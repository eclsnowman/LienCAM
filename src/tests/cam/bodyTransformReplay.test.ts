// @vitest-environment jsdom
//
// WO-3244: a project whose Model holds a Mirror (replace original) rebuilds the
// SAME reflected body in the background - CAM opened first, the Model page never
// mounted. The source is an imported STEP solid (the notched block), the plane an
// Offset Plane 20 mm off YZ. The background route is the production one:
// collectDocumentArchive -> loadDocumentArchive -> modelBodyHoleRecognition's
// headless pass -> headlessFeatureReplay.runHeadlessFeature -> the shared
// src/doc/features/bodyTransform.ts adapter -> GeomClient.transformBody.
//
// The block: [0,10]x[0,6]x[0,4] minus notch [0,2]x[0,3]x[2,4] = 228 mm3. Reflected
// in x=20 it spans x 30..40; its x=0 end face lands at x=40.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

let cachedStepBytes: ArrayBuffer | null = null
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => cachedStepBytes),
  removeCachedStep: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))

const { createLocalGeomService } = await import('../../geom')
const { resetDocumentHolder, stashLoadedDocument, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { finalizeSeedArchive, newSeededModelDag } = await import('../../doc/seedModelArchive')
const {
  __setModelBodyHeadlessClientFactoryForTests,
  readModelBodyFaceFacts,
  resolveModelReferencesHeadless,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { BASE_PLANE_YZ_NODE_ID } = await import('../../doc/genesis')
const { buildOffsetPlaneDatumNodeInput } = await import('../../sketch3d/datumPlane')
const { mirrorReplacePayload, bodyTransformConsumes } = await import('../../doc/features/bodyTransform')

import type { GeomClient } from '../../geom'
import type { BodyHandle, OpResult, TransformBodyRequest } from '../../geom/geom-service'

const IMPORT = 'import:block'
const MIRROR = 'F-MIRROR'

interface Captured { req: TransformBodyRequest; ok: boolean; volume?: number }
const captured: Captured[] = []
function capturingClient(): GeomClient {
  const client = createLocalGeomService()
  const transformBody = client.transformBody!.bind(client)
  client.transformBody = async (req: TransformBodyRequest): Promise<OpResult> => {
    const r = await transformBody(req)
    const rec: Captured = { req, ok: r.ok }
    if (r.ok && r.body !== undefined) rec.volume = (await client.measure(r.body, 'volume')).value
    captured.push(rec)
    return r
  }
  return client
}

let live: GeomClient | null = null

/** The notched block as an imported STEP file, and its live body. */
async function importedBlock(): Promise<BodyHandle> {
  const box = (await live!.makeBox('B', { x: 10, y: 6, z: 4 })).body!
  const notch0 = (await live!.makeBox('N0', { x: 2, y: 3, z: 2 })).body!
  const notch = (await live!.transformBody!({ featureId: 'N1', body: notch0, transform: { kind: 'translate', delta: { x: 0, y: 0, z: 2 } }, identity: 'copy' })).body!
  const block = (await live!.applyBoolean({ featureId: 'B2', op: 'cut', target: box, tools: [notch] })).body!
  cachedStepBytes = await live!.exportStep([block])
  const imported = await live!.importStep(cachedStepBytes, IMPORT)
  expect(imported.bodies.length).toBe(1)
  return imported.bodies[0].handle
}

function stashMirrorDocument(offsetMm: number, planeNodeId?: string): void {
  const dag = newSeededModelDag()
  dag.insertNode({ id: IMPORT, kind: 'import', consumes: [], refs: [], payload: { fileName: 'Block.step', cacheKey: 'block-key', name: 'Block' } })
  const { nodeId: planeId, input } = buildOffsetPlaneDatumNodeInput({ id: 'OP1', parentPlaneNodeId: BASE_PLANE_YZ_NODE_ID, distance: offsetMm })
  dag.insertNode(input)
  const payload = mirrorReplacePayload({ sourceBodyId: IMPORT, planeNodeId: planeNodeId ?? planeId, name: 'Mirror 1' })
  dag.insertNode({ id: MIRROR, kind: 'feature', consumes: bodyTransformConsumes(payload), refs: [], payload: { ...payload } })
  stashLoadedDocument(finalizeSeedArchive(dag))
}

beforeEach(async () => {
  captured.length = 0
  cachedStepBytes = null
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  __setModelBodyHeadlessClientFactoryForTests(capturingClient)
  live = createLocalGeomService()
  await live.init()
})

afterEach(async () => {
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  if (live !== null) await live.terminate().catch(() => undefined)
  live = null
})

describe('WO-3244: Mirror (replace original) replays headless', () => {
  it('rebuilds the reflected imported body with the live ids and geometry, never mounting Model', async () => {
    const source = await importedBlock()
    const liveMirror = await live!.transformBody!({
      featureId: MIRROR, body: source,
      transform: { kind: 'mirror', plane: { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } } },
      identity: 'replace',
    })
    expect(liveMirror.ok).toBe(true)
    const liveSnaps = await live!.snapshotsFor(liveMirror.body!)
    const faces = Object.keys(liveSnaps).sort()
    expect(faces.every((id) => id.startsWith(`${MIRROR}:PAT:i1:`))).toBe(true)

    stashMirrorDocument(20)
    expect((window as unknown as Record<string, unknown>).__solidsWorkbenchHooks, 'the Model page is not mounted').toBeUndefined()
    const resolved = await resolveModelReferencesHeadless('legacy', new Map([[MIRROR, faces]]))
    expect(resolved[0].resolutions.filter((r) => r.status !== 'exact')).toEqual([])

    expect(captured.length).toBeGreaterThan(0)
    for (const rec of captured) {
      expect(rec.ok).toBe(true)
      expect(rec.req.transform).toEqual({ kind: 'mirror', plane: expect.objectContaining({ origin: { x: 20, y: 0, z: 0 } }) })
      expect(rec.req.identity).toBe('replace')
      expect(Math.abs(rec.volume! - 228) / 228).toBeLessThan(1e-6)
    }
    // the face that was the block's x=0 end now sits at x=40
    const endFace = faces.find((id) => Math.abs(liveSnaps[id].centroid[0] - 40) < 1e-6 && liveSnaps[id].type === 'plane')
    expect(endFace).toBeDefined()
    const { snapshot } = await readModelBodyFaceFacts(MIRROR, endFace!, 'legacy')
    expect(snapshot.centroid[0]).toBeCloseTo(40, 6)
    expect(snapshot.area).toBeCloseTo(liveSnaps[endFace!].area, 6)
  }, 120_000)

  it('reads the plane where it is now: an offset of 22 moves the reflection +4 mm', async () => {
    const source = await importedBlock()
    const liveMirror = await live!.transformBody!({
      featureId: MIRROR, body: source,
      transform: { kind: 'mirror', plane: { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } } },
      identity: 'replace',
    })
    const liveSnaps = await live!.snapshotsFor(liveMirror.body!)
    const endFace = Object.keys(liveSnaps).find((id) => Math.abs(liveSnaps[id].centroid[0] - 40) < 1e-6 && liveSnaps[id].type === 'plane')!

    stashMirrorDocument(22)
    const { snapshot } = await readModelBodyFaceFacts(MIRROR, endFace, 'legacy')
    expect(snapshot.centroid[0]).toBeCloseTo(44, 6)
  }, 120_000)

  it('a mirror whose plane is not a plane refuses by name and builds nothing', async () => {
    await importedBlock()
    stashMirrorDocument(20, IMPORT)
    let message = ''
    try {
      await resolveModelReferencesHeadless('legacy', new Map([[MIRROR, [`${MIRROR}:PAT:i1:x`]]]))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(captured).toEqual([])
    expect(message).toMatch(/Mirror .*its plane .*could not be placed, so the body was not mirrored/)
  }, 120_000)
})

// Audit rounds 2-3: a Mirror (replace) inserted at the rollback marker before a
// feature that names the source's EDGES, FACES or world POSITIONS. The insert
// (the commands the dialog runs) moves only the feature's body carrier; the
// feature keeps its own references, and the background replay resolves them
// through the Mirror's plane where it is at that pass. Oracle: the kernel's own
// mirror of the already-finished body in that same plane - same volume and the
// same face centroids, face for face. Moving the plane re-resolves; undoing the
// insert gives the original body back.
const { runHeadlessFeature } = await import('../../lib/cam/headlessFeatureReplay')
const { CompositeCommand, InsertAtMarkerCommand, RemoveNodeCommand } = await import('../../doc')
const { RewireReplacedBodyConsumersCommand } = await import('../../doc/features/bodyTransform')
const { planFeatureDelete } = await import('../../components/model3d/tree/featureDelete')
const { lookupHeadlessLiveBody } = await import('../../lib/cam/headlessFeatureReplay')
type HeadlessReplayWorld = import('../../lib/cam/headlessFeatureReplay').HeadlessReplayWorld
type PlaneDef = import('../../geom/geom-service').PlaneDef

const yzAt = (x: number): PlaneDef => ({ origin: { x, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } })
const YZ = yzAt(0)
// the order's oblique plane: through (x0,0,0), normal (1,1,0)/sqrt2
const obliqueAt = (x: number): PlaneDef => ({ origin: { x, y: 0, z: 0 }, normal: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, xDir: { x: 0, y: 0, z: 1 } })

async function centroids(body: BodyHandle): Promise<number[][]> {
  const snaps = await live!.snapshotsFor(body)
  return Object.values(snaps).map((s) => [...s.centroid]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
}

async function expectSameSolid(after: OpResult | undefined, oracle: BodyHandle): Promise<void> {
  expect(after?.ok, JSON.stringify(after?.diagnostics)).toBe(true)
  const got = (await live!.measure(after!.body!, 'volume')).value
  const want = (await live!.measure(oracle, 'volume')).value
  expect(Math.abs(got - want)).toBeLessThan(1e-6 * want)
  // face for face: every centroid has its own partner within 1e-6 mm (matched
  // as a set - an oblique plane leaves coordinate ties a sort cannot order)
  const a = await centroids(after!.body!)
  const b = await centroids(oracle)
  expect(a.length).toBe(b.length)
  const unmatched = [...b]
  for (const c of a) {
    const k = unmatched.findIndex((o) => o.every((v, j) => Math.abs(v - c[j]) < 1e-6))
    expect(k, `face centroid ${c.join(', ')} has a partner on the oracle`).toBeGreaterThanOrEqual(0)
    unmatched.splice(k, 1)
  }
}

/**
 * Box B [0,10]x[0,6]x[0,4] and a later feature F on it; then a Mirror M is
 * inserted before F through the production commands, its plane an Offset Plane
 * node. For each plane in `planes`: the plane is moved there, M and F replay
 * headless, and F is checked against the kernel mirror of the finished body.
 */
async function laterFeatureThroughMirror(later: (edge: string) => Record<string, unknown>, planes: PlaneDef[]) {
  const box = (await live!.makeBox('B', { x: 10, y: 6, z: 4 })).body!
  const tess = await live!.tessellate(box, { deflection: 0.1, angularDeflection: 0.5 })
  const edge = tess.edgeIds.find((id) => id.includes('B:BOX:xMax') && id.includes('B:BOX:yMax'))
  expect(edge, 'the x=10,y=6 vertical edge').toBeDefined()
  const dag = newSeededModelDag()
  dag.insertNode({ id: 'B', kind: 'import', payload: {} })
  const { nodeId: planeId, input } = buildOffsetPlaneDatumNodeInput({ id: 'MP', parentPlaneNodeId: BASE_PLANE_YZ_NODE_ID, distance: 0 })
  dag.insertNode(input)
  const movePlane = (plane: PlaneDef): void => {
    dag.setPayload(planeId, { ...dag.getNode(planeId)!.payload, lastGoodFrame: plane })
  }
  const stored = { ...later(edge!), ownerId: 'B', name: 'Later F' }
  dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: stored })
  const world = {
    dag, client: live!, bodyHandles: new Map([['B', box]]), scheduler: { statusOf: () => 'ok' }, modelItemId: 'wo3244',
  } as unknown as HeadlessReplayWorld
  const before = await runHeadlessFeature(world, dag.getNode('F')!)
  expect(before?.ok, JSON.stringify(before?.diagnostics)).toBe(true)
  world.bodyHandles.delete('F')

  dag.setRollbackMarker({ kind: 'after', nodeId: planeId })
  const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: planeId, name: 'Mirror' })
  const insert = new CompositeCommand([
    new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } }),
    new RewireReplacedBodyConsumersCommand('M', 'B'),
  ])
  insert.do(dag)
  dag.setRollbackMarker({ kind: 'end' })
  // the stored feature keeps its own references; only its body moved
  expect(dag.getNode('F')!.payload).toEqual({ ...stored, ownerId: 'M' })

  const replays: Array<{ plane: PlaneDef; after: OpResult | undefined; oracle: BodyHandle }> = []
  for (const plane of planes) {
    movePlane(plane)
    world.bodyHandles.delete('M')
    world.bodyHandles.delete('F')
    const mirror = await runHeadlessFeature(world, dag.getNode('M')!)
    expect(mirror?.ok, JSON.stringify(mirror?.diagnostics)).toBe(true)
    const after = await runHeadlessFeature(world, dag.getNode('F')!)
    const oracle = await live!.transformBody!({ featureId: 'ORACLE', body: before!.body!, transform: { kind: 'mirror', plane }, identity: 'copy' })
    expect(oracle.ok).toBe(true)
    replays.push({ plane, after, oracle: oracle.body! })
  }
  expect(dag.getNode('F')!.payload).toEqual({ ...stored, ownerId: 'M' })
  return { dag, world, edge: edge!, before: before!, replays, insert, stored }
}

