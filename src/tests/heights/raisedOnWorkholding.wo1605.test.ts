// WO-1605 (Smart Heights campaign, slice 2): the slice-1 sketch RAISED 50 mm on
// a vise body marked as workholding, with auto stock, the slice-1 fixed stock
// and a fixed stock 10 mm taller than the auto stock. Face / Pocket 2D /
// Contour 2D / Drill, Smart default, the Bottom row at stock bottom + 1.35 mm,
// and a Pocket through cut (Bottom row at stock bottom - 0.5 mm).
//
// Every expected number below is worked out by hand, from the geometry, in
// docs/testing/SMART-HEIGHTS-CAMPAIGN.md (slice 2 expectation table). Never
// change one to match what the product produced: re-check the arithmetic in
// that doc, and if the expectation stands the case is a finding (it.fails).

import { describe, it, expect } from 'vitest'
import {
  circleLoop, isCutting, isRapid, movesEnteringBox, rapidViolations, rectLoop, runHeightScenario, installRealToolpathWorker,
  type HeightScenario, type ScenarioStock, type ScenarioWorkholding,
} from '../helpers/heightScenario'
import type { ToolpathMove } from '../../types'

installRealToolpathWorker()

const TOL = 0.01
const RAISE = 50

// This slice only authors the four operations the harness had at WO-1605; WO-1607
// widened ScenarioOperation with Adaptive 2D and Bore, which this file does not use.
type ScenarioOperation = 'face' | 'pocket_2d' | 'contour_2d' | 'drill'

const SKETCH_ON_VISE: HeightScenario['part'] = {
  kind: 'sketch_2d',
  z: RAISE,
  loops: [
    rectLoop('outline', 0, 0, 60, 40),
    rectLoop('pocket', 15, 10, 35, 30),
    circleLoop('hole', 48, 20, 4),
  ],
}

// A 50 mm tall vise body under the part, clear of the contour path and of the
// pocket (machine coordinates).
const VISE: ScenarioWorkholding = {
  name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: RAISE },
}

const STOCKS: Record<StockName, ScenarioStock> = {
  auto: { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 },
  fixed: { kind: 'fixed', width: 80, height: 60, depth: 17, position: { x: -10, y: -10, z: RAISE } },
  tall: { kind: 'fixed', width: 70, height: 50, depth: 22, position: { x: -5, y: -5, z: RAISE } },
}

type StockName = 'auto' | 'fixed' | 'tall'
type Setting = 'smart' | 'plus135' | 'through05'

const LOOPS: Record<ScenarioOperation, string[]> = {
  face: [],
  pocket_2d: ['pocket'],
  contour_2d: ['outline'],
  drill: ['hole'],
}

const TOOL_RADIUS: Record<ScenarioOperation, number> = { face: 3, pocket_2d: 3, contour_2d: 3, drill: 2.5 }

interface Expectation {
  case: number
  stock: StockName
  op: ScenarioOperation
  setting: Setting
  /** WCS (zero = stock top). */
  top: number
  bottom: number
  retract: number
  clearance: number
  stockBottom: number
  /** Machine Z (table = 0). */
  stockTopMachine: number
  bottomMachine: number
  /** Tall stock only: WCS Z of the part top (the auto stock top); cutting must start above it. */
  partTop?: number
  finding?: string
}

