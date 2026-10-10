// CAM-BINDING Stage 5 (face boundaries) - the charter's own acceptance test,
// end to end through REAL store actions: pick a face on a modeled body as a
// machining boundary (setOperationMachiningBoundaryFace) -> it really
// computes (real worker) -> a parametric model change re-resolves the
// reference (reresolveModelReferences, the SAME CAM-1 machinery
// verify-modelref-badges.mjs already proved, driven here for real through a
// picked-face op instead of a hand-injected one) -> the op's badge goes
// amber (stale) or red (degraded), retaining its last-known toolpath on
// degrade and NEVER silently recomputing while degraded.
//
// Mirrors camBindingStage2Compute.test.ts's own harness (real toolpathWorker
// shimmed in-process) and modelBodyDeriveFace.camBindingStage5.test.ts's own
// two-face mesh fixture (mergeFaces: distinct faceIds tagging distinct
// triangle subsets), so a pick that resolves to the WRONG face would produce
// a detectably different toolpath extent.

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
import type { BodyResolution } from '../../lib/cam/modelReferenceResolution'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// ─── two-face box mesh: a 40x30 TOP face ("F_top") over a SMALLER 10x8
//     BOTTOM face ("F_bottom"), so picking one vs. the other vs. the
//     whole-body default is detectably distinct by cut-path extent. ──────
interface Pt2 { x: number; y: number }
function rectCW(w: number, h: number, cx = 0, cy = 0): Pt2[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 }, { x: cx - w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy + h / 2 }, { x: cx + w / 2, y: cy - h / 2 },
  ]
}
function rectCapMesh(w: number, h: number, z: number): { positions: number[]; indices: number[] } {
  const pts = rectCW(w, h)
  return { positions: pts.flatMap((p) => [p.x, p.y, z]), indices: [0, 1, 2, 0, 2, 3] }
}
function mergeFaces(
  parts: Array<{ positions: number[]; indices: number[] }>, faceIds: string[],
): { positions: number[]; indices: number[]; triFace: number[]; faceIds: string[] } {
  const positions: number[] = []; const indices: number[] = []; const triFace: number[] = []
  for (let f = 0; f < parts.length; f++) {
    const base = positions.length / 3
    positions.push(...parts[f].positions)
    for (const idx of parts[f].indices) indices.push(idx + base)
    for (let t = 0; t < parts[f].indices.length / 3; t++) triFace.push(f)
  }
  return { positions, indices, triFace, faceIds }
}

const TOP_W = 40, TOP_H = 30, BOTTOM_W = 10, BOTTOM_H = 8
function twoFaceModelGeo(id: string, name: string): ImportedGeometry {
  const top = rectCapMesh(TOP_W, TOP_H, 10)
  const bottom = rectCapMesh(BOTTOM_W, BOTTOM_H, 0)
  const mesh = mergeFaces([bottom, top], ['F_bottom', 'F_top'])
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: mesh.faceIds, version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [-20, -15, 0], max: [20, 15, 10] },
        faceIds: mesh.faceIds, triFace: mesh.triFace,
      },
    },
  } as unknown as ImportedGeometry
}

function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: -22, y: -17, z: 0 }, { x: 22, y: 17, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}
const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock
const absoluteHeights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 1, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}
const tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function makeOp(geometryId: string): Operation {
  const heights = structuredClone(absoluteHeights)
  const params = { geometryId, loopIds: [], side: 'outside', direction: 'climb' }
  return {
    id: 'op-1', name: 'Boundary Op', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights,
    // Smart Height V2 is the only runtime authority (2e5678b7); stamp a
    // valid envelope so dispatch reaches the picked-face boundary machinery
    // under test instead of being refused earlier for want of authority
    // (ADR-0040). 'through_stock' resolves Material Start from the picked
    // face's own composed evidence (well above absoluteHeights' raw
    // retract/feed 5/1), so give the safety planes generous headroom - the
    // point of these tests is the FACE PICK driving compute, not this
    // unrelated ordering guard.
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      heights: { ...heights, clearanceHeight: 100, retractHeight: 60, feedHeight: 50 },
      params, geometryIds: [geometryId],
    }),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params,
  } as unknown as Operation
}
function makeAdaptiveOp(geometryId: string): Operation {
  const params = {
    geometryId, loopIds: [], boundarySource: 'geometry',
    targetEngagement: 0.4, maxEngagement: 0.7, stepDistance: 0.4,
    thetaMax: Math.PI / 3, climb: true, rampAngle: 3,
    completionTolerance: 1, helixDiameter: 90, tolerance: 0.05,
    integralWallFollow: true, wallCleanupAsWeGo: false,
    loopbackFilletPct: 25, heightReference: 'absolute',
    planeOffset: absoluteHeights.bottomHeight,
  }
  const base = makeOp(geometryId)
  return {
    ...base,
    name: 'Adaptive Boundary Op',
    type: 'adaptive_clearing_2d',
    smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', {
      heights: { ...base.heights, clearanceHeight: 100, retractHeight: 60, feedHeight: 50 },
      params, geometryIds: [geometryId],
    }),
    params,
  } as unknown as Operation
}
function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // setupProvenStockId needs the WCS bound to a stock before Smart
      // Height V2 can prove a Setup stock at all (mirrors camDrillFix1
      // .modelHeights.test.ts's identical fixture repair).
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}
const IDENTITY_LEGACY_PLACEMENT: ModelItemPlacementRecord[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]
function installProject(geometry: ImportedGeometry[], op: Operation): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    lastModelReresolveSeq: 0,
    modelRefsVerifiedSinceLoad: true,
    project: {
      ...s.project, geometry, stocks: [derivedStock()],
      setups: [makeSetup(op)], sceneStock, modelItemPlacements: IDENTITY_LEGACY_PLACEMENT,
    } as Project,
  }))
}
const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

