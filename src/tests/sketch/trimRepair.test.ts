// Trim entity-level constraint repair (kept/dropped table, trimTool.ts):
//   tangent      -> region check: kept on A / remapped to B / dropped
//   H/V (line)   -> kept on A AND copied to B (collinear pieces)
//   parallel/perp-> kept on A AND copied to B
//   equal        -> line: dropped (lengths changed); radius: kept
//   length dims  -> converted to the kept original-id piece, re-measured
// Point-site survival/cascade rules are covered by trimTool.test.ts.

import { describe, it, expect } from 'vitest'
import { trimAtPoint, trimSwipe, type SketchDoc } from '../../lib/sketch/tools/trimTool'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import type {
  SketchEntity, SketchConstraint, SketchDimension,
  SketchArcEntity, SketchLineEntity, SketchCircleEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `tr-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
): SketchLineEntity {
  return {
    id, kind: 'line', construction: false,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

function doc(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): SketchDoc {
  return { entities, constraints, dimensions }
}

function assertNoDangling(d: {
  entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[]
}) {
  const live = new Set(d.entities.map((e) => e.id))
  for (const c of d.constraints) {
    for (const ref of constraintRefIds(c)) {
      expect(live.has(ref), `constraint ${c.id} dangles on ${ref}`).toBe(true)
    }
  }
  for (const dim of d.dimensions) {
    for (const ref of dimensionRefIds(dim)) {
      expect(live.has(ref), `dimension ${dim.id} dangles on ${ref}`).toBe(true)
    }
  }
}

// Split fixture: T [0,10] on y=0 cut by verticals at x=3 and x=7; a click
// at x=5 removes the middle. Piece A = [0,3] (keeps id T), piece B = [7,10].
const splitBase = (): SketchEntity[] => [
  line('T', 0, 0, 10, 0),
  line('V1', 3, -5, 3, 5),
  line('V2', 7, -5, 7, 5),
]

function pieceB(t: { entities: SketchEntity[] }): SketchLineEntity {
  const b = t.entities.find(
    (e): e is SketchLineEntity =>
      e.kind === 'line' && e.id !== 'T' && !e.id.startsWith('V') &&
      Math.abs(e.start.y) < 1e-9 && Math.abs(e.end.y) < 1e-9,
  )
  expect(b).toBeDefined()
  return b!
}

describe('trim repair - tangent region check', () => {
  it('tangency region on piece A: tangent kept verbatim', () => {
    const d = doc(
      [...splitBase(), circle('CA', 1.5, 2, 2)], // tangent at (1.5,0), t=0.15
      [{ id: 'c-tan', kind: 'tangent', a: 'CA', b: 'T' }],
    )
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    const tan = t.constraints.find((c) => c.id === 'c-tan')
    expect(tan?.kind).toBe('tangent')
    if (tan?.kind === 'tangent') {
      expect(tan.a).toBe('CA')
      expect(tan.b).toBe('T')
    }
    assertNoDangling(t)
  })

  it('tangency region on piece B: tangent remapped to the new piece', () => {
    const d = doc(
      [...splitBase(), circle('CB', 8.5, 2, 2)], // tangent at (8.5,0), t=0.85
      [{ id: 'c-tan', kind: 'tangent', a: 'CB', b: 'T' }],
    )
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    const b = pieceB(t)
    const tan = t.constraints.find((c) => c.id === 'c-tan')
    expect(tan?.kind).toBe('tangent')
    if (tan?.kind === 'tangent') {
      expect(tan.a).toBe('CB')
      expect(tan.b).toBe(b.id)
    }
    assertNoDangling(t)
  })

  it('tangency region trimmed away: tangent dropped', () => {
    // CD never touches T (gap 0.5): an unsatisfied tangent whose
    // nearest-approach point (t=0.5) sits in the REMOVED span.
    const d = doc(
      [...splitBase(), circle('CD', 5, 2.5, 2)],
      [{ id: 'c-tan', kind: 'tangent', a: 'T', b: 'CD' }],
    )
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    expect(t.constraints.find((c) => c.id === 'c-tan')).toBeUndefined()
    assertNoDangling(t)
  })

  it('trimmed ARC keeps/drops tangent by the tangency angle', () => {
    // Arc 0..pi r5; unsatisfied tangent to TL (y=6) pulls at angle pi/2.
    // Cutter crosses at pi/4.
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    const x45 = 5 * Math.cos(Math.PI / 4)
    const cutter = line('V', x45, 0, x45, 10)
    const tl = line('TL', -10, 6, 10, 6)
    const cons: SketchConstraint[] = [{ id: 'c-tan', kind: 'tangent', a: 'A', b: 'TL' }]

    // Click below the cut (angle pi/8): kept piece = [pi/4, pi], which
    // CONTAINS the tangency angle pi/2 -> kept.
    const p1 = { x: 5 * Math.cos(Math.PI / 8), y: 5 * Math.sin(Math.PI / 8) }
    const t1 = trimAtPoint(doc([arc, cutter, tl], cons), p1, 0.4, newId).transform!
    expect(t1.constraints.find((c) => c.id === 'c-tan')?.kind).toBe('tangent')

    // Click above the cut (angle 3pi/8 < pi/2 so the removed span is
    // [pi/4, pi/2)... no: single cut at pi/4, click at 3pi/8 -> kept
    // piece = [0, pi/4], tangency pi/2 outside -> dropped.
    const p2 = { x: 5 * Math.cos((3 * Math.PI) / 8), y: 5 * Math.sin((3 * Math.PI) / 8) }
    const t2 = trimAtPoint(doc([arc, cutter, tl], cons), p2, 0.4, newId).transform!
    expect(t2.constraints.find((c) => c.id === 'c-tan')).toBeUndefined()
    assertNoDangling(t2)
  })

  it('circle->arc trim keeps/drops tangents by the kept sweep (wrapping)', () => {
    // Circle r5 cut by y=0 (angles 0 and pi); click the TOP: kept arc
    // sweeps CCW pi..2pi (the bottom). Tangent pulling at 3pi/2 (TB,
    // y=-6) survives; tangent pulling at pi/2 (TU, y=6) is dropped.
    const ents: SketchEntity[] = [
      circle('C', 0, 0, 5),
      line('L', -10, 0, 10, 0),
      line('TB', -10, -6, 10, -6),
      line('TU', -10, 6, 10, 6),
    ]
    const cons: SketchConstraint[] = [
      { id: 'tan-b', kind: 'tangent', a: 'C', b: 'TB' },
      { id: 'tan-u', kind: 'tangent', a: 'C', b: 'TU' },
    ]
    const t = trimAtPoint(doc(ents, cons), { x: 0, y: 5 }, 0.4, newId).transform!
    expect(t.constraints.find((c) => c.id === 'tan-b')?.kind).toBe('tangent')
    expect(t.constraints.find((c) => c.id === 'tan-u')).toBeUndefined()
    assertNoDangling(t)
  })
})

describe('trim repair - H/V, parallel, perpendicular propagation', () => {
  it('horizontal on a split line applies to BOTH collinear pieces', () => {
    const d = doc(splitBase(), [{ id: 'c-h', kind: 'horizontal', line: 'T' }])
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    const b = pieceB(t)
    const hs = t.constraints.filter((c) => c.kind === 'horizontal')
    expect(hs).toHaveLength(2)
    expect(hs.map((c) => c.kind === 'horizontal' && c.line).sort())
      .toEqual(['T', b.id].sort())
    // The original keeps its id on the original piece.
    const orig = t.constraints.find((c) => c.id === 'c-h')
    expect(orig?.kind === 'horizontal' && orig.line).toBe('T')
    assertNoDangling(t)
  })

  it('horizontal on a merely SHORTENED line is kept once (no second piece)', () => {
    const d = doc(
      [line('T', 0, 0, 10, 0), line('V1', 3, -5, 3, 5)],
      [{ id: 'c-h', kind: 'horizontal', line: 'T' }],
    )
    const t = trimAtPoint(d, { x: 1, y: 0 }, 0.4, newId).transform!
    expect(t.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(1)
    assertNoDangling(t)
  })

  it('parallel and perpendicular propagate to the second piece', () => {
    const d = doc(
      [...splitBase(), line('P', 0, 5, 10, 5)],
      [
        { id: 'c-par', kind: 'parallel', a: 'T', b: 'P' },
        { id: 'c-perp', kind: 'perpendicular', a: 'V1', b: 'T' },
      ],
    )
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    const b = pieceB(t)
    const pars = t.constraints.filter((c) => c.kind === 'parallel')
    expect(pars).toHaveLength(2)
    expect(pars.some((c) => c.kind === 'parallel' && c.a === b.id && c.b === 'P')).toBe(true)
    const perps = t.constraints.filter((c) => c.kind === 'perpendicular')
    expect(perps).toHaveLength(2)
    expect(perps.some((c) => c.kind === 'perpendicular' && c.a === 'V1' && c.b === b.id))
      .toBe(true)
    assertNoDangling(t)
  })
})

describe('trim repair - equal', () => {
  it('equal LENGTH on a trimmed line is dropped (lengths changed)', () => {
    const d = doc(
      [...splitBase(), line('P', 0, 5, 10, 5)],
      [{ id: 'c-eq', kind: 'equal', a: 'T', b: 'P' }],
    )
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    expect(t.constraints.find((c) => c.id === 'c-eq')).toBeUndefined()
    expect(t.constraints.filter((c) => c.kind === 'equal')).toHaveLength(0)
    assertNoDangling(t)
  })

  it('equal RADIUS on a trimmed arc is kept (radius unchanged)', () => {
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    const d = doc(
      [arc, line('V', 0, 0, 0, 10), circle('C2', 20, 0, 5)],
      [{ id: 'c-eq', kind: 'equal', a: 'A', b: 'C2' }],
    )
    const p = { x: 5 * Math.cos(Math.PI / 8), y: 5 * Math.sin(Math.PI / 8) }
    const t = trimAtPoint(d, p, 0.4, newId).transform!
    const eq = t.constraints.find((c) => c.id === 'c-eq')
    expect(eq?.kind).toBe('equal')
    assertNoDangling(t)
  })
})

describe('trim repair - midpoint (Operator ruling 2026-06-13: circle pinned to a line midpoint)', () => {
  // T [0,10] on y=0; circle C centered on T's midpoint (5,0) via a midpoint
  // constraint. Trimming T at x=5 used to keep the midpoint constraint on the
  // shorter piece A [0,3], dragging C's center to (1.5,0). It must DROP now so
  // C stays put at the cut-away virtual midpoint.
  const midDoc = () => doc(
    [...splitBase(), circle('C', 5, 0, 1)],
    [{ id: 'c-mid', kind: 'midpoint', point: { entityId: 'C', site: 'center' }, line: 'T' }],
  )

  it('midpoint on the trimmed line is dropped (anchored point not dragged)', () => {
    const t = trimAtPoint(midDoc(), { x: 5, y: 0 }, 0.4, newId).transform!
    expect(t.constraints.find((c) => c.id === 'c-mid')).toBeUndefined()
    expect(t.constraints.filter((c) => c.kind === 'midpoint')).toHaveLength(0)
    // The circle is untouched — still centered on the original midpoint.
    const c = t.entities.find((e) => e.id === 'C') as SketchCircleEntity
    expect(c.center).toEqual({ x: 5, y: 0 })
    assertNoDangling(t)
  })

  it('midpoint referencing a DIFFERENT line is left intact', () => {
    // Trim T; the midpoint constraint references P (not trimmed) -> kept.
    const d = doc(
      [...splitBase(), line('P', 0, 5, 10, 5), circle('C', 5, 5, 1)],
      [{ id: 'c-mid', kind: 'midpoint', point: { entityId: 'C', site: 'center' }, line: 'P' }],
    )
    const t = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId).transform!
    expect(t.constraints.find((c) => c.id === 'c-mid')?.kind).toBe('midpoint')
    assertNoDangling(t)
  })

  it('names the dropped Midpoint in the flash notice', () => {
    const r = trimAtPoint(midDoc(), { x: 5, y: 0 }, 0.4, newId)
    expect(r.notice).toMatch(/dropped Midpoint \(line trimmed/)
  })
})

describe('trim repair - length dim conversion', () => {
  it('length dim on a split line converts to the kept piece (re-measured)', () => {
    const dims: SketchDimension[] = [
      { id: 'd-len', kind: 'distance', driving: true, value: 10,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } },
    ]
    const t = trimAtPoint(doc(splitBase(), [], dims), { x: 5, y: 0 }, 0.4, newId).transform!
    const dl = t.dimensions.find((x) => x.id === 'd-len')
    expect(dl).toBeDefined()
    if (dl?.kind === 'distance') {
      expect(dl.a).toEqual({ entityId: 'T', site: 'start' })
      expect(dl.b).toEqual({ entityId: 'T', site: 'end' })
      expect(dl.value).toBeCloseTo(3, 9)
    }
    assertNoDangling(t)
  })

  it('length dim survives a one-sided trim that removed its anchor end', () => {
    // Click right of the only cutter: the [3,10] span (with the END
    // anchor) is removed. The old behavior cascaded the dim away; the
    // conversion keeps it measuring the surviving piece [0,3].
    const dims: SketchDimension[] = [
      { id: 'd-len', kind: 'distanceX', driving: true, value: 10,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } },
    ]
    const d = doc([line('T', 0, 0, 10, 0), line('V1', 3, -5, 3, 5)], [], dims)
    const t = trimAtPoint(d, { x: 6, y: 0 }, 0.4, newId).transform!
    const tt = t.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(tt.end.x).toBeCloseTo(3, 9)
    const dl = t.dimensions.find((x) => x.id === 'd-len')
    expect(dl).toBeDefined()
    expect(dl!.value).toBeCloseTo(3, 9)
    assertNoDangling(t)
  })

  it('a distance dim to ANOTHER entity is not converted (site rules apply)', () => {
    const dims: SketchDimension[] = [
      { id: 'd-x', kind: 'distance', driving: true, value: 3,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'V1', site: 'start' } },
    ]
    const t = trimAtPoint(doc(splitBase(), [], dims), { x: 5, y: 0 }, 0.4, newId).transform!
    const dl = t.dimensions.find((x) => x.id === 'd-x')
    expect(dl).toBeDefined()
    if (dl?.kind === 'distance') {
      expect(dl.a).toEqual({ entityId: 'T', site: 'start' })
      expect(dl.b).toEqual({ entityId: 'V1', site: 'start' })
      expect(dl.value).toBe(3) // untouched
    }
    assertNoDangling(t)
  })
})

describe('trim repair - notices (repair transparency)', () => {
  it('names the dropped Equal in the flash notice', () => {
    const d = doc(
      [...splitBase(), line('P', 0, 5, 10, 5)],
      [{ id: 'c-eq', kind: 'equal', a: 'T', b: 'P' }],
    )
    const r = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId)
    expect(r.notice).toMatch(/^Trimmed Line 1: kept 0 constraints, /)
    expect(r.notice).toMatch(/dropped Equal \(lengths changed\)/)
  })

  it('reports the H/V propagation and counts the kept original', () => {
    const d = doc(splitBase(), [{ id: 'c-h', kind: 'horizontal', line: 'T' }])
    const r = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId)
    expect(r.notice).toMatch(/^Trimmed Line 1: kept 1 constraint, /)
    expect(r.notice).toMatch(/applied Horizontal to both pieces/)
  })

  it('reports the length-dim conversion', () => {
    const dims: SketchDimension[] = [
      { id: 'd-len', kind: 'distance', driving: true, value: 10,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } },
    ]
    const r = trimAtPoint(doc(splitBase(), [], dims), { x: 5, y: 0 }, 0.4, newId)
    expect(r.notice).toMatch(/length dim now measures the kept piece/)
  })

  it('reports the tangent move to the new piece', () => {
    const d = doc(
      [...splitBase(), circle('CB', 8.5, 2, 2)],
      [{ id: 'c-tan', kind: 'tangent', a: 'CB', b: 'T' }],
    )
    const r = trimAtPoint(d, { x: 5, y: 0 }, 0.4, newId)
    expect(r.notice).toMatch(/moved Tangent to the new piece/)
  })

  it('a plain trim with no repairs stays quiet (generic flash speaks)', () => {
    const r = trimAtPoint(doc(splitBase()), { x: 5, y: 0 }, 0.4, newId)
    expect(r.transform).not.toBeNull()
    expect(r.notice).toBeNull()
  })

  it('a swipe aggregates repair clauses across every trimmed span', () => {
    const d = doc(
      [
        line('R1', 0, 0, 20, 0),
        line('R2', 0, 10, 20, 10),
        line('V1', 5, -5, 5, 15),
        line('V2', 10, -5, 10, 15),
        line('V3', 15, -5, 15, 15),
      ],
      [
        { id: 'cv1', kind: 'vertical', line: 'V1' },
        { id: 'cv2', kind: 'vertical', line: 'V2' },
        { id: 'cv3', kind: 'vertical', line: 'V3' },
      ],
    )
    const r = trimSwipe(d, [{ x: 2, y: 5 }, { x: 18, y: 5 }], newId)
    expect(r.notice).toMatch(/^Trimmed 3 spans: /)
    expect(r.notice).toMatch(/applied Vertical to both pieces x3/)
  })
})
