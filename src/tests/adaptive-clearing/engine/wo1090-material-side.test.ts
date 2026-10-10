// WO-1090 MATERIAL-SIDE PROOF (CI-enforced -- no underscore).
//
// WHY THIS EXISTS, AND WHY IT DOES NOT USE A SIDE PROBE.
//
// The engine's wall-ride milling-direction gate (processFeature.ts wallPointsMatchDirection /
// wallPointsPresentMaterialSide) decides the material side by stepping 1e-3mm off a segment
// midpoint and asking point-in-polygon which side is cleared. conventional-direction.test.ts
// judges the EMITTED rides with the same 1e-3mm step. When both use the same construction, a
// green result proves only that the engine agrees with itself -- and WO-1090 measured that the
// construction has a precondition (the sample must sit ON the wall) which trimmed loopback rides
// routinely break, by up to 0.083mm, i.e. 83x the probe's reach.
//
// So this file proves the same property by a DIFFERENT and exact construction: WINDING. For any
// cut-region loop the cleared field lies to the LEFT of the loop's own winding -- an outer loop
// (signed area > 0) has its cleared interior on the left, and a hole (signed area < 0) has the
// cleared field OUTSIDE it, which is again on the left of a clockwise winding. So a ride segment
// that lies ON the wall presents the cleared field on its left exactly when it runs WITH that
// wall segment's winding; climb wants that (material on the right, WO-1896) and conventional
// wants the reverse. This is exact at any sampling density and involves no offset, no tolerance and no
// point-in-polygon test -- it is the same argument conventional-direction.test.ts's own
// expectRingMaterialSide adopted under WO-1061, for the same reason.
//
// It is deliberately restricted to segments that provably lie on the wall (midpoint within 1e-9
// of a cut-region boundary segment: a wall ride's vertices ARE boundary vertices, so those
// segments are exact). Trimming chords that leave the wall are not judged here -- there is no
// material side to present where there is no wall -- and the sample floor below keeps that
// restriction from hollowing the test out.
import { describe, it, beforeAll, expect, vi } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, type ProcessParams, type AdaptivePass,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

type MillingDirection = 'climb' | 'conventional'

const square: Loop = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }]
const circle = (cx: number, cy: number, r: number, n = 80): Loop =>
  Array.from({ length: n }, (_, i) => {
    const a = 2 * Math.PI * i / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })

function loadGt(file: string): { boundary: Loop; holes: Loop[]; helixDiameter: number } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/${file}`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: ((d.islands ?? []) as number[][][]).map(isl => isl.map(([x, y]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
  }
}

/** The cut-region boundary segment nearest `pt`, with its unit winding direction. */
function nearestWallSegment(pt: Pt, cutRegion: Loops): { dist: number; dir: Pt } | null {
  let best: { dist: number; dir: Pt } | null = null
  for (const loop of cutRegion) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const lengthSq = dx * dx + dy * dy
      if (lengthSq <= 1e-12) continue
      const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lengthSq))
      const dist = Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy))
      if (!best || dist < best.dist) {
        const length = Math.sqrt(lengthSq)
        best = { dist, dir: { x: dx / length, y: dy / length } }
      }
    }
  }
  return best
}

interface Verdict { checked: number; offenders: string[] }

/** Every ON-WALL segment of every emitted wall-follow, judged by winding. */
function auditWallRides(
  label: string,
  passes: AdaptivePass[],
  cutRegion: Loops,
  millingDirection: MillingDirection,
): Verdict {
  const v: Verdict = { checked: 0, offenders: [] }
  passes.forEach((pass, passIndex) => {
    if (pass.type !== 'wallfollow') return
    for (let i = 1; i < pass.points.length; i++) {
      const a = pass.points[i - 1], b = pass.points[i]
      const dx = b.x - a.x, dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      if (length <= 1e-9) continue
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const wall = nearestWallSegment(midpoint, cutRegion)
      if (!wall || wall.dist > 1e-9) continue // not on the wall: no material side to present
      v.checked++
      const runsWithWinding = (dx * wall.dir.x + dy * wall.dir.y) / length > 0
      const clearedIsLeft = runsWithWinding
      // WO-1896: climb keeps material on the right, i.e. the cleared field on the left.
      const wantClearedLeft = millingDirection === 'climb'
      if (clearedIsLeft !== wantClearedLeft && v.offenders.length < 5) {
        v.offenders.push(
          `${label} pass ${passIndex} seg ${i} at (${midpoint.x.toFixed(3)}, ${midpoint.y.toFixed(3)}): `
          + `expected material ${millingDirection === 'climb' ? 'right' : 'left'}, `
          + `travel runs ${runsWithWinding ? 'WITH' : 'AGAINST'} the wall winding`,
        )
      } else if (clearedIsLeft !== wantClearedLeft) {
        v.offenders.push('...')
      }
    }
  })
  return v
}

function run(feature: { boundary: Loop; holes?: Loop[] }, params: ProcessParams) {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    return processFeature(feature, params)
  } finally {
    spy.mockRestore()
  }
}

describe('WO-1090 material side of emitted wall rides, proved by winding', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('holds in BOTH milling directions on the cleanup fixture', () => {
    let totalChecked = 0
    for (const millingDirection of ['conventional', 'climb'] as const) {
      const res = run({ boundary: square, holes: [circle(30, 30, 8)] }, {
        toolRadius: 2, stepOver: 0.25, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0.5,
        millingDirection, integralWallFollow: true, wallCleanupAsWeGo: true,
      })
      expect(res.stats.aborted).toBeUndefined()
      const v = auditWallRides(millingDirection, res.passes, res.cutRegion, millingDirection)
      expect(v.offenders, v.offenders.slice(0, 5).join('\n')).toEqual([])
      // Non-vacuity: the audit must actually have judged a substantial body of wall travel.
      expect(v.checked, `${millingDirection}: nothing was judged`).toBeGreaterThan(200)
      totalChecked += v.checked
    }
    expect(totalChecked).toBeGreaterThan(400)
  }, 300_000)

  it('holds on the two gt fixtures whose corner shape WO-1069 re-pinned', () => {
    for (const [file, name] of [['gt_fix1.json', 'Kidney'], ['gt_fix7.json', 'Barbell']] as const) {
      const { boundary, holes, helixDiameter } = loadGt(file)
      const res = run({ boundary, holes }, {
        toolRadius: 2, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      })
      expect(res.stats.aborted).toBeUndefined()
      // An omitted direction is climb (WO-1896), the historical material-right stream.
      const v = auditWallRides(name, res.passes, res.cutRegion, 'climb')
      expect(v.offenders, v.offenders.slice(0, 5).join('\n')).toEqual([])
      expect(v.checked, `${name}: nothing was judged`).toBeGreaterThan(200)
    }
  }, 300_000)
})
