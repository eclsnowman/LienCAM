// WO-279 -- the app asks for rest machining.
//
// WO-274 kept a rough's carved field alive; WO-277 taught the rougher to start
// from it and to refuse a field that describes a different situation. Nothing
// in the app ever passed the handle, so a machinist's second roughing pass
// still re-cut air. This is the call: when the operation immediately before a
// 3D rough, in the same setup, is the rough whose field the worker still holds,
// the store passes that handle.
//
// What these tests prove, through the REAL store compute path (the app), with
// the real BvhKernel behind an in-process worker channel:
//   1. IT ASKS. Two 3D roughs in one setup: the request the store sends for the
//      second one carries the first one's retained handle, and the pass drops
//      to a fraction of the same operation planned from a full box -- with every
//      engaging move standing where the big cutter left material. The full-box
//      control is the same op run FIRST in its own setup, so the number measures
//      the wiring, not the strategy.
//   2. A MISMATCH STILL RUNS. A second rough on a different cell size is not
//      asked for at all: no handle is passed, no refusal reaches the user, and
//      the operation plans from a full box and lands ready -- move for move the
//      same as running it alone. This is the test that would have caught the
//      dangerous version of this order, where the app passes a handle and lets
//      WO-277's refusal fail a job that used to run.
//   3. ORDER IS THE WHOLE RULE. A rough whose predecessor is a 3D FINISH gets no
//      handle even though the field is live and matches in every other way: the
//      retained picture is one operation old by construction (WO-274 retains one
//      field at a time). It cuts the full pocket again, exactly as before.
//
// Plus the branch table for restStartStockFor itself, where staging a case
// through the store would cost a rough per branch and prove no more.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { engagementPocket, pocketBox } from '../../cam3d/fixtures'
import {
  restStartStockFor,
  type RetainedRoughField,
} from '../../cam3d/integration/adaptive3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { Box3, ZDexelField } from '../../cam3d/stock'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse, StockHandle } from '../../cam3d/worker/protocol'
import type {
  FixedStockItem,
  ImportedGeometry,
  Operation,
  OperationType,
  PhysicalStock,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'

// The engagement fixture (WO-277's): 90 x 60 x 16 block, H-shaped pocket to a
// floor at z = 4 with a 6 mm NECK joining the two chambers. An 8 mm cutter
// cannot enter the neck at all, so what it leaves there is material it provably
// could not reach -- not a scallop a tolerance argument could explain away.
const EP = { x: 90, y: 60, z: 16 }
const EP_NECK = { x0: 40, x1: 50, y0: 27, y1: 33 }

// The small closed part (WO-274's): 24 x 20 x 12 block with a centred 10 x 8
// pocket 5 mm deep. Cheap enough to rough several times per test.
const BOX = { x: 24, y: 20, z: 12 }
const BOX_POCKET = { x: 10, y: 8, depth: 5 }

/** Shared grid for ops that are meant to describe the SAME situation. */
const CELL_SIZE = 1

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
): Operation {
  return stampSmartHeightAuthority({
    id,
    name: id,
    type,
    enabled: true,
    status: 'pending',
    toolId,
    geometrySelections: ['geo-wo279'],
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
  }, { setupId, geometryIds: ['geo-wo279'], stockId: 'stock-wo279' })
}

/** An adaptive_3d op's params, with the grid and stepdown as the only knobs a test turns. */
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

function setup(id: string, operations: Operation[]): Setup {
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
      stockId: 'stock-wo279',
    },
    stock: {
      type: 'rectangular',
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations,
    notes: '',
  }
}

/** Moves that touch material: everything that is not a positioning rapid. */
function cuttingMoves(moves: ToolpathMove[] | undefined): ToolpathMove[] {
  return (moves ?? []).filter((m) => m.type !== 'rapid')
}

/**
 * Highest material standing anywhere the cutter body covers at (x, y) -- the
 * honest question for "did this move work material the previous run left"
 * (WO-277's probe, unchanged). A cut in a leftover slot has its CENTRE offset by
 * up to the tool radius from the material it removes, and one cell of slack
 * covers the grid quantization.
 */
