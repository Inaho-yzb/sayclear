import { describe, expect, it, vi } from 'vitest'
import {
  createExportBundle,
  planExport,
  type ExportBundle,
  type ExportChange,
  type ExportOptions,
} from '../src/shared/export'
import { defaultComponentCatalog } from '../src/shared/component-catalog'
import { emptyDiagram, newComponent, type Diagram, type GraphSnapshot } from '../src/shared/diagram'
import { iterationExample, snapshot, startIteration } from '../src/shared/iteration'
import {
  buildSystem,
  createArchitecture,
  workspaceSchema,
  type Workspace,
} from '../src/shared/model'
import { exportZip } from '../src/shared/export-zip'
import { createReference, referenceBoards } from '../src/shared/diagram-references'

const exportedAt = '2026-11-01T03:04:05.000Z'
const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({
  scope: 'board',
  boardId: 'leaf',
  includeHistory: false,
  ...overrides,
})
function fixture(): Workspace {
  const architecture = {
    ...createArchitecture('客户系统'),
    id: 'customer-system',
    boards: [
      {
        id: 'group',
        name: '账户模块',
        description: '账户与注册',
        kind: 'aggregate' as const,
        parentId: 'customer-system',
      },
      {
        id: 'leaf',
        name: '注册图',
        description: '完整注册流程',
        kind: 'atomic' as const,
        parentId: 'group',
      },
    ],
  }
  const system = buildSystem(architecture)
  system.contents.find((content) => content.id === 'leaf')!.diagram = iterationExample()
  const external = buildSystem({ ...createArchitecture('消息系统'), id: 'message-system' })
  return workspaceSchema.parse({
    schemaVersion: 2,
    activeNodeId: 'leaf',
    systems: [system, external],
  })
}
function setGraph(workspace: Workspace, graph: Diagram) {
  workspace.systems[0].contents.find((content) => content.id === 'leaf')!.diagram = graph
}
function file(bundle: ExportBundle, path: string) {
  const found = bundle.files.find((item) => item.path === path)
  expect(found, `missing ${path}`).toBeDefined()
  return found!.content
}
function read<T>(bundle: ExportBundle, path: string): T {
  return JSON.parse(file(bundle, path)) as T
}
type Report = {
  schemaVersion: number
  boardId: string
  comparison: { kind: string; id: string | null; before: string | null; after: string }
  counts: {
    components: { added: number; modified: number; removed: number }
    connections: { added: number; modified: number; removed: number }
    total: number
  }
  changes: ExportChange[]
  affectedComponentIds: string[]
}
type Manifest = {
  format: string
  schemaVersion: number
  includesHistory: boolean
  scope: { type: string; boardId: string | null }
  counts: { boardCount: number; historyCount: number; historyChangeCount: number }
  entrypoints: Record<string, string>
  boards: {
    id: string
    graphPath: string
    baselinePath: string | null
    history: { id: string; path: string; changesPath: string }[]
    omittedHistoryCount: number
  }[]
  references: {
    componentId: string
    sourceBoardId: string
    sourcePath: string | null
    cachedDefinition: boolean
    status: 'ok' | 'changed' | 'missing'
    message: string
  }[]
  warnings: string[]
  files: { path: string; mediaType: string; bytes: number | null }[]
}
function boardPath(bundle: ExportBundle, boardId: string, name: string) {
  const board = read<Manifest>(bundle, 'manifest.json').boards.find((item) => item.id === boardId)!
  return board.graphPath.replace(/graph\.json$/, name)
}
function historyPath(bundle: ExportBundle, boardId: string, versionId: string, changes = false) {
  const version = read<Manifest>(bundle, 'manifest.json')
    .boards.find((item) => item.id === boardId)!
    .history.find((item) => item.id === versionId)!
  return changes ? version.changesPath : version.path
}
function historyGraph() {
  const component = {
    ...newComponent('action'),
    id: 'stable-action',
    name: '最初现状',
    inputs: [],
    outputs: [],
  }
  const first = snapshot({ ...emptyDiagram(), components: [component] })
  const second = snapshot(first)
  second.components[0].name = '第二次现状'
  const current = snapshot(second)
  current.components[0].name = '当前现状'
  const draft = startIteration({ ...current, history: [] }, '当前迭代')
  draft.iteration!.id = 'active-iteration'
  draft.components[0].name = '尚未发布的草稿'
  draft.history = [
    {
      id: 'first-history',
      name: '第一次更新前',
      publishedAt: '2026-10-30T00:00:00.000Z',
      componentCount: 1,
      connectionCount: 0,
      snapshotDigest: '0123456789abcdef',
    },
    {
      id: 'second-history',
      name: '第二次更新前',
      publishedAt: '2026-10-31T00:00:00.000Z',
      snapshot: second,
    },
  ]
  return { draft, first, second, current }
}

