// WO SKC-12 (5a): the epic's first hard evidence -- CAM's own arc tessellator
// (src/lib/sketch/tools/arcTools.ts, the canonical-CCW SOURCE convention) and sketch3d's
// sampleArcPoints (src/components/sketch3d-shared/geometry2d.ts) must AGREE on random
// start/end/through triples, now that sketch3d's makeArcEntity (draftEntities.ts) mirrors CAM's
// canonicalArcFromThreePoints instead of the old signed-sweep encoding. This FAILED before this WO
// by construction (the critic's experiment 2, docs/3d/SKETCH-CRITIC-REPORT.md) -- geometry2d.ts
// walked the RAW (possibly out-of-range) delta while arcTools.ts always normalized.
import { describe, expect, it } from 'vitest'
import { arcThrough3Points, tessellateArc, type BuiltArc } from '../../lib/sketch/tools/arcTools'
import { makeArcEntity } from '../../components/sketch3d-shared/draftEntities'
import { sampleArcPoints } from '../../components/sketch3d-shared/geometry2d'

const TWO_PI = Math.PI * 2

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

// Deterministic LCG (not Math.random) so a failure is reproducible without seed-hunting.
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

interface Vec2 {
  x: number
  y: number
}

function randomTriple(rng: () => number): { start: Vec2; end: Vec2; through: Vec2 } {
  const cx = (rng() - 0.5) * 40
  const cy = (rng() - 0.5) * 40
  const r = 2 + rng() * 18
  const pt = (a: number): Vec2 => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  return { start: pt(rng() * TWO_PI), end: pt(rng() * TWO_PI), through: pt(rng() * TWO_PI) }
}

