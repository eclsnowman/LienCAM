import type { HeightIntentV1, HeightParams } from '../../../types'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type ResolvedHeightPlanV2,
  type SmartHeightBoundsMm,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
} from './types'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

/** `model_top` is the smart stock-footprint Face (WO-2694, the operator 2026-10-09:
 * "smart height should be model top, but user over ridable"): the bottom is
 * the setup's model top, re-resolved from live evidence on every compute.
 * `explicit_depth` is the operator's own WCS plane, kept exactly as set. Both
 * persist as the `explicit_depth` policy variant over the stock footprint;
 * the Target End plane and its owner tell them apart. */
export type FaceSmartHeightMode = 'target_face' | 'explicit_depth' | 'model_top'

export interface FaceSmartHeightDraft {
  mode: FaceSmartHeightMode
  explicitTargetWcsMm: number
}

export interface FaceSmartHeightIntentInput {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  mode: FaceSmartHeightMode
  geometryIds?: string[]
  stockId?: string
  explicitTargetWcsMm?: number
}

export interface FaceSmartHeightStockEvidence {
  stockId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface FaceSmartHeightTargetEvidence {
  geometryId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  selectedPlaneMachineMm: number
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface FaceSmartHeightRemainingEvidence {
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
  schemaVersion?: number
}

/** The top of the model the setup's stock holds (machine Z), for a Face whose
 * smart Target End is the model top. */
export interface FaceSmartHeightModelTopEvidence {
  stockId: string
  geometryIds: string[]
  modelTopMachineMm: number
  fingerprint: string
}

export interface FaceSmartHeightEvidenceInput {
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  owningStocks: FaceSmartHeightStockEvidence[]
  floorStockToLeaveMm: number
  geometryIds?: string[]
  target?: FaceSmartHeightTargetEvidence
  remainingMaterial?: FaceSmartHeightRemainingEvidence
  modelTop?: FaceSmartHeightModelTopEvidence
}

export interface ResolvedFaceSmartHeights {
  plan: ResolvedHeightPlanV2
  /** WCS-relative scalar envelope handed to the existing Face worker. */
  workerHeights: HeightParams
  /** Exact V1 mirror spelling for diagnostics and persisted resolution snapshots. */
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
}

export class FaceSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Face Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'FaceSmartHeightError'
    this.refusal = refusal
  }
}

/** Recover the editable Face controls from a persisted V2 policy without
 * consulting legacy scalar heights. */
export function faceSmartHeightDraftFromIntent(intent: OperationHeightIntentV2): FaceSmartHeightDraft {
  if (intent.policy.operationType !== 'face') {
    throw new Error(`Cannot edit '${intent.policy.operationType}' as a Face Smart Height policy.`)
  }
  if (intent.policy.variant === 'target_face') {
    return { mode: 'target_face', explicitTargetWcsMm: 0 }
  }
  if (intent.policy.variant !== 'explicit_depth') {
    throw new Error(`Unsupported Face Smart Height variant '${intent.policy.variant}'.`)
  }
  const end = intent.machining.end.value
  if (end.kind === 'bounded_plane' && end.plane.reference === 'model_top' &&
      intent.machining.end.owner.kind === 'operation_policy') {
    return { mode: 'model_top', explicitTargetWcsMm: end.plane.offsetMm }
  }
  if (end.kind !== 'bounded_plane' || end.plane.reference !== 'wcs_plane') {
    throw new Error('Face explicit-depth policy does not contain a WCS target plane.')
  }
  return { mode: 'explicit_depth', explicitTargetWcsMm: end.plane.offsetMm }
}

/** True when resolving this Face needs the setup's model top as evidence: its
 * smart Target End, or an operator row plane written against Model top. */
export function faceIntentReferencesModelTop(intent: OperationHeightIntentV2): boolean {
  const end = intent.machining.end.value
  const endPlane = end.kind === 'bounded_plane' || end.kind === 'selected_plane' ? end.plane : undefined
  return endPlane?.reference === 'model_top' ||
    intent.planeOverrides?.top?.reference === 'model_top' ||
    intent.planeOverrides?.bottom?.reference === 'model_top'
}

