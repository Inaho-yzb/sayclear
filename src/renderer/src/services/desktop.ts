import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export const isDesktop = isTauri()

export async function nativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function copyText(text: string): Promise<void> {
  if (isDesktop) return nativeInvoke('copy_text', { text })
  return navigator.clipboard.writeText(text)
}

export async function initializeDesktop(flush: () => Promise<void>): Promise<() => void> {
  if (!isDesktop) return () => {}
  const platform = await nativeInvoke<string>('app_platform')
  document.documentElement.dataset.platform = platform
  const current = getCurrentWindow()
  let closing = false
  return current.onCloseRequested((event) => {
    event.preventDefault()
    if (closing) return
    closing = true
    void Promise.resolve()
      .then(flush)
      .then(() => current.destroy())
      .catch(() => {
        closing = false
        window.dispatchEvent(new Event('workspace-save-failed'))
      })
  })
}
