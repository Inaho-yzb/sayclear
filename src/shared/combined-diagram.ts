import {
  COMPONENT_WIDTH,
  componentHeight,
  type DiagramComponent,
  type DiagramConnection,
  type GraphSnapshot,
} from './diagram'
import {
  exportedPortId,
  referenceSnapshot,
  resolveReference,
  type Board,
  type BoardLocation,
} from './diagram-references'

export type CombinedBoard = {
  id: string
  board: Board
  location: BoardLocation
  graph: GraphSnapshot
  x: number
  y: number
  width: number
  height: number
}
export type CombinedNode = {
  id: string
  boardId: string
  component: DiagramComponent
  location: BoardLocation
  referenceStatus?: 'ok' | 'changed' | 'missing'
  referenceMessage?: string
}
export type CombinedEdge = {
  id: string
  kind: 'connection' | 'reference'
  sourceId: string
  targetId: string
  name: string
  connection?: DiagramConnection
  output?: boolean
  status?: 'ok' | 'changed' | 'missing'
}
export type CombinedIssue = {
  id: string
  kind: 'missing' | 'changed' | 'history' | 'limit'
  message: string
  location?: BoardLocation
  componentId?: string
}
export type CombinedDiagram = {
  rootKey: string
  boards: CombinedBoard[]
  nodes: CombinedNode[]
  edges: CombinedEdge[]
  issues: CombinedIssue[]
  pendingHistory: BoardLocation[]
  truncated: boolean
  width: number
  height: number
}

/** A board's versions are separate frames, even when their local component IDs agree. */
export function combinedBoardKey(location: BoardLocation): string {
  return `${encodeURIComponent(location.boardId)}:${location.version}:${encodeURIComponent(
    location.version === 'history'
      ? (location.historyId ?? '')
      : location.version === 'iteration'
        ? (location.iterationId ?? '')
        : '',
  )}`
}
const nodeKey = (boardKey: string, componentId: string) =>
  `${boardKey}/${encodeURIComponent(componentId)}`
function boardLocation(location: BoardLocation): BoardLocation {
  return {
    boardId: location.boardId,
    version: location.version,
    ...(location.version === 'iteration' ? { iterationId: location.iterationId } : {}),
    ...(location.version === 'history' ? { historyId: location.historyId } : {}),
  }
}

/**
 * Build a read-only projection. References retain their adopted definitions and are
 * joined to the exact source version; no execution connections are synthesized.
 * Only live current/iteration snapshots are searched for reverse references.
 */
