import { memo } from 'react'
import { ArrowUpRight, Layers, Link2 } from 'lucide-react'
import {
  COMPONENT_WIDTH,
  componentHeight,
  componentTypes,
  connectionTypes,
} from '../../../shared/diagram'
import { type CombinedBoard, type CombinedNode } from '../../../shared/combined-diagram'
import {
  type CombinedRenderEdge,
  type CombinedViewportSelection,
} from '../../../shared/combined-diagram-render'
import { type Board, type BoardLocation } from '../../../shared/diagram-references'
import { componentIcons } from './component-icons'
import { ValidationSummary } from './ValidationEditor'

export type CombinedDetailLevel = 'overview' | 'compact' | 'full'
export const combinedVersionLabel = (location: BoardLocation, board: Board) =>
  location.version === 'history'
    ? `历史 · ${board.diagram.history.find((h) => h.id === location.historyId)?.name ?? location.historyId}`
    : location.version === 'iteration'
      ? `迭代 · ${board.diagram.iteration?.name ?? location.iterationId}`
      : '现状'

const edgeColors: Record<string, string> = {
  data: 'var(--relation-data)',
  control: 'var(--relation-control)',
  dependency: 'var(--relation-dependency)',
  event: 'var(--relation-event)',
}

const NodeCard = memo(function NodeCard({
  node,
  compact,
  selected,
  dimmed,
  onSelect,
  onOpenBoard,
}: {
  node: CombinedNode
  compact: boolean
  selected: boolean
  dimmed: boolean
  onSelect: (id: string) => void
  onOpenBoard: (location: BoardLocation) => void
}) {
  const component = node.component,
    Icon = componentIcons[component.type]
  return (
    <article
      className={`diagram-node combined-node type-${component.type}${compact ? ' combined-node-compact' : ''}${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
      data-combined-node-id={node.id}
      data-source-component-id={component.id}
      data-reference-status={node.referenceStatus}
      aria-label={`组合组件 ${component.name}`}
      tabIndex={0}
      role="button"
      style={{
        left: component.position.x,
        top: component.position.y,
        width: COMPONENT_WIDTH,
        height: componentHeight(component),
      }}
      onClick={() => onSelect(node.id)}
      onDoubleClick={() => onOpenBoard(node.location)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(node.id)
        }
      }}
    >
      <header>
        <span className="diagram-node-icon">
          <Icon size={18} />
        </span>
        <div>
          <small>
            {component.reference ? '引用 · ' : component.exposed ? '对外开放 · ' : ''}
            {componentTypes[component.type]}
          </small>
          <strong title={component.name}>{component.name}</strong>
        </div>
      </header>
      {!compact && (
        <>
          <p title={component.description}>{component.description || '暂无说明'}</p>
          {component.validation && <ValidationSummary value={component.validation} />}
          <div className="diagram-node-ports">
            <div>
              {component.inputs.map((port) => (
                <span key={port.id} className="diagram-port input">
                  <span className="port-dot" />
                  <span>{port.name}</span>
                </span>
              ))}
            </div>
            <div>
              {component.outputs.map((port) => (
                <span key={port.id} className="diagram-port output">
                  <span>{port.name}</span>
                  <span className="port-dot" />
                </span>
              ))}
            </div>
          </div>
          {component.reference && (
            <div
              className={`combined-reference status-${node.referenceStatus}`}
              title={node.referenceMessage}
            >
              <Link2 size={12} />
              {node.referenceStatus === 'missing'
                ? '来源不可用 · 保留引用'
                : node.referenceStatus === 'changed'
                  ? '来源已变化 · 已采用定义'
                  : '已连接来源定义'}
            </div>
          )}
        </>
      )}
      {compact && (
        <span className="combined-compact-counts">
          {component.inputs.length} 入 · {component.outputs.length} 出
          {component.reference ? ' · 引用' : ''}
        </span>
      )}
    </article>
  )
})

const Frame = memo(function Frame({
  frame,
  overviewZoom,
  dimmed,
  onFocus,
  onOpenBoard,
}: {
  frame: CombinedBoard
  overviewZoom?: number
  dimmed: boolean
  onFocus: (bounds: CombinedBoard) => void
  onOpenBoard: (location: BoardLocation) => void
}) {
  const scale = overviewZoom ? 1 / overviewZoom : 1
  const screenWidth = overviewZoom ? frame.width * overviewZoom : frame.width
  const readable = !overviewZoom || screenWidth >= 30
  const showCounts = overviewZoom && frame.height * overviewZoom >= 65 && screenWidth >= 95
  return (
    <section
      className={`combined-board-frame${overviewZoom ? ' combined-board-overview' : ''}${dimmed ? ' dimmed' : ''}`}
      data-combined-board-id={frame.board.id}
      data-combined-frame-id={frame.id}
      data-version={frame.location.version}
      title={`${frame.board.path} · ${combinedVersionLabel(frame.location, frame.board)}${overviewZoom ? ' · 点击放大查看组件' : ''}`}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        borderWidth: overviewZoom ? scale : undefined,
        borderRadius: overviewZoom ? Math.min(frame.width / 4, 5 * scale) : undefined,
      }}
      role={overviewZoom ? 'button' : undefined}
      tabIndex={overviewZoom ? 0 : undefined}
      aria-label={overviewZoom ? `放大画板 ${frame.board.name}` : undefined}
      onClick={
        overviewZoom
          ? (event) => {
              if (event.detail === 0) onFocus(frame)
            }
          : undefined
      }
      onKeyDown={
        overviewZoom
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onFocus(frame)
              }
            }
          : undefined
      }
    >
      {readable && (
        <header
          style={
            overviewZoom
              ? {
                  height: Math.min(frame.height, 30 * scale),
                  padding: `0 ${6 * scale}px`,
                  gap: 5 * scale,
                }
              : undefined
          }
        >
          {!overviewZoom && <Layers size={18} />}
          <strong
            style={overviewZoom ? { fontSize: (screenWidth < 70 ? 9 : 11) * scale } : undefined}
          >
            {frame.board.name}
          </strong>
          {!overviewZoom && <span>{combinedVersionLabel(frame.location, frame.board)}</span>}
          {!overviewZoom && (
            <button
              title="打开此版本的原图"
              aria-label={`打开画板 ${frame.board.name}`}
              onClick={() => onOpenBoard(frame.location)}
            >
              <ArrowUpRight size={18} />
            </button>
          )}
        </header>
      )}
      {showCounts && (
        <p
          className="combined-overview-counts"
          style={{ fontSize: 10 * scale, padding: `${4 * scale}px ${6 * scale}px` }}
        >
          {frame.graph.components.length} 个组件 · {frame.graph.connections.length} 条连接
          <br />
          {combinedVersionLabel(frame.location, frame.board)}
        </p>
      )}
    </section>
  )
})

const Edge = memo(function Edge({
  edge,
  dimmed,
  full,
}: {
  edge: CombinedRenderEdge
  dimmed: boolean
  full: boolean
}) {
  const reference = edge.kind === 'reference'
  return (
    <g data-edge-kind={edge.kind} className={dimmed ? 'combined-edge dimmed' : 'combined-edge'}>
      <title>
        {reference ? '跨图引用对应' : `${connectionTypes[edge.connection!.type]} · ${edge.name}`}：
        {edge.source.component.name} → {edge.target.component.name}
      </title>
      <path
        d={edge.path}
        fill="none"
        stroke={
          reference
            ? 'var(--accent)'
            : (edgeColors[edge.connection!.type] ?? 'var(--relation-control)')
        }
        strokeWidth={reference ? 2 : 1.8}
        strokeDasharray={reference ? '8 6' : undefined}
        markerEnd={reference ? undefined : `url(#combined-arrow-${edge.connection!.type})`}
      />
      {full && !reference && (
        <text x={edge.label.x} y={edge.label.y} textAnchor="middle">
          {edge.name.slice(0, 20)}
        </text>
      )}
    </g>
  )
})

export function CombinedDiagramScene({
  viewport,
  level,
  zoom,
  selectedId,
  matched,
  traced,
  highlightedBoards,
  onSelect,
  onFocus,
  onOpenBoard,
}: {
  viewport: CombinedViewportSelection
  level: CombinedDetailLevel
  zoom: number
  selectedId: string
  matched: Set<string> | null
  traced: Set<string> | null
  highlightedBoards: Set<string> | null
  onSelect: (id: string) => void
  onFocus: (frame: CombinedBoard) => void
  onOpenBoard: (location: BoardLocation) => void
}) {
  const overview = level === 'overview'
  return (
    <>
      {viewport.visibleFrames.map((frame) => (
        <Frame
          key={frame.id}
          frame={frame}
          overviewZoom={overview ? zoom : undefined}
          dimmed={!!highlightedBoards && !highlightedBoards.has(frame.id)}
          onFocus={onFocus}
          onOpenBoard={onOpenBoard}
        />
      ))}
      <svg className="diagram-lines combined-lines" width="1" height="1" aria-label="组合视图连接">
        <defs>
          {Object.keys(connectionTypes).map((type) => (
            <marker
              key={type}
              id={`combined-arrow-${type}`}
              markerWidth="9"
              markerHeight="9"
              refX="8"
              refY="4"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 8 4 L 0 8 Z" fill={edgeColors[type] ?? 'var(--relation-control)'} />
            </marker>
          ))}
        </defs>
        {overview
          ? viewport.visibleBridges.map((bridge) => (
              <g
                key={bridge.id}
                data-edge-kind="reference"
                className={`combined-edge combined-board-bridge${highlightedBoards && (!highlightedBoards.has(bridge.sourceId) || !highlightedBoards.has(bridge.targetId)) ? ' dimmed' : ''}`}
              >
                <title>
                  {bridge.source.board.name} → {bridge.target.board.name} · {bridge.count} 处引用
                </title>
                <path
                  d={bridge.path}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.2 / zoom}
                  strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                />
              </g>
            ))
          : viewport.visibleEdges.map((edge) => (
              <Edge
                key={edge.id}
                edge={edge}
                full={level === 'full'}
                dimmed={
                  (!!traced && (!traced.has(edge.sourceId) || !traced.has(edge.targetId))) ||
                  (!!matched && !matched.has(edge.sourceId) && !matched.has(edge.targetId))
                }
              />
            ))}
      </svg>
      {!overview &&
        viewport.visibleNodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            compact={level === 'compact'}
            selected={selectedId === node.id}
            dimmed={(!!traced && !traced.has(node.id)) || (!!matched && !matched.has(node.id))}
            onSelect={onSelect}
            onOpenBoard={onOpenBoard}
          />
        ))}
    </>
  )
}
