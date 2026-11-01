import {
  emptyDiagram,
  newComponent,
  newConnection,
  COMPONENT_WIDTH,
  componentHeight,
  type Diagram,
  type GraphSnapshot,
  type DiagramComponent,
  type DiagramConnection,
} from './diagram'
import { describeValidation, type Validation } from './validation'

export type ChangeStatus = 'added' | 'modified' | 'removed' | 'unchanged'
export const changeLabels: Record<ChangeStatus, string> = {
  added: '新增',
  modified: '修改',
  removed: '删除',
  unchanged: '保持',
}
export type FieldChange = { field: string; before: unknown; after: unknown }
export type ModelChange = {
  kind: 'component' | 'connection'
  id: string
  name: string
  status: ChangeStatus
  fields: FieldChange[]
}
const labels: Record<string, string> = {
  reference: '画板引用',
  exposed: '对外开放',
  name: '名称',
  description: '说明',
  type: '类型',
  templateId: '组件模板',
  boundary: '系统边界',
  ownerId: '归属',
  inputs: '输入端口',
  outputs: '输出端口',
  metadata: '属性',
  sourceId: '起点组件',
  targetId: '终点组件',
  sourcePortId: '输出端口',
  targetPortId: '输入端口',
  protocol: '协议',
  condition: '触发条件',
  validation: '校验配置',
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)]),
      ),
    )
  return JSON.stringify(value) ?? ''
}
export function snapshot(graph: GraphSnapshot): GraphSnapshot {
  return structuredClone({
    schemaVersion: graph.schemaVersion,
    scenarioId: graph.scenarioId,
    components: graph.components,
    connections: graph.connections,
  })
}
export function startIteration(graph: Diagram, name: string): Diagram {
  if (graph.iteration) throw new Error('请先完成或放弃当前迭代')
  if (!name.trim() || name.trim().length > 80) throw new Error('请填写 1 至 80 字的迭代名称')
  return {
    ...graph,
    iteration: {
      id: crypto.randomUUID(),
      name: name.trim(),
      startedAt: new Date().toISOString(),
      baseline: snapshot(graph),
    },
  }
}
export function renameIteration(graph: Diagram, name: string): Diagram {
  if (!graph.iteration) throw new Error('当前迭代已结束')
  if (!name.trim() || name.trim().length > 80) throw new Error('请填写 1 至 80 字的迭代名称')
  return { ...graph, iteration: { ...graph.iteration, name: name.trim() } }
}
export function discardIteration(graph: Diagram): Diagram {
  if (!graph.iteration) return graph
  return { ...snapshot(graph.iteration.baseline), history: graph.history }
}
export function publishIteration(graph: Diagram): Diagram {
  if (!graph.iteration) return graph
  if (graph.history.length >= 50) throw new Error('已保留 50 个历史现状，请先导出备份并整理版本')
  return {
    ...snapshot(graph),
    history: [
      ...graph.history,
      {
        id: graph.iteration.id,
        name: `${graph.iteration.name.slice(0, 70)} · 更新前`,
        publishedAt: new Date().toISOString(),
        snapshot: snapshot(graph.iteration.baseline),
        ...(graph.iteration.git ? { git: graph.iteration.git } : {}),
      },
    ],
  }
}
function changes<T extends DiagramComponent | DiagramConnection>(
  before: T[],
  after: T[],
  kind: ModelChange['kind'],
): ModelChange[] {
  const oldItems = new Map(before.map((item) => [item.id, item]))
  const newItems = new Map(after.map((item) => [item.id, item]))
  return [...after, ...before.filter((item) => !newItems.has(item.id))].map((item) => {
    const old = oldItems.get(item.id),
      next = newItems.get(item.id)
    const fields: FieldChange[] = []
    if (old && next) {
      for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (field === 'id' || field === 'position') continue
        const a = (old as Record<string, unknown>)[field],
          b = (next as Record<string, unknown>)[field]
        if (field === 'metadata') {
          const av = (a ?? {}) as Record<string, string>,
            bv = (b ?? {}) as Record<string, string>
          for (const key of new Set([...Object.keys(av), ...Object.keys(bv)]))
            if ((av[key] ?? '') !== (bv[key] ?? ''))
              fields.push({ field: `属性 / ${key}`, before: av[key], after: bv[key] })
        } else if (canonical(a) !== canonical(b))
          fields.push({
            field: labels[field] ?? field,
            before: field === 'validation' && a ? describeValidation(a as Validation) : a,
            after: field === 'validation' && b ? describeValidation(b as Validation) : b,
          })
      }
    }
    return {
      kind,
      id: item.id,
      name: item.name,
      status: !old ? 'added' : !next ? 'removed' : fields.length ? 'modified' : 'unchanged',
      fields,
    }
  })
}
export function iterationChanges(graph: Diagram): ModelChange[] {
  if (!graph.iteration) return []
  return [
    ...changes(graph.iteration.baseline.components, graph.components, 'component'),
    ...changes(graph.iteration.baseline.connections, graph.connections, 'connection'),
  ]
}
// Conservative one-hop review hints; an impact hint is never a change itself.
export function affectedComponents(graph: Diagram, diff = iterationChanges(graph)): Set<string> {
  if (!graph.iteration) return new Set()
  const changed = new Set(
    diff.filter((c) => c.kind === 'component' && c.status !== 'unchanged').map((c) => c.id),
  )
  const changedEdges = new Set(
    diff.filter((c) => c.kind === 'connection' && c.status !== 'unchanged').map((c) => c.id),
  )
  const affected = new Set<string>()
  for (const edge of [...graph.connections, ...graph.iteration.baseline.connections]) {
    if (changed.has(edge.sourceId) || changed.has(edge.targetId) || changedEdges.has(edge.id)) {
      if (!changed.has(edge.sourceId)) affected.add(edge.sourceId)
      if (!changed.has(edge.targetId)) affected.add(edge.targetId)
    }
  }
  return affected
}

