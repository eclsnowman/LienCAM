// Inference constraints on snap commit — headless coverage (Stage 3
// chunk 3). Exercises the same pipeline the store runs: findSnap() on
// the cursor, toolClick() on the snapped point, PendingSnap recording,
// then inferenceConstraints() resolving against the commit.

import { describe, it, expect } from 'vitest'
import { findSnap, type SnapResult } from '../../lib/sketch/snap'
import { inferenceConstraints, type PendingSnap } from '../../lib/sketch/inference'
import { toolClick, type ToolState, type ToolCommit } from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity, Vec2 } from '../../lib/sketch/types'

const WPP = 0.1 // snap radius = 1 mm
const TOL = 0.5 // click tolerance (world mm)

let nextId = 0
const newId = () => `id${nextId++}`

function line(id: string, sx: number, sy: number, ex: number, ey: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } }
}

function pending(snap: SnapResult, at?: Vec2): PendingSnap {
  return { point: at ?? snap.point, inferences: snap.inferences, alignFrom: snap.alignFrom }
}

const FLAGS_ON = { entity: true, grid: true, inference: true }
const FLAGS_NO_INFERENCE = { entity: true, grid: true, inference: false }

describe('h-align snap -> horizontal constraint on the new line', () => {
  it('line chain: snapped h-align click commits a horizontal segment', () => {
    nextId = 0
    // Chain in progress: previous point (0,0) already anchored.
    const state: ToolState = {
      tool: 'line',
      chain: {
        kind: 'line', start: { x: 0, y: 0 },
        firstLineId: null, prev: { x: 0, y: 0 }, prevLineId: null,
      },
    }
    // Cursor nearly level with the chain's previous point.
    const snap = findSnap({
      cursor: { x: 20, y: 0.4 }, entities: [], gridSpacing: 25,
      worldPerPixel: WPP, alignRef: { x: 0, y: 0 }, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('h-align')

    const r = toolClick(state, snap.point, TOL, newId)
    expect(r.commit).not.toBeNull()
    const constraints = inferenceConstraints(
      r.commit!, [pending(snap)], newId
    )
    const lineId = r.commit!.entities[0].id
    expect(constraints).toEqual([
      { id: expect.any(String), kind: 'horizontal', line: lineId },
    ])
  })

  it('v-align produces a vertical constraint', () => {
    nextId = 0
    const state: ToolState = {
      tool: 'line',
      chain: {
        kind: 'line', start: { x: 5, y: 5 },
        firstLineId: null, prev: { x: 5, y: 5 }, prevLineId: null,
      },
    }
    const snap = findSnap({
      cursor: { x: 5.3, y: 30 }, entities: [], gridSpacing: 25,
      worldPerPixel: WPP, alignRef: { x: 5, y: 5 }, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('v-align')
    const r = toolClick(state, snap.point, TOL, newId)
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toHaveLength(1)
    expect(constraints[0]).toMatchObject({
      kind: 'vertical', line: r.commit!.entities[0].id,
    })
  })
})

describe('endpoint snap -> coincident to the existing entity point', () => {
  it('point tool click snapped onto an existing line endpoint', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 0)]
    const snap = findSnap({
      cursor: { x: 10.3, y: 0.2 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('endpoint')

    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId, {
      entities: existing,
    })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'coincident',
        a: { entityId: r.commit!.entities[0].id, site: 'self' },
        b: { entityId: 'lx', site: 'end' },
      },
    ])
    // The new point sits EXACTLY on the existing endpoint (shared point,
    // no duplicated coordinates).
    const pt = r.commit!.entities[0]
    expect(pt.kind === 'point' && pt.at).toEqual({ x: 10, y: 0 })
  })

  it('line chain anchored on an existing endpoint resolves on commit', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 0)]
    // First click: anchor snapped to lx end — no commit yet, snap pends.
    const snap1 = findSnap({
      cursor: { x: 9.8, y: 0.1 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap1.kind).toBe('endpoint')
    const r1 = toolClick({ tool: 'line', chain: null }, snap1.point, TOL, newId, {
      entities: existing,
    })
    expect(r1.commit).toBeNull()

    // Second click commits the segment; the pending anchor snap binds the
    // segment START to the existing line's end.
    const r2 = toolClick(r1.state, { x: 25, y: 8 }, TOL, newId, { entities: existing })
    expect(r2.commit).not.toBeNull()
    const constraints = inferenceConstraints(r2.commit!, [pending(snap1)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'coincident',
        a: { entityId: r2.commit!.entities[0].id, site: 'start' },
        b: { entityId: 'lx', site: 'end' },
      },
    ])
  })
})