// ─── real worker harness (identical to camBindingStage2Compute.test.ts) ────
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
afterAll(() => { delete (globalThis as { self?: unknown }).self })
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
afterEach(() => { ;(globalThis as { Worker?: unknown }).Worker = OrigWorker })

const cuttingMoves = (moves: ToolpathMove[]): ToolpathMove[] =>
  moves.filter((m) => m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw')
function cutBBox(moves: ToolpathMove[]) {
  const pts = cuttingMoves(moves).map((m) => m as unknown as Record<string, number>)
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  }
}

describe('CAM-BINDING Stage 5: setOperationMachiningBoundaryFace', () => {
  it('picking "F_top" stores a machining-boundary ModelReference and resets the op to pending', () => {
    installProject([twoFaceModelGeo('mb1', 'Box')], makeOp('mb1'))
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_top')
    const op = currentOp()
    expect(op.modelReferences).toEqual([{ bodyId: 'mb1-body', stableIds: ['F_top'], role: 'machining-boundary' }])
    expect(op.status).toBe('pending')
  })

  it('picking a face on a NON-model source throws and writes nothing (fail loud at pick time)', () => {
    const ordinary = {
      id: 'g1', name: 'DXF', filename: 'g1.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    } as unknown as ImportedGeometry
    installProject([ordinary], makeOp('g1'))
    expect(() => useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_top'))
      .toThrow(/not a modeled body/)
    expect(currentOp().modelReferences).toBeUndefined()
  })

  it('picking an unknown face id throws (deriveModelBodyFace\'s own refusal) and writes nothing', () => {
    installProject([twoFaceModelGeo('mb2', 'Box')], makeOp('mb2'))
    expect(() => useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_ghost'))
      .toThrow(/no longer exists/)
    expect(currentOp().modelReferences).toBeUndefined()
  })

  it('faceStableId: null clears an existing machining-boundary reference', () => {
    installProject([twoFaceModelGeo('mb3', 'Box')], makeOp('mb3'))
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_top')
    expect(currentOp().modelReferences).toBeDefined()
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', null)
    expect(currentOp().modelReferences).toBeUndefined()
  })
})

describe('CAM-BINDING Stage 5: a picked face really computes, scoped to THAT face', () => {
  it('picking "F_top" (40x30) produces a cut bbox matching the TOP face, not the smaller bottom face or a whole-body default', async () => {
    installProject([twoFaceModelGeo('mb4', 'Box')], makeOp('mb4'))
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_top')

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const bb = cutBBox(currentOp().toolpathMoves ?? [])
    // Cut extent is CLOSE to the 40x30 face (a tool-radius offset either
    // direction, not asserted exactly - the offset math itself is proven
    // elsewhere; this test's own job is proving the PICK, not the tool
    // geometry, drives compute) - well outside the 10x8 bottom face's range.
    expect(bb.maxX - bb.minX).toBeGreaterThan(TOP_W - 10)
    expect(bb.maxY - bb.minY).toBeGreaterThan(TOP_H - 10)
  })

  it('picking "F_bottom" (10x8) instead produces a MUCH smaller cut bbox - proves the pick, not the whole body, drives compute', async () => {
    installProject([twoFaceModelGeo('mb5', 'Box')], makeOp('mb5'))
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_bottom')

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const bb = cutBBox(currentOp().toolpathMoves ?? [])
    expect(bb.maxX - bb.minX).toBeLessThan(TOP_W - 5) // well under the top face's own extent
    expect(bb.maxY - bb.minY).toBeLessThan(TOP_H - 5)
  })

  it('adaptive clearing re-derives its durable picked-face boundary into the adaptive worker request', async () => {
    completeAdaptiveWithoutPlanning = true
    installProject([twoFaceModelGeo('mb-ac-face', 'Adaptive Box')], makeAdaptiveOp('mb-ac-face'))
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_top')

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_ADAPTIVE_CLEARING')
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    expect(cuttingMoves(currentOp().toolpathMoves ?? []).length).toBeGreaterThan(0)
  })
})

describe('CAM-BINDING Stage 5: the CAM-1 badge machinery, driven end-to-end through a REAL picked-face op', () => {
  async function readyOpWithBoundary(geoId: string) {
    installProject([twoFaceModelGeo(geoId, 'Box')], makeOp(geoId))
    useCamStore.getState().setOperationMachiningBoundaryFace('setup-1', 'op-1', 'F_top')
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(currentOp().status).toBe('ready')
    expect((currentOp().toolpathMoves ?? []).length).toBeGreaterThan(0)
  }

  it('exact resolution leaves a ready op untouched', async () => {
    await readyOpWithBoundary('mb6')
    const before = currentOp()
    const bodies: BodyResolution[] = [{ bodyId: 'mb6-body', changed: false, resolutions: [{ id: 'F_top', status: 'exact' }] }]
    useCamStore.getState().reresolveModelReferences(bodies)
    expect(currentOp()).toBe(before) // byte-identical reference, nothing changed
    expect(currentOp().status).toBe('ready')
  })

  it('fallback resolution flips a ready op to "outdated" (amber) and RETAINS its pre-edit toolpath - S5 audit DEFECT 1 ruling 2026-07-22', async () => {
    await readyOpWithBoundary('mb7')
    const retainedMoves = currentOp().toolpathMoves
    const bodies: BodyResolution[] = [{ bodyId: 'mb7-body', changed: true, resolutions: [{ id: 'F_top', status: 'fallback' }] }]
    useCamStore.getState().reresolveModelReferences(bodies)
    expect(currentOp().status).toBe('outdated')
    expect(currentOp().toolpathMoves).toBe(retainedMoves) // SAME reference - retained, not cleared
    expect(currentOp().modelReferenceNote ?? '').toMatch(/re-bound approximately/)
  })

  it('body-changed-but-exact resolution ALSO flips a ready op to "outdated" and RETAINS its pre-edit toolpath (parametric resize, per the charter\'s own acceptance test + S5 audit DEFECT 1 ruling 2026-07-22)', async () => {
    await readyOpWithBoundary('mb8')
    const retainedMoves = currentOp().toolpathMoves
    const bodies: BodyResolution[] = [{ bodyId: 'mb8-body', changed: true, resolutions: [{ id: 'F_top', status: 'exact' }] }]
    useCamStore.getState().reresolveModelReferences(bodies)
    expect(currentOp().status).toBe('outdated')
    expect(currentOp().toolpathMoves).toBe(retainedMoves) // SAME reference - retained, not cleared
  })

  it('lost resolution (feature deleted) flips a ready op to "degraded" (red) and RETAINS its last-known toolpath - never silently recomputes', async () => {
    await readyOpWithBoundary('mb9')
    const retainedMoves = currentOp().toolpathMoves
    const bodies: BodyResolution[] = [{ bodyId: 'mb9-body', changed: true, resolutions: [{ id: 'F_top', status: 'lost' }] }]
    useCamStore.getState().reresolveModelReferences(bodies)
    expect(currentOp().status).toBe('degraded')
    expect(currentOp().toolpathMoves).toBe(retainedMoves) // SAME reference - retained, not recomputed
    expect(currentOp().modelReferenceNote ?? '').toMatch(/removed/)

    // NEVER SILENTLY RECOMPUTES: a compute attempt on a degraded op is a
    // pre-existing CAM-1 guard (computeOperationToolpath's own top-of-body
    // check) - exercised here for real against a Stage-5 picked-face op.
    const before = workerRequests.length
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(workerRequests.length).toBe(before) // no new worker request issued
    expect(currentOp().status).toBe('degraded')
    expect(currentOp().toolpathMoves).toBe(retainedMoves)
  })

  it('an unknown resolver status is refused loud (fail-closed), not silently accepted', async () => {
    await readyOpWithBoundary('mb10')
    const bodies = [{ bodyId: 'mb10-body', changed: true, resolutions: [{ id: 'F_top', status: 'bogus' }] }] as unknown as BodyResolution[]
    expect(() => useCamStore.getState().reresolveModelReferences(bodies)).toThrow(/unknown resolver status/)
    // Refused BEFORE any mutation - op stays exactly as it was.
    expect(currentOp().status).toBe('ready')
  })
})

describe('CAM-BINDING Stage 5: load-boundary rehydration flag', () => {
  it('reresolveModelReferences flips modelRefsVerifiedSinceLoad true even when the flag started false', () => {
    installProject([twoFaceModelGeo('mb11', 'Box')], makeOp('mb11'))
    useCamStore.setState({ modelRefsVerifiedSinceLoad: false })
    const bodies: BodyResolution[] = [{ bodyId: 'mb11-body', changed: false, resolutions: [{ id: 'F_top', status: 'exact' }] }]
    useCamStore.getState().reresolveModelReferences(bodies)
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toBe(true)
  })

  it('a fresh project (newProject) never needs verification - loadProjectFromFile is the only setter of false', () => {
    installProject([twoFaceModelGeo('mb12', 'Box')], makeOp('mb12'))
    expect(useCamStore.getState().modelRefsVerifiedSinceLoad).toBe(true)
  })
})
