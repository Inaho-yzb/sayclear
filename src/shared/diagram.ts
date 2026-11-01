import { iterationGitSchema } from './git'
import { z } from 'zod'
import { newValidation, validationSchema } from './validation'

export const componentTypes = {
  actor: '角色',
  capability: '能力',
  ui: '交互界面',
  action: '行为',
  rule: '规则',
  validation: '校验',
  data: '数据对象',
  state: '状态',
  event: '事件',
  api: '接口',
  service: '服务',
  store: '存储',
} as const
export const componentDescriptions: Record<keyof typeof componentTypes, string> = {
  actor: '谁使用系统、执行操作或承担职责，例如游客、用户、管理员。',
  capability: '系统提供的一项完整能力，例如用户注册、订单取消，可包含页面与流程。',
  ui: '用户看到或操作的载体，例如页面、表单、弹窗和反馈提示。',
  action: '用户或系统执行的动作，例如提交注册、发送验证码、创建账号。',
  rule: '处理必须满足的条件，例如手机号唯一、验证码有效、操作权限。',
  validation: '按顺序检查一组规则，明确整体通过条件、提前结束策略及通过 / 不通过分支。',
  data: '业务信息的结构与含义，例如用户、订单及其字段和约束。',
  state: '业务对象所处的阶段，例如待支付、已支付、已取消。',
  event: '发生的事实或触发信号，例如注册成功、支付完成、定时触发。',
  api: '前后端或系统间的交互契约，例如注册接口、支付回调。',
  service: '承担一组职责的实现单元，例如用户服务、订单模块、短信平台。',
  store: '数据的保存与访问位置，例如数据库、缓存、对象存储。',
}
export const connectionTypes = {
  control: '执行顺序',
  data: '数据流',
  dependency: '依赖',
  event: '事件传递',
  contains: '组成',
  calls: '调用',
  implements: '实现',
  reads: '读取',
  writes: '写入',
  constrains: '约束',
  transitions: '状态迁移',
} as const
export const connectionDescriptions: Record<keyof typeof connectionTypes, string> = {
  control: '先执行 → 后执行；分支条件写在触发条件中',
  data: '输出端口 → 输入端口',
  dependency: '使用方 → 被依赖方',
  event: '产生方 → 事件，或事件 → 响应方',
  contains: '整体 → 组成部分',
  calls: '调用方 → 接口或服务',
  implements: '实现单元 → 能力或接口',
  reads: '读取方 → 数据对象或存储',
  writes: '写入方 → 数据对象或存储',
  constrains: '规则 → 被约束对象',
  transitions: '原状态 → 新状态；条件描述触发事件',
}
export type ComponentType = keyof typeof componentTypes
export type ConnectionType = keyof typeof connectionTypes
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)
const name = z.string().trim().min(1, '请填写名称').max(80)
const description = z.string().max(10000)
export const portSchema = z
  .object({ id, name, dataType: z.string().max(120), description })
  .strict()
export const diagramReferenceSchema = z
  .object({
    boardId: id,
    componentId: id,
    version: z.enum(['current', 'iteration', 'history']),
    historyId: id.optional(),
    iterationId: id.optional(),
    outputIds: z.array(id).max(32),
    definitionHash: z.string().regex(/^[a-f0-9]{16}$/),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if ((ref.version === 'history') !== (ref.historyId !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: '历史引用必须指定历史版本，其他引用不能指定历史版本',
      })
    if ((ref.version === 'iteration') !== (ref.iterationId !== undefined))
      ctx.addIssue({ code: 'custom', message: '迭代引用必须指定迭代版本，现状引用不能指定迭代' })
    if (
      new Set(ref.outputIds).size !== ref.outputIds.length ||
      ref.outputIds.includes(ref.componentId)
    )
      ctx.addIssue({ code: 'custom', message: '引用的对外输出不能重复或包含入口本身' })
  })
