import {
  COMPONENT_WIDTH,
  componentHeight,
  validationSummaryHeight,
  type DiagramComponent,
} from './diagram'

export type Anchor = { x: number; y: number; dx?: number; dy?: number }

export function connectionAnchor(
  component: DiagramComponent,
  portId: string | null,
  output: boolean,
  other?: DiagramComponent,
): Anchor {
  const index = component[output ? 'outputs' : 'inputs'].findIndex((p) => p.id === portId)
  if (index < 0 && other) {
    const height = componentHeight(component),
      x = component.position.x + COMPONENT_WIDTH / 2,
      y = component.position.y + height / 2
    const dx = other.position.x + COMPONENT_WIDTH / 2 - x,
      dy = other.position.y + componentHeight(other) / 2 - y
    // Distinct columns connect on their facing sides, even for distant branches.
    // A top/bottom anchor here would send the curve through neighboring cards.
    if (Math.abs(dx) >= COMPONENT_WIDTH || Math.abs(dx) / COMPONENT_WIDTH >= Math.abs(dy) / height)
      return { x: x + (Math.sign(dx) * COMPONENT_WIDTH) / 2, y, dx: Math.sign(dx), dy: 0 }
    return { x, y: y + (Math.sign(dy) * height) / 2, dx: 0, dy: Math.sign(dy) }
  }
  return {
    x: component.position.x + (output ? COMPONENT_WIDTH : 0),
    y:
      component.position.y +
      (index < 0 ? 42 : 109 + validationSummaryHeight(component) + index * 26),
    dx: output ? 1 : -1,
    dy: 0,
  }
}

export function connectionCurve(a: Anchor, b: Anchor): string {
  let offset = Math.max(35, Math.hypot(b.x - a.x, b.y - a.y) * 0.4)
  const ax = a.dx ?? 1,
    bx = b.dx ?? -1,
    ay = a.dy ?? 0,
    by = b.dy ?? 0
  // Bound control points to the gap for facing anchors. Feedback connections
  // retain outward handles so they can turn back toward their destination.
  if (!ay && !by && ax === -bx && (b.x - a.x) * ax > 0)
    offset = Math.min(offset, Math.abs(b.x - a.x) / 2)
  else if (!ax && !bx && ay === -by && (b.y - a.y) * ay > 0)
    offset = Math.min(offset, Math.abs(b.y - a.y) / 2)
  return `M ${a.x} ${a.y} C ${a.x + ax * offset} ${a.y + ay * offset}, ${b.x + bx * offset} ${b.y + by * offset}, ${b.x} ${b.y}`
}
