// WO-1604 (Smart Heights campaign, slice 1): a 2D sketch lying on the table,
// auto and fixed stock, Face / Pocket 2D / Contour 2D / Drill, Smart default and
// the Bottom row set to stock bottom + 1.35 mm.
//
// Every expected number below is worked out by hand, from the geometry, in
// docs/testing/SMART-HEIGHTS-CAMPAIGN.md (slice 1 expectation table). Never
// change one to match what the product produced: re-check the arithmetic in
// that doc, and if the expectation stands the case is a finding (it.fails).

import { describe, it, expect } from 'vitest'
import {
  circleLoop, isCutting, isRapid, rapidViolations, rectLoop, runHeightScenario, installRealToolpathWorker,
  type HeightScenario, type ScenarioStock,
} from '../helpers/heightScenario'

installRealToolpathWorker()

const TOL = 0.01
const POCKET_TOOL_RADIUS = 3 // the harness's default 6 mm end mill

// This slice only authors the four operations the harness had at WO-1604; WO-1607
// widened ScenarioOperation with Adaptive 2D and Bore, which this file does not use.
type ScenarioOperation = 'face' | 'pocket_2d' | 'contour_2d' | 'drill'

const SKETCH_ON_TABLE: HeightScenario['part'] = {
  kind: 'sketch_2d',
  z: 0,
  loops: [
    rectLoop('outline', 0, 0, 60, 40),
    rectLoop('pocket', 15, 10, 35, 30),
    circleLoop('hole', 48, 20, 4),
  ],
}

