import { parseWorkspace, type Workspace } from '../../../shared/model'
import { graphSnapshotSchema, type GraphSnapshot, type Diagram } from '../../../shared/diagram'
import {
  defaultComponentCatalog,
  parseCatalogDiagram,
  type ComponentCatalog,
} from '../../../shared/component-catalog'
import { snapshot } from '../../../shared/iteration'

const prefix = 'say-clear.files.v3/'
const journalKey = `${prefix}pending`
const encode = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : item,
  )
const hash = (text: string) => {
  let value = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text))
    value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n)
  return value.toString(16).padStart(16, '0')
}
type History = Diagram['history'][number]
type Index = Omit<Workspace, 'systems'> & {
  systems: { architecture: Workspace['systems'][number]['architecture']; boardIds: string[] }[]
}
type Board = {
  content: Omit<Workspace['systems'][number]['contents'][number], 'diagram'>
  diagram?: { history: History[]; iterationId?: string }
}
type Draft = {
  id: string
  name: string
  startedAt: string
  git?: NonNullable<Diagram['iteration']>['git']
  baselineDigest: string
  draft: GraphSnapshot
}
type Change = { path: string; before: string | null; after: string | null }
function raw(path: string) {
  return localStorage.getItem(`${prefix}${path}`)
}
function read<T>(path: string): T {
  const value = raw(path)
  if (value === null) throw new Error(`缺少浏览器数据：${path}`)
  return JSON.parse(value) as T
}
function recover() {
  const rawJournal = localStorage.getItem(journalKey)
  if (!rawJournal) return
  const changes = JSON.parse(rawJournal) as Change[]
  if (
    !Array.isArray(changes) ||
    changes.some(
      (c) =>
        typeof c.path !== 'string' ||
        !/^(workspace|board\/|version\/|iteration\/)/.test(c.path) ||
        c.path.includes('..'),
    )
  )
    throw new Error('浏览器恢复记录无效')
  for (const change of changes)
    if (raw(change.path) !== change.before && raw(change.path) !== change.after)
      throw new Error('浏览器数据在恢复期间发生变化')
  for (const change of changes) {
    if (raw(change.path) === change.after) continue
    if (change.after === null) localStorage.removeItem(`${prefix}${change.path}`)
    else localStorage.setItem(`${prefix}${change.path}`, change.after)
  }
  localStorage.removeItem(journalKey)
}
function transact(files: Map<string, string>, deletes: string[] = []) {
  recover()
  const changes: Change[] = [...files].flatMap(([path, after]) =>
    raw(path) === after ? [] : [{ path, before: raw(path), after }],
  )
  for (const path of deletes)
    if (raw(path) !== null) changes.push({ path, before: raw(path), after: null })
  if (!changes.length) return
  // Publish the workspace pointer last. A failed write leaves a replayable journal.
  changes.sort((a, b) => Number(a.path === 'workspace') - Number(b.path === 'workspace'))
  localStorage.setItem(journalKey, JSON.stringify(changes))
  recover()
}
function version(boardId: string, history: History): GraphSnapshot {
  if (history.snapshot) return history.snapshot
  const text = raw(`version/${boardId}/${history.id}`)
  if (!text) throw new Error('历史快照文件缺失')
  if (hash(text) !== history.snapshotDigest) throw new Error('历史快照与索引不一致')
  const snapshot = graphSnapshotSchema.parse(JSON.parse(text))
  if (
    snapshot.components.length !== history.componentCount ||
    snapshot.connections.length !== history.connectionCount
  )
    throw new Error('历史快照与索引不一致')
  return snapshot
}
export const browserStore = {
  load(): Workspace | null {
    recover()
    if (!raw('workspace')) {
      const old =
        localStorage.getItem('say-clear.workspace.v2') ??
        localStorage.getItem('say-clear.workspace.v1')
      if (!old) return null
      browserStore.save(parseWorkspace(JSON.parse(old)))
    }
    const index = read<Index>('workspace')
    return parseWorkspace({
      ...index,
      systems: index.systems.map((system) => ({
        architecture: system.architecture,
        contents: system.boardIds.map((id) => {
          const board = read<Board>(`board/${id}/index`)
          if (board.content.id !== id) throw new Error('画板索引 ID 不一致')
          if (!board.diagram) return board.content
          const current = graphSnapshotSchema.parse(read(`board/${id}/current`))
          let graph = current
          let iteration: Diagram['iteration']
          if (board.diagram.iterationId) {
            const draft = read<Draft>(`iteration/${id}/${board.diagram.iterationId}`)
            const text = raw(`version/${id}/${draft.id}`)
            if (
              draft.id !== board.diagram.iterationId ||
              !text ||
              hash(text) !== draft.baselineDigest ||
              encode(current) !== text
            )
              throw new Error('迭代基线无效')
            graph = draft.draft
            iteration = {
              id: draft.id,
              name: draft.name,
              startedAt: draft.startedAt,
              baseline: current,
              ...(draft.git ? { git: draft.git } : {}),
            }
          }
          return {
            ...board.content,
            diagram: { ...graph, iteration, history: board.diagram.history },
          }
        }),
      })),
    })
  },
  save(workspace: Workspace): Workspace {
    recover()
    const parsed = parseWorkspace(workspace)
    const files = new Map<string, string>()
    const deletes: string[] = []
    const immutable = (path: string, graph: GraphSnapshot) => {
      const text = encode(graph)
      if (raw(path) !== null && raw(path) !== text) throw new Error('只读历史或迭代基线不能被覆盖')
      files.set(path, text)
      return hash(text)
    }
    const oldIndex = raw('workspace') ? read<Index>('workspace') : undefined
    if (oldIndex && encode(oldIndex.componentCatalog) !== encode(parsed.componentCatalog))
      browserStore.validateCatalog(parsed.componentCatalog ?? defaultComponentCatalog)
    for (const system of parsed.systems)
      for (const content of system.contents) {
        const { diagram, ...metadata } = content
        const prior = raw(`board/${content.id}/index`)
          ? read<Board>(`board/${content.id}/index`)
          : undefined
        const board: Board = { content: metadata }
        if (diagram) {
          if (
            diagram.history.length &&
            prior?.diagram &&
            read<GraphSnapshot>(`board/${content.id}/current`).scenarioId !== diagram.scenarioId
          )
            throw new Error('画板包含历史现状，不能更换场景')
          files.set(
            `board/${content.id}/current`,
            encode(diagram.iteration?.baseline ?? snapshot(diagram)),
          )
          if (diagram.iteration) {
            const iteration = diagram.iteration
            const baselineDigest = immutable(
              `version/${content.id}/${iteration.id}`,
              iteration.baseline,
            )
            files.set(
              `iteration/${content.id}/${iteration.id}`,
              encode({
                id: iteration.id,
                name: iteration.name,
                startedAt: iteration.startedAt,
                ...(iteration.git ? { git: iteration.git } : {}),
                baselineDigest,
                draft: snapshot(diagram),
              }),
            )
          }
          diagram.history = diagram.history.map((history) => {
            if (!history.snapshot) {
              const existing = prior?.diagram?.history.find((h) => h.id === history.id)
              if (existing?.snapshotDigest !== history.snapshotDigest) version(content.id, history)
              return history
            }
            const snapshotDigest = immutable(
              `version/${content.id}/${history.id}`,
              history.snapshot,
            )
            return {
              id: history.id,
              name: history.name,
              publishedAt: history.publishedAt,
              ...(history.git ? { git: history.git } : {}),
              componentCount: history.snapshot.components.length,
              connectionCount: history.snapshot.connections.length,
              snapshotDigest,
            }
          })
          board.diagram = { history: diagram.history, iterationId: diagram.iteration?.id }
        } else if (prior?.diagram) deletes.push(`board/${content.id}/current`)
        if (prior?.diagram?.iterationId && prior.diagram.iterationId !== diagram?.iteration?.id) {
          deletes.push(`iteration/${content.id}/${prior.diagram.iterationId}`)
          if (!diagram?.history.some((h) => h.id === prior.diagram!.iterationId))
            deletes.push(`version/${content.id}/${prior.diagram.iterationId}`)
        }
        files.set(`board/${content.id}/index`, encode(board))
      }
    const index: Index = {
      ...parsed,
      systems: parsed.systems.map((s) => ({
        architecture: s.architecture,
        boardIds: s.contents.map((c) => c.id),
      })),
    }
    files.set('workspace', encode(index))
    const removed =
      oldIndex?.systems
        .flatMap((s) => s.boardIds)
        .filter((id) => !parsed.systems.some((s) => s.contents.some((c) => c.id === id))) ?? []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (
        key?.startsWith(prefix) &&
        removed.some((id) =>
          ['board', 'version', 'iteration'].some((kind) =>
            key.startsWith(`${prefix}${kind}/${id}/`),
          ),
        )
      )
        deletes.push(key.slice(prefix.length))
    }
    transact(files, deletes)
    return parsed
  },
  loadHistory(boardId: string, id: string): GraphSnapshot {
    recover()
    const board = read<Board>(`board/${boardId}/index`)
    const entry = board.diagram?.history.find((h) => h.id === id)
    if (!entry) throw new Error('历史版本不存在')
    const snapshot = version(boardId, entry)
    const current = read<GraphSnapshot>(`board/${boardId}/current`)
    if (snapshot.scenarioId !== current.scenarioId) throw new Error('历史快照与画板场景不一致')
    parseCatalogDiagram(
      { ...snapshot, history: [] },
      read<Index>('workspace').componentCatalog ?? defaultComponentCatalog,
    )
    return snapshot
  },
  validateCatalog(catalog: ComponentCatalog) {
    const workspace = browserStore.load()
    if (!workspace) return
    for (const system of workspace.systems)
      for (const content of system.contents)
        if (content.diagram) {
          parseCatalogDiagram(content.diagram, catalog)
          for (const history of content.diagram.history)
            parseCatalogDiagram({ ...version(content.id, history), history: [] }, catalog)
        }
  },
}
