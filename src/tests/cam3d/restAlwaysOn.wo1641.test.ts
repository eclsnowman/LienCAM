// WO-1641: every operation plans from the material the ENABLED earlier
// operations left - with no opt-in anywhere. Operator ruling 2026-09-17: "Rest is not an
// operation type. Rest is a methodology."
//
// Production compute path: the store authors each operation and
// computeOperationToolpath resolves Smart Heights and runs the real engines.
// Only browser transports are replaced (see heightScenario.ts, "WO-1606").
//
// Two projects that share nothing but the harness (part, stock, tools and the
// Face depth all differ), each proving the same three things:
//   1. rough then a default Parallel 3D finish: the finish feeds through no air
//      the rough removed;
//   2. the rough disabled and the finish regenerated: it plans against the full
//      stock, exactly as a finish with nothing before it;
//   3. a Drill after a Face starts at the faced top, not the stock top.

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
  installRealToolpathWorker, isRapid, runSolidScenario,
  type ScenarioStock, type SolidOperation, type SolidPartName,
} from '../helpers/heightScenario'
import { remainingStockBefore } from '../../store/toolReachInputs'
import { createStockState } from '../../lib/cam/stockState'
import { buildFaceSmartHeightIntent } from '../../lib/cam/smartHeights'
import { operationSafetyHeightIntent, setupDefaultHeightIntent } from '../../lib/cam/heightIntent'
import { deriveOperationHeightDraft } from '../../lib/cam/newOperationHeightDefaults'
import {
  defaultFaceParams, defaultHeights, defaultLinking, defaultPasses,
} from '../../components/modals/newOperationModalDefaults'
import { setupProvenStockId, smartHeightStockBounds, useCamStore } from '../../store'
import type { Operation, Tool, ToolHolder, ToolpathMove } from '../../types'
import { toolBands, writeSideView, type PathPoint } from '../helpers/sideViewEvidence'

installRealToolpathWorker()

interface FinishCase {
  name: string
  part: SolidPartName
  /** Machine Z of the part's lowest point. */
  z: number
  stock: ScenarioStock
  rough: SolidOperation
  finish: SolidOperation
}

interface DrillCase {
  name: string
  stock: ScenarioStock
  faceDepthMm: number
  faceToolDiameter: number
  drillDiameter: number
}

const FINISH_CASES: FinishCase[] = [
  {
    name: 'closed box, fixed stock, 6 mm rough, 6 mm ball',
    part: 'closed_box',
    z: 0,
    stock: { kind: 'fixed', width: 50, height: 40, depth: 15, position: { x: -10, y: -10, z: 0 } },
    rough: { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 6, axialStockToLeave: 0.5, params: { useStockBoundary: true } },
    finish: { kind: 'parallel_3d', toolDiameter: 6 },
  },
  {
    name: 'closed box raised 20 mm, larger fixed stock, 8 mm rough, 4 mm ball',
    part: 'closed_box',
    z: 20,
    stock: { kind: 'fixed', width: 60, height: 44, depth: 18, position: { x: -15, y: -12, z: 20 } },
    rough: { kind: 'adaptive_3d', source: 'current_material', toolDiameter: 8, axialStockToLeave: 0.8, params: { useStockBoundary: true } },
    finish: { kind: 'parallel_3d', toolDiameter: 4 },
  },
]

const DRILL_CASES: DrillCase[] = [
  { name: 'plate, 3 mm over, Face 2 mm, 5 mm drill', stock: { kind: 'auto', offsetXY: 5, offsetZTop: 3, offsetZBottom: 0 }, faceDepthMm: 2, faceToolDiameter: 10, drillDiameter: 5 },
  { name: 'plate, 5 mm over, Face 3.5 mm, 4 mm drill', stock: { kind: 'auto', offsetXY: 8, offsetZTop: 5, offsetZBottom: 0 }, faceDepthMm: 3.5, faceToolDiameter: 16, drillDiameter: 4 },
]