// The campaign doc's slice-2 expectation table, row for row.
// SH-1 (cases 21, 22, 30, 31, 39, 40): see sketch2dOnTable.wo1604.test.ts.
export const SLICE2_EXPECTATIONS: Expectation[] = [
  { case: 17, stock: 'auto', op: 'face', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 57 },
  { case: 18, stock: 'auto', op: 'face', setting: 'plus135', top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 51.35 },
  { case: 19, stock: 'auto', op: 'pocket_2d', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 57 },
  { case: 20, stock: 'auto', op: 'pocket_2d', setting: 'plus135', top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 51.35 },
  { case: 21, stock: 'auto', op: 'contour_2d', setting: 'smart', top: 0, bottom: -12, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 50 },
  { case: 22, stock: 'auto', op: 'contour_2d', setting: 'plus135', top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 51.35 },
  { case: 23, stock: 'auto', op: 'drill', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 57 },
  { case: 24, stock: 'auto', op: 'drill', setting: 'plus135', top: 0, bottom: -10.65, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 51.35 },
  { case: 25, stock: 'auto', op: 'pocket_2d', setting: 'through05', top: 0, bottom: -12.5, retract: 5, clearance: 15, stockBottom: -12, stockTopMachine: 62, bottomMachine: 49.5 },

  { case: 26, stock: 'fixed', op: 'face', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 62 },
  { case: 27, stock: 'fixed', op: 'face', setting: 'plus135', top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 51.35 },
  { case: 28, stock: 'fixed', op: 'pocket_2d', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 62 },
  { case: 29, stock: 'fixed', op: 'pocket_2d', setting: 'plus135', top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 51.35 },
  { case: 30, stock: 'fixed', op: 'contour_2d', setting: 'smart', top: 0, bottom: -17, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 50 },
  { case: 31, stock: 'fixed', op: 'contour_2d', setting: 'plus135', top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 51.35 },
  { case: 32, stock: 'fixed', op: 'drill', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 62 },
  { case: 33, stock: 'fixed', op: 'drill', setting: 'plus135', top: 0, bottom: -15.65, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 51.35 },
  { case: 34, stock: 'fixed', op: 'pocket_2d', setting: 'through05', top: 0, bottom: -17.5, retract: 5, clearance: 15, stockBottom: -17, stockTopMachine: 67, bottomMachine: 49.5 },

  { case: 35, stock: 'tall', op: 'face', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 67, partTop: -10 },
  { case: 36, stock: 'tall', op: 'face', setting: 'plus135', top: 0, bottom: -20.65, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 51.35, partTop: -10 },
  { case: 37, stock: 'tall', op: 'pocket_2d', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 67, partTop: -10 },
  { case: 38, stock: 'tall', op: 'pocket_2d', setting: 'plus135', top: 0, bottom: -20.65, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 51.35, partTop: -10 },
  { case: 39, stock: 'tall', op: 'contour_2d', setting: 'smart', top: 0, bottom: -22, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 50 },
  { case: 40, stock: 'tall', op: 'contour_2d', setting: 'plus135', top: 0, bottom: -20.65, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 51.35 },
  { case: 41, stock: 'tall', op: 'drill', setting: 'smart', top: 0, bottom: -5, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 67 },
  { case: 42, stock: 'tall', op: 'drill', setting: 'plus135', top: 0, bottom: -20.65, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 51.35 },
  { case: 43, stock: 'tall', op: 'pocket_2d', setting: 'through05', top: 0, bottom: -22.5, retract: 5, clearance: 15, stockBottom: -22, stockTopMachine: 72, bottomMachine: 49.5, partTop: -10 },
]

const BOTTOM_ROW = {
  smart: undefined,
  plus135: { reference: 'stock_bottom' as const, offsetMm: 1.35 },
  through05: { reference: 'stock_bottom' as const, offsetMm: -0.5 },
}

