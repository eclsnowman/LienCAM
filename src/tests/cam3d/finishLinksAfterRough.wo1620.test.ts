// WO-1620 (Smart Heights finding SH-6): a 3D finish after a rough links at the
// lowest height the material the rough left proves clear, instead of climbing
// to Clearance to cross material that is gone. What it cannot prove is still
// lifted, and with no rough the links are exactly as WO-1616 left them.
//
// Production compute path: the store's computeOperationToolpath on the closed
// box (30 x 20 x 10), fixed stock, Adaptive 3D rough then Parallel 3D (6 mm
// ball) - WO-1606 cases 81 (table) and 85 (raised). Only browser transports are
// replaced, exactly as in src/tests/cam/finishRetractOverStock.wo1616.test.ts.

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

import * as scenarioModule from '../helpers/heightScenario'
import {
  installRealToolpathWorker, isRapid, runSolidScenario, solidGougeMm, type ScenarioStock, type ScenarioWorkholding, type SolidOperation,
} from '../helpers/heightScenario'
import { lowerFinishLinksOverRemovedStock } from '../../cam3d/integration/finishLinksOverRemovedStock'
import { remainingStockBefore } from '../../store/toolReachInputs'
import { createStockState, type StockState } from '../../lib/cam/stockState'
import { useCamStore } from '../../store'
import type { Operation, Tool, ToolpathMove } from '../../types'

installRealToolpathWorker()

const TOL = 0.01
const RAISE = 50
const boxFixedStock = (z: number): ScenarioStock => ({ kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z } })
const ROUGH: SolidOperation = {
  kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true },
}
/** WO-1606 case 85's vise, under the box footprint. */
const BOX_VISE: ScenarioWorkholding = { name: 'Vise', min: { x: 5, y: 5, z: 0 }, max: { x: 25, y: 15, z: RAISE } }
const FINISH: SolidOperation = { kind: 'parallel_3d', toolDiameter: 6 }

/** Rapids strictly between the first and last cutting move: the finish's links. */
function interiorRapids(moves: readonly ToolpathMove[]): ToolpathMove[] {
  const firstFeed = moves.findIndex(m => !isRapid(m))
  let lastFeed = -1
  moves.forEach((m, i) => { if (!isRapid(m)) lastFeed = i })
  return moves.filter((m, i) => isRapid(m) && i > firstFeed && i < lastFeed)
}

/** Lateral rapid segments strictly between the first and last cutting move, as [from, to] pairs. */
function interiorLateralRapids(moves: readonly ToolpathMove[]): Array<[ToolpathMove, ToolpathMove]> {
  const firstFeed = moves.findIndex(m => !isRapid(m))
  let lastFeed = -1
  moves.forEach((m, i) => { if (!isRapid(m)) lastFeed = i })
  const out: Array<[ToolpathMove, ToolpathMove]> = []
  for (let i = firstFeed + 1; i < lastFeed; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b) && (a.x !== b.x || a.y !== b.y)) out.push([a, b])
  }
  return out
}