function topWithinReach(field: ZDexelField, x: number, y: number, radius: number): number {
  const reach = radius + field.cell
  const i0 = Math.max(0, Math.floor((x - reach - field.originX) / field.cell))
  const i1 = Math.min(field.nx - 1, Math.floor((x + reach - field.originX) / field.cell))
  const j0 = Math.max(0, Math.floor((y - reach - field.originY) / field.cell))
  const j1 = Math.min(field.ny - 1, Math.floor((y + reach - field.originY) / field.cell))
  let highest = Number.NEGATIVE_INFINITY
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const t = field.top[field.colIndex(i, j)]
      if (t > highest) highest = t
    }
  }
  return highest
}

/** What the store actually ASKED the worker for, per adaptive rough. */
type RoughAsk = { startFromStock: StockHandle | undefined; cellSize: number; stockBounds: Box3 }

interface Scene {
  /** Run one operation through the app's real compute path. */
  compute: (setupId: string, opId: string) => Promise<void>
  /** The operation as the store left it (status, moves, error). */
  op: (setupId: string, opId: string) => Operation
  /** One entry per adaptive rough request the store sent, in order. */
  asks: RoughAsk[]
  /** One entry per field the worker retained, in order. */
  retained: StockHandle[]
  dispatcher: Cam3dDispatcher
  dispose: () => Promise<void>
}

/**
 * Stand the app up around the real cam3d kernel: a Cam3dClient wired straight to
 * a Cam3dDispatcher (worker.test.ts / WO-274 pattern) behind the store's own
 * client accessor, so every carve is real geometry and every decision is the
 * production one. Only the byte cache and the tessellator are stubbed -- this
 * test is about which handle the store passes, not about reading STEP files.
 */
async function makeScene(mesh: PartMesh, stock: FixedStockItem, setups: Setup[], tools: Tool[]): Promise<Scene> {
  vi.resetModules()

  const kernel = new BvhKernel()
  const asks: RoughAsk[] = []
  const retained: StockHandle[] = []
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      const request = message as Cam3dRequest
      if (request.kind === 'adaptiveRough') {
        asks.push({
          startFromStock: request.startFromStock,
          cellSize: request.cellSize,
          stockBounds: { ...request.stockBounds },
        })
      }
      dispatcher.handle(request)
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    if (message.kind === 'adaptiveRoughed' && message.stockHandle !== undefined) {
      retained.push(message.stockHandle)
    }
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

  // STEP, not STL: an imported STL is recentred for display, so its moves live in
  // a shifted frame. STEP keeps the mesh coordinates, which makes the world moves
  // this test reads directly comparable to the fixture's own coordinates.
  const geometry: ImportedGeometry = {
    id: 'geo-wo279',
    name: 'WO-279 part',
    filename: 'wo279.step',
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
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: stock.id,
  }
  const sceneStock: SceneStock = {
    mode: 'fixed',
    autoOffsetXY: 0,
    autoOffsetZTop: 0,
    fixedWidth: stock.width,
    fixedHeight: stock.height,
    fixedDepth: stock.depth,
    fixedStocks: [stock],
  }
  // Adaptive 3D's live Smart Height V2 policy requires an owning PhysicalStock
  // matching setup.wcs.stockId (and the target geometry's own stockId, set
  // above) -- the same evidence the operation dialog resolves against.
  const physicalStock: PhysicalStock = {
    id: stock.id,
    name: stock.name,
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: stock.width, y: stock.height, z: stock.depth },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: { x: stock.width / 2, y: stock.height / 2, z: stock.depth / 2 },
    },
    position: { x: 0, y: 0, z: 0 },
  }

  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      id: 'project-wo279',
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
    asks,
    retained,
    dispatcher,
    dispose: async () => {
      await client.dispose()
    },
  }
}

function stockFor(size: { x: number; y: number; z: number }): FixedStockItem {
  // The block AS LOADED is exactly the fixture's own AABB, so the rougher's
  // field is the same box WO-277 planned against and the material top is proven.
  return {
    id: 'stock-wo279',
    name: 'WO-279 block',
    width: size.x,
    height: size.y,
    depth: size.z,
    position: { x: 0, y: 0, z: 0 },
  }
}

