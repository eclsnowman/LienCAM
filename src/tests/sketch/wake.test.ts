// Hover-wake alignment references — headless coverage (Stage 4 user
// addition, standard editor "wake up inference references").
//
// Pins: the wakeRef set semantics (most-recent WAKE_CAP, re-wake refresh,
// no-change identity), the wake payload on point-site snaps, remote H/V
// alignment candidate generation off woken refs, the virtual-snap pinning
// math (pinned coordinate exact, free axis under the cursor), dual H+V
// intersection (woken ref + chain point), and the priority order (entity
// snaps beat woken alignment).

import { describe, it, expect } from 'vitest'
import {
  findSnap,
  wakeRef,
  WAKE_CAP,
  SNAP_PX,
  type SnapQuery,
  type WokenRef,
} from '../../lib/sketch/snap'
import type { SketchEntity, Vec2, PointRef } from '../../lib/sketch/types'

const WPP = 0.1
const TOL = SNAP_PX * WPP // 1 mm

function line(id: string, sx: number, sy: number, ex: number, ey: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } }
}

function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}

function woken(x: number, y: number, ref: PointRef | null): WokenRef {
  return { point: { x, y }, ref }
}

function query(cursor: Vec2, entities: SketchEntity[], extra?: Partial<SnapQuery>): SnapQuery {
  return {
    cursor,
    entities,
    gridSpacing: 25,
    worldPerPixel: WPP,
    flags: { entity: true, grid: false, inference: true },
    ...extra,
  }
}

const REF_A: PointRef = { entityId: 'l1', site: 'end' }
const REF_B: PointRef = { entityId: 'l2', site: 'start' }
const REF_C: PointRef = { entityId: 'p1', site: 'self' }
const REF_D: PointRef = { entityId: 'c1', site: 'center' }

describe('wakeRef set semantics', () => {
  it('appends new refs most-recent-last up to WAKE_CAP', () => {
    let s: readonly WokenRef[] = []
    s = wakeRef(s, woken(0, 0, REF_A))
    s = wakeRef(s, woken(1, 0, REF_B))
    s = wakeRef(s, woken(2, 0, REF_C))
    expect(s.map((w) => w.ref)).toEqual([REF_A, REF_B, REF_C])
    expect(s.length).toBe(WAKE_CAP)
  })

  it('waking a 4th ref drops the OLDEST', () => {
    let s: readonly WokenRef[] = []
    for (const [i, r] of [REF_A, REF_B, REF_C, REF_D].entries()) {
      s = wakeRef(s, woken(i, 0, r))
    }
    expect(s.length).toBe(WAKE_CAP)
    expect(s.map((w) => w.ref)).toEqual([REF_B, REF_C, REF_D])
  })

  it('re-waking an existing ref refreshes its recency without duplication', () => {
    let s: readonly WokenRef[] = []
    s = wakeRef(s, woken(0, 0, REF_A))
    s = wakeRef(s, woken(1, 0, REF_B))
    s = wakeRef(s, woken(0, 0, REF_A)) // re-wake A
    expect(s.map((w) => w.ref)).toEqual([REF_B, REF_A])
    s = wakeRef(s, woken(2, 0, REF_C))
    s = wakeRef(s, woken(3, 0, REF_D)) // cap: B (now oldest) drops, A survives
    expect(s.map((w) => w.ref)).toEqual([REF_A, REF_C, REF_D])
  })

  it('returns the SAME array when the ref is already most recent (no churn)', () => {
    let s: readonly WokenRef[] = []
    s = wakeRef(s, woken(0, 0, REF_A))
    const again = wakeRef(s, woken(0, 0, REF_A))
    expect(again).toBe(s)
  })

  it('position-only refs (ref null, line midpoints) key by position', () => {
    let s: readonly WokenRef[] = []
    s = wakeRef(s, woken(5, 5, null))
    s = wakeRef(s, woken(5, 5, null)) // same midpoint: no duplicate
    expect(s.length).toBe(1)
    s = wakeRef(s, woken(7, 7, null)) // different midpoint: appended
    expect(s.length).toBe(2)
  })
})

