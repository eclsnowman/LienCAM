// Unit tests for the TRIMMED wall-clean transition builder (wallCleanLoop.ts).
//
// Asserts the validated-construction-with-trim invariants:
//   (a) every chain junction is coincident to < 1e-6
//       (exit[last]==fillet1[0]; fillet1[last]==traverse[0]; traverse[last]==fillet2[0];
//        fillet2[last]==entry[0]); plus exit[0]==A and entry[last]==B.
//   (b) NO wall-follow point lies PAST the fillet tangent point -- the exit's last point
//       equals fillet1[0] and no exit point extends beyond it (overshoot gone); symmetric
//       for the entry / fillet2.
//   (c) tangency at the two fillet joins (consecutive-segment dot > 0.99).

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Pt, type Loops } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { buildWallCleanTransition, buildWallFollowExit, buildWallFollowEntry, buildLoopback } from '../../../lib/cam/adaptiveClearing2d/engine/wallCleanLoop'

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

// Least-squares (Kasa) circle fit -> radius. Used to MEASURE the actual rendered fillet arc
// radius so the loopbackFilletPct knob can't silently stop driving the geometry again.
function fitCircleR(pts: Pt[]): number {
  const n = pts.length
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y
    sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y
    sxz += p.x * z; syz += p.y * z; sz += z
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]]
  const B = [sxz, syz, sz]
  for (let i = 0; i < 3; i++) {
    const piv = A[i][i]
    if (Math.abs(piv) < 1e-12) return NaN
    for (let j = 0; j < 3; j++) A[i][j] /= piv
    B[i] /= piv
    for (let k = 0; k < 3; k++) if (k !== i) {
      const f = A[k][i]
      for (let j = 0; j < 3; j++) A[k][j] -= f * A[i][j]
      B[k] -= f * B[i]
    }
  }
  const cx = B[0] / 2, cy = B[1] / 2
  return Math.sqrt(Math.max(0, B[2] + cx * cx + cy * cy))
}
function dirAt(p: Pt[], i: number): Pt {
  const a = p[i], b = p[i + 1]
  const m = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / m, y: (b.y - a.y) / m }
}
function dot(a: Pt, b: Pt): number { return a.x * b.x + a.y * b.y }

