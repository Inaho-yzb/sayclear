import {
  COMPONENT_WIDTH,
  componentHeight,
  componentTypes,
  connectionTypes,
  validationSummaryHeight,
  type DiagramComponent,
  type DiagramReference,
  type GraphSnapshot,
  type Port,
} from './diagram'
import { connectionAnchor, connectionCurve } from './diagram-geometry'
import { describeValidation } from './validation'
import { exportBoardPath, exportHistoryPath } from './export-paths'
import { iterationView } from './iteration'
import { type ExportChange, type ExportChangeReport } from './export'
import { type CombinedDiagram } from './combined-diagram'
import { type BoardLocation } from './diagram-references'
import {
  renderReview,
  reviewStyles,
  statusBadge,
  statusLabels,
  type ReviewEntry,
} from './export-html-review'

export type ExportHtmlData = {
  title: string
  exportedAt: string
  exportMode?: 'all' | 'changes'
  combined?: CombinedDiagram
  combinedNodeReasons?: Record<string, string[]>
  boards: {
    id: string
    name: string
    path: string
    description: string
    role?: 'changed' | 'context'
    kind?: string
    versions: {
      key: string
      label: string
      graph: GraphSnapshot
      iterationId?: string
      comparison?: ExportChangeReport
      baseline?: GraphSnapshot
    }[]
  }[]
}

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!
  })
}

function wrapped(value: string, width: number, limit: number): string[] {
  const lines: string[] = []
  let line = '',
    length = 0
  for (const character of value.replace(/\s+/g, ' ')) {
    const size = /[^\u0020-\u007e]/.test(character) ? 14 : 7
    if (length + size > width && line) {
      lines.push(line)
      line = ''
      length = 0
      if (lines.length === limit) {
        lines[limit - 1] = `${lines[limit - 1].slice(0, -1)}…`
        return lines
      }
    }
    line += character
    length += size
  }
  if (line) lines.push(line)
  return lines
}

function textLines(value: string, x: number, y: number, width: number, limit: number): string {
  return wrapped(value, width, limit)
    .map((line, index) => `<tspan x="${x}" y="${y + index * 19}">${escape(line)}</tspan>`)
    .join('')
}

function jsonDetails(value: unknown): string {
  return `<details class="raw-data"><summary>完整 JSON 定义</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`
}

function portsTable(ports: Port[], label: string): string {
  if (!ports.length) return `<p class="muted">${label}：无</p>`
  return `<h5>${label}</h5><div class="table-scroll"><table><thead><tr><th>端口</th><th>类型</th><th>说明</th><th>ID</th></tr></thead><tbody>${ports
    .map(
      (port) =>
        `<tr><th>${escape(port.name)}</th><td>${escape(port.dataType) || '未设置'}</td><td class="multiline">${escape(port.description) || '未设置'}</td><td><code>${escape(port.id)}</code></td></tr>`,
    )
    .join('')}</tbody></table></div>`
}

function renderNode(
  component: DiagramComponent,
  id: string,
  review?: ReviewEntry,
  note = '',
  linkTarget = id,
  visualId = `${id}-visual`,
): string {
  const { x, y } = component.position,
    height = componentHeight(component),
    validationHeight = validationSummaryHeight(component)
  const ports = (output: boolean) =>
    component[output ? 'outputs' : 'inputs']
      .map((port, index) => {
        const portY = 109 + validationHeight + index * 26
        return `<circle cx="${output ? COMPONENT_WIDTH : 0}" cy="${portY}" r="4" fill="${output ? '#647899' : '#71849b'}"/><text class="port" x="${output ? COMPONENT_WIDTH - 12 : 12}" y="${portY + 4}" text-anchor="${output ? 'end' : 'start'}"><title>${escape(`${port.name} · ${port.dataType}\n${port.description}`)}</title>${escape(wrapped(port.name, 90, 1)[0] ?? '')}</text>`
      })
      .join('')
  return `<a href="#${review?.detailId ?? linkTarget}" id="${review?.visualId ?? visualId}" class="graph-node ${review ? `graph-change change-${review.change.status}` : 'graph-context'}"${review ? ` data-focus="${review.visualId}" data-detail="${review.detailId}"` : ''}><g transform="translate(${x} ${y})"><title>${escape(`${component.name}\n${component.description}`)}</title><rect class="node-card" width="${COMPONENT_WIDTH}" height="${height}" rx="12" fill="white" stroke="${component.boundary === 'external' ? '#b78c55' : '#cbd2dd'}" stroke-width="1.5"${component.boundary === 'external' ? ' stroke-dasharray="5 4"' : ''}/><text class="node-kind" x="16" y="25">${escape(componentTypes[component.type])}${component.exposed ? ' · 对外开放' : ''}${component.boundary === 'external' ? ' · 外部' : ''}</text><text class="node-name" x="16" y="49">${textLines(component.name, 16, 49, 198, 1)}</text><text class="node-description" x="16" y="72">${textLines(component.description || '未填写说明', 16, 72, 198, 2)}</text>${
    component.validation
      ? `<text class="validation-note" x="16" y="116">${textLines(describeValidation(component.validation), 16, 116, 198, Math.min(component.validation.rules.length + 2, 5))}</text>`
      : ''
  }${ports(false)}${ports(true)}${review ? `<rect x="176" y="9" width="43" height="18" rx="4" fill="${{ added: '#187349', modified: '#986000', removed: '#b03e44' }[review.change.status]}"/><text class="node-status" x="197.5" y="22" text-anchor="middle" fill="white">${statusLabels[review.change.status]}</text>` : ''}${note ? `<text class="graph-status-label" x="16" y="${height - 5}">${escape(note)}</text>` : ''}${component.reference ? `<text class="node-kind" x="16" y="${height - 18}">引用画板 · ${escape(component.reference.version)}</text>` : ''}</g></a>`
}

