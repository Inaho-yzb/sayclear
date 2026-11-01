import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowUp,
  Box,
  Check,
  Link2,
  LoaderCircle,
  Plus,
  Settings2,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import {
  aiGraphRevision,
  aiProviders,
  buildAIPrompt,
  parseAIReply,
  type AISettings,
} from '../../../shared/ai'
import { type Diagram } from '../../../shared/diagram'
import {
  MAX_AI_CONTEXT_ITEMS,
  addAIContextItem,
  aiContextItemId,
  aiContextItemKey,
  aiContextItemLabel,
  createAIContextItem,
  type AIContextItem,
} from '../../../shared/ai-context'
import { type ComponentCatalog } from '../../../shared/component-catalog'
import { aiService, type AIProgress } from '../services/ai'
import { isDesktop } from '../services/desktop'
import { getAIConversationStore } from '../services/ai-conversations'
import './ai.css'

export type AIContextRequest = {
  id: string
  boardId: string
  versionKey: string
  item: AIContextItem
}

export function aiContextVersionKey(
  boardId: string,
  versionId: string | undefined,
  graph: Diagram,
  readOnly: boolean,
) {
  return JSON.stringify([boardId, versionId || null, graph.iteration?.id ?? null, readOnly])
}

type Props = {
  boardId: string
  versionId?: string
  scopeName: string
  scopeDescription?: string
  graph: Diagram
  contextGraph: Diagram
  contextRequest: AIContextRequest | null
  onContextConsumed: (id: string) => void
  catalog: ComponentCatalog
  readOnly: boolean
  active: boolean
  onApply: (graph: Diagram) => boolean
  onOpenSettings: () => void
}

export function AIAssistant(props: Props) {
  const [settings, setSettings] = useState<AISettings | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const load = () => {
      void aiService.loadSettings().then(
        (value) => {
          if (!disposed) {
            setSettings(value)
            setError('')
          }
        },
        (error: unknown) => {
          if (!disposed) {
            setSettings(null)
            setError(String(error))
          }
        },
      )
    }
    load()
    window.addEventListener('ai-settings-changed', load)
    return () => {
      disposed = true
      window.removeEventListener('ai-settings-changed', load)
    }
  }, [])
  if (!settings)
    return props.active ? (
      <button
        className="ai-fab"
        aria-label="打开 AI 设置"
        title={error || '正在读取 AI 设置'}
        onClick={props.onOpenSettings}
      >
        <Sparkles size={22} />
        <span>{error ? 'AI 设置' : 'AI'}</span>
      </button>
    ) : null
  // Only used to recover existing v1 records. Page identity is no longer session identity.
  const legacyKey = JSON.stringify([
    props.boardId,
    props.versionId,
    props.graph.iteration?.id ?? 'current',
    props.readOnly,
    settings.provider,
    settings[settings.provider],
  ])
  return (
    <ConversationPanel
      key={settings.provider}
      {...props}
      settings={settings}
      legacyKey={`say-clear.ai-chat.v1/${legacyKey}`}
    />
  )
}

