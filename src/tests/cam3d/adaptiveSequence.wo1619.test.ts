// WO-1619 (findings SH-2 and SH-5 of the Smart Heights campaign, WO-1606):
// Adaptive 3D "Rest material required" as the first operation, and a second
// Adaptive 3D after a rough, GENERATE instead of refusing (rule 11).
//
// The expected numbers are the hand-worked ones in
// docs/testing/SMART-HEIGHTS-CAMPAIGN.md (slice 3, cases 46/50/54/58 and
// 78-80/82-84). The production compute path runs end to end: only browser
// transports are replaced (see heightScenario.ts, "WO-1606").

import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  type ScenarioStock, type ScenarioWorkholding, type SolidOperation, type SolidOperationReading,
} from '../helpers/heightScenario'
import type { ToolpathMove } from '../../types'
import { writeSideView, type PathPoint } from '../helpers/sideViewEvidence'

installRealToolpathWorker()

// The scenario harness adds its tools as tool-1, tool-2, ... and the tool
// library outlives a scenario: without this, case 80's 3 mm tool-2 is refused
// as a duplicate of the case before it and the rest pass silently runs 6 mm.
beforeEach(async () => {
  const { useCamStore } = await import('../../store')
  for (const tool of useCamStore.getState().toolLibrary.filter(t => /^tool-\d+$/.test(t.id))) {
    useCamStore.getState().removeTool(tool.id)
  }
})

const TOL = 0.01
const RAISE = 50
type Placement = 'table' | 'raised'
type BoxStockName = 'auto' | 'fixed'

// The closed box, 30 x 20 x 10 (model X 0..30, Y 0..20, Z 0..10).
const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }

function boxStock(name: BoxStockName, placement: Placement): ScenarioStock {
  const z = placement === 'raised' ? RAISE : 0
  return name === 'auto'
    ? { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }
    : { kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z } }
}

const BOX_FRAME: Record<BoxStockName, { partTop: number; partBottom: number; stockBottom: number; stockHeight: number }> = {
  auto: { partTop: -3, partBottom: -13, stockBottom: -13, stockHeight: 13 },
  fixed: { partTop: -5, partBottom: -15, stockBottom: -15, stockHeight: 15 },
}

const highest = (moves: readonly ToolpathMove[]) => moves.reduce((z, m) => (m.z > z ? m.z : z), -Infinity)

function scenarioBase(stock: BoxStockName, placement: Placement) {
  return {
    part: 'closed_box' as const, z: placement === 'raised' ? RAISE : 0,
    stock: boxStock(stock, placement),
    ...(placement === 'raised' ? { workholding: BOX_VISE } : {}),
  }
}

function common(r: SolidOperationReading, stockBottom: number, stockTopMachine: number): void {
  const why = `authoring: ${r.authoringError ?? '-'} | compute: ${r.status} ${r.errorMessage ?? ''}`
  expect(r.authoringError, why).toBeUndefined()
  expect(r.status, why).toBe('ready')
  expect(r.stockTopMachineZ, 'stock top (machine)').toBeCloseTo(stockTopMachine, 2)
  expect(r.stockBottomWcs, 'stock bottom (WCS)').toBeCloseTo(stockBottom, 2)
  expect(r.moves.filter(m => isCutting(m)).length, 'cutting moves').toBeGreaterThan(0)
  expect(r.highestCuttingZ, 'highest cutting Z').toBeLessThanOrEqual(TOL)
  expect(highest(r.moves), 'clearance').toBeCloseTo(15, 2)
  expect(r.deepestCutZ, 'below the stock bottom').toBeGreaterThanOrEqual(stockBottom - TOL)
  expect(r.heightsRow.retract, 'Heights row: Retract').toBeCloseTo(5, 2)
  expect(r.heightsRow.clearance, 'Heights row: Clearance').toBeCloseTo(15, 2)
  if (r.workholdingWcs) {
    const entering = movesEnteringBox(r.moves, r.workholdingWcs, 3)
    expect(entering.length, `moves entering the vise: ${JSON.stringify(entering.slice(0, 3))}`).toBe(0)
  }
}

// ─── SH-2: Rest material required as the first operation ───────────────────

