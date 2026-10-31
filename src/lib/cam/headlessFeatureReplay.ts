// WO-2857: the background (no Model tab) replay of every body feature the
// Model tab builds. modelBodyHoleRecognition.ts's makeHeadlessExecutor
// dispatches each 'feature' node here; every branch issues the SAME kernel op
// with the SAME request the live executor's branch for that opType builds
// (SolidsWorkbenchPage.tsx makeReplayExecutor), so a reopened project's Regen
// All and Post Process rebuild the body the operator modeled instead of
// refusing a feature kind by name. The handful of small request builders that
// live privately in SolidsWorkbenchPage.tsx (imported fillet/chamfer re-drive,
// resize-hole and relief requests, the analytic axis face lookup) are mirrored
// below verbatim; every other builder is the workbench's own, via the
// verbatim lib/cam copies in modelWorkbenchHelpers.ts (fix round 2: lib/cam
// may not import components at runtime).
//
// The live executor's viewport bookkeeping (setFeatureVisible, publishBody,
// ownHandle, face-id migration) has no counterpart here: this pass owns a
// transient kernel that is terminated as soon as the caller has read the body.

import type { GeomClient, GeometrySnapshot } from '../../geom'
import type {
  BodyHandle,
  ChamferRequest,
  DraftRequest,
  FaceEditRequest,
  FilletRequest,
  LoftRequest,
  OpResult,
  PlaneDef,
  ProfileRegion,
  RevolveRequest,
  StableId,
  SweepRequest,
  Vec3,
} from '../../geom/geom-service'
import type { HoleDepthEditRequest, HoleStepDiameterEditRequest, ReliefEditRequest } from '../../geom/worker/geom-engine'
import type { DagNodeSnapshot, ElementMap, FeatureDag, FeatureStatus, RegenScheduler } from '../../doc'
import {
  axisLineOfNode,
  isOffsetPlaneDatumPayload,
  makeDatumAxisExecutor,
  makeDatumPlaneExecutor,
  makeDatumPointExecutor,
  type AxisFaceGeometry,
  type PlaneFrame,
} from '../../sketch3d'
import type { ProfileSelector } from '../../components/model3d/workbench/regionSelector'
import type { ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import {
  basePlaneFrame,
  bodyFeatureIds,
  buildAxisPathChain,
  buildExtrudeRequest,
  draftFaceNormalPlane,
  draftNeutralPlane,
  draftPullDir,
  liveBodyFeatureIds,
  resolveBodyTargetLineage,
  resolveDrivenField,
  resolveExtrudeSelection,
  resolveProfileSelector,
} from './modelWorkbenchHelpers'
import type { HoleFeaturePayload } from '../../components/model3d/dialogs/HoleDialog'
import type { BooleanFeaturePayload } from '../../components/model3d/dialogs/BooleanDialog'
import type { ChamferFeaturePayload } from '../../components/model3d/dialogs/ChamferDialog'
import type { ShellFeaturePayload } from '../../components/model3d/dialogs/ShellDialog'
import type { FilletFeaturePayload } from '../../components/model3d/dialogs/FilletDialog'
import type { DefeatureFeaturePayload } from '../../components/model3d/dialogs/DefeatureDialog'
import type { DraftFeaturePayload } from '../../components/model3d/dialogs/DraftDialog'
import type { RevolveFeaturePayload } from '../../components/model3d/dialogs/RevolveDialog'
import type { SweepFeaturePayload } from '../../components/model3d/dialogs/SweepDialog'
import type { LoftFeaturePayload } from '../../components/model3d/dialogs/LoftDialog'
import type { PushPullFeaturePayload } from '../../components/model3d/dialogs/PushPullEditDialog'
import type { ResizeHoleFeaturePayload } from '../../components/model3d/dialogs/ResizeHoleDialog'
import { buildFormBody, isFormFeaturePayload } from '../../form/formBody'
import { isReliefFeaturePayload, pictureOf, reliefKernelFields, type ReliefKernelFields } from '../../relief/reliefFeature'
import { resolveSweepPathChain } from '../../geom/sweep-path'
import { loadCachedSTL } from '../stlCache'
import { importStl } from '../../mesh/stl'
import { convertPrismaticMesh } from '../../mesh/prismatic'
import { replayBodyTransform, resolveReferencesThroughMirrors } from '../../doc/features/bodyTransform'
import { bodyTransformRefusalText, mirrorCarryReplayText } from '../operatorLabels'

/** Everything one headless pass shares across nodes. */
export interface HeadlessReplayWorld {
  dag: FeatureDag
  map: ElementMap
  scheduler: RegenScheduler
  client: GeomClient
  /** Node id -> the body that node rebuilt this pass. */
  bodyHandles: Map<string, BodyHandle>
  modelItemId: string
}

type Result = OpResult

export function kernelOpFailure(nodeId: string, reason: string): { ok: false; diagnostics: [{ code: 'KERNEL_OP_FAILED'; severity: 'error'; params: { id: string; reason: string } }] } {
  return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: nodeId, reason } }] }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const Z_AXIS = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }

