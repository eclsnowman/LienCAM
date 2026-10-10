// INT-17A-R3 C2: the HONEST final-consumer proof.
//
// ─── WHAT THE ROUND-3 AUDIT REJECTED ────────────────────────────────────────
//
// int17aR2OpCompute.test.ts claimed to prove the guard "at the final consumer"
// and did not. Its Worker stub's postMessage was a no-op, so no response ever
// came back; it never awaited computeOperationToolpath; and its assertions were
// negative-only (`not.toMatch`, `not.toBe('error')`). Every op it drove sat
// forever at status 'computing' with zero moves, which is exactly what the
// assertions demanded - including `toolpathMoves` being empty, which was true
// of every op in that file whether guarded, unguarded, legitimate or hostile.
// The audit's word for it was vacuous, and that is the right word.
//
// ─── WHAT THIS FILE DOES INSTEAD ────────────────────────────────────────────
//
// It runs the REAL computation. The Worker global is replaced with a shim that
// forwards each postMessage into the REAL src/lib/cam/toolpathWorker module's
// own self.onmessage - the same handler the browser worker thread runs, with
// the real builders and the real clipper behind it - and pipes the real
// TOOLPATH_COMPLETE / TOOLPATH_ERROR responses back to the store's onmessage.
// That precedent is src/tests/store/adaptiveClearingGeometryRefusal.test.ts,
// which already drives the real worker handler this way; this file inverts it
// to obtain a real SUCCESS rather than a real error.
//
// The two directions the WO's C2 requires:
//   (a) a legitimate op computed with a modeled body PRESENT elsewhere in the
//       project produces a real ToolpathMove[] with real cutting moves - and is
//       byte-identical to the same op computed with the modeled body absent,
//       which is what shows the guard EXCLUDED the body rather than merely
//       tolerating it;
//   (b) every guard refusal produces NO COMPUTE AT ALL - proven by asserting
//       the real worker handler received zero requests, not merely that the
//       move array ended up empty - and surfaces the named refusal on the op
//       card, which is where operations report errors.
//
// HOW IT CAN FAIL (charter rule 1): delete the guard call in
// computeOperationToolpath and the refusal cases fail on both the named message
// AND on the worker having been invoked. Break the real compute and (a) fails
// on move count. The committed mutation proof exercises the former.
//
// ─── INT-17A-R4 C2: EVERY compute channel, not just toolpathWorker ─────────
//
// The round-4 audit: workerRequests above only observes the toolpathWorker
// channel. parallel_3d and adaptive_3d never touch it - they hand off to the
// SEPARATE cam3d worker via src/cam3d/integration/appClient.ts's
// getCam3dClient(), which lazily spawns its own `new Worker(cam3dWorker.ts)`
// (see src/store/index.ts's parallel_3d/adaptive_3d branches, D-018). A
// refusal case that only asserts workerRequests is empty says nothing about
// whether the cam3d channel was reached; adaptive_3d additionally had no
// refusal case in this file at all.
//
// This file now also mocks src/cam3d/integration/appClient.ts so
// getCam3dClient - the ONE entry point every 3D family's compute path calls
// before it can reach its worker - is a spy wrapping the real implementation
// (cam3dClientSpy below). Every refusal case, 2.5D and 3D alike, asserts BOTH
// channels saw zero activity: workerRequests is empty AND cam3dClientSpy was
// never called. For the 2.5D refusal case this is redundant with the existing
// assertion (2.5D ops never call getCam3dClient regardless); for parallel_3d
// and adaptive_3d it is the claim the R3 file could not make, because the
// guard runs upstream of the branch that would have called it - proven here
// by observing the call itself never happens, not merely that no worker
// request followed from it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  ToolpathMove, Vec3, BoundingBox, WCS, HeightParams, PassParams, LinkingParams,
} from '../../types'

// The cam3d orchestration/client entry point (the audit's own suggested seam):
// a vi.fn() wrapping the REAL getCam3dClient, so a refusal case can assert it
// was never called while a (hypothetical, not exercised here) real 3D compute
// would still get the genuine client. vi.hoisted because vi.mock's factory
// below is hoisted above this file's other imports and needs a live reference.
const cam3dClientSpy = vi.hoisted(() => ({ getCam3dClient: vi.fn() }))

vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  cam3dClientSpy.getCam3dClient.mockImplementation(actual.getCam3dClient)
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual, getCam3dClient: cam3dClientSpy.getCam3dClient,
  })
})

// ─── fixtures ────────────────────────────────────────────────────────────────

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A legitimate loop-bearing 2D part on the derived stock. A real 40x30
 *  rectangle, big enough relative to the 6 mm tool that a contour actually
 *  produces cutting moves rather than degenerating. */
function ordinaryGeo(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`,
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }],
      closed: true, type: 'contour', layerId: 'L1', area: 1200,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** The hostile row: model ORIGIN wearing type 'brep' and real loops, no
 *  stockId (Stage 1 refuses to stock-bind it), parked high in Z so that any
 *  leak into an aggregate would visibly move the resulting toolpath. */
function hostileModelGeo(): ImportedGeometry {
  return {
    id: 'modelbody:F1', name: 'Model F1', filename: '', type: 'brep', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: -50 }, { x: 200, y: 200, z: 50 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'modelbody:F1-loop',
      points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }],
      closed: true, type: 'contour', layerId: 'L1', area: 10000,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  } as unknown as ImportedGeometry
}

function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 42, y: 32, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

/** stock_top so the op genuinely routes through resolveTopZ -> resolveOwningStock,
 *  the chain where a leaked modeled row would change the resolved heights. */
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
// finishPasses: 1 is load-bearing, not decoration. The real contour builder
// refuses a payload with no cutting mode selected ("Contour: no cutting mode
// selected. Enable roughing (stock to leave > 0), a finish pass, or both"), and
// a fixture that trips that refusal would never reach a real toolpath - which
// is how a proof about real toolpaths quietly becomes a proof about nothing.
const passes: PassParams = {
  stepdown: 1, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

const tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

// Commit 2e5678b7: a valid smart_v2 envelope is now the ONLY runtime height
// authority, and ensureOperationSmartHeightAuthority (store/index.ts) runs
// BEFORE the model-origin guard this file's (b) cases and the compute path
// (a) exercises. Stamp every op fixture below or every case here dies one
// boundary earlier than intended, on a Smart Height refusal instead of on
// whatever this file actually means to prove.
// smartHeightGeometryIds defaults to [geometryId], which is right for a
// direct single-geometry reference but wrong for the '__all__' aggregate
// sentinel: the Smart Height V2 scope is a concrete geometry-id list, not
// the sentinel itself (resolveContourSmartRuntime looks each id up in
// state.project.geometry directly), so '__all__' callers must pass the real
// ids the aggregate resolves to at call time.
function makeContourOp(geometryId: string, smartHeightGeometryIds: string[] = [geometryId]): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId, loopIds: [], side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, geometryIds: smartHeightGeometryIds,
    }),
  } as unknown as Operation
}

function makeParallel3dOp(entryId: string): Operation {
  return {
    id: 'op-1', name: 'Finish Pass', type: 'parallel_3d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [entryId],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { stepover: 1, angleDeg: 0 },
    smartHeight: smartHeightAuthorityFixture('parallel_3d', {
      setupId: 'setup-1', heights, geometryIds: [entryId],
    }),
  } as unknown as Operation
}

function makeAdaptive3dOp(entryId: string): Operation {
  return {
    id: 'op-1', name: 'Rough Pass', type: 'adaptive_3d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [entryId],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { maxStepdown: 2, stepover: 0.4, tolerance: 0.05, helixDiameter: 3 },
    smartHeight: smartHeightAuthorityFixture('adaptive_3d', {
      setupId: 'setup-1', heights, geometryIds: [entryId],
    }),
  } as unknown as Operation
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // Contour's Smart Height runtime (setupProvenStockId, store/index.ts)
      // requires a proven owning stock before it resolves anything.
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

function installProject(geometry: ImportedGeometry[], op: Operation): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project, geometry, stocks: [derivedStock()],
      setups: [makeSetup(op)], sceneStock,
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

const NAMED_REFUSAL = /refusing modeled geometry "Model F1"/

// ─── the REAL worker, driven in-process ──────────────────────────────────────

/** Requests the REAL toolpathWorker handler actually received. The refusal
 *  cases assert this is EMPTY, which is a far stronger claim than "no moves
 *  came back": it says no computation was even attempted. */
let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
/** The shim instance currently owning the real handler's responses. These tests
 *  compute one operation at a time, which is what makes a single slot safe. */
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined

beforeAll(async () => {
  // toolpathWorker.ts installs its handler onto self.onmessage as an import
  // side effect, so `self` must exist BEFORE the import. Responses it posts are
  // routed to whichever shim is currently driving it.
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as { self: typeof workerSelf }).self
  // Fail loudly rather than silently proving nothing if the import contract
  // ever changes - a null handler here would make every compute below a no-op,
  // which is the exact failure mode this file exists to stop repeating.
  expect(typeof workerSelf.onmessage).toBe('function')
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  cam3dClientSpy.getCam3dClient.mockClear()
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      // The real handler is async (clipper wasm, dynamic imports). Its response
      // arrives through self.postMessage above, exactly as it does across a real
      // worker boundary.
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
})

afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
  vi.restoreAllMocks()
})

const cuttingMoves = (moves: ToolpathMove[]): ToolpathMove[] =>
  moves.filter((m) => m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw')

describe('INT-17A-R3 C2 (a): a legitimate op really computes, with a modeled body present', () => {
  it('produces a real ToolpathMove[] with real cutting moves', async () => {
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()], makeContourOp('g1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    // The real worker was actually asked to compute - the thing the R2 test
    // could never have shown, because its worker was never asked anything.
    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_CONTOUR')

    expect(currentOp().status).toBe('ready')
    expect(currentOp().errorMessage ?? '').not.toMatch(NAMED_REFUSAL)

    const moves = currentOp().toolpathMoves ?? []
    expect(moves.length).toBeGreaterThan(0)
    expect(cuttingMoves(moves).length).toBeGreaterThan(0)
    // Real geometry, not a fabricated single move: an outside contour of a
    // 40x30 rectangle at 1 mm stepdown to -2 takes many moves.
    expect(moves.length).toBeGreaterThan(5)
    // Every emitted coordinate is finite. Charter rule 3: a NaN compares false
    // in BOTH directions, so it would sail through any tolerance assertion.
    for (const m of moves) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const v = (m as unknown as Record<string, unknown>)[axis]
        if (v !== undefined) expect(Number.isFinite(v as number)).toBe(true)
      }
    }
    // A real runtime estimate came back with it.
    expect(currentOp().estimatedCutTimeMs ?? 0).toBeGreaterThan(0)
  })

  it('computes IDENTICALLY with and without the modeled body in the project', async () => {
    // This is the assertion that distinguishes EXCLUDED from merely tolerated.
    // If the modeled row leaked into the '__all__' aggregate, into resolveTopZ,
    // or into the owning-stock bounds, its 100..200 mm footprint and -50..50 Z
    // extent would move the resolved heights or add loops, and these two move
    // arrays would differ.
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()], makeContourOp('__all__', ['g1']))
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const withModel = currentOp().toolpathMoves ?? []
    const withModelStatus = currentOp().status
    expect(withModel.length).toBeGreaterThan(0)

    installProject([ordinaryGeo('g1', 'Part A')], makeContourOp('__all__', ['g1']))
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const withoutModel = currentOp().toolpathMoves ?? []

    expect(withModelStatus).toBe('ready')
    expect(currentOp().status).toBe('ready')
    expect(withoutModel.length).toBeGreaterThan(0)
    expect(withModel).toEqual(withoutModel)
  })
})

describe('INT-17A-R3 C2 (b): modeled-source routes fail loud before the wrong compute channel', () => {
  // CAM-BINDING Stage 1 (coordination/work-orders/CAM-BINDING.md) reopens the
  // op-picker gate deliberately: a modeled body is now a LEGAL declared source
  // (NewOperationModal's isModelOpSourceEligible-relaxed filters), so the guard
  // catching a direct reference here can no longer mean "the op did something
  // wrong" - it means "no Stage 2 compute path exists yet." The status changes
  // from 'error' to the named 'unsupported'; the zero-compute assertions below
  // are UNCHANGED, because that half of the contract did not move: Stage 1
  // makes the SELECTION legal, not the COMPUTE.
  it('contour_2d referencing the modeled body: named CAM-BINDING Stage 1 pending state, and no compute attempted', async () => {
    // CAM-BINDING Stage 2: contour_2d now HAS a real compute path, but this
    // fixture (hostileModelGeo) carries no modelBody.display (never
    // regenerated), so deriveModelBodyProfile fails BEFORE any worker
    // request is made - the assertions below (zero worker/cam3d activity)
    // are unchanged; only the message got more specific (see
    // modelBodyDerive.camBindingStage2.test.ts for the derive step's own
    // direct unit coverage of this exact failure mode).
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeContourOp('modelbody:F1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    // Not "no moves came back" - no request was ever made. The refusal is
    // upstream of the compute, which is what a boundary guard has to mean.
    expect(workerRequests).toHaveLength(0)
    // INT-17A-R4 C2: the OTHER compute channel too - a 2.5D op never should
    // (and, proven here, never does) reach the cam3d client either.
    expect(cam3dClientSpy.getCam3dClient).not.toHaveBeenCalled()
    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage ?? '').toMatch(/Model F1/)
    expect(currentOp().errorMessage ?? '').toMatch(/profile could not be derived/)
    expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
  })

  it('parallel_3d referencing the modeled body: named CAM-BINDING Stage 1 pending state, and no compute attempted on EITHER channel', async () => {
    // The R2 bypass, at the consumer. This family never touches toolpathWorker
    // at all, so workerRequests alone cannot show its cam3d hand-off was ever
    // blocked - INT-17A-R4 C2 adds the direct assertion: getCam3dClient, the
    // one entry point the parallel_3d branch must call before it can reach a
    // cam3d worker (src/store/index.ts, D-018), was never called either.
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeParallel3dOp('modelbody:F1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(0)
    expect(cam3dClientSpy.getCam3dClient).not.toHaveBeenCalled()
    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage ?? '').toMatch(/Model F1/)
    // WO-1954: parallel_3d now computes a modeled solid, so this hostile body
    // (no display tessellation) gets Adaptive 3D's named refusal, not the old
    // "not yet available" one.
    expect(currentOp().errorMessage ?? '').toMatch(/no tessellated geometry/)
    expect(currentOp().errorMessage ?? '').toMatch(/retry Parallel 3D/)
    expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
  })

  it('adaptive_3d referencing a modeled body with no display fails by name before CAM3D dispatch', async () => {
    // Adaptive 3D now accepts a valid modeled solid. This hostile legacy fixture
    // deliberately has no display tessellation, so the Stage 2 INPUT does not
    // exist yet - a missing PRECONDITION, not broken data. WO-001 (2026-08-06,
    // Architect-ruled after the census/repro contradiction): an ABSENT display
    // lands on the SAME named 'unsupported' refusal contour_2d (this file,
    // above) and parallel_3d produce - the uniform census contract - naming the
    // body AND the specific reason, never the old generic "not supported"
    // refusal and never the orchestrator's generic 'error'. A display that is
    // PRESENT but INVALID (open mesh, degenerate triangles) is corrupt data and
    // stays a loud 'error' - adaptive3dInternalModel.test.ts pins that half.
    // Either way nothing is handed to CAM3D, which is this case's core claim.
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeAdaptive3dOp('modelbody:F1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(0)
    expect(cam3dClientSpy.getCam3dClient).not.toHaveBeenCalled()
    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage ?? '').toMatch(/Model F1/)
    expect(currentOp().errorMessage ?? '').toMatch(/no tessellated geometry/)
    expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
  })

  it('CONTROL: an ordinary op with no modeled body anywhere still computes for real', async () => {
    // Non-vacuity for the refusal cases above: proves the zero-request
    // assertions detect a BLOCKED compute rather than a harness that never
    // dispatches anything.
    installProject([ordinaryGeo('g1', 'Part A')], makeContourOp('g1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    expect(cuttingMoves(currentOp().toolpathMoves ?? []).length).toBeGreaterThan(0)
  })
})
