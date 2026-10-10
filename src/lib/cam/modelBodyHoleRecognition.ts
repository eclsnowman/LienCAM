// CAM-DRILL-ADAPTER: seam that obtains FeatureVerdict[] from the LIVE Model
// kernel for a CAM model-body entry. Lives outside modelBodyDerive so the
// pure derive mapper never imports window / store / workbench types.
//
// Prefers a test-injectable recognizer (setModelBodyHoleRecognizer). Falls
// back to window.__solidsWorkbenchHooks when the Model workbench happens to
// already be mounted (client.recognizeFeatures + getBodyHandle -- the SAME
// path resize-hole uses). WO-335: when neither is available -- the ordinary
// case for a user who opens Setup without ever visiting the Model tab -- this
// module mounts its OWN transient kernel and replays the document's feature
// history headlessly (see regenerateModelBodyHeadless below) rather than
// asking the operator to visit a tab first. Only a genuine failure to
// reconstruct the body (an unsupported feature kind, a lost reference, a
// kernel refusal) still refuses by name (ADR-0003).

import type { BodyHandle, FeatureVerdict, ProfileRegion } from '../../geom/geom-service'
import type { BodyResolution } from './modelReferenceResolution'
import { createGeomService, type GeomClient } from '../../geom'
import type { GeometrySnapshot } from '../../geom'
import { RegenScheduler, type DagNodeSnapshot, type ElementMap, type FeatureDag, type FeatureOp } from '../../doc'
import { loadDocumentArchive } from '../../doc/persist'
import { collectDocumentArchive, LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import { isDatumPlanePayload, makeDatumPlaneExecutor, type DatumPlanePayload } from '../../sketch3d/datumPlane'
import { makeSketch3dExecutor, sketch3dIdFromNodeId } from '../../sketch3d/regen'
import { createSketch3dSolveService, type Sketch3dSolveService } from '../../sketch3d/solveService'
import type { PlaneFrame } from '../../sketch3d'
import { resolveProfileSelector, type ProfileSelector } from '../../components/model3d/workbench/regionSelector'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import { resolveDrivenField } from '../../components/model3d/workbench/featureDimension'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'
import { liveBodyFeatureIds } from '../../components/model3d/bodyLineage'
import type { HoleFeaturePayload } from '../../components/model3d/dialogs/HoleDialog'
import type { BooleanFeaturePayload } from '../../components/model3d/dialogs/BooleanDialog'
import type { ChamferFeaturePayload } from '../../components/model3d/dialogs/ChamferDialog'
import type { ShellFeaturePayload } from '../../components/model3d/dialogs/ShellDialog'
import { loadCachedStep } from '../stepCache'

export type ModelBodyHoleRecognizer = (bodyId: string) => Promise<FeatureVerdict[]>
export type ModelBodyFaceSnapshotReader = (
  bodyId: string,
  faceStableId: string,
) => Promise<GeometrySnapshot | undefined>

let injectedRecognizer: ModelBodyHoleRecognizer | null = null
let injectedSnapshotReader: ModelBodyFaceSnapshotReader | null = null

/** Test / harness injection. Pass null to clear. */
export function setModelBodyHoleRecognizer(fn: ModelBodyHoleRecognizer | null): void {
  injectedRecognizer = fn
}

/** Test / harness injection. Pass null to clear. */
export function setModelBodyFaceSnapshotReader(fn: ModelBodyFaceSnapshotReader | null): void {
  injectedSnapshotReader = fn
}

type WorkbenchHoleHooks = {
  getBodyHandle?: (featureId: string) => unknown
  client?: {
    recognizeFeatures?: (h: unknown) => Promise<FeatureVerdict[]>
    snapshotsFor?: (h: unknown) => Promise<Record<string, GeometrySnapshot>>
  }
}

function workbenchHooks(): WorkbenchHoleHooks | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { __solidsWorkbenchHooks?: WorkbenchHoleHooks }).__solidsWorkbenchHooks
}