describe('SKC-12 5a: CAM tessellateArc and sketch3d sampleArcPoints agree (canonical-CCW property test)', () => {
  it('random start/end/through triples: same center/radius/angles, byte-close tessellated points', () => {
    const rng = makeRng(20260710)
    let checked = 0
    let attempts = 0
    const CHECKS_TARGET = 30
    const sweepsDeg: number[] = []

    while (checked < CHECKS_TARGET && attempts < 5000) {
      attempts++
      const { start, end, through } = randomTriple(rng)
      const camBuilt = arcThrough3Points(start, end, through, 1e-6)
      if (!camBuilt) continue // collinear/coincident triple -- CAM itself refuses these, skip

      // WO SKC-14 (BK-88): NO SWEEP FILTER. Pre-SKC-14 this test skipped every sweep outside
      // [60deg, 300deg], because the two tessellators' minimum-segment policies diverged there
      // (sketch3d max(2,..) vs CAM max(8,..)) -- so point identity was only ever proven in a
      // band, which is exactly the residual divergence SKC-12's audit HELD as a major. There is
      // now ONE tessellator (sampleArcPoints delegates to CAM's tessellateArc), so agreement is
      // asserted across the FULL range of sweeps the random triples produce.
      checked++

      const entity = makeArcEntity(`arc${checked}`, start, end, through)
      expect(entity.center.x).toBeCloseTo(camBuilt.center.x, 6)
      expect(entity.center.y).toBeCloseTo(camBuilt.center.y, 6)
      expect(entity.radius).toBeCloseTo(camBuilt.radius, 6)
      expect(entity.startAngle).toBeCloseTo(camBuilt.startAngle, 6)
      expect(entity.endAngle).toBeCloseTo(camBuilt.endAngle, 6)

      // Force CAM's tessellator to walk start->end (sampleArcPoints has no reversal concept --
      // it always walks its own startAngle->endAngle).
      const forwardBuilt: BuiltArc = { ...camBuilt, firstPointSite: 'start' }
      const camPoints = tessellateArc(forwardBuilt)
      const skPoints = sampleArcPoints(entity)

      // Record the sweep spread so a future filter creeping back in is visible in the assertion
      // below rather than silently shrinking this test's coverage.
      sweepsDeg.push((norm(camBuilt.endAngle - camBuilt.startAngle) * 180) / Math.PI)

      expect(skPoints.length).toBe(camPoints.length)
      for (let i = 0; i < camPoints.length; i++) {
        expect(skPoints[i].x).toBeCloseTo(camPoints[i].x, 6)
        expect(skPoints[i].y).toBeCloseTo(camPoints[i].y, 6)
      }
    }

    // FAILS-IF: too many random triples were rejected (collinear) to reach the target -- would
    // silently weaken this into a near-empty test.
    expect(checked).toBe(CHECKS_TARGET)

    // Random triples are SIZE-BIASED toward large sweeps: the constructed arc is whichever of the
    // two s->e arcs contains `through`, so P(sweep < 60deg) ~= 3%. Thirty samples therefore reach
    // the sub-60deg band only by luck -- which is exactly the band the old min-segment policies
    // disagreed in. This test asserts what it actually covers; the DETERMINISTIC test below is
    // what proves the sub-60deg / super-300deg range. (Measured, WO SKC-14: the seeded RNG's
    // first 30 accepted triples contain no sweep under 60deg.)
    expect(sweepsDeg.some((d) => d > 300)).toBe(true)
  })

  // WO SKC-14 (BK-88): the load-bearing half of "full-range point agreement". The random test
  // above cannot reach tiny sweeps often enough to be a guard, so the exact sweeps where the two
  // former policies diverged (CAM's max(8, ...) vs sketch3d's max(2, ...) -- i.e. every sweep
  // whose ceil(sweep/2pi * 64) lands below 8, meaning below 45deg) are constructed directly.
  //
  // MUTATION PROOF (run once, reverted, recorded in coordination/reports/SKC-14.report.json):
  // re-introducing a local `max(2, ceil(sweep/2pi*64))` walk inside sampleArcPoints turns the
  // 1deg / 5deg / 15deg / 30deg cases red on `skPoints.length` (3 points vs CAM's 9).
  it('deterministic edge sweeps (1deg..359deg + full turn): identical point counts and positions', () => {
    const center = { x: 3, y: -7 }
    const radius = 10
    const A0 = 0.37 // arbitrary non-axis-aligned start so no case is accidentally symmetric
    const pointAt = (a: number) => ({
      x: center.x + radius * Math.cos(a),
      y: center.y + radius * Math.sin(a),
    })

    const SWEEPS_DEG = [1, 5, 15, 30, 44, 45, 46, 60, 90, 180, 270, 300, 330, 350, 359]
    for (const sweepDeg of SWEEPS_DEG) {
      const sweep = (sweepDeg * Math.PI) / 180
      // start / end / through-the-middle: arcThrough3Points must recover exactly this arc.
      const start = pointAt(A0)
      const end = pointAt(A0 + sweep)
      const through = pointAt(A0 + sweep / 2)

      const camBuilt = arcThrough3Points(start, end, through, 1e-6)
      expect(camBuilt, `sweep ${sweepDeg}deg must build`).not.toBeNull()
      expect(norm(camBuilt!.endAngle - camBuilt!.startAngle)).toBeCloseTo(sweep, 6)

      const entity = makeArcEntity(`edge${sweepDeg}`, start, end, through)
      const camPoints = tessellateArc({ ...camBuilt!, firstPointSite: 'start' })
      const skPoints = sampleArcPoints(entity)

      expect(skPoints.length, `sweep ${sweepDeg}deg point count`).toBe(camPoints.length)
      for (let i = 0; i < camPoints.length; i++) {
        expect(skPoints[i].x).toBeCloseTo(camPoints[i].x, 6)
        expect(skPoints[i].y).toBeCloseTo(camPoints[i].y, 6)
      }
    }

    // The full-circle-via-arc-sampler convenience (SolidsWorkbenchPage renders circles as
    // `{startAngle: 0, endAngle: 2*PI}`). A plain modulo sends that sweep to zero and the circle
    // silently vanishes; the shared normalizer maps it to a full turn. FAILS-IF that rule is lost.
    const fullTurn = sampleArcPoints({ center, radius, startAngle: 0, endAngle: Math.PI * 2 })
    expect(fullTurn.length).toBe(65) // 64 segments per turn + 1
    expect(fullTurn[0].x).toBeCloseTo(center.x + radius, 6)
    expect(fullTurn[64].x).toBeCloseTo(center.x + radius, 6)
    expect(fullTurn[32].x).toBeCloseTo(center.x - radius, 6) // halfway round, not a degenerate dot
  })
})
