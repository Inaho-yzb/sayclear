import { componentTypes, connectionTypes } from './diagram'
import { type ExportChange, type ExportChangeReport } from './export'
import { describeValidation } from './validation'

export const htmlEscape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
export const statusLabels = {
  added: '新增',
  modified: '修改',
  removed: '删除',
  unchanged: '未变更',
}
export type ReviewEntry = {
  change: ExportChange
  report: ExportChangeReport
  detailId: string
  visualId: string
  originalTarget: string
  boardName: string
  boardPath: string
}

export function statusBadge(status: keyof typeof statusLabels): string {
  return `<span class="change-badge change-${status}">${statusLabels[status]}</span>`
}

const fieldLabels: Record<string, string> = {
  id: 'ID',
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
  metadata: '自定义属性',
  validation: '校验配置',
  sourceId: '起点组件',
  targetId: '终点组件',
  sourcePortId: '输出端口',
  targetPortId: '输入端口',
  protocol: '协议',
  condition: '触发条件',
  dataType: '数据类型',
  boardId: '来源画板',
  componentId: '来源组件',
  version: '版本',
  historyId: '历史 ID',
  iterationId: '迭代 ID',
  outputIds: '引用输出',
  definitionHash: '采用的定义指纹',
  passCondition: '通过条件',
  strategy: '执行策略',
  rules: '校验规则',
  when: '执行条件',
  failureMessage: '失败提示',
}

function valueMarkup(value: unknown, exists = true, key = ''): string {
  if (!exists) return '<p class="value-empty">未设置</p>'
  if (value === null || value === undefined) return '<p class="value-empty">无</p>'
  if (typeof value === 'boolean') return `<p>${value ? '是' : '否'}</p>`
  if (Array.isArray(value))
    return value.length
      ? `<ul class="structured-values">${value.map((item) => `<li>${valueMarkup(item)}</li>`).join('')}</ul>`
      : '<p class="value-empty">无</p>'
  if (typeof value === 'object') {
    const fields = Object.entries(value).filter(([field]) => field !== 'position')
    return fields.length
      ? `<dl class="structured-object">${fields.map(([field, content]) => `<dt>${htmlEscape(fieldLabels[field] ?? field)}</dt><dd>${valueMarkup(content, true, field)}</dd>`).join('')}</dl>`
      : '<p class="value-empty">无</p>'
  }
  const text =
    key === 'type'
      ? (componentTypes[value as keyof typeof componentTypes] ??
        connectionTypes[value as keyof typeof connectionTypes] ??
        String(value))
      : key === 'boundary'
        ? ({ internal: '系统内部', external: '系统外部' }[String(value)] ?? String(value))
        : String(value)
  return `<p class="multiline">${htmlEscape(text) || '<span class="value-empty">空内容</span>'}</p>`
}

function comparisonValues(
  label: string,
  before: unknown,
  after: unknown,
  beforeExists = true,
  afterExists = true,
): string {
  return `<div class="field-comparison"><h5>${htmlEscape(label)}</h5><div class="comparison-columns"><div class="before-value"><span class="value-label">变更前</span>${valueMarkup(before, beforeExists)}</div><div class="after-value"><span class="value-label">变更后</span>${valueMarkup(after, afterExists)}</div></div></div>`
}

function businessSummary(entry: ReviewEntry): string {
  const { change } = entry
  const object = change.status === 'removed' ? change.before : change.after
  if (!object) return ''
  const values: Record<string, unknown> = {
    类型:
      change.kind === 'component'
        ? componentTypes[object.type as keyof typeof componentTypes]
        : connectionTypes[object.type as keyof typeof connectionTypes],
  }
  if (object.description.trim()) values.说明 = object.description
  const componentName = (id: string) => {
    const related = entry.report.changes.find(
      (candidate) => candidate.kind === 'component' && candidate.id === id,
    )
    const component = change.status === 'removed' ? related?.before : related?.after
    return component?.name ?? id
  }
  if ('inputs' in object) {
    if (object.boundary === 'external') values.系统边界 = '系统外部'
    if (object.exposed) values.对外开放 = '是'
    if (object.ownerId) values.归属组件 = componentName(object.ownerId)
    for (const [key, ports] of [
      ['输入端口', object.inputs],
      ['输出端口', object.outputs],
    ] as const)
      if (ports.length)
        values[key] = ports.map((port) => ({
          名称: port.name,
          ...(port.dataType.trim() ? { 数据类型: port.dataType } : {}),
          ...(port.description.trim() ? { 说明: port.description } : {}),
        }))
    if (object.validation) values.校验规则 = describeValidation(object.validation)
    if (object.metadata && Object.keys(object.metadata).length)
      values.自定义属性 = Object.entries(object.metadata).map(([name, value]) => ({
        属性: name,
        内容: value,
      }))
    if (object.reference) {
      values.引用来源 = object.reference.boardId
      values.引用版本 = { current: '现状', iteration: '进行中迭代', history: '固定历史' }[
        object.reference.version
      ]
    }
  } else {
    values.连接方向 = `${componentName(object.sourceId)} → ${componentName(object.targetId)}`
    if (object.protocol.trim()) values.协议 = object.protocol
    if (object.condition.trim()) values.触发条件 = object.condition
  }
  return `<div class="field-comparison"><h5>${change.status === 'added' ? '新增内容' : '删除内容'}</h5>${valueMarkup(values)}</div>`
}

