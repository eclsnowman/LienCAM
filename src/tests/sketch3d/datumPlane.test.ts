import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import type { GeometrySnapshot } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { boxFaceId, mintBooleanFragments } from '../../doc/stable-id'
import type { ElementMapDelta, StableId } from '../../geom/geom-service'
import type { DagNodeSnapshot, FeatureOp } from '../../doc'
import {
  createFacePlaneDatumNode,
  makeDatumPlaneExecutor,
  reattachFacePlaneDatum,
  type DatumPlanePayload,
} from '../../sketch3d/datumPlane'

// WO SKC-5 acceptance criteria 1 (logic-level companion to the real-kernel
// integration test), 2, 3, 4, matching the audit-note requirements from
// SKC-7.audit.json: refs live in node.refs (never payload), and the frame is
// written by the datum's OWN FeatureOp executor. Mirrors tnp-regression.test.ts's
// fixture style (boxFaceId/mintBooleanFragments/hand-built deltas) -- the SAME
// canonical scenarios, now driving the datum layer built on top of them.

const plane = (centroid: GeometrySnapshot['centroid'], area: number, normal: GeometrySnapshot['normal'] = { x: 0, y: 0, z: 1 }): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid,
  area,
  normal,
})

const delta = (p: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...p,
})

const TOP = boxFaceId('F1', 'zmax')

/** A trivial mock body-producer for 'feature' nodes -- always ok, applies the
 *  delta it was constructed with. Mirrors src/tests/doc/regen/_helpers.ts's
 *  makeExecutor shape (kept local since that helper is scoped to its own
 *  test directory, not a shared export). */
function boxExecutor(boxDelta: ElementMapDelta): FeatureOp {
  return async (node: DagNodeSnapshot) => (node.id === 'F1' ? { ok: true, elementMap: boxDelta, diagnostics: [] } : { ok: true, diagnostics: [] })
}

function composeExecutor(dag: FeatureDag, map: ElementMap, boxDelta: ElementMapDelta): FeatureOp {
  const box = boxExecutor(boxDelta)
  const datum = makeDatumPlaneExecutor(dag, map)
  return async (node: DagNodeSnapshot) => (node.kind === 'datum' ? datum(node) : box(node))
}

function buildBoxAndDatum(): { dag: FeatureDag; map: ElementMap; boxDelta: ElementMapDelta; datumId: string } {
  const dag = new FeatureDag()
  const map = new ElementMap()
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
  const boxDelta = delta({
    featureId: 'F1',
    generated: [boxFaceId('F1', 'xmin'), boxFaceId('F1', 'xmax'), boxFaceId('F1', 'ymin'), boxFaceId('F1', 'ymax'), boxFaceId('F1', 'zmin'), TOP],
    geometry: { [TOP]: plane({ x: 0, y: 0, z: 10 }, 100) },
  })
  const datumId = createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: TOP })
  return { dag, map, boxDelta, datumId }
}