describe('结构化图与变更交付包', () => {
  it('根据稳定画板身份选择当前图、系统全部下级与工作区，并保留必要祖先结构', async () => {
    const workspace = fixture()
    expect(planExport(workspace, options())).toMatchObject({
      name: '注册图',
      boardCount: 1,
      iterationCount: 1,
      changeCount: 14,
    })
    expect(planExport(workspace, options({ scope: 'system' }))).toMatchObject({
      name: '客户系统',
      boardCount: 3,
    })
    expect(
      planExport(workspace, options({ scope: 'workspace', boardId: 'not-needed' })),
    ).toMatchObject({ boardCount: 4 })
    const bundle = await createExportBundle(workspace, options(), { exportedAt })
    const structure = read<{
      systems: { systemId: string; nodes: { id: string; graphIncluded: boolean }[] }[]
    }>(bundle, 'structure.json')
    expect(structure.systems).toHaveLength(1)
    expect(structure.systems[0].nodes.map((node) => [node.id, node.graphIncluded])).toEqual([
      ['customer-system', false],
      ['group', false],
      ['leaf', true],
    ])
    expect(bundle.files.some((item) => item.path.startsWith('boards/group/'))).toBe(false)
    const full = await createExportBundle(workspace, options({ scope: 'system' }), { exportedAt })
    expect(read<Manifest>(full, 'manifest.json').boards.map((board) => board.id)).toEqual([
      'customer-system',
      'group',
      'leaf',
    ])
    expect(() => planExport(workspace, options({ boardId: 'missing' }))).toThrow('不存在')
    expect(() =>
      planExport(
        { ...workspace, systems: [], activeNodeId: null },
        options({ scope: 'workspace' }),
      ),
    ).toThrow('为空')
  })

  it('完整导出增删改的对象、连接端点和字段前后值，关联提示不计作变更', async () => {
    const workspace = fixture()
    const graph = workspace.systems[0].contents.find((content) => content.id === 'leaf')!.diagram!
    graph.connections.find((edge) => edge.id === 'submit')!.condition = '用户已同意注册条款'
    graph.connections.find((edge) => edge.id === 'submit')!.protocol = 'HTTPS'
    const bundle = await createExportBundle(workspace, options(), { exportedAt })
    const report = read<Report>(bundle, boardPath(bundle, 'leaf', 'changes.json'))
    expect(report.counts).toEqual({
      components: { added: 4, modified: 4, removed: 1 },
      connections: { added: 4, modified: 1, removed: 1 },
      total: 15,
    })
    expect(report.comparison).toMatchObject({
      kind: 'active-iteration',
      before: boardPath(bundle, 'leaf', 'baseline.json'),
      after: boardPath(bundle, 'leaf', 'graph.json'),
    })
    expect(report.changes.find((change) => change.id === 'sms')).toMatchObject({
      status: 'added',
      before: null,
      after: { id: 'sms', boundary: 'external', description: '发送注册验证码，由第三方提供服务。' },
    })
    expect(report.changes.find((change) => change.id === 'welcome')).toMatchObject({
      status: 'removed',
      before: { name: '注册欢迎页' },
      after: null,
    })
    expect(report.changes.find((change) => change.id === 'show-welcome')).toMatchObject({
      status: 'removed',
      before: { sourceId: 'create-user', targetId: 'welcome' },
      after: null,
    })
    expect(report.changes.find((change) => change.id === 'submit')?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/protocol',
          before: '',
          after: 'HTTPS',
          beforeExists: true,
          afterExists: true,
        }),
        expect.objectContaining({ path: '/condition', before: '', after: '用户已同意注册条款' }),
      ]),
    )
    expect(report.affectedComponentIds).toContain('visitor')
    expect(report.changes.some((change) => change.id === 'visitor')).toBe(false)
    for (const path of ['changes.md', boardPath(bundle, 'leaf', 'changes.md')]) {
      const markdown = file(bundle, path)
      expect(markdown).not.toContain('完整对象')
      expect(markdown).not.toContain('```json')
      expect(markdown).not.toContain('templateId')
      expect(markdown).not.toContain('sourceId')
      expect(markdown).toContain('#### 协议')
      expect(markdown).toContain('**变更前**')
      expect(markdown).toContain('**变更后**')
      expect(markdown).toContain('> HTTPS')
      expect(markdown).toContain('用户已同意注册条款')
      expect(markdown).toContain('发送注册验证码，由第三方提供服务。')
      expect(markdown).toContain('创建账号 → 注册欢迎页')
    }
    expect(read<GraphSnapshot>(bundle, boardPath(bundle, 'leaf', 'baseline.json'))).toEqual(
      snapshot(graph.iteration!.baseline),
    )
    expect(read<GraphSnapshot>(bundle, boardPath(bundle, 'leaf', 'graph.json'))).toEqual(
      snapshot(graph),
    )
  })

  it('校验策略、端口与自定义属性保留原始结构和值，支持缺失字段标记', async () => {
    const workspace = fixture()
    const checker = { ...newComponent('validation'), id: 'checker', name: '注册校验' }
    checker.validation!.rules = [
      {
        id: 'phone-rule',
        name: '手机号格式',
        condition: 'phone.length === 11',
        when: '使用手机号注册',
        failureMessage: '请输入 11 位手机号',
      },
    ]
    const data = { ...newComponent('data'), id: 'user', metadata: { fields: 'id' } }
    const graph = startIteration(
      { ...emptyDiagram(), components: [checker, data] },
      '修改校验与输入',
    )
    graph.components[0].validation!.rules[0].failureMessage = '手机号必须为 11 位数字'
    graph.components[0].validation!.strategy = 'stopWhenDecided'
    graph.components[0].inputs[0].description = '包含手机号、设备标识与注册来源'
    graph.components[1].metadata = { fields: 'id,phone', identity: 'id' }
    setGraph(workspace, graph)
    const bundle = await createExportBundle(workspace, options(), { exportedAt })
    const report = read<Report>(bundle, boardPath(bundle, 'leaf', 'changes.json'))
    const checkChange = report.changes.find((change) => change.id === 'checker')!
    expect(checkChange.fields.find((field) => field.path === '/validation')).toMatchObject({
      before: graph.iteration!.baseline.components[0].validation,
      after: graph.components[0].validation,
    })
    expect(checkChange.fields.find((field) => field.path === '/inputs')?.after).toEqual(
      graph.components[0].inputs,
    )
    const identity = report.changes
      .find((change) => change.id === 'user')!
      .fields.find((field) => field.path === '/metadata/identity')!
    expect(identity).toMatchObject({
      before: null,
      beforeExists: false,
      after: 'id',
      afterExists: true,
    })
    const template = defaultComponentCatalog.scenarios[0].components.find(
      (item) => item.id === data.templateId,
    )!
    expect(identity.label).toBe(
      `属性 / ${template.fields.find((field) => field.id === 'identity')!.name}`,
    )
    expect(file(bundle, boardPath(bundle, 'leaf', 'changes.md'))).toContain(
      '手机号必须为 11 位数字',
    )
  })

  it('忽略布局和属性键顺序，且没有迭代的现状不会被误记为新增', async () => {
    const workspace = fixture()
    const component = {
      ...newComponent('data'),
      id: 'data',
      metadata: { fields: 'id,phone', identity: 'id' },
    }
    const graph = startIteration({ ...emptyDiagram(), components: [component] }, '仅布局')
    graph.components[0].position = { x: 1500, y: -500 }
    graph.components[0].metadata = { identity: 'id', fields: 'id,phone' }
    setGraph(workspace, graph)
    const bundle = await createExportBundle(workspace, options(), { exportedAt })
    expect(read<Report>(bundle, boardPath(bundle, 'leaf', 'changes.json')).counts.total).toBe(0)
    expect(
      read<GraphSnapshot>(bundle, boardPath(bundle, 'leaf', 'graph.json')).components[0].position,
    ).toEqual({
      x: 1500,
      y: -500,
    })
    setGraph(workspace, { ...snapshot(graph), history: [] })
    const current = await createExportBundle(workspace, options(), { exportedAt })
    expect(read<Report>(current, boardPath(current, 'leaf', 'changes.json'))).toMatchObject({
      comparison: { kind: 'none', before: null },
      counts: { total: 0 },
      changes: [],
    })
    expect(current.files.some((item) => item.path.endsWith('/baseline.json'))).toBe(false)
    expect(file(current, 'changes.md')).toContain('不将现状中的对象视为新增')
  })

  it('按需加载缺失历史，将最后一个历史快照对比当前现状基线而非草稿', async () => {
    const workspace = fixture()
    const { draft, first } = historyGraph()
    setGraph(workspace, draft)
    const loadHistory = vi.fn().mockResolvedValue(first)
    const omitted = await createExportBundle(workspace, options(), { exportedAt, loadHistory })
    expect(loadHistory).not.toHaveBeenCalled()
    expect(read<Manifest>(omitted, 'manifest.json').boards[0].omittedHistoryCount).toBe(2)
    const bundle = await createExportBundle(workspace, options({ includeHistory: true }), {
      exportedAt,
      loadHistory,
    })
    expect(loadHistory).toHaveBeenCalledExactlyOnceWith('leaf', 'first-history')
    const firstReport = read<Report>(bundle, historyPath(bundle, 'leaf', 'first-history', true))
    expect(firstReport.comparison).toMatchObject({
      kind: 'history-interval',
      after: historyPath(bundle, 'leaf', 'second-history'),
    })
    expect(firstReport.changes[0]).toMatchObject({
      before: { name: '最初现状' },
      after: { name: '第二次现状' },
    })
    const latest = read<Report>(bundle, historyPath(bundle, 'leaf', 'second-history', true))
    expect(latest.comparison.after).toBe(boardPath(bundle, 'leaf', 'baseline.json'))
    expect(latest.changes[0]).toMatchObject({
      before: { name: '第二次现状' },
      after: { name: '当前现状' },
    })
    expect(
      read<Report>(bundle, boardPath(bundle, 'leaf', 'changes.json')).changes[0],
    ).toMatchObject({
      before: { name: '当前现状' },
      after: { name: '尚未发布的草稿' },
    })
    expect(read<Manifest>(bundle, 'manifest.json').counts).toMatchObject({
      historyCount: 2,
      historyChangeCount: 2,
    })
    expect(file(bundle, 'changes.md')).toContain('非逐次操作日志')
  })

  it('历史缺失、读取失败或格式无效时拒绝整个导出，避免交付不完整历史', async () => {
    const workspace = fixture()
    const { draft, first } = historyGraph()
    setGraph(workspace, draft)
    const selected = options({ includeHistory: true })
    await expect(createExportBundle(workspace, selected, { exportedAt })).rejects.toThrow(
      '历史快照未加载',
    )
    await expect(
      createExportBundle(workspace, selected, {
        exportedAt,
        loadHistory: async () => {
          throw new Error('历史文件损坏')
        },
      }),
    ).rejects.toThrow('历史文件损坏')
    await expect(
      createExportBundle(workspace, selected, {
        exportedAt,
        loadHistory: async () => ({
          ...first,
          components: [...first.components, ...first.components],
        }),
      }),
    ).rejects.toThrow('组件 ID 不能重复')
    await expect(
      createExportBundle(workspace, selected, {
        exportedAt,
        loadHistory: async () => ({ ...first, scenarioId: 'other-scene' }),
      }),
    ).rejects.toThrow('历史场景')
    const invalidTemplate = snapshot(first)
    invalidTemplate.components[0].templateId = 'not-in-catalog'
    await expect(
      createExportBundle(workspace, selected, {
        exportedAt,
        loadHistory: async () => invalidTemplate,
      }),
    ).rejects.toThrow(/历史.*无效/)
    const invalidMetadata = snapshot(first)
    invalidMetadata.components[0].metadata = { undefinedField: '不可识别的值' }
    await expect(
      createExportBundle(workspace, selected, {
        exportedAt,
        loadHistory: async () => invalidMetadata,
      }),
    ).rejects.toThrow('未定义的属性')
  })

  it('导出等待历史期间的工作区编辑不会污染包内快照，导出本身不修改来源', async () => {
    const workspace = fixture()
    const { draft, first } = historyGraph()
    setGraph(workspace, draft)
    const original = structuredClone(workspace)
    let resolve!: (value: GraphSnapshot) => void
    const waiting = new Promise<GraphSnapshot>((done) => {
      resolve = done
    })
    const loadHistory = vi.fn(() => waiting)
    const selected = options({ includeHistory: true })
    const pending = createExportBundle(workspace, selected, { exportedAt, loadHistory })
    expect(loadHistory).toHaveBeenCalledOnce()
    expect(workspace).toEqual(original)
    workspace.systems[0].architecture.boards[1].name = '导出期间改名'
    workspace.systems[0].contents.find(
      (content) => content.id === 'leaf',
    )!.diagram!.components[0].name = '导出期间改图'
    const changed = structuredClone(workspace)
    resolve(first)
    const bundle = await pending
    expect(
      read<GraphSnapshot>(bundle, boardPath(bundle, 'leaf', 'graph.json')).components[0].name,
    ).toBe('尚未发布的草稿')
    expect(file(bundle, boardPath(bundle, 'leaf', 'README.md'))).toContain('# 注册图')
    expect(workspace).toEqual(changed)
    expect(draft.history[0].snapshot).toBeUndefined()
  })

  it('等待期间选项改变不会造成清单与已选历史范围不一致', async () => {
    const workspace = fixture()
    const { draft, first } = historyGraph()
    setGraph(workspace, draft)
    let resolve!: (value: GraphSnapshot) => void
    const selected = options({ includeHistory: true })
    const pending = createExportBundle(workspace, selected, {
      exportedAt,
      loadHistory: () =>
        new Promise((done) => {
          resolve = done
        }),
    })
    selected.includeHistory = false
    selected.scope = 'workspace'
    selected.boardId = 'message-system'
    resolve(first)
    const bundle = await pending
    expect(read<Manifest>(bundle, 'manifest.json')).toMatchObject({
      includesHistory: true,
      scope: { type: 'board', boardId: 'leaf' },
      counts: { boardCount: 1, historyCount: 2 },
    })
  })

  it('范围外引用保留缓存定义并明确告警，纳入来源时连接到正确的现状文件', async () => {
    const workspace = fixture()
    const source = startIteration(
      {
        ...emptyDiagram(),
        components: [
          {
            ...newComponent('capability'),
            id: 'source-entry',
            exposed: true,
            name: '已采用的来源',
          },
        ],
      },
      '来源迭代',
    )
    workspace.systems[1].contents[0].diagram = source
    const reference = {
      ...createReference(referenceBoards(workspace), 'leaf', {
        boardId: 'message-system',
        componentId: 'source-entry',
        version: 'current',
        outputIds: [],
      }),
      id: 'adopted-reference',
    }
    setGraph(workspace, { ...emptyDiagram(), components: [reference] })
    const selected = await createExportBundle(workspace, options(), { exportedAt })
    const selectedManifest = read<Manifest>(selected, 'manifest.json')
    expect(selectedManifest.references).toEqual([
      expect.objectContaining({
        componentId: reference.id,
        sourceBoardId: 'message-system',
        sourcePath: null,
        cachedDefinition: true,
      }),
    ])
    expect(selectedManifest.warnings).toEqual([expect.stringContaining('已保留采用的缓存定义')])
    expect(
      read<GraphSnapshot>(selected, boardPath(selected, 'leaf', 'graph.json')).components[0],
    ).toEqual(reference)
    const full = await createExportBundle(workspace, options({ scope: 'workspace' }), {
      exportedAt,
    })
    const fullManifest = read<Manifest>(full, 'manifest.json')
    expect(fullManifest.references[0].sourcePath).toBe(
      boardPath(full, 'message-system', 'baseline.json'),
    )
    expect(fullManifest.warnings).toEqual([])
  })

  it('引用来源变化或不再开放时，清单记录状态与提示，仍保留已采用定义', async () => {
    const workspace = fixture()
    const source = {
      ...emptyDiagram(),
      components: [
        {
          ...newComponent('capability'),
          id: 'entry',
          name: '原始入口',
          description: '已采用的说明',
          exposed: true,
        },
      ],
    }
    workspace.systems[1].contents[0].diagram = source
    const adopted = createReference(referenceBoards(workspace), 'leaf', {
      boardId: 'message-system',
      componentId: 'entry',
      version: 'current',
      outputIds: [],
    })
    setGraph(workspace, { ...emptyDiagram(), components: [adopted] })
    source.components[0].description = '来源已更新的说明'
    const changed = await createExportBundle(workspace, options({ scope: 'workspace' }), {
      exportedAt,
    })
    const changedManifest = read<Manifest>(changed, 'manifest.json')
    expect(changedManifest.references[0]).toMatchObject({
      status: 'changed',
      cachedDefinition: true,
      sourcePath: boardPath(changed, 'message-system', 'graph.json'),
    })
    expect(changedManifest.warnings).toEqual([expect.stringContaining('来源定义已变化')])
    expect(
      read<GraphSnapshot>(changed, boardPath(changed, 'leaf', 'graph.json')).components[0]
        .description,
    ).toBe('已采用的说明')
    source.components[0].exposed = false
    const missing = await createExportBundle(workspace, options({ scope: 'workspace' }), {
      exportedAt,
    })
    expect(read<Manifest>(missing, 'manifest.json').references[0]).toMatchObject({
      status: 'missing',
      message: expect.stringContaining('不再对外开放'),
    })
    expect(read<Manifest>(missing, 'manifest.json').warnings).toEqual([
      expect.stringContaining('不再对外开放'),
    ])
  })

  it('合法的 Windows 保留名、大小写相异及最长画板与历史 ID 均能导出 ZIP，稳定身份保留在清单', async () => {
    const longestId = 'x'.repeat(80)
    const longestHistoryId = 'v'.repeat(80)
    const architecture = {
      ...createArchitecture('跨平台导出'),
      id: 'con',
      boards: ['A', 'a', longestId].map((id, index) => ({
        id,
        name: `画板 ${index}`,
        description: '',
        kind: 'atomic' as const,
        parentId: 'con',
      })),
    }
    const system = buildSystem(architecture)
    system.contents.find((content) => content.id === longestId)!.diagram = {
      ...emptyDiagram(),
      history: [
        {
          id: 'CON',
          name: '保留名称',
          publishedAt: '2026-10-30T00:00:00.000Z',
          snapshot: snapshot(emptyDiagram()),
        },
        {
          id: longestHistoryId,
          name: '最长历史',
          publishedAt: '2026-10-31T00:00:00.000Z',
          snapshot: snapshot(emptyDiagram()),
        },
      ],
    }
    const workspace = workspaceSchema.parse({
      schemaVersion: 2,
      activeNodeId: 'con',
      systems: [system],
    })
    const bundle = await createExportBundle(
      workspace,
      options({ scope: 'workspace', boardId: 'con', includeHistory: true }),
      { exportedAt },
    )
    const manifest = read<Manifest>(bundle, 'manifest.json')
    expect(manifest.boards.map((board) => board.id)).toEqual(['con', 'A', 'a', longestId])
    expect(
      manifest.boards.find((board) => board.id === longestId)!.history.map((version) => version.id),
    ).toEqual(['CON', longestHistoryId])
    expect(new Set(bundle.files.map((entry) => entry.path.toLowerCase())).size).toBe(
      bundle.files.length,
    )
    expect(bundle.files.every((entry) => entry.path.length <= 240)).toBe(true)
    const zip = exportZip(bundle)
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50)
    expect(zip.byteLength).toBeGreaterThan(0)
  })

  it('Unicode 与 Markdown 围栏内容原样保留，并为清单列出每个实际文件及 UTF-8 字节数', async () => {
    const workspace = fixture()
    const graph = iterationExample()
    const payload =
      '中文🙂\n```json\n{"note":"原样保留"}\n```\n````\n<script>alert("example")</script>'
    graph.components.find((component) => component.id === 'signup-page')!.description = payload
    setGraph(workspace, graph)
    const bundle = await createExportBundle(workspace, options(), { exportedAt })
    const manifest = read<Manifest>(bundle, 'manifest.json')
    expect(bundle.name).toBe('say-clear-export-20261101T030405000Z')
    expect(
      read<GraphSnapshot>(bundle, boardPath(bundle, 'leaf', 'graph.json')).components.find(
        (component) => component.id === 'signup-page',
      )!.description,
    ).toBe(payload)
    const markdown = file(bundle, 'changes.md')
    expect(markdown).toContain('> 中文🙂')
    expect(markdown).toContain('> \\`\\`\\`json')
    expect(markdown).not.toMatch(/^`{3,}/m)
    expect(markdown).not.toContain('<script>')
    expect(
      read<Report>(bundle, boardPath(bundle, 'leaf', 'changes.json')).changes.find(
        (change) => change.id === 'signup-page',
      )!.after!.description,
    ).toBe(payload)
    const paths = bundle.files.map((item) => item.path)
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)))
    expect(new Set(paths).size).toBe(paths.length)
    expect(manifest.files.map((item) => item.path).sort()).toEqual([...paths].sort())
    for (const entry of manifest.files) {
      expect(entry.path).not.toMatch(/(^|\/)\.\.?($|\/)|\\/)
      if (entry.path === 'manifest.json') expect(entry.bytes).toBeNull()
      else expect(entry.bytes).toBe(new TextEncoder().encode(file(bundle, entry.path)).length)
    }
    for (const path of Object.values(manifest.entrypoints)) expect(paths).toContain(path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'templates/change-request.md',
        'templates/ai-handoff.md',
        'catalog.json',
        'structure.json',
        'diagram.html',
      ]),
    )
    expect(manifest.boards[0]).toMatchObject({
      id: 'leaf',
      graphPath: boardPath(bundle, 'leaf', 'graph.json'),
      baselinePath: boardPath(bundle, 'leaf', 'baseline.json'),
    })
    expect(manifest.format).toBe('say-clear.export')
    expect(manifest.schemaVersion).toBe(1)
    expect(read(bundle, 'catalog.json')).toEqual(defaultComponentCatalog)
    await expect(
      createExportBundle(workspace, options(), { exportedAt: 'invalid-date' }),
    ).rejects.toThrow('导出时间无效')
  })
})
