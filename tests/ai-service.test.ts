import { afterEach, expect, it, vi } from 'vitest'
import type { AIProgress } from '../src/renderer/src/services/ai'

const { nativeInvoke } = vi.hoisted(() => ({ nativeInvoke: vi.fn() }))
vi.mock('../src/renderer/src/services/desktop', () => ({ isDesktop: true, nativeInvoke }))
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: AIProgress) => void
  },
}))
const { aiService, AI_RESPONSE_TIMEOUT_MS } = await import('../src/renderer/src/services/ai')
const request = { requestId: 'request-1', sessionId: null, prompt: '修改画板' }

function channel() {
  return nativeInvoke.mock.calls.find(([command]) => command === 'run_ai_turn')![1].onProgress as {
    onmessage: (event: AIProgress) => void
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('在最终回复前传递会话和重连进度，拒绝其他请求的事件', async () => {
  let complete!: (result: { sessionId: string; output: string }) => void
  nativeInvoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const onProgress = vi.fn()
  const result = aiService.send(request, onProgress)
  const stream = channel()
  stream.onmessage({ requestId: 'other', stage: 'thinking', message: '无关事件' })
  expect(onProgress).not.toHaveBeenCalled()
  const connected: AIProgress = {
    requestId: request.requestId,
    sessionId: 'session-1',
    stage: 'connected',
    message: '会话已创建',
  }
  stream.onmessage(connected)
  stream.onmessage({ requestId: request.requestId, stage: 'retrying', message: '正在重连' })
  expect(onProgress).toHaveBeenCalledWith(connected)
  expect(onProgress).toHaveBeenCalledTimes(2)
  complete({ sessionId: 'session-1', output: 'reply' })
  await expect(result).resolves.toEqual({ sessionId: 'session-1', output: 'reply' })
  stream.onmessage(connected)
  expect(onProgress).toHaveBeenCalledTimes(2)
})

it('IPC 一直不返回时在 330 秒结束等待并取消后端，忽略迟到事件和结果', async () => {
  vi.useFakeTimers()
  let complete!: (result: { sessionId: string; output: string }) => void
  nativeInvoke.mockImplementation((command) =>
    command === 'run_ai_turn'
      ? new Promise((resolve) => {
          complete = resolve
        })
      : Promise.resolve(),
  )
  const onProgress = vi.fn()
  const result = aiService.send(request, onProgress)
  const failure = expect(result).rejects.toThrow('5 分 30 秒')
  const stream = channel()
  stream.onmessage({
    requestId: request.requestId,
    sessionId: 'session-1',
    stage: 'connected',
    message: '会话已创建',
  })
  await vi.advanceTimersByTimeAsync(AI_RESPONSE_TIMEOUT_MS - 1)
  expect(nativeInvoke).not.toHaveBeenCalledWith('cancel_ai_turn', expect.anything())
  await vi.advanceTimersByTimeAsync(1)
  await failure
  expect(nativeInvoke).toHaveBeenCalledWith('cancel_ai_turn', { requestId: request.requestId })
  stream.onmessage({ requestId: request.requestId, stage: 'completed', message: '迟到事件' })
  complete({ sessionId: 'session-1', output: 'late' })
  await Promise.resolve()
  expect(onProgress).toHaveBeenCalledTimes(1)
})

it('原生失败立即返回，保留已交给界面的会话 ID 并清理兜底计时器', async () => {
  vi.useFakeTimers()
  let fail!: (error: Error) => void
  nativeInvoke.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  const onProgress = vi.fn()
  const result = aiService.send(request, onProgress)
  const failure = expect(result).rejects.toThrow('连接失败')
  channel().onmessage({
    requestId: request.requestId,
    sessionId: 'session-retry',
    stage: 'connected',
    message: '会话已创建',
  })
  fail(new Error('连接失败'))
  await failure
  expect(onProgress.mock.calls[0][0].sessionId).toBe('session-retry')
  await vi.advanceTimersByTimeAsync(AI_RESPONSE_TIMEOUT_MS)
  expect(nativeInvoke).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
