// WO-1653: posting and running never send code that assumes material an
// unsent operation did not remove.
//
// `stageOperationsForEmission` (store/index.ts) is the one check both Post and
// Control run make at the moment code leaves the app. This file proves it
// through the production compute path (computeOperationToolpath, the real
// toolpathWorker.ts in-process - the same wire earlierMaterialStart.wo1609's
// harness uses) rather than a hand-built engine payload (rule 6):
//
//  - an enabled operation left OUT of the emitted set counts exactly as
//    disabled: its dependent is recomputed against the full stock, then
//    restore() puts everything back exactly as it was (bullet 1);
//  - a predecessor edited without a regenerate is recomputed silently instead
//    of refusing (bullet 2);
//  - a predecessor genuinely disabled is recomputed before its dependent is
//    posted/run, and that recompute is not undone by restore() - it is a real
//    project edit, not this call's own exclusion (bullet 3).
//
// SCENE: the same Face -> Pocket plate WO-1609 built (60 x 40 mm plate, 20 mm
// thick; the pocket starts one step-down below whatever the face left).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

const SETUP_ID = 'setup-1'
const PLATE_TOP = 20
const FACE_DEPTH = 2
const FACE_DEPTH_2 = 4
const POCKET_DEPTH = 10
const STEPDOWN = 3

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function sketchRect(id: string, name: string, x0: number, y0: number, x1: number, y1: number): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: x0, y: y0, z: 0 }, { x: x1, y: y1, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`, closed: true, type: 'contour', layerId: 'L1', area: (x1 - x0) * (y1 - y0),
      points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const POCKET_SKETCH = () => sketchRect('dxf-pocket', 'Pocket sketch', -10, -8, 10, 8)
const FACE_ALL_SKETCH = () => sketchRect('dxf-face', 'Face boundary', -30, -20, 30, 20)

const HOLDER = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 70,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

const FACE_MILL = tool({ id: 'face-mill', name: '10 mm end mill', diameter: 10, shankDiameter: 10 })
const POCKET_MILL = tool({ id: 'pocket-mill', name: '6 mm end mill' })

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -POCKET_DEPTH, bottomHeightMode: 'absolute',
}

function faceOp(depthMm = FACE_DEPTH): Operation {
  const params = {
    boundarySource: 'geometry', geometryId: 'dxf-face', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 2, chipThinning: false, bothSidesPerLevel: false,
    floorStockToLeave: 0, finishPass: false, entryType: 'plunge', leadInRadius: 0,
    leadOutRadius: 0, keepToolDown: false, maxStayDownDistance: 0,
    extendBeforeRetract: false, transition: 'direct', tolerance: 0.05,
  }
  const passes: PassParams = { stepdown: depthMm, stepover: 5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-face', name: 'Face', type: 'face', enabled: true, status: 'pending',
    toolId: FACE_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('face', {
      setupId: SETUP_ID, heights: HEIGHTS, params, stockId: DERIVED_STOCK_ID, explicitDepthMm: depthMm,
    }),
  } as unknown as Operation
}

function pocketOp(): Operation {
  const params = { geometryId: 'dxf-pocket', loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 0, direction: 'climb' }
  const passes: PassParams = { stepdown: STEPDOWN, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-pocket', name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: POCKET_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: ['dxf-pocket'], explicitDepthMm: POCKET_DEPTH,
    }),
  } as unknown as Operation
}

function install(operations: Operation[]): void {
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -30, y: -20, z: 0 }, { x: 30, y: 20, z: PLATE_TOP }),
    position: { x: -30, y: -20, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_ID, name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -30, y: -20, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations, notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 60, fixedHeight: 40, fixedDepth: PLATE_TOP, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [FACE_MILL, POCKET_MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [POCKET_SKETCH(), FACE_ALL_SKETCH()], stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: SETUP_ID, activeOperationId: operations[0].id,
      modelItemPlacements: [],
    } as Project,
  }))
}

// ── The worker wire: real toolpathWorker.ts, in-process (WO-1609's pattern) ─

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Reading the result ───────────────────────────────────────────────────────

const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!

async function generate(opId: string): Promise<void> {
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId)
  expect(opById(opId).status, opById(opId).errorMessage).toBe('ready')
}

/** The Z levels (WCS) the operation cuts at: horizontal feed moves below the plate top. */
function cutLevels(moves: readonly ToolpathMove[]): number[] {
  const levels = new Set<number>()
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid') continue
    if (Math.abs(a.z - b.z) > 1e-6 || Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue
    const wcsZ = b.z - PLATE_TOP
    if (wcsZ < -1e-6) levels.add(Math.round(wcsZ * 1000) / 1000)
  }
  return [...levels].sort((p, q) => q - p)
}

const consoleMessages = () => useCamStore.getState().consoleEvents.map((e) => e.message)
const materialStart = (opId: string) => opById(opId).resolvedHeightPlan?.machining.materialStart.wcsMm

describe('WO-1653: an operation left out of this post/run counts exactly as disabled', () => {
  it('recomputes the dependent against the full stock, then restore() undoes every trace of it', async () => {
    install([faceOp(), pocketOp()])
    await generate('op-face')
    await generate('op-pocket')
    const withFace = opById('op-pocket')
    expect(cutLevels(withFace.toolpathMoves ?? [])).toEqual([-5, -8, -10])
    expect((withFace as unknown as { dependsOnPredecessors?: boolean }).dependsOnPredecessors).toBe(true)

    const { recomputed, restore } = await useCamStore.getState()
      .stageOperationsForEmission(SETUP_ID, ['op-pocket'])

    // While staged: the face is excluded (disabled) and the pocket was
    // recomputed as if it had never run - full stock, byte-identical to the
    // "Face deleted" case WO-1609 pins.
    expect(opById('op-face').enabled).toBe(false)
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
    expect(recomputed.map((r) => r.opId)).toEqual(['op-pocket'])
    expect(recomputed[0].reason).toMatch(/not part of this program/)
    expect(consoleMessages().some((m) => m.includes('Recomputed "Pocket"') && m.includes('not part of this program'))).toBe(true)

    restore()

    // Restored: the face is enabled again and the pocket is back to its
    // ORIGINAL "with face" computed result - nothing was left recomputed or
    // disabled behind the scenes for a project where nothing really changed.
    expect(opById('op-face').enabled).toBe(true)
    expect(opById('op-face').status).toBe('ready')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-5, -8, -10])
    expect(opById('op-pocket').status).toBe('ready')
    expect((opById('op-pocket') as unknown as { dependsOnPredecessors?: boolean }).dependsOnPredecessors).toBe(true)
  })

  it('is a no-op when nothing is excluded (posting/running everything enabled)', async () => {
    install([faceOp(), pocketOp()])
    await generate('op-face')
    await generate('op-pocket')
    const { recomputed, restore } = await useCamStore.getState()
      .stageOperationsForEmission(SETUP_ID, ['op-face', 'op-pocket'])
    expect(recomputed).toEqual([])
    restore()
    expect(opById('op-pocket').status).toBe('ready')
  })
})

describe('WO-1653: a predecessor changed since the last regenerate is recomputed, not refused', () => {
  it('an edited face is recomputed during the post/run and the result matches a fresh regenerate', async () => {
    install([faceOp(), pocketOp()])
    await generate('op-face')
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-5, -8, -10])

    // Edit the face WITHOUT regenerating - the pocket goes outdated in the
    // same moment (the existing predecessor-freshness reconciliation). The
    // Smart Height authority carries the depth (not `passes.stepdown`), so
    // both are rebuilt together the way a real depth-field edit would.
    const editedFace = faceOp(FACE_DEPTH_2)
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', {
      passes: editedFace.passes,
      smartHeight: editedFace.smartHeight,
    })
    expect(opById('op-pocket').status).toBe('outdated')

    const { recomputed, restore } = await useCamStore.getState()
      .stageOperationsForEmission(SETUP_ID, undefined)
    restore() // no exclusion was staged (includedOpIds undefined) - this is a no-op

    expect(recomputed.map((r) => r.opId)).toEqual(['op-face', 'op-pocket'])
    expect(consoleMessages().some((m) => m.includes('Recomputed "Pocket"') && m.includes('out of date'))).toBe(true)

    // The recompute PERSISTS - it is a real edit, not this call's own
    // exclusion, so there is nothing to put back. It reads the NEW face
    // depth (matches a fresh regenerate, WO-1609's own read of "where it
    // starts"), and the floor is unchanged.
    expect(opById('op-pocket').status).toBe('ready')
    expect(materialStart('op-pocket')).toBeCloseTo(-FACE_DEPTH_2, 6)
    const levels = cutLevels(opById('op-pocket').toolpathMoves ?? [])
    expect(levels).not.toEqual([-5, -8, -10])
    expect(levels[levels.length - 1]).toBeCloseTo(-POCKET_DEPTH, 6)
  })

  it('a disabled predecessor is recomputed before its dependent is posted/run, and the recompute stays', async () => {
    install([faceOp(), pocketOp()])
    await generate('op-face')
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-5, -8, -10])

    // A REAL disable (not this call's own exclusion) - already outdates the
    // pocket immediately (WO-1656's mechanism, extended to every family).
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', { enabled: false })
    expect(opById('op-pocket').status).toBe('outdated')

    const { recomputed, restore } = await useCamStore.getState()
      .stageOperationsForEmission(SETUP_ID, undefined)
    restore()

    expect(recomputed.map((r) => r.opId)).toEqual(['op-pocket'])
    expect(opById('op-pocket').status).toBe('ready')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
    // The face stays disabled - that was a real edit this call did not make
    // and restore() (a no-op here) must not undo.
    expect(opById('op-face').enabled).toBe(false)
  })
})
