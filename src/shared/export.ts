import {
  catalogDiagramError,
  defaultComponentCatalog,
  getTemplate,
  type ComponentCatalog,
} from './component-catalog'
import {
  graphSnapshotSchema,
  type DiagramComponent,
  type DiagramConnection,
  type GraphSnapshot,
} from './diagram'
import { renderExportHtml, type ExportHtmlData } from './export-html'
import { exportTemplates } from './export-templates'
import { exportBoardPath, exportHistoryPath } from './export-paths'
import { affectedComponents, changeLabels, iterationChanges, snapshot } from './iteration'
import { iterationBoards, type IterationBoard } from './iteration-management'
import { flattenArchitecture, workspaceSchema, type Workspace } from './model'
import { resolveReference } from './diagram-references'
import { collectChangeExport, planChangeExport } from './export-change-scope'
import { renderChangeMarkdown, type MarkdownReviewContext } from './export-markdown-review'

export type ExportOptions = {
  mode?: 'all' | 'changes'
  scope: 'board' | 'system' | 'workspace'
  boardId: string
  includeHistory: boolean
}
export type ExportFile = { path: string; content: string }
export type ExportBundle = { name: string; files: ExportFile[] }
export type ExportField = {
  path: string
  label: string
  before: unknown
  after: unknown
  beforeExists: boolean
  afterExists: boolean
}
export type ExportChange = {
  kind: 'component' | 'connection'
  id: string
  name: string
  status: 'added' | 'modified' | 'removed'
  fields: ExportField[]
  before: DiagramComponent | DiagramConnection | null
  after: DiagramComponent | DiagramConnection | null
}
type Counts = Record<ExportChange['status'], number>
type ChangeReport = {
  schemaVersion: 1
  boardId: string
  comparison: {
    kind: 'active-iteration' | 'history-interval' | 'context' | 'none'
    id: string | null
    name: string
    before: string | null
    after: string
    startedAt?: string
    publishedAt?: string
    git?: NonNullable<IterationBoard['diagram']['iteration']>['git']
  }
  counts: { components: Counts; connections: Counts; total: number }
  changes: ExportChange[]
  affectedComponentIds: string[]
}
export type ExportChangeReport = ChangeReport
type ExportReference = {
  boardId: string
  version: string
  componentId: string
  sourceBoardId: string
  sourceComponentId: string
  sourceVersion: string
  sourcePath: string | null
  cachedDefinition: true
  status: 'ok' | 'changed' | 'missing'
  message: string
}

