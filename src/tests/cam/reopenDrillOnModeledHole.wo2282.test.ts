// @vitest-environment jsdom
//
// WO-2282: a Drill on a modeled hole computes after reopen, without opening
// the Model workspace.
//
// The fresh-PC journey (WO-2249 step 7) modeled a plate (Extrude F1), put a
// Hole feature (F2) on it, drilled it, saved, closed and reopened. REGEN ALL
// then left the Drill "unsupported": the reopened page has no Model workspace
// mounted, so hole recognition rebuilds the body in the background
// (modelBodyHoleRecognition.ts regenerateModelBodyHeadless), and that rebuild
// refused the hole feature by name ("background reconstruction does not
// support a 'hole' feature yet").
//
// Session 1 below stands in for the Model workspace the way the page itself
// publishes it: the body is built on a live kernel with the same requests the
// workbench executor issues (makeExtrude, then makeHole with the hole
// payload) and exposed through window.__solidsWorkbenchHooks, and the CAM row
// arrives through the production syncModelBodies. The Drill computes there,
// the project is saved through saveProjectToFile -> packageProjectToFile,
// the store and document holder are wiped, the hooks are removed, and the
// file is reopened through loadProjectFromFile. computeAllToolpaths must then
// bring the Drill ready on the same holes.
//
// Negative control: with the 'hole' branch removed from
// makeHeadlessExecutor the reopened Drill reads 'unsupported' with the
// "background reconstruction does not support a 'hole' feature yet" message
// (recorded in the WO's worker result).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's localStorage is broken under vitest's node launch flags; the store's
// persist() writes on every set() (same shim as documentHydrationCallSites.wo365).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { BASE_PLANE_XY_NODE_ID } = await import('../../doc/genesis')
const { finalizeSeedArchive, newSeededModelDag } = await import('../../doc/seedModelArchive')
const { extractSketchProfile } = await import('../../components/model3d/workbench/sketchProfile')
const { resolveProfileSelector } = await import('../../components/model3d/workbench/regionSelector')
const { buildExtrudeRequest } = await import('../../components/model3d/workbench/extrudeParams')
const {
  __setModelBodyHeadlessClientFactoryForTests,
  readModelBodyFaceFacts,
  recognizeModelBodyHoles,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { edgeId } = await import('../../geom/worker/stable-id')
const { buildDrillToolpath } = await import('../../lib/cam/drill2d')

import type { GeomClient } from '../../geom'
import type { BodyHandle, ProfileRegion } from '../../geom/geom-service'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import type { ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import type { HoleFeaturePayload } from '../../components/model3d/dialogs/HoleDialog'
import type { ModelBodyDisplay, Operation, PhysicalStock, Project, SceneStock, Tool, ToolpathMove } from '../../types'

const PLATE_SKETCH = 'sketch3d:S1'
const EXTRUDE = 'F1'
const HOLE = 'F2'
const HOLE_POINTS = [{ x: 15, y: 20, z: 10 }, { x: 45, y: 20, z: 10 }]
const DRILL_ID = 'wo2282-drill'
const XY_FRAME = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }

function plateSketch(): Sketch {
  const line = (id: string, sx: number, sy: number, ex: number, ey: number): SketchEntity =>
    ({ id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } })
  return {
    id: 'S1', layerId: 'L1', constraints: [], dimensions: [], solveStatus: null,
    entities: [line('e0', 0, 0, 60, 0), line('e1', 60, 0, 60, 40), line('e2', 60, 40, 0, 40), line('e3', 0, 40, 0, 0)],
  }
}

const extrudePayload = {
  opType: 'extrude', sketchId: PLATE_SKETCH, profileSelector: { kind: 'whole-sketch' },
  distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1',
}

/** What the Model workspace holds after Extrude F1 + Hole F2: the body built
 *  on a live kernel with the workbench executor's own requests. Returns the
 *  hole payload the document records. */