export function buildCombinedDiagram(
  boards: Board[],
  root: BoardLocation,
  options: { maxBoards?: number } = {},
): CombinedDiagram {
  const maxBoards = Number.isFinite(options.maxBoards)
    ? Math.max(1, Math.floor(options.maxBoards!))
    : 40
  const byId = new Map(boards.map((board) => [board.id, board]))
  const incoming = new Map<string, BoardLocation[]>()
  for (const board of boards) {
    const versions: BoardLocation[] = [{ boardId: board.id, version: 'current' }]
    if (board.diagram.iteration)
      versions.push({
        boardId: board.id,
        version: 'iteration',
        iterationId: board.diagram.iteration.id,
      })
    for (const location of versions) {
      const graph = referenceSnapshot(
        board,
        location.version,
        location.iterationId,
        location.historyId,
      )!
      for (const component of graph.components) {
        if (!component.reference) continue
        const targetKey = combinedBoardKey(component.reference)
        const sources = incoming.get(targetKey) ?? []
        if (!sources.some((source) => combinedBoardKey(source) === combinedBoardKey(location)))
          sources.push(location)
        incoming.set(targetKey, sources)
      }
    }
  }

  const rootLocation = boardLocation(root)
  const result: CombinedDiagram = {
    rootKey: combinedBoardKey(rootLocation),
    boards: [],
    nodes: [],
    edges: [],
    issues: [],
    pendingHistory: [],
    truncated: false,
    width: 640,
    height: 360,
  }
  const queue = [{ location: rootLocation, depth: 0 }]
  const seen = new Set([result.rootKey])
  const depths = new Map<string, number>()
  const bounds = new Map<string, { minX: number; minY: number }>()
  function enqueue(location: BoardLocation, depth: number) {
    const key = combinedBoardKey(location)
    if (seen.has(key)) return
    if (seen.size >= maxBoards) {
      result.truncated = true
      return
    }
    seen.add(key)
    queue.push({ location: boardLocation(location), depth })
  }
  for (let i = 0; i < queue.length; i++) {
    const { location, depth } = queue[i]
    const key = combinedBoardKey(location)
    const board = byId.get(location.boardId)
    const graph =
      board && referenceSnapshot(board, location.version, location.iterationId, location.historyId)
    // Find callers even when the requested historical file has not loaded yet.
    for (const source of incoming.get(key) ?? []) enqueue(source, depth - 1)
    if (!board || !graph) {
      const unloadedHistory =
        board &&
        location.version === 'history' &&
        board.diagram.history.some((version) => version.id === location.historyId)
      if (unloadedHistory) result.pendingHistory.push(location)
      result.issues.push({
        id: key,
        kind: unloadedHistory ? 'history' : 'missing',
        message: unloadedHistory
          ? `正在读取「${board.name}」的历史版本`
          : !board
            ? `来源画板「${location.boardId}」已删除或不在当前工作区`
            : location.version === 'iteration'
              ? `「${board.name}」的来源迭代已结束或不存在`
              : `「${board.name}」的来源历史版本已移除`,
        location,
      })
      continue
    }
    const minX = graph.components.length
      ? Math.min(...graph.components.map((component) => component.position.x))
      : 0
    const minY = graph.components.length
      ? Math.min(...graph.components.map((component) => component.position.y))
      : 0
    const maxX = Math.max(
      0,
      ...graph.components.map((component) => component.position.x + COMPONENT_WIDTH),
    )
    const maxY = Math.max(
      0,
      ...graph.components.map((component) => component.position.y + componentHeight(component)),
    )
    bounds.set(key, { minX, minY })
    depths.set(key, depth)
    result.boards.push({
      id: key,
      board,
      location,
      graph,
      x: 0,
      y: 0,
      width: Math.max(400, maxX - minX + 64),
      height: Math.max(260, maxY - minY + 128),
    })
    for (const component of graph.components)
      if (component.reference) enqueue(component.reference, depth + 1)
  }
  if (result.truncated)
    result.issues.push({
      id: 'board-limit',
      kind: 'limit',
      message: `关联画板超过 ${maxBoards} 张，当前仅展示前 ${maxBoards} 张，可继续展开关联画板`,
    })

  // Directional columns put callers to the left and source definitions to the right.
  const columns = new Map<number, CombinedBoard[]>()
  for (const frame of result.boards) {
    const depth = depths.get(frame.id)!
    columns.set(depth, [...(columns.get(depth) ?? []), frame])
  }
  let x = 40
  for (const [, frames] of [...columns].sort(([a], [b]) => a - b)) {
    let y = 40
    for (const frame of frames) {
      frame.x = x
      frame.y = y
      y += frame.height + 100
    }
    x += Math.max(...frames.map((frame) => frame.width)) + 160
    result.height = Math.max(result.height, y - 60)
  }
  result.width = Math.max(result.width, x - 120)
  for (const frame of result.boards) {
    const { minX, minY } = bounds.get(frame.id)!
    for (const component of frame.graph.components) {
      const resolution = component.reference ? resolveReference(boards, component) : undefined
      const node: CombinedNode = {
        id: nodeKey(frame.id, component.id),
        boardId: frame.id,
        component: {
          ...component,
          position: {
            x: component.position.x - minX + frame.x + 32,
            y: component.position.y - minY + frame.y + 96,
          },
        },
        location: { ...frame.location, componentId: component.id },
        ...(resolution
          ? { referenceStatus: resolution.status, referenceMessage: resolution.message }
          : {}),
      }
      result.nodes.push(node)
      if (resolution && resolution.status !== 'ok')
        result.issues.push({
          id: node.id,
          kind: resolution.status,
          message: `${frame.board.name} / ${component.name}：${resolution.message}`,
          location: node.location,
          componentId: component.id,
        })
    }
    for (const connection of frame.graph.connections)
      result.edges.push({
        id: `${frame.id}/edge/${encodeURIComponent(connection.id)}`,
        kind: 'connection',
        sourceId: nodeKey(frame.id, connection.sourceId),
        targetId: nodeKey(frame.id, connection.targetId),
        name: connection.name,
        connection,
      })
  }
  const nodes = new Map(result.nodes.map((node) => [node.id, node]))
  for (const node of result.nodes) {
    const reference = node.component.reference
    if (!reference) continue
    const sourceKey = combinedBoardKey(reference)
    for (const [index, id] of [reference.componentId, ...reference.outputIds].entries()) {
      const source = nodes.get(nodeKey(sourceKey, id))
      if (!source?.component.exposed || source.component.reference) continue
      result.edges.push({
        id: `${node.id}/reference/${encodeURIComponent(id)}`,
        kind: 'reference',
        sourceId: node.id,
        targetId: source.id,
        name: index === 0 ? '引用入口' : `引用输出 · ${source.component.name}`,
        output: index > 0,
        status: node.referenceStatus,
      })
    }
  }
  return result
}

