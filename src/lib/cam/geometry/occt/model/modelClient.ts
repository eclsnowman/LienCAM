// Main-thread client for the B-rep model worker (ADR 0018).
//
// - Lazy singleton Worker: the worker (and its 11.6 MB wasm kernel) spins up on
//   the first readStep() call and is reused for every later import / reload.
// - Promise-based protocol wrapper: readStep() resolves with the BrepModelPayload
//   on MODEL_READY and rejects with a ModelClientError (carrying `where`) on
//   MODEL_ERROR -- ADR 0003: failures are named, never swallowed.
// - Runtime payload registry: BrepModelPayload buffers are render-only runtime
//   data. They are held here in a module-level map, NEVER on the zustand store,
//   so they can never leak into the persisted localStorage project (the same
//   reason toolpath moves are stripped in the store's partialize).

import {
  computeStepSha256,
  loadCachedStep,
  STEP_DISPLAY_CONTRACT_VERSION,
  type StepDisplayTessellation,
} from '../../../../stepCache'
import type {
  BrepModelPayload,
  CylinderFeature,
  DerivedLoopsResult,
  HoleFeature,
  ModelRequestMsg,
  ModelResponseMsg,
  PrismaticRoughTargetFacts,
  SectionPlane,
} from './types'

/** Error from the model worker; `where` names the failing stage (ADR 0003). */
export class ModelClientError extends Error {
  where: string

  constructor(where: string, message: string) {
    super(message)
    this.name = 'ModelClientError'
    this.where = where
  }
}

export type ModelProgressPhase = 'read' | 'heal' | 'mesh'

export interface BrepPayloadRecord {
  displayContractVersion: typeof STEP_DISPLAY_CONTRACT_VERSION
  sourceSha256: string
  tessellation: StepDisplayTessellation | null
  payload: BrepModelPayload
}

interface PendingRequest {
  geoId: string
  /** Resolves with the terminal (non-progress, non-error) response message. */
  resolve: (msg: ModelResponseMsg) => void
  reject: (err: ModelClientError) => void
  onProgress?: (phase: ModelProgressPhase) => void
}

let worker: Worker | null = null
const pending = new Map<string, PendingRequest>()

/** Terminate a wedged model worker and reject every request that depended on it. */
export function disposeModelWorker(reason = 'Model worker was restarted'): void {
  const err = new ModelClientError('model-worker-reset', reason)
  for (const req of pending.values()) req.reject(err)
  pending.clear()
  worker?.terminate()
  worker = null
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module' })

  worker.onmessage = (event: MessageEvent<ModelResponseMsg>) => {
    const msg = event.data
    const req = pending.get(msg.requestId)
    if (!req) return // stale response from a superseded request
    if (msg.type === 'MODEL_PROGRESS') {
      req.onProgress?.(msg.phase)
      return
    }
    pending.delete(msg.requestId)
    if (msg.type === 'MODEL_ERROR') req.reject(new ModelClientError(msg.where, msg.message))
    else req.resolve(msg)
  }

  // A worker-level error (script load failure, unhandled throw) kills every
  // in-flight request; reject them all loudly and let the next call respawn.
  worker.onerror = (event: ErrorEvent) => {
    const err = new ModelClientError(
      'model-worker-crash',
      `Model worker failed: ${event.message || 'unknown worker error'}`,
    )
    for (const req of pending.values()) req.reject(err)
    pending.clear()
    worker?.terminate()
    worker = null
  }

  worker.onmessageerror = () => {
    disposeModelWorker('Model worker returned an unreadable message and was restarted')
  }

  return worker
}

/** Post one request and resolve with its terminal response message. */
function postRequest(
  msg: ModelRequestMsg,
  transfer?: Transferable[],
  onProgress?: (phase: ModelProgressPhase) => void,
): Promise<ModelResponseMsg> {
  return new Promise((resolve, reject) => {
    pending.set(msg.requestId, { geoId: msg.geoId, resolve, reject, onProgress })
    if (transfer) getWorker().postMessage(msg, transfer)
    else getWorker().postMessage(msg)
  })
}

/** Unexpected-response guard (protocol bug, ADR 0003: name it, don't swallow). */
function unexpected(msg: ModelResponseMsg, wanted: string): never {
  throw new ModelClientError(
    'protocol',
    `model worker answered ${msg.type} where ${wanted} was expected`,
  )
}

/**
 * Read STEP bytes into the model worker; resolves with the render payload.
 * NOTE: `bytes` is TRANSFERRED to the worker (detached afterwards) -- cache it
 * in stepCache BEFORE calling, or pass a copy if you still need it.
 */
