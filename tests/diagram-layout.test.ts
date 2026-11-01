import { describe, expect, it } from 'vitest'
import {
  COMPONENT_WIDTH,
  componentHeight,
  diagramSchema,
  emptyDiagram,
  layoutDiagram,
  newComponent,
  newConnection,
  newPort,
  type Diagram,
  type DiagramComponent,
} from '../src/shared/diagram'
import { iterationExample, iterationView } from '../src/shared/iteration'

const node = (id: string, x: number, y: number): DiagramComponent => ({
  ...newComponent('action', { x, y }),
  id,
  inputs: [],
  outputs: [],
})
function diagram(components: DiagramComponent[], edges: [string, string][]): Diagram {
  return {
    ...emptyDiagram(),
    components,
    connections: edges.map(([source, target], i) => ({
      ...newConnection(
        components.find((c) => c.id === source)!,
        components.find((c) => c.id === target)!,
      ),
      id: `edge-${i}`,
    })),
  }
}
const positions = (graph: Diagram) =>
  Object.fromEntries(graph.components.map((c) => [c.id, c.position]))
const center = (graph: Diagram, id: string) => {
  const component = graph.components.find((c) => c.id === id)!
  return component.position.y + componentHeight(component) / 2
}
function expectSeparated(graph: Diagram) {
  for (const [i, a] of graph.components.entries())
    for (const b of graph.components.slice(i + 1))
      expect(
        a.position.x + COMPONENT_WIDTH <= b.position.x ||
          b.position.x + COMPONENT_WIDTH <= a.position.x ||
          a.position.y + componentHeight(a) <= b.position.y ||
          b.position.y + componentHeight(b) <= a.position.y,
        `${a.id} overlaps ${b.id}`,
      ).toBe(true)
}

