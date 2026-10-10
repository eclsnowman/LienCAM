// WO-1387 -- rest machining replays world-space moves into local-space stock.
//
// Every operation's toolpathMoves is saved WORLD-placed (worldPlaceParallel3dMoves,
// src/store/index.ts): world = position + Rz(local). computeRest3dMoves sweeps a
// preceding operation's toolpathMoves into a voxel stock sized from the part's
// LOCAL bounds (the same frame as the mesh and `boundary`, per
// worldRingsToLocalFrame). Before this fix the store passed the raw world moves
// straight through: for a part not at the origin, the rough's real cut lands
// outside the local stock box and the rest pass never sees it as removed.
//
// What this test proves, through the REAL store compute path (the app), with
// the real BvhKernel behind an in-process worker channel:
//   1. TRANSLATION INVARIANCE. The same rough-then-rest setup, run once with the
//      part at the origin and once with it moved to (40, 25), produces rest
//      toolpaths that are the SAME shape once the shift is undone: the shifted
//      run's local-frame moves match the origin run's, move for move.
//   2. THE FIX MEANS SOMETHING. Both runs' rest passes cut meaningfully less
//      than the same rest-enabled operation with no preceding rough (the full
//      box, `previous_tool` reference machining) -- the reduction is a REAL
//      rest computation, not two runs that both happen to fail alike.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { PartMesh } from '../../cam3d/kernel/types'
import { restStepFixture, REST_FIXTURE } from './restStepFixture'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type {
  ImportedGeometry,
  Operation,
  OperationType,
  PhysicalStock,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
  Vec3,
} from '../../types'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'

// WO-1209's rest fixture: a 70 x 50 x 12 block with narrow slots (4-5 mm) an
// 8 mm rough cannot reach, plus a wide 25 x 12 pocket it can -- the same
// story that fixture was built for, reused here so the rough leaves real,
// provable rest material behind.
const BOX = { x: REST_FIXTURE.sizeX, y: REST_FIXTURE.sizeY, z: REST_FIXTURE.topZ }
const CELL_SIZE = 1
const SHIFT: Vec3 = { x: 40, y: 25, z: 0 }

function tool(id: string, diameter: number): Tool {
  return {
    id,
    name: `${diameter} mm flat`,
    type: 'flat_end_mill',
    diameter,
    fluteLength: 25,
    shankDiameter: diameter,
    overallLength: 60,
    numberOfFlutes: 3,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: { rpm: 12000, feedRate: 1200, plungeRate: 400, depthOfCut: 2, stepover: diameter * 0.4 },
    },
  }
}

