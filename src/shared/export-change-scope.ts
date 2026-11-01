import { catalogDiagramError, defaultComponentCatalog } from './component-catalog'
import { combinedBoardKey, type CombinedDiagram, type CombinedIssue } from './combined-diagram'
import {
  COMPONENT_WIDTH,
  componentHeight,
  graphSnapshotSchema,
  layoutDiagram,
  type GraphSnapshot,
} from './diagram'
import { referenceSnapshot, resolveReference, type BoardLocation } from './diagram-references'
import { iterationChanges, iterationView, snapshot } from './iteration'
import { iterationBoards, type IterationBoard } from './iteration-management'
import { flattenArchitecture, workspaceSchema, type Workspace } from './model'

type Dependencies = {
  loadHistory?: (boardId: string, versionId: string) => Promise<GraphSnapshot>
}
export type ChangeExportProjection = {
  workspace: Workspace
  changedBoardIds: string[]
  boardIds: string[]
  locations: BoardLocation[]
  combined: CombinedDiagram
  warnings: string[]
  nodeReasons: Record<string, string[]>
}
type Caller = { location: BoardLocation; componentId: string; sourceIds: string[] }
type Frame = {
  board: IterationBoard
  location: BoardLocation
  graph?: GraphSnapshot
  ids: Set<string>
  expanded: Set<string>
  processed: Set<string>
  reasons: Map<string, Set<string>>
  depth: number
}
const nodeKey = (frameKey: string, id: string) => `${frameKey}/${encodeURIComponent(id)}`
const locationOf = (board: IterationBoard, version: 'current' | 'iteration'): BoardLocation => ({
  boardId: board.id,
  version,
  ...(version === 'iteration' ? { iterationId: board.diagram.iteration!.id } : {}),
})