/** The body a single-owner feature replays onto -- the headless counterpart of
 *  the live executor's lookupLiveBody gate: the SAME shared liveBodyFeatureIds
 *  census, so an owner a later feature already consumed never resolves here.
 *  This pass replays every node once from scratch in dag order, so "has a
 *  handle" is exactly "already rebuilt". */
export function lookupHeadlessLiveBody(
  dag: FeatureDag,
  bodyHandles: Map<string, BodyHandle>,
  id: string,
): BodyHandle | undefined {
  return liveBodyFeatureIds(dag, (bid) => bodyHandles.has(bid)).includes(id) ? bodyHandles.get(id) : undefined
}

// ---------------------------------------------------------------------------
// Mirrors of SolidsWorkbenchPage.tsx's private request builders.

type FaceEditPayload = Pick<FaceEditRequest, 'featureKey' | 'kind' | 'delta'>

interface ImportedFilletFeaturePayload extends FilletFeaturePayload {
  importedFeatureKey: string
  importedOriginalRadius: number
  importedFaceId: string
}

function isImportedFilletPayload(payload: FilletFeaturePayload): payload is ImportedFilletFeaturePayload {
  const candidate = payload as Partial<ImportedFilletFeaturePayload>
  return typeof candidate.importedFeatureKey === 'string' &&
    candidate.importedFeatureKey.length > 0 &&
    typeof candidate.importedOriginalRadius === 'number' &&
    Number.isFinite(candidate.importedOriginalRadius) &&
    typeof candidate.importedFaceId === 'string' &&
    candidate.importedFaceId.length > 0
}

function importedFilletRequest(featureId: string, body: BodyHandle, payload: ImportedFilletFeaturePayload): FilletRequest & { importedFeatureKey: string } {
  return {
    featureId,
    body,
    edges: [payload.importedFaceId],
    radius: payload.radius,
    propagateTangent: true,
    importedFeatureKey: payload.importedFeatureKey,
  }
}

interface ImportedChamferFeaturePayload extends ChamferFeaturePayload {
  importedFeatureKey: string
  importedOriginalDistance: number
  importedFaceId: string
}

function isImportedChamferPayload(payload: ChamferFeaturePayload): payload is ImportedChamferFeaturePayload {
  const candidate = payload as Partial<ImportedChamferFeaturePayload>
  return typeof candidate.importedFeatureKey === 'string' &&
    candidate.importedFeatureKey.length > 0 &&
    typeof candidate.importedOriginalDistance === 'number' &&
    Number.isFinite(candidate.importedOriginalDistance) &&
    typeof candidate.importedFaceId === 'string' &&
    candidate.importedFaceId.length > 0
}

function importedChamferRequest(featureId: string, body: BodyHandle, payload: ImportedChamferFeaturePayload): ChamferRequest & { importedFeatureKey: string } {
  return {
    featureId,
    body,
    edges: [payload.importedFaceId],
    distance: payload.distance,
    propagateTangent: true,
    importedFeatureKey: payload.importedFeatureKey,
  }
}

interface HoleDepthPayloadFields {
  holeEdit: 'depth'
  currentDepth: number
  currentThrough: boolean
  newDepth: number | 'through'
}

