import { getTemplate, type ComponentCatalog } from './component-catalog'
import {
  componentTypes,
  connectionTypes,
  type GraphSnapshot,
  type DiagramReference,
} from './diagram'
import { type ExportChange } from './export'
import { describeValidation, type Validation } from './validation'

export type MarkdownReviewContext = {
  before: GraphSnapshot | null
  after: GraphSnapshot
  catalog: ComponentCatalog
  boardNames: ReadonlyMap<string, string>
}

const escape = (value: string) => value.replace(/[\\`*_[\]<>#|]/g, '\\$&')
const quote = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `> ${escape(line)}`)
    .join('\n')
const componentName = (graph: GraphSnapshot, id: unknown) =>
  graph.components.find((component) => component.id === id)?.name ?? String(id)
const portName = (graph: GraphSnapshot, id: unknown) =>
  graph.components
    .flatMap((component) => [...component.inputs, ...component.outputs])
    .find((port) => port.id === id)?.name ?? String(id)

function readable(
  value: unknown,
  key: string,
  graph: GraphSnapshot,
  change: ExportChange,
  context: MarkdownReviewContext,
): string {
  if (value === null || value === undefined) return '未设置'
  if (value === '') return '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (key === 'type')
    return (
      (change.kind === 'component'
        ? componentTypes[value as keyof typeof componentTypes]
        : connectionTypes[value as keyof typeof connectionTypes]) ?? String(value)
    )
  if (key === 'boundary') return value === 'external' ? '系统外部' : '系统内部'
  if (['ownerId', 'sourceId', 'targetId'].includes(key)) return componentName(graph, value)
  if (['sourcePortId', 'targetPortId'].includes(key)) return portName(graph, value)
  if (Array.isArray(value))
    return value.length
      ? value
          .map((item, index) => {
            if (item && typeof item === 'object' && 'name' in item)
              return `${index + 1}. ${item.name}${item.dataType ? `（${item.dataType}）` : ''}${item.description ? `：${item.description}` : ''}`
            return `${index + 1}. ${readable(item, '', graph, change, context)}`
          })
          .join('\n')
      : '无'
  if (typeof value === 'object') {
    if (key === 'validation') return describeValidation(value as Validation)
    if (key === 'reference') {
      const ref = value as DiagramReference
      const version =
        ref.version === 'history'
          ? `固定历史 ${ref.historyId}`
          : ref.version === 'iteration'
            ? '本次迭代'
            : '现状'
      return `${context.boardNames.get(ref.boardId) ?? ref.boardId} · ${version}`
    }
    return (
      Object.entries(value)
        .map(([name, content]) => `${name}：${readable(content, '', graph, change, context)}`)
        .join('\n') || '无'
    )
  }
  return String(value)
}

function businessSummary(change: ExportChange, context: MarkdownReviewContext): string[] {
  const item = change.after ?? change.before!
  const graph = change.after ? context.after : (context.before ?? context.after)
  const lines: string[] = []
  const add = (label: string, key: string, value: unknown) => {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length)
    )
      return
    lines.push(`**${label}**`, '', quote(readable(value, key, graph, change, context)), '')
  }
  add('类型', 'type', item.type)
  add('说明', 'description', item.description)
  if ('sourceId' in item) {
    add(
      '连接方向',
      '',
      `${componentName(graph, item.sourceId)}${item.sourcePortId ? `（${portName(graph, item.sourcePortId)}）` : ''} → ${componentName(graph, item.targetId)}${item.targetPortId ? `（${portName(graph, item.targetPortId)}）` : ''}`,
    )
    add('协议', 'protocol', item.protocol)
    add('触发条件', 'condition', item.condition)
  } else {
    if (item.boundary === 'external') add('边界', 'boundary', item.boundary)
    if (item.exposed) add('对外开放', 'exposed', true)
    add('归属', 'ownerId', item.ownerId)
    add('输入端口', 'inputs', item.inputs)
    add('输出端口', 'outputs', item.outputs)
    add('校验规则', 'validation', item.validation)
    add('引用来源', 'reference', item.reference)
    const template = getTemplate(context.catalog, graph, item)
    for (const [key, value] of Object.entries(item.metadata ?? {}))
      add(template?.fields.find((field) => field.id === key)?.name ?? key, '', value)
  }
  return lines
}

/** Human-facing change notes. Full object snapshots belong in changes.json. */
export function renderChangeMarkdown(change: ExportChange, context: MarkdownReviewContext): string {
  if (change.status !== 'modified') return businessSummary(change, context).join('\n')
  return change.fields
    .flatMap((field) => {
      const key = field.path.startsWith('/metadata/') ? '' : field.path.slice(1)
      return [
        `#### ${escape(field.label)}`,
        '',
        '**变更前**',
        '',
        quote(
          field.beforeExists
            ? readable(field.before, key, context.before ?? context.after, change, context)
            : '未设置',
        ),
        '',
        '**变更后**',
        '',
        quote(
          field.afterExists ? readable(field.after, key, context.after, change, context) : '未设置',
        ),
        '',
      ]
    })
    .join('\n')
}
