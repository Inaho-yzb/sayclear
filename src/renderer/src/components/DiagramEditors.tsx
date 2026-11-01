import { useState, type FormEvent, type ReactNode } from 'react'
import { Plus, Trash2, ArrowDown, Copy } from 'lucide-react'
import {
  componentTypes,
  connectionTypes,
  connectionDescriptions,
  componentDescriptions,
  newPort,
  diagramSchema,
  replaceComponent,
  type Diagram,
  type DiagramComponent,
  type DiagramConnection,
  type ConnectionType,
  type Port,
} from '../../../shared/diagram'
import { Modal } from './Modal'
import {
  metadataValue,
  fieldValueError,
  type ComponentTemplate,
} from '../../../shared/component-catalog'
import { copyText } from '../services/desktop'
import { ValidationEditor } from './ValidationEditor'

function validationError(value: unknown): string {
  const parsed = diagramSchema.safeParse(value)
  return parsed.success ? '' : parsed.error.issues[0].message
}

export function ComponentEditor({
  component,
  graph,
  template,
  title,
  submitLabel,
  templateMode = false,
  extraFields,
  onSave,
  onClose,
}: {
  component: DiagramComponent
  graph: Diagram
  template?: ComponentTemplate
  title?: string
  submitLabel?: string
  templateMode?: boolean
  extraFields?: ReactNode
  onSave: (component: DiagramComponent) => void | Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(() =>
    template
      ? {
          ...component,
          templateId: template.id,
          metadata: Object.fromEntries(
            template.fields.map((f) => [f.id, metadataValue(component, f)]),
          ),
        }
      : component,
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const existing = graph.components.some((c) => c.id === component.id)
  const nextGraph = () =>
    existing
      ? replaceComponent(graph, draft)
      : { ...graph, components: [...graph.components, draft] }
  const removedConnections = graph.connections.length - nextGraph().connections.length
  const updatePorts = (side: 'inputs' | 'outputs', ports: Port[]) =>
    setDraft({ ...draft, [side]: ports })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const error = validationError(nextGraph())
    if (error) {
      setError(error)
      return
    }
    for (const field of template?.fields ?? []) {
      const error = fieldValueError(field, metadataValue(draft, field))
      if (error) {
        setError(error)
        return
      }
    }
    setSaving(true)
    try {
      await onSave({
        ...draft,
        name: draft.name.trim(),
        inputs: draft.inputs.map((p) => ({ ...p, name: p.name.trim() })),
        outputs: draft.outputs.map((p) => ({ ...p, name: p.name.trim() })),
      })
    } catch (error) {
      setError(
        error instanceof Error
          ? 'issues' in error
            ? (error.issues as { message: string }[])[0].message
            : error.message
          : typeof error === 'string'
            ? error
            : '保存失败',
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title={title ?? (existing ? '编辑组件' : '添加组件')}
      onClose={onClose}
      wide
      busy={saving}
    >
      <p className="modal-description">
        {templateMode
          ? '定义组件的默认说明、输入输出和自定义属性。默认说明与端口的修改仅影响之后添加的组件。'
          : componentDescriptions[draft.type]}
      </p>
      <form onSubmit={submit} className="diagram-form" inert={saving} aria-busy={saving}>
        <div className="diagram-form-row">
          <label>
            名称
            <input
              aria-label="组件名称"
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </label>
          {!templateMode && (
            <label>
              组件模板
              <input
                aria-label="组件类型"
                readOnly
                value={template?.name ?? componentTypes[draft.type]}
              />
            </label>
          )}
        </div>
        {!templateMode && ['service', 'api', 'store'].includes(draft.type) && (
          <label>
            系统边界
            <select
              aria-label="系统边界"
              value={draft.boundary}
              onChange={(e) =>
                setDraft({ ...draft, boundary: e.target.value as 'internal' | 'external' })
              }
            >
              <option value="internal">系统内部</option>
              <option value="external">系统外部</option>
            </select>
          </label>
        )}
        {!templateMode && !draft.reference && (
          <label className="reference-exposure">
            <input
              type="checkbox"
              aria-label="允许其他画板引用"
              checked={draft.exposed ?? false}
              onChange={(e) => setDraft({ ...draft, exposed: e.target.checked })}
            />
            <span>允许其他画板引用（对外开放此组件及其输入输出）</span>
          </label>
        )}
        {extraFields}
        {!templateMode && draft.validation && (
          <ValidationEditor
            value={draft.validation}
            onChange={(validation) => setDraft({ ...draft, validation })}
          />
        )}
        {template && template.fields.length > 0 && (
          <fieldset className="diagram-ports-editor">
            <legend>组件属性</legend>
            {template.fields.map((field) => (
              <label key={field.id}>
                {field.name}
                {field.required ? ' *' : ''}
                {field.type === 'boolean' ? (
                  <select
                    aria-label={`组件属性 ${field.name}`}
                    required={field.required}
                    value={metadataValue(draft, field)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        metadata: { ...draft.metadata, [field.id]: e.target.value },
                      })
                    }
                  >
                    <option value="">请选择</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : (
                  <input
                    aria-label={`组件属性 ${field.name}`}
                    required={field.required}
                    maxLength={10000}
                    type={field.type === 'number' ? 'number' : 'text'}
                    step="any"
                    value={metadataValue(draft, field)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        metadata: { ...draft.metadata, [field.id]: e.target.value },
                      })
                    }
                  />
                )}
              </label>
            ))}
          </fieldset>
        )}
        <label>
          说明
          <textarea
            aria-label="组件说明"
            rows={3}
            maxLength={10000}
            placeholder="这个组件负责什么？内部如何处理？"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        {!templateMode && (
          <label>
            归属
            <select
              aria-label="组件归属"
              value={draft.ownerId ?? ''}
              onChange={(e) => setDraft({ ...draft, ownerId: e.target.value || null })}
            >
              <option value="">当前画板（顶层组件）</option>
              {graph.components
                .filter((c) => c.id !== draft.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {(['inputs', 'outputs'] as const).map((side) => (
          <fieldset className="diagram-ports-editor" key={side}>
            <legend>
              {side === 'inputs' ? '输入' : '输出'} <span>{draft[side].length} / 32</span>
            </legend>
            {draft[side].map((p, index) => (
              <div className="diagram-port-edit" key={p.id}>
                <div className="diagram-form-row">
                  <label>
                    名称
                    <input
                      aria-label={`${side === 'inputs' ? '输入' : '输出'} ${index + 1} 名称`}
                      required
                      maxLength={80}
                      value={p.name}
                      onChange={(e) =>
                        updatePorts(
                          side,
                          draft[side].map((v) =>
                            v.id === p.id ? { ...v, name: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    数据类型
                    <input
                      aria-label={`${side === 'inputs' ? '输入' : '输出'} ${index + 1} 数据类型`}
                      maxLength={120}
                      placeholder="object / string / User…"
                      value={p.dataType}
                      onChange={(e) =>
                        updatePorts(
                          side,
                          draft[side].map((v) =>
                            v.id === p.id ? { ...v, dataType: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除${side === 'inputs' ? '输入' : '输出'} ${index + 1}`}
                    onClick={() =>
                      updatePorts(
                        side,
                        draft[side].filter((v) => v.id !== p.id),
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <input
                  aria-label={`${side === 'inputs' ? '输入' : '输出'} ${index + 1} 说明`}
                  maxLength={10000}
                  placeholder="字段结构、含义或约束（选填）"
                  value={p.description}
                  onChange={(e) =>
                    updatePorts(
                      side,
                      draft[side].map((v) =>
                        v.id === p.id ? { ...v, description: e.target.value } : v,
                      ),
                    )
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="button text compact"
              disabled={draft[side].length >= 32}
              onClick={() =>
                updatePorts(side, [...draft[side], newPort(side === 'inputs' ? '输入' : '输出')])
              }
            >
              <Plus size={13} />
              添加{side === 'inputs' ? '输入' : '输出'}
            </button>
          </fieldset>
        ))}
        <p className="diagram-id">稳定 ID · {draft.id}</p>
        {removedConnections > 0 && (
          <p className="form-warning">
            保存后将移除已删除端口上的 {removedConnections} 条连接，可在画板中撤销。
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="button text" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary">
            {submitLabel ?? '保存组件'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConnectionEditor({
  connection,
  graph,
  onSave,
  onClose,
}: {
  connection: DiagramConnection
  graph: Diagram
  onSave: (connection: DiagramConnection) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(connection)
  const [error, setError] = useState('')
  const existing = graph.connections.some((e) => e.id === draft.id)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      ...graph,
      connections: existing
        ? graph.connections.map((e) => (e.id === draft.id ? draft : e))
        : [...graph.connections, draft],
    }
    const error = validationError(next)
    if (error) {
      setError(error)
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }
  return (
    <Modal title={existing ? '编辑连接' : '添加连接'} onClose={onClose}>
      <p className="modal-description">
        箭头由起点指向终点。数据流连接输出与输入，其他关系可直接连接组件。
      </p>
      <form className="diagram-form" onSubmit={submit}>
        <div className="diagram-form-row">
          <label>
            名称
            <input
              aria-label="连接名称"
              required
              maxLength={80}
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            关系类型
            <select
              aria-label="连接类型"
              value={draft.type}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  type: e.target.value as ConnectionType,
                  sourcePortId: null,
                  targetPortId: null,
                })
              }
            >
              {Object.entries(connectionTypes).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="type-description">{connectionDescriptions[draft.type]}</p>
        {(['source', 'target'] as const).map((side, i) => {
          const source = side === 'source',
            componentId = source ? draft.sourceId : draft.targetId
          const ports =
            graph.components.find((c) => c.id === componentId)?.[source ? 'outputs' : 'inputs'] ??
            []
          return (
            <div key={side}>
              {i > 0 && (
                <div className="diagram-connection-arrow">
                  <ArrowDown size={16} />
                </div>
              )}
              <div className="diagram-form-row">
                <label>
                  {source ? '起点组件' : '终点组件'}
                  <select
                    aria-label={source ? '起点组件' : '终点组件'}
                    value={componentId}
                    onChange={(e) => {
                      const c = graph.components.find((c) => c.id === e.target.value)!
                      setDraft(
                        source
                          ? { ...draft, sourceId: c.id, sourcePortId: c.outputs[0]?.id ?? null }
                          : { ...draft, targetId: c.id, targetPortId: c.inputs[0]?.id ?? null },
                      )
                    }}
                  >
                    {graph.components.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {source ? '输出端口' : '输入端口'}
                  <select
                    aria-label={source ? '输出端口' : '输入端口'}
                    value={(source ? draft.sourcePortId : draft.targetPortId) ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [source ? 'sourcePortId' : 'targetPortId']: e.target.value || null,
                      })
                    }
                  >
                    <option value="">组件整体</option>
                    {ports.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.dataType || '未指定类型'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          )
        })}
        <label>
          传输方式 / 协议
          <input
            aria-label="传输方式"
            maxLength={120}
            placeholder="如 HTTPS / POST、SQL、函数调用"
            value={draft.protocol}
            onChange={(e) => setDraft({ ...draft, protocol: e.target.value })}
          />
        </label>
        <label>
          触发条件
          <input
            aria-label="触发条件"
            maxLength={1000}
            placeholder="如校验成功、订单已支付"
            value={draft.condition}
            onChange={(e) => setDraft({ ...draft, condition: e.target.value })}
          />
        </label>
        <label>
          说明
          <textarea
            aria-label="连接说明"
            maxLength={10000}
            rows={3}
            placeholder="数据含义、字段映射、依赖原因或异常处理"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
        <p className="diagram-id">稳定 ID · {draft.id}</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button type="button" className="button text" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary">
            保存连接
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function DiagramJsonEditor({
  graph,
  onImport,
  onClose,
  onNotify,
  readOnly = false,
}: {
  graph: Diagram
  readOnly?: boolean
  onImport: (graph: Diagram) => void
  onClose: () => void
  onNotify: (message: string) => void
}) {
  const [text, setText] = useState(JSON.stringify(graph, null, 2)),
    [error, setError] = useState('')
  return (
    <Modal title="系统图 JSON" onClose={onClose} wide>
      <p className="modal-description">
        {readOnly
          ? '当前视图只读，可以复制 JSON。切换到本次迭代后可导入修改。'
          : '复制结构化数据用于备份；导入时替换当前可编辑内容，保留现状基线与历史版本。操作可以撤销。'}
      </p>
      <textarea
        className="diagram-json"
        aria-label="系统图 JSON"
        spellCheck={false}
        readOnly={readOnly}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button
          className="button secondary"
          onClick={() =>
            void copyText(text)
              .then(() => onNotify('系统图 JSON 已复制'))
              .catch(() => setError('复制失败，请手动选择并复制文本'))
          }
        >
          <Copy size={14} />
          复制 JSON
        </button>
        <button
          className="button primary"
          disabled={readOnly}
          onClick={() => {
            try {
              if (text.length > 16 * 1024 * 1024) throw new Error('系统图 JSON 超过 16 MiB 限制')
              const parsed = diagramSchema.safeParse(JSON.parse(text))
              if (!parsed.success) {
                setError(parsed.error.issues[0].message)
                return
              }
              onImport(parsed.data)
            } catch (e) {
              setError(e instanceof Error ? e.message : 'JSON 格式无效')
            }
          }}
        >
          校验并替换画板
        </button>
      </div>
    </Modal>
  )
}
