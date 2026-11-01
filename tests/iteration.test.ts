import { describe, expect, it } from 'vitest'
import fixture from './fixtures/iteration-v2.json'
import workspaceFixture from './fixtures/workspace-v2.json'
import {
  diagramSchema,
  emptyDiagram,
  newComponent,
  replaceComponent,
  removeComponent,
} from '../src/shared/diagram'
import {
  defaultComponentCatalog,
  instantiateTemplate,
  parseCatalogDiagram,
} from '../src/shared/component-catalog'
import {
  startIteration,
  discardIteration,
  publishIteration,
  iterationChanges,
  iterationExample,
  affectedComponents,
} from '../src/shared/iteration'
import { parseWorkspace, saveComponentCatalog, updateNodeContent } from '../src/shared/model'

const graph = () => diagramSchema.parse(structuredClone(fixture))
describe('现状与迭代', () => {
  it('12 类模板与共享迭代样本通过完整校验；旧类型不再接受', () => {
    const components = defaultComponentCatalog.scenarios[0].components.map((t) =>
      instantiateTemplate(t),
    )
    expect(components).toHaveLength(12)
    expect(
      parseCatalogDiagram({ ...emptyDiagram(), components }, defaultComponentCatalog).components,
    ).toHaveLength(12)
    expect(parseCatalogDiagram(graph(), defaultComponentCatalog)).toEqual(fixture)
    expect(parseCatalogDiagram(iterationExample(), defaultComponentCatalog).iteration).toBeDefined()
    const invalid = graph()
    Object.assign(invalid.components[0], { type: 'custom' })
    expect(diagramSchema.safeParse(invalid).success).toBe(false)
  })
  it('创建独立基线，修改与删除端口不会改变原现状', () => {
    const original = { ...emptyDiagram(), components: [newComponent('action')] }
    const next = startIteration(original, '修改流程')
    const oldName = next.iteration!.baseline.components[0].name
    next.components[0].name = '新动作'
    expect(next.iteration!.baseline.components[0].name).toBe(oldName)
    const removed = replaceComponent(next, { ...next.components[0], inputs: [], outputs: [] })
    expect(removed.iteration!.baseline.components[0].inputs).toHaveLength(1)
    expect(() => startIteration(next, '另一个迭代')).toThrow('当前迭代')
  })
  it('识别组件及关系的增删改，删除自动清理关系且保持稳定身份', () => {
    const next = graph(),
      diff = iterationChanges(next)
    expect(diff.filter((c) => c.kind === 'component' && c.status === 'added')).toHaveLength(4)
    expect(diff.filter((c) => c.kind === 'component' && c.status === 'modified')).toHaveLength(4)
    expect(diff.find((c) => c.id === 'welcome')?.status).toBe('removed')
    expect(diff.find((c) => c.id === 'show-welcome')?.status).toBe('removed')
    const deleted = removeComponent(next, 'signup-page')
    expect(
      deleted.connections.some((e) => e.sourceId === 'signup-page' || e.targetId === 'signup-page'),
    ).toBe(false)
    expect(deleted.iteration!.baseline.components.some((c) => c.id === 'signup-page')).toBe(true)
    expect(affectedComponents(next).has('visitor')).toBe(true)
    expect(diff.find((c) => c.id === 'visitor')?.status).toBe('unchanged')
  })
  it('忽略布局与对象属性顺序；还原内容后取消修改标记', () => {
    const next = startIteration(
      {
        ...emptyDiagram(),
        components: [{ ...newComponent('data'), metadata: { fields: 'id', identity: 'id' } }],
      },
      '调整数据',
    )
    next.components[0].position.x += 100
    next.components[0].metadata = { identity: 'id', fields: 'id' }
    expect(iterationChanges(next)[0].status).toBe('unchanged')
    next.components[0].metadata.fields = 'id、phone'
    expect(iterationChanges(next)[0].fields).toEqual([
      { field: '属性 / fields', before: 'id', after: 'id、phone' },
    ])
    next.components[0].metadata.fields = 'id'
    expect(iterationChanges(next)[0].status).toBe('unchanged')
  })
  it('连接重定向和条件变动可对比；新增后删除不产生虚假差异', () => {
    const next = startIteration(discardIteration(graph()), '调整连线')
    next.connections[0].targetId = 'create-user'
    next.connections[0].condition = '已填写邮箱'
    const diff = iterationChanges(next).find((c) => c.id === 'scope')!
    expect(diff.status).toBe('modified')
    expect(diff.fields.map((f) => f.field)).toEqual(['终点组件', '触发条件'])
    const transient = newComponent('action')
    next.components.push(transient)
    expect(
      iterationChanges(removeComponent(next, transient.id)).some((c) => c.id === transient.id),
    ).toBe(false)
  })
  it('放弃恢复现状；更新现状保留历史且下一次迭代使用新基线', () => {
    const next = graph(),
      baseline = structuredClone(next.iteration!.baseline)
    const discarded = discardIteration(next)
    expect(discarded.components).toEqual(baseline.components)
    expect(discarded.iteration).toBeUndefined()
    const published = publishIteration(next)
    expect(published.components).toEqual(next.components)
    expect(published.history[0].snapshot).toEqual(baseline)
    expect(published.iteration).toBeUndefined()
    const following = startIteration(published, '下一次迭代')
    expect(iterationChanges(following).every((c) => c.status === 'unchanged')).toBe(true)
    expect(parseCatalogDiagram(published, defaultComponentCatalog)).toEqual(published)
  })
  it('基线和历史完整校验，模板不能破坏已保存的历史', () => {
    const invalid = graph()
    invalid.iteration!.baseline.connections[0].targetId = 'missing'
    expect(diagramSchema.safeParse(invalid).success).toBe(false)
    const published = publishIteration(graph())
    published.history[0].snapshot!.scenarioId = 'missing'
    expect(diagramSchema.safeParse(published).success).toBe(false)
    let workspace = parseWorkspace(workspaceFixture)
    workspace = updateNodeContent(workspace, 'leads', (c) => ({
      ...c,
      diagram: publishIteration(graph()),
    }))
    const catalog = structuredClone(defaultComponentCatalog)
    catalog.scenarios[0].components = catalog.scenarios[0].components.filter((t) => t.type !== 'ui')
    expect(() => saveComponentCatalog(workspace, catalog)).toThrow()
    expect(parseWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace)
  })
})
