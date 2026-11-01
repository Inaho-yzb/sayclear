import { COMPONENT_WIDTH, componentHeight, componentTypes } from './diagram'
import { connectionAnchor, connectionCurve, type Anchor } from './diagram-geometry'
import {
  type CombinedBoard,
  type CombinedDiagram,
  type CombinedEdge,
  type CombinedNode,
} from './combined-diagram'

export type CombinedRenderBounds = { x: number; y: number; width: number; height: number }
export type CombinedRenderEdge = CombinedEdge & {
  source: CombinedNode
  target: CombinedNode
  from: Anchor
  to: Anchor
  path: string
  bounds: CombinedRenderBounds
  label: { x: number; y: number }
}
export type CombinedBoardBridge = {
  id: string
  sourceId: string
  targetId: string
  source: CombinedBoard
  target: CombinedBoard
  /** Number of reference cards, rather than their individual exported ports. */
  count: number
  edges: CombinedRenderEdge[]
  from: Anchor
  to: Anchor
  path: string
  bounds: CombinedRenderBounds
  label: { x: number; y: number }
}
type IndexedItem<T> = { item: T; bounds: CombinedRenderBounds; order: number }
type GridCell<T> = { x: number; y: number; entries: IndexedItem<T>[] }

const CELL_SIZE = 1024
const MAX_CELLS_PER_ITEM = 128
const intersects = (a: CombinedRenderBounds, b: CombinedRenderBounds) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y

/** Long edges and huge board frames remain bounded instead of filling millions of cells. */
class RenderGrid<T> {
  private cells = new Map<string, GridCell<T>>()
  private overflow: IndexedItem<T>[] = []
  private entries: IndexedItem<T>[] = []

