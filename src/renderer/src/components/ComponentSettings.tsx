import { useState, type FormEvent } from 'react'
import { Boxes, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  componentTypes,
  componentDescriptions,
  emptyDiagram,
  newPort,
  type ComponentType,
} from '../../../shared/diagram'
import {
  componentCatalogSchema,
  instantiateTemplate,
  type ComponentCatalog,
  type ComponentScenario,
  type ComponentTemplate,
  type MetadataField,
} from '../../../shared/component-catalog'
import { ComponentEditor } from './DiagramEditors'
import { componentIcons } from './component-icons'
import { Modal } from './Modal'

interface Props {
  catalog: ComponentCatalog
  onSave: (catalog: ComponentCatalog) => Promise<void>
}
const errorText = (error: unknown) => {
  if (error && typeof error === 'object' && 'issues' in error)
    return (error.issues as { message: string }[])[0].message
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '保存失败，请重试'
}

export function ComponentSettings({ catalog, onSave }: Props) {
  const [selectedId, setSelectedId] = useState('general')
  const scene = catalog.scenarios.find((s) => s.id === selectedId) ?? catalog.scenarios[0]
  const [scenarioDraft, setScenarioDraft] = useState<ComponentScenario | null>(null)
  const [templateDraft, setTemplateDraft] = useState<ComponentTemplate | null>(null)
  const [deleting, setDeleting] = useState<{
    kind: 'scene' | 'template'
    id: string
    name: string
  } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async (next: ComponentCatalog) => {
    setSaving(true)
    try {
      await onSave(componentCatalogSchema.parse(next))
      setError('')
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <div className="catalog-heading">
        <div>
          <h2>场景组件库</h2>
          <p>用 12 种基础类型描述 Web 应用，再通过模板定义业务属性。</p>
        </div>
        <button
          className="button secondary compact"
          disabled={catalog.scenarios.length >= 50}
          onClick={() =>
            setScenarioDraft({ id: crypto.randomUUID(), name: '', description: '', components: [] })
          }
        >
          <Plus size={14} />
          新建场景
        </button>
      </div>
      <div className="catalog-layout">
        <nav className="catalog-scenes" aria-label="组件场景">
          {catalog.scenarios.map((s) => (
            <button
              key={s.id}
              className={s.id === scene.id ? 'active' : ''}
              aria-current={s.id === scene.id ? 'true' : undefined}
              onClick={() => {
                setSelectedId(s.id)
                setError('')
              }}
            >
              <Boxes size={16} />
              <span>
                {s.name}
                <small>{s.components.length} 个组件</small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
        <section className="catalog-panel" aria-label={`${scene.name} 组件配置`}>
          <div className="catalog-heading">
            <div>
              <h3>{scene.name}</h3>
              <p>{scene.description || '为这个场景定义可使用的组件与属性。'}</p>
            </div>
            <div className="catalog-actions">
              <button
                className="icon-button"
                aria-label="编辑场景"
                onClick={() => setScenarioDraft(scene)}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="删除场景"
                disabled={scene.id === 'general'}
                title={scene.id === 'general' ? '保留 Web 应用默认场景' : '删除场景'}
                onClick={() => {
                  setError('')
                  setDeleting({ kind: 'scene', id: scene.id, name: scene.name })
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
          <div className="catalog-template-list">
            {scene.components.map((template) => {
              const Icon = componentIcons[template.type]
              return (
                <article className="catalog-template" key={template.id}>
                  <span className="catalog-template-icon">
                    <Icon size={19} />
                  </span>
                  <div>
                    <h4>
                      {template.name}
                      <small>{componentTypes[template.type]}</small>
                    </h4>
                    <p>{template.description || '尚未添加说明'}</p>
                    <span>
                      {template.inputs.length} 输入 · {template.outputs.length} 输出 ·{' '}
                      {template.fields.length} 自定义属性
                    </span>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`编辑组件模板 ${template.name}`}
                    onClick={() => setTemplateDraft(template)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除组件模板 ${template.name}`}
                    onClick={() => {
                      setError('')
                      setDeleting({ kind: 'template', id: template.id, name: template.name })
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </article>
              )
            })}
            {!scene.components.length && (
              <div className="catalog-empty">
                <Boxes size={28} />
                <h4>还没有可用组件</h4>
                <p>添加组件模板后，就可以在此场景的画板中使用。</p>
              </div>
            )}
          </div>
          <button
            className="button secondary catalog-add"
            disabled={scene.components.length >= 100}
            onClick={() =>
              setTemplateDraft({
                id: crypto.randomUUID(),
                name: '',
                type: 'action',
                description: '',
                inputs: [newPort('输入')],
                outputs: [newPort('输出')],
                fields: [],
              })
            }
          >
            <Plus size={15} />
            添加组件模板
          </button>
        </section>
      </div>
      <p className="catalog-note">
        模板中的说明和端口用于新组件的初始值；自定义属性规定名称、类型、必填项与默认值。正在被画板使用的场景和组件不能删除。
      </p>
      {scenarioDraft && (
        <ScenarioEditor
          scenario={scenarioDraft}
          onClose={() => setScenarioDraft(null)}
          onSave={async (next) => {
            await save({
              scenarios: catalog.scenarios.some((s) => s.id === next.id)
                ? catalog.scenarios.map((s) => (s.id === next.id ? next : s))
                : [...catalog.scenarios, next],
            })
            setSelectedId(next.id)
            setScenarioDraft(null)
          }}
        />
      )}
      {templateDraft && (
        <TemplateEditor
          template={templateDraft}
          onClose={() => setTemplateDraft(null)}
          onSave={async (next) => {
            await save({
              scenarios: catalog.scenarios.map((s) =>
                s.id === scene.id
                  ? {
                      ...s,
                      components: s.components.some((t) => t.id === next.id)
                        ? s.components.map((t) => (t.id === next.id ? next : t))
                        : [...s.components, next],
                    }
                  : s,
              ),
            })
            setTemplateDraft(null)
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`删除${deleting.kind === 'scene' ? '场景' : '组件模板'}`}
          onClose={() => setDeleting(null)}
          busy={saving}
        >
          <p className="modal-description">
            确认删除「{deleting.name}」？如果已有画板使用此配置，将保留配置并提示原因。
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-footer" inert={saving}>
            <button className="button text" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={async () => {
                try {
                  await save({
                    scenarios:
                      deleting.kind === 'scene'
                        ? catalog.scenarios.filter((s) => s.id !== deleting.id)
                        : catalog.scenarios.map((s) => ({
                            ...s,
                            components: s.components.filter((t) => t.id !== deleting.id),
                          })),
                  })
                  setDeleting(null)
                } catch (e) {
                  setError(errorText(e))
                }
              }}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function ScenarioEditor({
  scenario,
  onSave,
  onClose,
}: {
  scenario: ComponentScenario
  onSave: (s: ComponentScenario) => Promise<void>
  onClose: () => void
}) {
  const [draft, setDraft] = useState(scenario)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <Modal title={scenario.name ? '编辑场景' : '新建场景'} onClose={onClose} busy={saving}>
      <form
        className="diagram-form"
        inert={saving}
        aria-busy={saving}
        onSubmit={async (e: FormEvent) => {
          e.preventDefault()
          if (saving) return
          setSaving(true)
          try {
            await onSave(draft)
          } catch (e) {
            setError(errorText(e))
          } finally {
            setSaving(false)
          }
        }}
      >
        <label>
          场景名称
          <input
            autoFocus
            required
            maxLength={80}
            aria-label="场景名称"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="例如：业务流程、数据架构"
          />
        </label>
        <label>
          场景说明
          <textarea
            rows={3}
            maxLength={10000}
            aria-label="场景说明"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
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
            保存场景
          </button>
        </div>
      </form>
    </Modal>
  )
}

function TemplateEditor({
  template,
  onSave,
  onClose,
}: {
  template: ComponentTemplate
  onSave: (t: ComponentTemplate) => Promise<void>
  onClose: () => void
}) {
  const [type, setType] = useState(template.type)
  const [fields, setFields] = useState(template.fields)
  const [component] = useState(() => ({
    ...instantiateTemplate(template),
    id: template.id,
    inputs: template.inputs,
    outputs: template.outputs,
  }))
  const update = (id: string, patch: Partial<MetadataField>) =>
    setFields(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  return (
    <ComponentEditor
      component={component}
      graph={emptyDiagram()}
      onClose={onClose}
      title="组件元数据"
      submitLabel="保存组件模板"
      templateMode
      onSave={(c) =>
        onSave({
          id: template.id,
          name: c.name,
          type,
          description: c.description,
          inputs: c.inputs,
          outputs: c.outputs,
          fields,
        })
      }
      extraFields={
        <>
          <label>
            基础类型
            <select
              aria-label="模板基础类型"
              value={type}
              onChange={(e) => setType(e.target.value as ComponentType)}
            >
              {Object.entries(componentTypes).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="type-description">{componentDescriptions[type]}</p>
          <fieldset className="diagram-ports-editor">
            <legend>
              自定义属性 <span>{fields.length} / 32</span>
            </legend>
            {fields.map((f, i) => (
              <div className="catalog-field" key={f.id}>
                <div className="diagram-form-row">
                  <label>
                    属性名称
                    <input
                      required
                      maxLength={80}
                      aria-label={`属性 ${i + 1} 名称`}
                      value={f.name}
                      onChange={(e) => update(f.id, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    属性类型
                    <select
                      aria-label={`属性 ${i + 1} 类型`}
                      value={f.type}
                      onChange={(e) =>
                        update(f.id, {
                          type: e.target.value as MetadataField['type'],
                          defaultValue: '',
                        })
                      }
                    >
                      <option value="text">文本</option>
                      <option value="number">数字</option>
                      <option value="boolean">是 / 否</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除属性 ${i + 1}`}
                    onClick={() => setFields(fields.filter((v) => v.id !== f.id))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="diagram-form-row">
                  <label>
                    默认值
                    {f.type === 'boolean' ? (
                      <select
                        aria-label={`属性 ${i + 1} 默认值`}
                        value={f.defaultValue}
                        onChange={(e) => update(f.id, { defaultValue: e.target.value })}
                      >
                        <option value="">未设置</option>
                        <option value="true">是</option>
                        <option value="false">否</option>
                      </select>
                    ) : (
                      <input
                        aria-label={`属性 ${i + 1} 默认值`}
                        type={f.type === 'number' ? 'number' : 'text'}
                        step="any"
                        maxLength={10000}
                        value={f.defaultValue}
                        onChange={(e) => update(f.id, { defaultValue: e.target.value })}
                      />
                    )}
                  </label>
                  <label className="catalog-checkbox">
                    <input
                      type="checkbox"
                      aria-label={`属性 ${i + 1} 必填`}
                      checked={f.required}
                      onChange={(e) => update(f.id, { required: e.target.checked })}
                    />
                    必填
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="button text compact"
              disabled={fields.length >= 32}
              onClick={() =>
                setFields([
                  ...fields,
                  {
                    id: crypto.randomUUID(),
                    name: '',
                    type: 'text',
                    required: false,
                    defaultValue: '',
                  },
                ])
              }
            >
              <Plus size={13} />
              添加属性
            </button>
          </fieldset>
        </>
      }
    />
  )
}
