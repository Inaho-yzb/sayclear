import { z } from 'zod'
import { componentSchema, connectionSchema, type Diagram } from './diagram'

export const MAX_AI_CONTEXT_ITEMS = 20
export type AIContextTarget = { kind: 'component' | 'connection'; id: string }
export const aiContextItemSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('component'), component: componentSchema }).strict(),
    z
      .object({
        kind: z.literal('connection'),
        connection: connectionSchema,
        source: componentSchema,
        target: componentSchema,
      })
      .strict(),
  ])
  .superRefine((item, ctx) => {
    if (
      item.kind === 'connection' &&
      (item.source.id !== item.connection.sourceId || item.target.id !== item.connection.targetId)
    )
      ctx.addIssue({ code: 'custom', message: '引用连接的端点与组件不一致' })
  })
export type AIContextItem = z.infer<typeof aiContextItemSchema>

export function createAIContextItem(graph: Diagram, target: AIContextTarget): AIContextItem | null {
  if (target.kind === 'component') {
    const component = graph.components.find((component) => component.id === target.id)
    return component ? structuredClone({ kind: 'component', component }) : null
  }
  const connection = graph.connections.find((connection) => connection.id === target.id)
  if (!connection) return null
  const source = graph.components.find((component) => component.id === connection.sourceId)
  const destination = graph.components.find((component) => component.id === connection.targetId)
  return source && destination
    ? structuredClone({ kind: 'connection', connection, source, target: destination })
    : null
}

export function aiContextItemId(item: AIContextItem): string {
  return item.kind === 'component' ? item.component.id : item.connection.id
}

export function aiContextItemKey(item: AIContextItem): string {
  return `${item.kind}:${aiContextItemId(item)}`
}

export function aiContextItemLabel(item: AIContextItem): string {
  return item.kind === 'component'
    ? item.component.name
    : `${item.source.name} → ${item.target.name}：${item.connection.name}`
}

export function addAIContextItem(items: AIContextItem[], item: AIContextItem): AIContextItem[] {
  const key = aiContextItemKey(item)
  if (items.some((existing) => aiContextItemKey(existing) === key))
    return items.map((existing) => (aiContextItemKey(existing) === key ? item : existing))
  return items.length < MAX_AI_CONTEXT_ITEMS ? [...items, item] : items
}
