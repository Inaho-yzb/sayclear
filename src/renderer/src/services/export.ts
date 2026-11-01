import { createExportBundle, type ExportOptions } from '../../../shared/export'
import { exportZip } from '../../../shared/export-zip'
import { type Workspace } from '../../../shared/model'
import { isDesktop, nativeInvoke } from './desktop'
import { storage } from './storage'

let pendingExport: Promise<unknown> = Promise.resolve()

/** Capture a complete, independent bundle before asking for its destination. */
export function exportWorkspace(
  workspace: Workspace,
  options: ExportOptions,
  format: 'folder' | 'zip',
): Promise<string | null> {
  const task = (async () => {
    if (!isDesktop && format !== 'zip') throw new Error('浏览器预览请使用 ZIP 导出')
    const bundle = await createExportBundle(workspace, options, {
      loadHistory: (boardId, versionId) => storage.loadHistory(boardId, versionId),
    })
    if (isDesktop) return nativeInvoke<string | null>('export_bundle', { bundle, format })
    const url = URL.createObjectURL(new Blob([exportZip(bundle)], { type: 'application/zip' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${bundle.name}.zip`
    document.body.append(anchor)
    try {
      anchor.click()
    } finally {
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }
    return anchor.download
  })()
  // Closing waits for the complete file write. A failed/cancelled export does not
  // prevent closing a separately saved workspace.
  pendingExport = Promise.allSettled([pendingExport, task])
  return task
}

export async function flushExports(): Promise<void> {
  await pendingExport
}