export type DiagramReference = z.infer<typeof diagramReferenceSchema>
export const componentSchema = z
  .object({
    id,
    type: z.enum(Object.keys(componentTypes) as [ComponentType, ...ComponentType[]]),
    boundary: z.enum(['internal', 'external']),
    templateId: id,
    exposed: z.boolean().optional(),
    reference: diagramReferenceSchema.optional(),
    validation: validationSchema.optional(),
    metadata: z
      .record(id, z.string().max(10000))
      .refine((v) => Object.keys(v).length <= 32, '最多 32 个属性')
      .optional(),
    name,
    description,
    inputs: z.array(portSchema).max(32),
    outputs: z.array(portSchema).max(32),
    ownerId: id.nullable(),
    position: z
      .object({ x: z.number().min(-100000).max(100000), y: z.number().min(-100000).max(100000) })
      .strict(),
  })
  .strict()
  .superRefine((component, ctx) => {
    if ((component.type === 'validation') !== (component.validation !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: '校验组件必须配置校验策略，其他组件不能包含校验配置',
      })
  })
export const connectionSchema = z
  .object({
    id,
    name,
    type: z.enum(Object.keys(connectionTypes) as [ConnectionType, ...ConnectionType[]]),
    sourceId: id,
    targetId: id,
    sourcePortId: id.nullable(),
    targetPortId: id.nullable(),
    description,
    protocol: z.string().max(120),
    condition: z.string().max(1000),
  })
  .strict()
export const graphSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    scenarioId: id,
    components: z.array(componentSchema).max(300),
    connections: z.array(connectionSchema).max(1200),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const components = new Map(graph.components.map((c) => [c.id, c]))
    if (components.size !== graph.components.length) fail('组件 ID 不能重复')
    if (new Set(graph.connections.map((e) => e.id)).size !== graph.connections.length)
      fail('连接 ID 不能重复')
    for (const c of graph.components) {
      if (c.reference && c.exposed) fail('引用组件不能再次对外开放，请直接引用原始定义')
      const ports = [...c.inputs, ...c.outputs]
      if (new Set(ports.map((p) => p.id)).size !== ports.length) fail('同一组件的端口 ID 不能重复')
      const visited = new Set([c.id])
      let owner = c.ownerId
      while (owner !== null) {
        if (!components.has(owner)) {
          fail('归属组件不存在')
          break
        }
        if (visited.has(owner)) {
          fail('组件归属不能形成循环')
          break
        }
        visited.add(owner)
        owner = components.get(owner)!.ownerId
      }
    }
    const signatures = new Set<string>()
    for (const edge of graph.connections) {
      const source = components.get(edge.sourceId),
        target = components.get(edge.targetId)
      if (!source || !target) {
        fail('连接的起点或终点不存在')
        continue
      }
      if (edge.sourceId === edge.targetId) fail('请连接两个不同组件')
      if (edge.sourcePortId !== null && !source.outputs.some((p) => p.id === edge.sourcePortId))
        fail('起点必须是输出端口')
      if (edge.targetPortId !== null && !target.inputs.some((p) => p.id === edge.targetPortId))
        fail('终点必须是输入端口')
      if (edge.type === 'data' && (edge.sourcePortId === null || edge.targetPortId === null))
        fail('数据流需要指定输入和输出端口')
      const signature = JSON.stringify([
        edge.type,
        edge.sourceId,
        edge.sourcePortId,
        edge.targetId,
        edge.targetPortId,
      ])
      if (signatures.has(signature)) fail('相同类型和端点的连接已存在')
      signatures.add(signature)
    }
  })
