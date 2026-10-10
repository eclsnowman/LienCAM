// WO-1401: a section marked `sectionStale: true` must be refreshed from the
// current body BEFORE a compute reads its loops, not silently accepted as a
// ready operation's frozen (pre-edit) input.
//
// Authority (BUG-457, family K1): `sectionStale` was read in exactly one
// place in the whole tree (DesignTree's badge) - nothing in the compute/regen
// path ever checked it. A contour op bound to a stale Section-at-Z layer
// computed normally from the OLD frozen loops and landed 'ready' with a
// result that no longer matched the source body.
//
// Decided fix (architect, 2026-09-14): refresh, not refuse (LIENCAM rule 11 -
// the software can re-section a live body, so it does). computeOperationToolpath
// now re-derives a stale, tracked section layer in place right before reading
// it, carries the operation's own loop selection forward onto the refreshed
// layer's current loops (so a genuinely reshaped section does not orphan the
// very selection the fix just corrected), and logs one console line.
//
// This drives the fix through the REAL store action + REAL in-process
// toolpathWorker (same harness pattern as camBindingStage4.test.ts, which
// proves the ADJACENT non-stale Section-at-Z path this WO must not disturb).

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

/** A stepped body: 40x30 base (z 0..5) + a top slab (z 5..10) whose width/depth
 *  is parameterized so a test can install "the current body" at a DIFFERENT
 *  top size than whatever a previously-captured section snapshot recorded. */
function steppedModelGeo(id: string, name: string, topW: number, topH: number): ImportedGeometry {
  const base = buildWallMesh([rectCW(40, 30)], 0, 5)
  const top = buildWallMesh([rectCW(topW, topH)], 5, 10)
  const mesh = {
    positions: [...base.positions, ...top.positions],
    indices: [...base.indices, ...top.indices.map((i) => i + base.positions.length / 3)],
  }
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
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

const rectAt = (cx: number, cy: number, w: number, h: number): Pt2[] => [
  { x: cx - w / 2, y: cy - h / 2 }, { x: cx - w / 2, y: cy + h / 2 },
  { x: cx + w / 2, y: cy + h / 2 }, { x: cx + w / 2, y: cy - h / 2 },
]

/** A body with TWO SEPARATE top islands (z 5..10) - one centered at x=-10,
 *  one at x=+10 - over one shared base plate (z 0..5). A Section-at-Z z=8
 *  resolves to exactly 2 loops, one per island, so a test can select ONE
 *  island and edit only the OTHER. */
function twoIslandModelGeo(id: string, name: string, leftSize: number | null, rightSize: number | null): ImportedGeometry {
  const base = buildWallMesh([rectAt(0, 0, 60, 40)], 0, 5)
  // A null size omits that island entirely (the edit deleted it).
  const islands: Pt2[][] = []
  if (leftSize !== null) islands.push(rectAt(-10, 0, leftSize, leftSize))
  if (rightSize !== null) islands.push(rectAt(10, 0, rightSize, rightSize))
  const top = buildWallMesh(islands, 5, 10)
  const mesh = {
    positions: [...base.positions, ...top.positions],
    indices: [...base.indices, ...top.indices.map((i) => i + base.positions.length / 3)],
  }
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -30, y: -20, z: 0 }, { x: 30, y: 20, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [-30, -20, 0], max: [30, 20, 10] },
      },
    },
  } as unknown as ImportedGeometry
}

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

