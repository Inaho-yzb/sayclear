import { useState } from 'react'
import {
  Archive,
  Download,
  FileJson,
  Folder,
  GitBranch,
  Layers,
  LoaderCircle,
  Network,
} from 'lucide-react'
import { planExport, type ExportOptions } from '../../../shared/export'
import { flattenArchitecture, type Workspace } from '../../../shared/model'
import { isDesktop } from '../services/desktop'
import { Modal } from './Modal'
import './export.css'

export function ExportDialog({
  workspace,
  onClose,
  onExport,
}: {
  workspace: Workspace
  onClose: () => void
  onExport: (options: ExportOptions, format: 'folder' | 'zip') => Promise<string | null>
}) {
  const boardId = workspace.activeNodeId ?? workspace.systems[0]?.architecture.id ?? ''
  const system = workspace.systems.find((item) =>
    flattenArchitecture(item.architecture).some((node) => node.id === boardId),
  )
  const board =
    system && flattenArchitecture(system.architecture).find((node) => node.id === boardId)
  const [scope, setScope] = useState<ExportOptions['scope']>('board')
  const [mode, setMode] = useState<'all' | 'changes'>('all')
  const [includeHistory, setIncludeHistory] = useState(true)
  const [format, setFormat] = useState<'folder' | 'zip'>(isDesktop ? 'folder' : 'zip')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changesOnly = mode === 'changes'
  const options: ExportOptions = {
    scope,
    boardId,
    mode,
    includeHistory: !changesOnly && includeHistory,
  }
  let plan: ReturnType<typeof planExport> | undefined
  let planError = ''
  try {
    plan = planExport(workspace, options)
  } catch (cause) {
    planError = cause instanceof Error ? cause.message : '无法生成导出预览'
  }
  const noChanges = changesOnly && plan?.changeCount === 0
  const submit = async () => {
    if (busy || !plan?.boardCount || noChanges) return
    setBusy(true)
    setError('')
    try {
      const result = await onExport(options, format)
      if (result) onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="导出交付包" onClose={onClose} wide busy={busy}>
      <p className="modal-description export-intro">
        将图、详细变更和结构化数据一起交付，供他人阅读、其他系统接入或 AI 理解。
      </p>
      <form
        className="export-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <fieldset className="export-fieldset export-mode" disabled={busy}>
          <legend>导出内容</legend>
          <div className="export-mode-options">
            {(
              [
                {
                  value: 'all',
                  label: '完整导出',
                  detail: '所选范围的完整图、变更与可选历史',
                  Icon: Layers,
                },
                {
                  value: 'changes',
                  label: '变更导出',
                  detail: '变更组合视图、归属与引用，以及所属原图',
                  Icon: GitBranch,
                },
              ] as const
            ).map(({ value, label, detail, Icon }) => (
              <label className={mode === value ? 'selected' : ''} key={value}>
                <input
                  type="radio"
                  name="export-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <Icon size={17} aria-hidden="true" />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="export-fieldset" disabled={busy}>
          <legend>{changesOnly ? '从哪里查找变更' : '导出范围'}</legend>
          <div className="export-scope-options">
            {(
              [
                {
                  value: 'board',
                  label: '当前画板',
                  detail: board?.name ?? '未选择画板',
                  Icon: Network,
                },
                {
                  value: 'system',
                  label: '当前系统',
                  detail: system?.architecture.name ?? '未选择系统',
                  Icon: Layers,
                },
                {
                  value: 'workspace',
                  label: '整个工作区',
                  detail: `${workspace.systems.length} 个系统及全部下级画板`,
                  Icon: Folder,
                },
              ] as const
            ).map(({ value, label, detail, Icon }) => (
              <label
                className={`export-scope-option ${scope === value ? 'selected' : ''}`}
                key={value}
              >
                <input
                  type="radio"
                  name="export-scope"
                  value={value}
                  checked={scope === value}
                  disabled={value !== 'workspace' && !board}
                  onChange={() => setScope(value)}
                />
                <Icon size={17} aria-hidden="true" />
                <strong>{label}</strong>
                <span title={detail}>{detail}</span>
              </label>
            ))}
          </div>
          {changesOnly && (
            <p className="export-scope-note">
              查找所选范围内进行中的迭代变更，自动纳入变更组件的归属和关联引用图；关联图可以来自范围外。
            </p>
          )}
          <label className={`export-history-option${changesOnly ? ' unavailable' : ''}`}>
            <input
              type="checkbox"
              checked={!changesOnly && includeHistory}
              disabled={changesOnly}
              onChange={(event) => setIncludeHistory(event.target.checked)}
            />
            <span>
              <strong>附带历史现状</strong>
              <small>
                {changesOnly
                  ? '变更导出聚焦进行中的迭代；按引用固定的必要历史版本仍会随包保留。'
                  : '附带历史快照与相邻版本的变更对比，便于追溯已完成迭代。'}
              </small>
            </span>
          </label>
        </fieldset>

        <div className="export-preview" aria-live="polite">
          <div className="export-preview-heading">
            <FileJson size={16} aria-hidden="true" />
            <strong>{changesOnly ? '变更交付包' : '交付包内容'}</strong>
            {plan && <span>{plan.boardCount} 张画板</span>}
          </div>
          <dl className="export-stats">
            <div>
              <dt>{changesOnly ? '变更所属图' : '进行中迭代'}</dt>
              <dd>{changesOnly ? (plan?.changedBoardCount ?? 0) : (plan?.iterationCount ?? 0)}</dd>
            </div>
            <div>
              <dt>进行中变更点</dt>
              <dd>{plan?.changeCount ?? 0}</dd>
            </div>
            <div>
              <dt>{changesOnly ? '关联与归属图' : '历史版本'}</dt>
              <dd>{changesOnly ? (plan?.relatedBoardCount ?? 0) : (plan?.historyCount ?? 0)}</dd>
            </div>
          </dl>
          {noChanges && (
            <p className="export-empty-state" role="status">
              {scope === 'board'
                ? '当前画板没有进行中的业务变更。可以选择当前系统或整个工作区，查找下级画板的变更。'
                : '所选范围没有进行中的业务变更。请先创建或编辑迭代，或选择完整导出。'}
            </p>
          )}
          <details className="export-package-files">
            <summary>查看文件结构与内容</summary>
            <ul className="export-file-list">
              <li>
                <code>README.md</code>
                <span>阅读顺序、范围与版本说明</span>
              </li>
              <li>
                <code>changes.md</code>
                <span>全部变更及字段前后值</span>
              </li>
              <li>
                <code>diagram.html</code>
                <span>
                  {changesOnly
                    ? '变更相关组合视图，增删改高亮与前后对比'
                    : '离线图浏览、增删改高亮与前后对比'}
                </span>
              </li>
              {changesOnly && (
                <li>
                  <code>combined.json</code>
                  <span>变更、归属及引用组成的结构化组合视图</span>
                </li>
              )}
              <li>
                <code>manifest.json / structure.json / catalog.json</code>
                <span>文件索引、画板层级与组件定义</span>
              </li>
              <li>
                <code>boards/&lt;ID&gt;/</code>
                <span>
                  {changesOnly
                    ? '各变更所属原图和关联图的完整内容、基线与变更'
                    : '各图 JSON、基线、详细变更与历史'}
                </span>
              </li>
              <li>
                <code>templates/</code>
                <span>可复用的 Markdown 交付模板</span>
              </li>
            </ul>
          </details>
          <p className="export-preview-note">
            {changesOnly
              ? '组合视图聚焦变更组件、归属和关联引用，同时保留各变更所属原图。未变更的上下文会单独标识，不计入变更数量。'
              : '进行中迭代按基线与结果精确对比；历史变更由相邻快照对比还原，不是逐次操作日志。移动位置不计入业务变更。'}
          </p>
        </div>

        <fieldset className="export-fieldset export-format" disabled={busy}>
          <legend>保存为</legend>
          <div className="export-format-options">
            {isDesktop && (
              <label className={format === 'folder' ? 'selected' : ''}>
                <input
                  type="radio"
                  name="export-format"
                  value="folder"
                  checked={format === 'folder'}
                  onChange={() => setFormat('folder')}
                />
                <Folder size={16} aria-hidden="true" />
                文件夹
              </label>
            )}
            <label className={format === 'zip' ? 'selected' : ''}>
              <input
                type="radio"
                name="export-format"
                value="zip"
                checked={format === 'zip'}
                onChange={() => setFormat('zip')}
              />
              <Archive size={16} aria-hidden="true" />
              ZIP 压缩包
            </label>
          </div>
          <p>
            {isDesktop
              ? '点击导出后选择保存位置。'
              : '浏览器预览将下载 ZIP，解压后打开 README.md 或 diagram.html。'}
          </p>
        </fieldset>

        {(error || planError) && (
          <p className="form-error" role="alert">
            {error || planError}
          </p>
        )}
        <div className="modal-footer export-footer">
          {busy && <span role="status">正在整理图与变更，请稍候…</span>}
          <button className="button text" type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !plan?.boardCount || !!planError || noChanges}
          >
            {busy ? <LoaderCircle className="export-spinner" size={15} /> : <Download size={15} />}
            {busy ? '正在导出…' : '导出交付包'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
