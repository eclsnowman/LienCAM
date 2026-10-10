// WO-1606 (Smart Heights campaign, slice 3): imported 3D solids, on the table
// and raised on a vise, auto and fixed stock. Adaptive 3D in each Material
// source mode, Parallel 3D and Waterline 3D Smart defaults, Drill on detected
// holes, and the sequence Operator named: an Adaptive 3D rough, then a second
// operation on the same part.
//
// Every expected number below is worked out by hand, from the model
// dimensions, in docs/testing/SMART-HEIGHTS-CAMPAIGN.md (slice 3). Never change
// one to match what the product produced: re-check the arithmetic in that doc,
// and if the expectation stands the case is a finding (it.fails).
//
// Only browser transports are replaced (see heightScenario.ts, "WO-1606"):
// the STEP byte cache, the tessellator worker, the cam3d worker and the model
// worker's hole query. The code behind each is the product's.

import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: async (geoId: string) => (await import('../helpers/heightScenario')).solidStepBytes(geoId),
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: async (source, tolerance) =>
      (await import('../helpers/heightScenario')).tessellateSolid(source, tolerance),
  }))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) =>
  typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => scenarioModule.inProcessCam3dClient(),
    disposeCam3dClient: () => {},
  }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) =>
  typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
    deriveHoles: async (geoId: string) =>
      (await import('../helpers/heightScenario')).deriveHolesInProcess(geoId),
  }))

import * as scenarioModule from '../helpers/heightScenario'
import {
  installRealToolpathWorker, isCutting, isRapid, movesEnteringBox, runSolidScenario, solidGougeMm,
  type AdaptiveMaterialSource, type ScenarioStock, type ScenarioWorkholding, type SolidOperation, type SolidOperationReading,
  type SolidPartName,
} from '../helpers/heightScenario'
import type { ToolpathMove } from '../../types'
import { TRAVERSE_STANDOFF_MM } from '../../cam3d/pathbuild'

installRealToolpathWorker()

const TOL = 0.01
const RAISE = 50
/** This slice measures HEIGHTS. A cutter running along a wall within half a
 * millimetre is measured as clear of it (the radial reading is logged
 * as a record, see radialPenetrationMm), so a vertical reading is about Z. */
const LATERAL_SLACK = 0.5
type Placement = 'table' | 'raised'

// ─── the closed box, 30 x 20 x 10 (model X 0..30, Y 0..20, Z 0..10) ─────────

// Under the box footprint only (X 0..30, Y 0..20), so nothing has a reason to
// go near it except by descending past the part's own bottom.
const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }

type BoxStockName = 'auto' | 'fixed'
function boxStock(name: BoxStockName, placement: Placement): ScenarioStock {
  const z = placement === 'raised' ? RAISE : 0
  return name === 'auto'
    ? { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
    : { kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z } }
}

/** WCS numbers (zero = stock top) that do not depend on the placement. */
const BOX_FRAME: Record<BoxStockName, { partTop: number; partBottom: number; stockBottom: number; stockHeight: number }> = {
  auto: { partTop: -3, partBottom: -13, stockBottom: -13, stockHeight: 13 },
  fixed: { partTop: -5, partBottom: -15, stockBottom: -15, stockHeight: 15 },
}

/** The operator's rough: 6 mm flat, 0.5 mm axial stock to leave, cut out to
 * the stock boundary (the Stock boundary checkbox) so the walls are roughed. */
function rough(
  source: AdaptiveMaterialSource,
  extra: { band?: { topWcsMm: number; bottomWcsMm: number } } = {},
): SolidOperation {
  return {
    kind: 'adaptive_3d', source, toolDiameter: 6, axialStockToLeave: 0.5,
    params: { useStockBoundary: true }, ...extra,
  }
}

/** WO1606_NO_FINDINGS=1 runs every case as a plain test, to re-read what the
 * product does before a finding id is kept or dropped. */