export const diagramSchema = graphSnapshotSchema
  .safeExtend({
    iteration: z
      .object({
        id,
        name,
        startedAt: z.iso.datetime(),
        baseline: graphSnapshotSchema,
        git: iterationGitSchema.optional(),
      })
      .strict()
      .optional(),
    history: z
      .array(
        z
          .object({
            id,
            name,
            publishedAt: z.iso.datetime(),
            git: iterationGitSchema.optional(),
            snapshot: graphSnapshotSchema.optional(),
            componentCount: z.number().int().min(0).max(300).optional(),
            connectionCount: z.number().int().min(0).max(1200).optional(),
            snapshotDigest: z
              .string()
              .regex(/^[a-f0-9]{16}$/)
              .optional(),
          })
          .strict()
          .refine(
            (version) =>
              !!version.snapshot ||
              (version.componentCount !== undefined &&
                version.connectionCount !== undefined &&
                !!version.snapshotDigest),
            '历史版本缺少快照或索引',
          ),
      )
      .max(50),
  })
  .superRefine((graph, ctx) => {
    const snapshots = [graph.iteration?.baseline, ...graph.history.map((h) => h.snapshot)].filter(
      Boolean,
    )
    if (snapshots.some((s) => s!.scenarioId !== graph.scenarioId))
      ctx.addIssue({ code: 'custom', message: '现状、迭代与历史必须使用同一场景' })
    if (new Set(graph.history.map((h) => h.id)).size !== graph.history.length)
      ctx.addIssue({ code: 'custom', message: '历史版本 ID 不能重复' })
  })
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>
export type Diagram = z.infer<typeof diagramSchema>
export type DiagramComponent = z.infer<typeof componentSchema>
export type DiagramConnection = z.infer<typeof connectionSchema>
export type Port = z.infer<typeof portSchema>
export const emptyDiagram = (): Diagram => ({
  schemaVersion: 2,
  scenarioId: 'general',
  components: [],
  connections: [],
  history: [],
})
export const newPort = (name: string): Port => ({
  id: crypto.randomUUID(),
  name,
  dataType: 'object',
  description: '',
})
export function newComponent(type: ComponentType, position = { x: 80, y: 80 }): DiagramComponent {
  return {
    id: crypto.randomUUID(),
    type,
    boundary: 'internal',
    templateId: `builtin-${type}`,
    name: componentTypes[type],
    description: '',
    ...(type === 'validation' ? { validation: newValidation() } : {}),
    inputs: ['ui', 'action', 'api', 'service', 'store', 'validation'].includes(type)
      ? [newPort('输入')]
      : [],
    outputs:
      type === 'validation'
        ? [newPort('通过'), newPort('不通过')]
        : ['ui', 'action', 'api', 'service', 'store'].includes(type)
          ? [newPort('输出')]
          : [],
    ownerId: null,
    position,
  }
}
export function newConnection(
  source: DiagramComponent,
  target: DiagramComponent,
): DiagramConnection {
  const sourcePortId = source.outputs[0]?.id ?? null,
    targetPortId = target.inputs[0]?.id ?? null
  return {
    id: crypto.randomUUID(),
    name: '传递数据',
    type: sourcePortId && targetPortId ? 'data' : 'dependency',
    sourceId: source.id,
    targetId: target.id,
    sourcePortId,
    targetPortId,
    description: '',
    protocol: '',
    condition: '',
  }
}
export function removeComponent(graph: Diagram, id: string): Diagram {
  return {
    ...graph,
    components: graph.components
      .filter((c) => c.id !== id)
      .map((c) => (c.ownerId === id ? { ...c, ownerId: null } : c)),
    connections: graph.connections.filter((e) => e.sourceId !== id && e.targetId !== id),
  }
}
export function replaceComponent(graph: Diagram, component: DiagramComponent): Diagram {
  // Deleting a port also removes its incident connections; never silently reconnect data.
  return {
    ...graph,
    components: graph.components.map((c) => (c.id === component.id ? component : c)),
    connections: graph.connections.filter(
      (e) =>
        !(
          e.sourceId === component.id &&
          e.sourcePortId &&
          !component.outputs.some((p) => p.id === e.sourcePortId)
        ) &&
        !(
          e.targetId === component.id &&
          e.targetPortId &&
          !component.inputs.some((p) => p.id === e.targetPortId)
        ),
    ),
  }
}
export function traceComponents(
  graph: Diagram,
  id: string,
  direction: 'upstream' | 'downstream',
): Set<string> {
  const found = new Set([id]),
    queue = [id]
  for (let i = 0; i < queue.length; i++) {
    for (const edge of graph.connections) {
      const [from, to] =
        direction === 'downstream' ? [edge.sourceId, edge.targetId] : [edge.targetId, edge.sourceId]
      if (from === queue[i] && !found.has(to)) {
        found.add(to)
        queue.push(to)
      }
    }
  }
  return found
}
export const COMPONENT_WIDTH = 230
export const validationSummaryHeight = (c: DiagramComponent) =>
  c.validation ? 94 + Math.min(c.validation.rules.length, 3) * 20 : 0
