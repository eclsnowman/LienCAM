import { describe, it, expect, vi } from 'vitest'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import type { FeatureResult, AdaptivePass, FinishApproach } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

// --- builders -----------------------------------------------------------------

function ctx(over: Partial<EmitContext> = {}): EmitContext {
  return {
    heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
    feeds: { feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 1000, leadOutRate: 1000, fastTraverseRate: 5000, finishRate: 1000 },
    stepdown: 2,
    helixAngleDeg: 3,
    ...over,
  }
}

function result(
  passes: AdaptivePass[],
  finishClearedRegions?: ('inside' | 'outside')[],
): FeatureResult {
  return {
    startPoint: passes.length ? { x: 0, y: 0 } : null,
    entries: [],
    passes,
    finishClearedRegions,
    cleared: [],
    cutRegion: [],
    residual: [],
    stats: { passes: 0, points: 0, cacheHits: 0, cacheMisses: 0, residualArea: 0, residualMaxInscribedR: 0 },
  }
}

const helixEntry: AdaptivePass = { type: 'entry', point: { x: 0, y: 0 }, radius: 2, mode: 'helix' }
const smallHelixEntry: AdaptivePass = { type: 'entry', point: { x: 0, y: 0 }, radius: 0.1, mode: 'helix' }
const plungeEntry: AdaptivePass = { type: 'entry', point: { x: 0, y: 0 }, radius: 0, mode: 'plunge' }
const cut3: AdaptivePass = { type: 'cut', points: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] }
const finishSquare: AdaptivePass = {
  type: 'finish',
  points: [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    { x: 0, y: 10 }, { x: 0, y: 0 },
  ],
}

function ccwSweep(
  start: { x: number; y: number },
  end: { x: number; y: number },
  center: { x: number; y: number },
): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  const raw = a1 - a0
  return raw >= 0 ? raw : raw + 2 * Math.PI
}

function polygonArea(points: { x: number; y: number }[]): number {
  let twiceArea = 0
  for (let i = 0; i + 1 < points.length; i++) {
    twiceArea += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y
  }
  return twiceArea / 2
}

function pathLength(points: { x: number; y: number }[]): number {
  let length = 0
  for (let i = 0; i + 1 < points.length; i++) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y)
  }
  return length
}

// --- tests --------------------------------------------------------------------

