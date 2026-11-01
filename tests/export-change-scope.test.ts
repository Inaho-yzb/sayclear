import { describe, expect, it, vi } from 'vitest'
import { collectChangeExport, planChangeExport } from '../src/shared/export-change-scope'
import { combinedBoardKey } from '../src/shared/combined-diagram'
import {
  emptyDiagram,
  newComponent,
  newConnection,
  removeComponent,
  type Diagram,
} from '../src/shared/diagram'
import {
  createReference,
  referenceBoards,
  type BoardLocation,
} from '../src/shared/diagram-references'
import { snapshot, startIteration } from '../src/shared/iteration'
import {
  buildSystem,
  createArchitecture,
  workspaceSchema,
  type Workspace,
} from '../src/shared/model'

const component = (id: string, exposed = false) => ({
  ...newComponent('action'),
  id,
  name: id,
  exposed,
  inputs: [],
  outputs: [],
})
function graph(workspace: Workspace, id: string): Diagram {
  return workspace.systems
    .flatMap((system) => system.contents)
    .find((content) => content.id === id)!.diagram!
}
function setGraph(workspace: Workspace, id: string, diagram: Diagram) {
  workspace.systems
    .flatMap((system) => system.contents)
    .find((content) => content.id === id)!.diagram = diagram
}
function edge(diagram: Diagram, id: string, from: string, to: string) {
  return {
    ...newConnection(
      diagram.components.find((item) => item.id === from)!,
      diagram.components.find((item) => item.id === to)!,
    ),
    id,
    sourcePortId: null,
    targetPortId: null,
  }
}
function fixture(): Workspace {
  const system = buildSystem({
    ...createArchitecture('业务应用'),
    id: 'app',
    boards: [
      { id: 'group', name: '业务聚合', description: '', kind: 'aggregate', parentId: 'app' },
      { id: 'changed', name: '原子业务', description: '', kind: 'atomic', parentId: 'group' },
      { id: 'provider', name: '公开服务', description: '', kind: 'atomic', parentId: 'app' },
      { id: 'unrelated', name: '无关图', description: '', kind: 'atomic', parentId: 'app' },
    ],
  })
  const external = buildSystem({
    ...createArchitecture('调用应用'),
    id: 'external',
    boards: [
      { id: 'caller', name: '现状调用方', description: '', kind: 'atomic', parentId: 'external' },
      {
        id: 'pinned',
        name: '固定历史调用方',
        description: '',
        kind: 'atomic',
        parentId: 'external',
      },
      {
        id: 'draft-caller',
        name: '迭代调用方',
        description: '',
        kind: 'atomic',
        parentId: 'external',
      },
    ],
  })
  const workspace: Workspace = {
    schemaVersion: 2,
    activeNodeId: 'changed',
    systems: [system, external],
  }
  for (const content of workspace.systems.flatMap((entry) => entry.contents))
    content.diagram = { ...emptyDiagram(), components: [component('entry', true)] }
  const diagram: Diagram = {
    ...emptyDiagram(),
    components: [
      component('owner'),
      { ...component('work', true), ownerId: 'owner', description: '旧说明' },
      component('near'),
      component('far'),
      { ...component('gone'), ownerId: 'owner' },
      component('entry', true),
    ],
  }
  diagram.connections = [
    edge(diagram, 'work-near', 'work', 'near'),
    edge(diagram, 'near-far', 'near', 'far'),
    edge(diagram, 'work-gone', 'work', 'gone'),
  ]
  diagram.history = [
    {
      id: 'release-old',
      name: '固定旧现状',
      publishedAt: '2026-11-01T00:00:00.000Z',
      snapshot: snapshot(diagram),
    },
  ]
  setGraph(workspace, 'changed', diagram)
  const groupRef = createReference(referenceBoards(workspace), 'group', {
    boardId: 'changed',
    componentId: 'entry',
    version: 'current',
    outputIds: [],
  })
  groupRef.id = 'group-reference'
  graph(workspace, 'group').components.push(groupRef)
  graph(workspace, 'group').connections.push(
    edge(graph(workspace, 'group'), 'group-contains', 'entry', groupRef.id),
  )
  const rootRef = createReference(referenceBoards(workspace), 'app', {
    boardId: 'group',
    componentId: 'entry',
    version: 'current',
    outputIds: [],
  })
  rootRef.id = 'root-reference'
  graph(workspace, 'app').components.push(rootRef)
  const currentRef = createReference(referenceBoards(workspace), 'caller', {
    boardId: 'changed',
    componentId: 'work',
    version: 'current',
    outputIds: [],
  })
  currentRef.id = 'current-reference'
  graph(workspace, 'caller').components.push(currentRef)
  const pinned = createReference(referenceBoards(workspace), 'pinned', {
    boardId: 'changed',
    componentId: 'work',
    version: 'history',
    historyId: 'release-old',
    outputIds: [],
  })
  graph(workspace, 'pinned').components.push({ ...pinned, id: 'pinned-reference' })
  const next = startIteration(diagram, '修改业务')
  next.iteration!.id = 'active-change'
  next.components.find((item) => item.id === 'work')!.description = '新说明'
  setGraph(workspace, 'changed', removeComponent(next, 'gone'))
  const draftRef = createReference(referenceBoards(workspace), 'draft-caller', {
    boardId: 'changed',
    componentId: 'work',
    version: 'iteration',
    iterationId: 'active-change',
    outputIds: [],
  })
  graph(workspace, 'draft-caller').components.push({ ...draftRef, id: 'draft-reference' })
  return workspaceSchema.parse(workspace)
}
function frameKey(
  id: string,
  version: BoardLocation['version'] = 'iteration',
  iterationId = 'active-change',
) {
  return combinedBoardKey({
    boardId: id,
    version,
    ...(version === 'iteration' ? { iterationId } : {}),
  })
}