const MARK_FINDINGS = process.env.WO1606_NO_FINDINGS !== '1'
const itCase = (finding: string | undefined) => (finding && MARK_FINDINGS ? it.fails : it)

// ─── what every operation must satisfy ──────────────────────────────────────

interface Common {
  top?: number
  retract: number
  clearance: number
  stockBottom: number
  stockTopMachine: number
  /** Deepest a cut may legitimately go; default the stock bottom (a through drill's point goes below it). */
  lowestCut?: number
}

const highest = (moves: readonly ToolpathMove[]) => moves.reduce((z, m) => (m.z > z ? m.z : z), -Infinity)

/** Adaptive 3D keeps proven stay-down links inside cleared material (WO-096):
 * its rapids are allowed below the retract, and are held to "never through the
 * part" instead (checkAdaptive, adaptiveLinksClearPart). A Parallel 3D finish links
 * between passes just over the proven stock top (WO-2210: stock top + standoff).
 * Every other family links at or above the retract. */
async function frameAndSafety(r: SolidOperationReading, e: Common): Promise<void> {
  const why = `authoring: ${r.authoringError ?? '-'} | compute: ${r.status} ${r.errorMessage ?? ''}`
  expect(r.stockTopMachineZ, 'stock top (machine)').toBeCloseTo(e.stockTopMachine, 2)
  expect(r.wcsOriginMachineZ, 'work zero (machine)').toBeCloseTo(e.stockTopMachine, 2)
  expect(r.stockTopWcs, 'stock top (WCS)').toBeCloseTo(0, 2)
  expect(r.stockBottomWcs, 'stock bottom (WCS)').toBeCloseTo(e.stockBottom, 2)
  expect(r.authoringError, why).toBeUndefined()
  expect(r.status, why).toBe('ready')
  expect(r.moves.filter(m => isCutting(m, r.kind === 'drill' ? 'drill' : undefined)).length, 'cutting moves')
    .toBeGreaterThan(0)
  // No cutting move above the material top.
  expect(r.highestCuttingZ, 'highest cutting Z').toBeLessThanOrEqual((e.top ?? 0) + TOL)
  // Every rapid at or above the Setup's retract; the path reaches clearance.
  if (r.kind === 'parallel_3d') {
    expect(r.lowestRapidZ, 'lowest rapid Z: the stock top + standoff').toBeGreaterThanOrEqual(TRAVERSE_STANDOFF_MM - TOL)
  } else if (r.kind !== 'adaptive_3d') {
    expect(r.lowestRapidZ, 'lowest rapid Z').toBeGreaterThanOrEqual(e.retract - TOL)
  }
  expect(highest(r.moves), 'clearance').toBeCloseTo(e.clearance, 2)
  // Nothing below the stock bottom (or below a through drill's own point).
  expect(r.deepestCutZ, 'below the stock bottom').toBeGreaterThanOrEqual((e.lowestCut ?? e.stockBottom) - TOL)
  // The Heights tab rows say what the moves use.
  expect(r.heightsRow.retract, 'Heights row: Retract').toBeCloseTo(e.retract, 2)
  expect(r.heightsRow.clearance, 'Heights row: Clearance').toBeCloseTo(e.clearance, 2)
  if (r.workholdingWcs) {
    const entering = movesEnteringBox(r.moves, r.workholdingWcs, 3)
    expect(entering.length, `moves entering the vise: ${JSON.stringify(entering.slice(0, 3))}`).toBe(0)
  }
}

/** Cutting moves only (the ramps and leads of a 3D path included: all of
 * them are feed moves in material). */
function feedMoves(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.filter(m => !isRapid(m))
}

/** An Adaptive 3D path's moves, rapids included, never pass through the part. */
async function adaptiveLinksClearPart(
  r: SolidOperationReading, part: SolidPartName, partPositionZ: number, toolDiameter: number,
): Promise<void> {
  const links = await solidGougeMm({
    part, partPositionZ, worldMoves: r.worldMoves, cutter: { kind: 'flat', diameter: toolDiameter },
    shrinkMm: LATERAL_SLACK, includeRapids: true,
  })
  expect(links.maxGougeMm, `a move through the part: ${JSON.stringify(links.worst)}`).toBeLessThanOrEqual(TOL)
}