function changeDetails(entry: ReviewEntry): string {
  const { change } = entry
  return `<section class="change-detail" id="${entry.detailId}" data-change-visual="${entry.visualId}"><div class="change-detail-heading">${statusBadge(change.status)}<span>${change.kind === 'component' ? '组件' : '连接'}</span></div><h4>${htmlEscape(change.name)}</h4><p class="meta">${htmlEscape(entry.boardPath)}<br>对象 ID：<code>${htmlEscape(change.id)}</code></p><p class="change-detail-actions"><a href="#${entry.visualId}" data-focus="${entry.visualId}" data-detail="${entry.detailId}">定位图中对象</a> · <a href="#${entry.originalTarget}">查看所属原图</a></p>${entry.report.comparison.kind === 'history-interval' ? '<p class="comparison-note">历史快照区间对比；不代表逐次编辑记录。</p>' : ''}${change.status === 'modified' ? change.fields.map((field) => comparisonValues(field.label, field.before, field.after, field.beforeExists, field.afterExists)).join('') : businessSummary(entry)}</section>`
}

export function renderReview(entries: ReviewEntry[], title = '变更清单'): string {
  if (!entries.length) return ''
  return `<div class="change-review"><div class="review-heading"><h4>${title}</h4><span>${entries.length} 项</span></div><ol class="change-list">${entries.map((entry, index) => `<li><a href="#${entry.detailId}" data-focus="${entry.visualId}" data-detail="${entry.detailId}"${index ? '' : ' aria-current="true"'}>${statusBadge(entry.change.status)}<span><strong>${htmlEscape(entry.change.name)}</strong><small>${htmlEscape(entry.boardName)} · ${entry.change.kind === 'component' ? '组件' : '连接'}</small></span></a></li>`).join('')}</ol><div class="change-inspector" aria-live="polite">${entries.map(changeDetails).join('')}</div></div>`
}

