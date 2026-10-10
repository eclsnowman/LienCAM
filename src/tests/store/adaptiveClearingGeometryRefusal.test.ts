// SKC-47-R2 — end-to-end drive proof for the Adaptive Clearing loop-consumer census row.
//
// The R1 audit's live-user-facing defect: a geometry-boundary adaptive_clearing_2d op with
// only OPEN loops (a partial-ellipse region) had NO store-level pre-dispatch guard (unlike
// Face — see store/index.ts:5415-5420, cited read-only, NOT edited by this WO) and dispatched
// straight to a builder that logged a console.warn and returned []: status stayed 'ready',
// 0 moves, nothing renders. SKC-47-R2 fixed the builder to throw (adaptiveClearing2d/engine/
// index.ts). This test drives the REAL failure path end to end:
//   1. The REAL store dispatch (computeOperationToolpath, store/index.ts — read/cite only, no
//      edits) builds the REAL ACWorkerPayload for a geometry-boundary op with only open loops.
//   2. The REAL builder (buildAdaptiveClearingToolpath) is run against that REAL payload and
//      genuinely throws the named refusal (not fabricated).
//   3. The thrown error is delivered to the store's REAL worker.onmessage handler exactly as
//      toolpathWorker.ts's catch block would (TOOLPATH_ERROR), proving the REAL, unedited
//      store code (store/index.ts:5945-5952) sets the operation to status 'error' with that
//      message — the same user-visible surface DesignTree.tsx renders (:1167, :1188).
// The only simulated boundary is the Worker postMessage/onmessage wire itself (jsdom has no
// real Worker threads) — the SAME test-double convention this repo already uses
// (src/tests/store/consoleWritersUI11B.test.ts's CrashWorker precedent for worker.onerror).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { bakeSketch } from '../../lib/sketch/bake'
import { buildAdaptiveClearingToolpath } from '../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, PhysicalStock, Setup, Operation, Tool,
  HeightParams, PassParams, LinkingParams,
} from '../../types'
import type { ACWorkerPayload, WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

// ── The canonical open-loop bake fixture — a LONE elliptical arc (SKC-48).
// SKC-48 taught bake.ts to chain a partial ellipse with an adjacent chord into ONE closed loop, so
// the old arc+chord fixture no longer bakes open. A LONE elliptical arc (no closing neighbour) still
// bakes to exactly ONE open loop — the honest no-closed-loop input this end-to-end refusal proof
// requires. (This file must remain an open-loops refusal proof; the D-shape now closes and is proven
// cuttable in loop-consumer-census.test.ts / bake.test.ts instead.)
function sketch(entities: SketchEntity[]): Sketch {
  return { id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}
const ellipticalArc = (id: string, majorRadius: number, minorRadius: number, startParam: number, endParam: number): SketchEntity => ({
  id, kind: 'elliptical-arc', construction: false,
  center: { x: 0, y: 0 }, majorRadius, minorRadius, rotation: 0, startParam, endParam,
})
const A = 20, B = 10
const PARTIAL_ELLIPSE_LOOPS = bakeSketch(sketch([
  ellipticalArc('ea', A, B, 0, Math.PI),
])).loops

function makeStock(): FixedStockItem {
  return {
    id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12,
    position: { x: 0, y: 0, z: 0 },
  }
}
function makeSceneStock(stock: FixedStockItem): SceneStock {
  return {
    mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock],
  }
}
function makeGeo(): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: -20, y: -10, z: 0 }, max: { x: 20, y: 10, z: 0 },
      size: { x: 40, y: 20, z: 0 }, center: { x: 0, y: 0, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    // ONLY open loops — the partial-ellipse region has no closed boundary.
    loops: PARTIAL_ELLIPSE_LOOPS,
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  }
}
function makeSetup(stockId: string, operations: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations,
    notes: '',
  }
}
function makeTool(): Tool {
  return {
    id: 'tool-1', name: '6mm EM', type: 'flat_endmill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
  } as unknown as Tool
}
// Stamped for Smart Height V2 (commit 2e5678b7): the explicit-depth planar-
// rough policy always resolves machining.start as 'current_material' (the
// real stock top), ignoring topHeightMode/topHeight - so clearance/retract/
// feed (the legacy-intent bridge maps them straight through as absolute
// wcs_plane offsets) must already clear the stock top (world/WCS Z 12: the
// stock block is 12mm deep at WCS origin Z 0) for the V2 authority's
// Clearance >= Retract >= Feed >= Material Start check to hold.
const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makeOp(): Operation {
  const params = {
    geometryId: 'geo-1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.7,
    stepDistance: 0.4, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
  }
  return {
    id: 'op-1', name: 'AC', type: 'adaptive_clearing_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights, passes, linking,
    // boundarySource deliberately ABSENT: default 'geometry' — the branch with NO store
    // pre-dispatch guard (unlike face/stock — store/index.ts:5440-5502 only handles 'stock').
    params,
    smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', {
      setupId: 'setup-1', heights, params, geometryIds: ['geo-1'],
    }),
    // Simulate a saved, previously-ready path. The real compute lifecycle must
    // clear this atomically before dispatch and keep it absent on refusal.
    toolpathMoves: [{ type: 'feed', x: 618, y: 0, z: -2, feed: 1000 }],
    computeTimeMs: 618,
    estimatedCutTimeMs: 619,
    estimatedCutTimeMsError: 'stale estimate refusal',
  } as unknown as Operation
}