describe('wake payload on point-site snaps', () => {
  it('endpoint snap carries a wake payload with the point ref', () => {
    const r = findSnap(query({ x: 10.3, y: 0.2 }, [line('l1', 0, 0, 10, 0)]))
    expect(r!.kind).toBe('endpoint')
    expect(r!.wake).toEqual({ point: { x: 10, y: 0 }, ref: { entityId: 'l1', site: 'end' } })
  })

  it('line midpoint snap wakes with the line-center site ref (SKC-62: point-site picking needs the stable owner/site; the dim flow excludes midpoint refs at the toolController boundary instead)', () => {
    const r = findSnap(query({ x: 5.2, y: 0.3 }, [line('l1', 0, 0, 10, 0)]))
    expect(r!.kind).toBe('midpoint')
    // Pre-SKC-62 this carried ref:null to keep smart-dim whole-line
    // semantics. That protection now lives in toolController's
    // dimExplicitPoint construction (which skips kind==='midpoint'), so the
    // wake payload can carry the center site that point-site picking and
    // constraint inference need.
    expect(r!.wake).toEqual({ point: { x: 5, y: 0 }, ref: { entityId: 'l1', site: 'center' } })
  })

  it('alignment results never carry a wake payload', () => {
    const r = findSnap(
      query({ x: 30, y: 0.4 }, [], { wokenRefs: [woken(10, 0, REF_A)] })
    )
    expect(r!.kind).toBe('h-align')
    expect(r!.wake).toBeUndefined()
  })
})

describe('remote H/V alignment off woken refs', () => {
  it('h-align: pins Y to the woken ref, free X stays under the cursor', () => {
    const r = findSnap(
      query({ x: 42.7, y: 20.6 }, [], { wokenRefs: [woken(10, 20, REF_A)] })
    )
    expect(r!.kind).toBe('h-align')
    expect(r!.point).toEqual({ x: 42.7, y: 20 }) // exact pin + exact free axis
    expect(r!.inferences).toEqual([{ kind: 'horizontal', to: REF_A }])
    expect(r!.alignFrom).toEqual({ x: 10, y: 20 })
    expect(r!.alignFrom2).toBeUndefined()
  })

  it('v-align: pins X to the woken ref, free Y stays under the cursor', () => {
    const r = findSnap(
      query({ x: 9.4, y: -33.3 }, [], { wokenRefs: [woken(10, 20, REF_A)] })
    )
    expect(r!.kind).toBe('v-align')
    expect(r!.point).toEqual({ x: 10, y: -33.3 })
    expect(r!.inferences).toEqual([{ kind: 'vertical', to: REF_A }])
    expect(r!.alignFrom).toEqual({ x: 10, y: 20 })
  })

  it('does NOT align outside the tolerance', () => {
    const r = findSnap(
      query({ x: 42, y: 20 + TOL + 0.1 }, [], { wokenRefs: [woken(10, 20, REF_A)] })
    )
    expect(r).toBeNull()
  })

  it('does NOT align while hovering the woken ref itself', () => {
    const r = findSnap(
      query({ x: 10.2, y: 20.2 }, [], { wokenRefs: [woken(10, 20, REF_A)] })
    )
    expect(r).toBeNull() // entity tier owns that spot; nothing to align
  })

  it('closest source wins its axis when several woken refs hit', () => {
    const r = findSnap(
      query({ x: 50, y: 20.45 }, [], {
        wokenRefs: [woken(10, 20.6, REF_A), woken(0, 20.4, REF_B)],
      })
    )
    expect(r!.kind).toBe('h-align')
    expect(r!.point.y).toBe(20.4)
    expect(r!.inferences).toEqual([{ kind: 'horizontal', to: REF_B }])
  })

  it('position-only woken refs (midpoints) align with NO inference', () => {
    const r = findSnap(
      query({ x: 42, y: 20.3 }, [], { wokenRefs: [woken(10, 20, null)] })
    )
    expect(r!.kind).toBe('h-align')
    expect(r!.point).toEqual({ x: 42, y: 20 })
    expect(r!.inferences).toEqual([])
    expect(r!.alignFrom).toEqual({ x: 10, y: 20 })
  })

  it('woken alignment requires the inference flag (same gate as chain alignment)', () => {
    const r = findSnap(
      query({ x: 42, y: 20.3 }, [], {
        wokenRefs: [woken(10, 20, REF_A)],
        flags: { entity: true, grid: false, inference: false },
      })
    )
    expect(r).toBeNull()
  })
})