const labels: Record<string, string> = {
  name: '名称',
  description: '说明',
  type: '类型',
  templateId: '组件模板',
  boundary: '系统边界',
  exposed: '对外开放',
  reference: '画板引用',
  ownerId: '归属组件',
  inputs: '输入端口',
  outputs: '输出端口',
  metadata: '属性',
  validation: '校验配置',
  sourceId: '起点组件',
  targetId: '终点组件',
  sourcePortId: '输出端口',
  targetPortId: '输入端口',
  protocol: '协议',
  condition: '触发条件',
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const inline = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#|]/g, '\\$&')
function block(value: unknown): string {
  const content = JSON.stringify(value, null, 2) ?? 'null'
  const fence = '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${fence}json\n${content}\n${fence}`
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? ''
}
function selectedBoards(workspace: Workspace, options: ExportOptions): IterationBoard[] {
  const boards = iterationBoards(workspace)
  if (options.scope === 'workspace') {
    if (!boards.length) throw new Error('工作空间为空，暂无可导出的画板')
    return boards
  }
  const active = boards.find((board) => board.id === options.boardId)
  if (!active) throw new Error('导出画板已不存在，请重新选择')
  return options.scope === 'board'
    ? [active]
    : boards.filter((board) => board.systemId === active.systemId)
}

export function planExport(workspace: Workspace, options: ExportOptions) {
  const seeds = selectedBoards(workspace, options)
  const projection =
    options.mode === 'changes'
      ? planChangeExport(
          workspace,
          seeds.map((b) => b.id),
        )
      : undefined
  const boards = projection
    ? iterationBoards(workspace).filter((b) => projection.boardIds.includes(b.id))
    : seeds
  return {
    name:
      options.scope === 'workspace'
        ? '整个工作空间'
        : options.scope === 'system'
          ? seeds[0].systemName
          : seeds[0].name,
    boardCount: boards.length,
    iterationCount: projection
      ? projection.changedBoardIds.length
      : boards.filter((b) => b.diagram.iteration).length,
    changedBoardCount:
      projection?.changedBoardIds.length ??
      boards.filter((b) => iterationChanges(b.diagram).some((c) => c.status !== 'unchanged'))
        .length,
    relatedBoardCount: projection ? boards.length - projection.changedBoardIds.length : 0,
    historyCount:
      options.includeHistory && options.mode !== 'changes'
        ? boards.reduce((n, b) => n + b.diagram.history.length, 0)
        : 0,
    changeCount:
      projection?.changeCount ??
      boards.reduce(
        (n, b) => n + iterationChanges(b.diagram).filter((c) => c.status !== 'unchanged').length,
        0,
      ),
  }
}

function rawFields(
  before: ExportChange['before'],
  after: ExportChange['after'],
  catalog: ComponentCatalog,
  graph: GraphSnapshot,
): ExportField[] {
  if (!before || !after) return []
  const a = before as Record<string, unknown>,
    b = after as Record<string, unknown>
  const template = 'templateId' in after ? getTemplate(catalog, graph, after) : undefined
  const fields: ExportField[] = []
  const add = (path: string, label: string, av: unknown, bv: unknown) => {
    if (canonical(av) !== canonical(bv))
      fields.push({
        path,
        label,
        before: av ?? null,
        after: bv ?? null,
        beforeExists: av !== undefined,
        afterExists: bv !== undefined,
      })
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'id' || key === 'position') continue
    if (key === 'metadata') {
      const av = (a.metadata ?? {}) as Record<string, string>,
        bv = (b.metadata ?? {}) as Record<string, string>
      for (const field of new Set([...Object.keys(av), ...Object.keys(bv)])) {
        if ((av[field] ?? '') === (bv[field] ?? '')) continue
        add(
          `/metadata/${field}`,
          `属性 / ${template?.fields.find((f) => f.id === field)?.name ?? field}`,
          av[field],
          bv[field],
        )
      }
    } else add(`/${key}`, labels[key] ?? key, a[key], b[key])
  }
  return fields
}
function report(
  board: IterationBoard,
  before: GraphSnapshot | null,
  after: GraphSnapshot,
  comparison: ChangeReport['comparison'],
  catalog: ComponentCatalog,
): ChangeReport {
  const model = {
    ...snapshot(after),
    history: [],
    ...(before
      ? {
          iteration: {
            id: comparison.id ?? 'export',
            name: comparison.name,
            startedAt: comparison.startedAt ?? '1970-01-01T00:00:00.000Z',
            baseline: before,
          },
        }
      : {}),
  }
  const changes: ExportChange[] = iterationChanges(model).flatMap((change) => {
    if (change.status === 'unchanged') return []
    const oldItems = change.kind === 'component' ? before?.components : before?.connections
    const newItems = change.kind === 'component' ? after.components : after.connections
    const old = oldItems?.find((item) => item.id === change.id) ?? null
    const next = newItems.find((item) => item.id === change.id) ?? null
    return [
      {
        kind: change.kind,
        id: change.id,
        name: change.name,
        status: change.status,
        fields: rawFields(old, next, catalog, after),
        before: old,
        after: next,
      },
    ]
  })
  const count = (kind: ExportChange['kind']): Counts => ({
    added: changes.filter((c) => c.kind === kind && c.status === 'added').length,
    modified: changes.filter((c) => c.kind === kind && c.status === 'modified').length,
    removed: changes.filter((c) => c.kind === kind && c.status === 'removed').length,
  })
  return {
    schemaVersion: 1,
    boardId: board.id,
    comparison,
    counts: {
      components: count('component'),
      connections: count('connection'),
      total: changes.length,
    },
    changes,
    affectedComponentIds: [...affectedComponents(model)].sort(),
  }
}
function reportMarkdown(
  board: IterationBoard,
  entry: ChangeReport,
  context: MarkdownReviewContext,
  prefix = '',
): string {
  const counts = entry.counts
  const lines = [
    `## ${inline(board.path)} · ${inline(entry.comparison.name)}`,
    '',
    `- 画板 ID：\`${board.id}\``,
    `- 对比类型：${{ 'active-iteration': '本次迭代与固定现状基线', 'history-interval': '历史现状区间（快照推导，非逐次操作日志）', context: '关联上下文（不计入所选变更）', none: '无活动迭代' }[entry.comparison.kind]}`,
    `- 基线文件：${entry.comparison.before ? `[${entry.comparison.before}](${prefix}${entry.comparison.before})` : '无比较基线'}`,
    `- 结果文件：[${entry.comparison.after}](${prefix}${entry.comparison.after})`,
    `- 组件：新增 ${counts.components.added} / 修改 ${counts.components.modified} / 删除 ${counts.components.removed}`,
    `- 连接：新增 ${counts.connections.added} / 修改 ${counts.connections.modified} / 删除 ${counts.connections.removed}`,
    '',
  ]
  if (entry.comparison.id) lines.push(`- 迭代 / 区间 ID：\`${entry.comparison.id}\``, '')
  if (entry.comparison.startedAt) lines.push(`- 迭代开始时间：${entry.comparison.startedAt}`, '')
  if (entry.comparison.publishedAt)
    lines.push(`- 区间更新记录时间：${entry.comparison.publishedAt}`, '')
  if (entry.comparison.git) {
    const git = entry.comparison.git
    lines.push(
      '### Git 关联',
      '',
      `- 分支：${inline(git.branch)}`,
      `- 基准分支：${inline(git.baseBranch)}`,
      `- 起点提交：${git.baseCommit}`,
      '',
    )
  }
  if (!entry.changes.length)
    lines.push(
      entry.comparison.kind === 'none'
        ? '没有活动迭代，因此不将现状中的对象视为新增。完整内容见画板清单与 graph.json。'
        : entry.comparison.kind === 'context'
          ? '此画板因归属或引用关系附带，供理解所选变更；其中独立的迭代不计入本次交付的变更。'
          : '该区间没有业务变更。位置移动不计入业务变更。',
      '',
    )
  for (const change of entry.changes) {
    lines.push(
      `### ${changeLabels[change.status]}${change.kind === 'component' ? '组件' : '连接'}：${inline(change.name)}`,
      '',
      `对象 ID：\`${change.id}\``,
      '',
    )
    lines.push(renderChangeMarkdown(change, context), '')
  }
  if (entry.affectedComponentIds.length)
    lines.push(
      '### 相邻关联提示',
      '',
      '以下组件与实际变更相邻，建议复核；此列表不代表它们发生了变更。',
      '',
      ...entry.affectedComponentIds.map((id) => {
        const component =
          context.after.components.find((item) => item.id === id) ??
          context.before?.components.find((item) => item.id === id)
        return `- ${inline(component?.name ?? id)}`
      }),
      '',
    )
  return lines.join('\n')
}

