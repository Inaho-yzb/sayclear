import {
  deleteSystem,
  parseWorkspace,
  workspaceSchema,
  type Workspace,
} from '../../../shared/model'
import { isDesktop, nativeInvoke } from './desktop'
import { graphSnapshotSchema, type Diagram, type GraphSnapshot } from '../../../shared/diagram'
import { type ComponentCatalog } from '../../../shared/component-catalog'
import { browserStore } from './browser-storage'
import { type GitStartOptions } from '../../../shared/git'

let pendingWrites: Promise<void> = Promise.resolve()
type SavedHistory = { boardId: string; history: Diagram['history'] }
let savedHistory: SavedHistory[] = []
const historyCache = new Map<string, Promise<GraphSnapshot>>()
let generation = 0
function clearHistory() {
  generation++
  historyCache.clear()
  savedHistory = []
}
export const storage = {
  async getDataDirectory(): Promise<string | null> {
    return isDesktop ? nativeInvoke<string>('get_data_directory') : null
  },
  chooseDataDirectory(): Promise<string | null> {
    if (!isDesktop) return Promise.reject(new Error('请在桌面版中选择本地数据目录'))
    const previousWrites = pendingWrites
    const change = previousWrites
      .then(() => nativeInvoke<string | null>('choose_data_directory'))
      .then((path) => {
        if (path) clearHistory()
        return path
      })
    // Closing waits for migration. A failed migration leaves the saved original usable;
    // an earlier save failure must still prevent closing.
    pendingWrites = change.then(
      () => {},
      () => previousWrites,
    )
    void pendingWrites.catch(() => {})
    return change
  },
  async load(): Promise<Workspace | null> {
    clearHistory()
    if (isDesktop) {
      const data = await nativeInvoke<unknown>('load_workspace')
      return data === null ? null : parseWorkspace(data)
    }
    return browserStore.load()
  },
  save(workspace: Workspace): Promise<void> {
    const snapshot = workspaceSchema.parse(workspace)
    // A single ordered queue keeps an older asynchronous write from winning the race.
    pendingWrites = pendingWrites
      .catch(() => {})
      .then(async () => {
        if (isDesktop)
          savedHistory =
            (await nativeInvoke<SavedHistory[] | undefined>('save_workspace', {
              workspace: snapshot,
            })) ?? []
        else
          savedHistory = browserStore
            .save(snapshot)
            .systems.flatMap((system) =>
              system.contents.flatMap((content) =>
                content.diagram ? [{ boardId: content.id, history: content.diagram.history }] : [],
              ),
            )
      })
    return pendingWrites
  },
  createGitIteration(
    workspace: Workspace,
    boardId: string,
    options: GitStartOptions,
  ): Promise<Workspace> {
    if (!isDesktop) return Promise.reject(new Error('请在桌面版中创建 Git 分支'))
    const snapshot = workspaceSchema.parse(workspace)
    const previousWrites = pendingWrites
    const creation = previousWrites.then(async () => {
      const saved = workspaceSchema.parse(
        await nativeInvoke<unknown>('create_git_iteration', {
          workspace: snapshot,
          boardId,
          branch: options.branch,
          baseBranch: options.baseBranch,
        }),
      )
      clearHistory()
      return saved
    })
    // Branch creation and its workspace save must finish before the window can close.
    // Failure leaves the previously saved workspace usable; an earlier save error still blocks close.
    pendingWrites = creation.then(
      () => {},
      () => previousWrites,
    )
    void pendingWrites.catch(() => {})
    return creation
  },
  deleteSystem(systemId: string): Promise<Workspace> {
    // Deletion runs after all queued saves, and is part of the close-window flush.
    const deletion = pendingWrites.then(async () => {
      clearHistory()
      if (isDesktop)
        return workspaceSchema.parse(await nativeInvoke<unknown>('delete_system', { systemId }))
      const current = browserStore.load()
      if (!current) throw new Error('请先保存工作区再删除应用系统')
      return browserStore.save(deleteSystem(current, systemId))
    })
    pendingWrites = deletion.then(() => {})
    void pendingWrites.catch(() => {})
    return deletion
  },
  compact(workspace: Workspace): Workspace {
    if (
      !workspace.systems.some((s) =>
        s.contents.some((c) => c.diagram?.history.some((h) => h.snapshot)),
      )
    )
      return workspace
    const indices = new Map(
      savedHistory.map((entry) => [entry.boardId, new Map(entry.history.map((h) => [h.id, h]))]),
    )
    if (
      !workspace.systems.some((s) =>
        s.contents.some((c) =>
          c.diagram?.history.some((h) => h.snapshot && indices.get(c.id)?.has(h.id)),
        ),
      )
    )
      return workspace
    return {
      ...workspace,
      systems: workspace.systems.map((s) => ({
        ...s,
        contents: s.contents.map((c) =>
          !c.diagram
            ? c
            : {
                ...c,
                diagram: {
                  ...c.diagram,
                  history: c.diagram.history.map((h) =>
                    h.snapshot && indices.get(c.id)?.get(h.id)?.snapshotDigest
                      ? { ...h, ...indices.get(c.id)!.get(h.id)!, snapshot: undefined }
                      : h,
                  ),
                },
              },
        ),
      })),
    }
  },
  async loadHistory(boardId: string, versionId: string): Promise<GraphSnapshot> {
    const key = JSON.stringify([generation, boardId, versionId])
    let pending = historyCache.get(key)
    if (!pending) {
      const sourceGeneration = generation
      pending = pendingWrites.then(async () => {
        if (sourceGeneration !== generation) throw new Error('数据来源已切换，请重新打开历史版本')
        return graphSnapshotSchema.parse(
          isDesktop
            ? await nativeInvoke('load_history', { boardId, versionId })
            : browserStore.loadHistory(boardId, versionId),
        )
      })
      historyCache.set(key, pending)
      void pending.catch(() => {
        if (historyCache.get(key) === pending) historyCache.delete(key)
      })
      if (historyCache.size > 8) historyCache.delete(historyCache.keys().next().value!)
    } else {
      historyCache.delete(key)
      historyCache.set(key, pending)
    }
    const sourceGeneration = generation
    return pending.then((graph) => {
      if (sourceGeneration !== generation) throw new Error('数据来源已切换，请重新打开历史版本')
      return structuredClone(graph)
    })
  },
  async validateCatalog(catalog: ComponentCatalog): Promise<void> {
    await pendingWrites
    if (isDesktop) await nativeInvoke('validate_catalog', { catalog })
    else browserStore.validateCatalog(catalog)
  },
  flush(): Promise<void> {
    return pendingWrites
  },
  async exportMarkdown(name: string, content: string): Promise<boolean> {
    if (isDesktop) return nativeInvoke<boolean>('export_markdown', { document: { name, content } })
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${name.replace(/[<>:"/\\|?*]/g, '_')}.md`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  },
}
