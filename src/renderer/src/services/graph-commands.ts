import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { workspaceSchema, type Workspace } from '../../../shared/model'
import type { GraphSnapshot } from '../../../shared/diagram'
import { isDesktop, nativeInvoke } from './desktop'
import { storage } from './storage'

export type GraphCommandRequest = {
  command: string
  graphId?: string | null
  itemId?: string | null
  input?: unknown
  expectedRevision?: string | null
  dryRun?: boolean
}
export type GraphCommandEvent = { id: string; request: GraphCommandRequest }
export type GraphCommandError = { code: string; message: string }
export type GraphCommandOutcome = {
  workspace: Workspace
  result: unknown
  changed: boolean
  changedBoardIds: string[]
}
export type GraphCommandCompletion =
  { result: unknown; error?: never } | { result?: never; error: GraphCommandError }

export function graphCommandError(error: unknown): GraphCommandError {
  if (typeof error === 'string') {
    try {
      return graphCommandError(JSON.parse(error))
    } catch {
      return { code: 'EXECUTION_FAILED', message: error }
    }
  }
  if (error && typeof error === 'object' && 'code' in error && 'message' in error)
    return { code: String(error.code), message: String(error.message) }
  return {
    code: 'EXECUTION_FAILED',
    message: error instanceof Error ? error.message : '图操作失败，请重试。',
  }
}

function needsHistory(request: GraphCommandRequest) {
  const input = request.input as { version?: string; operations?: { op?: string }[] } | undefined
  return (
    request.command === 'graph.delete' ||
    request.command === 'component.delete' ||
    (request.command === 'graph.update' &&
      Array.isArray(input?.operations) &&
      input.operations.some((operation) => operation?.op === 'component.delete')) ||
    input?.version === 'history'
  )
}

export async function hydrateCommandHistory(
  workspace: Workspace,
  request: GraphCommandRequest,
  load: (boardId: string, historyId: string) => Promise<GraphSnapshot>,
): Promise<Workspace> {
  if (!needsHistory(request)) return workspace
  const input = request.input as { version?: string; historyId?: string } | undefined
  const candidate = structuredClone(workspace)
  // Read sequentially: a delete may inspect many boards, including detached contents.
  for (const system of candidate.systems)
    for (const content of system.contents) {
      if (input?.version === 'history' && content.id !== request.graphId) continue
      for (const version of content.diagram?.history ?? []) {
        if (input?.version === 'history' && input.historyId && version.id !== input.historyId)
          continue
        if (!version.snapshot) version.snapshot = await load(content.id, version.id)
      }
    }
  return candidate
}

// Loading history for a command must not turn every historical body into resident UI state.
function restoreHistoryCache(candidate: Workspace, previous: Workspace): Workspace {
  const originals = new Map(
    previous.systems.flatMap((system) => system.contents.map((content) => [content.id, content])),
  )
  for (const system of candidate.systems)
    for (const content of system.contents) {
      const original = originals.get(content.id)?.diagram
      for (const history of content.diagram?.history ?? [])
        if (!original?.history.find((version) => version.id === history.id)?.snapshot)
          delete history.snapshot
    }
  return candidate
}

export function graphCommandStateKey(workspace: Workspace): string {
  return JSON.stringify(workspace, (key, value: unknown) => {
    if (key === 'history' && Array.isArray(value))
      return value.map((version: Record<string, unknown>) => {
        const copy = { ...version }
        delete copy.snapshot
        delete copy.snapshotDigest
        delete copy.componentCount
        delete copy.connectionCount
        return copy
      })
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  })
}

type QueueContext = {
  getWorkspace: () => Workspace | null
  available?: () => boolean
  setBusy: (busy: boolean) => void
  flush: () => Promise<void>
  hydrate: (workspace: Workspace, request: GraphCommandRequest) => Promise<Workspace>
  execute: (workspace: Workspace, request: GraphCommandRequest) => Promise<GraphCommandOutcome>
  apply: (before: Workspace, outcome: GraphCommandOutcome, requestId: string) => void
  save: (workspace: Workspace) => Promise<void>
  deleteSystem: (systemId: string) => Promise<Workspace>
  complete: (id: string, completion: GraphCommandCompletion) => Promise<void>
  onError?: (error: GraphCommandError) => void
}