// Deleted objects are comparison overlays, never edits to the immutable baseline.
// Derive their positions so layout, reload and undo show the same arrangement.
export function iterationView(graph: Diagram): Diagram {
  if (!graph.iteration) return graph
  const baseline = graph.iteration.baseline,
    current = new Map(graph.components.map((c) => [c.id, c])),
    previous = new Map(baseline.components.map((c) => [c.id, c])),
    components = [...graph.components]
  for (const removed of baseline.components.filter((c) => !current.has(c.id))) {
    const adjacent = baseline.connections.flatMap((edge) =>
      edge.sourceId === removed.id
        ? [edge.targetId]
        : edge.targetId === removed.id
          ? [edge.sourceId]
          : [],
    )
    const anchor = adjacent
      .filter((id) => current.has(id))
      .sort((a, b) => {
        const distance = (id: string) =>
          Math.hypot(
            previous.get(id)!.position.x - removed.position.x,
            previous.get(id)!.position.y - removed.position.y,
          )
        return distance(a) - distance(b) || a.localeCompare(b)
      })[0]
    const position = { ...removed.position }
    if (anchor) {
      position.x += current.get(anchor)!.position.x - previous.get(anchor)!.position.x
      position.y += current.get(anchor)!.position.y - previous.get(anchor)!.position.y
    }
    const gap = 24,
      height = componentHeight(removed)
    const intervals = components
      .filter(
        (c) =>
          c.position.x < position.x + COMPONENT_WIDTH + gap &&
          c.position.x + COMPONENT_WIDTH + gap > position.x,
      )
      .map((c) => ({
        start: c.position.y - height - gap,
        end: c.position.y + componentHeight(c) + gap,
      }))
      .sort((a, b) => a.start - b.start)
    const blocked: { start: number; end: number }[] = []
    for (const interval of intervals) {
      const last = blocked.at(-1)
      if (last && interval.start < last.end) last.end = Math.max(last.end, interval.end)
      else blocked.push({ ...interval })
    }
    const overlap = blocked.find(
      (interval) => position.y > interval.start && position.y < interval.end,
    )
    if (overlap)
      position.y =
        position.y - overlap.start < overlap.end - position.y ? overlap.start : overlap.end
    components.push({ ...removed, position })
  }
  const connectionIds = new Set(graph.connections.map((edge) => edge.id))
  return {
    ...graph,
    components,
    connections: [
      ...graph.connections,
      ...baseline.connections.filter((edge) => !connectionIds.has(edge.id)),
    ],
  }
}

