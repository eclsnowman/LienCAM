// WO-2168: Adaptive rough keeps the pocket wall pass (regression from WO-2145).
//
// WO-2145 sends a first rough whose stock is exactly the part's box through the full-clear
// route (side entry, reach past the stock edge). On that route the rough skipped the outer
// wall cleanup of every region with holes, taking its outer ring for the stock edge. A pocket
// with an island in a part-box stock is such a region, but its outer ring is the MODEL's pocket
// wall: the wall pass went missing and the benchmark engagement-pocket rough left ~850 mm3 on
// its walls for the finisher (.planning/benchmark-reds-2026-09-28.md).
//
// The part and the rough are the benchmark's own: the engagement pocket (90 x 60 x 16, an H
// pocket with a 6 mm neck and a 10 x 10 island, floor at z 4) in its part-box stock, roughed by
// the 6 mm flat with the engagement-pocket-rest-pencil chain's parameters. It runs through the
// benchmark's chain runner, which drives the application's production entry
// (`computeOperationToolpath`, the real cam3d dispatcher and kernel). A one-step chain with its
// own setup label, so it shares no scene with a scored chain.

import { describe, expect, it } from 'vitest'

import { planChain } from '../benchmark/chainRunner'
import { WHOLE_PART, type BenchmarkChain } from '../benchmark/registry'
import { ENGAGEMENT_POCKET_BOUNDARIES } from '../../cam3d/fixtures'
import type { ToolpathMove } from '../../types'

const TOP = 16
const FLOOR = 4
const R = 3
const RADIAL_STOCK = 0.3

const chain: BenchmarkChain = {
  id: 'wo2168-pocket-wall-pass',
  partId: 'engagement-pocket',
  setupLabel: 'wo2168',
  tiers: [],
  steps: [{
    id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART,
    params: {
      maxStepdown: 4, stepover: 0.4, tolerance: 0.1, helixDiameter: 3, helixAngleDeg: 10, cellSize: 0.4,
      useStockBoundary: false, radialStockToLeave: RADIAL_STOCK, axialStockToLeave: 0.3,
    },
    stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05,
  }],
}

const isRapid = (m: ToolpathMove) => m.type === 'rapid'

/** The pocket's outer wall: the MODEL's wall, not the stock edge. */
const WALL = ENGAGEMENT_POCKET_BOUNDARIES.outer

/**
 * Points on the pocket's straight outer walls, 0.25 mm apart. A round cutter cannot reach into a
 * corner, so points within R + 1 mm of any wall vertex are not asked of it, nor the walls of the
 * 6 mm neck (exactly one tool diameter wide).
 */
function wallSamples(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < WALL.length; i++) {
    const [ax, ay] = WALL[i], [bx, by] = WALL[(i + 1) % WALL.length]
    const n = Math.floor(Math.hypot(bx - ax, by - ay) / 0.25)
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n
      if (WALL.some(([vx, vy]) => Math.hypot(x - vx, y - vy) < R + 1)) continue
      if (x >= 40 && x <= 50) continue
      out.push({ x, y })
    }
  }
  return out
}

/** Feed points of one Z level, at most 0.1 mm apart (arcs followed as arcs). */
function levelPoints(moves: readonly ToolpathMove[], z: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b) || Math.abs(a.z - z) > 1e-3 || Math.abs(b.z - z) > 1e-3) continue
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && b.cx !== undefined && b.cy !== undefined) {
      const r = Math.hypot(a.x - b.cx, a.y - b.cy)
      const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
      let sweep = Math.atan2(b.y - b.cy, b.x - b.cx) - a0
      if (b.type === 'arc_cw') { while (sweep >= 0) sweep -= 2 * Math.PI } else { while (sweep <= 0) sweep += 2 * Math.PI }
      const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / 0.1))
      for (let k = 0; k <= n; k++) out.push({ x: b.cx + r * Math.cos(a0 + (sweep * k) / n), y: b.cy + r * Math.sin(a0 + (sweep * k) / n) })
      continue
    }
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1))
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  return out
}

/**
 * Per rough level: the stock left on the pocket's outer wall past the radial allowance (mm),
 * at every wall sample: how far the nearest cutter edge stands off the wall, minus 0.3 mm.
 */
function wallStockLeft(moves: readonly ToolpathMove[]): { z: number; left: number[] }[] {
  const samples = wallSamples()
  // A rough level is a Z the rough cuts along (helix and ramp moves pass through many Zs).
  const flatLength = new Map<number, number>()
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b) || Math.abs(a.z - b.z) > 1e-4) continue
    const z = Math.round(b.z * 1000) / 1000
    flatLength.set(z, (flatLength.get(z) ?? 0) + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const levels = [...flatLength].filter(([z, len]) => len > 50 && z < TOP - 1e-3 && z > FLOOR - 1e-3)
    .map(([z]) => z).sort((a, b) => b - a)
  return levels.map((z) => {
    const pts = levelPoints(moves, z)
    return {
      z,
      left: samples.map((s) => {
        let best = Infinity
        for (const p of pts) best = Math.min(best, Math.hypot(p.x - s.x, p.y - s.y))
        return best - R - RADIAL_STOCK
      }),
    }
  })
}

describe('WO-2168: Adaptive rough keeps the pocket wall pass in a part-box stock', () => {
  it('the engagement pocket (pocket with an island): every rough level rides the whole pocket wall', async () => {
    const planned = await planChain(chain)
    const moves = planned.steps[0].moves
    const levels = wallStockLeft(moves)
    const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
    console.log(`[WO-2168] ${moves.length} moves; wall stock left past the 0.3 mm allowance, per level: ` +
      levels.map((l) => `z ${l.z.toFixed(3)}: min ${Math.min(...l.left).toFixed(3)}, median ${pct(l.left, 0.5).toFixed(3)}, ` +
        `p95 ${pct(l.left, 0.95).toFixed(3)}, max ${Math.max(...l.left).toFixed(3)} mm, ` +
        `within 0.1 of the cleanest ${(l.left.filter((v) => v <= Math.min(...l.left) + 0.1).length / l.left.length * 100).toFixed(1)}%`).join('; '))
    // Not vacuous: the rough goes down into the pocket, level by level, to its floor.
    expect(levels.length).toBeGreaterThanOrEqual(3)
    expect(Math.min(...levels.map((l) => l.z))).toBeLessThan(FLOOR + 0.5)
    // The wall pass rides the whole wall at one stand-off (measured: 0.41-0.45 mm past the
    // allowance at every level, the pocket's cell-diagonal safety field). Without it the adaptive
    // passes alone wobble off the wall: up to 0.65 mm, 4.9% of the wall (negative control, WO).
    for (const l of levels) {
      const clean = Math.min(...l.left)
      expect(clean, `z ${l.z}: the rough reaches the pocket wall`).toBeLessThan(0.5)
      expect(Math.max(...l.left), `z ${l.z}: most stock left on the pocket wall past the allowance (mm)`)
        .toBeLessThanOrEqual(clean + 0.1)
    }
  }, 900_000)
})