// ---------------------------------------------------------------------------
// WO-335: headless kernel mount. Mirrors src/store/headlessModelBodyReplay.ts's
// precedent (transient GeomClient, torn down in `finally`) but replays the
// document's FULL feature history rather than just its 'import' nodes, since
// a Setup bore pick can land on a body built from sketches/extrudes that were
// never imported. Reuses the SAME pure, kernel-untouched builders the Model
// workbench's own regen executor uses (makeDatumPlaneExecutor, makeSketch3dExecutor,
// buildExtrudeRequest, extractSketchProfile, resolveDrivenField) -- this is a
// second CALLER of that shared logic, never a second implementation of it.

/** Test / harness injection for the transient kernel client (mirrors
 *  headlessModelBodyReplay's __setHeadlessReplayClientFactoryForTests). Pass
 *  null to restore the production Web-Worker-backed client. */
let clientFactory: () => GeomClient = createGeomService
export function __setModelBodyHeadlessClientFactoryForTests(factory: (() => GeomClient) | null): void {
  clientFactory = factory ?? createGeomService
}

function kernelOpFailure(nodeId: string, reason: string): { ok: false; diagnostics: [{ code: 'KERNEL_OP_FAILED'; severity: 'error'; params: { id: string; reason: string } }] } {
  return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: nodeId, reason } }] }
}

/** A `PlaneFrame` with a NaN/zero-length axis is unusable for profile
 *  extraction -- mirrors SolidsWorkbenchPage.tsx's own isFinitePlaneFrame
 *  guard (a tiny, self-contained check, not worth threading through an
 *  export just for this one caller). */
function isFiniteFrame(frame: PlaneFrame | undefined): frame is PlaneFrame {
  if (frame === undefined) return false
  for (const v of [frame.origin, frame.normal, frame.xDir]) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false
  }
  return Math.hypot(frame.normal.x, frame.normal.y, frame.normal.z) > 1e-9
}

/** Recompute a "package sketch" node's `profile`/`regions` from its plane's
 *  current frame -- the headless counterpart of SolidsWorkbenchPage's
 *  recomputeSketchProfileInDag, minus the concurrent-session stale-result
 *  guard (nothing else can touch this transient dag while this single pass
 *  runs, so there is nothing to race). */
async function recomputePackageSketchProfile(dag: FeatureDag, nodeId: string): Promise<Awaited<ReturnType<FeatureOp>>> {
  const node = dag.getNode(nodeId)
  if (node === undefined) return { ok: true, diagnostics: [] }
  const payload = node.payload as { sketch?: CamSketch; planeNodeId?: string }
  const sketch = payload.sketch
  if (sketch === undefined || sketch === null) return { ok: true, diagnostics: [] }

  const planeNode = payload.planeNodeId !== undefined ? dag.getNode(payload.planeNodeId) : undefined
  const frame = planeNode !== undefined && isDatumPlanePayload(planeNode.payload)
    ? (planeNode.payload as DatumPlanePayload).lastGoodFrame
    : undefined
  if (!isFiniteFrame(frame)) {
    return kernelOpFailure(nodeId, 'the sketch plane has no resolved frame')
  }

  const rawId = sketch3dIdFromNodeId(nodeId) ?? nodeId
  const result = await extractSketchProfile(sketch, frame, rawId)
  if (!result.ok) return kernelOpFailure(nodeId, result.refusal.message)

  dag.setPayload(nodeId, { ...node.payload, regions: result.regions })
  return { ok: true, diagnostics: [] }
}

/** Replay one 'feature' node whose opType is 'extrude' against the transient
 *  kernel, tracking the resulting BodyHandle by node id so a later feature
 *  that targets/consumes this one can find it (bodyHandles is this pass's
 *  ONLY bookkeeping -- there is no viewport/undo state to maintain here). */
