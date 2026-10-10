// WO-1410 (BUG-453, BUG-458): an edited body's own operations must not refuse
// it as a stranger.
//
// A feature edit (resize a hole, push/pull) publishes the SAME part under a new
// leaf body id: F1 -> F2, IMP1 -> F1. The compute guards used to compare the
// saved reference's bodyId string to the source's CURRENT bodyId and refuse
// "another item or body" on any difference - before the subshape resolvers
// (hole recognition, deriveModelBodyEdges' exact/migrated/ambiguous/lost) could
// look at what actually changed.
//
// These tests drive the REAL store action (computeOperationToolpath) with the
// REAL in-process toolpathWorker (same harness as staleSectionComputeGuard
// .wo1401.test.ts). The re-derive itself goes through the production writer,
// syncModelBodies, with the same live/derived lineage payload the workbench
// publishes. The cross-item and cross-lineage refusals are pinned unchanged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import {
  MODEL_EDGE_CHAIN_ROLE, modelReferenceMatchesSource, modelReferenceSourceIdentity,
} from '../../store/modelEdgeChainBinding'
import { setModelBodyHoleRecognizer } from '../../lib/cam/modelBodyHoleRecognition'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { FeatureDag } from '../../doc/dag'
import { createDocumentArchive } from '../../doc/persist'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { ModelReference, WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, ModelBodyDisplay, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  Vec3, BoundingBox, WCS, HeightParams, PassParams, LinkingParams, ModelItemPlacementRecord,
} from '../../types'

const SAME_BODY_REFUSAL = /Refusing to resolve a reference against another item or body/
const EDGE_CHAIN_MISMATCH = /picked edge chain was taken from a different body/

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

interface Pt2 { x: number; y: number }
const HALF_W = 20
const HALF_H = 15
const TOP_Z = 10
const corners = (): Pt2[] => [
  { x: -HALF_W, y: -HALF_H }, { x: HALF_W, y: -HALF_H }, { x: HALF_W, y: HALF_H }, { x: -HALF_W, y: HALF_H },
]
/** The top rim of the block: four edges, ids minted from face pairs the way
 *  the kernel does ("(A^B)"), so a re-derive that keeps the faces keeps them. */
const RIM_EDGE_IDS = ['(F0:top^F0:s0)', '(F0:top^F0:s1)', '(F0:top^F0:s2)', '(F0:top^F0:s3)']

/** A 40x30x10 block: wall triangles + the four top-rim edge polylines. */
function blockDisplay(): ModelBodyDisplay {
  const pts = corners()
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < 4; i++) {
    positions.push(pts[i].x, pts[i].y, 0, pts[i].x, pts[i].y, TOP_Z)
  }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1
    indices.push(b0, b1, t1, b0, t1, t0)
  }
  const edgePositions: number[] = []
  const edgeOffsets: number[] = [0]
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4]
    edgePositions.push(a.x, a.y, TOP_Z, b.x, b.y, TOP_Z)
    edgeOffsets.push(edgeOffsets[edgeOffsets.length - 1] + 2)
  }
  return {
    positions, normals: [], indices, edgePositions, edgeOffsets,
    bbox: { min: [-HALF_W, -HALF_H, 0], max: [HALF_W, HALF_H, TOP_Z] },
    edgeIds: [...RIM_EDGE_IDS],
  } as unknown as ModelBodyDisplay
}

function modelRow(
  id: string, bodyId: string, lineageId: string, modelItemId: string | undefined = undefined,
): ImportedGeometry {
  return {
    id, name: `Block ${bodyId}`, filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -HALF_W, y: -HALF_H, z: 0 }, { x: HALF_W, y: HALF_H, z: TOP_Z }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    ...(modelItemId !== undefined ? { modelItemId } : {}),
    modelBody: {
      ref: { bodyId, lineageId, stableIds: [`${bodyId}:F0`], version: 1 },
      display: blockDisplay(),
    },
  } as unknown as ImportedGeometry
}

