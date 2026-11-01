import { describe, expect, it } from 'vitest'
import {
  buildCombinedRenderIndex,
  combinedViewportBounds,
  selectCombinedViewport,
} from '../src/shared/combined-diagram-render'
import {
  type CombinedBoard,
  type CombinedDiagram,
  type CombinedEdge,
  type CombinedNode,
} from '../src/shared/combined-diagram'
import { emptyDiagram, newComponent, newConnection } from '../src/shared/diagram'

function frame(
  id: string,
  x = 0,
  y = 0,
  version: 'current' | 'history' = 'current',
): CombinedBoard {
  const diagram = emptyDiagram()
  return {
    id: `${id}:${version}`,
    board: { id, name: id, path: `交易应用 / ${id}`, diagram },
    location: { boardId: id, version, ...(version === 'history' ? { historyId: 'old' } : {}) },
    graph: diagram,
    x,
    y,
    width: 1800,
    height: 1800,
  }
}
function node(board: CombinedBoard, local: string, x: number, y: number): CombinedNode {
  const component = { ...newComponent('action', { x, y }), id: local, name: `处理 ${local}` }
  return {
    id: `${board.id}/${local}`,
    boardId: board.id,
    component,
    location: { ...board.location, componentId: local },
  }
}
function edge(
  source: CombinedNode,
  target: CombinedNode,
  id: string,
  reference = false,
): CombinedEdge {
  return {
    id,
    kind: reference ? 'reference' : 'connection',
    name: id,
    sourceId: source.id,
    targetId: target.id,
    ...(reference
      ? {}
      : { connection: { ...newConnection(source.component, target.component), id } }),
  }
}
function graph(
  boards: CombinedBoard[],
  nodes: CombinedNode[],
  edges: CombinedEdge[] = [],
): CombinedDiagram {
  return {
    rootKey: boards[0]?.id ?? '',
    boards,
    nodes,
    edges,
    issues: [],
    pendingHistory: [],
    truncated: false,
    width: 100000,
    height: 100000,
  }
}
const view = { x: 0, y: 0, zoom: 1, width: 800, height: 500 }