describe('midpoint and intersection snaps', () => {
  it('midpoint snap -> midpoint constraint onto the existing line', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 0)]
    const snap = findSnap({
      cursor: { x: 5.2, y: 0.3 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('midpoint')
    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId, {
      entities: existing,
    })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'midpoint',
        point: { entityId: r.commit!.entities[0].id, site: 'self' },
        line: 'lx',
      },
    ])
  })

  it('intersection snap -> point_on_object onto BOTH source curves', () => {
    nextId = 0
    const existing = [line('la', -2, 0, 10, 0), line('lb', 0, -2, 0, 10)]
    const snap = findSnap({
      cursor: { x: 0.3, y: 0.2 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('intersection')
    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId, {
      entities: existing,
    })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    const ref = { entityId: r.commit!.entities[0].id, site: 'self' }
    expect(constraints).toEqual([
      { id: expect.any(String), kind: 'point_on_object', point: ref, object: 'la' },
      { id: expect.any(String), kind: 'point_on_object', point: ref, object: 'lb' },
    ])
  })
})

describe('coincident fallback when no new point site lands on the snap', () => {
  it('3-pt circle rim click on an existing endpoint -> point_on_object', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 0)]
    // Rim click 1 snapped to lx end (10,0).
    const snap1 = findSnap({
      cursor: { x: 10.2, y: 0.1 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap1.kind).toBe('endpoint')
    let r = toolClick({ tool: 'circle-3pt', chain: null }, snap1.point, TOL, newId, {
      entities: existing,
    })
    r = toolClick(r.state, { x: 20, y: 10 }, TOL, newId, { entities: existing })
    r = toolClick(r.state, { x: 0, y: 10 }, TOL, newId, { entities: existing })
    expect(r.commit).not.toBeNull()
    const circleId = r.commit!.entities[0].id

    // The circle has no point site at (10,0), but its curve passes through
    // it: the EXISTING endpoint is tied onto the NEW circle.
    const constraints = inferenceConstraints(r.commit!, [pending(snap1)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'point_on_object',
        point: { entityId: 'lx', site: 'end' },
        object: circleId,
      },
    ])
  })
})

