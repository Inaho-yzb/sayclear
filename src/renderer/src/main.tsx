import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { initializeDesktop } from './services/desktop'
import { storage } from './services/storage'
import { flushExports } from './services/export'

async function start() {
  if (import.meta.env.VITE_E2E === '1') await import('@wdio/tauri-plugin')
  const dispose = await initializeDesktop(async () => {
    await Promise.all([storage.flush(), flushExports()])
  })
  import.meta.hot?.dispose(dispose)
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void start().catch((error: unknown) => {
  const root = document.getElementById('root')!
  root.className = 'startup-screen'
  const message = document.createElement('p')
  message.textContent = `桌面服务初始化失败：${error instanceof Error ? error.message : String(error)}`
  const retry = document.createElement('button')
  retry.className = 'button primary'
  retry.textContent = '重新打开'
  retry.onclick = () => location.reload()
  root.replaceChildren(message, retry)
})
