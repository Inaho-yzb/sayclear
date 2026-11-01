import { useState } from 'react'
import { Code2, Plus, Trash2 } from 'lucide-react'
import {
  architectureSchema,
  createArchitecture,
  flattenArchitecture,
  scopeTitles,
  type Architecture,
  type BoardNode,
} from '../../../shared/model'
import { Modal } from './Modal'

export function ArchitectureEditor({
  architecture,
  onSave,
  onClose,
}: {
  architecture?: Architecture
  onSave: (architecture: Architecture) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Architecture>(() =>
    architecture ? structuredClone(architecture) : createArchitecture(),
  )
  const [showJson, setShowJson] = useState(false)
  const [error, setError] = useState('')
  const nodes = flattenArchitecture(draft)
  const removed =
    architecture?.boards.filter((n) => !draft.boards.some((b) => b.id === n.id)).length ?? 0
  const patch = (id: string, update: Partial<BoardNode>) =>
    setDraft((current) => ({
      ...current,
      boards: current.boards.map((n) => (n.id === id ? { ...n, ...update } : n)),
    }))
  const add = (parentId: string) =>
    setDraft((current) => ({
      ...current,
      boards: [
        ...current.boards,
        { id: crypto.randomUUID(), name: '', description: '', kind: 'atomic', parentId },
      ],
    }))
  const remove = (id: string) => {
    const ids = new Set([id])
    for (let i = 0; i < draft.boards.length; i++)
      for (const node of draft.boards) if (ids.has(node.parentId)) ids.add(node.id)
    setDraft({ ...draft, boards: draft.boards.filter((n) => !ids.has(n.id)) })
  }
  return (
    <Modal title={architecture ? '编辑画板结构' : '创建应用系统'} onClose={onClose} wide>
      <p className="modal-description">
        每个节点都是一张画板。聚合图可以继续包含下级图；应用用于划分业务边界，系统总图可以组合多个应用。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const result = architectureSchema.safeParse({
            ...draft,
            updatedAt: new Date().toISOString(),
          })
          if (!result.success) {
            setError(result.error.issues[0].message)
            return
          }
          try {
            onSave(result.data)
          } catch (e) {
            setError(e instanceof Error ? e.message : '结构保存失败')
          }
        }}
      >
        <div className="architecture-fields">
          <label className="form-field">
            应用系统名称
            <input
              autoFocus
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例如：用户应用"
            />
          </label>
          <label className="form-field">
            根图类型
            <select
              aria-label="根图类型"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as Architecture['kind'] })}
            >
              <option value="application">应用</option>
              <option value="system">系统总图（组合多个应用）</option>
            </select>
          </label>
          <label className="form-field">
            系统说明
            <textarea
              rows={2}
              maxLength={10000}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
        </div>
        <div className="architecture-section-heading">
          <strong>画板组成</strong>
          <span>{draft.boards.length} 张下级图</span>
        </div>
        {draft.boards.map((node, index) => (
          <fieldset className="subsystem-editor" key={node.id}>
            <legend>
              {index + 1} · {scopeTitles[node.kind]}
            </legend>
            <div className="structure-row">
              <label className="form-field">
                画板名称
                <input
                  required
                  aria-label={`画板 ${index + 1} 名称`}
                  value={node.name}
                  maxLength={80}
                  onChange={(e) => patch(node.id, { name: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`移除画板 ${index + 1}`}
                onClick={() => remove(node.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="composition-edit-row">
              <label className="form-field">
                类型
                <select
                  aria-label={`画板 ${index + 1} 类型`}
                  value={node.kind}
                  onChange={(e) => patch(node.id, { kind: e.target.value as BoardNode['kind'] })}
                >
                  <option value="atomic">原子图</option>
                  <option value="aggregate">聚合图</option>
                  <option value="application">应用</option>
                </select>
              </label>
              <label className="form-field">
                归属
                <select
                  aria-label={`画板 ${index + 1} 归属`}
                  value={node.parentId}
                  onChange={(e) => patch(node.id, { parentId: e.target.value })}
                >
                  {nodes
                    .filter((n) => n.id !== node.id && n.type !== 'atomic')
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {'　'.repeat(Math.min(n.depth, 6))}
                        {n.name || '未命名'}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="form-field">
              职责说明
              <textarea
                rows={2}
                maxLength={10000}
                value={node.description}
                onChange={(e) => patch(node.id, { description: e.target.value })}
              />
            </label>
            {node.kind !== 'atomic' && (
              <button className="button text" type="button" onClick={() => add(node.id)}>
                <Plus size={14} />
                添加子图
              </button>
            )}
          </fieldset>
        ))}
        <button
          className="button text"
          type="button"
          disabled={draft.boards.length >= 2000}
          onClick={() => add(draft.id)}
        >
          <Plus size={15} />
          添加画板
        </button>
        <div className="architecture-preview">
          <button
            className="button text"
            type="button"
            aria-expanded={showJson}
            onClick={() => setShowJson(!showJson)}
          >
            <Code2 size={15} />
            {showJson ? '收起架构 JSON' : '查看架构 JSON'}
          </button>
          {showJson && (
            <pre className="markdown-source" aria-label="架构 JSON">
              {JSON.stringify(draft, null, 2)}
            </pre>
          )}
        </div>
        {removed > 0 && (
          <p className="form-warning">
            将移除 {removed}{' '}
            张图的归属，已保存的画板与历史内容会保留。其他画板中的引用将提示来源失效。
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button className="button text" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit">
            {architecture ? '保存画板结构' : '创建应用系统'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