async function runHeadlessExtrude(
  dag: FeatureDag,
  client: GeomClient,
  bodyHandles: Map<string, BodyHandle>,
  node: DagNodeSnapshot,
  modelItemId: string,
): Promise<Awaited<ReturnType<FeatureOp>>> {
  const payload = node.payload
  const sketchId = payload.sketchId
  if (typeof sketchId !== 'string' || sketchId.length === 0) {
    return kernelOpFailure(node.id, 'extrude feature has no sketch reference')
  }
  const sketchNode = dag.getNode(sketchId)
  const profileSelection = resolveProfileSelector(
    sketchNode?.payload.regions as ProfileRegion[] | undefined,
    payload.profileSelector as ProfileSelector | undefined,
  )
  if (!profileSelection.ok) {
    return kernelOpFailure(node.id, `profile selector ${profileSelection.code} for '${sketchId}': ${profileSelection.message}`)
  }

  const driven = resolveDrivenField(dag, node, 'distance')
  const build = buildExtrudeRequest({
    featureId: node.id,
    payload: payload as ExtrudeParamsInput,
    profiles: profileSelection.profiles,
    distance: driven.value,
    lookupTarget: (id) => bodyHandles.get(id),
    modelItemId,
  })
  if (!build.ok) return kernelOpFailure(node.id, build.reason)

  const result = await client.makeExtrude(build.req)
  if (result.ok && result.body !== undefined) bodyHandles.set(node.id, result.body)
  return result
}

/** Replay one 'import' node (a STEP-imported body) against the transient
 *  kernel -- the same replay the LIVE executor's node.kind === 'import'
 *  branch runs (SolidsWorkbenchPage.tsx): cached STEP bytes via
 *  loadCachedStep -> client.importStep -> own the returned handle, refusing
 *  BY NAME (ADR-0003) when the cache is missing, the import reports a fatal
 *  diagnostic, or it yields zero bodies. WO-1412: this case was previously
 *  absent, so a warm reopen's Regen All hit an import node in the document's
 *  history and refused by name ("background reconstruction does not support
 *  a 'import' node yet") instead of replaying it. */
async function runHeadlessImport(
  client: GeomClient,
  bodyHandles: Map<string, BodyHandle>,
  node: DagNodeSnapshot,
): Promise<Awaited<ReturnType<FeatureOp>>> {
  const fileName = typeof node.payload.fileName === 'string' ? node.payload.fileName : node.id
  const cacheKey = typeof node.payload.cacheKey === 'string' ? node.payload.cacheKey : node.id
  const bytes = await loadCachedStep(cacheKey)
  if (bytes === null) {
    return kernelOpFailure(node.id, `cached STEP bytes for "${fileName}" are missing from IndexedDB. Re-import the file.`)
  }
  const imported = await client.importStep(bytes, node.id)
  const fatal = imported.diagnostics.find((d) => d.severity === 'error')
  if (fatal !== undefined) {
    await Promise.all(imported.bodies.map((b) => client.dispose(b.handle).catch(() => undefined)))
    const reason = (fatal.params as { reason?: unknown } | undefined)?.reason
    return kernelOpFailure(node.id, typeof reason === 'string' ? reason : `"${fileName}" failed to import`)
  }
  if (imported.bodies.length === 0) {
    return kernelOpFailure(node.id, `"${fileName}" contains no solid bodies`)
  }
  const bodyIndex = typeof node.payload.bodyIndex === 'number' ? node.payload.bodyIndex : undefined
  if (bodyIndex === undefined) {
    if (imported.bodies.length > 1) {
      await Promise.all(imported.bodies.map((b) => client.dispose(b.handle).catch(() => undefined)))
      return kernelOpFailure(
        node.id,
        `"${fileName}" contains ${imported.bodies.length} bodies -- the workbench imports one body per action; import each separately`,
      )
    }
    const body = imported.bodies[0]
    bodyHandles.set(node.id, body.handle)
    return { ok: true, body: body.handle, elementMap: body.elementMap, diagnostics: imported.diagnostics }
  }
  if (bodyIndex < 0 || bodyIndex >= imported.bodies.length) {
    await Promise.all(imported.bodies.map((b) => client.dispose(b.handle).catch(() => undefined)))
    return kernelOpFailure(
      node.id,
      `"${fileName}" solid ${bodyIndex + 1} is missing -- the file now contains ${imported.bodies.length} solid(s). Re-import the file.`,
    )
  }
  const selected = imported.bodies[bodyIndex]
  await Promise.all(
    imported.bodies.filter((_, i) => i !== bodyIndex).map((b) => client.dispose(b.handle).catch(() => undefined)),
  )
  bodyHandles.set(node.id, selected.handle)
  return { ok: true, body: selected.handle, elementMap: selected.elementMap, diagnostics: imported.diagnostics }
}

