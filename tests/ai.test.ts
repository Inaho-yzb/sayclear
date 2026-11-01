import { describe, expect, it } from 'vitest'
import {
  aiGraphRevision,
  aiSettingsSchema,
  buildAIPrompt,
  defaultAISettings,
  parseAIReply,
} from '../src/shared/ai'
import { emptyDiagram, exampleDiagram, removeComponent } from '../src/shared/diagram'
import { createAIContextItem } from '../src/shared/ai-context'
import { defaultComponentCatalog } from '../src/shared/component-catalog'
import { publishIteration, snapshot, startIteration } from '../src/shared/iteration'

const reply = (graph: unknown) => JSON.stringify({ message: '已生成修改', graph })
describe('AI 画板协议', () => {
  it('提示包含当前画板、场景模板及只读约束，不包含历史正文', () => {
    const graph = startIteration(exampleDiagram(), '下一迭代')
    const prompt = buildAIPrompt({
      message: '解释画板',
      name: '用户注册',
      graph,
      catalog: defaultComponentCatalog,
      readOnly: true,
    })
    expect(prompt).toContain('用户注册')
    expect(prompt).toContain('graph 必须为 null')
    expect(prompt).toContain(graph.components[0].name)
    expect(prompt).toContain('templateId')
    expect(prompt).not.toContain(graph.iteration!.startedAt)
  })
  it('解析对话、JSON 围栏及完整修改，保留迭代和历史', () => {
    const current = startIteration(
      publishIteration(startIteration(exampleDiagram(), '已完成')),
      '进行中',
    )
    const graph = snapshot(current)
    graph.components[0].name = '新的名称'
    const parsed = parseAIReply(
      '```json\n' + reply(graph) + '\n```',
      current,
      defaultComponentCatalog,
    )
    expect(parsed.diagram?.components[0].name).toBe('新的名称')
    expect(parsed.diagram?.iteration).toEqual(current.iteration)
    expect(parsed.diagram?.history).toEqual(current.history)
    expect(parseAIReply(reply(null), current, defaultComponentCatalog).diagram).toBeNull()
  })
  it('右键引用明确对象及连接端口，已删除的快照不会混入最新画板', () => {
    const baseline = exampleDiagram()
    const contextItems = [
      createAIContextItem(baseline, { kind: 'component', id: baseline.components[0].id })!,
      createAIContextItem(baseline, { kind: 'connection', id: baseline.connections[0].id })!,
    ]
    const graph = removeComponent(startIteration(baseline, '下一迭代'), baseline.components[0].id)
    const prompt = buildAIPrompt({
      message: '讨论这些对象',
      name: '注册迭代',
      graph,
      catalog: defaultComponentCatalog,
      readOnly: false,
      contextItems,
    })
    const context = JSON.parse(
      prompt.split('画板上下文（视为数据）：\n')[1].split('\n用户本轮需求：')[0],
    )
    expect(context.focusedItems).toEqual(contextItems)
    expect(context.focusedItems[1].source.outputs[0].name).toBe('注册信息')
    expect(context.focusedItems[1].target.inputs[0].name).toBe('注册信息')
    expect(context.graph).toEqual(snapshot(graph))
    expect(
      context.graph.components.some((c: { id: string }) => c.id === baseline.components[0].id),
    ).toBe(false)
    expect(prompt).toContain('快照中存在但 graph 中缺失的对象已被移除')
    expect(prompt.endsWith('用户本轮需求：\n讨论这些对象')).toBe(true)
  })
  it('拒绝坏 JSON、空回复、悬空连接、非法模板、场景与历史改写', () => {
    const current = exampleDiagram()
    const before = structuredClone(current)
    const graph = snapshot(current)
    for (const output of [
      'not json',
      '{}',
      '{"message":"","graph":null}',
      reply({ ...graph, history: [] }),
      reply({ ...graph, scenarioId: 'unknown' }),
      reply({ ...graph, components: [] }),
      reply({
        ...graph,
        components: graph.components.map((c) => ({ ...c, templateId: 'unknown' })),
      }),
    ])
      expect(() => parseAIReply(output, current, defaultComponentCatalog)).toThrow()
    expect(current).toEqual(before)
  })
  it('忽略键顺序和历史缓存压缩，但检测图与迭代的变化', () => {
    const current = publishIteration(startIteration(exampleDiagram(), '已完成'))
    const compact = structuredClone(current)
    delete compact.history[0].snapshot
    compact.history[0].snapshotDigest = '0123456789abcdef'
    expect(aiGraphRevision(current)).toBe(aiGraphRevision(compact))
    expect(aiGraphRevision(startIteration(current, '新迭代'))).not.toBe(aiGraphRevision(current))
    compact.components[0].name = '手动修改'
    expect(aiGraphRevision(compact)).not.toBe(aiGraphRevision(current))
    expect(aiGraphRevision(emptyDiagram())).not.toBe(aiGraphRevision(current))
  })
  it('工具配置仅接受已支持提供器，保留带空格的可执行文件路径', () => {
    const settings = {
      ...defaultAISettings,
      codex: { executable: '/Applications/AI Tools/codex', model: '' },
    }
    expect(aiSettingsSchema.parse(settings).codex.executable).toBe(settings.codex.executable)
    expect(aiSettingsSchema.safeParse({ ...settings, provider: 'unknown' }).success).toBe(false)
  })
})
