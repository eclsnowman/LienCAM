// WO UI-51A: extrude feature parameters wired end-to-end through the modal.
// This module is the ONE source of truth mapping the user-facing extrude
// parameter model (direction + boolean mode + optional target) onto the
// already-built, real-kernel-tested frozen ExtrudeRequest surface
// (geom-service.ts's ExtrudeEnd blind/symmetric + op newBody/add/cut/
// intersect, geom/worker/geom-engine.ts:1253-1328). The kernel is NOT touched
// by this WO -- this is payload/executor/dialog/lineage wiring only.
//
// It is deliberately React-free (imports only geom-service TYPES) so the
// direction x booleanMode census and every accept/refuse path can be unit-
// tested as a pure function, and so both the dialog (labels + controls) and
// the page's regen executor (buildExtrudeRequest) share the SAME mapping with
// no forked truth.
//
// draftAngleDeg and thin (ExtrudeRequest.draftAngleDeg / thin, geom-service.ts
// :160-161) are ACCEPTED-AND-IGNORED trap fields on the kernel op -- makeExtrude
// never reads either. This WO does NOT wire them (BK-119 owns draft; thin/
// surface is a separate GEO-lane build); they are intentionally absent here so
// no UI control is ever bound to a dead field (the propagateTangent lesson,
// geom-service.ts:243-245).

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type {
  BodyHandle,
  ExtrudeEndTargetIdentity,
  ExtrudeEnd,
  ExtrudePlaneTargetIdentity,
  ExtrudeRequest,
  ExtrudeTargetIdentity,
  PlaneDef,
  ProfileRegion,
  ResolvedExtrudeFaceTarget,
  ResolvedExtrudePlaneTarget,
  ResolvedExtrudeTarget,
} from '../../../geom/geom-service'
import type { BodyTargetLineageResolution } from '../bodyLineage'

// ---------------------------------------------------------------------------
// Type unions -- the census derives directly from these tuples (derived
// completeness: direction x booleanMode is exactly EXTRUDE_DIRECTIONS x
// EXTRUDE_BOOL_MODES, enumerated and tested cell-by-cell).
// ---------------------------------------------------------------------------

export const EXTRUDE_DIRECTIONS = ['up', 'down', 'midplane'] as const
export type ExtrudeDirection = (typeof EXTRUDE_DIRECTIONS)[number]

/** UI vocabulary (cross-workspace parity: New body / Add / Remove / Intersect). NOTE
 *  'remove' is the USER term; it maps to the kernel op 'cut' (extrudeKernelOp
 *  below) -- the only name-translation in this module, isolated here. */
export const EXTRUDE_BOOL_MODES = ['newBody', 'add', 'remove', 'intersect'] as const
export type ExtrudeBoolMode = (typeof EXTRUDE_BOOL_MODES)[number]

export const EXTRUDE_END_CONDITIONS = ['blind', 'symmetric', 'upToNext', 'toFace', 'toPart', 'toVertex', 'throughAll'] as const
export type ExtrudeEndCondition = (typeof EXTRUDE_END_CONDITIONS)[number]

export const EXTRUDE_END_CONDITION_LABELS: Record<ExtrudeEndCondition, string> = {
  get blind() { return workbenchText('extrudeParams.blind') },
  get symmetric() { return workbenchText('extrudeParams.symmetric') },
  get upToNext() { return workbenchText('extrudeParams.upToNext') },
  get toFace() { return workbenchText('extrudeParams.upToFacePlane') },
  get toPart() { return workbenchText('extrudeParams.upToPartBody') },
  get toVertex() { return workbenchText('extrudeParams.upToVertexPoint') },
  get throughAll() { return workbenchText('extrudeParams.throughAll') },
}

export const EXTRUDE_DIRECTION_LABELS: Record<ExtrudeDirection, string> = {
  get up() { return workbenchText('extrudeParams.up') },
  get down() { return workbenchText('extrudeParams.down') },
  get midplane() { return workbenchText('extrudeParams.symmetricMidplane') },
}

