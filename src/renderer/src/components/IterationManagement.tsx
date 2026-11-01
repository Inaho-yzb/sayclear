import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  GitBranch,
  History,
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react'
import { type Workspace } from '../../../shared/model'
import { type BoardLocation } from '../../../shared/diagram-references'
import { defaultComponentCatalog, getTemplate } from '../../../shared/component-catalog'
import { iterationBoards, type IterationAction } from '../../../shared/iteration-management'
import { changeLabels, iterationChanges, type ModelChange } from '../../../shared/iteration'
import { ChangeDetails, describeIterationValue } from './IterationControls'
import { Modal } from './Modal'
import './iteration-management.css'
import { defaultIterationBranch, type GitStartOptions } from '../../../shared/git'
import { IterationGitFields } from './IterationGitFields'

type Dialog =
  | { type: 'start' }
  | { type: 'rename' | 'publish' | 'discard' | 'changes'; boardId: string; iterationId: string }

const dateLabel = (date: string) =>
  new Date(date).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

function ChangeCounts({ changes }: { changes: ModelChange[] }) {
  return (
    <div className="management-change-counts">
      {(['added', 'modified', 'removed'] as const).map((status) => (
        <span key={status} className={`change-label change-${status}`}>
          <i />
          {changeLabels[status]} {changes.filter((change) => change.status === status).length}
        </span>
      ))}
    </div>
  )
}

