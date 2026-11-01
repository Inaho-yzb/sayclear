import { sectionTitles, type Message, type Project, type SectionId } from '../../../shared/model'

// Real providers belong behind Tauri commands; never expose credentials to the WebView.
export interface AssistantProvider {
  readonly mode: 'demo' | 'live'
  propose(input: {
    project: Project
    text: string
    sectionId: SectionId
    signal: AbortSignal
  }): Promise<Message>
}

export const demoAssistant: AssistantProvider = {
  mode: 'demo',
  async propose({ text, sectionId, signal }) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const abort = () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, 650)
      signal.addEventListener('abort', abort, { once: true })
    })
    return {
      id: crypto.randomUUID(),
      role: 'assistant',
      createdAt: new Date().toISOString(),
      text: `这段说明可以补充到「${sectionTitles[sectionId]}」。先看看下面的内容，确认后再写入文档。\n\n本地演示会保留你的原文；复杂的语义梳理将在接入 AI 模型后支持。`,
      proposal: { sectionId, content: text.trim(), status: 'pending' },
    }
  },
}
