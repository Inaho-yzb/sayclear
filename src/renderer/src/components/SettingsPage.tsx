import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Boxes,
  Check,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { type Workspace } from '../../../shared/model'
import { ComponentSettings } from './ComponentSettings'
import { defaultComponentCatalog, type ComponentCatalog } from '../../../shared/component-catalog'
import { isDesktop } from '../services/desktop'
import { storage } from '../services/storage'
import { AISettings } from './AISettings'
import { GitRepositorySettings } from './GitRepositorySettings'
import { type GitRepository } from '../../../shared/git'

interface Props {
  workspace: Workspace
  initialSection?: 'workspace' | 'components' | 'ai'
  onSaveCatalog: (catalog: ComponentCatalog) => Promise<void>
  onSaveRepository: (repository: GitRepository | undefined) => Promise<void>
  saveStatus: 'saving' | 'saved' | 'error'
  saveError: string
  reloadDisabled: boolean
  changingDirectory: boolean
  onChooseDataDirectory: () => Promise<string | null>
  onBack: () => void
  onReload: () => void
  onRetrySave: () => void
}

export function SettingsPage({
  workspace,
  initialSection = 'workspace',
  onSaveCatalog,
  onSaveRepository,
  saveStatus,
  saveError,
  reloadDisabled,
  changingDirectory,
  onChooseDataDirectory,
  onBack,
  onReload,
  onRetrySave,
}: Props) {
  const [section, setSection] = useState(initialSection)
  const sectionTitle =
    section === 'workspace' ? '工作空间设置' : section === 'ai' ? 'AI 设置' : '组件设置'
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [dataDirectory, setDataDirectory] = useState<string | null>(null)
  const [directoryError, setDirectoryError] = useState('')
  const [loadingDirectory, setLoadingDirectory] = useState(isDesktop)
  useEffect(() => {
    titleRef.current?.focus()
  }, [section])
  useEffect(() => {
    let disposed = false
    void storage.getDataDirectory().then(
      (directory) => {
        if (!disposed) {
          setDataDirectory(directory)
          setLoadingDirectory(false)
        }
      },
      (error: unknown) => {
        if (!disposed) {
          setDirectoryError(error instanceof Error ? error.message : '无法读取数据目录')
          setLoadingDirectory(false)
        }
      },
    )
    return () => {
      disposed = true
    }
  }, [])
  const chooseDirectory = async () => {
    setDirectoryError('')
    try {
      const directory = await onChooseDataDirectory()
      if (directory) setDataDirectory(directory)
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : '更换数据目录失败，请重试')
    }
  }
  const boards = workspace.systems.flatMap((system) => system.architecture.boards)
  const aggregates = boards.filter((n) => n.kind !== 'atomic').length
  const atoms = boards.filter((n) => n.kind === 'atomic').length

  return (
    <>
      <aside className="sidebar settings-sidebar" aria-label="设置导航">
        <button className="settings-back" onClick={onBack}>
          <ArrowLeft size={16} />
          返回工作空间
        </button>
        <h2 className="settings-sidebar-title">设置</h2>
        <nav className="settings-menu" aria-label="设置菜单">
          <button
            className={`settings-menu-item ${section === 'ai' ? 'active' : ''}`}
            aria-current={section === 'ai' ? 'page' : undefined}
            onClick={() => setSection('ai')}
          >
            <Sparkles size={17} />
            AI 设置
          </button>
          <button
            className={`settings-menu-item ${section === 'workspace' ? 'active' : ''}`}
            aria-current={section === 'workspace' ? 'page' : undefined}
            onClick={() => setSection('workspace')}
          >
            <FolderOpen size={17} />
            工作空间设置
          </button>
          <button
            className={`settings-menu-item ${section === 'components' ? 'active' : ''}`}
            aria-current={section === 'components' ? 'page' : undefined}
            onClick={() => setSection('components')}
          >
            <Boxes size={17} />
            组件设置
          </button>
        </nav>
        <div className="local-label">
          <span />
          本地工作空间
        </div>
      </aside>
      <main className="workspace settings-page" aria-labelledby="settings-title">
        <header className="workspace-header">
          <div className="breadcrumb">
            <span>设置</span>
            <span aria-hidden="true">/</span>
            <strong>{sectionTitle}</strong>
          </div>
        </header>
        <div className="settings-scroll">
          <div className="settings-content">
            <div className="settings-intro">
              <h1 id="settings-title" ref={titleRef} tabIndex={-1}>
                {sectionTitle}
              </h1>
              <p>
                {section === 'workspace'
                  ? '查看工作空间信息，管理本地数据。'
                  : section === 'ai'
                    ? '选择 AI 工具，用对话完善系统图。'
                    : '为不同场景定义组件与元数据，让每张系统图遵循统一规范。'}
              </p>
            </div>
            {section === 'ai' ? (
              <AISettings />
            ) : section === 'components' ? (
              <>
                <div className="catalog-save-status" role="status">
                  {saveStatus === 'saved'
                    ? '已保存到本地'
                    : saveStatus === 'saving'
                      ? '正在保存…'
                      : '保存失败'}
                  {saveStatus === 'error' && (
                    <button className="button text compact" onClick={onRetrySave}>
                      重试
                    </button>
                  )}
                </div>
                {saveError && (
                  <div className="save-error" role="alert">
                    {saveError}
                  </div>
                )}
                <ComponentSettings
                  catalog={workspace.componentCatalog ?? defaultComponentCatalog}
                  onSave={onSaveCatalog}
                />
              </>
            ) : (
              <>
                <section className="settings-section" aria-labelledby="workspace-overview-title">
                  <h2 id="workspace-overview-title">工作空间概览</h2>
                  <div className="settings-card">
                    <div className="settings-workspace-name">
                      <span className="settings-workspace-icon">
                        <FolderOpen size={22} />
                      </span>
                      <div>
                        <h3>本地工作空间</h3>
                        <p>在这里整理应用边界、聚合图与原子图。</p>
                      </div>
                    </div>
                    <dl className="settings-stats">
                      <div>
                        <dt>应用系统</dt>
                        <dd>{workspace.systems.length}</dd>
                      </div>
                      <div>
                        <dt>聚合图与应用</dt>
                        <dd>{aggregates}</dd>
                      </div>
                      <div>
                        <dt>原子图</dt>
                        <dd>{atoms}</dd>
                      </div>
                    </dl>
                  </div>
                </section>
                <GitRepositorySettings
                  repository={workspace.gitRepository}
                  onSave={onSaveRepository}
                />
                <section className="settings-section" aria-labelledby="workspace-storage-title">
                  <h2 id="workspace-storage-title">数据与存储</h2>
                  <div className="settings-card">
                    <div className="settings-directory">
                      <div className="settings-row">
                        <div>
                          <h3>数据目录</h3>
                          <p>选择本地文件夹，保存系统架构与系统图。</p>
                        </div>
                        <button
                          className="button secondary"
                          disabled={
                            !isDesktop || loadingDirectory || reloadDisabled || changingDirectory
                          }
                          onClick={() => void chooseDirectory()}
                        >
                          {changingDirectory ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <FolderOpen size={14} />
                          )}
                          {changingDirectory ? '正在更换…' : '选择文件夹'}
                        </button>
                      </div>
                      {isDesktop ? (
                        <>
                          <input
                            className="settings-directory-path"
                            aria-label="当前数据目录"
                            readOnly
                            value={dataDirectory ?? ''}
                            placeholder={
                              loadingDirectory ? '正在读取数据目录…' : '暂时无法读取数据目录'
                            }
                            title={dataDirectory ?? undefined}
                          />
                          <p className="settings-directory-hint">
                            请选择空文件夹。现有数据会复制到新目录，原目录保留副本；设置立即生效，重启后继续使用。
                          </p>
                        </>
                      ) : (
                        <p className="settings-directory-hint">
                          请在桌面版中选择本地文件夹。浏览器预览使用浏览器存储。
                        </p>
                      )}
                      {directoryError && (
                        <p className="form-error" role="alert">
                          {directoryError}
                        </p>
                      )}
                    </div>
                    <div className="settings-row">
                      <div>
                        <h3>存储方式</h3>
                        <p>
                          {isDesktop
                            ? '系统架构与系统图保存在上方指定的数据目录。'
                            : '当前为浏览器预览，数据保存在此浏览器中，与桌面版相互独立。'}
                        </p>
                      </div>
                      <span className="settings-value">
                        {isDesktop ? '本地文件' : '浏览器存储'}
                      </span>
                    </div>
                    <div className="settings-row">
                      <div>
                        <h3>自动保存</h3>
                        <p>工作空间的修改会自动保存到本地。</p>
                      </div>
                      <span className={`save-status ${saveStatus}`} role="status">
                        {saveStatus === 'saved' ? (
                          <Check size={14} />
                        ) : saveStatus === 'saving' ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <HardDrive size={14} />
                        )}
                        {saveStatus === 'saved'
                          ? '已保存到本地'
                          : saveStatus === 'saving'
                            ? '正在保存'
                            : '保存失败'}
                        {saveStatus === 'error' && <button onClick={onRetrySave}>重试</button>}
                      </span>
                    </div>
                    {saveError && (
                      <div className="save-error" role="alert">
                        {saveError}
                      </div>
                    )}
                    <div className="settings-row">
                      <div>
                        <h3>重新读取本地数据</h3>
                        <p>重新加载已保存的系统架构和系统图。</p>
                      </div>
                      <button
                        className="button secondary compact"
                        disabled={reloadDisabled}
                        onClick={onReload}
                      >
                        <RefreshCw size={14} />
                        重新读取
                      </button>
                    </div>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </>
  )
}
