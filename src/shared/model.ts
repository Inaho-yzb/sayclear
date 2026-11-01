import { z } from 'zod'
import { diagramSchema } from './diagram'
import { gitRepositorySchema } from './git'
import {
  componentCatalogSchema,
  defaultComponentCatalog,
  catalogDiagramError,
  type ComponentCatalog,
} from './component-catalog'

export const sectionIds = ['overview', 'audience', 'features', 'flow', 'acceptance'] as const
export type SectionId = (typeof sectionIds)[number]
export const sectionTitles: Record<SectionId, string> = {
  overview: '需求概述',
  audience: '目标用户',
  features: '核心功能',
  flow: '交互流程',
  acceptance: '验收标准',
}

const sectionSchema = z.object({
  id: z.enum(sectionIds),
  content: z.string().max(100_000),
  confirmed: z.boolean(),
})
const proposalSchema = z.object({
  sectionId: z.enum(sectionIds),
  content: z.string().max(100_000),
  status: z.enum(['pending', 'accepted', 'dismissed']),
})
const messageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(100_000),
  createdAt: z.string(),
  proposal: proposalSchema.optional(),
})
export const projectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  diagram: diagramSchema.optional(),
  messages: z.array(messageSchema).max(5000),
  sections: z
    .array(sectionSchema)
    .length(5)
    .refine(
      (sections) => new Set(sections.map((section) => section.id)).size === 5,
      '文档章节不能重复',
    ),
})
export const legacyWorkspaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeProjectId: z.string(),
    projects: z.array(projectSchema).min(1).max(100),
  })
  .refine(
    (state) => state.projects.some((project) => project.id === state.activeProjectId),
    '当前项目不存在',
  )
  .refine(
    (state) => new Set(state.projects.map((project) => project.id)).size === state.projects.length,
    '项目 ID 重复',
  )

export type Project = z.infer<typeof projectSchema>
export type Message = z.infer<typeof messageSchema>

export type Section = z.infer<typeof sectionSchema>

export function createProject(name: string, idea = ''): Project {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 80),
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sections: sectionIds.map((id) => ({
      id,
      content: id === 'overview' ? idea.trim() : '',
      confirmed: false,
    })),
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        createdAt: now,
        text: '让我们从一个想法开始。这个产品想帮助谁，解决什么问题？\n\n你可以自由描述，也可以选择右侧的章节，逐步补充需求。当前为本地演示：你的文字会作为补充建议，确认采纳后再写入文档。',
      },
    ],
  }
}

function createExampleProject(): Project {
  const project = createProject('示例 Web 应用')
  project.sections = [
    {
      id: 'overview',
      confirmed: true,
      content: '描述应用的角色、能力、流程与业务逻辑，在现状之上设计下一次迭代。',
    },
    {
      id: 'audience',
      confirmed: true,
      content: '需要梳理产品想法的独立开发者、产品经理，以及希望准确表达需求的业务团队。',
    },
    {
      id: 'features',
      confirmed: false,
      content:
        '通过对话描述、补充和修改产品需求。\n按章节组织需求，并允许用户直接编辑。\n每次修改先预览、再确认，保留用户的决定权。\n自动保存到本地，支持导出 Markdown 文档。',
    },
    {
      id: 'flow',
      confirmed: false,
      content: '创建项目 → 描述想法 → 逐步澄清 → 确认需求 → 导出文档。',
    },
    { id: 'acceptance', confirmed: false, content: '' },
  ]
  project.messages = [
    {
      id: crypto.randomUUID(),
      role: 'user',
      createdAt: project.createdAt,
      text: '我想做一个桌面应用，通过和 AI 对话，把模糊的想法整理成清晰的需求文档。交互要舒服、流畅，修改需求也要很方便。',
    },
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      createdAt: project.createdAt,
      text: '好的，我们先把这个想法的轮廓搭起来。\n\n右侧是一份示例需求草稿，包含项目目标、用户和核心功能。你可以随时编辑，也可以继续聊，把每个细节慢慢说清楚。\n\n接下来，我们可以先聚焦核心功能：你希望用户如何确认和修改 AI 整理的需求？',
    },
  ]
  return project
}

export function updateSection(project: Project, id: SectionId, content: string): Project {
  if (project.sections.find((section) => section.id === id)?.content === content) return project
  return {
    ...project,
    revision: project.revision + 1,
    updatedAt: new Date().toISOString(),
    sections: project.sections.map((section) =>
      section.id === id ? { ...section, content, confirmed: false } : section,
    ),
  }
}

export function resolveProposal(project: Project, messageId: string, accept: boolean): Project {
  const proposal = project.messages.find((message) => message.id === messageId)?.proposal
  if (!proposal || proposal.status !== 'pending') return project
  const section = project.sections.find((item) => item.id === proposal.sectionId)!
  const updated = accept
    ? updateSection(
        project,
        section.id,
        [section.content, proposal.content].filter(Boolean).join('\n'),
      )
    : project
  return {
    ...updated,
    updatedAt: new Date().toISOString(),
    messages: updated.messages.map((message) =>
      message.id === messageId
        ? { ...message, proposal: { ...proposal, status: accept ? 'accepted' : 'dismissed' } }
        : message,
    ),
  }
}

