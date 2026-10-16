// WO-2857 fix round 2: the pure Model-tab helpers the background (no Model
// tab) replay needs, held under lib/cam so headlessFeatureReplay.ts keeps the
// architecture boundary (lib/cam may not import components). Each declaration
// below is a VERBATIM copy of the one in the file named on its section line;
// src/tests/cam/reopenedModelRefs.wo2857.test.ts compares every copy to its
// source text, so an edit to either side that is not made to both fails the
// declared slice instead of letting the background rebuild drift from the
// Model tab's. Types stay imported from the originals (type imports cross the
// boundary by design), so a changed signature is also a compile error here.
//
// Follow-up for the owner of src/components/model3d/ (held by WO-2856 when
// this was written): point those modules at this one and delete the copies.

import { textFor } from '../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type {
  BodyHandle,
  Diag,
  ExtrudeEnd,
  ExtrudeEndTargetIdentity,
  ExtrudePlaneTargetIdentity,
  ExtrudeRequest,
  ExtrudeTargetIdentity,
  PathChain,
  PlaneDef,
  ProfileRegion,
  ResolvedExtrudeFaceTarget,
  ResolvedExtrudePlaneTarget,
  ResolvedExtrudeTarget,
  Vec3,
} from '../../geom/geom-service'
import {
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_XZ_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
  evaluate,
  paramNodeId,
  parseExpression,
  type DagNodeSnapshot,
  type FeatureDag,
  type ParamDiag,
  type ParamLookup,
} from '../../doc'
import type { BasePlaneKind, PlaneFrame } from '../../sketch3d'
import type { ProfileSelector, ProfileSelectorResolution } from '../../components/model3d/workbench/regionSelector'
import type {
  BuildExtrudeRequestArgs,
  ExtrudeBoolMode,
  ExtrudeDirection,
  ExtrudeEndCondition,
  ExtrudeEndResolution,
  ExtrudeRequestBuild,
} from '../../components/model3d/workbench/extrudeParams'
import type { DrivenFieldResult } from '../../components/model3d/workbench/featureDimension'
import type { BodyTargetLineageResolution, WorkbenchBodyOpType } from '../../components/model3d/bodyLineage'
import type { DraftFaceFrame, DraftFaceNormalResult, PathAxis } from '../../components/model3d/dialogs/dressUpGeometry'

// ---- verbatim from src/components/model3d/workbench/regionSelector.ts ----

export function profileRegionSignature(region: ProfileRegion): string[] {
  return [...new Set(
    region.loops
      .flat()
      .map((segment) => segment.srcId)
      .filter((id) => id.length > 0),
  )].sort()
}

function normalizedSelectorSignature(signature: unknown): string[] | null {
  if (
    !Array.isArray(signature) ||
    signature.length === 0 ||
    signature.some((id) => typeof id !== 'string' || id.length === 0)
  ) return null
  return [...new Set(signature)].sort()
}

function signaturesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function resolveProfileSelector(
  regions: readonly ProfileRegion[] | undefined,
  selector: ProfileSelector | undefined,
): ProfileSelectorResolution {
  if (selector === undefined || selector.kind === 'whole-sketch') {
    return regions === undefined || regions.length === 0
      ? {
          ok: false,
          code: 'regions-unavailable',
          message: workbenchText('regionSelector.thisSketchNoLongerHasAClosedProfile'),
        }
      : { ok: true, profiles: [...regions] as [ProfileRegion, ...ProfileRegion[]] }
  }

  if (selector.kind === 'regions') {
    if (!Array.isArray(selector.regions) || selector.regions.length === 0) {
      return {
        ok: false,
        code: 'invalid-selector',
        message: workbenchText('regionSelector.thisFeatureHasAnInvalidSketchRegionSelection'),
      }
    }
    const profiles: ProfileRegion[] = []
    for (let index = 0; index < selector.regions.length; index++) {
      const selected = selector.regions[index]
      const resolved = resolveProfileSelector(regions, { kind: 'region', ...selected })
      if (!resolved.ok) {
        return {
          ok: false,
          code: resolved.code === 'invalid-selector' ? 'invalid-selector' : 'regions-unavailable',
          message: workbenchText('regionSelector.selectedSketchRegionIsUnavailable', { value1: String(index + 1), message: String(resolved.message) }),
        }
      }
      profiles.push(resolved.profiles[0])
    }
    return { ok: true, profiles: profiles as [ProfileRegion, ...ProfileRegion[]] }
  }

  if (selector.kind !== 'region') {
    return {
      ok: false,
      code: 'invalid-selector',
      message: workbenchText('regionSelector.thisFeatureHasAnInvalidSketchRegionSelection'),
    }
  }

  const signature = normalizedSelectorSignature(selector.signature)
  if (signature === null) {
    return {
      ok: false,
      code: 'invalid-selector',
      message: workbenchText('regionSelector.thisFeatureHasAnInvalidSketchRegionSelection'),
    }
  }
  if (regions === undefined || regions.length === 0) {
    return {
      ok: false,
      code: 'regions-unavailable',
      message: workbenchText('regionSelector.thisSketchDoesNotContainReplayableClosedRegions'),
    }
  }

  const matches = regions.filter((region) =>
    signaturesEqual(profileRegionSignature(region), signature),
  )
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'region-not-found',
      message: workbenchText('regionSelector.theSelectedSketchRegionChangedOrNoLongerExists'),
    }
  }
  if (matches.length === 1) return { ok: true, profiles: [matches[0]] }

  // Several regions now share this boundary lineage (see ProfileSelector.ordinal). Resolve ONLY by
  // the recorded position; a selector that never had one, or whose position no longer exists,
  // refuses by name rather than picking a region for the user.
  const ordinal = selector.ordinal
  if (ordinal === undefined || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= matches.length) {
    return {
      ok: false,
      code: 'region-ambiguous',
      message: workbenchText('regionSelector.severalSketchRegionsNowShareThisBoundarySelectThe'),
    }
  }
  return { ok: true, profiles: [matches[ordinal]] }
}

// ---- verbatim from src/components/model3d/workbench/extrudeParams.ts ----

export const EXTRUDE_DIRECTIONS = ['up', 'down', 'midplane'] as const

export const EXTRUDE_BOOL_MODES = ['newBody', 'add', 'remove', 'intersect'] as const

export const EXTRUDE_END_CONDITIONS = ['blind', 'symmetric', 'upToNext', 'toFace', 'toPart', 'toVertex', 'throughAll'] as const

export const DEFAULT_EXTRUDE_DIRECTION: ExtrudeDirection = 'up'

export const DEFAULT_EXTRUDE_BOOL_MODE: ExtrudeBoolMode = 'newBody'

export function isExtrudeDirection(v: unknown): v is ExtrudeDirection {
  return typeof v === 'string' && (EXTRUDE_DIRECTIONS as readonly string[]).includes(v)
}

export function isExtrudeBoolMode(v: unknown): v is ExtrudeBoolMode {
  return typeof v === 'string' && (EXTRUDE_BOOL_MODES as readonly string[]).includes(v)
}

export function isExtrudeEndCondition(v: unknown): v is ExtrudeEndCondition {
  return typeof v === 'string' && (EXTRUDE_END_CONDITIONS as readonly string[]).includes(v)
}

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

// ---- verbatim from src/components/model3d/workbench/featureDimension.ts ----

function paramLookup(dag: FeatureDag): ParamLookup {
  return (name) => {
    const producer = dag.getNode(paramNodeId(name))
    if (producer === undefined || producer.kind !== 'parameter') return { ok: false }
    const value = (producer.payload as { value?: unknown }).value
    return typeof value === 'number' ? { ok: true, value } : { ok: false }
  }
}

function toFeatureDimensionDiag(nodeId: string, field: string, diag: ParamDiag): Diag {
  return { code: 'KERNEL_OP_FAILED', severity: 'warning', params: { id: nodeId, field, paramCode: diag.code, ...diag.params } }
}

export function resolveDrivenField(dag: FeatureDag, node: DagNodeSnapshot, field: string): DrivenFieldResult {
  const payload = node.payload
  const literal = payload[field] as number
  const expression = payload.expression as string | undefined
  if (expression === undefined || expression.trim() === '') return { value: literal }
  const { ast } = parseExpression(expression)
  const result = evaluate(ast, paramLookup(dag))
  if (!result.ok) return { value: literal, diag: toFeatureDimensionDiag(node.id, field, result.diag) }
  if (result.value !== literal) dag.setPayload(node.id, { ...payload, [field]: result.value })
  return { value: result.value }
}