export const EXTRUDE_BOOL_MODE_LABELS: Record<ExtrudeBoolMode, string> = {
  get newBody() { return workbenchText('extrudeParams.newBody') },
  get add() { return workbenchText('extrudeParams.add') },
  get remove() { return workbenchText('extrudeParams.remove') },
  get intersect() { return workbenchText('extrudeParams.intersect') },
}

/** Legacy-compat defaults. These are ALSO exactly what the doc-schema v2->v3
 *  migration writes onto a pre-UI-51A extrude payload (doc/persist/
 *  versioning.ts): a pre-UI-51A extrude was blind / along +normal / new body,
 *  so an old file with neither field defaults to up / newBody. (Region
 *  behavior -- the sketch truncated to its first canonical region -- is
 *  unchanged and owned by UI-51C; no region field is added here.) */
export const DEFAULT_EXTRUDE_DIRECTION: ExtrudeDirection = 'up'
export const DEFAULT_EXTRUDE_BOOL_MODE: ExtrudeBoolMode = 'newBody'
export const DEFAULT_EXTRUDE_END_CONDITION: ExtrudeEndCondition = 'blind'

export function isExtrudeDirection(v: unknown): v is ExtrudeDirection {
  return typeof v === 'string' && (EXTRUDE_DIRECTIONS as readonly string[]).includes(v)
}

export function isExtrudeBoolMode(v: unknown): v is ExtrudeBoolMode {
  return typeof v === 'string' && (EXTRUDE_BOOL_MODES as readonly string[]).includes(v)
}

export function isExtrudeEndCondition(v: unknown): v is ExtrudeEndCondition {
  return typeof v === 'string' && (EXTRUDE_END_CONDITIONS as readonly string[]).includes(v)
}

// ---------------------------------------------------------------------------
// Mapping onto the frozen kernel contract.
// ---------------------------------------------------------------------------

/** Map the UI boolean mode onto the frozen ExtrudeRequest.op. The ONLY
 *  translation is 'remove' -> 'cut'; every other mode is identity. Exhaustive
 *  over ExtrudeBoolMode -- a new mode is a compile error here (the `never`
 *  arm), which is the point of routing all mode->op truth through one switch. */
export function extrudeKernelOp(mode: ExtrudeBoolMode): ExtrudeRequest['op'] {
  switch (mode) {
    case 'newBody':
      return 'newBody'
    case 'add':
      return 'add'
    case 'remove':
      return 'cut'
    case 'intersect':
      return 'intersect'
    default: {
      const _exhaustive: never = mode
      throw new Error(workbenchText('extrudeParams.extrudekernelopUnhandledBoolMode', { value1: String(String(_exhaustive)) }))
    }
  }
}

export type ExtrudeEndResolution = { ok: true; end: ExtrudeEnd } | { ok: false; reason: string }

/**
 * Resolve (direction, distance) onto a frozen ExtrudeEnd.
 *
 * DIRECTION ENCODING (WO constraint 3 / preflight edit 3): direction is a
 * closed type union, NOT a sign convention, and `distance` is a POSITIVE
 * MAGNITUDE. Down is expressible ONLY via direction='down' -- never via a
 * negative distance. This closes the live silent path that existed before
 * UI-51A, where a bound fx expression evaluating negative already extruded
 * anti-normal unannounced (geom-engine.ts:1265 does extVec = normal*distance
 * with no sign check). Here a non-finite or <= 0 distance is a NAMED refusal,
 * never a silent flip: there are no longer two invisible ways to say "down".
 *
 * - up:       blind, +magnitude along the profile-plane normal.
 * - down:     blind, -magnitude (anti-normal). The frozen ExtrudeEnd.blind
 *             .distance is an unconstrained number; a negative value drives
 *             BRepPrimAPI_MakePrism the opposite way (proven by the real-occt
 *             direction x mode matrix in extrude.test.ts).
 * - midplane: symmetric, centered on the profile plane, total depth = magnitude.
 */