/** How far into a wall the cutter reaches, mm, to the ladder's resolution: the
 * smallest radial shrink at which no sample sits below the drop contact. */
async function radialPenetrationMm(input: Parameters<typeof solidGougeMm>[0]): Promise<number> {
  for (const shrinkMm of [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5]) {
    const reading = await solidGougeMm({ ...input, shrinkMm })
    if (reading.maxGougeMm <= TOL) return shrinkMm
  }
  return Infinity
}

// ─── 1. Adaptive 3D, each Material source mode ──────────────────────────────

interface AdaptiveCase extends Common {
  case: number
  stock: BoxStockName
  placement: Placement
  source: 'current_material' | 'initial_stock' | 'rest' | 'bounded_band'
  band?: { topWcsMm: number; bottomWcsMm: number }
  /** Deepest cut: the part bottom + 0.5, or the band bottom. */
  bottom: number
  finding?: string
}

function adaptiveCases(): AdaptiveCase[] {
  const out: AdaptiveCase[] = []
  let n = 44
  for (const placement of ['table', 'raised'] as const) {
    for (const stock of ['auto', 'fixed'] as const) {
      const f = BOX_FRAME[stock]
      const stockTopMachine = (placement === 'raised' ? RAISE : 0) + f.stockHeight
      const common = { stock, placement, retract: 5, clearance: 15, stockBottom: f.stockBottom, stockTopMachine }
      out.push({ case: n++, ...common, source: 'current_material', top: 0, bottom: f.partBottom + 0.5 })
      out.push({ case: n++, ...common, source: 'initial_stock', top: 0, bottom: f.partBottom + 0.5 })
      out.push({ case: n++, ...common, source: 'rest', top: 0, bottom: f.partBottom + 0.5 })
      out.push({
        case: n++, ...common, source: 'bounded_band', band: { topWcsMm: -1, bottomWcsMm: -8 }, top: -1,
        // The band bottom is a finished plane like the model surface: the 0.5 mm
        // axial stock to leave stands on it (see the campaign doc, case 47).
        bottom: -8 + 0.5,
      })
    }
  }
  return out
}
export const ADAPTIVE_EXPECTATIONS = adaptiveCases()

async function checkAdaptive(e: AdaptiveCase): Promise<void> {
  const r = await runAdaptive(e)
  await frameAndSafety(r, e)
  expect(r.heightsRow.top, 'Heights row: Top').toBeCloseTo(e.top!, 2)
  expect(Math.abs(r.deepestCutZ - e.bottom), `deepest cut ${r.deepestCutZ} vs ${e.bottom}`).toBeLessThanOrEqual(TOL)
  // The band case never cuts outside its band.
  if (e.band) {
    for (const m of feedMoves(r.moves)) {
      expect(m.z, 'inside the band').toBeGreaterThanOrEqual(e.band.bottomWcsMm + 0.5 - TOL)
    }
  }
  // Follows the model in Z: wherever the tool centre is over the box top, the
  // tip stays the 0.5 mm stock to leave above it, and no rapid crosses the box
  // below its top. (How far the cutter's side reaches into a wall is SH-4.)
  // Stored moves are machine XY; the box model sits at machine X 0..30, Y 0..20.
  const boxTopWcs = BOX_FRAME[e.stock].partTop
  r.worldMoves.forEach((world, i) => {
    if (!(world.x > 0 && world.x < 30 && world.y > 0 && world.y < 20)) return
    const m = r.moves[i]
    if (isRapid(m)) expect(m.z, `rapid over the box at ${world.x},${world.y}`).toBeGreaterThanOrEqual(boxTopWcs - TOL)
    else expect(m.z, `feed over the box at ${world.x},${world.y}`).toBeGreaterThanOrEqual(boxTopWcs + 0.5 - TOL)
  })
}

