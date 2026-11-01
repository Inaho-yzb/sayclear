import { useState } from 'react'
import { Check, ChevronRight, Code2, Copy, Download, FileText, PencilLine, X } from 'lucide-react'
import { sectionTitles, type Project, type Section, type SectionId } from '../../../shared/model'
import { toMarkdown } from '../../../shared/document'
import { copyText } from '../services/desktop'

interface Props {
  project: Project
  activeSection: SectionId
  onSectionChange: (id: SectionId) => void
  onEdit: (id: SectionId, content: string) => void
  onConfirm: (id: SectionId) => void
  onExport: () => void
  onNotify: (text: string) => void
}

function DocumentSection({
  section,
  index,
  active,
  onSelect,
  onEdit,
  onConfirm,
}: {
  section: Section
  index: number
  active: boolean
  onSelect: () => void
  onEdit: (content: string) => void
  onConfirm: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(section.content)
  return (
    <section
      className={`document-section ${active ? 'selected' : ''}`}
      id={`section-${section.id}`}
    >
      <div className="section-heading">
        <button className="section-title" onClick={onSelect}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <h3>{sectionTitles[section.id]}</h3>
        </button>
        <div className="section-controls">
          <button
            className={`section-status ${section.confirmed ? 'confirmed' : ''}`}
            disabled={!section.content.trim() || editing}
            onClick={onConfirm}
            title={section.confirmed ? '取消本章节确认' : '确认本章节需求'}
            aria-label={`${section.confirmed ? '取消确认' : '确认'}${sectionTitles[section.id]}`}
          >
            {section.confirmed ? (
              <>
                <Check size={11} />
                已确认
              </>
            ) : (
              <>
                <span />
                待确认
              </>
            )}
          </button>
          <button
            className="icon-button edit-button"
            title="编辑章节"
            aria-label={`编辑${sectionTitles[section.id]}`}
            onClick={() => {
              setValue(section.content)
              setEditing(true)
              onSelect()
            }}
          >
            <PencilLine size={14} />
          </button>
        </div>
      </div>
      {editing ? (
        <div className="section-editor">
          <textarea
            autoFocus
            aria-label={`${sectionTitles[section.id]}内容`}
            value={value}
            maxLength={100000}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false)
            }}
          />
          <div>
            <button className="button text compact" onClick={() => setEditing(false)}>
              <X size={13} />
              取消
            </button>
            <button
              className="button primary compact"
              onClick={() => {
                onEdit(value.trim())
                setEditing(false)
              }}
            >
              <Check size={13} />
              保存修改
            </button>
          </div>
        </div>
      ) : section.content ? (
        <div className={`section-content ${section.id === 'features' ? 'feature-list' : ''}`}>
          {section.content
            .split('\n')
            .filter(Boolean)
            .map((line, i) => (
              <p key={i}>
                {section.id === 'features' && <span className="feature-bullet" />}
                {line}
              </p>
            ))}
        </div>
      ) : (
        <button
          className="empty-section"
          onClick={() => {
            setValue('')
            setEditing(true)
            onSelect()
          }}
        >
          <PencilLine size={14} />
          补充这一部分，让需求更完整
          <ChevronRight size={14} />
        </button>
      )}
    </section>
  )
}

export function DocumentPanel({
  project,
  activeSection,
  onSectionChange,
  onEdit,
  onConfirm,
  onExport,
  onNotify,
}: Props) {
  const [sourceView, setSourceView] = useState(false)
  const confirmed = project.sections.filter((section) => section.confirmed).length
  const markdown = toMarkdown(project)
  const select = (id: SectionId) => {
    onSectionChange(id)
    document
      .getElementById(`section-${id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  return (
    <section className="document-panel" aria-label="需求文档">
      <div className="panel-heading">
        <span>
          <FileText size={16} />
          需求文档<span className="draft-badge">{confirmed === 5 ? '已确认' : '草稿'}</span>
        </span>
        <div className="view-controls">
          <button
            className={!sourceView ? 'active' : ''}
            title="文档视图"
            aria-label="文档视图"
            aria-pressed={!sourceView}
            onClick={() => setSourceView(false)}
          >
            <FileText size={15} />
          </button>
          <button
            className={sourceView ? 'active' : ''}
            title="Markdown 源码"
            aria-label="Markdown 源码"
            aria-pressed={sourceView}
            onClick={() => setSourceView(true)}
          >
            <Code2 size={16} />
          </button>
        </div>
      </div>
      <div className="document-progress">
        <div>
          <span>
            <span className="progress-dot" />
            让需求一步步落定
          </span>
          <strong>
            {confirmed}
            <span> / 5 章节已确认</span>
          </strong>
        </div>
        <div className="progress-track">
          <span style={{ width: `${confirmed * 20}%` }} />
        </div>
      </div>
      <div className="document-scroll">
        {sourceView ? (
          <pre className="markdown-source">{markdown}</pre>
        ) : (
          <div className="document-paper">
            <div className="paper-eyebrow">
              <span>PRODUCT REQUIREMENTS</span>
              <span>v0.{project.revision}</span>
            </div>
            <h2>{project.name}</h2>
            <p className="paper-subtitle">从想法到共识，一份持续生长的需求文档。</p>
            <div className="paper-divider" />
            {project.sections.map((section, index) => (
              <DocumentSection
                key={section.id}
                section={section}
                index={index}
                active={activeSection === section.id}
                onSelect={() => select(section.id)}
                onEdit={(content) => onEdit(section.id, content)}
                onConfirm={() => onConfirm(section.id)}
              />
            ))}
            <div className="paper-end">
              <span />
              把共识留下，把产品做好。
              <span />
            </div>
          </div>
        )}
      </div>
      <div className="document-footer">
        <button
          className="button text"
          onClick={() =>
            void copyText(markdown)
              .then(() => onNotify('已复制 Markdown 文档'))
              .catch(() => onNotify('复制失败，请使用导出文档'))
          }
        >
          <Copy size={14} />
          复制
        </button>
        <button className="button export-button" onClick={onExport}>
          <Download size={15} />
          导出文档
          <ChevronRight size={14} />
        </button>
      </div>
    </section>
  )
}
