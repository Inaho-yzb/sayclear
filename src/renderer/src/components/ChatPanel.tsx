import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  CheckCheck,
  CornerDownLeft,
  Lightbulb,
  MessageCircle,
  Sparkles,
  X,
} from 'lucide-react'
import { sectionIds, sectionTitles, type Project, type SectionId } from '../../../shared/model'
import { Brand } from './Brand'

interface Props {
  project: Project
  activeSection: SectionId
  onSectionChange: (id: SectionId) => void
  onSend: (text: string) => void
  onResolve: (messageId: string, accept: boolean) => void
  busy: boolean
}
const suggestions: { label: string; section: SectionId; text: string }[] = [
  { label: '补充目标用户', section: 'audience', text: '主要用户是……，他们目前遇到的问题是……' },
  { label: '细化核心功能', section: 'features', text: '我希望用户可以……，具体的操作方式是……' },
  { label: '完善验收标准', section: 'acceptance', text: '当用户……时，系统应当……，这样就算完成。' },
]

export function ChatPanel({
  project,
  activeSection,
  onSectionChange,
  onSend,
  onResolve,
  busy,
}: Props) {
  const [draft, setDraft] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [project.messages.length, busy])
  const send = () => {
    if (!draft.trim() || busy) return
    onSend(draft.trim())
    setDraft('')
    textarea.current?.focus()
  }
  return (
    <section className="chat-panel" aria-labelledby="chat-title">
      <div className="panel-heading">
        <span>
          <MessageCircle size={16} />
          需求对话
        </span>
        <span className="mode-badge">
          <span />
          本地演示
        </span>
      </div>
      <div className="chat-scroll">
        <div className="conversation-intro">
          <span className="eyebrow">A LITTLE CLARITY, A GREAT START.</span>
          <h1 id="chat-title">
            把想法，<span>聊清楚。</span>
          </h1>
          <p>不必一开始就想好所有细节，我们一步步来。</p>
        </div>
        <div className="conversation-date">
          <span />
          这次对话，从一个想法开始
          <span />
        </div>
        <div className="messages" aria-live="polite" aria-relevant="additions text">
          {project.messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-identity">
                {message.role === 'assistant' ? (
                  <Brand small />
                ) : (
                  <span className="user-avatar">我</span>
                )}
                <strong>{message.role === 'assistant' ? 'Say Clear' : '你'}</strong>
                {message.role === 'assistant' && (
                  <span className="assistant-tag">需求伙伴 · 演示</span>
                )}
              </div>
              <div className="message-body">
                <p>{message.text}</p>
                {message.proposal && (
                  <div className={`proposal ${message.proposal.status}`}>
                    <div className="proposal-title">
                      <Sparkles size={15} />
                      <strong>补充建议</strong>
                      <span>{sectionTitles[message.proposal.sectionId]}</span>
                    </div>
                    <p>{message.proposal.content}</p>
                    {message.proposal.status === 'pending' ? (
                      <div className="proposal-actions">
                        <button
                          className="button primary compact"
                          onClick={() => onResolve(message.id, true)}
                        >
                          <Check size={14} />
                          采纳并更新文档
                        </button>
                        <button
                          className="button text compact"
                          onClick={() => onResolve(message.id, false)}
                        >
                          暂不采纳
                        </button>
                      </div>
                    ) : (
                      <div className="proposal-resolved">
                        {message.proposal.status === 'accepted' ? (
                          <>
                            <CheckCheck size={15} />
                            已写入文档
                          </>
                        ) : (
                          <>
                            <X size={14} />
                            未采纳，文档保持原样
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </article>
          ))}
          {busy && (
            <div className="thinking">
              <Brand small />
              <span>正在整理这段说明</span>
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        <div className="suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.section}
              onClick={() => {
                onSectionChange(suggestion.section)
                setDraft(suggestion.text)
                textarea.current?.focus()
              }}
            >
              <Lightbulb size={13} />
              {suggestion.label}
            </button>
          ))}
        </div>
        <div className="composer">
          <label className="section-select">
            <span className="section-select-dot" />
            正在讨论
            <select
              aria-label="正在讨论的章节"
              value={activeSection}
              onChange={(event) => onSectionChange(event.target.value as SectionId)}
            >
              {sectionIds.map((id) => (
                <option value={id} key={id}>
                  {sectionTitles[id]}
                </option>
              ))}
            </select>
          </label>
          <textarea
            ref={textarea}
            aria-label="描述你的需求"
            placeholder="说说你的想法，或者想修改的地方…"
            value={draft}
            maxLength={10000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229
              ) {
                event.preventDefault()
                send()
              }
            }}
          />
          <div className="composer-footer">
            <span>
              <CornerDownLeft size={12} />
              发送 <i>·</i> Shift + Enter 换行
            </span>
            <button
              className="send-button"
              aria-label="发送需求"
              disabled={!draft.trim() || busy}
              onClick={send}
            >
              <ArrowUp size={19} />
            </button>
          </div>
        </div>
        <p className="composer-note">
          想法留在本地，文档由你确认。<span>当前未连接 AI 模型</span>
        </p>
      </div>
    </section>
  )
}