describe('face-plane datum: refs live in node.refs, never payload (audit note 1)', () => {
  it('createFacePlaneDatumNode puts the face stable-ID in refs and leaves payload config-only', () => {
    const { dag, datumId } = buildBoxAndDatum()
    const node = dag.getNode(datumId)!
    expect(node.refs).toEqual([{ id: TOP, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
    expect(node.consumes).toEqual(['F1'])
    const payload = node.payload as DatumPlanePayload
    expect(payload).not.toHaveProperty('face')
    expect(payload).not.toHaveProperty('faceId')
    expect(payload.datumType).toBe('plane')
    expect(payload.planeKind).toBe('face-plane')
  })

  it('marking the owning feature dirty reaches the datum via `consumes` (not just `refs`)', () => {
    const { dag, map, datumId } = buildBoxAndDatum()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    expect(scheduler.dirtyIds()).toContain(datumId)
  })
})

describe('AC #1: exact single-face bind resolves and the executor computes a frame', () => {
  it('binds exactly and writes lastGoodFrame = {origin: centroid, normal, projected-model-X}', async () => {
    const { dag, map, boxDelta, datumId } = buildBoxAndDatum()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    const result = await scheduler.run(composeExecutor(dag, map, boxDelta))
    expect(result.executed).toContain(datumId)
    expect(scheduler.statusOf(datumId)).toBe('ok')

    const node = dag.getNode(datumId)!
    expect(node.degraded).toBe(false)
    const payload = node.payload as DatumPlanePayload
    expect(payload.lastGoodFrame).toBeDefined()
    expect(payload.lastGoodFrame!.origin).toEqual({ x: 0, y: 0, z: 10 })
    expect(payload.lastGoodFrame!.normal).toEqual({ x: 0, y: 0, z: 1 })
    // projected-model-X policy: world X projects cleanly onto a Z-normal plane.
    expect(payload.lastGoodFrame!.xDir.x).toBeCloseTo(1, 9)
    expect(payload.lastGoodFrame!.xDir.y).toBeCloseTo(0, 9)
  })
})

describe('AC #2: a parent parameter edit moves the face -> the datum frame follows, xDir stays continuous', () => {
  it('re-running with a moved TOP centroid updates origin but preserves xDir direction', async () => {
    const { dag, map, boxDelta, datumId } = buildBoxAndDatum()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    await scheduler.run(composeExecutor(dag, map, boxDelta))
    const firstXDir = (dag.getNode(datumId)!.payload as DatumPlanePayload).lastGoodFrame!.xDir

    // A parameter edit re-executes F1: TOP survives (retrim, same id) but its
    // centroid moved (the box grew taller).
    const movedDelta = delta({ featureId: 'F1-regen', modified: { [TOP]: [TOP] }, geometry: { [TOP]: plane({ x: 0, y: 0, z: 25 }, 100) } })
    const movedExecutor: FeatureOp = async (node) =>
      node.id === 'F1' ? { ok: true, elementMap: movedDelta, diagnostics: [] } : composeExecutor(dag, map, boxDelta)(node)
    scheduler.markDirty('F1')
    await scheduler.run(movedExecutor)

    const node = dag.getNode(datumId)!
    expect(node.degraded).toBe(false)
    const frame = (node.payload as DatumPlanePayload).lastGoodFrame!
    expect(frame.origin).toEqual({ x: 0, y: 0, z: 25 })
    expect(frame.xDir.x).toBeCloseTo(firstXDir.x, 9)
    expect(frame.xDir.y).toBeCloseTo(firstXDir.y, 9)
  })
})

describe('AC #3: parent face deleted -> honest degrade (never silent rebind); minimal reattach recovers', () => {
  it('deleting TOP degrades the datum and RETAINS lastGoodFrame; reattach + regen recovers', async () => {
    const { dag, map, boxDelta, datumId } = buildBoxAndDatum()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    await scheduler.run(composeExecutor(dag, map, boxDelta))
    const lastGood = (dag.getNode(datumId)!.payload as DatumPlanePayload).lastGoodFrame!

    // F1 regenerates and TOP no longer exists (no successor) -- honest deletion.
    const deleteDelta = delta({ featureId: 'F1-shrink', deleted: [TOP] })
    const deleteExecutor: FeatureOp = async (node) => (node.id === 'F1' ? { ok: true, elementMap: deleteDelta, diagnostics: [] } : { ok: true, diagnostics: [] })
    scheduler.markDirty('F1')
    await scheduler.run(async (node) => (node.kind === 'datum' ? makeDatumPlaneExecutor(dag, map)(node) : deleteExecutor(node)))

    const degradedNode = dag.getNode(datumId)!
    expect(degradedNode.degraded).toBe(true)
    expect(degradedNode.diagnostics.some((d) => d.code === 'REFERENCE_UNRESOLVED')).toBe(true)
    expect(scheduler.statusOf(datumId)).toBe('degraded')
    // Never silently rebound: refs still name the lost TOP id.
    expect(degradedNode.refs).toEqual([{ id: TOP, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
    // lastGoodFrame retained for display/repair, not wiped.
    expect((degradedNode.payload as DatumPlanePayload).lastGoodFrame).toEqual(lastGood)

    // Minimal reattach (Q5): re-pick a different live face on F1.
    const XMAX = boxFaceId('F1', 'xmax')
    map.applyDelta(delta({ featureId: 'seed-xmax-geom', geometry: { [XMAX]: plane({ x: 5, y: 0, z: 5 }, 80, { x: 1, y: 0, z: 0 }) } }))
    reattachFacePlaneDatum(dag, datumId, { ownerId: 'F1', faceId: XMAX })
    scheduler.markDirty(datumId)
    const repaired = await scheduler.run(makeDatumPlaneExecutor(dag, map))
    expect(repaired.executed).toContain(datumId)

    const repairedNode = dag.getNode(datumId)!
    expect(repairedNode.degraded).toBe(false)
    expect(repairedNode.refs).toEqual([{ id: XMAX, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
    const repairedFrame = (repairedNode.payload as DatumPlanePayload).lastGoodFrame!
    expect(repairedFrame.origin).toEqual({ x: 5, y: 0, z: 5 })
    expect(repairedFrame.normal).toEqual({ x: 1, y: 0, z: 0 })
  })
})

describe('AC #4: parent face split -> deterministic winner when confident, degrade otherwise', () => {
  function splitFixture(withParentSnapshot: boolean): { dag: FeatureDag; map: ElementMap; datumId: string; eastId: StableId; westId: StableId } {
    const dag = new FeatureDag()
    const map = new ElementMap()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    // AC #4's "degrade otherwise" branch: pickSplitWinner (element-map.ts)
    // can only disambiguate a split against the PARENT's own last-known
    // snapshot -- with none recorded, it returns undefined (never guesses)
    // and resolve() degrades to lost. A biased-vs-tied centroid does NOT
    // itself produce ambiguity (ties break deterministically on sorted id,
    // by design -- see element-map.ts's pickSplitWinner comment), so the
    // genuine "cannot decide" case this WO must prove is "no parent
    // snapshot to disambiguate against" instead.
    if (withParentSnapshot) {
      map.applyDelta(delta({ featureId: 'F1', generated: [TOP] }), { [TOP]: plane({ x: 2.5, y: 0, z: 10 }, 100) })
    } else {
      map.applyDelta(delta({ featureId: 'F1', generated: [TOP] }))
    }
    const frags = mintBooleanFragments('F5', 'CUT', TOP, [
      { centroid: { x: 3, y: 0, z: 10 }, area: 50, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'east' },
      { centroid: { x: -3, y: 0, z: 10 }, area: 50, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'west' },
    ]).fragments
    const snaps: Record<string, GeometrySnapshot> = {}
    for (const f of frags) snaps[f.id] = plane(f.seed.centroid, 50)
    map.applyDelta(delta({ featureId: 'F5', modified: { [TOP]: frags.map((f) => f.id) } }), snaps)
    const datumId = createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: TOP })
    const eastId = frags.find((f) => f.seed.centroid.x === 3)!.id
    const westId = frags.find((f) => f.seed.centroid.x === -3)!.id
    return { dag, map, datumId, eastId, westId }
  }

  it('a confidently-biased parent snapshot resolves to the deterministic overlap winner', async () => {
    const { dag, map, datumId, eastId } = splitFixture(true)
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty(datumId)
    await scheduler.run(makeDatumPlaneExecutor(dag, map))
    const node = dag.getNode(datumId)!
    expect(node.degraded).toBe(false)
    expect(node.refs).toEqual([{ id: TOP, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
    const frame = (node.payload as DatumPlanePayload).lastGoodFrame!
    expect(frame.origin).toEqual({ x: 3, y: 0, z: 10 })
    void eastId
  })

  it('a split with no parent snapshot to disambiguate against degrades rather than guessing', async () => {
    const { dag, map, datumId } = splitFixture(false)
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty(datumId)
    await scheduler.run(makeDatumPlaneExecutor(dag, map))
    const node = dag.getNode(datumId)!
    expect(node.degraded).toBe(true)
    expect(node.diagnostics.some((d) => d.code === 'REFERENCE_UNRESOLVED')).toBe(true)
  })
})

describe('non-planar / missing-normal snapshot fails the op honestly rather than fabricating a frame', () => {
  it('a face snapshot with no captured normal returns ok:false with a typed diagnostic', async () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    const faceNoNormal = boxFaceId('F1', 'zmax')
    map.applyDelta(delta({ featureId: 'F1', generated: [faceNoNormal] }), { [faceNoNormal]: { surfaceType: 'cylinder', centroid: { x: 0, y: 0, z: 0 }, area: 10 } })
    const datumId = createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: faceNoNormal })
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty(datumId)
    await scheduler.run(makeDatumPlaneExecutor(dag, map))
    expect(scheduler.statusOf(datumId)).toBe('failed')
    const diags = scheduler.diagnosticsOf(datumId)
    expect(diags.some((d) => d.code === 'KERNEL_OP_FAILED')).toBe(true)
  })
})