function adaptiveGougeInput(e: AdaptiveCase, r: SolidOperationReading) {
  return {
    part: 'closed_box' as const, partPositionZ: e.placement === 'raised' ? RAISE : 0, worldMoves: r.worldMoves,
    cutter: { kind: 'flat' as const, diameter: 6 },
  }
}

const adaptiveRuns = new Map<number, Promise<SolidOperationReading>>()
function runAdaptive(e: AdaptiveCase): Promise<SolidOperationReading> {
  let run = adaptiveRuns.get(e.case)
  if (!run) {
    run = runSolidScenario({
      part: 'closed_box', z: e.placement === 'raised' ? RAISE : 0,
      stock: boxStock(e.stock, e.placement),
      ...(e.placement === 'raised' ? { workholding: BOX_VISE } : {}),
      operations: [rough(e.source, e.band ? { band: e.band } : {})],
    }).then(readings => readings[0])
    adaptiveRuns.set(e.case, run)
  }
  return run
}

/** Radial stock to leave is 0: the rough may touch the box walls, within its
 * 0.05 mm tolerance, and no further. */
async function checkAdaptiveWalls(e: AdaptiveCase): Promise<void> {
  const r = await runAdaptive(e)
  expect(r.status, r.errorMessage).toBe('ready')
  const reach = await radialPenetrationMm(adaptiveGougeInput(e, r))
  console.log(`[WO-1606 radial] case ${e.case} Adaptive 3D ${e.source}: ${reach} mm into a wall`)
  expect(reach, 'mm into a box wall').toBeLessThanOrEqual(0.05)
}

describe('WO-1606 Smart Heights: Adaptive 3D material source on the closed box', () => {
  for (const e of ADAPTIVE_EXPECTATIONS) {
    const name = `case ${e.case}: ${e.placement}, ${e.stock} stock, Adaptive 3D ${e.source}` +
      ` -> top ${e.top}, deepest ${e.bottom}` + (e.finding ? ` [${e.finding}]` : '')
    itCase(e.finding)(name, () => checkAdaptive(e), 120_000)
    if (!e.finding) {
      // SH-4 closed by WO-1614: the rough goes ROUND each corner on an arc; the reach was the
      // harness reading arcs as chords. With arcs sampled on the arc these pass.
      it(`case ${e.case}w: ${e.placement}, ${e.stock} stock, Adaptive 3D ${e.source} -> ` +
        'no deeper than 0.05 mm into a box wall', () => checkAdaptiveWalls(e), 120_000)
    }
  }
})

// ─── 2. Parallel 3D and Waterline 3D Smart defaults ─────────────────────────

interface FinishCase extends Common {
  case: number
  part: 'closed_box' | 'tray'
  stock: BoxStockName
  placement: Placement
  op: 'parallel_3d' | 'waterline_3d'
  finding?: string
}

function finishCases(): FinishCase[] {
  const out: FinishCase[] = []
  let n = 60
  for (const placement of ['table', 'raised'] as const) {
    for (const stock of ['auto', 'fixed'] as const) {
      const f = BOX_FRAME[stock]
      const stockTopMachine = (placement === 'raised' ? RAISE : 0) + f.stockHeight
      for (const op of ['parallel_3d', 'waterline_3d'] as const) {
        out.push({
          case: n++, part: 'closed_box', stock, placement, op, top: 0, retract: 5, clearance: 15,
          stockBottom: f.stockBottom, stockTopMachine,
        })
      }
    }
  }
  // The tray on the table, auto stock 3 mm over its rim: rim WCS -3, floor
  // WCS -22, bottom WCS -23 (tray model Z -18..2, floor at -17).
  for (const op of ['parallel_3d', 'waterline_3d'] as const) {
    out.push({
      case: n++, part: 'tray', stock: 'auto', placement: 'table', op, top: 0, retract: 5, clearance: 15,
      stockBottom: -23, stockTopMachine: 23,
    })
  }
  return out
}
export const FINISH_EXPECTATIONS = finishCases()