export function resolveExtrudeEnd(direction: ExtrudeDirection, distance: number): ExtrudeEndResolution {
  if (!Number.isFinite(distance) || distance <= 0) {
    return {
      ok: false,
      reason: workbenchText('extrudeParams.extrudeDistanceMustBeAPositiveMagnitudeGotUse', { distance: String(distance) }),
    }
  }
  switch (direction) {
    case 'up':
      return { ok: true, end: { kind: 'blind', distance } }
    case 'down':
      return { ok: true, end: { kind: 'blind', distance: -distance } }
    case 'midplane':
      return { ok: true, end: { kind: 'symmetric', distance } }
    default: {
      const _exhaustive: never = direction
      throw new Error(workbenchText('extrudeParams.resolveextrudeendUnhandledDirection', { value1: String(String(_exhaustive)) }))
    }
  }
}

// ---------------------------------------------------------------------------
// Executor request builder -- the single accept/refuse gate the page's regen
// executor calls. Every path refuses BY NAME (charter rule 2); nothing
// fail-opens. Kept pure + fully enumerated so the whole census is unit-tested
// without booting the page or the kernel.
// ---------------------------------------------------------------------------

/** The raw, post-load payload view. Values are `unknown` on purpose: after a
 *  migration/round-trip the fields are plain JSON and must be VALIDATED at
 *  this accept point (charter rule 3), not trusted. */
export interface ExtrudeParamsInput {
  direction?: unknown
  boolMode?: unknown
  targetFeatureIds?: unknown
  targetFeatureId?: unknown
  endCondition?: unknown
  terminalOffset?: unknown
  endTarget?: unknown
  resolvedEndTargets?: unknown
}

export type ExtrudeRequestBuild =
  | { ok: true; req: ExtrudeRequest; /** feature id whose body this op consumes; hide it on success */ hideTargetId?: string }
  | { ok: false; reason: string }

interface BuildExtrudeRequestArgsBase {
  featureId: string
  payload: ExtrudeParamsInput
  /** already-resolved driving distance (literal or fx-evaluated) */
  distance: number
  /** live body-handle lookup (bodyHandlesRef.current.get); undefined = missing/consumed */
  lookupTarget: (featureId: string) => BodyHandle | undefined
  /** Transient union of a validated multi-body boolean target set. */
  composedTarget?: { featureIds: readonly string[]; body: BodyHandle }
  /** Required for target-driven end conditions. Kept optional so legacy blind
   * callers remain source compatible while WO-216 wires the active item. */
  modelItemId?: string
  /** Runtime same-item body census used by Up to next and Through all. Each
   * entry carries durable identity plus its current-generation handle. */
  candidateTargets?: readonly ResolvedExtrudeTarget[]
  /** Resolve a persisted END-CONDITION body reference through later features.
   * Boolean Add/Remove/Intersect targets deliberately do not use this seam:
   * they are consumed inputs and must remain live under their persisted ids. */
  resolveBodyTarget?: (featureId: string) => BodyTargetLineageResolution
  /** Re-resolves a persisted base/construction datum node to its current
   * generation plane. Required only when Up to face names a planeFeatureId. */
  lookupPlaneTarget?: (featureId: string) => PlaneDef | undefined
}

export type BuildExtrudeRequestArgs = BuildExtrudeRequestArgsBase & (
  | { profiles: readonly ProfileRegion[]; profile?: never }
  | { /** @deprecated Out-of-lane source compatibility. */ profile: ProfileRegion; profiles?: never }
)