const HOLE = {
  opType: 'hole', faceId: 'B:BOX:zMax', points: [{ x: 3, y: 3, z: 4 }],
  style: { kind: 'simple', diameter: 1 }, depth: { kind: 'blind', distance: 2 },
}

describe('WO-3244 audit rounds 2-3: a later feature replays on the reflection through the Mirror plane where it is now', () => {
  it('a fillet on one edge replays on the mirrored edge, and follows the plane moved from x=0 to x=20', async () => {
    const { dag, edge, replays } = await laterFeatureThroughMirror((e) => ({ opType: 'fillet', edges: [e], radius: 0.5, propagateTangent: true }), [YZ, yzAt(20)])
    expect(dag.getNode('F')!.payload.edges).toEqual([edge])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
    const band = (await live!.snapshotsFor(replays[1].after!.body!))['F:FIL:(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)']
    expect(band, 'the fillet band is named from the mirrored edge').toBeDefined()
    expect(band.centroid[0]).toBeGreaterThan(30)
  }, 180_000)

  it('a chamfer on one edge replays on the mirrored edge at each plane position', async () => {
    const { replays } = await laterFeatureThroughMirror((e) => ({ opType: 'chamfer', edges: [e], distance: 0.5, propagateTangent: true }), [YZ, yzAt(20)])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
  }, 180_000)

  it('a shell opened on one face replays on the mirrored face', async () => {
    const { dag, replays } = await laterFeatureThroughMirror(() => ({ opType: 'shell', removeFaces: ['B:BOX:zMax'], thickness: 0.5 }), [YZ])
    expect(dag.getNode('F')!.payload.removeFaces).toEqual(['B:BOX:zMax'])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
  }, 180_000)

  // Audit round 3, finding 1: the carried hole point was frozen at the
  // insertion plane, so moving the plane to x=20 put it at x=-3, outside the
  // reflected top face (HOLE_FAILED). It must land at 2*20-3 = 37.
  it('a blind hole replays at the reflected point for the plane at x=0 and again after it moves to x=20', async () => {
    const { dag, replays } = await laterFeatureThroughMirror(() => ({ ...HOLE }), [YZ, yzAt(20)])
    expect(dag.getNode('F')!.payload.points).toEqual([{ x: 3, y: 3, z: 4 }])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
    const volume = (await live!.measure(replays[1].after!.body!, 'volume')).value
    expect(Math.abs(volume - (240 - Math.PI * 0.25 * 2))).toBeLessThan(1e-6 * 240)
  }, 180_000)

  // Audit round 3, finding 2: every pull direction has a reflected form -
  // pull in the mirror plane, along its normal, and oblique to it.
  it('a draft pulled in the mirror plane (+z) replays on the reflection at each plane position', async () => {
    const { replays } = await laterFeatureThroughMirror(() => ({ opType: 'draft', faces: ['B:BOX:xMax', 'B:BOX:yMax'], angleDeg: 3, pullAxis: 'z', pullFlip: false, offset: 0 }), [YZ, yzAt(20)])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
  }, 180_000)

  it('a draft pulled along the mirror normal (+x) replays with the pull reversed and the neutral plane reflected', async () => {
    const { replays } = await laterFeatureThroughMirror(() => ({ opType: 'draft', faces: ['B:BOX:yMax', 'B:BOX:zMax'], angleDeg: 3, pullAxis: 'x', pullFlip: false, offset: 0 }), [YZ, yzAt(20)])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
  }, 180_000)

  it('a draft pulled along +x replays across the order\'s oblique plane, moved from (2,0,0) to (5,0,0)', async () => {
    const { replays } = await laterFeatureThroughMirror(() => ({ opType: 'draft', faces: ['B:BOX:yMax', 'B:BOX:zMax'], angleDeg: 3, pullAxis: 'x', pullFlip: false, offset: 1 }), [obliqueAt(2), obliqueAt(5)])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
  }, 180_000)

  // The order's oblique plane reflects +x onto -y, a principal axis again. A
  // plane at 30 deg to XY (normal (0,-1/2,sqrt3/2)) reflects +z onto
  // (0,sqrt3/2,-1/2): the kernel drafts in a frame turned by 60 deg and turns
  // the drafted body back (geom-engine #rebindByRotation surface points).
  it('a draft pulled along +z replays across a plane at 30 deg, where the reflected pull is on no principal axis', async () => {
    const tiltedAt = (z: number): PlaneDef => ({ origin: { x: 0, y: 0, z }, normal: { x: 0, y: -0.5, z: Math.sqrt(3) / 2 }, xDir: { x: 1, y: 0, z: 0 } })
    const { replays } = await laterFeatureThroughMirror(() => ({ opType: 'draft', faces: ['B:BOX:xMax', 'B:BOX:yMax'], angleDeg: 3, pullAxis: 'z', pullFlip: false, offset: 1 }), [tiltedAt(0), tiltedAt(3)])
    for (const { after, oracle } of replays) await expectSameSolid(after, oracle)
  }, 180_000)

  it('undoing the Mirror insert, or deleting the Mirror from the tree, gives back the body as it was before', async () => {
    const { dag, world, before, insert, stored } = await laterFeatureThroughMirror(() => ({ ...HOLE }), [yzAt(20)])
    // undo: the hole moves back onto B with its own (never rewritten) point
    insert.undo(dag)
    expect(dag.getNode('M')).toBeUndefined()
    expect(dag.getNode('F')!.payload).toEqual(stored)
    world.bodyHandles.delete('F')
    world.bodyHandles.delete('M')
    const undone = await runHeadlessFeature(world, dag.getNode('F')!)
    expect(undone?.ok, JSON.stringify(undone?.diagnostics)).toBe(true)
    await expectSameSolid(undone, before.body!)
    // redo then delete from the tree: the existing dependent-delete plan takes
    // the Mirror and what was built on it, and B is live again
    insert.do(dag)
    const plan = planFeatureDelete(dag, 'M')
    expect(plan.ok && [...plan.idsToRemove].sort()).toEqual(['F', 'M'])
    if (!plan.ok) return
    new CompositeCommand(plan.removalOrder.map((id) => new RemoveNodeCommand(id))).do(dag)
    world.bodyHandles.delete('F')
    world.bodyHandles.delete('M')
    expect(lookupHeadlessLiveBody(dag, world.bodyHandles, 'B')).toBeDefined()
  }, 180_000)
})
