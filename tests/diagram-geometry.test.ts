import { describe, expect, it } from 'vitest'
import { COMPONENT_WIDTH, componentHeight, newComponent, newPort } from '../src/shared/diagram'
import { connectionAnchor, connectionCurve } from '../src/shared/diagram-geometry'

describe('系统图连线几何', () => {
  it('较远的上下分支仍从左右侧连接，整条曲线留在相邻列的空隙内', () => {
    for (const y of [-600, 600]) {
      const source = newComponent('action', { x: 60, y: 0 }),
        target = newComponent('action', { x: 380, y })
      target.inputs = []
      const a = connectionAnchor(source, source.outputs[0].id, true, target),
        b = connectionAnchor(target, null, false, source)
      expect(b.x).toBe(target.position.x)
      expect(b.dy).toBe(0)
      const [x0, y0, x1, y1, x2, y2, x3, y3] = connectionCurve(a, b)
        .match(/-?\d+(?:\.\d+)?/g)!
        .map(Number)
      // Sample the actual cubic, checking that it cannot enter a sibling card.
      for (let step = 0; step <= 100; step++) {
        const t = step / 100,
          u = 1 - t,
          x = u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
          cy = u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3
        expect(x).toBeGreaterThanOrEqual(source.position.x + COMPONENT_WIDTH - 0.000001)
        expect(x).toBeLessThanOrEqual(target.position.x + 0.000001)
        expect(Number.isFinite(cy)).toBe(true)
      }
    }
  })

  it('同列组件使用上下边连接，端口连接仍精确指向对应端口', () => {
    const source = newComponent('action', { x: 0, y: 0 }),
      target = newComponent('action', { x: 0, y: 500 })
    expect(connectionAnchor(source, null, true, target)).toEqual({
      x: COMPONENT_WIDTH / 2,
      y: componentHeight(source),
      dx: 0,
      dy: 1,
    })
    expect(connectionAnchor(target, null, false, source)).toEqual({
      x: COMPONENT_WIDTH / 2,
      y: target.position.y,
      dx: 0,
      dy: -1,
    })
    target.inputs.push(newPort('第二个输入'))
    expect(connectionAnchor(target, target.inputs[1].id, false, source)).toEqual({
      x: 0,
      y: 500 + 109 + 26,
      dx: -1,
      dy: 0,
    })
  })

  it('反向端口连接保留回转方向', () => {
    const source = newComponent('action', { x: 380, y: 0 }),
      target = newComponent('action', { x: 60, y: 0 })
    const a = connectionAnchor(source, source.outputs[0].id, true, target),
      b = connectionAnchor(target, target.inputs[0].id, false, source)
    const coordinates = connectionCurve(a, b)
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number)
    expect(coordinates[2]).toBeGreaterThan(a.x)
    expect(coordinates[4]).toBeLessThan(b.x)
  })
})
