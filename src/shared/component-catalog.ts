import { z } from 'zod'
import defaults from './default-component-catalog.json'
import {
  componentTypes,
  diagramSchema,
  newComponent,
  portSchema,
  type ComponentType,
  type Diagram,
  type GraphSnapshot,
  type DiagramComponent,
} from './diagram'

const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)
const name = z.string().trim().min(1, '请填写名称').max(80)
export const metadataFieldSchema = z
  .object({
    id,
    name,
    type: z.enum(['text', 'number', 'boolean']),
    required: z.boolean(),
    defaultValue: z.string().max(10000),
  })
  .strict()
export type MetadataField = z.infer<typeof metadataFieldSchema>
export function fieldValueError(field: MetadataField, value: string): string {
  if (!value.trim()) return field.required ? `请填写「${field.name}」` : ''
  if (
    field.type === 'number' &&
    (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) ||
      !Number.isFinite(Number(value)))
  )
    return `「${field.name}」必须是有效数字`
  if (field.type === 'boolean' && !['true', 'false'].includes(value))
    return `「${field.name}」必须选择是或否`
  return ''
}
export const componentTemplateSchema = z
  .object({
    id,
    name,
    type: z.enum(Object.keys(componentTypes) as [ComponentType, ...ComponentType[]]),
    description: z.string().max(10000),
    inputs: z.array(portSchema).max(32),
    outputs: z.array(portSchema).max(32),
    fields: z.array(metadataFieldSchema).max(32),
  })
  .strict()
  .superRefine((template, ctx) => {
    const ports = [...template.inputs, ...template.outputs]
    if (new Set(ports.map((p) => p.id)).size !== ports.length)
      ctx.addIssue({ code: 'custom', message: '端口 ID 不能重复' })
    if (
      new Set(template.fields.map((f) => f.id)).size !== template.fields.length ||
      new Set(template.fields.map((f) => f.name)).size !== template.fields.length
    )
      ctx.addIssue({ code: 'custom', message: '属性 ID 和名称不能重复' })
    for (const field of template.fields) {
      // Required fields may be filled when placing the component.
      const error = fieldValueError({ ...field, required: false }, field.defaultValue)
      if (error) ctx.addIssue({ code: 'custom', message: error })
    }
  })
export const scenarioSchema = z
  .object({
    id,
    name,
    description: z.string().max(10000),
    components: z.array(componentTemplateSchema).max(100),
  })
  .strict()
export const componentCatalogSchema = z
  .object({
    scenarios: z.array(scenarioSchema).min(1, '至少保留一个场景').max(50),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const scenes = catalog.scenarios
    if (!scenes.some((s) => s.id === 'general'))
      ctx.addIssue({ code: 'custom', message: '请保留 Web 应用默认场景' })
    if (
      new Set(scenes.map((s) => s.id)).size !== scenes.length ||
      new Set(scenes.map((s) => s.name)).size !== scenes.length
    )
      ctx.addIssue({ code: 'custom', message: '场景 ID 和名称不能重复' })
    const templates = scenes.flatMap((s) => s.components)
    if (new Set(templates.map((t) => t.id)).size !== templates.length)
      ctx.addIssue({ code: 'custom', message: '组件模板 ID 不能重复' })
    if (scenes.some((s) => new Set(s.components.map((t) => t.name)).size !== s.components.length))
      ctx.addIssue({ code: 'custom', message: '同一场景内组件名称不能重复' })
  })
export type ComponentTemplate = z.infer<typeof componentTemplateSchema>
export type ComponentScenario = z.infer<typeof scenarioSchema>
export type ComponentCatalog = z.infer<typeof componentCatalogSchema>
export const defaultComponentCatalog = componentCatalogSchema.parse(defaults)
export const scenarioId = (graph: GraphSnapshot) => graph.scenarioId
export const templateId = (component: DiagramComponent) => component.templateId
export const getScenario = (catalog: ComponentCatalog, graph: GraphSnapshot) =>
  catalog.scenarios.find((s) => s.id === scenarioId(graph))
export const getTemplate = (
  catalog: ComponentCatalog,
  graph: GraphSnapshot,
  component: DiagramComponent,
) =>
  (component.reference
    ? catalog.scenarios.flatMap((s) => s.components)
    : getScenario(catalog, graph)?.components
  )?.find((t) => t.id === templateId(component))
export const metadataValue = (component: DiagramComponent, field: MetadataField) =>
  component.metadata?.[field.id] ?? field.defaultValue

function snapshotCatalogError(graph: GraphSnapshot, catalog: ComponentCatalog): string {
  const scene = getScenario(catalog, graph)
  if (!scene) return '画板场景不存在，请先在组件设置中配置'
  for (const component of graph.components) {
    const template = getTemplate(catalog, graph, component)
    if (!template || template.type !== component.type)
      return `「${component.name}」不是「${scene.name}」中规定的组件`
    if (
      Object.keys(component.metadata ?? {}).some(
        (key) => !template.fields.some((f) => f.id === key),
      )
    )
      return `「${component.name}」包含未定义的属性`
    for (const field of template.fields) {
      const error = fieldValueError(field, metadataValue(component, field))
      if (error) return `组件「${component.name}」：${error}`
    }
  }
  return ''
}
export function catalogDiagramError(graph: Diagram, catalog: ComponentCatalog): string {
  for (const snapshot of [
    graph,
    graph.iteration?.baseline,
    ...graph.history.map((h) => h.snapshot),
  ]) {
    if (!snapshot) continue
    const error = snapshotCatalogError(snapshot, catalog)
    if (error) return error
  }
  return ''
}
export function parseCatalogDiagram(
  value: unknown,
  catalog: ComponentCatalog,
  expectedScene?: string,
): Diagram {
  const graph = diagramSchema.parse(value)
  // Import always uses the current board's scene; JSON cannot switch the allowlist.
  if (expectedScene && graph.scenarioId && graph.scenarioId !== expectedScene)
    throw new Error('导入的场景与当前画板不一致，请先切换画板场景')
  const result = expectedScene ? { ...graph, scenarioId: expectedScene } : graph
  const error = catalogDiagramError(result, catalog)
  if (error) throw new Error(error)
  return result
}
export function instantiateTemplate(
  template: ComponentTemplate,
  position = { x: 80, y: 80 },
): DiagramComponent {
  return {
    ...newComponent(template.type, position),
    templateId: template.id,
    name: template.name,
    description: template.description,
    inputs: template.inputs.map((p) => ({ ...p, id: crypto.randomUUID() })),
    outputs: template.outputs.map((p) => ({ ...p, id: crypto.randomUUID() })),
    metadata: Object.fromEntries(template.fields.map((f) => [f.id, f.defaultValue])),
  }
}
