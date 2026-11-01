import { useState } from 'react'
import { scopeTitles, type ScopeNode } from '../../../shared/model'
import { Modal } from './Modal'
export function CompositionDialog({
  mode,
  nodes,
  allowApplication,
  onSave,
  onClose,
}: {
  mode: 'add' | 'group'
  nodes: ScopeNode[]
  allowApplication: boolean
  onSave: (name: string, kind: 'atomic' | 'aggregate' | 'application', ids: string[]) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'atomic' | 'aggregate' | 'application'>('atomic')
  const [ids, setIds] = useState(nodes.map((n) => n.id))
  const [error, setError] = useState('')
  return (
    <Modal title={mode === 'group' ? '聚合子图' : '新建子图'} onClose={onClose}>
      <p className="modal-description">
        {mode === 'group'
          ? '选中的同级图将归属到新的聚合图。通过公开入口生成引用，已有业务连接与引用版本会保留。'
          : '新画板具有独立定义和公开入口，可被上级图和其他应用引用。'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          try {
            onSave(name, kind, ids)
          } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败')
          }
        }}
      >
        <label className="form-field">
          画板名称
          <input
            autoFocus
            required
            maxLength={80}
            aria-label="新画板名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {mode === 'add' ? (
          <label className="form-field">
            类型
            <select
              aria-label="新画板类型"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="atomic">原子图</option>
              <option value="aggregate">聚合图</option>
              {allowApplication && <option value="application">应用</option>}
            </select>
          </label>
        ) : (
          <fieldset className="reference-exports">
            <legend>选择同级画板</legend>
            {nodes.map((n) => (
              <label key={n.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(n.id)}
                  onChange={(e) =>
                    setIds(e.target.checked ? [...ids, n.id] : ids.filter((id) => id !== n.id))
                  }
                />
                <span>
                  {n.name} · {scopeTitles[n.type]}
                </span>
              </label>
            ))}
          </fieldset>
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
            {mode === 'group' ? '创建聚合图' : '创建画板'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