function parseTargetIdentity(raw: unknown): { ok: true; identity: ExtrudeEndTargetIdentity } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeEndConditionRequiresAStableTargetIdentity') }
  }
  const value = raw as Record<string, unknown>
  if (typeof value.modelItemId !== 'string' || value.modelItemId === '') {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetIsMissingModelItemId') }
  }
  if (value.planeFeatureId !== undefined) {
    if (typeof value.planeFeatureId !== 'string' || value.planeFeatureId === '') {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeDatumPlaneTargetIsMissingPlaneFeatureId') }
    }
    if (value.bodyFeatureId !== undefined || value.subshape !== undefined) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetCannotNameBothADatumPlane') }
    }
    return {
      ok: true,
      identity: { modelItemId: value.modelItemId, planeFeatureId: value.planeFeatureId },
    }
  }
  if (typeof value.bodyFeatureId !== 'string' || value.bodyFeatureId === '') {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetIsMissingBodyFeatureId') }
  }
  let subshape: ExtrudeTargetIdentity['subshape']
  if (value.subshape !== undefined) {
    if (value.subshape === null || typeof value.subshape !== 'object' || Array.isArray(value.subshape)) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetSubshapeIsMalformed') }
    }
    const s = value.subshape as Record<string, unknown>
    if ((s.kind !== 'face' && s.kind !== 'vertex') || typeof s.stableId !== 'string' || s.stableId === '') {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetSubshapeRequiresKindAndStableId') }
    }
    if (s.lineage !== undefined && (!Array.isArray(s.lineage) || s.lineage.some((id) => typeof id !== 'string' || id === ''))) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetLineageMustContainStableIds') }
    }
    subshape = {
      kind: s.kind,
      stableId: s.stableId,
      ...(Array.isArray(s.lineage) ? { lineage: [...new Set(s.lineage as string[])] } : {}),
    }
  }
  return {
    ok: true,
    identity: { modelItemId: value.modelItemId, bodyFeatureId: value.bodyFeatureId, ...(subshape ? { subshape } : {}) },
  }
}