const policyOwner = { kind: 'operation_policy' as const }
const userOwner = { kind: 'user_override' as const }

function setupOwner(setupId: string) {
  return { kind: 'setup' as const, setupId }
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function validBounds(bounds: SmartHeightBoundsMm, label: string): SmartHeightBoundsMm {
  for (const [axis, value] of Object.entries(bounds)) finite(value, `${label} ${axis}`)
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new Error(`${label} has inverted bounds.`)
  }
  return { ...bounds }
}

function fingerprint(prefix: string, values: readonly string[]): string {
  return [prefix, ...values].join(':')
}

function artifact(
  value: Pick<FaceSmartHeightStockEvidence, 'artifactId' | 'fingerprint' | 'representation' | 'schemaVersion'>,
  boundsMm: SmartHeightBoundsMm,
) {
  return {
    artifactId: value.artifactId,
    schemaVersion: value.schemaVersion ?? 1,
    representation: value.representation,
    frame: 'machine' as const,
    boundsMm: { ...boundsMm },
    fingerprint: value.fingerprint,
  }
}

function boundsOverlap(left: SmartHeightBoundsMm, right: SmartHeightBoundsMm): boolean {
  return left.minX <= right.maxX && left.maxX >= right.minX &&
    left.minY <= right.maxY && left.maxY >= right.minY &&
    left.minZ <= right.maxZ && left.maxZ >= right.minZ
}

/** Author Face semantics without inheriting the generic V1 Top-minus-5 default.
 * A stock-boundary Face is not complete until the operator selects a target
 * face or confirms an explicit WCS endpoint. */
export function buildFaceSmartHeightIntent(input: FaceSmartHeightIntentInput): OperationHeightIntentV2 {
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: value.reference,
    offsetMm: value.offset,
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  if (input.mode === 'target_face') {
    const geometryIds = input.geometryIds?.filter(Boolean) ?? []
    if (geometryIds.length === 0) {
      throw new Error('Face target-face intent requires selected target geometry.')
    }
    return {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'face', variant: 'target_face' },
      safety: {
        clearance: safetyPlane(input.safetyIntent.clearance),
        retract: safetyPlane(input.safetyIntent.retract),
        feed: safetyPlane(input.safetyIntent.feed),
      },
      machining: {
        start: { owner: policyOwner, value: { kind: 'current_material' } },
        end: {
          owner: userOwner,
          value: {
            kind: 'selected_plane',
            plane: { reference: 'picked_surface', offsetMm: 0, owner: userOwner },
          },
        },
        scope: {
          owner: policyOwner,
          value: { kind: 'selected_geometry', geometryIds: [...geometryIds] },
        },
      },
    }
  }

  const stockId = input.stockId?.trim() ?? ''
  if (!stockId) throw new Error('Face explicit-depth intent requires an owning stock.')
  // WO-2694: the smart Face ends at the model top. The policy owns that plane,
  // so it follows the model and the stock; the operator's own plane (below)
  // replaces it and is kept exactly as typed.
  const end = input.mode === 'model_top'
    ? {
        owner: policyOwner,
        value: {
          kind: 'bounded_plane' as const,
          plane: { reference: 'model_top' as const, offsetMm: 0, owner: policyOwner },
        },
      }
    : {
        owner: userOwner,
        value: {
          kind: 'bounded_plane' as const,
          plane: {
            reference: 'wcs_plane' as const,
            offsetMm: finite(input.explicitTargetWcsMm ?? NaN, 'Face explicit Target End'),
            owner: userOwner,
          },
        },
      }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'face', variant: 'explicit_depth' },
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: { owner: policyOwner, value: { kind: 'current_material' } },
      end,
      scope: {
        owner: policyOwner,
        value: { kind: 'stock_footprint', stockId },
      },
    },
  }
}