export const reviewStyles = `
.change-summary{background:#fff;border:1px solid #e4e7ed;border-radius:14px;padding:20px 24px;margin:22px 0}.change-summary h3{margin:0 0 12px;font-size:16px}.change-totals{display:flex;align-items:center;gap:20px;flex-wrap:wrap}.change-total{display:flex;align-items:baseline;gap:7px}.change-total strong{font-size:28px}.change-total small{color:#606d7e}.change-badge{display:inline-block;border:1px solid transparent;border-radius:5px;padding:2px 7px;font-size:11px;line-height:1.5;font-weight:600;white-space:nowrap}.change-added{--change-color:#187349;--change-soft:#e6f6ed}.change-modified{--change-color:#986000;--change-soft:#fff4d7}.change-removed{--change-color:#b03e44;--change-soft:#ffebed}.change-unchanged{--change-color:#606d7e;--change-soft:#f0f2f5}.change-badge{color:var(--change-color);background:var(--change-soft);border-color:color-mix(in srgb,var(--change-color) 25%,transparent)}.comparison-legend{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:12px 0;color:#606d7e;font-size:12px}.comparison-banner{background:#fff8e8;border-left:3px solid #c78a2b;padding:11px 14px;font-size:12px;margin:16px 0}.comparison-banner strong{display:block;font-size:13px;margin-bottom:2px}.review-layout{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:18px;align-items:start}.review-canvas{min-width:0}.change-review{border:1px solid #e4e7ed;border-radius:10px;overflow:hidden;background:#ffffff;min-width:0}.review-heading{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #e4e7ed}.review-heading h4{margin:0}.review-heading>span{font-size:11px;color:#606d7e}.change-list{list-style:none;padding:0;margin:0;max-height:205px;overflow:auto;border-bottom:1px solid #e4e7ed}.change-list li{margin:0}.change-list a{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;text-decoration:none;border-left:3px solid transparent}.change-list a:hover,.change-list a[aria-current=true]{background:#ebf0fa;border-left-color:#526bab}.change-list strong{display:block;font-size:12px;color:#303846;font-weight:600;overflow-wrap:anywhere}.change-list small{display:block;font-size:10px;color:#606d7e;margin-top:3px}.change-inspector{padding:14px;max-height:520px;overflow:auto}.change-detail-heading{display:flex;gap:8px;align-items:center;font-size:11px;color:#606d7e}.change-detail h4{margin:9px 0 5px;font-size:15px}.change-detail .meta{font-size:10px}.change-detail-actions{font-size:11px;margin:10px 0 16px}.field-comparison{border-top:1px solid #e4e7ed;padding-top:12px;margin-top:12px}.field-comparison h5{font-size:12px;margin:0 0 9px;color:#586374}.comparison-columns{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0}.comparison-columns>div{border-radius:6px;padding:8px;min-width:0;overflow-wrap:anywhere}.before-value{background:#f5f6f8}.after-value{background:#f0f4fc}.value-label{font-size:10px;color:#606d7e;font-weight:600}.comparison-columns p{margin:6px 0 0;font-size:11px;line-height:1.65}.value-empty{font-style:italic;color:#8b95a4}.structured-values{padding-left:12px;margin:7px 0;font-size:11px}.structured-values>li{margin-bottom:8px}.structured-object{display:block;margin:5px 0;font-size:10px}.structured-object>dt{font-size:10px;margin-top:5px;color:#606d7e}.structured-object>dd{margin:0}.structured-object p{font-size:11px}.comparison-note{font-size:11px;color:#9c7b44}.graph-change{cursor:pointer}.graph-change .node-card{stroke-width:2.5}.graph-change.change-added .node-card{fill:#ecfaf1;stroke:#299362}.graph-change.change-modified .node-card{fill:#fff6db;stroke:#c28c24}.graph-change.change-removed .node-card{fill:#fff0f1;stroke:#c66a70;stroke-dasharray:7 4}.graph-change.change-added path{stroke:#299362;stroke-width:3}.graph-change.change-modified path{stroke:#c28c24;stroke-width:3}.graph-change.change-removed path{stroke:#c66a70;stroke-width:3;stroke-dasharray:8 5}.node-status{font-size:10px;font-weight:700}.graph-selected .node-card{stroke:#526bab!important;stroke-width:4!important;filter:drop-shadow(0 0 4px #b9c6e4)}.graph-selected path{stroke:#526bab!important;stroke-width:4!important}.fade-context .graph-context{opacity:.25}.fade-context .graph-context:hover{opacity:.85}.graph-toolbar .context-toggle[aria-pressed=true]{background:#ebf0fa;border-color:#cbd6ed}.graph-toolbar{flex-wrap:wrap}.graph-viewport{cursor:grab}.graph-viewport.grabbing{cursor:grabbing;user-select:none}.frame-rect{fill:#ffffff;fill-opacity:.7;stroke:#d1d7e0;stroke-width:2}.frame-title{font-size:19px;font-weight:700;fill:#303846}.frame-version{font-size:12px;fill:#606d7e}.reference-link path{stroke:#7c8595;stroke-dasharray:8 5;stroke-width:2.5}.reference-link .edge-label{fill:#606d7e}.ownership-link{stroke:#9aa3b1;stroke-dasharray:3 5;fill:none}.ownership-label{font-size:10px;fill:#7c8595}.combined-issues{font-size:12px;color:#9b723e;background:#fff8e8;padding:12px 16px;border-radius:8px}.role-label{font-size:11px;padding:3px 7px;border-radius:5px;background:#f0f2f5;color:#586374}.change-nav-count{font-size:10px;padding:1px 5px;background:#fff2d6;border-radius:4px;margin-left:5px;color:#94692d}.nav-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b95a4;margin:20px 10px 8px}.original-section-title{font-size:20px;margin-top:35px;color:#303846}.graph-status-label{font-size:10px;fill:#606d7e}.change-summary p{margin:10px 0 0;font-size:12px;color:#606d7e}.change-detail:target{outline:none}@media(max-width:1250px){.review-layout{grid-template-columns:1fr}.change-review{display:grid;grid-template-columns:260px minmax(0,1fr)}.review-heading{grid-column:1/-1}.change-list{max-height:360px;border-bottom:0;border-right:1px solid #e4e7ed}.change-inspector{max-height:440px}.comparison-columns{grid-template-columns:1fr 1fr}}@media(max-width:650px){.change-review{display:block}.change-list{max-height:170px;border-right:0;border-bottom:1px solid #e4e7ed}.change-inspector{max-height:480px}.review-layout{gap:12px}.comparison-columns{grid-template-columns:1fr}.change-summary{padding:16px}.change-totals{gap:13px}.change-total strong{font-size:24px}.graph-toolbar>div{flex-wrap:wrap}.graph-viewport{height:420px}}@media print{.change-inspector{max-height:none;overflow:visible}.change-detail[hidden]{display:block!important}.change-review{display:block}.change-list{display:none}.review-layout{display:block}.graph-context{opacity:1!important}}
`
