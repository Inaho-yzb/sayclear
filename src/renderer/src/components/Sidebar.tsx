import { useRef, useEffect, useState } from 'react'
import {
  Plus,
  Search,
  FolderOpen,
  CircleHelp,
  ChevronDown,
  ChevronRight,
  Boxes,
  Layers,
  Box,
  Trash2,
  Settings,
  GitBranch,
} from 'lucide-react'
import { flattenArchitecture, scopeTitles, type Workspace } from '../../../shared/model'
import { compositionChanges } from '../../../shared/composition'
import { referenceBoards, incomingReferences } from '../../../shared/diagram-references'
import { Brand } from './Brand'

interface Props {
  workspace: Workspace
  hidden: boolean
  onSettings: () => void
  iterationsOpen: boolean
  onIterations: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onHelp: () => void
  onDelete: (systemId: string) => void
  deleteDisabled: boolean
}
export function Sidebar({
  workspace,
  hidden,
  onSettings,
  iterationsOpen,
  onIterations,
  onSelect,
  onNew,
  onHelp,
  onDelete,
  deleteDisabled,
}: Props) {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const settingsRef = useRef<HTMLButtonElement>(null)
  const wasHidden = useRef(hidden)
  useEffect(() => {
    if (!hidden && wasHidden.current) settingsRef.current?.focus()
    wasHidden.current = hidden
  }, [hidden])
  useEffect(() => {
    if (hidden) return
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hidden])
  const changes = compositionChanges(workspace)
  const boards = referenceBoards(workspace)
  const query = search.trim().toLocaleLowerCase()
  const rows = workspace.systems.flatMap((system) => {
    const nodes = flattenArchitecture(system.architecture)
    const matches = new Set<string>()
    for (const node of nodes) {
      if (node.name.toLocaleLowerCase().includes(query)) {
        matches.add(node.id)
        let parentId = node.parentId
        while (parentId) {
          matches.add(parentId)
          parentId = nodes.find((item) => item.id === parentId)?.parentId ?? null
        }
      }
    }
    return nodes
      .filter((node) => {
        if (query) return matches.has(node.id)
        let parentId = node.parentId
        while (parentId) {
          if (collapsed.has(parentId)) return false
          parentId = nodes.find((item) => item.id === parentId)?.parentId ?? null
        }
        return true
      })
      .map((node) => ({
        ...node,
        hasChildren: nodes.some((item) => item.parentId === node.id),
        childCount: nodes.filter((item) => item.parentId === node.id).length,
        content: system.contents.find((item) => item.id === node.id)!,
      }))
  })
  return (
    <aside className="sidebar" hidden={hidden}>
      <div className="sidebar-brand">
        <Brand />
        <div>
          <strong>
            说清楚<span className="brand-dot">.</span>
          </strong>
          <span className="brand-english">SAY CLEAR</span>
        </div>
      </div>
      <button className="new-project" onClick={onNew}>
        <Plus size={18} />
        <span>创建应用系统</span>
      </button>
      <button
        className={`settings-button iteration-nav ${iterationsOpen ? 'active' : ''}`}
        aria-current={iterationsOpen ? 'page' : undefined}
        onClick={onIterations}
      >
        <GitBranch size={17} />
        <span>迭代管理</span>
        <span className="iteration-nav-count">
          {boards.filter((board) => board.diagram.iteration).length}
        </span>
      </button>
      <label className="search-field">
        <Search size={15} />
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索应用或画板"
          aria-label="搜索应用、聚合图、原子图"
        />
        <kbd>⌘ K</kbd>
      </label>
      <div className="sidebar-label">
        <span>系统组成</span>
        <span>{workspace.systems.length.toString().padStart(2, '0')}</span>
      </div>
      <nav className="project-list" aria-label="画板组成树">
        {rows.map((node) => {
          const Icon = ['system', 'application'].includes(node.type)
            ? Boxes
            : node.type === 'aggregate'
              ? Layers
              : Box
          return (
            <div
              className="tree-row"
              key={node.id}
              data-board-id={node.id}
              style={{ paddingLeft: Math.min(node.depth * 12, 72) }}
            >
              {node.hasChildren ? (
                <button
                  className="tree-toggle"
                  aria-label={`${collapsed.has(node.id) ? '展开' : '收起'}${node.name}`}
                  aria-expanded={query ? true : !collapsed.has(node.id)}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (next.has(node.id)) next.delete(node.id)
                      else next.add(node.id)
                      return next
                    })
                  }
                >
                  {collapsed.has(node.id) && !query ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
              ) : (
                <span className="tree-toggle" />
              )}
              <button
                className={`project-item ${!iterationsOpen && workspace.activeNodeId === node.id ? 'active' : ''}`}
                onClick={() => onSelect(node.id)}
                aria-current={
                  !iterationsOpen && workspace.activeNodeId === node.id ? 'page' : undefined
                }
                title={node.name}
              >
                <Icon size={15} />
                <span>
                  <strong>{node.name}</strong>
                  <small>
                    {scopeTitles[node.type]}
                    {node.childCount ? ` · ${node.childCount} 张子图` : ''}
                    {incomingReferences(boards, node.id).length > 0 && ' · 被引用'}
                  </small>
                  {(changes.get(node.id)?.own || !!changes.get(node.id)?.descendants) && (
                    <small className="tree-change-status">
                      {changes.get(node.id)?.own ? '本图有变更' : ''}
                      {changes.get(node.id)?.own && changes.get(node.id)?.descendants ? ' · ' : ''}
                      {changes.get(node.id)?.descendants
                        ? `下级 ${changes.get(node.id)!.descendants} 张图有变更`
                        : ''}
                    </small>
                  )}
                </span>
              </button>
              {node.parentId === null && (
                <button
                  className="icon-button delete-system-button"
                  title={`删除应用系统 ${node.name}`}
                  aria-label={`删除应用系统 ${node.name}`}
                  disabled={deleteDisabled}
                  onClick={() => onDelete(node.id)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )
        })}
        {rows.length === 0 && (
          <div className="search-empty">
            <FolderOpen size={22} />
            <p>{workspace.systems.length === 0 ? '还没有应用系统' : '没有找到匹配的结构'}</p>
          </div>
        )}
      </nav>
      <div className="sidebar-bottom">
        <button ref={settingsRef} className="settings-button" onClick={onSettings}>
          <Settings size={17} />
          <span>设置</span>
          <ChevronRight size={14} />
        </button>
        <button className="help-button" onClick={onHelp}>
          <CircleHelp size={17} />
          <span>使用指南</span>
          <span className="version">v0.1</span>
        </button>
        <div className="local-label">
          <span />
          本地工作空间
        </div>
      </div>
    </aside>
  )
}
