import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createInitialWorkspace } from '../src/shared/model'
import legacy from './fixtures/workspace-v1.json'
import { browserStore } from '../src/renderer/src/services/browser-storage'
import { discardIteration, iterationExample, publishIteration } from '../src/shared/iteration'

vi.mock('../src/renderer/src/services/desktop', () => ({ isDesktop: false, nativeInvoke: vi.fn() }))
const { storage } = await import('../src/renderer/src/services/storage')
let data: Map<string, string>
let setItem: ReturnType<typeof vi.fn>
beforeEach(() => {
  data = new Map()
  setItem = vi.fn((key: string, value: string) => data.set(key, value))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem,
    removeItem: (key: string) => data.delete(key),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    },
  })
})
afterEach(async () => {
  await storage.flush().catch(() => {})
  vi.unstubAllGlobals()
})

it('浏览器预览明确不支持本地文件夹，不改变已保存内容', async () => {
  const workspace = createInitialWorkspace()
  await storage.save(workspace)
  expect(await storage.getDataDirectory()).toBeNull()
  await expect(storage.chooseDataDirectory()).rejects.toThrow('桌面版')
  expect(await storage.load()).toEqual(workspace)
})

it('浏览器删除最后一个系统后读取空工作区，不重新导入旧版数据', async () => {
  data.set('say-clear.workspace.v1', JSON.stringify(legacy))
  const workspace = await storage.load()
  await storage.save(workspace!)
  const empty = await storage.deleteSystem(legacy.activeProjectId)
  expect(empty).toEqual({ schemaVersion: 2, activeNodeId: null, systems: [] })
  expect(await storage.load()).toEqual(empty)
  expect(data.get('say-clear.workspace.v1')).toBe(JSON.stringify(legacy))
})

it('浏览器删除写入失败时原数据保持可读，重新保存后可以重试', async () => {
  const workspace = createInitialWorkspace()
  const id = workspace.systems[0].architecture.id
  await storage.save(workspace)
  setItem.mockImplementationOnce(() => {
    throw new Error('浏览器存储不可写')
  })
  await expect(storage.deleteSystem(id)).rejects.toThrow('浏览器存储不可写')
  expect(await storage.load()).toEqual(workspace)
  await storage.save(workspace)
  expect((await storage.deleteSystem(id)).systems).toEqual([])
})

const prefix = 'say-clear.files.v3/'
function sample() {
  const workspace = createInitialWorkspace()
  workspace.systems[0].contents[0].diagram = iterationExample()
  return workspace
}
it('浏览器拆分画板和迭代，普通保存只修改变动的键，发布复用基线', () => {
  const workspace = sample()
  const board = workspace.systems[0].contents[0]
  const versionKey = `${prefix}version/${board.id}/${board.diagram!.iteration!.id}`
  browserStore.save(workspace)
  const baseline = data.get(versionKey)
  setItem.mockClear()
  browserStore.save(workspace)
  expect(setItem).not.toHaveBeenCalled()
  board.diagram!.components[0].name = '本次改动'
  browserStore.save(workspace)
  expect(setItem.mock.calls.map(([key]) => key)).toEqual([
    `${prefix}pending`,
    `${prefix}iteration/${board.id}/${board.diagram!.iteration!.id}`,
  ])
  board.diagram = publishIteration(board.diagram!)
  setItem.mockClear()
  const saved = browserStore.save(workspace)
  expect(data.get(versionKey)).toBe(baseline)
  expect(setItem.mock.calls.some(([key]) => key === versionKey)).toBe(false)
  expect(saved.systems[0].contents[0].diagram!.history[0].snapshot).toBeUndefined()
  expect(browserStore.loadHistory(board.id, board.diagram.history[0].id)).toEqual(
    board.diagram.history[0].snapshot,
  )
  data.delete(versionKey)
  const loaded = browserStore.load()!
  expect(() => browserStore.loadHistory(board.id, board.diagram!.history[0].id)).toThrow('缺失')
  expect(() => browserStore.save(loaded)).not.toThrow()
})

it('浏览器拆分存储保留仓库与迭代分支，发布后历史索引保留关联', () => {
  const workspace = sample()
  workspace.gitRepository = {
    path: '/项目/代码 仓库',
    baseBranch: 'main',
    remoteUrl: 'https://example.com/team/repository.git',
  }
  const board = workspace.systems[0].contents[0]
  const git = {
    repositoryPath: workspace.gitRepository.path,
    branch: 'iteration/注册流程',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
  }
  board.diagram!.iteration!.git = git
  browserStore.save(workspace)
  const restored = browserStore.load()!
  expect(restored.gitRepository).toEqual(workspace.gitRepository)
  const restoredBoard = restored.systems[0].contents[0]
  expect(restoredBoard.diagram!.iteration!.git).toEqual(git)

  restoredBoard.diagram = publishIteration(restoredBoard.diagram!)
  const saved = browserStore.save(restored)
  expect(saved.systems[0].contents[0].diagram!.history[0].snapshot).toBeUndefined()
  expect(saved.systems[0].contents[0].diagram!.history[0].git).toEqual(git)
  const published = browserStore.load()!
  expect(published.systems[0].contents[0].diagram!.history[0].git).toEqual(git)
  browserStore.save(published)
  expect(browserStore.load()).toEqual(published)
})

it('迁移保留旧数据，中途写入失败可恢复，放弃迭代清理草稿和基线且允许撤销', () => {
  const workspace = sample()
  const old = JSON.stringify(workspace)
  data.set('say-clear.workspace.v2', old)
  let writes = 0
  setItem.mockImplementation((key: string, value: string) => {
    if (++writes === 4) throw new Error('模拟写入中断')
    data.set(key, value)
  })
  expect(() => browserStore.load()).toThrow('模拟写入中断')
  expect(data.get('say-clear.workspace.v2')).toBe(old)
  expect(data.has(`${prefix}pending`)).toBe(true)
  setItem.mockImplementation((key: string, value: string) => data.set(key, value))
  expect(browserStore.load()).toEqual(workspace)
  const board = workspace.systems[0].contents[0]
  const draft = board.diagram!
  board.diagram = discardIteration(draft)
  browserStore.save(workspace)
  expect(data.has(`${prefix}iteration/${board.id}/${draft.iteration!.id}`)).toBe(false)
  expect(data.has(`${prefix}version/${board.id}/${draft.iteration!.id}`)).toBe(false)
  board.diagram = draft
  browserStore.save(workspace)
  expect(browserStore.load()).toEqual(workspace)
  expect(data.get('say-clear.workspace.v2')).toBe(old)
})

it('迁移无法写入日志或旧数据损坏时，不留下半成品和空工作区', () => {
  const old = JSON.stringify(sample())
  data.set('say-clear.workspace.v2', old)
  setItem.mockImplementationOnce(() => {
    throw new Error('容量不足')
  })
  expect(() => browserStore.load()).toThrow('容量不足')
  expect([...data.keys()]).toEqual(['say-clear.workspace.v2'])
  data.set('say-clear.workspace.v2', 'broken')
  expect(() => browserStore.load()).toThrow()
  expect([...data.keys()]).toEqual(['say-clear.workspace.v2'])
})