describe('WO-1620 a 3D finish after a rough keeps its links low over removed material', () => {
  for (const placement of ['table', 'raised'] as const) {
    it(`rough then Parallel 3D on the box (${placement === 'raised' ? 'raised on a vise' : 'table'}): no link climbs above Retract, and none enters the part`, async () => {
      const z = placement === 'raised' ? RAISE : 0
      const [rough, finish] = await runSolidScenario({
        part: 'closed_box', z, stock: boxFixedStock(z),
        ...(placement === 'raised' ? { workholding: BOX_VISE } : {}),
        operations: [ROUGH, FINISH],
      })
      expect(rough.status, rough.errorMessage).toBe('ready')
      expect(finish.status, finish.errorMessage).toBe('ready')
      expect(finish.heightsRow.retract, 'Retract row unchanged').toBeCloseTo(5, 2)
      expect(finish.heightsRow.clearance, 'Clearance row unchanged').toBeCloseTo(15, 2)

      const links = interiorLateralRapids(finish.moves)
      expect(links.length, 'the finish has links between raster regions').toBeGreaterThan(0)
      const high = interiorRapids(finish.moves).filter(m => m.z > (finish.heightsRow.retract ?? Number.NEGATIVE_INFINITY) + TOL)
      expect(high.map(m => `(${m.x.toFixed(2)}, ${m.y.toFixed(2)}, ${m.z.toFixed(2)})`), 'links above Retract').toEqual([])
      // The entry and the exit still use the operation's own Clearance.
      expect(Math.max(...finish.moves.map(m => m.z)), 'clearance at entry/exit').toBeCloseTo(15, 2)

      // A low link is only worth having if it is clear: every link, the real 6 mm ball, the real part.
      const worldLinks = interiorLateralRapids(finish.worldMoves)
      for (const [a, b] of worldLinks) {
        const gouge = await solidGougeMm({
          part: 'closed_box', partPositionZ: z, worldMoves: [a, b], cutter: { kind: 'ball', diameter: 6 }, includeRapids: true,
        })
        expect(gouge.maxGougeMm, `link into the part: ${JSON.stringify(gouge.worst)}`).toBeLessThanOrEqual(TOL)
      }
    }, 240_000)
  }

  it('links kept low over the rough depend on it: suppressing or editing the rough outdates the finish', async () => {
    const opStatus = (id: string) => useCamStore.getState().project.setups[0].operations.find(o => o.id === id)!
    const dependsOnPredecessors = (op: Operation) => (op as Operation & { dependsOnPredecessors?: boolean }).dependsOnPredecessors

    const [rough, finish] = await runSolidScenario({ part: 'closed_box', z: 0, stock: boxFixedStock(0), operations: [ROUGH, FINISH] })
    expect(rough.status, rough.errorMessage).toBe('ready')
    expect(finish.status, finish.errorMessage).toBe('ready')
    expect(interiorRapids(finish.moves).some(m => m.z < 15 - TOL), 'some link stays below Clearance').toBe(true)
    const setupId = useCamStore.getState().project.setups[0].id
    expect(dependsOnPredecessors(opStatus(finish.opId))).toBe(true)

    useCamStore.getState().updateOperation(setupId, rough.opId, { enabled: false })
    expect(opStatus(rough.opId).status).toBe('ready')
    expect(opStatus(finish.opId).status, 'the rough no longer removes the material the links cross').toBe('outdated')

    const [rough2, finish2] = await runSolidScenario({ part: 'closed_box', z: 0, stock: boxFixedStock(0), operations: [ROUGH, FINISH] })
    expect(finish2.status, finish2.errorMessage).toBe('ready')
    const roughOp = opStatus(rough2.opId)
    useCamStore.getState().updateOperation(useCamStore.getState().project.setups[0].id,
      rough2.opId, { params: { ...roughOp.params, axialStockToLeave: 3 } } as Partial<Operation>)
    expect(opStatus(finish2.opId).status, 'the rough now leaves more material').toBe('outdated')
  }, 480_000)

  it('WRITE_EVIDENCE=1 dumps the rough-then-finish side view for the picture', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const [rough, finish] = await runSolidScenario({ part: 'closed_box', z: 0, stock: boxFixedStock(0), operations: [ROUGH, FINISH] })
    // The app's own replay of the rough into the stock (world frame: fixed stock X -10..40, Y -10..30, Z 0..15).
    const remaining = remainingStockBefore(
      [{ enabled: true, status: 'ready', toolpathMoves: rough.worldMoves, tool: { id: 'r', type: 'flat_end_mill', diameter: 6 } as unknown as Tool }],
      { min: { x: -10, y: -10, z: 0 }, max: { x: 40, y: 30, z: 15 } },
    )!.stock
    // WCS = world shifted so the stock corner and top are zero.
    const dx = finish.stockXY.minX + 10, dy = finish.stockXY.minY + 10, dz = -finish.wcsOriginMachineZ
    // The highest material under the link corridor: WCS Y 5..11 (the three rows around the links, plus the ball's reach).
    const section: Array<{ x: number; top: number }> = []
    for (let i = 0; i < remaining.nx; i++) {
      let top = -Infinity
      for (let j = 0; j < remaining.ny; j++) {
        const y = remaining.bounds.minY + (j + 0.5) * remaining.resolutionMm + dy
        if (y < 5 || y > 11) continue
        top = Math.max(top, remaining.topZ[j * remaining.nx + i])
      }
      section.push({ x: remaining.bounds.minX + (i + 0.5) * remaining.resolutionMm + dx, top: top + dz })
    }
    const band = finish.moves.filter(m => m.y >= 7.9 && m.y <= 10.1)
    const interior = interiorRapids(finish.moves)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1620', { recursive: true })
    const label = process.env.WO1620_EVIDENCE_LABEL ?? 'after'
    writeFileSync(`src/tests/evidence/WO-1620/moves-${label}.json`, JSON.stringify({
      label, heightsRow: finish.heightsRow, stockTopWcs: finish.stockTopWcs, stockBottomWcs: finish.stockBottomWcs,
      partTopWcs: finish.partTopWcs, partBottomWcs: finish.partBottomWcs, stockXY: finish.stockXY, section,
      linksAboveRetract: interior.filter(m => m.z > 5 + TOL).length,
      highestLinkZ: Math.max(...interior.map(m => m.z)),
      moves: band.map(m => ({ t: isRapid(m) ? 'rapid' : 'feed', x: m.x, y: m.y, z: m.z })),
    }))
  }, 240_000)

  it('Parallel 3D with no rough before it: links cross just over the proven stock top (WO-2210)', async () => {
    // WO-1616 put these links at Clearance; WO-2210 lifts a link between passes
    // only to the proven stock top (WCS 0) + the traverse standoff, 1 mm.
    const [finish] = await runSolidScenario({ part: 'closed_box', z: 0, stock: boxFixedStock(0), operations: [FINISH] })
    expect(finish.status, finish.errorMessage).toBe('ready')
    const published = useCamStore.getState().project.setups[0].operations.find(o => o.id === finish.opId)!
    expect((published as Operation & { dependsOnPredecessors?: boolean }).dependsOnPredecessors, 'nothing earlier to depend on').toBeUndefined()
    const rapids = finish.moves.filter(isRapid)
    expect(Math.min(...rapids.map(m => m.z)), 'lowest rapid').toBeGreaterThanOrEqual(1 - TOL)
    const links = interiorLateralRapids(finish.moves)
    expect(links.length).toBeGreaterThan(0)
    for (const [a, b] of links) {
      expect(Math.min(a.z, b.z), 'an un-roughed link crosses at stock top + 1').toBeCloseTo(1, 2)
    }
  }, 240_000)
})