function makeSetup(op: Operation): Setup {
  return {
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
}

function installProject(
  geometry: ImportedGeometry[], op: Operation, modelItemPlacements: ModelItemPlacementRecord[] = [],
): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    consoleEvents: [], consoleReadThroughId: 0,
    project: {
      ...s.project, geometry, stocks: [derivedStock()],
      setups: [makeSetup(op)], sceneStock, modelItemPlacements,
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]
const currentGeo = (id: string): ImportedGeometry =>
  useCamStore.getState().project.geometry.find((g) => g.id === id)!
const sectionLayer = (id: string) => (currentGeo(id).layers2d ?? []).find((l) => l.derived)!

const IDENTITY_LEGACY_PLACEMENT: ModelItemPlacementRecord[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]

// ─── the REAL worker, driven in-process (identical harness to Stage 2/4's own) ─
let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined

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

/** Land a real Section-at-Z on `id` (top slab, z=8), bind the contour op to
 *  the resulting loop id(s), then mark the section layer stale AND swap the
 *  body's live tessellation for a top slab of a DIFFERENT size - simulating
 *  "the section was captured, then the source body changed" (BUG-457) without
 *  re-running the whole model-sync pipeline this WO does not own. */
async function installStaleSection(
  id: string, capturedTopW: number, capturedTopH: number, currentTopW: number, currentTopH: number,
): Promise<void> {
  installProject([steppedModelGeo(id, 'Stepped', capturedTopW, capturedTopH)], makeContourOp(id), IDENTITY_LEGACY_PLACEMENT)
  await useCamStore.getState().deriveBrepLayer(id, 'section', { z: 8 })
  const capturedLoopIds = (currentGeo(id).loops ?? []).map((l) => l.id)
  expect(capturedLoopIds.length).toBeGreaterThan(0)

  useCamStore.setState((s) => {
    const geo = s.project.geometry.find((g) => g.id === id)!
    const layer = geo.layers2d!.find((l) => l.derived)!
    const editedGeo: ImportedGeometry = {
      ...geo,
      modelBody: {
        ...geo.modelBody!,
        display: steppedModelGeo(id, 'Stepped', currentTopW, currentTopH).modelBody!.display,
      },
      layers2d: geo.layers2d!.map((l) => (l.id === layer.id ? { ...l, sectionStale: true } : l)),
    }
    const op = s.project.setups[0].operations[0]
    return {
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) => (g.id === id ? editedGeo : g)),
        setups: [{
          ...s.project.setups[0],
          operations: [{ ...op, params: { ...op.params, loopIds: capturedLoopIds } }],
        }],
      },
    }
  })
  expect(sectionLayer(id).sectionStale).toBe(true)
}

/** Land a Section-at-Z on a TWO-ISLAND body, select ONLY the left island's
 *  loop, mark the layer stale, then edit ONLY the right island's size - the
 *  audit's exact repro (src/store/index.ts:14305, 2026-09-15): a partial
 *  selection must stay partial through a refresh, never widen onto a
 *  sibling loop the edit did not even touch. */
async function installTwoIslandStaleSection(
  id: string,
  captured: { left: number; right: number },
  current: { left: number | null; right: number | null },
): Promise<{ leftLoopId: string; rightLoopId: string }> {
  installProject([twoIslandModelGeo(id, 'Islands', captured.left, captured.right)], makeContourOp(id), IDENTITY_LEGACY_PLACEMENT)
  await useCamStore.getState().deriveBrepLayer(id, 'section', { z: 8 })
  const loops = currentGeo(id).loops ?? []
  expect(loops.length).toBe(2)
  const left = loops.find((l) => l.points.every((p) => p.x < 0))
  const right = loops.find((l) => l.points.every((p) => p.x > 0))
  expect(left).toBeTruthy()
  expect(right).toBeTruthy()
  const leftLoopId = left!.id
  const rightLoopId = right!.id

  useCamStore.setState((s) => {
    const geo = s.project.geometry.find((g) => g.id === id)!
    const layer = geo.layers2d!.find((l) => l.derived)!
    const editedGeo: ImportedGeometry = {
      ...geo,
      modelBody: {
        ...geo.modelBody!,
        display: twoIslandModelGeo(id, 'Islands', current.left, current.right).modelBody!.display,
      },
      layers2d: geo.layers2d!.map((l) => (l.id === layer.id ? { ...l, sectionStale: true } : l)),
    }
    const op = s.project.setups[0].operations[0]
    return {
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) => (g.id === id ? editedGeo : g)),
        setups: [{
          ...s.project.setups[0],
          operations: [{ ...op, params: { ...op.params, loopIds: [leftLoopId] } }],
        }],
      },
    }
  })
  expect(sectionLayer(id).sectionStale).toBe(true)
  return { leftLoopId, rightLoopId }
}

