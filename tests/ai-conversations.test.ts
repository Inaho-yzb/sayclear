import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAIConversationStore,
  getAIConversationStore,
  type AIConversation,
  type AIConversationStorage,
} from '../src/renderer/src/services/ai-conversations'
import type { AIProvider } from '../src/shared/ai'
import { createAIContextItem } from '../src/shared/ai-context'
import { exampleDiagram } from '../src/shared/diagram'

const stableKey = (provider: AIProvider) => `say-clear.ai-chat.v2/${provider}`
const legacyKey = (
  boardId = 'board-a',
  provider: AIProvider = 'codex',
  versionId: string | null = null,
  config: { executable: string; model: string } = { executable: provider, model: '' },
) =>
  'say-clear.ai-chat.v1/' + JSON.stringify([boardId, versionId, 'current', false, provider, config])
const savedConversation = (sessionId: string): AIConversation => ({
  sessionId,
  messages: [{ role: 'assistant', text: `回复 ${sessionId}`, boardName: '订单画板' }],
  draft: '',
})
function memoryStorage(entries: [string, string][] = []) {
  const data = new Map(entries)
  const storage: AIConversationStorage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value)
    }),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    },
  }
  return { storage, data }
}

afterEach(() => vi.unstubAllGlobals())

describe('跨页面 AI 会话存储', () => {
  it('通知订阅者前同步保存会话和草稿，重新创建存储后仍可恢复', () => {
    const { storage, data } = memoryStorage()
    const store = createAIConversationStore('codex', storage)
    const initial = store.getSnapshot()
    expect(store.getSnapshot()).toBe(initial)
    const listener = vi.fn(() => {
      expect(JSON.parse(data.get(stableKey('codex'))!)).toEqual(store.getSnapshot().conversation)
    })
    const unsubscribe = store.subscribe(listener)
    store.updateConversation(() => ({ ...savedConversation('thread-1'), draft: '继续补充' }))
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).not.toBe(initial)
    expect(createAIConversationStore('codex', storage).getSnapshot()).toEqual(store.getSnapshot())
    unsubscribe()
    store.updateConversation((current) => ({ ...current, draft: '离开页面前的输入' }))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('全局实例只加载一次，换画板、版本及工具配置仍返回同一提供器实例', () => {
    const { storage } = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const store = getAIConversationStore('codex', legacyKey())
    store.updateConversation(() => savedConversation('shared-thread'))
    const reads = vi.mocked(storage.getItem).mock.calls.length
    expect(
      getAIConversationStore(
        'codex',
        legacyKey('board-b', 'codex', 'history-1', { executable: '/new/codex', model: 'another' }),
      ),
    ).toBe(store)
    expect(storage.getItem).toHaveBeenCalledTimes(reads)
    expect(getAIConversationStore('qodercli')).not.toBe(store)
    expect(getAIConversationStore('qodercli').getSnapshot().conversation.sessionId).toBeNull()
  })

  it.each([5, 6])('迁移 v1 %s 项版本键，兼容缺省草稿并保留原记录', (length) => {
    const values =
      length === 6
        ? ['board-a', 'history-1', 'current', true, 'codex', { executable: 'codex', model: '' }]
        : ['board-a', 'current', false, 'codex', { executable: 'codex', model: '' }]
    const key = 'say-clear.ai-chat.v1/' + JSON.stringify(values)
    const legacy = JSON.stringify({
      sessionId: 'legacy-thread',
      messages: [{ role: 'user', text: '需求' }],
    })
    const { storage, data } = memoryStorage([[key, legacy]])
    const store = createAIConversationStore('codex', storage, key)
    expect(store.getSnapshot().conversation).toEqual({
      sessionId: 'legacy-thread',
      messages: [{ role: 'user', text: '需求' }],
      draft: '',
    })
    expect(data.get(key)).toBe(legacy)
    expect(JSON.parse(data.get(stableKey('codex'))!)).toEqual(store.getSnapshot().conversation)
  })

  it('优先语义匹配当前上下文，兼容五/六项键及配置字段顺序', () => {
    const current = legacyKey('board-z')
    const oldKey =
      'say-clear.ai-chat.v1/' +
      JSON.stringify(['board-z', 'current', false, 'codex', { model: '', executable: 'codex' }])
    const { storage, data } = memoryStorage([
      [legacyKey('board-a'), JSON.stringify(savedConversation('alphabetically-first'))],
      [oldKey, JSON.stringify(savedConversation('current-board'))],
    ])
    const store = createAIConversationStore('codex', storage, current)
    expect(store.getSnapshot().conversation.sessionId).toBe('current-board')
    expect(data.has(oldKey)).toBe(true)
    expect(data.has(legacyKey('board-a'))).toBe(true)
  })

  it('当前页面空缓存不遮蔽同工具旧会话，回退顺序不受插入顺序影响', () => {
    const empty = JSON.stringify({ sessionId: null, messages: [] })
    const entries: [string, string][] = [
      [legacyKey('current-page'), empty],
      [legacyKey('board-z'), JSON.stringify(savedConversation('z-thread'))],
      [legacyKey('board-a'), JSON.stringify(savedConversation('a-thread'))],
      [legacyKey('board-0', 'qodercli'), JSON.stringify(savedConversation('other-provider'))],
    ]
    for (const source of [entries, [...entries].reverse()]) {
      const { storage } = memoryStorage(source)
      expect(
        createAIConversationStore('codex', storage, legacyKey('current-page')).getSnapshot()
          .conversation.sessionId,
      ).toBe('a-thread')
    }
  })

  it('已持久化的新空会话优先于所有旧缓存，不在重启时重新导入', () => {
    const { storage, data } = memoryStorage([
      [legacyKey(), JSON.stringify(savedConversation('old-thread'))],
    ])
    const store = createAIConversationStore('codex', storage)
    store.reset()
    const reset = { sessionId: null, messages: [], draft: '' }
    expect(createAIConversationStore('codex', storage).getSnapshot().conversation).toEqual(reset)
    expect(data.has(legacyKey())).toBe(true)
  })

  it('Codex 与 Qoder 会话分别持久化，迁移和修改不会串会话', () => {
    const { storage } = memoryStorage([
      [legacyKey('board-a', 'codex'), JSON.stringify(savedConversation('codex-thread'))],
      [legacyKey('board-a', 'qodercli'), JSON.stringify(savedConversation('qoder-thread'))],
    ])
    const codex = createAIConversationStore('codex', storage)
    const qoder = createAIConversationStore('qodercli', storage)
    expect(codex.getSnapshot().conversation.sessionId).toBe('codex-thread')
    expect(qoder.getSnapshot().conversation.sessionId).toBe('qoder-thread')
    codex.reset()
    expect(qoder.getSnapshot().conversation.sessionId).toBe('qoder-thread')
    expect(
      createAIConversationStore('qodercli', storage).getSnapshot().conversation.sessionId,
    ).toBe('qoder-thread')
  })

  it('保存并恢复草稿及消息中的对象引用，保留画板版本且按工具隔离，新会话清空引用', () => {
    const graph = exampleDiagram()
    const items = [
      createAIContextItem(graph, { kind: 'component', id: graph.components[0].id })!,
      createAIContextItem(graph, { kind: 'connection', id: graph.connections[0].id })!,
    ]
    const { storage } = memoryStorage()
    const store = createAIConversationStore('codex', storage)
    store.updateConversation((current) => ({
      ...current,
      draft: '请解释这些对象',
      draftContext: { boardId: 'board-a', versionKey: 'iteration-1', items },
      messages: [{ role: 'user', text: '上一轮讨论', contextItems: items }],
    }))
    const restored = createAIConversationStore('codex', storage).getSnapshot().conversation
    expect(restored.draftContext).toEqual({ boardId: 'board-a', versionKey: 'iteration-1', items })
    expect(restored.messages[0].contextItems).toEqual(items)
    expect(
      createAIConversationStore('qodercli', storage).getSnapshot().conversation.draftContext,
    ).toBeUndefined()
    store.reset()
    const reset = createAIConversationStore('codex', storage).getSnapshot().conversation
    expect(reset.draftContext).toBeUndefined()
    expect(reset.messages).toEqual([])
  })

  it('卸载订阅后仍保存最后请求的迟到会话 ID，新请求和重置拒绝旧 ID', () => {
    const { storage } = memoryStorage()
    const store = createAIConversationStore('codex', storage)
    const unsubscribe = store.subscribe(vi.fn())
    store.beginRequest('request-1')
    unsubscribe()
    store.rememberSession('request-1', 'thread-1')
    expect(createAIConversationStore('codex', storage).getSnapshot().conversation.sessionId).toBe(
      'thread-1',
    )
    store.beginRequest('request-2')
    store.rememberSession('request-1', 'stale-thread')
    expect(store.getSnapshot().conversation.sessionId).toBe('thread-1')
    store.rememberSession('request-2', 'thread-2')
    expect(store.getSnapshot().conversation.sessionId).toBe('thread-2')
    store.reset()
    store.rememberSession('request-2', 'stale-after-reset')
    expect(store.getSnapshot().conversation.sessionId).toBeNull()
    store.beginRequest('request-3')
    store.rememberSession('request-3', 'thread-3')
    expect(store.getSnapshot().conversation.sessionId).toBe('thread-3')
  })

  it('写入失败时保留内存和警告，之后成功保存可恢复', () => {
    const { storage } = memoryStorage()
    const store = createAIConversationStore('codex', storage)
    vi.mocked(storage.setItem).mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })
    const listener = vi.fn()
    store.subscribe(listener)
    store.updateConversation(() => savedConversation('in-memory'))
    expect(store.getSnapshot().conversation.sessionId).toBe('in-memory')
    expect(store.getSnapshot().storageError).toContain('无法保存')
    expect(listener).toHaveBeenCalledOnce()
    store.updateConversation((current) => ({ ...current, draft: 'retry-save' }))
    expect(store.getSnapshot().storageError).toBe('')
    expect(createAIConversationStore('codex', storage).getSnapshot()).toEqual(store.getSnapshot())
  })

  it('迁移保存失败保留恢复出的会话及原缓存', () => {
    const key = legacyKey()
    const value = JSON.stringify(savedConversation('legacy-thread'))
    const { storage, data } = memoryStorage([[key, value]])
    vi.mocked(storage.setItem).mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const store = createAIConversationStore('codex', storage)
    expect(store.getSnapshot().conversation.sessionId).toBe('legacy-thread')
    expect(store.getSnapshot().storageError).toContain('无法保存')
    expect(data.get(key)).toBe(value)
  })

  it('localStorage 读取或枚举异常不阻止使用内存会话', () => {
    const { storage } = memoryStorage()
    vi.mocked(storage.getItem).mockImplementation(() => {
      throw new Error('storage disabled')
    })
    Object.defineProperty(storage, 'length', {
      get() {
        throw new Error('storage disabled')
      },
    })
    const store = createAIConversationStore('codex', storage)
    expect(store.getSnapshot().storageError).toContain('无法读取')
    store.beginRequest('request-1')
    store.rememberSession('request-1', 'memory-thread')
    expect(store.getSnapshot().conversation.sessionId).toBe('memory-thread')
    const unavailable = createAIConversationStore('codex', undefined)
    unavailable.updateConversation(() => savedConversation('without-storage'))
    expect(unavailable.getSnapshot().conversation.sessionId).toBe('without-storage')
    expect(unavailable.getSnapshot().storageError).toContain('无法保存')
  })

  it('忽略损坏的旧键和记录，保留它们并继续寻找有效会话', () => {
    const brokenKey = 'say-clear.ai-chat.v1/not-json'
    const brokenRecord = legacyKey('board-0')
    const { storage, data } = memoryStorage([
      [brokenKey, '{}'],
      [brokenRecord, '{invalid'],
      [legacyKey('board-a'), JSON.stringify(savedConversation('valid-thread'))],
    ])
    expect(createAIConversationStore('codex', storage).getSnapshot().conversation.sessionId).toBe(
      'valid-thread',
    )
    expect(data.get(brokenKey)).toBe('{}')
    expect(data.get(brokenRecord)).toBe('{invalid')
  })
})
