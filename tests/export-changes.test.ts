import { describe, expect, it, vi } from 'vitest'
import { createExportBundle, planExport, type ExportBundle } from '../src/shared/export'
import {
  emptyDiagram,
  newComponent,
  newConnection,
  type Diagram,
  type GraphSnapshot,
} from '../src/shared/diagram'
import { type CombinedDiagram } from '../src/shared/combined-diagram'
import { createReference, referenceBoards } from '../src/shared/diagram-references'
import { snapshot, startIteration } from '../src/shared/iteration'
import {
  buildSystem,
  createArchitecture,
  workspaceSchema,
  type Workspace,
} from '../src/shared/model'

const exportedAt = '2026-11-01T13:00:00.000Z'
type Manifest = {
  mode: 'all' | 'changes'
  counts: { changeCount: number; changedBoardCount?: number; relatedBoardCount?: number }
  entrypoints: { combined?: string }
  boards: {
    id: string
    exportRole: 'changed' | 'context'
    kind: string
    graphPath: string
    baselinePath: string | null
    history: { id: string; path: string; changesPath?: string }[]
  }[]
  references: { sourceBoardId: string; sourcePath: string | null }[]
}
const options = {
  scope: 'board' as const,
  boardId: 'checkout',
  mode: 'changes' as const,
  includeHistory: false,
}
function read<T>(bundle: ExportBundle, path: string): T {
  const file = bundle.files.find((item) => item.path === path)
  expect(file, `缺少导出文件 ${path}`).toBeDefined()
  return JSON.parse(file!.content) as T
}
function diagram(workspace: Workspace, id: string): Diagram {
  return workspace.systems
    .flatMap((system) => system.contents)
    .find((content) => content.id === id)!.diagram!
}
function setDiagram(workspace: Workspace, id: string, value: Diagram) {
  workspace.systems
    .flatMap((system) => system.contents)
    .find((content) => content.id === id)!.diagram = value
}
function fixture(): Workspace {
  const app = buildSystem({
    ...createArchitecture('订单应用'),
    id: 'order-app',
    boards: [
      {
        id: 'order-group',
        name: '订单模块',
        description: '',
        parentId: 'order-app',
        kind: 'aggregate',
      },
      {
        id: 'checkout',
        name: '结算原子图',
        description: '',
        parentId: 'order-group',
        kind: 'atomic',
      },
      {
        id: 'unrelated',
        name: '无关原子图',
        description: '',
        parentId: 'order-app',
        kind: 'atomic',
      },
    ],
  })
  const provider = buildSystem({
    ...createArchitecture('支付应用'),
    id: 'payment-app',
    boards: [
      {
        id: 'payment',
        name: '支付原子图',
        description: '',
        parentId: 'payment-app',
        kind: 'atomic',
      },
    ],
  })
  const caller = buildSystem({ ...createArchitecture('调用方应用'), id: 'caller-app' })
  let workspace: Workspace = {
    schemaVersion: 2,
    activeNodeId: 'checkout',
    systems: [app, provider, caller],
  }
  const owner = {
    ...newComponent('capability'),
    id: 'checkout-owner',
    name: '结算能力',
    inputs: [],
    outputs: [],
  }
  const action = {
    ...newComponent('action'),
    id: 'create-order',
    name: '创建订单',
    description: '变更前的下单约束',
    ownerId: owner.id,
    exposed: true,
    inputs: [],
    outputs: [],
  }
  const neighbor = {
    ...newComponent('ui'),
    id: 'checkout-page',
    name: '结算页面',
    inputs: [],
    outputs: [],
  }
  const noise = {
    ...newComponent('data'),
    id: 'unrelated-local-node',
    name: '原图中完整保留的无关节点',
    inputs: [],
    outputs: [],
  }
  const entry = {
    ...newComponent('api'),
    id: 'payment-entry',
    name: '支付入口',
    exposed: true,
    inputs: [],
    outputs: [],
  }
  setDiagram(workspace, 'payment', { ...emptyDiagram(), components: [entry] })
  const reference = {
    ...createReference(referenceBoards(workspace), 'checkout', {
      boardId: 'payment',
      componentId: entry.id,
      version: 'current',
      outputIds: [],
    }),
    id: 'payment-reference',
  }
  const edge = {
    ...newConnection(action, reference),
    id: 'calls-payment',
    sourcePortId: null,
    targetPortId: null,
  }
  const input = {
    ...newConnection(neighbor, action),
    id: 'submit-order',
    sourcePortId: null,
    targetPortId: null,
  }
  const draft = startIteration(
    {
      ...emptyDiagram(),
      components: [owner, action, neighbor, reference, noise],
      connections: [edge, input],
    },
    '修改下单约束',
  )
  draft.iteration!.id = 'checkout-iteration'
  draft.components.find((component) => component.id === action.id)!.description = '变更后的下单约束'
  setDiagram(workspace, 'checkout', draft)
  const incoming = {
    ...createReference(referenceBoards(workspace), 'caller-app', {
      boardId: 'checkout',
      componentId: action.id,
      version: 'iteration',
      iterationId: draft.iteration!.id,
      outputIds: [],
    }),
    id: 'checkout-reference',
  }
  setDiagram(workspace, 'caller-app', { ...emptyDiagram(), components: [incoming] })
  const other = startIteration(
    {
      ...emptyDiagram(),
      components: [{ ...newComponent('action'), id: 'other-action', name: '无关业务' }],
    },
    '范围外变更',
  )
  other.components[0].description = '不应作为当前画板变更导出的起点'
  setDiagram(workspace, 'unrelated', other)
  workspace = workspaceSchema.parse(workspace)
  return workspace
}

