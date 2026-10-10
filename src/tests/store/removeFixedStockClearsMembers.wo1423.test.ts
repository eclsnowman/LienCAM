// WO-1423 (Codex audit BUG-467, family K3): removing a FIXED stock left its
// LOCKED member geometry pointing at the deleted stock forever.
//
// repo /// removeFixedStock dropped the removed stock's PhysicalStock and
// legacy FixedStockItem, then called assignStocks directly. It never cleared
// the removed stock's id off any MEMBER geometry first, and
// assignGeometryToStocks skips a `stockIdLocked === true` row verbatim
// (stockAssignment.ts), so a part explicitly locked to the deleted stock kept
// a dangling stockId indefinitely. repointSetupsAfterStockRemoval DID re-point
// the setup's WCS to the catch-all, so setup and geometry then disagreed about
// which stock owned the part - bounds derived to nothing and Post independently
// refused the now-stale operation.
//
// The sibling removeAutoStock already cleared `{ stockId: undefined,
// stockIdLocked: false }` on the removed stock's members before re-sorting.
// removeFixedStock never got the same step. This file drives the REAL store
// action and pins the shared cause.
//
// Acceptance coverage:
//   1. locked imported member is cleared + re-sorts to the catch-all; the bound
//      setup agrees on the same stock (checks below);
//   2. a real production compute pass on an operation sourced from that geometry
//      recomputes against the catch-all, and Post agrees (no OP_OUTDATED);
//   3. undo restores the exact prior stockId/stockIdLocked and stock;
//   4. modeled / imported / automatic / explicitly-unassigned members each
//      verified separately.
//
// The e2e half runs the REAL toolpathWorker handler in-process (same shim shape
// as src/tests/store/int17aR3OpCompute.test.ts) so a passing test proves a real
// ToolpathMove[] came back through the real clipper/builder pipeline.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { postProject } from '../../lib/post/postProject'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  ToolpathMove, Vec3, BoundingBox, WCS, HeightParams, PassParams, LinkingParams,
} from '../../types'

// ─── fixtures ────────────────────────────────────────────────────────────────

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const FIXED_ID = 'fs-1'

/** An imported 2D part (40x30 rectangle) locked to `stockId`. */
function importedGeo(stockId: string, locked = true): ImportedGeometry {
  return {
    id: 'g1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId, stockIdLocked: locked,
    loops: [{
      id: 'g1-loop',
      points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }],
      closed: true, type: 'contour', layerId: 'L1', area: 1200,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** A model-workbench body (format 'model') locked to `stockId`. */
function modelGeo(stockId: string, locked = true): ImportedGeometry {
  return {
    id: 'g1', name: 'Body', filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'legacy',
    stockId, stockIdLocked: locked,
    modelBody: { ref: { bodyId: 'g1-body', stableIds: ['g1-body:F0'], version: 1 } },
  } as unknown as ImportedGeometry
}

function explicitStock(id: string): PhysicalStock {
  return {
    id, name: 'Fixed Block', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function catchAll(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock', mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 42, y: 32, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function cornerBoundWcs(stockId: string): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 100, z: 12 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    stockId,
    originBinding: { kind: 'stock_corner', stockId, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
  } as WCS
}

function sceneStockFixed(): SceneStock {
  return {
    mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [{
      id: FIXED_ID, name: 'Fixed Block', width: 100, height: 100, depth: 12,
      position: { x: 0, y: 0, z: 0 },
    }],
  } as unknown as SceneStock
}

function readyOp(): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 }],
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    params: { geometryId: 'g1', loopIds: [], side: 'outside', direction: 'climb' },
    heights: {
      clearanceHeight: 10, retractHeight: 5, feedHeight: 2,
      topHeight: 0, bottomHeight: -2,
    },
  } as unknown as Operation
}

function makeSetup(op: Operation, wcs: WCS): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'al' },
    operations: [op], notes: '',
  } as unknown as Setup
}

function install(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [],
      stocks: [],
      setups: [],
      activeSetupId: 'setup-1',
      activeOperationId: null,
      sceneStock: sceneStockFixed(),
      ...over,
    },
  }))
}