async function checkCase(e: Expectation): Promise<void> {
  const bottomRow = BOTTOM_ROW[e.setting]
  const reading = await runHeightScenario({
    part: SKETCH_ON_VISE,
    stock: STOCKS[e.stock],
    operation: e.op,
    loopIds: LOOPS[e.op],
    workholding: VISE,
    ...(bottomRow ? { bottomRow } : {}),
  })
  const why = `authoring: ${reading.authoringError ?? '-'} | compute: ${reading.status} ${reading.errorMessage ?? ''}`

  // The frames the expectations were written in: the stock sits on the vise.
  expect(reading.stockBottomMachineZ, 'stock bottom (machine)').toBeCloseTo(RAISE, 2)
  expect(reading.stockTopMachineZ, 'stock top (machine)').toBeCloseTo(e.stockTopMachine, 2)
  expect(reading.wcsOriginMachineZ, 'work zero (machine)').toBeCloseTo(e.stockTopMachine, 2)
  expect(reading.stockTopWcs, 'stock top (WCS)').toBeCloseTo(0, 2)
  expect(reading.stockBottomWcs, 'stock bottom (WCS)').toBeCloseTo(e.stockBottom, 2)

  expect(reading.authoringError, why).toBeUndefined()
  expect(reading.status, why).toBe('ready')
  expect(reading.moves.filter(m => isCutting(m, e.op)).length, 'real cutting moves').toBeGreaterThan(0)

  // Deepest cut is the expected bottom, in the program's frame and in the machine's:
  // the depth followed the part up by exactly the raise.
  expect(Math.abs(reading.deepestCutZ - e.bottom), `deepest cut ${reading.deepestCutZ} vs ${e.bottom}`)
    .toBeLessThanOrEqual(TOL)
  expect(Math.abs(reading.deepestCutMachineZ - e.bottomMachine),
    `deepest cut (machine) ${reading.deepestCutMachineZ} vs ${e.bottomMachine}`).toBeLessThanOrEqual(TOL)
  // No cutting move above the expected top.
  expect(reading.highestCuttingZ, 'highest cutting Z').toBeLessThanOrEqual(e.top + TOL)
  // Taller stock: cutting starts in the extra material above the part top.
  if (e.partTop !== undefined && e.op !== 'drill') {
    expect(reading.highestCuttingZ, 'cutting starts above the part top').toBeGreaterThan(e.partTop + TOL)
  }
  // Every rapid at or above the retract; none below the stock top over the stock.
  // Pocket 2D (WO-1972 stay-down, WO-2067): below the retract only on the way
  // into an entry, and never through material still standing.
  const rapids = reading.moves.filter(isRapid)
  expect(rapids.length, 'rapids').toBeGreaterThan(0)
  if (e.op === 'pocket_2d') {
    const violations = rapidViolations(reading.moves, { ...reading.stockXY, topZ: reading.stockTopWcs },
      TOOL_RADIUS[e.op], e.retract)
    expect(violations, 'pocket rapids vs the material left').toEqual([])
  } else {
    // WO-3083 re-pin (one entry rule, owner 2026-10-23): entries rapid down to 1 mm above the
    // material they meet (was the Feed plane / Retract), so the rapid floor is that entry start.
    const entryFloor = Math.min(e.retract, Math.min(e.top, reading.stockTopWcs) + 1)
    expect(reading.lowestRapidZ, 'lowest rapid Z').toBeGreaterThanOrEqual(entryFloor - TOL)
    if (Number.isFinite(reading.lowestRapidOverStockZ)) {
      expect(reading.lowestRapidOverStockZ, 'lowest rapid over the stock').toBeGreaterThanOrEqual(e.top - TOL)
    }
  }
  // Nothing below the stock bottom, except a through cut's own breakthrough.
  const breakthrough = e.setting === 'through05' ? 0.5 : 0
  expect(reading.deepestCutZ, 'below stock bottom + breakthrough')
    .toBeGreaterThanOrEqual(e.stockBottom - breakthrough - TOL)
  // The highest move of the whole path reaches the clearance plane.
  expect(Math.max(...reading.moves.map(m => m.z)), 'clearance').toBeCloseTo(e.clearance, 2)

  // The vise: no move enters it, and every link over its footprint passes above its top.
  const vise = reading.workholdingWcs!
  expect(vise.max.z, 'vise top (WCS) = stock bottom').toBeCloseTo(e.stockBottom, 2)
  const entering = movesEnteringBox(reading.moves, vise, TOOL_RADIUS[e.op])
  expect(entering.length, `moves entering the vise: ${JSON.stringify(entering.slice(0, 3))}`).toBe(0)
  const overVise = rapids.filter(m =>
    m.x > vise.min.x - TOOL_RADIUS[e.op] && m.x < vise.max.x + TOOL_RADIUS[e.op] &&
    m.y > vise.min.y - TOOL_RADIUS[e.op] && m.y < vise.max.y + TOOL_RADIUS[e.op])
  for (const m of overVise) expect(m.z, 'link over the vise').toBeGreaterThan(vise.max.z + TOL)

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
const SETTING_LABEL: Record<Setting, string> = {
  smart: 'Smart', plus135: 'Bottom = stock bottom + 1.35', through05: 'Bottom = stock bottom - 0.5 (through)',
}
const STOCK_LABEL: Record<StockName, string> = {
  auto: 'auto stock', fixed: 'fixed stock', tall: 'fixed stock 10 mm over the part',
}

describe('WO-1605 Smart Heights: 2D sketch raised 50 mm on a vise', () => {
  for (const e of SLICE2_EXPECTATIONS) {
    const name = `case ${e.case}: ${STOCK_LABEL[e.stock]}, ${OP_LABEL[e.op]}, ${SETTING_LABEL[e.setting]}` +
      ` -> top ${e.top}, bottom ${e.bottom} (machine ${e.bottomMachine})` +
      (e.finding ? ` [${e.finding}]` : '')
    if (e.finding) it.fails(name, () => checkCase(e), 60_000)
    else it(name, () => checkCase(e), 60_000)
  }
})

// WO-2067: the controls for the Pocket 2D rapid check, on hand-built moves (a
// control, never application truth - LIENCAM rule 6). A 40 x 40 block, top Z 0,
// a 6 mm cutter, Retract 5. A slot is cut at Z -3 from (10, 10) to (20, 10).
describe('WO-2067 controls: a Pocket 2D rapid is held to the material left', () => {
  const block = { minX: 0, maxX: 40, minY: 0, maxY: 40, topZ: 0 }
  const rapid = (x: number, y: number, z: number): ToolpathMove => ({ type: 'rapid', role: 'rapid', x, y, z })
  const feed = (x: number, y: number, z: number, role: ToolpathMove['role'] = 'cut'): ToolpathMove =>
    ({ type: 'feed', role, feed: 300, x, y, z })
  const slot: ToolpathMove[] = [
    rapid(10, 10, 15), rapid(10, 10, 5),
    rapid(10, 10, 1), feed(10, 10, -3, 'plunge'),   // entry drop over air, then the entry
    feed(20, 10, -3),                               // the slot
  ]

  it('passes the stay-down: lift 1 mm, move over the slot just cut, next entry', () => {
    const moves = [...slot, rapid(20, 10, -2), rapid(12, 10, -2), feed(12, 10, -6, 'plunge'), rapid(12, 10, 5)]
    expect(rapidViolations(moves, block, 3, 5)).toEqual([])
  })

  it('NEGATIVE: a rapid across uncut stock at cut depth fails', () => {
    const moves = [...slot, rapid(20, 30, -3), feed(20, 30, -6, 'plunge'), rapid(20, 30, 5)]
    const violations = rapidViolations(moves, block, 3, 5)
    expect(violations.length, violations.join('\n')).toBe(1)
    expect(violations[0]).toMatch(/^move 5: rapid .* crosses material standing at Z 0\.000$/)
  })

  // WO-2067 audit: the slot's wall stands at Y 13; a stay-down beside the slot
  // puts the real 3 mm radius over the wall by `graze`. Any overlap wider than
  // OVERLAP (0.01 mm) fails - there is no narrower inspection radius to hide in.
  for (const graze of [0.2, 0.05, 0.02]) {
    it(`NEGATIVE: a real cutter grazing standing stock by ${graze} mm fails`, () => {
      const y = 10 + graze
      const moves = [...slot, rapid(20, 10, -2), rapid(15, y, -2), feed(15, y, -6, 'plunge'), rapid(15, y, 5)]
      const violations = rapidViolations(moves, block, 3, 5)
      expect(violations.length, violations.join('\n')).toBe(1)
      expect(violations[0]).toMatch(/^move 6: rapid .* crosses material standing at Z 0\.000$/)
    })
  }

  it('NEGATIVE: an entry drop onto uncut stock (below its top) fails', () => {
    const moves = [rapid(30, 30, 15), rapid(30, 30, -1), feed(30, 30, -3, 'plunge'), rapid(30, 30, 5)]
    expect(rapidViolations(moves, block, 3, 5)[0]).toMatch(/^move 1: .* crosses material/)
  })

  // WO-2067 audit (attempt 2): the replay used to start at move 1, so the
  // operation's very first move was never checked.
  it('NEGATIVE: a first rapid below Retract over untouched stock fails', () => {
    const moves = [rapid(20, 20, -1), feed(20, 20, -3, 'plunge'), rapid(20, 20, 5)]
    const violations = rapidViolations(moves, block, 3, 5)
    expect(violations.length, violations.join('\n')).toBe(1)
    expect(violations[0]).toMatch(/^move 0: rapid at \(20\.00, 20\.00, -1\.000\) crosses material standing at Z 0\.000$/)
  })

  it('NEGATIVE: a first rapid below Retract that leads into no entry fails, even over air', () => {
    const moves = [rapid(60, 60, 1), rapid(60, 60, 15)]
    expect(rapidViolations(moves, block, 3, 5)).toEqual([
      'move 0: rapid at Z 1.000 below 5 does not lead into an entry',
    ])
  })

  it('NEGATIVE: a rapid below Retract that leads into no entry fails, even over air', () => {
    const moves = [...slot, rapid(20, 10, 1), rapid(60, 60, 1), rapid(60, 60, 5)]
    const violations = rapidViolations(moves, block, 3, 5)
    expect(violations.length, violations.join('\n')).toBe(2)
    for (const v of violations) expect(v).toMatch(/does not lead into an entry$/)
  })
})
