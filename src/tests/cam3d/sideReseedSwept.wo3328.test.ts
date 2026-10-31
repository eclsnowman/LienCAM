// WO-3328: a re-seed roll-in must be emittable on a stock field the strategy could not prove.
//
// The 2D planner rolls a leftover that holds no legal helix in from the cleared side
// (WO-1178, WO-409): a 'side' entry whose clear point C it proved inside its own cleared
// belief. The 3D emitter accepted a side entry only on a 2D stock section (passed only for
// an outside-in operation) or on the live carved stock (only when stockProven). An interior
// operation on an unproven field has neither, so the first such roll-in threw
//
//   emitLevelPasses: 'side' entry at z=18 has no stock section (wiring bug, ADR-0003).
//
// and the operation made no toolpath. Gate A.3/A.9 (hemisphereOnSlab) met it on x64 with
// steering smoothing ON; the arm64 Spark's pass stream happens to leave no helix-less
// leftover there, so it never reached the throw. The fixture is that x64 level's exact
// pass stream, so this test reaches the case on any CPU.
//
// The proof that replaces the missing ones is the level's own motion: the cutter already
// swept the disk at C at this depth, so nothing stands above it there. A side entry the
// emitted motion does not prove (an outside-in opening with its section unwired) still
// fails loud -- the ADR-0003 wiring check stays.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import { ensureGeom2dReady } from '../../cam3d/geom2d'
import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import { emitLevelPasses, type EmitContext, type EmitHeights } from '../../cam3d/rough/emit'
import type { CutterSpec } from '../../cam3d/kernel/types'

interface Fixture {
  z: number
  heights: EmitHeights
  toolRadius: number
  cutter: CutterSpec
  helixAngleDeg?: number
  millingDirection?: EmitContext['millingDirection']
  passes: AdaptivePass[]
}

const fixture: Fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./sideReseedSwept.wo3328.fixture.json', import.meta.url)),
  'utf8',
))

// The context adaptiveRough builds on a field it could not prove (stockBoundsAreRealStock
// unset): no live stock proof, and no stock section because the operation is interior.
function unprovenCtx(): EmitContext {
  return {
    cursor: { x: NaN, y: NaN, z: fixture.heights.clearanceZ },
    toolRadius: fixture.toolRadius,
    cutter: fixture.cutter,
    stockProven: false,
    ...(fixture.helixAngleDeg !== undefined ? { helixAngleDeg: fixture.helixAngleDeg } : {}),
    ...(fixture.millingDirection !== undefined ? { millingDirection: fixture.millingDirection } : {}),
  }
}

beforeAll(async () => {
  await ensureGeom2dReady()
})

describe('WO-3328: side re-seed roll-in on an unproven stock field', () => {
  it('emits the x64 Gate A.3 z=18 level: descends at the swept clear point, then leads in', () => {
    const side = fixture.passes.find((p) => p.type === 'entry' && p.mode === 'side')
    if (!side || side.type !== 'entry' || !side.clearPoint) throw new Error('fixture lost its side entry')
    const C = side.clearPoint
    const P = side.point

    const moves = emitLevelPasses(fixture.passes, fixture.z, fixture.heights, unprovenCtx(), undefined)

    const lead = moves.findIndex((m) => m.role === 'lead_in' && m.x === P.x && m.y === P.y)
    expect(lead).toBeGreaterThan(0)
    expect(moves[lead]).toMatchObject({ t: 'feed', z: fixture.z })
    // The descent is vertical at C and ends at the cutting depth; the lead follows it.
    expect(moves[lead - 1]).toMatchObject({ x: C.x, y: C.y, z: fixture.z })
  })

  it('still fails loud when the level motion never swept the clear point (wiring check stays)', () => {
    // An outside-in opening with its stock section unwired: C stands in air nothing swept.
    const passes: AdaptivePass[] = [
      { type: 'entry', point: { x: -0.5, y: 5 }, clearPoint: { x: -2, y: 5 }, radius: 0, mode: 'side' },
      { type: 'cut', points: [{ x: -0.5, y: 5 }, { x: 4, y: 5 }] },
    ]
    expect(() => emitLevelPasses(
      passes, 1, { clearanceZ: 5, retractZ: 3, feedZ: 2 },
      { cursor: { x: NaN, y: NaN, z: 5 }, toolRadius: 1, cutter: { kind: 'flat', diameter: 2 }, stockProven: false },
    )).toThrow(/'side' entry at z=1 has no stock section \(wiring bug, ADR-0003\)/)
  })

  it('refuses a re-seed whose clear disk the level swept only in part', () => {
    // A helix opens (5,5), a cut runs to (15,5); the re-seed clear point at (10,6.5) has
    // most of its disk off the 2 mm wide swept band.
    const passes: AdaptivePass[] = [
      { type: 'entry', point: { x: 5, y: 5 }, radius: 0.6, mode: 'helix' },
      { type: 'cut', points: [{ x: 5, y: 5 }, { x: 15, y: 5 }] },
      { type: 'entry', point: { x: 10, y: 7.5 }, clearPoint: { x: 10, y: 6.5 }, radius: 0, mode: 'side' },
      { type: 'cut', points: [{ x: 10, y: 7.5 }, { x: 14, y: 7.5 }] },
    ]
    expect(() => emitLevelPasses(
      passes, 1, { clearanceZ: 5, retractZ: 3, feedZ: 2 },
      { cursor: { x: NaN, y: NaN, z: 5 }, toolRadius: 1, cutter: { kind: 'flat', diameter: 2 }, stockProven: false },
    )).toThrow(/has no stock section \(wiring bug, ADR-0003\)/)
  })

  it('accepts a re-seed whose clear disk the level already swept at this depth', () => {
    const passes: AdaptivePass[] = [
      { type: 'entry', point: { x: 5, y: 5 }, radius: 0.6, mode: 'helix' },
      { type: 'cut', points: [{ x: 5, y: 5 }, { x: 15, y: 5 }] },
      { type: 'entry', point: { x: 10, y: 6.2 }, clearPoint: { x: 10, y: 5 }, radius: 0, mode: 'side' },
      { type: 'cut', points: [{ x: 10, y: 6.2 }, { x: 14, y: 6.2 }] },
    ]
    const moves = emitLevelPasses(
      passes, 1, { clearanceZ: 5, retractZ: 3, feedZ: 2 },
      { cursor: { x: NaN, y: NaN, z: 5 }, toolRadius: 1, cutter: { kind: 'flat', diameter: 2 }, stockProven: false },
    )
    const lead = moves.findIndex((m) => m.role === 'lead_in')
    expect(moves[lead]).toMatchObject({ t: 'feed', x: 10, y: 6.2, z: 1 })
    expect(moves[lead - 1]).toMatchObject({ t: 'rapid', x: 10, y: 5, z: 1 })
  })
})