describe('WO-1619 SH-2: Adaptive 3D Rest as the first operation plans against the stock', () => {
  const cases = [
    { case: 46, placement: 'table', stock: 'auto' },
    { case: 50, placement: 'table', stock: 'fixed' },
    { case: 54, placement: 'raised', stock: 'auto' },
    { case: 58, placement: 'raised', stock: 'fixed' },
  ] as const
  for (const e of cases) {
    it(`case ${e.case}: ${e.placement}, ${e.stock} stock -> Top 0, cuts to the box bottom + 0.5`, async () => {
      const f = BOX_FRAME[e.stock]
      const [r] = await runSolidScenario({
        ...scenarioBase(e.stock, e.placement),
        operations: [{
          kind: 'adaptive_3d', source: 'rest', toolDiameter: 6, axialStockToLeave: 0.5,
          params: { useStockBoundary: true },
        }],
      })
      common(r, f.stockBottom, (e.placement === 'raised' ? RAISE : 0) + f.stockHeight)
      expect(r.heightsRow.top, 'Heights row: Top').toBeCloseTo(0, 2)
      expect(Math.abs(r.deepestCutZ - (f.partBottom + 0.5)), `deepest cut ${r.deepestCutZ}`).toBeLessThanOrEqual(TOL)
      r.worldMoves.forEach((world, i) => {
        if (!(world.x > 0 && world.x < 30 && world.y > 0 && world.y < 20)) return
        const m = r.moves[i]
        if (isRapid(m)) expect(m.z, 'rapid over the box').toBeGreaterThanOrEqual(f.partTop - TOL)
        else expect(m.z, 'feed over the box').toBeGreaterThanOrEqual(f.partTop + 0.5 - TOL)
      })
    }, 180_000)
  }
})

// ─── SH-5: a second Adaptive 3D after the rough ────────────────────────────

const SEQ_FRAME = BOX_FRAME.fixed
/** What the rough leaves standing: the box plus 0.5 on top (WCS -4.5). */
const LEFT_TOP = SEQ_FRAME.partTop + 0.5

const ROUGH: SolidOperation = {
  kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5,
  params: { useStockBoundary: true },
}

type Second = 'current_material' | 'rest' | 'rest_smaller_tool'
function secondOperation(second: Second): SolidOperation {
  return {
    kind: 'adaptive_3d', source: second === 'current_material' ? 'current_material' : 'rest',
    toolDiameter: second === 'rest_smaller_tool' ? 3 : 6, axialStockToLeave: 0,
    params: { useStockBoundary: true },
  }
}

function interiorRapids(moves: readonly ToolpathMove[]): ToolpathMove[] {
  const firstFeed = moves.findIndex(m => !isRapid(m))
  let lastFeed = -1
  moves.forEach((m, i) => { if (!isRapid(m)) lastFeed = i })
  return moves.filter((m, i) => isRapid(m) && i > firstFeed && i < lastFeed)
}