  add(item: T, bounds: CombinedRenderBounds) {
    const entry = { item, bounds, order: this.entries.length }
    this.entries.push(entry)
    const minX = Math.floor(bounds.x / CELL_SIZE)
    const maxX = Math.floor((bounds.x + bounds.width) / CELL_SIZE)
    const minY = Math.floor(bounds.y / CELL_SIZE)
    const maxY = Math.floor((bounds.y + bounds.height) / CELL_SIZE)
    if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_CELLS_PER_ITEM) {
      this.overflow.push(entry)
      return
    }
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`
        let cell = this.cells.get(key)
        if (!cell) {
          cell = { x, y, entries: [] }
          this.cells.set(key, cell)
        }
        cell.entries.push(entry)
      }
  }

  query(bounds: CombinedRenderBounds): { items: T[]; candidates: number } {
    const minX = Math.floor(bounds.x / CELL_SIZE)
    const maxX = Math.floor((bounds.x + bounds.width) / CELL_SIZE)
    const minY = Math.floor(bounds.y / CELL_SIZE)
    const maxY = Math.floor((bounds.y + bounds.height) / CELL_SIZE)
    const cellCount = (maxX - minX + 1) * (maxY - minY + 1)
    // A fit-to-workspace viewport can cover enormous empty areas between boards.
    // Scan the cached entries instead of iterating the coordinates of empty cells.
    if (cellCount > Math.max(256, this.cells.size * 4))
      return {
        items: this.entries.filter((entry) => intersects(entry.bounds, bounds)).map((e) => e.item),
        candidates: this.entries.length,
      }
    const candidates = new Set(this.overflow)
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++)
        for (const entry of this.cells.get(`${x},${y}`)?.entries ?? []) candidates.add(entry)
    return {
      items: [...candidates]
        .filter((entry) => intersects(entry.bounds, bounds))
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.item),
      candidates: candidates.size,
    }
  }
}

export type CombinedRenderIndex = {
  graph: CombinedDiagram
  nodeById: Map<string, CombinedNode>
  frameById: Map<string, CombinedBoard>
  searchTextByNodeId: Map<string, string>
  nodeBoundsById: Map<string, CombinedRenderBounds>
  nodes: CombinedNode[]
  frames: CombinedBoard[]
  edges: CombinedRenderEdge[]
  bridges: CombinedBoardBridge[]
  nodeGrid: RenderGrid<CombinedNode>
  frameGrid: RenderGrid<CombinedBoard>
  edgeGrid: RenderGrid<CombinedRenderEdge>
  bridgeGrid: RenderGrid<CombinedBoardBridge>
}

function geometry(from: Anchor, to: Anchor, labelWidth = 0) {
  const path = connectionCurve(from, to)
  // connectionCurve is the single source of curve routing. Its eight coordinates
  // include both control points, whose convex hull contains the complete curve.
  const coordinates = path.match(/-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi)!.map(Number)
  const xs = coordinates.filter((_, index) => index % 2 === 0)
  const ys = coordinates.filter((_, index) => index % 2 !== 0)
  const label = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 8 }
  const x = Math.min(...xs, label.x - labelWidth / 2) - 8
  const y = Math.min(...ys, label.y - 14) - 8
  return {
    from,
    to,
    path,
    label,
    bounds: {
      x,
      y,
      width: Math.max(...xs, label.x + labelWidth / 2) + 8 - x,
      height: Math.max(...ys, label.y + 8) + 8 - y,
    },
  }
}

function frameAnchor(frame: CombinedBoard, other: CombinedBoard): Anchor {
  const x = frame.x + frame.width / 2
  const y = frame.y + frame.height / 2
  const dx = other.x + other.width / 2 - x
  const dy = other.y + other.height / 2 - y
  if (Math.abs(dx) / frame.width >= Math.abs(dy) / frame.height) {
    const direction = Math.sign(dx) || 1
    return { x: x + (direction * frame.width) / 2, y, dx: direction, dy: 0 }
  }
  const direction = Math.sign(dy) || 1
  return { x, y: y + (direction * frame.height) / 2, dx: 0, dy: direction }
}

/** Build once per graph revision, independently of pan, zoom, search or selection. */
export function buildCombinedRenderIndex(graph: CombinedDiagram): CombinedRenderIndex {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const frameById = new Map(graph.boards.map((frame) => [frame.id, frame]))
  const nodeBoundsById = new Map<string, CombinedRenderBounds>()
  const searchTextByNodeId = new Map<string, string>()
  const nodeGrid = new RenderGrid<CombinedNode>()
  const frameGrid = new RenderGrid<CombinedBoard>()
  const edgeGrid = new RenderGrid<CombinedRenderEdge>()
  const bridgeGrid = new RenderGrid<CombinedBoardBridge>()
  for (const frame of graph.boards) frameGrid.add(frame, frame)
  for (const node of graph.nodes) {
    const component = node.component
    const bounds = {
      ...component.position,
      width: COMPONENT_WIDTH,
      height: componentHeight(component),
    }
    nodeBoundsById.set(node.id, bounds)
    nodeGrid.add(node, bounds)
    searchTextByNodeId.set(
      node.id,
      [
        component.name,
        component.description,
        component.id,
        componentTypes[component.type],
        frameById.get(node.boardId)?.board.path,
      ]
        .join(' ')
        .toLowerCase(),
    )
  }
  const edges: CombinedRenderEdge[] = []
  const bridgePairs = new Map<string, CombinedRenderEdge[]>()
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.sourceId)
    const target = nodeById.get(edge.targetId)
    if (!source || !target) continue
    const rendered = {
      ...edge,
      source,
      target,
      ...geometry(
        connectionAnchor(
          source.component,
          edge.connection?.sourcePortId ?? null,
          true,
          target.component,
        ),
        connectionAnchor(
          target.component,
          edge.connection?.targetPortId ?? null,
          false,
          source.component,
        ),
        edge.kind === 'connection' ? Math.min(edge.name.length, 20) * 12 : 0,
      ),
    }
    edges.push(rendered)
    edgeGrid.add(rendered, rendered.bounds)
    if (edge.kind === 'reference' && source.boardId !== target.boardId) {
      const key = JSON.stringify([source.boardId, target.boardId])
      const pair = bridgePairs.get(key) ?? []
      pair.push(rendered)
      bridgePairs.set(key, pair)
    }
  }
  const bridges: CombinedBoardBridge[] = []
  for (const [id, referenceEdges] of bridgePairs) {
    const first = referenceEdges[0]
    const source = frameById.get(first.source.boardId)
    const target = frameById.get(first.target.boardId)
    if (!source || !target) continue
    const bridge = {
      id,
      sourceId: source.id,
      targetId: target.id,
      source,
      target,
      count: new Set(referenceEdges.map((edge) => edge.sourceId)).size,
      edges: referenceEdges,
      ...geometry(frameAnchor(source, target), frameAnchor(target, source), 60),
    }
    bridges.push(bridge)
    bridgeGrid.add(bridge, bridge.bounds)
  }
  return {
    graph,
    nodeById,
    frameById,
    searchTextByNodeId,
    nodeBoundsById,
    nodes: graph.nodes,
    frames: graph.boards,
    edges,
    bridges,
    nodeGrid,
    frameGrid,
    edgeGrid,
    bridgeGrid,
  }
}

export type CombinedViewport = {
  x: number
  y: number
  zoom: number
  width: number
  height: number
}
export type CombinedViewportOptions = {
  /** Buffer measured in screen pixels, so zooming in does not cause edge popping. */
  overscan?: number
  nodes?: boolean
  edges?: boolean
  frames?: boolean
  bridges?: boolean
}

export function combinedViewportBounds(
  view: CombinedViewport,
  overscan = 160,
): CombinedRenderBounds {
  const zoom = Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom : 0.001
  const padding = Number.isFinite(overscan) ? Math.max(0, overscan) : 160
  return {
    x: (-view.x - padding) / zoom,
    y: (-view.y - padding) / zoom,
    width: (Math.max(0, view.width) + 2 * padding) / zoom,
    height: (Math.max(0, view.height) + 2 * padding) / zoom,
  }
}

/** Only geometry candidates near the viewport are visited during high-frequency input. */
export function selectCombinedViewport(
  index: CombinedRenderIndex,
  view: CombinedViewport,
  options: CombinedViewportOptions = {},
) {
  const bounds = combinedViewportBounds(view, options.overscan)
  const empty = <T>(): { items: T[]; candidates: number } => ({ items: [], candidates: 0 })
  const nodes = options.nodes === false ? empty<CombinedNode>() : index.nodeGrid.query(bounds)
  const frames = options.frames === false ? empty<CombinedBoard>() : index.frameGrid.query(bounds)
  const edges = options.edges === false ? empty<CombinedRenderEdge>() : index.edgeGrid.query(bounds)
  const bridges =
    options.bridges === false ? empty<CombinedBoardBridge>() : index.bridgeGrid.query(bounds)
  return {
    visibleNodes: nodes.items,
    visibleFrames: frames.items,
    visibleEdges: edges.items,
    visibleBridges: bridges.items,
    bounds,
    stats: {
      nodeCandidates: nodes.candidates,
      frameCandidates: frames.candidates,
      edgeCandidates: edges.candidates,
      bridgeCandidates: bridges.candidates,
    },
  }
}

export type CombinedViewportSelection = ReturnType<typeof selectCombinedViewport>