function resolvePersistedTarget(
  raw: unknown,
  modelItemId: string | undefined,
  lookupTarget: (featureId: string) => BodyHandle | undefined,
  lookupPlaneTarget: ((featureId: string) => PlaneDef | undefined) | undefined,
  expected: 'body' | 'face' | 'vertex',
  resolveBodyTarget?: (featureId: string) => BodyTargetLineageResolution,
): { ok: true; target: ResolvedExtrudeFaceTarget } | { ok: false; reason: string } {
  const parsed = parseTargetIdentity(raw)
  if (!parsed.ok) return parsed
  const { identity } = parsed
  if (modelItemId === undefined) return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetCannotBeResolvedWithoutTheActive') }
  if (identity.modelItemId !== modelItemId) {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetBelongsToModelItemNot', { modelItemId: String(identity.modelItemId), modelItemId2: String(modelItemId) }) }
  }
  if ('planeFeatureId' in identity) {
    if (expected !== 'face') {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeRequiresBodyGeometryNotADatumPlane', { value1: String(expected === 'body' ? workbenchText('extrudeParams.upToPart') : workbenchText('extrudeParams.upToVertex')) }) }
    }
    if (lookupPlaneTarget === undefined) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeDatumPlaneTargetCannotBeResolvedWithoutA', { planeFeatureId: String(identity.planeFeatureId) }) }
    }
    const plane = lookupPlaneTarget(identity.planeFeatureId)
    if (plane === undefined) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeDatumPlaneTargetIsLostNoLivePlane', { planeFeatureId: String(identity.planeFeatureId) }) }
    }
    const target: ResolvedExtrudePlaneTarget = { identity: identity as ExtrudePlaneTargetIdentity, plane }
    return { ok: true, target }
  }
  if (expected === 'body' && identity.subshape !== undefined) {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeUpToPartRequiresABodyTargetNot') }
  }
  if (expected !== 'body' && identity.subshape?.kind !== expected) {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetRequiresAStableId', { expected: String(expected) }) }
  }
  const resolvedBody = resolveBodyTarget?.(identity.bodyFeatureId)
  if (resolvedBody !== undefined && !resolvedBody.ok) {
    return resolvedBody.reason === 'lost'
      ? { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetBodyIsLostNoLiveDescendant', { bodyFeatureId: String(identity.bodyFeatureId) }) }
      : { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetBodyIsAmbiguousBetweenLiveBodies', { bodyFeatureId: String(identity.bodyFeatureId), value2: String(resolvedBody.candidates.join(', ')) }) }
  }
  const currentBodyId = resolvedBody?.bodyId ?? identity.bodyFeatureId
  if (identity.subshape !== undefined && currentBodyId !== identity.bodyFeatureId) {
    return {
      ok: false,
      reason: workbenchText('extrudeParams.extrudeEndTargetOnBodyIsLostAfterBody', { kind: String(identity.subshape.kind), stableId: String(identity.subshape.stableId), bodyFeatureId: String(identity.bodyFeatureId), currentBodyId: String(currentBodyId) }),
    }
  }
  const body = lookupTarget(currentBodyId)
  if (body === undefined) {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeEndTargetBodyResolvedToButHasNo', { bodyFeatureId: String(identity.bodyFeatureId), currentBodyId: String(currentBodyId) }) }
  }
  return { ok: true, target: { identity: { ...identity, bodyFeatureId: currentBodyId }, body } }
}

/**
 * Build a frozen ExtrudeRequest from a feature payload, enumerating EVERY
 * accept/skip/refuse path to the last consumer (charter rule 2):
 *
 *  - direction: undefined -> the named legacy default 'up' (same default the
 *    v2->v3 migration writes); an unrecognized NON-undefined value refuses by
 *    name (never silently coerced).
 *  - distance: <= 0 / non-finite -> named refusal (resolveExtrudeEnd).
 *  - boolMode: undefined -> legacy default 'newBody'; unrecognized -> refuse.
 *  - newBody: no target consulted (a stray targetFeatureId is ignored, not an
 *    error -- switching a saved cut back to New body must not wedge on a dead
 *    target reference).
 *  - add/remove/intersect: target REQUIRED. Refuses by name on:
 *      * missing/empty targetFeatureId  (nothing selected)
 *      * self-target                    (feature cannot consume its own body)
 *      * no live handle                 (target missing OR already consumed
 *                                        downstream -- the lookup is the only
 *                                        liveness truth)
 *    Lineage: a single target keeps legacy targetFeatureId compatibility;
 *    multi-body targetFeatureIds persist every parent and use the first ordered
 *    member as their validated identity carrier (bodyLineage.ts).
 */
export function buildExtrudeRequest(args: BuildExtrudeRequestArgs): ExtrudeRequestBuild {
  const { featureId, payload, distance, lookupTarget, modelItemId } = args
  const selectedProfiles = 'profiles' in args && args.profiles !== undefined ? args.profiles : [args.profile]
  if (selectedProfiles.length === 0) {
    return { ok: false, reason: workbenchText('extrudeParams.extrudeRequiresAtLeastOneProfileRegion') }
  }
  const profiles = [...selectedProfiles] as [ProfileRegion, ...ProfileRegion[]]

  const rawDirection = payload.direction === undefined ? DEFAULT_EXTRUDE_DIRECTION : payload.direction
  if (!isExtrudeDirection(rawDirection)) {
    return { ok: false, reason: workbenchText('extrudeParams.unknownExtrudeDirection', { value1: String(String(rawDirection)) }) }
  }

  const rawMode = payload.boolMode === undefined ? DEFAULT_EXTRUDE_BOOL_MODE : payload.boolMode
  if (!isExtrudeBoolMode(rawMode)) {
    return { ok: false, reason: workbenchText('extrudeParams.unknownExtrudeBooleanMode', { value1: String(String(rawMode)) }) }
  }
  const op = extrudeKernelOp(rawMode)

  let targetId: string | undefined
  let target: BodyHandle | undefined
  if (op !== 'newBody') {
    const rawTargetIds = payload.targetFeatureIds === undefined
      ? [payload.targetFeatureId]
      : payload.targetFeatureIds
    if (
      !Array.isArray(rawTargetIds) ||
      rawTargetIds.length === 0 ||
      rawTargetIds.some((id) => typeof id !== 'string' || id === '') ||
      new Set(rawTargetIds).size !== rawTargetIds.length
    ) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeRequiresATargetBody', { rawMode: String(rawMode) }) }
    }
    // Boolean targets are consumed inputs, not references. Remapping one to a
    // descendant would cut a different body while the DAG still records the
    // persisted id, so require every member to remain live under that id.
    const targetIds = rawTargetIds as string[]
    if (targetIds.includes(featureId)) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeCannotTargetItself', { rawMode: String(rawMode) }) }
    }
    const currentTargetId = targetIds[0]
    if (targetIds.length > 1) {
      const missingTargetId = targetIds.find((id) => lookupTarget(id) === undefined)
      if (missingTargetId !== undefined) {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeTargetHasNoLiveBodyMissingOrAlready', { rawMode: String(rawMode), missingTargetId: String(missingTargetId) }) }
      }
      const composed = args.composedTarget
      if (
        composed === undefined ||
        composed.featureIds.length !== targetIds.length ||
        composed.featureIds.some((id, index) => id !== targetIds[index])
      ) {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeRequiresItsBodyTargetSetToBeComposed', { rawMode: String(rawMode), length: String(targetIds.length) }) }
      }
      target = composed.body
    } else {
      target = lookupTarget(currentTargetId)
    }
    if (target === undefined) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeTargetHasNoLiveBodyMissingOrAlready2', { rawMode: String(rawMode), currentTargetId: String(currentTargetId) }) }
    }
    targetId = currentTargetId
  }

  const rawEnd = payload.endCondition === undefined
    ? (rawDirection === 'midplane' ? 'symmetric' : 'blind')
    : payload.endCondition
  if (!isExtrudeEndCondition(rawEnd)) {
    return { ok: false, reason: workbenchText('extrudeParams.unknownExtrudeEndCondition', { value1: String(String(rawEnd)) }) }
  }

  let end: ExtrudeEnd
  if (rawEnd === 'blind' || rawEnd === 'symmetric') {
    if (rawEnd === 'symmetric') {
      const endRes = resolveExtrudeEnd('midplane', distance)
      if (!endRes.ok) return { ok: false, reason: endRes.reason }
      end = endRes.end
    } else {
      if (rawDirection === 'midplane') {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeBlindCannotUseDirectionSymmetricChooseTheSymmetric') }
      }
      const endRes = resolveExtrudeEnd(rawDirection, distance)
      if (!endRes.ok) return { ok: false, reason: endRes.reason }
      end = endRes.end
    }
  } else {
    if (rawDirection === 'midplane' && rawEnd !== 'throughAll') {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeDoesNotSupportASymmetricDirection', { rawEnd: String(rawEnd) }) }
    }
    const direction: 1 | -1 = rawDirection === 'down' ? -1 : 1
    const offset = payload.terminalOffset === undefined ? 0 : payload.terminalOffset
    if (typeof offset !== 'number' || !Number.isFinite(offset)) {
      return { ok: false, reason: workbenchText('extrudeParams.extrudeTerminalOffsetMustBeFiniteGot', { value1: String(String(offset)) }) }
    }

    if (rawEnd === 'toFace' || rawEnd === 'toPart' || rawEnd === 'toVertex') {
      const expected = rawEnd === 'toFace' ? 'face' : rawEnd === 'toVertex' ? 'vertex' : 'body'
      const resolved = resolvePersistedTarget(
        payload.endTarget,
        modelItemId,
        lookupTarget,
        args.lookupPlaneTarget,
        expected,
        args.resolveBodyTarget,
      )
      if (!resolved.ok) return resolved
      if ('bodyFeatureId' in resolved.target.identity && resolved.target.identity.bodyFeatureId === featureId) {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeEndConditionCannotTargetItsOwnOutputBody') }
      }
      end = { kind: rawEnd, direction, target: resolved.target, offset } as ExtrudeEnd
    } else {
      let candidates = [...(args.candidateTargets ?? [])].filter((candidate) => candidate.identity.bodyFeatureId !== featureId)
      if (modelItemId === undefined) {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeCannotBeResolvedWithoutTheActiveModelItemId', { rawEnd: String(rawEnd) }) }
      }
      const foreign = candidates.find((candidate) => candidate.identity.modelItemId !== modelItemId)
      if (foreign) {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeCandidateBelongsToAnotherModelItem', { rawEnd: String(rawEnd), bodyFeatureId: String(foreign.identity.bodyFeatureId) }) }
      }
      if (rawEnd === 'throughAll' && candidates.length === 0 && target !== undefined && targetId !== undefined) {
        candidates.push({ identity: { modelItemId, bodyFeatureId: targetId }, body: target })
      }
      if (payload.resolvedEndTargets !== undefined) {
        if (!Array.isArray(payload.resolvedEndTargets) || payload.resolvedEndTargets.length === 0) {
          return { ok: false, reason: workbenchText('extrudeParams.extrudeHasMalformedPersistedResolvedTargets', { rawEnd: String(rawEnd) }) }
        }
        const liveById = new Map<string, ResolvedExtrudeTarget[]>()
        for (const candidate of candidates) {
          const matches = liveById.get(candidate.identity.bodyFeatureId) ?? []
          matches.push(candidate)
          liveById.set(candidate.identity.bodyFeatureId, matches)
        }
        const resolvedCandidates: ResolvedExtrudeTarget[] = []
        for (const raw of payload.resolvedEndTargets) {
          const parsed = parseTargetIdentity(raw)
          if (!parsed.ok) return parsed
          if (!('bodyFeatureId' in parsed.identity)) {
            return { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetMustNameBodyGeometry', { rawEnd: String(rawEnd) }) }
          }
          const persistedId = parsed.identity.bodyFeatureId
          if (persistedId === undefined) {
            return { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetMustNameABodyFeature', { rawEnd: String(rawEnd) }) }
          }
          if (parsed.identity.modelItemId !== modelItemId) {
            return { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetBodyBelongsToAnotherModelItem', { rawEnd: String(rawEnd), persistedId: String(persistedId) }) }
          }
          const lineage = args.resolveBodyTarget?.(persistedId)
          if (lineage !== undefined && !lineage.ok) {
            return lineage.reason === 'lost'
              ? { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetBodyIsLostNoLiveDescendant', { rawEnd: String(rawEnd), persistedId: String(persistedId) }) }
              : { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetBodyIsAmbiguousBetweenLiveBodies', { rawEnd: String(rawEnd), persistedId: String(persistedId), value3: String(lineage.candidates.join(', ')) }) }
          }
          const currentId = lineage?.bodyId ?? persistedId
          const matches = liveById.get(currentId) ?? []
          if (matches.length === 0) {
            return { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetBodyResolvedToButHasNo', { rawEnd: String(rawEnd), persistedId: String(persistedId), currentId: String(currentId) }) }
          }
          if (matches.length > 1) {
            return { ok: false, reason: workbenchText('extrudeParams.extrudePersistedTargetBodyResolvesAmbiguouslyToDuplicateLive', { rawEnd: String(rawEnd), persistedId: String(persistedId), currentId: String(currentId) }) }
          }
          if (!resolvedCandidates.some((candidate) => candidate.identity.bodyFeatureId === currentId)) {
            resolvedCandidates.push(matches[0])
          }
        }
        candidates = resolvedCandidates
      }
      if (candidates.length === 0) {
        return { ok: false, reason: workbenchText('extrudeParams.extrudeRequiresAtLeastOneLiveSameItemTarget', { rawEnd: String(rawEnd) }) }
      }
      end = rawEnd === 'upToNext'
        ? { kind: 'upToNext', direction, candidates, offset }
        : { kind: 'throughAll', direction, targets: candidates, symmetric: rawDirection === 'midplane' }
    }
  }

  const req: ExtrudeRequest = {
    featureId,
    profiles,
    end,
    op,
    ...(target !== undefined ? { target } : {}),
    ...(modelItemId !== undefined ? { modelItemId } : {}),
  }
  return op === 'newBody'
    ? { ok: true, req }
    : { ok: true, req, hideTargetId: targetId }
}
