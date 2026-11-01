import { describe, expect, it } from 'vitest'
import fixture from './fixtures/workspace-v2.json'
import { iterationBoards, manageIteration } from '../src/shared/iteration-management'
import { iterationExample, snapshot } from '../src/shared/iteration'
import { getProject, parseWorkspace, updateNodeContent } from '../src/shared/model'

const workspace = () => parseWorkspace(structuredClone(fixture))
const withIteration = () =>
  updateNodeContent(workspace(), 'leads', (project) => ({
    ...project,
    diagram: iterationExample(),
  }))

describe('统一迭代管理', () => {
  it('包含没有系统图的画板、保留路径并排除已脱离架构的内容', () => {
    const data = workspace()
    data.systems[0].contents.push({
      ...structuredClone(data.systems[0].contents[0]),
      id: 'detached',
    })
    const boards = iterationBoards(data)
    expect(boards.map((board) => board.id)).toEqual(['fixture-project', 'sales', 'leads'])
    expect(boards.find((board) => board.id === 'leads')?.path).toBe(
      '兼容性验证 🚀 / 销售管理 / 销售线索',
    )
    expect(boards.every((board) => board.diagram.schemaVersion === 2)).toBe(true)
    expect(iterationBoards({ schemaVersion: 2, systems: [], activeNodeId: null })).toEqual([])
  })

  it('可在空画板创建迭代，不改变其他画板、历史内容或当前选择', () => {
    const data = workspace()
    const next = manageIteration(data, { type: 'start', boardId: 'leads', name: '  新注册流程  ' })
    expect(getProject(next, 'leads').diagram?.iteration?.name).toBe('新注册流程')
    expect(getProject(data, 'leads').diagram?.iteration).toBeUndefined()
    expect(getProject(next, 'sales')).toEqual(getProject(data, 'sales'))
    expect(getProject(next, 'leads').messages).toEqual(getProject(data, 'leads').messages)
    expect(next.activeNodeId).toBe(data.activeNodeId)
    expect(() => manageIteration(next, { type: 'start', boardId: 'leads', name: '重复' })).toThrow(
      '当前迭代',
    )
    expect(() =>
      manageIteration(data, { type: 'start', boardId: 'missing', name: '缺失' }),
    ).toThrow('不存在')
  })

  it('改名保留稳定身份、开始时间、当前变更和基线，保存后可重新读取', () => {
    const data = withIteration()
    const before = getProject(data, 'leads').diagram!
    const next = manageIteration(data, {
      type: 'rename',
      boardId: 'leads',
      iterationId: before.iteration!.id,
      name: '  完善注册  ',
    })
    const after = getProject(next, 'leads').diagram!
    expect(after).toEqual({ ...before, iteration: { ...before.iteration, name: '完善注册' } })
    expect(parseWorkspace(JSON.parse(JSON.stringify(next)))).toEqual(next)
    for (const name of ['   ', '长'.repeat(81)]) {
      expect(() =>
        manageIteration(data, {
          type: 'rename',
          boardId: 'leads',
          iterationId: before.iteration!.id,
          name,
        }),
      ).toThrow('1 至 80')
    }
  })

  it('完成只更新目标画板现状并保留更新前快照；重复操作和过期迭代被拒绝', () => {
    const data = withIteration()
    const before = getProject(data, 'leads').diagram!
    const action = { type: 'publish' as const, boardId: 'leads', iterationId: before.iteration!.id }
    const next = manageIteration(data, action)
    const after = getProject(next, 'leads').diagram!
    expect(after.iteration).toBeUndefined()
    expect(snapshot(after)).toEqual(snapshot(before))
    expect(after.history[0].snapshot).toEqual(before.iteration!.baseline)
    expect(getProject(next, 'sales')).toEqual(getProject(data, 'sales'))
    expect(() => manageIteration(next, action)).toThrow('已结束')
    const following = manageIteration(next, { type: 'start', boardId: 'leads', name: '下次迭代' })
    expect(() => manageIteration(following, { ...action, type: 'discard' })).toThrow('发生变化')
    expect(parseWorkspace(JSON.parse(JSON.stringify(next)))).toEqual(next)
  })

  it('放弃精确恢复基线并保留已有历史，不影响来源数据', () => {
    const data = withIteration()
    const graph = getProject(data, 'leads').diagram!
    const next = manageIteration(data, {
      type: 'discard',
      boardId: 'leads',
      iterationId: graph.iteration!.id,
    })
    const restored = getProject(next, 'leads').diagram!
    expect(snapshot(restored)).toEqual(graph.iteration!.baseline)
    expect(restored.history).toEqual(graph.history)
    expect(restored.iteration).toBeUndefined()
    expect(getProject(data, 'leads').diagram?.iteration).toBeDefined()
  })

  it('没有业务变更或历史达到上限时禁止完成，且不删除任何历史', () => {
    let data = manageIteration(workspace(), { type: 'start', boardId: 'leads', name: '未修改' })
    expect(() =>
      manageIteration(data, {
        type: 'publish',
        boardId: 'leads',
        iterationId: getProject(data, 'leads').diagram!.iteration!.id,
      }),
    ).toThrow('还没有业务变更')
    data = withIteration()
    const graph = getProject(data, 'leads').diagram!
    graph.history = Array.from({ length: 50 }, (_, index) => ({
      id: `version-${index}`,
      name: `历史 ${index}`,
      publishedAt: new Date().toISOString(),
      snapshot: snapshot(graph),
    }))
    expect(() =>
      manageIteration(data, {
        type: 'publish',
        boardId: 'leads',
        iterationId: graph.iteration!.id,
      }),
    ).toThrow('50')
    expect(graph.history).toHaveLength(50)
  })
})