afterEach(() => {
  vi.doUnmock('../../cam3d/integration/appClient')
  vi.doUnmock('../../cam3d/integration/parallel3dOperation')
  vi.doUnmock('../../lib/stepCache')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('WO-279 the app asks for rest machining', () => {
  it(
    'a second rough in a setup is planned from the first one\'s field',
    { timeout: 600_000 },
    async () => {
      const big = tool('tool-8', 8)
      const small = tool('tool-3', 3)
      // Setup A is the machinist's real sequence: hog it out with the 8 mm
      // cutter, then send the 3 mm one after what it could not reach. Setup B
      // runs THE SAME 3 mm operation first, which is the full-box control -- the
      // comparison then measures the wiring and not the strategy.
      const rest = setup('setup-rest', [
        operation('op-rough-8', 'adaptive_3d', big.id, EP.z, roughParams(CELL_SIZE, 6), 'setup-rest'),
        operation('op-rough-3', 'adaptive_3d', small.id, EP.z, roughParams(CELL_SIZE, 6), 'setup-rest'),
      ])
      const control = setup('setup-control', [
        operation('op-rough-3-alone', 'adaptive_3d', small.id, EP.z, roughParams(CELL_SIZE, 6), 'setup-control'),
      ])
      const scene = await makeScene(engagementPocket(), stockFor(EP), [rest, control], [big, small])
      try {
        await scene.compute(rest.id, 'op-rough-8')
        expect(scene.op(rest.id, 'op-rough-8').status).toBe('ready')
        // Hold the field the big cutter left: the next rough's own retention
        // releases it, and this is what "material the big cutter could not
        // reach" means, measured rather than argued.
        expect(scene.retained).toHaveLength(1)
        const bigLeft = scene.dispatcher.peekStock(scene.retained[0]).clone()
        expect(
          topWithinReach(bigLeft, (EP_NECK.x0 + EP_NECK.x1) / 2, (EP_NECK.y0 + EP_NECK.y1) / 2, 0),
        ).toBeCloseTo(EP.z, 3)

        await scene.compute(rest.id, 'op-rough-3')
        const restOp = scene.op(rest.id, 'op-rough-3')
        expect(restOp.errorMessage).toBeUndefined()
        expect(restOp.status).toBe('ready')

        // THE CALL. The store asked the worker to start this operation from the
        // field the operation before it left behind. Everything below is what
        // that asking bought.
        expect(scene.asks).toHaveLength(2)
        expect(scene.asks[0].startFromStock).toBeUndefined()
        expect(scene.asks[1].startFromStock).toBe(scene.retained[0])

        // The control: the same operation, first in its own setup, so no handle
        // is asked for and it plans from a full box.
        await scene.compute(control.id, 'op-rough-3-alone')
        expect(scene.op(control.id, 'op-rough-3-alone').status).toBe('ready')
        expect(scene.asks).toHaveLength(3)
        expect(scene.asks[2].startFromStock).toBeUndefined()

        const restCuts = cuttingMoves(restOp.toolpathMoves)
        const boxCuts = cuttingMoves(scene.op(control.id, 'op-rough-3-alone').toolpathMoves)
        expect(restCuts.length).toBeGreaterThan(0)
        expect(boxCuts.length).toBeGreaterThan(0)
        expect(restCuts.length).toBeLessThan(boxCuts.length)

        // ...and what it kept is the material the 8 mm cutter could not reach.
        // Moves at or above the top of the block are excluded by geometry, not
        // by taste: no material stands that high anywhere in this stock, so an
        // entry ramp descending to it cuts nothing and makes no claim about
        // which region it is over. Entries (plunge / ramp / lead) are excluded
        // for the same reason: a wall-cleanup plunge lands in PROVEN-CLEAR air
        // on the floor the big cutter already made (z == local top, cutting
        // nothing) and only then leads into the island wall - WO-401.
        const restRadius = small.diameter / 2
        const lateral = new Set(['cut', 'stepover', 'finish'])
        const engaging = restCuts.filter((m) => m.z < EP.z - 1e-6 && lateral.has(String(m.role)))
        expect(engaging.length).toBeGreaterThan(0)
        const misplaced = engaging.filter(
          (m) => topWithinReach(bigLeft, m.x, m.y, restRadius) <= m.z + 1e-3,
        )
        expect(misplaced).toHaveLength(0)
        const inNeck = restCuts.filter(
          (m) =>
            m.x > EP_NECK.x0 - restRadius &&
            m.x < EP_NECK.x1 + restRadius &&
            m.y > EP_NECK.y0 - restRadius &&
            m.y < EP_NECK.y1 + restRadius &&
            m.z < EP.z,
        )
        expect(inNeck.length).toBeGreaterThan(0)

        // Tier 2 evidence: the two move counts this order exists to change.
        console.log(
          `[WO-279] 3 mm rough after the 8 mm rough in the same setup: ${restCuts.length} ` +
            `cutting moves (${inNeck.length} in the neck the 8 mm cutter cannot enter); the ` +
            `same operation planned from a full box: ${boxCuts.length}`,
        )
      } finally {
        await scene.dispose()
      }
    },
  )

  it(
    'a second rough on a different grid plans from a full box and still runs',
    { timeout: 300_000 },
    async () => {
      // Same tool, same part, same setup -- only the cell size differs, so the
      // retained field describes a grid this operation is not planning on. The
      // app must not ask for it: WO-277 would REFUSE the handle, and a refusal
      // reaching the user turns a job that used to run into a failing one.
      const cutter = tool('tool-3', 3)
      const mismatch = setup('setup-mismatch', [
        operation('op-rough-coarse', 'adaptive_3d', cutter.id, BOX.z, roughParams(CELL_SIZE, 3), 'setup-mismatch'),
        operation('op-rough-fine', 'adaptive_3d', cutter.id, BOX.z, roughParams(CELL_SIZE / 2, 3), 'setup-mismatch'),
      ])
      const control = setup('setup-control', [
        operation('op-rough-fine-alone', 'adaptive_3d', cutter.id, BOX.z, roughParams(CELL_SIZE / 2, 3), 'setup-control'),
      ])
      const scene = await makeScene(
        pocketBox(BOX, BOX_POCKET),
        stockFor(BOX),
        [mismatch, control],
        [cutter],
      )
      try {
        await scene.compute(mismatch.id, 'op-rough-coarse')
        expect(scene.op(mismatch.id, 'op-rough-coarse').status).toBe('ready')
        expect(scene.retained).toHaveLength(1)

        await scene.compute(mismatch.id, 'op-rough-fine')
        const fine = scene.op(mismatch.id, 'op-rough-fine')
        // No refusal, no error, a real toolpath: the operation planned from a
        // full box exactly as it always did.
        expect(fine.errorMessage).toBeUndefined()
        expect(fine.status).toBe('ready')
        expect(scene.asks[1].cellSize).toBe(CELL_SIZE / 2)
        expect(scene.asks[1].startFromStock).toBeUndefined()

        await scene.compute(control.id, 'op-rough-fine-alone')
        const alone = scene.op(control.id, 'op-rough-fine-alone')
        expect(alone.status).toBe('ready')
        // Move for move what running it alone produces -- the retained field
        // changed nothing about it.
        const fineCuts = cuttingMoves(fine.toolpathMoves)
        expect(fineCuts.length).toBeGreaterThan(0)
        expect(fineCuts.length).toBe(cuttingMoves(alone.toolpathMoves).length)
        console.log(
          `[WO-279] cell-size mismatch: ${fineCuts.length} cutting moves, identical to the same ` +
            'operation run alone; no handle passed, no refusal',
        )
      } finally {
        await scene.dispose()
      }
    },
  )

  it(
    'a rough after a 3D finish, or first in its setup, plans from a full box',
    { timeout: 300_000 },
    async () => {
      // The two roughs are IDENTICAL -- same tool, same grid, same part. If the
      // app wrongly asked for the live field, the second one would find nothing
      // left to cut (WO-277's decisive case). It sits behind a 3D FINISH, so the
      // retained picture is one operation old and must not be asked for.
      const cutter = tool('tool-3', 3)
      const ordered = setup('setup-ordered', [
        operation('op-rough-first', 'adaptive_3d', cutter.id, BOX.z, roughParams(CELL_SIZE, 3), 'setup-ordered'),
        operation('op-finish', 'parallel_3d', cutter.id, BOX.z, { stepover: 1, tolerance: 0.05 }, 'setup-ordered'),
        operation('op-rough-after-finish', 'adaptive_3d', cutter.id, BOX.z, roughParams(CELL_SIZE, 3), 'setup-ordered'),
      ])
      const scene = await makeScene(
        pocketBox(BOX, BOX_POCKET),
        stockFor(BOX),
        [ordered],
        [cutter],
      )
      try {
        // First in its setup: nothing before it, so nothing is asked for.
        await scene.compute(ordered.id, 'op-rough-first')
        const first = scene.op(ordered.id, 'op-rough-first')
        expect(first.status).toBe('ready')
        expect(scene.asks[0].startFromStock).toBeUndefined()
        expect(scene.retained).toHaveLength(1)

        await scene.compute(ordered.id, 'op-rough-after-finish')
        const after = scene.op(ordered.id, 'op-rough-after-finish')
        expect(after.errorMessage).toBeUndefined()
        expect(after.status).toBe('ready')
        expect(scene.asks[1].startFromStock).toBeUndefined()

        // It cut the whole pocket again: identical inputs, identical path (D-006).
        const firstCuts = cuttingMoves(first.toolpathMoves)
        const afterCuts = cuttingMoves(after.toolpathMoves)
        expect(firstCuts.length).toBeGreaterThan(0)
        expect(afterCuts.length).toBe(firstCuts.length)
        console.log(
          `[WO-279] rough behind a 3D finish: ${afterCuts.length} cutting moves, the same as the ` +
            `identical rough before it (${firstCuts.length}); no handle passed`,
        )
      } finally {
        await scene.dispose()
      }
    },
  )
})

describe('WO-279 restStartStockFor decides before the handle is passed', () => {
  const client = { id: 'client' } as unknown as Cam3dClient
  const bounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 24, maxY: 20, maxZ: 12 }
  const retained: RetainedRoughField = {
    client,
    handle: 7 as StockHandle,
    setupId: 'setup-1',
    opId: 'op-rough-a',
    geometryId: 'geo-1',
    stockBounds: bounds,
    cellSize: CELL_SIZE,
    upstreamChainFingerprint: 'chain-a',
  }
  const previousOp = {
    id: 'op-rough-a',
    type: 'adaptive_3d',
    status: 'ready',
    enabled: true,
  } as const
  const ask = (over: Partial<Parameters<typeof restStartStockFor>[0]> = {}) =>
    restStartStockFor({
      retained,
      client,
      setupId: 'setup-1',
      previousOp,
      geometryId: 'geo-1',
      stockBounds: { ...bounds },
      cellSize: CELL_SIZE,
      upstreamChainFingerprint: 'chain-a',
      ...over,
    })

  it('passes the handle when the whole situation matches', () => {
    expect(ask()).toBe(retained.handle)
  })

  it.each([
    ['nothing has been retained yet', { retained: undefined }],
    ['the field lives in a worker that is gone', { client: {} as unknown as Cam3dClient }],
    ['this is the first operation in the setup', { previousOp: undefined }],
    [
      'the operation before it is not a 3D rough',
      { previousOp: { ...previousOp, type: 'parallel_3d' as const } },
    ],
    [
      'the operation before it is a different rough',
      { previousOp: { ...previousOp, id: 'op-rough-elsewhere' } },
    ],
    [
      'the operation before it is disabled',
      { previousOp: { ...previousOp, enabled: false } },
    ],
    [
      'the operation before it has no current toolpath',
      { previousOp: { ...previousOp, status: 'outdated' as const } },
    ],
    ['the field was carved in another setup', { setupId: 'setup-2' }],
    ['the field was carved around another solid', { geometryId: 'geo-2' }],
    ['this operation has no solid selected', { geometryId: undefined }],
    ['the grid is different', { cellSize: CELL_SIZE / 2 }],
    ['an enabled upstream operation changed or moved', { upstreamChainFingerprint: 'chain-b' }],
    ['the block is taller', { stockBounds: { ...bounds, maxZ: 17 } }],
    ['the block starts somewhere else', { stockBounds: { ...bounds, minX: -1 } }],
    ['a bound is not a number', { stockBounds: { ...bounds, maxY: Number.NaN } }],
  ])('refuses to ask when %s', (_name, over) => {
    expect(ask(over)).toBeUndefined()
  })
})