describe('WO-1401: computeOperationToolpath refreshes a stale Section-at-Z before reading it', () => {
  it('acceptance 1: a stale section is refreshed from the CURRENT body, the op ends ready with moves matching the NEW top (not the captured 20x15 one), and the console says so', async () => {
    await installStaleSection('m-stale-1', 20, 15, 26, 18)
    const capturedLoopIds = [...(currentOp().params as { loopIds: string[] }).loopIds]

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const cuts = cutXY(currentOp().toolpathMoves ?? [])
    expect(cuts.length).toBeGreaterThan(0)
    const box = bbox2d(cuts)
    // The 6mm tool's 'outside'-side contour insets the cut by one radius
    // (3mm) per edge (same convention camBindingStage4.test.ts pins): the
    // CURRENT 26x18 top cuts to ~20x12. The captured (stale) 20x15 top would
    // instead have cut to ~14x9 - clearly distinct, so this box proves the
    // moves came from the refreshed body, not the frozen section.
    expect(box.w).toBeCloseTo(20, 0)
    expect(box.h).toBeCloseTo(12, 0)

    // The tracked layer is refreshed: no longer stale, fingerprint moved on.
    const layer = sectionLayer('m-stale-1')
    expect(layer.sectionStale).not.toBe(true)

    // The op's own selection was carried forward onto the refreshed loops -
    // never left pointing at ids the refresh just replaced.
    const nextLoopIds = (currentOp().params as { loopIds: string[] }).loopIds
    expect(nextLoopIds.length).toBeGreaterThan(0)
    for (const id of capturedLoopIds) expect(nextLoopIds).not.toContain(id)
    const liveIds = new Set((currentGeo('m-stale-1').loops ?? []).map((l) => l.id))
    for (const id of nextLoopIds) expect(liveIds.has(id)).toBe(true)

    // One console line names the refresh.
    const events = useCamStore.getState().consoleEvents
    expect(events.some((e) => e.message.includes('refreshed from the current body'))).toBe(true)
  })

  it('acceptance 2: a second regen after the refresh stays ready, matches the current source, and does not re-announce a refresh', async () => {
    await installStaleSection('m-stale-2', 20, 15, 26, 18)
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(currentOp().status).toBe('ready')
    const firstBox = bbox2d(cutXY(currentOp().toolpathMoves ?? []))
    const refreshMessagesAfterFirst = useCamStore.getState().consoleEvents
      .filter((e) => e.message.includes('refreshed from the current body')).length
    expect(refreshMessagesAfterFirst).toBe(1)

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const secondBox = bbox2d(cutXY(currentOp().toolpathMoves ?? []))
    expect(secondBox.w).toBeCloseTo(firstBox.w, 1)
    expect(secondBox.h).toBeCloseTo(firstBox.h, 1)
    const refreshMessagesAfterSecond = useCamStore.getState().consoleEvents
      .filter((e) => e.message.includes('refreshed from the current body')).length
    expect(refreshMessagesAfterSecond).toBe(1) // unchanged - nothing left stale to refresh
  })

  it('regression: an unrelated ready operation on a different, non-stale source is untouched', async () => {
    installProject(
      [steppedModelGeo('m-fresh', 'Stepped', 20, 15)],
      makeContourOp('m-fresh'),
      IDENTITY_LEGACY_PLACEMENT,
    )
    await useCamStore.getState().deriveBrepLayer('m-fresh', 'section', { z: 8 })
    const loopIds = (currentGeo('m-fresh').loops ?? []).map((l) => l.id)
    useCamStore.setState((s) => {
      const op = s.project.setups[0].operations[0]
      return {
        project: {
          ...s.project,
          setups: [{ ...s.project.setups[0], operations: [{ ...op, params: { ...op.params, loopIds } }] }],
        },
      }
    })
    expect(sectionLayer('m-fresh').sectionStale).not.toBe(true)

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    expect((currentOp().params as { loopIds: string[] }).loopIds).toEqual(loopIds)
    const events = useCamStore.getState().consoleEvents
    expect(events.some((e) => e.message.includes('refreshed from the current body'))).toBe(false)
  })

  it('audit fix (2026-09-15): refreshing a stale section keeps a PARTIAL loop selection partial - a sibling loop the edit never touched, and the operator never selected, is never added', async () => {
    const { leftLoopId, rightLoopId } = await installTwoIslandStaleSection(
      'm-two', { left: 10, right: 10 }, { left: 10, right: 16 },
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')

    // The left island's content never changed, so its content-hashed loop id
    // is unchanged too - the fix must keep exactly that id and must NOT pull
    // in the right island's (edited, unselected) loop.
    const nextLoopIds = (currentOp().params as { loopIds: string[] }).loopIds
    expect(nextLoopIds).toEqual([leftLoopId])
    expect(nextLoopIds).not.toContain(rightLoopId)

    // Every cut move stays over the LEFT island (x < 0) - the right island
    // the operator never selected is never cut.
    const cuts = cutXY(currentOp().toolpathMoves ?? [])
    expect(cuts.length).toBeGreaterThan(0)
    for (const p of cuts) expect(p.x).toBeLessThan(0)

    const layer = sectionLayer('m-two')
    expect(layer.sectionStale).not.toBe(true)
    const events = useCamStore.getState().consoleEvents
    expect(events.some((e) => e.message.includes('refreshed from the current body'))).toBe(true)
  })

  // Re-scope 2026-09-15: a selected id the refresh orphaned may re-bind ONLY to
  // a loop that is NEW after the refresh and replaces it; a surviving loop is
  // never a candidate, and with no replacement the id orphans into the
  // builder's existing missing-geometry handling.
  const liveLoopIds = (id: string) => new Set((currentGeo(id).loops ?? []).map((l) => l.id))
  const opLoopIdsNow = () => (currentOp().params as { loopIds: string[] }).loopIds

  it('re-scope (a): the edit deletes the selected left island and leaves the right untouched -> the op never cuts the right island; the id orphans into the missing-geometry path', async () => {
    const { leftLoopId, rightLoopId } = await installTwoIslandStaleSection(
      'm-del', { left: 10, right: 10 }, { left: null, right: 10 },
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    // The right island survived the refresh with its own id, so it is no candidate.
    expect(liveLoopIds('m-del').has(rightLoopId)).toBe(true)
    expect(opLoopIdsNow()).toEqual([leftLoopId])
    for (const p of cutXY(currentOp().toolpathMoves ?? [])) expect(p.x).toBeLessThan(0)
    expect(currentOp().status).not.toBe('ready')
    expect(currentOp().errorMessage ?? '').toMatch(/no longer exist/)
    const events = useCamStore.getState().consoleEvents
    expect(events.some((e) => e.message.includes('refreshed from the current body')
      && e.message.includes('1 selected loop(s) no longer exist'))).toBe(true)
  })

  it('re-scope (b): the selected island is resized (new id, same place) beside an untouched sibling -> the op re-binds to the resized island only', async () => {
    const { leftLoopId, rightLoopId } = await installTwoIslandStaleSection(
      'm-grow', { left: 10, right: 10 }, { left: 14, right: 10 },
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const next = opLoopIdsNow()
    expect(next).toHaveLength(1)
    expect(next[0]).not.toBe(leftLoopId)
    expect(next[0]).not.toBe(rightLoopId)
    const rebound = (currentGeo('m-grow').loops ?? []).find((l) => l.id === next[0])
    expect(rebound).toBeTruthy()
    expect(rebound!.points.every((p) => p.x < 0)).toBe(true)
    const cuts = cutXY(currentOp().toolpathMoves ?? [])
    expect(cuts.length).toBeGreaterThan(0)
    for (const p of cuts) expect(p.x).toBeLessThan(0)
    // Same inset convention as acceptance 1: a 14mm island cuts to ~8mm.
    expect(bbox2d(cuts).w).toBeCloseTo(8, 0)
  })

  it('re-scope: the selected island is deleted while the unselected sibling is resized -> the sibling\'s new loop is never taken', async () => {
    const { leftLoopId } = await installTwoIslandStaleSection(
      'm-del-grow', { left: 10, right: 10 }, { left: null, right: 16 },
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(opLoopIdsNow()).toEqual([leftLoopId])
    for (const p of cutXY(currentOp().toolpathMoves ?? [])) expect(p.x).toBeLessThan(0)
    expect(currentOp().status).not.toBe('ready')
  })

  it('re-scope: both islands are resized, only the left was selected -> the op re-binds to the resized left island, never the resized right one', async () => {
    const { leftLoopId, rightLoopId } = await installTwoIslandStaleSection(
      'm-both', { left: 10, right: 10 }, { left: 14, right: 16 },
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const next = opLoopIdsNow()
    expect(next).toHaveLength(1)
    expect([leftLoopId, rightLoopId]).not.toContain(next[0])
    const rebound = (currentGeo('m-both').loops ?? []).find((l) => l.id === next[0])
    expect(rebound!.points.every((p) => p.x < 0)).toBe(true)
    const cuts = cutXY(currentOp().toolpathMoves ?? [])
    expect(cuts.length).toBeGreaterThan(0)
    for (const p of cuts) expect(p.x).toBeLessThan(0)
  })
})