describe('变更交付范围与组合视图', () => {
  it('保留完整原图，只投影变更、删除对象、归属链和一跳上下文；排除无关图与多跳节点', async () => {
    const source = fixture(),
      before = structuredClone(source)
    const preview = planChangeExport(source, ['changed'])
    const result = await collectChangeExport(source, ['changed'])
    expect(result.changedBoardIds).toEqual(['changed'])
    expect(preview.boardIds).toEqual(result.boardIds)
    expect(result.boardIds).toEqual(
      expect.arrayContaining(['changed', 'group', 'app', 'caller', 'external', 'draft-caller']),
    )
    expect(result.boardIds).not.toContain('unrelated')
    expect(result.boardIds).not.toContain('pinned')
    const draft = result.combined.boards.find((frame) => frame.id === frameKey('changed'))!
    expect(draft.graph.components.map((item) => item.id)).toEqual(
      expect.arrayContaining(['work', 'gone', 'owner', 'near']),
    )
    expect(draft.graph.components.some((item) => item.id === 'far')).toBe(false)
    expect(draft.graph.connections.some((item) => item.id === 'work-gone')).toBe(true)
    expect(result.nodeReasons[`${draft.id}/owner`]).toContain('owner')
    expect(result.nodeReasons[`${draft.id}/near`]).toContain('adjacent')
    expect(
      result.combined.nodes.some(
        (node) => node.location.boardId === 'group' && node.component.id === 'group-reference',
      ),
    ).toBe(true)
    expect(
      result.combined.nodes.some(
        (node) => node.location.boardId === 'app' && node.component.id === 'root-reference',
      ),
    ).toBe(true)
    expect(graph(result.workspace, 'changed').components.some((item) => item.id === 'far')).toBe(
      true,
    )
    expect(source).toEqual(before)
    expect(result.workspace).toEqual(source)
  })

  it('反向引用严格按现状、指定迭代和对象匹配，不把固定历史调用者当成当前变更影响', async () => {
    const result = await collectChangeExport(fixture(), ['changed'])
    const currentEdge = result.combined.edges.find(
      (edge) => edge.kind === 'reference' && edge.sourceId.includes('/current-reference'),
    )!
    const draftEdge = result.combined.edges.find(
      (edge) => edge.kind === 'reference' && edge.sourceId.includes('/draft-reference'),
    )!
    expect(currentEdge.targetId).toBe(`${frameKey('changed', 'current')}/work`)
    expect(draftEdge.targetId).toBe(`${frameKey('changed')}/work`)
    expect(result.locations.some((location) => location.version === 'history')).toBe(false)
    expect(new Set(result.combined.nodes.map((node) => node.id)).size).toBe(
      result.combined.nodes.length,
    )
    expect(
      result.combined.nodes.filter((node) => node.component.id === 'entry').length,
    ).toBeGreaterThan(1)
  })

  it('原子图内部修改即使远离公开入口，也交付其现状入口调用方；固定历史调用方仍不扩展', async () => {
    const source = fixture()
    const caller = graph(source, 'caller')
    caller.components = [caller.components[0]]
    const ref = createReference(referenceBoards(source), 'caller', {
      boardId: 'changed',
      componentId: 'entry',
      version: 'current',
      outputIds: [],
    })
    caller.components.push({ ...ref, id: 'disconnected-entry-reference' })
    const group = graph(source, 'group')
    group.components = [group.components[0]]
    group.connections = []
    const result = await collectChangeExport(source, ['changed'])
    expect(result.boardIds).toContain('caller')
    expect(result.boardIds).not.toContain('pinned')
    const node = result.combined.nodes.find(
      (item) => item.component.id === 'disconnected-entry-reference',
    )!
    expect(result.nodeReasons[node.id]).toContain('board-reference-context')
    const referenceEdge = result.combined.edges.find(
      (item) => item.sourceId === node.id && item.kind === 'reference',
    )!
    expect(referenceEdge.targetId).toBe(`${frameKey('changed', 'current')}/entry`)
  })

  it('仅沿关联组件继续展开引用，多个变更根和循环引用会去重', async () => {
    const source = fixture()
    const provider = createReference(referenceBoards(source), 'changed', {
      boardId: 'provider',
      componentId: 'entry',
      version: 'current',
      outputIds: [],
    })
    provider.id = 'provider-reference'
    graph(source, 'changed').components.push(provider)
    graph(source, 'changed').connections.push(
      edge(graph(source, 'changed'), 'uses-provider', 'work', provider.id),
    )
    const unrelated = createReference(referenceBoards(source), 'provider', {
      boardId: 'unrelated',
      componentId: 'entry',
      version: 'current',
      outputIds: [],
    })
    graph(source, 'provider').components.push({ ...unrelated, id: 'far-reference' })
    const cyclic = createReference(referenceBoards(source), 'provider', {
      boardId: 'changed',
      componentId: 'work',
      version: 'current',
      outputIds: [],
    })
    graph(source, 'provider').components.push({ ...cyclic, id: 'cycle-reference' })
    graph(source, 'provider').connections.push(
      edge(graph(source, 'provider'), 'cycle-link', 'entry', 'cycle-reference'),
    )
    const second = startIteration(graph(source, 'draft-caller'), '第二根变更')
    second.components[0].description = '另一个范围内变更'
    setGraph(source, 'draft-caller', second)
    const result = await collectChangeExport(source, ['changed', 'draft-caller'])
    expect(result.changedBoardIds).toEqual(['changed', 'draft-caller'])
    expect(result.boardIds).toContain('provider')
    expect(result.boardIds).not.toContain('unrelated')
    expect(result.combined.nodes.some((node) => node.component.id === 'far-reference')).toBe(false)
    expect(result.combined.nodes.some((node) => node.component.id === 'cycle-reference')).toBe(true)
    expect(new Set(result.combined.boards.map((frame) => frame.id)).size).toBe(
      result.combined.boards.length,
    )
    expect(result.combined.truncated).toBe(false)
  })

  it('仅载入实际达到的固定历史来源，快照损坏或缺失会阻止不完整交付', async () => {
    const source = fixture()
    const old = snapshot(graph(source, 'provider'))
    graph(source, 'provider').history.push({
      id: 'needed',
      name: '需要的历史',
      publishedAt: '2026-11-01T00:00:00.000Z',
      snapshot: old,
    })
    const ref = createReference(referenceBoards(source), 'changed', {
      boardId: 'provider',
      componentId: 'entry',
      version: 'history',
      historyId: 'needed',
      outputIds: [],
    })
    graph(source, 'changed').components.push({ ...ref, id: 'history-reference' })
    graph(source, 'changed').connections.push(
      edge(graph(source, 'changed'), 'history-use', 'work', 'history-reference'),
    )
    graph(source, 'provider').history[0] = {
      id: 'needed',
      name: '需要的历史',
      publishedAt: '2026-11-01T00:00:00.000Z',
      componentCount: 1,
      connectionCount: 0,
      snapshotDigest: '0123456789abcdef',
    }
    graph(source, 'provider').history.push({
      id: 'not-needed',
      name: '无关历史',
      publishedAt: '2026-11-01T01:00:00.000Z',
      componentCount: 0,
      connectionCount: 0,
      snapshotDigest: '0123456789abcdef',
    })
    const loadHistory = vi.fn().mockResolvedValue(old)
    const result = await collectChangeExport(source, ['changed'], { loadHistory })
    expect(loadHistory).toHaveBeenCalledExactlyOnceWith('provider', 'needed')
    expect(result.locations).toContainEqual({
      boardId: 'provider',
      version: 'history',
      historyId: 'needed',
    })
    expect(result.combined.pendingHistory).toEqual([])
    expect(graph(source, 'provider').history[0].snapshot).toBeUndefined()
    expect(graph(result.workspace, 'provider').history[0].snapshot).toEqual(old)
    await expect(collectChangeExport(source, ['changed'])).rejects.toThrow('未加载')
    await expect(
      collectChangeExport(source, ['changed'], {
        loadHistory: async () => {
          throw new Error('文件损坏')
        },
      }),
    ).rejects.toThrow('文件损坏')
    const invalid = snapshot(old)
    invalid.components[0].templateId = 'missing-template'
    await expect(
      collectChangeExport(source, ['changed'], { loadHistory: async () => invalid }),
    ).rejects.toThrow('无效')
  })

  it('失效引用保留缓存与提示，没有活动变更时预览为零并拒绝生成空交付', async () => {
    const source = fixture()
    const stale = createReference(referenceBoards(source), 'changed', {
      boardId: 'provider',
      componentId: 'entry',
      version: 'current',
      outputIds: [],
    })
    stale.reference!.boardId = 'deleted-board'
    graph(source, 'changed').components.push({ ...stale, id: 'missing-reference' })
    const result = await collectChangeExport(source, ['changed'])
    expect(result.warnings.join(' ')).toContain('deleted-board')
    expect(
      result.combined.nodes.find((node) => node.component.id === 'missing-reference')?.component,
    ).toMatchObject({ name: stale.name, reference: { boardId: 'deleted-board' } })
    expect(planChangeExport(source, ['unrelated'])).toEqual({
      boardIds: [],
      changedBoardIds: [],
      changeCount: 0,
    })
    await expect(collectChangeExport(source, ['unrelated'])).rejects.toThrow('没有进行中的业务变更')
    expect(() => planChangeExport(source, ['missing'])).toThrow('已不存在')
  })

  it('超过旧组合视图 40 张限制仍完整导出，超过交付上限则明确失败而不静默截断', async () => {
    const source = fixture()
    const addCallers = (count: number) => {
      const system = source.systems[1]
      const reference = graph(source, 'caller').components.find(
        (item) => item.id === 'current-reference',
      )!
      source.systems[1] = buildSystem(
        {
          ...system.architecture,
          boards: [
            ...system.architecture.boards,
            ...Array.from({ length: count }, (_, index) => ({
              id: `extra-${system.architecture.boards.length}-${index}`,
              name: `额外调用方 ${system.architecture.boards.length}-${index}`,
              description: '',
              kind: 'atomic' as const,
              parentId: 'external',
            })),
          ],
        },
        system,
      )
      for (const content of source.systems[1].contents)
        if (content.id.startsWith('extra-'))
          content.diagram = { ...emptyDiagram(), components: [structuredClone(reference)] }
    }
    addCallers(45)
    const result = await collectChangeExport(source, ['changed'])
    expect(result.combined.boards.length).toBeGreaterThan(40)
    expect(result.combined.truncated).toBe(false)
    addCallers(160)
    await expect(collectChangeExport(source, ['changed'])).rejects.toThrow('超过 200 个画板版本')
  })
})