describe('变更交付包集成', () => {
  it('从选定画板的变更扩展归属与双向引用，保留完整原子图而组合图仅保留相关内容', async () => {
    const workspace = fixture()
    const original = structuredClone(workspace)
    const bundle = await createExportBundle(workspace, options, { exportedAt })
    const manifest = read<Manifest>(bundle, 'manifest.json')
    expect(manifest.mode).toBe('changes')
    expect(manifest.counts.changeCount).toBe(1)
    expect(manifest.boards.map((board) => board.id)).toEqual(
      expect.arrayContaining([
        'checkout',
        'order-app',
        'order-group',
        'payment',
        'payment-app',
        'caller-app',
      ]),
    )
    expect(manifest.boards.map((board) => board.id)).not.toContain('unrelated')
    expect(manifest.boards.find((board) => board.id === 'checkout')).toMatchObject({
      kind: 'atomic',
      exportRole: 'changed',
    })
    expect(manifest.boards.find((board) => board.id === 'payment')).toMatchObject({
      kind: 'atomic',
      exportRole: 'context',
    })
    const originalPath = manifest.boards.find((board) => board.id === 'checkout')!.graphPath
    expect(
      read<GraphSnapshot>(bundle, originalPath).components.map((component) => component.id),
    ).toContain('unrelated-local-node')
    const combined = read<CombinedDiagram>(bundle, manifest.entrypoints.combined ?? 'combined.json')
    expect(
      combined.nodes.some(
        (node) =>
          node.location.boardId === 'checkout' && node.component.id === 'unrelated-local-node',
      ),
    ).toBe(false)
    expect(
      combined.nodes.some(
        (node) => node.location.boardId === 'checkout' && node.component.id === 'checkout-owner',
      ),
    ).toBe(true)
    expect(combined.edges.some((edge) => edge.kind === 'reference')).toBe(true)
    const ids = new Set(combined.nodes.map((node) => node.id))
    expect(ids.size).toBe(combined.nodes.length)
    for (const edge of combined.edges) {
      expect(ids.has(edge.sourceId)).toBe(true)
      expect(ids.has(edge.targetId)).toBe(true)
    }
    for (const reference of manifest.references.filter((reference) => reference.sourcePath)) {
      expect(bundle.files.some((file) => file.path === reference.sourcePath)).toBe(true)
    }
    expect(workspace).toEqual(original)
  })

  it('变更起点遵循范围，完整导出继续包含未变更图', async () => {
    const workspace = fixture()
    const scoped = planExport(workspace, options)
    expect(scoped.changeCount).toBe(1)
    const allChanges = await createExportBundle(
      workspace,
      { ...options, scope: 'workspace' },
      { exportedAt },
    )
    const changedIds = read<Manifest>(allChanges, 'manifest.json')
      .boards.filter((board) => board.exportRole === 'changed')
      .map((board) => board.id)
    expect(changedIds).toEqual(expect.arrayContaining(['checkout', 'unrelated']))
    const full = await createExportBundle(workspace, { ...options, mode: 'all' }, { exportedAt })
    expect(read<Manifest>(full, 'manifest.json').boards.map((board) => board.id)).toEqual([
      'checkout',
    ])
    expect(full.files.some((file) => file.path === 'combined.json')).toBe(false)
    const html = full.files.find((file) => file.path === 'diagram.html')!.content
    expect(html).toContain('变更前的下单约束')
    expect(html).toContain('变更后的下单约束')
    expect(html).toContain('变更前')
    expect(html).toContain('变更后')
  })

  it('即使未附带全部历史，也读取并保留被变更上下文精确引用的固定历史版本', async () => {
    const workspace = fixture()
    const provider = diagram(workspace, 'payment')
    const pinned = snapshot(provider)
    pinned.components[0].description = '固定历史支付定义'
    const record = {
      id: 'pinned-payment',
      name: '支付历史',
      publishedAt: '2026-10-30T00:00:00.000Z',
      snapshot: pinned,
    }
    provider.history = [record]
    const historicalReference = {
      ...createReference(referenceBoards(workspace), 'checkout', {
        boardId: 'payment',
        componentId: 'payment-entry',
        version: 'history',
        historyId: record.id,
        outputIds: [],
      }),
      id: 'payment-reference',
    }
    const leaf = diagram(workspace, 'checkout')
    leaf.components = leaf.components.map((component) =>
      component.id === historicalReference.id ? historicalReference : component,
    )
    leaf.iteration!.baseline.components = leaf.iteration!.baseline.components.map((component) =>
      component.id === historicalReference.id ? structuredClone(historicalReference) : component,
    )
    provider.history = [
      {
        ...record,
        snapshot: undefined,
        componentCount: 1,
        connectionCount: 0,
        snapshotDigest: '0123456789abcdef',
      },
      {
        id: 'unreferenced-history',
        name: '无关历史',
        publishedAt: '2026-10-29T00:00:00.000Z',
        componentCount: 1,
        connectionCount: 0,
        snapshotDigest: 'fedcba9876543210',
      },
    ]
    const loadHistory = vi.fn(async (boardId: string, versionId: string) => {
      expect([boardId, versionId]).toEqual(['payment', 'pinned-payment'])
      return pinned
    })
    const bundle = await createExportBundle(workspace, options, { exportedAt, loadHistory })
    expect(loadHistory).toHaveBeenCalledTimes(1)
    const manifest = read<Manifest>(bundle, 'manifest.json')
    const history = manifest.boards.find((board) => board.id === 'payment')!.history
    expect(history.map((entry) => entry.id)).toEqual(['pinned-payment'])
    expect(read<GraphSnapshot>(bundle, history[0].path)).toEqual(pinned)
    const combined = read<CombinedDiagram>(bundle, manifest.entrypoints.combined ?? 'combined.json')
    expect(combined.boards.some((frame) => frame.location.historyId === 'pinned-payment')).toBe(
      true,
    )
    expect(bundle.files.some((file) => file.path.includes('unreferenced-history'))).toBe(false)
  })

  it('没有进行中变更时给出空预览并拒绝生成空的变更包', async () => {
    const workspace = fixture()
    setDiagram(workspace, 'checkout', {
      ...snapshot(diagram(workspace, 'checkout').iteration!.baseline),
      history: [],
    })
    expect(planExport(workspace, options).changeCount).toBe(0)
    await expect(createExportBundle(workspace, options, { exportedAt })).rejects.toThrow(/变更/)
  })

  it('完整导出的历史对比以当前现状为结果，不把未发布草稿混入已完成变更', async () => {
    const workspace = fixture()
    const leaf = diagram(workspace, 'checkout')
    const historical = snapshot(leaf.iteration!.baseline)
    historical.components.find((component) => component.id === 'create-order')!.description =
      '已完成调整之前的历史约束'
    leaf.history = [
      {
        id: 'checkout-history',
        name: '已完成的下单调整 · 更新前',
        publishedAt: '2026-10-31T00:00:00.000Z',
        snapshot: historical,
      },
    ]
    const bundle = await createExportBundle(
      workspace,
      { ...options, mode: 'all', includeHistory: true },
      { exportedAt },
    )
    const manifest = read<Manifest>(bundle, 'manifest.json')
    const board = manifest.boards.find((entry) => entry.id === 'checkout')!
    const historicalReport = read<{
      comparison: { after: string }
      changes: { id: string; before: { description: string }; after: { description: string } }[]
    }>(bundle, board.history[0].changesPath!)
    expect(historicalReport.comparison.after).toBe(board.baselinePath)
    expect(historicalReport.changes.find((change) => change.id === 'create-order')).toMatchObject({
      before: { description: '已完成调整之前的历史约束' },
      after: { description: '变更前的下单约束' },
    })
    const html = bundle.files.find((file) => file.path === 'diagram.html')!.content
    expect(html).toContain('已完成调整之前的历史约束')
    expect(html).toContain('变更前的下单约束')
    expect(html).toContain('变更后的下单约束')
  })
})