describe('buildWallCleanTransition (trimmed)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  // SAME-LOOP adjacent-cusp case (the only scenario wall-clean now serves): the prior cut and
  // the next cut both reach the SAME outer wall (loop 0, a circle R=20 @ (20,20)) at two points
  // a short arc apart near the bottom. The wall-follow exit rides the wall behind the prior
  // cut, the loopback crosses the short cleared sliver between the two passes, and the entry
  // rides the wall into B. (A cross-loop pair -- outer wall -> island -- now returns null; see
  // the dedicated cross-loop test below.)
  const N = 64
  const ring = (cx: number, cy: number, R: number): Pt[] => {
    const p: Pt[] = []
    for (let i = 0; i < N; i++) { const a = 2 * Math.PI * i / N; p.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }) }
    return p
  }
  const cutRegion: Loops = [ring(20, 20, 20), ring(20, 8, 5)]
  const toolRadius = 2.0
  const arcTol = 0.02

  // A on the outer wall at ~250deg = (13.16, 1.21); prior cut comes down the interior to it.
  const A0 = { x: 20 + 20 * Math.cos(250 * Math.PI / 180), y: 20 + 20 * Math.sin(250 * Math.PI / 180) }
  // B on the outer wall at ~290deg = (26.84, 1.21), a short arc (~14mm) clockwise from A.
  const B0 = { x: 20 + 20 * Math.cos(290 * Math.PI / 180), y: 20 + 20 * Math.sin(290 * Math.PI / 180) }
  // prior cut arrives at A travelling down-and-out toward the wall.
  const priorCut: Pt[] = [{ x: 16, y: 8 }, { x: 14.5, y: 4 }, A0]
  // next cut starts at B travelling up-and-in away from the wall.
  const nextCut: Pt[] = [B0, { x: 25.5, y: 4 }, { x: 24, y: 8 }]

  it('produces a fully coincident chain (junctions < 1e-6, A/B exact)', () => {
    const t = buildWallCleanTransition(priorCut, nextCut, cutRegion, toolRadius, arcTol)
    expect(t).not.toBeNull()
    if (!t) return
    const A = priorCut[priorCut.length - 1]
    const B = nextCut[0]
    expect(dist(t.exit[0], A)).toBeLessThan(1e-6)
    expect(dist(t.exit[t.exit.length - 1], t.fillet1[0])).toBeLessThan(1e-6)
    expect(dist(t.fillet1[t.fillet1.length - 1], t.traverse[0])).toBeLessThan(1e-6)
    expect(dist(t.traverse[t.traverse.length - 1], t.fillet2[0])).toBeLessThan(1e-6)
    expect(dist(t.fillet2[t.fillet2.length - 1], t.entry[0])).toBeLessThan(1e-6)
    expect(dist(t.entry[t.entry.length - 1], B)).toBeLessThan(1e-6)
  })

  it('has NO wall-follow overshoot past the fillet tangent point', () => {
    const t = buildWallCleanTransition(priorCut, nextCut, cutRegion, toolRadius, arcTol)
    expect(t).not.toBeNull()
    if (!t) return
    // The exit's last point IS the fillet tangent point.
    expect(dist(t.exit[t.exit.length - 1], t.fillet1[0])).toBeLessThan(1e-6)
    // No exit vertex lies past the tangent point: measuring along the exit's own tangent
    // direction, the tangent point must be the furthest along (max projection). Project
    // every exit point onto the final exit segment direction; the last point is the max.
    const tan = t.exit[t.exit.length - 1]
    const dir = dirAt(t.exit, t.exit.length - 2)
    const projLast = tan.x * dir.x + tan.y * dir.y
    for (const p of t.exit) {
      const proj = p.x * dir.x + p.y * dir.y
      expect(proj).toBeLessThanOrEqual(projLast + 1e-6)
    }
    // Symmetric for the entry: its first point IS fillet2's tangent point, and no entry
    // point lies before it along the entry's start direction.
    const tan2 = t.entry[0]
    const dir2 = dirAt(t.entry, 0)
    const projFirst = tan2.x * dir2.x + tan2.y * dir2.y
    for (const p of t.entry) {
      const proj = p.x * dir2.x + p.y * dir2.y
      expect(proj).toBeGreaterThanOrEqual(projFirst - 1e-6)
    }
  })

  it('is tangent at both fillet joins (dot > 0.99)', () => {
    const t = buildWallCleanTransition(priorCut, nextCut, cutRegion, toolRadius, arcTol)
    expect(t).not.toBeNull()
    if (!t) return
    // join exit -> fillet1: last exit segment vs first fillet1 segment.
    const exitOut = dirAt(t.exit, t.exit.length - 2)
    const fil1In = dirAt(t.fillet1, 0)
    expect(dot(exitOut, fil1In)).toBeGreaterThan(0.99)
    // join fillet1 -> traverse.
    const fil1Out = dirAt(t.fillet1, t.fillet1.length - 2)
    const travIn = dirAt(t.traverse, 0)
    expect(dot(fil1Out, travIn)).toBeGreaterThan(0.99)
    // join traverse -> fillet2.
    const travOut = dirAt(t.traverse, t.traverse.length - 2)
    const fil2In = dirAt(t.fillet2, 0)
    expect(dot(travOut, fil2In)).toBeGreaterThan(0.99)
    // join fillet2 -> entry.
    const fil2Out = dirAt(t.fillet2, t.fillet2.length - 2)
    const entryIn = dirAt(t.entry, 0)
    expect(dot(fil2Out, entryIn)).toBeGreaterThan(0.99)
  })

  it('returns null on degenerate input (too few points / empty region)', () => {
    expect(buildWallCleanTransition([{ x: 0, y: 0 }], nextCut, cutRegion, toolRadius, arcTol)).toBeNull()
    expect(buildWallCleanTransition(priorCut, [{ x: 0, y: 0 }], cutRegion, toolRadius, arcTol)).toBeNull()
    expect(buildWallCleanTransition(priorCut, nextCut, [], toolRadius, arcTol)).toBeNull()
  })

  it('drives the loopback fillet radius LIVE from loopbackFilletPct (regression: no fixed clamp)', () => {
    // Build the exit/entry rides once, then build the loopback at two pct settings and FIT a
    // circle to each fillet arc. The fitted radius MUST equal (pct/100)*toolRadius and MUST
    // scale ~5x between 10% and 50% -- guards the e31aedf defect where Math.max(Rf, 1.0)
    // silently pinned every pct <= 50% (R2 tool) to a fixed 1.0mm so the UI knob did nothing.
    const ex = buildWallFollowExit(priorCut, cutRegion, toolRadius, undefined, 10)
    const en = buildWallFollowEntry(nextCut, cutRegion, toolRadius, undefined, 10)
    expect(ex).not.toBeNull(); expect(en).not.toBeNull()
    if (!ex || !en) return

    const measure = (pct: number): number => {
      const lb = buildLoopback(ex.points, en.points, toolRadius, arcTol, pct)
      expect(lb).not.toBeNull()
      if (!lb) return NaN
      // fillet1 is the leading curved arc (>= 4 sampled pts at these radii); fit a circle to it.
      const f1 = lb.loopback.fillet1
      expect(f1.length).toBeGreaterThanOrEqual(4)
      return fitCircleR(f1)
    }

    const r10 = measure(10)   // expect 0.10 * 2.0 = 0.2mm
    const r50 = measure(50)   // expect 0.50 * 2.0 = 1.0mm
    expect(r10).toBeCloseTo(0.10 * toolRadius, 2)
    expect(r50).toBeCloseTo(0.50 * toolRadius, 2)
    // and the radius must genuinely scale (not be clamped to a common floor)
    expect(r50 / r10).toBeGreaterThan(4.5)
    expect(r50 / r10).toBeLessThan(5.5)
  })

  it('returns null on a CROSS-LOOP transition (outer wall -> island)', () => {
    // Prior cut ends on the OUTER wall (loop 0); next cut starts on the ISLAND wall (loop 1).
    // There is no shared wall to clean -- riding each on its own loop is the part-spanning
    // traverse we eliminated, so the builder must bail to null and let the caller fall back.
    const priorOnOuter: Pt[] = [{ x: 20, y: 3 }, { x: 18, y: 1 }, { x: 16.527, y: 0.3038 }]
    const nextOnIsland: Pt[] = [{ x: 20.8682, y: 12.924 }, { x: 21, y: 15 }, { x: 21, y: 18 }]
    expect(buildWallCleanTransition(priorOnOuter, nextOnIsland, cutRegion, toolRadius, arcTol)).toBeNull()
  })
})
