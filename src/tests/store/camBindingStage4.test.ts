// CAM-BINDING Stage 4 (slicing): the "Section at Z -> pocket" wizard flow
// extended to a modeled body, driven end-to-end through the REAL store
// action (deriveBrepLayer) and the REAL toolpathWorker handler (same harness
// pattern as camBindingStage2Compute.test.ts).
//
// MUTATION-PROOF (mirrors Stage 2's own rule): remove the
// `isModelOriginGeometry(sourceGeo) ? deriveModelBodySection(...) : ...`
// branch in deriveBrepLayer's 'section' kind (src/store/index.ts) and the
// "lands a real layer" test below fails (deriveSection throws for a
// model-origin geo, which has no occt-model shape resident). Remove the
// `persistedSelected.length > 0 ? persistedSelected : deriveModelBodyProfile(...)`
// branch in computeOperationToolpath's model-origin catch and the
// "computes from the SELECTED section, not the whole-body default" test
// below fails (the toolpath would trace the base's 40x30 rect, not the
// section's 20x15 rect).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  ToolpathMove, Vec3, BoundingBox, WCS, HeightParams, PassParams, LinkingParams,
  ModelItemPlacementRecord,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

interface Pt2 { x: number; y: number }
function buildWallMesh(polygons: Pt2[][], z0: number, z1: number): { positions: number[]; indices: number[] } {
  const positions: number[] = []
  const indices: number[] = []
  for (const pts of polygons) {
    const n = pts.length
    const base = positions.length / 3
    for (let i = 0; i < n; i++) {
      positions.push(pts[i].x, pts[i].y, z0)
      positions.push(pts[i].x, pts[i].y, z1)
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const b0 = base + 2 * i, t0 = base + 2 * i + 1
      const b1 = base + 2 * j, t1 = base + 2 * j + 1
      indices.push(b0, b1, t1)
      indices.push(b0, t1, t0)
    }
  }
  return { positions, indices }
}
const rectCW = (w: number, h: number): Pt2[] => [
  { x: -w / 2, y: -h / 2 }, { x: -w / 2, y: h / 2 }, { x: w / 2, y: h / 2 }, { x: w / 2, y: -h / 2 },
]

/** A stepped body: wide 40x30 base (z 0..5), narrower 20x15 top (z 5..10) -
 *  so the whole-body default derive (near-bottom slice) and a Section-at-Z
 *  taken near the TOP are provably DIFFERENT shapes. */
function steppedModelGeo(id: string, name: string): ImportedGeometry {
  const base = buildWallMesh([rectCW(40, 30)], 0, 5)
  const top = buildWallMesh([rectCW(20, 15)], 5, 10)
  const mesh = {
    positions: [...base.positions, ...top.positions],
    indices: [...base.indices, ...top.indices.map((i) => i + base.positions.length / 3)],
  }
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    // Smart Height V2's Contour authority refuses a target whose OWN stock
    // assignment does not match the Setup's proven stock (src/store/index.ts,
    // "belongs to stock '...', not this Setup's stock"). derivedStock() below
    // is that one proven stock.
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [-20, -15, 0], max: [20, 15, 10] },
      },
    },
  } as unknown as ImportedGeometry
}

// EXPLICIT (not 'derived'): Smart Height V2's Contour authority resolves
// machining "start" as the owning stock's OWN top (kind: 'current_material',
// src/lib/cam/smartHeights/resolve.ts), read verbatim via stockWorldBounds
// for an 'explicit' stock - deterministic regardless of which geometry is
// installed, and tall enough to clear the 10mm stepped body below it (see
// absoluteHeights).
function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'explicit',
    bounds: bbox({ x: -22, y: -17, z: 0 }, { x: 22, y: 17, z: 12 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

// clearance/retract/feed are bridged into the Smart Height V2 safety planes
// verbatim as absolute WCS Z (legacyHeightIntentForOperation always emits
// 'wcs_plane') - so they must clear Material Start, which V2 resolves as the
// owning stock's OWN top (derivedStock()'s explicit 12mm bounds above).
const absoluteHeights: HeightParams = {
  clearanceHeight: 22, clearanceHeightMode: 'relative',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
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
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function makeContourOp(geometryId: string, loopIds: string[] = []): Operation {
  const params = { geometryId, loopIds, side: 'outside', direction: 'climb' }
  return {
    id: 'op-1', name: 'Model Op', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: structuredClone(absoluteHeights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights: absoluteHeights, params, geometryIds: [geometryId],
    }),
  } as unknown as Operation
}

function makeAdaptiveOp(geometryId: string, loopIds: string[] = []): Operation {
  const params = {
    geometryId, loopIds, boundarySource: 'geometry',
    targetEngagement: 0.4, maxEngagement: 0.7, stepDistance: 0.4,
    thetaMax: Math.PI / 3, climb: true, rampAngle: 3,
    completionTolerance: 1, helixDiameter: 90, tolerance: 0.05,
    integralWallFollow: true, wallCleanupAsWeGo: false,
    loopbackFilletPct: 25, heightReference: 'absolute',
    planeOffset: absoluteHeights.bottomHeight,
  }
  return {
    ...makeContourOp(geometryId, loopIds),
    name: 'Adaptive Model Op',
    type: 'adaptive_clearing_2d',
    params,
    smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', {
      setupId: 'setup-1', heights: absoluteHeights, params, geometryIds: [geometryId],
    }),
  } as unknown as Operation
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // Smart Height V2's Contour authority proves the Setup's stock through
      // this legacy binding (workOffsets.ts's wcsBoundStockId).
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

function installProject(
  geometry: ImportedGeometry[], op: Operation, modelItemPlacements: ModelItemPlacementRecord[] = [],
): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project, geometry, stocks: [derivedStock()],
      setups: [makeSetup(op)], sceneStock, modelItemPlacements,
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]
const currentGeo = (id: string): ImportedGeometry =>
  useCamStore.getState().project.geometry.find((g) => g.id === id)!

