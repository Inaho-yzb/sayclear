import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Layers,
  LoaderCircle,
  Maximize,
  Minus,
  Plus,
  Search,
  X,
} from 'lucide-react'
import {
  buildCombinedDiagram,
  traceCombinedDiagram,
  type CombinedNode,
} from '../../../shared/combined-diagram'
import { COMPONENT_WIDTH, componentHeight, type GraphSnapshot } from '../../../shared/diagram'
import {
  buildCombinedRenderIndex,
  selectCombinedViewport,
} from '../../../shared/combined-diagram-render'
import { type Board, type BoardLocation } from '../../../shared/diagram-references'
import { storage } from '../services/storage'
import {
  CombinedDiagramScene,
  combinedVersionLabel as versionLabel,
  type CombinedDetailLevel,
} from './CombinedDiagramScene'
import './combined-diagram.css'

type View = { x: number; y: number; zoom: number }
const clampZoom = (zoom: number) => Math.max(0.001, Math.min(2, zoom))

export function CombinedDiagram({
  boards,
  root,
  onClose,
  onOpenBoard,
}: {
  boards: Board[]
  root: BoardLocation
  onClose: () => void
  onOpenBoard: (destination: BoardLocation) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 30, y: 30, zoom: 0.1 })
  const viewTarget = useRef(view)
  const viewFrame = useRef<number | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 })
  const retainCanvasFocus = useCallback(() => {
    const canvas = canvasRef.current
    const focused = document.activeElement
    if (
      canvas &&
      focused instanceof HTMLElement &&
      canvas.contains(focused) &&
      focused.closest('.combined-node, .combined-board-frame')
    )
      canvas.focus({ preventScroll: true })
  }, [])
  const queueView = useCallback(
    (update: View | ((previous: View) => View)) => {
      retainCanvasFocus()
      viewTarget.current = typeof update === 'function' ? update(viewTarget.current) : update
      if (viewFrame.current !== null) return
      viewFrame.current = requestAnimationFrame(() => {
        viewFrame.current = null
        setView(viewTarget.current)
      })
    },
    [retainCanvasFocus],
  )
  const immediateView = useCallback(
    (next: View) => {
      retainCanvasFocus()
      if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current)
      viewFrame.current = null
      viewTarget.current = next
      setView(next)
    },
    [retainCanvasFocus],
  )
  useEffect(
    () => () => {
      if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current)
    },
    [],
  )
  const pan = useRef<{ x: number; y: number; view: View; moved: boolean; frameId?: string } | null>(
    null,
  )
  const [query, setQuery] = useState('')
  const [resultLimit, setResultLimit] = useState(100)
  const [maxBoards, setMaxBoards] = useState(40)
  const [selectedId, setSelectedId] = useState('')
  const [direction, setDirection] = useState<'all' | 'upstream' | 'downstream'>('all')
  const [history, setHistory] = useState<
    Record<string, { snapshot?: GraphSnapshot; error?: string }>
  >({})
  const historyKey = useCallback(
    (location: BoardLocation) =>
      JSON.stringify([
        location.boardId,
        location.historyId,
        boards
          .find((b) => b.id === location.boardId)
          ?.diagram.history.find((h) => h.id === location.historyId)?.snapshotDigest,
      ]),
    [boards],
  )
  const hydratedBoards = useMemo(
    () =>
      boards.map((board) => ({
        ...board,
        diagram: {
          ...board.diagram,
          history: board.diagram.history.map((version) => ({
            ...version,
            snapshot:
              version.snapshot ??
              history[historyKey({ boardId: board.id, version: 'history', historyId: version.id })]
                ?.snapshot,
          })),
        },
      })),
    [boards, history, historyKey],
  )
  const graph = useMemo(
    () => buildCombinedDiagram(hydratedBoards, root, { maxBoards }),
    [hydratedBoards, root, maxBoards],
  )
  const pending = graph.pendingHistory.filter((location) => !history[historyKey(location)]?.error)
  const pendingKey = JSON.stringify(pending)
  useEffect(() => {
    if (!pending.length) return
    let disposed = false
    void Promise.all(
      pending.map(async (location) => {
        const key = historyKey(location)
        try {
          return [
            key,
            { snapshot: await storage.loadHistory(location.boardId, location.historyId!) },
          ] as const
        } catch (error) {
          return [key, { error: error instanceof Error ? error.message : String(error) }] as const
        }
      }),
    ).then((results) => {
      if (!disposed) setHistory((previous) => ({ ...previous, ...Object.fromEntries(results) }))
    })
    return () => {
      disposed = true
    }
    // The serialized list changes only when another referenced history needs loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, historyKey])

  const renderIndex = useMemo(() => buildCombinedRenderIndex(graph), [graph])
  const nodes = renderIndex.nodeById
  const selected = nodes.get(selectedId)
  const selectedBoard = selected ? renderIndex.frameById.get(selected.boardId) : undefined
  const traced = useMemo(
    () =>
      selectedId && direction !== 'all' ? traceCombinedDiagram(graph, selectedId, direction) : null,
    [graph, selectedId, direction],
  )
  const search = query.trim().toLowerCase()
  const matched = useMemo(
    () =>
      search
        ? new Set(
            [...renderIndex.searchTextByNodeId]
              .filter(([, text]) => text.includes(search))
              .map(([id]) => id),
          )
        : null,
    [search, renderIndex],
  )
  const results = useMemo(
    () => (matched ? graph.nodes.filter((node) => matched.has(node.id)) : []),
    [graph.nodes, matched],
  )
  const highlightedBoards = useMemo(() => {
    if (!matched && !traced) return null
    return new Set(
      graph.nodes
        .filter((node) => (!matched || matched.has(node.id)) && (!traced || traced.has(node.id)))
        .map((node) => node.boardId),
    )
  }, [graph.nodes, matched, traced])
  const detailLevel: CombinedDetailLevel =
    view.zoom < 0.22 ? 'overview' : view.zoom < 0.55 ? 'compact' : 'full'
  const viewport = useMemo(
    () =>
      selectCombinedViewport(
        renderIndex,
        { ...view, ...canvasSize },
        {
          nodes: detailLevel !== 'overview',
          edges: detailLevel !== 'overview',
          bridges: detailLevel === 'overview',
          overscan: 120,
        },
      ),
    [renderIndex, view, canvasSize, detailLevel],
  )
  const fitBounds = useCallback(
    (bounds: { x: number; y: number; width: number; height: number }, minimumZoom = 0.001) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const zoom = Math.min(
        1,
        clampZoom(
          Math.max(
            minimumZoom,
            Math.min(
              (canvas.clientWidth - 80) / Math.max(bounds.width, 1),
              (canvas.clientHeight - 90) / Math.max(bounds.height, 1),
            ),
          ),
        ),
      )
      immediateView({
        x: (canvas.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
        y: (canvas.clientHeight - bounds.height * zoom) / 2 - bounds.y * zoom,
        zoom,
      })
    },
    [immediateView],
  )
  const fit = useCallback(
    () => fitBounds({ x: 0, y: 0, width: graph.width, height: graph.height }),
    [fitBounds, graph.width, graph.height],
  )
  const focusFrame = useCallback(
    (frame: { x: number; y: number; width: number; height: number }) => fitBounds(frame, 0.28),
    [fitBounds],
  )
  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  useEffect(() => {
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(dialogRef.current!)
    return () => observer.disconnect()
  }, [fit])
  useEffect(() => {
    const canvas = canvasRef.current!
    const measure = () =>
      setCanvasSize((previous) => {
        const width = canvas.clientWidth,
          height = canvas.clientHeight
        return previous.width === width && previous.height === height ? previous : { width, height }
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const canvas = canvasRef.current!
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1
      if (event.ctrlKey || event.metaKey) {
        const rect = canvas.getBoundingClientRect()
        const x = event.clientX - rect.left,
          y = event.clientY - rect.top
        queueView((previous) => {
          const zoom = clampZoom(previous.zoom * Math.exp(-event.deltaY * factor * 0.01))
          return {
            x: x - ((x - previous.x) * zoom) / previous.zoom,
            y: y - ((y - previous.y) * zoom) / previous.zoom,
            zoom,
          }
        })
      } else
        queueView((previous) => ({
          ...previous,
          x: previous.x - event.deltaX * factor,
          y: previous.y - event.deltaY * factor,
        }))
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [queueView])
  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current!
    queueView((previous) => {
      const zoom = clampZoom(previous.zoom * factor)
      const x = canvas.clientWidth / 2,
        y = canvas.clientHeight / 2
      return {
        x: x - ((x - previous.x) * zoom) / previous.zoom,
        y: y - ((y - previous.y) * zoom) / previous.zoom,
        zoom,
      }
    })
  }
  const focusNode = useCallback(
    (node: CombinedNode) => {
      setSelectedId(node.id)
      fitBounds({
        ...node.component.position,
        width: COMPONENT_WIDTH + 200,
        height: componentHeight(node.component) + 160,
        x: node.component.position.x - 100,
        y: node.component.position.y - 80,
      })
    },
    [fitBounds],
  )
  const rootBoard = boards.find((board) => board.id === root.boardId)
  const errors = graph.pendingHistory.flatMap((location) => {
    const error = history[historyKey(location)]?.error
    return error ? [{ location, error }] : []
  })

  return (
    <dialog
      ref={dialogRef}
      className="modal combined-diagram-dialog"
      aria-label="多图组合视图"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className="combined-heading">
        <span className="combined-heading-icon">
          <Layers size={21} />
        </span>
        <div>
          <h2>
            组合视图 <span>全链路</span>
          </h2>
          <p>
            {rootBoard?.name} · {graph.boards.length} 张图 · {graph.nodes.length} 个组件
          </p>
        </div>
        <span className="scope-badge">只读</span>
        <button className="icon-button" aria-label="关闭组合视图" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="combined-toolbar">
        <label className="combined-search">
          <Search size={15} />
          <input
            aria-label="搜索组合视图"
            placeholder="搜索组件或画板…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setResultLimit(100)
            }}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="清除组合视图搜索"
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </label>
        <div className="combined-trace" aria-label="跨图链路追踪">
          <button
            className="button text compact"
            aria-pressed={direction === 'all'}
            onClick={() => setDirection('all')}
          >
            全部链路
          </button>
          <button
            className="button text compact"
            aria-pressed={direction === 'upstream'}
            disabled={!selected}
            onClick={() => setDirection('upstream')}
          >
            <ArrowUpRight size={13} />
            上游
          </button>
          <button
            className="button text compact"
            aria-pressed={direction === 'downstream'}
            disabled={!selected}
            onClick={() => setDirection('downstream')}
          >
            <ArrowDownRight size={13} />
            下游
          </button>
        </div>
        <span className="combined-toolbar-hint">
          {detailLevel === 'overview'
            ? '全局总览 · 点击画板或搜索组件放大查看'
            : '选择组件追踪跨图链路'}
        </span>
      </div>
      <div className="combined-body">
        <aside className="combined-directory" aria-label="组合画板目录">
          <h3>{search ? `搜索结果 · ${results.length}` : `关联画板 · ${graph.boards.length}`}</h3>
          {search ? (
            <>
              <div className="combined-board-list">
                {results.length ? (
                  results.slice(0, resultLimit).map((node) => (
                    <button key={node.id} onClick={() => focusNode(node)}>
                      <strong>{node.component.name}</strong>
                      <small>{renderIndex.frameById.get(node.boardId)?.board.name}</small>
                    </button>
                  ))
                ) : (
                  <p className="combined-empty">没有匹配的组件或画板</p>
                )}
              </div>
              {results.length > resultLimit && (
                <div className="combined-search-more">
                  <p>已显示 {resultLimit} 项，继续输入可缩小范围</p>
                  <button
                    className="button secondary compact"
                    onClick={() => setResultLimit((count) => count + 100)}
                  >
                    显示更多搜索结果
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="combined-board-list">
              {graph.boards.map((frame) => (
                <button key={frame.id} onClick={() => focusFrame(frame)} title={frame.board.path}>
                  <strong>
                    {frame.board.name}
                    {frame.id === graph.rootKey && <span className="combined-origin">起点</span>}
                  </strong>
                  <small>{versionLabel(frame.location, frame.board)}</small>
                  <small>{frame.board.path}</small>
                </button>
              ))}
            </div>
          )}
          <div className="combined-legend">
            <span>
              <i />
              图内业务连接
            </span>
            <span>
              <i className="reference" />
              跨图引用对应
            </span>
            <p>虚线连接引用与原始定义，执行方向以图内业务连接为准。</p>
          </div>
          {!!pending.length && (
            <p className="combined-loading" role="status">
              <LoaderCircle size={13} className="spin" />
              正在读取 {pending.length} 份历史快照…
            </p>
          )}
          {!!graph.issues.length && (
            <div className="combined-issues" aria-label="组合视图提示">
              <h3>
                <AlertTriangle size={13} />
                引用提示
              </h3>
              {graph.issues
                .filter((issue) => issue.kind !== 'history')
                .map((issue) => (
                  <p key={issue.id}>{issue.message}</p>
                ))}
              {errors.map(({ location, error }) => (
                <p role="alert" key={historyKey(location)}>
                  {boards.find((b) => b.id === location.boardId)?.name}：{error}
                </p>
              ))}
              {!!errors.length && (
                <button
                  className="button secondary compact"
                  onClick={() =>
                    setHistory((previous) =>
                      Object.fromEntries(
                        Object.entries(previous).filter(([, result]) => !result.error),
                      ),
                    )
                  }
                >
                  重试读取历史
                </button>
              )}
              {graph.truncated && (
                <button
                  className="button secondary compact"
                  onClick={() => setMaxBoards((count) => count * 2)}
                >
                  继续展开关联画板
                </button>
              )}
            </div>
          )}
        </aside>
        <div
          ref={canvasRef}
          className="diagram-canvas combined-canvas"
          role="region"
          tabIndex={0}
          aria-label="组合视图画板"
          aria-busy={!!pending.length}
          data-detail-level={detailLevel}
          data-total-nodes={graph.nodes.length}
          data-rendered-nodes={viewport.visibleNodes.length}
          data-rendered-edges={
            detailLevel === 'overview'
              ? viewport.visibleBridges.length
              : viewport.visibleEdges.length
          }
          onKeyDown={(event) => {
            if ((event.target as HTMLElement).closest('button, input')) return
            if (event.key.toLowerCase() === 'f') {
              event.preventDefault()
              fit()
            }
            if (event.key === '+' || event.key === '=') zoomBy(1.2)
            if (event.key === '-') zoomBy(1 / 1.2)
          }}
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              (event.target as HTMLElement).closest('button, .diagram-node')
            )
              return
            pan.current = {
              x: event.clientX,
              y: event.clientY,
              view: viewTarget.current,
              moved: false,
              frameId:
                detailLevel === 'overview'
                  ? ((event.target as HTMLElement)
                      .closest('.combined-board-frame')
                      ?.getAttribute('data-combined-frame-id') ?? undefined)
                  : undefined,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = pan.current
            if (!start) return
            const x = event.clientX - start.x,
              y = event.clientY - start.y
            if (Math.hypot(x, y) > 3) start.moved = true
            queueView({ ...start.view, x: start.view.x + x, y: start.view.y + y })
          }}
          onPointerUp={(event) => {
            if (pan.current && !pan.current.moved) {
              const frame = pan.current.frameId && renderIndex.frameById.get(pan.current.frameId)
              if (frame) focusFrame(frame)
              else {
                setSelectedId('')
                setDirection('all')
              }
            }
            pan.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            pan.current = null
          }}
        >
          <div
            className="diagram-world"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          >
            <CombinedDiagramScene
              viewport={viewport}
              level={detailLevel}
              zoom={view.zoom}
              selectedId={selectedId}
              matched={matched}
              traced={traced}
              highlightedBoards={highlightedBoards}
              onSelect={setSelectedId}
              onFocus={focusFrame}
              onOpenBoard={onOpenBoard}
            />
          </div>
          {!graph.nodes.length && !pending.length && (
            <p className="combined-canvas-empty">当前版本暂无组件，可在原图添加组件与引用。</p>
          )}
          <div className="diagram-floating combined-zoom">
            <button
              className="icon-button"
              aria-label="缩小组合视图"
              onClick={() => zoomBy(1 / 1.2)}
            >
              <Minus size={16} />
            </button>
            <span>{Math.round(view.zoom * 100)}%</span>
            <button className="icon-button" aria-label="放大组合视图" onClick={() => zoomBy(1.2)}>
              <Plus size={16} />
            </button>
            <i />
            <button
              className="icon-button"
              aria-label="适应组合视图"
              title="适应视图 F"
              onClick={fit}
            >
              <Maximize size={16} />
            </button>
          </div>
        </div>
      </div>
      {selected && selectedBoard ? (
        <footer className="combined-selection">
          <div>
            <strong>{selected.component.name}</strong>
            <span>
              {selectedBoard.board.path} · {versionLabel(selected.location, selectedBoard.board)}
            </span>
            <p>{selected.component.description || selected.referenceMessage || '暂无说明'}</p>
          </div>
          <button
            className="button secondary compact"
            onClick={() => onOpenBoard(selected.location)}
          >
            打开原图
            <ArrowUpRight size={14} />
          </button>
        </footer>
      ) : (
        <footer className="combined-footer">
          自动展开引用与被引用画板 · 拖动空白平移 · ⌘/Ctrl + 滚轮缩放 · 双击组件打开原图
        </footer>
      )}
    </dialog>
  )
}