/** Tray: coarser stepover / stepdown than the dialog defaults, so the slice
 * stays minutes long (the heights under test do not depend on them). */
const TRAY_FINISH_PARAMS = {
  parallel_3d: { stepover: 3, tolerance: 0.1 },
  waterline_3d: { stepdown: 3, tolerance: 0.1 },
}

function partPositionZ(e: FinishCase): number {
  // A part's row position lifts its lowest point to the placement Z; the tray's
  // lowest model point is Z -18.
  return (e.placement === 'raised' ? RAISE : 0) + (e.part === 'tray' ? 18 : 0)
}

/** The finish's own declared accuracy: the dialog default 0.05, the tray's 0.1. */
function finishTolerance(e: FinishCase): number {
  return e.part === 'tray' ? TRAY_FINISH_PARAMS[e.op].tolerance : 0.05
}

function finishGougeInput(e: FinishCase, r: SolidOperationReading) {
  return {
    part: e.part, partPositionZ: partPositionZ(e), worldMoves: r.worldMoves,
    cutter: e.op === 'parallel_3d' ? { kind: 'ball' as const, diameter: 6 } : { kind: 'flat' as const, diameter: 6 },
  }
}

const finishRuns = new Map<number, Promise<SolidOperationReading>>()
function runFinish(e: FinishCase): Promise<SolidOperationReading> {
  let run = finishRuns.get(e.case)
  if (!run) {
    run = runSolidScenario({
      part: e.part, z: e.placement === 'raised' ? RAISE : 0,
      stock: e.part === 'tray' ? { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 } : boxStock(e.stock, e.placement),
      ...(e.placement === 'raised' ? { workholding: BOX_VISE } : {}),
      operations: [{
        kind: e.op, toolDiameter: 6, ...(e.part === 'tray' ? { params: TRAY_FINISH_PARAMS[e.op] } : {}),
      }],
    }).then(readings => readings[0])
    finishRuns.set(e.case, run)
  }
  return run
}

describe('WO-1606 Smart Heights: Parallel 3D and Waterline 3D Smart defaults on the closed box', () => {
  for (const e of FINISH_EXPECTATIONS) {
    const label = `case ${e.case}: ${e.part === 'tray' ? 'tray' : 'box'}, ${e.placement}, ${e.stock} stock, ` +
      `${e.op === 'parallel_3d' ? 'Parallel 3D' : 'Waterline 3D'} Smart`
    // The cut never goes below the model surface and starts no higher than the material top.
    // SH-7 (Parallel 3D ball into the tray's rounded walls) was closed by WO-1615.
    const surfaceFinding: string | undefined = undefined
    const surfaceName = `${label} -> never below the model surface, never above the material top` +
      (surfaceFinding ? ` [${surfaceFinding}]` : '')
    const surface = async () => {
      const r = await runFinish(e)
      expect(r.authoringError).toBeUndefined()
      expect(r.status, r.errorMessage).toBe('ready')
      expect(r.highestCuttingZ, 'highest cutting Z').toBeLessThanOrEqual(TOL)
      expect(r.deepestCutZ, 'below the stock bottom').toBeGreaterThanOrEqual(e.stockBottom - TOL)
      console.log(`[WO-1606 radial] case ${e.case} ${e.part} ${e.op}: ` +
        `${await radialPenetrationMm(finishGougeInput(e, r))} mm into a wall (tolerance ${finishTolerance(e)})`)
      const gouge = await solidGougeMm({ ...finishGougeInput(e, r), shrinkMm: LATERAL_SLACK })
      if (e.op === 'parallel_3d') expect(gouge.samplesOverPart, 'samples over the part').toBeGreaterThan(0)
      expect(gouge.maxGougeMm, `below the model surface: ${JSON.stringify(gouge.worst)}`)
        .toBeLessThanOrEqual(finishTolerance(e))
      if (r.workholdingWcs) expect(movesEnteringBox(r.moves, r.workholdingWcs, 3).length, 'vise').toBe(0)
    }
    itCase(surfaceFinding)(surfaceName, surface, 120_000)
    // Retract and clearance are the Setup's planes over the stock top.
    const safetyName = `${label} -> retract ${e.retract}, clearance ${e.clearance}` + (e.finding ? ` [${e.finding}]` : '')
    itCase(e.finding)(safetyName, async () => frameAndSafety(await runFinish(e), e), 120_000)
  }
})

