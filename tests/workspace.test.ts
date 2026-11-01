import { describe, expect, it } from 'vitest'
import {
  createInitialWorkspace,
  createArchitecture,
  deleteSystem,
  createProject,
  getProject,
  parseWorkspace,
  architectureSchema,
  saveArchitecture,
  updateNodeContent,
  resolveProposal,
  updateSection,
  workspaceSchema,
} from '../src/shared/model'
import { toMarkdown } from '../src/shared/document'
import { demoAssistant } from '../src/renderer/src/services/assistant'

describe('需求确认与建议', () => {
  it('修改已确认内容后取消确认，仅在内容变化时更新版本', () => {
    const project = getProject(createInitialWorkspace())
    expect(updateSection(project, 'overview', project.sections[0].content)).toBe(project)
    const updated = updateSection(project, 'overview', '新的产品目标')
    expect(updated.sections[0]).toMatchObject({ confirmed: false, content: '新的产品目标' })
    expect(updated.revision).toBe(project.revision + 1)
    expect(project.sections[0].confirmed).toBe(true)
  })

  it('采纳时合并当前文档，保留期间的手动修改，且不能重复采纳', () => {
    const project = getProject(createInitialWorkspace())
    project.messages.push({
      id: 'proposal',
      role: 'assistant',
      text: '建议',
      createdAt: new Date().toISOString(),
      proposal: { sectionId: 'overview', content: '增加离线支持', status: 'pending' },
    })
    const edited = updateSection(project, 'overview', '用户手动修改的目标')
    const accepted = resolveProposal(edited, 'proposal', true)
    expect(accepted.sections[0].content).toBe('用户手动修改的目标\n增加离线支持')
    expect(accepted.sections[0].confirmed).toBe(false)
    expect(resolveProposal(accepted, 'proposal', true)).toBe(accepted)
  })

  it('拒绝建议不修改文档或版本', () => {
    const project = getProject(createInitialWorkspace())
    project.messages.push({
      id: 'proposal',
      role: 'assistant',
      text: '建议',
      createdAt: new Date().toISOString(),
      proposal: { sectionId: 'overview', content: '无需加入', status: 'pending' },
    })
    const dismissed = resolveProposal(project, 'proposal', false)
    expect(dismissed.sections).toEqual(project.sections)
    expect(dismissed.revision).toBe(project.revision)
    expect(dismissed.messages.at(-1)?.proposal?.status).toBe('dismissed')
  })

  it('拒绝损坏的工作区，防止错误项目和重复章节被加载', () => {
    const workspace = createInitialWorkspace()
    expect(workspaceSchema.safeParse({ ...workspace, activeNodeId: 'missing' }).success).toBe(false)
    workspace.systems[0].contents[0].sections[1] = workspace.systems[0].contents[0].sections[0]
    expect(workspaceSchema.safeParse(workspace).success).toBe(false)
  })

  it('导出的文档保留未确认标记与空章节提示', () => {
    const text = toMarkdown(createProject('测试项目', '示例目标'))
    expect(text).toContain('# 测试项目 · 需求文档')
    expect(text).toContain('草稿（0/5 章节已确认）')
    expect(text).toContain('## 5. 验收标准')
    expect(text).toContain('（待补充）')
  })

  it('演示保留用户原文并允许中止请求', async () => {
    const project = createProject('演示')
    const controller = new AbortController()
    const pending = demoAssistant.propose({
      project,
      text: '支持中文输入法',
      sectionId: 'features',
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const reply = await demoAssistant.propose({
      project,
      text: '  支持中文输入法  ',
      sectionId: 'features',
      signal: new AbortController().signal,
    })
    expect(reply.proposal).toEqual({
      sectionId: 'features',
      content: '支持中文输入法',
      status: 'pending',
    })
  })
})

it('与 Rust 共用的 v1 工作区样本符合前端数据约束', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v1.json')
  const migrated = parseWorkspace(fixture)
  expect(migrated.schemaVersion).toBe(2)
  expect(getProject(migrated)).toEqual(fixture.projects[0])
  expect(migrated.systems[0].architecture.boards).toEqual([])
})

it('与 Rust 共用的 v2 样本保留画板组成树', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v2.json')
  expect(workspaceSchema.parse(fixture)).toEqual(fixture)
})

it('架构编辑保留稳定 ID、确认状态和对话，新增节点有独立内容', () => {
  const workspace = createInitialWorkspace()
  const original = getProject(workspace)
  const architecture = structuredClone(workspace.systems[0].architecture)
  architecture.name = '客户管理系统'
  architecture.boards.push(
    {
      id: 'sales',
      name: '销售管理',
      description: '',
      kind: 'aggregate',
      parentId: architecture.id,
    },
    {
      id: 'leads',
      name: '销售线索',
      description: '记录意向客户',
      kind: 'atomic',
      parentId: 'sales',
    },
  )
  const updated = saveArchitecture(workspace, architecture)
  expect(getProject(updated).name).toBe('客户管理系统')
  expect(getProject(updated).sections).toEqual(original.sections)
  expect(getProject(updated).messages).toEqual(original.messages)
  expect(getProject(updated, 'leads').sections[0].content).toBe('记录意向客户')
  expect(getProject(updated, 'sales').sections[0].content).toBe('')
  expect(updated.systems[0].contents[0]).not.toHaveProperty('name')
})

