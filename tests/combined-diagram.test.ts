import { describe, expect, it } from 'vitest'
import {
  buildCombinedDiagram,
  combinedBoardKey,
  traceCombinedDiagram,
} from '../src/shared/combined-diagram'
import {
  COMPONENT_WIDTH,
  componentHeight,
  emptyDiagram,
  newComponent,
  newConnection,
  type DiagramComponent,
} from '../src/shared/diagram'
import { createReference, exportedPortId, type Board } from '../src/shared/diagram-references'
import { snapshot, startIteration } from '../src/shared/iteration'

function board(id: string): Board {
  return {
    id,
    name: id,
    path: `应用 / ${id}`,
    diagram: {
      ...emptyDiagram(),
      components: [{ ...newComponent('capability'), id: 'entry', exposed: true, name: id }],
    },
  }
}
function reference(boards: Board[], caller: Board, source: Board) {
  const component = createReference(boards, caller.id, {
    boardId: source.id,
    componentId: 'entry',
    version: 'current',
    outputIds: [],
  })
  caller.diagram.components.push(component)
  return component
}
const root = (board: Board) => ({ boardId: board.id, version: 'current' as const })

describe('多画板全链路组合视图', () => {
  it('从中间图同时递归展开调用方和来源，跨应用保留所有原始连接', () => {
    const [a, b, c, unrelated] = ['a', 'b', 'c', 'unrelated'].map(board)
    a.applicationId = 'first-app'
    c.applicationId = 'other-app'
    const boards = [a, b, c, unrelated]
    const ab = reference(boards, a, b)
    const bc = reference(boards, b, c)
    a.diagram.connections.push(newConnection(a.diagram.components[0], ab))
    b.diagram.connections.push(newConnection(b.diagram.components[0], bc))
    const graph = buildCombinedDiagram(boards, root(b))
    expect(graph.boards.map((frame) => frame.board.id).sort()).toEqual(['a', 'b', 'c'])
    expect(graph.edges.filter((edge) => edge.kind === 'connection')).toHaveLength(2)
    expect(graph.edges.filter((edge) => edge.kind === 'reference')).toHaveLength(2)
    expect(graph.issues).toEqual([])
    expect(graph.truncated).toBe(false)
    const frames = new Map(graph.boards.map((frame) => [frame.board.id, frame]))
    expect(frames.get('a')!.x).toBeLessThan(frames.get('b')!.x)
    expect(frames.get('b')!.x).toBeLessThan(frames.get('c')!.x)
  })

  it('循环引用和多个引用共享同一版本来源，不重复生成画板或节点', () => {
    const boards = ['a', 'b', 'c'].map(board)
    reference(boards, boards[0], boards[1])
    reference(boards, boards[1], boards[2])
    reference(boards, boards[2], boards[0])
    reference(boards, boards[0], boards[2])
    const graph = buildCombinedDiagram(boards, root(boards[0]))
    expect(graph.boards).toHaveLength(3)
    expect(graph.edges.filter((edge) => edge.kind === 'reference')).toHaveLength(4)
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length)
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length)
    expect(graph.truncated).toBe(false)
  })

  it('现状与草稿分开绘制，反向引用严格匹配所引用的版本', () => {
    const [caller, source, otherCaller] = ['caller', 'source', 'other-caller'].map(board)
    source.diagram = startIteration(source.diagram, '新版本')
    source.diagram.components[0].name = '迭代入口'
    const boards = [caller, source, otherCaller]
    reference(boards, caller, source)
    const draftReference = createReference(boards, caller.id, {
      boardId: source.id,
      componentId: 'entry',
      version: 'iteration',
      iterationId: source.diagram.iteration!.id,
      outputIds: [],
    })
    otherCaller.diagram.components.push(draftReference)
    const current = buildCombinedDiagram(boards, root(source))
    expect(current.boards.map((frame) => frame.board.id).sort()).toEqual(['caller', 'source'])
    expect(current.nodes.find((node) => node.location.boardId === 'source')!.component.name).toBe(
      'source',
    )
    const draft = buildCombinedDiagram(boards, {
      boardId: source.id,
      version: 'iteration',
      iterationId: source.diagram.iteration!.id,
    })
    expect(draft.boards.map((frame) => frame.board.id).sort()).toEqual(['other-caller', 'source'])
    expect(draft.nodes.find((node) => node.location.boardId === 'source')!.component.name).toBe(
      '迭代入口',
    )
    caller.diagram.components.push(draftReference)
    const combined = buildCombinedDiagram(boards, root(caller))
    expect(combined.boards.filter((frame) => frame.board.id === source.id)).toHaveLength(2)
    expect(new Set(combined.nodes.map((node) => node.id)).size).toBe(combined.nodes.length)
  })

  it('保留来源历史版本并返回待加载快照，读取后继续递归历史中的引用', () => {
    const [caller, source, downstream] = ['caller', 'source', 'downstream'].map(board)
    const boards = [caller, source, downstream]
    reference(boards, source, downstream)
    const historical = snapshot(source.diagram)
    source.diagram.history.push({
      id: 'old',
      name: '旧版本',
      publishedAt: '2026-10-31T00:00:00.000Z',
      snapshot: historical,
    })
    const historyRef = createReference(boards, caller.id, {
      boardId: source.id,
      componentId: 'entry',
      version: 'history',
      historyId: 'old',
      outputIds: [],
    })
    caller.diagram.components.push(historyRef)
    source.diagram.components = []
    source.diagram.history[0] = {
      id: 'old',
      name: '旧版本',
      publishedAt: '2026-10-31T00:00:00.000Z',
      componentCount: historical.components.length,
      connectionCount: 0,
      snapshotDigest: '0123456789abcdef',
    }
    const pending = buildCombinedDiagram(boards, root(caller))
    expect(pending.pendingHistory).toEqual([
      { boardId: 'source', version: 'history', historyId: 'old' },
    ])
    expect(pending.issues.some((issue) => issue.kind === 'history')).toBe(true)
    expect(pending.nodes.find((node) => node.component.id === historyRef.id)!.component.name).toBe(
      'source',
    )
    source.diagram.history[0].snapshot = historical
    const loaded = buildCombinedDiagram(boards, root(caller))
    expect(loaded.pendingHistory).toEqual([])
    expect(loaded.boards.find((frame) => frame.board.id === 'source')!.location).toEqual({
      boardId: 'source',
      version: 'history',
      historyId: 'old',
    })
    expect(loaded.boards.some((frame) => frame.board.id === 'downstream')).toBe(true)
    expect(loaded.issues).toEqual([])
  })

  it('来源变化时保留已采用定义，来源失效时保留引用卡及其业务连接', () => {
    const [caller, source] = ['caller', 'source'].map(board)
    const boards = [caller, source]
    const ref = reference(boards, caller, source)
    caller.diagram.connections.push(newConnection(caller.diagram.components[0], ref))
    source.diagram.components[0].name = '新的名称'
    const changed = buildCombinedDiagram(boards, root(caller))
    const cached = changed.nodes.find((node) => node.component.id === ref.id)!
    expect(cached.component.name).toBe('source')
    expect(cached.referenceStatus).toBe('changed')
    expect(changed.issues.some((issue) => issue.kind === 'changed')).toBe(true)
    expect(changed.nodes.some((node) => node.component.name === '新的名称')).toBe(true)
    const missing = buildCombinedDiagram([caller], root(caller))
    expect(missing.nodes.find((node) => node.component.id === ref.id)!.referenceStatus).toBe(
      'missing',
    )
    expect(missing.edges.filter((edge) => edge.kind === 'connection')).toHaveLength(1)
    expect(missing.edges.filter((edge) => edge.kind === 'reference')).toHaveLength(0)
    expect(missing.issues.some((issue) => issue.kind === 'missing')).toBe(true)
  })

  it('展开公开输出的对应关系，不把已取消开放的内部组件连为有效来源', () => {
    const [caller, source] = ['caller', 'source'].map(board)
    const output: DiagramComponent = {
      ...newComponent('event'),
      id: 'done',
      exposed: true,
      name: '完成事件',
    }
    source.diagram.components.push(output)
    const boards = [caller, source]
    const ref = createReference(boards, caller.id, {
      boardId: source.id,
      componentId: 'entry',
      version: 'current',
      outputIds: ['done'],
    })
    caller.diagram.components.push(ref)
    const graph = buildCombinedDiagram(boards, root(caller))
    const links = graph.edges.filter((edge) => edge.kind === 'reference')
    expect(links).toHaveLength(2)
    expect(links.find((edge) => edge.output)?.name).toBe('引用输出 · 完成事件')
    output.exposed = false
    const privateOutput = buildCombinedDiagram(boards, root(caller))
    expect(privateOutput.edges.filter((edge) => edge.kind === 'reference')).toHaveLength(1)
    expect(privateOutput.issues.some((issue) => issue.message.includes('对外输出'))).toBe(true)
  })

  it('缺失迭代不回退为现状或另一个迭代，缺失根图也可安全展示问题', () => {
    const source = board('source')
    source.diagram = startIteration(source.diagram, '当前迭代')
    const graph = buildCombinedDiagram([source], {
      boardId: source.id,
      version: 'iteration',
      iterationId: 'finished',
    })
    expect(graph.boards).toEqual([])
    expect(graph.issues[0].message).toMatch(/来源迭代/)
    expect(buildCombinedDiagram([], root(source)).issues[0].kind).toBe('missing')
  })

  it('超出画板上限时显式提示，并且所有已生成的连接端点仍存在', () => {
    const boards = ['a', 'b', 'c', 'd'].map(board)
    for (let i = 0; i < boards.length - 1; i++) reference(boards, boards[i], boards[i + 1])
    const graph = buildCombinedDiagram(boards, root(boards[0]), { maxBoards: 2 })
    expect(graph.boards).toHaveLength(2)
    expect(graph.truncated).toBe(true)
    expect(graph.issues.some((issue) => issue.kind === 'limit')).toBe(true)
    const ids = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId))).toBe(true)
  })

  it('画板边框容纳不同尺寸及负坐标的卡片，布局与追踪不改写原图', () => {
    const boards = ['a', 'b', 'c'].map(board)
    reference(boards, boards[0], boards[1])
    reference(boards, boards[0], boards[2])
    boards[0].diagram.components[0].position = { x: -500, y: -200 }
    boards[1].diagram.components[0] = {
      ...newComponent('validation'),
      id: 'entry',
      exposed: true,
      position: { x: 400, y: 600 },
    }
    const before = structuredClone(boards)
    const graph = buildCombinedDiagram(boards, root(boards[0]))
    for (const frame of graph.boards) {
      for (const node of graph.nodes.filter((node) => node.boardId === frame.id)) {
        expect(node.component.position.x).toBeGreaterThanOrEqual(frame.x)
        expect(node.component.position.y).toBeGreaterThanOrEqual(frame.y + 80)
        expect(node.component.position.x + COMPONENT_WIDTH).toBeLessThanOrEqual(
          frame.x + frame.width,
        )
        expect(node.component.position.y + componentHeight(node.component)).toBeLessThanOrEqual(
          frame.y + frame.height,
        )
      }
    }
    for (let i = 0; i < graph.boards.length; i++)
      for (let j = i + 1; j < graph.boards.length; j++) {
        const a = graph.boards[i]
        const b = graph.boards[j]
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true)
      }
    traceCombinedDiagram(graph, graph.nodes[0].id, 'downstream')
    expect(boards).toEqual(before)
  })

  it('跨引用追踪上下游，业务连线保持方向，循环不会重复遍历', () => {
    const [caller, source] = ['caller', 'source'].map(board)
    const boards = [caller, source]
    const ref = reference(boards, caller, source)
    const before = caller.diagram.components[0]
    const after = { ...newComponent('action'), id: 'after' }
    source.diagram.components.push(after)
    caller.diagram.connections.push(newConnection(before, ref))
    source.diagram.connections.push(newConnection(source.diagram.components[0], after))
    const graph = buildCombinedDiagram(boards, root(caller))
    const node = (boardId: string, componentId: string) =>
      graph.nodes.find(
        (node) => node.location.boardId === boardId && node.component.id === componentId,
      )!.id
    expect(traceCombinedDiagram(graph, node(caller.id, 'entry'), 'downstream')).toEqual(
      new Set(graph.nodes.map((node) => node.id)),
    )
    expect(traceCombinedDiagram(graph, node(source.id, 'after'), 'upstream')).toEqual(
      new Set(graph.nodes.map((node) => node.id)),
    )
    expect(traceCombinedDiagram(graph, node(source.id, 'after'), 'downstream')).toEqual(
      new Set([node(source.id, 'after')]),
    )
    expect(traceCombinedDiagram(graph, 'unknown', 'upstream')).toEqual(new Set())
    expect(combinedBoardKey(root(caller))).toBe(graph.rootKey)
  })

  it('按引用的具体输出端口追踪，不从输出回到入口或跳到其他分支', () => {
    const [caller, source] = ['caller', 'source'].map(board)
    const entry = { ...newComponent('api'), id: 'entry', exposed: true }
    const middle = { ...newComponent('action'), id: 'middle' }
    const output = { ...newComponent('event'), id: 'output', exposed: true }
    const sibling = { ...newComponent('event'), id: 'sibling', exposed: true }
    source.diagram.components = [entry, middle, output, sibling]
    source.diagram.connections = [
      newConnection(entry, middle),
      newConnection(middle, output),
      newConnection(entry, sibling),
    ]
    const boards = [caller, source]
    const ref = createReference(boards, caller.id, {
      boardId: source.id,
      componentId: entry.id,
      version: 'current',
      outputIds: [output.id, sibling.id],
    })
    const consumer = { ...newComponent('action'), id: 'consumer' }
    const siblingConsumer = { ...newComponent('action'), id: 'sibling-consumer' }
    const directConsumer = { ...newComponent('action'), id: 'direct-consumer' }
    caller.diagram.components.push(ref, consumer, siblingConsumer, directConsumer)
    caller.diagram.connections = [
      newConnection(caller.diagram.components[0], ref),
      {
        ...newConnection(ref, consumer),
        sourcePortId: exportedPortId(source.id, output.id),
      },
      {
        ...newConnection(ref, siblingConsumer),
        sourcePortId: exportedPortId(source.id, sibling.id),
      },
      newConnection(ref, directConsumer),
    ]
    const graph = buildCombinedDiagram(boards, root(caller))
    const node = (boardId: string, componentId: string) =>
      graph.nodes.find(
        (node) => node.location.boardId === boardId && node.component.id === componentId,
      )!.id
    const trace = (boardId: string, componentId: string, direction: 'upstream' | 'downstream') =>
      traceCombinedDiagram(graph, node(boardId, componentId), direction)
    expect(trace(source.id, middle.id, 'downstream')).toEqual(
      new Set([
        node(source.id, middle.id),
        node(source.id, output.id),
        node(caller.id, ref.id),
        node(caller.id, consumer.id),
      ]),
    )
    expect(trace(source.id, entry.id, 'upstream')).toEqual(
      new Set([node(source.id, entry.id), node(caller.id, ref.id), node(caller.id, 'entry')]),
    )
    expect(trace(caller.id, consumer.id, 'upstream')).toEqual(
      new Set([
        node(caller.id, consumer.id),
        node(caller.id, ref.id),
        node(caller.id, 'entry'),
        node(source.id, output.id),
        node(source.id, middle.id),
        node(source.id, entry.id),
      ]),
    )
    // The source's own port is distinct from both additionally exported events.
    expect(trace(caller.id, directConsumer.id, 'upstream')).toEqual(
      new Set([
        node(caller.id, directConsumer.id),
        node(caller.id, ref.id),
        node(caller.id, 'entry'),
        node(source.id, entry.id),
      ]),
    )
    expect(trace(source.id, sibling.id, 'downstream')).toEqual(
      new Set([
        node(source.id, sibling.id),
        node(caller.id, ref.id),
        node(caller.id, siblingConsumer.id),
      ]),
    )
  })

  it('来源缺失时继续按缓存引用卡追踪实际存在的本图连接', () => {
    const [caller, source] = ['caller', 'source'].map(board)
    const ref = reference([caller, source], caller, source)
    const consumer = { ...newComponent('action'), id: 'consumer' }
    caller.diagram.components.push(consumer)
    caller.diagram.connections = [
      newConnection(caller.diagram.components[0], ref),
      newConnection(ref, consumer),
    ]
    const graph = buildCombinedDiagram([caller], root(caller))
    const start = graph.nodes.find((node) => node.component.id === 'entry')!.id
    expect(traceCombinedDiagram(graph, start, 'downstream')).toEqual(
      new Set(graph.nodes.map((node) => node.id)),
    )
  })
})
