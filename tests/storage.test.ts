import { afterEach, expect, it, vi } from 'vitest'
import { createInitialWorkspace } from '../src/shared/model'
import { emptyDiagram } from '../src/shared/diagram'
import { snapshot } from '../src/shared/iteration'

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }))
vi.mock('../src/renderer/src/services/desktop', () => ({ isDesktop: true, nativeInvoke }))
const { storage } = await import('../src/renderer/src/services/storage')

afterEach(async () => {
  await storage.flush().catch(() => {})
  vi.resetAllMocks()
})

it('串行保存快照，关闭时等待最后一次写入', async () => {
  const first = createInitialWorkspace()
  const second = structuredClone(first)
  second.systems[0].architecture.name = '第二次修改'
  let release!: () => void
  nativeInvoke
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    .mockResolvedValueOnce(undefined)
  const one = storage.save(first)
  const two = storage.save(second)
  second.systems[0].architecture.name = '之后的变化不能污染快照'
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  let flushed = false
  const flush = storage.flush().then(() => {
    flushed = true
  })
  expect(flushed).toBe(false)
  release()
  await Promise.all([one, two, flush])
  expect(nativeInvoke.mock.calls[1][1].workspace.systems[0].architecture.name).toBe('第二次修改')
  expect(flushed).toBe(true)
})

it('失败会通知调用方，下一次重试仍可以保存', async () => {
  nativeInvoke.mockRejectedValueOnce(new Error('磁盘只读')).mockResolvedValueOnce(undefined)
  const workspace = createInitialWorkspace()
  await expect(storage.save(workspace)).rejects.toThrow('磁盘只读')
  await expect(storage.flush()).rejects.toThrow('磁盘只读')
  await storage.save(workspace)
  await expect(storage.flush()).resolves.toBeUndefined()
})

it('原生读取失败时不静默降级到浏览器存储', async () => {
  nativeInvoke.mockRejectedValueOnce(new Error('工作区损坏'))
  await expect(storage.load()).rejects.toThrow('工作区损坏')
})

it('原生导出取消时返回 false', async () => {
  nativeInvoke.mockResolvedValueOnce(false)
  expect(await storage.exportMarkdown('需求', '# 需求')).toBe(false)
  expect(nativeInvoke).toHaveBeenCalledWith('export_markdown', {
    document: { name: '需求', content: '# 需求' },
  })
})

it('更换数据目录等待保存，关闭窗口等待目录切换完成', async () => {
  let finishSave!: () => void
  let finishChange!: (path: string) => void
  nativeInvoke
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishChange = resolve
        }),
    )
  const saved = storage.save(createInitialWorkspace())
  const changed = storage.chooseDataDirectory()
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  finishSave()
  await saved
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(2))
  expect(nativeInvoke.mock.calls[1][0]).toBe('choose_data_directory')
  let closed = false
  const flushed = storage.flush().then(() => {
    closed = true
  })
  expect(closed).toBe(false)
  finishChange('/新目录/需求数据')
  expect(await changed).toBe('/新目录/需求数据')
  await flushed
  expect(closed).toBe(true)
})

it('取消或目录切换失败不阻止已保存工作区关闭，保存失败则阻止切换', async () => {
  nativeInvoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(null)
  await storage.save(createInitialWorkspace())
  expect(await storage.chooseDataDirectory()).toBeNull()
  nativeInvoke.mockRejectedValueOnce(new Error('所选文件夹不是空文件夹'))
  await expect(storage.chooseDataDirectory()).rejects.toThrow('不是空文件夹')
  await expect(storage.flush()).resolves.toBeUndefined()
  nativeInvoke.mockRejectedValueOnce(new Error('保存失败'))
  await expect(storage.save(createInitialWorkspace())).rejects.toThrow('保存失败')
  const count = nativeInvoke.mock.calls.length
  await expect(storage.chooseDataDirectory()).rejects.toThrow('保存失败')
  expect(nativeInvoke).toHaveBeenCalledTimes(count)
  await expect(storage.flush()).rejects.toThrow('保存失败')
})

it('删除等待之前的保存，关闭窗口等待删除完成', async () => {
  const workspace = createInitialWorkspace()
  const empty = { schemaVersion: 2, activeNodeId: null, systems: [] }
  let releaseSave!: () => void
  let releaseDelete!: (value: unknown) => void
  nativeInvoke
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          releaseDelete = resolve
        }),
    )
  const saved = storage.save(workspace)
  const deleted = storage.deleteSystem(workspace.systems[0].architecture.id)
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  releaseSave()
  await saved
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(2))
  expect(nativeInvoke.mock.calls[1]).toEqual([
    'delete_system',
    { systemId: workspace.systems[0].architecture.id },
  ])
  let closed = false
  const flushed = storage.flush().then(() => {
    closed = true
  })
  expect(closed).toBe(false)
  releaseDelete(empty)
  expect(await deleted).toEqual(empty)
  await flushed
  expect(closed).toBe(true)
})

it('保存失败时不执行删除，删除失败保留错误供用户重试', async () => {
  const workspace = createInitialWorkspace()
  const id = workspace.systems[0].architecture.id
  nativeInvoke.mockRejectedValueOnce(new Error('磁盘只读'))
  await expect(storage.save(workspace)).rejects.toThrow('磁盘只读')
  await expect(storage.deleteSystem(id)).rejects.toThrow('磁盘只读')
  expect(nativeInvoke).toHaveBeenCalledTimes(1)
  nativeInvoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('删除失败'))
  await storage.save(workspace)
  await expect(storage.deleteSystem(id)).rejects.toThrow('删除失败')
  await expect(storage.flush()).rejects.toThrow('删除失败')
})

it('历史读取等待保存，合并并发请求，隔离缓存对象且失败后可重试', async () => {
  await storage.save(createInitialWorkspace())
  nativeInvoke.mockResolvedValueOnce(null)
  await storage.load()
  nativeInvoke.mockClear()
  let finish!: () => void
  nativeInvoke.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  nativeInvoke.mockResolvedValueOnce(snapshot(emptyDiagram()))
  const saved = storage.save(createInitialWorkspace())
  const first = storage.loadHistory('board', 'version')
  const second = storage.loadHistory('board', 'version')
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  finish()
  const [a, b] = await Promise.all([first, second])
  await saved
  expect(a).toEqual(b)
  expect(a).not.toBe(b)
  expect(nativeInvoke).toHaveBeenCalledTimes(2)
  await storage.loadHistory('board', 'version')
  expect(nativeInvoke).toHaveBeenCalledTimes(2)
  nativeInvoke
    .mockRejectedValueOnce(new Error('缺少历史文件'))
    .mockResolvedValueOnce(snapshot(emptyDiagram()))
  await expect(storage.loadHistory('board', 'missing')).rejects.toThrow('缺少历史文件')
  await expect(storage.loadHistory('board', 'missing')).resolves.toMatchObject({
    components: [],
    connections: [],
  })
})

it('重新读取工作区后不返回旧目录中尚未完成的历史请求', async () => {
  let finish!: (graph: unknown) => void
  nativeInvoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = storage.loadHistory('board', 'old-directory')
  const rejected = expect(pending).rejects.toThrow('数据来源已切换')
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  nativeInvoke.mockResolvedValueOnce(null)
  await storage.load()
  finish(snapshot(emptyDiagram()))
  await rejected
})