const AUTO_STOCK: ScenarioStock = { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const FIXED_STOCK: ScenarioStock = {
  kind: 'fixed', width: 80, height: 60, depth: 17, position: { x: -10, y: -10, z: 0 },
}

const LOOPS: Record<ScenarioOperation, string[]> = {
  face: [],
  pocket_2d: ['pocket'],
  contour_2d: ['outline'],
  drill: ['hole'],
}

interface Expectation {
  case: number
  stock: 'auto' | 'fixed'
  op: ScenarioOperation
  override: boolean
  top: number
  bottom: number
  retract: number
  clearance: number
  stockBottom: number
  /** Finding id when the product does not meet this expectation. */
  finding?: string
}

// The campaign doc's expectation table, row for row.
// SH-1 (cases 5, 6, 13, 14): the operation dialog starts a Contour on a picked
// flat 2D loop as "selected feature" (useNewOperationModalState.ts, the
// selectedFeatureByFamily contour_2d entry counts any picked loop), and the
// selected-feature derivation then refuses the flat curve
// (contourFeatureEvidence.ts deriveOne) - so no Contour authority exists to
// compute, with or without the Bottom row. The expectation stands: the stock is
// proven, so the cut goes to the stock bottom.
export const SLICE1_EXPECTATIONS: Expectation[] = [
  { case: 1, stock: 'auto', op: 'face', override: false, top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 2, stock: 'auto', op: 'face', override: true, top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 3, stock: 'auto', op: 'pocket_2d', override: false, top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 4, stock: 'auto', op: 'pocket_2d', override: true, top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 5, stock: 'auto', op: 'contour_2d', override: false, top: 0, bottom: -12, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 6, stock: 'auto', op: 'contour_2d', override: true, top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 7, stock: 'auto', op: 'drill', override: false, top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 8, stock: 'auto', op: 'drill', override: true, top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12 },
  { case: 9, stock: 'fixed', op: 'face', override: false, top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 10, stock: 'fixed', op: 'face', override: true, top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 11, stock: 'fixed', op: 'pocket_2d', override: false, top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 12, stock: 'fixed', op: 'pocket_2d', override: true, top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 13, stock: 'fixed', op: 'contour_2d', override: false, top: 0, bottom: -17, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 14, stock: 'fixed', op: 'contour_2d', override: true, top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 15, stock: 'fixed', op: 'drill', override: false, top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -17 },
  { case: 16, stock: 'fixed', op: 'drill', override: true, top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17 },
]

async function checkCase(e: Expectation): Promise<void> {
  const reading = await runHeightScenario({
    part: SKETCH_ON_TABLE,
    stock: e.stock === 'auto' ? AUTO_STOCK : FIXED_STOCK,
    operation: e.op,
    loopIds: LOOPS[e.op],
    ...(e.override ? { bottomRow: { reference: 'stock_bottom' as const, offsetMm: 1.35 } } : {}),
  })
  const why = `authoring: ${reading.authoringError ?? '-'} | compute: ${reading.status} ${reading.errorMessage ?? ''}`

  // The frame the expectations were written in.
  expect(reading.stockTopWcs, 'stock top (WCS)').toBeCloseTo(0, 2)
  expect(reading.stockBottomWcs, 'stock bottom (WCS)').toBeCloseTo(e.stockBottom, 2)

  expect(reading.authoringError, why).toBeUndefined()
  expect(reading.status, why).toBe('ready')
  expect(reading.moves.filter(m => isCutting(m, e.op)).length, 'real cutting moves').toBeGreaterThan(0)

  // Deepest cut is the expected bottom (stock to leave is 0 in every case).
  expect(Math.abs(reading.deepestCutZ - e.bottom), `deepest cut ${reading.deepestCutZ} vs ${e.bottom}`)
    .toBeLessThanOrEqual(TOL)
  // No cutting move above the expected top.
  expect(reading.highestCuttingZ, 'highest cutting Z').toBeLessThanOrEqual(e.top + TOL)
  // Every rapid at or above the retract; none below the stock top over the stock.
  const rapids = reading.moves.filter(isRapid)
  expect(rapids.length, 'rapids').toBeGreaterThan(0)
  if (e.op === 'pocket_2d') {
    // Pocket 2D's stay-down (WO-1972, WO-2466): a rapid may sit below the Retract
    // over material the operation already removed - never through stock still standing.
    const violations = rapidViolations(reading.moves, { ...reading.stockXY, topZ: reading.stockTopWcs },
      POCKET_TOOL_RADIUS, e.retract)
    expect(violations, 'pocket rapids vs the material left').toEqual([])
  } else {
    expect(reading.lowestRapidZ, 'lowest rapid Z').toBeGreaterThanOrEqual(e.retract - TOL)
    if (Number.isFinite(reading.lowestRapidOverStockZ)) {
      expect(reading.lowestRapidOverStockZ, 'lowest rapid over the stock').toBeGreaterThanOrEqual(e.top - TOL)
    }
  }
  // Nothing below the stock bottom (no case in this slice is a through-cut below it).
  expect(reading.deepestCutZ, 'below stock bottom').toBeGreaterThanOrEqual(e.stockBottom - TOL)
  // The highest move of the whole path reaches the clearance plane.
  expect(Math.max(...reading.moves.map(m => m.z)), 'clearance').toBeCloseTo(e.clearance, 2)

  // The Heights tab rows say what the moves do.
  expect(reading.heightsRow.top, 'Heights row: Top').toBeCloseTo(e.top, 2)
  expect(reading.heightsRow.bottom, 'Heights row: Bottom').toBeCloseTo(e.bottom, 2)
  expect(Math.abs((reading.heightsRow.bottom ?? NaN) - reading.deepestCutZ), 'row Bottom = moves')
    .toBeLessThanOrEqual(TOL)
  expect(reading.heightsRow.retract, 'Heights row: Retract').toBeCloseTo(e.retract, 2)
  expect(reading.heightsRow.clearance, 'Heights row: Clearance').toBeCloseTo(e.clearance, 2)
}

const OP_LABEL: Record<ScenarioOperation, string> = {
  face: 'Face', pocket_2d: 'Pocket 2D', contour_2d: 'Contour 2D', drill: 'Drill',
}

describe('WO-1604 Smart Heights: 2D sketch on the table', () => {
  for (const e of SLICE1_EXPECTATIONS) {
    const name = `case ${e.case}: ${e.stock} stock, ${OP_LABEL[e.op]}, ` +
      `${e.override ? 'Bottom = stock bottom + 1.35' : 'Smart'} -> top ${e.top}, bottom ${e.bottom}` +
      (e.finding ? ` [${e.finding}]` : '')
    if (e.finding) it.fails(name, () => checkCase(e), 60_000)
    else it(name, () => checkCase(e), 60_000)
  }
})