export function IterationManagement({
  workspace,
  saveStatus,
  saveError,
  onRetrySave,
  onAction,
  onOpenBoard,
  onBack,
}: {
  workspace: Workspace
  saveStatus: 'saving' | 'saved' | 'error'
  saveError: string
  onRetrySave: () => void
  onAction: (action: IterationAction, gitOptions?: GitStartOptions) => Promise<void> | void
  onOpenBoard: (location: BoardLocation) => void
  onBack: () => void
}) {
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [query, setQuery] = useState('')
  const [systemId, setSystemId] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [boardId, setBoardId] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [gitReady, setGitReady] = useState(false)
  const [gitOptions, setGitOptions] = useState<GitStartOptions>({ branch: '', baseBranch: '' })
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    titleRef.current?.focus()
  }, [])
  const boards = useMemo(() => iterationBoards(workspace), [workspace])
  const active = useMemo(
    () =>
      boards
        .flatMap((board) =>
          board.diagram.iteration
            ? [
                {
                  board,
                  iteration: board.diagram.iteration,
                  changes: iterationChanges(board.diagram).filter(
                    (change) => change.status !== 'unchanged',
                  ),
                },
              ]
            : [],
        )
        .sort((a, b) => b.iteration.startedAt.localeCompare(a.iteration.startedAt)),
    [boards],
  )
  const history = useMemo(
    () =>
      boards
        .flatMap((board) => board.diagram.history.map((version) => ({ board, version })))
        .sort((a, b) => b.version.publishedAt.localeCompare(a.version.publishedAt)),
    [boards],
  )
  const search = query.trim().toLocaleLowerCase()
  const matches = (board: (typeof boards)[number], title: string) =>
    (!systemId || board.systemId === systemId) &&
    `${title} ${board.path}`.toLocaleLowerCase().includes(search)
  const visibleActive = active.filter(({ board, iteration }) => matches(board, iteration.name))
  const visibleHistory = history.filter(({ board, version }) => matches(board, version.name))
  const available = boards.filter((board) => !board.diagram.iteration)
  const selected =
    dialog && dialog.type !== 'start'
      ? active.find(
          ({ board, iteration }) =>
            board.id === dialog.boardId && iteration.id === dialog.iterationId,
        )
      : undefined
  const openCreate = () => {
    setBoardId(
      available.find((board) => board.id === workspace.activeNodeId)?.id ??
        available.find((board) => !systemId || board.systemId === systemId)?.id ??
        available[0]?.id ??
        '',
    )
    setName('')
    setGitOptions({
      branch: defaultIterationBranch(),
      baseBranch: workspace.gitRepository?.baseBranch ?? '',
    })
    setGitReady(false)
    setError('')
    setDialog({ type: 'start' })
  }
  const openDialog = (type: Exclude<Dialog['type'], 'start'>, entry: (typeof active)[number]) => {
    setName(entry.iteration.name)
    setError('')
    setDialog({ type, boardId: entry.board.id, iterationId: entry.iteration.id })
  }
  const openIteration = (entry: (typeof active)[number], componentId?: string) =>
    onOpenBoard({
      boardId: entry.board.id,
      version: 'iteration',
      iterationId: entry.iteration.id,
      componentId,
    })
  const submit = async () => {
    if (busy || !dialog || dialog.type === 'changes') return
    setBusy(true)
    setError('')
    try {
      if (dialog.type === 'start') {
        if (workspace.gitRepository && !gitReady) throw new Error('请检查 Git 分支设置')
        await onAction(
          { type: 'start', boardId, name },
          workspace.gitRepository ? gitOptions : undefined,
        )
      } else {
        if (!selected) throw new Error('该迭代已结束或发生变化，请重新选择')
        await onAction(
          dialog.type === 'rename'
            ? { ...dialog, type: 'rename', name }
            : { ...dialog, type: dialog.type },
        )
      }
      setTab('active')
      if (dialog.type === 'start') {
        setQuery('')
        setSystemId('')
      }
      setDialog(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法保存迭代')
    } finally {
      setBusy(false)
    }
  }
  const resultCount = tab === 'active' ? visibleActive.length : visibleHistory.length
  return (
    <main className="workspace iteration-management" aria-labelledby="iteration-management-title">
      <header className="workspace-header">
        <button className="button text compact" onClick={onBack}>
          <ArrowLeft size={14} />
          返回画板
        </button>
        <span className={`save-status ${saveStatus}`} role="status">
          {saveStatus === 'saved'
            ? '已保存到本地'
            : saveStatus === 'saving'
              ? '正在保存'
              : '保存失败'}
          {saveStatus === 'error' && <button onClick={onRetrySave}>重试</button>}
        </span>
      </header>
      {saveError && (
        <div className="save-error" role="alert">
          {saveError}
        </div>
      )}
      <div className="management-scroll">
        <div className="management-content">
          <div className="management-intro">
            <div>
              <span className="management-eyebrow">
                <GitBranch size={14} />
                工作空间
              </span>
              <h1 id="iteration-management-title" ref={titleRef} tabIndex={-1}>
                迭代管理
              </h1>
              <p>汇总各画板的迭代，跟进变更，记录落地后的系统现状。</p>
            </div>
            <button
              className="button primary"
              onClick={openCreate}
              disabled={!available.length}
              title={
                !boards.length
                  ? '请先创建应用系统'
                  : !available.length
                    ? '所有画板均有进行中的迭代'
                    : undefined
              }
            >
              <Plus size={16} />
              创建迭代
            </button>
          </div>
          <dl className="management-stats">
            <div>
              <dt>进行中的迭代</dt>
              <dd>
                {active.length}
                <small>个</small>
              </dd>
            </div>
            <div>
              <dt>待落地的变更</dt>
              <dd>
                {active.reduce((sum, entry) => sum + entry.changes.length, 0)}
                <small>项</small>
              </dd>
            </div>
            <div>
              <dt>历史现状快照</dt>
              <dd>
                {history.length}
                <small>份</small>
              </dd>
            </div>
          </dl>
          <div className="management-toolbar">
            <div className="management-tabs" aria-label="迭代记录类型">
              <button aria-pressed={tab === 'active'} onClick={() => setTab('active')}>
                <GitBranch size={14} />
                进行中<span>{active.length}</span>
              </button>
              <button aria-pressed={tab === 'history'} onClick={() => setTab('history')}>
                <History size={14} />
                历史现状<span>{history.length}</span>
              </button>
            </div>
            <div className="management-filters">
              <label className="management-search">
                <Search size={15} />
                <input
                  aria-label="搜索迭代或画板"
                  placeholder="搜索迭代或画板"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <select
                aria-label="筛选应用系统"
                value={systemId}
                onChange={(event) => setSystemId(event.target.value)}
              >
                <option value="">全部系统</option>
                {workspace.systems.map(({ architecture }) => (
                  <option key={architecture.id} value={architecture.id}>
                    {architecture.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="management-list-note">
            {tab === 'active'
              ? '每张画板独立迭代；移动位置不计入业务变更。'
              : '每次完成迭代时保留更新前的现状，可打开画板只读查看。'}
            <span>{resultCount} 条记录</span>
          </p>
          <div
            className="management-list"
            aria-label={tab === 'active' ? '进行中的迭代' : '历史现状记录'}
          >
            {tab === 'active'
              ? visibleActive.map((entry) => (
                  <article
                    className="management-card"
                    key={`${entry.board.id}-${entry.iteration.id}`}
                    data-iteration-board={entry.board.id}
                  >
                    <div className="management-card-heading">
                      <span className="management-card-icon">
                        <GitBranch size={18} />
                      </span>
                      <div>
                        <h2>{entry.iteration.name}</h2>
                        <p>{entry.board.path}</p>
                        {entry.iteration.git && (
                          <span
                            className="iteration-git-branch"
                            title={`${entry.iteration.git.repositoryPath} · 从 ${entry.iteration.git.baseBranch} 创建`}
                          >
                            <GitBranch size={12} />
                            {entry.iteration.git.branch}
                          </span>
                        )}
                      </div>
                      <span className="management-status">进行中</span>
                    </div>
                    <div className="management-card-meta">
                      <ChangeCounts changes={entry.changes} />
                      <time dateTime={entry.iteration.startedAt}>
                        创建于 {dateLabel(entry.iteration.startedAt)}
                      </time>
                    </div>
                    <div className="management-card-footer">
                      <button
                        className="button text compact"
                        onClick={() => openDialog('changes', entry)}
                      >
                        查看变更 <span className="iteration-count">{entry.changes.length}</span>
                      </button>
                      <button className="button text compact" onClick={() => openIteration(entry)}>
                        打开画板
                        <ArrowUpRight size={13} />
                      </button>
                      <div className="management-card-actions">
                        <button
                          className="button text compact"
                          onClick={() => openDialog('rename', entry)}
                        >
                          <Pencil size={13} />
                          改名
                        </button>
                        <button
                          className="button secondary compact"
                          disabled={
                            !entry.changes.length || entry.board.diagram.history.length >= 50
                          }
                          title={
                            entry.board.diagram.history.length >= 50
                              ? '历史现状已达 50 个上限'
                              : !entry.changes.length
                                ? '还没有业务变更'
                                : '更新为现状并保留原版本'
                          }
                          onClick={() => openDialog('publish', entry)}
                        >
                          <Check size={13} />
                          完成迭代
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`放弃迭代 ${entry.iteration.name}`}
                          title="放弃迭代"
                          onClick={() => openDialog('discard', entry)}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))
              : visibleHistory.map(({ board, version }) => (
                  <article className="management-card" key={`${board.id}-${version.id}`}>
                    <div className="management-card-heading">
                      <span className="management-card-icon historical">
                        <History size={18} />
                      </span>
                      <div>
                        <h2>{version.name}</h2>
                        <p>{board.path}</p>
                        {version.git && (
                          <span
                            className="iteration-git-branch"
                            title={`${version.git.repositoryPath} · 从 ${version.git.baseBranch} 创建`}
                          >
                            <GitBranch size={12} />
                            {version.git.branch}
                          </span>
                        )}
                      </div>
                      <span className="management-status historical">只读快照</span>
                    </div>
                    <div className="management-card-meta">
                      <span>
                        {version.snapshot?.components.length ?? version.componentCount} 个组件 ·{' '}
                        {version.snapshot?.connections.length ?? version.connectionCount} 条连接
                      </span>
                      <time dateTime={version.publishedAt}>
                        保留于 {dateLabel(version.publishedAt)}
                      </time>
                    </div>
                    <div className="management-card-footer">
                      <span>更新前的系统现状</span>
                      <button
                        className="button text compact"
                        onClick={() =>
                          onOpenBoard({
                            boardId: board.id,
                            version: 'history',
                            historyId: version.id,
                          })
                        }
                      >
                        查看历史画板
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                  </article>
                ))}
            {!resultCount && (
              <div className="management-empty">
                {tab === 'active' ? <GitBranch size={30} /> : <History size={30} />}
                <h2>
                  {search || systemId
                    ? '没有匹配的记录'
                    : tab === 'active'
                      ? '还没有进行中的迭代'
                      : '还没有历史现状'}
                </h2>
                <p>
                  {search || systemId
                    ? '试试其他关键词，或清除筛选条件。'
                    : !boards.length
                      ? '先创建应用系统，再为画板开始第一次迭代。'
                      : tab === 'active'
                        ? '选择一张画板，保存现状基线，开始设计下一次变更。'
                        : '完成迭代后，更新前的现状会保留在这里。'}
                </p>
                {search || systemId ? (
                  <button
                    className="button secondary"
                    onClick={() => {
                      setQuery('')
                      setSystemId('')
                    }}
                  >
                    清除筛选
                  </button>
                ) : tab === 'active' && available.length > 0 ? (
                  <button className="button secondary" onClick={openCreate}>
                    <Plus size={14} />
                    创建第一个迭代
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
      {dialog && (
        <Modal
          title={
            {
              start: '创建迭代',
              rename: '修改迭代名称',
              publish: '完成迭代并更新现状',
              discard: '放弃迭代',
              changes: '迭代变更清单',
            }[dialog.type]
          }
          onClose={() => setDialog(null)}
          wide={dialog.type === 'changes'}
          busy={busy}
        >
          {dialog.type === 'changes' ? (
            selected ? (
              <>
                <p className="management-dialog-title">
                  <strong>{selected.iteration.name}</strong>
                  <span>{selected.board.path}</span>
                </p>
                <ChangeCounts changes={selected.changes} />
                <div className="management-changes">
                  {!selected.changes.length && (
                    <p className="modal-description">
                      还没有业务变更。打开画板添加或修改组件，变更会自动记录在这里。
                    </p>
                  )}
                  {selected.changes.map((change) => (
                    <details className="change-list-item" key={`${change.kind}-${change.id}`}>
                      <summary>
                        <span className={`change-label change-${change.status}`}>
                          {changeLabels[change.status]}
                        </span>
                        <strong>{change.name}</strong>
                        <small>{change.kind === 'component' ? '组件' : '连接'}</small>
                      </summary>
                      <ChangeDetails
                        change={change}
                        describe={(value) => describeIterationValue(value, selected.board.diagram)}
                        fieldLabel={(field) => {
                          const component = [
                            ...selected.board.diagram.components,
                            ...selected.iteration.baseline.components,
                          ].find((item) => item.id === change.id)
                          return field.startsWith('属性 / ') && component
                            ? (getTemplate(
                                workspace.componentCatalog ?? defaultComponentCatalog,
                                selected.board.diagram,
                                component,
                              )?.fields.find((item) => item.id === field.slice(5))?.name ?? field)
                            : field
                        }}
                      />
                      {change.kind === 'component' && (
                        <button
                          className="button text compact"
                          onClick={() => openIteration(selected, change.id)}
                        >
                          在画板中查看
                          <ArrowUpRight size={12} />
                        </button>
                      )}
                    </details>
                  ))}
                </div>
                <div className="modal-footer">
                  <button className="button primary" onClick={() => openIteration(selected)}>
                    打开迭代画板
                    <ArrowUpRight size={14} />
                  </button>
                </div>
              </>
            ) : (
              <p className="form-error" role="alert">
                该迭代已结束或发生变化，请重新选择。
              </p>
            )
          ) : (
            <form
              className="diagram-form"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              {dialog.type === 'start' ? (
                <>
                  <p className="modal-description">
                    保存所选画板作为现状基线，接下来的修改会记录在本次迭代中。
                  </p>
                  <label>
                    所属画板
                    <select
                      aria-label="迭代所属画板"
                      required
                      disabled={busy}
                      value={boardId}
                      onChange={(event) => setBoardId(event.target.value)}
                    >
                      <option value="" disabled>
                        选择画板
                      </option>
                      {boards.map((board) => (
                        <option
                          key={board.id}
                          value={board.id}
                          disabled={!!board.diagram.iteration}
                        >
                          {board.path}
                          {board.diagram.iteration ? '（迭代进行中）' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <p className="management-dialog-title">
                  <strong>{selected?.iteration.name ?? '迭代已结束'}</strong>
                  <span>{selected?.board.path}</span>
                </p>
              )}
              {dialog.type === 'start' || dialog.type === 'rename' ? (
                <label>
                  迭代名称
                  <input
                    aria-label="迭代名称"
                    autoFocus
                    required
                    maxLength={80}
                    disabled={busy}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：增加手机号验证码注册"
                  />
                </label>
              ) : (
                <p className="modal-description">
                  {dialog.type === 'publish'
                    ? `确认本次迭代已实际落地，将 ${selected?.changes.length ?? 0} 项变更更新为系统现状。更新前的现状将保留为只读历史快照。此操作只记录系统模型，不执行部署。`
                    : '本次迭代的修改将被移除，画板恢复为创建迭代时的现状。已有历史快照保留；放弃后无法在管理页撤销。'}
                </p>
              )}
              {dialog.type === 'start' && workspace.gitRepository && (
                <IterationGitFields
                  repository={workspace.gitRepository}
                  value={gitOptions}
                  onChange={setGitOptions}
                  onReadyChange={setGitReady}
                  disabled={busy}
                />
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-footer">
                <button
                  type="button"
                  className="button text"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={`button ${dialog.type === 'discard' ? 'danger' : 'primary'}`}
                  disabled={
                    busy ||
                    (dialog.type === 'start'
                      ? !boardId || !name.trim() || (!!workspace.gitRepository && !gitReady)
                      : !selected || (dialog.type === 'rename' && !name.trim()))
                  }
                >
                  {busy
                    ? '正在保存…'
                    : {
                        start: workspace.gitRepository ? '创建分支并开始迭代' : '开始迭代',
                        rename: '保存名称',
                        publish: '确认完成并更新现状',
                        discard: '放弃并恢复现状',
                      }[dialog.type]}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </main>
  )
}
