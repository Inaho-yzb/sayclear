import { describe, expect, it } from 'vitest'
import fixture from './fixtures/component-catalog.json'
import workspaceFixture from './fixtures/workspace-v2.json'
import {
  componentCatalogSchema,
  defaultComponentCatalog,
  instantiateTemplate,
  parseCatalogDiagram,
} from '../src/shared/component-catalog'
import { diagramSchema, exampleDiagram } from '../src/shared/diagram'
import { parseWorkspace, saveComponentCatalog, updateNodeContent } from '../src/shared/model'

const catalog = () => componentCatalogSchema.parse(structuredClone(fixture.catalog))
const graph = () => diagramSchema.parse(structuredClone(fixture.diagram))

describe('按场景定义组件', () => {
  it('旧画板兼容默认组件库，新实例复制端口和属性且保持独立 ID', () => {
    expect(parseCatalogDiagram(exampleDiagram(), defaultComponentCatalog).components).toHaveLength(
      4,
    )
    const template = catalog().scenarios[1].components[0]
    const a = instantiateTemplate(template),
      b = instantiateTemplate(template)
    expect(a.id).not.toBe(b.id)
    expect(a.inputs[0].id).not.toBe(b.inputs[0].id)
    expect(a.templateId).toBe(template.id)
    expect(a.metadata).toEqual({ assignee: '', timeout: '30', retry: 'false' })
    a.inputs[0].name = '新输入'
    expect(template.inputs[0].name).toBe('申请')
    expect(parseCatalogDiagram(graph(), catalog())).toEqual(fixture.diagram)
  })

  it('新增、复制及导入不能混入其他场景、未知模板或伪造类型', () => {
    const wrong = graph()
    wrong.components.push(...exampleDiagram().components)
    expect(() => parseCatalogDiagram(wrong, catalog())).toThrow('规定的组件')
    const forged = graph()
    forged.components[0].type = 'store'
    expect(() => parseCatalogDiagram(forged, catalog())).toThrow('规定的组件')
    const unknown = graph()
    unknown.components[0].templateId = 'unknown'
    expect(() => parseCatalogDiagram(unknown, catalog())).toThrow('规定的组件')
    expect(() => parseCatalogDiagram(exampleDiagram(), catalog(), 'approval')).toThrow(
      '场景与当前画板不一致',
    )
    expect(() => parseCatalogDiagram(graph(), catalog(), 'general')).toThrow('场景与当前画板不一致')
    const missing = graph()
    missing.scenarioId = 'missing'
    expect(() => parseCatalogDiagram(missing, catalog())).toThrow('场景不存在')
  })

  it('验证必填属性、属性类型、未定义的属性，允许使用模板默认值', () => {
    const invalidValues: Record<string, string>[] = [
      { assignee: '' },
      { assignee: '财务', timeout: 'NaN' },
      { assignee: '财务', retry: 'yes' },
      { assignee: '财务', unregistered: 'x' },
    ]
    for (const metadata of invalidValues) {
      const invalid = graph()
      invalid.components[0].metadata = metadata
      expect(() => parseCatalogDiagram(invalid, catalog())).toThrow()
    }
    const defaults = graph()
    defaults.components[0].metadata = { assignee: '财务' }
    expect(() => parseCatalogDiagram(defaults, catalog())).not.toThrow()
    const bad = catalog()
    bad.scenarios[1].components[0].fields[1].defaultValue = 'abc'
    expect(componentCatalogSchema.safeParse(bad).success).toBe(false)
  })

  it('修改组件库前检查所有画板，不允许删除正在使用的定义或破坏属性', () => {
    let workspace = saveComponentCatalog(parseWorkspace(workspaceFixture), catalog())
    workspace = updateNodeContent(workspace, 'leads', (c) => ({ ...c, diagram: graph() }))
    expect(parseWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace)
    const deleted = catalog()
    deleted.scenarios.pop()
    expect(() => saveComponentCatalog(workspace, deleted)).toThrow('仍在使用')
    const removedTemplate = catalog()
    removedTemplate.scenarios[1].components = []
    expect(() => saveComponentCatalog(workspace, removedTemplate)).toThrow('规定的组件')
    const changed = catalog()
    changed.scenarios[1].components[0].fields.push({
      id: 'new',
      name: '新属性',
      type: 'text',
      required: true,
      defaultValue: '',
    })
    expect(() => saveComponentCatalog(workspace, changed)).toThrow('新属性')
    changed.scenarios[1].components[0].fields[3].defaultValue = '默认值'
    expect(() => saveComponentCatalog(workspace, changed)).not.toThrow()
    // Detached content must continue to protect its template.
    workspace.systems[0].architecture.boards = []
    workspace.activeNodeId = workspace.systems[0].architecture.id
    expect(() => saveComponentCatalog(workspace, deleted)).toThrow('仍在使用')
  })

  it('拒绝重名场景、重复模板 ID 和重复属性，允许空场景', () => {
    const duplicate = catalog()
    duplicate.scenarios[1].components.push(duplicate.scenarios[1].components[0])
    expect(componentCatalogSchema.safeParse(duplicate).success).toBe(false)
    const duplicateScene = catalog()
    duplicateScene.scenarios[1].name = duplicateScene.scenarios[0].name
    expect(componentCatalogSchema.safeParse(duplicateScene).success).toBe(false)
    const duplicateField = catalog()
    duplicateField.scenarios[1].components[0].fields[1].name = '负责人'
    expect(componentCatalogSchema.safeParse(duplicateField).success).toBe(false)
    const empty = catalog()
    empty.scenarios[1].components = []
    expect(() =>
      parseCatalogDiagram(
        { schemaVersion: 2, history: [], scenarioId: 'approval', components: [], connections: [] },
        empty,
      ),
    ).not.toThrow()
  })
})
