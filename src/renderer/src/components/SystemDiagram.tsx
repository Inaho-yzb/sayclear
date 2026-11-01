import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Plus,
  Minus,
  Maximize,
  Undo2,
  Redo2,
  Workflow,
  Box,
  Search,
  X,
  ArrowUpRight,
  ArrowDownRight,
  Pencil,
  Copy,
  Trash2,
  Link2,
  Braces,
  LayoutGrid,
  MousePointer2,
  Hand,
  ChevronDown,
  Layers,
} from 'lucide-react'
import {
  componentTypes,
  connectionTypes,
  connectionDescriptions,
  type ComponentType,
  newConnection,
  newPort,
  emptyDiagram,
  exampleDiagram,
  replaceComponent,
  removeComponent,
  layoutDiagram,
  traceComponents,
  COMPONENT_WIDTH,
  componentHeight,
  type Diagram,
  type DiagramComponent,
  type DiagramConnection,
  type ConnectionType,
} from '../../../shared/diagram'
import {
  connectionAnchor as anchor,
  connectionCurve as curve,
} from '../../../shared/diagram-geometry'
import {
  defaultComponentCatalog,
  getScenario,
  scenarioId,
  parseCatalogDiagram,
  catalogDiagramError,
  instantiateTemplate,
  metadataValue,
  type ComponentCatalog,
  type ComponentTemplate,
} from '../../../shared/component-catalog'
import { ComponentEditor, ConnectionEditor, DiagramJsonEditor } from './DiagramEditors'
import { ValidationSummary, ValidationDetails } from './ValidationEditor'
import { useHistorySnapshot } from '../services/use-history-snapshot'
import { DiagramOverviewPopover } from './DiagramOverviewPopover'
import { componentIcons as icons } from './component-icons'
import {
  IterationControls,
  ChangeDetails,
  describeIterationValue,
  type DiagramMode,
} from './IterationControls'
import {
  iterationChanges,
  iterationView,
  affectedComponents,
  iterationExample,
  changeLabels,
} from '../../../shared/iteration'
import {
  incomingReferences,
  resolveReference,
  type Board,
  type BoardLocation,
} from '../../../shared/diagram-references'
import {
  ReferenceEditor,
  ReferenceDetails,
  ReferenceUsages,
  ReferenceUsageModal,
} from './DiagramReferences'
import './system-diagram.css'
import { AIAssistant, aiContextVersionKey, type AIContextRequest } from './AIAssistant'
import { DiagramContextMenu } from './DiagramContextMenu'
import { CombinedDiagram } from './CombinedDiagram'
import { createAIContextItem, type AIContextTarget } from '../../../shared/ai-context'
import { type GitRepository, type GitStartOptions } from '../../../shared/git'

const relationColors = {
  data: 'var(--relation-data)',
  control: 'var(--relation-control)',
  dependency: 'var(--relation-dependency)',
  event: 'var(--relation-event)',
  contains: '#8393aa',
  calls: '#637fbc',
  implements: '#7f8d68',
  reads: '#519990',
  writes: '#49857c',
  constrains: '#b38a4b',
  transitions: '#9680b5',
}
type Selection = { kind: 'component' | 'connection'; id: string } | null
type Point = { x: number; y: number }
type View = Point & { zoom: number }
type Gesture =
  | { kind: 'pan'; start: Point; view: View }
  | { kind: 'drag'; start: Point; component: DiagramComponent; position: Point }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