export async function readStep(
  geoId: string,
  bytes: ArrayBuffer,
  fileName: string,
  onProgress?: (phase: ModelProgressPhase) => void,
  tess?: { linearDeflection: number; angularDeflection: number },
): Promise<BrepModelPayload> {
  // Compute before transfer detaches `bytes`. Failure only disables display
  // portability; raw STEP parsing remains available and fail-loud as before.
  const sourceSha256 = await computeStepSha256(bytes)
  const requestId = crypto.randomUUID()
  const msg = await postRequest(
    { type: 'READ_STEP', requestId, geoId, bytes, fileName, tessellation: tess },
    [bytes],
    onProgress,
  )
  if (msg.type !== 'MODEL_READY') unexpected(msg, 'MODEL_READY')
  if (sourceSha256) {
    lastReadMetadata.set(msg.payload, {
      displayContractVersion: STEP_DISPLAY_CONTRACT_VERSION,
      sourceSha256,
      tessellation: tess ?? null,
    })
  }
  return msg.payload
}

// ---- Stage 3 derivation methods ----
//
// Auto-recovery (client-side by design -- the worker has no IndexedDB access):
// if the worker reports the shape is not resident (page was reloaded, worker
// respawned after a crash, ...) and the original STEP bytes are still in
// stepCache, re-run READ_STEP and retry the derive exactly once.

const recoveryReads = new Map<string, Promise<void>>()
let brepProjectGeneration = 0

async function recoverShapeOnce(geoId: string): Promise<void> {
  let recovery = recoveryReads.get(geoId)
  if (!recovery) {
    const generation = brepProjectGeneration
    recovery = (async () => {
      const bytes = await loadCachedStep(geoId)
      if (generation !== brepProjectGeneration) {
        throw new ModelClientError('model-project-reset', 'B-rep recovery belongs to a closed project')
      }
      if (!bytes) {
        throw new ModelClientError(
          'shape-not-resident',
          `B-rep shape for geometry ${geoId} is not resident and no STEP bytes are cached; ` +
            `re-import the STEP file`,
        )
      }
      const hadVisiblePayload = payloads.has(geoId)
      const recovered = await readStep(geoId, bytes, '(stepCache recovery)')
      if (generation !== brepProjectGeneration) {
        lastReadMetadata.delete(recovered)
        throw new ModelClientError('model-project-reset', 'B-rep recovery belongs to a closed project')
      }
      // A fast-restored display is the visible/picking contract. Re-reading raw
      // source here exists only to recover the exact worker shape; replacing the
      // registry with a default-tessellation payload would desynchronize it from
      // the mesh currently attached to the viewport.
      if (!hadVisiblePayload && !payloads.has(geoId)) setBrepPayload(geoId, recovered)
      else lastReadMetadata.delete(recovered)
    })().finally(() => {
      if (recoveryReads.get(geoId) === recovery) recoveryReads.delete(geoId)
    })
    recoveryReads.set(geoId, recovery)
  }
  await recovery
}

async function deriveWithRecovery(geoId: string, makeMsg: () => ModelRequestMsg): Promise<ModelResponseMsg> {
  try {
    return await postRequest(makeMsg())
  } catch (err) {
    if (!(err instanceof ModelClientError) || err.where !== 'shape-not-resident') throw err
    await recoverShapeOnce(geoId)
    return await postRequest(makeMsg())
  }
}

/** Boundary loops + plane Z of a planar Z-normal face (typed rejection otherwise). */
export async function deriveFaceLoops(
  geoId: string,
  faceIndex: number,
): Promise<DerivedLoopsResult> {
  const msg = await deriveWithRecovery(geoId, () => ({
    type: 'DERIVE_FACE_LOOPS',
    requestId: crypto.randomUUID(),
    geoId,
    faceIndex,
  }))
  if (msg.type !== 'DERIVED_FACE_LOOPS') unexpected(msg, 'DERIVED_FACE_LOOPS')
  return msg.result
}

/**
 * Chain picked edges into closed/open loops, grouped by the Z plane each loop
 * lives at: ONE result per Z plane (a single-plane pick is a length-1 array).
 * Typed rejection if any single chained loop is non-coplanar (tilted).
 */
export async function deriveEdgeLoops(
  geoId: string,
  edgeIndices: number[],
): Promise<DerivedLoopsResult[]> {
  const msg = await deriveWithRecovery(geoId, () => ({
    type: 'DERIVE_EDGE_LOOPS',
    requestId: crypto.randomUUID(),
    geoId,
    edgeIndices,
  }))
  if (msg.type !== 'DERIVED_EDGE_LOOPS') unexpected(msg, 'DERIVED_EDGE_LOOPS')
  return msg.result
}

