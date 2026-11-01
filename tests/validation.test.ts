import { describe, expect, it } from 'vitest'
import fixture from './fixtures/validation-v2.json'
import workspaceFixture from './fixtures/workspace-v2.json'
import { diagramSchema, emptyDiagram, newComponent, replaceComponent } from '../src/shared/diagram'
import {
  defaultComponentCatalog,
  instantiateTemplate,
  parseCatalogDiagram,
} from '../src/shared/component-catalog'
import { createReference, resolveReference, type Board } from '../src/shared/diagram-references'
import {
  discardIteration,
  iterationChanges,
  publishIteration,
  startIteration,
} from '../src/shared/iteration'
import { parseWorkspace, updateNodeContent } from '../src/shared/model'
import { validationStrategyLabel } from '../src/shared/validation'

const graph = () => diagramSchema.parse(structuredClone(fixture))
describe('校验节点', () => {
  it('默认模板带双出口及独立配置，空配置明确保留为待配置状态', () => {
    const template = defaultComponentCatalog.scenarios[0].components.find(
      (t) => t.type === 'validation',
    )!
    const a = instantiateTemplate(template),
      b = instantiateTemplate(template)
    expect(a.outputs.map((p) => p.name)).toEqual(['通过', '不通过'])
    expect(a.validation).toEqual({ passCondition: 'all', strategy: 'collectAll', rules: [] })
    a.validation!.rules.push(graph().components[0].validation!.rules[0])
    expect(b.validation!.rules).toEqual([])
    expect(
      parseCatalogDiagram({ ...emptyDiagram(), components: [a, b] }, defaultComponentCatalog)
        .components,
    ).toHaveLength(2)
  })
  it('规则、顺序及策略经过工作区序列化完整保留，端口改名保留连接', () => {
    const g = graph()
    g.connections.push({
      id: 'pass-edge',
      name: '通过后继续',
      type: 'control',
      sourceId: g.components[0].id,
      targetId: 'next',
      sourcePortId: 'pass',
      targetPortId: null,
      description: '',
      protocol: '',
      condition: '校验通过',
    })
    g.components.push({ ...newComponent('action'), id: 'next' })
    const workspace = updateNodeContent(parseWorkspace(workspaceFixture), 'leads', (c) => ({
      ...c,
      diagram: g,
    }))
    expect(parseWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace)
    const c = structuredClone(g.components[0])
    c.outputs[0].name = '校验通过'
    expect(replaceComponent(g, c).connections).toEqual(g.connections)
    c.outputs.shift()
    expect(replaceComponent(g, c).connections).toEqual([])
  })
  it('拒绝未知策略、重复规则 ID、空白条件及超限规则，包括基线和历史', () => {
    const invalids = [
      { ...fixture.components[0].validation, passCondition: 'custom' },
      { ...fixture.components[0].validation, strategy: 'parallel' },
      {
        ...fixture.components[0].validation,
        rules: [
          fixture.components[0].validation.rules[0],
          fixture.components[0].validation.rules[0],
        ],
      },
      {
        ...fixture.components[0].validation,
        rules: [{ ...fixture.components[0].validation.rules[0], condition: '   ' }],
      },
      {
        ...fixture.components[0].validation,
        rules: Array.from({ length: 33 }, (_, i) => ({
          ...fixture.components[0].validation.rules[0],
          id: `r-${i}`,
        })),
      },
    ]
    for (const validation of invalids) {
      const invalid = { ...graph(), components: [{ ...graph().components[0], validation }] }
      expect(diagramSchema.safeParse(invalid).success).toBe(false)
      expect(
        diagramSchema.safeParse({
          ...startIteration(graph(), '变更'),
          iteration: {
            id: 'iteration',
            name: '变更',
            startedAt: '2026-10-31T00:00:00.000Z',
            baseline: {
              schemaVersion: 2,
              scenarioId: 'general',
              components: invalid.components,
              connections: [],
            },
          },
        }).success,
      ).toBe(false)
    }
    const missing = graph()
    delete missing.components[0].validation
    expect(diagramSchema.safeParse(missing).success).toBe(false)
    expect(
      diagramSchema.safeParse({
        ...graph(),
        components: [{ ...graph().components[0], type: 'rule' }],
      }).success,
    ).toBe(false)
    const published = publishIteration(startIteration(graph(), '变更'))
    published.history[0].snapshot!.components[0].validation!.rules[0].name = ''
    expect(diagramSchema.safeParse(published).success).toBe(false)
  })
  it('规则排序、条件和策略变动参与可读的迭代对比，放弃与历史保持原始定义', () => {
    const original = graph()
    const draft = startIteration(structuredClone(original), '修改校验')
    draft.components[0].validation!.rules.reverse()
    draft.components[0].validation!.passCondition = 'any'
    draft.components[0].validation!.strategy = 'stopWhenDecided'
    const change = iterationChanges(draft)[0]
    expect(change.status).toBe('modified')
    expect(change.fields[0].field).toBe('校验配置')
    expect(change.fields[0].before).toContain('1. 邮箱格式正确')
    expect(change.fields[0].after).toContain('1. 已同意用户协议')
    expect(change.fields[0].after).toContain('首条通过即停止')
    expect(discardIteration(draft).components).toEqual(original.components)
    expect(publishIteration(draft).history[0].snapshot!.components).toEqual(original.components)
    expect(
      validationStrategyLabel({ ...draft.components[0].validation!, passCondition: 'all' }),
    ).toBe('首条失败即停止')
  })
  it('公开校验节点的规则变更提示更新引用，缓存和历史规则不被源修改污染', () => {
    const source: Board = { id: 'source', name: '来源', path: '来源', diagram: graph() }
    source.diagram.components[0].exposed = true
    const ref = createReference([source], 'target', {
      boardId: source.id,
      componentId: source.diagram.components[0].id,
      version: 'current',
      outputIds: [],
    })
    expect(resolveReference([source], ref).status).toBe('ok')
    source.diagram.components[0].validation!.rules[0].condition = '新判断条件'
    expect(ref.validation!.rules[0].condition).not.toBe('新判断条件')
    const resolution = resolveReference([source], ref)
    expect(resolution.status).toBe('changed')
    expect(resolution.next!.validation!.rules[0].condition).toBe('新判断条件')
    expect(resolveReference([source], resolution.next!).status).toBe('ok')
  })
})