export function iterationExample(): Diagram {
  const node = (
    id: string,
    type: DiagramComponent['type'],
    name: string,
    description: string,
    x: number,
    y: number,
  ): DiagramComponent => ({
    ...newComponent(type, { x, y }),
    id,
    name,
    description,
    inputs: [],
    outputs: [],
  })
  const components = [
    node('signup', 'capability', '用户注册', '通过邮箱创建账号，开始使用应用。', 40, 40),
    node('visitor', 'actor', '访客', '还没有账号，希望注册并开始使用。', 40, 290),
    node('signup-page', 'ui', '注册页面', '填写邮箱和密码，提交注册信息。', 390, 290),
    node('create-user', 'action', '创建账号', '校验注册信息，创建用户记录。', 740, 290),
    node('user-data', 'data', '用户资料', '字段：userId、email、passwordHash。', 1090, 290),
    node('email-rule', 'rule', '邮箱唯一', '邮箱已被注册时，提示登录或找回账号。', 740, 40),
    node('welcome', 'ui', '注册欢迎页', '注册成功后展示欢迎页面。', 1090, 540),
  ]
  const link = (
    id: string,
    a: string,
    b: string,
    type: DiagramConnection['type'],
    name: string,
  ): DiagramConnection => ({
    ...newConnection(
      components.find((c) => c.id === a)!,
      components.find((c) => c.id === b)!,
    ),
    id,
    type,
    name,
    sourcePortId: null,
    targetPortId: null,
  })
  const graph: Diagram = {
    ...emptyDiagram(),
    components,
    connections: [
      link('scope', 'signup', 'signup-page', 'contains', '包含注册入口'),
      link('visit', 'visitor', 'signup-page', 'control', '访问注册'),
      link('submit', 'signup-page', 'create-user', 'control', '提交注册'),
      link('check-email', 'email-rule', 'create-user', 'constrains', '邮箱注册时校验'),
      link('save-user', 'create-user', 'user-data', 'writes', '写入用户'),
      link('show-welcome', 'create-user', 'welcome', 'control', '注册成功'),
    ],
  }
  const draft = startIteration(graph, '增加手机号验证码注册')
  draft.components = draft.components
    .filter((c) => c.id !== 'welcome')
    .map((c) => {
      if (c.id === 'signup') return { ...c, description: '支持邮箱注册与手机号验证码注册。' }
      if (c.id === 'signup-page')
        return { ...c, description: '保留邮箱注册，增加手机号、验证码输入与发送验证码入口。' }
      if (c.id === 'create-user')
        return { ...c, description: '按注册方式校验邮箱密码或短信验证码，创建用户记录。' }
      if (c.id === 'user-data')
        return {
          ...c,
          description: '字段：userId、email、phone、passwordHash；邮箱和手机号至少填写一项。',
        }
      return c
    })
  draft.components.push(
    node('sms', 'service', '短信平台', '发送注册验证码，由第三方提供服务。', 40, 540),
    node('send-code', 'action', '发送验证码', '向手机号发送验证码，并限制重复发送频率。', 390, 540),
    node('code-rule', 'rule', '验证码有效', '验证码未过期且匹配；校验成功后立即失效。', 740, 540),
    node('registered', 'event', '注册成功', '通知后续业务，前端引导用户进入首页。', 1090, 40),
  )
  draft.components.find((c) => c.id === 'sms')!.boundary = 'external'
  const connect = (
    id: string,
    a: string,
    b: string,
    type: DiagramConnection['type'],
    name: string,
  ): DiagramConnection => ({
    ...newConnection(
      draft.components.find((c) => c.id === a)!,
      draft.components.find((c) => c.id === b)!,
    ),
    id,
    type,
    name,
    sourcePortId: null,
    targetPortId: null,
  })
  draft.connections = draft.connections.filter((e) => e.id !== 'show-welcome')
  draft.connections.push(
    connect('request-code', 'signup-page', 'send-code', 'control', '请求验证码'),
    connect('call-sms', 'send-code', 'sms', 'calls', '调用短信服务'),
    connect('check-code', 'code-rule', 'create-user', 'constrains', '手机号注册时校验'),
    connect('emit-registered', 'create-user', 'registered', 'event', '创建成功后发布'),
  )
  return draft
}