function boardMarkdown(board: IterationBoard, graph: GraphSnapshot): string {
  return [
    `# ${inline(board.name)}`,
    '',
    `路径：${inline(board.path)}  `,
    `画板 ID：\`${board.id}\`  `,
    `版本：${board.diagram.iteration ? `本次迭代 · ${inline(board.diagram.iteration.name)}` : '现状'}  `,
    `场景 ID：\`${graph.scenarioId}\``,
    '',
    '[变更说明](changes.md) · [结构化图](graph.json) · [离线图](../../diagram.html)',
    '',
    '## 组件完整清单',
    '',
    ...graph.components.flatMap((component) => [
      `### ${inline(component.name)} · \`${component.id}\``,
      '',
      block(component),
      '',
    ]),
    ...(graph.components.length ? [] : ['（空）', '']),
    '## 连接完整清单',
    '',
    ...graph.connections.flatMap((connection) => [
      `### ${inline(connection.name)} · \`${connection.id}\``,
      '',
      block(connection),
      '',
    ]),
    ...(graph.connections.length ? [] : ['（空）', '']),
  ].join('\n')
}

export async function createExportBundle(
  source: Workspace,
  requestedOptions: ExportOptions,
  dependencies: {
    exportedAt?: string
    loadHistory?: (boardId: string, versionId: string) => Promise<GraphSnapshot>
  } = {},
): Promise<ExportBundle> {
  // Parse + copy before the first await: later edits cannot mix versions in one package.
  const options = {
    ...requestedOptions,
    mode: requestedOptions.mode ?? 'all',
    includeHistory: requestedOptions.mode === 'changes' ? false : requestedOptions.includeHistory,
  }
  let workspace = workspaceSchema.parse(source)
  const seedBoards = selectedBoards(workspace, options)
  const plan = planExport(workspace, options)
  const projection =
    options.mode === 'changes'
      ? await collectChangeExport(
          workspace,
          seedBoards.map((b) => b.id),
          dependencies,
        )
      : undefined
  if (projection) workspace = projection.workspace
  const boards = projection
    ? iterationBoards(workspace).filter((b) => projection.boardIds.includes(b.id))
    : seedBoards
  const changedIds = new Set(
    projection?.changedBoardIds ??
      boards
        .filter((b) => iterationChanges(b.diagram).some((c) => c.status !== 'unchanged'))
        .map((b) => b.id),
  )
  const requiredHistories = new Map<string, Set<string>>()
  for (const location of projection?.locations ?? [])
    if (location.version === 'history' && location.historyId) {
      const ids = requiredHistories.get(location.boardId) ?? new Set<string>()
      ids.add(location.historyId)
      requiredHistories.set(location.boardId, ids)
    }
  const historyCount = boards.reduce(
    (n, b) =>
      n +
      (options.includeHistory
        ? b.diagram.history.length
        : (requiredHistories.get(b.id)?.size ?? 0)),
    0,
  )
  const expectedFiles =
    8 +
    boards.length * 4 +
    boards.filter((b) => b.diagram.iteration).length +
    historyCount * 2 +
    (projection ? 2 : 0)
  if (expectedFiles > 10_000)
    throw new Error('导出包超过 10,000 个文件，请缩小导出范围或关闭历史现状')
  const catalog = workspace.componentCatalog ?? defaultComponentCatalog
  const exportedAt = dependencies.exportedAt ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error('导出时间无效')
  const bundle: ExportBundle = {
    name: `say-clear-export-${new Date(exportedAt).toISOString().replace(/[-:.]/g, '')}`,
    files: [],
  }
  let totalBytes = 0
  const put = (path: string, content: string) => {
    const bytes = new TextEncoder().encode(content).length
    if (bytes > 64 * 1024 * 1024)
      throw new Error(`导出文件 ${path} 超过 64 MiB，请缩小范围或关闭历史现状`)
    totalBytes += bytes
    if (totalBytes > 256 * 1024 * 1024)
      throw new Error('导出包超过 256 MiB，请缩小范围或关闭历史现状')
    bundle.files.push({ path, content })
  }
  const warnings: string[] = [...(projection?.warnings ?? [])]
  const references: ExportReference[] = []
  const html: ExportHtmlData = {
    title: `${plan.name} · ${projection ? '变更交付包' : '图与变更交付包'}`,
    exportedAt,
    boards: [],
    exportMode: options.mode,
    ...(projection
      ? { combined: projection.combined, combinedNodeReasons: projection.nodeReasons }
      : {}),
  }
  const boardEntries = []
  const allReports: string[] = []
  let historyChangeCount = 0
  if (projection) {
    put(
      'combined.json',
      json({
        format: 'say-clear.combined-export',
        schemaVersion: 1,
        ...projection.combined,
        boards: projection.combined.boards.map((frame) => ({
          ...frame,
          board: { id: frame.board.id, name: frame.board.name, path: frame.board.path },
        })),
      }),
    )
    put(
      'change-context.json',
      json({
        schemaVersion: 1,
        seedBoardIds: seedBoards.map((b) => b.id),
        changedBoardIds: projection.changedBoardIds,
        boardIds: projection.boardIds,
        locations: projection.locations,
        nodeReasons: projection.nodeReasons,
        warnings: projection.warnings,
      }),
    )
  }
  const scopeNodes = new Map(
    workspace.systems
      .flatMap((s) => flattenArchitecture(s.architecture))
      .map((node) => [node.id, node]),
  )
  const boardNames = new Map(iterationBoards(workspace).map((board) => [board.id, board.path]))
  for (const board of boards) {
    const basePath = exportBoardPath(board.id)
    const graph = snapshot(board.diagram)
    const current = snapshot(board.diagram.iteration?.baseline ?? graph)
    const iteration = board.diagram.iteration
    const isContext = !!projection && !changedIds.has(board.id)
    const currentReport = report(
      board,
      iteration && !isContext ? current : null,
      graph,
      {
        kind: isContext ? 'context' : iteration ? 'active-iteration' : 'none',
        id: iteration?.id ?? null,
        name: iteration?.name ?? '现状',
        before: iteration && !isContext ? `${basePath}/baseline.json` : null,
        after: `${basePath}/graph.json`,
        ...(iteration ? { startedAt: iteration.startedAt, git: iteration.git } : {}),
      },
      catalog,
    )
    const reports = [currentReport]
    const markdownContexts = new Map<ChangeReport, MarkdownReviewContext>([
      [currentReport, { before: iteration ? current : null, after: graph, catalog, boardNames }],
    ])
    const versions: ExportHtmlData['boards'][number]['versions'] = [
      {
        key: iteration ? 'iteration' : 'current',
        label: iteration ? `本次迭代 · ${iteration.name}` : '现状',
        ...(iteration ? { iterationId: iteration.id } : {}),
        graph,
        ...(iteration && !isContext ? { comparison: currentReport, baseline: current } : {}),
      },
    ]
    put(`${basePath}/graph.json`, json(graph))
    put(`${basePath}/changes.json`, json(currentReport))
    put(`${basePath}/README.md`, boardMarkdown(board, graph))
    if (iteration) {
      put(`${basePath}/baseline.json`, json(current))
      versions.push({ key: 'current', label: '现状 · 迭代基线', graph: current })
    }
    const historyEntries = []
    if (options.includeHistory || requiredHistories.has(board.id)) {
      // Histories are stored as pre-update snapshots in publication order.
      const histories: GraphSnapshot[] = []
      const selectedHistories = options.includeHistory
        ? board.diagram.history
        : board.diagram.history.filter((v) => requiredHistories.get(board.id)?.has(v.id))
      for (const version of selectedHistories) {
        const value = version.snapshot ?? (await dependencies.loadHistory?.(board.id, version.id))
        if (!value)
          throw new Error(`无法导出「${board.name}」的历史「${version.name}」：历史快照未加载`)
        const parsed = graphSnapshotSchema.parse(value)
        if (parsed.scenarioId !== graph.scenarioId)
          throw new Error(`「${board.name}」的历史场景与当前画板不一致`)
        const catalogError = catalogDiagramError({ ...parsed, history: [] }, catalog)
        if (catalogError)
          throw new Error(`「${board.name}」的历史「${version.name}」无效：${catalogError}`)
        histories.push(snapshot(parsed))
      }
      for (let i = 0; i < histories.length; i++) {
        const version = selectedHistories[i]
        const path = exportHistoryPath(board.id, version.id)
        const next = histories[i + 1] ?? current
        const after =
          i + 1 < histories.length
            ? exportHistoryPath(board.id, selectedHistories[i + 1].id)
            : iteration
              ? `${basePath}/baseline.json`
              : `${basePath}/graph.json`
        const historicalReport = report(
          board,
          options.includeHistory ? histories[i] : null,
          next,
          {
            kind: options.includeHistory ? 'history-interval' : 'context',
            id: version.id,
            name: version.name,
            before: options.includeHistory ? path : null,
            after: options.includeHistory ? after : path,
            publishedAt: version.publishedAt,
            git: version.git,
          },
          catalog,
        )
        historyChangeCount += historicalReport.counts.total
        markdownContexts.set(historicalReport, {
          before: histories[i],
          after: next,
          catalog,
          boardNames,
        })
        if (options.includeHistory) reports.push(historicalReport)
        put(path, json(histories[i]))
        put(path.replace(/\.json$/, '.changes.json'), json(historicalReport))
        versions.push({
          key: `history-${version.id}`,
          label: `历史现状 · ${version.name}`,
          graph: histories[i],
        })
        historyEntries.push({
          id: version.id,
          name: version.name,
          publishedAt: version.publishedAt,
          path,
          changesPath: path.replace(/\.json$/, '.changes.json'),
          git: version.git,
        })
        if (options.includeHistory) {
          const nextKey =
            i + 1 < histories.length ? `history-${selectedHistories[i + 1].id}` : 'current'
          // The comparison belongs to its result version, never to the pre-update snapshot.
          const target = versions.find((v) => v.key === nextKey)
          if (target) {
            target.comparison = historicalReport
            target.baseline = histories[i]
          }
        }
      }
      // A later historical result version may have been appended after its report.
      if (options.includeHistory)
        for (let i = 0; i + 1 < histories.length; i++) {
          const target = versions.find((v) => v.key === `history-${selectedHistories[i + 1].id}`)!
          const comparison = reports.find(
            (r) =>
              r.comparison.kind === 'history-interval' &&
              r.comparison.id === selectedHistories[i].id,
          )!
          target.comparison = comparison
          target.baseline = histories[i]
        }
    }
    put(
      `${basePath}/changes.md`,
      [
        `# ${inline(board.name)} · 变更说明`,
        '',
        ...reports.map((entry) =>
          reportMarkdown(board, entry, markdownContexts.get(entry)!, '../../'),
        ),
      ].join('\n'),
    )
    if (!isContext)
      allReports.push(
        ...reports.map((entry) => reportMarkdown(board, entry, markdownContexts.get(entry)!)),
      )
    html.boards.push({
      id: board.id,
      name: board.name,
      path: board.path,
      description: scopeNodes.get(board.id)!.description,
      kind: scopeNodes.get(board.id)!.type,
      role: changedIds.has(board.id) ? 'changed' : 'context',
      versions,
    })
    boardEntries.push({
      id: board.id,
      name: board.name,
      path: board.path,
      systemId: board.systemId,
      kind: scopeNodes.get(board.id)!.type,
      exportRole: changedIds.has(board.id) ? 'changed' : 'context',
      graphPath: `${basePath}/graph.json`,
      graphVersion: iteration ? 'iteration' : 'current',
      baselinePath: iteration ? `${basePath}/baseline.json` : null,
      iteration: iteration
        ? {
            id: iteration.id,
            name: iteration.name,
            startedAt: iteration.startedAt,
            git: iteration.git,
          }
        : null,
      changesPath: `${basePath}/changes.json`,
      counts: currentReport.counts,
      history: historyEntries,
      omittedHistoryCount: board.diagram.history.length - historyEntries.length,
    })
  }
  const referenceSources = iterationBoards(workspace).map((board) => ({
    ...board,
    diagram: {
      ...board.diagram,
      history: board.diagram.history.map((entry) => ({
        ...entry,
        snapshot:
          html.boards
            .find((b) => b.id === board.id)
            ?.versions.find((v) => v.key === `history-${entry.id}`)?.graph ?? entry.snapshot,
      })),
    },
  }))
  for (const board of html.boards)
    for (const version of board.versions)
      for (const component of version.graph.components) {
        const ref = component.reference
        if (!ref) continue
        const resolution = resolveReference(referenceSources, component)
        const target = boards.find((b) => b.id === ref.boardId)
        const sourcePath = !target
          ? null
          : ref.version === 'current'
            ? `${exportBoardPath(target.id)}/${target.diagram.iteration ? 'baseline' : 'graph'}.json`
            : ref.version === 'iteration' && ref.iterationId === target.diagram.iteration?.id
              ? `${exportBoardPath(target.id)}/graph.json`
              : ref.version === 'history' &&
                  (options.includeHistory ||
                    requiredHistories.get(target.id)?.has(ref.historyId!)) &&
                  target.diagram.history.some((h) => h.id === ref.historyId)
                ? exportHistoryPath(target.id, ref.historyId!)
                : null
        references.push({
          boardId: board.id,
          version: version.key,
          componentId: component.id,
          sourceBoardId: ref.boardId,
          sourceComponentId: ref.componentId,
          sourceVersion:
            ref.version === 'history'
              ? `history:${ref.historyId}`
              : ref.version === 'iteration'
                ? `iteration:${ref.iterationId}`
                : 'current',
          sourcePath,
          cachedDefinition: true,
          status: resolution.status,
          message: resolution.message,
        })
        if (!sourcePath)
          warnings.push(
            `画板 ${board.id} 的 ${version.key} 中，组件 ${component.id} 引用的来源 ${ref.boardId}（${ref.version}）未包含在导出包；已保留采用的缓存定义。`,
          )
        if (resolution.status !== 'ok')
          warnings.push(
            `画板 ${board.id} 的 ${version.key} 中，引用组件 ${component.id}：${resolution.message}。`,
          )
      }
  const selectedIds = new Set(boards.map((b) => b.id))
  const structure = workspace.systems.flatMap((system) => {
    const nodes = flattenArchitecture(system.architecture)
    const included = new Set(nodes.filter((n) => selectedIds.has(n.id)).map((n) => n.id))
    for (const node of nodes.filter((n) => included.has(n.id))) {
      let parent = node.parentId
      while (parent) {
        included.add(parent)
        parent = nodes.find((n) => n.id === parent)?.parentId ?? null
      }
    }
    return included.size
      ? [
          {
            systemId: system.architecture.id,
            nodes: nodes
              .filter((n) => included.has(n.id))
              .map((node) => ({ ...node, graphIncluded: selectedIds.has(node.id) })),
          },
        ]
      : []
  })
  put('structure.json', json({ schemaVersion: 1, systems: structure }))
  put('catalog.json', json(catalog))
  put(
    'changes.md',
    [
      '# 全部变更说明',
      '',
      `导出时间：${exportedAt}  `,
      `范围：${inline(plan.name)} · ${boards.length} 张画板  `,
      `活动迭代变更 ${plan.changeCount} 项；历史区间变更 ${historyChangeCount} 项（不同区间分别计数，同一对象可能多次出现）。`,
      '',
      '本次迭代直接对比固定现状。历史区间比较相邻现状快照，可能包含区间内的现状直接编辑，不能还原逐次操作或完整时间线。位置移动不计入业务变更，图文件保留布局。',
      ...(projection
        ? [
            '变更导出只统计选定范围的进行中迭代。自动附带的归属与引用画板是上下文，不把它们独立的迭代或历史差异计入所选变更。',
          ]
        : []),
      '',
      ...allReports,
    ].join('\n'),
  )
  put('diagram.html', renderExportHtml(html))
  for (const [path, content] of Object.entries(exportTemplates)) put(path, content)
  put(
    'README.md',
    [
      `# ${inline(plan.name)} · 图与变更交付包`,
      '',
      `导出格式：say-clear.export / v1  `,
      `导出时间（UTC）：${exportedAt}  `,
      `导出内容：${projection ? '变更导出（进行中迭代）' : '完整导出'}  `,
      `范围：${{ board: '当前画板', system: '当前系统（全部下级画板）', workspace: '整个工作空间' }[options.scope]}  `,
      `画板：${boards.length} · 活动迭代：${plan.iterationCount} · 活动变更：${plan.changeCount} · 已包含历史现状：${historyCount}`,
      '',
      '## 从这里开始',
      '',
      '- 人工浏览：[离线系统图](diagram.html)，解压后用浏览器直接打开。默认标记增删改，点击图或变更清单查看前后值；支持搜索、版本切换及缩放。',
      ...(projection
        ? [
            '- [变更组合数据](combined.json) · [变更范围与纳入原因](change-context.json)：从所选范围的变更出发，沿归属、相邻连线及精确版本引用展开。首页组合视图保留删除项，区分实际变更和关联上下文；各画板仍提供完整原图，含变更所属原子图。',
          ]
        : []),
      '- 评审与实施：[全部变更说明](changes.md)，逐项说明新增、修改、删除，提供可读的业务说明与字段前后对比。完整对象数据见各画板 changes.json。',
      '- 系统与 AI：[文件与版本清单](manifest.json)、[画板层级](structure.json)、[组件模板](catalog.json)，再读取各画板 JSON。',
      '- 交接模板：[变更实施](templates/change-request.md) · [AI 交接](templates/ai-handoff.md)。',
      '',
      '## 文件结构',
      '',
      '```text',
      'README.md / changes.md / diagram.html',
      'manifest.json / structure.json / catalog.json',
      ...(projection ? ['combined.json / change-context.json  变更组合与范围解释'] : []),
      'boards/<画板 ID>/',
      '  README.md         完整组件、端口、连接与属性清单',
      '  graph.json        活动迭代草稿；没有迭代时为现状',
      '  baseline.json     活动迭代的固定现状（仅有迭代时）',
      '  changes.json      活动迭代的结构化变更',
      '  changes.md        本画板的全部纳入变更',
      '  history/<ID>.json 历史现状快照（可选）',
      '  history/<ID>.changes.json 该快照到下一现状的区间差异',
      'templates/          可复用的交接模板',
      '```',
      '',
      '## 版本与字段约定',
      '',
      '稳定 ID 用于关联，不能用可能重名的显示名称关联。文件夹与历史文件名附加稳定指纹以兼容大小写不敏感的文件系统及保留名称；请从 manifest.json 读取实际路径，不要自行拼接 ID。graph.json、baseline.json 与 history/*.json 使用图模型 schemaVersion: 2；manifest.json 与变更报告使用独立的 schemaVersion: 1。文件内容为 UTF-8。',
      '',
      'changes.json 的 changes[] 包含 kind、id、status、完整 before / after 对象和 fields[]。字段 path 使用 JSON Pointer；beforeExists / afterExists 区分缺失字段与 null。新增对象的 before 为 null，删除对象的 after 为 null。端口、校验与引用保留完整结构，自定义属性标签由 catalog.json 解释。',
      '',
      '有活动迭代时，现状始终读取 baseline.json，不能把 graph.json 当作已落地状态。没有活动迭代时不把现状误记为新增。affectedComponentIds 仅为一跳关联复核提示。忽略位置变动及对象键顺序，遵循工作台中的业务变更口径。',
      '',
      '历史保存的是“更新前现状”；历史区间按保存顺序对比下一历史现状或当前现状，可能混有现状直接编辑。它不是完整操作日志，不包含已放弃迭代，也不证明每项变更的发生时间。导出是范围内的一致快照，不会修改工作区。',
      '',
      `${projection ? '变更导出自动扩展与所选变更相关的归属画板、引用来源和调用画板，按具体组件及版本展开，不把不相干引用链整批纳入。固定历史引用会附带其精确历史，即使未开启全部历史；缺失版本不会冒充当前版本。组合视图仅截取相关对象，各画板原图保留完整内容；关联图的独立变更不计入所选变更。' : '完整导出只覆盖选定画板及必要的祖先结构，未自动扩展包外来源。'}跨图引用保留当时采用的缓存定义；manifest.json.references 列出来源版本与 sourcePath，null 表示包外或未包含版本。请核对来源和引用提示后实施。不包含聊天记录、AI 设置或工作区仓库配置。活动迭代 / 历史中已经保存的 Git 关联（含仓库路径）随版本元数据保留。`,
      '',
      '## 画板索引',
      '',
      ...boards.map(
        (board) =>
          `- [${inline(board.path)}](${exportBoardPath(board.id)}/README.md) · \`${board.id}\`${projection ? ` · ${changedIds.has(board.id) ? '所选变更原图' : '关联上下文'} · ${scopeNodes.get(board.id)!.type === 'atomic' ? '原子图' : '归属 / 关联画板'}` : ''}`,
      ),
      '',
      '## 引用提示',
      '',
      ...(warnings.length
        ? [...new Set(warnings)].map((w) => `- ${inline(w)}`)
        : ['没有需要提示的引用依赖。']),
      '',
    ].join('\n'),
  )
  const files = [
    ...bundle.files.map((file) => ({
      path: file.path,
      mediaType: file.path.endsWith('.json')
        ? 'application/json'
        : file.path.endsWith('.html')
          ? 'text/html'
          : 'text/markdown',
      bytes: new TextEncoder().encode(file.content).length,
    })),
    { path: 'manifest.json', mediaType: 'application/json', bytes: null },
  ].sort((a, b) => a.path.localeCompare(b.path))
  put(
    'manifest.json',
    json({
      format: 'say-clear.export',
      schemaVersion: 1,
      sourceGraphSchemaVersion: 2,
      mode: options.mode,
      exportedAt,
      name: plan.name,
      scope: {
        type: options.scope,
        boardId: options.scope === 'workspace' ? null : options.boardId,
      },
      includesHistory: options.includeHistory,
      historyPolicy: options.includeHistory
        ? 'all-selected'
        : requiredHistories.size
          ? 'referenced-versions-only'
          : 'none',
      ...(projection
        ? {
            changeSelection: {
              seedBoardIds: seedBoards.map((b) => b.id),
              changedBoardIds: projection.changedBoardIds,
              relatedBoardIds: projection.boardIds.filter((id) => !changedIds.has(id)),
              contextPath: 'change-context.json',
            },
          }
        : {}),
      counts: {
        boardCount: boards.length,
        changedBoardCount: changedIds.size,
        relatedBoardCount: projection ? boards.length - changedIds.size : 0,
        iterationCount: plan.iterationCount,
        historyCount,
        changeCount: plan.changeCount,
        historyChangeCount,
      },
      entrypoints: {
        human: 'README.md',
        diagram: 'diagram.html',
        changes: 'changes.md',
        structure: 'structure.json',
        catalog: 'catalog.json',
        ...(projection ? { combined: 'combined.json', context: 'change-context.json' } : {}),
      },
      boards: boardEntries,
      references,
      warnings: [...new Set(warnings)],
      files,
    }),
  )
  bundle.files.sort((a, b) => a.path.localeCompare(b.path))
  return bundle
}