describe('emitFeature', () => {
  it('returns no moves for an empty/aborted result', () => {
    expect(emitFeature(result([]), ctx())).toEqual([])
  })

  it('emits a helix entry that descends monotonically to the level depth', () => {
    const moves = emitFeature(result([helixEntry, cut3]), ctx({ stepdown: 5 })) // single level 0 -> -2
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix.length).toBeGreaterThan(2)
    // Z is non-increasing along the spiral and reaches bottomZ at the end.
    for (let i = 1; i < helix.length; i++) expect(helix[i].z).toBeLessThanOrEqual(helix[i - 1].z + 1e-9)
    expect(helix[helix.length - 1].z).toBeCloseTo(-2, 6)
  })

  it('uses a straight plunge (no helix) for a plunge-mode entry', () => {
    const moves = emitFeature(result([plungeEntry, cut3]), ctx({ stepdown: 5 }))
    expect(moves.some(m => m.role === 'helix')).toBe(false)
    expect(moves.some(m => m.role === 'plunge')).toBe(true)
  })

  it('falls back to a straight plunge when the planned helix is below the historical floor', () => {
    const moves = emitFeature(result([smallHelixEntry, cut3]), ctx({ stepdown: 5 }))
    expect(moves.some(m => m.role === 'helix')).toBe(false)
    expect(moves.some(m => m.role === 'plunge')).toBe(true)
  })

  it('accepts a small planned helix when the configured floor is lower', () => {
    const moves = emitFeature(result([smallHelixEntry, cut3]), ctx({
      stepdown: 5,
      minHelixRadius: 0.05,
    }))
    expect(moves.some(m => m.role === 'helix')).toBe(true)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'uses the historical helix floor for invalid value %s',
    (minHelixRadius) => {
      const moves = emitFeature(result([smallHelixEntry, cut3]), ctx({
        stepdown: 5,
        minHelixRadius,
      }))
      expect(moves.some(m => m.role === 'helix')).toBe(false)
      expect(moves.some(m => m.role === 'plunge')).toBe(true)
    },
  )

  it('cuts at the level depth and returns to clearance at the end', () => {
    const moves = emitFeature(result([helixEntry, cut3]), ctx({ stepdown: 5 }))
    const cuts = moves.filter(m => m.role === 'cut')
    expect(cuts.length).toBe(3)
    for (const m of cuts) {
      expect(m.type).toBe('feed')
      expect(m.feed).toBe(1000)
      expect(m.z).toBeCloseTo(-2, 6)
    }
    expect(moves[moves.length - 1]).toMatchObject({ type: 'rapid', z: 15, role: 'rapid' })
  })

  it('replays the 2D path once per depth level', () => {
    // top 0 -> bottom -4 with stepdown 2 = two levels (-2, -4).
    const moves = emitFeature(result([helixEntry, cut3]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -4 },
      stepdown: 2,
    }))
    const cutZs = moves.filter(m => m.role === 'cut').map(m => m.z)
    expect(cutZs.length).toBe(6) // 3 points x 2 levels
    expect(cutZs.filter(z => Math.abs(z - -2) < 1e-6).length).toBe(3)
    expect(cutZs.filter(z => Math.abs(z - -4) < 1e-6).length).toBe(3)
  })

  it('replays cut/link/entry once at trueBottom and tags floor cuts as finish', () => {
    const link1: AdaptivePass = {
      type: 'link',
      points: [{ x: 3, y: 0 }, { x: 5, y: 0 }],
      jumpType: 1,
    }
    const wallFollow: AdaptivePass = {
      type: 'wallfollow',
      points: [{ x: 3, y: 0 }, { x: 4, y: 1 }],
    }
    const moves = emitFeature(result([plungeEntry, cut3, link1, cut3, wallFollow]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -4.5 },
      stepdown: 3,
      floorFinishDepth: -6,
    }))

    const roughCuts = moves.filter(m => m.role === 'cut')
    expect(roughCuts).toHaveLength(12) // 2 cut passes x 3 points x 2 rough levels
    expect(new Set(roughCuts.map(m => m.z))).toEqual(new Set([-3, -4.5]))

    const floorCuts = moves.filter(m => m.role === 'finish')
    expect(floorCuts).toHaveLength(8) // 6 primary + 2 wall-follow floor cuts, one replay
    expect(floorCuts.every(m => m.z === -6 && m.feed === undefined)).toBe(true)
    expect(moves.filter(m => m.role === 'wall_follow' && m.z === -6)).toHaveLength(0)
    expect(moves.filter(m => m.role === 'wall_follow')).toHaveLength(4) // rough levels unchanged
    expect(moves.filter(m => m.role === 'fast_traverse' && m.z === -6)).toHaveLength(1)
    expect(moves.filter(m => m.role === 'plunge' && m.z === -6)).toHaveLength(1)
    expect(moves[moves.length - 1]).toMatchObject({ type: 'rapid', z: 15, role: 'rapid' })
    for (const m of moves) {
      expect(m.z).toBeGreaterThanOrEqual(-6 - 1e-6)
      expect(m.z).toBeLessThanOrEqual(15 + 1e-6)
    }
  })

  it('honors a lowered helix floor during both roughing and floor-finish replay', () => {
    const moves = emitFeature(result([smallHelixEntry, cut3]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
      stepdown: 2,
      minHelixRadius: 0.05,
      floorFinishDepth: -4,
    }))

    const helixZs = moves.filter(m => m.role === 'helix').map(m => m.z)
    expect(helixZs.length).toBeGreaterThan(4)
    expect(helixZs.some(z => z === -2)).toBe(true)
    expect(helixZs.some(z => z === -4)).toBe(true)
  })

  it('fails loud when axial stock leaves no rough depth before floor cleanup', () => {
    expect(() => emitFeature(result([plungeEntry, cut3]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: 0 },
      floorFinishDepth: -6,
    }))).toThrow(/floorFinish.*no rough depth.*reduce floor stock/i)
  })

  it('schedules wall finishing at rough depths plus trueBottom without equal-depth duplicates', () => {
    const wallDepths = (moves: ReturnType<typeof emitFeature>): number[] =>
      moves
        .filter(m => m.role === 'finish' && m.x === 10)
        .map(m => m.z)

    const raisedRoughFloor = {
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -4.5 },
      stepdown: 3,
      floorFinishDepth: -6,
    }
    const finalOnly = emitFeature(result([plungeEntry, cut3, finishSquare]), ctx({
      ...raisedRoughFloor,
      wallFinishMode: 'final',
    }))
    expect(new Set(wallDepths(finalOnly))).toEqual(new Set([-6]))
    expect(wallDepths(finalOnly).filter(z => z === -6)).toHaveLength(2)

    const eachRaised = emitFeature(result([plungeEntry, cut3, finishSquare]), ctx({
      ...raisedRoughFloor,
      wallFinishMode: 'each_stepdown',
    }))
    expect(new Set(wallDepths(eachRaised))).toEqual(new Set([-3, -4.5, -6]))

    const equalBottom = emitFeature(result([plungeEntry, cut3, finishSquare]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -6 },
      stepdown: 3,
      floorFinishDepth: -6,
      wallFinishMode: 'each_stepdown',
    }))
    expect(new Set(wallDepths(equalBottom))).toEqual(new Set([-3, -6]))
    expect(wallDepths(equalBottom).filter(z => z === -6)).toHaveLength(2)
  })

  it('emits a jumpType-1 keep-down link as a fast_traverse move with NO baked feed', () => {
    const link1: AdaptivePass = { type: 'link', points: [{ x: 3, y: 0 }, { x: 5, y: 0 }], jumpType: 1 }
    const moves = emitFeature(result([helixEntry, cut3, link1, cut3]), ctx({ stepdown: 5 }))
    const traverses = moves.filter(m => m.role === 'fast_traverse')
    expect(traverses.length).toBe(1)
    // Non-cutting reposition at depth: it stays down (z = -2) and carries the move type
    // only. The operation must NOT hardcode a feedrate -- that is the postprocessor's job.
    expect(traverses[0]).toMatchObject({ type: 'feed', x: 5, y: 0, z: -2 })
    expect(traverses[0].feed).toBeUndefined()
    // It is not mislabelled as a cutting stepover.
    expect(moves.some(m => m.role === 'stepover')).toBe(false)
  })

  it('lifts to clearance, rapids across, and plunges for a jumpType-2 link', () => {
    const link2: AdaptivePass = { type: 'link', points: [{ x: 3, y: 0 }, { x: 9, y: 9 }], jumpType: 2 }
    const moves = emitFeature(result([helixEntry, cut3, link2, cut3]), ctx({ stepdown: 5 }))
    const i = moves.findIndex(m => m.type === 'rapid' && m.z === 15 && m.x === 3 && m.y === 0)
    expect(i).toBeGreaterThan(0)
    expect(moves[i + 1]).toMatchObject({ type: 'rapid', x: 9, y: 9, z: 15 })
    expect(moves[i + 2]).toMatchObject({ type: 'feed', x: 9, y: 9, z: -2, feed: 300, role: 'plunge' })
  })

  it('WO-437: a jumpType-2 link with microLift hops at passEndDepth + z instead of clearance', () => {
    const link2: AdaptivePass = {
      type: 'link', points: [{ x: 3, y: 0 }, { x: 9, y: 9 }], jumpType: 2, microLift: { z: 2 },
    }
    const moves = emitFeature(result([helixEntry, cut3, link2, cut3]), ctx({ stepdown: 5 }))
    // passEndDepth is -2 at this single level; stay-down height is -2 + 2 = 0, NOT clearanceZ (15).
    const i = moves.findIndex(m => m.type === 'rapid' && m.z === 0 && m.x === 3 && m.y === 0)
    expect(i).toBeGreaterThan(0)
    expect(moves[i + 1]).toMatchObject({ type: 'rapid', x: 9, y: 9, z: 0 })
    // The gated descent itself (plunge role, final depth) is untouched.
    expect(moves[i + 2]).toMatchObject({ type: 'feed', x: 9, y: 9, z: -2, feed: 300, role: 'plunge' })
    // The link's own two rapids never fly to full clearance when microLift is present
    // (a later end-of-feature retract to clearanceZ is a separate, legitimate move).
    expect(moves[i]).not.toMatchObject({ z: 15 })
    expect(moves[i + 1]).not.toMatchObject({ z: 15 })
  })

  it('WO-437: an absent microLift field keeps the jumpType-2 link byte-identical to full clearance', () => {
    const withField: AdaptivePass = { type: 'link', points: [{ x: 3, y: 0 }, { x: 9, y: 9 }], jumpType: 2 }
    const withUndefinedField: AdaptivePass = {
      type: 'link', points: [{ x: 3, y: 0 }, { x: 9, y: 9 }], jumpType: 2, microLift: undefined,
    }
    const a = emitFeature(result([helixEntry, cut3, withField, cut3]), ctx({ stepdown: 5 }))
    const b = emitFeature(result([helixEntry, cut3, withUndefinedField, cut3]), ctx({ stepdown: 5 }))
    expect(b).toEqual(a)
    // Both rapids still fly to full clearance (15), matching today's behavior exactly.
    const i = a.findIndex(m => m.type === 'rapid' && m.z === 15 && m.x === 3 && m.y === 0)
    expect(i).toBeGreaterThan(0)
    expect(a[i + 1]).toMatchObject({ type: 'rapid', x: 9, y: 9, z: 15 })
  })

  it('skips a link that is immediately followed by an entry (entry owns the reposition)', () => {
    const link2: AdaptivePass = { type: 'link', points: [{ x: 3, y: 0 }, { x: 9, y: 9 }], jumpType: 2 }
    const reseedEntry: AdaptivePass = { type: 'entry', point: { x: 9, y: 9 }, radius: 2, mode: 'helix' }
    const withLink = emitFeature(result([helixEntry, cut3, link2, reseedEntry, cut3]), ctx({ stepdown: 5 }))
    // The link's rapid-across to (9,9) at clearance must NOT appear as a standalone link
    // move; only the entry's own approach to its helix start should reposition.
    const acrossAtClearance = withLink.filter(m => m.type === 'rapid' && m.z === 15 && m.x === 9 && m.y === 9)
    expect(acrossAtClearance.length).toBe(0)
  })

  it('keeps every emitted Z within [bottomZ, clearanceZ]', () => {
    const link2: AdaptivePass = { type: 'link', points: [{ x: 3, y: 0 }, { x: 9, y: 9 }], jumpType: 2 }
    const moves = emitFeature(result([helixEntry, cut3, link2, cut3]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -4 }, stepdown: 2,
    }))
    for (const m of moves) {
      expect(m.z).toBeGreaterThanOrEqual(-4 - 1e-6)
      expect(m.z).toBeLessThanOrEqual(15 + 1e-6)
    }
  })

  it('keeps the legacy finish stream byte-identical when both lead radii are zero', () => {
    const expected = [
      { type: 'feed', x: 0, y: 0, z: -2, role: 'finish' },
      { type: 'feed', x: 10, y: 0, z: -2, role: 'finish' },
      { type: 'feed', x: 10, y: 10, z: -2, role: 'finish' },
      { type: 'feed', x: 0, y: 10, z: -2, role: 'finish' },
      { type: 'feed', x: 0, y: 0, z: -2, role: 'finish' },
      { type: 'rapid', x: 0, y: 0, z: 15, role: 'rapid' },
    ]

    const legacy = emitFeature(result([finishSquare]), ctx())
    const explicitZero = emitFeature(result([finishSquare]), ctx({
      finishLeadInRadius: 0,
      finishLeadOutRadius: 0,
    }))

    expect(legacy).toEqual(expected)
    expect(explicitZero).toEqual(expected)
  })

  it('keeps the entire legacy stream byte-identical when floor finishing is absent', () => {
    const omitted = emitFeature(result([helixEntry, cut3, finishSquare]), ctx())
    const explicitUndefined = emitFeature(result([helixEntry, cut3, finishSquare]), ctx({
      floorFinishDepth: undefined,
    }))
    expect(explicitUndefined).toEqual(omitted)
  })

  it('emits tangent <=90deg finish lead arcs with distinct roles/rates and unchanged contour winding', () => {
    const feeds = {
      ...ctx().feeds,
      leadInRate: 321,
      leadOutRate: 654,
      finishRate: 777,
    }
    const moves = emitFeature(result([finishSquare]), ctx({
      feeds,
      finishLeadInRadius: 2,
      finishLeadOutRadius: 2,
    }))

    const leadIn = moves.filter(m => m.role === 'lead_in')
    const finish = moves.filter(m => m.role === 'finish')
    const leadOut = moves.filter(m => m.role === 'lead_out')
    expect(leadIn).toHaveLength(2)
    expect(leadOut).toHaveLength(1)
    expect(leadIn.every(m => m.feed === 321)).toBe(true)
    expect(leadOut.every(m => m.feed === 654)).toBe(true)
    expect(finish.every(m => m.feed === undefined)).toBe(true)

    const leadInArc = leadIn[1]
    const leadOutArc = leadOut[0]
    expect(leadInArc).toMatchObject({
      type: 'arc_ccw', x: 5, y: 0, cx: 5, cy: 2, role: 'lead_in', feed: 321,
    })
    expect(leadOutArc).toMatchObject({
      type: 'arc_ccw', x: 7, y: 2, cx: 5, cy: 2, role: 'lead_out', feed: 654,
    })

    const leadInSweep = ccwSweep(leadIn[0], leadInArc, { x: leadInArc.cx!, y: leadInArc.cy! })
    const leadOutStart = finish[finish.length - 1]
    const leadOutSweep = ccwSweep(leadOutStart, leadOutArc, { x: leadOutArc.cx!, y: leadOutArc.cy! })
    expect(leadInSweep).toBeLessThanOrEqual(Math.PI / 2 + 1e-12)
    expect(leadOutSweep).toBeLessThanOrEqual(Math.PI / 2 + 1e-12)

    // Native CCW tangent at a point is the radius vector rotated left 90 deg.
    const leadInTangent = {
      x: -(leadInArc.y - leadInArc.cy!),
      y: leadInArc.x - leadInArc.cx!,
    }
    const finishStartDirection = {
      x: finish[0].x - leadInArc.x,
      y: finish[0].y - leadInArc.y,
    }
    expect(leadInTangent.x * finishStartDirection.y - leadInTangent.y * finishStartDirection.x)
      .toBeCloseTo(0, 12)
    expect(leadInTangent.x * finishStartDirection.x + leadInTangent.y * finishStartDirection.y)
      .toBeGreaterThan(0)

    const priorFinish = finish[finish.length - 2]
    const finishEndDirection = {
      x: leadOutStart.x - priorFinish.x,
      y: leadOutStart.y - priorFinish.y,
    }
    const leadOutTangent = {
      x: -(leadOutStart.y - leadOutArc.cy!),
      y: leadOutStart.x - leadOutArc.cx!,
    }
    expect(finishEndDirection.x * leadOutTangent.y - finishEndDirection.y * leadOutTangent.x)
      .toBeCloseTo(0, 12)
    expect(finishEndDirection.x * leadOutTangent.x + finishEndDirection.y * leadOutTangent.y)
      .toBeGreaterThan(0)

    // Re-seaming may split one edge, but the closed contour's length, area, and CCW
    // winding remain exactly the same.
    const reseamed = [
      { x: leadInArc.x, y: leadInArc.y },
      ...finish.map(m => ({ x: m.x, y: m.y })),
    ]
    expect(pathLength(reseamed)).toBeCloseTo(40, 12)
    expect(polygonArea(reseamed)).toBeCloseTo(100, 12)
  })

  it('keeps wall-finish tangent leads at trueBottom when floor replay is enabled', () => {
    const feeds = {
      ...ctx().feeds,
      leadInRate: 321,
      leadOutRate: 654,
    }
    const moves = emitFeature(result([plungeEntry, cut3, finishSquare]), ctx({
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -4.5 },
      feeds,
      stepdown: 3,
      floorFinishDepth: -6,
      wallFinishMode: 'final',
      finishLeadInRadius: 2,
      finishLeadOutRadius: 2,
    }))

    const leadIn = moves.filter(m => m.role === 'lead_in')
    const leadOut = moves.filter(m => m.role === 'lead_out')
    expect(leadIn).toHaveLength(2)
    expect(leadOut).toHaveLength(1)
    expect(leadIn.every(m => m.z === -6 && m.feed === 321)).toBe(true)
    expect(leadOut.every(m => m.z === -6 && m.feed === 654)).toBe(true)

    const leadInArc = leadIn[1]
    const leadOutArc = leadOut[0]
    expect(leadInArc).toMatchObject({
      type: 'arc_ccw', x: 5, y: 0, z: -6, cx: 5, cy: 2, role: 'lead_in', feed: 321,
    })
    expect(leadOutArc).toMatchObject({
      type: 'arc_ccw', x: 7, y: 2, z: -6, cx: 5, cy: 2, role: 'lead_out', feed: 654,
    })

    const leadInArcIndex = moves.indexOf(leadInArc)
    const leadOutArcIndex = moves.indexOf(leadOutArc)
    const wallFinish = moves
      .slice(leadInArcIndex + 1, leadOutArcIndex)
      .filter(m => m.role === 'finish')
    expect(wallFinish.length).toBeGreaterThan(2)
    expect(wallFinish.every(m => m.z === -6 && m.feed === undefined)).toBe(true)

    const leadInSweep = ccwSweep(leadIn[0], leadInArc, { x: leadInArc.cx!, y: leadInArc.cy! })
    const leadOutStart = wallFinish[wallFinish.length - 1]
    const leadOutSweep = ccwSweep(leadOutStart, leadOutArc, {
      x: leadOutArc.cx!,
      y: leadOutArc.cy!,
    })
    expect(leadInSweep).toBeLessThanOrEqual(Math.PI / 2 + 1e-12)
    expect(leadOutSweep).toBeLessThanOrEqual(Math.PI / 2 + 1e-12)
  })

  it('retains the legacy finish path when a requested radius cannot fit', () => {
    const narrowFinish: AdaptivePass = {
      type: 'finish',
      points: [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 2 },
        { x: 0, y: 2 }, { x: 0, y: 0 },
      ],
    }
    const legacy = emitFeature(result([narrowFinish]), ctx())
    const noFit = emitFeature(result([narrowFinish]), ctx({
      finishLeadInRadius: 3,
      finishLeadOutRadius: 3,
    }))

    expect(noFit).toEqual(legacy)
    expect(noFit.some(m => m.role === 'lead_in' || m.role === 'lead_out')).toBe(false)
  })

  it('rejects a tangent lead that crosses a nearby island and re-seams on a safe wall', () => {
    const pocketWithNearIsland = Object.assign(
      result([finishSquare], ['inside']),
      {
        finishFitRegion: [
          [
            { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
          ],
          [
            { x: 3, y: 1 }, { x: 3, y: 4 }, { x: 7, y: 4 }, { x: 7, y: 1 },
          ],
        ],
      },
    )
    const moves = emitFeature(pocketWithNearIsland, ctx({
      finishLeadInRadius: 2,
      finishLeadOutRadius: 2,
    }))
    const leadIn = moves.filter(m => m.role === 'lead_in')
    const leadOut = moves.filter(m => m.role === 'lead_out')

    // The historical single-ring check chose the bottom seam at (5, 0), where both
    // quarter circles enter the island. The complete-region check rejects it and uses
    // the next deterministic equal-length candidate on the unobstructed right wall.
    expect(leadIn[0]).toMatchObject({ type: 'feed', x: 8, y: 3, role: 'lead_in' })
    expect(leadIn[1]).toMatchObject({
      type: 'arc_ccw', x: 10, y: 5, cx: 8, cy: 5, role: 'lead_in',
    })
    expect(leadOut[0]).toMatchObject({
      type: 'arc_ccw', x: 8, y: 7, cx: 8, cy: 5, role: 'lead_out',
    })
  })

  it('puts tangent leads on the outside/cleared side of a CW island finish ring', () => {
    const clockwiseIsland: AdaptivePass = {
      type: 'finish',
      points: [
        { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 },
        { x: 10, y: 0 }, { x: 0, y: 0 },
      ],
    }
    const moves = emitFeature(result([clockwiseIsland], ['outside']), ctx({
      finishLeadInRadius: 2,
      finishLeadOutRadius: 2,
    }))
    const leadIn = moves.filter(m => m.role === 'lead_in')
    const finish = moves.filter(m => m.role === 'finish')
    const leadOut = moves.filter(m => m.role === 'lead_out')

    expect(leadIn[0]).toMatchObject({ type: 'feed', x: -2, y: 3, role: 'lead_in' })
    expect(leadIn[1]).toMatchObject({
      type: 'arc_ccw', x: 0, y: 5, cx: -2, cy: 5, role: 'lead_in',
    })
    expect(leadOut[0]).toMatchObject({
      type: 'arc_ccw', x: -2, y: 7, cx: -2, cy: 5, role: 'lead_out',
    })
    expect(leadIn[0].x).toBeLessThan(0)
    expect(leadOut[0].x).toBeLessThan(0)

    const contour = [
      { x: leadIn[1].x, y: leadIn[1].y },
      ...finish.map(m => ({ x: m.x, y: m.y })),
    ]
    expect(pathLength(contour)).toBeCloseTo(40, 12)
    expect(polygonArea(contour)).toBeCloseTo(-100, 12)
  })

  it('supports lead-in-only and lead-out-only radii without changing contour geometry', () => {
    const cases = [
      { finishLeadInRadius: 2, finishLeadOutRadius: 0, leadInCount: 2, leadOutCount: 0 },
      { finishLeadInRadius: 0, finishLeadOutRadius: 2, leadInCount: 0, leadOutCount: 1 },
    ]

    for (const c of cases) {
      const moves = emitFeature(result([finishSquare]), ctx(c))
      const leadIn = moves.filter(m => m.role === 'lead_in')
      const finish = moves.filter(m => m.role === 'finish')
      const leadOut = moves.filter(m => m.role === 'lead_out')
      expect(leadIn).toHaveLength(c.leadInCount)
      expect(leadOut).toHaveLength(c.leadOutCount)

      const contour = c.leadInCount > 0
        ? [{ x: leadIn[1].x, y: leadIn[1].y }, ...finish.map(m => ({ x: m.x, y: m.y }))]
        : finish.map(m => ({ x: m.x, y: m.y }))
      expect(pathLength(contour)).toBeCloseTo(40, 12)
      expect(polygonArea(contour)).toBeCloseTo(100, 12)
    }
  })
})

