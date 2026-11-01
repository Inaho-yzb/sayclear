import { defaultComponentCatalog, parseCatalogDiagram } from './component-catalog'
import { emptyDiagram } from './diagram'
import { type Board } from './diagram-references'
import {
  discardIteration,
  iterationChanges,
  publishIteration,
  renameIteration,
  startIteration,
} from './iteration'
import { flattenArchitecture, getProject, updateNodeContent, type Workspace } from './model'

export type IterationBoard = Board & { systemId: string; systemName: string }

// Include empty boards, but not content detached from the architecture.
export function iterationBoards(workspace: Workspace): IterationBoard[] {
  return workspace.systems.flatMap((system) => {
    const nodes = flattenArchitecture(system.architecture)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const contents = new Map(system.contents.map((content) => [content.id, content]))
    return nodes.map((node) => {
      const ancestors = [node]
      while (ancestors[0].parentId) ancestors.unshift(byId.get(ancestors[0].parentId)!)
      return {
        id: node.id,
        name: node.name,
        path: ancestors.map((item) => item.name).join(' / '),
        systemId: system.architecture.id,
        systemName: system.architecture.name,
        diagram: contents.get(node.id)?.diagram ?? emptyDiagram(),
      }
    })
  })
}

export type IterationAction = { boardId: string } & (
  | { type: 'start'; name: string }
  | { type: 'rename'; iterationId: string; name: string }
  | { type: 'publish' | 'discard'; iterationId: string }
)

export function manageIteration(workspace: Workspace, action: IterationAction): Workspace {
  const project = getProject(workspace, action.boardId)
  const diagram = project.diagram ?? emptyDiagram()
  if (action.type !== 'start' && diagram.iteration?.id !== action.iterationId)
    throw new Error('该迭代已结束或发生变化，请重新选择')
  if (
    action.type === 'publish' &&
    !iterationChanges(diagram).some((change) => change.status !== 'unchanged')
  )
    throw new Error('还没有业务变更，请先编辑画板')
  const next =
    action.type === 'start'
      ? startIteration(diagram, action.name)
      : action.type === 'rename'
        ? renameIteration(diagram, action.name)
        : action.type === 'publish'
          ? publishIteration(diagram)
          : discardIteration(diagram)
  const parsed = parseCatalogDiagram(next, workspace.componentCatalog ?? defaultComponentCatalog)
  return updateNodeContent(workspace, action.boardId, (current) => ({
    ...current,
    diagram: parsed,
    updatedAt: new Date().toISOString(),
  }))
}
