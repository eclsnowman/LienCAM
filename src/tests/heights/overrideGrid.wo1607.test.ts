// WO-1607 (Smart Heights campaign, slice 4): the override grid, for every
// operation the previous slices had not yet reached - Adaptive 2D and Bore net
// new, plus Face / Pocket 2D / Contour 2D / Drill re-run through the wider
// grid - on the WO-1605 raised-on-a-vise sketch, auto stock. Five settings per
// operation: Smart, Bottom = stock bottom + 1.35 (the earlier slices' case),
// Bottom = stock top - 8 (a SECOND reference, negative direction), Top = stock
// top + 2 (the Top row, not just Bottom), and Retract = WCS 20 (a safety row -
// Clearance follows it, since the Setup's own default defines Clearance as
// Retract + 10).
//
// Every expected number below is worked out by hand from the geometry (see
// docs/testing/SMART-HEIGHTS-CAMPAIGN.md, slice 4). Never change one to match
// what the product produced: if the expectation stands the case is a finding
// (it.fails). Chamfer, Engrave and Adaptive 3D's safety rows are NOT in this
// grid - see the campaign doc's slice 4 section for why, logged rather than
// silently skipped.

import { describe, it, expect } from 'vitest'
import {
  circleLoop, isCutting, isRapid, rapidViolations, rectLoop, runHeightScenario, installRealToolpathWorker,
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

// The WO-1605 vise: its top sits exactly at the auto stock's bottom (WCS -12),
// so every bottom this grid tries (-5, -8, -10.65) stays clear of it without a
// dedicated entry check - see WO-1605's own scenario for that proof.
const VISE: ScenarioWorkholding = {
  name: 'Vise', min: { x: 40, y: 5, z: 0 }, max: { x: 56, y: 35, z: RAISE },
}

const AUTO_STOCK: ScenarioStock = { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 }
const STOCK_BOTTOM_WCS = -12

type GridOp = 'face' | 'pocket_2d' | 'adaptive_clearing_2d' | 'contour_2d' | 'drill' | 'bore'

const OPS: GridOp[] = ['face', 'pocket_2d', 'adaptive_clearing_2d', 'contour_2d', 'drill', 'bore']

const LOOPS: Record<GridOp, string[]> = {
  face: [], pocket_2d: ['pocket'], adaptive_clearing_2d: ['pocket'],
  contour_2d: ['outline'], drill: ['hole'], bore: ['hole'],
}

const OP_LABEL: Record<GridOp, string> = {
  face: 'Face', pocket_2d: 'Pocket 2D', adaptive_clearing_2d: 'Adaptive 2D',
  contour_2d: 'Contour 2D', drill: 'Drill', bore: 'Bore',
}

// Smart default Bottom (WCS), from the same rule as WO-1604/1605: Face / Pocket
// / Adaptive / Drill / Bore have no physical floor on a flat sketch, so the
// dialog proposes 5 mm from stock top; Contour goes to the stock bottom (fixed
// by WO-1610 - it used to be SH-1, WO-1602's flat-curve refusal).
const SMART_BOTTOM: Record<GridOp, number> = {
  face: -5, pocket_2d: -5, adaptive_clearing_2d: -5, contour_2d: STOCK_BOTTOM_WCS, drill: -5, bore: -5,
}

type Kind = 'smart' | 'bottom_stock_bottom_plus' | 'bottom_stock_top_minus' | 'top_stock_top_minus' | 'safety_retract'

interface Expectation {
  case: number
  op: GridOp
  kind: Kind
  top: number
  bottom: number
  retract: number
  clearance: number
  finding?: string
}

let caseNo = 900
const GRID_EXPECTATIONS: Expectation[] = []
for (const op of OPS) {
  const bottom = SMART_BOTTOM[op]
  GRID_EXPECTATIONS.push(
    { case: caseNo++, op, kind: 'smart', top: 0, bottom, retract: 5, clearance: 15 },
    { case: caseNo++, op, kind: 'bottom_stock_bottom_plus', top: 0, bottom: STOCK_BOTTOM_WCS + 1.35, retract: 5, clearance: 15 },
    { case: caseNo++, op, kind: 'bottom_stock_top_minus', top: 0, bottom: -8, retract: 5, clearance: 15 },
    // Top must stay low enough that Feed (top + 5, the Setup's own default
    // formula) does not exceed the untouched Retract (5): a raised Top of +2
    // broke the product's own Clearance >= Retract >= Feed >= Top ordering
    // before a single move could be planned - not this grid's question.
    { case: caseNo++, op, kind: 'top_stock_top_minus', top: -3, bottom, retract: 5, clearance: 15 },
    { case: caseNo++, op, kind: 'safety_retract', top: 0, bottom, retract: 20, clearance: 30 },
  )
}

function scenarioFor(e: Expectation): HeightScenario {
  const base: HeightScenario = {
    part: SKETCH_ON_VISE, stock: AUTO_STOCK, operation: e.op, loopIds: LOOPS[e.op], workholding: VISE,
  }
  switch (e.kind) {
    case 'smart': return base
    case 'bottom_stock_bottom_plus':
      return { ...base, bottomRow: { reference: 'stock_bottom', offsetMm: 1.35 } }
    case 'bottom_stock_top_minus':
      return { ...base, bottomRow: { reference: 'stock_top', offsetMm: -8 } }
    case 'top_stock_top_minus':
      return { ...base, topRow: { reference: 'stock_top', offsetMm: -3 } }
    case 'safety_retract':
      return { ...base, safetyOverride: { plane: 'retract', reference: 'wcs_plane', offsetMm: 20 } }
  }
}

const POCKET_TOOL_RADIUS = 3 // the harness's default 6 mm end mill

async function checkCase(e: Expectation): Promise<void> {
  const reading = await runHeightScenario(scenarioFor(e))
  const why = `authoring: ${reading.authoringError ?? '-'} | compute: ${reading.status} ${reading.errorMessage ?? ''}`

  expect(reading.stockTopWcs, 'stock top (WCS)').toBeCloseTo(0, 2)
  expect(reading.stockBottomWcs, 'stock bottom (WCS)').toBeCloseTo(STOCK_BOTTOM_WCS, 2)

  expect(reading.authoringError, why).toBeUndefined()
  expect(reading.status, why).toBe('ready')
  expect(reading.moves.filter(m => isCutting(m, e.op as never)).length, 'real cutting moves').toBeGreaterThan(0)

  // Deepest cut is the expected bottom; nothing cuts above the expected top.
  expect(Math.abs(reading.deepestCutZ - e.bottom), `deepest cut ${reading.deepestCutZ} vs ${e.bottom}`)
    .toBeLessThanOrEqual(TOL)
  expect(reading.highestCuttingZ, 'highest cutting Z').toBeLessThanOrEqual(e.top + TOL)

  const rapids = reading.moves.filter(isRapid)
  expect(rapids.length, 'rapids').toBeGreaterThan(0)
  if (e.op === 'adaptive_clearing_2d') {
    // Adaptive Clearing's own stay-down (integralWallFollow, the same
    // family as Adaptive 3D's proven WO-096 links) rides links low inside
    // cleared material rather than retracting every time; it is held to
    // "never below the bottom of cut", not to Retract/Feed.
    expect(reading.lowestRapidZ, 'stay-down never below the bottom of cut').toBeGreaterThanOrEqual(e.bottom - TOL)
  } else if (e.op === 'pocket_2d') {
    // Pocket 2D's WO-1972 stay-down (WO-2067): below the Feed plane (Top + 5,
    // as below) only on the way into an entry, and never through material
    // still standing.
    const violations = rapidViolations(reading.moves, { ...reading.stockXY, topZ: reading.stockTopWcs },
      POCKET_TOOL_RADIUS, e.top + 5)
    expect(violations, 'pocket rapids vs the material left').toEqual([])
  } else {
    // WO-3083 re-pin (one entry rule, owner 2026-10-23): every entry now rapids down to
    // 1 mm above the material it meets (was the Feed plane, Top + 5), so the floor a
    // Retract override must hold is the entry start, 1 mm over the material.
    const entryFloor = Math.min(e.top, reading.stockTopWcs) + 1
    expect(reading.lowestRapidZ, 'lowest rapid Z').toBeGreaterThanOrEqual(entryFloor - TOL)
    if (Number.isFinite(reading.lowestRapidOverStockZ)) {
      expect(reading.lowestRapidOverStockZ, 'lowest rapid over the stock').toBeGreaterThanOrEqual(e.top - TOL)
    }
  }
  expect(reading.deepestCutZ, 'below stock bottom').toBeGreaterThanOrEqual(STOCK_BOTTOM_WCS - TOL)
  // The highest point of the whole path reaches the clearance this case names
  // (WO-1607's second outcome: every link and feed-in uses exactly that height).
  expect(Math.max(...reading.moves.map(m => m.z)), 'clearance').toBeCloseTo(e.clearance, 2)

  // The Heights tab rows say what the moves do - the WO-1599/1601/1602 rule
  // (WO-1607's third outcome: the row and the moves never disagree).
  expect(reading.heightsRow.top, 'Heights row: Top').toBeCloseTo(e.top, 2)
  expect(reading.heightsRow.bottom, 'Heights row: Bottom').toBeCloseTo(e.bottom, 2)
  expect(Math.abs((reading.heightsRow.bottom ?? NaN) - reading.deepestCutZ), 'row Bottom = moves')
    .toBeLessThanOrEqual(TOL)
  expect(reading.heightsRow.retract, 'Heights row: Retract').toBeCloseTo(e.retract, 2)
  expect(reading.heightsRow.clearance, 'Heights row: Clearance').toBeCloseTo(e.clearance, 2)
}

const KIND_LABEL: Record<Kind, string> = {
  smart: 'Smart',
  bottom_stock_bottom_plus: 'Bottom = stock bottom + 1.35',
  bottom_stock_top_minus: 'Bottom = stock top - 8',
  top_stock_top_minus: 'Top = stock top - 3',
  safety_retract: 'Retract = WCS 20 (Clearance follows, Retract + 10)',
}

describe('WO-1607 Smart Heights: the override grid (raised sketch, auto stock)', () => {
  for (const e of GRID_EXPECTATIONS) {
    const name = `case ${e.case}: ${OP_LABEL[e.op]}, ${KIND_LABEL[e.kind]} -> ` +
      `top ${e.top}, bottom ${e.bottom}, retract ${e.retract}, clearance ${e.clearance}` +
      (e.finding ? ` [${e.finding}]` : '')
    if (e.finding) it.fails(name, () => checkCase(e), 60_000)
    else it(name, () => checkCase(e), 60_000)
  }
})

// Clearing an override: WO-1607's fourth outcome ("clearing an override
// returns the moves to the Smart result"). The harness builds a fresh
// operation per case rather than editing one in place, so "cleared" and
// "never set" are the same authoring path - proven directly by the 'smart'
// case of every operation above, run right beside its override siblings on
// the same part/stock. This block re-asserts it as its own named case so the
// outcome has a case number of its own, not just a shared implication.
describe('WO-1607 Smart Heights: clearing an override reproduces Smart', () => {
  for (const op of OPS) {
    const smart = GRID_EXPECTATIONS.find(e => e.op === op && e.kind === 'smart')!
    const name = `${OP_LABEL[op]}: an override case with no bottomRow/topRow/safetyOverride equals its Smart row` +
      (smart.finding ? ` [${smart.finding}]` : '')
    const run = async () => {
      const cleared = await runHeightScenario({
        part: SKETCH_ON_VISE, stock: AUTO_STOCK, operation: op, loopIds: LOOPS[op], workholding: VISE,
      })
      expect(cleared.authoringError, cleared.authoringError ?? '-').toBeUndefined()
      expect(cleared.heightsRow.top, 'Top').toBeCloseTo(smart.top, 2)
      expect(cleared.heightsRow.bottom, 'Bottom').toBeCloseTo(smart.bottom, 2)
      expect(cleared.heightsRow.retract, 'Retract').toBeCloseTo(smart.retract, 2)
      expect(cleared.heightsRow.clearance, 'Clearance').toBeCloseTo(smart.clearance, 2)
    }
    if (smart.finding) it.fails(name, run, 60_000)
    else it(name, run, 60_000)
  }
})