function proj(): Project { return useCamStore.getState().project }
function geo0(): ImportedGeometry { return proj().geometry[0] }
function setup0(): Setup { return proj().setups[0] }

beforeEach(() => {
  useCamStore.getState().newProject()
})

// =============================================================================
// Acceptance 1 + 4: the locked member is cleared and re-sorts to the catch-all
// =============================================================================

describe('WO-1423: removeFixedStock clears the removed stock off its members', () => {
  it('clears a LOCKED imported member and re-sorts it to the catch-all', () => {
    install({
      geometry: [importedGeo(FIXED_ID, true)],
      stocks: [explicitStock(FIXED_ID), catchAll()],
      setups: [makeSetup(readyOp(), cornerBoundWcs(FIXED_ID))],
    })
    // Precondition: on the pre-fix store this row is untouched (dangling).
    expect(geo0().stockId).toBe(FIXED_ID)
    expect(geo0().stockIdLocked).toBe(true)

    useCamStore.getState().removeFixedStock(FIXED_ID)

    expect(geo0().stockId).not.toBe(FIXED_ID)
    expect(geo0().stockId).toBe(DERIVED_STOCK_ID)
    expect(geo0().stockIdLocked).toBe(false)
    // Geometry and its bound setup agree on the SAME surviving stock.
    expect(setup0().wcs.stockId).toBe(DERIVED_STOCK_ID)
    expect(setup0().wcs.stockId).toBe(geo0().stockId)
    // The removed explicit PhysicalStock is gone from the stock list.
    expect((proj().stocks ?? []).some((st) => st.id === FIXED_ID)).toBe(false)
  })

  it('clears a LOCKED modeled member (never left dangling)', () => {
    install({
      geometry: [modelGeo(FIXED_ID, true)],
      stocks: [explicitStock(FIXED_ID), catchAll()],
      setups: [makeSetup(readyOp(), cornerBoundWcs(FIXED_ID))],
    })
    useCamStore.getState().removeFixedStock(FIXED_ID)
    expect(geo0().stockId).not.toBe(FIXED_ID)
    expect(geo0().stockIdLocked ?? false).not.toBe(true)
  })

  it('re-sorts an AUTOMATIC (unlocked) member to the catch-all', () => {
    install({
      geometry: [importedGeo(FIXED_ID, false)],
      stocks: [explicitStock(FIXED_ID), catchAll()],
      setups: [makeSetup(readyOp(), cornerBoundWcs(FIXED_ID))],
    })
    useCamStore.getState().removeFixedStock(FIXED_ID)
    expect(geo0().stockId).toBe(DERIVED_STOCK_ID)
    expect(geo0().stockIdLocked ?? false).not.toBe(true)
  })

  it('leaves an EXPLICITLY UNASSIGNED member exactly as it was', () => {
    const unassigned = { ...importedGeo(FIXED_ID, true), stockId: undefined, stockIdLocked: true }
    install({
      geometry: [unassigned],
      stocks: [explicitStock(FIXED_ID), catchAll()],
      setups: [makeSetup(readyOp(), cornerBoundWcs(FIXED_ID))],
    })
    useCamStore.getState().removeFixedStock(FIXED_ID)
    // A user who deliberately chose NO stock must keep that sticky state; the
    // removal of an unrelated stock never touches it.
    expect(geo0().stockId).toBeUndefined()
    expect(geo0().stockIdLocked).toBe(true)
  })

  it('stays unassigned when there is no catch-all to fall back to', () => {
    install({
      geometry: [importedGeo(FIXED_ID, true)],
      stocks: [explicitStock(FIXED_ID)],
      setups: [makeSetup(readyOp(), cornerBoundWcs(FIXED_ID))],
    })
    useCamStore.getState().removeFixedStock(FIXED_ID)
    expect(geo0().stockId).toBeUndefined()
    expect(geo0().stockIdLocked).toBe(false)
    // Setup re-points or unbinds, but never dangles on the deleted id.
    expect(setup0().wcs.stockId).not.toBe(FIXED_ID)
  })

  it('leaves a member of a DIFFERENT stock untouched', () => {
    install({
      geometry: [importedGeo('other-stock', true)],
      stocks: [explicitStock(FIXED_ID), explicitStock('other-stock'), catchAll()],
      setups: [makeSetup(readyOp(), cornerBoundWcs('other-stock'))],
    })
    useCamStore.getState().removeFixedStock(FIXED_ID)
    expect(geo0().stockId).toBe('other-stock')
    expect(geo0().stockIdLocked).toBe(true)
    expect(setup0().wcs.stockId).toBe('other-stock')
  })

  // ===========================================================================
  // Acceptance 3: undo restores the exact prior membership and lock state
  // ===========================================================================

  it('undo restores the exact prior stockId/stockIdLocked and stock', () => {
    install({
      geometry: [importedGeo(FIXED_ID, true)],
      stocks: [explicitStock(FIXED_ID), catchAll()],
      setups: [makeSetup(readyOp(), cornerBoundWcs(FIXED_ID))],
    })
    useCamStore.getState().removeFixedStock(FIXED_ID)
    expect(geo0().stockId).toBe(DERIVED_STOCK_ID)

    useCamStore.getState().undo()

    expect(geo0().stockId).toBe(FIXED_ID)
    expect(geo0().stockIdLocked).toBe(true)
    // The fixed stock itself comes back.
    expect((proj().stocks ?? []).some((st) => st.id === FIXED_ID)).toBe(true)
    expect(proj().sceneStock.fixedStocks?.some((fs) => fs.id === FIXED_ID)).toBe(true)
    expect(setup0().wcs.stockId).toBe(FIXED_ID)
  })
})