const setupOf = () => useCamStore.getState().project.setups[0]
const opById = (id: string) => setupOf().operations.find(o => o.id === id)!
const toolOf = (op: Operation) => useCamStore.getState().toolLibrary.find(t => t.id === op.toolId)!

/**
 * Length (mm) of FED moves along which the ball of `radius` stands clear of
 * `field` by more than `marginMm` everywhere under its round footprint (ball
 * surface over every column cell it overlaps): cutting feed spent in air. Measured here,
 * independently of the product's own conversion (which uses a coarser square).
 */
function airFeedMm(moves: readonly ToolpathMove[], radius: number, field: ReturnType<typeof stockAfter>, marginMm: number): number {
  const res = field.resolutionMm
  const clearAt = (x: number, y: number, z: number): boolean => {
    const i0 = Math.max(0, Math.floor((x - radius - field.bounds.minX) / res))
    const i1 = Math.min(field.nx - 1, Math.floor((x + radius - field.bounds.minX) / res))
    const j0 = Math.max(0, Math.floor((y - radius - field.bounds.minY) / res))
    const j1 = Math.min(field.ny - 1, Math.floor((y + radius - field.bounds.minY) / res))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = field.bounds.minX + (i + 0.5) * res, cy = field.bounds.minY + (j + 0.5) * res
        // The nearest point of the column's cell, not its centre: a ball rolling
        // down a wall touches a cell whose centre lies just outside its radius.
        const d = Math.max(0, Math.hypot(cx - x, cy - y) - res * Math.SQRT1_2)
        if (d > radius) continue
        const surface = z + radius - Math.sqrt(radius * radius - d * d)
        if (surface <= field.topZ[j * field.nx + i] + marginMm) return false
      }
    }
    return true
  }
  let air = 0
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (isRapid(b) || b.type !== 'feed') continue
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const samples = Math.max(1, Math.ceil(length / 0.25))
    let clear = true
    for (let k = 0; k <= samples && clear; k++) {
      const t = k / samples
      clear = clearAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
    }
    if (clear) air += length
  }
  return air
}

/** The stock block as the store proves it, after the given (world-frame) results. */
function stockAfter(results: Array<{ moves: ToolpathMove[]; tool: Tool }>) {
  const bounds = smartHeightStockBounds(useCamStore.getState().project, setupProvenStockId(setupOf(), useCamStore.getState().project)!)!
  const block = { min: { ...bounds.min }, max: { ...bounds.max } }
  return remainingStockBefore(
    results.map(r => ({ enabled: true, status: 'ready' as const, toolpathMoves: r.moves, tool: r.tool })),
    block,
  )!.stock
}

const feedLength = (moves: readonly ToolpathMove[]) => {
  let total = 0
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].type === 'feed') total += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y, moves[i].z - moves[i - 1].z)
  }
  return total
}