async function buildLiveBody(
  client: GeomClient,
): Promise<{ handle: BodyHandle; hole: HoleFeaturePayload; topFace: string; sideFace: string }> {
  const profile = await extractSketchProfile(plateSketch(), XY_FRAME, 'S1')
  if (!profile.ok) throw new Error(profile.refusal.message)
  const selection = resolveProfileSelector(profile.regions as ProfileRegion[], { kind: 'whole-sketch' })
  if (!selection.ok) throw new Error(selection.message)
  const build = buildExtrudeRequest({
    featureId: EXTRUDE, payload: extrudePayload as ExtrudeParamsInput, profiles: selection.profiles,
    distance: 10, lookupTarget: () => undefined, modelItemId: 'legacy',
  })
  if (!build.ok) throw new Error(build.reason)
  const plate = await client.makeExtrude(build.req)
  if (!plate.ok || plate.body === undefined) throw new Error('extrude failed')
  const snapshots = await client.snapshotsFor(plate.body)
  const topFace = Object.entries(snapshots).find(([, s]) =>
    s.type === 'plane' && Math.abs(s.normal![2] - 1) < 1e-6 && Math.abs(s.centroid[2] - 10) < 1e-6)?.[0]
  if (topFace === undefined) throw new Error('plate has no top face at Z 10')
  const sideFace = Object.entries(snapshots).find(([, s]) =>
    s.type === 'plane' && Math.abs(s.normal![0] + 1) < 1e-6 && Math.abs(s.centroid[0]) < 1e-6)?.[0]
  if (sideFace === undefined) throw new Error('plate has no side face at X 0')
  const hole: HoleFeaturePayload = {
    opType: 'hole', ownerId: EXTRUDE, faceId: topFace, points: HOLE_POINTS,
    style: { kind: 'simple', diameter: 6 }, depth: { kind: 'throughAll' }, name: 'Hole F2',
  }
  const holed = await client.makeHole({
    featureId: HOLE, body: plate.body, face: hole.faceId, points: hole.points, style: hole.style, depth: hole.depth,
  })
  if (!holed.ok || holed.body === undefined) throw new Error('hole failed')
  return { handle: holed.body, hole, topFace, sideFace }
}

type SeededDag = ReturnType<typeof newSeededModelDag>

function stashModelDocument(hole: HoleFeaturePayload, extra: (dag: SeededDag) => void = () => {}): void {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: PLATE_SKETCH, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: { sketch: plateSketch(), planeNodeId: BASE_PLANE_XY_NODE_ID },
  })
  dag.insertNode({ id: EXTRUDE, kind: 'feature', consumes: [PLATE_SKETCH], refs: [], payload: { ...extrudePayload } })
  dag.insertNode({ id: HOLE, kind: 'feature', consumes: [EXTRUDE], refs: [], payload: { ...hole } })
  extra(dag)
  stashLoadedDocument(finalizeSeedArchive(dag))
}

function display(): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min: [0, 0, 0], max: [60, 40, 10] },
  }
}

const stock: PhysicalStock = {
  id: 'stock-wo2282', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 10 },
    size: { x: 60, y: 40, z: 10 }, center: { x: 30, y: 20, z: 5 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 60, fixedHeight: 40, fixedDepth: 10, fixedStocks: [],
} as SceneStock

const drillTool: Tool = {
  id: 'wo2282-drill-6', name: 'Drill 6', type: 'drill', diameter: 6,
  fluteLength: 30, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 3000, feedRate: 200, plungeRate: 100, depthOfCut: 2, stepover: 1 } },
} as Tool

function drillOp(geometryId: string): Operation {
  return stampSmartHeightAuthority({
    id: DRILL_ID, name: 'Journey Drill', type: 'drill', enabled: true, status: 'pending',
    toolId: drillTool.id, geometrySelections: [],
    modelReferences: [{ bodyId: HOLE, stableIds: [], role: 'drill-targets' }],
    heights: {
      clearanceHeight: 25, clearanceHeightMode: 'absolute',
      retractHeight: 15, feedHeight: 12, topHeight: 10, topHeightMode: 'absolute',
      bottomHeight: -1, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId, loopIds: [], cycleType: 'simple', peckDepth: 2,
      chipBreakRetract: 1, dwell: 0, retractMode: 'retract', sortStrategy: 'none',
    },
  } as unknown as Operation, { geometryIds: [geometryId] })
}

function installProject(): void {
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId: HOLE, name: 'Extrude F1' }],
    derived: [{ bodyId: HOLE, version: 1, stableIds: [], display: display() }],
  })
  const geo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')
  expect(geo, 'syncModelBodies published the modeled body row').toBeDefined()
  useCamStore.setState((s) => ({
    toolLibrary: [drillTool, ...s.toolLibrary],
    project: {
      ...s.project,
      name: 'WO-2282 journey',
      stocks: [stock],
      sceneStock,
      setups: [{
        id: 'setup-wo2282', name: 'Setup 1', operations: [drillOp(geo!.id)],
        wcs: {
          id: 'wcs-wo2282', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          stockId: stock.id,
        },
        stock: {
          type: 'rectangular', width: 60, height: 40, depth: 10,
          offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
        },
        notes: '',
      }],
      activeSetupId: 'setup-wo2282',
    } as unknown as Project,
  }))
  // The operator puts the modeled body in the stock (the Stock panel's pick).
  useCamStore.getState().setStockMembership(geo!.id, stock.id)
  expect(useCamStore.getState().project.geometry.find((g) => g.id === geo!.id)?.stockId).toBe(stock.id)
}

function drill(): Operation {
  return useCamStore.getState().project.setups.flatMap((s) => s.operations).find((o) => o.id === DRILL_ID)!
}

