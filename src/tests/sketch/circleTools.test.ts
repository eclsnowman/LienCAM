// Circle tools (center-point + 3-point) — headless commit coverage.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  toolPreview,
  escapeTool,
  type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import { circumcircle } from '../../lib/sketch/tools/circleTools'
import type { SketchCircleEntity } from '../../lib/sketch/types'

const TOL = 0.5

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

describe('center-point circle', () => {
  it('first click anchors the center; no commit', () => {
    const r = toolClick(armed('circle-center'), { x: 5, y: 5 }, TOL, idFactory())
    expect(r.commit).toBeNull()
    expect(r.state.chain).toEqual({ kind: 'circle', mode: 'center', p1: { x: 5, y: 5 }, p2: null })
  })

  it('second click commits a circle with radius = center-to-click distance', () => {
    const newId = idFactory()
    let r = toolClick(armed('circle-center'), { x: 5, y: 5 }, TOL, newId)
    r = toolClick(r.state, { x: 9, y: 8 }, TOL, newId)
    expect(r.commit!.entities).toEqual([{
      id: 'id0', kind: 'circle', construction: false,
      center: { x: 5, y: 5 }, radius: 5, // 3-4-5 triangle
    }])
    expect(r.commit!.constraints).toEqual([])
    // Chain ended; tool stays armed for the next circle.
    expect(r.state).toEqual({ tool: 'circle-center', chain: null })
  })

  it('ignores a zero-radius click (rim on the center)', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('circle-center'), { x: 5, y: 5 }, TOL, newId)
    const r2 = toolClick(r1.state, { x: 5.2, y: 5.1 }, TOL, newId)
    expect(r2.commit).toBeNull()
    expect(r2.state).toEqual(r1.state)
  })

  it('radius preview is the exact circle the click commits', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('circle-center'), { x: 5, y: 5 }, TOL, newId)
    const preview = toolPreview(r1.state, { x: 9, y: 8 })!
    // Closed tessellation, every point at the committed radius.
    expect(preview[0].x).toBeCloseTo(preview[preview.length - 1].x, 10)
    expect(preview[0].y).toBeCloseTo(preview[preview.length - 1].y, 10)
    for (const p of preview) {
      expect(Math.hypot(p.x - 5, p.y - 5)).toBeCloseTo(5, 10)
    }
  })

  it('Esc cancels the in-progress circle; tool stays armed', () => {
    const r1 = toolClick(armed('circle-center'), { x: 5, y: 5 }, TOL, idFactory())
    const esc = escapeTool(r1.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'circle-center', chain: null })
  })
})

describe('3-point circle', () => {
  it('three clicks commit the circle through all three points', () => {
    const newId = idFactory()
    let r = toolClick(armed('circle-3pt'), { x: 0, y: 0 }, TOL, newId)
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 5, y: 5 }, TOL, newId)

    const c = r.commit!.entities[0] as SketchCircleEntity
    expect(c.kind).toBe('circle')
    // Circle through (0,0), (10,0), (5,5): center (5, 0), radius 5
    // (equidistant: bisector x=5 meets bisector y=5-x at (5,0)).
    expect(c.center.x).toBeCloseTo(5, 10)
    expect(c.center.y).toBeCloseTo(0, 10)
    expect(c.radius).toBeCloseTo(5, 10)
    for (const p of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]) {
      expect(Math.hypot(p.x - c.center.x, p.y - c.center.y)).toBeCloseTo(c.radius, 10)
    }
    expect(r.state).toEqual({ tool: 'circle-3pt', chain: null })
  })

  it('ignores a second click on the first point', () => {
    const newId = idFactory()
    const r1 = toolClick(armed('circle-3pt'), { x: 0, y: 0 }, TOL, newId)
    const r2 = toolClick(r1.state, { x: 0.2, y: 0.1 }, TOL, newId)
    expect(r2.commit).toBeNull()
    expect(r2.state).toEqual(r1.state)
  })

  it('ignores a (near-)collinear third click', () => {
    const newId = idFactory()
    let r = toolClick(armed('circle-3pt'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const before = r.state
    r = toolClick(r.state, { x: 20, y: 0.1 }, TOL, newId) // 0.1 < tol off-line
    expect(r.commit).toBeNull()
    expect(r.state).toEqual(before)
  })

  it('live preview after point 2 passes through both points and the cursor', () => {
    const newId = idFactory()
    let r = toolClick(armed('circle-3pt'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const cursor = { x: 5, y: 5 }
    const preview = toolPreview(r.state, cursor)!
    const expected = circumcircle({ x: 0, y: 0 }, { x: 10, y: 0 }, cursor, 0)!
    for (const p of preview) {
      expect(Math.hypot(p.x - expected.center.x, p.y - expected.center.y))
        .toBeCloseTo(expected.radius, 10)
    }
  })
})
