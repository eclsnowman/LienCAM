// @vitest-environment jsdom
//
// WO-3231 (WO-3172 Draft D): a project with a curved-path Sweep, opened
// straight into CAM, rebuilds the SAME body the Model page builds -- without
// mounting the Model page.
//
// The live side of each case builds the body with the request the Model
// page's replay executor builds for a sketch-path Sweep (WO-3230): the profile
// region, the path from the ONE resolver (src/geom/sweep-path.ts, WO-3228) and
// transition 'rightCorner' (WO-3229). The background side is the production
// headless replay (modelBodyHoleRecognition.ts -> headlessFeatureReplay.ts)
// reading the held document, with no workbench hooks. Volumes are judged
// against closed forms; faces and stable ids against the live body.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))

// jsdom's localStorage is broken under vitest's node launch flags; the store's
// persist() writes on every set() (same shim as reopenedModelRefs.wo2857).
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
  resolveModelReferencesHeadless,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { BASE_PLANE_XY_NODE_ID, BASE_PLANE_YZ_NODE_ID } = await import('../../doc/genesis')
const { basePlaneFrame } = await import('../../components/model3d/workbench/basePlanes')
const { extractSketchProfile } = await import('../../components/model3d/workbench/sketchProfile')
const { resolveSweepPathChain } = await import('../../geom/sweep-path')
const { buildAxisPathChain } = await import('../../components/model3d/dialogs/dressUpGeometry')
const { GeometryCache } = await import('../../viewport3d')
const { progressiveTessellate } = await import('../../viewport3d/progressiveTessellate')
const { modelBodyDisplayFromCached } = await import('../../viewport3d/modelBodyDisplay')

import type { GeomClient } from '../../geom'
import type { BodyHandle, OpResult, ProfileRegion, SweepRequest } from '../../geom/geom-service'
import type { FeatureDag } from '../../doc'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const QUARTER_TUBE_MM3 = 394.7841760435743 // pi * 2^2 * (pi * 20 / 2)
const L_PATH_MM3 = 502.6548245743669 // pi * 2^2 * (20 + 20), right mitre
const REL = 1e-6
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b)

const line = (id: string, [sx, sy]: number[], [ex, ey]: number[]): SketchEntity =>
  ({ id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } }) as SketchEntity
const arc = (id: string, [cx, cy]: number[], radius: number, startAngle: number, endAngle: number): SketchEntity =>
  ({ id, kind: 'arc', construction: false, center: { x: cx, y: cy }, radius, startAngle, endAngle }) as SketchEntity
const circle = (id: string, [cx, cy]: number[], radius: number): SketchEntity =>
  ({ id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius }) as SketchEntity
const sketchOf = (id: string, entities: SketchEntity[]): Sketch =>
  ({ id, layerId: 'L1', constraints: [], dimensions: [], solveStatus: null, entities }) as unknown as Sketch

/** Quarter arc R 20 on XY: starts at the origin heading +X, ends at (20, 20). */
const QUARTER: SketchEntity[] = [arc('pa0', [0, 20], 20, -Math.PI / 2, 0)]
/** L path on XY: (0,0) -> (20,0) -> (20,20). */
const L_PATH: SketchEntity[] = [line('pl0', [0, 0], [20, 0]), line('pl1', [20, 0], [20, 20])]

