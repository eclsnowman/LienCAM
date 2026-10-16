// @vitest-environment jsdom
//
// WO-2857: after Save -> Open, toolpaths on an edited imported STEP model
// regenerate and post without first opening the Model tab.
//
// The operator's sweep (2026-10-15, F2): Part 1 is an imported STEP with a Fillet r1.5
// added in the Model tab; a Drill drills its holes. Save -> New -> Open ->
// REGEN ALL left the Drill "unsupported" ("background reconstruction does not
// support a 'fillet' feature yet") and Post refused with
// OP_MODEL_REFS_UNVERIFIED until he opened the Model tab. The reopened page has
// no Model workspace mounted, so both the Drill's hole recognition and Post's
// reference check rebuild the body in the background
// (modelBodyHoleRecognition.ts), and that rebuild knew only a few feature kinds.
//
// Every case below runs the production path: session 1 holds the edited body
// on a live kernel built with the Model workspace executor's own request
// (exposed through window.__solidsWorkbenchHooks, the CAM row arriving through
// syncModelBodies), the Drill computes, the project is saved through
// saveProjectToFile; the store and document holder are wiped, the hooks
// removed, the file reopened through loadProjectFromFile; computeAllToolpaths
// must bring the Drill ready on the same hole, and Post Process (the store's
// verifyModelReferences, then postProject) must post with no
// OP_MODEL_REFS_UNVERIFIED. The STEP bytes stay in the (mocked) IndexedDB
// cache across the reopen, as they do in the app.
//
// One case per body-feature kind the Model tab builds on top of an imported
// body (headlessFeatureReplay.ts). Kinds that remove or replace the drilled
// hole (defeature, a shell through it, the new-body kinds) are checked by
// reading the background rebuild back against the live body instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))
const stlBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async () => {}),
}))

