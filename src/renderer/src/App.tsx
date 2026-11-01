import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  HardDrive,
  LoaderCircle,
  Network,
  RefreshCw,
  Boxes,
  Plus,
  Workflow,
  Download,
} from 'lucide-react'
import {
  createInitialWorkspace,
  getProject,
  flattenArchitecture,
  saveArchitecture,
  saveComponentCatalog,
  scopeTitles,
  updateNodeContent,
  type Project,
  type Workspace,
  workspaceSchema,
} from '../../shared/model'
import {
  referenceBoards,
  incomingReferences,
  type BoardLocation,
} from '../../shared/diagram-references'
import { addBoard, aggregateBoards, initializeBoards } from '../../shared/composition'
import { CompositionDialog } from './components/CompositionDialog'
import { defaultComponentCatalog } from '../../shared/component-catalog'
import { storage } from './services/storage'
import { Sidebar } from './components/Sidebar'
import { Modal } from './components/Modal'
import { ArchitectureEditor } from './components/ArchitectureEditor'
import { DeleteSystemDialog } from './components/DeleteSystemDialog'
import { Brand } from './components/Brand'
import { SettingsPage } from './components/SettingsPage'
import { SystemDiagram } from './components/SystemDiagram'
import { IterationManagement } from './components/IterationManagement'
import { manageIteration } from '../../shared/iteration-management'
import { applyIterationAction } from './services/iterations'
import { inspectRepository } from './services/git'
import { type GitStartOptions } from '../../shared/git'
import { type Diagram } from '../../shared/diagram'
import { ExportDialog } from './components/ExportDialog'
import { exportWorkspace } from './services/export'
import {
  connectGraphCommands,
  graphCommandStateKey,
  type GraphCommandOutcome,
} from './services/graph-commands'