/** Detect Z-axis cylindrical holes (bosses excluded by the inward-normal test). */
export async function deriveHoles(geoId: string): Promise<HoleFeature[]> {
  const msg = await deriveWithRecovery(geoId, () => ({
    type: 'DERIVE_HOLES',
    requestId: crypto.randomUUID(),
    geoId,
  }))
  if (msg.type !== 'DERIVED_HOLES') unexpected(msg, 'DERIVED_HOLES')
  return msg.holes
}

/**
 * Detect vertical cylindrical features (bores AND bosses), each tagged kind.
 * Pass `faceIndices` to restrict the scan to picked bore/boss walls; omit for a
 * full-shape scan. Same shape-not-resident auto-recovery as deriveHoles.
 */
export async function deriveCylinders(
  geoId: string,
  faceIndices?: number[],
): Promise<CylinderFeature[]> {
  const msg = await deriveWithRecovery(geoId, () => ({
    type: 'DERIVE_CYLINDERS',
    requestId: crypto.randomUUID(),
    geoId,
    ...(faceIndices ? { faceIndices } : {}),
  }))
  if (msg.type !== 'DERIVED_CYLINDERS') unexpected(msg, 'DERIVED_CYLINDERS')
  return msg.cylinders
}

/** Complete B-rep classification for Smart Height's scalar planar-rough bridge. */
export async function derivePrismaticRoughTarget(
  geoId: string,
): Promise<PrismaticRoughTargetFacts> {
  const msg = await deriveWithRecovery(geoId, () => ({
    type: 'DERIVE_PRISMATIC_ROUGH_TARGET',
    requestId: crypto.randomUUID(),
    geoId,
  }))
  if (msg.type !== 'DERIVED_PRISMATIC_ROUGH_TARGET') {
    unexpected(msg, 'DERIVED_PRISMATIC_ROUGH_TARGET')
  }
  return msg.facts
}

/**
 * Exact planar section of the solid. With only `z` it cuts the horizontal plane
 * at that height (legacy). With a MODEL-space `plane` frame it cuts that arbitrary
 * plane and flattens loops into the plane's (u,v); `z` is then the naming scalar.
 */
export async function deriveSection(
  geoId: string,
  z: number,
  plane?: SectionPlane,
): Promise<DerivedLoopsResult> {
  const msg = await deriveWithRecovery(geoId, () => ({
    type: 'DERIVE_SECTION',
    requestId: crypto.randomUUID(),
    geoId,
    z,
    ...(plane ? { plane } : {}),
  }))
  if (msg.type !== 'DERIVED_SECTION') unexpected(msg, 'DERIVED_SECTION')
  return msg.result
}

// ---- Runtime payload registry (render-only; never persisted) ----

const payloads = new Map<string, BrepModelPayload>()
const payloadRecords = new Map<string, BrepPayloadRecord>()
let lastReadMetadata = new WeakMap<BrepModelPayload, Omit<BrepPayloadRecord, 'payload'>>()

export function setBrepPayload(
  geoId: string,
  payload: BrepModelPayload,
  metadata?: Omit<BrepPayloadRecord, 'payload'>,
): BrepPayloadRecord | undefined {
  payloads.set(geoId, payload)
  const resolved = metadata ?? lastReadMetadata.get(payload)
  // Provenance belongs to exactly one readStep -> setBrepPayload handoff. Never
  // let a later caller reuse stale metadata merely because it reused the geo id.
  lastReadMetadata.delete(payload)
  if (resolved) {
    const record = { ...resolved, payload }
    payloadRecords.set(geoId, record)
    return record
  }
  payloadRecords.delete(geoId)
  return undefined
}

export function getBrepPayload(geoId: string): BrepModelPayload | undefined {
  return payloads.get(geoId)
}

export function getBrepPayloadRecord(geoId: string): BrepPayloadRecord | undefined {
  return payloadRecords.get(geoId)
}

export function removeBrepPayload(geoId: string): void {
  payloads.delete(geoId)
  payloadRecords.delete(geoId)
}

/** Project boundary: exact worker shapes and render registries are project-owned.
 * Clearing both prevents a same-geoId incoming project from deriving against the
 * previous project's still-resident shape. */
export function resetBrepProjectState(): void {
  brepProjectGeneration += 1
  disposeModelWorker('B-rep project state was reset')
  payloads.clear()
  payloadRecords.clear()
  lastReadMetadata = new WeakMap()
  recoveryReads.clear()
}
