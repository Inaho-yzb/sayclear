import { LoaderCircle, Trash2 } from 'lucide-react'
import type { SystemData } from '../../../shared/model'
import { Modal } from './Modal'

export function DeleteSystemDialog({
  system,
  referencedBy = [],
  deleting,
  error,
  onConfirm,
  onClose,
}: {
  system: SystemData
  referencedBy?: string[]
  deleting: boolean
  error: string
  onConfirm: () => void
  onClose: () => void
}) {
  const { architecture, contents } = system
  const diagrams = contents.flatMap((content) => (content.diagram ? [content.diagram] : []))
  const componentCount = diagrams.reduce((count, diagram) => count + diagram.components.length, 0)
  const connectionCount = diagrams.reduce((count, diagram) => count + diagram.connections.length, 0)
  return (
    <Modal
      title="删除应用系统"
      onClose={() => {
        if (!deleting) onClose()
      }}
    >
      <p className="modal-description delete-description">
        确认删除「<strong>{architecture.name}</strong>」？
      </p>
      <p className="delete-scope">
        包含 {architecture.boards.length} 张下级画板、{diagrams.length} 张系统图（{componentCount}{' '}
        个组件、{connectionCount} 条连接）。
      </p>
      <p className="form-warning">
        该系统的架构、系统图、历史节点内容及系统目录下的其他文件将一并删除，删除后无法在应用中撤销。
      </p>
      {referencedBy.length > 0 && (
        <p className="form-warning">
          以下画板仍在引用此系统，删除后将标记来源失效：{referencedBy.join('、')}。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <button className="button text" disabled={deleting} onClick={onClose}>
          取消
        </button>
        <button className="button danger" disabled={deleting} onClick={onConfirm}>
          {deleting ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
          {deleting ? '正在删除' : '确认删除'}
        </button>
      </div>
    </Modal>
  )
}