function holeDepthFields(payload: ResizeHoleFeaturePayload): HoleDepthPayloadFields | undefined {
  if (payload.holeEdit !== 'depth') return undefined
  const { currentDepth, currentThrough, newDepth } = payload
  if (typeof currentDepth !== 'number' || (newDepth !== 'through' && typeof newDepth !== 'number')) return undefined
  return { holeEdit: 'depth', currentDepth, currentThrough: currentThrough === true, newDepth }
}

function resizeHoleKernelRequest(featureId: string, body: BodyHandle, payload: ResizeHoleFeaturePayload): FaceEditRequest {
  if (payload.holeEdit === 'move') return { featureId, body, featureKey: payload.featureKey, delta: 0, kind: 'holeMove', translation: payload.translation as [number, number, number] } as FaceEditRequest
  const depth = holeDepthFields(payload)
  const step = payload.holeStep === 'counterbore' ? { step: 'counterbore' as const } : {}
  if (depth === undefined) {
    if (step.step === undefined) return { featureId, body, featureKey: payload.featureKey, delta: payload.delta, kind: 'holeDiameter' }
    const stepReq: HoleStepDiameterEditRequest = { featureId, body, featureKey: payload.featureKey, delta: payload.delta, kind: 'holeDiameter', step: step.step }
    return stepReq as unknown as FaceEditRequest
  }
  const req: HoleDepthEditRequest = depth.newDepth === 'through'
    ? { featureId, body, featureKey: payload.featureKey, delta: 0, kind: 'holeDepth', through: true, ...step }
    : { featureId, body, featureKey: payload.featureKey, delta: depth.newDepth - depth.currentDepth, kind: 'holeDepth', ...step }
  return req as unknown as FaceEditRequest
}

function reliefKernelRequest(featureId: string, body: BodyHandle, faceId: string, fields: ReliefKernelFields): FaceEditRequest {
  const { frame, poles, detail } = fields
  const req: ReliefEditRequest = {
    featureId, body, featureKey: faceId, delta: 0, kind: 'relief',
    relief: {
      origin: frame.origin, xDir: frame.xDir, yDir: frame.yDir, normal: frame.normal, widthMm: frame.widthMm, heightMm: frame.heightMm, n: poles.n, heights: poles.heights,
      ...(detail !== undefined ? { detail: { cols: detail.cols, rows: detail.rows, heights: detail.heights } } : {}),
    },
  }
  return req as unknown as FaceEditRequest
}

function isFinitePlaneFrame(frame: PlaneFrame | undefined): frame is PlaneFrame {
  if (frame === undefined) return false
  for (const v of [frame.origin, frame.normal, frame.xDir]) {
    if (v === undefined || v === null) return false
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false
  }
  return Math.hypot(frame.normal.x, frame.normal.y, frame.normal.z) > 1e-9 &&
    Math.hypot(frame.xDir.x, frame.xDir.y, frame.xDir.z) > 1e-9
}

function extrudePlaneDef(dag: FeatureDag, nodeId: string, status: FeatureStatus): PlaneDef | undefined {
  const base = basePlaneFrame(nodeId)
  if (isFinitePlaneFrame(base)) return { origin: base.origin, normal: base.normal, xDir: base.xDir }
  const node = dag.getNode(nodeId)
  if (node?.degraded === true || status === 'failed' || status === 'degraded') return undefined
  const payload = node !== undefined && isOffsetPlaneDatumPayload(node.payload) ? node.payload : undefined
  return payload !== undefined && isFinitePlaneFrame(payload.lastGoodFrame)
    ? { origin: payload.lastGoodFrame.origin, normal: payload.lastGoodFrame.normal, xDir: payload.lastGoodFrame.xDir }
    : undefined
}