export function App() {
  const [compositionMode, setCompositionMode] = useState<'add' | 'group' | null>(null)
  const [navigation, setNavigation] = useState<BoardLocation | undefined>()
  const [navigationVersion, setNavigationVersion] = useState(0)
  const [backLocations, setBackLocations] = useState<BoardLocation[]>([])
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const [settingsSection, setSettingsSection] = useState<'workspace' | 'components' | 'ai'>(
    'workspace',
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [iterationsOpen, setIterationsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [changingDirectory, setChangingDirectory] = useState(false)
  const [modal, setModal] = useState<'new' | 'architecture' | 'reload' | 'delete' | 'help' | null>(
    null,
  )
  const [reloading, setReloading] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [commandBusy, setCommandBusy] = useState(false)
  const commandBusyRef = useRef(false)
  const [gitBusy, setGitBusy] = useState(false)
  const gitBusyRef = useRef(false)
  const [externalChange, setExternalChange] = useState<{
    id: string
    boardId: string
    before: Diagram
  } | null>(null)
  const [commandUndo, setCommandUndo] = useState<{
    before: Workspace
    after: Workspace
  } | null>(null)
  const saveSequence = useRef(0)
  const notify = useCallback((text: string) => setNotice(text), [])
  const latestWorkspace = useRef(workspace)
  latestWorkspace.current = workspace
  const commandAvailable = useRef(true)
  commandAvailable.current = !(
    reloading ||
    deleting ||
    changingDirectory ||
    modal ||
    compositionMode ||
    settingsOpen ||
    exportOpen ||
    gitBusy
  )

  useEffect(() => {
    let disposed = false
    let disconnect: (() => void) | undefined
    void connectGraphCommands({
      getWorkspace: () => latestWorkspace.current,
      available: () =>
        commandAvailable.current &&
        !gitBusyRef.current &&
        !commandBusyRef.current &&
        !document.querySelector('dialog.modal[open]'),
      setBusy: (busy) => {
        commandBusyRef.current = busy
        flushSync(() => setCommandBusy(busy))
      },
      apply: (before, outcome: GraphCommandOutcome, id) => {
        const next = outcome.workspace
        const activeId = before.activeNodeId
        const previousGraph = before.systems
          .flatMap((system) => system.contents)
          .find((content) => content.id === activeId)?.diagram
        const nextGraph = next.systems
          .flatMap((system) => system.contents)
          .find((content) => content.id === activeId)?.diagram
        const deletedSystem = before.systems.some(
          (system) => !next.systems.some((item) => item.architecture.id === system.architecture.id),
        )
        flushSync(() => {
          latestWorkspace.current = next
          setWorkspace(next)
          if (
            activeId &&
            activeId === next.activeNodeId &&
            previousGraph &&
            nextGraph &&
            JSON.stringify(previousGraph) !== JSON.stringify(nextGraph)
          )
            setExternalChange({ id, boardId: activeId, before: previousGraph })
          else setExternalChange(null)
          setCommandUndo(deletedSystem ? null : { before, after: next })
          if (before.activeNodeId !== next.activeNodeId) {
            setNavigation(undefined)
            setBackLocations([])
          }
          setNotice(deletedSystem ? '外部命令已删除应用系统' : '外部修改已应用')
        })
      },
      onError: (error) => notify(error.message),
    }).then(
      (dispose) => {
        if (disposed) dispose()
        else disconnect = dispose
      },
      (error: unknown) => {
        if (!disposed)
          notify(error instanceof Error ? error.message : '命令连接初始化失败，请重新打开应用。')
      },
    )
    return () => {
      disposed = true
      disconnect?.()
    }
  }, [notify])

  useEffect(() => {
    let disposed = false
    storage
      .load()
      .then((data) => {
        if (!disposed) setWorkspace(data ?? createInitialWorkspace())
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : '本地工作区读取失败')
      })
    return () => {
      disposed = true
    }
  }, [])
  useLayoutEffect(() => {
    if (!workspace) return
    const sequence = ++saveSequence.current
    setSaveStatus('saving')
    setSaveError('')
    void storage
      .save(workspace)
      .then(() => {
        if (sequence === saveSequence.current) {
          setSaveStatus('saved')
          const compact = storage.compact(workspace)
          if (compact !== workspace)
            setWorkspace((current) => (current === workspace ? compact : current))
        }
      })
      .catch((error: unknown) => {
        if (sequence === saveSequence.current) {
          setSaveStatus('error')
          setSaveError(error instanceof Error ? error.message : '本地保存失败')
        }
      })
  }, [workspace])
  useEffect(() => {
    const failed = () => {
      setSaveStatus('error')
      notify('尚有修改未保存，请点击“重试”后再关闭窗口。')
    }
    window.addEventListener('workspace-save-failed', failed)
    return () => window.removeEventListener('workspace-save-failed', failed)
  }, [notify])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  const updateProject = useCallback((id: string, update: (project: Project) => Project) => {
    if (gitBusyRef.current) return
    setWorkspace((current) => (current ? updateNodeContent(current, id, update) : current))
  }, [])
  const consumeExternalChange = useCallback((id: string) => {
    setExternalChange((current) => (current?.id === id ? null : current))
  }, [])

  if (loadError)
    return (
      <main className="startup-screen">
        <Brand />
        <h1>暂时无法打开工作区</h1>
        <p>{loadError}</p>
        <p>原有数据不会被覆盖。请检查本地文件后重新读取。</p>
        <button className="button primary" onClick={() => location.reload()}>
          重新读取
        </button>
      </main>
    )
  if (!workspace)
    return (
      <main className="startup-screen">
        <Brand />
        <LoaderCircle className="spin" size={24} />
        <p>正在打开系统图工作区…</p>
      </main>
    )
  const boards = referenceBoards(workspace)
  const canUndoCommand =
    commandUndo && graphCommandStateKey(workspace) === graphCommandStateKey(commandUndo.after)
  const undoCommand = async () => {
    if (!commandUndo || commandBusyRef.current) return
    const expected = graphCommandStateKey(commandUndo.after)
    const before = commandUndo.before
    const current = latestWorkspace.current
    if (!current || graphCommandStateKey(current) !== expected) return
    const createdRoots = current.systems.filter(
      (system) => !before.systems.some((item) => item.architecture.id === system.architecture.id),
    )
    if (createdRoots.length) {
      commandBusyRef.current = true
      setCommandBusy(true)
      try {
        await storage.save(current)
        if (!latestWorkspace.current || graphCommandStateKey(latestWorkspace.current) !== expected)
          throw new Error('工作区已变化，未撤销新建图。')
        const saved = await storage.deleteSystem(createdRoots[0].architecture.id)
        setWorkspace({ ...saved, activeNodeId: before.activeNodeId })
        setCommandUndo(null)
        setExternalChange(null)
        setNavigation(undefined)
        setBackLocations([])
        setReloadVersion((version) => version + 1)
        notify('已撤销新建图，正在保存')
      } catch (error) {
        notify(error instanceof Error ? error.message : '撤销失败，请重试')
      } finally {
        commandBusyRef.current = false
        setCommandBusy(false)
      }
      return
    }
    setWorkspace((current) =>
      current && graphCommandStateKey(current) === expected ? before : current,
    )
    setCommandUndo(null)
    setExternalChange(null)
    setNavigation(undefined)
    setBackLocations([])
    setReloadVersion((version) => version + 1)
    notify('已撤销外部修改，正在保存')
  }
  const navigate = (destination: BoardLocation) => {
    const board = boards.find((b) => b.id === destination.boardId)
    if (!board) {
      notify('来源画板不存在')
      return false
    }
    if (
      destination.version === 'iteration' &&
      board.diagram.iteration?.id !== destination.iterationId
    ) {
      notify('来源迭代已结束，请更新引用并选择现状')
      return false
    }
    if (
      destination.version === 'history' &&
      !board.diagram.history.some((h) => h.id === destination.historyId)
    ) {
      notify('来源历史版本不存在')
      return false
    }
    setWorkspace({ ...workspace, activeNodeId: destination.boardId })
    setNavigation(destination)
    setNavigationVersion((v) => v + 1)
    return true
  }
  const project = workspace.activeNodeId === null ? null : getProject(workspace)
  const system = workspace.systems.find((item) =>
    flattenArchitecture(item.architecture).some((node) => node.id === project?.id),
  )
  const nodes = system ? flattenArchitecture(system.architecture) : []
  const activeNode = nodes.find((node) => node.id === project?.id)
  const breadcrumb = activeNode ? [activeNode] : []
  while (breadcrumb[0]?.parentId)
    breadcrumb.unshift(nodes.find((node) => node.id === breadcrumb[0].parentId)!)

  const reload = async () => {
    setReloading(true)
    setModal(null)
    try {
      await storage.flush().catch(() => {})
      const loaded = await storage.load()
      if (!loaded) throw new Error('工作区文件不存在，当前内容已保留')
      setWorkspace(loaded)
      setReloadVersion((version) => version + 1)
      notify('已重新读取本地数据')
    } catch (error) {
      notify(error instanceof Error ? error.message : '重新读取失败')
    } finally {
      setReloading(false)
    }
  }

  const chooseDataDirectory = async () => {
    if (changingDirectory || reloading || deleting) return null
    setChangingDirectory(true)
    try {
      try {
        await storage.save(workspace)
        setSaveStatus('saved')
        setSaveError('')
      } catch (error) {
        setSaveStatus('error')
        setSaveError(error instanceof Error ? error.message : '本地保存失败')
        throw error
      }
      const directory = await storage.chooseDataDirectory()
      if (directory) notify('数据目录已更新，后续修改将保存到所选文件夹')
      return directory
    } finally {
      setChangingDirectory(false)
    }
  }

  const deleteTarget = workspace.systems.find((item) => item.architecture.id === deleteTargetId)
  const createGitIteration = async (boardId: string, name: string, options?: GitStartOptions) => {
    if (gitBusyRef.current || commandBusyRef.current)
      throw new Error('工作空间正在处理修改，请稍后重试')
    gitBusyRef.current = true
    setGitBusy(true)
    try {
      const current = latestWorkspace.current
      if (!current) throw new Error('工作空间尚未打开')
      // Save existing edits first, so a Git failure leaves the current board recoverable.
      await storage.save(current)
      const next = await applyIterationAction(current, { type: 'start', boardId, name }, options)
      latestWorkspace.current = next
      setWorkspace(next)
      setCommandUndo(null)
      setExternalChange(null)
      notify(`迭代已创建 · ${getProject(next, boardId).diagram?.iteration?.git?.branch ?? name}`)
      return true
    } finally {
      gitBusyRef.current = false
      setGitBusy(false)
    }
  }
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      await storage.save(workspace)
      const next = await storage.deleteSystem(deleteTarget.architecture.id)
      setWorkspace(next)
      setModal(null)
      setDeleteTargetId(null)
      notify(`已删除应用系统「${deleteTarget.architecture.name}」`)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="app-shell"
      inert={reloading || deleting || changingDirectory || commandBusy || gitBusy}
    >
      <div className="titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>Say Clear</span>
        <div data-tauri-drag-region>
          <Workflow size={12} />
          本地系统设计工作台
        </div>
      </div>
      <Sidebar
        workspace={workspace}
        hidden={settingsOpen}
        iterationsOpen={iterationsOpen}
        onIterations={() => setIterationsOpen(true)}
        onSettings={() => {
          setSettingsSection('workspace')
          setSettingsOpen(true)
        }}
        onSelect={(id) => {
          setIterationsOpen(false)
          setNavigation(undefined)
          setBackLocations([])
          setWorkspace((current) => (current ? { ...current, activeNodeId: id } : current))
        }}
        onNew={() => {
          if (workspace.systems.length >= 100) {
            notify('当前工作区最多支持 100 个应用系统')
            return
          }
          setModal('new')
        }}
        onHelp={() => setModal('help')}
        deleteDisabled={deleting || reloading}
        onDelete={(systemId) => {
          setDeleteTargetId(systemId)
          setDeleteError('')
          setModal('delete')
        }}
      />
      <div
        className="workspace"
        hidden={settingsOpen || iterationsOpen}
        inert={settingsOpen || iterationsOpen}
      >
        <header className="workspace-header">
          <div className="breadcrumb">
            {!!backLocations.length && (
              <button
                className="button text compact"
                aria-label="返回引用画板"
                onClick={() => {
                  const previous = backLocations.at(-1)!
                  if (navigate(previous)) setBackLocations((v) => v.slice(0, -1))
                }}
              >
                <ArrowLeft size={14} />
                返回
              </button>
            )}
            {!project && <strong>工作空间</strong>}
            {breadcrumb.map((node, index) => (
              <span className="breadcrumb-part" key={node.id}>
                {index > 0 && <ChevronRight size={14} />}
                <button
                  onClick={() => {
                    setNavigation(undefined)
                    setBackLocations([])
                    setWorkspace({ ...workspace, activeNodeId: node.id })
                  }}
                  aria-current={node.id === project?.id ? 'page' : undefined}
                >
                  {node.name}
                </button>
              </span>
            ))}
            {activeNode && <span className="scope-badge">{scopeTitles[activeNode.type]}</span>}
          </div>
          <div className="workspace-header-right">
            <button
              className="button secondary compact"
              aria-label="导出交付包"
              disabled={
                !workspace.systems.length ||
                reloading ||
                changingDirectory ||
                commandBusy ||
                gitBusy
              }
              onClick={() => setExportOpen(true)}
            >
              <Download size={14} />
              导出
            </button>
            {activeNode && activeNode.type !== 'atomic' && (
              <div className="composition-actions">
                <button className="button text compact" onClick={() => setCompositionMode('add')}>
                  <Plus size={14} />
                  新建子图
                </button>
                <button
                  className="button text compact"
                  disabled={nodes.filter((n) => n.parentId === activeNode.id).length < 2}
                  onClick={() => setCompositionMode('group')}
                >
                  聚合子图
                </button>
              </div>
            )}
            <button
              className="button text compact"
              disabled={!system || reloading}
              onClick={() => setModal('architecture')}
            >
              <Network size={14} />
              画板结构
            </button>
            <button
              className="icon-button"
              title="重新读取本地数据"
              aria-label="重新读取本地数据"
              disabled={reloading}
              onClick={() => setModal('reload')}
            >
              <RefreshCw size={14} className={reloading ? 'spin' : ''} />
            </button>
            <span className={`save-status ${saveStatus}`} role="status">
              {commandBusy ? (
                <LoaderCircle className="spin" size={13} />
              ) : saveStatus === 'saved' ? (
                <Check size={13} />
              ) : saveStatus === 'saving' ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <HardDrive size={13} />
              )}
              {commandBusy
                ? '正在处理外部操作'
                : saveStatus === 'saved'
                  ? '已保存到本地'
                  : saveStatus === 'saving'
                    ? '正在保存'
                    : '保存失败'}
              {saveStatus === 'error' && (
                <button onClick={() => setWorkspace({ ...workspace })}>重试</button>
              )}
            </span>
          </div>
        </header>
        {saveError && (
          <div className="save-error" role="alert">
            {saveError}
          </div>
        )}
        {project && activeNode ? (
          <>
            {nodes.some((n) => n.parentId === activeNode.id) && (
              <nav className="composition-children" aria-label="下级画板">
                {nodes
                  .filter((n) => n.parentId === activeNode.id)
                  .map((n) => (
                    <button
                      className="button text compact"
                      key={n.id}
                      onClick={() => {
                        setNavigation(undefined)
                        setWorkspace({ ...workspace, activeNodeId: n.id })
                      }}
                    >
                      {scopeTitles[n.type]} · {n.name}
                      <ChevronRight size={12} />
                    </button>
                  ))}
              </nav>
            )}
            <div className="diagram-workspace">
              <SystemDiagram
                key={`${project.id}-${reloadVersion}-${navigationVersion}`}
                boardId={project.id}
                boards={boards}
                location={navigation?.boardId === project.id ? navigation : undefined}
                onOpenBoard={(destination, origin) => {
                  if (navigate(destination)) setBackLocations((v) => [...v.slice(-19), origin])
                }}
                value={project.diagram}
                externalChange={externalChange?.boardId === project.id ? externalChange : undefined}
                onExternalChangeConsumed={consumeExternalChange}
                externalBusy={commandBusy || gitBusy}
                gitRepository={workspace.gitRepository}
                onStartIteration={
                  workspace.gitRepository
                    ? (name, options) => createGitIteration(project.id, name, options)
                    : undefined
                }
                catalog={workspace.componentCatalog ?? defaultComponentCatalog}
                onOpenAISettings={() => {
                  setSettingsSection('ai')
                  setSettingsOpen(true)
                }}
                onOpenSettings={() => {
                  setSettingsSection('components')
                  setSettingsOpen(true)
                }}
                active={!settingsOpen && !iterationsOpen && !exportOpen}
                scopeName={project.name}
                scopeDescription={activeNode.description}
                onChange={(diagram) =>
                  updateProject(project.id, (current) => ({
                    ...current,
                    diagram,
                    updatedAt: new Date().toISOString(),
                  }))
                }
                onNotify={notify}
              />
            </div>
          </>
        ) : (
          <div className="empty-workspace">
            <Boxes size={42} strokeWidth={1.3} />
            <h1>还没有应用系统</h1>
            <p>创建应用系统，记录现状的能力与流程，再设计下一次迭代。</p>
            <button className="button primary" onClick={() => setModal('new')}>
              <Plus size={16} />
              创建应用系统
            </button>
          </div>
        )}
      </div>
      {iterationsOpen && !settingsOpen && (
        <IterationManagement
          key={reloadVersion}
          workspace={workspace}
          saveStatus={saveStatus}
          saveError={saveError}
          onRetrySave={() => setWorkspace({ ...workspace })}
          onBack={() => setIterationsOpen(false)}
          onOpenBoard={(destination) => {
            if (navigate(destination)) {
              setBackLocations([])
              setIterationsOpen(false)
            }
          }}
          onAction={async (action, options) => {
            if (action.type === 'start' && workspace.gitRepository) {
              await createGitIteration(action.boardId, action.name, options)
            } else {
              const current = latestWorkspace.current
              if (!current) throw new Error('工作空间尚未打开')
              const next = manageIteration(current, action)
              latestWorkspace.current = next
              setWorkspace(next)
            }
            // Discard stale canvas undo entries after a lifecycle change outside the canvas.
            if (action.boardId === workspace.activeNodeId) {
              setNavigation(undefined)
              setNavigationVersion((version) => version + 1)
            }
            notify(
              {
                start: '迭代已创建',
                rename: '迭代名称已更新',
                publish: '迭代已完成，原现状已保留在历史中',
                discard: '已放弃迭代并恢复现状',
              }[action.type],
            )
          }}
        />
      )}
      {exportOpen && (
        <ExportDialog
          workspace={workspace}
          onClose={() => setExportOpen(false)}
          onExport={async (options, format) => {
            const path = await exportWorkspace(workspace, options, format)
            if (path) notify(`交付包已导出：${path}`)
            return path
          }}
        />
      )}
      {settingsOpen && (
        <SettingsPage
          workspace={workspace}
          onSaveRepository={async (repository) => {
            if (gitBusyRef.current || commandBusyRef.current)
              throw new Error('工作空间正在处理修改，请稍后重试')
            gitBusyRef.current = true
            setGitBusy(true)
            try {
              if (repository) {
                const info = await inspectRepository(repository.path)
                if (!info.branches.includes(repository.baseBranch))
                  throw new Error('基准分支已变化，请刷新仓库后重试')
                repository = { ...repository, path: info.path }
              }
              const current = latestWorkspace.current
              if (!current) throw new Error('工作空间尚未打开')
              const next = workspaceSchema.parse({ ...current, gitRepository: repository })
              await storage.save(next)
              latestWorkspace.current = next
              setWorkspace(next)
              notify(repository ? 'Git 仓库已关联' : 'Git 仓库已解除关联')
            } finally {
              gitBusyRef.current = false
              setGitBusy(false)
            }
          }}
          initialSection={settingsSection}
          onSaveCatalog={async (catalog) => {
            const next = saveComponentCatalog(workspace, catalog)
            await storage.validateCatalog(catalog)
            setWorkspace(next)
            notify('组件设置已更新')
          }}
          saveStatus={saveStatus}
          saveError={saveError}
          reloadDisabled={reloading || deleting}
          changingDirectory={changingDirectory}
          onChooseDataDirectory={chooseDataDirectory}
          onBack={() => setSettingsOpen(false)}
          onReload={() => setModal('reload')}
          onRetrySave={() => setWorkspace({ ...workspace })}
        />
      )}
      {(notice || canUndoCommand) && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice || '外部修改已应用'}
          {canUndoCommand && (
            <>
              <button className="button secondary compact" onClick={() => void undoCommand()}>
                撤销
              </button>
              <button
                className="button text compact"
                style={{ color: 'inherit' }}
                aria-label="关闭外部修改通知"
                onClick={() => {
                  setCommandUndo(null)
                  setNotice('')
                }}
              >
                关闭
              </button>
            </>
          )}
        </div>
      )}
      {compositionMode && activeNode && (
        <CompositionDialog
          mode={compositionMode}
          nodes={nodes.filter((n) => n.parentId === activeNode.id)}
          allowApplication={!breadcrumb.some((n) => n.type === 'application')}
          onClose={() => setCompositionMode(null)}
          onSave={(name, kind, ids) => {
            const next =
              compositionMode === 'group'
                ? aggregateBoards(workspace, activeNode.id, ids, name)
                : addBoard(workspace, activeNode.id, name, kind)
            setWorkspace(next)
            setNavigation(undefined)
            setCompositionMode(null)
            notify(
              compositionMode === 'group'
                ? '已创建聚合图；公开入口已引用，已有业务连接保留'
                : '画板已创建，并加入上级图',
            )
          }}
        />
      )}
      {(modal === 'new' || modal === 'architecture') && (
        <ArchitectureEditor
          architecture={modal === 'architecture' ? system?.architecture : undefined}
          onClose={() => setModal(null)}
          onSave={(architecture) => {
            // Compute first so validation errors stay in the editor; preserve the latest node contents.
            const next = initializeBoards(saveArchitecture(workspace, architecture))
            setWorkspace(next)
            setModal(null)
            const removed = system
              ? flattenArchitecture(system.architecture).filter(
                  (n) => !flattenArchitecture(architecture).some((next) => next.id === n.id),
                )
              : []
            const usages = [
              ...new Set(
                removed.flatMap((n) => incomingReferences(boards, n.id)).map((u) => u.board.name),
              ),
            ]
            notify(
              usages.length
                ? `系统架构已更新，请检查引用画板：${usages.join('、')}`
                : modal === 'new'
                  ? '应用系统已创建，正在保存'
                  : '系统架构已更新，正在保存',
            )
          }}
        />
      )}
      {modal === 'delete' && deleteTarget && (
        <DeleteSystemDialog
          system={deleteTarget}
          referencedBy={[
            ...new Set(
              flattenArchitecture(deleteTarget.architecture)
                .flatMap((n) => incomingReferences(boards, n.id))
                .filter(
                  (u) =>
                    !flattenArchitecture(deleteTarget.architecture).some(
                      (n) => n.id === u.board.id,
                    ),
                )
                .map((u) => u.board.path),
            ),
          ]}
          deleting={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'reload' && (
        <Modal title="重新读取本地数据" onClose={() => setModal(null)}>
          <p className="modal-description">
            从文件重新加载系统架构和系统图。如果存在保存失败的修改，它们将被文件中的内容替换。
          </p>
          <div className="modal-footer">
            <button className="button text" onClick={() => setModal(null)}>
              取消
            </button>
            <button className="button primary" onClick={() => void reload()}>
              重新读取并替换
            </button>
          </div>
        </Modal>
      )}
      {modal === 'help' && (
        <Modal title="看清现状，设计下一次迭代" onClose={() => setModal(null)}>
          <p className="modal-description">Say Clear · 说清楚 / v0.1.0</p>
          <div className="guide-steps">
            <div>
              <span>01</span>
              <p>
                <strong>选择设计范围</strong>
                创建应用或系统总图，从原子图逐层聚合；选择任意节点进入独立画板，通过公开入口跨应用引用。
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                <strong>定义组件与连接</strong>
                通过角色、能力、界面、行为、规则等 12 类组件描述应用；按能力、流程或实现视角查看。
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                <strong>创建迭代，对比修改</strong>
                创建迭代后，在现状与本次迭代间切换。变更自动标记，实际落地后更新现状，原版本保留在历史中。
              </p>
            </div>
          </div>
          <div className="demo-notice">
            <HardDrive size={18} />
            <p>
              <strong>设计保存在本地</strong>
              桌面版数据保存在设置中指定的目录；浏览器预览使用当前浏览器的本地存储，两者相互独立。
            </p>
          </div>
          <button className="button primary full-width" onClick={() => setModal(null)}>
            开始设计系统图
            <ArrowRight size={15} />
          </button>
        </Modal>
      )}
    </div>
  )
}