/** WO-2282: the body a single-owner feature (hole, chamfer, shell, boolean)
 *  replays onto -- the headless counterpart of the live executor's
 *  lookupLiveBody gate (SolidsWorkbenchPage.tsx): the SAME shared
 *  liveBodyFeatureIds census, so an owner a later feature already consumed
 *  never resolves here either. This pass replays every node once from
 *  scratch in dag order, so "has a handle" is exactly "already rebuilt". */
function lookupHeadlessLiveBody(
  dag: FeatureDag,
  bodyHandles: Map<string, BodyHandle>,
  id: string,
): BodyHandle | undefined {
  return liveBodyFeatureIds(dag, (bid) => bodyHandles.has(bid)).includes(id) ? bodyHandles.get(id) : undefined
}

/** WO-2282: replay one feature that consumes upstream bodies by feature id,
 *  with the SAME kernel op and the SAME request the live executor's branch
 *  for that opType builds (SolidsWorkbenchPage.tsx makeReplayExecutor).
 *  Returns undefined for an opType this headless path does not replay, so
 *  the caller's by-name refusal stands for it. */
async function runHeadlessOwnedFeature(
  dag: FeatureDag,
  client: GeomClient,
  bodyHandles: Map<string, BodyHandle>,
  node: DagNodeSnapshot,
): Promise<Awaited<ReturnType<FeatureOp>> | undefined> {
  const opType = node.payload.opType
  const live = (id: string): BodyHandle | undefined => lookupHeadlessLiveBody(dag, bodyHandles, id)
  const noLiveBody = (label: string, id: string) =>
    kernelOpFailure(node.id, `${label} '${id}' has no live body (missing or already consumed)`)
  let result: Awaited<ReturnType<GeomClient['makeHole']>>
  if (opType === 'hole') {
    const p = node.payload as unknown as HoleFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('hole owner', p.ownerId)
    result = await client.makeHole({ featureId: node.id, body, face: p.faceId, points: p.points, style: p.style, depth: p.depth })
  } else if (opType === 'chamfer') {
    const p = node.payload as unknown as ChamferFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('chamfer owner', p.ownerId)
    result = await client.applyChamfer({ featureId: node.id, body, edges: p.edges, distance: p.distance, propagateTangent: true })
  } else if (opType === 'shell') {
    const p = node.payload as unknown as ShellFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('shell owner', p.ownerId)
    result = await client.applyShell({ featureId: node.id, body, removeFaces: p.removeFaces, thickness: p.thickness })
  } else if (opType === 'boolean') {
    const p = node.payload as unknown as BooleanFeaturePayload
    const target = live(p.targetFeatureId)
    if (target === undefined) return noLiveBody(`boolean ${p.boolOp} target`, p.targetFeatureId)
    const tool = live(p.toolFeatureId)
    if (tool === undefined) return noLiveBody(`boolean ${p.boolOp} tool`, p.toolFeatureId)
    result = await client.applyBoolean({ featureId: node.id, op: p.boolOp, target, tools: [tool] })
  } else {
    return undefined
  }
  if (result.ok && result.body !== undefined) bodyHandles.set(node.id, result.body)
  return result
}

/** The one FeatureOp this module drives its own RegenScheduler pass with.
 *  Dispatches by node kind/opType onto the shared, kernel-op-owning builders
 *  above; anything this headless path does not yet know how to replay
 *  refuses BY NAME (ADR-0003) rather than guessing or silently skipping. */