// ─── 3. The sequence: Adaptive 3D rough, then a second operation ────────────

interface SequenceCase {
  case: number
  placement: Placement
  second: 'current_material' | 'rest' | 'rest_smaller_tool' | 'parallel_3d'
  finding?: string
}

// Fixed stock only: the box's material after the rough is hand-worked for it.
const SEQ_FRAME = BOX_FRAME.fixed
/** What the rough leaves standing: the box plus 0.5 mm on top (WCS -4.5); all
 * the stock around the box is gone down to the box bottom + 0.5 (WCS -14.5). */
const LEFT_TOP = SEQ_FRAME.partTop + 0.5

export const SEQUENCE_EXPECTATIONS: SequenceCase[] = [
  { case: 78, placement: 'table', second: 'current_material' },
  { case: 79, placement: 'table', second: 'rest' },
  { case: 80, placement: 'table', second: 'rest_smaller_tool' },
  { case: 81, placement: 'table', second: 'parallel_3d', finding: 'SH-6' },
  { case: 82, placement: 'raised', second: 'current_material' },
  { case: 83, placement: 'raised', second: 'rest' },
  { case: 84, placement: 'raised', second: 'rest_smaller_tool' },
  { case: 85, placement: 'raised', second: 'parallel_3d', finding: 'SH-6' },
]

function secondOperation(second: SequenceCase['second']): SolidOperation {
  if (second === 'parallel_3d') return { kind: 'parallel_3d', toolDiameter: 6 }
  return {
    kind: 'adaptive_3d', source: second === 'current_material' ? 'current_material' : 'rest',
    toolDiameter: second === 'rest_smaller_tool' ? 3 : 6, axialStockToLeave: 0,
    params: { useStockBoundary: true },
  }
}

const sequenceRuns = new Map<string, Promise<SolidOperationReading[]>>()
function runSequence(e: SequenceCase): Promise<SolidOperationReading[]> {
  const key = `${e.placement}:${e.second}`
  let run = sequenceRuns.get(key)
  if (!run) {
    run = runSolidScenario({
      part: 'closed_box', z: e.placement === 'raised' ? RAISE : 0,
      stock: boxStock('fixed', e.placement),
      ...(e.placement === 'raised' ? { workholding: BOX_VISE } : {}),
      operations: [rough('current_material'), secondOperation(e.second)],
    })
    sequenceRuns.set(key, run)
  }
  return run
}

/** Links between cuts: rapids other than the operation's first descent and last climb. */
function interiorRapids(moves: readonly ToolpathMove[]): ToolpathMove[] {
  const firstFeed = moves.findIndex(m => !isRapid(m))
  let lastFeed = -1
  moves.forEach((m, i) => { if (!isRapid(m)) lastFeed = i })
  return moves.filter((m, i) => isRapid(m) && i > firstFeed && i < lastFeed)
}

