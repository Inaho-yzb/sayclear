import { flattenArchitecture, type Workspace } from './model'
import {
  componentSchema,
  type Diagram,
  type DiagramComponent,
  type DiagramReference,
  type GraphSnapshot,
} from './diagram'

export type Board = {
  id: string
  name: string
  path: string
  diagram: Diagram
  applicationId?: string
  applicationName?: string
}
export type BoardLocation = {
  boardId: string
  componentId?: string
  version: 'current' | 'iteration' | 'history'
  iterationId?: string
  historyId?: string
}
export function referenceBoards(workspace: Workspace): Board[] {
  return workspace.systems.flatMap((system) =>
    flattenArchitecture(system.architecture).flatMap((node) => {
      const nodes = flattenArchitecture(system.architecture)
      const ancestors = [node]
      while (ancestors[0].parentId)
        ancestors.unshift(nodes.find((n) => n.id === ancestors[0].parentId)!)
      const diagram = system.contents.find((c) => c.id === node.id)?.diagram
      return diagram
        ? [
            {
              id: node.id,
              name: node.name,
              applicationId: ancestors.find((n) => n.type === 'application')?.id,
              applicationName: ancestors.find((n) => n.type === 'application')?.name,
              path: ancestors.map((n) => n.name).join(' / '),
              diagram,
            },
          ]
        : []
    }),
  )
}
export function referenceSnapshot(
  board: Board,
  version: DiagramReference['version'],
  iterationId?: string,
  historyId?: string,
): GraphSnapshot | undefined {
  if (version === 'history') return board.diagram.history.find((h) => h.id === historyId)?.snapshot
  if (version === 'current') return board.diagram.iteration?.baseline ?? board.diagram
  return board.diagram.iteration && board.diagram.iteration.id === iterationId
    ? board.diagram
    : undefined
}
export const exposedComponents = (graph?: GraphSnapshot) =>
  graph?.components.filter((c) => c.exposed && !c.reference) ?? []
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? ''
}
// A deterministic change fingerprint, not an identity or security token.
function hash(value: unknown): string {
  let h = 0xcbf29ce484222325n
  for (const ch of new TextEncoder().encode(canonical(value)))
    h = BigInt.asUintN(64, (h ^ BigInt(ch)) * 0x100000001b3n)
  return h.toString(16).padStart(16, '0')
}
export const exportedPortId = (boardId: string, id: string) => `export-${hash([boardId, id])}`
function definition(component: DiagramComponent) {
  return {
    type: component.type,
    templateId: component.templateId,
    boundary: component.boundary,
    name: component.name,
    description: component.description,
    metadata: component.metadata ?? {},
    ...(component.validation ? { validation: component.validation } : {}),
    inputs: component.inputs,
    outputs: component.outputs,
  }
}
export type ReferenceResolution = {
  status: 'ok' | 'changed' | 'missing'
  message: string
  board?: Board
  next?: DiagramComponent
}
export function resolveReference(
  boards: Board[],
  component: DiagramComponent,
): ReferenceResolution {
  const ref = component.reference
  if (!ref) return { status: 'missing', message: '不是引用组件' }
  const board = boards.find((b) => b.id === ref.boardId)
  if (!board) return { status: 'missing', message: '来源画板已删除或不在当前工作区' }
  const graph = referenceSnapshot(board, ref.version, ref.iterationId, ref.historyId)
  if (
    !graph &&
    ref.version === 'history' &&
    board.diagram.history.some((h) => h.id === ref.historyId)
  )
    return { status: 'ok', board, message: '已固定历史版本；打开或更新引用时读取快照' }
  if (!graph)
    return {
      status: 'missing',
      board,
      message:
        ref.version === 'history'
          ? '来源历史版本已移除，已采用的定义仍保留'
          : '来源迭代已结束，请重新选择现状或其他版本',
    }
  const exposed = exposedComponents(graph)
  const source = exposed.find((c) => c.id === ref.componentId)
  if (!source) return { status: 'missing', board, message: '来源组件已删除或不再对外开放' }
  const exports = ref.outputIds.map((id) => exposed.find((c) => c.id === id))
  if (exports.some((c) => !c))
    return { status: 'missing', board, message: '引用的对外输出已删除或不再开放，请检查关联连接' }
  const definitionHash = hash([definition(source), ...exports.map((c) => definition(c!))])
  const next = {
    ...component,
    ...definition(source),
    validation: source.validation ? structuredClone(source.validation) : undefined,
    exposed: false,
    inputs: source.inputs.map((p) => ({
      ...p,
      id: `source-${hash([ref.boardId, source.id, p.id])}`,
    })),
    outputs: [
      ...source.outputs.map((p) => ({
        ...p,
        id: `source-${hash([ref.boardId, source.id, p.id])}`,
      })),
      ...exports.map((c) => ({
        id: exportedPortId(ref.boardId, c!.id),
        name: c!.name,
        dataType: c!.type,
        description: c!.description,
      })),
    ],
    reference: { ...ref, definitionHash },
  }
  if (next.outputs.length > 32)
    return { status: 'missing', board, message: '来源输出超过 32 个，请减少所选输出' }
  const changed =
    ref.definitionHash !== definitionHash ||
    canonical(definition(component)) !== canonical(definition(next))
  return {
    status: changed ? 'changed' : 'ok',
    board,
    next,
    message: changed ? '来源定义已变化，更新引用前保留已采用版本' : '已与所选来源版本同步',
  }
}
export function createReference(
  boards: Board[],
  targetBoardId: string,
  ref: Omit<DiagramReference, 'definitionHash'>,
  position = { x: 100, y: 100 },
): DiagramComponent {
  if (ref.boardId === targetBoardId) throw new Error('请选择其他画板')
  const seed: DiagramComponent = {
    id: crypto.randomUUID(),
    type: 'capability',
    templateId: 'builtin-capability',
    boundary: 'internal',
    name: '画板引用',
    description: '',
    inputs: [],
    outputs: [],
    ownerId: null,
    position,
    reference: { ...ref, definitionHash: '0000000000000000' },
  }
  const result = resolveReference(boards, seed)
  if (!result.next) throw new Error(result.message)
  return componentSchema.parse(result.next)
}
export type ReferenceUsage = {
  board: Board
  component: DiagramComponent
  version: 'current' | 'iteration'
  iterationId?: string
}
export function incomingReferences(
  boards: Board[],
  boardId: string,
  componentId?: string,
): ReferenceUsage[] {
  return boards.flatMap((board) => {
    const versions: {
      graph: GraphSnapshot
      version: 'current' | 'iteration'
      iterationId?: string
    }[] = board.diagram.iteration
      ? [
          { graph: board.diagram.iteration.baseline, version: 'current' },
          { graph: board.diagram, version: 'iteration', iterationId: board.diagram.iteration.id },
        ]
      : [{ graph: board.diagram, version: 'current' }]
    return versions.flatMap(({ graph, version, iterationId }) =>
      graph.components
        .filter(
          (c) =>
            c.reference?.boardId === boardId &&
            (!componentId ||
              c.reference.componentId === componentId ||
              c.reference.outputIds.includes(componentId)),
        )
        .map((component) => ({ board, component, version, iterationId })),
    )
  })
}
