import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Terminal, Sparkles } from 'lucide-react'
import {
  aiProviders,
  defaultAISettings,
  type AIProvider,
  type AISettings as Settings,
} from '../../../shared/ai'
import { aiService } from '../services/ai'
import { isDesktop } from '../services/desktop'
import './ai.css'

export function AISettings() {
  const [settings, setSettings] = useState<Settings>(structuredClone(defaultAISettings))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'check' | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  useEffect(() => {
    let disposed = false
    void aiService.loadSettings().then(
      (value) => {
        if (!disposed) {
          setSettings(value)
          setLoading(false)
        }
      },
      (error: unknown) => {
        if (!disposed) {
          setError(String(error))
          setLoading(false)
        }
      },
    )
    return () => {
      disposed = true
    }
  }, [])
  const update = (next: Settings) => {
    setSettings(next)
    setStatus('')
    setError('')
  }
  const perform = async (action: 'save' | 'check') => {
    setBusy(action)
    setError('')
    setStatus('')
    try {
      if (action === 'save') {
        await aiService.saveSettings(settings)
        setStatus('AI 设置已保存，下次发送时生效。')
      } else {
        const version = await aiService.check(settings)
        setStatus(
          `工具可用：${version || aiProviders[settings.provider]}。登录状态会在发送时验证。`,
        )
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试')
    } finally {
      setBusy(null)
    }
  }
  const tool = settings[settings.provider]
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void perform('save')
      }}
    >
      <fieldset className="ai-settings-fields" disabled={loading || !!busy}>
        <section className="settings-section" aria-labelledby="ai-tool-title">
          <h2 id="ai-tool-title">使用的 AI 工具</h2>
          <div className="ai-tool-options">
            {(Object.keys(aiProviders) as AIProvider[]).map((provider) => (
              <label
                key={provider}
                className={`ai-tool-option ${settings.provider === provider ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="ai-provider"
                  value={provider}
                  checked={settings.provider === provider}
                  onChange={() => update({ ...settings, provider })}
                />
                {provider === 'codex' ? <Sparkles size={22} /> : <Terminal size={22} />}
                <span>
                  <strong>{aiProviders[provider]}</strong>
                  <small>{provider === 'codex' ? '使用本机 Codex CLI' : '使用本机 qodercli'}</small>
                </span>
                {settings.provider === provider && <Check size={16} />}
              </label>
            ))}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="ai-config-title">
          <h2 id="ai-config-title">{aiProviders[settings.provider]} 配置</h2>
          <div className="settings-card ai-config-card">
            <label>
              命令或可执行文件路径
              <input
                aria-label="AI 工具命令路径"
                required
                maxLength={4096}
                value={tool.executable}
                spellCheck={false}
                onChange={(event) =>
                  update({
                    ...settings,
                    [settings.provider]: { ...tool, executable: event.target.value },
                  })
                }
              />
            </label>
            <p>默认自动查找本机命令。找不到时，可填写完整路径；路径中有空格也无需添加引号。</p>
            <label>
              模型 <span className="ai-optional">可选</span>
              <input
                aria-label="AI 模型"
                maxLength={200}
                value={tool.model}
                placeholder="使用工具的默认模型"
                spellCheck={false}
                onChange={(event) =>
                  update({
                    ...settings,
                    [settings.provider]: { ...tool, model: event.target.value },
                  })
                }
              />
            </label>
            <p>沿用命令行工具的登录与账号配置，请先在终端完成安装和登录。</p>
            <div className="ai-settings-actions">
              <button
                className="button secondary"
                type="button"
                disabled={!isDesktop || !tool.executable.trim()}
                onClick={() => void perform('check')}
              >
                {busy === 'check' ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Terminal size={15} />
                )}
                检测工具
              </button>
              <button className="button primary" type="submit" disabled={!tool.executable.trim()}>
                {busy === 'save' && <LoaderCircle size={15} className="spin" />}保存设置
              </button>
            </div>
          </div>
        </section>
      </fieldset>
      {loading && <p role="status">正在读取 AI 设置…</p>}
      {status && (
        <p className="ai-settings-status" role="status">
          <Check size={15} />
          {status}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="ai-settings-note">
        从画板右下角的 AI
        浮球开始对话。发送时会将当前画板和场景组件定义交给所选工具，修改通过校验后自动应用，并支持撤销。
      </p>
      {!isDesktop && (
        <p className="ai-settings-note">
          当前为浏览器预览，可预览和保存设置；调用本地 AI 工具需在桌面版中进行。
        </p>
      )}
    </form>
  )
}
