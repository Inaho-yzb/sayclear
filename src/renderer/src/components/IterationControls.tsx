import { useState } from 'react'
import { GitBranch, ListFilter, Plus, Check, History, X } from 'lucide-react'
import {
  componentTypes,
  connectionTypes,
  type ComponentType,
  type ConnectionType,
  type Diagram,
} from '../../../shared/diagram'
import {
  startIteration,
  publishIteration,
  discardIteration,
  changeLabels,
  type ModelChange,
} from '../../../shared/iteration'
import { Modal } from './Modal'
import {
  defaultIterationBranch,
  type GitRepository,
  type GitStartOptions,
} from '../../../shared/git'
import { IterationGitFields } from './IterationGitFields'

export type DiagramMode = 'current' | 'iteration'
export function IterationControls({
  model,
  mode,
  historicalId,
  changes,
  showChanges,
  onMode,
  onVersion,
  onToggleChanges,
  onApply,
  gitRepository,
  onStart,
}: {
  model: Diagram
  mode: DiagramMode
  historicalId: string
  changes: ModelChange[]
  showChanges: boolean
  onMode: (mode: DiagramMode) => void
  onVersion: (id: string) => void
  onToggleChanges: () => void
  onApply: (graph: Diagram) => boolean
  gitRepository?: GitRepository
  onStart?: (name: string, gitOptions?: GitStartOptions) => Promise<boolean>
}) {
  const [dialog, setDialog] = useState<'start' | 'publish' | 'discard' | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [gitReady, setGitReady] = useState(false)
  const [gitOptions, setGitOptions] = useState<GitStartOptions>({ branch: '', baseBranch: '' })
  const shownGit = historicalId
    ? model.history.find((version) => version.id === historicalId)?.git
    : model.iteration?.git
  const changed = changes.filter((c) => c.status !== 'unchanged')
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (dialog === 'start' && onStart) {
        if (gitRepository && !gitReady) throw new Error('请检查 Git 分支设置')
        if (await onStart(name, gitRepository ? gitOptions : undefined)) {
          onMode('iteration')
          setDialog(null)
        }
        return
      }
      if (dialog === 'start' && gitRepository) throw new Error('Git 迭代创建服务暂不可用')
      const next =
        dialog === 'start'
          ? startIteration(model, name)
          : dialog === 'publish'
            ? publishIteration(model)
            : discardIteration(model)
      if (onApply(next)) {
        onMode(dialog === 'start' ? 'iteration' : 'current')
        setDialog(null)
        setError('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法保存迭代')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="iteration-bar">
        <div className="iteration-tabs" aria-label="画板版本" title={model.iteration?.name}>
          {(['current', 'iteration'] as const).map((view) => (
            <button
              key={view}
              aria-pressed={!historicalId && (model.iteration ? mode === view : view === 'current')}
              disabled={view !== 'current' && !model.iteration}
              onClick={() => onMode(view)}
            >
              {{ current: '现状', iteration: '本次迭代' }[view]}
            </button>
          ))}
        </div>
        <div className="iteration-context">
          {(historicalId || model.iteration) && (
            <>
              <GitBranch size={14} />
              <strong title={model.iteration?.name}>
                {historicalId ? '历史现状' : model.iteration?.name}
              </strong>
            </>
          )}
          {shownGit && (
            <span
              className="iteration-git-branch"
              title={`${shownGit.repositoryPath} · 从 ${shownGit.baseBranch} 创建`}
            >
              <GitBranch size={12} />
              {shownGit.branch}
            </span>
          )}
          <small>
            {historicalId || (model.iteration && mode === 'current')
              ? '只读'
              : model.iteration
                ? '编辑迭代'
                : '现状可编辑'}
          </small>
        </div>
        {model.iteration && mode === 'iteration' && !historicalId && (
          <div className="iteration-legend" title="节点与连接自动对比，移动位置不计入业务变更">
            {(['added', 'modified', 'removed'] as const).map((status) => (
              <span key={status} className={`change-label change-${status}`}>
                <i />
                {changeLabels[status]} {changed.filter((c) => c.status === status).length}
              </span>
            ))}
            <span className="change-label change-affected">
              <i />
              关联影响
            </span>
          </div>
        )}
        <div className="iteration-actions">
          {model.history.length > 0 && (
            <label className="iteration-history">
              <History size={14} />
              <select
                aria-label="查看历史现状"
                value={historicalId}
                onChange={(e) => onVersion(e.target.value)}
              >
                <option value="">当前版本</option>
                {[...model.history].reverse().map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {model.iteration ? (
            <>
              <button
                className={`button text compact ${showChanges ? 'active' : ''}`}
                aria-expanded={showChanges}
                onClick={onToggleChanges}
              >
                <ListFilter size={14} />
                变更清单 <span className="iteration-count">{changed.length}</span>
              </button>
              <button
                className="button secondary compact"
                disabled={!!historicalId || !changed.length}
                onClick={() => {
                  setError('')
                  setDialog('publish')
                }}
              >
                <Check size={14} />
                更新为现状
              </button>
              <button
                className="icon-button"
                aria-label="放弃本次迭代"
                disabled={!!historicalId}
                onClick={() => {
                  setError('')
                  setDialog('discard')
                }}
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <button
              className="button secondary compact"
              disabled={!!historicalId}
              onClick={() => {
                setName('')
                setGitOptions({
                  branch: defaultIterationBranch(),
                  baseBranch: gitRepository?.baseBranch ?? '',
                })
                setGitReady(false)
                setError('')
                setDialog('start')
              }}
            >
              <Plus size={14} />
              创建迭代
            </button>
          )}
        </div>
      </div>
      {dialog && (
        <Modal
          title={
            dialog === 'start'
              ? '创建本次迭代'
              : dialog === 'publish'
                ? '更新系统现状'
                : '放弃本次迭代'
          }
          onClose={() => setDialog(null)}
          busy={busy}
        >
          <form
            className="diagram-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            {dialog === 'start' ? (
              <>
                <p className="modal-description">
                  保存当前画板作为现状基线，接下来的修改会记录在本次迭代中。
                </p>
                <label>
                  迭代名称
                  <input
                    aria-label="迭代名称"
                    autoFocus
                    required
                    maxLength={80}
                    disabled={busy}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：增加手机号验证码注册"
                  />
                </label>
                {gitRepository && (
                  <IterationGitFields
                    repository={gitRepository}
                    value={gitOptions}
                    onChange={setGitOptions}
                    onReadyChange={setGitReady}
                    disabled={busy}
                  />
                )}
              </>
            ) : (
              <p className="modal-description">
                {dialog === 'publish'
                  ? `确认「${model.iteration?.name}」已实际落地后，将本次迭代的结果记录为新的系统现状。包含 ${changed.filter((c) => c.kind === 'component').length} 个组件和 ${changed.filter((c) => c.kind === 'connection').length} 条连接的变化。原现状保留在历史版本中。`
                  : '本次迭代的修改将被移除，画板恢复为创建迭代时的现状。此操作可以撤销。'}
              </p>
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
                className="button primary"
                disabled={busy || (dialog === 'start' && !!gitRepository && !gitReady)}
              >
                {busy
                  ? '正在保存…'
                  : dialog === 'start'
                    ? gitRepository
                      ? '创建分支并开始迭代'
                      : '开始迭代'
                    : dialog === 'publish'
                      ? '确认更新现状'
                      : '放弃并恢复现状'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

export function describeIterationValue(value: unknown, model: Diagram): string {
  if (value === undefined || value === null || value === '') return '未设置'
  if (Array.isArray(value))
    return value.length
      ? value
          .map((item) =>
            typeof item === 'object' && item && 'name' in item
              ? `${item.name}${item.dataType ? ` · ${item.dataType}` : ''}${item.description ? ` · ${item.description}` : ''}`
              : String(item),
          )
          .join('\n')
      : '无'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return (
    [...model.components, ...(model.iteration?.baseline.components ?? [])].find(
      (component) => component.id === value,
    )?.name ??
    componentTypes[value as ComponentType] ??
    connectionTypes[value as ConnectionType] ??
    { internal: '系统内部', external: '系统外部' }[String(value)] ??
    String(value)
  )
}

export function ChangeDetails({
  change,
  describe = (value) =>
    typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '未设置'),
  fieldLabel = (value) => value,
}: {
  change: ModelChange
  describe?: (value: unknown) => string
  fieldLabel?: (value: string) => string
}) {
  return (
    <div className="change-details">
      <span className={`change-label change-${change.status}`}>{changeLabels[change.status]}</span>
      {change.fields.map((field) => (
        <div className="change-field" key={field.field}>
          <strong>{fieldLabel(field.field)}</strong>
          <div>
            <small>现状</small>
            <p>{describe(field.before)}</p>
          </div>
          <div>
            <small>迭代</small>
            <p>{describe(field.after)}</p>
          </div>
        </div>
      ))}
      {change.status === 'added' && <p>现状中不存在，本次迭代新增。</p>}
      {change.status === 'removed' && <p>本次迭代删除，仍保留在现状基线中。</p>}
    </div>
  )
}