/**
 * Trace through a reference's entry and exported ports separately. A reached output
 * highlights its reference card without re-entering the source or sibling outputs.
 */
export function traceCombinedDiagram(
  graph: CombinedDiagram,
  selectedId: string,
  direction: 'upstream' | 'downstream',
): Set<string> {
  const found = new Set<string>()
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  if (!nodes.has(selectedId)) return found
  const adjacent = new Map<string, Set<string>>()
  const owners = new Map<string, string>()
  const components = new Map<string, string>()
  const references = new Map<
    string,
    { input: string; output: string; exports: Map<string, string>; ports: Map<string, string> }
  >()
  function vertex(nodeId: string, role: string, outputId?: string) {
    const id = JSON.stringify([nodeId, role, outputId])
    owners.set(id, nodeId)
    return id
  }
  function connect(source: string, target: string) {
    const from = direction === 'downstream' ? source : target
    const to = direction === 'downstream' ? target : source
    const next = adjacent.get(from) ?? new Set<string>()
    next.add(to)
    adjacent.set(from, next)
  }
  for (const node of graph.nodes) {
    const reference = node.component.reference
    if (!reference) {
      components.set(node.id, vertex(node.id, 'component'))
      continue
    }
    const exports = new Map<string, string>()
    const ports = new Map<string, string>()
    for (const id of reference.outputIds) {
      const output = vertex(node.id, 'export', id)
      exports.set(id, output)
      ports.set(exportedPortId(reference.boardId, id), output)
    }
    references.set(node.id, {
      input: vertex(node.id, 'input'),
      output: vertex(node.id, 'output'),
      exports,
      ports,
    })
  }
  const resolvedEntries = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.kind === 'reference') {
      const reference = references.get(edge.sourceId)
      const source = components.get(edge.targetId)
      if (!reference || !source) continue
      if (edge.output) {
        const output = reference.exports.get(nodes.get(edge.targetId)!.component.id)
        if (output) connect(source, output)
      } else {
        connect(reference.input, source)
        connect(source, reference.output)
        resolvedEntries.add(edge.sourceId)
      }
      continue
    }
    const sourceReference = references.get(edge.sourceId)
    const source = sourceReference
      ? (sourceReference.ports.get(edge.connection?.sourcePortId ?? '') ?? sourceReference.output)
      : components.get(edge.sourceId)
    const target = references.get(edge.targetId)?.input ?? components.get(edge.targetId)
    if (source && target) connect(source, target)
  }
  // An unavailable source remains an atomic cached card, so its local business
  // connections are still useful while the missing-source warning is visible.
  for (const [id, reference] of references)
    if (!resolvedEntries.has(id)) {
      connect(reference.input, reference.output)
      for (const output of reference.exports.values()) connect(reference.input, output)
    }
  const selectedReference = references.get(selectedId)
  const queue = selectedReference
    ? direction === 'downstream'
      ? [selectedReference.input]
      : [selectedReference.input, selectedReference.output, ...selectedReference.exports.values()]
    : [components.get(selectedId)!]
  const visited = new Set(queue)
  for (let i = 0; i < queue.length; i++)
    for (const id of adjacent.get(queue[i]) ?? [])
      if (!visited.has(id)) {
        visited.add(id)
        queue.push(id)
      }
  for (const id of visited) found.add(owners.get(id)!)
  return found
}