// ---- verbatim from src/components/model3d/workbench/basePlanes.ts ----

export const BASE_PLANE_FRAMES: Readonly<Record<BasePlaneKind, PlaneFrame>> = {
  xy: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
  xz: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } },
  yz: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } },
}

export const BASE_PLANE_BY_NODE_ID: Readonly<Record<string, BasePlaneKind>> = {
  [BASE_PLANE_XY_NODE_ID]: 'xy',
  [BASE_PLANE_XZ_NODE_ID]: 'xz',
  [BASE_PLANE_YZ_NODE_ID]: 'yz',
}

export function basePlaneFrame(nodeId: string): PlaneFrame | undefined {
  const kind = BASE_PLANE_BY_NODE_ID[nodeId]
  return kind === undefined ? undefined : BASE_PLANE_FRAMES[kind]
}

// ---- verbatim from src/components/model3d/bodyLineage.ts ----

export const WORKBENCH_BODY_OP_DEFINITIONS = Object.freeze([
  { opType: 'extrude', historyRole: 'feature' },
  { opType: 'revolve', historyRole: 'feature' },
  { opType: 'boolean', historyRole: 'feature' },
  { opType: 'fillet', historyRole: 'feature' },
  { opType: 'defeature', historyRole: 'direct-edit' },
  { opType: 'chamfer', historyRole: 'feature' },
  { opType: 'shell', historyRole: 'feature' },
  { opType: 'draft', historyRole: 'feature' },
  { opType: 'sweep', historyRole: 'feature' },
  { opType: 'loft', historyRole: 'feature' },
  { opType: 'hole', historyRole: 'feature' },
  // WO UI-80: push/pull (direct face offset) is a first-class modifier op --
  // consumes ONE upstream body, supersedes it, replays via client.editFeature
  // 'faceOffset'. Registered here (omission = build error at the executor's
  // `never` exhaustiveness check) so a push/pull commit lands as a real DAG
  // node, not an invisible payload.faceEdits sub-record on the owner.
  { opType: 'pushPull', historyRole: 'direct-edit' },
  // WO UI-71: resize-hole follows the same first-class history contract. Its
  // executor still uses the existing editFeature('holeDiameter') kernel path;
  // only the document representation changes from an invisible faceEdits
  // sub-record to a visible, undoable feature node.
  { opType: 'resizeHole', historyRole: 'direct-edit' },
  // Form (docs/design/FORM-ENVIRONMENT.md): a finished SubD form - payload is
  // the cage, replay sews its tessellated limit surface into a solid.
  { opType: 'form', historyRole: 'feature' },
  // WO-2171 image relief: a picture laid into a flat face of ONE consumed body
  // (payload = the picture + every control); replays through the geometry
  // worker's relief op (editFeature kind 'relief') and supersedes its owner.
  { opType: 'relief', historyRole: 'feature' },
] as const)

export const WORKBENCH_BODY_OP_TYPES: readonly WorkbenchBodyOpType[] = Object.freeze(
  WORKBENCH_BODY_OP_DEFINITIONS.map((definition) => definition.opType),
)

const WORKBENCH_BODY_OP_TYPE_SET: ReadonlySet<string> = new Set(WORKBENCH_BODY_OP_TYPES)

export function isWorkbenchBodyOpType(value: unknown): value is WorkbenchBodyOpType {
  return typeof value === 'string' && WORKBENCH_BODY_OP_TYPE_SET.has(value)
}