describe('WO-1619 SH-5: a second Adaptive 3D after the rough generates from what the rough left', () => {
  const cases: Array<{ case: number; placement: Placement; second: Second }> = [
    { case: 78, placement: 'table', second: 'current_material' },
    { case: 79, placement: 'table', second: 'rest' },
    { case: 80, placement: 'table', second: 'rest_smaller_tool' },
    { case: 82, placement: 'raised', second: 'current_material' },
    { case: 83, placement: 'raised', second: 'rest' },
    { case: 84, placement: 'raised', second: 'rest_smaller_tool' },
  ]
  for (const e of cases) {
    it(`case ${e.case}: ${e.placement}, rough then ${e.second} -> Top ${LEFT_TOP}, reaches -15, links <= 5`, async () => {
      const [first, second] = await runSolidScenario({
        ...scenarioBase('fixed', e.placement),
        operations: [ROUGH, secondOperation(e.second)],
      })
      const stockTopMachine = (e.placement === 'raised' ? RAISE : 0) + SEQ_FRAME.stockHeight
      common(first, SEQ_FRAME.stockBottom, stockTopMachine)
      console.log(`[WO-1619 sequence] case ${e.case}: ${second.status} ${second.errorMessage ?? ''} | top row ` +
        `${second.heightsRow.top}, highest cut ${second.highestCuttingZ}, deepest ${second.deepestCutZ}, ` +
        `moves ${second.moves.length}, console ${JSON.stringify(second.consoleMessages.filter(m => /Adaptive|rest|engagement/i.test(m)).slice(0, 6))}`)
      expect(second.authoringError).toBeUndefined()
      expect(second.status, second.errorMessage).toBe('ready')
      if (e.second === 'rest_smaller_tool') {
        // The 3 mm pass derives a finer grid than the 6 mm rough carved on; it
        // plans on the rough's grid and says so, instead of re-roughing the block.
        expect(second.consoleMessages.some(m => /previous rough's 0\.5 mm grid/.test(m)),
          JSON.stringify(second.consoleMessages)).toBe(true)
      }
      const cuts = second.moves.filter(m => isCutting(m))
      expect(cuts.length, 'second operation cuts').toBeGreaterThan(0)
      expect(highest(cuts), 'highest cutting move of the second operation').toBeLessThanOrEqual(LEFT_TOP + TOL)
      expect(second.heightsRow.top, 'Heights row: Top = the material left').toBeCloseTo(LEFT_TOP, 2)
      for (const link of interiorRapids(second.moves)) {
        expect(link.z, 'link between cuts').toBeLessThanOrEqual(5 + TOL)
      }
      const links = await solidGougeMm({
        part: 'closed_box', partPositionZ: e.placement === 'raised' ? RAISE : 0, worldMoves: second.worldMoves,
        cutter: { kind: 'flat', diameter: e.second === 'rest_smaller_tool' ? 3 : 6 },
        shrinkMm: 0.5, includeRapids: true,
      })
      expect(links.maxGougeMm, `a move through the part: ${JSON.stringify(links.worst)}`).toBeLessThanOrEqual(TOL)
      if (second.workholdingWcs) expect(movesEnteringBox(second.moves, second.workholdingWcs, 3).length).toBe(0)
      expect(second.deepestCutZ, 'second op reaches the box bottom').toBeCloseTo(SEQ_FRAME.partBottom, 2)
    }, 360_000)
  }
})

// ─── Tier 2 evidence: the side view Operator judges ────────────────────────────

/** A section through the box middle (world Y 7..13) seen from the front, WCS X/Z. */
function sectionPath(r: SolidOperationReading): PathPoint[] {
  return r.moves.flatMap((m, i) => {
    const world = r.worldMoves[i]
    if (Math.abs(world.y - 10) > 3) return []
    return [{ x: m.x, y: world.y, z: m.z, kind: isRapid(m) ? 'traverse' as const : 'cut' as const }]
  })
}

describe.skipIf(process.env.WRITE_EVIDENCE !== '1')('WO-1619 evidence', () => {
  it('draws the rough and the rest pass after it, side view, fixed stock on the table', async () => {
    const [first, second] = await runSolidScenario({
      ...scenarioBase('fixed', 'table'),
      operations: [ROUGH, secondOperation('rest_smaller_tool')],
    })
    expect(second.status, second.errorMessage).toBe('ready')
    // WCS X of the box: the moves carry both frames.
    const dx = first.worldMoves[0].x - first.moves[0].x
    const box = { columns: [[0 - dx, 30 - dx, SEQ_FRAME.partBottom, SEQ_FRAME.partTop] as const], yRange: [0, 20] as const,
      colour: '#7f8c8d', label: 'closed box 30 x 20 x 10' }
    const skin = { columns: [[0 - dx, 30 - dx, SEQ_FRAME.partTop, LEFT_TOP] as const], yRange: [0, 20] as const,
      colour: '#e67e22', label: '0.5 mm the rough left', showLabel: false }
    const stock = { columns: [[-10 - dx, 40 - dx, SEQ_FRAME.stockBottom, 0] as const], colour: '#ecf0f1',
      label: 'fixed stock 50 x 40 x 15', showLabel: false }
    const dir = 'src/tests/evidence/WO-1619'
    const lines = [
      { z: 0, label: 'stock top 0' }, { z: 5, label: 'retract 5' }, { z: LEFT_TOP, label: `material left ${LEFT_TOP}` },
      { z: SEQ_FRAME.partBottom, label: `box bottom ${SEQ_FRAME.partBottom}` },
    ]
    const firstCut = (r: SolidOperationReading) => r.moves.find(m => isCutting(m))!
    writeSideView({
      dir, name: '1-rough', title: 'Adaptive 3D rough, 6 mm flat, 0.5 mm stock to leave',
      subtitle: `section through the box middle (Y 7..13); ${first.moves.length} moves`,
      obstacles: [stock, box], path: sectionPath(first),
      bands: [[0, 20, 3, '#2980b9', '6 mm flat']], placements: [{ x: firstCut(first).x, tipZ: firstCut(first).z }],
      referenceLines: lines,
      captions: [`Top row ${first.heightsRow.top}, deepest cut ${first.deepestCutZ.toFixed(2)}`],
    })
    writeSideView({
      dir, name: '2-rest-after-rough', title: 'Second Adaptive 3D, Material source Rest: starts where the rough left off',
      subtitle: `section through the box middle (Y 7..13); ${second.moves.length} moves`,
      obstacles: [box, skin], path: sectionPath(second),
      bands: [[0, 20, 1.5, '#27ae60', '3 mm flat']], placements: [{ x: firstCut(second).x, tipZ: firstCut(second).z }],
      referenceLines: lines,
      captions: [
        'orange on the box top: the 0.5 mm the rough left',
        `Top row ${second.heightsRow.top}, highest cut ${second.highestCuttingZ.toFixed(2)}, deepest cut ${second.deepestCutZ.toFixed(2)}`,
        `highest link between cuts ${Math.max(...interiorRapids(second.moves).map(m => m.z)).toFixed(2)} (retract 5)`,
        ...second.consoleMessages.filter(m => /grid/.test(m)),
      ],
    })
  }, 360_000)
})