/** Build the exact evidence graph shared by Face preview and dispatch. */
export function buildFaceSmartHeightEvidenceContext(
  input: FaceSmartHeightEvidenceInput,
): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Face WCS origin')
  finite(input.floorStockToLeaveMm, 'Face floor stock to leave')
  if (input.floorStockToLeaveMm < 0) throw new Error('Face floor stock to leave cannot be negative.')
  const geometryIds = input.geometryIds?.filter(Boolean) ?? []
  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const nodes: SmartHeightEvidenceNode[] = [
    {
      id: wcsId,
      kind: 'setup_wcs',
      role: 'wcs_origin',
      entityId: input.operationId,
      dependencyNodeIds: [],
      dependencyFingerprint: fingerprint(input.revision.setupRevision, [String(input.wcsOriginMachineMm)]),
      scalar: { frame: 'machine', valueMm: input.wcsOriginMachineMm },
    },
    {
      id: scopeId,
      kind: 'operation_scope',
      role: 'scope',
      entityId: input.operationId,
      dependencyNodeIds: [wcsId],
      dependencyFingerprint: fingerprint(input.revision.operationRevision, geometryIds),
    },
  ]

  const stocks = input.owningStocks.map(stock => ({
    ...stock,
    boundsMachineMm: validBounds(stock.boundsMachineMm, `Face stock '${stock.stockId}'`),
  }))
  for (const stock of stocks) {
    const materialId = `owning-stock:${stock.stockId}:material`
    const stockFingerprint = fingerprint(stock.fingerprint, [stock.stockId])
    nodes.push(
      {
        id: materialId,
        kind: 'owning_stock',
        role: 'material_artifact',
        entityId: stock.stockId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: stockFingerprint,
        spatial: artifact(stock, stock.boundsMachineMm),
      },
      {
        id: `owning-stock:${stock.stockId}:top`,
        kind: 'owning_stock',
        role: 'stock_top',
        entityId: stock.stockId,
        dependencyNodeIds: [materialId],
        dependencyFingerprint: stockFingerprint,
        scalar: { frame: 'machine', valueMm: stock.boundsMachineMm.maxZ },
      },
      {
        id: `owning-stock:${stock.stockId}:bottom`,
        kind: 'owning_stock',
        role: 'stock_bottom',
        entityId: stock.stockId,
        dependencyNodeIds: [materialId],
        dependencyFingerprint: stockFingerprint,
        scalar: { frame: 'machine', valueMm: stock.boundsMachineMm.minZ },
      },
    )
  }

  if (input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const remainingBounds = validBounds(remaining.boundsMachineMm, 'Face remaining material')
    const materialId = `remaining-material:${remaining.artifactId}`
    nodes.push(
      {
        id: materialId,
        kind: 'remaining_material',
        role: 'material_artifact',
        entityId: remaining.artifactId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: remaining.fingerprint,
        spatial: artifact(remaining, remainingBounds),
      },
      {
        id: `${materialId}:top`,
        kind: 'remaining_material',
        role: 'material_top',
        entityId: remaining.artifactId,
        dependencyNodeIds: [materialId],
        dependencyFingerprint: remaining.fingerprint,
        scalar: {
          frame: 'machine',
          valueMm: finite(remaining.materialTopMachineMm, 'Face remaining material Top'),
        },
      },
    )
  }

  if (input.target) {
    const target = input.target
    const targetBounds = validBounds(target.boundsMachineMm, `Face target '${target.geometryId}'`)
    if (!geometryIds.includes(target.geometryId)) {
      throw new Error(`Face target '${target.geometryId}' is outside the operation scope.`)
    }
    if (stocks.length === 1 && !boundsOverlap(targetBounds, stocks[0].boundsMachineMm)) {
      throw new Error(`Face target '${target.geometryId}' does not intersect its owning stock.`)
    }
    const selectedPlane = finite(target.selectedPlaneMachineMm, 'Face selected target plane')
    if (stocks.length === 1 &&
        (selectedPlane < stocks[0].boundsMachineMm.minZ || selectedPlane > stocks[0].boundsMachineMm.maxZ)) {
      throw new Error(`Face selected target plane is outside owning stock '${stocks[0].stockId}'.`)
    }
    const targetId = `target-model:${target.geometryId}`
    nodes.push(
      {
        id: targetId,
        kind: 'target_model',
        role: 'target_artifact',
        entityId: target.geometryId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: target.fingerprint,
        spatial: artifact(target, targetBounds),
      },
      {
        id: `selected-plane:${target.geometryId}`,
        kind: 'selected_plane',
        role: 'selected_plane',
        entityId: target.geometryId,
        dependencyNodeIds: [targetId],
        dependencyFingerprint: target.fingerprint,
        scalar: { frame: 'machine', valueMm: selectedPlane },
      },
    )
  }

  if (input.modelTop) {
    const modelTop = input.modelTop
    nodes.push({
      id: `target-model:${modelTop.stockId}:model-top`,
      kind: 'target_model',
      role: 'target_top',
      entityId: modelTop.stockId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: fingerprint(modelTop.fingerprint, modelTop.geometryIds),
      scalar: { frame: 'machine', valueMm: finite(modelTop.modelTopMachineMm, 'Face model top') },
    })
  }

  nodes.push({
    id: `allowance:${input.operationId}:floor`,
    kind: 'strategy_allowance',
    role: 'cutter_end_allowance',
    entityId: input.operationId,
    dependencyNodeIds: input.target ? [`selected-plane:${input.target.geometryId}`] : [scopeId],
    dependencyFingerprint: fingerprint(input.revision.operationRevision, [String(input.floorStockToLeaveMm)]),
    scalar: { frame: 'machine', valueMm: input.floorStockToLeaveMm },
  })

  return {
    revision: { ...input.revision },
    operationType: 'face',
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}

