import { describe, expect, it } from 'vitest'
import fixture from './fixtures/diagram-v2.json'
import workspaceFixture from './fixtures/workspace-v2.json'
import {
  diagramSchema,
  exampleDiagram,
  newConnection,
  newComponent,
  newPort,
  removeComponent,
  replaceComponent,
  traceComponents,
  layoutDiagram,
  componentHeight,
} from '../src/shared/diagram'
import {
  getProject,
  parseWorkspace,
  saveArchitecture,
  updateNodeContent,
} from '../src/shared/model'

const graph = () => diagramSchema.parse(structuredClone(fixture))

describe('系统图数据完整性', () => {
  it('共享样本和示例符合约束，数据保留在对应节点且不影响文档版本', () => {
    expect(diagramSchema.parse(fixture)).toEqual(fixture)
    expect(diagramSchema.parse(exampleDiagram()).connections).toHaveLength(3)
    const workspace = parseWorkspace(workspaceFixture)
    const original = getProject(workspace, 'leads')
    const updated = updateNodeContent(workspace, 'leads', (current) => ({
      ...current,
      diagram: graph(),
    }))
    expect(getProject(updated, 'leads').diagram).toEqual(fixture)
    expect(getProject(updated, 'leads').revision).toBe(original.revision)
    expect(getProject(updated, 'sales').diagram).toBeUndefined()
    const renamed = saveArchitecture(updated, {
      ...updated.systems[0].architecture,
      name: '重命名',
    })
    expect(
      getProject(parseWorkspace(JSON.parse(JSON.stringify(renamed))), 'leads').diagram,
    ).toEqual(fixture)
  })

  it('拒绝失效端点、反向端口、数据流缺少端口和重复连接', () => {
    for (const patch of [
      { sourceId: 'missing' },
      { targetPortId: 'id' },
      { sourcePortId: null },
      { targetId: 'form' },
    ]) {
      const g = graph()
      Object.assign(g.connections[0], patch)
      expect(diagramSchema.safeParse(g).success).toBe(false)
    }
    const g = graph()
    g.connections.push({ ...g.connections[0], id: 'duplicate' })
    expect(diagramSchema.safeParse(g).success).toBe(false)
    g.connections[1].type = 'event'
    expect(diagramSchema.safeParse(g).success).toBe(true)
  })

  it('拒绝重复 ID、孤立归属与循环归属，允许独立循环数据流', () => {
    const g = graph()
    g.components[0].ownerId = 'store'
    g.components[1].ownerId = 'form'
    expect(diagramSchema.safeParse(g).success).toBe(false)
    g.components[0].ownerId = 'missing'
    expect(diagramSchema.safeParse(g).success).toBe(false)
    g.components[0].ownerId = null
    expect(diagramSchema.safeParse(g).success).toBe(true)
    g.components[1].inputs.push({ ...g.components[1].outputs[0] })
    expect(diagramSchema.safeParse(g).success).toBe(false)
    const cyclic = exampleDiagram()
    cyclic.connections.push({
      ...newConnection(cyclic.components[2], cyclic.components[1]),
      type: 'control',
      sourcePortId: null,
      targetPortId: null,
    })
    expect(diagramSchema.safeParse(cyclic).success).toBe(true)
  })

  it('删除组件清理连接并解除子组件归属；删除端口只清理关联连接', () => {
    const g = graph()
    g.components[1].ownerId = 'form'
    const deleted = removeComponent(g, 'form')
    expect(deleted.components[0].ownerId).toBeNull()
    expect(deleted.connections).toHaveLength(0)
    expect(diagramSchema.parse(deleted)).toEqual(deleted)
    expect(g.components).toHaveLength(2)
    const noPort = replaceComponent(g, { ...g.components[1], inputs: [] })
    expect(noPort.connections).toHaveLength(0)
    const renamedPort = replaceComponent(g, {
      ...g.components[1],
      inputs: [{ ...g.components[1].inputs[0], name: '新名称' }],
    })
    expect(renamedPort.connections).toEqual(g.connections)
  })

  it('上下游追踪终止于访问过的节点，依赖允许组件级端点', () => {
    const g = exampleDiagram()
    const [a, b, c, d] = g.components
    g.connections.push({
      ...newConnection(c, b),
      type: 'dependency',
      sourcePortId: null,
      targetPortId: null,
    })
    expect(diagramSchema.safeParse(g).success).toBe(true)
    expect(traceComponents(g, a.id, 'downstream')).toEqual(new Set([a.id, b.id, c.id, d.id]))
    expect(traceComponents(g, a.id, 'upstream')).toEqual(new Set([a.id]))
    expect(traceComponents(g, c.id, 'upstream')).toEqual(new Set([a.id, b.id, c.id]))
  })

  it('自动布局覆盖孤立组件与循环，组件不重叠且连接保持不变', () => {
    const g = exampleDiagram()
    g.components.push(newComponent('service'))
    g.connections.push(newConnection(g.components[2], g.components[1]))
    const laid = layoutDiagram(g)
    expect(laid.connections).toEqual(g.connections)
    expect(diagramSchema.safeParse(laid).success).toBe(true)
    for (const a of laid.components)
      for (const b of laid.components) {
        if (a.id !== b.id && a.position.x === b.position.x) {
          expect(
            a.position.y + componentHeight(a) <= b.position.y ||
              b.position.y + componentHeight(b) <= a.position.y,
          ).toBe(true)
        }
      }
  })
  it('最大数量的长链与高端口组件仍在合法坐标范围内', () => {
    const components = Array.from({ length: 300 }, () => newComponent('action'))
    const chain = {
      schemaVersion: 2 as const,
      scenarioId: 'general',
      history: [],
      components,
      connections: components.slice(1).map((c, index) => newConnection(components[index], c)),
    }
    expect(diagramSchema.safeParse(layoutDiagram(chain)).success).toBe(true)
    const tall = {
      schemaVersion: 2 as const,
      scenarioId: 'general',
      history: [],
      connections: [],
      components: components.map((c) => ({
        ...c,
        inputs: Array.from({ length: 32 }, () => newPort('输入')),
      })),
    }
    expect(diagramSchema.safeParse(layoutDiagram(tall)).success).toBe(true)
  })
})