function operation(
  id: string,
  type: OperationType,
  toolId: string,
  topZ: number,
  params: Record<string, unknown>,
  setupId: string,
  geometryId: string,
  stockId: string,
): Operation {
  return stampSmartHeightAuthority({
    id,
    name: id,
    type,
    enabled: true,
    status: 'pending',
    toolId,
    geometrySelections: [geometryId],
    heights: {
      clearanceHeight: topZ + 10,
      clearanceHeightMode: 'absolute',
      retractHeight: topZ + 2,
      feedHeight: topZ + 1,
      topHeight: 0,
      topHeightMode: 'model_top',
      bottomHeight: 0,
      bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge',
      rampAngle: 3,
      rampLength: 10,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params,
  }, { setupId, geometryIds: [geometryId], stockId })
}

/** An adaptive_3d rough's params, with the grid and stepdown as the only knobs. */
function roughParams(cellSize: number, maxStepdown: number): Record<string, unknown> {
  return {
    maxStepdown,
    stepover: 0.4,
    tolerance: 0.2,
    helixDiameter: 2,
    helixAngleDeg: 10,
    cellSize,
    useStockBoundary: false,
  }
}

/** A rest-enabled parallel_3d finish, replaying the setup's preceding operations. */
function restFromPredecessorsParams(): Record<string, unknown> {
  return {
    restMachining: true,
    stockSource: 'previous_operations',
    tolerance: 0.2,
    stockToLeave: 0,
    stepdown: 3,
    direction: 'climb',
    useStockBoundary: false,
  }
}

function setup(id: string, stockId: string, operations: Operation[]): Setup {
  return {
    id,
    name: id,
    wcs: {
      id: `wcs-${id}`,
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId,
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations,
    notes: '',
  }
}

/** Moves that touch material: everything that is not a positioning rapid. */
function cuttingMoves(moves: readonly ToolpathMove[] | undefined): ToolpathMove[] {
  return (moves ?? []).filter((m) => m.type !== 'rapid')
}

/** Total distance actually cutting stock (WO-1209's metric): the honest
 * "how much work did this toolpath do" number -- move COUNT alone conflates a
 * few long full-coverage passes with many short pecked rest moves. */
function cutLengthMm(moves: readonly ToolpathMove[] | undefined): number {
  const all = moves ?? []
  let total = 0
  for (let i = 1; i < all.length; i++) {
    const from = all[i - 1]
    const move = all[i]
    if (!isStockCuttingRole(effectiveMoveRole(move))) continue
    total += Math.hypot(move.x - from.x, move.y - from.y, move.z - from.z)
  }
  return total
}

/** Undo a pure translation (no spin) so a shifted run's stored moves compare
 * directly against the same setup run with the part left at the origin. */
function unplace(moves: readonly ToolpathMove[], position: Vec3): ToolpathMove[] {
  return moves.map((m) => ({
    ...m,
    x: m.x - position.x,
    y: m.y - position.y,
    z: m.z - position.z,
    ...(typeof m.cx === 'number' ? { cx: m.cx - position.x } : {}),
    ...(typeof m.cy === 'number' ? { cy: m.cy - position.y } : {}),
  }))
}

interface Scene {
  /** Run one operation through the app's real compute path. */
  compute: (setupId: string, opId: string) => Promise<void>
  /** The operation as the store left it (status, moves, error). */
  op: (setupId: string, opId: string) => Operation
  dispose: () => Promise<void>
}

/**
 * Stand the app up around the real cam3d kernel (restWiring.wo279 pattern): a
 * Cam3dClient wired straight to a Cam3dDispatcher behind the store's own
 * client accessor, so every carve is real geometry and every decision is the
 * production one. Only the byte cache and the tessellator are stubbed. The
 * part sits at `position` in world space -- the whole point of this WO.
 */
async function makeScene(
  mesh: PartMesh,
  setups: Setup[],
  tools: Tool[],
  position: Vec3,
  geometryId: string,
  stockId: string,
): Promise<Scene> {
  vi.resetModules()

  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest)
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  const client = new Cam3dClient(fakeWorker)

  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => client,
  }))
  vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: vi.fn(async () => mesh),
  }))
  vi.doMock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
    ...(await importOriginal<typeof import('../../lib/stepCache')>()),
    loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
  }))

  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {
    localStorage,
    __cncViewport: { getStockBounds: () => null },
  })

  const { useCamStore } = await import('../../store')

  // STEP, not STL: an imported STL is recentred for display, so its moves live
  // in a shifted frame. STEP keeps the mesh coordinates, which makes the world
  // moves this test reads directly comparable to the fixture's own coordinates.
  const geometry: ImportedGeometry = {
    id: geometryId,
    name: 'WO-1387 part',
    filename: 'wo1387.step',
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: mesh.bounds.min[0], y: mesh.bounds.min[1], z: mesh.bounds.min[2] },
      max: { x: mesh.bounds.max[0], y: mesh.bounds.max[1], z: mesh.bounds.max[2] },
      size: {
        x: mesh.bounds.max[0] - mesh.bounds.min[0],
        y: mesh.bounds.max[1] - mesh.bounds.min[1],
        z: mesh.bounds.max[2] - mesh.bounds.min[2],
      },
      center: {
        x: (mesh.bounds.max[0] + mesh.bounds.min[0]) / 2,
        y: (mesh.bounds.max[1] + mesh.bounds.min[1]) / 2,
        z: (mesh.bounds.max[2] + mesh.bounds.min[2]) / 2,
      },
    },
    position,
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId,
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: BOX.x, fixedHeight: BOX.y, fixedDepth: BOX.z,
    fixedStocks: [{ id: stockId, name: stockId, width: BOX.x, height: BOX.y, depth: BOX.z, position: { x: 0, y: 0, z: 0 } }],
  }
  // The real block sits in world space exactly under the (translated) part, as
  // a machinist would actually fixture it -- resolveProvenCam3dStockBounds
  // reads THIS bound, not the geometry's, to size the local-frame replay stock.
  const physicalStock: PhysicalStock = {
    id: stockId,
    name: stockId,
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: BOX.x, y: BOX.y, z: BOX.z },
      size: { x: BOX.x, y: BOX.y, z: BOX.z },
      center: { x: BOX.x / 2, y: BOX.y / 2, z: BOX.z / 2 },
    },
    position,
  }

  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      id: `project-wo1387-${geometryId}`,
      geometry: [geometry],
      setups,
      stocks: [physicalStock],
      sceneStock,
      toolLibrary: tools,
      activeSetupId: setups[0].id,
    },
    toolLibrary: tools,
    toolpathBatch: null,
  }))

  return {
    compute: (setupId, opId) => useCamStore.getState().computeOperationToolpath(setupId, opId),
    op: (setupId, opId) => {
      const found = useCamStore
        .getState()
        .project.setups.find((s) => s.id === setupId)
        ?.operations.find((o) => o.id === opId)
      if (!found) throw new Error(`operation ${opId} vanished from setup ${setupId}`)
      return found
    },
    dispose: async () => {
      await client.dispose()
    },
  }
}