/** Drilled XY positions: the plunge (cut-role feed) moves' XY, rounded. */
function drilledPoints(moves: ToolpathMove[] | undefined): string[] {
  const pts = new Set<string>()
  for (const m of moves ?? []) {
    if (m.type === 'feed' && m.z < 10) pts.add(`${m.x.toFixed(3)},${m.y.toFixed(3)}`)
  }
  return [...pts].sort()
}

let savedProjectText = ''
let originalWorker: typeof Worker | undefined
let liveClient: GeomClient | null = null

beforeEach(() => {
  mem.clear()
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
  __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  savedProjectText = ''
  originalWorker = globalThis.Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage(data: { type: string; payload: Record<string, unknown> & { opId: string } }): void {
      const moves = data.type === 'COMPUTE_DRILL' ? buildDrillToolpath(data.payload as never) : []
      queueMicrotask(() => this.onmessage?.({
        data: { type: 'TOOLPATH_COMPLETE', opId: data.payload.opId, moves, computeTimeMs: 1 },
      } as MessageEvent))
    }
    terminate(): void { /* no-op */ }
    addEventListener(): void { /* no-op */ }
    removeEventListener(): void { /* no-op */ }
  }
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 10 } }),
  }
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-2282.camproject'
    },
  })
})

afterEach(async () => {
  ;(globalThis as { Worker?: unknown }).Worker = originalWorker
  delete (window as unknown as Record<string, unknown>).__cncViewport
  delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
  vi.unstubAllGlobals()
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  if (liveClient !== null) await liveClient.terminate().catch(() => undefined)
  liveClient = null
})

describe('WO-2282: a Drill on a modeled hole computes after reopen', () => {
  it('save -> reopen with no Model workspace -> computeAllToolpaths brings the Drill ready on the same holes', async () => {
    // Session 1: the Model workspace is mounted and owns the live body.
    liveClient = createLocalGeomService()
    await liveClient.init()
    const live = await buildLiveBody(liveClient)
    const liveVerdicts = await liveClient.recognizeFeatures(live.handle)
    ;(window as unknown as Record<string, unknown>).__solidsWorkbenchHooks = {
      getBodyHandle: (id: string) => (id === HOLE ? live.handle : undefined),
      client: liveClient,
    }
    stashModelDocument(live.hole)
    installProject()

    await useCamStore.getState().computeOperationToolpath('setup-wo2282', DRILL_ID)
    expect(drill().status, `errorMessage: ${drill().errorMessage}`).toBe('ready')
    const before = drilledPoints(drill().toolpathMoves)
    expect(before).toEqual(['15.000,20.000', '45.000,20.000'])

    await useCamStore.getState().saveProjectToFile()
    expect(savedProjectText).not.toBe('')
    expect(JSON.parse(savedProjectText).document, 'the model rides in the file').toEqual(expect.any(String))

    // Close: fresh store, fresh document holder, no Model workspace hooks.
    delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
    const viewport = (window as unknown as Record<string, unknown>).__cncViewport
    delete (window as unknown as Record<string, unknown>).__cncViewport
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.setState(useCamStore.getInitialState(), true)

    // Reopen through the production open path and REGEN ALL.
    await useCamStore.getState().loadProjectFromFile(savedProjectText)
    expect((window as unknown as Record<string, unknown>).__solidsWorkbenchHooks).toBeUndefined()
    ;(window as unknown as Record<string, unknown>).__cncViewport = viewport
    await useCamStore.getState().computeAllToolpaths()

    const reopened = drill()
    expect(reopened.errorMessage ?? '').not.toMatch(/background reconstruction/)
    expect(reopened.status, `errorMessage: ${reopened.errorMessage}`).toBe('ready')
    expect(drilledPoints(reopened.toolpathMoves)).toEqual(before)

    // The background rebuild is the Model workspace's body: same recognized holes.
    const rebuilt = await recognizeModelBodyHoles(HOLE, 'legacy')
    const holes = (vs: typeof rebuilt) => vs
      .filter((v) => v.featureClass === 'throughHole' || v.featureClass === 'blindHole')
      .map((v) => `${v.featureClass}:${Number(v.params.diameter).toFixed(3)}:${[...(v.faceIds ?? [])].sort().join('|')}`)
      .sort()
    expect(holes(rebuilt)).toEqual(holes(liveVerdicts))
    expect(holes(rebuilt)).toHaveLength(2)
  }, 120_000)
})

