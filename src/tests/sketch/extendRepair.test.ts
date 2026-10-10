// Extend constraint repair (the user's named case): extending a line
// whose end carries a fillet must KEEP the fillet attached and tangent.
// The arc's tangent constraint survives by id (tangency to a line never
// referenced the endpoint), and the joint coincident CONVERTS to
// point_on_object so the arc stays anchored at the "virtual corner"
// while the line grows past it. Built with the REAL fillet transform,
// extended with the REAL extend transform, verified on the REAL solver.

import { describe, it, expect } from 'vitest'
import { filletLines } from '../../lib/sketch/tools/filletTool'
import { extendClick, type ExtendChainState } from '../../lib/sketch/tools/extendTool'
import type { SketchDoc, SketchDocTransform } from '../../lib/sketch/tools/trimTool'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchArcEntity, SketchLineEntity,
  SketchConstraint, SketchDimension, Vec2,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `xr-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
): SketchLineEntity {
  return {
    id, kind: 'line', construction: false,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function doc(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): SketchDoc {
  return { entities, constraints, dimensions }
}

function asSketch(d: SketchDocTransform): Sketch {
  return {
    id: 'sk', layerId: 'layer',
    entities: d.entities, constraints: d.constraints, dimensions: d.dimensions,
    solveStatus: null,
  }
}

function getLine(entities: readonly SketchEntity[], id: string): SketchLineEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`no line ${id}`)
  return e
}

function getArc(entities: readonly SketchEntity[], id: string): SketchArcEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'arc') throw new Error(`no arc ${id}`)
  return e
}

/** Two-step extend through the real click flow: pick, then commit.
 *  (The commit's notice may carry the repair summary — see the
 *  dedicated notice tests.) */
function extendVia(d: SketchDoc, pickAt: Vec2, cursor: Vec2): SketchDocTransform {
  const r = extendOutcome(d, pickAt, cursor)
  return r.transform!
}

function extendOutcome(d: SketchDoc, pickAt: Vec2, cursor: Vec2) {
  const r1 = extendClick(null, d, pickAt, 0.4, newId)
  expect(r1.chain).not.toBeNull()
  const r2 = extendClick(r1.chain as ExtendChainState, d, cursor, 0.4, newId)
  expect(r2.transform).not.toBeNull()
  return r2
}

/** |cross| of the line's D1 and the arc's D1 at the arc's joint site —
 *  analytic tangency, not finite-diff. Zero when perfectly tangent. */
function tangencyCross(
  l: SketchLineEntity, a: SketchArcEntity, jointSite: 'start' | 'end',
): number {
  const ang = jointSite === 'start' ? a.startAngle : a.endAngle
  const llen = Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)
  const lx = (l.end.x - l.start.x) / llen
  const ly = (l.end.y - l.start.y) / llen
  // Arc D1 (unit): d/dt (center + r cos, r sin) direction.
  const tx = -Math.sin(ang)
  const ty = Math.cos(ang)
  return Math.abs(lx * ty - ly * tx)
}

/** L-corner with a REAL R2 fillet: LA (0,0)->(8,0), arc (8,0)->(10,2)
 *  about (8,2), LB (10,2)->(10,10). Plus extend boundaries at x=14 and
 *  x=-4. Returns the post-fillet document. */
function filletedCorner(): SketchDoc {
  const base = doc(
    [
      line('LA', 0, 0, 10, 0),
      line('LB', 10, 0, 10, 10),
      line('BD', 14, -5, 14, 5),
      line('BD2', -4, -5, -4, 5),
    ],
    [
      { id: 'c-corner', kind: 'coincident',
        a: { entityId: 'LA', site: 'end' }, b: { entityId: 'LB', site: 'start' } },
    ],
  )
  const r = filletLines(base, 'LA', 'LB', { x: 2, y: 0 }, { x: 10, y: 8 }, 2, newId)
  expect(typeof r).not.toBe('string')
  if (typeof r === 'string') throw new Error(r)
  return r.transform
}

describe('extend through a fillet (real fillet + real extend + real solver)', () => {
  it('extending the FILLETED end keeps the arc tangent at the virtual corner', async () => {
    const d = filletedCorner()
    const arcId = d.entities.find((e) => e.kind === 'arc')!.id
    const tangentIds = d.constraints
      .filter((c) => c.kind === 'tangent')
      .map((c) => c.id)
    expect(tangentIds).toHaveLength(2)
    const jointId = d.constraints.find(
      (c) => c.kind === 'coincident' &&
        (c.a.entityId === 'LA' || c.b.entityId === 'LA'),
    )!.id

    // Extend LA's filleted end PAST the joint to the boundary at x=14.
    const t = extendVia(d, { x: 4, y: 0 }, { x: 12.5, y: 0 })

    // The line grew past the virtual corner to the target.
    const la = getLine(t.entities, 'LA')
    expect(la.start).toEqual({ x: 0, y: 0 })
    expect(la.end.x).toBeCloseTo(14, 9)
    expect(la.end.y).toBeCloseTo(0, 9)
    // The arc itself did not move: its joint stays at the virtual corner.
    const arc = getArc(t.entities, arcId)
    expect(arc.center.x).toBeCloseTo(8, 9)
    expect(arc.center.y).toBeCloseTo(2, 9)

    // BOTH tangent constraints survive BY ID — never dropped/recreated.
    const ids = t.constraints.map((c) => c.id)
    for (const tid of tangentIds) expect(ids).toContain(tid)

    // The joint coincident CONVERTED (same id) to point_on_object: the
    // arc end stays anchored ON the line at the virtual intersection.
    const joint = t.constraints.find((c) => c.id === jointId)
    expect(joint?.kind).toBe('point_on_object')
    if (joint?.kind === 'point_on_object') {
      expect(joint.point.entityId).toBe(arcId)
      expect(joint.object).toBe('LA')
    }
    // The landing got its own on-curve constraint onto the boundary.
    expect(t.constraints.some(
      (c) => c.kind === 'point_on_object' &&
        c.point.entityId === 'LA' && c.point.site === 'end' && c.object === 'BD',
    )).toBe(true)

    // Real solve comes back CLEAN (no conflicts), geometry holds.
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, asSketch(t))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])

    const sLA = getLine(out.entities, 'LA')
    const sArc = getArc(out.entities, arcId)
    // Tangency analytically verified: D1 cross product ~ 0.
    expect(tangencyCross(sLA, sArc, 'start')).toBeLessThan(1e-9)
    // The joint point stayed at the virtual corner (8,0).
    const jx = sArc.center.x + sArc.radius * Math.cos(sArc.startAngle)
    const jy = sArc.center.y + sArc.radius * Math.sin(sArc.startAngle)
    expect(jx).toBeCloseTo(8, 6)
    expect(jy).toBeCloseTo(0, 6)
    // And the extended end reached the target boundary.
    expect(sLA.end.x).toBeCloseTo(14, 6)
  })

  it('extending the fillet-FREE end leaves every joint constraint untouched', async () => {
    const d = filletedCorner()
    const before = new Map(d.constraints.map((c) => [c.id, c.kind]))

    // Extend LA's free start to the boundary at x=-4: the far endpoint
    // (away from the fillet) moves; the fillet end is not touched.
    const t = extendVia(d, { x: 4, y: 0 }, { x: -2, y: 0 })
    const la = getLine(t.entities, 'LA')
    expect(la.start.x).toBeCloseTo(-4, 9)
    expect(la.end.x).toBeCloseTo(8, 9) // fillet joint end untouched

    // Every pre-existing constraint survives with its kind unchanged
    // (the coincident joint stays a coincident — nothing converted).
    for (const [id, kind] of before) {
      const c = t.constraints.find((x) => x.id === id)
      expect(c, `constraint ${id} must survive`).toBeDefined()
      expect(c!.kind).toBe(kind)
    }

    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, asSketch(t))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
    const arcId = d.entities.find((e) => e.kind === 'arc')!.id
    expect(tangencyCross(getLine(out.entities, 'LA'), getArc(out.entities, arcId), 'start'))
      .toBeLessThan(1e-9)
  })
})

describe('extend repair of other endpoint-pinning constraints', () => {
  it('a stale on-curve pin on the moved end is dropped, not contradicted', async () => {
    // T's end sits ON vertical N (a previous trim/extend landing). A new
    // extension to FAR must DROP that pin — keeping it would demand the
    // endpoint be on two parallel verticals at once (infeasible).
    const d = doc(
      [
        line('T', 0, 0, 5, 0),
        line('N', 5, -5, 5, 5),
        line('FAR', 9, -5, 9, 5),
      ],
      [
        { id: 'poo-old', kind: 'point_on_object',
          point: { entityId: 'T', site: 'end' }, object: 'N' },
      ],
    )
    const t = extendVia(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    expect(getLine(t.entities, 'T').end.x).toBeCloseTo(9, 9)
    expect(t.constraints.find((c) => c.id === 'poo-old')).toBeUndefined()
    expect(t.constraints.some(
      (c) => c.kind === 'point_on_object' && c.object === 'FAR',
    )).toBe(true)

    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, asSketch(t))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
  })

  it('a plain corner coincident converts: the partner anchors on the line', () => {
    const d = doc(
      [
        line('T', 0, 0, 5, 0),
        line('W', 5, 0, 5, 5),
        line('FAR', 9, -5, 9, 5),
      ],
      [
        { id: 'c-w', kind: 'coincident',
          a: { entityId: 'T', site: 'end' }, b: { entityId: 'W', site: 'start' } },
      ],
    )
    const t = extendVia(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    const conv = t.constraints.find((c) => c.id === 'c-w')
    expect(conv?.kind).toBe('point_on_object')
    if (conv?.kind === 'point_on_object') {
      expect(conv.point).toEqual({ entityId: 'W', site: 'start' })
      expect(conv.object).toBe('T')
    }
  })

  it('a ground (fix) on the moved end is dropped - the user moved it on purpose', () => {
    const d = doc(
      [line('T', 0, 0, 5, 0), line('FAR', 9, -5, 9, 5)],
      [{ id: 'fx', kind: 'fix', point: { entityId: 'T', site: 'end' } }],
    )
    const t = extendVia(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    expect(t.constraints.find((c) => c.id === 'fx')).toBeUndefined()
  })

  it('a length dim touching the moved end is re-measured, not left stale', () => {
    const d = doc(
      [line('T', 0, 0, 5, 0), line('FAR', 9, -5, 9, 5)],
      [],
      [{ id: 'dl', kind: 'distance', driving: true, value: 5,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } }],
    )
    const t = extendVia(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    const dl = t.dimensions.find((x) => x.id === 'dl')
    expect(dl).toBeDefined()
    expect(dl!.value).toBeCloseTo(9, 9)
  })

  it('H/V point-pair constraints on the moved end are KEPT (orientation, not a pin)', () => {
    const d = doc(
      [line('T', 0, 0, 5, 0), line('O', 0, 3, 5, 3), line('FAR', 9, -5, 9, 5)],
      [
        { id: 'vv', kind: 'vertical',
          points: [{ entityId: 'T', site: 'end' }, { entityId: 'O', site: 'end' }] },
      ],
    )
    const t = extendVia(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    const kept = t.constraints.find((c) => c.id === 'vv')
    expect(kept?.kind).toBe('vertical')
  })
})

describe('extend repair notices (repair transparency)', () => {
  it('the fillet conversion is reported in the flash notice', () => {
    const d = filletedCorner()
    const r = extendOutcome(d, { x: 4, y: 0 }, { x: 12.5, y: 0 })
    // Entities: LA(Line 1), LB(Line 2), BD(Line 3), BD2(Line 4), Arc 1.
    expect(r.notice).toMatch(/^Extended Line 1: /)
    expect(r.notice).toMatch(/Arc 1 stays joined at the virtual corner/)
  })

  it('a dropped on-curve pin is named with its boundary', () => {
    const d = doc(
      [
        line('T', 0, 0, 5, 0),
        line('N', 5, -5, 5, 5),
        line('FAR', 9, -5, 9, 5),
      ],
      [
        { id: 'poo-old', kind: 'point_on_object',
          point: { entityId: 'T', site: 'end' }, object: 'N' },
      ],
    )
    const r = extendOutcome(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    expect(r.notice).toMatch(/^Extended Line 1: /)
    expect(r.notice).toMatch(/dropped Point on object to Line 2 \(endpoint moved\)/)
  })

  it('a re-measured length dim is reported', () => {
    const d = doc(
      [line('T', 0, 0, 5, 0), line('FAR', 9, -5, 9, 5)],
      [],
      [{ id: 'dl', kind: 'distance', driving: true, value: 5,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } }],
    )
    const r = extendOutcome(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    expect(r.notice).toMatch(/re-measured Distance dim/)
  })

  it('an extend with nothing to repair stays quiet (generic flash speaks)', () => {
    const d = doc([line('T', 0, 0, 5, 0), line('FAR', 9, -5, 9, 5)])
    const r = extendOutcome(d, { x: 2, y: 0 }, { x: 7, y: 0 })
    expect(r.notice).toBeNull()
  })
})
