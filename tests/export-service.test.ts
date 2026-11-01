import { afterEach, expect, it, vi } from 'vitest'
import { createInitialWorkspace } from '../src/shared/model'
import { emptyDiagram } from '../src/shared/diagram'

const { nativeInvoke, loadHistory } = vi.hoisted(() => ({
  nativeInvoke: vi.fn(),
  loadHistory: vi.fn(),
}))
vi.mock('../src/renderer/src/services/desktop', () => ({ isDesktop: true, nativeInvoke }))
vi.mock('../src/renderer/src/services/storage', () => ({ storage: { loadHistory } }))
const { exportWorkspace, flushExports } = await import('../src/renderer/src/services/export')

afterEach(async () => {
  await flushExports()
  vi.resetAllMocks()
})

it('发送完整交付包并传递取消，取消不阻止关闭', async () => {
  const workspace = createInitialWorkspace()
  nativeInvoke.mockResolvedValue(null)
  const result = await exportWorkspace(
    workspace,
    {
      scope: 'board',
      boardId: workspace.activeNodeId!,
      includeHistory: true,
    },
    'folder',
  )
  expect(result).toBeNull()
  expect(nativeInvoke).toHaveBeenCalledTimes(1)
  const [command, args] = nativeInvoke.mock.calls[0]
  expect(command).toBe('export_bundle')
  expect(args.format).toBe('folder')
  expect(args.bundle.files.map((file: { path: string }) => file.path)).toEqual(
    expect.arrayContaining(['manifest.json', 'changes.md', 'diagram.html']),
  )
  await expect(flushExports()).resolves.toBeUndefined()
})

it('退出等待实际写入完成，写入错误保留给调用方而不会损害工作区保存', async () => {
  let fail!: (error: Error) => void
  nativeInvoke.mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  const workspace = createInitialWorkspace()
  const task = exportWorkspace(
    workspace,
    { scope: 'workspace', boardId: workspace.activeNodeId!, includeHistory: false },
    'zip',
  )
  const failure = expect(task).rejects.toThrow('磁盘已满')
  await vi.waitFor(() => expect(nativeInvoke).toHaveBeenCalledTimes(1))
  let flushed = false
  const flush = flushExports().then(() => {
    flushed = true
  })
  await Promise.resolve()
  expect(flushed).toBe(false)
  fail(new Error('磁盘已满'))
  await failure
  await flush
  expect(flushed).toBe(true)
})

it('历史无法读取时不打开保存对话框，不发布不完整交付包', async () => {
  const workspace = createInitialWorkspace()
  workspace.systems[0].contents[0].diagram = {
    ...emptyDiagram(),
    history: [
      {
        id: 'unloaded',
        name: '历史',
        publishedAt: '2026-11-01T00:00:00.000Z',
        snapshotDigest: '0123456789abcdef',
        componentCount: 0,
        connectionCount: 0,
      },
    ],
  }
  loadHistory.mockRejectedValue(new Error('快照文件损坏'))
  await expect(
    exportWorkspace(
      workspace,
      { scope: 'workspace', boardId: workspace.activeNodeId!, includeHistory: true },
      'folder',
    ),
  ).rejects.toThrow('快照文件损坏')
  expect(nativeInvoke).not.toHaveBeenCalled()
  expect(loadHistory).toHaveBeenCalledWith(workspace.activeNodeId, 'unloaded')
})