const IDENTITY_LEGACY_PLACEMENT: ModelItemPlacementRecord[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]

// ─── the REAL worker, driven in-process (identical harness to Stage 2's own) ─
let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined
let completeAdaptiveWithoutPlanning = false

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as { self: typeof workerSelf }).self
  expect(typeof workerSelf.onmessage).toBe('function')
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  completeAdaptiveWithoutPlanning = false
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      if (completeAdaptiveWithoutPlanning && data.type === 'COMPUTE_ADAPTIVE_CLEARING') {
        queueMicrotask(() => this.onmessage?.({
          data: {
            type: 'TOOLPATH_COMPLETE',
            opId: data.payload.opId,
            moves: [{ type: 'feed', x: 0, y: 0, z: -1, role: 'cut' }],
            computeTimeMs: 1,
          },
        }))
        return
      }
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
})

afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
})

const isCut = (m: ToolpathMove): boolean => m.type === 'feed' && m.role === 'cut'
function cutXY(moves: ToolpathMove[]): Array<{ x: number; y: number }> {
  return moves.filter(isCut).map((m) => {
    const r = m as unknown as Record<string, number>
    return { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100 }
  })
}
function bbox2d(pts: Array<{ x: number; y: number }>) {
  return {
    w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
    h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)),
  }
}

describe('CAM-BINDING Stage 4: deriveBrepLayer(section) for a model-origin source', () => {
  it('lands a real Layer2D + loops on the geo row, geometrically matching the TOP cross-section (not the base)', async () => {
    installProject([steppedModelGeo('m1', 'Stepped')], makeContourOp('m1'), IDENTITY_LEGACY_PLACEMENT)

    await useCamStore.getState().deriveBrepLayer('m1', 'section', { z: 8 })

    const geo = currentGeo('m1')
    expect(geo.loops?.length ?? 0).toBeGreaterThan(0)
    expect(geo.layers2d?.some((l) => l.derived)).toBe(true)
    const sectionLayer = geo.layers2d?.find((l) => l.derived)
    expect(sectionLayer?.sectionSource?.bodyId).toBe('m1-body')
    expect(sectionLayer?.sectionSource?.geometryFingerprint).toMatch(/^mbf1:/)
    expect(sectionLayer?.sectionStale).not.toBe(true)
    const pts = (geo.loops ?? []).flatMap((l) => l.points)
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 0) // top is 20 wide
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(15, 0) // top is 15 deep
  })

  it('a degenerate Z (above the body) throws and does not land a layer', async () => {
    installProject([steppedModelGeo('m2', 'Stepped')], makeContourOp('m2'), IDENTITY_LEGACY_PLACEMENT)

    await expect(useCamStore.getState().deriveBrepLayer('m2', 'section', { z: 999 })).rejects.toThrow(/outside the body's world Z range/)
    expect(currentGeo('m2').loops ?? []).toHaveLength(0)
  })
})

