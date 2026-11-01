import { describe, expect, it } from 'vitest'
import {
  emptyDiagram,
  newComponent,
  newConnection,
  newPort,
  diagramSchema,
  replaceComponent,
} from '../src/shared/diagram'
import {
  createReference,
  exportedPortId,
  incomingReferences,
  referenceBoards,
  resolveReference,
  type Board,
} from '../src/shared/diagram-references'
import {
  startIteration,
  publishIteration,
  discardIteration,
  snapshot,
} from '../src/shared/iteration'
import { createArchitecture, buildSystem, workspaceSchema, deleteSystem } from '../src/shared/model'
import { defaultComponentCatalog, parseCatalogDiagram } from '../src/shared/component-catalog'
function setup() {
  const capability = {
    ...newComponent('capability'),
    id: 'signup',
    name: '用户注册',
    exposed: true,
  }
  const event = {
    ...newComponent('event'),
    id: 'registered',
    name: '注册成功',
    exposed: true,
    metadata: { payload: 'userId' },
  }
  const source: Board = {
    id: 'signup-board',
    name: '注册功能图',
    path: '应用 / 注册功能图',
    diagram: { ...emptyDiagram(), components: [capability, event] },
  }
  const target: Board = {
    id: 'account-board',
    name: '账户初始化',
    path: '应用 / 账户初始化',
    diagram: emptyDiagram(),
  }
  const boards = [source, target]
  const ref = createReference(boards, target.id, {
    boardId: source.id,
    componentId: capability.id,
    version: 'current',
    outputIds: [event.id],
  })
  target.diagram.components = [ref]
  return { boards, source, target, capability, event, ref }
}
describe('跨画板引用', () => {
  it('保留业务类型并从公开事件产生稳定输出，源名称和载荷变化可检测，移动位置不算变化', () => {
    const { boards, source, capability, event, ref } = setup()
    expect(ref.type).toBe('capability')
    expect(ref.outputs[0]).toMatchObject({
      id: exportedPortId(source.id, event.id),
      name: '注册成功',
      dataType: 'event',
    })
    expect(resolveReference(boards, ref).status).toBe('ok')
    capability.position.x += 80
    source.name = '注册服务设计'
    expect(resolveReference(boards, ref).status).toBe('ok')
    event.metadata.payload = 'userId,eventId'
    expect(resolveReference(boards, ref).status).toBe('changed')
    capability.name = '新用户注册'
    const next = resolveReference(boards, ref).next!
    expect(next.name).toBe('新用户注册')
    expect(next.outputs[0].id).toBe(ref.outputs[0].id)
    expect(ref.name).toBe('用户注册')
    expect(resolveReference(boards, next).status).toBe('ok')
  })
  it('现状引用不读取草稿，迭代引用锁定具体迭代，发布或放弃后要求重新选版本', () => {
    const { boards, source, target, ref } = setup()
    source.diagram = startIteration(source.diagram, '手机号注册')
    source.diagram.components = source.diagram.components.map((c) => ({
      ...c,
      name: '草稿' + c.name,
    }))
    expect(resolveReference(boards, ref).status).toBe('ok')
    const draft = createReference(boards, target.id, {
      ...ref.reference!,
      version: 'iteration',
      iterationId: source.diagram.iteration!.id,
    })
    expect(draft.name).toBe('草稿用户注册')
    const saved = structuredClone(source.diagram)
    source.diagram = publishIteration(source.diagram)
    expect(resolveReference(boards, ref).status).toBe('changed')
    expect(resolveReference(boards, draft).status).toBe('missing')
    source.diagram = discardIteration(saved)
    expect(resolveReference(boards, draft).status).toBe('missing')
    expect(resolveReference(boards, ref).status).toBe('ok')
  })
  it('取消开放、删除输出、删除来源都保留已采用定义和连线，并能找到反向引用', () => {
    const { boards, source, target, event, ref } = setup()
    const action = newComponent('action')
    const edge = { ...newConnection(ref, action), type: 'event' as const }
    target.diagram.components.push(action)
    target.diagram.connections.push(edge)
    expect(incomingReferences(boards, source.id, event.id)).toHaveLength(1)
    event.exposed = false
    expect(resolveReference(boards, ref).message).toMatch(/对外输出/)
    expect(diagramSchema.parse(target.diagram).connections).toHaveLength(1)
    source.diagram.components = []
    expect(resolveReference(boards, ref).status).toBe('missing')
    expect(resolveReference([target], ref).status).toBe('missing')
    expect(ref.outputs[0].name).toBe('注册成功')
  })
  it('仅显式更新才变更快照；移除端口清理对应连接，基线与历史保持原定义', () => {
    const { boards, source, target, capability, ref } = setup()
    capability.outputs = [newPort('注册结果')]
    const adopted = resolveReference(boards, ref).next!
    const action = newComponent('action')
    target.diagram.components = [adopted, action]
    target.diagram.connections = [{ ...newConnection(adopted, action), type: 'event' }]
    target.diagram = startIteration(target.diagram, '更新引用')
    const baseline = structuredClone(target.diagram.iteration!.baseline)
    capability.outputs = []
    const refreshed = resolveReference(boards, adopted).next!
    target.diagram = replaceComponent(target.diagram, refreshed)
    expect(target.diagram.connections).toHaveLength(0)
    expect(target.diagram.iteration!.baseline).toEqual(baseline)
    expect(publishIteration(target.diagram).history[0].snapshot).toEqual(baseline)
    expect(incomingReferences(boards, source.id)).toHaveLength(2)
  })
  it('拒绝内部对象、自引用、转引、重复输出和缺少迭代标识', () => {
    const { boards, source, target, capability, ref } = setup()
    expect(() => createReference(boards, source.id, ref.reference!)).toThrow('其他画板')
    capability.exposed = false
    expect(() => createReference(boards, target.id, ref.reference!)).toThrow('对外开放')
    capability.exposed = true
    expect(() =>
      createReference(boards, target.id, {
        ...ref.reference!,
        outputIds: ['registered', 'registered'],
      }),
    ).toThrow()
    expect(() =>
      createReference(boards, target.id, { ...ref.reference!, version: 'iteration' }),
    ).toThrow()
    expect(
      diagramSchema.safeParse({ ...target.diagram, components: [{ ...ref, exposed: true }] })
        .success,
    ).toBe(false)
  })
  it('跨系统引用在持久化往返及来源系统删除后仍能加载；缺失来源是可修复状态', () => {
    const { source, target } = setup()
    const systems = [source, target].map((b) => {
      const arch = { ...createArchitecture(b.name), id: b.id }
      const sys = buildSystem(arch)
      sys.contents[0].diagram = b.diagram
      return sys
    })
    const workspace = workspaceSchema.parse({ schemaVersion: 2, activeNodeId: target.id, systems })
    expect(workspaceSchema.parse(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace)
    expect(referenceBoards(workspace)).toHaveLength(2)
    const deleted = deleteSystem(workspace, source.id)
    const boards = referenceBoards(deleted)
    expect(resolveReference(boards, boards[0].diagram.components[0]).status).toBe('missing')
  })
  it('允许引用其他场景的已定义模板，模板与属性仍须有效', () => {
    const { boards, source, target, capability } = setup()
    const catalog = structuredClone(defaultComponentCatalog)
    const template = {
      ...catalog.scenarios[0].components.find((t) => t.type === 'capability')!,
      id: 'special-capability',
    }
    catalog.scenarios.push({ id: 'special', name: '专用', description: '', components: [template] })
    source.diagram.scenarioId = 'special'
    capability.templateId = template.id
    const ref = createReference(boards, target.id, {
      boardId: source.id,
      componentId: capability.id,
      version: 'current',
      outputIds: [],
    })
    expect(() =>
      parseCatalogDiagram({ ...emptyDiagram(), components: [ref] }, catalog),
    ).not.toThrow()
    expect(() =>
      parseCatalogDiagram(
        { ...emptyDiagram(), components: [{ ...ref, templateId: 'missing' }] },
        catalog,
      ),
    ).toThrow()
    expect(snapshot({ ...emptyDiagram(), components: [ref] }).components[0].reference).toEqual(
      ref.reference,
    )
  })
})
