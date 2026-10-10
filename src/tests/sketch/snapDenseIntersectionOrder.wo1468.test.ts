// WO-1468 / BUG-487 — dense intersection snapping must not depend on
// document (array) order.
//
// findSnap's intersection tier bounds the pairwise-intersection search to
// INTERSECTION_ENTITY_CAP entities so a huge document stays fast. Before this
// fix that cap sliced `q.entities` in ARRAY order: whichever near-curve
// entity happened to sit past index 12 was silently dropped regardless of
// how close it actually was to the cursor, so the same cursor position could
// find a different (or missing) intersection purely because of unrelated
// entity reordering (BUG-487). The fix sorts near-curve candidates by actual
// distance to the cursor before applying the cap, so the kept entities are
// always the closest ones.

import { describe, it, expect } from 'vitest'
import { findSnap, DEFAULT_SNAP_FLAGS, type SnapQuery } from '../../lib/sketch/snap'
import type { SketchEntity, Vec2 } from '../../lib/sketch/types'

// Same convention as snap.test.ts: worldPerPixel = 0.1 -> snap radius
// (tol) = SNAP_PX * 0.1 = 1 mm; the intersection tier's near-filter uses
// 2x that radius (2 mm).
const WPP = 0.1

function line(id: string, sx: number, sy: number, ex: number, ey: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } }
}

function query(cursor: Vec2, entities: SketchEntity[], extra?: Partial<SnapQuery>): SnapQuery {
  return {
    cursor,
    entities,
    gridSpacing: 25,
    worldPerPixel: WPP,
    flags: DEFAULT_SNAP_FLAGS,
    ...extra,
  }
}

/** 11 horizontal "filler" lines whose curve distance to the cursor (0,0) is
 *  between 1x and 2x tol: near enough to occupy a slot in the capped
 *  near-array, far enough that they never produce an actual snap candidate
 *  themselves (that always requires dist <= tol) and never coincide with an
 *  endpoint/midpoint within tol either (their perpendicular distance already
 *  exceeds tol, and endpoint distance can only be >= that). */
function fillerLines(): SketchEntity[] {
  const fillers: SketchEntity[] = []
  for (let i = 0; i < 11; i++) {
    const y = 1.15 + i * 0.08 // 1.15 .. 1.95, all in (TOL, 2*TOL]
    fillers.push(line(`filler-${i}`, -5, y, 9, y))
  }
  return fillers
}

describe('WO-1468: dense intersection snap is order-independent', () => {
  it('reproduces BUG-487: crossing pair last in the array misses the intersection on main', () => {
    // Crossing pair: Hclose (y=0) x V (x=0), meeting exactly at the cursor.
    // Their own midpoints/endpoints are kept far from the cursor so only the
    // intersection candidate can match.
    const hClose = line('h-close', -5, 0, 9, 0)
    const v = line('v', 0, -5, 0, 9)
    const fillers = fillerLines()
    const cursor: Vec2 = { x: 0, y: 0 }

    // 13 entities genuinely near the cursor (11 fillers + the crossing
    // pair) — one more than INTERSECTION_ENTITY_CAP (12).
    const orderCrossingFirst = query(cursor, [hClose, v, ...fillers])
    const orderCrossingLast = query(cursor, [...fillers, hClose, v])

    const first = findSnap(orderCrossingFirst)
    const last = findSnap(orderCrossingLast)

    // Both orders must find the SAME intersection, independent of where the
    // crossing pair sits in the array.
    for (const r of [first, last]) {
      expect(r).not.toBeNull()
      expect(r!.kind).toBe('intersection')
      expect(r!.point.x).toBeCloseTo(0, 9)
      expect(r!.point.y).toBeCloseTo(0, 9)
      expect(new Set(r!.sourceEntityIds)).toEqual(new Set(['h-close', 'v']))
    }
  })

  it('sparse scene (well under the cap) is unaffected', () => {
    const ents = [line('l1', -2, 0, 10, 0), line('l2', 0, -2, 0, 10)]
    const r = findSnap(query({ x: 0.4, y: 0.3 }, ents))
    expect(r!.kind).toBe('intersection')
    expect(r!.point.x).toBeCloseTo(0, 9)
    expect(r!.point.y).toBeCloseTo(0, 9)
    expect(new Set(r!.sourceEntityIds)).toEqual(new Set(['l1', 'l2']))
  })

  it('with MORE than 12 genuinely-near curves, keeps the closest 12 by distance even when the true-nearest curve is placed last', () => {
    const cursor: Vec2 = { x: 0, y: 0 }
    const v = line('v', 0, -5, 0, 9)
    // 13 "distractor" horizontal lines, all within the near-filter (dist in
    // (TOL, 2*TOL]) but none within snap tolerance on their own.
    const distractors: SketchEntity[] = []
    for (let i = 0; i < 13; i++) {
      const y = 1.05 + i * 0.07 // 1.05 .. 1.89
      distractors.push(line(`distractor-${i}`, -5, y, 9, y))
    }
    // The true nearest curve: dead on the cursor (dist 0), deliberately
    // placed LAST in the array, after v and all 13 distractors (15 near
    // entities total -- 3 over the cap of 12).
    const hNear = line('h-near', -5, 0, 9, 0)

    const q = query(cursor, [v, ...distractors, hNear])
    const r = findSnap(q)

    expect(r).not.toBeNull()
    expect(r!.kind).toBe('intersection')
    expect(new Set(r!.sourceEntityIds)).toEqual(new Set(['h-near', 'v']))
  })
})