describe('WO-1641: a 3D finish after a rough plans from what the rough left - no opt-in', () => {
  for (const c of FINISH_CASES) {
    it(`${c.name}: no air feed with the rough on; the full stock with the rough off`, async () => {
      const [rough, finish] = await runSolidScenario({ part: c.part, z: c.z, stock: c.stock, operations: [c.rough, c.finish] })
      expect(rough.status, rough.errorMessage).toBe('ready')
      expect(finish.status, finish.errorMessage).toBe('ready')
      // Nothing opted in: the finish record carries no rest switch at all.
      const finishOp = opById(finish.opId)
      expect((finishOp.params as Record<string, unknown>).restMachining).toBeUndefined()

      const radius = toolOf(finishOp).diameter / 2
      const roughTool = toolOf(opById(rough.opId))
      const afterRough = stockAfter([{ moves: rough.worldMoves, tool: roughTool }])
      const margin = afterRough.resolutionMm
      const withRough = airFeedMm(finish.worldMoves, radius, afterRough, margin)

      // Disable the rough and regenerate the finish (the automatic stamp is WO-1656).
      const setupId = setupOf().id
      useCamStore.getState().updateOperation(setupId, rough.opId, { enabled: false })
      expect(opById(finish.opId).status, 'WO-1656: outdated immediately on disable, before any regenerate').toBe('outdated')
      await useCamStore.getState().computeOperationToolpath(setupId, finish.opId)
      const regenerated = opById(finish.opId)
      expect(regenerated.status, regenerated.errorMessage).toBe('ready')
      const disabledMoves = regenerated.toolpathMoves ?? []

      // The same finish with nothing before it: the full-stock plan.
      const [alone] = await runSolidScenario({ part: c.part, z: c.z, stock: c.stock, operations: [c.finish] })
      expect(alone.status, alone.errorMessage).toBe('ready')

      // The reading sees air when there is air: the same finish lifted 3 mm over
      // what the rough left is air nearly everywhere.
      const control = airFeedMm(finish.worldMoves.map(m => ({ ...m, z: m.z + 3 })), radius, afterRough, margin)
      console.log(`[WO-1641] ${c.name}: air feed ${withRough.toFixed(1)} mm with the rough (control ${control.toFixed(0)} mm); ` +
        `fed ${feedLength(finish.worldMoves).toFixed(0)} with the rough vs ${feedLength(disabledMoves).toFixed(0)} mm without`)
      expect(control, 'control: the reading detects air').toBeGreaterThan(50)
      expect(withRough, 'feed through air the rough removed').toBe(0)
      // The rough changed the plan (links low, air fed at rapid) ...
      expect(finish.worldMoves.map(m => [m.type, m.z])).not.toEqual(disabledMoves.map(m => [m.type, m.z]))
      // Rough disabled: exactly the plan a finish with nothing before it makes.
      expect(disabledMoves.length).toBe(alone.worldMoves.length)
      expect(disabledMoves.map(m => [m.type, m.x, m.y, m.z])).toEqual(alone.worldMoves.map(m => [m.type, m.x, m.y, m.z]))
    }, 600_000)
  }
})

/** A Face authored the way the dialog does (explicit depth below the stock top), put FIRST in the setup. */
async function addFaceFirst(depthMm: number, toolDiameter: number): Promise<string> {
  const setup = setupOf()
  const project = useCamStore.getState().project
  const faceTool = {
    id: 'tool-face', name: `Face ${toolDiameter}`, type: 'flat_end_mill', diameter: toolDiameter,
    fluteLength: 30, shankDiameter: toolDiameter, overallLength: 70, numberOfFlutes: 3,
    material: 'carbide', coating: 'none', toolNumber: 9, notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: depthMm, stepover: toolDiameter * 0.6 } },
  } as unknown as Tool
  useCamStore.setState(s => ({ toolLibrary: [...s.toolLibrary, faceTool] }))
  const setupIntent = setupDefaultHeightIntent(setup)
  const params = { ...defaultFaceParams } as unknown as Record<string, unknown>
  const draft = deriveOperationHeightDraft({ operationType: 'face', setupIntent, currentParams: params })
  const face = {
    id: 'op-face', name: 'Face', type: 'face', enabled: true, status: 'pending', toolId: faceTool.id,
    geometrySelections: [], passes: { ...defaultPasses, stepdown: depthMm }, linking: { ...defaultLinking },
    heights: { ...defaultHeights, ...draft.heights },
    params: { ...params, ...draft.paramsPatch },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildFaceSmartHeightIntent({
        setupId: setup.id, safetyIntent: operationSafetyHeightIntent(setupIntent, new Set()),
        mode: 'explicit_depth', stockId: setupProvenStockId(setup, project), explicitTargetWcsMm: -depthMm,
      }),
    },
  } as unknown as Operation
  useCamStore.getState().addOperation(setup.id, face)
  const index = setupOf().operations.findIndex(o => o.id === face.id)
  useCamStore.getState().reorderOperations(setup.id, index, 0)
  expect(setupOf().operations[0].id).toBe(face.id)
  return face.id
}