function bodyEdgeCarriesMaterial(dag: FeatureDag, consumerId: string, producerId: string): boolean {
  const node = dag.getNode(consumerId)
  if (node?.kind !== 'feature') return false

  const payload = node.payload
  switch (payload.opType) {
    case 'boolean': {
      const isTarget = payload.targetFeatureId === producerId
      const isTool = payload.toolFeatureId === producerId
      switch (payload.boolOp) {
        case 'fuse':
        case 'intersect':
          return isTarget || isTool
        case 'cut':
          return isTarget
        default:
          return false
      }
    }
    case 'extrude': {
      if (payload.boolMode !== 'add' && payload.boolMode !== 'remove' && payload.boolMode !== 'intersect') {
        return false
      }
      if (payload.targetFeatureIds !== undefined) {
        const targets = payload.targetFeatureIds
        if (
          !Array.isArray(targets) ||
          targets.length === 0 ||
          !targets.every((id): id is string => typeof id === 'string' && id.length > 0) ||
          new Set(targets).size !== targets.length ||
          targets.some((id) => !node.consumes.includes(id))
        ) {
          return false
        }
        return targets.includes(producerId)
      }
      return payload.targetFeatureId === producerId
    }
    case 'revolve':
    case 'fillet':
    case 'defeature':
    case 'chamfer':
    case 'shell':
    case 'draft':
    case 'sweep':
    case 'loft':
    case 'hole':
    case 'pushPull':
    case 'resizeHole':
    case 'form':
    case 'relief':
      return true
    default:
      return false
  }
}

export function resolveBodyTargetLineage(
  dag: FeatureDag,
  bodyFeatureIds: readonly string[],
  liveBodyIds: readonly string[],
  persistedBodyId: string,
): BodyTargetLineageResolution {
  const bodyIds = new Set(bodyFeatureIds)
  if (!bodyIds.has(persistedBodyId)) return { ok: false, reason: "lost", candidates: [] }

  const live = [...new Set(liveBodyIds)]
  const invalidLiveId = live.find((id) => !bodyIds.has(id))
  if (invalidLiveId !== undefined) {
    throw new Error(`live body '${invalidLiveId}' is absent from the body-producer census`)
  }
  if (live.includes(persistedBodyId)) return { ok: true, bodyId: persistedBodyId }

  // A body reference follows material through body-producing features only.
  // Walking the raw DAG closure would cross BODY -> datum -> sketch -> a new
  // independent body and falsely treat that body as containing the original.
  const bodyConsumers = new Map<string, string[]>()
  for (const consumerId of bodyIds) {
    for (const producerId of dag.getNode(consumerId)?.consumes ?? []) {
      if (!bodyIds.has(producerId) || !bodyEdgeCarriesMaterial(dag, consumerId, producerId)) continue
      const consumers = bodyConsumers.get(producerId) ?? []
      consumers.push(consumerId)
      bodyConsumers.set(producerId, consumers)
    }
  }
  const descendants = new Set<string>()
  const pending = [...(bodyConsumers.get(persistedBodyId) ?? [])]
  while (pending.length > 0) {
    const consumerId = pending.pop()!
    if (descendants.has(consumerId)) continue
    descendants.add(consumerId)
    pending.push(...(bodyConsumers.get(consumerId) ?? []))
  }

  const candidates = live.filter((id) => descendants.has(id))
  if (candidates.length === 1) return { ok: true, bodyId: candidates[0] }
  if (candidates.length === 0) return { ok: false, reason: "lost", candidates: [] }
  return { ok: false, reason: "ambiguous", candidates }
}

export function bodyFeatureIds(dag: FeatureDag): string[] {
  return dag.nodeIds().filter((id) => {
    const node = dag.getNode(id)
    if (node === undefined) return false
    // An imported body is body-producing exactly like a 'feature' opType node
    // (selectable/push-pullable/exportable), just under the DAG's OWN dedicated
    // 'import' kind (dag.ts's DAG_NODE_KINDS) rather than 'feature'+opType; a
    // 'meshImport' node (a prismatic STL rebuilt as a solid) is a body producer
    // too. All three branches apply the SAME suppressed/rolled-back liveness gate.
    if (node.kind !== 'feature' && node.kind !== 'import' && node.kind !== 'meshImport') return false
    if (node.kind === 'feature' && !isWorkbenchBodyOpType(node.payload.opType)) return false
    return !dag.isEffectivelySuppressed(id) && !dag.isRolledBack(id)
  })
}

