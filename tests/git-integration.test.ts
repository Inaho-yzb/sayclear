import { afterEach, expect, it, vi } from 'vitest'
import { createInitialWorkspace, getProject } from '../src/shared/model'
import { emptyDiagram } from '../src/shared/diagram'
import { startIteration } from '../src/shared/iteration'

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }))
vi.mock('../src/renderer/src/services/desktop', () => ({ isDesktop: true, nativeInvoke }))
const { storage } = await import('../src/renderer/src/services/storage')
const { applyIterationAction } = await import('../src/renderer/src/services/iterations')

afterEach(async () => {
  await storage.flush().catch(() => {})
  vi.resetAllMocks()
})

function linkedWorkspace() {
  return {
    ...createInitialWorkspace(),
    gitRepository: { path: '/项目/repository', baseBranch: 'main' },
  }
}

it('普通迭代保持本地流程，已关联仓库的迭代要求 Git 分支参数', async () => {
  const local = createInitialWorkspace()
  const next = await applyIterationAction(local, {
    type: 'start',
    boardId: local.activeNodeId!,
    name: '登录流程',
  })
  expect(getProject(next).diagram?.iteration?.name).toBe('登录流程')
  expect(nativeInvoke).not.toHaveBeenCalled()
  const linked = linkedWorkspace()
  const action = { type: 'start' as const, boardId: linked.activeNodeId!, name: '登录流程' }
  await expect(applyIterationAction(linked, action)).rejects.toThrow('基准分支')
  await expect(
    applyIterationAction(linked, action, { branch: '--force', baseBranch: 'main' }),
  ).rejects.toThrow('有效的 Git 分支名')
  expect(nativeInvoke).not.toHaveBeenCalled()
  expect(getProject(linked).diagram?.iteration).toBeUndefined()
})

it('分支创建等待之前的保存，返回原生保存后的关联，关闭窗口等待创建结束', async () => {
  const workspace = linkedWorkspace()
  const boardId = workspace.activeNodeId!
  let finishSave!: () => void
  let finishCreate!: (value: unknown) => void
  nativeInvoke
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          finishCreate = resolve
        }),
    )
  const saving = storage.save(workspace)
  const creating = applyIterationAction(
    workspace,
    { type: 'start', boardId, name: '登录流程' },
    { branch: 'iteration/login', baseBranch: 'main' },
  )
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  finishSave()
  await saving
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(2))
  const [command, request] = nativeInvoke.mock.calls[1]
  expect(command).toBe('create_git_iteration')
  expect(request).toMatchObject({ boardId, branch: 'iteration/login', baseBranch: 'main' })
  expect(getProject(request.workspace).diagram?.iteration?.name).toBe('登录流程')
  let closed = false
  const closing = storage.flush().then(() => {
    closed = true
  })
  expect(closed).toBe(false)
  const saved = structuredClone(request.workspace)
  getProject(saved) // Ensure the selected board still exists in the candidate.
  saved.systems[0].contents[0].diagram.iteration.git = {
    repositoryPath: workspace.gitRepository.path,
    branch: 'iteration/login',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
  }
  finishCreate(saved)
  const next = await creating
  await closing
  expect(getProject(next).diagram?.iteration?.git?.branch).toBe('iteration/login')
  expect(closed).toBe(true)
  expect(getProject(workspace).diagram?.iteration).toBeUndefined()
})

it('分支失败不返回本地迭代，重新保存后可重试，发布和改名不再拉分支', async () => {
  const workspace = linkedWorkspace()
  const boardId = workspace.activeNodeId!
  nativeInvoke.mockRejectedValueOnce(new Error('分支已存在'))
  await expect(
    applyIterationAction(
      workspace,
      { type: 'start', boardId, name: '登录' },
      {
        branch: 'iteration/login',
        baseBranch: 'main',
      },
    ),
  ).rejects.toThrow('分支已存在')
  expect(getProject(workspace).diagram?.iteration).toBeUndefined()
  await expect(storage.flush()).resolves.toBeUndefined()
  nativeInvoke.mockResolvedValueOnce(undefined)
  await storage.save(workspace)
  const diagram = startIteration(emptyDiagram(), '登录')
  diagram.iteration!.git = {
    repositoryPath: workspace.gitRepository.path,
    branch: 'iteration/login',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
  }
  workspace.systems[0].contents[0].diagram = diagram
  nativeInvoke.mockClear()
  const renamed = await applyIterationAction(workspace, {
    type: 'rename',
    boardId,
    iterationId: diagram.iteration!.id,
    name: '登录改版',
  })
  expect(getProject(renamed).diagram?.iteration?.git).toEqual(diagram.iteration!.git)
  expect(nativeInvoke).not.toHaveBeenCalled()
})

it('前置保存失败时不会执行 Git 操作', async () => {
  const workspace = linkedWorkspace()
  nativeInvoke.mockRejectedValueOnce(new Error('磁盘只读'))
  await expect(storage.save(workspace)).rejects.toThrow('磁盘只读')
  await expect(
    applyIterationAction(
      workspace,
      { type: 'start', boardId: workspace.activeNodeId!, name: '登录' },
      {
        branch: 'iteration/login',
        baseBranch: 'main',
      },
    ),
  ).rejects.toThrow('磁盘只读')
  expect(nativeInvoke).toHaveBeenCalledTimes(1)
})