// ─── the proof itself, on a stock state built by hand ────────────────────────

const TOOL = {
  id: 'tool-1', name: 'Flat6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 30, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', toolNumber: 1,
} as unknown as Tool

/** A 40 x 40 x 10 block machined flat to Z 2, with an uncut pillar up to Z 10 where asked. */
function roughedBlock(pillar: boolean): StockState {
  const state = createStockState({ minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 10 }, 0.5)
  const topZ = new Float32Array(state.topZ.length)
  for (let j = 0; j < state.ny; j++) {
    for (let i = 0; i < state.nx; i++) {
      const x = (i + 0.5) * state.resolutionMm, y = (j + 0.5) * state.resolutionMm
      topZ[j * state.nx + i] = pillar && x > 18 && x < 22 && y > 5 && y < 10 ? 10 : 2
    }
  }
  return { ...state, topZ }
}

/** Two cuts on the Z 2 floor joined by the finish's lift / across / descend link over `plane`. */
function finishMoves(plane: number): ToolpathMove[] {
  return [
    { type: 'rapid', x: 5, y: 5, z: plane, role: 'rapid' },
    { type: 'rapid', x: 5, y: 5, z: 4, role: 'rapid' },
    { type: 'feed', x: 5, y: 5, z: 2, role: 'plunge', feed: 300 },
    { type: 'feed', x: 10, y: 5, z: 2, role: 'cut', feed: 1000 },
    { type: 'rapid', x: 10, y: 5, z: plane, role: 'rapid' },
    { type: 'rapid', x: 30, y: 10, z: plane, role: 'rapid' },
    { type: 'rapid', x: 30, y: 10, z: 4, role: 'rapid' },
    { type: 'feed', x: 30, y: 10, z: 2, role: 'plunge', feed: 300 },
    { type: 'feed', x: 35, y: 10, z: 2, role: 'cut', feed: 1000 },
    { type: 'rapid', x: 35, y: 10, z: plane, role: 'rapid' },
  ]
}

describe('WO-1620 lowerFinishLinksOverRemovedStock', () => {
  it('a corridor over cleared floor: the link crosses just over the floor, not at the plane', () => {
    const result = lowerFinishLinksOverRemovedStock({ moves: finishMoves(20), tool: TOOL, remaining: roughedBlock(false), clearanceZ: 20 })
    expect(result.candidates).toBe(1)
    expect(result.lowered).toBe(1)
    const link = interiorLateralRapids(result.moves)
    expect(link).toHaveLength(1)
    expect(Math.max(link[0][0].z, link[0][1].z)).toBeLessThanOrEqual(3 + TOL)
    // Cutting moves are the finish's own, in order.
    expect(result.moves.filter(m => !isRapid(m))).toEqual(finishMoves(20).filter(m => !isRapid(m)))
  })

  it('uncut material in the corridor: the link goes over that material, still below the plane', () => {
    const result = lowerFinishLinksOverRemovedStock({ moves: finishMoves(20), tool: TOOL, remaining: roughedBlock(true), clearanceZ: 20 })
    const link = interiorLateralRapids(result.moves)
    expect(link).toHaveLength(1)
    const crossZ = Math.min(link[0][0].z, link[0][1].z)
    expect(crossZ, 'over the Z 10 pillar with the 1 mm headroom').toBeGreaterThanOrEqual(11 - TOL)
    expect(crossZ, 'below the plane').toBeLessThan(20)
  })

  it('what it cannot prove clear below the plane still crosses over the plane', () => {
    const moves = finishMoves(10.5)
    const result = lowerFinishLinksOverRemovedStock({ moves, tool: TOOL, remaining: roughedBlock(true), clearanceZ: 10.5 })
    expect(result.lowered).toBe(0)
    const link = interiorLateralRapids(result.moves)
    expect(link).toHaveLength(1)
    expect(link[0][0].z).toBeCloseTo(10.5, 6)
    expect(link[0][1].z).toBeCloseTo(10.5, 6)
    expect(result.moves.filter(m => !isRapid(m))).toEqual(moves.filter(m => !isRapid(m)))
  })
})