it('切换节点后仍把回复写回原节点，移除结构节点保留内容且回到系统', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v2.json')
  const workspace = workspaceSchema.parse(fixture)
  workspace.activeNodeId = 'leads'
  const switched = { ...workspace, activeNodeId: 'sales' }
  const replied = updateNodeContent(switched, 'leads', (project) =>
    updateSection(project, 'features', '仅属于线索的需求'),
  )
  expect(getProject(replied, 'sales').sections[2].content).toBe('')
  expect(getProject(replied, 'leads').sections[2].content).toBe('仅属于线索的需求')
  const removed = saveArchitecture(
    { ...replied, activeNodeId: 'leads' },
    { ...replied.systems[0].architecture, boards: [] },
  )
  expect(removed.activeNodeId).toBe(replied.systems[0].architecture.id)
  expect(
    removed.systems[0].contents.find((content) => content.id === 'leads')?.sections[2].content,
  ).toBe('仅属于线索的需求')
})

it('拒绝重复节点、重复同级名称、越级结构和危险目录 ID', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v2.json')
  const architecture = structuredClone(fixture.systems[0].architecture)
  architecture.boards.push({
    ...architecture.boards[1],
    id: 'another',
  })
  expect(architectureSchema.safeParse(architecture).success).toBe(false)
  expect(architectureSchema.safeParse({ ...architecture, id: '../outside' }).success).toBe(false)
  const normal = structuredClone(fixture.systems[0].architecture)
  normal.boards[1].id = normal.id
  expect(architectureSchema.safeParse(normal).success).toBe(false)
  expect(
    architectureSchema.safeParse({ ...fixture.systems[0].architecture, modules: [] }).success,
  ).toBe(false)
})

it('迁移长说明不会截断 emoji 的 UTF-16 代理对', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v1.json')
  const legacy = structuredClone(fixture)
  legacy.projects[0].sections[0].content = 'a'.repeat(9999) + '🚀'
  const migrated = parseWorkspace(legacy)
  expect(migrated.systems[0].architecture.description).toBe('a'.repeat(9999))
  expect(getProject(migrated).sections[0].content).toBe(legacy.projects[0].sections[0].content)
})

it('删除当前模块所属的系统时清除整个系统并选中其他系统', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v2.json')
  const workspace = saveArchitecture(
    workspaceSchema.parse(fixture),
    createArchitecture('保留的系统'),
  )
  workspace.activeNodeId = 'leads'
  const remaining = workspace.systems[1]
  const deleted = deleteSystem(workspace, 'fixture-project')
  expect(deleted.systems).toEqual([remaining])
  expect(deleted.activeNodeId).toBe(remaining.architecture.id)
  expect(workspace.systems).toHaveLength(2)
})

it('删除非当前系统保留当前模块，最后一个系统删除后允许空工作区', async () => {
  const { default: fixture } = await import('./fixtures/workspace-v2.json')
  const workspace = saveArchitecture(
    workspaceSchema.parse(fixture),
    createArchitecture('另一个系统'),
  )
  workspace.activeNodeId = 'leads'
  const deleted = deleteSystem(workspace, workspace.systems[1].architecture.id)
  expect(deleted.activeNodeId).toBe('leads')
  const empty = deleteSystem(deleted, 'fixture-project')
  expect(empty).toEqual({ schemaVersion: 2, activeNodeId: null, systems: [] })
  expect(parseWorkspace(JSON.parse(JSON.stringify(empty)))).toEqual(empty)
  expect(workspaceSchema.safeParse({ ...empty, activeNodeId: 'leads' }).success).toBe(false)
  expect(workspaceSchema.safeParse({ ...deleted, activeNodeId: null }).success).toBe(false)
  const created = saveArchitecture(empty, createArchitecture('重新开始'))
  expect(getProject(created).name).toBe('重新开始')
})

it('不存在的系统不能删除，迟到的回复不会恢复已删除的系统', () => {
  const workspace = createInitialWorkspace()
  const id = workspace.systems[0].architecture.id
  expect(() => deleteSystem(workspace, 'missing')).toThrow('应用系统不存在')
  const empty = deleteSystem(workspace, id)
  expect(
    updateNodeContent(empty, id, () => {
      throw new Error('不得执行已删除节点的更新')
    }),
  ).toBe(empty)
})