export const componentHeight = (c: DiagramComponent) =>
  122 +
  Math.max(c.inputs.length, c.outputs.length, 1) * 26 +
  (c.reference ? 38 : 0) +
  validationSummaryHeight(c)
// Existing rows and columns express intent that edge direction alone cannot:
// rules above actions, or calls back to a service on the left.
function alignExistingGrid(graph: Diagram): Map<string, { x: number; y: number }> | null {
  const groupAxis = (axis: 'x' | 'y') => {
    const groups: DiagramComponent[][] = []
    for (const component of [...graph.components].sort(
      (a, b) => a.position[axis] - b.position[axis] || a.id.localeCompare(b.id),
    )) {
      const last = groups.at(-1)
      if (last && component.position[axis] - last[0].position[axis] <= 32) last.push(component)
      else groups.push([component])
    }
    return groups
  }
  const columns = groupAxis('x'),
    rows = groupAxis('y')
  if (
    columns.length < 2 ||
    rows.length < 2 ||
    [columns, rows].some(
      (groups) => groups.filter((g) => g.length > 1).flat().length < graph.components.length / 2,
    )
  )
    return null
  const columnOf = new Map(columns.flatMap((column, i) => column.map((c) => [c.id, i] as const)))
  // Nodes occupying the same cell need a fresh arrangement.
  if (rows.some((row) => new Set(row.map((c) => columnOf.get(c.id))).size !== row.length))
    return null
  const coordinates = (groups: DiagramComponent[][], axis: 'x' | 'y') => {
    let end = -Infinity
    return groups.map((group) => {
      const position = Math.max(group[Math.floor((group.length - 1) / 2)].position[axis], end)
      end =
        position +
        (axis === 'x' ? COMPONENT_WIDTH + 90 : Math.max(...group.map(componentHeight)) + 55)
      return position
    })
  }
  const xs = coordinates(columns, 'x'),
    ys = coordinates(rows, 'y')
  if ([...xs, ...ys].some((coordinate) => coordinate > 100000)) return null
  return new Map(
    rows.flatMap((row, i) => row.map((c) => [c.id, { x: xs[columnOf.get(c.id)!], y: ys[i] }])),
  )
}

function positionedDiagram(
  graph: Diagram,
  positions: Map<string, { x: number; y: number }>,
): Diagram {
  if (
    !graph.components.some((c) => {
      const next = positions.get(c.id)!
      return c.position.x !== next.x || c.position.y !== next.y
    })
  )
    return graph
  return {
    ...graph,
    components: graph.components.map((c) => ({ ...c, position: positions.get(c.id)! })),
  }
}

