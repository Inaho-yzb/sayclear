import { Channel } from '@tauri-apps/api/core'
import { aiSettingsSchema, defaultAISettings, type AISettings } from '../../../shared/ai'
import { isDesktop, nativeInvoke } from './desktop'

export type AIProgress = {
  requestId: string
  sessionId?: string
  stage: 'starting' | 'connected' | 'thinking' | 'retrying' | 'responding' | 'completed'
  message: string
}
export const AI_RESPONSE_TIMEOUT_MS = 330_000
const settingsKey = 'say-clear.ai-settings.v1'
export const aiService = {
  async loadSettings(): Promise<AISettings> {
    if (isDesktop) return aiSettingsSchema.parse(await nativeInvoke('load_ai_settings'))
    const saved = localStorage.getItem(settingsKey)
    return saved ? aiSettingsSchema.parse(JSON.parse(saved)) : structuredClone(defaultAISettings)
  },
  async saveSettings(settings: AISettings): Promise<void> {
    const parsed = aiSettingsSchema.parse(settings)
    if (isDesktop) await nativeInvoke('save_ai_settings', { settings: parsed })
    else localStorage.setItem(settingsKey, JSON.stringify(parsed))
    window.dispatchEvent(new Event('ai-settings-changed'))
  },
  async check(settings: AISettings): Promise<string> {
    if (!isDesktop) throw new Error('请在桌面版中检测本地 AI 工具。')
    return nativeInvoke('check_ai_tool', { settings })
  },
  async send(
    request: { requestId: string; sessionId: string | null; prompt: string },
    onProgress?: (progress: AIProgress) => void,
  ) {
    if (!isDesktop) throw new Error('请在桌面版中使用 AI 对话；浏览器无法调用本地命令行工具。')
    let active = true
    const progress = new Channel<AIProgress>()
    progress.onmessage = (event) => {
      if (active && event.requestId === request.requestId) onProgress?.(event)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        active = false
        // The native worker has its own 300-second deadline. This also covers a lost IPC reply.
        void aiService.cancel(request.requestId).catch(() => {})
        reject(
          new Error('AI 请求超过 5 分 30 秒未返回，已请求停止。画板未修改，请检查工具状态后重试。'),
        )
      }, AI_RESPONSE_TIMEOUT_MS)
    })
    try {
      return await Promise.race([
        nativeInvoke<{ sessionId: string; output: string }>('run_ai_turn', {
          request,
          onProgress: progress,
        }),
        timeout,
      ])
    } finally {
      active = false
      clearTimeout(timer)
    }
  },
  async cancel(requestId: string) {
    if (isDesktop) await nativeInvoke('cancel_ai_turn', { requestId })
  },
}