function graphToolbar(): string {
  return `<div class="graph-toolbar" aria-label="图查看操作"><span>点击变更对象查看前后值 · 拖动空白处平移</span><div><button type="button" class="context-toggle" data-context-toggle aria-pressed="true">突出变更</button><button type="button" data-zoom="out" aria-label="缩小图">−</button><button type="button" data-zoom="fit">适应视图</button><button type="button" data-zoom="in" aria-label="放大图">＋</button></div></div>`
}

function curveMarkup(
  source: DiagramComponent,
  target: DiagramComponent,
  sourcePortId: string | null,
  targetPortId: string | null,
) {
  const curve = connectionCurve(
    connectionAnchor(source, sourcePortId, true, target),
    connectionAnchor(target, targetPortId, false, source),
  )
  const [x0, y0, x1, y1, x2, y2, x3, y3] = curve.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  return {
    curve,
    x: (x0 + 3 * x1 + 3 * x2 + x3) / 8,
    y: (y0 + 3 * y1 + 3 * y2 + y3) / 8,
    controls: [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
  }
}

function renderGraph(graph: GraphSnapshot, prefix: string, reviews: ReviewEntry[] = []): string {
  if (!graph.components.length) return '<div class="empty-graph">这张图暂时没有组件。</div>'
  const components = new Map(graph.components.map((component) => [component.id, component]))
  const bounds = graph.components.flatMap((component) => [
    { x: component.position.x, y: component.position.y },
    {
      x: component.position.x + COMPONENT_WIDTH,
      y: component.position.y + componentHeight(component),
    },
  ])
  const edges = graph.connections
    .map((edge, index) => {
      const source = components.get(edge.sourceId),
        target = components.get(edge.targetId)
      if (!source || !target) return ''
      const { curve, x, y, controls } = curveMarkup(
        source,
        target,
        edge.sourcePortId,
        edge.targetPortId,
      )
      bounds.push(...controls)
      const review = reviews.find(
        (entry) => entry.change.kind === 'connection' && entry.change.id === edge.id,
      )
      const id = `${prefix}-edge-${index}`
      return `<a href="#${review?.detailId ?? id}" id="${review?.visualId ?? `${id}-visual`}" class="${review ? `graph-change change-${review.change.status}` : 'graph-context'}"${review ? ` data-focus="${review.visualId}" data-detail="${review.detailId}"` : ''}><g class="graph-edge"><title>${escape(`${source.name} → ${target.name}\n${edge.name} · ${connectionTypes[edge.type]}\n${edge.description}${edge.condition ? `\n条件：${edge.condition}` : ''}`)}</title><path d="${curve}" fill="none" stroke="${edge.type === 'data' ? '#577eaf' : '#8b95a5'}" stroke-width="2" marker-end="url(#${prefix}-arrow)"${edge.type === 'contains' || edge.type === 'dependency' ? ' stroke-dasharray="6 4"' : ''}/><text class="edge-label" x="${x}" y="${y - 8}" text-anchor="middle">${review ? `[${statusLabels[review.change.status]}] ` : ''}${escape(wrapped(edge.name, 220, 1)[0] ?? '')}</text></g></a>`
    })
    .join('')
  const minX = Math.min(...bounds.map((point) => point.x)) - 120,
    minY = Math.min(...bounds.map((point) => point.y)) - 80
  const width = Math.max(...bounds.map((point) => point.x)) + 120 - minX,
    height = Math.max(...bounds.map((point) => point.y)) + 80 - minY
  return `${graphToolbar()}<div class="graph-viewport"><svg class="graph-canvas" xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" data-width="${width}" data-height="${height}" role="img" aria-label="系统图，${graph.components.length} 个组件、${graph.connections.length} 条连接"><defs><marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8b95a5"/></marker></defs>${edges}${graph.components
    .map((component, index) =>
      renderNode(
        component,
        `${prefix}-node-${index}`,
        reviews.find(
          (entry) => entry.change.kind === 'component' && entry.change.id === component.id,
        ),
      ),
    )
    .join('')}</svg></div>`
}

function renderReference(reference: DiagramReference, boards: ExportHtmlData['boards']): string {
  const boardIndex = boards.findIndex((board) => board.id === reference.boardId)
  if (boardIndex < 0)
    return `<code>${escape(reference.boardId)}</code>（未包含在本导出范围中；图中保留已采用的定义）`
  const board = boards[boardIndex]
  const key = reference.version === 'history' ? `history-${reference.historyId}` : reference.version
  const versionIndex = board.versions.findIndex(
    (version) =>
      version.key === key &&
      (reference.version !== 'iteration' || version.iterationId === reference.iterationId),
  )
  if (versionIndex < 0)
    return `${escape(board.path)}（该引用版本未包含在本导出中；图中保留已采用的定义）`
  const version = board.versions[versionIndex]
  const componentIndex = version.graph.components.findIndex(
    (component) => component.id === reference.componentId,
  )
  const anchor = `board-${boardIndex}-version-${versionIndex}${componentIndex >= 0 ? `-node-${componentIndex}` : ''}`
  return `<a href="#${anchor}">${escape(board.path)} · ${escape(version.label)}</a>${componentIndex < 0 ? '（该版本中未找到来源组件）' : ''}`
}

function renderDefinitions(graph: GraphSnapshot, prefix: string, boards: ExportHtmlData['boards']) {
  const byId = new Map(graph.components.map((component) => [component.id, component]))
  const componentName = (id: string | null) =>
    id ? `${byId.get(id)?.name ?? '未知组件'} (${id})` : '无'
  return `<details class="definitions"><summary>完整定义 · ${graph.components.length} 个组件 / ${graph.connections.length} 条连接</summary><h4>组件</h4>${
    graph.components
      .map((component, index) => {
        const reference = component.reference
        return `<details class="object-definition" id="${prefix}-node-${index}"><summary>${escape(component.name)} <span>${escape(componentTypes[component.type])}</span></summary><dl><dt>ID</dt><dd><code>${escape(component.id)}</code></dd><dt>说明</dt><dd class="multiline">${escape(component.description) || '未填写'}</dd><dt>组件模板</dt><dd><code>${escape(component.templateId)}</code></dd><dt>边界 / 开放</dt><dd>${component.boundary === 'external' ? '系统外部' : '系统内部'} / ${component.exposed ? '对外开放' : '未开放'}</dd><dt>归属组件</dt><dd>${escape(componentName(component.ownerId))}</dd></dl>${
          reference
            ? `<h5>画板引用</h5><p>${renderReference(reference, boards)} · ${escape(reference.version)}${reference.historyId ? ` · 历史 ${escape(reference.historyId)}` : ''}${reference.iterationId ? ` · 迭代 ${escape(reference.iterationId)}` : ''}</p>`
            : ''
        }${portsTable(component.inputs, '输入端口')}${portsTable(component.outputs, '输出端口')}${component.validation ? `<h5>校验策略与规则</h5><pre>${escape(describeValidation(component.validation))}</pre>` : ''}${
          component.metadata && Object.keys(component.metadata).length
            ? `<h5>自定义属性</h5><dl>${Object.entries(component.metadata)
                .map(
                  ([key, value]) =>
                    `<dt><code>${escape(key)}</code></dt><dd class="multiline">${escape(value) || '未设置'}</dd>`,
                )
                .join('')}</dl>`
            : ''
        }${jsonDetails(component)}</details>`
      })
      .join('') || '<p class="muted">无组件</p>'
  }<h4>连接</h4>${
    graph.connections
      .map((edge, index) => {
        const source = byId.get(edge.sourceId),
          target = byId.get(edge.targetId),
          sourcePort = source?.outputs.find((port) => port.id === edge.sourcePortId),
          targetPort = target?.inputs.find((port) => port.id === edge.targetPortId)
        return `<details class="object-definition" id="${prefix}-edge-${index}"><summary>${escape(edge.name)} <span>${escape(connectionTypes[edge.type])}</span></summary><dl><dt>ID</dt><dd><code>${escape(edge.id)}</code></dd><dt>方向</dt><dd>${escape(componentName(edge.sourceId))} → ${escape(componentName(edge.targetId))}</dd><dt>输出端口</dt><dd>${sourcePort ? escape(`${sourcePort.name} (${sourcePort.id})`) : '未指定'}</dd><dt>输入端口</dt><dd>${targetPort ? escape(`${targetPort.name} (${targetPort.id})`) : '未指定'}</dd><dt>说明</dt><dd class="multiline">${escape(edge.description) || '未填写'}</dd><dt>协议</dt><dd>${escape(edge.protocol) || '未设置'}</dd><dt>触发条件</dt><dd class="multiline">${escape(edge.condition) || '未设置'}</dd></dl>${jsonDetails(edge)}</details>`
      })
      .join('') || '<p class="muted">无连接</p>'
  }</details>`
}

const stylesheet = `
:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#272d38;background:#f5f6f8;font-size:14px;line-height:1.6}*{box-sizing:border-box}body{margin:0}a{color:#526bab;text-underline-offset:3px}a:hover{color:#40588f}button,input,select{font:inherit}button,select{border:1px solid #d1d7e0;border-radius:7px;background:white;color:#374151;padding:6px 12px}button{cursor:pointer}button:hover{background:#f0f3f8}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #94a8d6;outline-offset:3px}aside{position:fixed;inset:0 auto 0 0;width:250px;overflow:auto;padding:28px 20px;background:#eef0f4;border-right:1px solid #e0e4eb}aside .brand{font-size:12px;letter-spacing:.14em;font-weight:700;color:#697386}aside h1{font-size:20px;line-height:1.5;margin:16px 0;overflow-wrap:anywhere}aside input{width:100%;padding:9px 10px;background:white;border:1px solid #d1d7e0;border-radius:7px}nav{margin-top:18px}nav a{display:block;padding:8px 10px;border-radius:7px;text-decoration:none;overflow-wrap:anywhere}nav a:hover{background:#e8edf5}nav small{display:block;color:#667085;line-height:1.4;margin-top:3px}main{margin-left:250px;padding:36px 42px 70px;max-width:1900px}header{margin-bottom:28px}header h2{font-size:30px;letter-spacing:-.03em;margin:0 0 8px}.muted,.meta{color:#667085}.meta{font-size:12px;overflow-wrap:anywhere}.board{background:white;border:1px solid #e0e4eb;border-radius:16px;margin:24px 0;padding:26px;scroll-margin-top:20px}.board-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.board h2{font-size:22px;margin:0 0 5px}.path{margin:0;color:#667085;font-size:12px}.board-description{white-space:pre-wrap;overflow-wrap:anywhere;color:#586374;margin:15px 0 20px}.board-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.board-tools a{font-size:12px;white-space:nowrap}.version-panel{margin-top:20px}.version-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 10px}.version-title h3{margin:0;font-size:15px}.badge{font-size:12px;color:#667085}.graph-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;background:#f7f8fa;border:1px solid #e0e4eb;border-radius:10px 10px 0 0;font-size:12px;color:#667085}.graph-toolbar>div{display:flex;gap:5px}.graph-toolbar button{padding:2px 9px;font-size:12px}.graph-viewport{height:min(65vh,620px);min-height:340px;overflow:auto;background-color:#ffffff;background-image:radial-gradient(#e1e5ec .8px,transparent .8px);background-size:18px 18px;border:1px solid #e0e4eb;border-top:0;border-radius:0 0 10px 10px}.graph-canvas{display:block;width:100%;height:100%;min-width:1px;min-height:1px}.graph-canvas text{font-family:inherit}.node-kind{font-size:10px;fill:#728096}.node-name{font-size:14px;font-weight:700;fill:#303846}.node-description{font-size:12px;fill:#667085}.validation-note{font-size:11px;fill:#6b7280}.port{font-size:10px;fill:#728096}.edge-label{font-size:11px;fill:#667085;paint-order:stroke;stroke:#ffffff;stroke-width:5px;stroke-linejoin:round}.graph-node:hover rect{stroke:#526bab;stroke-width:2.5}.graph-edge:hover path{stroke:#526bab;stroke-width:3}.empty-graph{padding:60px;text-align:center;background:#f7f8fa;border:1px dashed #d7dce5;border-radius:10px;color:#728096}.definitions{margin-top:16px}.definitions>summary{padding:10px 0;font-weight:600;cursor:pointer}.object-definition{border:1px solid #e0e4eb;border-radius:8px;margin:10px 0;scroll-margin-top:24px}.object-definition>summary{cursor:pointer;padding:12px 14px;font-weight:600;overflow-wrap:anywhere}.object-definition>summary span{font-size:11px;color:#728096;font-weight:400;margin-left:8px}.object-definition[open]{padding:0 16px 16px}.object-definition[open]>summary{margin:0 -16px 12px;background:#f7f8fa;border-radius:8px 8px 0 0}.object-definition:target{border-color:#7890c5;box-shadow:0 0 0 3px #ebf0fa}h4{font-size:14px;margin:20px 0 8px}h5{font-size:12px;margin:18px 0 8px;color:#586374}dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 14px;margin:12px 0}dt{color:#728096;font-size:12px;overflow-wrap:anywhere}dd{margin:0;overflow-wrap:anywhere}.multiline{white-space:pre-wrap;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:12px;line-height:1.7;background:#f7f8fa;border-radius:7px;padding:14px;color:#4b5563;max-height:500px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.raw-data{margin-top:16px}.raw-data>summary{font-size:12px;color:#667085;cursor:pointer}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px;text-align:left}td,th{padding:8px 10px;border-bottom:1px solid #e7eaf0;vertical-align:top;max-width:500px;overflow-wrap:anywhere}thead th{background:#f7f8fa;font-weight:500;color:#728096}tbody th{font-weight:500}footer{margin-top:28px;font-size:12px;color:#8b95a4}.no-script{font-size:12px;color:#6b7280}[hidden]{display:none!important}@media(max-width:900px){aside{position:static;width:auto;border-right:0;border-bottom:1px solid #e0e4eb;padding:20px}aside h1{margin:8px 0}nav{display:flex;gap:4px;flex-wrap:wrap}nav a{max-width:240px}nav small{display:none}main{margin:0;padding:24px 16px}.board{padding:18px}.board-header{flex-direction:column;gap:12px}.graph-toolbar>span{display:none}.graph-toolbar{justify-content:flex-end}.graph-viewport{min-height:300px}dl{grid-template-columns:80px minmax(0,1fr)}}@media print{aside,.graph-toolbar,.board-tools,.raw-data{display:none}main{margin:0;padding:0}.board{break-before:page;border:0;padding:0}.graph-viewport{height:600px;overflow:hidden}.graph-canvas{width:100%!important;height:100%!important}.version-panel[hidden]{display:block!important}.definitions>summary{list-style:none}}
`

type HtmlBoard = ExportHtmlData['boards'][number]
type HtmlVersion = HtmlBoard['versions'][number]

function displayGraph(version: HtmlVersion): GraphSnapshot {
  const report = version.comparison
  if (!report?.changes.length) return version.graph
  const components = new Map(version.graph.components.map((item) => [item.id, item]))
  const connections = new Map(version.graph.connections.map((item) => [item.id, item]))
  for (const change of report.changes) {
    const map = change.kind === 'component' ? components : connections
    if (!change.before) map.delete(change.id)
    else map.set(change.id, change.before as never)
  }
  const baseline = version.baseline ?? {
    ...version.graph,
    components: [...components.values()],
    connections: [...connections.values()],
  }
  return iterationView({
    ...version.graph,
    history: [],
    iteration: {
      id: report.comparison.id ?? 'export-comparison',
      name: report.comparison.name,
      startedAt: report.comparison.startedAt ?? '1970-01-01T00:00:00.000Z',
      baseline,
    },
  })
}

function reviewsForVersion(
  board: HtmlBoard,
  boardIndex: number,
  version: HtmlVersion,
  versionIndex: number,
): ReviewEntry[] {
  const graph = displayGraph(version)
  const prefix = `board-${boardIndex}-version-${versionIndex}`
  return (
    version.comparison?.changes.map((change, index) => {
      const objectIndex = (
        change.kind === 'component' ? graph.components : graph.connections
      ).findIndex((item) => item.id === change.id)
      const originalTarget = `${prefix}-${change.kind === 'component' ? 'node' : 'edge'}-${objectIndex}`
      return {
        change,
        report: version.comparison!,
        detailId: `${prefix}-change-${index}`,
        visualId: `${originalTarget}-visual`,
        originalTarget,
        boardName: board.name,
        boardPath: board.path,
      }
    }) ?? []
  )
}

function locationVersion(data: ExportHtmlData, location: BoardLocation) {
  const boardIndex = data.boards.findIndex((board) => board.id === location.boardId)
  const board = data.boards[boardIndex]
  const key = location.version === 'history' ? `history-${location.historyId}` : location.version
  const versionIndex =
    board?.versions.findIndex(
      (version) =>
        version.key === key &&
        (location.version !== 'iteration' || version.iterationId === location.iterationId),
    ) ?? -1
  return { board, boardIndex, versionIndex, version: board?.versions[versionIndex] }
}

function originalTarget(
  data: ExportHtmlData,
  location: BoardLocation,
  componentId?: string,
): string {
  const { board, boardIndex, version, versionIndex } = locationVersion(data, location)
  if (!board || !version) return board ? `board-${boardIndex}` : 'original-graphs'
  const graph = displayGraph(version)
  const componentIndex = componentId
    ? graph.components.findIndex((component) => component.id === componentId)
    : -1
  return `board-${boardIndex}-version-${versionIndex}${componentIndex >= 0 ? `-node-${componentIndex}` : ''}`
}

function comparisonLegend(): string {
  return `<div class="comparison-legend">${statusBadge('added')}${statusBadge('modified')}${statusBadge('removed')}<span>删除对象以虚线保留 · 淡色为未变更上下文</span></div>`
}

function renderCombined(data: ExportHtmlData, reviews: ReviewEntry[]): string {
  const combined = data.combined
  if (!combined) return ''
  const nodes = new Map(combined.nodes.map((node) => [node.id, node]))
  const matches = (entry: ReviewEntry, location: BoardLocation) =>
    location.version === 'iteration' &&
    entry.report.comparison.kind === 'active-iteration' &&
    entry.report.boardId === location.boardId &&
    entry.report.comparison.id === location.iterationId
  const activeReviews = reviews.filter(
    (entry) => entry.report.comparison.kind === 'active-iteration',
  )
  const combinedReviews: ReviewEntry[] = []
  for (const entry of activeReviews) {
    const nodeIndex = combined.nodes.findIndex(
      (node) =>
        entry.change.kind === 'component' &&
        matches(entry, node.location) &&
        entry.change.id === node.component.id,
    )
    const edgeIndex = combined.edges.findIndex(
      (edge) =>
        entry.change.kind === 'connection' &&
        edge.kind === 'connection' &&
        edge.connection?.id === entry.change.id &&
        !!nodes.get(edge.sourceId) &&
        matches(entry, nodes.get(edge.sourceId)!.location),
    )
    if (nodeIndex < 0 && edgeIndex < 0) continue
    combinedReviews.push({
      ...entry,
      detailId: `combined-change-${combinedReviews.length}`,
      visualId: nodeIndex >= 0 ? `combined-node-${nodeIndex}` : `combined-edge-${edgeIndex}`,
    })
  }
  const frames = combined.boards
    .map((frame) => {
      const { board, version } = locationVersion(data, frame.location)
      const role =
        board?.role === 'changed' && frame.location.version === 'iteration'
          ? '变更所属图'
          : '归属 / 引用上下文'
      return `<g class="combined-frame"><rect class="frame-rect" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" rx="18"/><a href="#${originalTarget(data, frame.location)}"><text class="frame-title" x="${frame.x + 24}" y="${frame.y + 34}"><title>${escape(frame.board.path)}</title>${escape(wrapped(frame.board.name, frame.width - 48, 1)[0] ?? '')}</text><text class="frame-version" x="${frame.x + 24}" y="${frame.y + 58}">${escape(version?.label ?? { current: '现状', iteration: '本次迭代', history: '历史现状' }[frame.location.version])} · ${role} · 打开原图 ↗</text></a></g>`
    })
    .join('')
  const edges = combined.edges
    .map((edge, index) => {
      const source = nodes.get(edge.sourceId),
        target = nodes.get(edge.targetId)
      if (!source || !target) return ''
      const { curve, x, y } = curveMarkup(
        source.component,
        target.component,
        edge.connection?.sourcePortId ?? null,
        edge.connection?.targetPortId ?? null,
      )
      const review = combinedReviews.find((entry) => entry.visualId === `combined-edge-${index}`)
      const targetId =
        review?.detailId ?? originalTarget(data, source.location, source.component.id)
      return `<a href="#${targetId}" id="combined-edge-${index}" class="${edge.kind === 'reference' ? 'reference-link' : review ? `graph-change change-${review.change.status}` : 'graph-context'}"${review ? ` data-focus="${review.visualId}" data-detail="${review.detailId}"` : ''}><title>${escape(edge.name)}${edge.kind === 'reference' ? ' · 跨画板引用（非业务执行连接）' : ''}</title><path d="${curve}" fill="none" stroke="#8b95a5" stroke-width="2" marker-end="url(#combined-arrow)"/><text class="edge-label" x="${x}" y="${y - 9}" text-anchor="middle">${review ? `[${statusLabels[review.change.status]}] ` : ''}${escape(edge.name)}</text></a>`
    })
    .join('')
  const ownership = combined.nodes
    .map((node) => {
      if (!node.component.ownerId) return ''
      const owner = combined.nodes.find(
        (candidate) =>
          candidate.boardId === node.boardId && candidate.component.id === node.component.ownerId,
      )
      if (!owner) return ''
      const x = node.component.position.x + COMPONENT_WIDTH / 2,
        y = node.component.position.y
      const ox = owner.component.position.x + COMPONENT_WIDTH / 2,
        oy = owner.component.position.y + componentHeight(owner.component)
      return `<g><path class="ownership-link" d="M ${ox} ${oy} L ${x} ${y}"/><text class="ownership-label" x="${(x + ox) / 2 + 6}" y="${(y + oy) / 2}">归属</text></g>`
    })
    .join('')
  const reasonLabels: Record<string, string> = {
    owner: '归属组件',
    adjacent: '相邻关联',
    reference: '引用关联',
    'reference-source': '引用来源',
    'ownership-reference': '归属引用',
    'board-reference-context': '原子图引用关联',
  }
  const nodeMarkup = combined.nodes
    .map((node, index) => {
      const review = combinedReviews.find((entry) => entry.visualId === `combined-node-${index}`)
      const reasons = data.combinedNodeReasons?.[node.id] ?? []
      const note = review
        ? ''
        : reasons
            .map((reason) => reasonLabels[reason])
            .filter(Boolean)
            .join(' · ')
      return renderNode(
        node.component,
        `combined-node-${index}`,
        review,
        note,
        originalTarget(data, node.location, node.component.id),
        `combined-node-${index}`,
      )
    })
    .join('')
  return `<article class="board combined-export" id="combined-view"><div class="board-header"><div><p class="path">变更、组件归属与引用关系</p><h2>变更内容组合视图</h2><p class="meta">${combined.boards.length} 个版本画框 · ${combined.nodes.length} 个相关组件 · <a href="combined.json">结构化组合数据 ↗</a></p></div><a href="#original-graphs">查看各变更所属原图 ↓</a></div><p class="board-description">彩色对象是选定迭代的实际变更；画框标明其所属画板和版本。虚线跨框连接表示引用，细点线表示组件归属。</p>${comparisonLegend()}${combined.issues.length ? `<div class="combined-issues">${combined.issues.map((issue) => `<p>${escape(issue.message)}</p>`).join('')}</div>` : ''}<section class="version-panel" id="combined-version"><div class="review-layout"><div class="review-canvas fade-context" data-graph-scope>${graphToolbar()}<div class="graph-viewport"><svg class="graph-canvas" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${combined.width} ${combined.height}" data-width="${combined.width}" data-height="${combined.height}" role="img" aria-label="变更内容相关组合图"><defs><marker id="combined-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8b95a5"/></marker></defs>${frames}${ownership}${edges}${nodeMarkup}</svg></div></div>${renderReview(combinedReviews, '组合视图变更')}</div></section></article>`
}

function renderVersion(
  board: HtmlBoard,
  boardIndex: number,
  version: HtmlVersion,
  versionIndex: number,
  data: ExportHtmlData,
): string {
  const prefix = `board-${boardIndex}-version-${versionIndex}`
  const graph = displayGraph(version),
    entries = reviewsForVersion(board, boardIndex, version, versionIndex)
  const graphPath = version.key.startsWith('history-')
    ? exportHistoryPath(board.id, version.key.slice('history-'.length))
    : version.key === 'current' && board.versions.some((item) => item.key === 'iteration')
      ? `${exportBoardPath(board.id)}/baseline.json`
      : `${exportBoardPath(board.id)}/graph.json`
  const comparison = version.comparison
  const banner =
    comparison && comparison.comparison.kind !== 'none' && comparison.comparison.kind !== 'context'
      ? `<div class="comparison-banner"><strong>${comparison.comparison.kind === 'history-interval' ? '历史快照区间对比' : '本次迭代与现状基线对比'} · ${entries.length} 项变更</strong>${escape(comparison.comparison.name)}</div>`
      : ''
  return `<section class="version-panel" id="${prefix}" data-version="${escape(version.key)}"><div class="version-title"><h3>${escape(version.label)}</h3><span class="badge">${version.graph.components.length} 组件 · ${version.graph.connections.length} 连接 · <a href="${escape(graphPath)}">该版本 JSON ↗</a></span></div>${banner}${entries.length ? comparisonLegend() : ''}<div class="${entries.length ? 'review-layout' : 'plain-graph'}"><div class="review-canvas${entries.length ? ' fade-context' : ''}" data-graph-scope>${renderGraph(graph, prefix, entries)}</div>${renderReview(entries)}</div>${renderDefinitions(graph, prefix, data.boards)}</section>`
}

// User content is emitted as escaped text/attributes, never as executable code.
const script = `
function resize(svg,scale){svg.dataset.scale=String(scale);svg.style.width=Number(svg.dataset.width)*scale+'px';svg.style.height=Number(svg.dataset.height)*scale+'px';}
function fit(svg,viewport){resize(svg,Math.min(1,(viewport.clientWidth-8)/Number(svg.dataset.width),(viewport.clientHeight-8)/Number(svg.dataset.height)));viewport.scrollLeft=0;viewport.scrollTop=0;}
function fitVisible(root){root.querySelectorAll('.version-panel:not([hidden]) .graph-canvas').forEach(function(svg){fit(svg,svg.parentElement);});}
function showTargetVersion(target){var panel=target.closest('.version-panel');if(!panel)return;var board=panel.closest('.board'),select=board.querySelector('select');if(select)select.value=panel.id;board.querySelectorAll('.version-panel').forEach(function(item){item.hidden=item!==panel;});}
function focusVisual(id){var visual=document.getElementById(id);if(!visual)return;var svg=visual.closest('svg'),viewport=svg&&svg.parentElement;if(!svg)return;svg.querySelectorAll('.graph-selected').forEach(function(item){item.classList.remove('graph-selected');});visual.classList.add('graph-selected');var box=visual.getBBox(),scale=Math.max(Number(svg.dataset.scale)||1,.7);resize(svg,scale);var view=svg.viewBox.baseVal;viewport.scrollLeft=(box.x-view.x+box.width/2)*scale-viewport.clientWidth/2;viewport.scrollTop=(box.y-view.y+box.height/2)*scale-viewport.clientHeight/2;}
function selectChange(detail){var review=detail.closest('.change-review');if(!review)return;review.querySelectorAll('.change-detail').forEach(function(item){item.hidden=item!==detail;});review.querySelectorAll('[data-detail]').forEach(function(link){if(link.dataset.detail===detail.id)link.setAttribute('aria-current','true');else link.removeAttribute('aria-current');});}
function revealTarget(scroll){var target=document.getElementById(location.hash.slice(1));if(!target)return;showTargetVersion(target);if(target.classList.contains('change-detail')){selectChange(target);focusVisual(target.dataset.changeVisual);if(scroll!==false)target.closest('.review-layout').scrollIntoView({block:'start'});}else{var item=target;while(item){if(item.tagName==='DETAILS')item.open=true;item=item.parentElement;}if(scroll!==false)target.scrollIntoView({block:'start'});}}
document.querySelectorAll('.board').forEach(function(board){var select=board.querySelector('select');if(select){function showVersion(){board.querySelectorAll('.version-panel').forEach(function(panel){panel.hidden=panel.id!==select.value;});fitVisible(board);}select.addEventListener('change',showVersion);showVersion();}});
document.querySelectorAll('.change-review').forEach(function(review){review.querySelectorAll('.change-detail').forEach(function(detail,index){detail.hidden=index!==0;});});
document.querySelectorAll('[data-graph-scope]').forEach(function(scope){scope.querySelectorAll('[data-zoom]').forEach(function(button){button.addEventListener('click',function(){var svg=scope.querySelector('svg'),viewport=scope.querySelector('.graph-viewport');if(!svg)return;if(button.dataset.zoom==='fit'){fit(svg,viewport);return;}var oldScale=Number(svg.dataset.scale)||1,scale=Math.max(.001,Math.min(4,oldScale*(button.dataset.zoom==='in'?1.4:1/1.4))),x=(viewport.scrollLeft+viewport.clientWidth/2)/oldScale,y=(viewport.scrollTop+viewport.clientHeight/2)/oldScale;resize(svg,scale);viewport.scrollLeft=x*scale-viewport.clientWidth/2;viewport.scrollTop=y*scale-viewport.clientHeight/2;});});var toggle=scope.querySelector('[data-context-toggle]');if(toggle)toggle.addEventListener('click',function(){var enabled=toggle.getAttribute('aria-pressed')!=='true';toggle.setAttribute('aria-pressed',String(enabled));scope.classList.toggle('fade-context',enabled);});var viewport=scope.querySelector('.graph-viewport');if(viewport){var drag=null;viewport.addEventListener('pointerdown',function(event){if(event.pointerType!=='mouse'||event.button!==0||event.target.closest('a'))return;drag={x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.classList.add('grabbing');viewport.setPointerCapture(event.pointerId);});viewport.addEventListener('pointermove',function(event){if(!drag)return;viewport.scrollLeft=drag.left-(event.clientX-drag.x);viewport.scrollTop=drag.top-(event.clientY-drag.y);});function stop(){drag=null;viewport.classList.remove('grabbing');}viewport.addEventListener('pointerup',stop);viewport.addEventListener('pointercancel',stop);}});
fitVisible(document);
var firstCombinedChange=document.querySelector('.combined-export .change-detail');if(firstCombinedChange)focusVisual(firstCombinedChange.dataset.changeVisual);
document.querySelector('#board-search').addEventListener('input',function(event){var query=event.target.value.trim().toLocaleLowerCase();document.querySelectorAll('nav a,.change-list li').forEach(function(item){item.hidden=!item.textContent.toLocaleLowerCase().includes(query);});});
document.addEventListener('click',function(event){var link=event.target.closest('a[href^="#"]');if(!link)return;if(link.dataset.detail){event.preventDefault();var detail=document.getElementById(link.dataset.detail);if(detail){showTargetVersion(detail);selectChange(detail);focusVisual(link.dataset.focus);history.replaceState(null,'','#'+detail.id);detail.closest('.review-layout').scrollIntoView({block:'start'});}return;}setTimeout(function(){revealTarget(true);},0);});
window.addEventListener('hashchange',function(){revealTarget(true);});revealTarget(true);
`

export function renderExportHtml(data: ExportHtmlData): string {
  const entries = data.boards.flatMap((board, boardIndex) =>
    board.versions.flatMap((version, versionIndex) =>
      reviewsForVersion(board, boardIndex, version, versionIndex),
    ),
  )
  const active = entries.filter((entry) => entry.report.comparison.kind === 'active-iteration'),
    historical = entries.filter((entry) => entry.report.comparison.kind === 'history-interval')
  const primary = active.length ? active : historical
  const count = (status: ExportChange['status']) =>
    primary.filter((entry) => entry.change.status === status).length
  const boardOrder = data.boards
    .map((board, index) => ({
      board,
      index,
      active: active.filter((entry) => entry.report.boardId === board.id).length,
      total: entries.filter((entry) => entry.report.boardId === board.id).length,
    }))
    .sort((a, b) => b.active - a.active || b.total - a.total || a.index - b.index)
  const summary = `<section class="change-summary" aria-label="变更总览"><h3>${active.length ? '本次迭代变更总览' : historical.length ? '历史区间变更总览' : '当前变更总览'}</h3><div class="change-totals"><div class="change-total"><strong>${primary.length}</strong><small>项变更</small></div>${(['added', 'modified', 'removed'] as const).map((status) => `<div class="change-total">${statusBadge(status)}<strong>${count(status)}</strong></div>`).join('')}</div><p>${active.length ? `另含 ${historical.length} 项历史区间差异，按对应版本单独查看。` : historical.length ? '差异由相邻现状快照推导，可能包含区间内的直接编辑。' : '导出范围内没有待发布的业务变更；下方保留现状与完整定义。'} 点击图中的彩色对象或变更清单，可查看具体前后值。</p></section>`
  const nav = boardOrder
    .map(
      ({ board, index, total }) =>
        `<a href="#board-${index}">${escape(board.name)}${total ? `<span class="change-nav-count">${total} 项</span>` : ''}<small>${escape(board.path)}</small></a>`,
    )
    .join('')
  const originals =
    boardOrder
      .map(
        ({ board, index }) =>
          `<article class="board" id="board-${index}"><div class="board-header"><div><p class="path">${escape(board.path)}</p><h2>${escape(board.name)}</h2><div class="meta">画板 ID：<code>${escape(board.id)}</code> <span class="role-label">${board.kind === 'atomic' ? '原子图原图' : board.role === 'context' ? '关联上下文原图' : '完整原图'}</span></div></div><div class="board-tools">${board.versions.length > 1 ? `<select aria-label="${escape(board.name)}的图版本">${board.versions.map((version, versionIndex) => `<option value="board-${index}-version-${versionIndex}">${escape(version.label)}</option>`).join('')}</select>` : ''}<a href="${escape(exportBoardPath(board.id))}/README.md">画板说明 ↗</a></div></div>${board.description ? `<p class="board-description">${escape(board.description)}</p>` : ''}${board.versions.map((version, versionIndex) => renderVersion(board, index, version, versionIndex, data)).join('')}</article>`,
      )
      .join('') || '<p class="muted">导出范围中没有画板。</p>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(data.title)} · 图导出</title><style>${stylesheet}${reviewStyles}</style></head><body><aside><div class="brand">SAY CLEAR / EXPORT</div><h1>${escape(data.title)}</h1><p class="meta">${data.boards.length} 张画板 · ${data.exportMode === 'changes' ? '变更交付包' : '离线交付包'}</p><input id="board-search" type="search" placeholder="搜索画板或变更…" aria-label="搜索导出的画板与变更"><nav aria-label="画板目录">${data.combined ? '<a href="#combined-view"><strong>变更内容组合视图</strong></a>' : ''}<div class="nav-label">原图与版本</div>${nav}</nav><p class="meta"><a href="README.md">阅读交付说明</a> · <a href="changes.md">Markdown 变更</a></p></aside><main><header><h2>${data.exportMode === 'changes' ? '变更交付包' : '系统图交付包'}</h2><p class="meta">导出时间：${escape(data.exportedAt)}<br>新增、修改、删除直接标记在图上；点击变更对象查看前后内容。</p><noscript><p class="no-script">当前未启用脚本；下方仍可查看全部版本、图、变更和完整定义。</p></noscript></header>${summary}${renderCombined(data, entries)}<h2 class="original-section-title" id="original-graphs">${data.combined ? '变更所属原图与关联图' : '画板与版本'}</h2>${originals}<footer>由 Say Clear 生成 · 本文件可直接在浏览器中离线打开</footer></main><script>${script}</script></body></html>`
}
