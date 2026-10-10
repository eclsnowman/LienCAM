// Arc tools (3-point, center-point, tangent) — headless commit coverage.
//
// Document arcs sweep CCW from startAngle to endAngle (types.ts); these
// tests pin the CCW normalization, the tangent tool's endpoint pick +
// auto-constraints, and that previews are the exact committed arc.

import { describe, it, expect } from 'vitest'
import {
  toolClick,
  toolPreview,
  escapeTool,
  type ToolState,
} from '../../lib/sketch/tools/toolMachine'
import type { SketchArcEntity, SketchEntity, Vec2 } from '../../lib/sketch/types'

const TOL = 0.5
const TWO_PI = Math.PI * 2

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function armed(tool: ToolState['tool']): ToolState {
  return { tool, chain: null }
}

function arcPoint(a: SketchArcEntity, angle: number): Vec2 {
  return {
    x: a.center.x + a.radius * Math.cos(angle),
    y: a.center.y + a.radius * Math.sin(angle),
  }
}

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

describe('3-point arc', () => {
  it('start, end, then a through-point commit the arc spanning all three', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-3pt'), { x: 0, y: 0 }, TOL, newId)   // start
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)                // end
    expect(r.commit).toBeNull()
    r = toolClick(r.state, { x: 5, y: 5 }, TOL, newId)                 // through

    const a = r.commit!.entities[0] as SketchArcEntity
    expect(a.kind).toBe('arc')
    expect(r.commit!.constraints).toEqual([])
    // Circle through the three points: center (5,0), radius 5.
    expect(a.center.x).toBeCloseTo(5, 10)
    expect(a.center.y).toBeCloseTo(0, 10)
    expect(a.radius).toBeCloseTo(5, 10)
    // Angular endpoints are the clicked start/end (order-free check) and
    // the through-point lies INSIDE the stored CCW sweep.
    const ends = [arcPoint(a, a.startAngle), arcPoint(a, a.endAngle)]
    const xs = ends.map((p) => p.x).sort((p, q) => p - q)
    expect(xs[0]).toBeCloseTo(0, 10)
    expect(xs[1]).toBeCloseTo(10, 10)
    const sweep = norm(a.endAngle - a.startAngle)
    const offThru = norm(Math.atan2(5 - a.center.y, 5 - a.center.x) - a.startAngle)
    expect(offThru).toBeLessThanOrEqual(sweep)
    expect(r.state).toEqual({ tool: 'arc-3pt', chain: null })
  })

  it('ignores a collinear through-point', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-3pt'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const before = r.state
    r = toolClick(r.state, { x: 5, y: 0.1 }, TOL, newId)
    expect(r.commit).toBeNull()
    expect(r.state).toEqual(before)
  })

  it('preview after the second click is the exact committed arc, anchored at the start click', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-3pt'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const preview = toolPreview(r.state, { x: 5, y: 5 })!
    const a = toolClick(r.state, { x: 5, y: 5 }, TOL, newId).commit!.entities[0] as SketchArcEntity
    // Travel order: polyline runs from the first clicked point.
    expect(preview[0].x).toBeCloseTo(0, 10)
    expect(preview[0].y).toBeCloseTo(0, 10)
    expect(preview[preview.length - 1].x).toBeCloseTo(10, 10)
    expect(preview[preview.length - 1].y).toBeCloseTo(0, 10)
    for (const p of preview) {
      expect(Math.hypot(p.x - a.center.x, p.y - a.center.y)).toBeCloseTo(a.radius, 10)
    }
  })

  it('Esc cancels the in-progress arc; tool stays armed', () => {
    const r = toolClick(armed('arc-3pt'), { x: 0, y: 0 }, TOL, idFactory())
    const esc = escapeTool(r.state)
    expect(esc.consumed).toBe(true)
    expect(esc.state).toEqual({ tool: 'arc-3pt', chain: null })
  })
})

