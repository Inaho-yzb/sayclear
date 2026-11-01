import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/workspace-v2.json'
import { workspaceSchema, type Workspace } from '../src/shared/model'
import { exampleDiagram } from '../src/shared/diagram'
import { publishIteration, startIteration } from '../src/shared/iteration'

const { invoke, nativeInvoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  nativeInvoke: vi.fn(),
  listen: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('../src/renderer/src/services/desktop', () => ({ isDesktop: true, nativeInvoke }))
vi.mock('../src/renderer/src/services/storage', () => ({ storage: {} }))

const {
  connectGraphCommands,
  createGraphCommandQueue,
  graphCommandError,
  graphCommandStateKey,
  hydrateCommandHistory,
} = await import('../src/renderer/src/services/graph-commands')
type Context = Parameters<typeof createGraphCommandQueue>[0]

function workspace() {
  const value = workspaceSchema.parse(fixture)
  value.systems[0].contents[0].diagram = exampleDiagram()
  return value
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup() {
  let current: Workspace | null = workspace()
  const context: Context = {
    getWorkspace: vi.fn(() => current),
    setBusy: vi.fn(),
    flush: vi.fn(async () => {}),
    hydrate: vi.fn(async (before) => before),
    execute: vi.fn(async (before) => ({
      workspace: before,
      result: { revision: 'r1' },
      changed: false,
      changedBoardIds: [],
    })),
    apply: vi.fn((_before, outcome) => {
      current = outcome.workspace
    }),
    save: vi.fn(async () => {}),
    deleteSystem: vi.fn(async () => ({
      schemaVersion: 2 as const,
      activeNodeId: null,
      systems: [],
    })),
    complete: vi.fn(async () => {}),
  }
  return {
    context,
    queue: createGraphCommandQueue(context),
    get current(): Workspace {
      return current!
    },
    set current(value: Workspace) {
      current = value
    },
  }
}

const event = (id = 'request-1') => ({
  id,
  request: { command: 'graph.update', graphId: 'fixture-project', expectedRevision: 'r1' },
})

function changed(before: Workspace) {
  const next = structuredClone(before)
  next.systems[0].contents[0].diagram!.components[0].name = 'CLI 修改后的组件'
  return {
    workspace: next,
    result: { revision: 'r2' },
    changed: true,
    changedBoardIds: ['fixture-project'],
  }
}

afterEach(() => vi.resetAllMocks())

describe('桌面图命令队列', () => {
  it('先等待已提交保存，然后读取最新界面状态，成功回复等待修改落盘', async () => {
    const state = setup()
    const save = deferred<void>()
    const next = changed(state.current)
    vi.mocked(state.context.execute).mockResolvedValue(next)
    vi.mocked(state.context.save).mockReturnValue(save.promise)
    const result = state.queue.enqueue(event())
    await vi.waitFor(() => expect(state.context.save).toHaveBeenCalled())
    expect(state.context.flush).toHaveBeenCalledTimes(1)
    expect(state.context.apply).toHaveBeenCalledTimes(1)
    expect(state.current.systems[0].contents[0].diagram!.components[0].name).toBe(
      'CLI 修改后的组件',
    )
    expect(state.context.complete).not.toHaveBeenCalled()
    save.resolve()
    await result
    expect(state.context.flush).toHaveBeenCalledTimes(2)
    expect(state.context.complete).toHaveBeenCalledWith('request-1', { result: { revision: 'r2' } })
    expect(state.context.setBusy).toHaveBeenNthCalledWith(1, true)
    expect(state.context.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('串行执行多轮操作，下一轮看到前一轮提交的状态', async () => {
    const state = setup()
    const save = deferred<void>()
    vi.mocked(state.context.execute).mockImplementation(async (before) => changed(before))
    vi.mocked(state.context.save).mockReturnValueOnce(save.promise)
    const first = state.queue.enqueue(event('first'))
    const second = state.queue.enqueue(event('second'))
    await vi.waitFor(() => expect(state.context.save).toHaveBeenCalledTimes(1))
    expect(state.context.execute).toHaveBeenCalledTimes(1)
    const applied = state.current
    save.resolve()
    await Promise.all([first, second])
    expect(vi.mocked(state.context.execute).mock.calls[1][0]).toBe(applied)
    expect(state.context.complete).toHaveBeenCalledTimes(2)
  })

  it('拒绝计算期间出现的新编辑，保留新界面内容，不保存过期结果', async () => {
    const state = setup()
    const execute = deferred<Awaited<ReturnType<Context['execute']>>>()
    const candidate = changed(state.current)
    vi.mocked(state.context.execute).mockReturnValue(execute.promise)
    const result = state.queue.enqueue(event())
    await vi.waitFor(() => expect(state.context.execute).toHaveBeenCalled())
    state.current = { ...state.current, activeNodeId: 'sales' }
    execute.resolve(candidate)
    await result
    expect(state.context.apply).not.toHaveBeenCalled()
    expect(state.context.save).not.toHaveBeenCalled()
    expect(state.context.complete).toHaveBeenCalledWith('request-1', {
      error: expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    })
    expect(state.current.activeNodeId).toBe('sales')
  })

  it('保存失败保留已应用的候选供界面重试，并向CLI返回失败', async () => {
    const state = setup()
    vi.mocked(state.context.execute).mockResolvedValue(changed(state.current))
    vi.mocked(state.context.save).mockRejectedValue(new Error('磁盘已满'))
    await state.queue.enqueue(event())
    expect(state.current.systems[0].contents[0].diagram!.components[0].name).toBe(
      'CLI 修改后的组件',
    )
    expect(state.context.complete).toHaveBeenCalledWith('request-1', {
      error: { code: 'EXECUTION_FAILED', message: '磁盘已满' },
    })
    expect(state.context.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('仅历史缓存压缩不会误报冲突，修改后仍保持历史按需加载', async () => {
    const state = setup()
    state.current.systems[0].contents[0].diagram = publishIteration(
      startIteration(exampleDiagram(), '历史'),
    )
    const execute = deferred<Awaited<ReturnType<Context['execute']>>>()
    const candidate = changed(state.current)
    vi.mocked(state.context.execute).mockReturnValue(execute.promise)
    const result = state.queue.enqueue(event())
    await vi.waitFor(() => expect(state.context.execute).toHaveBeenCalled())
    const compact = structuredClone(state.current)
    const history = compact.systems[0].contents[0].diagram!.history[0]
    delete history.snapshot
    history.snapshotDigest = '0123456789abcdef'
    history.componentCount = 5
    history.connectionCount = 4
    state.current = compact
    execute.resolve(candidate)
    await result
    expect(state.context.apply).toHaveBeenCalledOnce()
    expect(state.current.systems[0].contents[0].diagram!.history[0].snapshot).toBeUndefined()
    expect(state.context.complete).toHaveBeenCalledWith('request-1', {
      result: { revision: 'r2' },
    })
  })

  it('只读和dry-run结果不替换界面或保存；重复事件不会再次执行', async () => {
    const state = setup()
    const request = event()
    request.request = { ...request.request, command: 'graph.get' }
    await Promise.all([state.queue.enqueue(request), state.queue.enqueue(request)])
    expect(state.context.execute).toHaveBeenCalledTimes(1)
    expect(state.context.apply).not.toHaveBeenCalled()
    expect(state.context.save).not.toHaveBeenCalled()
  })

  it('根图删除先保存当前状态，再使用专用删除，完成后才替换界面', async () => {
    const state = setup()
    const before = state.current
    const saved = deferred<Workspace>()
    const next: Workspace = { schemaVersion: 2, activeNodeId: null, systems: [] }
    vi.mocked(state.context.execute).mockResolvedValue({
      workspace: next,
      result: { deleted: true },
      changed: true,
      changedBoardIds: ['fixture-project'],
    })
    vi.mocked(state.context.deleteSystem).mockReturnValue(saved.promise)
    const request = event()
    request.request.command = 'graph.delete'
    const result = state.queue.enqueue(request)
    await vi.waitFor(() => expect(state.context.deleteSystem).toHaveBeenCalled())
    expect(state.context.save).toHaveBeenCalledWith(before)
    expect(state.context.deleteSystem).toHaveBeenCalledWith('fixture-project')
    expect(state.context.apply).not.toHaveBeenCalled()
    saved.resolve(next)
    await result
    expect(state.current).toBe(next)
    expect(state.context.save).toHaveBeenCalledTimes(1)
  })

  it('编辑弹窗或工作区切换时返回BUSY，断开后拒绝迟到结果', async () => {
    const unavailable = setup()
    unavailable.context.available = () => false
    await unavailable.queue.enqueue(event())
    expect(unavailable.context.execute).not.toHaveBeenCalled()
    expect(unavailable.context.complete).toHaveBeenCalledWith('request-1', {
      error: expect.objectContaining({ code: 'BUSY' }),
    })
    const state = setup()
    const execute = deferred<Awaited<ReturnType<Context['execute']>>>()
    const candidate = changed(state.current)
    vi.mocked(state.context.execute).mockReturnValue(execute.promise)
    const result = state.queue.enqueue(event())
    await vi.waitFor(() => expect(state.context.execute).toHaveBeenCalled())
    state.queue.dispose()
    execute.resolve(candidate)
    await result
    expect(state.context.apply).not.toHaveBeenCalled()
    expect(state.context.complete).toHaveBeenCalledWith('request-1', {
      error: expect.objectContaining({ code: 'NOT_READY' }),
    })
  })

  it('加载历史只用于校验，落回界面时仍保留按需加载状态', async () => {
    const state = setup()
    const diagram = publishIteration(startIteration(exampleDiagram(), '历史'))
    state.current.systems[0].contents[0].diagram = diagram
    delete diagram.history[0].snapshot
    vi.mocked(state.context.execute).mockImplementation(async (before) => {
      const next = changed(before)
      next.workspace.systems[0].contents[0].diagram!.history[0].snapshot = exampleDiagram()
      return next
    })
    await state.queue.enqueue(event())
    expect(state.current.systems[0].contents[0].diagram!.history[0].snapshot).toBeUndefined()
  })
})

describe('历史与命令连接', () => {
  it('删除组件和批量删除会补齐历史，历史查询只读取指定版本', async () => {
    const before = workspace()
    const graph = publishIteration(startIteration(exampleDiagram(), '历史'))
    const historyId = graph.history[0].id
    const snapshot = graph.history[0].snapshot!
    delete graph.history[0].snapshot
    before.systems[0].contents[0].diagram = graph
    const load = vi.fn(async () => snapshot)
    const hydrated = await hydrateCommandHistory(
      before,
      { command: 'graph.update', input: { operations: [{ op: 'component.delete' }] } },
      load,
    )
    expect(load).toHaveBeenCalledWith('fixture-project', historyId)
    expect(before.systems[0].contents[0].diagram!.history[0].snapshot).toBeUndefined()
    expect(hydrated.systems[0].contents[0].diagram!.history[0].snapshot).toEqual(snapshot)
    load.mockClear()
    await hydrateCommandHistory(
      before,
      {
        command: 'graph.get',
        graphId: 'fixture-project',
        input: { version: 'history', historyId },
      },
      load,
    )
    expect(load).toHaveBeenCalledTimes(1)
    load.mockClear()
    await hydrateCommandHistory(before, { command: 'component.update' }, load)
    expect(load).not.toHaveBeenCalled()
  })

  it('工作区比较忽略历史正文缓存，仍检测业务字段修改', () => {
    const before = workspace()
    before.systems[0].contents[0].diagram = publishIteration(
      startIteration(exampleDiagram(), '历史'),
    )
    const compact = structuredClone(before)
    delete compact.systems[0].contents[0].diagram!.history[0].snapshot
    compact.systems[0].contents[0].diagram!.history[0].snapshotDigest = '0123456789abcdef'
    expect(graphCommandStateKey(before)).toBe(graphCommandStateKey(compact))
    compact.systems[0].contents[0].diagram!.components[0].name = '新名称'
    expect(graphCommandStateKey(before)).not.toBe(graphCommandStateKey(compact))
    expect(graphCommandError({ code: 'REVISION_REQUIRED', message: '需要版本' })).toEqual({
      code: 'REVISION_REQUIRED',
      message: '需要版本',
    })
  })

  it('监听安装后才就绪，严格模式的旧连接清理不会关闭新连接', async () => {
    const first = deferred<() => void>()
    const unlistenFirst = vi.fn()
    const unlistenSecond = vi.fn()
    listen.mockReturnValueOnce(first.promise).mockResolvedValueOnce(unlistenSecond)
    nativeInvoke.mockResolvedValue(undefined)
    const handlers = {
      getWorkspace: () => null,
      setBusy: vi.fn(),
      apply: vi.fn(),
    }
    const connectFirst = connectGraphCommands(handlers)
    expect(nativeInvoke).not.toHaveBeenCalled()
    const disposeSecond = await connectGraphCommands(handlers)
    first.resolve(unlistenFirst)
    const disposeFirst = await connectFirst
    disposeFirst()
    expect(unlistenFirst).toHaveBeenCalledOnce()
    expect(nativeInvoke).toHaveBeenCalledTimes(1)
    expect(nativeInvoke).toHaveBeenCalledWith('set_cli_ready', { ready: true })
    disposeSecond()
    await vi.waitFor(() =>
      expect(nativeInvoke).toHaveBeenLastCalledWith('set_cli_ready', { ready: false }),
    )
    expect(unlistenSecond).toHaveBeenCalledOnce()
  })
})