// The other single-call features the Model workspace replays (chamfer, shell,
// boolean) rebuild in the background too. Each case builds the body on a live
// kernel with the workbench executor's own request, stashes the same document,
// and reads it back through the background rebuild (no workbench hooks): the
// faces the feature created carry the same analytic snapshot, and recognition
// reads the same features.
describe('WO-2282: the background rebuild replays chamfer, shell and boolean features', () => {
  async function expectSameBody(bodyId: string, liveHandle: BodyHandle): Promise<void> {
    const liveSnapshots = await liveClient!.snapshotsFor(liveHandle)
    const liveKeys = (await liveClient!.recognizeFeatures(liveHandle)).map((v) => `${v.featureClass}:${v.featureKey}`).sort()
    const created = Object.keys(liveSnapshots).filter((id) => id.includes(`${bodyId}:`))
    expect(created.length, 'the feature created faces of its own').toBeGreaterThan(0)
    for (const faceId of new Set([created[0], created[created.length - 1]])) {
      const { snapshot, verdicts } = await readModelBodyFaceFacts(bodyId, faceId, 'legacy')
      const want = liveSnapshots[faceId]
      expect(snapshot.type).toBe(want.type)
      expect(snapshot.area).toBeCloseTo(want.area, 6)
      expect(snapshot.centroid.map((v) => +v.toFixed(6))).toEqual(want.centroid.map((v) => +v.toFixed(6)))
      expect(verdicts.map((v) => `${v.featureClass}:${v.featureKey}`).sort()).toEqual(liveKeys)
    }
  }

  beforeEach(async () => {
    liveClient = createLocalGeomService()
    await liveClient.init()
  })

  it('chamfer on the holed plate', async () => {
    const live = await buildLiveBody(liveClient!)
    const edges = [edgeId([live.topFace, live.sideFace], '0')]
    const payload = { opType: 'chamfer', ownerId: HOLE, edges, distance: 1, propagateTangent: true, name: 'Chamfer F3' }
    const r = await liveClient!.applyChamfer({ featureId: 'F3', body: live.handle, edges, distance: 1, propagateTangent: true })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument(live.hole, (dag) => dag.insertNode({ id: 'F3', kind: 'feature', consumes: [HOLE], refs: [], payload }))
    await expectSameBody('F3', r.body!)
  }, 120_000)

  it('shell of the holed plate, top face removed', async () => {
    const live = await buildLiveBody(liveClient!)
    const payload = { opType: 'shell', ownerId: HOLE, removeFaces: [live.topFace], thickness: 1, name: 'Shell F3' }
    const r = await liveClient!.applyShell({ featureId: 'F3', body: live.handle, removeFaces: payload.removeFaces, thickness: 1 })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument(live.hole, (dag) => dag.insertNode({ id: 'F3', kind: 'feature', consumes: [HOLE], refs: [], payload }))
    await expectSameBody('F3', r.body!)
  }, 120_000)

  it('boolean cut of a second extruded body from the holed plate', async () => {
    const live = await buildLiveBody(liveClient!)
    const line = (id: string, sx: number, sy: number, ex: number, ey: number): SketchEntity =>
      ({ id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } })
    const toolSketch: Sketch = {
      id: 'S2', layerId: 'L1', constraints: [], dimensions: [], solveStatus: null,
      entities: [line('t0', 50, 10, 70, 10), line('t1', 70, 10, 70, 30), line('t2', 70, 30, 50, 30), line('t3', 50, 30, 50, 10)],
    }
    const toolExtrude = {
      opType: 'extrude', sketchId: 'sketch3d:S2', profileSelector: { kind: 'whole-sketch' },
      distance: 20, direction: 'up', boolMode: 'newBody', name: 'Extrude F3',
    }
    const profile = await extractSketchProfile(toolSketch, XY_FRAME, 'S2')
    if (!profile.ok) throw new Error(profile.refusal.message)
    const selection = resolveProfileSelector(profile.regions as ProfileRegion[], { kind: 'whole-sketch' })
    if (!selection.ok) throw new Error(selection.message)
    const build = buildExtrudeRequest({
      featureId: 'F3', payload: toolExtrude as ExtrudeParamsInput, profiles: selection.profiles,
      distance: 20, lookupTarget: () => undefined, modelItemId: 'legacy',
    })
    if (!build.ok) throw new Error(build.reason)
    const tool = await liveClient!.makeExtrude(build.req)
    expect(tool.ok).toBe(true)
    const payload = { opType: 'boolean', targetFeatureId: HOLE, toolFeatureId: 'F3', boolOp: 'cut', name: 'Boolean F4' }
    const r = await liveClient!.applyBoolean({ featureId: 'F4', op: 'cut', target: live.handle, tools: [tool.body!] })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument(live.hole, (dag) => {
      dag.insertNode({
        id: 'sketch3d:S2', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
        payload: { sketch: toolSketch, planeNodeId: BASE_PLANE_XY_NODE_ID },
      })
      dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['sketch3d:S2'], refs: [], payload: toolExtrude })
      dag.insertNode({ id: 'F4', kind: 'feature', consumes: [HOLE, 'F3'], refs: [], payload })
    })
    await expectSameBody('F4', r.body!)
  }, 120_000)
})