function stock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -22, y: -17, z: 0 }, { x: 22, y: 17, z: 12 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

const heights: HeightParams = {
  clearanceHeight: 22, clearanceHeightMode: 'relative',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 1, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}
const tools = [
  {
    id: 'em6', name: 'EM6', type: 'flat_end_mill', diameter: 6,
    fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  },
  {
    id: 'drill6', name: 'D6', type: 'drill', diameter: 6,
    fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  },
] as Tool[]

function drillOp(geometryId: string, refs: ModelReference[]): Operation {
  const params = {
    geometryId, loopIds: [], cycleType: 'simple', peckDepth: 2,
    chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
  }
  return {
    id: 'op-1', name: 'Drill holes', type: 'drill', enabled: true, status: 'pending',
    toolId: 'drill6', geometrySelections: [], modelReferences: refs,
    heights: structuredClone(heights), passes: structuredClone(passes), linking: structuredClone(linking),
    params,
    smartHeight: smartHeightAuthorityFixture('drill', {
      setupId: 'setup-1', heights, params, geometryIds: [geometryId],
    }),
  } as unknown as Operation
}

function contourOp(geometryId: string, refs: ModelReference[]): Operation {
  const params = { geometryId, loopIds: [], side: 'outside', direction: 'climb' }
  return {
    id: 'op-1', name: 'Rim contour', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'em6', geometrySelections: [], modelReferences: refs,
    heights: structuredClone(heights), passes: structuredClone(passes), linking: structuredClone(linking),
    params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, params, geometryIds: [geometryId],
    }),
  } as unknown as Operation
}

function installProject(geometry: ImportedGeometry[], op: Operation, itemIds: string[] = ['legacy']): void {
  const modelItemPlacements: ModelItemPlacementRecord[] = itemIds.map((modelItemId) => ({
    modelItemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  }))
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
  useCamStore.setState((s) => ({
    toolLibrary: tools,
    consoleEvents: [], consoleReadThroughId: 0,
    project: {
      ...s.project, geometry, stocks: [stock()],
      setups: [setup], activeSetupId: 'setup-1', sceneStock, modelItemPlacements,
      modelItems: itemIds.filter((id) => id !== 'legacy').map((id) => ({ id, name: id })),
    } as unknown as Project,
  }))
}

/** The workbench publishing a feature edit: the same lineage, a new leaf id. */
function publishEdit(bodyId: string, lineageId: string, modelItemId?: string): void {
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId, lineageId, name: `Block ${bodyId}` }],
    derived: [{
      bodyId, lineageId, version: 2, stableIds: [`${bodyId}:F0`], display: blockDisplay(),
    }],
    ...(modelItemId !== undefined ? { modelItemId } : {}),
  })
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

function holeVerdict(): FeatureVerdict {
  return {
    featureKey: 'hole:0:0:10:0:0:1:3', featureClass: 'throughHole',
    removable: true, effect: 'add', faceIds: ['F0:hole-wall'], neighbourIds: [],
    params: { diameter: 6, depth: 10, axisX: 0, axisY: 0, axisZ: 1, centerX: 0, centerY: 0, centerZ: 10 },
  } as FeatureVerdict
}

// ─── the REAL worker, driven in-process ───────────────────────────────────────
let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined
let recognizedBodyIds: string[] = []

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
  resetDocumentHolder()
  workerRequests = []
  recognizedBodyIds = []
  activeShim = null
  setModelBodyHoleRecognizer(async (bodyId) => {
    recognizedBodyIds.push(bodyId)
    return [holeVerdict()]
  })
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
})

afterEach(() => {
  setModelBodyHoleRecognizer(null)
  resetDocumentHolder()
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
})

async function compute(): Promise<Operation> {
  await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
  return currentOp()
}

