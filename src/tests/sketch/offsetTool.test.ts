// Sketch offset tool (interaction framework rework: select - side -
// confirm). Exact per-entity offsets (parallel line / concentric arc /
// concentric circle), bake-identical chaining, and the documented corner
// policy — fillet arc (R = distance, centered on the original corner)
// where consecutive offsets DIVERGE, exact intersection trim where they
// OVERLAP. New entities chain among THEMSELVES with coincident
// constraints but carry NO constraints to the source.
//
// Flow: click selects the chain, the next click LOCKS the cursor's side,
// and the confirm overlay's OK (offsetApply) commits at the editable
// distance. The locked-side ghost (offsetPreview) is built from the SAME
// computeOffset as the commit.

import { describe, it, expect } from 'vitest'
import {
  offsetClick, offsetApply, offsetPreview, offsetSeedFromSelection,
  computeOffset, chainSide,
  type OffsetChainState, type OffsetSource,
} from '../../lib/sketch/tools/offsetTool'
import type {
  Vec2, SketchEntity, SketchConstraint,
  SketchArcEntity, SketchCircleEntity, SketchLineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `o-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
  construction = false,
): SketchLineEntity {
  return {
    id, kind: 'line', construction,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

/** Closed 10x10 rectangle (0,0)-(10,10), CCW, geometrically coincident
 *  corners (the bake chains on geometry too — no constraints needed). */
function rect(): SketchEntity[] {
  return [
    line('b', 0, 0, 10, 0),
    line('r', 10, 0, 10, 10),
    line('t', 10, 10, 0, 10),
    line('l', 0, 10, 0, 0),
  ]
}

function selectChain(
  entities: SketchEntity[], at: Vec2, constraints: SketchConstraint[] = [],
): OffsetChainState {
  const r = offsetClick(null, entities, constraints, at, 0.5)
  expect(r.chain).not.toBeNull()
  expect(r.chain!.lockedSide).toBeNull()
  return r.chain!
}

type OffsetCommit = { entities: SketchEntity[]; constraints: SketchConstraint[] }

/** Lock the side under `cursor`, then apply at `distance` — the full
 *  side-confirm flow as the store drives it. */
function lockApply(
  chain: OffsetChainState, ents: SketchEntity[], cursor: Vec2, distance: number,
): OffsetCommit | string {
  const locked = offsetClick(chain, ents, [], cursor, 0.5)
  expect(locked.chain).not.toBeNull()
  expect(locked.chain!.lockedSide).not.toBeNull()
  return offsetApply(locked.chain!, distance, newId)
}

function commitOf(r: OffsetCommit | string): OffsetCommit {
  expect(typeof r).not.toBe('string')
  return r as OffsetCommit
}

function lines(ents: SketchEntity[]): SketchLineEntity[] {
  return ents.filter((e): e is SketchLineEntity => e.kind === 'line')
}

function arcs(ents: SketchEntity[]): SketchArcEntity[] {
  return ents.filter((e): e is SketchArcEntity => e.kind === 'arc')
}

describe('offset - closed rectangle', () => {
  it('outward: 4 parallel lines + 4 corner arcs (R = distance) centered on the corners', () => {
    const ents = rect()
    const chain = selectChain(ents, { x: 5, y: 0 })
    // Lock the side OUTSIDE the rectangle: offset lands outside.
    const commit = commitOf(lockApply(chain, ents, { x: 5, y: -3 }, 2))
    const out = commit.entities
    const ls = lines(out)
    const as = arcs(out)
    expect(ls).toHaveLength(4)
    expect(as).toHaveLength(4)
    // Every offset line is 2mm outside its source: the bottom line's
    // offset sits at y = -2 spanning x 0..10 (corner arcs cover the rest).
    const bottom = ls.find((e) => Math.abs(e.start.y + 2) < 1e-9 && Math.abs(e.end.y + 2) < 1e-9)
    expect(bottom).toBeDefined()
    const xs = [bottom!.start.x, bottom!.end.x].sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 9)
    expect(xs[1]).toBeCloseTo(10, 9)
    // Corner arcs: R2 centered on the ORIGINAL corners, each sweeping 90 deg.
    const corners = [[0, 0], [10, 0], [10, 10], [0, 10]]
    for (const a of as) {
      expect(a.radius).toBeCloseTo(2, 9)
      const hit = corners.find(([x, y]) =>
        Math.abs(a.center.x - x) < 1e-9 && Math.abs(a.center.y - y) < 1e-9)
      expect(hit).toBeDefined()
      const sweep = ((a.endAngle - a.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
      expect(sweep).toBeCloseTo(Math.PI / 2, 9)
    }
    // The new chain is coincident-constrained at its own 8 joints, and no
    // constraint references a SOURCE entity.
    const coincs = commit.constraints.filter((c) => c.kind === 'coincident')
    expect(coincs).toHaveLength(8)
    const newIds = new Set(out.map((e) => e.id))
    for (const c of coincs) {
      if (c.kind !== 'coincident') continue
      expect(newIds.has(c.a.entityId)).toBe(true)
      expect(newIds.has(c.b.entityId)).toBe(true)
    }
  })

  it('inward: plain shrunk rectangle (4 lines, intersection-trimmed corners, no arcs)', () => {
    const ents = rect()
    const chain = selectChain(ents, { x: 5, y: 0 })
    const commit = commitOf(lockApply(chain, ents, { x: 5, y: 5 }, 2))
    const out = commit.entities
    expect(arcs(out)).toHaveLength(0)
    const ls = lines(out)
    expect(ls).toHaveLength(4)
    // Every vertex of the shrunk rect is a corner of (2,2)-(8,8).
    for (const e of ls) {
      for (const p of [e.start, e.end]) {
        expect([2, 8]).toContainEqual(Math.round(p.x * 1e9) / 1e9)
        expect([2, 8]).toContainEqual(Math.round(p.y * 1e9) / 1e9)
      }
    }
    // 4 corner coincidents, all among the new entities.
    expect(commit.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(4)
  })

  it('inward offset >= half the rectangle is rejected with a reason, flow kept', () => {
    const ents = rect()
    const chain = selectChain(ents, { x: 5, y: 0 })
    const r = lockApply(chain, ents, { x: 5, y: 5 }, 6)
    expect(typeof r).toBe('string')
    expect(r as string).toMatch(/too large|cannot trim/)
  })

  it('preview-equals-commit: the locked-side ghost lies on the committed geometry', () => {
    const ents = rect()
    const chain = selectChain(ents, { x: 5, y: 0 })
    const locked = offsetClick(chain, ents, [], { x: 5, y: 5 }, 0.5).chain!
    const ghost = offsetPreview(locked, { x: 99, y: 99 }, 2)! // cursor ignored once locked
    // Inward 2mm: every ghost point sits on the (2,2)-(8,8) boundary.
    for (const p of ghost) {
      const onX = Math.abs(p.x - 2) < 1e-9 || Math.abs(p.x - 8) < 1e-9
      const onY = Math.abs(p.y - 2) < 1e-9 || Math.abs(p.y - 8) < 1e-9
      expect(onX || onY).toBe(true)
    }
    const commit = commitOf(offsetApply(locked, 2, newId))
    expect(commit.entities).toHaveLength(4)
  })

  it('clicking again while locked RE-LOCKS to the new cursor side', () => {
    const ents = rect()
    const chain = selectChain(ents, { x: 5, y: 0 })
    const locked = offsetClick(chain, ents, [], { x: 5, y: 5 }, 0.5).chain!
    const flipped = offsetClick(locked, ents, [], { x: 5, y: -3 }, 0.5).chain!
    expect(flipped.lockedSide).not.toBeNull()
    expect(flipped.lockedSide).not.toBe(locked.lockedSide)
  })
})

describe('offset - circle', () => {
  it('outward lock = concentric grown circle; inward lock = shrunk', () => {
    const ents = [circle('c1', 5, 5, 4)]
    const grow = commitOf(
      lockApply(selectChain(ents, { x: 9, y: 5 }), ents, { x: 12, y: 5 }, 2))
    const g = grow.entities[0] as SketchCircleEntity
    expect(g.kind).toBe('circle')
    expect(g.center).toEqual({ x: 5, y: 5 })
    expect(g.radius).toBeCloseTo(6, 9)
    const shrink = commitOf(
      lockApply(selectChain(ents, { x: 9, y: 5 }), ents, { x: 5, y: 5 }, 2))
    const s = shrink.entities[0] as SketchCircleEntity
    expect(s.radius).toBeCloseTo(2, 9)
    // A circle offset carries no constraints at all.
    expect(grow.constraints).toHaveLength(0)
  })

  it('rejects a distance that collapses the circle', () => {
    const ents = [circle('c1', 5, 5, 4)]
    const r = lockApply(selectChain(ents, { x: 9, y: 5 }), ents, { x: 5, y: 5 }, 5)
    expect(typeof r).toBe('string')
    expect(r as string).toMatch(/collapses/)
  })
})

describe('offset - open polyline', () => {
  // L-shape: (0,0)->(10,0)->(10,10). Convex on the lower-right side,
  // concave on the upper-left side.
  const lShape = () => [line('a', 0, 0, 10, 0), line('b', 10, 0, 10, 10)]

  it('convex side: two exact parallels joined by a corner arc at the elbow', () => {
    const ents = lShape()
    const chain = selectChain(ents, { x: 5, y: 0 })
    const commit = commitOf(lockApply(chain, ents, { x: 11, y: -1 }, 2))
    const out = commit.entities
    const ls = lines(out)
    const as = arcs(out)
    expect(ls).toHaveLength(2)
    expect(as).toHaveLength(1)
    // Horizontal leg offsets to y=-2 over its FULL original span (open
    // ends are left square, no extension).
    const h = ls.find((e) => Math.abs(e.start.y + 2) < 1e-9 && Math.abs(e.end.y + 2) < 1e-9)!
    expect(h).toBeDefined()
    expect(Math.min(h.start.x, h.end.x)).toBeCloseTo(0, 9)
    expect(Math.max(h.start.x, h.end.x)).toBeCloseTo(10, 9)
    // Vertical leg offsets to x=12.
    const v = ls.find((e) => Math.abs(e.start.x - 12) < 1e-9 && Math.abs(e.end.x - 12) < 1e-9)!
    expect(v).toBeDefined()
    // Elbow arc centered on the original corner (10,0).
    expect(as[0].center.x).toBeCloseTo(10, 9)
    expect(as[0].center.y).toBeCloseTo(0, 9)
    expect(as[0].radius).toBeCloseTo(2, 9)
    // Open chain of 3 pieces: 2 joints, both coincident-constrained.
    expect(commit.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(2)
  })

  it('concave side: the two parallels trim to their exact intersection', () => {
    const ents = lShape()
    const chain = selectChain(ents, { x: 5, y: 0 })
    const commit = commitOf(lockApply(chain, ents, { x: 5, y: 2 }, 2))
    const out = commit.entities
    expect(arcs(out)).toHaveLength(0)
    const ls = lines(out)
    expect(ls).toHaveLength(2)
    // Trim point = (8, 2): both offsets meet there exactly.
    const h = ls.find((e) => Math.abs(e.start.y - 2) < 1e-9 && Math.abs(e.end.y - 2) < 1e-9)!
    const v = ls.find((e) => Math.abs(e.start.x - 8) < 1e-9 && Math.abs(e.end.x - 8) < 1e-9)!
    expect(Math.max(h.start.x, h.end.x)).toBeCloseTo(8, 9)
    expect(Math.min(v.start.y, v.end.y)).toBeCloseTo(2, 9)
  })

  it('single line: exact parallel on the locked side, both sides', () => {
    const ents = [line('a', 0, 0, 10, 0)]
    const above = commitOf(
      lockApply(selectChain(ents, { x: 5, y: 0 }), ents, { x: 5, y: 3 }, 1.5))
    const la = above.entities[0] as SketchLineEntity
    expect(la.start.y).toBeCloseTo(1.5, 9)
    expect(la.end.y).toBeCloseTo(1.5, 9)
    const below = commitOf(
      lockApply(selectChain(ents, { x: 5, y: 0 }), ents, { x: 5, y: -3 }, 1.5))
    const lb = below.entities[0] as SketchLineEntity
    expect(lb.start.y).toBeCloseTo(-1.5, 9)
    expect(lb.end.y).toBeCloseTo(-1.5, 9)
  })
})

describe('offset - picking, exclusions, seeding', () => {
  it('construction entities are excluded with a notice', () => {
    const ents = [line('a', 0, 0, 10, 0, true)]
    const r = offsetClick(null, ents, [], { x: 5, y: 0 }, 0.5)
    expect(r.chain).toBeNull()
    expect(r.notice).toMatch(/construction/)
  })

  it('empty first click is quiet', () => {
    const r = offsetClick(null, rect(), [], { x: 50, y: 50 }, 0.5)
    expect(r.chain).toBeNull()
    expect(r.notice).toBeNull()
  })

  it('clicking one entity selects the WHOLE chained loop (bake chaining)', () => {
    const ents = rect()
    const chain = selectChain(ents, { x: 5, y: 0 })
    expect(chain.source.kind).toBe('chain')
    if (chain.source.kind !== 'chain') return
    expect(chain.source.steps).toHaveLength(4)
    expect(chain.source.closed).toBe(true)
  })

  it('offsetSeedFromSelection: first selected curve seeds its chain', () => {
    const ents = rect()
    const src = offsetSeedFromSelection(ents, [], ['b'])!
    expect(src.kind).toBe('chain')
    if (src.kind !== 'chain') return
    expect(src.steps).toHaveLength(4)
    // Construction-only / empty selections seed nothing.
    expect(offsetSeedFromSelection([line('c', 0, 0, 5, 0, true)], [], ['c'])).toBeNull()
    expect(offsetSeedFromSelection(ents, [], [])).toBeNull()
  })

  it('applying without a locked side refuses with a reason', () => {
    const chain = selectChain(rect(), { x: 5, y: 0 })
    const r = offsetApply(chain, 2, newId)
    expect(typeof r).toBe('string')
    expect(r as string).toMatch(/side/)
  })
})

describe('offset - side resolution', () => {
  it('chainSide reports the cursor side of the traversal', () => {
    const ents = [line('a', 0, 0, 10, 0)]
    const chain = selectChain(ents, { x: 5, y: 0 })
    const src: OffsetSource = chain.source
    const sideUp = chainSide(src, { x: 5, y: 2 })
    const sideDown = chainSide(src, { x: 5, y: -2 })
    expect(sideUp).not.toBe(sideDown)
  })

  it('computeOffset arc radii: left of CCW traversal shrinks, right grows', () => {
    // Quarter arc, CCW from 0 to 90 deg, R10 at the origin.
    const arc: SketchEntity = {
      id: 'arc', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2,
    }
    const src: OffsetSource = {
      kind: 'chain', steps: [{ entity: arc as SketchArcEntity, forward: true }], closed: false,
    }
    const left = computeOffset(src, 1, 2)
    const right = computeOffset(src, -1, 2)
    expect(typeof left).not.toBe('string')
    expect(typeof right).not.toBe('string')
    if (typeof left === 'string' || typeof right === 'string') return
    expect((left.pieces[0] as { radius: number }).radius).toBeCloseTo(8, 9)
    expect((right.pieces[0] as { radius: number }).radius).toBeCloseTo(12, 9)
  })
})
