import { emptyDiagram, type Diagram } from './diagram'
import { instantiateTemplate, defaultComponentCatalog } from './component-catalog'
import { createReference, exposedComponents, referenceBoards } from './diagram-references'
import { iterationChanges } from './iteration'
import {
  flattenArchitecture,
  saveArchitecture,
  updateNodeContent,
  workspaceSchema,
  type Workspace,
  type ScopeNode,
  type Architecture,
} from './model'

export function initializeBoards(workspace: Workspace): Workspace {
  if (
    workspace.systems.every((system) =>
      flattenArchitecture(system.architecture).every(
        (node) => system.contents.find((c) => c.id === node.id)?.diagram,
      ),
    )
  )
    return workspace
  const catalog = workspace.componentCatalog ?? defaultComponentCatalog
  const scene = catalog.scenarios.find((s) => s.components.some((c) => c.type === 'capability'))
  if (!scene) throw new Error('请先在组件设置中配置一个能力模板，用于画板的公开入口')
  const template = scene.components.find((c) => c.type === 'capability')!
  return workspaceSchema.parse({
    ...workspace,
    systems: workspace.systems.map((system) => {
      const nodes = flattenArchitecture(system.architecture)
      return {
        ...system,
        contents: system.contents.map((content) => {
          const node = nodes.find((n) => n.id === content.id)
          if (!node || content.diagram) return content
          const entry = {
            ...instantiateTemplate(template),
            id: 'board-entry',
            name: node.name,
            description: node.description,
            exposed: true,
          }
          return {
            ...content,
            diagram: { ...emptyDiagram(), scenarioId: scene.id, components: [entry] },
          }
        }),
      }
    }),
  })
}

export function addBoard(
  workspace: Workspace,
  parentId: string,
  name: string,
  kind: 'atomic' | 'aggregate' | 'application',
): Workspace {
  const system = workspace.systems.find((s) =>
    flattenArchitecture(s.architecture).some((n) => n.id === parentId),
  )
  if (!system) throw new Error('归属画板不存在')
  const parent = flattenArchitecture(system.architecture).find((n) => n.id === parentId)!
  if (parent.type === 'atomic') throw new Error('请先将原子图改为聚合图，再添加子图')
  const id = crypto.randomUUID()
  const next = initializeBoards(
    saveArchitecture(workspace, {
      ...system.architecture,
      updatedAt: new Date().toISOString(),
      boards: [...system.architecture.boards, { id, name, kind, parentId, description: '' }],
    }),
  )
  return { ...includeBoards(next, parentId, [id]), activeNodeId: id }
}

// Composition creates references only. Execution order must be specified by the author.
export function includeBoards(
  workspace: Workspace,
  targetId: string,
  childIds: string[],
): Workspace {
  const boards = referenceBoards(workspace)
  const target = boards.find((b) => b.id === targetId)
  if (!target) throw new Error('聚合画板不存在')
  let diagram: Diagram = structuredClone(target.diagram)
  for (const id of childIds) {
    if (diagram.components.some((c) => c.reference?.boardId === id)) continue
    const source = boards.find((b) => b.id === id)
    if (!source) continue
    const graph = source.diagram.iteration?.baseline ?? source.diagram
    const exposed = exposedComponents(graph)
    const entry =
      exposed.find((c) => c.id === 'board-entry') ??
      exposed.find((c) => c.type === 'capability') ??
      exposed[0]
    if (!entry)
      throw new Error(
        `画板「${source.name}」的现状尚无公开入口，请先开放入口；迭代入口可通过“引用画板”选择`,
      )
    const index = Math.max(0, diagram.components.length - 1)
    const ref = createReference(
      boards,
      targetId,
      { boardId: id, componentId: entry.id, version: 'current', outputIds: [] },
      { x: 80 + (index % 3) * 380, y: 360 + Math.floor(index / 3) * 280 },
    )
    diagram = { ...diagram, components: [...diagram.components, ref] }
  }
  return workspaceSchema.parse(
    updateNodeContent(workspace, targetId, (p) => ({
      ...p,
      diagram,
      updatedAt: new Date().toISOString(),
    })),
  )
}

export function aggregateBoards(
  workspace: Workspace,
  parentId: string,
  childIds: string[],
  name: string,
): Workspace {
  const system = workspace.systems.find((s) =>
    flattenArchitecture(s.architecture).some((n) => n.id === parentId),
  )
  if (!system) throw new Error('归属画板不存在')
  if (new Set(childIds).size !== childIds.length || childIds.length < 2)
    throw new Error('请选择至少两张不同的同级画板')
  if (
    childIds.some(
      (id) => !system.architecture.boards.some((n) => n.id === id && n.parentId === parentId),
    )
  )
    throw new Error('只能聚合同一归属下的画板')
  const id = crypto.randomUUID()
  const architecture: Architecture = {
    ...system.architecture,
    updatedAt: new Date().toISOString(),
    boards: [
      ...system.architecture.boards.map((n) =>
        childIds.includes(n.id) ? { ...n, parentId: id } : n,
      ),
      { id, name, kind: 'aggregate', parentId, description: '' },
    ],
  }
  let next = initializeBoards(saveArchitecture(workspace, architecture))
  next = includeBoards(next, id, childIds)
  // Keep existing connected references and all baselines intact. Unconnected child cards
  // can be replaced by the new aggregate; existing business connections stay explicit.
  next = updateNodeContent(next, parentId, (p) => {
    if (!p.diagram) return p
    const diagram = p.diagram
    return {
      ...p,
      diagram: {
        ...diagram,
        components: diagram.components.filter(
          (c) =>
            !c.reference ||
            !childIds.includes(c.reference.boardId) ||
            diagram.connections.some((e) => e.sourceId === c.id || e.targetId === c.id),
        ),
      },
    }
  })
  next = includeBoards(next, parentId, [id])
  return workspaceSchema.parse({ ...next, activeNodeId: id })
}

export function compositionChanges(
  workspace: Workspace,
): Map<string, { own: boolean; descendants: number }> {
  const result = new Map<string, { own: boolean; descendants: number }>()
  for (const system of workspace.systems) {
    const nodes = flattenArchitecture(system.architecture)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const node of nodes) result.set(node.id, { own: false, descendants: 0 })
    for (const content of system.contents) {
      if (
        !byId.has(content.id) ||
        !content.diagram ||
        !iterationChanges(content.diagram).some((c) => c.status !== 'unchanged')
      )
        continue
      result.get(content.id)!.own = true
      let node: ScopeNode | undefined = byId.get(content.id)
      while (node?.parentId) {
        result.get(node.parentId)!.descendants++
        node = byId.get(node.parentId)
      }
    }
  }
  return result
}