// WO-466 TIER 2.5 -- THE EMISSION CONTRACT: TRAVEL AT DEPTH, THEN FEED.
//
// Added in the fix round after the audit noted this file "passed without exercising the new
// finish-approach branch". The branch's whole claim is that the tool NEVER LEAVES THE FLOOR,
// so what has to be pinned is the absence of a lift as much as the presence of the two moves:
// no rapid, no clearance height, no descent, one at-depth traverse with NO baked feedrate,
// then one lead_in at leadInRate. WO-449's tier-3 stream is asserted alongside it, unchanged,
// so a future edit cannot quietly turn a retract into a stay-down or the reverse.
describe('WO-466 stop-short finish approach', () => {
  const roughCut: AdaptivePass = { type: 'cut', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }
  const lap: AdaptivePass = {
    type: 'finish',
    points: [{ x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 }, { x: 0, y: 0 }, { x: 6, y: 0 }],
  }
  // travel[0] is where the tool physically stands (the end of roughCut); the split is at
  // (5.5, 0) and the last 0.5mm into the lap's own start is the fed tail.
  const stopShort: FinishApproach = {
    tier: 'stopshort',
    descent: { x: 6, y: 0 },
    travel: [{ x: 4, y: 0 }, { x: 5.5, y: 0 }],
    feed: [{ x: 5.5, y: 0 }, { x: 6, y: 0 }],
    reason: 'stop-short@(5.50, 0.00): 1.50mm travelled AT DEPTH, then 0.50mm FED',
  }
  const retract: FinishApproach = {
    tier: 'retract',
    descent: { x: 6, y: 0 },
    reason: 'tier3 retract, descent on the lap start',
  }

  function withApproach(approach: FinishApproach): FeatureResult {
    return { ...result([plungeEntry, roughCut, lap]), finishApproaches: [approach] }
  }

  it('emits an at-depth traverse then a fed tail, and never leaves the floor', () => {
    const moves = emitFeature(withApproach(stopShort), ctx())
    const bottom = -2
    const lapStart = moves.findIndex(m => m.role === 'finish')
    expect(lapStart).toBeGreaterThan(0)
    // The two moves the planner asked for, in order, immediately before the lap.
    const approachMoves = [moves[lapStart - 2], moves[lapStart - 1]]
    expect(approachMoves.map(m => [m.type, m.role, m.x, m.y, m.z, m.feed])).toEqual([
      ['feed', 'fast_traverse', 5.5, 0, bottom, undefined],
      ['feed', 'lead_in', 6, 0, bottom, ctx().feeds.leadInRate],
    ])
    // NOTHING LIFTS. Between the roughing cut that leaves the tool at (4, 0) and the lap's
    // first finish move there is no rapid and no z above the floor at all.
    const cutEnd = moves.findIndex(m => m.role === 'cut' && m.x === 4)
    expect(cutEnd).toBeGreaterThan(-1)
    const between = moves.slice(cutEnd + 1, lapStart)
    expect(between.filter(m => m.type === 'rapid')).toEqual([])
    expect(between.every(m => Math.abs(m.z - bottom) <= 1e-9), JSON.stringify(between)).toBe(true)
    expect(between.some(m => m.z === ctx().heights.clearanceZ)).toBe(false)
    expect(between.filter(m => m.role === 'plunge')).toEqual([])
  })

  it('still flies and descends for WO-449 tier 3, so the two tiers stay distinguishable', () => {
    const moves = emitFeature(withApproach(retract), ctx())
    const lapStart = moves.findIndex(m => m.role === 'finish')
    const cutEnd = moves.findIndex(m => m.role === 'cut' && m.x === 4)
    const between = moves.slice(cutEnd + 1, lapStart)
    expect(between.some(m => m.type === 'rapid' && m.z === ctx().heights.clearanceZ)).toBe(true)
    expect(between.some(m => m.role === 'fast_traverse')).toBe(false)
  })

  it('descends vertically where it stands if it is ever handed a tool above the level', () => {
    // The precondition (tool already at this level's depth) holds by construction today. If a
    // future scheduler breaks it, the answer must be a vertical plunge at the CURRENT xy --
    // never a diagonal ramp into the part -- and it must be loud.
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation(m => { warns.push(String(m)) })
    try {
      // wallFinishMode 'each_stepdown' with a 1mm stepdown puts a lap at the FIRST level,
      // where the preceding entry/cut leave the tool at that level's depth, then a second lap
      // at the floor: the floor replay's approach is the one that starts from above.
      const moves = emitFeature(withApproach(stopShort), ctx({ stepdown: 1, wallFinishMode: 'each_stepdown' }))
      const traverses = moves.filter(m => m.role === 'fast_traverse')
      expect(traverses.length).toBeGreaterThan(0)
      for (const t of traverses) {
        const i = moves.indexOf(t)
        const prev = moves[i - 1]
        // Whatever preceded it, the traverse itself is always AT the level it travels on, and
        // any depth correction ahead of it is a vertical plunge at the tool's own xy.
        expect(prev.z).toBeCloseTo(t.z, 9)
        if (prev.role === 'plunge') {
          expect(prev.x).toBe(moves[i - 2].x)
          expect(prev.y).toBe(moves[i - 2].y)
        }
      }
    } finally {
      spy.mockRestore()
    }
  })
})