describe('WO-1410 #1 drill targets follow the same part across a resize (BUG-453)', () => {
  it('bound on F1, the resize re-derives the body as F2 -> resolves against the current body, never "another body"', async () => {
    installProject(
      [modelRow('mb', 'F1', 'F1')],
      drillOp('mb', [{ bodyId: 'F1', stableIds: ['F0:hole-wall'], role: 'drill-targets' }]),
    )
    publishEdit('F2', 'F1')
    const row = useCamStore.getState().project.geometry.find((g) => g.id === 'mb')!
    expect(row.modelBody!.ref).toMatchObject({ bodyId: 'F2', lineageId: 'F1' })

    const op = await compute()
    expect(op.errorMessage ?? '').not.toMatch(SAME_BODY_REFUSAL)
    // The resolver ran - hole recognition against the CURRENT leaf.
    expect(recognizedBodyIds).toEqual(['F2'])
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    expect(workerRequests.length).toBeGreaterThan(0)
  })

  it('bound on an intermediate leaf F1 of lineage F0, a second edit publishes F2 -> the item document names the lineage', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F0', kind: 'feature', payload: { opType: 'extrude', height: 10 } })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['F0'], payload: { opType: 'resizeHole' } })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], payload: { opType: 'resizeHole' } })
    stashLoadedDocument(createDocumentArchive({ dag, elementMapDeltas: [] }))

    installProject(
      [modelRow('mb', 'F1', 'F0')],
      drillOp('mb', [{ bodyId: 'F1', stableIds: ['F0:hole-wall'], role: 'drill-targets' }]),
    )
    publishEdit('F2', 'F0')

    const op = await compute()
    expect(op.errorMessage ?? '').not.toMatch(SAME_BODY_REFUSAL)
    expect(recognizedBodyIds).toEqual(['F2'])
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
  })
})

describe('WO-1410 #2 an edge chain follows the same part across a resize (BUG-458)', () => {
  it('picked on IMP1, the body re-derives as F1 -> the chain resolves through deriveModelBodyEdges and computes', async () => {
    installProject(
      [modelRow('mb', 'IMP1', 'IMP1')],
      contourOp('mb', [{ bodyId: 'IMP1', stableIds: [...RIM_EDGE_IDS], role: MODEL_EDGE_CHAIN_ROLE }]),
    )
    publishEdit('F1', 'IMP1')

    const op = await compute()
    expect(op.errorMessage ?? '').not.toMatch(EDGE_CHAIN_MISMATCH)
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    expect(workerRequests.length).toBeGreaterThan(0)
  })

  it('a picked edge that is gone after the edit still refuses BY NAME (lost), never a guess', async () => {
    installProject(
      [modelRow('mb', 'IMP1', 'IMP1')],
      contourOp('mb', [{ bodyId: 'IMP1', stableIds: ['(F0:gone^F0:s9)'], role: MODEL_EDGE_CHAIN_ROLE }]),
    )
    publishEdit('F1', 'IMP1')

    const op = await compute()
    expect(op.status).toBe('unsupported')
    expect(op.errorMessage).not.toMatch(EDGE_CHAIN_MISMATCH)
    expect(op.errorMessage).toMatch(/no longer exists/)
    expect(workerRequests).toHaveLength(0)
  })
})