const MIN_ZOOM = 0.001
const perspectiveTypes: Record<string, ComponentType[]> = {
  capability: ['actor', 'capability'],
  flow: ['actor', 'ui', 'action', 'rule', 'validation', 'data', 'state', 'event'],
  implementation: ['action', 'api', 'service', 'data', 'store'],
}
export function SystemDiagram({
  value,
  boards,
  boardId,
  location,
  onOpenBoard,
  catalog = defaultComponentCatalog,
  onOpenSettings,
  onOpenAISettings,
  active,
  scopeName,
  scopeDescription,
  onChange,
  onNotify,
  externalChange,
  onExternalChangeConsumed,
  externalBusy = false,
  gitRepository,
  onStartIteration,
}: {
  value?: Diagram
  boards: Board[]
  boardId: string
  location?: BoardLocation
  onOpenBoard: (destination: BoardLocation, origin: BoardLocation) => void
  catalog?: ComponentCatalog
  onOpenSettings: () => void
  onOpenAISettings: () => void
  active: boolean
  scopeName: string
  scopeDescription?: string
  onChange: (graph: Diagram) => void
  onNotify: (message: string) => void
  externalChange?: { id: string; before: Diagram }
  onExternalChangeConsumed?: (id: string) => void
  externalBusy?: boolean
  gitRepository?: GitRepository
  onStartIteration?: (name: string, options?: GitStartOptions) => Promise<boolean>
}) {
  const model = useMemo(() => value ?? emptyDiagram(), [value])
  const [mode, setMode] = useState<DiagramMode>(
    location?.version === 'history' ? 'current' : (location?.version ?? 'iteration'),
  )
  const [historicalId, setHistoricalId] = useState(location?.historyId ?? '')
  const [showChanges, setShowChanges] = useState(false)
  const [perspective, setPerspective] = useState('all')
  const historical = model.history.find((h) => h.id === historicalId)
  const historyData = useHistorySnapshot(boardId, historical)
  const readOnly = !!historical || (!!model.iteration && mode !== 'iteration')
  const aiVersionId = historical?.id ?? (readOnly ? model.iteration?.id : undefined)
  const graph: Diagram = useMemo(
    () =>
      historical
        ? {
            ...(historyData.snapshot ?? { ...emptyDiagram(), scenarioId: model.scenarioId }),
            history: model.history,
          }
        : model.iteration && mode === 'current'
          ? { ...model.iteration.baseline, history: model.history }
          : model,
    [historical, historyData.snapshot, model, mode],
  )
  // Panning, zooming and pointer previews do not change the graph's business state.
  const diff = useMemo(() => iterationChanges(model), [model])
  const componentChanges = useMemo(
    () => new Map(diff.filter((c) => c.kind === 'component').map((c) => [c.id, c])),
    [diff],
  )
  const connectionChanges = useMemo(
    () => new Map(diff.filter((c) => c.kind === 'connection').map((c) => [c.id, c])),
    [diff],
  )
  const affected = useMemo(() => affectedComponents(model, diff), [model, diff])
  const showDiff = !!model.iteration && mode === 'iteration' && !historical
  const viewGraph = useMemo(() => (showDiff ? iterationView(graph) : graph), [showDiff, graph])
  const referenceResolutions = useMemo(
    () =>
      new Map(
        viewGraph.components
          .filter((c) => c.reference)
          .map((c) => [c.id, resolveReference(boards, c)]),
      ),
    [viewGraph.components, boards],
  )
  const editableComponents = useMemo(
    () => new Set(graph.components.map((c) => c.id)),
    [graph.components],
  )
  const editableConnections = useMemo(
    () => new Set(graph.connections.map((e) => e.id)),
    [graph.connections],
  )
  const canEditComponent = (id: string) => !readOnly && editableComponents.has(id)
  const canEditConnection = (id: string) => !readOnly && editableConnections.has(id)
  const scene = useMemo(() => getScenario(catalog, graph)!, [catalog, graph])
  const library = scene.components
  const sceneTemplates = useMemo(
    () => new Map(library.map((template) => [template.id, template])),
    [library],
  )
  const allTemplates = useMemo(
    () =>
      new Map(
        catalog.scenarios
          .flatMap((scenario) => scenario.components)
          .map((template) => [template.id, template]),
      ),
    [catalog],
  )
  const templateFor = (component: DiagramComponent) =>
    (component.reference ? allTemplates : sceneTemplates).get(component.templateId)
  const incomingCount = useMemo(() => incomingReferences(boards, boardId).length, [boards, boardId])
  const [selection, setSelection] = useState<Selection>(
    location?.componentId ? { kind: 'component', id: location.componentId } : null,
  )
  const [objectMenu, setObjectMenu] = useState<{
    x: number
    y: number
    target: AIContextTarget
    element: HTMLElement | SVGElement
  } | null>(null)
  const [aiContextRequest, setAIContextRequest] = useState<AIContextRequest | null>(null)
  const closeObjectMenu = useCallback(() => setObjectMenu(null), [])
  const consumeAIContext = useCallback((id: string) => {
    setAIContextRequest((current) => (current?.id === id ? null : current))
  }, [])
  const openObjectMenu = (
    target: AIContextTarget,
    element: HTMLElement | SVGElement,
    point?: Point,
  ) => {
    const bounds = element.getBoundingClientRect()
    setObjectMenu({
      target,
      element,
      x: point?.x ?? bounds.left + Math.min(bounds.width / 2, 100),
      y: point?.y ?? bounds.top + Math.min(bounds.height / 2, 40),
    })
    setPendingLink(null)
  }
  const [referenceDraft, setReferenceDraft] = useState<DiagramComponent | 'new' | null>(null)
  const [showReferences, setShowReferences] = useState(false)
  const [showCombined, setShowCombined] = useState(false)
  const currentLocation: BoardLocation = useMemo(
    () => ({
      boardId,
      componentId: selection?.kind === 'component' ? selection.id : undefined,
      version: historical
        ? 'history'
        : model.iteration && mode !== 'current'
          ? 'iteration'
          : 'current',
      historyId: historical?.id,
      iterationId:
        !historical && model.iteration && mode !== 'current' ? model.iteration.id : undefined,
    }),
    [boardId, selection, historical, model.iteration, mode],
  )
  const combinedBoards = useMemo(
    () =>
      boards.some((board) => board.id === boardId)
        ? boards
        : [...boards, { id: boardId, name: scopeName, path: scopeName, diagram: model }],
    [boards, boardId, scopeName, model],
  )
  const openBoard = (destination: BoardLocation) => onOpenBoard(destination, currentLocation)
  const [view, setView] = useState<View>({ x: 30, y: 30, zoom: 0.8 })
  const [dragPosition, setDragPosition] = useState<{ id: string; position: Point } | null>(null)
  const [pendingLink, setPendingLink] = useState<{ componentId: string; portId: string } | null>(
    null,
  )
  const [pointer, setPointer] = useState<Point>({ x: 0, y: 0 })
  const [componentDraft, setComponentDraft] = useState<DiagramComponent | null>(null)
  const [connectionDraft, setConnectionDraft] = useState<DiagramConnection | null>(null)
  const [showJson, setShowJson] = useState(false),
    [showLibrary, setShowLibrary] = useState(false)
  const [query, setQuery] = useState(''),
    [relation, setRelation] = useState<ConnectionType | 'all'>('all')
  const [trace, setTrace] = useState<'all' | 'upstream' | 'downstream'>('all')
  const [hand, setHand] = useState(false),
    [historyVersion, setHistoryVersion] = useState(0)
  const canvasRef = useRef<HTMLDivElement>(null),
    gesture = useRef<Gesture | null>(null)
  const past = useRef<Diagram[]>([]),
    future = useRef<Diagram[]>([])
  const recordedExternalChange = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!externalChange || recordedExternalChange.current === externalChange.id) return
    recordedExternalChange.current = externalChange.id
    past.current = [...past.current.slice(-39), externalChange.before]
    future.current = []
    setHistoryVersion((version) => version + 1)
    setPendingLink(null)
    setComponentDraft(null)
    setConnectionDraft(null)
    setDragPosition(null)
    gesture.current = null
    onExternalChangeConsumed?.(externalChange.id)
  }, [externalChange, onExternalChangeConsumed])
  const fitted = useRef(false)
  const currentRef = useRef({ graph: viewGraph, view })
  currentRef.current = { graph: viewGraph, view }

  const applyModel = (next: Diagram) => {
    if (externalBusy) return false
    let parsed: Diagram
    try {
      parsed = parseCatalogDiagram(next, catalog)
    } catch (e) {
      onNotify(e instanceof Error ? e.message : '画板配置无效')
      return false
    }
    past.current = [...past.current.slice(-39), model]
    future.current = []
    setHistoryVersion((v) => v + 1)
    onChange(parsed)
    return true
  }
  const commit = (next: Diagram) => {
    if (readOnly || externalBusy) return false
    return applyModel({ ...next, iteration: model.iteration, history: model.history })
  }
  const switchMode = (next: DiagramMode) => {
    closeObjectMenu()
    setAIContextRequest(null)
    setMode(next)
    setShowLibrary(false)
    setHistoricalId('')
    setSelection(null)
    setShowChanges(false)
    setPendingLink(null)
    setComponentDraft(null)
    setReferenceDraft(null)
    setConnectionDraft(null)
    setDragPosition(null)
    gesture.current = null
  }
  const undo = () => {
    if (readOnly || externalBusy) return
    const previous = past.current.at(-1)
    if (!previous) return
    const error = catalogDiagramError(previous, catalog)
    if (error) {
      onNotify(`无法撤销：${error}`)
      return
    }
    past.current.pop()
    future.current.push(model)
    onChange(previous)
    setHistoryVersion((v) => v + 1)
    setPendingLink(null)
  }
  const redo = () => {
    if (readOnly || externalBusy) return
    const next = future.current.at(-1)
    if (!next) return
    const error = catalogDiagramError(next, catalog)
    if (error) {
      onNotify(`无法重做：${error}`)
      return
    }
    future.current.pop()
    past.current.push(model)
    onChange(next)
    setHistoryVersion((v) => v + 1)
    setPendingLink(null)
  }
  const select = (next: Selection) => {
    setSelection(next)
    if (next) setShowChanges(false)
    setTrace('all')
  }
  const selectedComponent = useMemo(
    () =>
      viewGraph.components.find((c) => selection?.kind === 'component' && c.id === selection.id),
    [viewGraph.components, selection],
  )
  const selectedConnection = useMemo(
    () =>
      viewGraph.connections.find((c) => selection?.kind === 'connection' && c.id === selection.id),
    [viewGraph.connections, selection],
  )
  const displayed = useMemo(
    () =>
      dragPosition
        ? viewGraph.components.map((c) =>
            dragPosition.id === c.id ? { ...c, position: dragPosition.position } : c,
          )
        : viewGraph.components,
    [viewGraph.components, dragPosition],
  )
  const componentMap = useMemo(() => new Map(displayed.map((c) => [c.id, c])), [displayed])
  const filteredGraph = useMemo(
    () =>
      relation === 'all'
        ? viewGraph
        : { ...viewGraph, connections: viewGraph.connections.filter((e) => e.type === relation) },
    [relation, viewGraph],
  )
  const traced = useMemo(
    () =>
      selectedComponent && trace !== 'all'
        ? traceComponents(filteredGraph, selectedComponent.id, trace)
        : null,
    [selectedComponent, trace, filteredGraph],
  )
  const searchText = useMemo(
    () =>
      new Map(
        viewGraph.components.map((c) => [
          c.id,
          `${c.name} ${c.description} ${c.id} ${componentTypes[c.type]} ${(c.reference ? allTemplates : sceneTemplates).get(c.templateId)?.name ?? ''}`.toLowerCase(),
        ]),
      ),
    [viewGraph.components, allTemplates, sceneTemplates],
  )
  const search = query.trim().toLowerCase()
  const matchingIds = useMemo(
    () =>
      new Set(
        viewGraph.components
          .filter(
            (c) =>
              (perspective === 'all' || perspectiveTypes[perspective].includes(c.type)) &&
              (!traced || traced.has(c.id)) &&
              (!search || searchText.get(c.id)!.includes(search)),
          )
          .map((c) => c.id),
      ),
    [viewGraph.components, perspective, traced, search, searchText],
  )
  const matches = (component: DiagramComponent) => matchingIds.has(component.id)
  const searchResults = useMemo(
    () => graph.components.filter((component) => matchingIds.has(component.id)),
    [graph.components, matchingIds],
  )
  const describeChangeValue = (value: unknown) => describeIterationValue(value, model)
  const changeFieldLabel = (id: string, field: string) => {
    if (!field.startsWith('属性 / ')) return field
    const c =
      model.components.find((c) => c.id === id) ??
      model.iteration?.baseline.components.find((c) => c.id === id)
    return c ? (templateFor(c)?.fields.find((f) => f.id === field.slice(5))?.name ?? field) : field
  }
  const referenceIssues = useMemo(
    () =>
      new Set(
        [...referenceResolutions]
          .filter(([, resolution]) => resolution.status !== 'ok')
          .map(([id]) => id),
      ),
    [referenceResolutions],
  )
  const visibleEdges = useMemo(
    () =>
      filteredGraph.connections.filter(
        (e) => !traced || (traced.has(e.sourceId) && traced.has(e.targetId)),
      ),
    [filteredGraph.connections, traced],
  )
  const renderedEdges = useMemo(
    () =>
      visibleEdges.flatMap((edge) => {
        const a = componentMap.get(edge.sourceId),
          b = componentMap.get(edge.targetId)
        if (!a || !b) return []
        const from = anchor(a, edge.sourcePortId, true, b),
          to = anchor(b, edge.targetPortId, false, a)
        return [{ edge, a, b, from, to, d: curve(from, to) }]
      }),
    [visibleEdges, componentMap],
  )

  const fit = useCallback((data: Diagram = currentRef.current.graph) => {
    const canvas = canvasRef.current
    if (!canvas || !data.components.length) {
      setView({ x: 30, y: 30, zoom: 0.8 })
      return
    }
    const minX = Math.min(...data.components.map((c) => c.position.x)),
      minY = Math.min(...data.components.map((c) => c.position.y))
    const width = Math.max(...data.components.map((c) => c.position.x + COMPONENT_WIDTH)) - minX
    const height = Math.max(...data.components.map((c) => c.position.y + componentHeight(c))) - minY
    const zoom = clamp(
      Math.min((canvas.clientWidth - 100) / width, (canvas.clientHeight - 130) / height),
      MIN_ZOOM,
      1.1,
    )
    setView({
      x: (canvas.clientWidth - width * zoom) / 2 - minX * zoom,
      y: (canvas.clientHeight - height * zoom) / 2 - minY * zoom,
      zoom,
    })
  }, [])
  useEffect(() => {
    if (active && !fitted.current) {
      fit()
      fitted.current = true
    }
  }, [active, fit])
  useEffect(() => {
    if (active && historyData.snapshot) fit()
  }, [active, historyData.snapshot, fit])
  // Non-passive wheel keeps trackpad gestures within the board in both WKWebView and Chromium.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1
      if (event.ctrlKey || event.metaKey) {
        const rect = canvas.getBoundingClientRect(),
          x = event.clientX - rect.left,
          y = event.clientY - rect.top
        setView((v) => {
          const zoom = clamp(v.zoom * Math.exp(-event.deltaY * scale * 0.01), MIN_ZOOM, 2)
          return { x: x - ((x - v.x) * zoom) / v.zoom, y: y - ((y - v.y) * zoom) / v.zoom, zoom }
        })
      } else
        setView((v) => ({ ...v, x: v.x - event.deltaX * scale, y: v.y - event.deltaY * scale }))
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [])
  const zoomBy = (factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    setView((v) => {
      const zoom = clamp(v.zoom * factor, MIN_ZOOM, 2),
        x = rect.width / 2,
        y = rect.height / 2
      return { x: x - ((x - v.x) * zoom) / v.zoom, y: y - ((y - v.y) * zoom) / v.zoom, zoom }
    })
  }
  const toCanvas = (x: number, y: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: (x - rect.left - view.x) / view.zoom, y: (y - rect.top - view.y) / view.zoom }
  }
  const focusComponent = (c: DiagramComponent) => {
    select({ kind: 'component', id: c.id })
    const canvas = canvasRef.current!
    setView((v) => ({
      ...v,
      x: canvas.clientWidth / 2 - (c.position.x + COMPONENT_WIDTH / 2) * v.zoom,
      y: canvas.clientHeight / 2 - (c.position.y + componentHeight(c) / 2) * v.zoom,
    }))
  }
  const startPan = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    canvasRef.current?.focus()
    gesture.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, view }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!hand) select(null)
  }
  const startDrag = (e: ReactPointerEvent, c: DiagramComponent) => {
    if (e.button !== 0 && e.button !== 1) return
    if (!canEditComponent(c.id)) {
      e.stopPropagation()
      select({ kind: 'component', id: c.id })
      return
    }
    if (hand || e.button === 1) {
      startPan(e)
      return
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.stopPropagation()
    e.preventDefault()
    canvasRef.current?.focus()
    select({ kind: 'component', id: c.id })
    gesture.current = {
      kind: 'drag',
      start: { x: e.clientX, y: e.clientY },
      component: c,
      position: c.position,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent) => {
    if (pendingLink) setPointer(toCanvas(e.clientX, e.clientY))
    const active = gesture.current
    if (!active) return
    const dx = e.clientX - active.start.x,
      dy = e.clientY - active.start.y
    if (active.kind === 'pan')
      setView({ ...active.view, x: active.view.x + dx, y: active.view.y + dy })
    else {
      active.position = {
        x: clamp(
          Math.round((active.component.position.x + dx / view.zoom) / 10) * 10,
          -100000,
          100000,
        ),
        y: clamp(
          Math.round((active.component.position.y + dy / view.zoom) / 10) * 10,
          -100000,
          100000,
        ),
      }
      setDragPosition({ id: active.component.id, position: active.position })
    }
  }
  const finish = () => {
    const active = gesture.current
    if (
      active?.kind === 'drag' &&
      (active.position.x !== active.component.position.x ||
        active.position.y !== active.component.position.y)
    ) {
      commit({
        ...graph,
        components: graph.components.map((c) =>
          c.id === active.component.id ? { ...c, position: active.position } : c,
        ),
      })
    }
    gesture.current = null
    setDragPosition(null)
  }
  const add = (template: ComponentTemplate) => {
    if (readOnly) return
    const canvas = canvasRef.current!
    setComponentDraft(
      instantiateTemplate(template, {
        x: clamp(
          Math.round((canvas.clientWidth / 2 - view.x) / view.zoom - COMPONENT_WIDTH / 2),
          -100000,
          100000,
        ),
        y: clamp(Math.round((canvas.clientHeight / 2 - view.y) / view.zoom - 90), -100000, 100000),
      }),
    )
    setShowLibrary(false)
  }
  const connect = (target: DiagramComponent, portId: string) => {
    if (!canEditComponent(target.id)) return
    if (!pendingLink) {
      onNotify('先点击起点组件右侧的输出端口，再点击输入端口')
      return
    }
    const source = graph.components.find((c) => c.id === pendingLink.componentId)
    if (!source) {
      setPendingLink(null)
      return
    }
    const edge = {
      ...newConnection(source, target),
      sourcePortId: pendingLink.portId,
      targetPortId: portId,
    }
    if (commit({ ...graph, connections: [...graph.connections, edge] })) {
      setPendingLink(null)
      select({ kind: 'connection', id: edge.id })
    }
  }
  const removeSelected = () => {
    if (readOnly) return
    if (selectedComponent && canEditComponent(selectedComponent.id)) {
      commit(removeComponent(graph, selectedComponent.id))
      const usages = incomingReferences(boards, boardId, selectedComponent.id)
      onNotify(
        usages.length
          ? `组件已移除，可撤销。请检查引用画板：${[...new Set(usages.map((u) => u.board.name))].join('、')}`
          : '组件及关联连接已移除，可撤销',
      )
    } else if (selectedConnection && canEditConnection(selectedConnection.id))
      commit({
        ...graph,
        connections: graph.connections.filter((e) => e.id !== selectedConnection.id),
      })
    select(null)
    setPendingLink(null)
  }
  const duplicate = () => {
    if (!selectedComponent || !canEditComponent(selectedComponent.id)) return
    const copy: DiagramComponent = {
      ...selectedComponent,
      id: crypto.randomUUID(),
      name: selectedComponent.reference
        ? selectedComponent.name
        : `${selectedComponent.name.slice(0, 75)} 副本`,
      inputs: selectedComponent.reference
        ? selectedComponent.inputs
        : selectedComponent.inputs.map((p) => ({ ...p, id: newPort('').id })),
      outputs: selectedComponent.reference
        ? selectedComponent.outputs
        : selectedComponent.outputs.map((p) => ({ ...p, id: newPort('').id })),
      position: {
        x: clamp(selectedComponent.position.x + 40, -100000, 100000),
        y: clamp(selectedComponent.position.y + 50, -100000, 100000),
      },
    }
    if (commit({ ...graph, components: [...graph.components, copy] }))
      select({ kind: 'component', id: copy.id })
  }
  const editSelected = () => {
    if (selectedComponent && canEditComponent(selectedComponent.id))
      if (selectedComponent.reference) setReferenceDraft(selectedComponent)
      else setComponentDraft(selectedComponent)
    if (selectedConnection && canEditConnection(selectedConnection.id))
      setConnectionDraft(selectedConnection)
  }

  return (
    <section
      className="system-diagram"
      aria-label={`${scopeName} 系统图`}
      data-history={historyVersion}
    >
      <AIAssistant
        key={`${historicalId}-${readOnly}`}
        boardId={boardId}
        versionId={aiVersionId}
        scopeName={scopeName}
        scopeDescription={scopeDescription}
        graph={graph}
        contextGraph={viewGraph}
        contextRequest={aiContextRequest}
        onContextConsumed={consumeAIContext}
        catalog={catalog}
        readOnly={readOnly || (!!historical && !historyData.snapshot)}
        active={active && !showCombined}
        onOpenSettings={onOpenAISettings}
        onApply={(next) => {
          if (!commit(next)) return false
          setPendingLink(null)
          select(null)
          fit(next)
          onNotify('AI 修改已应用，可撤销恢复')
          return true
        }}
      />
      {objectMenu && active && (
        <DiagramContextMenu
          x={objectMenu.x}
          y={objectMenu.y}
          onClose={closeObjectMenu}
          returnFocus={() => objectMenu.element.focus({ preventScroll: true })}
          onAddToAI={() => {
            const item = createAIContextItem(viewGraph, objectMenu.target)
            closeObjectMenu()
            if (!item) return
            setAIContextRequest({
              id: crypto.randomUUID(),
              boardId,
              versionKey: aiContextVersionKey(boardId, aiVersionId, graph, readOnly),
              item,
            })
          }}
        />
      )}
      <div className="diagram-toolbar">
        <label className="diagram-scenario-select" title="画板场景">
          <Workflow size={18} />
          <select
            aria-label="画板场景"
            value={scenarioId(graph)}
            disabled={readOnly || !!model.iteration || model.history.length > 0}
            onChange={(e) => {
              if (commit({ ...graph, scenarioId: e.target.value })) {
                setShowLibrary(false)
                setPendingLink(null)
              }
            }}
          >
            {catalog.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div className="diagram-toolbar-actions">
          <button
            className="button text compact"
            title="展开相互引用的画板，查看完整链路"
            onClick={() => setShowCombined(true)}
          >
            <Layers size={14} />
            组合视图
          </button>
          <DiagramOverviewPopover>
            <aside className="diagram-overview" aria-label="画板概览说明">
              <div className="diagram-inspector-heading">
                <span>画板概览</span>
              </div>
              <div className="diagram-inspector-scroll">
                <h2>{scopeName}</h2>
                <p className="diagram-detail-description">
                  {scopeDescription || '在画板结构中补充职责与业务范围，通过公开入口连接其他画板。'}
                </p>
                <p className="diagram-overview-counts">
                  <span>
                    <strong>{graph.components.length}</strong> 个组件
                  </span>
                  <span>
                    <strong>{graph.connections.length}</strong> 条连接
                  </span>
                </p>
                <div className="diagram-detail-section">
                  <h3>画板场景 · {scene.name}</h3>
                  <p>
                    {library.length
                      ? `可使用本场景的 ${library.length} 种组件`
                      : '此场景还没有组件，请先添加组件模板'}
                  </p>
                  <div className="diagram-overview-actions">
                    <button className="button text compact" onClick={() => setShowReferences(true)}>
                      <Link2 size={13} /> 被引用 {incomingCount}
                    </button>
                    <button className="button text compact" onClick={onOpenSettings}>
                      组件设置 <ArrowUpRight size={13} />
                    </button>
                  </div>
                </div>
                <div className="diagram-detail-section">
                  <h3>关系图例</h3>
                  {Object.entries(connectionTypes).map(([key, label]) => (
                    <div className="diagram-legend" key={key}>
                      <span
                        style={{
                          borderColor: relationColors[key as ConnectionType],
                          borderTopStyle:
                            key === 'dependency' ? 'dashed' : key === 'event' ? 'dotted' : 'solid',
                        }}
                      />
                      <strong>{label}</strong>
                      <small>{connectionDescriptions[key as ConnectionType]}</small>
                    </div>
                  ))}
                </div>
                <div className="diagram-detail-section">
                  <h3>操作说明</h3>
                  <p>拖动输出端口连接输入端口。点击组件或连线，在右侧查看详情；双击可直接编辑。</p>
                  <p>修改自动保存，支持撤销。拖动空白平移，⌘/Ctrl + 滚轮缩放。</p>
                </div>
                {graph.components.length > 0 && (
                  <details className="diagram-overview-directory">
                    <summary>组件目录 · {graph.components.length}</summary>
                    {graph.components.map((c) => {
                      const Icon = icons[c.type]
                      return (
                        <button
                          className="diagram-directory-item"
                          key={c.id}
                          onClick={() => focusComponent(c)}
                        >
                          <Icon size={14} />
                          <span>{c.name}</span>
                          <ArrowUpRight size={12} />
                        </button>
                      )
                    })}
                  </details>
                )}
              </div>
            </aside>
          </DiagramOverviewPopover>
          <span className="diagram-divider" />
          <button
            className="icon-button"
            aria-label="撤销画板操作"
            title="撤销 ⌘/Ctrl Z"
            disabled={readOnly || !past.current.length}
            onClick={undo}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="重做画板操作"
            title="重做 ⌘/Ctrl Shift Z"
            disabled={readOnly || !future.current.length}
            onClick={redo}
          >
            <Redo2 size={16} />
          </button>
          <span className="diagram-divider" />
          <button
            className="button text compact diagram-tool-secondary"
            aria-label="自动布局"
            title="自动布局"
            disabled={readOnly || !graph.components.length}
            onClick={() => {
              const next = layoutDiagram(graph)
              if (next === graph || commit(next)) fit(showDiff ? iterationView(next) : next)
            }}
          >
            <LayoutGrid size={14} />
            <span>自动布局</span>
          </button>
          <button
            className="button text compact diagram-tool-secondary"
            aria-label="JSON"
            disabled={!!historical && !historyData.snapshot}
            title="导入 / 导出 JSON"
            onClick={() => setShowJson(true)}
          >
            <Braces size={14} />
            <span>JSON</span>
          </button>
          <button
            className="button secondary compact"
            disabled={readOnly || graph.components.length < 2}
            onClick={() => {
              const source = selectedComponent ?? graph.components[0],
                target = graph.components.find((c) => c.id !== source.id)!
              setConnectionDraft(newConnection(source, target))
            }}
          >
            <Link2 size={14} />
            添加连接
          </button>
          <button
            className="button secondary compact"
            disabled={readOnly || graph.components.length >= 300}
            onClick={() => setReferenceDraft('new')}
          >
            <ArrowUpRight size={14} />
            引用画板
          </button>
          <div className="diagram-library-anchor">
            <button
              className="button primary compact"
              aria-expanded={showLibrary}
              disabled={readOnly}
              onClick={() => setShowLibrary((v) => !v)}
            >
              <Plus size={14} />
              添加组件
              <ChevronDown size={12} />
            </button>
            {showLibrary && (
              <>
                <button
                  className="diagram-menu-dismiss"
                  aria-label="关闭组件菜单"
                  onClick={() => setShowLibrary(false)}
                />
                <div className="diagram-library">
                  <small>{scene.name} · 可用组件</small>
                  {library.map((template) => {
                    const Icon = icons[template.type]
                    return (
                      <button
                        key={template.id}
                        aria-label={`添加组件 ${template.name}`}
                        onClick={() => add(template)}
                      >
                        <Icon size={17} />
                        <span>
                          {template.name}
                          <small>{template.description}</small>
                        </span>
                        <Plus size={13} />
                      </button>
                    )
                  })}
                  {!library.length && (
                    <button onClick={onOpenSettings}>
                      前往组件设置 <ArrowUpRight size={14} />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <IterationControls
        model={model}
        gitRepository={gitRepository}
        onStart={
          onStartIteration
            ? async (name, options) => {
                const started = await onStartIteration(name, options)
                if (started) {
                  past.current = []
                  future.current = []
                  setHistoryVersion((version) => version + 1)
                }
                return started
              }
            : undefined
        }
        mode={mode}
        historicalId={historicalId}
        changes={diff}
        showChanges={showChanges}
        onMode={switchMode}
        onVersion={(id) => {
          switchMode('current')
          setHistoricalId(id)
        }}
        onToggleChanges={() => {
          setShowChanges((v) => !v)
          setSelection(null)
        }}
        onApply={applyModel}
      />
      {showCombined && (
        <CombinedDiagram
          boards={combinedBoards}
          root={currentLocation}
          onClose={() => setShowCombined(false)}
          onOpenBoard={(destination) => {
            setShowCombined(false)
            openBoard(destination)
          }}
        />
      )}
      <div className="diagram-body">
        {historical && (historyData.loading || historyData.error) && (
          <div className="history-load-state" role={historyData.error ? 'alert' : 'status'}>
            <p>{historyData.error ?? '正在读取历史画板…'}</p>
            {historyData.error && (
              <button className="button secondary" onClick={historyData.retry}>
                重试读取
              </button>
            )}
          </div>
        )}
        <div
          className={`diagram-canvas ${hand ? 'hand-mode' : ''} ${pendingLink ? 'link-mode' : ''}`}
          ref={canvasRef}
          tabIndex={0}
          aria-label="系统图画板"
          aria-busy={historyData.loading}
          inert={!!historical && !historyData.snapshot}
          role="region"
          style={{
            backgroundSize: `${Math.max(8, 20 * view.zoom)}px ${Math.max(8, 20 * view.zoom)}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={(e) => {
            if (
              (e.target as HTMLElement).closest(
                'button, input, select, .diagram-node, .diagram-edge, .diagram-floating',
              )
            )
              return
            startPan(e)
          }}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={() => {
            gesture.current = null
            setDragPosition(null)
          }}
          onKeyDown={(e) => {
            if ((e.target as HTMLElement).closest('input, textarea, select, button')) return
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
              e.preventDefault()
              if (e.shiftKey) redo()
              else undo()
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault()
              removeSelected()
            } else if (e.key === 'Escape') {
              setPendingLink(null)
              select(null)
              setShowLibrary(false)
            } else if (e.key.toLowerCase() === 'f') fit()
          }}
        >
          <div className="diagram-canvas-top diagram-floating">
            <div className="diagram-search">
              <Search size={14} />
              <input
                aria-label="搜索画板组件"
                placeholder="搜索组件…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button aria-label="清除组件搜索" onClick={() => setQuery('')}>
                  <X size={13} />
                </button>
              )}
            </div>
            <select
              aria-label="查看视角"
              value={perspective}
              onChange={(e) => setPerspective(e.target.value)}
            >
              <option value="all">全部对象</option>
              <option value="capability">看能力</option>
              <option value="flow">看流程</option>
              <option value="implementation">看实现</option>
            </select>
            <select
              aria-label="筛选连接类型"
              value={relation}
              onChange={(e) => setRelation(e.target.value as ConnectionType | 'all')}
            >
              <option value="all">全部关系</option>
              {Object.entries(connectionTypes).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
            {query && (
              <div className="diagram-search-results">
                {searchResults.length ? (
                  searchResults.map((c) => (
                    <button key={c.id} onClick={() => focusComponent(c)}>
                      {c.name}
                      <ArrowUpRight size={13} />
                    </button>
                  ))
                ) : (
                  <p>没有匹配的组件</p>
                )}
              </div>
            )}
          </div>
          <div
            className="diagram-world"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          >
            <svg className="diagram-lines" width="1" height="1" aria-label="组件连接">
              <defs>
                {Object.entries({
                  ...relationColors,
                  added: '#2b9274',
                  modified: '#bb862b',
                  removed: '#bd6262',
                }).map(([key, color]) => (
                  <marker
                    id={`diagram-arrow-${key}`}
                    key={key}
                    markerWidth="9"
                    markerHeight="9"
                    refX="8"
                    refY="4"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 Z" fill={color} />
                  </marker>
                ))}
              </defs>
              {renderedEdges.map(({ edge, a, b, from, to, d }) => {
                const selected = selectedConnection?.id === edge.id
                return (
                  <g
                    key={edge.id}
                    data-connection-id={edge.id}
                    className={`diagram-edge ${selected ? 'selected' : ''} ${showDiff ? `change-${connectionChanges.get(edge.id)?.status}` : ''}`}
                    data-change={showDiff ? connectionChanges.get(edge.id)?.status : undefined}
                    style={{ opacity: matches(a) && matches(b) ? 1 : 0.15 }}
                    role="button"
                    tabIndex={0}
                    data-reference-warning={
                      (!historical && (referenceIssues.has(a.id) || referenceIssues.has(b.id))) ||
                      undefined
                    }
                    aria-label={`连接 ${a.name} → ${b.name}：${edge.name}`}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      openObjectMenu({ kind: 'connection', id: edge.id }, e.currentTarget, {
                        x: e.clientX,
                        y: e.clientY,
                      })
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      select({ kind: 'connection', id: edge.id })
                    }}
                    onDoubleClick={() => {
                      if (canEditConnection(edge.id)) setConnectionDraft(edge)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault()
                        e.stopPropagation()
                        openObjectMenu({ kind: 'connection', id: edge.id }, e.currentTarget)
                      } else if (e.key === 'Enter') {
                        e.stopPropagation()
                        select({ kind: 'connection', id: edge.id })
                      }
                    }}
                  >
                    <path className="diagram-edge-hit" d={d} />
                    <path
                      className={`diagram-edge-line ${!historical && (referenceIssues.has(edge.sourceId) || referenceIssues.has(edge.targetId)) ? 'reference-edge-warning' : ''}`}
                      d={d}
                      stroke={
                        showDiff && connectionChanges.get(edge.id)?.status !== 'unchanged'
                          ? {
                              added: '#2b9274',
                              modified: '#bb862b',
                              removed: '#bd6262',
                              unchanged: '',
                            }[connectionChanges.get(edge.id)!.status]
                          : relationColors[edge.type]
                      }
                      strokeWidth={selected ? 3 : 1.8}
                      strokeDasharray={
                        showDiff && connectionChanges.get(edge.id)?.status === 'removed'
                          ? '6 5'
                          : edge.type === 'dependency'
                            ? '6 5'
                            : edge.type === 'event'
                              ? '3 4'
                              : undefined
                      }
                      markerEnd={`url(#diagram-arrow-${showDiff && connectionChanges.get(edge.id)?.status !== 'unchanged' ? connectionChanges.get(edge.id)?.status : edge.type})`}
                    />
                    <g transform={`translate(${(from.x + to.x) / 2}, ${(from.y + to.y) / 2 - 10})`}>
                      <rect
                        x={-Math.min(edge.name.length * 6 + 12, 90)}
                        y="-12"
                        width={Math.min(edge.name.length * 12 + 24, 180)}
                        height="24"
                        rx="6"
                      />
                      <text textAnchor="middle" dominantBaseline="central">
                        {edge.name.length > 13 ? `${edge.name.slice(0, 12)}…` : edge.name}
                      </text>
                    </g>
                  </g>
                )
              })}
              {pendingLink && componentMap.has(pendingLink.componentId) && (
                <path
                  d={curve(
                    anchor(componentMap.get(pendingLink.componentId)!, pendingLink.portId, true),
                    pointer,
                  )}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeDasharray="5 5"
                />
              )}
            </svg>
            {displayed.map((c) => {
              const Icon = icons[c.type],
                selected = selectedComponent?.id === c.id,
                owner = c.ownerId ? componentMap.get(c.ownerId) : null
              return (
                <article
                  className={`diagram-node type-${c.type} ${selected ? 'selected' : ''} ${matches(c) ? '' : 'dimmed'} ${showDiff ? `change-${componentChanges.get(c.id)?.status}` : ''} ${showDiff && affected.has(c.id) ? 'change-affected' : ''}`}
                  data-change={showDiff ? componentChanges.get(c.id)?.status : undefined}
                  key={c.id}
                  data-component-id={c.id}
                  data-reference-status={referenceResolutions.get(c.id)?.status}
                  aria-label={`组件 ${c.name}`}
                  tabIndex={0}
                  style={{
                    left: c.position.x,
                    top: c.position.y,
                    width: COMPONENT_WIDTH,
                    height: componentHeight(c),
                  }}
                  onPointerDown={(e) => startDrag(e, c)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    openObjectMenu({ kind: 'component', id: c.id }, e.currentTarget, {
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('button'))
                      select({ kind: 'component', id: c.id })
                  }}
                  onDoubleClick={() => {
                    if (c.reference) openBoard(c.reference)
                    else if (canEditComponent(c.id)) setComponentDraft(c)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault()
                      e.stopPropagation()
                      openObjectMenu({ kind: 'component', id: c.id }, e.currentTarget)
                    } else if (e.key === 'Enter') {
                      e.stopPropagation()
                      select({ kind: 'component', id: c.id })
                    }
                  }}
                >
                  {showDiff && componentChanges.get(c.id)?.status !== 'unchanged' && (
                    <span
                      className={`node-change-badge change-${componentChanges.get(c.id)?.status}`}
                    >
                      {changeLabels[componentChanges.get(c.id)!.status]}
                    </span>
                  )}
                  {showDiff && affected.has(c.id) && (
                    <span className="node-change-badge change-affected">关联影响</span>
                  )}
                  <header>
                    <span className="diagram-node-icon">
                      <Icon size={18} />
                    </span>
                    <div>
                      <small>
                        {c.reference ? '引用 · ' : c.exposed ? '对外开放 · ' : ''}
                        {c.boundary === 'external' ? '外部 · ' : ''}
                        {templateFor(c)?.name ?? componentTypes[c.type]}
                      </small>
                      <strong title={c.name}>{c.name}</strong>
                    </div>
                  </header>
                  <p title={c.description}>{c.description || '双击补充组件职责与处理逻辑'}</p>
                  {c.validation && <ValidationSummary value={c.validation} />}
                  <div className="diagram-node-ports">
                    <div>
                      {c.inputs.map((p) => (
                        <button
                          key={p.id}
                          className="diagram-port input"
                          disabled={!canEditComponent(c.id)}
                          aria-label={`${c.name} 输入 ${p.name}`}
                          title={`${p.name} · ${p.dataType}\n${p.description}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => {
                            if (e.button === 0 && pendingLink && e.pointerType !== 'touch') {
                              e.stopPropagation()
                              connect(c, p.id)
                            }
                          }}
                          onClick={() => {
                            if (pendingLink) connect(c, p.id)
                          }}
                        >
                          <span className="port-dot" />
                          <span>{p.name}</span>
                        </button>
                      ))}
                    </div>
                    <div>
                      {c.outputs.map((p) => (
                        <button
                          key={p.id}
                          disabled={!canEditComponent(c.id)}
                          className={`diagram-port output ${pendingLink?.portId === p.id && pendingLink.componentId === c.id ? 'pending' : ''}`}
                          aria-label={`${c.name} 输出 ${p.name}`}
                          title={`${p.name} · ${p.dataType}\n${p.description}`}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            if (e.button !== 0) return
                            setPendingLink({ componentId: c.id, portId: p.id })
                            setPointer(anchor(c, p.id, true))
                          }}
                          onClick={() => {
                            setPendingLink({ componentId: c.id, portId: p.id })
                            setPointer(anchor(c, p.id, true))
                          }}
                        >
                          <span>{p.name}</span>
                          <span className="port-dot" />
                        </button>
                      ))}
                    </div>
                  </div>
                  {c.reference && (
                    <button
                      className={`diagram-reference-link status-${referenceResolutions.get(c.id)!.status}`}
                      aria-label={`查看引用来源 ${c.name}`}
                      onClick={() => openBoard(c.reference!)}
                      title={`${referenceResolutions.get(c.id)!.board?.path ?? c.reference.boardId} · ${referenceResolutions.get(c.id)!.message}`}
                    >
                      <ArrowUpRight size={12} />
                      <span>
                        {[
                          ...new Set(
                            [
                              referenceResolutions.get(c.id)!.board?.applicationName,
                              referenceResolutions.get(c.id)!.board?.name,
                            ].filter(Boolean),
                          ),
                        ].join(' / ') || '来源不可用'}
                      </span>
                      <small>
                        {c.reference.version === 'history'
                          ? '历史'
                          : c.reference.version === 'iteration'
                            ? '迭代中'
                            : '现状'}
                        {!historical && referenceResolutions.get(c.id)!.status !== 'ok'
                          ? ' · 待检查'
                          : ''}
                      </small>
                    </button>
                  )}
                  <footer>
                    <Box size={10} />
                    <span title={owner?.name ?? scopeName}>{owner?.name ?? scopeName}</span>
                    <small>
                      {c.inputs.length || c.outputs.length
                        ? `${c.inputs.length} 入 · ${c.outputs.length} 出`
                        : '整体关联'}
                    </small>
                  </footer>
                </article>
              )
            })}
          </div>
          {!graph.components.length && (
            <div className="diagram-empty diagram-floating">
              <div className="diagram-empty-symbol">
                <Workflow size={34} strokeWidth={1.3} />
              </div>
              <span>SYSTEM CANVAS</span>
              <h2>让系统现状与下一步，都清晰可见</h2>
              <p>
                从角色与能力出发，连接页面、行为和规则，
                <br />
                在现状之上，设计下一次迭代。
              </p>
              <button
                className="button primary"
                disabled={readOnly || !library.length}
                onClick={() => setShowLibrary(true)}
              >
                <Plus size={15} />
                添加第一个组件
              </button>
              <button
                className="button text"
                disabled={
                  readOnly ||
                  !!catalogDiagramError(exampleDiagram(), catalog) ||
                  scenarioId(graph) !== 'general'
                }
                onClick={() => {
                  const sample = exampleDiagram()
                  if (commit(sample)) fit(sample)
                }}
              >
                从注册流程示例开始 <ArrowUpRight size={14} />
              </button>
              {!readOnly && !gitRepository && !model.iteration && !model.history.length && (
                <button
                  className="button text"
                  disabled={
                    !!catalogDiagramError(iterationExample(), catalog) ||
                    scenarioId(graph) !== 'general'
                  }
                  onClick={() => {
                    const sample = iterationExample()
                    if (applyModel(sample)) {
                      switchMode('iteration')
                      fit(sample)
                    }
                  }}
                >
                  体验「手机号注册」迭代示例 <ArrowUpRight size={14} />
                </button>
              )}
            </div>
          )}
          {pendingLink && (
            <div className="diagram-link-hint diagram-floating">
              选择目标组件的输入端口
              <button onClick={() => setPendingLink(null)} aria-label="取消连线">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="diagram-canvas-bottom diagram-floating">
            <div className="diagram-view-controls">
              <button
                className={hand ? '' : 'active'}
                aria-label="选择工具"
                aria-pressed={!hand}
                onClick={() => setHand(false)}
              >
                <MousePointer2 size={16} />
              </button>
              <button
                className={hand ? 'active' : ''}
                aria-label="平移工具"
                aria-pressed={hand}
                onClick={() => setHand(true)}
              >
                <Hand size={16} />
              </button>
              <span />
              <button aria-label="缩小画板" onClick={() => zoomBy(1 / 1.2)}>
                <Minus size={16} />
              </button>
              <output>
                {view.zoom < 0.01 ? (view.zoom * 100).toFixed(1) : Math.round(view.zoom * 100)}%
              </output>
              <button aria-label="放大画板" onClick={() => zoomBy(1.2)}>
                <Plus size={16} />
              </button>
              <span />
              <button aria-label="适应画板" title="适应画板 F" onClick={() => fit()}>
                <Maximize size={15} />
              </button>
            </div>
            <small>拖动空白平移 · ⌘/Ctrl + 滚轮缩放</small>
          </div>
        </div>
        {showChanges && model.iteration && (
          <aside className="diagram-inspector changes-inspector" aria-label="迭代变更清单">
            <div className="diagram-inspector-heading">
              <span>本次迭代 · 变更清单</span>
              <button
                className="icon-button"
                aria-label="关闭变更清单"
                onClick={() => setShowChanges(false)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="diagram-inspector-scroll">
              <h2>{model.iteration.name}</h2>
              <p className="diagram-detail-description">
                {diff.filter((c) => c.kind === 'component' && c.status !== 'unchanged').length}{' '}
                个组件 ·{' '}
                {diff.filter((c) => c.kind === 'connection' && c.status !== 'unchanged').length}{' '}
                条连接发生变化
              </p>
              {!diff.some((c) => c.status !== 'unchanged') && (
                <p>还没有业务修改。可以添加组件，或双击现有组件开始编辑。</p>
              )}
              {diff
                .filter((c) => c.status !== 'unchanged')
                .map((change) => (
                  <details className="change-list-item" key={`${change.kind}-${change.id}`}>
                    <summary>
                      <span className={`change-label change-${change.status}`}>
                        {changeLabels[change.status]}
                      </span>
                      <strong>{change.name}</strong>
                      <small>{change.kind === 'component' ? '组件' : '连接'}</small>
                    </summary>
                    <ChangeDetails
                      change={change}
                      describe={describeChangeValue}
                      fieldLabel={(field) => changeFieldLabel(change.id, field)}
                    />
                    <button
                      className="button text compact"
                      onClick={() => {
                        setMode('iteration')
                        setHistoricalId('')
                        select({ kind: change.kind, id: change.id })
                      }}
                    >
                      查看对象 <ArrowUpRight size={12} />
                    </button>
                  </details>
                ))}
              {affected.size > 0 && (
                <div className="diagram-detail-section">
                  <h3>关联影响 · {affected.size}</h3>
                  <p>与修改对象直接关联，建议检查；不计为已修改。</p>
                  {[...affected].map((id) => (
                    <button
                      key={id}
                      className="diagram-directory-item"
                      onClick={() => {
                        setMode('iteration')
                        setHistoricalId('')
                        select({ kind: 'component', id })
                      }}
                    >
                      {model.components.find((c) => c.id === id)?.name ?? id}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
        {(selectedComponent || selectedConnection) && !pendingLink && (
          <aside
            className="diagram-inspector"
            aria-label="系统图属性"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                select(null)
                canvasRef.current?.focus()
              }
            }}
          >
            <div className="diagram-inspector-heading">
              <span>{selectedComponent ? '组件详情' : '连接详情'}</span>
              <button
                className="icon-button"
                aria-label="取消选择"
                title="关闭详情"
                onClick={() => {
                  select(null)
                  canvasRef.current?.focus()
                }}
              >
                <X size={15} />
              </button>
            </div>
            <div className="diagram-inspector-scroll">
              {selectedComponent ? (
                <>
                  <span className={`diagram-type-pill type-${selectedComponent.type}`}>
                    {templateFor(selectedComponent)?.name ?? componentTypes[selectedComponent.type]}
                  </span>
                  <h2>{selectedComponent.name}</h2>
                  {showDiff &&
                    componentChanges.has(selectedComponent.id) &&
                    componentChanges.get(selectedComponent.id)!.status !== 'unchanged' && (
                      <ChangeDetails
                        change={componentChanges.get(selectedComponent.id)!}
                        describe={describeChangeValue}
                        fieldLabel={(field) => changeFieldLabel(selectedComponent.id, field)}
                      />
                    )}
                  {showDiff && affected.has(selectedComponent.id) && (
                    <p className="impact-note">
                      关联影响：与修改对象直接关联，请检查是否需要同步调整。
                    </p>
                  )}
                  <p className="diagram-detail-description">
                    {selectedComponent.description || '尚未填写组件说明。'}
                  </p>
                  {selectedComponent.validation && (
                    <ValidationDetails value={selectedComponent.validation} />
                  )}
                  {(templateFor(selectedComponent)?.fields ?? []).length > 0 && (
                    <dl className="diagram-metadata">
                      {templateFor(selectedComponent)!.fields.map((f) => (
                        <div key={f.id}>
                          <dt>{f.name}</dt>
                          <dd>
                            {f.type === 'boolean'
                              ? ({ true: '是', false: '否' }[metadataValue(selectedComponent, f)] ??
                                '未填写')
                              : metadataValue(selectedComponent, f) || '未填写'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {selectedComponent.reference && (
                    <ReferenceDetails
                      component={selectedComponent}
                      boards={boards}
                      editable={canEditComponent(selectedComponent.id)}
                      historical={!!historical}
                      onOpen={openBoard}
                      onUpdate={() => setReferenceDraft(selectedComponent)}
                    />
                  )}
                  {!selectedComponent.reference && (
                    <ReferenceUsages
                      boards={boards}
                      boardId={boardId}
                      componentId={selectedComponent.id}
                      onOpen={openBoard}
                    />
                  )}
                  <div className="diagram-detail-actions">
                    <button
                      className="button secondary compact"
                      disabled={
                        readOnly ||
                        (selectedComponent
                          ? !canEditComponent(selectedComponent.id)
                          : !canEditConnection(selectedConnection!.id))
                      }
                      onClick={editSelected}
                    >
                      <Pencil size={13} />
                      {selectedComponent.reference ? '配置引用' : '编辑组件'}
                    </button>
                    <button
                      className="icon-button"
                      aria-label="复制组件"
                      disabled={readOnly || !canEditComponent(selectedComponent.id)}
                      title="复制组件"
                      onClick={duplicate}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      className="icon-button diagram-delete"
                      aria-label="删除组件"
                      disabled={readOnly || !canEditComponent(selectedComponent.id)}
                      title="删除组件及关联连接（可撤销）"
                      onClick={removeSelected}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="diagram-detail-section">
                    <h3>归属</h3>
                    {selectedComponent.ownerId ? (
                      <button
                        className="diagram-owner-link"
                        onClick={() =>
                          focusComponent(componentMap.get(selectedComponent.ownerId!)!)
                        }
                      >
                        <Box size={13} />
                        {componentMap.get(selectedComponent.ownerId)?.name}
                        <ArrowUpRight size={12} />
                      </button>
                    ) : (
                      <p>{scopeName} · 顶层组件</p>
                    )}
                  </div>
                  {(['inputs', 'outputs'] as const).map((side) => (
                    <div className="diagram-detail-section" key={side}>
                      <h3>
                        {side === 'inputs' ? '输入' : '输出'}
                        <span>{selectedComponent[side].length}</span>
                      </h3>
                      {selectedComponent[side].length ? (
                        selectedComponent[side].map((p) => (
                          <div className="diagram-port-detail" key={p.id}>
                            <div>
                              <strong>{p.name}</strong>
                              <code>{p.dataType || '未指定'}</code>
                            </div>
                            {p.description && <p>{p.description}</p>}
                          </div>
                        ))
                      ) : (
                        <p>无{side === 'inputs' ? '输入' : '输出'}端口</p>
                      )}
                    </div>
                  ))}
                  <div className="diagram-detail-section">
                    <h3>链路追踪</h3>
                    <div className="diagram-trace-controls">
                      <button
                        className={trace === 'upstream' ? 'active' : ''}
                        onClick={() => setTrace(trace === 'upstream' ? 'all' : 'upstream')}
                      >
                        <ArrowUpRight size={13} />
                        上游来源
                      </button>
                      <button
                        className={trace === 'downstream' ? 'active' : ''}
                        onClick={() => setTrace(trace === 'downstream' ? 'all' : 'downstream')}
                      >
                        <ArrowDownRight size={13} />
                        下游影响
                      </button>
                    </div>
                    {trace !== 'all' && (
                      <p>
                        高亮 {traced?.size} 个组件（含当前组件），按当前关系筛选追踪。再次点击恢复。
                      </p>
                    )}
                  </div>
                  <div className="diagram-detail-section">
                    <h3>关联连接</h3>
                    {graph.connections
                      .filter(
                        (e) =>
                          e.sourceId === selectedComponent.id ||
                          e.targetId === selectedComponent.id,
                      )
                      .map((e) => (
                        <button
                          className="diagram-relation-item"
                          key={e.id}
                          onClick={() => select({ kind: 'connection', id: e.id })}
                        >
                          <span style={{ background: relationColors[e.type] }} />
                          <div>
                            <strong>{e.name}</strong>
                            <small>
                              {componentMap.get(e.sourceId)?.name} →{' '}
                              {componentMap.get(e.targetId)?.name}
                            </small>
                          </div>
                          <ArrowUpRight size={12} />
                        </button>
                      ))}
                  </div>
                  <div className="diagram-detail-section">
                    <h3>组件 ID</h3>
                    <code className="diagram-detail-id">{selectedComponent.id}</code>
                  </div>
                </>
              ) : selectedConnection ? (
                <>
                  <span
                    className="diagram-type-pill"
                    style={{ color: relationColors[selectedConnection.type] }}
                  >
                    {connectionTypes[selectedConnection.type]}
                  </span>
                  <h2>{selectedConnection.name}</h2>
                  {showDiff &&
                    connectionChanges.has(selectedConnection.id) &&
                    connectionChanges.get(selectedConnection.id)!.status !== 'unchanged' && (
                      <ChangeDetails
                        change={connectionChanges.get(selectedConnection.id)!}
                        describe={describeChangeValue}
                      />
                    )}
                  <p className="diagram-detail-description">
                    {selectedConnection.description || '尚未填写连接说明。'}
                  </p>
                  <div className="diagram-detail-actions">
                    <button
                      className="button secondary compact"
                      disabled={!canEditConnection(selectedConnection.id)}
                      onClick={editSelected}
                    >
                      <Pencil size={13} />
                      编辑连接
                    </button>
                    <button
                      className="icon-button diagram-delete"
                      aria-label="删除连接"
                      disabled={readOnly || !canEditConnection(selectedConnection.id)}
                      onClick={removeSelected}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {(['source', 'target'] as const).map((side) => {
                    const c = componentMap.get(
                        side === 'source'
                          ? selectedConnection.sourceId
                          : selectedConnection.targetId,
                      )!,
                      portId =
                        side === 'source'
                          ? selectedConnection.sourcePortId
                          : selectedConnection.targetPortId
                    return (
                      <div className="diagram-detail-section" key={side}>
                        <h3>{side === 'source' ? '起点 / 输出' : '终点 / 输入'}</h3>
                        <button className="diagram-owner-link" onClick={() => focusComponent(c)}>
                          {c.name}
                          <ArrowUpRight size={13} />
                        </button>
                        <p>
                          {c[side === 'source' ? 'outputs' : 'inputs'].find((p) => p.id === portId)
                            ?.name ?? '组件整体'}
                        </p>
                      </div>
                    )
                  })}
                  <div className="diagram-detail-section">
                    <h3>传输方式 / 协议</h3>
                    <p>{selectedConnection.protocol || '未指定'}</p>
                  </div>
                  <div className="diagram-detail-section">
                    <h3>触发条件</h3>
                    <p>{selectedConnection.condition || '无特定条件'}</p>
                  </div>
                  <div className="diagram-detail-section">
                    <h3>连接 ID</h3>
                    <code className="diagram-detail-id">{selectedConnection.id}</code>
                  </div>
                </>
              ) : null}
            </div>
          </aside>
        )}
      </div>
      <div className="diagram-status">
        <span>
          <i />
          {scopeName} 的独立系统图
        </span>
        <span>方向由箭头表示 · 归属显示于组件底部</span>
      </div>
      {showReferences && (
        <ReferenceUsageModal onClose={() => setShowReferences(false)}>
          <ReferenceUsages boards={boards} boardId={boardId} onOpen={openBoard} />
        </ReferenceUsageModal>
      )}
      {referenceDraft && (
        <ReferenceEditor
          boards={boards}
          boardId={boardId}
          graph={graph}
          component={referenceDraft === 'new' ? undefined : referenceDraft}
          position={
            referenceDraft === 'new'
              ? {
                  x: Math.round(((canvasRef.current?.clientWidth ?? 800) / 2 - view.x) / view.zoom),
                  y: Math.round(
                    ((canvasRef.current?.clientHeight ?? 600) / 2 - view.y) / view.zoom,
                  ),
                }
              : referenceDraft.position
          }
          onClose={() => setReferenceDraft(null)}
          onSave={(c) => {
            const next = graph.components.some((item) => item.id === c.id)
              ? replaceComponent(graph, c)
              : { ...graph, components: [...graph.components, c] }
            if (commit(next)) {
              setReferenceDraft(null)
              select({ kind: 'component', id: c.id })
            }
          }}
        />
      )}
      {componentDraft && (
        <ComponentEditor
          component={componentDraft}
          graph={graph}
          template={templateFor(componentDraft)}
          onClose={() => setComponentDraft(null)}
          onSave={(c) => {
            const next = graph.components.some((item) => item.id === c.id)
              ? replaceComponent(graph, c)
              : { ...graph, components: [...graph.components, c] }
            if (commit(next)) {
              setComponentDraft(null)
              select({ kind: 'component', id: c.id })
            }
          }}
        />
      )}
      {connectionDraft && (
        <ConnectionEditor
          connection={connectionDraft}
          graph={graph}
          onClose={() => setConnectionDraft(null)}
          onSave={(e) => {
            if (
              commit({
                ...graph,
                connections: graph.connections.some((item) => item.id === e.id)
                  ? graph.connections.map((item) => (item.id === e.id ? e : item))
                  : [...graph.connections, e],
              })
            ) {
              setConnectionDraft(null)
              select({ kind: 'connection', id: e.id })
            }
          }}
        />
      )}
      {showJson && (
        <DiagramJsonEditor
          graph={graph}
          readOnly={readOnly}
          onNotify={onNotify}
          onClose={() => setShowJson(false)}
          onImport={(imported) => {
            const next = parseCatalogDiagram(
              { ...imported, iteration: model.iteration, history: model.history },
              catalog,
              scenarioId(graph),
            )
            if (commit(next)) {
              setShowJson(false)
              setPendingLink(null)
              select(null)
              fit(next)
              onNotify('系统图已导入，可撤销恢复')
            }
          }}
        />
      )}
    </section>
  )
}