export function liveBodyFeatureIds(dag: FeatureDag, hasBody: (id: string) => boolean): string[] {
  const ids = bodyFeatureIds(dag)
  const bodyIdSet = new Set(ids)
  const superseded = new Set<string>()
  for (const id of ids) {
    if (!hasBody(id)) continue
    // Walk the entire body-producing ancestry. A dress-up op disposes its direct
    // input handle after success, so a chain F1 -> F2 -> F3 can have handles only
    // for F1 and F3; stopping at bodyless F2 would incorrectly resurrect F1 as a
    // second live row/pick candidate. A failed child has no handle and never
    // starts this traversal, preserving the valid-owner fallback.
    const pending = [...(dag.getNode(id)?.consumes ?? [])]
    while (pending.length > 0) {
      const producer = pending.pop()!
      if (!bodyIdSet.has(producer) || superseded.has(producer)) continue
      superseded.add(producer)
      pending.push(...(dag.getNode(producer)?.consumes ?? []))
    }
  }
  // hasBody(id) is REQUIRED in the returned set itself, not just while building
  // the superseded set above -- a node that legitimately refused at the kernel
  // (e.g. DRAFT_FAILED on replay) is never superseded by anything, so without
  // this term it survived the filter with no body handle at all.
  return ids.filter((id) => hasBody(id) && !superseded.has(id))
}

// ---- verbatim from src/components/model3d/dialogs/dressUpGeometry.ts ----

export function buildAxisPathChain(axis: PathAxis, length: number): PathChain {
  const byAxis: Record<PathAxis, { xDir: Vec3; normal: Vec3 }> = {
    x: { xDir: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    y: { xDir: { x: 0, y: 1, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
    z: { xDir: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: 1, z: 0 } },
  }
  const { xDir, normal } = byAxis[axis]
  return {
    sketchId: 'UI13A_PATH',
    plane: { origin: { x: 0, y: 0, z: 0 }, normal, xDir },
    segments: [{ kind: 'line', a: [0, 0], b: [length, 0], srcId: 'UI13A_PATH.e0' }],
  }
}

const AXIS_UNIT: Record<PathAxis, Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
}

export function draftPullDir(axis: PathAxis, flip: boolean): Vec3 {
  const u = AXIS_UNIT[axis]
  // `|| 0` normalizes a negated 0 component back to +0 (flipping 'x' negates y/z too) -- cosmetic
  // (-0 === 0 and behaves identically in every arithmetic use), but keeps DRAFT_PULL_DIR's own
  // literal {x:0,y:0,z:-1} byte-comparable to draftPullDir('z', true)'s output (decomposePrincipalAxis's
  // own round-trip test relies on this).
  return flip ? { x: -u.x || 0, y: -u.y || 0, z: -u.z || 0 } : { ...u }
}

export function draftNeutralPlane(pullDir: Vec3, offset: number): { origin: Vec3; normal: Vec3 } {
  return { origin: { x: pullDir.x * offset, y: pullDir.y * offset, z: pullDir.z * offset }, normal: { ...pullDir } }
}

export function draftFaceNormalPlane(
  frame: DraftFaceFrame | undefined,
  flip: boolean,
  offset: number,
): DraftFaceNormalResult {
  if (frame === undefined) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceFrameIsUnavailableRePickTheFace') }
  }
  const origin = frame.origin
  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceFrameOriginIsDegenerateRePickThe') }
  }
  const normal = frame.normal
  if (![normal.x, normal.y, normal.z].every(Number.isFinite)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceNormalIsDegenerateRePickTheFace') }
  }
  const length = Math.hypot(normal.x, normal.y, normal.z)
  if (!(length > 1e-9)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceNormalIsDegenerateRePickTheFace') }
  }
  if (!Number.isFinite(offset)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.draftNeutralPlaneOffsetMustBeAFiniteNumber') }
  }
  const directionScale = (flip ? -1 : 1) / length
  const pullDir = {
    x: normal.x * directionScale || 0,
    y: normal.y * directionScale || 0,
    z: normal.z * directionScale || 0,
  }
  return {
    ok: true,
    pullDir,
    neutralPlane: {
      origin: {
        x: origin.x + pullDir.x * offset,
        y: origin.y + pullDir.y * offset,
        z: origin.z + pullDir.z * offset,
      },
      normal: { ...pullDir },
    },
  }
}