export function createGraphCommandQueue(context: QueueContext) {
  let pending = Promise.resolve()
  let disposed = false
  const requests = new Map<string, Promise<void>>()
  const run = async ({ id, request }: GraphCommandEvent) => {
    let completion: GraphCommandCompletion
    let busy = false
    try {
      if (disposed) throw { code: 'NOT_READY', message: '桌面连接已关闭，请重试。' }
      if (context.available && !context.available())
        throw { code: 'BUSY', message: '桌面正在编辑或切换工作区，请稍后重试。' }
      context.setBusy(true)
      busy = true
      await context.flush()
      const before = context.getWorkspace()
      if (!before) throw { code: 'NOT_READY', message: '工作区尚未打开。' }
      const revision = graphCommandStateKey(before)
      const hydrated = await context.hydrate(before, request)
      const outcome = await context.execute(hydrated, request)
      if (disposed) throw { code: 'NOT_READY', message: '桌面连接已关闭，修改未应用。' }
      const current = context.getWorkspace()
      if (!current || graphCommandStateKey(current) !== revision)
        throw { code: 'REVISION_CONFLICT', message: '处理期间画板已变化，修改未应用，请重新查询。' }
      if (outcome.changed) {
        const next = restoreHistoryCache(workspaceSchema.parse(outcome.workspace), current)
        const removed = before.systems.filter(
          (system) => !next.systems.some((item) => item.architecture.id === system.architecture.id),
        )
        if (removed.length) {
          if (removed.length !== 1 || request.command !== 'graph.delete')
            throw { code: 'INVALID_INPUT', message: '删除应用系统必须使用专用图删除操作。' }
          await context.save(before)
          const saved = await context.deleteSystem(removed[0].architecture.id)
          context.apply(before, { ...outcome, workspace: saved }, id)
        } else {
          context.apply(before, { ...outcome, workspace: next }, id)
          // Keep the candidate visible on save failure so the normal retry UI remains usable.
          await context.save(next)
          await context.flush()
        }
      }
      completion = { result: outcome.result }
    } catch (error) {
      completion = { error: graphCommandError(error) }
    } finally {
      if (busy) context.setBusy(false)
    }
    try {
      await context.complete(id, completion)
    } catch (error) {
      context.onError?.(graphCommandError(error))
    }
  }
  return {
    enqueue(event: GraphCommandEvent) {
      const previous = requests.get(event.id)
      if (previous) return previous
      const next = pending.catch(() => {}).then(() => run(event))
      pending = next
      requests.set(event.id, next)
      if (requests.size > 128) requests.delete(requests.keys().next().value!)
      return next
    },
    dispose() {
      disposed = true
    },
  }
}

type DesktopHandlers = Pick<
  QueueContext,
  'getWorkspace' | 'available' | 'setBusy' | 'apply' | 'onError'
>
let desktopConnection = 0
let readiness = Promise.resolve()
function setReady(ready: boolean) {
  const pending = readiness
    .catch(() => {})
    .then(() => nativeInvoke<void>('set_cli_ready', { ready }))
  readiness = pending
  return pending
}

export async function connectGraphCommands(handlers: DesktopHandlers): Promise<() => void> {
  if (!isDesktop) return () => {}
  const generation = ++desktopConnection
  const queue = createGraphCommandQueue({
    ...handlers,
    flush: () => storage.flush(),
    hydrate: (workspace, request) => hydrateCommandHistory(workspace, request, storage.loadHistory),
    execute: (workspace, request) =>
      invoke<GraphCommandOutcome>('execute_graph_command', { workspace, request }),
    save: (workspace) => storage.save(workspace),
    deleteSystem: (id) => storage.deleteSystem(id),
    complete: (requestId, completion) =>
      nativeInvoke('complete_cli_request', { requestId, ...completion }),
  })
  const unlisten = await listen<GraphCommandEvent>('sayclear://cli-request', (event) => {
    if (generation === desktopConnection) void queue.enqueue(event.payload)
  })
  if (generation !== desktopConnection) {
    queue.dispose()
    unlisten()
    return () => {}
  }
  try {
    await setReady(true)
  } catch (error) {
    queue.dispose()
    unlisten()
    throw error
  }
  return () => {
    queue.dispose()
    unlisten()
    if (generation === desktopConnection) {
      desktopConnection++
      void setReady(false).catch(() => {})
    }
  }
}
