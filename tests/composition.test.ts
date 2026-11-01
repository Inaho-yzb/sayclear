import { describe, it, expect } from 'vitest'
import {
  addBoard,
  aggregateBoards,
  compositionChanges,
  initializeBoards,
} from '../src/shared/composition'
import {
  architectureSchema,
  buildSystem,
  createArchitecture,
  flattenArchitecture,
  getProject,
  updateNodeContent,
  workspaceSchema,
} from '../src/shared/model'
import {
  createReference,
  referenceBoards,
  resolveReference,
} from '../src/shared/diagram-references'
import { newConnection } from '../src/shared/diagram'
import { startIteration, publishIteration, snapshot } from '../src/shared/iteration'

function setup() {
  const root = { ...createArchitecture('用户应用'), id: 'users' }
  return initializeBoards(
    workspaceSchema.parse({
      schemaVersion: 2,
      activeNodeId: root.id,
      systems: [buildSystem(root)],
    }),
  )
}
describe('画板组成与跨应用引用', () => {
  it('聚合缺少公开入口的图时明确报错，原结构和内容保持完整', () => {
    let w = addBoard(setup(), 'users', '内部校验', 'atomic')
    const first = w.activeNodeId!
    w = addBoard(w, 'users', '用户创建', 'atomic')
    const second = w.activeNodeId!
    w = updateNodeContent(w, first, (p) => ({
      ...p,
      diagram: {
        ...p.diagram!,
        components: p.diagram!.components.map((c) => ({ ...c, exposed: false })),
      },
    }))
    const before = structuredClone(w)
    expect(() => aggregateBoards(w, 'users', [first, second], '注册')).toThrow('现状尚无公开入口')
    expect(w).toEqual(before)
  })
  it('支持超过三层、拒绝循环、缺失归属、原子图子节点和嵌套应用', () => {
    const root = createArchitecture('系统')
    root.kind = 'system'
    root.boards = Array.from({ length: 12 }, (_, i) => ({
      id: `layer-${i}`,
      name: `层 ${i}`,
      kind: 'aggregate' as const,
      description: '',
      parentId: i ? `layer-${i - 1}` : root.id,
    }))
    expect(flattenArchitecture(architectureSchema.parse(root)).at(-1)?.depth).toBe(12)
    const invalid = structuredClone(root)
    invalid.boards[0].parentId = 'layer-11'
    expect(architectureSchema.safeParse(invalid).success).toBe(false)
    invalid.boards[0].parentId = 'missing'
    expect(architectureSchema.safeParse(invalid).success).toBe(false)
    invalid.boards[0].parentId = root.id
    invalid.boards[0].kind = 'atomic'
    expect(architectureSchema.safeParse(invalid).success).toBe(false)
    root.kind = 'application'
    root.boards[0].kind = 'application'
    expect(architectureSchema.safeParse(root).success).toBe(false)
  })
  it('逐层聚合保留原图 ID、内容、被引用关系与父图现状快照', () => {
    let w = addBoard(setup(), 'users', '注册校验', 'atomic')
    const a = w.activeNodeId!
    w = addBoard(w, 'users', '创建用户', 'atomic')
    const b = w.activeNodeId!
    const before = structuredClone(getProject(w, a))
    w = updateNodeContent(w, 'users', (p) => {
      const diagram = p.diagram!
      const [source, target] = diagram.components.filter((c) => c.reference)
      diagram.connections.push(newConnection(source, target))
      return { ...p, diagram: startIteration(diagram, '组合注册流程') }
    })
    const baseline = snapshot(getProject(w, 'users').diagram!.iteration!.baseline)
    const edge = structuredClone(getProject(w, 'users').diagram!.connections[0])
    w = aggregateBoards(w, 'users', [a, b], '用户注册')
    const group = w.activeNodeId!
    expect(getProject(w, a)).toEqual(before)
    expect(w.systems[0].architecture.boards.find((n) => n.id === a)?.parentId).toBe(group)
    expect(
      getProject(w, group)
        .diagram!.components.filter((c) => c.reference)
        .map((c) => c.reference!.boardId),
    ).toEqual([a, b])
    expect(getProject(w, 'users').diagram!.iteration!.baseline).toEqual(baseline)
    expect(getProject(w, 'users').diagram!.connections).toContainEqual(edge)
    expect(
      referenceBoards(w)
        .flatMap((board) => board.diagram.components)
        .filter((c) => c.reference)
        .every((c) => resolveReference(referenceBoards(w), c).status === 'ok'),
    ).toBe(true)
    expect(() => aggregateBoards(w, 'users', [a, b], '非法跨级')).toThrow('同一归属')
    w = addBoard(w, group, '通知用户', 'atomic')
    const c = w.activeNodeId!
    w = aggregateBoards(w, group, [a, c], '注册前置')
    expect(flattenArchitecture(w.systems[0].architecture).find((n) => n.id === a)?.depth).toBe(3)
  })
  it('下级变更向上汇总，位置变化不冒充业务修改', () => {
    let w = addBoard(setup(), 'users', '开户', 'atomic')
    const id = w.activeNodeId!
    w = updateNodeContent(w, id, (p) => ({ ...p, diagram: startIteration(p.diagram!, '开户迭代') }))
    w = updateNodeContent(w, id, (p) => ({
      ...p,
      diagram: {
        ...p.diagram!,
        components: p.diagram!.components.map((c) => ({ ...c, position: { x: 900, y: 0 } })),
      },
    }))
    expect(compositionChanges(w).get('users')).toEqual({ own: false, descendants: 0 })
    w = updateNodeContent(w, id, (p) => ({
      ...p,
      diagram: {
        ...p.diagram!,
        components: p.diagram!.components.map((c) => ({ ...c, description: '增加配置分支' })),
      },
    }))
    expect(compositionChanges(w).get('users')).toEqual({ own: false, descendants: 1 })
    expect(compositionChanges(w).get(id)?.own).toBe(true)
  })
  it('跨应用引用显示来源应用，来源更新不修改已采用定义；历史版本可固定并回跳', () => {
    let w = setup()
    const account = createArchitecture('账户应用')
    w = initializeBoards({ ...w, systems: [...w.systems, buildSystem(account)] })
    let boards = referenceBoards(w)
    const current = createReference(boards, account.id, {
      boardId: 'users',
      componentId: 'board-entry',
      version: 'current',
      outputIds: [],
    })
    expect(boards.find((b) => b.id === 'users')?.applicationName).toBe('用户应用')
    w = updateNodeContent(w, 'users', (p) => {
      const draft = startIteration(p.diagram!, '注册改名')
      draft.components[0].name = '新的注册能力'
      return { ...p, diagram: publishIteration(draft) }
    })
    boards = referenceBoards(w)
    expect(resolveReference(boards, current).status).toBe('changed')
    expect(current.name).toBe('用户应用')
    const historical = createReference(boards, account.id, {
      boardId: 'users',
      componentId: 'board-entry',
      version: 'history',
      historyId: boards.find((b) => b.id === 'users')!.diagram.history[0].id,
      outputIds: [],
    })
    expect(historical.name).toBe('用户应用')
    expect(resolveReference(boards, historical).status).toBe('ok')
    boards.find((b) => b.id === 'users')!.diagram.components[0].name = '又一次修改'
    expect(resolveReference(boards, historical).status).toBe('ok')
    boards.find((b) => b.id === 'users')!.diagram.history = []
    expect(resolveReference(boards, historical).status).toBe('missing')
    expect(historical.name).toBe('用户应用')
  })
})