function project(workspace: Workspace, seedBoardIds: string[], render = true) {
  const boards = iterationBoards(workspace)
  const byId = new Map(boards.map((board) => [board.id, board]))
  for (const id of seedBoardIds) if (!byId.has(id)) throw new Error(`导出画板 ${id} 已不存在`)
  const selected = new Set(seedBoardIds)
  const changed = boards.flatMap((board) => {
    if (!selected.has(board.id)) return []
    const changes = iterationChanges(board.diagram).filter(
      (change) => change.status !== 'unchanged',
    )
    return changes.length ? [{ board, changes }] : []
  })
  const changedIds = new Set(changed.map(({ board }) => board.id))
  const nodes = new Map(
    workspace.systems
      .flatMap((system) => flattenArchitecture(system.architecture))
      .map((node) => [node.id, node]),
  )
  const ancestors = (boardId: string) => {
    const result: string[] = []
    let parent = nodes.get(boardId)?.parentId
    while (parent) {
      result.push(parent)
      parent = nodes.get(parent)?.parentId
    }
    return result
  }
  // Scan live callers only. Unrelated archived callers are not an impact graph.
  const incoming = new Map<string, Caller[]>()
  for (const board of boards) {
    const locations = [locationOf(board, 'current')]
    if (board.diagram.iteration) locations.push(locationOf(board, 'iteration'))
    for (const location of locations) {
      const graph = referenceSnapshot(board, location.version, location.iterationId)!
      for (const component of graph.components) {
        if (!component.reference) continue
        const key = combinedBoardKey(component.reference)
        const callers = incoming.get(key) ?? []
        callers.push({
          location,
          componentId: component.id,
          sourceIds: [component.reference.componentId, ...component.reference.outputIds],
        })
        incoming.set(key, callers)
      }
    }
  }
  const frames = new Map<string, Frame>()
  const requestedBoards = new Set<string>()
  const pending = new Map<string, BoardLocation>()
  const warnings = new Set<string>()
  const issues = new Map<string, CombinedIssue>()
  const queue: { frame: Frame; id: string; expand: boolean }[] = []
  function warn(location: BoardLocation, message: string, componentId?: string) {
    warnings.add(message)
    const key = `${combinedBoardKey(location)}/${componentId ?? ''}/${message}`
    issues.set(key, { id: key, kind: 'missing', message, location, componentId })
  }
  function ensureFrame(location: BoardLocation, depth = 0): Frame | undefined {
    const key = combinedBoardKey(location)
    const previous = frames.get(key)
    if (previous) return previous
    const board = byId.get(location.boardId)
    if (!board) {
      warn(location, `来源画板 ${location.boardId} 不在工作区，已保留采用的引用定义`)
      return
    }
    requestedBoards.add(board.id)
    let graph = referenceSnapshot(board, location.version, location.iterationId, location.historyId)
    if (!graph) {
      if (
        location.version === 'history' &&
        board.diagram.history.some((version) => version.id === location.historyId)
      )
        pending.set(key, location)
      else {
        warn(
          location,
          `「${board.name}」的 ${location.version} 来源版本已不存在，已保留采用的引用定义`,
        )
        return
      }
    }
    if (frames.size >= 200) throw new Error('变更关联超过 200 个画板版本，请缩小导出范围')
    if (graph && location.version === 'iteration' && changedIds.has(board.id))
      graph = iterationView(board.diagram)
    const frame: Frame = {
      board,
      location: {
        boardId: location.boardId,
        version: location.version,
        ...(location.version === 'iteration' ? { iterationId: location.iterationId } : {}),
        ...(location.version === 'history' ? { historyId: location.historyId } : {}),
      },
      graph,
      ids: new Set(),
      expanded: new Set(),
      processed: new Set(),
      reasons: new Map(),
      depth,
    }
    frames.set(key, frame)
    const parents = ancestors(board.id)
    for (let index = 0; index < parents.length; index++) {
      const parent = byId.get(parents[index])!
      ensureFrame(locationOf(parent, 'current'), depth - index - 1)
    }
    // An authored parent reference is the board's ownership boundary. Include its
    // public entry even when the changed internal node is several hops away.
    const atomicChange = changedIds.has(board.id) && nodes.get(board.id)?.type === 'atomic'
    for (const caller of incoming.get(key) ?? []) {
      const parentReference = parents.includes(caller.location.boardId)
      if (!parentReference && !atomicChange) continue
      const reason = parentReference ? 'ownership-reference' : 'board-reference-context'
      addNode(caller.location, caller.componentId, reason, true, depth - 1)
      for (const id of caller.sourceIds) addNode(location, id, reason, false, depth)
    }
    return frame
  }
  function addNode(
    location: BoardLocation,
    id: string,
    reason: string,
    expand: boolean,
    depth = 0,
  ) {
    const frame = ensureFrame(location, depth)
    if (!frame) return
    if (frame.graph && !frame.graph.components.some((component) => component.id === id)) {
      warn(location, `「${frame.board.name}」的来源组件 ${id} 不存在，已保留采用的引用定义`, id)
      return
    }
    const fresh = !frame.ids.has(id)
    frame.ids.add(id)
    const reasons = frame.reasons.get(id) ?? new Set<string>()
    reasons.add(reason)
    frame.reasons.set(id, reasons)
    if (frame.graph && (fresh || (expand && !frame.expanded.has(id))))
      queue.push({ frame, id, expand })
  }
  for (const { board, changes } of changed) {
    const draft = locationOf(board, 'iteration'),
      current = locationOf(board, 'current')
    ensureFrame(draft)
    // The atomic board is the delivery boundary, so its unchanged public contract
    // and live callers still provide ownership context for a purely internal edit.
    if (nodes.get(board.id)?.type === 'atomic') ensureFrame(current)
    for (const change of changes) {
      if (change.kind === 'component') {
        addNode(draft, change.id, 'changed', true)
        if (
          board.diagram.iteration!.baseline.components.some(
            (component) => component.id === change.id,
          )
        )
          addNode(current, change.id, 'changed', true)
      } else {
        const before = board.diagram.iteration!.baseline.connections.find(
          (edge) => edge.id === change.id,
        )
        const after = board.diagram.connections.find((edge) => edge.id === change.id)
        if (before)
          for (const id of [before.sourceId, before.targetId]) {
            addNode(current, id, 'changed-connection', true)
            addNode(draft, id, 'changed-connection', true)
          }
        if (after)
          for (const id of [after.sourceId, after.targetId])
            addNode(draft, id, 'changed-connection', true)
      }
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { frame, id, expand } = queue[cursor]
    const graph = frame.graph!
    const component = graph.components.find((item) => item.id === id)!
    if (expand && !frame.expanded.has(id)) {
      frame.expanded.add(id)
      for (const edge of graph.connections)
        if (edge.sourceId === id || edge.targetId === id) {
          addNode(
            frame.location,
            edge.sourceId === id ? edge.targetId : edge.sourceId,
            'adjacent',
            false,
            frame.depth,
          )
        }
    }
    if (frame.processed.has(id)) continue
    frame.processed.add(id)
    let owner = component.ownerId
    while (owner) {
      addNode(frame.location, owner, 'owner', false, frame.depth)
      owner = graph.components.find((item) => item.id === owner)?.ownerId ?? null
    }
    const ref = component.reference
    if (ref) {
      ensureFrame(ref, frame.depth + 1)
      for (const sourceId of [ref.componentId, ...ref.outputIds])
        addNode(ref, sourceId, 'reference-source', true, frame.depth + 1)
    }
    for (const caller of incoming.get(combinedBoardKey(frame.location)) ?? [])
      if (caller.sourceIds.includes(id)) {
        addNode(caller.location, caller.componentId, 'reference', true, frame.depth - 1)
      }
  }
  const combined: CombinedDiagram = {
    rootKey: changed.length ? combinedBoardKey(locationOf(changed[0].board, 'iteration')) : '',
    boards: [],
    nodes: [],
    edges: [],
    issues: [],
    pendingHistory: [...pending.values()],
    truncated: false,
    width: 640,
    height: 360,
  }
  const nodeReasons: Record<string, string[]> = {}
  const columns = new Map<number, Frame[]>()
  for (const frame of frames.values())
    if (render && frame.graph)
      columns.set(frame.depth, [...(columns.get(frame.depth) ?? []), frame])
  let x = 40
  for (const [, column] of [...columns].sort(([a], [b]) => a - b)) {
    let y = 40,
      columnWidth = 400
    for (const frame of column) {
      const graph = snapshot(
        layoutDiagram({
          ...snapshot(frame.graph!),
          components: frame.graph!.components.filter((component) => frame.ids.has(component.id)),
          connections: frame.graph!.connections.filter(
            (edge) => frame.ids.has(edge.sourceId) && frame.ids.has(edge.targetId),
          ),
          history: [],
        }),
      )
      const key = combinedBoardKey(frame.location)
      const minX = Math.min(0, ...graph.components.map((component) => component.position.x))
      const minY = Math.min(0, ...graph.components.map((component) => component.position.y))
      const width = Math.max(
        400,
        ...graph.components.map((component) => component.position.x - minX + COMPONENT_WIDTH + 64),
      )
      const height = Math.max(
        220,
        ...graph.components.map(
          (component) => component.position.y - minY + componentHeight(component) + 128,
        ),
      )
      combined.boards.push({
        id: key,
        board: frame.board,
        location: frame.location,
        graph,
        x,
        y,
        width,
        height,
      })
      for (const component of graph.components) {
        const resolution = component.reference ? resolveReference(boards, component) : undefined
        const node = {
          id: nodeKey(key, component.id),
          boardId: key,
          location: { ...frame.location, componentId: component.id },
          component: {
            ...component,
            position: {
              x: component.position.x - minX + x + 32,
              y: component.position.y - minY + y + 96,
            },
          },
          ...(resolution
            ? { referenceStatus: resolution.status, referenceMessage: resolution.message }
            : {}),
        }
        combined.nodes.push(node)
        nodeReasons[node.id] = [...(frame.reasons.get(component.id) ?? [])].sort()
        if (resolution && resolution.status !== 'ok') {
          const message = `${frame.board.name} / ${component.name}：${resolution.message}`
          warnings.add(message)
          issues.set(node.id, {
            id: node.id,
            kind: resolution.status,
            message,
            location: node.location,
            componentId: component.id,
          })
        }
      }
      for (const edge of graph.connections)
        combined.edges.push({
          id: `${key}/edge/${encodeURIComponent(edge.id)}`,
          kind: 'connection',
          sourceId: nodeKey(key, edge.sourceId),
          targetId: nodeKey(key, edge.targetId),
          name: edge.name,
          connection: edge,
        })
      columnWidth = Math.max(columnWidth, width)
      y += height + 100
      combined.height = Math.max(combined.height, y - 60)
    }
    x += columnWidth + 160
  }
  combined.width = Math.max(combined.width, x - 120)
  const exportedNodes = new Map(combined.nodes.map((node) => [node.id, node]))
  for (const node of combined.nodes)
    if (node.component.reference) {
      const ref = node.component.reference
      for (const [index, id] of [ref.componentId, ...ref.outputIds].entries()) {
        const target = exportedNodes.get(nodeKey(combinedBoardKey(ref), id))
        if (!target) continue
        combined.edges.push({
          id: `${node.id}/reference/${encodeURIComponent(id)}`,
          kind: 'reference',
          sourceId: node.id,
          targetId: target.id,
          name: index ? `引用输出 · ${target.component.name}` : '引用入口',
          output: index > 0,
          status: node.referenceStatus,
        })
      }
    }
  combined.issues = [...issues.values()]
  return {
    changedBoardIds: [...changedIds],
    boardIds: boards.filter((board) => requestedBoards.has(board.id)).map((board) => board.id),
    changeCount: changed.reduce((count, entry) => count + entry.changes.length, 0),
    locations: [...frames.values()].filter((frame) => !!frame.graph).map((frame) => frame.location),
    combined,
    warnings: [...warnings],
    nodeReasons,
    pending: [...pending.values()],
  }
}

/** Preview uses loaded data and reports pending historical sources without reading files. */
export function planChangeExport(workspace: Workspace, seedBoardIds: string[]) {
  const result = project(workspace, seedBoardIds, false)
  return {
    changedBoardIds: result.changedBoardIds,
    boardIds: result.boardIds,
    changeCount: result.changeCount,
  }
}

/** Build a complete projection; only reached fixed historical versions are loaded. */
export async function collectChangeExport(
  source: Workspace,
  seedBoardIds: string[],
  dependencies: Dependencies = {},
): Promise<ChangeExportProjection> {
  const workspace = workspaceSchema.parse(source)
  const seeds = [...seedBoardIds]
  const catalog = workspace.componentCatalog ?? defaultComponentCatalog
  let result = project(workspace, seeds)
  if (!result.changeCount)
    throw new Error('所选范围没有进行中的业务变更，请先修改迭代或选择其他范围')
  while (result.pending.length) {
    for (let offset = 0; offset < result.pending.length; offset += 4) {
      await Promise.all(
        result.pending.slice(offset, offset + 4).map(async (location) => {
          const board = iterationBoards(workspace).find((item) => item.id === location.boardId)!
          const version = board.diagram.history.find((entry) => entry.id === location.historyId)!
          let value: GraphSnapshot | undefined
          try {
            value = await dependencies.loadHistory?.(board.id, version.id)
          } catch (error) {
            throw new Error(
              `无法读取关联画板「${board.name}」的历史「${version.name}」：${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          }
          if (!value) throw new Error(`关联画板「${board.name}」的历史「${version.name}」未加载`)
          const parsed = graphSnapshotSchema.parse(value)
          if (parsed.scenarioId !== board.diagram.scenarioId)
            throw new Error(`关联画板「${board.name}」的历史场景不一致`)
          const error = catalogDiagramError({ ...parsed, history: [] }, catalog)
          if (error) throw new Error(`关联历史「${version.name}」无效：${error}`)
          version.snapshot = snapshot(parsed)
        }),
      )
    }
    result = project(workspace, seeds)
  }
  return {
    workspace,
    changedBoardIds: result.changedBoardIds,
    boardIds: result.boardIds,
    locations: result.locations,
    combined: result.combined,
    warnings: result.warnings,
    nodeReasons: result.nodeReasons,
  }
}