function ConversationPanel({
  settings,
  legacyKey,
  ...props
}: Props & { settings: AISettings; legacyKey: string }) {
  const [open, setOpen] = useState(false)
  const conversationStore = getAIConversationStore(settings.provider, legacyKey)
  const { conversation, storageError } = useSyncExternalStore(
    conversationStore.subscribe,
    conversationStore.getSnapshot,
  )
  const setConversation = conversationStore.updateConversation
  const input = conversation.draft
  const setInput = (draft: string) => setConversation((current) => ({ ...current, draft }))
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<AIProgress | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const startedAt = useRef(0)
  const [error, setError] = useState('')
  const request = useRef<string | null>(null)
  const latest = useRef(props)
  latest.current = props
  const dialog = useRef<HTMLDialogElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const messages = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const versionKey = aiContextVersionKey(
    props.boardId,
    props.versionId,
    props.graph,
    props.readOnly,
  )
  const contextItems =
    conversation.draftContext?.boardId === props.boardId &&
    conversation.draftContext.versionKey === versionKey
      ? conversation.draftContext.items
      : []
  const { contextRequest, onContextConsumed, boardId, active } = props

  useEffect(() => {
    if (!contextRequest || !active) return
    if (contextRequest.boardId === boardId && contextRequest.versionKey === versionKey) {
      const current = conversationStore.getSnapshot().conversation.draftContext
      const items =
        current?.boardId === boardId && current.versionKey === versionKey ? current.items : []
      const next = addAIContextItem(items, contextRequest.item)
      if (next === items)
        setError(`每轮最多引用 ${MAX_AI_CONTEXT_ITEMS} 个对象，请先移除部分上下文。`)
      else {
        setConversation((current) => ({
          ...current,
          draftContext: { boardId, versionKey, items: next },
        }))
        setError('')
      }
      setOpen(true)
      textarea.current?.focus()
    }
    onContextConsumed(contextRequest.id)
  }, [
    contextRequest,
    active,
    boardId,
    versionKey,
    onContextConsumed,
    conversationStore,
    setConversation,
  ])

  useEffect(
    () => () => {
      const id = request.current
      request.current = null
      if (id) {
        conversationStore.updateConversation((current) => ({
          ...current,
          messages: [
            ...current.messages.slice(-49),
            {
              role: 'assistant',
              text: '已暂停本轮请求，会话和记录已保留，可以继续对话。',
            },
          ],
        }))
        void aiService.cancel(id).catch(() => {})
      }
    },
    [conversationStore],
  )
  useEffect(() => {
    if (!open || !props.active) return
    const element = dialog.current!
    element.showModal()
    textarea.current?.focus()
    return () => element.close()
  }, [open, props.active])
  useEffect(() => {
    messages.current?.scrollTo({ top: messages.current.scrollHeight })
  }, [conversation, busy, error, open])

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [busy])

  const send = async () => {
    const message = input.trim()
    if (!message || request.current || !isDesktop) return
    const id = crypto.randomUUID()
    request.current = id
    conversationStore.beginRequest(id)
    startedAt.current = Date.now()
    setElapsedSeconds(0)
    setProgress({
      requestId: id,
      stage: 'starting',
      message: `正在启动 ${aiProviders[settings.provider]}…`,
    })
    setBusy(true)
    setError('')
    const start = latest.current
    const sentContext = contextItems.map(
      (item) =>
        createAIContextItem(start.contextGraph, {
          kind: item.kind,
          id: aiContextItemId(item),
        }) ?? item,
    )
    const revision = aiGraphRevision(start.graph)
    const catalogRevision = JSON.stringify(start.catalog)
    setConversation((current) => ({
      ...current,
      draft: '',
      draftContext: undefined,
      messages: [
        ...current.messages.slice(-48),
        {
          role: 'user',
          text: message,
          boardName: start.scopeName,
          contextItems: sentContext.length ? sentContext : undefined,
        },
      ],
    }))
    try {
      const result = await aiService.send(
        {
          requestId: id,
          sessionId: conversation.sessionId,
          prompt: buildAIPrompt({
            message,
            name: start.scopeName,
            description: start.scopeDescription,
            graph: start.graph,
            catalog: start.catalog,
            readOnly: start.readOnly,
            contextItems: sentContext,
          }),
        },
        (event) => {
          if (event.requestId !== id) return
          // Retain a late creation event even if navigation unmounted this view.
          // The store rejects IDs from a request superseded by a newer turn/session.
          if (event.sessionId) conversationStore.rememberSession(id, event.sessionId)
          if (request.current !== id) return
          setProgress(event)
        },
      )
      conversationStore.rememberSession(id, result.sessionId)
      if (request.current !== id) return
      const current = latest.current
      const reply = parseAIReply(result.output, start.graph, start.catalog)
      let applied = false
      if (reply.diagram) {
        if (start.readOnly || current.readOnly)
          throw new Error('当前版本为只读，AI 修改未应用。请切换到可编辑画板。')
        if (
          current.boardId !== start.boardId ||
          current.versionId !== start.versionId ||
          current.graph.iteration?.id !== start.graph.iteration?.id ||
          aiGraphRevision(current.graph) !== revision ||
          JSON.stringify(current.catalog) !== catalogRevision
        )
          throw new Error('等待期间画板已变化，AI 修改未应用。请重新发送需求，基于最新画板生成。')
        if (aiGraphRevision(reply.diagram) !== revision) {
          applied = current.onApply(reply.diagram)
          if (!applied) throw new Error('画板校验未通过，AI 修改未应用。')
        }
      }
      setConversation((current) => ({
        ...current,
        messages: [
          ...current.messages.slice(-49),
          { role: 'assistant', text: reply.message, applied },
        ],
      }))
    } catch (error) {
      if (request.current === id) {
        const text = error instanceof Error ? error.message : 'AI 请求失败，请重试'
        setError(text)
        setConversation((current) => ({
          ...current,
          messages: [
            ...current.messages.slice(-49),
            { role: 'assistant', text: `本轮未应用修改：${text}` },
          ],
        }))
        setConversation((current) => {
          const pending = current.draftContext
          const items =
            pending?.boardId === start.boardId && pending.versionKey === versionKey
              ? pending.items
              : []
          return {
            ...current,
            draft: message,
            draftContext: sentContext.length
              ? {
                  boardId: start.boardId,
                  versionKey,
                  items: sentContext.reduce(addAIContextItem, items),
                }
              : pending,
          }
        })
      }
    } finally {
      if (request.current === id) {
        request.current = null
        setBusy(false)
        textarea.current?.focus()
      }
    }
  }
  const stop = async () => {
    const id = request.current
    if (!id) return
    // Invalidate first, so a racing completion can never apply a cancelled result.
    request.current = null
    setBusy(false)
    setConversation((current) => ({
      ...current,
      messages: [
        ...current.messages.slice(-49),
        { role: 'assistant', text: '已停止，本轮未修改画板。' },
      ],
    }))
    try {
      await aiService.cancel(id)
    } catch (error) {
      setError(error instanceof Error ? error.message : '停止工具失败')
    }
  }

  return (
    <>
      {props.active && (
        <button
          className={`ai-fab ${busy ? 'working' : ''}`}
          aria-label="打开 AI 对话"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {busy ? <LoaderCircle size={23} className="spin" /> : <Sparkles size={23} />}
          <span>AI</span>
        </button>
      )}
      {open && props.active && (
        <dialog
          className="ai-dialog"
          ref={dialog}
          aria-labelledby="ai-dialog-title"
          onCancel={(event) => {
            event.preventDefault()
            setOpen(false)
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <header className="ai-dialog-header">
            <span className="ai-avatar">
              <Sparkles size={19} />
            </span>
            <div>
              <h2 id="ai-dialog-title">AI 画板助手</h2>
              <p>
                {aiProviders[settings.provider]} ·{' '}
                {conversation.sessionId ? '会话已连接' : '新会话'}
              </p>
            </div>
            <button
              className="icon-button"
              title="新建会话"
              aria-label="新建 AI 会话"
              disabled={busy}
              onClick={() => {
                conversationStore.reset()
                setError('')
                setInput('')
                textarea.current?.focus()
              }}
            >
              <Plus size={17} />
            </button>
            <button
              className="icon-button"
              title="AI 设置"
              aria-label="AI 设置"
              disabled={busy}
              onClick={props.onOpenSettings}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="icon-button"
              title="收起对话"
              aria-label="收起 AI 对话"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </header>
          <div className="ai-board-context">
            <span />
            {props.scopeName}
            <small>
              {props.readOnly
                ? '只读 · 仅讨论'
                : props.graph.iteration
                  ? '编辑当前迭代'
                  : '编辑现状'}
            </small>
          </div>
          <div
            className="ai-messages"
            ref={messages}
            role="log"
            aria-label="AI 对话记录"
            aria-live="polite"
          >
            {!conversation.messages.length && (
              <div className="ai-welcome">
                <Sparkles size={30} strokeWidth={1.5} />
                <h3>一起把系统图说清楚</h3>
                <p>描述你的想法，我会结合当前画板回答，或直接调整组件与连接。</p>
                <button
                  disabled={busy}
                  onClick={() => {
                    setInput('请解释当前画板的业务流程，并指出可以完善的地方。')
                    textarea.current?.focus()
                  }}
                >
                  帮我梳理当前画板 <ArrowUp size={13} />
                </button>
              </div>
            )}
            {conversation.messages.map((message, index) => (
              <div key={index} className={`ai-message ${message.role}`}>
                <span className="ai-message-role">
                  {message.role === 'user' ? '你' : aiProviders[settings.provider]}
                  {message.boardName && ` · ${message.boardName}`}
                </span>
                <p>{message.text}</p>
                {!!message.contextItems?.length && (
                  <div className="ai-message-contexts" aria-label="消息引用的画板对象">
                    <ContextChips items={message.contextItems} />
                  </div>
                )}
                {message.applied && (
                  <span className="ai-applied">
                    <Check size={12} />
                    已应用到画板 · 可撤销
                  </span>
                )}
              </div>
            ))}
            {busy && (
              <div className="ai-thinking" role="status" data-stage={progress?.stage ?? 'starting'}>
                <LoaderCircle size={15} className="spin" />
                <div>
                  <span>{progress?.message || '正在等待 AI 工具响应…'}</span>
                  <small aria-hidden="true">已等待 {elapsedSeconds} 秒</small>
                </div>
              </div>
            )}
          </div>
          {error && (
            <div className="ai-error" role="alert">
              {error}
            </div>
          )}
          {storageError && (
            <div className="ai-error" role="status">
              {storageError}
            </div>
          )}
          {!isDesktop && (
            <div className="ai-preview-note">浏览器中可编辑并保存草稿；发送消息请使用桌面版。</div>
          )}
          <form
            className="ai-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            {!!contextItems.length && (
              <div className="ai-context-list" aria-label="本轮引用的画板对象">
                <ContextChips
                  items={contextItems}
                  onRemove={(item) => {
                    setConversation((current) => ({
                      ...current,
                      draftContext: {
                        boardId: props.boardId,
                        versionKey,
                        items: contextItems.filter(
                          (existing) => aiContextItemKey(existing) !== aiContextItemKey(item),
                        ),
                      },
                    }))
                    textarea.current?.focus()
                  }}
                />
              </div>
            )}
            <textarea
              ref={textarea}
              aria-label="AI 对话输入"
              placeholder={
                props.readOnly ? '询问这个版本的设计…' : '例如：添加短信验证，并连接到注册流程…'
              }
              value={input}
              maxLength={10000}
              disabled={busy}
              rows={3}
              onChange={(event) => setInput(event.target.value)}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
              }}
              onKeyDown={(event) => {
                if (
                  isDesktop &&
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="ai-composer-actions">
              <span>
                {!isDesktop
                  ? '草稿自动保存，发送请使用桌面版'
                  : props.readOnly
                    ? '只读版本不会修改画板'
                    : '修改自动应用，可在画板撤销'}
                <small>{isDesktop ? 'Enter 发送 · Shift + Enter 换行' : 'Enter 换行'}</small>
              </span>
              {busy ? (
                <button
                  className="ai-send stop"
                  type="button"
                  aria-label="停止 AI 请求"
                  onClick={() => void stop()}
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  className="ai-send"
                  type="submit"
                  aria-label="发送 AI 消息"
                  disabled={!input.trim() || !isDesktop}
                >
                  <ArrowUp size={19} />
                </button>
              )}
            </div>
          </form>
        </dialog>
      )}
    </>
  )
}

function ContextChips({
  items,
  onRemove,
}: {
  items: AIContextItem[]
  onRemove?: (item: AIContextItem) => void
}) {
  return items.map((item) => {
    const label = aiContextItemLabel(item)
    const Icon = item.kind === 'component' ? Box : Link2
    return (
      <span
        className="ai-context-chip"
        key={aiContextItemKey(item)}
        data-context-kind={item.kind}
        data-context-id={aiContextItemId(item)}
        title={`${item.kind === 'component' ? '组件' : '连线'} · ${label}`}
      >
        <Icon size={12} aria-hidden="true" />
        <span>{label}</span>
        {onRemove && (
          <button type="button" aria-label={`移除上下文 ${label}`} onClick={() => onRemove(item)}>
            <X size={12} />
          </button>
        )}
      </span>
    )
  })
}