// jsdom's localStorage is broken under vitest's node launch flags; the store's
// persist() writes on every set() (same shim as reopenDrillOnModeledHole.wo2282).
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
const { finalizeSeedArchive, newSeededModelDag } = await import('../../doc/seedModelArchive')
const {
  __setModelBodyHeadlessClientFactoryForTests,
  readModelBodyFaceFacts,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { edgeId } = await import('../../geom/worker/stable-id')
const { buildDrillToolpath } = await import('../../lib/cam/drill2d')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post/dialects/uccnc')
const { buildAxisPathChain, draftPullDir, draftNeutralPlane } = await import('../../components/model3d/dialogs/dressUpGeometry')
const { BASE_PLANE_XY_NODE_ID } = await import('../../doc/genesis')
const { basePlaneFrame } = await import('../../components/model3d/workbench/basePlanes')
const { extractSketchProfile } = await import('../../components/model3d/workbench/sketchProfile')
const { resolveProfileSelector } = await import('../../components/model3d/workbench/regionSelector')
const { buildExtrudeRequest } = await import('../../components/model3d/workbench/extrudeParams')
const { BASE_PLANE_XZ_NODE_ID } = await import('../../doc/genesis')
const { resolveModelReferencesHeadless } = await import('../../lib/cam/modelBodyHoleRecognition')
const { boxCage } = await import('../../form/starters')
const { buildFormBody, makeFormFeaturePayload } = await import('../../form/formBody')
const { isReliefFeaturePayload, pictureOf, reliefKernelFields } = await import('../../relief/reliefFeature')
const { exportBinaryStl } = await import('../../mesh/stl')
const { importStl } = await import('../../mesh/stl')
const { convertPrismaticMesh } = await import('../../mesh/prismatic')

import type { GeomClient } from '../../geom'
import type { BodyHandle, OpResult, ProfileRegion, Vec3 } from '../../geom/geom-service'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import type { ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import type { FeatureRef } from '../../doc/dag'
import type { ModelBodyDisplay, Operation, PhysicalStock, Project, SceneStock, Tool, ToolpathMove } from '../../types'

const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_single_hole_block.step')
const CACHE_KEY = 'wo2857-part1'
const IMPORT = 'IMP1'
const DRILL_ID = 'wo2857-drill'
const SETUP_ID = 'setup-wo2857'
// fix_single_hole_block.step: a 40 x 20 x 20 block, one blind hole d6 x 8 at
// (20, 10) from the top face at Z 20.
const FACE = {
  minusX: 'IMP1:step:face#0',
  minusY: 'IMP1:step:face#1',
  top: 'IMP1:step:face#2',
  plusY: 'IMP1:step:face#3',
  bottom: 'IMP1:step:face#4',
  plusX: 'IMP1:step:face#5',
  bore: 'IMP1:step:face#6',
}
const HOLE_KEY = 'hole:20:10:20:0:0:1:3'
const HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack']
const POST_OPTS = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

function fixtureBytes(): ArrayBuffer {
  const source = readFileSync(STEP_FIXTURE)
  return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
}

interface FeatureNode {
  id: string
  kind?: 'feature' | 'sketch' | 'meshImport'
  consumes: string[]
  refs?: FeatureRef[]
  payload: Record<string, unknown>
}

/** One Model-tab edit: the document node(s) it records and the live kernel
 *  call the workbench executor makes for it. */
interface EditCase {
  kind: string
  /** The body the CAM row and the Drill reference (the last feature). */
  bodyId: string
  /** Where the Drill must plunge on the edited body. */
  drilled: string[]
  build: (client: GeomClient, part: BodyHandle) => Promise<{ nodes: FeatureNode[]; result: OpResult }>
}

const topMinusXEdge = edgeId([FACE.top, FACE.minusX], '0')

const DRILL_CASES: EditCase[] = [
  {
    // The operator's part: a Fillet r1.5 added in the Model tab.
    kind: 'fillet',
    bodyId: 'F1',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const payload = { opType: 'fillet', ownerId: IMPORT, edges: [topMinusXEdge], radius: 1.5, name: 'Fillet F1' }
      const result = await client.applyFillet({ featureId: 'F1', body: part, edges: payload.edges, radius: 1.5, propagateTangent: true })
      return { nodes: [{ id: 'F1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'chamfer',
    bodyId: 'F1',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const edges = [edgeId([FACE.top, FACE.plusX], '0')]
      const payload = { opType: 'chamfer', ownerId: IMPORT, edges, distance: 1, propagateTangent: true, name: 'Chamfer F1' }
      const result = await client.applyChamfer({ featureId: 'F1', body: part, edges, distance: 1, propagateTangent: true })
      return { nodes: [{ id: 'F1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'pushPull',
    bodyId: 'PP1',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const payload = { opType: 'pushPull', ownerId: IMPORT, delta: 2, name: 'Push/Pull PP1' }
      const result = await client.editFeature({ featureId: 'PP1', body: part, featureKey: FACE.minusX, delta: 2, kind: 'faceOffset' })
      return { nodes: [{ id: 'PP1', consumes: [IMPORT], refs: [{ id: FACE.minusX, kind: 'single-face' }], payload }], result }
    },
  },
  {
    kind: 'hole',
    bodyId: 'F1',
    drilled: ['20.000,10.000', '8.000,10.000'],
    build: async (client, part) => {
      const payload = {
        opType: 'hole', ownerId: IMPORT, faceId: FACE.top, points: [{ x: 8, y: 10, z: 20 }],
        style: { kind: 'simple', diameter: 6 }, depth: { kind: 'throughAll' }, name: 'Hole F1',
      }
      const result = await client.makeHole({
        featureId: 'F1', body: part, face: FACE.top, points: payload.points, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'throughAll' },
      })
      return { nodes: [{ id: 'F1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'resizeHole (move)',
    bodyId: 'RH1',
    drilled: ['25.000,10.000'],
    build: async (client, part) => {
      const payload = {
        opType: 'resizeHole', ownerId: IMPORT, featureKey: HOLE_KEY, currentDiameter: 6, newDiameter: 6, delta: 0,
        holeEdit: 'move', translation: [5, 0, 0], name: 'Move Hole RH1',
      }
      const result = await client.editFeature({ featureId: 'RH1', body: part, featureKey: HOLE_KEY, delta: 0, kind: 'holeMove', translation: [5, 0, 0] } as never)
      return { nodes: [{ id: 'RH1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'resizeHole (diameter)',
    bodyId: 'RH1',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const payload = {
        opType: 'resizeHole', ownerId: IMPORT, featureKey: HOLE_KEY, currentDiameter: 6, newDiameter: 6.5, delta: 0.5, name: 'Resize Hole RH1',
      }
      const result = await client.editFeature({ featureId: 'RH1', body: part, featureKey: HOLE_KEY, delta: 0.5, kind: 'holeDiameter' })
      return { nodes: [{ id: 'RH1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'resizeHole (depth)',
    bodyId: 'RH1',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const payload = {
        opType: 'resizeHole', ownerId: IMPORT, featureKey: HOLE_KEY, currentDiameter: 6, newDiameter: 6, delta: 0,
        holeEdit: 'depth', currentDepth: 8, currentThrough: false, newDepth: 10, name: 'Hole Depth RH1',
      }
      const result = await client.editFeature({ featureId: 'RH1', body: part, featureKey: HOLE_KEY, delta: 2, kind: 'holeDepth' } as never)
      return { nodes: [{ id: 'RH1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'draft',
    bodyId: 'F1',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const payload = {
        opType: 'draft', ownerId: IMPORT, faces: [FACE.minusY, FACE.plusY], angleDeg: 3,
        pullAxis: 'z', pullFlip: false, offset: 0, name: 'Draft F1',
      }
      const pullDir = draftPullDir('z', false)
      const result = await client.applyDraft({
        featureId: 'F1', body: part, faces: payload.faces, neutralPlane: draftNeutralPlane(pullDir, 0), pullDir, angleDeg: 3,
      })
      return { nodes: [{ id: 'F1', consumes: [IMPORT], payload }], result }
    },
  },
  {
    kind: 'boolean',
    bodyId: 'F2',
    drilled: ['20.000,10.000'],
    build: async (client, part) => {
      const tool = await extrudeRect(client, 'S1', 'F1', [34, -1, 46, 21], 30)
      const payload = { opType: 'boolean', targetFeatureId: IMPORT, toolFeatureId: 'F1', boolOp: 'cut', name: 'Boolean F2' }
      const result = await client.applyBoolean({ featureId: 'F2', op: 'cut', target: part, tools: [tool.body] })
      return { nodes: [...tool.nodes, { id: 'F2', consumes: [IMPORT, 'F1'], payload }], result }
    },
  },
]

function rectSketch(id: string, [x0, y0, x1, y1]: number[]): Sketch {
  const line = (lid: string, sx: number, sy: number, ex: number, ey: number): SketchEntity =>
    ({ id: lid, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } })
  return {
    id, layerId: 'L1', constraints: [], dimensions: [], solveStatus: null,
    entities: [line(`${id}e0`, x0, y0, x1, y0), line(`${id}e1`, x1, y0, x1, y1), line(`${id}e2`, x1, y1, x0, y1), line(`${id}e3`, x0, y1, x0, y0)],
  }
}

const PLANE_FRAMES: Record<string, { origin: Vec3; normal: Vec3; xDir: Vec3 }> = {
  [BASE_PLANE_XY_NODE_ID]: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
}

/** A package sketch node on a base plane and its profile, as the Model tab records them. */
async function sketchOn(planeNodeId: string, sketchId: string, rect: number[]): Promise<{ node: FeatureNode & { kind: 'sketch' }; profile: ProfileRegion }> {
  const sketch = rectSketch(sketchId, rect)
  const frame = PLANE_FRAMES[planeNodeId] ?? basePlaneFrame(planeNodeId)!
  const extracted = await extractSketchProfile(sketch, frame, sketchId)
  if (!extracted.ok) throw new Error(extracted.refusal.message)
  const selection = resolveProfileSelector(extracted.regions as ProfileRegion[], { kind: 'whole-sketch' })
  if (!selection.ok) throw new Error(selection.message)
  return {
    node: { id: `sketch3d:${sketchId}`, kind: 'sketch', consumes: [planeNodeId], payload: { sketch, planeNodeId } },
    profile: selection.profiles[0],
  }
}

/** A new-body extrude of a rectangle on XY, built with the workbench's own request. */
async function extrudeRect(client: GeomClient, sketchId: string, featureId: string, rect: number[], distance: number): Promise<{ body: BodyHandle; nodes: FeatureNode[] }> {
  const { node, profile } = await sketchOn(BASE_PLANE_XY_NODE_ID, sketchId, rect)
  const payload = {
    opType: 'extrude', sketchId: node.id, profileSelector: { kind: 'whole-sketch' },
    distance, direction: 'up', boolMode: 'newBody', name: `Extrude ${featureId}`,
  }
  const build = buildExtrudeRequest({
    featureId, payload: payload as ExtrudeParamsInput, profiles: [profile], distance,
    lookupTarget: () => undefined, modelItemId: 'legacy',
  })
  if (!build.ok) throw new Error(build.reason)
  const r = await client.makeExtrude(build.req)
  if (!r.ok || r.body === undefined) throw new Error(`extrude failed: ${JSON.stringify(r.diagnostics)}`)
  return { body: r.body, nodes: [node, { id: featureId, consumes: [node.id], payload }] }
}

function display(): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min: [0, 0, 0], max: [40, 20, 20] },
  }
}

const stock: PhysicalStock = {
  id: 'stock-wo2857', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 20 },
    size: { x: 40, y: 20, z: 20 }, center: { x: 20, y: 10, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 40, fixedHeight: 20, fixedDepth: 20, fixedStocks: [],
} as SceneStock

const drillTool: Tool = {
  id: 'wo2857-drill-6', name: 'Drill 6', type: 'drill', diameter: 6, toolNumber: 4,
  fluteLength: 30, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 3000, feedRate: 200, plungeRate: 100, depthOfCut: 2, stepover: 1 } },
} as Tool

function drillOp(geometryId: string, bodyId: string, stableIds: string[]): Operation {
  return stampSmartHeightAuthority({
    id: DRILL_ID, name: 'Drill 4', type: 'drill', enabled: true, status: 'pending',
    toolId: drillTool.id, geometrySelections: [],
    modelReferences: [{ bodyId, stableIds, role: 'drill-targets' }],
    heights: {
      clearanceHeight: 35, clearanceHeightMode: 'absolute',
      retractHeight: 25, feedHeight: 22, topHeight: 20, topHeightMode: 'absolute',
      bottomHeight: 12, bottomHeightMode: 'absolute',
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

function stashModelDocument(nodes: FeatureNode[], withPart = true): void {
  const dag = newSeededModelDag()
  if (withPart) {
    dag.insertNode({
      id: IMPORT, kind: 'import', consumes: [], refs: [],
      payload: { fileName: 'Part 1.step', cacheKey: CACHE_KEY, name: 'Part 1' },
    })
  }
  for (const n of nodes) dag.insertNode({ id: n.id, kind: n.kind ?? 'feature', consumes: n.consumes, refs: n.refs ?? [], payload: n.payload })
  stashLoadedDocument(finalizeSeedArchive(dag))
}

function installProject(bodyId: string, stableIds: string[]): void {
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId, name: 'Part 1' }],
    derived: [{ bodyId, version: 1, stableIds: [], display: display() }],
  })
  const geo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')
  expect(geo, 'syncModelBodies published the modeled body row').toBeDefined()
  useCamStore.setState((s) => ({
    toolLibrary: [drillTool, ...s.toolLibrary],
    project: {
      ...s.project,
      name: 'WO-2857 reopen',
      stocks: [stock],
      sceneStock,
      setups: [{
        id: SETUP_ID, name: 'Setup 1', operations: [drillOp(geo!.id, bodyId, stableIds)],
        wcs: {
          id: 'wcs-wo2857', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          stockId: stock.id,
        },
        stock: {
          type: 'rectangular', width: 40, height: 20, depth: 20,
          offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
        },
        notes: '',
      }],
      activeSetupId: SETUP_ID,
    } as unknown as Project,
  }))
  useCamStore.getState().setStockMembership(geo!.id, stock.id)
}

function drill(): Operation {
  return useCamStore.getState().project.setups.flatMap((s) => s.operations).find((o) => o.id === DRILL_ID)!
}

/** Drilled XY positions: the plunge (cut-role feed) moves' XY, rounded. */
function drilledPoints(moves: ToolpathMove[] | undefined): string[] {
  const pts = new Set<string>()
  for (const m of moves ?? []) {
    if (m.type === 'feed' && m.z < 20) pts.add(`${m.x.toFixed(3)},${m.y.toFixed(3)}`)
  }
  return [...pts].sort()
}

function consoleText(): string {
  return useCamStore.getState().consoleEvents.map((e) => e.message).join('\n')
}

/** Post Process's sequence: check the references, then post from fresh state. */
async function postProcess(): Promise<ReturnType<typeof postProject>> {
  await useCamStore.getState().verifyModelReferences()
  const s = useCamStore.getState()
  return postProject({ ...s.project, toolLibrary: s.toolLibrary }, s.project.setups, UCCNC_CONFIG, {
    ...POST_OPTS,
    modelRefsVerifiedSinceLoad: s.modelRefsVerifiedSinceLoad,
  })
}

let savedProjectText = ''
/** Worker replies held back while non-null (F7: a result that lands later). */
let heldReplies: Array<() => void> | null = null
const dispatchedOpIds: string[] = []
let originalWorker: typeof Worker | undefined
let liveClient: GeomClient | null = null

async function importPart(client: GeomClient): Promise<BodyHandle> {
  const imported = await client.importStep(fixtureBytes(), IMPORT)
  expect(imported.bodies).toHaveLength(1)
  return imported.bodies[0].handle
}

beforeEach(async () => {
  mem.clear()
  stepBytes.clear()
  stepBytes.set(CACHE_KEY, fixtureBytes())
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
  __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  savedProjectText = ''
  heldReplies = null
  dispatchedOpIds.length = 0
  originalWorker = globalThis.Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage(data: { type: string; payload: Record<string, unknown> & { opId: string } }): void {
      const moves = data.type === 'COMPUTE_DRILL' ? buildDrillToolpath(data.payload as never) : []
      const reply = () => this.onmessage?.({
        data: { type: 'TOOLPATH_COMPLETE', opId: data.payload.opId, moves, computeTimeMs: 1 },
      } as MessageEvent)
      dispatchedOpIds.push(data.payload.opId)
      if (heldReplies !== null) heldReplies.push(reply)
      else queueMicrotask(reply)
    }
    terminate(): void { /* no-op */ }
    addEventListener(): void { /* no-op */ }
    removeEventListener(): void { /* no-op */ }
  }
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 20 } }),
  }
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-2857.camproject'
    },
  })
  liveClient = createLocalGeomService()
  await liveClient.init()
})

afterEach(async () => {
  ;(globalThis as { Worker?: unknown }).Worker = originalWorker
  delete (window as unknown as Record<string, unknown>).__cncViewport
  delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
  vi.unstubAllGlobals()
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  stepBytes.clear()
  stlBytes.clear()
  if (liveClient !== null) await liveClient.terminate().catch(() => undefined)
  liveClient = null
})

describe('WO-2857: an edited imported STEP regenerates and posts after reopen, no Model tab visit', () => {
  for (const c of DRILL_CASES) {
    it(`${c.kind}: save -> open -> Regen All -> Post`, async () => {
      // Session 1: the Model workspace is mounted and owns the edited body.
      const part = await importPart(liveClient!)
      const { nodes, result } = await c.build(liveClient!, part)
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      const liveHandle = result.body!
      ;(window as unknown as Record<string, unknown>).__solidsWorkbenchHooks = {
        getBodyHandle: (id: string) => (id === c.bodyId ? liveHandle : undefined),
        client: liveClient,
      }
      stashModelDocument(nodes)
      // The Drill binds the recognized holes' face ids, as the New Operation
      // dialog does (deriveModelBodyDrillTargets -> faceIds).
      const holeFaces = (await liveClient!.recognizeFeatures(liveHandle))
        .filter((v) => HOLE_CLASSES.includes(v.featureClass))
        .flatMap((v) => v.faceIds ?? [])
      expect(holeFaces.length, 'the edited body still has its hole').toBeGreaterThan(0)
      installProject(c.bodyId, [...new Set(holeFaces)])

      await useCamStore.getState().computeOperationToolpath(SETUP_ID, DRILL_ID)
      expect(drill().status, `errorMessage: ${drill().errorMessage}`).toBe('ready')
      const before = drilledPoints(drill().toolpathMoves)
      expect(before).toEqual(c.drilled)

      await useCamStore.getState().saveProjectToFile()
      expect(JSON.parse(savedProjectText).document, 'the model rides in the file').toEqual(expect.any(String))
      // Evidence: WO2857_PROJECT_OUT=<dir> keeps the saved file for the real-app capture.
      if (process.env.WO2857_PROJECT_OUT) writeFileSync(resolve(process.env.WO2857_PROJECT_OUT, `${c.kind}.camproject`), savedProjectText)

      // Close: fresh store, fresh document holder, no Model workspace hooks.
      delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
      const viewport = (window as unknown as Record<string, unknown>).__cncViewport
      delete (window as unknown as Record<string, unknown>).__cncViewport
      resetDocumentHolder()
      setDocumentStorage(new InMemoryDocumentStorage())
      useCamStore.setState(useCamStore.getInitialState(), true)

      // Open the saved file and REGEN ALL.
      await useCamStore.getState().loadProjectFromFile(savedProjectText)
      expect((window as unknown as Record<string, unknown>).__solidsWorkbenchHooks).toBeUndefined()
      ;(window as unknown as Record<string, unknown>).__cncViewport = viewport
      await useCamStore.getState().computeAllToolpaths()

      const reopened = drill()
      expect(reopened.errorMessage ?? '').not.toMatch(/background reconstruction/)
      expect(reopened.status, `errorMessage: ${reopened.errorMessage}`).toBe('ready')
      expect(drilledPoints(reopened.toolpathMoves)).toEqual(before)

      // Post Process: the reference check rebuilds the body itself and the post goes out.
      const posted = await postProcess()
      expect(consoleText()).not.toMatch(/Could not check the model references/)
      expect(posted.diagnostics.filter((d) => d.code === 'OP_MODEL_REFS_UNVERIFIED')).toEqual([])
      expect(posted.diagnostics.filter((d) => d.level === 'error')).toEqual([])
      expect(posted.ok).toBe(true)
      for (const pt of c.drilled) {
        const [x, y] = pt.split(',').map((v) => String(Number(v)))
        expect(posted.combined?.gcode, `the program drills ${pt}`).toMatch(new RegExp(`X${x}(\\.0*)? Y${y}(\\.0*)?\\b`))
      }
    }, 120_000)
  }
})

// Kinds that remove the drilled hole or make a new body: the background
// rebuild (no workbench hooks) is read back against the live body the Model
// workspace built -- the same analytic face snapshots, the same recognized
// features -- and Post's headless reference check resolves the faces exact.
describe('WO-2857: the background rebuild replays the kinds that replace the drilled hole', () => {
  async function expectSameBody(bodyId: string, liveHandle: BodyHandle): Promise<void> {
    expect((window as unknown as Record<string, unknown>).__solidsWorkbenchHooks).toBeUndefined()
    const liveSnapshots = await liveClient!.snapshotsFor(liveHandle)
    const liveKeys = (await liveClient!.recognizeFeatures(liveHandle)).map((v) => `${v.featureClass}:${v.featureKey}`).sort()
    const faces = Object.keys(liveSnapshots).sort()
    expect(faces.length, 'the live body has faces').toBeGreaterThan(0)
    for (const faceId of new Set([faces[0], faces[faces.length - 1]])) {
      const { snapshot, verdicts } = await readModelBodyFaceFacts(bodyId, faceId, 'legacy')
      const want = liveSnapshots[faceId]
      expect(snapshot.type).toBe(want.type)
      expect(snapshot.area).toBeCloseTo(want.area, 6)
      expect(snapshot.centroid.map((v) => +v.toFixed(6))).toEqual(want.centroid.map((v) => +v.toFixed(6)))
      expect(verdicts.map((v) => `${v.featureClass}:${v.featureKey}`).sort()).toEqual(liveKeys)
    }
    const [resolved] = await resolveModelReferencesHeadless('legacy', new Map([[bodyId, faces]]))
    expect(resolved.resolutions.filter((r) => r.status !== 'exact')).toEqual([])
  }

  it('shell of the part, bottom face removed', async () => {
    const part = await importPart(liveClient!)
    const payload = { opType: 'shell', ownerId: IMPORT, removeFaces: [FACE.bottom], thickness: 2, name: 'Shell F1' }
    const r = await liveClient!.applyShell({ featureId: 'F1', body: part, removeFaces: payload.removeFaces, thickness: 2 })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([{ id: 'F1', consumes: [IMPORT], payload }])
    await expectSameBody('F1', r.body!)
  }, 120_000)

  it('defeature: the hole removed', async () => {
    const part = await importPart(liveClient!)
    const payload = { opType: 'defeature', ownerId: IMPORT, featureKeys: [HOLE_KEY], name: 'Defeature DF1' }
    const r = await liveClient!.defeatureBatch({ featureId: 'DF1', body: part, featureKeys: [HOLE_KEY] })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([{ id: 'DF1', consumes: [IMPORT], payload }])
    await expectSameBody('DF1', r.body!)
  }, 120_000)

  it('revolve of a sketch on XZ about Z', async () => {
    const { node, profile } = await sketchOn(BASE_PLANE_XZ_NODE_ID, 'S1', [5, 0, 10, 10])
    const payload = { opType: 'revolve', sketchId: node.id, profileSelector: { kind: 'whole-sketch' }, angleDeg: 270, name: 'Revolve F1' }
    const r = await liveClient!.makeRevolve({
      featureId: 'F1', profile, axis: { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }, angleDeg: 270, op: 'newBody',
    })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([node, { id: 'F1', consumes: [node.id], payload }], false)
    await expectSameBody('F1', r.body!)
  }, 120_000)

  it('sweep of a sketch along Z', async () => {
    const { node, profile } = await sketchOn(BASE_PLANE_XY_NODE_ID, 'S1', [0, 0, 5, 5])
    const payload = { opType: 'sweep', sketchId: node.id, profileSelector: { kind: 'whole-sketch' }, axis: 'z', length: 12, orientation: 'fixed', name: 'Sweep F1' }
    const r = await liveClient!.makeSweep({ featureId: 'F1', profile, path: buildAxisPathChain('z', 12), orientation: 'fixed', op: 'newBody' })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([node, { id: 'F1', consumes: [node.id], payload }], false)
    await expectSameBody('F1', r.body!)
  }, 120_000)

  it('loft between two sketches', async () => {
    const a = await sketchOn(BASE_PLANE_XY_NODE_ID, 'S1', [0, 0, 10, 10])
    const b = await sketchOn(BASE_PLANE_XY_NODE_ID, 'S2', [2, 2, 8, 8])
    const payload = { opType: 'loft', sectionIds: [a.node.id, b.node.id], spacing: 10, ruled: false, name: 'Loft F1' }
    const upper = { ...b.profile, plane: { ...b.profile.plane, origin: { ...b.profile.plane.origin, z: b.profile.plane.origin.z + 10 } } }
    const r = await liveClient!.makeLoft({ featureId: 'F1', sections: [a.profile, upper], ruled: false, op: 'newBody' })
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([a.node, b.node, { id: 'F1', consumes: [a.node.id, b.node.id], payload }], false)
    await expectSameBody('F1', r.body!)
  }, 120_000)

  it('form: a box cage', async () => {
    const payload = makeFormFeaturePayload('Form 1', boxCage())
    const r = await buildFormBody(liveClient!, payload, 'FRM1')
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([{ id: 'FRM1', consumes: [], payload: payload as unknown as Record<string, unknown> }], false)
    await expectSameBody('FRM1', r.body!)
  }, 180_000)

  it('relief: the app-saved relief medallion (WO-2404) reopened from its own file', async () => {
    const project = JSON.parse(readFileSync(resolve(process.cwd(), 'src/tests/evidence/WO-2404/relief-only.camproject'), 'utf8'))
    const archive = new Uint8Array(Buffer.from(project.document, 'base64'))
    const doc = JSON.parse(strFromU8(unzipSync(archive)['document.json']))
    const imp = doc.dag.nodes.find((n: { kind: string }) => n.kind === 'import')
    const rel = doc.dag.nodes.find((n: { payload?: { opType?: string } }) => n.payload?.opType === 'relief')
    const step = Buffer.from(project.binaries[imp.payload.cacheKey].step, 'base64')
    const blank = step.buffer.slice(step.byteOffset, step.byteOffset + step.byteLength) as ArrayBuffer
    stepBytes.set(imp.payload.cacheKey, blank)
    if (!isReliefFeaturePayload(rel.payload)) throw new Error('no relief payload')
    const body = (await liveClient!.importStep(blank, imp.id)).bodies[0].handle
    const fields = reliefKernelFields(await pictureOf(rel.payload.image), rel.payload)
    const r = await liveClient!.editFeature({
      featureId: rel.id, body, featureKey: rel.refs[0].id, delta: 0, kind: 'relief',
      relief: {
        ...fields.frame, n: fields.poles.n, heights: fields.poles.heights,
        ...(fields.detail !== undefined ? { detail: { cols: fields.detail.cols, rows: fields.detail.rows, heights: fields.detail.heights } } : {}),
      },
    } as never)
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashLoadedDocument(archive)
    await expectSameBody(rel.id, r.body!)
  }, 180_000)

  it('mesh import: a prismatic STL', async () => {
    // A 30 x 20 x 10 box as a binary STL.
    const p = [[0, 0, 0], [30, 0, 0], [30, 20, 0], [0, 20, 0], [0, 0, 10], [30, 0, 10], [30, 20, 10], [0, 20, 10]].flat()
    const tri = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
    const bytes = exportBinaryStl({ positions: Float32Array.from(p), indices: Uint32Array.from(tri) }).bytes
    stlBytes.set('wo2857-stl', bytes)
    const conv = convertPrismaticMesh(importStl(bytes).mesh, { convertId: 'MSH1' })
    if (!conv.ok) throw new Error(conv.message)
    const r = await liveClient!.makeSolidFromPlanarFaces(conv.faceSet)
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    stashModelDocument([{ id: 'MSH1', kind: 'meshImport', consumes: [], payload: { fileName: 'box.stl', cacheKey: 'wo2857-stl', name: 'box' } }], false)
    await expectSameBody('MSH1', r.body!)
  }, 120_000)
})

// Sweep F7 (MINOR, unsure): Post with Contour 3 unticked logged "Recomputed
// Drill 4: Contour 3 is not part of this program" and left Drill 4 "Outdated"
// in the tree, its time gone from the setup total (18m55s -> 16m04s).
//
// The recompute itself is by design (WO-1653): a Drill after a Contour reads
// the material the Contour left (rest stock, dependsOnPredecessors), so the
// program without Contour 3 is computed for the material actually there, and
// stageOperationsForEmission's restore() puts every operation back afterwards.
//
// The suspected way Drill 4 could stay Outdated: a second compute of it
// dispatched while Contour 3 is shadow-disabled (Post Process's auto-recompute
// effect, PostProcessModal.tsx WO-2788, re-reads the preview on every store
// change and would see the shadow-outdated Drill as OP_OUTDATED) that lands
// after restore(). This pins that sequence at the store seam: the late result
// is re-stamped against the restored project and Drill 4 stays ready with the
// same moves -- so that route is not what the operator saw (see the WO's result).
describe('WO-2857 F7: a partial post leaves the excluded operation\'s successor as it was', () => {
  it('a compute of Drill 4 dispatched during the partial-post staging and landing after restore leaves it ready', async () => {
    const part = await importPart(liveClient!)
    const { nodes, result } = await DRILL_CASES[0].build(liveClient!, part)
    const liveHandle = result.body!
    ;(window as unknown as Record<string, unknown>).__solidsWorkbenchHooks = {
      getBodyHandle: (id: string) => (id === 'F1' ? liveHandle : undefined),
      client: liveClient,
    }
    stashModelDocument(nodes)
    const holeFaces = (await liveClient!.recognizeFeatures(liveHandle))
      .filter((v) => HOLE_CLASSES.includes(v.featureClass)).flatMap((v) => v.faceIds ?? [])
    installProject('F1', [...new Set(holeFaces)])
    // "Contour 3" stand-in: an earlier operation whose cut Drill 4 reads.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: s.project.setups.map((st) => ({
          ...st,
          operations: [{ ...st.operations[0], id: 'wo2857-contour3', name: 'Contour 3' }, ...st.operations],
        })),
      },
    }))
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, 'wo2857-contour3')
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, DRILL_ID)
    expect(drill().status, drill().errorMessage).toBe('ready')
    expect((drill() as { dependsOnPredecessors?: boolean }).dependsOnPredecessors, 'Drill 4 reads what Contour 3 left').toBe(true)
    const before = drill()

    // Post with Contour 3 unticked: Drill 4 recomputed for this program.
    const staged = await useCamStore.getState().stageOperationsForEmission(SETUP_ID, [DRILL_ID])
    expect(staged.recomputed.map((r) => r.opId)).toEqual([DRILL_ID])
    expect(consoleText()).toMatch(/"Contour 3" is not part of this program/)

    // Post Process's auto-recompute picks the shadow-outdated Drill up while staging is live.
    heldReplies = []
    dispatchedOpIds.length = 0
    const late = useCamStore.getState().computeOperationToolpath(SETUP_ID, DRILL_ID)
    for (let i = 0; i < 200 && !dispatchedOpIds.includes(DRILL_ID); i++) await new Promise((r) => setTimeout(r, 5))
    expect(dispatchedOpIds, 'the compute was dispatched under the staged program').toContain(DRILL_ID)
    staged.restore() // runFreshPost's finally{}
    expect(drill().status).toBe('ready')
    const replies = heldReplies
    heldReplies = null
    replies.forEach((reply) => reply())
    await late

    // After the post the tree should show Drill 4 exactly as it was.
    expect(drill().status, 'Drill 4 after the partial post').toBe('ready')
    expect(drill().toolpathMoves).toEqual(before.toolpathMoves)
  }, 120_000)
})