function makeHeadlessExecutor(
  dag: FeatureDag,
  map: ElementMap,
  scheduler: RegenScheduler,
  client: GeomClient,
  bodyHandles: Map<string, BodyHandle>,
  modelItemId: string,
): FeatureOp {
  let solveServicePromise: Promise<Sketch3dSolveService> | null = null
  const getSolveService = (): Promise<Sketch3dSolveService> => {
    if (solveServicePromise === null) solveServicePromise = createSketch3dSolveService()
    return solveServicePromise
  }

  return async (node) => {
    if (node.kind === 'datum') return makeDatumPlaneExecutor(dag, map)(node)

    if (node.kind === 'sketch') {
      const payload = node.payload as { sketch?: unknown; document?: unknown }
      if (payload.sketch !== undefined && payload.sketch !== null) {
        return recomputePackageSketchProfile(dag, node.id)
      }
      if (payload.document !== undefined && payload.document !== null) {
        const solveService = await getSolveService()
        return makeSketch3dExecutor(dag, solveService, scheduler, map)(node)
      }
      // A legacy static-profile sketch carries no live geometry to recompute.
      return { ok: true, diagnostics: [] }
    }

    if (node.kind === 'feature' && node.payload.opType === 'extrude') {
      return runHeadlessExtrude(dag, client, bodyHandles, node, modelItemId)
    }

    if (node.kind === 'import') {
      return runHeadlessImport(client, bodyHandles, node)
    }

    if (node.kind === 'feature') {
      const owned = await runHeadlessOwnedFeature(dag, client, bodyHandles, node)
      if (owned !== undefined) return owned
    }

    const what = node.kind === 'feature' ? `a '${String(node.payload.opType)}' feature` : `a '${node.kind}' node`
    return kernelOpFailure(node.id, `background reconstruction does not support ${what} yet`)
  }
}

/** Why `bodyId` (or one of its upstream dependencies) failed to regenerate,
 *  in one sentence -- the first failed node in dag order, with its own
 *  recorded reason if one was given. Never names an internal component to
 *  visit; it states the fact and lets the caller decide the consequence. */
function describeHeadlessFailure(dag: FeatureDag, scheduler: RegenScheduler): string {
  for (const id of dag.nodeIds()) {
    if (scheduler.statusOf(id) !== 'failed') continue
    const reason = scheduler.diagnosticsOf(id).find((d) => typeof d.params?.reason === 'string')?.params?.reason
    return typeof reason === 'string' ? `feature "${id}" ${reason}` : `feature "${id}" could not be rebuilt`
  }
  return 'its geometry could not be rebuilt'
}

interface HeadlessReplay {
  client: GeomClient
  scheduler: RegenScheduler
  bodyHandles: Map<string, BodyHandle>
}

/** Mount a transient kernel and replay every node of `dag` through it. The
 *  caller owns the returned client (must terminate() it); on a throw this
 *  terminates it itself. */
async function replayDocumentHeadless(
  dag: FeatureDag,
  map: ElementMap,
  modelItemId: string,
): Promise<HeadlessReplay> {
  const scheduler = new RegenScheduler(dag, map)
  for (const id of dag.nodeIds()) scheduler.markDirty(id)
  const client = clientFactory()
  try {
    await client.init()
    const bodyHandles = new Map<string, BodyHandle>()
    await scheduler.run(makeHeadlessExecutor(dag, map, scheduler, client, bodyHandles, modelItemId))
    return { client, scheduler, bodyHandles }
  } catch (err) {
    await client.terminate().catch(() => undefined)
    throw err
  }
}

/** A non-Error kernel rejection, named for `subject`. */
function kernelFailure(err: unknown, subject: string): Error {
  return err instanceof Error ? err : new Error(`${subject}: the modeling kernel failed (${String(err)}).`)
}

/**
 * WO-2332: re-resolve CAM ModelReferences for ONE Model Item without the
 * Model tab. Replays that item's held document through a transient kernel
 * (the same replay `recognizeModelBodyHoles` uses), then asks the kernel's
 * resolve() for every requested stable id -- the same gather the workbench's
 * reresolveCamModelRefs does (SolidsWorkbenchPage.tsx): a body that no longer
 * exists, or survives only as a consumed ancestor, comes back all-`lost`.
 *
 * `changed` is false for every body: this replays the saved document itself,
 * so nothing regenerated relative to what the ops were computed against; any
 * drift in the ids is the resolver's own `fallback`/`lost` verdict.
 *
 * Throws (and resolves nothing) when the document is not held or a referenced
 * body that still exists could not be rebuilt here -- a background-replay
 * limitation is not evidence that a face was lost, so the caller leaves those
 * references unchecked instead of degrading them.
 */
