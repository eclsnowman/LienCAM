// WO-3202 (WO-3170 Slice B): the first same-revision binder between editing
// and CAM. Resize Hole (Model) and the picked-wall Bore (Setup) read ONE
// recognition result for one body revision instead of each calling the kernel
// recognizer on its own.
//
// What lives here, and what does not:
//   - the source token a result is bound to, the result itself (the kernel's
//     own verdicts + face snapshots, and the common PartFeatureList built from
//     them by the WO-3002 adapter), and the selection helpers both consumers
//     use to find "the hole on this face";
//   - a tiny in-flight/completed memo. It owns no lifetime: a ModelSession
//     holds one for its mount, documentHolder holds one per archived document,
//     and each throws it away with its owner. No database, no global cache,
//     no second recognizer -- the producer passed in is the kernel's own.
//
// Token (IMPLEMENTATION.md "Revision"): a live result is bound to the model
// item, the body id, the session's CommandHistory revision, the kernel
// lifetime and the committed handle. A kernel handle names an immutable shape
// (geom/worker/internal-types.ts BodyRecord: every op yields a NEW handle), so
// a handle within one kernel lifetime never names different geometry; the
// kernel serial keeps a restarted worker's reused numbers apart. An archive
// result is bound to the holder's serial for the exact bytes it replayed.
// The memo instance is per session (one document generation's mount) or per
// archive, so a result never crosses a project or a model item.

