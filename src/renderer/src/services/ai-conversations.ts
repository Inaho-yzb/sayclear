import { z } from 'zod'
import type { AIProvider } from '../../../shared/ai'
import { aiContextItemSchema, MAX_AI_CONTEXT_ITEMS } from '../../../shared/ai-context'

const conversationSchema = z.object({
  sessionId: z.string().max(128).nullable(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(30000),
        applied: z.boolean().optional(),
        boardName: z.string().optional(),
        contextItems: z.array(aiContextItemSchema).max(MAX_AI_CONTEXT_ITEMS).optional(),
      }),
    )
    .max(50),
  draft: z.string().default(''),
  draftContext: z
    .object({
      boardId: z.string(),
      versionKey: z.string(),
      items: z.array(aiContextItemSchema).max(MAX_AI_CONTEXT_ITEMS),
    })
    .optional(),
})
export type AIConversation = z.infer<typeof conversationSchema>
export type AIConversationSnapshot = { conversation: AIConversation; storageError: string }
export type AIConversationStorage = Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>
export type AIConversationStore = {
  getSnapshot: () => AIConversationSnapshot
  subscribe: (listener: () => void) => () => void
  updateConversation: (update: (conversation: AIConversation) => AIConversation) => void
  reset: () => void
  beginRequest: (requestId: string) => void
  rememberSession: (requestId: string, sessionId: string) => void
}

const legacyPrefix = 'say-clear.ai-chat.v1/'
const storagePrefix = 'say-clear.ai-chat.v2/'
const readError = '无法读取已保存的 AI 对话，当前对话暂存在内存中。'
const writeError = '对话记录暂时无法保存，关闭应用后可能丢失。'
const emptyConversation = (): AIConversation => ({ sessionId: null, messages: [], draft: '' })
const legacyContextSchema = z.object({
  boardId: z.string(),
  versionId: z.string().nullable(),
  iterationId: z.string(),
  readOnly: z.boolean(),
  provider: z.enum(['codex', 'qodercli']),
  config: z.object({ executable: z.string(), model: z.string() }),
})

function legacyContext(key: string) {
  if (!key.startsWith(legacyPrefix)) return null
  try {
    const value: unknown = JSON.parse(key.slice(legacyPrefix.length))
    if (!Array.isArray(value) || (value.length !== 5 && value.length !== 6)) return null
    // Older v1 keys omitted versionId. Parse fields instead of comparing JSON property order.
    const [boardId, versionId, iterationId, readOnly, provider, config] =
      value.length === 5 ? [value[0], null, ...value.slice(1)] : value
    return legacyContextSchema.parse({
      boardId,
      versionId,
      iterationId,
      readOnly,
      provider,
      config,
    })
  } catch {
    return null
  }
}

function parseConversation(value: string | null): AIConversation | null {
  if (value === null) return null
  try {
    return conversationSchema.parse(JSON.parse(value))
  } catch {
    return null
  }
}

export function createAIConversationStore(
  provider: AIProvider,
  storage: AIConversationStorage | undefined,
  legacyKey?: string,
): AIConversationStore {
  const storageKey = `${storagePrefix}${provider}`
  let storageError = storage ? '' : readError
  let conversation: AIConversation | null = null
  if (storage) {
    try {
      const value = storage.getItem(storageKey)
      conversation = parseConversation(value)
      if (value !== null && !conversation) storageError = readError
    } catch {
      storageError = readError
    }
  }
  if (!conversation && storage) {
    const preferred = legacyKey ? legacyContext(legacyKey) : null
    const candidates: { key: string; conversation: AIConversation; preferred: boolean }[] = []
    try {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      for (const key of keys) {
        if (!key) continue
        const context = legacyContext(key)
        if (!context || context.provider !== provider) continue
        let saved: AIConversation | null = null
        try {
          saved = parseConversation(storage.getItem(key))
        } catch {
          storageError = readError
        }
        // Empty per-page entries must not hide a conversation created on another page.
        if (!saved || (!saved.sessionId && !saved.messages.length && !saved.draft)) continue
        candidates.push({
          key,
          conversation: saved,
          preferred: !!preferred && JSON.stringify(context) === JSON.stringify(preferred),
        })
      }
    } catch {
      storageError = readError
    }
    // v1 has no timestamps; this is a deterministic fallback, not a recency order.
    candidates.sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
    })
    if (candidates.length) {
      conversation = candidates[0].conversation
      try {
        storage.setItem(storageKey, JSON.stringify(conversation))
        storageError = ''
      } catch {
        storageError = writeError
      }
    }
  }
  let snapshot: AIConversationSnapshot = {
    conversation: conversation ?? emptyConversation(),
    storageError,
  }
  let lastRequestId: string | null = null
  const listeners = new Set<() => void>()
  const updateConversation: AIConversationStore['updateConversation'] = (update) => {
    const next = update(snapshot.conversation)
    let storageError = ''
    try {
      if (!storage) throw new Error('Storage unavailable')
      storage.setItem(storageKey, JSON.stringify(next))
    } catch {
      storageError = writeError
    }
    snapshot = { conversation: next, storageError }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    updateConversation,
    reset: () => {
      lastRequestId = null
      updateConversation(emptyConversation)
    },
    beginRequest: (requestId) => {
      lastRequestId = requestId
    },
    rememberSession: (requestId, sessionId) => {
      // Unmounting/cancelling may precede thread.started. Only a newer request or reset supersedes it.
      if (lastRequestId !== requestId || snapshot.conversation.sessionId === sessionId) return
      updateConversation((current) => ({ ...current, sessionId }))
    },
  }
}

const stores = new Map<AIProvider, AIConversationStore>()
export function getAIConversationStore(
  provider: AIProvider,
  legacyKey?: string,
): AIConversationStore {
  const existing = stores.get(provider)
  if (existing) return existing
  let storage: AIConversationStorage | undefined
  try {
    storage = globalThis.localStorage
  } catch {
    // Accessing localStorage itself may throw when browser storage is disabled.
  }
  const store = createAIConversationStore(provider, storage, legacyKey)
  stores.set(provider, store)
  return store
}
