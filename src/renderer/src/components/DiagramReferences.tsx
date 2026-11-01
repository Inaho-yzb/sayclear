import { useState, type ReactNode } from 'react'
import { ArrowUpRight, Link2 } from 'lucide-react'
import {
  componentTypes,
  replaceComponent,
  type Diagram,
  type DiagramComponent,
} from '../../../shared/diagram'
import {
  createReference,
  exposedComponents,
  incomingReferences,
  referenceSnapshot,
  resolveReference,
  type Board,
  type BoardLocation,
} from '../../../shared/diagram-references'
import { Modal } from './Modal'
import { useHistorySnapshot } from '../services/use-history-snapshot'

export function ReferenceEditor({
  boards,
  boardId,
  graph,
  component,
  position,
  onSave,
  onClose,
}: {
  boards: Board[]
  boardId: string
  graph: Diagram
  component?: DiagramComponent
  position: { x: number; y: number }
  onSave: (c: DiagramComponent) => void
  onClose: () => void
}) {
  const allSources = boards.filter((b) => b.id !== boardId)
  const [application, setApplication] = useState('all')
  const sources = allSources.filter(
    (b) => application === 'all' || (b.applicationId ?? 'system') === application,
  )
  const [sourceId, setSourceId] = useState(component?.reference?.boardId ?? sources[0]?.id ?? '')
  const [version, setVersion] = useState<'current' | 'iteration' | 'history'>(
    component?.reference?.version ?? 'current',
  )
  const [historyId, setHistoryId] = useState(component?.reference?.historyId ?? '')
  const [entryId, setEntryId] = useState(component?.reference?.componentId ?? '')
  const [outputIds, setOutputIds] = useState<string[]>(component?.reference?.outputIds ?? [])
  const [error, setError] = useState('')
  const board = sources.find((b) => b.id === sourceId)
  const historical =
    version === 'history' ? board?.diagram.history.find((h) => h.id === historyId) : undefined
  const historyData = useHistorySnapshot(sourceId, historical)
  const loadedBoard =
    board && historical && historyData.snapshot
      ? {
          ...board,
          diagram: {
            ...board.diagram,
            history: board.diagram.history.map((h) =>
              h.id === historyId ? { ...h, snapshot: historyData.snapshot } : h,
            ),
          },
        }
      : board
  const iterationId = version === 'iteration' ? board?.diagram.iteration?.id : undefined
  const exposed = exposedComponents(
    loadedBoard && referenceSnapshot(loadedBoard, version, iterationId, historyId),
  )
  const entry = exposed.find((c) => c.id === entryId)
  let candidate: DiagramComponent | undefined
  let problem = ''
  if (board && entry) {
    try {
      candidate = createReference(
        boards.map((b) => (b.id === loadedBoard?.id ? loadedBoard : b)),
        boardId,
        {
          boardId: sourceId,
          componentId: entryId,
          version,
          ...(iterationId ? { iterationId } : {}),
          ...(version === 'history' ? { historyId } : {}),
          outputIds,
        },
        position,
      )
      if (component) candidate = { ...candidate, id: component.id, ownerId: component.ownerId }
    } catch (e) {
      problem = e instanceof Error ? e.message : '引用无效'
    }
  }
  const lost =
    component && candidate
      ? graph.connections.filter(
          (e) => !replaceComponent(graph, candidate!).connections.some((n) => n.id === e.id),
        )
      : []
  const reset = () => {
    setEntryId('')
    setOutputIds([])
    setError('')
  }
  return (
    <Modal title={component ? '更新画板引用' : '引用其他画板'} onClose={onClose} wide>
      <p className="modal-description">
        支持同一工作区内跨应用引用。选择公开能力、接口或事件，连接其输入与输出；来源变化时保留已采用定义，显式更新后才生效。
      </p>
      <form
        className="diagram-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!candidate) {
            setError(problem || '请选择对外开放的入口组件')
            return
          }
          try {
            onSave(candidate)
          } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败')
          }
        }}
      >
        <label>
          来源应用
          <select
            aria-label="引用来源应用"
            value={application}
            onChange={(e) => {
              setApplication(e.target.value)
              setSourceId(
                allSources.find(
                  (b) =>
                    e.target.value === 'all' || (b.applicationId ?? 'system') === e.target.value,
                )?.id ?? '',
              )
              setVersion('current')
              setHistoryId('')
              reset()
            }}
          >
            <option value="all">所有应用与系统总图</option>
            {[
              ...new Map(
                allSources.map((b) => [
                  b.applicationId ?? 'system',
                  b.applicationName ?? '系统总图',
                ]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          来源画板
          <select
            aria-label="引用来源画板"
            value={sourceId}
            onChange={(e) => {
              setSourceId(e.target.value)
              setVersion('current')
              reset()
            }}
          >
            {!sources.length && <option value="">暂无其他画板</option>}
            {sources.map((b) => (
              <option key={b.id} value={b.id}>
                {b.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          来源版本
          <select
            aria-label="引用来源版本"
            value={version === 'history' ? `history:${historyId}` : version}
            onChange={(e) => {
              const value = e.target.value
              setVersion(
                value.startsWith('history:') ? 'history' : (value as 'current' | 'iteration'),
              )
              setHistoryId(value.startsWith('history:') ? value.slice(8) : '')
              reset()
            }}
          >
            <option value="current">现状（更新时显式采用）</option>
            {board?.diagram.history.map((h) => (
              <option key={h.id} value={`history:${h.id}`}>
                历史 · {h.name}
              </option>
            ))}
            {version === 'history' && !board?.diagram.history.some((h) => h.id === historyId) && (
              <option value={`history:${historyId}`} disabled>
                原历史版本已移除
              </option>
            )}
            {board?.diagram.iteration && (
              <option value="iteration">迭代中 · {board.diagram.iteration.name}</option>
            )}
            {!board?.diagram.iteration && version === 'iteration' && (
              <option value="iteration" disabled>
                原迭代已结束，请选择现状
              </option>
            )}
          </select>
        </label>
        {version === 'iteration' && (
          <p className="form-warning">依赖尚未发布的迭代；该迭代结束后，需要重新选择来源版本。</p>
        )}
        {historyData.loading && <p role="status">正在读取来源历史版本…</p>}
        {historyData.error && (
          <div role="alert">
            <p className="form-error">{historyData.error}</p>
            <button type="button" className="button secondary" onClick={historyData.retry}>
              重试读取
            </button>
          </div>
        )}
        <label>
          对外入口
          <select
            aria-label="引用入口组件"
            value={entryId}
            onChange={(e) => {
              setEntryId(e.target.value)
              setOutputIds([])
            }}
          >
            <option value="">请选择入口</option>
            {exposed.map((c) => (
              <option key={c.id} value={c.id}>
                {componentTypes[c.type]} · {c.name}
              </option>
            ))}
          </select>
        </label>
        {!exposed.length && !historyData.loading && !historyData.error && (
          <p className="form-warning">
            该版本尚无对外开放的组件。请进入来源画板，编辑能力、事件或接口，勾选“允许其他画板引用”。现状与迭代分别生效。
          </p>
        )}
        {entry && (
          <>
            <p>{entry.description || '来源尚未填写说明'}</p>
            <fieldset className="reference-exports">
              <legend>附带的对外输出</legend>
              <p>入口自身的端口会自动带入，也可选择来源画板公开的事件、数据或接口作为输出。</p>
              {exposed
                .filter((c) => c.id !== entry.id && ['event', 'data', 'api'].includes(c.type))
                .map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      aria-label={`引用输出 ${c.name}`}
                      checked={outputIds.includes(c.id)}
                      onChange={(e) =>
                        setOutputIds(
                          e.target.checked
                            ? [...outputIds, c.id]
                            : outputIds.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span>
                      {componentTypes[c.type]} · {c.name}
                    </span>
                  </label>
                ))}
              {outputIds
                .filter((id) => !exposed.some((c) => c.id === id))
                .map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked
                      aria-label={`移除失效输出 ${id}`}
                      onChange={() => setOutputIds(outputIds.filter((v) => v !== id))}
                    />
                    <span>输出已失效，取消勾选后可更新</span>
                  </label>
                ))}
            </fieldset>
          </>
        )}
        {candidate && (
          <div className="reference-preview">
            <strong>{component ? `${component.name} → ${candidate.name}` : candidate.name}</strong>
            <p>
              {componentTypes[candidate.type]} · {candidate.inputs.length} 个输入 ·{' '}
              {candidate.outputs.length} 个输出
            </p>
            <p>输出：{candidate.outputs.map((p) => p.name).join('、') || '无'}</p>
            <details>
              <summary>查看来源定义</summary>
              <pre>
                {JSON.stringify(
                  {
                    说明: candidate.description,
                    属性: candidate.metadata,
                    输入: candidate.inputs,
                    输出: candidate.outputs,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        )}
        {lost.length > 0 && (
          <div className="form-warning">
            端口变更将移除 {lost.length} 条连接：{lost.map((e) => e.name).join('、')}
            。保存后可撤销。
          </div>
        )}
        {(error || problem) && (
          <p className="form-error" role="alert">
            {error || problem}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="button text" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={!candidate}>
            {component ? '更新引用' : '添加引用'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ReferenceDetails({
  component,
  boards,
  editable,
  historical,
  onOpen,
  onUpdate,
}: {
  component: DiagramComponent
  boards: Board[]
  editable: boolean
  historical: boolean
  onOpen: (location: BoardLocation) => void
  onUpdate: () => void
}) {
  const ref = component.reference!
  const resolved = resolveReference(boards, component)
  return (
    <div className={`diagram-detail-section reference-details status-${resolved.status}`}>
      <h3>
        <Link2 size={14} />
        画板引用
      </h3>
      <p>{resolved.board?.path ?? ref.boardId}</p>
      <strong>
        {ref.version === 'history'
          ? `历史 · ${resolved.board?.diagram.history.find((h) => h.id === ref.historyId)?.name ?? '版本不可用'}`
          : ref.version === 'iteration'
            ? '迭代中'
            : '现状 · 已采用定义'}
      </strong>
      <p>{historical ? '当前展示历史中已采用的定义快照。' : resolved.message}</p>
      <div className="diagram-detail-actions">
        <button
          className="button secondary compact"
          disabled={!resolved.board}
          onClick={() => onOpen(ref)}
        >
          查看来源
          <ArrowUpRight size={12} />
        </button>
        <button className="button secondary compact" disabled={!editable} onClick={onUpdate}>
          更新引用
        </button>
      </div>
      <p>名称、说明与端口由来源定义；本图保留已采用版本，更新时会列出受影响的连接。</p>
    </div>
  )
}

export function ReferenceUsages({
  boards,
  boardId,
  componentId,
  onOpen,
}: {
  boards: Board[]
  boardId: string
  componentId?: string
  onOpen: (location: BoardLocation) => void
}) {
  const usages = incomingReferences(boards, boardId, componentId)
  return (
    <div className="diagram-detail-section reference-usages">
      <h3>被哪些图引用 · {usages.length}</h3>
      {!usages.length && <p>暂无其他画板引用{componentId ? '此对象' : '本图'}。</p>}
      {usages.map((u) => (
        <button
          className="diagram-directory-item"
          key={`${u.board.id}-${u.component.id}-${u.version}`}
          onClick={() =>
            onOpen({
              boardId: u.board.id,
              componentId: u.component.id,
              version: u.version,
              iterationId: u.iterationId,
            })
          }
        >
          <span>
            {u.board.path}
            <small>
              {u.component.name} · {u.version === 'current' ? '现状' : '迭代中'}
            </small>
          </span>
          <ArrowUpRight size={12} />
        </button>
      ))}
    </div>
  )
}

export function ReferenceUsageModal({
  children,
  onClose,
}: {
  children: ReactNode
  onClose: () => void
}) {
  return (
    <Modal title="画板引用关系" onClose={onClose}>
      {children}
    </Modal>
  )
}