describe('WO-1606 Smart Heights: Adaptive 3D rough, then a second operation (fixed stock)', () => {
  for (const e of SEQUENCE_EXPECTATIONS) {
    const label = `case ${e.case}: ${e.placement}, rough then ${e.second}`
    const name = `${label} -> starts from the material the rough left (WCS ${LEFT_TOP}), ` +
      `links stay at or below retract 5 [${e.finding}]`
    const body = async () => {
      const [first, second] = await runSequence(e)
      const stockTopMachine = (e.placement === 'raised' ? RAISE : 0) + SEQ_FRAME.stockHeight
      // The rough itself is the slice-3 case-48 shape on fixed stock.
      await frameAndSafety(first, { top: 0, retract: 5, clearance: 15, stockBottom: SEQ_FRAME.stockBottom, stockTopMachine })
      const positionZ = e.placement === 'raised' ? RAISE : 0
      console.log(`[WO-1606 sequence] case ${e.case}: second op ${second.status} ` +
        `${second.errorMessage ?? ''} | top row ${second.heightsRow.top}, highest cut ${second.highestCuttingZ}, ` +
        `deepest ${second.deepestCutZ}, links ${JSON.stringify(interiorRapids(second.moves).map(m => m.z).slice(0, 12))}`)
      expect(second.authoringError).toBeUndefined()
      expect(second.status, second.errorMessage).toBe('ready')
      const cuts = second.moves.filter(m => isCutting(m))
      expect(cuts.length, 'second operation cuts').toBeGreaterThan(0)
      // Starts from what the rough left, not from the original stock top.
      expect(highest(cuts), 'highest cutting move of the second operation').toBeLessThanOrEqual(LEFT_TOP + TOL)
      if (e.second !== 'parallel_3d') {
        expect(second.heightsRow.top, 'Heights row: Top = the material left').toBeCloseTo(LEFT_TOP, 2)
      }
      // Its links do not climb to clear stock that is already gone.
      for (const link of interiorRapids(second.moves)) {
        expect(link.z, 'link between cuts').toBeLessThanOrEqual(5 + TOL)
      }
      if (second.kind === 'adaptive_3d') {
        await adaptiveLinksClearPart(second, 'closed_box', positionZ, e.second === 'rest_smaller_tool' ? 3 : 6)
      } else {
        expect(second.lowestRapidZ, 'lowest rapid').toBeGreaterThanOrEqual(LEFT_TOP - TOL)
      }
      if (second.workholdingWcs) expect(movesEnteringBox(second.moves, second.workholdingWcs, 3).length).toBe(0)
      if (e.second !== 'parallel_3d') {
        // Rest / current material with no stock to leave finishes to the box bottom.
        expect(second.deepestCutZ, 'second op reaches the box bottom').toBeCloseTo(SEQ_FRAME.partBottom, 2)
      }
    }
    itCase(e.finding)(name, body, 180_000)
  }

  // Stay-down of the rough: measured and recorded, not changed.
  it('case 86: the rough\'s stay-down behaviour, recorded (table and raised)', async () => {
    for (const placement of ['table', 'raised'] as const) {
      const [first] = await runSequence({ case: 86, placement, second: 'current_material' })
      expect(first.status, first.errorMessage).toBe('ready')
      const rapids = first.moves.filter(isRapid)
      const interior = interiorRapids(first.moves)
      const record = {
        placement,
        moves: first.moves.length,
        rapids: rapids.length,
        linksBetweenCuts: interior.length,
        linksAtClearance: interior.filter(m => m.z >= 15 - TOL).length,
        linksBelowStockTop: interior.filter(m => m.z < -TOL).length,
      }
      console.log(`[WO-1606 stay-down] ${JSON.stringify(record)}`)
      // Recorded in the campaign doc (slice 3 results). The behaviour held to:
      // between cuts the rough never climbs to Clearance.
      expect(record.linksBetweenCuts, 'links between cuts').toBeGreaterThan(0)
      expect(record.linksAtClearance, 'links that climb to clearance').toBe(0)
    }
  }, 360_000)
})


// ─── 4. Drill on plate-holes.step ───────────────────────────────────────────