type Posted = { type: string; payload: ACWorkerPayload }
class MockWorker {
  static instances: MockWorker[] = []
  posted: Posted[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { MockWorker.instances.push(this) }
  postMessage(msg: Posted): void { this.posted.push(msg) }
  terminate(): void { /* no-op */ }
}

function installScene(geometry: ImportedGeometry = makeGeo()): void {
  const stock = makeStock()
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: stock.width, y: stock.height, z: stock.depth },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: { x: stock.width / 2, y: stock.height / 2, z: stock.depth / 2 },
    },
    position: { x: stock.position.x, y: stock.position.y, z: stock.position.z },
  }
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [{ ...geometry, stockId: stock.id }],
      setups: [makeSetup(stock.id, [makeOp()])],
      sceneStock: makeSceneStock(stock),
      stocks: [physicalStock],
      activeSetupId: 'setup-1',
      activeOperationId: 'op-1',
    },
    toolLibrary: [makeTool()],
    toolpathBatch: null,
  }))
}

function opAfter(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

describe('Adaptive Clearing geometry-boundary refusal — REAL end-to-end (SKC-47-R2)', () => {
  beforeEach(async () => {
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
    await ensureEngineClipperReady()
  })
  afterAll(() => { vi.unstubAllGlobals() })

  it('a geometry-boundary AC op with only open loops ends at status "error" through the ' +
     'real dispatch -> real builder throw -> real TOOLPATH_ERROR store handler chain', async () => {
    installScene()

    // 1. REAL dispatch: computeOperationToolpath builds the REAL payload and posts it to the
    // (stubbed) worker. Dispatch up to postMessage is synchronous (mirrors dispatchHeights.test.ts).
    void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      .catch(() => { /* the silent-worker shim never resolves; unrelated to this assertion */ })
    // Smart Height V2's planar-rough runtime resolves through one await
    // (resolvePlanarRoughSmartRuntime, store/index.ts ~12753) before
    // postMessage - flush that microtask, same convention as
    // faceStockDefaultModelPresent.camOpsModelE2E.test.ts.
    await Promise.resolve()
    await Promise.resolve()
    expect(MockWorker.instances).toHaveLength(1)
    const worker = MockWorker.instances[0]
    expect(worker.posted).toHaveLength(1)
    const dispatched = worker.posted[0]
    expect(dispatched.type).toBe('COMPUTE_ADAPTIVE_CLEARING')
    // The store never filtered by closed for the geometry branch — both open loops still ride.
    expect(dispatched.payload.loops.every(l => l.closed === false)).toBe(true)
    expect(dispatched.payload.loopOrigins).toEqual(Object.fromEntries(
      dispatched.payload.loops.map(loop => [loop.id, { x: 0, y: 0 }]),
    ))
    expect(opAfter().status).toBe('computing')
    expect(opAfter().toolpathMoves).toBeUndefined()
    expect(opAfter().computeTimeMs).toBeUndefined()
    expect(opAfter().estimatedCutTimeMs).toBeUndefined()
    expect(opAfter().estimatedCutTimeMsError).toBeUndefined()

    // 2. REAL builder against the REAL dispatched payload — genuinely throws (SKC-47-R2 fix).
    let thrown: Error | undefined
    try {
      await buildAdaptiveClearingToolpath(dispatched.payload)
    } catch (err) {
      thrown = err instanceof Error ? err : new Error(String(err))
    }
    expect(thrown, 'the real builder must throw on a no-closed-loop geometry-boundary payload').toBeDefined()
    expect(thrown!.message).toMatch(/Adaptive Clearing:.*no closed loop/i)

    // 3. Deliver it to the store's REAL worker.onmessage handler exactly as toolpathWorker.ts's
    // catch block does (mirrors the CrashWorker onerror precedent for onmessage/TOOLPATH_ERROR).
    expect(typeof worker.onmessage).toBe('function')
    worker.onmessage!({ data: { type: 'TOOLPATH_ERROR', opId: dispatched.payload.opId, message: thrown!.message } })

    const op = opAfter()
    expect(op.status).toBe('error')
    expect(op.errorMessage).toMatch(/Adaptive Clearing:.*no closed loop/i)
    expect(op.toolpathMoves).toBeUndefined()
    expect(op.computeTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMs).toBeUndefined()
    expect(op.estimatedCutTimeMsError).toBeUndefined()
  })

  it('chooses a nonzero authored origin only for loops that follow geometry.position', async () => {
    const geometry = makeGeo()
    geometry.position = { x: 37.5, y: -19.25, z: 0 }
    const localLoop = { ...geometry.loops![0], id: 'local-loop', layerId: 'L1' }
    const worldLoop = {
      ...geometry.loops![0],
      id: 'world-loop',
      layerId: 'world-layer',
      points: geometry.loops![0].points.map(point => ({
        ...point,
        x: point.x + 200,
        y: point.y - 100,
      })),
    }
    geometry.loops = [localLoop, worldLoop]
    geometry.layers2d = [
      geometry.layers2d![0],
      {
        id: 'world-layer', name: 'World projection', color: '#00e5ff', visible: true,
        projectionPlane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
      },
    ]
    installScene(geometry)

    void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      .catch(() => { /* the silent-worker shim never resolves; unrelated to this assertion */ })
    await Promise.resolve()
    await Promise.resolve()

    const dispatched = MockWorker.instances[0]?.posted[0]
    expect(dispatched).toBeDefined()
    expect(dispatched.payload.loopOrigins).toEqual({
      'local-loop': { x: 37.5, y: -19.25 },
      'world-loop': { x: 0, y: 0 },
    })
    expect(dispatched.payload.loops.find(loop => loop.id === 'local-loop')?.points)
      .toEqual(localLoop.points.map(point => ({
        ...point,
        x: point.x + 37.5,
        y: point.y - 19.25,
      })))
    expect(dispatched.payload.loops.find(loop => loop.id === 'world-loop')?.points)
      .toEqual(worldLoop.points)
  })

  it('replaces the stale cache with the newly generated path and timing on success', async () => {
    installScene()

    void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      .catch(() => { /* the silent-worker shim never resolves; unrelated to this assertion */ })
    // Flush the Smart Height V2 planar-rough runtime's one await before postMessage
    // (see the comment on the previous test).
    await Promise.resolve()
    await Promise.resolve()
    const worker = MockWorker.instances[0]
    expect(worker).toBeDefined()

    const generatedMoves = [
      { type: 'rapid', x: 0, y: 0, z: 5 },
      { type: 'plunge', x: 0, y: 0, z: -2, feed: 300 },
      { type: 'feed', x: 20, y: 0, z: -2, feed: 1000 },
    ] as NonNullable<Operation['toolpathMoves']>
    worker.onmessage!({
      data: {
        type: 'TOOLPATH_COMPLETE',
        opId: 'op-1',
        moves: generatedMoves,
        computeTimeMs: 23,
      },
    })

    const op = opAfter()
    expect(op.status).toBe('ready')
    expect(op.toolpathMoves).toEqual(generatedMoves)
    expect(op.computeTimeMs).toBe(23)
    expect(op.estimatedCutTimeMs ?? 0).toBeGreaterThan(0)
    expect(op.estimatedCutTimeMsError).toBeUndefined()
  })
})

// ── SKC-47-R3 audit fix — the test above manually constructs the TOOLPATH_ERROR message at
// line ~207 rather than getting it from toolpathWorker.ts's own catch block, so a regression in
// that catch/response conversion would not turn this file RED. This describe drives the REAL
// toolpathWorker.ts module: it stubs only the Worker-global wire (self.postMessage — jsdom/node
// has no real Worker thread, same test-double convention as MockWorker above) and invokes the
// REAL self.onmessage handler with a REAL COMPUTE_ADAPTIVE_CLEARING request, asserting on the
// TOOLPATH_ERROR response the handler's own catch block actually constructs.
describe('toolpathWorker COMPUTE_ADAPTIVE_CLEARING boundary — real self.onmessage catch/response conversion (SKC-47-R3)', () => {
  afterAll(() => {
    delete (globalThis as { self?: unknown }).self
  })

  it('a real worker onmessage dispatch on an only-open-loops payload posts the handler\'s own TOOLPATH_ERROR response', async () => {
    const posted: WorkerResponseMsg[] = []
    ;(globalThis as { self?: unknown }).self = {
      postMessage: (m: WorkerResponseMsg) => { posted.push(m) },
      onmessage: null as ((e: { data: WorkerRequestMsg }) => Promise<void>) | null,
    }

    // toolpathWorker.ts installs its handler onto self.onmessage as a side effect of import.
    await import('../../lib/cam/toolpathWorker')
    const workerSelf = (globalThis as {
      self: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
    }).self
    expect(typeof workerSelf.onmessage).toBe('function')

    const payload: ACWorkerPayload = {
      opId: 'op-boundary', setupId: 'setup-1',
      params: {
        geometryId: 'geo-1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.7,
        stepDistance: 0.4, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
      },
      heights, passes, linking, tool: makeTool(), loops: PARTIAL_ELLIPSE_LOOPS, wcsOrigin: { x: 0, y: 0, z: 0 },
    } as ACWorkerPayload
    const request: WorkerRequestMsg = { type: 'COMPUTE_ADAPTIVE_CLEARING', payload }

    await workerSelf.onmessage!({ data: request })

    // The builder also posts a TOOLPATH_PROGRESS message before it throws (onProgress fires
    // before the no-closed-loop check), so find the error response rather than assume length 1.
    const response = posted.find((m): m is Extract<WorkerResponseMsg, { type: 'TOOLPATH_ERROR' }> => m.type === 'TOOLPATH_ERROR')
    expect(response, `expected a TOOLPATH_ERROR among posted messages: ${JSON.stringify(posted)}`).toBeDefined()
    expect(response!.opId).toBe(payload.opId)
    expect(response!.message).toMatch(/Adaptive Clearing:.*no closed loop/i)
  })
})