/** Resolve Face once, validate that durable scope still matches live evidence,
 * and adapt the immutable result to the legacy worker's scalar input shape. */
export function resolveFaceSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds?: string[]
  stockId?: string
}): ResolvedFaceSmartHeights {
  if (input.intent.policy.operationType !== 'face') {
    throw new FaceSmartHeightError({
      code: 'policy_mismatch', message: 'Face Smart Height received a non-Face intent.',
    })
  }
  const scope = input.intent.machining.scope.value
  if (input.intent.policy.variant === 'target_face') {
    const geometryIds = input.geometryIds ?? []
    if (scope.kind !== 'selected_geometry' || scope.geometryIds.length !== geometryIds.length ||
        scope.geometryIds.some((id, index) => id !== geometryIds[index])) {
      throw new FaceSmartHeightError({
        code: 'policy_mismatch',
        message: 'Face Smart Height target scope no longer matches the selected geometry.',
      })
    }
  } else if (scope.kind !== 'stock_footprint' || scope.stockId !== input.stockId) {
    throw new FaceSmartHeightError({
      code: 'policy_mismatch',
      message: 'Face Smart Height stock scope no longer matches the owning stock.',
    })
  }

  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new FaceSmartHeightError(result.refusal)
  const plan = result.plan
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!cutterEnd) {
    throw new FaceSmartHeightError({
      code: 'invalid_evidence', message: 'Face Smart Height resolved no cutter-center Target End.',
    })
  }
  const feed = plan.safety.feed
  if (!feed) {
    throw new FaceSmartHeightError({
      code: 'invalid_intent', message: 'Face Smart Height requires a Feed plane.',
    })
  }
  const inferred = (offset: number) => ({
    reference: 'wcs_plane' as const,
    offset,
    provenance: 'inferred' as const,
  })
  const snapshotIntent: HeightIntentV1 = {
    version: 1,
    clearance: inferred(plan.safety.clearance.wcsMm),
    retract: inferred(plan.safety.retract.wcsMm),
    feed: inferred(feed.wcsMm),
    top: inferred(plan.machining.materialStart.wcsMm),
    bottom: inferred(cutterEnd.wcsMm),
  }
  const workerHeights: HeightParams = {
    clearanceHeight: plan.safety.clearance.wcsMm,
    clearanceHeightMode: 'absolute',
    retractHeight: plan.safety.retract.wcsMm,
    feedHeight: feed.wcsMm,
    topHeight: plan.machining.materialStart.wcsMm,
    topHeightMode: 'absolute',
    bottomHeight: cutterEnd.wcsMm,
    bottomHeightMode: 'absolute',
    heightIntent: snapshotIntent,
  }
  return {
    plan,
    workerHeights,
    snapshotIntent,
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
  }
}
