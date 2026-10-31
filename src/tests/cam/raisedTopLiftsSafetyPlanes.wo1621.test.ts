// WO-1621 (SH-11): a raised Top Height lifts the Setup-owned safety planes
// instead of refusing. The Setup default is Retract 5, Feed = Top + 5,
// Clearance = Retract + 10; raising Top to stock top + 2 puts Feed at 7, above
// the untouched Retract. The software can plan that - Retract and Clearance
// were never the operator's - so it lifts them. Only planes the operator set
// himself that contradict each other still refuse.
//
// Production compute path: the WO-1607 heightScenario harness on the WO-1605
// raised sketch, auto stock.

import { describe, it, expect } from 'vitest'
import {
  circleLoop, isRapid, isCutting, rapidViolations, rectLoop, runHeightScenario, installRealToolpathWorker,
  type HeightScenario, type ScenarioStock, type ScenarioWorkholding,
} from '../helpers/heightScenario'

installRealToolpathWorker()

const TOL = 0.01
const RAISE = 50

const SKETCH_ON_VISE: HeightScenario['part'] = {
  kind: 'sketch_2d',
  z: RAISE,
  loops: [
    rectLoop('outline', 0, 0, 60, 40),
    rectLoop('pocket', 15, 10, 35, 30),
    circleLoop('hole', 48, 20, 4),
  ],
}

const VISE: ScenarioWorkholding = {
  name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: RAISE },
}

const AUTO_STOCK: ScenarioStock = { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }

const OPS = [
  { op: 'face' as const, label: 'Face', loops: [] as string[] },
  { op: 'pocket_2d' as const, label: 'Pocket 2D', loops: ['pocket'] },
]

describe('WO-1621: a raised Top lifts the Setup-owned safety planes', () => {
  for (const { op, label, loops } of OPS) {
    it(`${label}: Top = stock top + 2 is ready with Feed 7, Retract 7, Clearance >= 7`, async () => {
      const reading = await runHeightScenario({
        part: SKETCH_ON_VISE, stock: AUTO_STOCK, operation: op, loopIds: loops, workholding: VISE,
        topRow: { reference: 'stock_top', offsetMm: 2 },
      })
      const why = `authoring: ${reading.authoringError ?? '-'} | compute: ${reading.status} ${reading.errorMessage ?? ''}`
      expect(reading.authoringError, why).toBeUndefined()
      expect(reading.status, why).toBe('ready')
      expect(reading.moves.filter(m => isCutting(m, op)).length, 'real cutting moves').toBeGreaterThan(0)

      expect(reading.heightsRow.top, 'Heights row: Top').toBeCloseTo(2, 2)
      expect(reading.plan?.safety.feed.wcsMm, 'Heights row: Feed').toBeCloseTo(7, 2)
      expect(reading.heightsRow.retract, 'Heights row: Retract').toBeCloseTo(7, 2)
      expect(reading.heightsRow.clearance!, 'Heights row: Clearance').toBeGreaterThanOrEqual(7 - TOL)

      expect(reading.highestCuttingZ, 'no cutting move above Top').toBeLessThanOrEqual(2 + TOL)
      expect(reading.moves.filter(isRapid).length, 'rapids').toBeGreaterThan(0)
      if (op === 'pocket_2d') {
        // Pocket 2D's stay-down (WO-1972, WO-2466): below Feed only over material already removed.
        const violations = rapidViolations(reading.moves, { ...reading.stockXY, topZ: reading.stockTopWcs },
          3, 7)
        expect(violations, 'pocket rapids vs the material left').toEqual([])
      } else {
        // WO-3083: Face enters at material + 1, so each pass's entry rapid descends from
        // Clearance to 1 mm above the surface it is about to cut and then plunges; every other
        // rapid stays at or above the Feed plane and nothing enters the material.
        const rapids = reading.moves.map((m, i) => [m, i] as const).filter(([m]) => isRapid(m))
        const belowFeed = rapids.filter(([m]) => m.z < 7 - TOL)
        expect(belowFeed.length, 'one entry rapid per pass').toBeGreaterThan(0)
        for (const [m, i] of belowFeed) {
          const next = reading.moves[i + 1]
          expect(next?.type, 'the entry rapid is followed by its plunge').toBe('feed')
          expect(next.z, 'the plunge starts at the entry rapid').toBeLessThanOrEqual(m.z + TOL)
        }
        expect(reading.lowestRapidZ, 'the entry rapid stops at material + 1').toBeGreaterThanOrEqual(1 - TOL)
        expect(rapids.every(([m]) => m.z >= 1 - TOL), 'no rapid below material + 1').toBe(true)
      }
      // The row and the moves never disagree: the path's highest point is the row's Clearance.
      expect(Math.max(...reading.moves.map(m => m.z)), 'clearance = row')
        .toBeCloseTo(reading.heightsRow.clearance!, 2)
    }, 60_000)
  }

  it('Face: a user-set Retract below the raised Top still refuses, naming the planes', async () => {
    const reading = await runHeightScenario({
      part: SKETCH_ON_VISE, stock: AUTO_STOCK, operation: 'face', loopIds: [], workholding: VISE,
      topRow: { reference: 'stock_top', offsetMm: 2 },
      safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 1 },
    })
    expect(reading.status).toBe('error')
    expect(reading.errorMessage).toMatch(/invalid_plane_order/)
    expect(reading.errorMessage).toMatch(/Retract \(1\) is below Feed \(7\)/)
  }, 60_000)
})