async function analyticAxisFaceGeometry(client: GeomClient, handles: readonly BodyHandle[], map: ElementMap, faceId: StableId): Promise<AxisFaceGeometry | undefined> {
  const snap = map.snapshotOf(faceId)
  if (snap === undefined || snap.surfaceType === 'plane' || snap.axis === undefined) return snap
  for (const handle of handles) {
    let snaps: Record<StableId, GeometrySnapshot>
    try {
      snaps = await client.snapshotsFor(handle)
    } catch {
      continue
    }
    const runtime = snaps[faceId]
    if (runtime?.axisPoint === undefined || runtime.axis === undefined) continue
    const [ax, ay, az] = runtime.axis
    const cx = ay * snap.axis.z - az * snap.axis.y, cy = az * snap.axis.x - ax * snap.axis.z, cz = ax * snap.axis.y - ay * snap.axis.x
    if (Math.hypot(cx, cy, cz) > 1e-4 * Math.hypot(ax, ay, az) * Math.hypot(snap.axis.x, snap.axis.y, snap.axis.z)) continue
    const radius = typeof runtime.radius === 'number' && Number.isFinite(runtime.radius) && runtime.radius > 0 ? { radius: runtime.radius } : {}
    return { ...snap, axisPoint: { x: runtime.axisPoint[0], y: runtime.axisPoint[1], z: runtime.axisPoint[2] }, ...radius }
  }
  return snap
}

// ---------------------------------------------------------------------------

/** A datum node: plane, axis or point, each reading faces through the same
 *  analytic lookup the live executor gives it. */
export function runHeadlessDatum(world: HeadlessReplayWorld, node: DagNodeSnapshot): Promise<Result> | Result {
  const owners = node.consumes.flatMap((id) => world.bodyHandles.get(id) ?? [])
  const handles = [...new Set([...owners, ...world.bodyHandles.values()])]
  const lookup = (faceId: StableId) => analyticAxisFaceGeometry(world.client, handles, world.map, faceId)
  if (node.payload.datumType === 'axis') return makeDatumAxisExecutor(world.dag, world.map, lookup)(node)
  if (node.payload.datumType === 'point') return makeDatumPointExecutor(world.dag, world.map, lookup)(node)
  return makeDatumPlaneExecutor(world.dag, world.map, lookup)(node)
}

/** The live finalizer's body step: replay any legacy payload.faceEdits
 *  (resize-hole diameter / pocket depth sub-records) onto the result, then
 *  record the node's body. A stray 'faceOffset' record is refused by name, as
 *  the live finalizer refuses it. */
async function finalizeBody(world: HeadlessReplayWorld, node: DagNodeSnapshot, result: Result): Promise<Result> {
  if (!result.ok || result.body === undefined) return result
  const faceEdits = (node.payload.faceEdits as FaceEditPayload[] | undefined) ?? []
  const stray = faceEdits.find((e) => e.kind === 'faceOffset')
  if (stray !== undefined) {
    return kernelOpFailure(node.id, `carries a legacy face-offset edit ("${stray.featureKey}") that was never promoted to a Push/Pull feature`)
  }
  let current = result.body
  let last: Result = result
  for (const edit of faceEdits) {
    const r = await world.client.editFeature({ featureId: node.id, body: current, featureKey: edit.featureKey, delta: edit.delta, kind: edit.kind })
    if (!r.ok || r.body === undefined) {
      await world.client.dispose(current).catch(() => undefined)
      return r
    }
    await world.client.dispose(current).catch(() => undefined)
    current = r.body
    last = r
  }
  world.bodyHandles.set(node.id, current)
  return last
}

/** A prismatic STL import ('meshImport' node): the live branch's mesh -> B-rep
 *  pipeline, refusing by name when the bytes are gone or the mesh is not
 *  prismatic. */
export async function runHeadlessMeshImport(world: HeadlessReplayWorld, node: DagNodeSnapshot): Promise<Result> {
  const fileName = typeof node.payload.fileName === 'string' ? node.payload.fileName : node.id
  const cacheKey = typeof node.payload.cacheKey === 'string' ? node.payload.cacheKey : node.id
  const bytes = await loadCachedSTL(cacheKey)
  if (bytes === null) return kernelOpFailure(node.id, `cached STL bytes for "${fileName}" are missing from IndexedDB. Re-import the file.`)
  const conv = convertPrismaticMesh(importStl(bytes).mesh, { convertId: node.id })
  if (!conv.ok) return kernelOpFailure(node.id, conv.message)
  const built = await world.client.makeSolidFromPlanarFaces(conv.faceSet)
  if (!built.ok || built.body === undefined) {
    return built.diagnostics.length > 0 ? built : kernelOpFailure(node.id, `"${fileName}" could not be sewn into a closed solid`)
  }
  if (built.diagnostics.some((d) => d.severity === 'error')) {
    await world.client.dispose(built.body).catch(() => undefined)
    return { ok: false, diagnostics: built.diagnostics }
  }
  return finalizeBody(world, node, built)
}