// =============================================================================
// Acceptance 2: a real compute pass recomputes against the catch-all, and Post
// agrees (the pre-fix disagreement: compute ready w/ cached moves, Post
// OP_OUTDATED).
// =============================================================================

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

const tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, toolNumber: 1,
} as Tool

function contourOp(): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId: 'g1', loopIds: [], side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, geometryIds: ['g1'],
    }),
  } as unknown as Operation
}

function installE2E(): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      toolLibrary: [tool],
      geometry: [importedGeo(FIXED_ID, true)],
      stocks: [explicitStock(FIXED_ID), catchAll()],
      setups: [makeSetup(contourOp(), cornerBoundWcs(FIXED_ID))],
      sceneStock: sceneStockFixed(),
    } as Project,
  }))
}

let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
} | null = null
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as { self: typeof workerSelf }).self
  expect(typeof workerSelf!.onmessage).toBe('function')
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf!.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
})

afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
  vi.restoreAllMocks()
})

const postOpts = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

describe('WO-1423: compute recomputes against the catch-all and Post agrees', () => {
  it('real compute pass + Post after removeFixedStock agree on the same stock', async () => {
    installE2E()
    // Compute while the part is locked to the fixed stock.
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_CONTOUR')
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready')

    // Remove the fixed stock the part (and setup) were bound to.
    useCamStore.getState().removeFixedStock(FIXED_ID)

    // The member and its setup now agree on the catch-all - never the deleted id.
    expect(geo0().stockId).toBe(DERIVED_STOCK_ID)
    expect(geo0().stockIdLocked).toBe(false)
    expect(setup0().wcs.stockId).toBe(DERIVED_STOCK_ID)

    // A real compute/generate pass against the stock it now belongs to.
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(workerRequests).toHaveLength(2)
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    const cutting = (op.toolpathMoves ?? []).filter(
      (m: ToolpathMove) => m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw',
    )
    expect(cutting.length).toBeGreaterThan(0)

    // Post reads the SAME current operation state; it must not independently
    // refuse (the pre-fix audit signature was compute-ready vs Post
    // OP_OUTDATED because the geometry still pointed at the deleted stock).
    const setup = useCamStore.getState().project.setups[0]
    expect(operationGenerationIsCurrent(useCamStore.getState().project, setup, op)).toBe(true)
    const input = buildPostInput(useCamStore.getState().project, setup)
    expect(input.setup.operations[0].op.status).toBe('ready')
    const res = postProject(useCamStore.getState().project, [setup], UCCNC_CONFIG, postOpts)
    expect(res.diagnostics.some((d) => d.code === 'OP_OUTDATED')).toBe(false)
    expect(res.ok, JSON.stringify(res.diagnostics)).toBe(true)
  })
})