describe('center-point arc', () => {
  it('center, start (radius), end (sweep) commit a CCW arc', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-center'), { x: 0, y: 0 }, TOL, newId) // center
    r = toolClick(r.state, { x: 5, y: 0 }, TOL, newId)                  // start
    r = toolClick(r.state, { x: 0, y: 7 }, TOL, newId)                  // end (angle only)

    const a = r.commit!.entities[0] as SketchArcEntity
    expect(a).toMatchObject({ kind: 'arc', center: { x: 0, y: 0 }, radius: 5 })
    expect(a.startAngle).toBeCloseTo(0, 10)
    expect(a.endAngle).toBeCloseTo(Math.PI / 2, 10) // end click direction; radius from start
    expect(r.state).toEqual({ tool: 'arc-center', chain: null })
  })

  it('sweeps CCW even when the end click is "below" the start (long way around)', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-center'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 5, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 0, y: -5 }, TOL, newId)
    const a = r.commit!.entities[0] as SketchArcEntity
    // CCW 0 -> -pi/2 is a 3/4 sweep, never a clockwise quarter.
    expect(norm(a.endAngle - a.startAngle)).toBeCloseTo(1.5 * Math.PI, 10)
  })

  it('ignores zero-radius and zero-sweep clicks', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-center'), { x: 0, y: 0 }, TOL, newId)
    const atCenter = toolClick(r.state, { x: 0.2, y: 0.1 }, TOL, newId)
    expect(atCenter.commit).toBeNull() // zero radius
    r = toolClick(r.state, { x: 5, y: 0 }, TOL, newId)
    const zeroSweep = toolClick(r.state, { x: 6, y: 0 }, TOL, newId) // same angle
    expect(zeroSweep.commit).toBeNull()
  })

  it('preview equals the committed arc', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-center'), { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 5, y: 0 }, TOL, newId)
    const preview = toolPreview(r.state, { x: 0, y: 7 })!
    const a = toolClick(r.state, { x: 0, y: 7 }, TOL, newId).commit!.entities[0] as SketchArcEntity
    expect(preview[0].x).toBeCloseTo(arcPoint(a, a.startAngle).x, 10)
    expect(preview[0].y).toBeCloseTo(arcPoint(a, a.startAngle).y, 10)
    const last = preview[preview.length - 1]
    expect(last.x).toBeCloseTo(arcPoint(a, a.endAngle).x, 10)
    expect(last.y).toBeCloseTo(arcPoint(a, a.endAngle).y, 10)
    for (const p of preview) {
      expect(Math.hypot(p.x - a.center.x, p.y - a.center.y)).toBeCloseTo(a.radius, 10)
    }
  })
})

