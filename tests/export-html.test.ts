import { describe, expect, it } from 'vitest'
import {
  emptyDiagram,
  newComponent,
  newConnection,
  type GraphSnapshot,
} from '../src/shared/diagram'
import { renderExportHtml, type ExportHtmlData } from '../src/shared/export-html'
import { exportBoardPath, exportHistoryPath } from '../src/shared/export-paths'
import { type ExportChangeReport } from '../src/shared/export'
import { type CombinedDiagram } from '../src/shared/combined-diagram'
import { iterationView } from '../src/shared/iteration'

function sample(): ExportHtmlData {
  const form = { ...newComponent('ui', { x: -440, y: -120 }), id: 'form', name: '注册页面' }
  form.outputs[0] = {
    id: 'submit',
    name: '提交手机号',
    dataType: 'Registration',
    description: 'phone: 手机号；code: 验证码',
  }
  const validate = {
    ...newComponent('validation', { x: 20, y: 200 }),
    id: 'validate',
    name: '注册校验',
    description: '逐项检查用户输入',
    metadata: { failurePolicy: '反馈错误，允许再次提交' },
    validation: {
      passCondition: 'all' as const,
      strategy: 'stopWhenDecided' as const,
      rules: [
        {
          id: 'phone-rule',
          name: '手机号有效',
          condition: 'phone 满足格式要求',
          when: '手机号注册',
          failureMessage: '请输入正确手机号',
        },
      ],
    },
  }
  const edge = {
    ...newConnection(form, validate),
    id: 'submit-edge',
    name: '提交注册',
    protocol: 'HTTP POST',
    condition: '已填写必填项',
    description: '发起注册请求并等待校验结果',
    sourcePortId: 'submit',
  }
  const graph: GraphSnapshot = {
    ...emptyDiagram(),
    components: [form, validate],
    connections: [edge],
  }
  return {
    title: '注册系统',
    exportedAt: '2026-11-01T01:00:00.000Z',
    boards: [
      {
        id: 'registration',
        name: '用户注册',
        path: '账号系统 / 用户注册',
        description: '支持手机号注册与校验',
        versions: [{ key: 'current', label: '现状', graph }],
      },
    ],
  }
}

function changedSample(): ExportHtmlData {
  const data = sample()
  const baseline = structuredClone(data.boards[0].versions[0].graph)
  const modified = { ...baseline.components[0], description: '支持手机号验证码与邮箱注册' }
  const added = { ...newComponent('data', { x: 400, y: 200 }), id: 'new-data', name: '注册资料' }
  const graph = {
    ...baseline,
    components: [modified, added],
    connections: [
      { ...baseline.connections[0], id: 'new-edge', targetId: added.id, targetPortId: null },
    ],
  }
  const report: ExportChangeReport = {
    schemaVersion: 1,
    boardId: 'registration',
    comparison: {
      kind: 'active-iteration',
      id: 'active',
      name: '手机号注册',
      before: 'baseline.json',
      after: 'graph.json',
    },
    counts: {
      components: { added: 1, modified: 1, removed: 1 },
      connections: { added: 1, modified: 0, removed: 1 },
      total: 5,
    },
    changes: [
      {
        kind: 'component',
        id: modified.id,
        name: modified.name,
        status: 'modified',
        before: baseline.components[0],
        after: modified,
        fields: [
          {
            path: '/description',
            label: '说明',
            before: baseline.components[0].description,
            after: modified.description,
            beforeExists: true,
            afterExists: true,
          },
        ],
      },
      {
        kind: 'component',
        id: added.id,
        name: added.name,
        status: 'added',
        before: null,
        after: added,
        fields: [],
      },
      {
        kind: 'component',
        id: baseline.components[1].id,
        name: baseline.components[1].name,
        status: 'removed',
        before: baseline.components[1],
        after: null,
        fields: [],
      },
      {
        kind: 'connection',
        id: graph.connections[0].id,
        name: graph.connections[0].name,
        status: 'added',
        before: null,
        after: graph.connections[0],
        fields: [],
      },
      {
        kind: 'connection',
        id: baseline.connections[0].id,
        name: baseline.connections[0].name,
        status: 'removed',
        before: baseline.connections[0],
        after: null,
        fields: [],
      },
    ],
    affectedComponentIds: [],
  }
  data.boards[0].role = 'changed'
  data.boards[0].kind = 'atomic'
  data.boards[0].versions = [
    {
      key: 'iteration',
      label: '本次迭代 · 手机号注册',
      iterationId: 'active',
      graph,
      baseline,
      comparison: report,
    },
    { key: 'current', label: '现状基线', graph: baseline },
  ]
  return data
}