describe('WO-1641: a Drill after a Face starts at the faced top', () => {
  for (const c of DRILL_CASES) {
    it(`${c.name}`, async () => {
      const [drill] = await runSolidScenario({
        part: 'plate_holes', z: 0, stock: c.stock,
        operations: [{ kind: 'drill', toolDiameter: c.drillDiameter, holeDiameters: [6, 10] }],
      })
      expect(drill.status, drill.errorMessage).toBe('ready')
      // Nothing before it: the drill starts at the stock top.
      expect(drill.heightsRow.top, 'drill Top with nothing before it').toBeCloseTo(drill.stockTopWcs, 3)

      const faceId = await addFaceFirst(c.faceDepthMm, c.faceToolDiameter)
      const setupId = setupOf().id
      await useCamStore.getState().computeOperationToolpath(setupId, faceId)
      expect(opById(faceId).status, opById(faceId).errorMessage).toBe('ready')
      await useCamStore.getState().computeOperationToolpath(setupId, drill.opId)
      const redrilled = opById(drill.opId)
      expect(redrilled.status, redrilled.errorMessage).toBe('ready')

      const facedTop = drill.stockTopWcs - c.faceDepthMm
      const plan = redrilled.resolvedHeightPlan
      expect(plan?.version).toBe(2)
      const top = plan?.version === 2 ? plan.machining.materialStart.wcsMm : NaN
      console.log(`[WO-1641] ${c.name}: drill Top ${drill.heightsRow.top} -> ${top} (faced top ${facedTop})`)
      expect(top, 'drill Top after the Face').toBeCloseTo(facedTop, 2)
      // The bottom is the holes', unchanged by where it starts.
      const bottomAfter = plan?.version === 2
        ? Math.min(...(plan.machining.featureEndpoints ?? []).map(e => e.cutterCenterEnd.wcsMm))
        : NaN
      expect(bottomAfter).toBeCloseTo(drill.heightsRow.bottom!, 3)

      // Disable the Face and regenerate: back to the stock top.
      useCamStore.getState().updateOperation(setupId, faceId, { enabled: false })
      expect(opById(drill.opId).status, 'WO-1656: outdated immediately on disable, before any regenerate').toBe('outdated')
      await useCamStore.getState().computeOperationToolpath(setupId, drill.opId)
      const again = opById(drill.opId).resolvedHeightPlan
      expect(again?.version === 2 ? again.machining.materialStart.wcsMm : NaN, 'Face disabled').toBeCloseTo(drill.stockTopWcs, 3)
    }, 300_000)
  }
})

// ─── Tier 2 pictures: side view of the rough then the finish, rough on vs off ─

/** The field's silhouette along one Y row: one column per run of equal height. */
function profileAt(field: ReturnType<typeof stockAfter>, y: number): (readonly [number, number, number, number])[] {
  const cell = field.resolutionMm
  const j = Math.min(field.ny - 1, Math.max(0, Math.floor((y - field.bounds.minY) / cell)))
  const out: [number, number, number, number][] = []
  for (let i = 0; i < field.nx; i++) {
    const top = field.topZ[j * field.nx + i]
    const x0 = field.bounds.minX + i * cell
    const last = out[out.length - 1]
    if (last && Math.abs(last[3] - top) < 1e-6 && Math.abs(last[1] - x0) < 1e-6) last[1] = x0 + cell
    else out.push([x0, x0 + cell, field.bottomZ, top])
  }
  return out.filter(column => column[3] > field.bottomZ + 1e-6)
}

/** The finish's moves along the raster row nearest `y`, links included. */
function rowPath(moves: readonly ToolpathMove[], y: number): PathPoint[] {
  const rowY = moves.filter(m => !isRapid(m)).reduce((best, m) => Math.abs(m.y - y) < Math.abs(best - y) ? m.y : best, Number.POSITIVE_INFINITY)
  const out: PathPoint[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (Math.abs(a.y - rowY) > 1e-3 || Math.abs(b.y - rowY) > 1e-3) continue
    const kind: PathPoint['kind'] = isRapid(b) ? 'traverse' : b.role === 'plunge' ? 'plunge' : 'cut'
    out.push({ x: a.x, y: rowY, z: a.z, kind }, { x: b.x, y: rowY, z: b.z, kind })
  }
  return out
}