export async function resolveModelReferencesHeadless(
  modelItemId: string,
  stableIdsByBody: ReadonlyMap<string, readonly string[]>,
): Promise<BodyResolution[]> {
  const bytes = collectDocumentArchive(modelItemId)
  if (bytes === undefined) {
    throw new Error(`Model Item "${modelItemId}" has no document held for it here.`)
  }
  const loaded = loadDocumentArchive(bytes)
  const dag = loaded.dag
  const { client, scheduler, bodyHandles } = await replayDocumentHeadless(dag, loaded.elementMap, modelItemId)
    .catch((err: unknown) => { throw kernelFailure(err, `Model Item "${modelItemId}"`) })
  try {
    for (const bodyId of stableIdsByBody.keys()) {
      if (dag.has(bodyId) && scheduler.statusOf(bodyId) !== 'ok') {
        throw new Error(`body "${bodyId}": ${describeHeadlessFailure(dag, scheduler)}.`)
      }
    }
    const liveBodyIds = new Set(liveBodyFeatureIds(dag, (id) => bodyHandles.has(id)))
    const bodies: BodyResolution[] = []
    for (const [bodyId, stableIds] of stableIdsByBody) {
      const handle = bodyHandles.get(bodyId)
      if (handle === undefined || !liveBodyIds.has(bodyId)) {
        bodies.push({ bodyId, changed: false, resolutions: stableIds.map((id) => ({ id, status: 'lost' })) })
        continue
      }
      const resolved = await client.resolve(handle, [...stableIds])
      bodies.push({
        bodyId,
        changed: false,
        resolutions: resolved.map((r) => ({ id: r.id, status: r.status, localIndex: r.localIndex, type: r.type })),
      })
    }
    return bodies
  } finally {
    await client.terminate().catch(() => undefined)
  }
}

/**
 * Mount a transient kernel, replay the current document's full feature
 * history through it, and return the live handle for `bodyId`. The caller
 * owns the returned client's lifetime (must terminate() it once done) -- on
 * any failure this function terminates it itself before throwing, so a
 * caller never has to clean up a client it never received.
 *
 * `modelItemId` (defaults to the legacy item, mirroring every other consumer
 * of `collectDocumentArchive`): each Model Item's document is stashed under
 * its OWN id (`replaceLoadedDocumentArchives`), so a body owned by a
 * non-legacy item (created via the design tree's "New model" button) must
 * name that item here or this reads the wrong (or no) archive.
 */
async function regenerateModelBodyHeadless(
  bodyId: string,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): Promise<{ client: GeomClient; handle: BodyHandle }> {
  const bytes = collectDocumentArchive(modelItemId)
  if (bytes === undefined) {
    // WO-355 Finding 2: a resolved, NON-legacy owner (a real "New model" item
    // named by the geometry row itself, not the legacy-id fallback) whose
    // document was never captured is a DIFFERENT condition from "no model at
    // all" -- the model IS loaded, just not the one this body claims to
    // belong to. Reusing the legacy-id message here is exactly the silent
    // substitution the WO named: it reads as "there is no 3D model", which is
    // false and unactionable when one is plainly on screen. Name the item.
    if (modelItemId !== LEGACY_MODEL_ITEM_ID) {
      throw new Error(
        `body "${bodyId}": its owning Model Item ("${modelItemId}") has no document held for it here - ` +
          'open that model in the Model tab (or re-save the project) so its geometry can be read, then try again.',
      )
    }
    throw new Error(`body "${bodyId}": this project has no 3D model to read.`)
  }
  const loaded = loadDocumentArchive(bytes)
  const dag = loaded.dag
  if (!dag.has(bodyId)) {
    throw new Error(`body "${bodyId}" no longer exists in this project's model.`)
  }
  const { client, scheduler, bodyHandles } = await replayDocumentHeadless(dag, loaded.elementMap, modelItemId)
    .catch((err: unknown) => { throw kernelFailure(err, `body "${bodyId}"`) })
  try {
    if (scheduler.statusOf(bodyId) !== 'ok') {
      // WO-1412: name what actually failed to rebuild and stop there -- the
      // prior wording tacked on "Save Setup stays disabled..." unconditionally,
      // which is an unrelated guard's message and does not help the operator
      // recover from THIS refusal (e.g. a missing STEP cache entry).
      throw new Error(`body "${bodyId}": ${describeHeadlessFailure(dag, scheduler)}.`)
    }
    const handle = bodyHandles.get(bodyId)
    if (handle === undefined) {
      throw new Error(`body "${bodyId}" produced no live geometry.`)
    }
    return { client, handle }
  } catch (err) {
    await client.terminate().catch(() => undefined)
    throw kernelFailure(err, `body "${bodyId}"`)
  }
}