describe('deduplication against the commit own constraints', () => {
  it('closing a line chain on its snapped start adds no duplicate coincident', () => {
    nextId = 0
    // Draw a triangle: clicks at (0,0), (10,0), (5,8), then close on (0,0).
    let r = toolClick({ tool: 'line', chain: null }, { x: 0, y: 0 }, TOL, newId)
    r = toolClick(r.state, { x: 10, y: 0 }, TOL, newId)
    const firstLineId = r.commit!.entities[0].id
    r = toolClick(r.state, { x: 5, y: 8 }, TOL, newId)
    // Closing click snapped onto the FIRST line's start point.
    const entitiesSoFar: SketchEntity[] = [line(firstLineId, 0, 0, 10, 0)]
    const snap = findSnap({
      cursor: { x: 0.2, y: 0.2 }, entities: entitiesSoFar, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('endpoint')
    expect(snap.point).toEqual({ x: 0, y: 0 })
    r = toolClick(r.state, snap.point, TOL, newId)
    expect(r.commit).not.toBeNull()
    // lineClick already emitted the closure coincident (new end -> first
    // line start); the snap inference must NOT add a second copy.
    const closure = r.commit!.constraints.filter((c) => c.kind === 'coincident')
    expect(closure.length).toBeGreaterThan(0)
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([])
  })

  it('tangent arc keeps its existing behavior (no duplicate constraints)', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 0)]
    // First click: snapped endpoint pick (the arc tool picks the same
    // endpoint via its own tolerance) — snap pends.
    const snap1 = findSnap({
      cursor: { x: 10.2, y: 0.1 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    let r = toolClick({ tool: 'arc-tangent', chain: null }, snap1.point, TOL, newId, {
      entities: existing,
    })
    expect(r.state.chain?.kind).toBe('arc')
    // Second click commits arc + its own coincident + tangent.
    r = toolClick(r.state, { x: 18, y: 6 }, TOL, newId, { entities: existing })
    expect(r.commit).not.toBeNull()
    expect(r.commit!.constraints.map((c) => c.kind).sort()).toEqual([
      'coincident', 'tangent',
    ])
    // The pending endpoint snap resolves to the SAME coincident pair the
    // tool already created: nothing extra is emitted.
    const constraints = inferenceConstraints(r.commit!, [pending(snap1)], newId)
    expect(constraints).toEqual([])
  })
})

describe('hover-wake remote alignment -> two-point H/V constraint', () => {
  it('h-align to a woken endpoint commits horizontal(points) to that site', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 20)]
    // Chain anchored well below the woken ref; cursor far right, nearly
    // level with the woken endpoint (10, 20).
    const state: ToolState = {
      tool: 'line',
      chain: {
        kind: 'line', start: { x: 0, y: -30 },
        firstLineId: null, prev: { x: 0, y: -30 }, prevLineId: null,
      },
    }
    const snap = findSnap({
      cursor: { x: 40, y: 20.4 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, alignRef: { x: 0, y: -30 },
      wokenRefs: [{ point: { x: 10, y: 20 }, ref: { entityId: 'lx', site: 'end' } }],
      flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('h-align')
    expect(snap.point).toEqual({ x: 40, y: 20 })

    const r = toolClick(state, snap.point, TOL, newId, { entities: existing })
    expect(r.commit).not.toBeNull()
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'horizontal',
        points: [
          { entityId: r.commit!.entities[0].id, site: 'end' },
          { entityId: 'lx', site: 'end' },
        ],
      },
    ])
  })

  it('v-align to a woken point entity commits vertical(points)', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 20)]
    const snap = findSnap({
      cursor: { x: 10.3, y: -40 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP,
      wokenRefs: [{ point: { x: 10, y: 20 }, ref: { entityId: 'lx', site: 'end' } }],
      flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('v-align')
    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId, {
      entities: existing,
    })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'vertical',
        points: [
          { entityId: r.commit!.entities[0].id, site: 'self' },
          { entityId: 'lx', site: 'end' },
        ],
      },
    ])
  })

  it('dual woken-H + chain-V intersection commits BOTH constraints', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 20)]
    const state: ToolState = {
      tool: 'line',
      chain: {
        kind: 'line', start: { x: 30, y: -30 },
        firstLineId: null, prev: { x: 30, y: -30 }, prevLineId: null,
      },
    }
    // Cursor near x=30 (chain V) AND y=20 (woken H) -> intersection.
    const snap = findSnap({
      cursor: { x: 30.3, y: 19.7 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, alignRef: { x: 30, y: -30 },
      wokenRefs: [{ point: { x: 10, y: 20 }, ref: { entityId: 'lx', site: 'end' } }],
      flags: FLAGS_ON,
    })!
    expect(snap.point).toEqual({ x: 30, y: 20 })

    const r = toolClick(state, snap.point, TOL, newId, { entities: existing })
    const newLineId = r.commit!.entities[0].id
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'horizontal',
        points: [
          { entityId: newLineId, site: 'end' },
          { entityId: 'lx', site: 'end' },
        ],
      },
      { id: expect.any(String), kind: 'vertical', line: newLineId },
    ])
  })

  it('deduplicates an already-present two-point constraint (either order)', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 20)]
    const snap = findSnap({
      cursor: { x: 40, y: 20.4 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP,
      wokenRefs: [{ point: { x: 10, y: 20 }, ref: { entityId: 'lx', site: 'end' } }],
      flags: FLAGS_ON,
    })!
    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId, {
      entities: existing,
    })
    const newRef = { entityId: r.commit!.entities[0].id, site: 'self' as const }
    // Pretend the commit already carries the pair (reversed order).
    r.commit!.constraints.push({
      id: newId(), kind: 'horizontal',
      points: [{ entityId: 'lx', site: 'end' }, newRef],
    })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([])
  })

  it('position-only woken refs (midpoints) commit NOTHING', () => {
    nextId = 0
    // Woken line midpoint: aligns positionally, no addressable point.
    const snap = findSnap({
      cursor: { x: 40, y: 20.4 }, entities: [], gridSpacing: 25,
      worldPerPixel: WPP,
      wokenRefs: [{ point: { x: 10, y: 20 }, ref: null }],
      flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('h-align')
    expect(snap.point).toEqual({ x: 40, y: 20 })
    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId)
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([])
  })
})