// Architecture is the only source of names and hierarchy. Content IDs refer to its nodes.
const nodeIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, '节点 ID 只能包含字母、数字、下划线和连字符')
const nodeFields = {
  id: nodeIdSchema,
  name: z.string().trim().min(1, '请填写名称').max(80),
  description: z.string().max(10000),
}
export const boardNodeSchema = z
  .object({
    ...nodeFields,
    kind: z.enum(['application', 'aggregate', 'atomic']),
    parentId: nodeIdSchema,
  })
  .strict()
export const architectureSchema = z
  .object({
    schemaVersion: z.literal(2),
    ...nodeFields,
    kind: z.enum(['system', 'application']),
    createdAt: z.string(),
    updatedAt: z.string(),
    boards: z.array(boardNodeSchema).max(2000),
  })
  .strict()
  .superRefine((architecture, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const nodes = new Map(architecture.boards.map((n) => [n.id, n]))
    if (nodes.size !== architecture.boards.length || nodes.has(architecture.id))
      fail('架构中的节点 ID 不能重复')
    const names = new Set<string>()
    for (const node of architecture.boards) {
      const key = JSON.stringify([node.parentId, node.name])
      if (names.has(key)) fail('同一层级下的名称不能重复')
      names.add(key)
      const seen = new Set([node.id])
      let parentId = node.parentId
      let applicationCount = node.kind === 'application' ? 1 : 0
      while (parentId !== architecture.id) {
        const parent = nodes.get(parentId)
        if (!parent) {
          fail('画板的归属节点不存在')
          break
        }
        if (seen.has(parentId)) {
          fail('画板归属不能形成循环')
          break
        }
        if (parent.kind === 'atomic') fail('原子图不能包含子图，请先改为聚合图')
        if (parent.kind === 'application') applicationCount++
        seen.add(parentId)
        parentId = parent.parentId
      }
      if (architecture.kind === 'application') applicationCount++
      if (applicationCount > 1) fail('应用边界不能嵌套，请将应用放在系统总图下')
    }
  })
export type Architecture = z.infer<typeof architectureSchema>
export type BoardNode = z.infer<typeof boardNodeSchema>
export type ScopeNode = {
  id: string
  name: string
  description: string
  type: 'system' | BoardNode['kind']
  parentId: string | null
  depth: number
}
export const scopeTitles = {
  system: '系统总图',
  application: '应用',
  aggregate: '聚合图',
  atomic: '原子图',
}

export function flattenArchitecture(architecture: Architecture): ScopeNode[] {
  const root: ScopeNode = {
    id: architecture.id,
    name: architecture.name,
    description: architecture.description,
    type: architecture.kind,
    parentId: null,
    depth: 0,
  }
  const result: ScopeNode[] = []
  const stack = [root]
  const visited = new Set<string>()
  const children = new Map<string, BoardNode[]>()
  for (const node of architecture.boards)
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node.id)) continue
    visited.add(node.id)
    result.push(node)
    for (const child of [...(children.get(node.id) ?? [])].reverse())
      stack.push({ ...child, type: child.kind, depth: node.depth + 1 })
  }
  return result
}
export const nodeContentSchema = projectSchema.omit({ name: true }).extend({ id: nodeIdSchema })
const systemSchema = z
  .object({
    architecture: architectureSchema,
    contents: z.array(nodeContentSchema).max(25000),
  })
  .superRefine((system, ctx) => {
    const contentIds = new Set(system.contents.map((content) => content.id))
    if (contentIds.size !== system.contents.length)
      ctx.addIssue({ code: 'custom', message: '节点内容 ID 重复' })
    if (flattenArchitecture(system.architecture).some((node) => !contentIds.has(node.id))) {
      ctx.addIssue({ code: 'custom', message: '架构节点缺少对应的需求内容' })
    }
  })
export const workspaceSchema = z
  .object({
    schemaVersion: z.literal(2),
    activeNodeId: z.string().nullable(),
    componentCatalog: componentCatalogSchema.optional(),
    gitRepository: gitRepositorySchema.optional(),
    systems: z.array(systemSchema).max(100),
  })
  .superRefine((workspace, ctx) => {
    for (const system of workspace.systems) {
      for (const content of system.contents) {
        if (content.diagram) {
          const error = catalogDiagramError(
            content.diagram,
            workspace.componentCatalog ?? defaultComponentCatalog,
          )
          if (error) ctx.addIssue({ code: 'custom', message: error })
        }
      }
    }
    const nodes = workspace.systems.flatMap((system) => flattenArchitecture(system.architecture))
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
      ctx.addIssue({ code: 'custom', message: '工作区中的节点 ID 不能重复' })
    if (
      nodes.length === 0
        ? workspace.activeNodeId !== null
        : !nodes.some((node) => node.id === workspace.activeNodeId)
    )
      ctx.addIssue({ code: 'custom', message: '当前节点不存在或空工作区仍有选中节点' })
  })