/**
 * Recognize holes on a Model-kernel body id (DAG feature id / bodyId).
 * Throws a named Error when recognition cannot run.
 *
 * `modelItemId` (optional, defaults to the legacy item): the Model Item that
 * owns `bodyId` -- pass `resolveOwningModelItemId(geo)` from the CAM geometry
 * row so the headless fallback (below) replays that item's OWN document
 * rather than assuming the legacy one.
 */
export async function recognizeModelBodyHoles(bodyId: string, modelItemId?: string): Promise<FeatureVerdict[]> {
  if (typeof bodyId !== 'string' || bodyId.length === 0) {
    throw new Error('recognizeModelBodyHoles: bodyId is required.')
  }
  if (injectedRecognizer) {
    return injectedRecognizer(bodyId)
  }
  const hooks = workbenchHooks()
  const handle = hooks?.getBodyHandle?.(bodyId)
  const recognize = hooks?.client?.recognizeFeatures
  if (handle !== undefined && recognize !== undefined) {
    return recognize(handle)
  }
  const { client, handle: headlessHandle } = await regenerateModelBodyHeadless(bodyId, modelItemId)
  try {
    return await client.recognizeFeatures(headlessHandle)
  } finally {
    await client.terminate().catch(() => undefined)
  }
}

export interface ModelBodyFaceFacts {
  snapshot: GeometrySnapshot
  verdicts: FeatureVerdict[]
}

/** Read one selected face's analytic kernel snapshot and the body's recognition
 * verdicts. Both facts belong to the same live body identity; no mesh inference
 * or imported-STEP worker is involved.
 *
 * `modelItemId` (optional, defaults to the legacy item): see
 * `recognizeModelBodyHoles`'s doc comment -- same reason, same fallback. */
export async function readModelBodyFaceFacts(
  bodyId: string,
  faceStableId: string,
  modelItemId?: string,
): Promise<ModelBodyFaceFacts> {
  if (typeof bodyId !== 'string' || bodyId.length === 0) {
    throw new Error('readModelBodyFaceFacts: bodyId is required.')
  }
  if (typeof faceStableId !== 'string' || faceStableId.length === 0) {
    throw new Error('readModelBodyFaceFacts: faceStableId is required.')
  }

  if (injectedSnapshotReader) {
    const [snapshot, verdicts] = await Promise.all([
      injectedSnapshotReader(bodyId, faceStableId),
      recognizeModelBodyHoles(bodyId, modelItemId),
    ])
    if (!snapshot) {
      throw new Error(
        `Selected Model face "${faceStableId}" is unavailable on body "${bodyId}". ` +
          'Re-sync the model and pick the face again.',
      )
    }
    return { snapshot, verdicts }
  }

  const hooks = workbenchHooks()
  const handle = hooks?.getBodyHandle?.(bodyId)
  const recognize = hooks?.client?.recognizeFeatures
  const snapshotsFor = hooks?.client?.snapshotsFor
  if (handle !== undefined && recognize !== undefined && snapshotsFor !== undefined) {
    const [verdicts, snapshots] = await Promise.all([recognize(handle), snapshotsFor(handle)])
    const snapshot = snapshots[faceStableId]
    if (!snapshot) {
      throw new Error(
        `Selected Model face "${faceStableId}" is unavailable on body "${bodyId}". ` +
          'Re-sync the model and pick the face again.',
      )
    }
    return { snapshot, verdicts }
  }

  const { client, handle: headlessHandle } = await regenerateModelBodyHeadless(bodyId, modelItemId)
  try {
    const [verdicts, snapshots] = await Promise.all([
      client.recognizeFeatures(headlessHandle),
      client.snapshotsFor(headlessHandle),
    ])
    const snapshot = snapshots[faceStableId]
    if (!snapshot) {
      throw new Error(
        `Selected Model face "${faceStableId}" is unavailable on body "${bodyId}". ` +
          'Re-sync the model and pick the face again.',
      )
    }
    return { snapshot, verdicts }
  } finally {
    await client.terminate().catch(() => undefined)
  }
}