const OFFSET_PLANE = 'datum:OP1'
function offsetPlanePayload(distance: number): Record<string, unknown> {
  return {
    datumType: 'plane', planeKind: 'offset-plane', payloadSchema: 1, name: 'Offset 1',
    definition: { kind: 'offset', distance, flipNormal: false },
    lastGoodFrame: { origin: { x: 0, y: 0, z: distance }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
  }
}

interface NodeSpec { id: string; kind: 'sketch' | 'feature' | 'datum'; consumes: string[]; payload: Record<string, unknown> }

/** The circle r 2 profile on YZ (perpendicular to every path's start) and its region. */
async function profileSketch(id = 'S1', center: number[] = [0, 0]): Promise<{ node: NodeSpec; profile: ProfileRegion }> {
  const sketch = sketchOf(id, [circle(`${id}c`, center, 2)])
  const extracted = await extractSketchProfile(sketch, basePlaneFrame(BASE_PLANE_YZ_NODE_ID)!, id)
  if (!extracted.ok) throw new Error(extracted.refusal.message)
  return {
    node: { id: `sketch3d:${id}`, kind: 'sketch', consumes: [BASE_PLANE_YZ_NODE_ID], payload: { sketch, planeNodeId: BASE_PLANE_YZ_NODE_ID } },
    profile: extracted.regions[0],
  }
}

function pathSketch(id: string, entities: SketchEntity[], planeNodeId = BASE_PLANE_XY_NODE_ID): NodeSpec {
  return { id: `sketch3d:${id}`, kind: 'sketch', consumes: [planeNodeId], payload: { sketch: sketchOf(id, entities), planeNodeId } }
}

function sweepNode(id: string, profileNode: NodeSpec, path: Record<string, unknown> | undefined, consumes?: string[]): NodeSpec {
  const pathSketchId = typeof path?.sketchId === 'string' ? path.sketchId : undefined
  return {
    id, kind: 'feature',
    consumes: consumes ?? (pathSketchId === undefined ? [profileNode.id] : [profileNode.id, pathSketchId]),
    payload: {
      opType: 'sweep', sketchId: profileNode.id, profileSelector: { kind: 'whole-sketch' },
      axis: 'z', length: 12, orientation: 'frenet', name: `Sweep ${id}`,
      ...(path === undefined ? {} : { path }),
    },
  }
}

function chain(sketchNodeId: string, entityIds: string[]): Record<string, unknown> {
  return { kind: 'sketch-chain', sketchId: sketchNodeId, steps: entityIds.map((entityId) => ({ entityId, forward: true })) }
}

function documentDag(nodes: NodeSpec[], datums: NodeSpec[] = []): FeatureDag {
  const dag = newSeededModelDag()
  for (const n of [...datums, ...nodes]) dag.insertNode({ id: n.id, kind: n.kind, consumes: n.consumes, refs: [], payload: n.payload })
  return dag
}

/** The Model page's request for a sketch-path Sweep (WO-3230 live branch). */
function liveSweepRequest(dag: FeatureDag, featureId: string, profile: ProfileRegion): SweepRequest {
  const node = dag.getNode(featureId)!
  const resolved = resolveSweepPathChain(node.payload.path, (id) => dag.getNode(id))
  if (!resolved.ok) throw new Error(resolved.diagnostic.message)
  return { featureId, profile, path: resolved.path, orientation: node.payload.orientation as 'frenet', op: 'newBody', transition: 'rightCorner' }
}

interface HeadlessSweep { req: SweepRequest; ok: boolean; volume?: number }
/** Every makeSweep the background replay issued this test, with the built body's volume. */
const headlessSweeps: HeadlessSweep[] = []
function capturingHeadlessClient(): GeomClient {
  const client = createLocalGeomService()
  const makeSweep = client.makeSweep.bind(client)
  client.makeSweep = async (req: SweepRequest): Promise<OpResult> => {
    const r = await makeSweep(req)
    const rec: HeadlessSweep = { req, ok: r.ok }
    if (r.ok && r.body !== undefined) rec.volume = (await client.measure(r.body, 'volume')).value
    headlessSweeps.push(rec)
    return r
  }
  return client
}

/** A thrown read as a value, so a refusal fails at the assertion that names it. */
async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await p }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The background rebuild of `bodyId` judged against the live body: every live
 *  face id resolves exact, and two faces read back the same analytic facts. */
async function expectSameBody(bodyId: string, liveHandle: BodyHandle): Promise<void> {
  expect((window as unknown as Record<string, unknown>).__solidsWorkbenchHooks, 'the Model page is not mounted').toBeUndefined()
  const liveSnapshots = await liveClient!.snapshotsFor(liveHandle)
  const faces = Object.keys(liveSnapshots).sort()
  expect(faces.length, 'the live body has faces').toBeGreaterThan(0)
  const resolved = await settle(resolveModelReferencesHeadless('legacy', new Map([[bodyId, faces]])))
  expect(resolved.error, 'the background rebuild of the curved sweep').toBeUndefined()
  expect(resolved.value![0].resolutions.filter((r) => r.status !== 'exact')).toEqual([])
  for (const faceId of new Set([faces[0], faces[faces.length - 1]])) {
    const { snapshot } = await readModelBodyFaceFacts(bodyId, faceId, 'legacy')
    const want = liveSnapshots[faceId]
    expect(snapshot.type).toBe(want.type)
    expect(snapshot.area).toBeCloseTo(want.area, 6)
    expect(snapshot.centroid.map((v) => +v.toFixed(6))).toEqual(want.centroid.map((v) => +v.toFixed(6)))
  }
}