describe('离线 HTML 图导出', () => {
  it('保留图、业务属性、校验、端口、方向和稳定 ID 的可读定义', () => {
    const html = renderExportHtml(sample())
    for (const value of [
      '注册系统',
      '账号系统 / 用户注册',
      '2026-11-01T01:00:00.000Z',
      '逐项检查用户输入',
      'Registration',
      'phone: 手机号；code: 验证码',
      '手机号有效',
      'phone 满足格式要求',
      '请输入正确手机号',
      '首条失败即停止',
      'HTTP POST',
      '已填写必填项',
      '注册页面 (form) → 注册校验 (validate)',
      '反馈错误，允许再次提交',
      'submit-edge',
      '完整 JSON 定义',
      'marker-end=',
      'viewBox="-560 -200 ',
      `${exportBoardPath('registration')}/graph.json`,
      'README.md',
    ]) {
      expect(html).toContain(value)
    }
    expect(html).toContain('href="#board-0-version-0-node-0"')
    expect(html).toContain('id="board-0-version-0-edge-0"')
  })

  it('全部外部文本转义；导出不依赖网络、远程字体或外部脚本', () => {
    const data = sample()
    const attack = '</script><img src="https://evil.test/x" onerror="alert(1)">&\''
    data.title = attack
    data.boards[0].id = '../bad"board'
    data.boards[0].name = attack
    data.boards[0].description = attack
    data.boards[0].versions[0].key = attack
    data.boards[0].versions[0].graph.components[0].name = attack
    data.boards[0].versions[0].graph.components[0].metadata = { unsafe: attack }
    const html = renderExportHtml(data)
    expect(html.match(/<script>/g)).toHaveLength(1)
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/)
    expect(html).toContain('&lt;/script&gt;&lt;img')
    expect(html).toContain('&quot;alert(1)\u0026quot;')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('href="boards/../bad"board')
  })

  it('独立标记多个版本，引用范围外的图时保留来源与版本提示', () => {
    const data = sample()
    const graph = structuredClone(data.boards[0].versions[0].graph)
    graph.components[0].reference = {
      boardId: 'external-board',
      componentId: 'entry',
      version: 'history',
      historyId: 'release-one',
      outputIds: [],
      definitionHash: '0123456789abcdef',
    }
    data.boards[0].versions.push({ key: 'iteration', label: '迭代 · 手机号注册', graph })
    const html = renderExportHtml(data)
    expect(html).toContain('value="board-0-version-0"')
    expect(html).toContain('value="board-0-version-1"')
    expect(html).toContain('id="board-0-version-1-node-0"')
    expect(html).toContain(`href="${exportBoardPath('registration')}/baseline.json"`)
    expect(html).toContain('未包含在本导出范围中；图中保留已采用的定义')
    expect(html).toContain('历史 release-one')
    expect(html).toContain('external-board')
    expect(html).toContain('未启用脚本')
    data.boards[0].versions.push({ key: 'history-release-one', label: '历史现状', graph })
    expect(renderExportHtml(data)).toContain(
      `href="${exportHistoryPath('registration', 'release-one')}"`,
    )
  })

  it('引用包含在导出中的其他画板时生成内部导航；空图和空范围也能阅读', () => {
    const data = sample()
    data.boards[0].versions[0].graph.components[0].reference = {
      boardId: 'provider',
      componentId: 'entry',
      version: 'current',
      outputIds: [],
      definitionHash: '0123456789abcdef',
    }
    data.boards.push({
      id: 'provider',
      name: '短信服务',
      path: '外部服务 / 短信服务',
      description: '',
      versions: [{ key: 'current', label: '现状', graph: emptyDiagram() }],
    })
    const html = renderExportHtml(data)
    expect(html).toContain('<a href="#board-1-version-0">外部服务 / 短信服务 · 现状</a>')
    expect(html).toContain('这张图暂时没有组件')
    expect(renderExportHtml({ ...data, boards: [] })).toContain('导出范围中没有画板')
  })

  it('来源链接精确指向现状、指定历史或同一活动迭代，缺失版本时保留缓存提示', () => {
    const data = sample()
    const reference = {
      boardId: 'provider',
      componentId: 'entry',
      version: 'current' as 'current' | 'iteration' | 'history',
      outputIds: [],
      definitionHash: '0123456789abcdef',
    }
    data.boards[0].versions[0].graph.components[0].reference = reference
    const sourceGraph = {
      ...emptyDiagram(),
      components: [{ ...newComponent('api'), id: 'entry', name: '公开接口' }],
    }
    data.boards.push({
      id: 'provider',
      name: '短信服务',
      path: '短信服务',
      description: '',
      versions: [
        { key: 'iteration', label: '正在设计', graph: sourceGraph, iterationId: 'active' },
        { key: 'current', label: '已落地', graph: sourceGraph },
        { key: 'history-release-one', label: '历史一', graph: sourceGraph },
      ],
    })
    expect(renderExportHtml(data)).toContain(
      '<a href="#board-1-version-1-node-0">短信服务 · 已落地</a>',
    )
    Object.assign(reference, { version: 'history', historyId: 'release-one' })
    expect(renderExportHtml(data)).toContain(
      '<a href="#board-1-version-2-node-0">短信服务 · 历史一</a>',
    )
    Object.assign(reference, { historyId: 'missing' })
    expect(renderExportHtml(data)).toContain('短信服务（该引用版本未包含在本导出中')
    expect(renderExportHtml(data)).not.toMatch(/href="#board-1-version-\d-node-0">短信服务/)
    Object.assign(reference, { version: 'iteration', iterationId: 'active' })
    expect(renderExportHtml(data)).toContain(
      '<a href="#board-1-version-0-node-0">短信服务 · 正在设计</a>',
    )
    Object.assign(reference, { iterationId: 'stale-iteration' })
    expect(renderExportHtml(data)).toContain('短信服务（该引用版本未包含在本导出中')
    expect(renderExportHtml(data)).not.toMatch(/href="#board-1-version-\d-node-0">短信服务/)
  })
  it('默认以增删改覆盖图展示差异，保留已删节点与连接并输出可读的前后值', () => {
    const data = changedSample()
    const html = renderExportHtml(data)
    expect(html).toContain('本次迭代变更总览')
    expect(html).toContain('本次迭代与现状基线对比')
    expect(html).toContain('graph-node graph-change change-added')
    expect(html).toContain('graph-node graph-change change-modified')
    expect(html).toContain('graph-node graph-change change-removed')
    expect(html).toContain('[删除] 提交注册')
    expect(html).toContain('注册校验')
    expect(html).toContain('变更前</span>')
    expect(html).toContain('变更后</span>')
    expect(html).toContain('支持手机号验证码与邮箱注册')
    expect(html).toContain('data-focus="board-0-version-0-node-0-visual"')
    expect(html).toContain('data-detail="board-0-version-0-change-0"')
    expect(html).toContain('突出变更')
    expect(html).toContain('原子图原图')
    expect(html).toContain('查看所属原图')
    const details = [...html.matchAll(/<section class="change-detail"[\s\S]*?<\/section>/g)].map(
      (match) => match[0],
    )
    expect(details).toHaveLength(5)
    for (const detail of details) {
      expect(detail).not.toContain('完整前后 JSON')
      expect(detail).not.toContain('<pre>')
      expect(detail).not.toContain('组件模板')
      expect(detail).not.toContain('builtin-')
    }
    const added = details.find((detail) => detail.includes('<h4>注册资料</h4>'))!
    const removed = details.find((detail) => detail.includes('<h4>注册校验</h4>'))!
    expect(added).toContain('新增内容')
    expect(added).toContain('数据对象')
    expect(removed).toContain('删除内容')
    expect(removed).toContain('手机号有效')
    expect(removed).toContain('请输入正确手机号')
    expect(html).toContain('完整 JSON 定义')
  })

  it('变更字段文本不会变成 HTML 或脚本，历史区间也清晰标注比较语义', () => {
    const data = changedSample()
    const comparison = data.boards[0].versions[0].comparison!
    comparison.comparison.kind = 'history-interval'
    comparison.changes[0].fields[0].after =
      '</script><img src="https://evil.test" onerror="alert(1)">'
    const html = renderExportHtml(data)
    expect(html).toContain('历史区间变更总览')
    expect(html).toContain('历史快照区间对比')
    expect(html).toContain('不代表逐次编辑记录')
    expect(html).not.toContain('<img')
    expect(html.match(/<script>/g)).toHaveLength(1)
    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain('&lt;/script&gt;&lt;img')
  })

  it('组合视图保留版本画框和引用，关联图中的相同局部 ID 不会误标为变更', () => {
    const data = changedSample()
    data.exportMode = 'changes'
    const version = data.boards[0].versions[0]
    const overlay = iterationView({
      ...version.graph,
      history: [],
      iteration: {
        id: 'active',
        name: '手机号注册',
        startedAt: '2026-11-01T00:00:00.000Z',
        baseline: version.baseline!,
      },
    })
    const context = {
      ...newComponent('api', { x: 1100, y: 150 }),
      id: 'form',
      name: '关联来源接口',
    }
    const contextGraph = { ...emptyDiagram(), components: [context] }
    data.boards.push({
      id: 'provider',
      name: '来源图',
      path: '其他应用 / 来源图',
      description: '',
      role: 'context',
      kind: 'atomic',
      versions: [{ key: 'current', label: '现状', graph: contextGraph }],
    })
    const location = {
      boardId: 'registration',
      version: 'iteration' as const,
      iterationId: 'active',
    }
    const frameId = 'registration:iteration:active'
    const nodes = overlay.components.map((component) => ({
      id: `${frameId}/${component.id}`,
      boardId: frameId,
      component,
      location: { ...location, componentId: component.id },
    }))
    nodes.push({
      id: 'provider:current/form',
      boardId: 'provider:current',
      component: context,
      location: {
        boardId: 'provider',
        version: 'current' as never,
        componentId: 'form',
        iterationId: undefined as never,
      },
    })
    const combined: CombinedDiagram = {
      rootKey: frameId,
      boards: [
        {
          id: frameId,
          board: {
            id: 'registration',
            name: '用户注册',
            path: '账号系统 / 用户注册',
            diagram: { ...version.graph, history: [] },
          },
          location,
          graph: overlay,
          x: -480,
          y: -200,
          width: 1400,
          height: 800,
        },
        {
          id: 'provider:current',
          board: {
            id: 'provider',
            name: '来源图',
            path: '其他应用 / 来源图',
            diagram: { ...contextGraph, history: [] },
          },
          location: { boardId: 'provider', version: 'current' },
          graph: contextGraph,
          x: 1050,
          y: 50,
          width: 420,
          height: 500,
        },
      ],
      nodes,
      edges: [
        ...overlay.connections.map((connection) => ({
          id: connection.id,
          kind: 'connection' as const,
          sourceId: `${frameId}/${connection.sourceId}`,
          targetId: `${frameId}/${connection.targetId}`,
          name: connection.name,
          connection,
        })),
        {
          id: 'cross-reference',
          kind: 'reference',
          sourceId: `${frameId}/form`,
          targetId: 'provider:current/form',
          name: '引用入口',
        },
      ],
      issues: [],
      pendingHistory: [],
      truncated: false,
      width: 1600,
      height: 900,
    }
    data.combined = combined
    data.combinedNodeReasons = { 'provider:current/form': ['reference-source'] }
    const html = renderExportHtml(data)
    expect(html).toContain('变更内容组合视图')
    expect(html).toContain('class="frame-rect"')
    expect(html).toContain('class="reference-link"')
    expect(html).toContain('组合视图变更')
    expect(html).toContain('变更所属原图与关联图')
    expect(html).toContain('href="combined.json"')
    expect(html).toContain(
      'href="#board-1-version-0-node-0" id="combined-node-3" class="graph-node graph-context"',
    )
    expect(html).toContain('引用来源')
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