describe('自动布局保持流程可读性', () => {
  it('保留截图中已有的二维注册流程，不把上下规则和左向短信调用重排成单向流程', () => {
    const graph = iterationExample()
    const before = structuredClone(graph)
    expect(layoutDiagram(graph)).toBe(graph)
    expect(iterationView(layoutDiagram(graph)).components.map((c) => [c.id, c.position])).toEqual(
      [
        ...graph.components,
        graph.iteration!.baseline.components.find((c) => c.id === 'welcome')!,
      ].map((c) => [c.id, c.position]),
    )
    expectSeparated(iterationView(graph))
    expect(graph).toEqual(before)
  })

  it('整理轻微错位和不足的间距，保留行列关系且一次完成对齐', () => {
    const graph = iterationExample()
    graph.components.find((c) => c.id === 'visitor')!.position.x += 12
    graph.components.find((c) => c.id === 'email-rule')!.position.y += 10
    graph.components.find((c) => c.id === 'registered')!.position.x += 8
    const laid = layoutDiagram(graph),
      p = positions(laid)
    expect(p.visitor.x).toBe(p.signup.x)
    expect(p['email-rule'].y).toBe(p.signup.y)
    expect(p.registered.x).toBe(p['user-data'].x)
    expect(layoutDiagram(laid)).toBe(laid)
    expectSeparated(iterationView(laid))
  })

  it('删除节点避让现有组件，重载后位置一致且不改写迭代基线', () => {
    const graph = iterationExample(),
      baseline = structuredClone(graph.iteration!.baseline)
    graph.components.find((c) => c.id === 'sms')!.position = {
      ...baseline.components.find((c) => c.id === 'welcome')!.position,
    }
    const view = iterationView(layoutDiagram(graph))
    expect(view.components).toHaveLength(11)
    expect(view.components.find((c) => c.id === 'welcome')!.position).not.toEqual(
      graph.components.find((c) => c.id === 'sms')!.position,
    )
    expectSeparated(view)
    expect(iterationView(JSON.parse(JSON.stringify(graph)))).toEqual(view)
    expect(graph.iteration!.baseline).toEqual(baseline)
    expect(
      iterationView(iterationExample()).components.find((c) => c.id === 'welcome')!.position,
    ).toEqual(baseline.components.find((c) => c.id === 'welcome')!.position)
  })

  it('重叠的迭代图重新布局时所有可见节点都不重叠，包括删除节点', () => {
    const graph = iterationExample()
    graph.components = graph.components.map((c) => ({ ...c, position: { x: 80, y: 80 } }))
    const laid = layoutDiagram(graph)
    expectSeparated(iterationView(laid))
    expect(layoutDiagram(laid)).toBe(laid)
    expect(laid.iteration).toBe(graph.iteration)
  })

  it('按已有上下位置保留平行分支，创建顺序不会让连线交叉', () => {
    const graph = diagram(
      [
        node('a', 0, 0),
        node('b', 0, 300),
        node('d', 400, 300),
        node('c', 400, 0),
        node('end', 800, 150),
      ],
      [
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'end'],
        ['d', 'end'],
      ],
    )
    const laid = layoutDiagram(graph),
      p = positions(laid)
    expect(p.a.y).toBeLessThan(p.b.y)
    expect(p.c.y).toBeLessThan(p.d.y)
    expect(p.a.y).toBe(p.c.y)
    expect(p.b.y).toBe(p.d.y)
    expect(center(laid, 'end')).toBe((center(laid, 'c') + center(laid, 'd')) / 2)
    expect(
      positions(
        layoutDiagram({
          ...graph,
          components: [...graph.components].reverse(),
          connections: [...graph.connections].reverse(),
        }),
      ),
    ).toEqual(p)
    expect(layoutDiagram(laid)).toBe(laid)
  })

  it('回路保持从左到右的阅读顺序，回路后续流程继续分层', () => {
    const graph = diagram(
      [node('end', 1200, 0), node('b', 400, 0), node('c', 800, 0), node('start', 0, 0)],
      [
        ['start', 'b'],
        ['b', 'c'],
        ['c', 'b'],
        ['c', 'end'],
      ],
    )
    const laid = layoutDiagram(graph),
      p = positions(laid)
    expect(p.start.x).toBeLessThan(p.b.x)
    expect(p.b.x).toBeLessThan(p.c.x)
    expect(p.c.x).toBeLessThan(p.end.x)
    expect(laid.connections).toEqual(graph.connections)
    expect(layoutDiagram(laid)).toBe(laid)
    expectSeparated(laid)
  })

  it('高度不同的校验和引用组件保留间距，主节点居中对齐分支', () => {
    const validation = { ...newComponent('validation', { x: 400, y: 0 }), id: 'check' }
    const reference = {
      ...node('reference', 400, 500),
      reference: {
        boardId: 'other-board',
        componentId: 'entry',
        version: 'current' as const,
        outputIds: [],
        definitionHash: '0123456789abcdef',
      },
    }
    const graph = diagram(
      [node('start', 0, 150), reference, validation],
      [
        ['start', 'check'],
        ['start', 'reference'],
      ],
    )
    const laid = layoutDiagram(graph)
    expect(diagramSchema.safeParse(laid).success).toBe(true)
    expect(center(laid, 'start')).toBeCloseTo(
      (center(laid, 'check') + center(laid, 'reference')) / 2,
      1,
    )
    expectSeparated(laid)
    expect(layoutDiagram(laid)).toBe(laid)
  })

  it('互不相关的流程分组摆放，孤立组件不会挤在一根长列里', () => {
    const graph = diagram(
      [
        node('a', 0, 0),
        node('b', 400, 500),
        node('c', 0, 250),
        node('d', 400, 250),
        ...Array.from({ length: 12 }, (_, i) => node(`isolated-${i}`, 0, 800 + i * 200)),
      ],
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    )
    const laid = layoutDiagram(graph),
      p = positions(laid)
    expect(p.a.y).toBe(p.b.y)
    expect(p.c.y).toBe(p.d.y)
    expect(
      new Set(laid.components.filter((c) => c.id.startsWith('isolated')).map((c) => c.position.x))
        .size,
    ).toBeGreaterThan(1)
    expectSeparated(laid)
    expect(layoutDiagram(laid)).toBe(laid)
  })

  it('只修改坐标，连续点击不再移动组件或改变迭代与历史', () => {
    const graph = iterationExample(),
      original = structuredClone(graph),
      laid = layoutDiagram(graph)
    expect(graph).toEqual(original)
    expect({
      ...laid,
      components: laid.components.map((c, i) => ({ ...c, position: graph.components[i].position })),
    }).toEqual(graph)
    expect(laid.iteration).toBe(graph.iteration)
    expect(laid.history).toBe(graph.history)
    expectSeparated(laid)
    expect(layoutDiagram(laid)).toBe(laid)
  })

  it('最大数量的高组件分支换列后仍不重叠、坐标合法且重复布局稳定', () => {
    const components = Array.from({ length: 300 }, (_, i) => ({
      ...node(`node-${i.toString().padStart(3, '0')}`, 0, i),
      inputs: Array.from({ length: 32 }, () => newPort('输入')),
    }))
    const graph = diagram(
      components,
      components.slice(1).map((c) => [components[0].id, c.id]),
    )
    const laid = layoutDiagram(graph)
    expect(diagramSchema.safeParse(laid).success).toBe(true)
    expectSeparated(laid)
    expect(layoutDiagram(laid)).toBe(laid)
  })

  it('空画板无需修改', () => {
    const graph = emptyDiagram()
    expect(layoutDiagram(graph)).toBe(graph)
  })
})