afterEach(() => {
  vi.doUnmock('../../cam3d/integration/appClient')
  vi.doUnmock('../../cam3d/integration/parallel3dOperation')
  vi.doUnmock('../../lib/stepCache')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('WO-1387 rest machining replays predecessor moves into the local frame', () => {
  it(
    'a translated part\'s finish matches the origin run, move for move, once the shift is undone',
    { timeout: 300_000 },
    async () => {
      const big = tool('tool-big', 8)
      const small = tool('tool-small', 2)

      const runRoughThenRest = async (position: Vec3) => {
        const rough = operation('op-rough', 'adaptive_3d', big.id, BOX.z, roughParams(CELL_SIZE, 6), 'setup-1', 'geo', 'stock')
        const rest = operation('op-rest', 'parallel_3d', small.id, BOX.z, restFromPredecessorsParams(), 'setup-1', 'geo', 'stock')
        const scene = await makeScene(restStepFixture(), [setup('setup-1', 'stock', [rough, rest])], [big, small], position, 'geo', 'stock')
        try {
          await scene.compute('setup-1', 'op-rough')
          expect(scene.op('setup-1', 'op-rough').status).toBe('ready')
          await scene.compute('setup-1', 'op-rest')
          const restOp = scene.op('setup-1', 'op-rest')
          expect(restOp.errorMessage).toBeUndefined()
          expect(restOp.status).toBe('ready')
          return restOp.toolpathMoves ?? []
        } finally {
          await scene.dispose()
        }
      }

      const originMoves = await runRoughThenRest({ x: 0, y: 0, z: 0 })
      const shiftedMoves = await runRoughThenRest(SHIFT)

      const originCuts = cuttingMoves(originMoves)
      const shiftedCuts = cuttingMoves(shiftedMoves)
      expect(originCuts.length).toBeGreaterThan(0)
      expect(shiftedCuts.length).toBe(originCuts.length)

      // THE CALL. Undo the world placement on the shifted run and it must be
      // the origin run's toolpath, coordinate for coordinate -- the finish saw
      // the SAME local-frame removed stock in both cases. Before the fix, the
      // shifted run swept world-placed moves into a local-frame stock box: the
      // removed region landed in the wrong place and this diverges. WO-1641
      // keeps that frame rule on the replay that now runs for EVERY finish.
      const localizedShifted = unplace(shiftedMoves, SHIFT)
      for (let i = 0; i < originMoves.length; i++) {
        expect(localizedShifted[i].x).toBeCloseTo(originMoves[i].x, 6)
        expect(localizedShifted[i].y).toBeCloseTo(originMoves[i].y, 6)
        expect(localizedShifted[i].z).toBeCloseTo(originMoves[i].z, 6)
      }

      // Control: the SAME small tool, SAME code path, but the "predecessor"
      // removed nothing (empty toolpathMoves) -- what "the finish was told
      // nothing was removed" looks like, apples to apples with the runs above.
      const emptyPredecessor: Operation = {
        id: 'op-empty', name: 'op-empty', type: 'adaptive_3d', enabled: true, status: 'ready',
        toolId: big.id, geometrySelections: ['geo'],
        heights: {
          clearanceHeight: BOX.z + 10, clearanceHeightMode: 'absolute',
          retractHeight: BOX.z + 2, feedHeight: BOX.z + 1,
          topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom',
        },
        passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
        linking: {
          entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
          retractType: 'full', transitionType: 'safe_height',
        },
        params: {},
        toolpathMoves: [],
      }
      const controlOp = operation('op-rest-alone', 'parallel_3d', small.id, BOX.z, restFromPredecessorsParams(), 'setup-control', 'geo', 'stock')
      const controlScene = await makeScene(restStepFixture(), [setup('setup-control', 'stock', [emptyPredecessor, controlOp])], [big, small], { x: 0, y: 0, z: 0 }, 'geo', 'stock')
      let controlLengthMm: number
      try {
        await controlScene.compute('setup-control', 'op-rest-alone')
        const control = controlScene.op('setup-control', 'op-rest-alone')
        expect(control.errorMessage).toBeUndefined()
        expect(control.status).toBe('ready')
        controlLengthMm = cutLengthMm(control.toolpathMoves)
      } finally {
        await controlScene.dispose()
      }

      const originLengthMm = cutLengthMm(originMoves)
      const shiftedLengthMm = cutLengthMm(shiftedMoves)
      // WO-1641: the finish stays the finish the operator chose -- it still
      // covers the surface -- but it FEEDS through none of the air the rough
      // removed, so it cuts strictly less than the same finish that was told
      // nothing was removed. Both placements save exactly the same length.
      expect(controlLengthMm).toBeGreaterThan(0)
      expect(originLengthMm).toBeLessThan(controlLengthMm)
      expect(shiftedLengthMm).toBeLessThan(controlLengthMm)
      expect(shiftedLengthMm).toBeCloseTo(originLengthMm, 6)

      console.log(
        `[WO-1387/WO-1641] finish after rough, origin vs shifted (+${SHIFT.x},+${SHIFT.y}): ` +
          `${originCuts.length} vs ${shiftedCuts.length} cutting moves (identical once unplaced); ` +
          `fed length ${originLengthMm.toFixed(1)}mm vs ${shiftedLengthMm.toFixed(1)}mm; ` +
          `told-nothing-was-removed control: ${controlLengthMm.toFixed(1)}mm`,
      )
    },
  )
})