// Plate 100 x 60 x 10, six through holes: D6 at (20,20) (50,20) (80,20),
// D10 at (30,40) (70,40), D3 at (90,40). The 5 mm drill is put in the D6 and
// D10 holes. A vise under the plate between the hole columns when raised.
const PLATE_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 38, y: 0, z: 0 }, max: { x: 44, y: 60, z: RAISE } }
/** 5 mm drill, 118 deg point: tip to full diameter = 2.5 / tan(59 deg). */
const DRILL_POINT = 2.5 / Math.tan(59 * Math.PI / 180)

interface DrillCase extends Common {
  case: number
  placement: Placement
  holeBottom: number
  bottom: number
  finding?: string
}

export const DRILL_EXPECTATIONS: DrillCase[] = (['table', 'raised'] as const).map((placement, i) => ({
  case: 87 + i, placement, top: 0, retract: 5, clearance: 15,
  // Auto stock, 3 mm over the plate: plate top WCS -3, hole bottom WCS -13.
  stockBottom: -13, stockTopMachine: (placement === 'raised' ? RAISE : 0) + 13,
  holeBottom: -13, bottom: -13 - DRILL_POINT,
}))

const drillRuns = new Map<Placement, Promise<SolidOperationReading>>()
function runDrill(e: DrillCase): Promise<SolidOperationReading> {
  let run = drillRuns.get(e.placement)
  if (!run) {
    run = runSolidScenario({
      part: 'plate_holes', z: e.placement === 'raised' ? RAISE : 0,
      stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 },
      ...(e.placement === 'raised' ? { workholding: PLATE_VISE } : {}),
      operations: [{ kind: 'drill', toolDiameter: 5, holeDiameters: [6, 10] }],
    }).then(readings => readings[0])
    drillRuns.set(e.placement, run)
  }
  return run
}

describe('WO-1606 Smart Heights: Drill on detected holes of plate-holes.step', () => {
  for (const e of DRILL_EXPECTATIONS) {
    it(`case ${e.case}a: ${e.placement}, Detect holes finds six through holes ending at WCS ${e.holeBottom}`, async () => {
      const r = await runDrill(e)
      expect(r.holes?.length).toBe(6)
      for (const hole of r.holes!) {
        expect(hole.through, `hole at ${hole.center}`).toBe(true)
        expect(hole.topWcs).toBeCloseTo(-3, 2)
        expect(hole.bottomWcs).toBeCloseTo(e.holeBottom, 2)
      }
      expect(r.status, r.errorMessage).toBe('ready')
      // One plunge per picked hole (3 x D6 + 2 x D10), none shallower than the hole bottom.
      const plunges = r.moves.filter(m => m.role === 'plunge')
      expect(plunges.length).toBe(5)
      for (const plunge of plunges) expect(plunge.z, 'reaches the hole bottom').toBeLessThanOrEqual(e.holeBottom + TOL)
      expect(r.heightsRow.top, 'Heights row: Top').toBeCloseTo(0, 2)
      if (r.workholdingWcs) expect(movesEnteringBox(r.moves, r.workholdingWcs, 2.5).length, 'vise').toBe(0)
    }, 120_000)
    const name = `case ${e.case}b: ${e.placement}, Drill Smart -> the full diameter reaches the through-depth: ` +
      `tip at ${e.bottom.toFixed(3)}` + (e.finding ? ` [${e.finding}]` : '')
    itCase(e.finding)(name, async () => {
      const r = await runDrill(e)
      // A through hole's drill point goes below the stock bottom by design.
      // SH-8 closed by WO-1624: the -13 reading was the harness reusing a
      // stale tool-1 (an end mill) from an earlier scenario's tool library.
      await frameAndSafety(r, { ...e, lowestCut: e.bottom })
      for (const plunge of r.moves.filter(m => m.role === 'plunge')) {
        expect(Math.abs(plunge.z - e.bottom), `tip ${plunge.z}`).toBeLessThanOrEqual(TOL)
      }
      expect(r.heightsRow.bottom, 'Heights row: Bottom').toBeCloseTo(e.bottom, 2)
    }, 120_000)
  }
})

export const SOLID_PARTS_USED: SolidPartName[] = ['closed_box', 'plate_holes']