// Fix round 2: lib/cam may not import components, so the pure Model-tab helpers
// the background replay calls are copied into src/lib/cam/modelWorkbenchHelpers.ts.
// A copy that drifts from the Model tab's own declaration would rebuild a
// different body in the background than the operator sees, so every copied
// declaration must stay text-identical to its source.
describe('WO-2857: the lib/cam copies of the Model-tab helpers match their sources verbatim', () => {
  /** One top-level declaration: its first line through its closing line. */
  function declarationText(text: string, name: string): string | undefined {
    const lines = text.split('\n')
    const start = lines.findIndex((line) => new RegExp(`^(export )?(function|const) ${name}\\b`).test(line))
    if (start < 0) return undefined
    const out = [lines[start]]
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line === '' || /^\s/.test(line)) { out.push(line); continue }
      if (/^[}\])]/.test(line)) {
        out.push(line)
        if (/[{([]$/.test(line)) continue
      }
      break
    }
    while (out[out.length - 1] === '') out.pop()
    return out.join('\n')
  }

  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
  const copyText = read('src/lib/cam/modelWorkbenchHelpers.ts')
  const sections = [...copyText.matchAll(/^\/\/ ---- verbatim from (\S+) ----$/gm)]

  it('copies from all six Model-tab modules', () => {
    expect(sections.map((m) => m[1])).toEqual([
      'src/components/model3d/workbench/regionSelector.ts',
      'src/components/model3d/workbench/extrudeParams.ts',
      'src/components/model3d/workbench/featureDimension.ts',
      'src/components/model3d/workbench/basePlanes.ts',
      'src/components/model3d/bodyLineage.ts',
      'src/components/model3d/dialogs/dressUpGeometry.ts',
    ])
  })

  it.each(sections.map((m, i) => [m[1], i] as const))('%s', (source, index) => {
    const from = sections[index].index! + sections[index][0].length
    const to = index + 1 < sections.length ? sections[index + 1].index! : copyText.length
    const names = [...copyText.slice(from, to).matchAll(/^(?:export )?(?:function|const) (\w+)/gm)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(0)
    const sourceText = read(source)
    for (const name of names) {
      expect(declarationText(copyText, name), `${name} in ${source}`).toBe(declarationText(sourceText, name))
    }
  })
})