describe('WO-1410 #3 a raw F1 in ANOTHER Model Item is still refused', () => {
  it('reference on item-a F1, source is item-b F1 (compound-id collision) -> the existing refusal', async () => {
    installProject(
      [modelRow('mb-a', 'F1', 'F1', 'item-a'), modelRow('mb-b', 'F1', 'F1', 'item-b')],
      drillOp('mb-b', [{ modelItemId: 'item-a', bodyId: 'F1', stableIds: ['F0:hole-wall'], role: 'drill-targets' }]),
      ['item-a', 'item-b'],
    )

    const op = await compute()
    expect(op.status).toBe('unsupported')
    expect(op.errorMessage).toContain(
      'its drill targets belongs to body "F1" in Model Item "item-a", but its source "Block F1" is body "F1" ' +
        'in Model Item "item-b". Refusing to resolve a reference against another item or body.',
    )
    expect(recognizedBodyIds).toEqual([])
    expect(workerRequests).toHaveLength(0)
  })

  it('an edge chain from item-a stays refused against item-b even when item-b\'s lineage root has the same raw id', async () => {
    installProject(
      [modelRow('mb-a', 'IMP1', 'IMP1', 'item-a'), modelRow('mb-b', 'F1', 'IMP1', 'item-b')],
      contourOp('mb-b', [{
        modelItemId: 'item-a', bodyId: 'IMP1', stableIds: [...RIM_EDGE_IDS], role: MODEL_EDGE_CHAIN_ROLE,
      }]),
      ['item-a', 'item-b'],
    )

    const op = await compute()
    expect(op.status).toBe('unsupported')
    expect(op.errorMessage).toMatch(EDGE_CHAIN_MISMATCH)
    expect(workerRequests).toHaveLength(0)
  })
})

describe('WO-1410 #4 a genuinely different body is still refused', () => {
  it('the operator switched the source to another body in the same item -> the existing mismatch message', async () => {
    installProject(
      [modelRow('mb-part', 'F2', 'F1'), modelRow('mb-other', 'G1', 'G1')],
      drillOp('mb-other', [{ bodyId: 'F1', stableIds: ['F0:hole-wall'], role: 'drill-targets' }]),
    )

    const op = await compute()
    expect(op.status).toBe('unsupported')
    expect(op.errorMessage).toContain(
      'its drill targets belongs to body "F1" in Model Item "legacy", but its source "Block G1" is body "G1" ' +
        'in Model Item "legacy". Refusing to resolve a reference against another item or body.',
    )
    expect(recognizedBodyIds).toEqual([])
    expect(workerRequests).toHaveLength(0)
  })

  it('an edge chain picked on another lineage stays refused with the existing message', async () => {
    installProject(
      [modelRow('mb-part', 'F1', 'IMP1'), modelRow('mb-other', 'G1', 'G1')],
      contourOp('mb-other', [{ bodyId: 'IMP1', stableIds: [...RIM_EDGE_IDS], role: MODEL_EDGE_CHAIN_ROLE }]),
    )

    const op = await compute()
    expect(op.status).toBe('unsupported')
    expect(op.errorMessage).toMatch(EDGE_CHAIN_MISMATCH)
    expect(workerRequests).toHaveLength(0)
  })
})

describe('WO-1410 the lineage identity withholds every guess', () => {
  it('two live rows claiming one lineage -> exact ids only', () => {
    const a = modelRow('a', 'F2', 'F1')
    const b = modelRow('b', 'F3', 'F1')
    const identity = modelReferenceSourceIdentity(a, 'legacy', [a, b], () => 'F1')
    expect(modelReferenceMatchesSource({ bodyId: 'F1' }, identity)).toBe(false)
    expect(modelReferenceMatchesSource({ bodyId: 'F2' }, identity)).toBe(true)
  })

  it('a reference id that another live body currently holds never resolves by lineage', () => {
    const a = modelRow('a', 'F2', 'F1')
    const b = modelRow('b', 'F1', 'G1')
    const identity = modelReferenceSourceIdentity(a, 'legacy', [a, b], () => 'F1')
    expect(modelReferenceMatchesSource({ bodyId: 'F1' }, identity)).toBe(false)
  })

  it('an unknown historical id with no document evidence stays a mismatch', () => {
    const a = modelRow('a', 'F2', 'F0')
    const identity = modelReferenceSourceIdentity(a, 'legacy', [a], () => undefined)
    expect(modelReferenceMatchesSource({ bodyId: 'F1' }, identity)).toBe(false)
    expect(modelReferenceMatchesSource({ bodyId: 'F0' }, identity)).toBe(true)
  })
})