function profilesOf(world: HeadlessReplayWorld, node: DagNodeSnapshot, sketchId: string, selector: ProfileSelector | undefined | null, op: string):
  { ok: true; profiles: ProfileRegion[] } | { ok: false; failure: Result } {
  const sketchNode = world.dag.getNode(sketchId)
  const selection = resolveProfileSelector(
    sketchNode?.payload.regions as ProfileRegion[] | undefined,
    selector === null ? undefined : selector,
  )
  if (!selection.ok) {
    return { ok: false, failure: kernelOpFailure(node.id, `${op} profile selector ${selection.code} for '${sketchId}': ${selection.message}`) }
  }
  return { ok: true, profiles: selection.profiles }
}

/** One 'feature' node, dispatched by opType onto the live executor's own
 *  kernel op and request. Returns undefined for an opType the workbench does
 *  not define, so the caller's by-name refusal stands for it. */
export async function runHeadlessFeature(world: HeadlessReplayWorld, stored: DagNodeSnapshot): Promise<Result | undefined> {
  const { dag, client, bodyHandles } = world
  // WO-3244: a feature authored on a body a Mirror later replaced keeps its
  // own references; they are resolved through the Mirror's CURRENT plane here,
  // the same resolver the Model screen runs, and never written back.
  const throughMirrors = resolveReferencesThroughMirrors(dag, stored, (id) => extrudePlaneDef(dag, id, world.scheduler.statusOf(id)))
  if (!throughMirrors.ok) {
    const name = typeof stored.payload.name === 'string' ? stored.payload.name : undefined
    return kernelOpFailure(stored.id, mirrorCarryReplayText(throughMirrors.error, name))
  }
  const node = throughMirrors.node
  const payload = node.payload
  const opType = payload.opType
  const live = (id: string): BodyHandle | undefined => lookupHeadlessLiveBody(dag, bodyHandles, id)
  const noLiveBody = (label: string, id: string) =>
    kernelOpFailure(node.id, `${label} '${id}' has no live body (missing or already consumed)`)
  const withDriven = (result: Result, diag: Result['diagnostics'][number] | undefined): Result =>
    diag === undefined ? result : { ...result, diagnostics: [...result.diagnostics, diag] }

  if (opType === 'extrude') {
    const sketchId = payload.sketchId
    if (typeof sketchId !== 'string' || sketchId.length === 0) {
      return kernelOpFailure(node.id, 'extrude feature has no sketch reference')
    }
    // WO-3237: the Model tab's own selection resolver, so a saved open chain
    // replays as the same Thin open wall here and nothing else.
    const sel = resolveExtrudeSelection(
      sketchId,
      dag.getNode(sketchId)?.payload.regions as ProfileRegion[] | undefined,
      (payload.profileSelector ?? undefined) as ProfileSelector | undefined,
      (id) => dag.getNode(id),
    )
    if (!sel.ok) return kernelOpFailure(node.id, `extrude profile selector ${sel.code} for '${sketchId}': ${sel.message}`)
    const driven = resolveDrivenField(dag, node, 'distance')
    const liveIds = () => liveBodyFeatureIds(dag, (id) => live(id) !== undefined)
    const build = buildExtrudeRequest({
      featureId: node.id,
      payload: payload as ExtrudeParamsInput,
      profiles: sel.profiles,
      openChain: sel.openChain,
      distance: driven.value,
      lookupTarget: live,
      resolveBodyTarget: (id) => resolveBodyTargetLineage(dag, bodyFeatureIds(dag), liveIds(), id),
      modelItemId: world.modelItemId,
      candidateTargets: liveIds()
        .filter((id) => id !== node.id)
        .map((id) => ({ identity: { modelItemId: world.modelItemId, bodyFeatureId: id }, body: live(id)! })),
      lookupPlaneTarget: (id) => extrudePlaneDef(dag, id, world.scheduler.statusOf(id)),
    })
    if (!build.ok) return withDriven(kernelOpFailure(node.id, build.reason), driven.diag)
    return withDriven(await finalizeBody(world, node, await client.makeExtrude(build.req)), driven.diag)
  }

  if (opType === 'revolve') {
    const p = payload as unknown as RevolveFeaturePayload
    const sel = profilesOf(world, node, p.sketchId, p.profileSelector, 'revolve')
    if (!sel.ok) return sel.failure
    let axis = Z_AXIS
    if (p.axisDatumId !== undefined) {
      const line = axisLineOfNode(dag, p.axisDatumId)
      if (line === undefined) return kernelOpFailure(node.id, `revolve axis '${p.axisDatumId}' has no resolved line`)
      axis = { origin: line.origin, dir: line.dir }
    }
    const driven = resolveDrivenField(dag, node, 'angleDeg')
    const req: RevolveRequest = { featureId: node.id, profile: sel.profiles[0], axis, angleDeg: driven.value, op: 'newBody' }
    return withDriven(await finalizeBody(world, node, await client.makeRevolve(req)), driven.diag)
  }

  if (opType === 'boolean') {
    const p = payload as unknown as BooleanFeaturePayload
    const target = live(p.targetFeatureId)
    if (target === undefined) return noLiveBody(`boolean ${p.boolOp} target`, p.targetFeatureId)
    const tool = live(p.toolFeatureId)
    if (tool === undefined) return noLiveBody(`boolean ${p.boolOp} tool`, p.toolFeatureId)
    return finalizeBody(world, node, await client.applyBoolean({ featureId: node.id, op: p.boolOp, target, tools: [tool] }))
  }

  if (opType === 'fillet') {
    const p = payload as unknown as FilletFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('fillet owner', p.ownerId)
    const result = isImportedFilletPayload(p)
      ? await client.applyFillet(importedFilletRequest(node.id, body, p))
      : await client.applyFillet({ featureId: node.id, body, edges: p.edges, radius: p.radius, propagateTangent: true } satisfies FilletRequest)
    return finalizeBody(world, node, result)
  }

  if (opType === 'defeature') {
    const p = payload as unknown as DefeatureFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('defeature owner', p.ownerId)
    const result = await client.defeatureBatch({ featureId: node.id, body, featureKeys: p.featureKeys })
    const rejected = result.report?.items.filter((item) => !item.healed) ?? []
    const notFound = result.report?.notFound ?? []
    if (result.ok && result.body !== undefined && (rejected.length > 0 || notFound.length > 0)) {
      await client.dispose(result.body).catch(() => undefined)
      const reasons = [
        ...rejected.map((item) => `${item.featureClass} '${item.featureKey}': ${item.reason ?? 'the engine gave no reason'}`),
        ...notFound.map((key) => `'${key}' was not found during replay`),
      ]
      return { ok: false, diagnostics: [...result.diagnostics, kernelOpFailure(node.id, `defeature refused: ${reasons.join('; ')}`).diagnostics[0]] }
    }
    const finalized = await finalizeBody(world, node, result)
    if (finalized.ok && finalized.body !== undefined && bodyHandles.get(p.ownerId) === body) {
      bodyHandles.delete(p.ownerId)
      await client.dispose(body).catch(() => undefined)
    }
    return finalized
  }

  if (opType === 'chamfer') {
    const p = payload as unknown as ChamferFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('chamfer owner', p.ownerId)
    const req: ChamferRequest = isImportedChamferPayload(p)
      ? importedChamferRequest(node.id, body, p)
      : { featureId: node.id, body, edges: p.edges, distance: p.distance, propagateTangent: true }
    return finalizeBody(world, node, await client.applyChamfer(req))
  }

  if (opType === 'shell') {
    const p = payload as unknown as ShellFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('shell owner', p.ownerId)
    return finalizeBody(world, node, await client.applyShell({ featureId: node.id, body, removeFaces: p.removeFaces, thickness: p.thickness }))
  }

  if (opType === 'draft') {
    const p = payload as unknown as DraftFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('draft owner', p.ownerId)
    const resolveDraftFace = (rawId: string): { ok: true; id: string } | { ok: false; reason: string } => {
      const stableRef = node.refs.find((ref) => ref.kind === 'single-face' && ref.id === rawId)
      if (stableRef === undefined) return { ok: true, id: rawId }
      const resolution = world.map.resolve(stableRef.id, stableRef.kind)
      if (resolution.status === 'lost' || resolution.boundTo.length === 0) {
        return { ok: false, reason: `draft face '${rawId}' was lost after an upstream change` }
      }
      return { ok: true, id: resolution.boundTo[0] }
    }
    const faces: string[] = []
    for (const faceId of p.faces) {
      const resolved = resolveDraftFace(faceId)
      if (!resolved.ok) return kernelOpFailure(node.id, resolved.reason)
      faces.push(resolved.id)
    }
    const neutralFace = p.faceFrameSourceId === undefined ? undefined : resolveDraftFace(p.faceFrameSourceId)
    if (neutralFace !== undefined && !neutralFace.ok) return kernelOpFailure(node.id, neutralFace.reason)
    let pullDir: Vec3
    let neutralPlane: { origin: Vec3; normal: Vec3 }
    if (p.pullMode === 'face-normal') {
      if (neutralFace !== undefined && faces.includes(neutralFace.id)) {
        return kernelOpFailure(node.id, `draft neutral face '${p.faceFrameSourceId}' cannot also be a drafted face`)
      }
      const resolved = draftFaceNormalPlane(p.faceFrame, p.pullFlip, p.offset)
      if (!resolved.ok) return kernelOpFailure(node.id, `draft selected-face plane refused: ${resolved.reason}`)
      pullDir = resolved.pullDir
      neutralPlane = resolved.neutralPlane
    } else {
      pullDir = draftPullDir(p.pullAxis, p.pullFlip)
      neutralPlane = draftNeutralPlane(pullDir, p.offset)
    }
    const req: DraftRequest = { featureId: node.id, body, faces, neutralPlane, pullDir, angleDeg: p.angleDeg }
    return finalizeBody(world, node, await client.applyDraft(req))
  }

  if (opType === 'sweep') {
    const p = payload as unknown as SweepFeaturePayload
    const sel = profilesOf(world, node, p.sketchId, p.profileSelector, 'sweep')
    if (!sel.ok) return sel.failure
    const pathSelector = (payload as { path?: unknown }).path
    if (pathSelector === undefined) {
      const path = buildAxisPathChain(p.axis, p.length)
      const req: SweepRequest = { featureId: node.id, profile: sel.profiles[0], path, orientation: p.orientation, op: 'newBody' }
      return finalizeBody(world, node, await client.makeSweep(req))
    }
    // WO-3231: a sketch-chain path, the live branch's own route -- the path
    // sketch must be an input of this sweep that comes before it, and the ONE
    // resolver (WO-3228) reads its CURRENT curves and plane. A path it cannot
    // resolve builds nothing: never the dormant axis/length, never a straight
    // substitute.
    const order = dag.featureOrder()
    const producer = isRecord(pathSelector) && typeof pathSelector.sketchId === 'string' ? pathSelector.sketchId : ''
    if (!node.consumes.includes(producer) || order.indexOf(producer) === -1 || order.indexOf(producer) > order.indexOf(node.id)) {
      return kernelOpFailure(node.id, `sweep path: the sweep path's sketch ${producer} is not an input that comes before this sweep.`)
    }
    const resolution = resolveSweepPathChain(pathSelector, (id) => dag.getNode(id))
    if (!resolution.ok) {
      return kernelOpFailure(node.id, `sweep path (${resolution.diagnostic.code}): ${resolution.diagnostic.message}`)
    }
    const req: SweepRequest = {
      featureId: node.id, profile: sel.profiles[0], path: resolution.path, orientation: p.orientation, op: 'newBody', transition: 'rightCorner',
    }
    return finalizeBody(world, node, await client.makeSweep(req))
  }

  if (opType === 'loft') {
    const p = payload as unknown as LoftFeaturePayload
    const sections: ProfileRegion[] = []
    for (let i = 0; i < p.sectionIds.length; i++) {
      const sel = profilesOf(world, node, p.sectionIds[i], p.sectionProfileSelectors?.[i], 'loft')
      if (!sel.ok) return sel.failure
      const profile = sel.profiles[0]
      sections.push(i === 0
        ? profile
        : { ...profile, plane: { ...profile.plane, origin: { ...profile.plane.origin, z: profile.plane.origin.z + i * p.spacing } } })
    }
    const req: LoftRequest = { featureId: node.id, sections, ruled: p.ruled, op: 'newBody' }
    return finalizeBody(world, node, await client.makeLoft(req))
  }

  if (opType === 'hole') {
    const p = payload as unknown as HoleFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('hole owner', p.ownerId)
    return finalizeBody(world, node, await client.makeHole({ featureId: node.id, body, face: p.faceId, points: p.points, style: p.style, depth: p.depth }))
  }

  if (opType === 'pushPull') {
    const p = payload as unknown as PushPullFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('push/pull owner', p.ownerId)
    const ref = node.refs.find((r) => r.kind === 'single-face')
    if (ref === undefined) return kernelOpFailure(node.id, 'push/pull has no single-face target reference')
    const res = world.map.resolve(ref.id, ref.kind)
    if (res.status === 'lost' || res.boundTo.length === 0) {
      return kernelOpFailure(node.id, `push/pull target face '${ref.id}' was lost after an upstream change`)
    }
    if (!Number.isFinite(p.delta)) return kernelOpFailure(node.id, 'push/pull has a non-finite distance')
    const liveFaceId = res.boundTo[0]
    const finalized = await finalizeBody(world, node, await client.editFeature({ featureId: node.id, body, featureKey: liveFaceId, delta: p.delta, kind: 'faceOffset' }))
    return res.status === 'fallback'
      ? { ...finalized, diagnostics: [...finalized.diagnostics, { code: 'REFERENCE_FALLBACK', severity: 'warning', params: { id: ref.id, boundTo: liveFaceId } }] }
      : finalized
  }

  if (opType === 'resizeHole') {
    const p = payload as unknown as ResizeHoleFeaturePayload
    const body = live(p.ownerId)
    if (body === undefined) return noLiveBody('move/resize hole owner', p.ownerId)
    const depthEdit = holeDepthFields(p)
    const translation = p.translation as unknown
    if (
      typeof p.featureKey !== 'string' || p.featureKey.length === 0 ||
      (p.holeEdit === 'move'
        ? !Array.isArray(translation) || translation.length !== 3 || translation.some((v) => typeof v !== 'number' || !Number.isFinite(v))
        : depthEdit === undefined ? !Number.isFinite(p.delta) || Math.abs(p.delta) <= 1e-9 : !Number.isFinite(depthEdit.currentDepth))
    ) {
      return kernelOpFailure(node.id, 'move/resize hole has an invalid feature key or value')
    }
    return finalizeBody(world, node, await client.editFeature(resizeHoleKernelRequest(node.id, body, p)))
  }

  if (opType === 'form') {
    if (!isFormFeaturePayload(payload)) return kernelOpFailure(node.id, 'form has no cage in its payload')
    return finalizeBody(world, node, await buildFormBody(client, payload, node.id))
  }

  if (opType === 'relief') {
    if (!isReliefFeaturePayload(payload)) return kernelOpFailure(node.id, 'relief has no picture or settings in its payload')
    const body = live(payload.ownerId)
    if (body === undefined) return noLiveBody('relief owner', payload.ownerId)
    const ref = node.refs.find((r) => r.kind === 'single-face')
    const res = ref === undefined ? undefined : world.map.resolve(ref.id, ref.kind)
    if (res === undefined || res.status === 'lost' || res.boundTo.length === 0) {
      return kernelOpFailure(node.id, 'relief: its face was lost after an upstream change')
    }
    let fields: ReliefKernelFields
    try {
      fields = reliefKernelFields(await pictureOf(payload.image), payload)
    } catch (e) {
      return kernelOpFailure(node.id, `relief: its picture could not be read (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`)
    }
    return finalizeBody(world, node, await client.editFeature(reliefKernelRequest(node.id, body, res.boundTo[0], fields)))
  }

  if (opType === 'bodyTransform') {
    // WO-3244: the same adapter the live executor calls.
    return finalizeBody(world, node, await replayBodyTransform(node, {
      client,
      lookupLiveBody: live,
      resolvePlane: (id) => extrudePlaneDef(dag, id, world.scheduler.statusOf(id)),
      refusalText: bodyTransformRefusalText,
    }))
  }

  return undefined
}