describe('tangent arc', () => {
  const line: SketchEntity = {
    id: 'l1', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
  }
  const ctx = { entities: [line] }

  it('first click must hit an existing endpoint; misses are ignored', () => {
    const r = toolClick(armed('arc-tangent'), { x: 5, y: 3 }, TOL, idFactory(), ctx)
    expect(r.commit).toBeNull()
    expect(r.state.chain).toBeNull() // nothing anchored
  })

  it('endpoint click + end click commit an arc leaving tangent, plus coincident and tangent constraints', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-tangent'), { x: 10.2, y: 0.1 }, TOL, newId, ctx)
    expect(r.state.chain).toMatchObject({
      kind: 'arc', mode: 'tangent',
      from: { entityId: 'l1', site: 'end', point: { x: 10, y: 0 }, dir: { x: 1, y: 0 } },
    })
    r = toolClick(r.state, { x: 14, y: 4 }, TOL, newId, ctx)

    const a = r.commit!.entities[0] as SketchArcEntity
    // Unique arc tangent to +x at (10,0) through (14,4): center (10,4), r=4.
    expect(a.center.x).toBeCloseTo(10, 10)
    expect(a.center.y).toBeCloseTo(4, 10)
    expect(a.radius).toBeCloseTo(4, 10)
    // CCW from (10,0) [-pi/2] to (14,4) [0]; shared point is the arc START.
    expect(a.startAngle).toBeCloseTo(-Math.PI / 2, 10)
    expect(a.endAngle).toBeCloseTo(0, 10)
    expect(r.commit!.constraints).toEqual([
      {
        id: r.commit!.constraints[0].id, kind: 'coincident',
        a: { entityId: 'l1', site: 'end' },
        b: { entityId: a.id, site: 'start' },
      },
      { id: r.commit!.constraints[1].id, kind: 'tangent', a: 'l1', b: a.id },
    ])
    expect(r.state).toEqual({ tool: 'arc-tangent', chain: null })
  })

  it('curling to the other side stores the arc CCW with the shared point at the END site', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-tangent'), { x: 10, y: 0 }, TOL, newId, ctx)
    r = toolClick(r.state, { x: 14, y: -4 }, TOL, newId, ctx)
    const a = r.commit!.entities[0] as SketchArcEntity
    expect(a.center.x).toBeCloseTo(10, 10)
    expect(a.center.y).toBeCloseTo(-4, 10)
    // Stored CCW from (14,-4) [0] to (10,0) [pi/2]: the shared endpoint
    // (10,0) is the arc's endAngle end — coincident targets site 'end'.
    const shared = arcPoint(a, a.endAngle)
    expect(shared.x).toBeCloseTo(10, 10)
    expect(shared.y).toBeCloseTo(0, 10)
    expect(r.commit!.constraints[0]).toMatchObject({
      kind: 'coincident',
      a: { entityId: 'l1', site: 'end' },
      b: { entityId: a.id, site: 'end' },
    })
  })

  it('ignores an end click on the tangent line itself (no finite arc)', () => {
    const newId = idFactory()
    let r = toolClick(armed('arc-tangent'), { x: 10, y: 0 }, TOL, newId, ctx)
    const before = r.state
    r = toolClick(r.state, { x: 15, y: 0.2 }, TOL, newId, ctx)
    expect(r.commit).toBeNull()
    expect(r.state).toEqual(before)
  })

  it('picks ARC endpoints too, leaving tangent to the arc', () => {
    const src: SketchEntity = {
      id: 'a1', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2,
    }
    const newId = idFactory()
    // Arc 'end' endpoint is (0,5); CCW leaving direction there is (-1,0).
    let r = toolClick(armed('arc-tangent'), { x: 0.1, y: 5.1 }, TOL, newId, { entities: [src] })
    expect(r.state.chain).toMatchObject({
      kind: 'arc', mode: 'tangent', from: { entityId: 'a1', site: 'end' },
    })
    r = toolClick(r.state, { x: -4, y: 9 }, TOL, newId, { entities: [src] })
    const a = r.commit!.entities[0] as SketchArcEntity
    // Tangent to (-1,0) at (0,5) through (-4,9): center (0,9), radius 4.
    expect(a.center.x).toBeCloseTo(0, 10)
    expect(a.center.y).toBeCloseTo(9, 10)
    expect(a.radius).toBeCloseTo(4, 10)
    expect(r.commit!.constraints[1]).toMatchObject({ kind: 'tangent', a: 'a1', b: a.id })
  })

  it('preview equals the committed arc and starts at the shared endpoint', () => {
    const newId = idFactory()
    const r = toolClick(armed('arc-tangent'), { x: 10, y: 0 }, TOL, newId, ctx)
    const preview = toolPreview(r.state, { x: 14, y: 4 })!
    const commit = toolClick(r.state, { x: 14, y: 4 }, TOL, newId, ctx).commit!
    const a = commit.entities[0] as SketchArcEntity
    expect(preview[0].x).toBeCloseTo(10, 10)
    expect(preview[0].y).toBeCloseTo(0, 10)
    const last = preview[preview.length - 1]
    expect(last.x).toBeCloseTo(14, 10)
    expect(last.y).toBeCloseTo(4, 10)
    for (const p of preview) {
      expect(Math.hypot(p.x - a.center.x, p.y - a.center.y)).toBeCloseTo(a.radius, 10)
    }
  })
})