describe('CAM-BINDING Stage 4: compute uses the SELECTED Section-at-Z snapshot, not the whole-body default', () => {
  it('an op bound to the section-derived loop IDs computes from the TOP cross-section (20x15), not the base (40x30)', async () => {
    installProject([steppedModelGeo('m3', 'Stepped')], makeContourOp('m3'), IDENTITY_LEGACY_PLACEMENT)
    await useCamStore.getState().deriveBrepLayer('m3', 'section', { z: 8 })
    const sectionLoopIds = (currentGeo('m3').loops ?? []).map((l) => l.id)
    expect(sectionLoopIds.length).toBeGreaterThan(0)

    // Bind the op to those specific persisted loop ids (mirrors runBrepDerive's
    // setLoopIds(layerLoopIds) call in the real wizard).
    useCamStore.setState((s) => {
      const op = s.project.setups[0].operations[0]
      const nextOp = { ...op, params: { ...op.params, loopIds: sectionLoopIds } }
      return {
        project: {
          ...s.project,
          setups: [{ ...s.project.setups[0], operations: [nextOp] }],
        } as Project,
      }
    })

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const cuts = cutXY(currentOp().toolpathMoves ?? [])
    expect(cuts.length).toBeGreaterThan(0)
    const box = bbox2d(cuts)
    // The 6mm tool's offset (contour builder insets/offsets by one radius,
    // 3mm, each side here) shifts the cut box off the raw 20x15 loop by a
    // fixed, tool-radius-sized amount either way - the load-bearing proof is
    // that this box is CLOSE TO the 20x15 top section and NOWHERE NEAR a
    // 40x30-base-derived cut (which the regression test below pins at ~34x24).
    expect(box.w).toBeGreaterThan(10)
    expect(box.w).toBeLessThan(20)
    expect(box.h).toBeGreaterThan(6)
    expect(box.h).toBeLessThan(15)
  })

  it('regression: an op with NO loopIds selection still computes the whole-body DEFAULT profile (Stage 2 behavior unchanged), even after another op ran Section-at-Z on the same geo', async () => {
    installProject([steppedModelGeo('m4', 'Stepped')], makeContourOp('m4'), IDENTITY_LEGACY_PLACEMENT)
    // Run a Section-at-Z (as if a DIFFERENT op had used it) - lands persisted
    // loops on the geo row, but THIS op's own loopIds stays empty.
    await useCamStore.getState().deriveBrepLayer('m4', 'section', { z: 8 })
    expect(currentOp().params).toMatchObject({ loopIds: [] })

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const cuts = cutXY(currentOp().toolpathMoves ?? [])
    const box = bbox2d(cuts)
    // Whole-body default derive slices near the BOTTOM (base, 40x30) - a
    // clearly different, much LARGER box than the top section's ~14x9
    // (proven above) - proves the persisted section snapshot did NOT leak
    // into an op that never selected it.
    expect(box.w).toBeGreaterThan(30)
    expect(box.h).toBeGreaterThan(20)
  })

  it('adaptive clearing dispatches the selected top section as its exact worker input', async () => {
    completeAdaptiveWithoutPlanning = true
    installProject(
      [steppedModelGeo('m-ac-section', 'Adaptive Stepped')],
      makeAdaptiveOp('m-ac-section'),
      IDENTITY_LEGACY_PLACEMENT,
    )
    await useCamStore.getState().deriveBrepLayer('m-ac-section', 'section', { z: 8 })
    const sectionLoopIds = (currentGeo('m-ac-section').loops ?? []).map((loop) => loop.id)
    expect(sectionLoopIds.length).toBeGreaterThan(0)

    useCamStore.setState((s) => {
      const op = s.project.setups[0].operations[0]
      return {
        project: {
          ...s.project,
          setups: [{
            ...s.project.setups[0],
            operations: [{ ...op, params: { ...op.params, loopIds: sectionLoopIds } }],
          }],
        } as Project,
      }
    })

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    const request = workerRequests[0]
    expect(request.type).toBe('COMPUTE_ADAPTIVE_CLEARING')
    if (request.type !== 'COMPUTE_ADAPTIVE_CLEARING') {
      throw new Error(`Expected adaptive request, got ${request.type}`)
    }
    const inputPoints = request.payload.loops.flatMap((loop) => loop.points)
    const inputBox = bbox2d(inputPoints)
    expect(inputBox.w).toBeCloseTo(20, 0)
    expect(inputBox.h).toBeCloseTo(15, 0)
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
  })

  it('WO-2713 audit: an adaptive with NO loops picked after a real placement move dispatches the body at its NEW position, never the old section', async () => {
    completeAdaptiveWithoutPlanning = true
    installProject(
      [steppedModelGeo('m-ac-stale', 'Adaptive Stale')],
      makeAdaptiveOp('m-ac-stale'),
      IDENTITY_LEGACY_PLACEMENT,
    )
    await useCamStore.getState().deriveBrepLayer('m-ac-stale', 'section', { z: 8 })
    const sectionLayerIds = new Set((currentGeo('m-ac-stale').loops ?? []).map((loop) => loop.layerId))
    expect(sectionLayerIds.size).toBeGreaterThan(0)

    // The body moves +50 in X after the section was taken, through the real Placement action
    // (which does NOT mark the section stale - the audit's 6:12 PM probe).
    useCamStore.getState().updateModelItemPlacement(
      'legacy', currentGeo('m-ac-stale').modelBody!.ref.bodyId, { x: 50, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    const request = workerRequests[0]
    if (request.type !== 'COMPUTE_ADAPTIVE_CLEARING') {
      throw new Error(`Expected adaptive request, got ${request.type}`)
    }
    const xs = request.payload.loops.flatMap((loop) => loop.points.map((p) => p.x))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(30)
    expect(Math.max(...xs)).toBeLessThanOrEqual(70)
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
  })
})