/** The CAM row the Model page publishes for the live body (its own tessellation route). */
async function publishLiveBody(bodyId: string, handle: BodyHandle): Promise<void> {
  const cache = new GeometryCache()
  try {
    await progressiveTessellate(liveClient!, cache, bodyId, handle)
    const cached = cache.get(bodyId)!
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId, name: 'Tube' }],
      derived: [{ bodyId, version: cached.version, stableIds: [...cached.faceIds, ...cached.edgeIds], display: modelBodyDisplayFromCached(cached) }],
    })
  } finally {
    cache.disposeAll()
  }
}

let liveClient: GeomClient | null = null
let savedProjectText = ''

beforeEach(async () => {
  mem.clear()
  headlessSweeps.length = 0
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.getState().newProject()
  __setModelBodyHeadlessClientFactoryForTests(capturingHeadlessClient)
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-3231.camproject'
    },
  })
  liveClient = createLocalGeomService()
  await liveClient.init()
})

afterEach(async () => {
  delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
  vi.unstubAllGlobals()
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  if (liveClient !== null) await liveClient.terminate().catch(() => undefined)
  liveClient = null
})

describe('WO-3231: a curved-path Sweep replays headless in CAM', () => {
  it('reopens directly in CAM and reconstructs the same curved body without mounting Model', async () => {
    for (const [name, entities, analytic] of [['quarter tube', QUARTER, QUARTER_TUBE_MM3], ['L path', L_PATH, L_PATH_MM3]] as const) {
      headlessSweeps.length = 0
      const { node: prof, profile } = await profileSketch()
      const path = pathSketch('P1', [...entities])
      const sweep = sweepNode('F1', prof, chain(path.id, entities.map((e) => e.id)))
      const dag = documentDag([prof, path, sweep])

      // Session 1: the Model page holds the body and publishes its CAM row.
      const live = await liveClient!.makeSweep(liveSweepRequest(dag, 'F1', profile))
      expect(live.ok, JSON.stringify(live.diagnostics)).toBe(true)
      const liveVolume = (await liveClient!.measure(live.body!, 'volume')).value
      expect(rel(liveVolume, analytic), `${name}: live volume`).toBeLessThan(REL)
      stashLoadedDocument(finalizeSeedArchive(dag))
      await publishLiveBody('F1', live.body!)
      await useCamStore.getState().saveProjectToFile()
      expect(JSON.parse(savedProjectText).document, 'the model rides in the file').toEqual(expect.any(String))

      // Close, then open the file straight into CAM.
      resetDocumentHolder()
      setDocumentStorage(new InMemoryDocumentStorage())
      useCamStore.setState(useCamStore.getInitialState(), true)
      await useCamStore.getState().loadProjectFromFile(savedProjectText)
      expect(useCamStore.getState().project.geometry.some((g) => g.modelBody?.ref.bodyId === 'F1'), `${name}: the reopened row`).toBe(true)

      await expectSameBody('F1', live.body!)
      expect(headlessSweeps.length, `${name}: the background replay swept`).toBeGreaterThan(0)
      for (const rec of headlessSweeps) {
        expect(rec.req.transition, `${name}: right-corner construction`).toBe('rightCorner')
        expect(rec.req.path.segments.map((s) => s.srcId), `${name}: the path is the sketch's curves`).toEqual(entities.map((e) => e.id))
        expect(rel(rec.volume!, analytic), `${name}: background volume ${rec.volume}`).toBeLessThan(REL)
        expect(rel(rec.volume!, liveVolume), `${name}: background volume vs live`).toBeLessThan(1e-9)
      }
      await liveClient!.disposeAll?.()
    }
  }, 240_000)

  it('replays native solved and package open path sketches with live plane frames', async () => {
    // A package path sketch on an offset plane: the replay reads the plane's
    // frame as it is now, so moving the plane moves the path.
    for (const distance of [5, 9]) {
      headlessSweeps.length = 0
      const { node: prof } = await profileSketch('S1', [0, distance])
      const path = pathSketch('P1', [...QUARTER], OFFSET_PLANE)
      const plane: NodeSpec = { id: OFFSET_PLANE, kind: 'datum', consumes: [BASE_PLANE_XY_NODE_ID], payload: offsetPlanePayload(distance) }
      stashLoadedDocument(finalizeSeedArchive(documentDag([prof, path, sweepNode('F1', prof, chain(path.id, ['pa0']))], [plane])))
      const resolved = await settle(resolveModelReferencesHeadless('legacy', new Map([['F1', []]])))
      expect(resolved.error, `package path on a plane at z ${distance}`).toBeUndefined()
      expect(headlessSweeps).toHaveLength(1)
      expect(headlessSweeps[0].req.path.plane.origin.z, 'the path sits on the plane as it is now').toBeCloseTo(distance, 9)
      expect(rel(headlessSweeps[0].volume!, QUARTER_TUBE_MM3)).toBeLessThan(REL)
    }

    // A native (sketch3d document) path sketch, solved by its executor on replay.
    headlessSweeps.length = 0
    const { node: prof } = await profileSketch()
    const native: NodeSpec = {
      id: 'sketch3d:N1', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID],
      payload: {
        document: { id: 'N1', entities: L_PATH.map((e) => ({ ...e })), constraints: [] },
        planeNodeId: BASE_PLANE_XY_NODE_ID,
      },
    }
    stashLoadedDocument(finalizeSeedArchive(documentDag([prof, native, sweepNode('F1', prof, chain(native.id, ['pl0', 'pl1']))])))
    const resolved = await settle(resolveModelReferencesHeadless('legacy', new Map([['F1', []]])))
    expect(resolved.error, 'native path sketch').toBeUndefined()
    expect(headlessSweeps).toHaveLength(1)
    expect(headlessSweeps[0].req.transition).toBe('rightCorner')
    expect(rel(headlessSweeps[0].volume!, L_PATH_MM3)).toBeLessThan(REL)
  }, 240_000)

  it('legacy axis archive still replays with unchanged payload geometry and face IDs', async () => {
    const { node: prof, profile } = await profileSketch()
    const sweep = sweepNode('F1', prof, undefined)
    const dag = documentDag([prof, sweep])
    const before = JSON.stringify(dag.getNode('F1')!.payload)
    const want: SweepRequest = { featureId: 'F1', profile, path: buildAxisPathChain('z', 12), orientation: 'frenet', op: 'newBody' }
    const live = await liveClient!.makeSweep(want)
    expect(live.ok, JSON.stringify(live.diagnostics)).toBe(true)
    stashLoadedDocument(finalizeSeedArchive(dag))
    await expectSameBody('F1', live.body!)
    expect(headlessSweeps.length).toBeGreaterThan(0)
    for (const rec of headlessSweeps) {
      expect(rec.req).toEqual(want)
      expect('transition' in rec.req, 'the axis sweep carries no transition').toBe(false)
    }
    expect(JSON.stringify(dag.getNode('F1')!.payload), 'the payload is untouched').toBe(before)
  }, 120_000)

  it('unknown path tag missing entity and missing producer never use stored axis values', async () => {
    const { node: prof } = await profileSketch()
    const path = pathSketch('P1', [...QUARTER])
    const cases: Array<{ name: string; nodes: NodeSpec[]; reason: RegExp }> = [
      { name: 'unknown path tag', nodes: [prof, path, sweepNode('F1', prof, { kind: 'helix', sketchId: path.id, steps: [] })], reason: /sweep path \(unsupported-path-kind\)/ },
      { name: 'missing entity', nodes: [prof, path, sweepNode('F1', prof, chain(path.id, ['gone']))], reason: /sweep path \(missing-entity\).*gone/ },
      { name: 'missing producer', nodes: [prof, sweepNode('F1', prof, chain('sketch3d:P9', ['pa0']), [prof.id])], reason: /sketch3d:P9 is not an input that comes before this sweep/ },
      { name: 'producer not consumed', nodes: [prof, path, sweepNode('F1', prof, chain(path.id, ['pa0']), [prof.id])], reason: /sketch3d:P1 is not an input that comes before this sweep/ },
    ]
    for (const c of cases) {
      headlessSweeps.length = 0
      stashLoadedDocument(finalizeSeedArchive(documentDag(c.nodes)))
      const resolved = await settle(resolveModelReferencesHeadless('legacy', new Map([['F1', []]])))
      expect(headlessSweeps.map((s) => s.req.path.segments.map((g) => g.srcId)), `${c.name}: nothing was swept`).toEqual([])
      expect(resolved.error ?? '', `${c.name}: refused by name`).toMatch(c.reason)
    }
  }, 120_000)
})