describe('组合视图渲染索引与视口裁剪', () => {
  it('按视口查询组件、画板和连线，并保留原图顺序与缓存对象', () => {
    const first = frame('first')
    const far = frame('far', 5000, 5000)
    const a = node(first, 'a', 100, 100)
    const b = node(first, 'b', 500, 100)
    const c = node(far, 'c', 5100, 5100)
    const source = graph([first, far], [a, b, c], [edge(a, b, 'ab'), edge(b, c, 'bc')])
    const before = structuredClone(source)
    const index = buildCombinedRenderIndex(source)
    const visible = selectCombinedViewport(index, view, { overscan: 0 })
    expect(visible.visibleFrames).toEqual([first])
    expect(visible.visibleNodes).toEqual([a, b])
    expect(visible.visibleEdges.map((item) => item.id)).toEqual(['ab', 'bc'])
    expect(visible.visibleNodes[0]).toBe(index.nodeById.get(a.id))
    expect(visible.visibleEdges[0]).toBe(index.edges[0])
    expect(index.searchTextByNodeId.get(a.id)).toContain('交易应用 / first')
    expect(index.nodeBoundsById.get(a.id)).toMatchObject({ x: 100, y: 100, width: 230 })
    selectCombinedViewport(index, { ...view, x: -5000, y: -5000 })
    expect(source).toEqual(before)
  })

  it('将屏幕尺寸和平移缩放转换为世界坐标，缓冲区按屏幕像素计算', () => {
    expect(
      combinedViewportBounds({ x: 500, y: 250, zoom: 0.5, width: 200, height: 100 }, 50),
    ).toEqual({
      x: -1100,
      y: -600,
      width: 600,
      height: 400,
    })
    const board = frame('negative', -1200, -800)
    const negative = node(board, 'negative', -1000, -500)
    const nearby = node(board, 'nearby', -650, -500)
    const index = buildCombinedRenderIndex(graph([board], [negative, nearby]))
    const located = selectCombinedViewport(
      index,
      { x: 500, y: 250, zoom: 0.5, width: 150, height: 100 },
      { overscan: 0 },
    )
    expect(located.visibleNodes).toEqual([negative])
    const buffered = selectCombinedViewport(
      index,
      { x: 500, y: 250, zoom: 0.5, width: 150, height: 100 },
      { overscan: 30 },
    )
    expect(buffered.visibleNodes).toEqual([negative, nearby])
  })

  it('保留横穿视口的连线，即使两个端点组件都在屏幕外', () => {
    const board = frame('crossing', -2000)
    const left = node(board, 'left', -1500, 100)
    const right = node(board, 'right', 1500, 100)
    const index = buildCombinedRenderIndex(
      graph([board], [left, right], [edge(left, right, 'cross')]),
    )
    const visible = selectCombinedViewport(
      index,
      { ...view, width: 400, height: 350 },
      { overscan: 0 },
    )
    expect(visible.visibleNodes).toEqual([])
    expect(visible.visibleEdges.map((item) => item.id)).toEqual(['cross'])
  })

  it('曲线裁剪考虑控制点外凸部分，不只使用端点包围盒', () => {
    const board = frame('feedback')
    const top = node(board, 'top', 0, 0)
    const bottom = node(board, 'bottom', 0, 1000)
    const index = buildCombinedRenderIndex(
      graph([board], [top, bottom], [edge(top, bottom, 'feedback')]),
    )
    const rendered = index.edges[0]
    const coordinates = rendered.path.match(/-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi)!.map(Number)
    const t = 0.1
    const point = (offset: number) =>
      (1 - t) ** 3 * coordinates[offset] +
      3 * (1 - t) ** 2 * t * coordinates[2 + offset] +
      3 * (1 - t) * t ** 2 * coordinates[4 + offset] +
      t ** 3 * coordinates[6 + offset]
    const x = point(0),
      y = point(1)
    expect(x).toBeGreaterThan(Math.max(rendered.from.x, rendered.to.x))
    const visible = selectCombinedViewport(
      index,
      { x: -x + 1, y: -y + 1, zoom: 1, width: 2, height: 2 },
      { overscan: 0 },
    )
    expect(visible.visibleNodes).toEqual([])
    expect(visible.visibleEdges[0]).toBe(rendered)
  })

  it('按画板版本聚合引用，端口对应不重复计为新的引用卡', () => {
    const a = frame('caller')
    const current = frame('source', 4000)
    const historical = frame('source', 4000, 3000, 'history')
    const firstRef = node(a, 'reference-1', 100, 100)
    const secondRef = node(a, 'reference-2', 500, 100)
    const entry = node(current, 'entry', 4100, 100)
    const output = node(current, 'output', 4500, 100)
    const oldEntry = node(historical, 'entry', 4100, 3100)
    const index = buildCombinedRenderIndex(
      graph(
        [a, current, historical],
        [firstRef, secondRef, entry, output, oldEntry],
        [
          edge(firstRef, entry, 'first-entry', true),
          edge(firstRef, output, 'first-output', true),
          edge(secondRef, entry, 'second-entry', true),
          edge(firstRef, oldEntry, 'first-old-entry', true),
        ],
      ),
    )
    expect(index.bridges).toHaveLength(2)
    expect(index.bridges[0]).toMatchObject({ sourceId: a.id, targetId: current.id, count: 2 })
    expect(index.bridges[0].edges).toHaveLength(3)
    expect(index.bridges[1]).toMatchObject({ targetId: historical.id, count: 1 })
    expect(index.nodeById.get(entry.id)).not.toBe(index.nodeById.get(oldEntry.id))
    const overview = selectCombinedViewport(
      index,
      { ...view, zoom: 0.1, width: 1000, height: 800 },
      { nodes: false, edges: false },
    )
    expect(overview.visibleNodes).toEqual([])
    expect(overview.visibleEdges).toEqual([])
    expect(overview.visibleBridges).toEqual(index.bridges)
    expect(overview.stats.nodeCandidates).toBe(0)
    expect(overview.stats.edgeCandidates).toBe(0)
  })

  it('千级组件只查询附近候选，极低缩放与超长连线不枚举巨大空网格', () => {
    const boards: CombinedBoard[] = []
    const nodes: CombinedNode[] = []
    const edges: CombinedEdge[] = []
    for (let i = 0; i < 50; i++) {
      const board = frame(`board-${i}`, (i % 10) * 4000, Math.floor(i / 10) * 4000)
      boards.push(board)
      const local: CombinedNode[] = []
      for (let j = 0; j < 30; j++) {
        const component = node(
          board,
          `component-${j}`,
          board.x + 100 + (j % 5) * 300,
          board.y + 100 + Math.floor(j / 5) * 240,
        )
        local.push(component)
        nodes.push(component)
        if (j) edges.push(edge(local[j - 1], component, `${board.id}-edge-${j}`))
      }
    }
    // The control-point bounds cover thousands of grid cells and use bounded overflow storage.
    const remoteBoard = frame('remote', 1e8, 1e8)
    const remote = node(remoteBoard, 'remote', 1e8 + 100, 1e8 + 100)
    boards.push(remoteBoard)
    nodes.push(remote)
    edges.push(edge(nodes[0], remote, 'extreme-distance'))
    const index = buildCombinedRenderIndex(graph(boards, nodes, edges))
    const near = selectCombinedViewport(index, view, { overscan: 0, bridges: false })
    expect(near.visibleNodes.length).toBeLessThan(15)
    expect(near.stats.nodeCandidates).toBeLessThan(80)
    expect(near.stats.edgeCandidates).toBeLessThan(120)
    const overview = selectCombinedViewport(
      index,
      { ...view, zoom: 0.001 },
      { nodes: false, edges: false },
    )
    expect(overview.visibleFrames).toHaveLength(50)
    expect(overview.stats.frameCandidates).toBe(51)
    const all = selectCombinedViewport(index, { ...view, zoom: 0.000001 }, { overscan: 0 })
    expect(all.visibleNodes).toHaveLength(1501)
    expect(all.visibleEdges).toHaveLength(1451)
  })
})