import type { BodyHandle, FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import {
  facesFromSnapshots,
  fromModelVerdicts,
  recognisedFeatureList,
  type FaceSnapshotLike,
  type PartFeature,
  type PartFeatureList,
} from '../../kernel/features'

/** Producer + adapter identity: a change to either makes a new token. */
export const MODEL_FEATURE_BINDER_VERSION = 'model-kernel-r2+wo3002-adapter/1'

export type ModelBodySourceRoute =
  /** a mounted ModelSession's committed body handle */
  | 'live'
  /** a headless replay of the holder's archived document */
  | 'archive'
  /** a one-off read with no owner to memoize under (test hooks, a live
   *  collector without a session); shared by nobody */
  | 'transient'

export interface ModelBodySourceToken {
  readonly binderVersion: string
  readonly route: ModelBodySourceRoute
  readonly modelItemId: string
  readonly bodyId: string
  /** live: the session's CommandHistory revision; archive: the holder's
   *  serial for the archived bytes; transient: 0 */
  readonly revision: number
  /** live only: the kernel lifetime the handle belongs to */
  readonly kernel?: number
  /** live only: the committed handle the result was read from */
  readonly handle?: number
}

export function sourceTokenKey(token: ModelBodySourceToken): string {
  return JSON.stringify([
    token.binderVersion, token.route, token.modelItemId, token.bodyId,
    token.revision, token.kernel ?? null, token.handle ?? null,
  ])
}

export function sameSourceToken(a: ModelBodySourceToken, b: ModelBodySourceToken): boolean {
  return sourceTokenKey(a) === sourceTokenKey(b)
}

/** One body's recognition at one revision. Plain data only: no handle, no
 *  client, so it survives the Model -> Setup handoff and a worker boundary. */
export interface ModelBodyFeatureResult {
  readonly token: ModelBodySourceToken
  /** the common feature list (WO-3002), with the kernel evidence attached */
  readonly features: PartFeatureList
  /** the kernel's own verdicts, verbatim: the edit commands and Bore's
   *  deriveModelBodyBoreTarget still read these */
  readonly verdicts: readonly FeatureVerdict[]
  /** the body's face snapshots by stable id, from the same handle */
  readonly snapshots: Readonly<Record<string, GeometrySnapshot>>
}

/** The kernel calls a result needs. Both come from the SAME handle. */
export interface ModelBodyKernel {
  recognizeFeatures(handle: BodyHandle): Promise<FeatureVerdict[]>
  snapshotsFor(handle: BodyHandle): Promise<Record<string, GeometrySnapshot>>
}

const kernelSerials = new WeakMap<object, number>()
let nextKernelSerial = 1
/** A stable number per kernel client object, for the token. */
export function kernelSerial(kernel: object): number {
  let serial = kernelSerials.get(kernel)
  if (serial === undefined) {
    serial = nextKernelSerial++
    kernelSerials.set(kernel, serial)
  }
  return serial
}

function faceSnapshotLike(snapshot: GeometrySnapshot): FaceSnapshotLike {
  const v = (p: readonly [number, number, number]) => ({ x: p[0], y: p[1], z: p[2] })
  return {
    surfaceType: snapshot.type,
    centroid: v(snapshot.centroid),
    area: snapshot.area,
    // FaceDescriptor's normal is a planar face's; the worker probes one for every face.
    ...(snapshot.type === 'plane' ? { normal: v(snapshot.normal) } : {}),
    ...(snapshot.axis ? { axis: v(snapshot.axis) } : {}),
  }
}

/** Builds the result from one handle's verdicts and snapshots. */
export function bindModelBodyFeatures(
  token: ModelBodySourceToken,
  verdicts: readonly FeatureVerdict[],
  snapshots: Readonly<Record<string, GeometrySnapshot>>,
): ModelBodyFeatureResult {
  const faces = facesFromSnapshots(Object.fromEntries(
    Object.entries(snapshots).map(([id, s]) => [id, faceSnapshotLike(s)]),
  ))
  const features = recognisedFeatureList(
    { kind: 'geometry-native', entityId: token.bodyId },
    'model-kernel',
    () => fromModelVerdicts(verdicts, faces),
    // No FeatureSourceScope: its projectId is the store's, which this binder
    // never sees, and a guessed one would be a false claim. `token` is the
    // result's ownership and revision.
  )
  return { token, features, verdicts: [...verdicts], snapshots: { ...snapshots } }
}

/** Reads verdicts and snapshots from one handle, then binds them. */
export async function produceModelBodyFeatures(
  token: ModelBodySourceToken,
  kernel: ModelBodyKernel,
  handle: BodyHandle,
): Promise<ModelBodyFeatureResult> {
  const [verdicts, snapshots] = await Promise.all([kernel.recognizeFeatures(handle), kernel.snapshotsFor(handle)])
  return bindModelBodyFeatures(token, verdicts, snapshots)
}

/** The common feature a kernel verdict became (associated by sourceKey,
 *  never by array index). Undefined when the adapter could not list it. */
export function featureForVerdict(result: ModelBodyFeatureResult, featureKey: string): PartFeature | undefined {
  return result.features.features.find((feature) => feature.sourceKey === featureKey)
}

/** The verdict behind a common feature. */
export function verdictForFeature(result: ModelBodyFeatureResult, feature: PartFeature): FeatureVerdict | undefined {
  return result.verdicts.find((verdict) => verdict.featureKey === feature.sourceKey)
}

/** The common features that list `faceStableId` among their references. */
export function featuresOnFace(result: ModelBodyFeatureResult, faceStableId: string): PartFeature[] {
  return result.features.features.filter((feature) => feature.references.includes(faceStableId))
}

/** What one consumer selected from one result: the binding a test or a later
 *  consumer can compare across Resize Hole and Bore. */
export interface FeatureResultSelection {
  readonly consumer: 'resize-hole' | 'bore-face'
  readonly token: ModelBodySourceToken
  readonly featureId: string | null
  readonly featureKey: string | null
  readonly faceStableId: string | null
}

export function selectionFromResult(
  consumer: FeatureResultSelection['consumer'],
  result: ModelBodyFeatureResult,
  verdict: Pick<FeatureVerdict, 'featureKey'> | undefined,
  faceStableId: string | null,
): FeatureResultSelection {
  const feature = verdict !== undefined ? featureForVerdict(result, verdict.featureKey) : undefined
  return {
    consumer,
    token: result.token,
    featureId: feature?.id ?? null,
    featureKey: verdict?.featureKey ?? null,
    faceStableId,
  }
}

interface MemoEntry {
  readonly token: ModelBodySourceToken
  readonly promise: Promise<ModelBodyFeatureResult>
  result?: ModelBodyFeatureResult
}

/**
 * In-flight + completed results by token. Concurrent callers for one token
 * share one promise; a failure removes only its own entry, so a retry runs
 * again instead of reading a poisoned rejection. The owner bounds it
 * (`retain`, `clear`) and drops it with itself.
 */
export class FeatureResultMemo {
  private readonly entries = new Map<string, MemoEntry>()

  read(token: ModelBodySourceToken, produce: () => Promise<ModelBodyFeatureResult>): Promise<ModelBodyFeatureResult> {
    const key = sourceTokenKey(token)
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing.promise
    let entry!: MemoEntry
    const promise = Promise.resolve().then(produce).then(
      (result) => {
        if (this.entries.get(key) === entry) entry.result = result
        return result
      },
      (err: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw err
      },
    )
    entry = { token, promise }
    this.entries.set(key, entry)
    return promise
  }

  /** A completed result for exactly `token`, if one is held. */
  completed(token: ModelBodySourceToken): ModelBodyFeatureResult | undefined {
    return this.entries.get(sourceTokenKey(token))?.result
  }

  /** Every completed result. */
  completedResults(): ModelBodyFeatureResult[] {
    return [...this.entries.values()].flatMap((entry) => (entry.result === undefined ? [] : [entry.result]))
  }

  /** Install an already-completed result (evidence carried across an owner
   *  handoff). Replaces any entry for the same token. */
  install(result: ModelBodyFeatureResult): void {
    this.entries.set(sourceTokenKey(result.token), { token: result.token, promise: Promise.resolve(result), result })
  }

  /** Drop every entry whose token `keep` rejects (in flight or completed). */
  retain(keep: (token: ModelBodySourceToken) => boolean): void {
    for (const [key, entry] of this.entries) if (!keep(entry.token)) this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** What a mounted workbench lends its session so a reader reaches the SAME
 *  committed bodies and kernel the screen does (never a preview handle). */
export interface LiveBodySource {
  handleOf(bodyId: string): BodyHandle | undefined
  kernel(): ModelBodyKernel | null
}

/** The slice of ModelSession the live read needs (kept structural so this
 *  module imports nothing from src/doc). */
export interface LiveFeatureOwner {
  readonly modelItemId: string
  readonly featureResults: FeatureResultMemo
  revision(): number
  liveBodySource(): LiveBodySource | null
}

/** Thrown when the live body cannot be read right now (no workbench body for
 *  that id). The caller falls back to the archived document. */
export class FeatureSourceUnavailableError extends Error {}

export function liveSourceToken(owner: LiveFeatureOwner, bodyId: string, kernel: ModelBodyKernel, handle: BodyHandle): ModelBodySourceToken {
  return {
    binderVersion: MODEL_FEATURE_BINDER_VERSION,
    route: 'live',
    modelItemId: owner.modelItemId,
    bodyId,
    revision: owner.revision(),
    kernel: kernelSerial(kernel),
    handle,
  }
}

const SUPERSEDED_RETRIES = 3

/**
 * The live read (IMPLEMENTATION.md binder steps 1-4): resolve the committed
 * handle, read or join the memo entry for its token, then check the handle,
 * kernel and revision again before handing the result out. A result whose
 * body was superseded while it ran is not handed out; the read retries
 * against the current body. The superseded entry stays keyed to its own
 * handle (it is still true of that shape) until the owner's bound drops it.
 */
export async function readLiveModelBodyFeatures(owner: LiveFeatureOwner, bodyId: string): Promise<ModelBodyFeatureResult> {
  for (let attempt = 0; attempt < SUPERSEDED_RETRIES; attempt++) {
    const source = owner.liveBodySource()
    const kernel = source?.kernel() ?? null
    const handle = source?.handleOf(bodyId)
    if (source === null || kernel === null || handle === undefined) {
      throw new FeatureSourceUnavailableError(`body "${bodyId}" has no live geometry in the open model.`)
    }
    const token = liveSourceToken(owner, bodyId, kernel, handle)
    // Bound: only the current kernel lifetime and revision stay held.
    owner.featureResults.retain((t) => t.route !== 'live' || (t.kernel === token.kernel && t.revision === token.revision))
    const result = await owner.featureResults.read(token, () => produceModelBodyFeatures(token, kernel, handle))
    const now = owner.liveBodySource()
    if (now === source && now.kernel() === kernel && now.handleOf(bodyId) === handle && owner.revision() === token.revision) {
      return result
    }
  }
  throw new Error(`body "${bodyId}" kept changing while its features were read; try again once the model settles.`)
}