describe('dual H+V alignment intersection', () => {
  it('woken ref H + chain point V intersect: both coordinates pinned', () => {
    // Chain previous at (30, 0); woken ref at (10, 20). Cursor near
    // x=30 AND y=20 -> the snap is their intersection (30, 20).
    const r = findSnap(
      query({ x: 30.4, y: 19.8 }, [], {
        alignRef: { x: 30, y: 0 },
        wokenRefs: [woken(10, 20, REF_A)],
      })
    )
    expect(r!.point).toEqual({ x: 30, y: 20 })
    expect(r!.inferences).toEqual([
      { kind: 'horizontal', to: REF_A }, // two-point H to the woken ref
      { kind: 'vertical' },              // new line V off the chain point
    ])
    // alignFrom carries the CHAIN source (inference.ts resolves the new
    // line against it); the woken source rides alignFrom2.
    expect(r!.alignFrom).toEqual({ x: 30, y: 0 })
    expect(r!.alignFrom2).toEqual({ x: 10, y: 20 })
  })

  it('two woken refs intersect with two two-point inferences', () => {
    const r = findSnap(
      query({ x: 30.3, y: 20.4 }, [], {
        wokenRefs: [woken(10, 20, REF_A), woken(30, -50, REF_B)],
      })
    )
    expect(r!.point).toEqual({ x: 30, y: 20 })
    expect(r!.inferences).toEqual([
      { kind: 'horizontal', to: REF_A },
      { kind: 'vertical', to: REF_B },
    ])
  })

  it('same source supplying H AND V keeps only the closer axis', () => {
    // Cursor diagonally near the woken ref (both dx, dy within tol but
    // outside the ref-proximity guard): intersecting would land ON the
    // ref itself — the entity tier's business, not alignment's.
    const r = findSnap(
      query({ x: 10.9, y: 20.6 }, [], { wokenRefs: [woken(10, 20, REF_A)] })
    )
    expect(r!.kind).toBe('h-align') // dy 0.6 < dx 0.9
    expect(r!.point).toEqual({ x: 10.9, y: 20 })
    expect(r!.inferences).toEqual([{ kind: 'horizontal', to: REF_A }])
    expect(r!.alignFrom2).toBeUndefined()
  })
})

describe('priority: entity snaps beat woken alignment', () => {
  it('an endpoint within radius wins over a woken h-align through it', () => {
    // p1 sits exactly on the woken ref's Y; cursor is near BOTH the
    // point entity and the alignment line — the entity snap must win.
    const r = findSnap(
      query({ x: 40.3, y: 20.2 }, [point('p1', 40, 20)], {
        wokenRefs: [woken(10, 20, REF_A)],
      })
    )
    expect(r!.kind).toBe('endpoint')
    expect(r!.point).toEqual({ x: 40, y: 20 })
    expect(r!.inferences).toEqual([
      { kind: 'coincident', to: { entityId: 'p1', site: 'self' } },
    ])
  })

  it('woken alignment beats grid', () => {
    // Grid pitch 10 puts a grid point (50, 20) right under the cursor,
    // but the alignment tier answers before the grid tier.
    const r = findSnap(
      query({ x: 50.4, y: 20.3 }, [], {
        gridSpacing: 10,
        wokenRefs: [woken(10, 20, REF_A)],
        flags: { entity: true, grid: true, inference: true },
      })
    )
    expect(r!.kind).toBe('h-align')
    expect(r!.point).toEqual({ x: 50.4, y: 20 })
  })
})
