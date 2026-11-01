import { describe, expect, it } from 'vitest'
import {
  addAIContextItem,
  aiContextItemKey,
  aiContextItemLabel,
  aiContextItemSchema,
  createAIContextItem,
  MAX_AI_CONTEXT_ITEMS,
  type AIContextItem,
} from '../src/shared/ai-context'
import { exampleDiagram, removeComponent } from '../src/shared/diagram'
import { iterationView, startIteration } from '../src/shared/iteration'

describe('AI 画板对象引用', () => {
  it('捕获组件和连接的完整独立快照，连接带有端点及端口语义', () => {
    const graph = exampleDiagram()
    const component = createAIContextItem(graph, {
      kind: 'component',
      id: graph.components[0].id,
    })!
    const connection = createAIContextItem(graph, {
      kind: 'connection',
      id: graph.connections[0].id,
    })!
    expect(component).toEqual({ kind: 'component', component: graph.components[0] })
    expect(connection).toEqual({
      kind: 'connection',
      connection: graph.connections[0],
      source: graph.components[0],
      target: graph.components[1],
    })
    expect(aiContextItemSchema.parse(connection)).toEqual(connection)
    expect(aiContextItemLabel(connection)).toBe('用户信息表单 → 校验与注册：提交注册')
    graph.components[0].outputs[0].name = '后续端口修改'
    graph.connections[0].name = '后续连接修改'
    expect(connection.kind === 'connection' && connection.source.outputs[0].name).toBe('注册信息')
    expect(aiContextItemLabel(component)).toBe('用户信息表单')
    expect(aiContextItemLabel(connection)).toBe('用户信息表单 → 校验与注册：提交注册')
  })

  it('比较视图允许引用已删除组件和连接，但不会改变迭代草稿', () => {
    const baseline = exampleDiagram()
    const graph = removeComponent(startIteration(baseline, '下一迭代'), baseline.components[0].id)
    const before = structuredClone(graph)
    const overlay = iterationView(graph)
    expect(
      createAIContextItem(graph, { kind: 'component', id: baseline.components[0].id }),
    ).toBeNull()
    expect(
      createAIContextItem(overlay, { kind: 'component', id: baseline.components[0].id }),
    ).toMatchObject({ kind: 'component', component: { id: baseline.components[0].id } })
    expect(
      createAIContextItem(overlay, { kind: 'connection', id: baseline.connections[0].id }),
    ).toMatchObject({ kind: 'connection', connection: { id: baseline.connections[0].id } })
    expect(graph).toEqual(before)
  })

  it('未知对象和悬空端点不生成引用，存储模式拒绝不匹配的端点', () => {
    const graph = exampleDiagram()
    expect(createAIContextItem(graph, { kind: 'component', id: 'missing' })).toBeNull()
    expect(createAIContextItem(graph, { kind: 'connection', id: 'missing' })).toBeNull()
    const item = createAIContextItem(graph, { kind: 'connection', id: graph.connections[0].id })!
    expect(aiContextItemSchema.safeParse({ ...item, target: graph.components[2] }).success).toBe(
      false,
    )
    graph.components = []
    expect(
      createAIContextItem(graph, { kind: 'connection', id: graph.connections[0].id }),
    ).toBeNull()
  })

  it('重复加入刷新原位置的快照，组件与连接 ID 相同也分别保留，限制新增数量', () => {
    const graph = exampleDiagram()
    const component = createAIContextItem(graph, {
      kind: 'component',
      id: graph.components[0].id,
    })! as Extract<AIContextItem, { kind: 'component' }>
    graph.connections[0].id = component.component.id
    const connection = createAIContextItem(graph, {
      kind: 'connection',
      id: graph.connections[0].id,
    })!
    expect(addAIContextItem([component], connection)).toHaveLength(2)
    const items = Array.from({ length: MAX_AI_CONTEXT_ITEMS }, (_, index) => ({
      ...component,
      component: { ...component.component, id: `component-${index}` },
    }))
    expect(addAIContextItem(items, connection)).toBe(items)
    const updated = { ...items[0], component: { ...items[0].component, name: '最新名称' } }
    const next = addAIContextItem(items, updated)
    expect(next).toHaveLength(MAX_AI_CONTEXT_ITEMS)
    expect(next[0]).toBe(updated)
    expect(aiContextItemKey(next[0])).toBe('component:component-0')
  })
})