export function layoutDiagram(graph: Diagram): Diagram {
  if (!graph.components.length) return graph
  const grid = alignExistingGrid(graph)
  if (grid) return positionedDiagram(graph, grid)
  const columnStep = COMPONENT_WIDTH + 90,
    gap = 55,
    maxHeight = 90000
  const components = new Map(graph.components.map((c) => [c.id, c]))
  const compare = (a: string, b: string, axis: 'x' | 'y') => {
    const first = components.get(a)!.position,
      second = components.get(b)!.position,
      other = axis === 'x' ? 'y' : 'x'
    return first[axis] - second[axis] || first[other] - second[other] || a.localeCompare(b)
  }
  const ids = [...components.keys()].sort((a, b) => compare(a, b, 'y'))
  const outgoing = new Map(ids.map((id) => [id, new Set<string>()])),
    incoming = new Map(ids.map((id) => [id, new Set<string>()]))
  for (const edge of graph.connections) {
    outgoing.get(edge.sourceId)!.add(edge.targetId)
    incoming.get(edge.targetId)!.add(edge.sourceId)
  }

  // Collapse only strongly connected regions. A feedback edge must not pull
  // every downstream node into the cycle's column.
  const visited = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    onStack = new Set<string>(),
    regions: string[][] = [],
    regionOf = new Map<string, number>()
  const visit = (id: string) => {
    visited.set(id, visited.size)
    low.set(id, visited.get(id)!)
    stack.push(id)
    onStack.add(id)
    for (const next of outgoing.get(id)!) {
      if (!visited.has(next)) {
        visit(next)
        low.set(id, Math.min(low.get(id)!, low.get(next)!))
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, visited.get(next)!))
    }
    if (low.get(id) !== visited.get(id)) return
    const region: string[] = []
    let next: string
    do {
      next = stack.pop()!
      onStack.delete(next)
      regionOf.set(next, regions.length)
      region.push(next)
    } while (next !== id)
    // Retain the user's reading order within a loop, with room for each node.
    regions.push(region.sort((a, b) => compare(a, b, 'x')))
  }
  ids.forEach((id) => {
    if (!visited.has(id)) visit(id)
  })
  const predecessors = regions.map(() => new Set<number>())
  for (const edge of graph.connections) {
    const source = regionOf.get(edge.sourceId)!,
      target = regionOf.get(edge.targetId)!
    if (source !== target) predecessors[target].add(source)
  }
  const starts = new Map<number, number>()
  const start = (region: number): number => {
    if (!starts.has(region))
      starts.set(
        region,
        Math.max(0, ...[...predecessors[region]].map((p) => start(p) + regions[p].length)),
      )
    return starts.get(region)!
  }
  const rank = new Map<string, number>()
  regions.forEach((region, index) =>
    region.forEach((id, offset) => rank.set(id, start(index) + offset)),
  )

  // Keep unrelated flows together instead of interleaving their roots and leaves.
  const remaining = new Set(ids),
    groups: string[][] = []
  for (const id of ids) {
    if (!remaining.delete(id)) continue
    const group = [id]
    for (let i = 0; i < group.length; i++)
      for (const next of [...outgoing.get(group[i])!, ...incoming.get(group[i])!])
        if (remaining.delete(next)) group.push(next)
    groups.push(group)
  }
  const positions = new Map<string, { x: number; y: number }>()
  const sizes = groups.map((group) => {
    const layers = new Map<number, string[]>()
    for (const id of group) {
      const layer = rank.get(id)!
      layers.set(layer, [...(layers.get(layer) ?? []), id])
    }
    const columns: string[][] = []
    for (const [, layer] of [...layers].sort(([a], [b]) => a - b)) {
      const layerHeight = layer.reduce(
        (height, id) => height + componentHeight(components.get(id)!) + gap,
        -gap,
      )
      let column: string[] = [],
        height = 0
      for (const id of layer.sort((a, b) => compare(a, b, layerHeight > maxHeight ? 'x' : 'y'))) {
        const nextHeight = componentHeight(components.get(id)!) + (column.length ? gap : 0)
        if (height + nextHeight > maxHeight) {
          columns.push(column)
          column = []
          height = 0
        }
        height += componentHeight(components.get(id)!) + (column.length ? gap : 0)
        column.push(id)
      }
      columns.push(column)
    }
    const heights = columns.map((column) =>
      column.reduce((height, id) => height + componentHeight(components.get(id)!) + gap, -gap),
    )
    const height = Math.max(...heights)
    columns.forEach((column, index) => {
      let y = (height - heights[index]) / 2
      for (const id of column) {
        positions.set(id, { x: index * columnStep, y })
        y += componentHeight(components.get(id)!) + gap
      }
    })
    const center = (id: string) => positions.get(id)!.y + componentHeight(components.get(id)!) / 2
    const align = (index: number, neighbors: Map<string, Set<string>>) => {
      const column = columns[index],
        offsets: number[] = []
      const blocks: { from: number; to: number; sum: number; count: number }[] = []
      let y = 0
      column.forEach((id, i) => {
        const nodeHeight = componentHeight(components.get(id)!),
          offset = y + nodeHeight / 2
        offsets.push(offset)
        y += nodeHeight + gap
        // Back edges stay visible but do not drag the main flow out of alignment.
        const adjacent = [...neighbors.get(id)!].filter((next) =>
          neighbors === incoming
            ? rank.get(next)! < rank.get(id)!
            : rank.get(next)! > rank.get(id)!,
        )
        const desired = adjacent.length
          ? adjacent.reduce((sum, next) => sum + center(next), 0) / adjacent.length
          : center(id)
        blocks.push({ from: i, to: i, sum: desired - offset, count: 1 })
        // Pool conflicting offsets to preserve row order and the minimum gap.
        while (blocks.length > 1) {
          const right = blocks.at(-1)!,
            left = blocks.at(-2)!
          if (left.sum / left.count <= right.sum / right.count) break
          blocks.pop()
          left.to = right.to
          left.sum += right.sum
          left.count += right.count
        }
      })
      for (const block of blocks) {
        const shift = Math.max(0, Math.min(height - heights[index], block.sum / block.count))
        for (let i = block.from; i <= block.to; i++)
          positions.get(column[i])!.y =
            shift + offsets[i] - componentHeight(components.get(column[i])!) / 2
      }
    }
    // Start from geometry derived from the row order on every invocation, so
    // repeated clicks do not keep nudging an already arranged diagram.
    for (let pass = 0; pass < 4; pass++) {
      columns.forEach((_, index) => align(index, incoming))
      for (let index = columns.length - 1; index >= 0; index--) align(index, outgoing)
    }
    return { width: (columns.length - 1) * columnStep + COMPONENT_WIDTH, height }
  })

  // Pack disconnected flows (including isolated nodes) into compact rows.
  const rowWidth = Math.max(
    ...sizes.map((size) => size.width),
    Math.sqrt(sizes.reduce((area, size) => area + (size.width + 90) * (size.height + gap), 0)) *
      1.5,
  )
  let x = 0,
    y = 0,
    rowHeight = 0
  let origins = sizes.map((size) => {
    if (x && x + size.width > rowWidth) {
      x = 0
      y += rowHeight + gap
      rowHeight = 0
    }
    const origin = { x, y }
    x += size.width + 90
    rowHeight = Math.max(rowHeight, size.height)
    return origin
  })
  if (y + rowHeight > maxHeight) {
    x = 0
    origins = sizes.map((size) => {
      const origin = { x, y: 0 }
      x += size.width + 90
      return origin
    })
  }
  groups.forEach((group, index) => {
    for (const id of group) {
      const position = positions.get(id)!
      position.x += 60 + origins[index].x
      position.y = Math.round((position.y + 70 + origins[index].y) * 100) / 100
    }
  })
  const arranged = positionedDiagram(graph, positions)
  const aligned = alignExistingGrid(arranged)
  return aligned ? positionedDiagram(arranged, aligned) : arranged
}
export function exampleDiagram(): Diagram {
  const form = newComponent('ui'),
    logic = newComponent('action'),
    db = newComponent('store'),
    page = newComponent('ui')
  Object.assign(form, {
    name: '用户信息表单',
    description: '收集姓名和邮箱，提交注册申请。',
    inputs: [],
    position: { x: 50, y: 210 },
  })
  Object.assign(logic, {
    name: '校验与注册',
    description: '校验字段、检查重复邮箱，创建用户。',
    position: { x: 400, y: 210 },
  })
  Object.assign(db, {
    name: '用户数据库',
    description: '持久化用户资料，返回唯一用户 ID。',
    position: { x: 750, y: 80 },
  })
  Object.assign(page, {
    name: '注册结果页',
    description: '显示注册结果与用户信息。',
    outputs: [],
    position: { x: 750, y: 370 },
  })
  form.outputs[0].name = '注册信息'
  logic.inputs[0].name = '注册信息'
  logic.outputs[0].name = '用户资料'
  db.inputs[0].name = '用户资料'
  db.outputs[0].name = '用户 ID'
  page.inputs[0].name = '注册结果'
  const a = newConnection(form, logic),
    b = newConnection(logic, db),
    c = newConnection(logic, page)
  Object.assign(a, { name: '提交注册', protocol: 'HTTPS / POST' })
  Object.assign(b, { name: '写入用户', protocol: 'SQL', condition: '字段校验通过且邮箱未注册' })
  Object.assign(c, { name: '展示结果', condition: '注册处理完成' })
  return diagramSchema.parse({
    ...emptyDiagram(),
    components: [form, logic, db, page],
    connections: [a, b, c],
  })
}