describe('WO-1641 pictures', () => {
  it('WRITE_EVIDENCE=1 draws rough then Parallel 3D, the rough enabled and then disabled', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const c = FINISH_CASES[0]
    const [rough, finish] = await runSolidScenario({ part: c.part, z: c.z, stock: c.stock, operations: [c.rough, c.finish] })
    const roughTool = toolOf(opById(rough.opId))
    const finishTool = toolOf(opById(finish.opId))
    const afterRough = stockAfter([{ moves: rough.worldMoves, tool: roughTool }])
    const b = afterRough.bounds
    const full = createStockState({ minX: b.minX, minY: b.minY, minZ: b.minZ, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ }, afterRough.resolutionMm)
    const setupId = setupOf().id
    useCamStore.getState().updateOperation(setupId, rough.opId, { enabled: false })
    await useCamStore.getState().computeOperationToolpath(setupId, finish.opId)
    const disabledMoves = opById(finish.opId).toolpathMoves ?? []
    const SECTION_Y = 10
    const holder: ToolHolder = { id: 'h', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }
    const bands = toolBands(finishTool, holder)
    const dir = 'src/tests/evidence/WO-1641'
    const on = rowPath(finish.worldMoves, SECTION_Y)
    const off = rowPath(disabledMoves, SECTION_Y)
    /** The highest rapid strictly between the first and last cut: the links. */
    const highestLink = (moves: readonly ToolpathMove[]) => {
      const first = moves.findIndex(m => !isRapid(m))
      let last = -1
      moves.forEach((m, i) => { if (!isRapid(m)) last = i })
      return Math.max(...moves.filter((m, i) => isRapid(m) && i > first && i < last).map(m => m.z))
    }
    const lowest = (path: PathPoint[]) => path.filter(p => p.kind === 'cut').reduce((m, p) => (p.z < m.z ? p : m), path[0])
    writeSideView({
      dir, name: '1-rough-enabled',
      title: 'Rough ENABLED - the finish plans from what the rough left',
      subtitle: `Closed box 30 x 20 x 10, fixed stock 50 x 40 x 15. Adaptive 3D 6 mm rough, then Parallel 3D 6 mm ball, default settings (no rest switch). Row at Y ${SECTION_Y}, looking from -Y.`,
      obstacles: [{ columns: profileAt(afterRough, SECTION_Y), colour: '#c0392b', label: 'stock the rough left', showLabel: false }],
      path: on, bands, placements: [{ x: lowest(on).x, tipZ: lowest(on).z }],
      referenceLines: [{ z: b.maxZ, label: 'stock top as loaded' }],
      captions: [
        'red = the stock the rough left - blue = the finish on this row, dashed = rapid links',
        `Whole finish: highest link between rows at machine Z ${highestLink(finish.worldMoves).toFixed(2)} (stock top as loaded ${b.maxZ.toFixed(2)}).`,
        `Fed length ${feedLength(finish.worldMoves).toFixed(0)} mm for the whole finish.`,
      ],
    })
    writeSideView({
      dir, name: '2-rough-disabled',
      title: 'Rough DISABLED - the finish plans against the full stock',
      subtitle: `Same project; the rough switched off and the finish regenerated. Row at Y ${SECTION_Y}, looking from -Y.`,
      obstacles: [{ columns: profileAt(full, SECTION_Y), colour: '#c0392b', label: 'full stock', showLabel: false }],
      path: off, bands, placements: [{ x: lowest(off).x, tipZ: lowest(off).z }],
      referenceLines: [{ z: b.maxZ, label: 'stock top as loaded' }],
      captions: [
        'red = the full stock (nothing earlier is enabled) - blue = the finish on this row, dashed = rapid links',
        `Whole finish: highest link between rows at machine Z ${highestLink(disabledMoves).toFixed(2)} (stock top as loaded ${b.maxZ.toFixed(2)}).`,
        `Fed length ${feedLength(disabledMoves).toFixed(0)} mm for the whole finish.`,
      ],
    })
  }, 600_000)
})