export type SystemData = z.infer<typeof systemSchema>
export type NodeContent = z.infer<typeof nodeContentSchema>
export type Workspace = z.infer<typeof workspaceSchema>

export function createArchitecture(name = '', description = ''): Architecture {
  const now = new Date().toISOString()
  return {
    schemaVersion: 2,
    kind: 'application',
    id: crypto.randomUUID(),
    name,
    description,
    createdAt: now,
    updatedAt: now,
    boards: [],
  }
}
export function buildSystem(architecture: Architecture, previous?: SystemData): SystemData {
  const parsed = architectureSchema.parse(architecture)
  // Retain detached content so a manual architecture edit never destroys conversation history.
  const contents = [...(previous?.contents ?? [])]
  for (const node of flattenArchitecture(parsed)) {
    if (!contents.some((content) => content.id === node.id)) {
      contents.push(
        nodeContentSchema.parse({ ...createProject(node.name, node.description), id: node.id }),
      )
    }
  }
  return systemSchema.parse({ architecture: parsed, contents })
}
export function getProject(workspace: Workspace, id = workspace.activeNodeId): Project {
  for (const system of workspace.systems) {
    const node = flattenArchitecture(system.architecture).find((item) => item.id === id)
    const content = system.contents.find((item) => item.id === id)
    if (node && content) return { ...content, name: node.name }
  }
  throw new Error('当前节点不存在')
}
export function updateNodeContent(
  workspace: Workspace,
  id: string,
  update: (project: Project) => Project,
): Workspace {
  // A late reply must not recreate content after its system has been deleted.
  if (
    !workspace.systems.some((system) =>
      flattenArchitecture(system.architecture).some((node) => node.id === id),
    )
  )
    return workspace
  const updated = nodeContentSchema.parse(update(getProject(workspace, id)))
  return {
    ...workspace,
    systems: workspace.systems.map((system) =>
      flattenArchitecture(system.architecture).some((node) => node.id === id)
        ? {
            ...system,
            contents: system.contents.map((content) => (content.id === id ? updated : content)),
          }
        : system,
    ),
  }
}
export function saveArchitecture(workspace: Workspace, architecture: Architecture): Workspace {
  const previous = workspace.systems.find((system) => system.architecture.id === architecture.id)
  const system = buildSystem(architecture, previous)
  const systems = previous
    ? workspace.systems.map((item) => (item.architecture.id === architecture.id ? system : item))
    : [...workspace.systems, system]
  const activeStillExists = systems
    .flatMap((item) => flattenArchitecture(item.architecture))
    .some((node) => node.id === workspace.activeNodeId)
  return workspaceSchema.parse({
    ...workspace,
    systems,
    activeNodeId: previous && activeStillExists ? workspace.activeNodeId : architecture.id,
  })
}
export function deleteSystem(workspace: Workspace, systemId: string): Workspace {
  if (!workspace.systems.some((system) => system.architecture.id === systemId))
    throw new Error('应用系统不存在')
  const systems = workspace.systems.filter((system) => system.architecture.id !== systemId)
  const activeExists = systems.some((system) =>
    flattenArchitecture(system.architecture).some((node) => node.id === workspace.activeNodeId),
  )
  return workspaceSchema.parse({
    ...workspace,
    systems,
    activeNodeId: activeExists ? workspace.activeNodeId : (systems[0]?.architecture.id ?? null),
  })
}

function truncateDescription(text: string): string {
  const truncated = text.slice(0, 10000)
  const last = truncated.charCodeAt(truncated.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated
}
export function parseWorkspace(value: unknown): Workspace {
  if (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1
  ) {
    const legacy = legacyWorkspaceSchema.parse(value)
    return workspaceSchema.parse({
      schemaVersion: 2,
      activeNodeId: legacy.activeProjectId,
      systems: legacy.projects.map((project) => ({
        architecture: {
          schemaVersion: 2,
          kind: 'application',
          id: project.id,
          name: project.name.trim() || '未命名系统',
          description: truncateDescription(
            project.sections.find((section) => section.id === 'overview')!.content,
          ),
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          boards: [],
        },
        contents: [nodeContentSchema.parse(project)],
      })),
    })
  }
  return workspaceSchema.parse(value)
}
export function createInitialWorkspace(): Workspace {
  const project = createExampleProject()
  return parseWorkspace({ schemaVersion: 1, activeProjectId: project.id, projects: [project] })
}

export function saveComponentCatalog(workspace: Workspace, catalog: ComponentCatalog): Workspace {
  // Validate against every saved board, including detached content, before replacing definitions.
  const parsed = componentCatalogSchema.parse(catalog)
  for (const system of workspace.systems) {
    for (const content of system.contents) {
      if (!content.diagram) continue
      const error = catalogDiagramError(content.diagram, parsed)
      if (error) {
        const node = flattenArchitecture(system.architecture).find((n) => n.id === content.id)
        throw new Error(
          `无法保存：画板「${node?.name ?? content.id}」仍在使用此配置。${error}。请先调整画板，或为新增属性提供默认值。`,
        )
      }
    }
  }
  return workspaceSchema.parse({ ...workspace, componentCatalog: parsed })
}