describe('grid snap -> fix constraint on the new point', () => {
  it('point tool click snapped to a grid point emits a fix constraint', () => {
    nextId = 0
    const snap = findSnap({
      cursor: { x: 25.4, y: 49.7 }, entities: [], gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    expect(snap.kind).toBe('grid')
    expect(snap.point).toEqual({ x: 25, y: 50 })

    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId)
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([
      {
        id: expect.any(String),
        kind: 'fix',
        point: { entityId: r.commit!.entities[0].id, site: 'self' },
      },
    ])
    const pt = r.commit!.entities[0]
    expect(pt.kind === 'point' && pt.at).toEqual({ x: 25, y: 50 })
  })

  it('dedup: already-fixed point does not emit a second fix', () => {
    nextId = 0
    const snap = findSnap({
      cursor: { x: 25.4, y: 49.7 }, entities: [], gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_ON,
    })!
    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId)
    const ref = { entityId: r.commit!.entities[0].id, site: 'self' as const }
    r.commit!.constraints.push({ id: newId(), kind: 'fix', point: ref })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([])
  })
})

describe('inference off -> no constraints', () => {
  it('endpoint snap still positions the click but creates nothing', () => {
    nextId = 0
    const existing = [line('lx', 0, 0, 10, 0)]
    const snap = findSnap({
      cursor: { x: 10.3, y: 0.2 }, entities: existing, gridSpacing: 25,
      worldPerPixel: WPP, flags: FLAGS_NO_INFERENCE,
    })!
    expect(snap.kind).toBe('endpoint')
    expect(snap.point).toEqual({ x: 10, y: 0 }) // position still snaps
    expect(snap.inferences).toEqual([])

    const r = toolClick({ tool: 'point', chain: null }, snap.point, TOL, newId, {
      entities: existing,
    })
    const constraints = inferenceConstraints(r.commit!, [pending(snap)], newId)
    expect(constraints).toEqual([])
  })

  it('alignment snaps vanish entirely with inference off', () => {
    const snap = findSnap({
      cursor: { x: 20, y: 0.4 }, entities: [], gridSpacing: 25,
      worldPerPixel: WPP, alignRef: { x: 0, y: 0 }, flags: FLAGS_NO_INFERENCE,
    })
    expect(snap).toBeNull()
  })
})

// Type-level guard: ToolCommit shape used above matches the machine.
const _commitShape: ToolCommit = { entities: [], constraints: [] }
void _commitShape
