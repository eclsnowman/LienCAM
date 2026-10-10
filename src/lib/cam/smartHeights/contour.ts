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
  type StableFeatureReference,
} from './types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type ContourSmartHeightMode =
  | 'selected_feature'
  | 'through_stock'
  | 'stock_bottom'
  | 'model_bottom'
  | 'explicit_depth'

export interface ContourSmartHeightDraft {
  mode: ContourSmartHeightMode
  explicitTargetWcsMm: number
  throughAllowanceMm: number
}

export interface ContourSmartHeightIntentInput {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  mode: ContourSmartHeightMode
  geometryIds?: string[]
  features?: StableFeatureReference[]
  explicitTargetWcsMm?: number
  throughAllowanceMm?: number
}

export interface ContourStockEvidence {
  stockId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface ContourTargetModelEvidence {
  geometryId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface ContourSelectedFeatureEvidence {
  loopId: string
  feature: StableFeatureReference
  topMachineMm: number
  floorMachineMm: number
  fingerprint: string
}

export interface ContourRemainingMaterialEvidence {
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
  schemaVersion?: number
}

export interface ContourSmartHeightEvidenceInput {
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  geometryIds: string[]
  owningStocks: ContourStockEvidence[]
  floorStockToLeaveMm: number
  selectedFeatures?: ContourSelectedFeatureEvidence[]
  targets?: ContourTargetModelEvidence[]
  remainingMaterial?: ContourRemainingMaterialEvidence
}

export interface ResolvedContourFeatureEndpoint {
  loopId: string
  feature: StableFeatureReference
  physicalTargetWcsMm: number
  cutterCenterEndWcsMm: number
}

export interface ResolvedContourSmartHeights {
  plan: ResolvedHeightPlanV2
  workerHeights: HeightParams
  /** V2 resolves axial allowance once; the worker must not apply it again. */
  workerFloorStockToLeaveMm: 0
  loopBottoms?: Record<string, number>
  featureEndpoints: ResolvedContourFeatureEndpoint[]
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
}

export class ContourSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Contour Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'ContourSmartHeightError'
    this.refusal = refusal
  }
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

function nonNegative(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked < 0) throw new Error(`${label} cannot be negative.`)
  return checked
}

function nonBlankIds(values: readonly string[] | undefined, label: string): string[] {
  const ids = (values ?? []).map(value => value.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error(`${label} requires at least one id.`)
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids.`)
  return ids
}

function featureKey(feature: StableFeatureReference): string {
  return [
    feature.modelItemId,
    feature.bodyId,
    feature.featureKind,
    feature.stableId,
    String(feature.sourceVersion),
    feature.sourceFingerprint,
  ].join('\u001f')
}

function validFeature(feature: StableFeatureReference, label: string): StableFeatureReference {
  const fields = [feature.modelItemId, feature.bodyId, feature.featureKind, feature.stableId, feature.sourceFingerprint]
  if (fields.some(value => !value.trim())) throw new Error(`${label} has a blank identity field.`)
  if (!Number.isInteger(feature.sourceVersion) || feature.sourceVersion < 0) {
    throw new Error(`${label} sourceVersion must be a non-negative integer.`)
  }
  return { ...feature }
}

function validFeatures(features: readonly StableFeatureReference[] | undefined, label: string): StableFeatureReference[] {
  const checked = (features ?? []).map((feature, index) => validFeature(feature, `${label} ${index + 1}`))
  if (checked.length === 0) throw new Error(`${label} requires at least one stable feature.`)
  const keys = checked.map(featureKey)
  if (new Set(keys).size !== keys.length) throw new Error(`${label} contains duplicate stable features.`)
  return checked
}

function validBounds(bounds: SmartHeightBoundsMm, label: string): SmartHeightBoundsMm {
  for (const [axis, value] of Object.entries(bounds)) finite(value, `${label} ${axis}`)
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new Error(`${label} has inverted bounds.`)
  }
  return { ...bounds }
}

function artifact(
  value: Pick<ContourStockEvidence, 'artifactId' | 'fingerprint' | 'representation' | 'schemaVersion'>,
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

function evidenceFingerprint(prefix: string, values: unknown): string {
  return `${prefix}:${smartHeightEvidenceFingerprint(values)}`
}

/** Author the physical Contour endpoint. Flat 2D input is never assigned a
 * generic Top-minus-5 default: it must use an explicitly selected mode. */
export function buildContourSmartHeightIntent(
  input: ContourSmartHeightIntentInput,
): OperationHeightIntentV2 {
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'Contour safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const safety = {
    clearance: safetyPlane(input.safetyIntent.clearance),
    retract: safetyPlane(input.safetyIntent.retract),
    feed: safetyPlane(input.safetyIntent.feed),
  }

  if (input.mode === 'selected_feature') {
    const features = validFeatures(input.features, 'Contour selected-feature intent')
    return {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'contour_2d', variant: 'selected_feature' },
      safety,
      machining: {
        start: { owner: policyOwner, value: { kind: 'current_material' } },
        end: { owner: policyOwner, value: { kind: 'detected_feature_floors' } },
        scope: { owner: policyOwner, value: { kind: 'selected_features', features } },
      },
    }
  }

  const geometryIds = nonBlankIds(input.geometryIds, `Contour ${input.mode} scope`)
  const common = {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    safety,
    machining: {
      start: { owner: policyOwner, value: { kind: 'current_material' as const } },
      scope: {
        owner: policyOwner,
        value: { kind: 'selected_geometry' as const, geometryIds },
      },
    },
  }

  if (input.mode === 'through_stock') {
    return {
      ...common,
      policy: { operationType: 'contour_2d', variant: 'through_stock' },
      machining: {
        ...common.machining,
        end: {
          owner: userOwner,
          value: { kind: 'through_stock', allowanceMm: nonNegative(input.throughAllowanceMm ?? 0, 'Contour breakthrough allowance') },
        },
      },
    }
  }
  if (input.mode === 'stock_bottom') {
    return {
      ...common,
      policy: { operationType: 'contour_2d', variant: 'stock_bottom' },
      machining: {
        ...common.machining,
        end: { owner: policyOwner, value: { kind: 'stock_bottom', allowanceMm: 0 } },
      },
    }
  }
  if (input.mode === 'model_bottom') {
    return {
      ...common,
      policy: { operationType: 'contour_2d', variant: 'model_bottom' },
      machining: {
        ...common.machining,
        end: { owner: policyOwner, value: { kind: 'model_bottom', allowanceMm: 0 } },
      },
    }
  }
  return {
    ...common,
    policy: { operationType: 'contour_2d', variant: 'explicit_depth' },
    machining: {
      ...common.machining,
      end: {
        owner: userOwner,
        value: {
          kind: 'bounded_plane',
          plane: {
            reference: 'wcs_plane',
            offsetMm: finite(input.explicitTargetWcsMm ?? NaN, 'Contour explicit Target End'),
            owner: userOwner,
          },
        },
      },
    },
  }
}

/** Recover the editable Contour endpoint from persisted V2 authority. Legacy
 * scalar heights are intentionally not consulted: a V2 edit round-trip is
 * policy -> draft -> policy, while frozen V1 remains under its old authority. */
export function contourSmartHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
): ContourSmartHeightDraft {
  if (intent.policy.operationType !== 'contour_2d') {
    throw new Error(`Cannot edit '${intent.policy.operationType}' as a Contour Smart Height policy.`)
  }
  const mode = intent.policy.variant
  if (mode !== 'selected_feature' && mode !== 'through_stock' &&
      mode !== 'stock_bottom' && mode !== 'model_bottom' && mode !== 'explicit_depth') {
    throw new Error(`Unsupported Contour Smart Height variant '${String(mode)}'.`)
  }
  const end = intent.machining.end.value
  if (mode === 'through_stock') {
    if (end.kind !== 'through_stock') {
      throw new Error('Contour through-stock policy has no breakthrough allowance.')
    }
    return { mode, explicitTargetWcsMm: 0, throughAllowanceMm: end.allowanceMm }
  }
  if (mode === 'explicit_depth') {
    if (end.kind !== 'bounded_plane' || end.plane.reference !== 'wcs_plane') {
      throw new Error('Contour explicit-depth policy has no WCS Target End.')
    }
    return { mode, explicitTargetWcsMm: end.plane.offsetMm, throughAllowanceMm: 0 }
  }
  return { mode, explicitTargetWcsMm: 0, throughAllowanceMm: 0 }
}

/** Build one revision-stamped graph for both preview and dispatch. */
export function buildContourSmartHeightEvidenceContext(
  input: ContourSmartHeightEvidenceInput,
): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Contour WCS origin')
  const floorAllowance = nonNegative(input.floorStockToLeaveMm, 'Contour floor stock to leave')
  const geometryIds = input.geometryIds.map(id => id.trim()).filter(Boolean)
  if (new Set(geometryIds).size !== geometryIds.length) {
    throw new Error('Contour evidence scope contains duplicate geometry ids.')
  }
  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const nodes: SmartHeightEvidenceNode[] = [
    {
      id: wcsId,
      kind: 'setup_wcs',
      role: 'wcs_origin',
      entityId: input.operationId,
      dependencyNodeIds: [],
      dependencyFingerprint: evidenceFingerprint(input.revision.setupRevision, input.wcsOriginMachineMm),
      scalar: { frame: 'machine', valueMm: input.wcsOriginMachineMm },
    },
    {
      id: scopeId,
      kind: 'operation_scope',
      role: 'scope',
      entityId: input.operationId,
      dependencyNodeIds: [wcsId],
      dependencyFingerprint: evidenceFingerprint(input.revision.operationRevision, {
        geometryIds,
        features: (input.selectedFeatures ?? []).map(item => featureKey(item.feature)),
      }),
    },
  ]

  const stocks = input.owningStocks.map(stock => ({
    ...stock,
    stockId: stock.stockId.trim(),
    boundsMachineMm: validBounds(stock.boundsMachineMm, `Contour stock '${stock.stockId}'`),
  }))
  if (stocks.some(stock => !stock.stockId)) throw new Error('Contour stock id cannot be blank.')
  for (const stock of stocks) {
    const materialId = `owning-stock:${stock.stockId}:material`
    const stockFingerprint = evidenceFingerprint(stock.fingerprint, stock.boundsMachineMm)
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
    const bounds = validBounds(remaining.boundsMachineMm, 'Contour remaining material')
    const materialId = `remaining-material:${remaining.artifactId}`
    nodes.push(
      {
        id: materialId,
        kind: 'remaining_material',
        role: 'material_artifact',
        entityId: remaining.artifactId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: remaining.fingerprint,
        spatial: artifact(remaining, bounds),
      },
      {
        id: `${materialId}:top`,
        kind: 'remaining_material',
        role: 'material_top',
        entityId: remaining.artifactId,
        dependencyNodeIds: [materialId],
        dependencyFingerprint: remaining.fingerprint,
        scalar: { frame: 'machine', valueMm: finite(remaining.materialTopMachineMm, 'Contour remaining-material top') },
      },
    )
  }

  const targets = input.targets ?? []
  for (const target of targets) {
    const bounds = validBounds(target.boundsMachineMm, `Contour target '${target.geometryId}'`)
    const artifactId = `target-model:${target.geometryId}:artifact`
    nodes.push(
      {
        id: artifactId,
        kind: 'target_model',
        role: 'target_artifact',
        entityId: target.geometryId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: target.fingerprint,
        spatial: artifact(target, bounds),
      },
      {
        id: `target-model:${target.geometryId}:top`,
        kind: 'target_model',
        role: 'target_top',
        entityId: target.geometryId,
        dependencyNodeIds: [artifactId],
        dependencyFingerprint: target.fingerprint,
        scalar: { frame: 'machine', valueMm: bounds.maxZ },
      },
      {
        id: `target-model:${target.geometryId}:bottom`,
        kind: 'target_model',
        role: 'target_bottom',
        entityId: target.geometryId,
        dependencyNodeIds: [artifactId],
        dependencyFingerprint: target.fingerprint,
        scalar: { frame: 'machine', valueMm: bounds.minZ },
      },
    )
  }

  const selectedFeatures = input.selectedFeatures ?? []
  const loopIds = new Set<string>()
  const featureKeys = new Set<string>()
  for (const [index, item] of selectedFeatures.entries()) {
    const loopId = item.loopId.trim()
    if (!loopId) throw new Error(`Contour selected feature ${index + 1} has a blank loop id.`)
    if (loopIds.has(loopId)) throw new Error(`Contour selected loop '${loopId}' has more than one feature endpoint.`)
    loopIds.add(loopId)
    const feature = validFeature(item.feature, `Contour selected feature '${loopId}'`)
    const key = featureKey(feature)
    if (featureKeys.has(key)) throw new Error(`Contour stable feature '${feature.stableId}' is selected more than once.`)
    featureKeys.add(key)
    const floor = finite(item.floorMachineMm, `Contour feature '${loopId}' floor`)
    const top = finite(item.topMachineMm, `Contour feature '${loopId}' top`)
    if (floor > top) throw new Error(`Contour feature '${loopId}' floor is above its top.`)
    const featureId = `selected-feature:${encodeURIComponent(key)}`
    nodes.push(
      {
        id: `${featureId}:top`,
        kind: 'selected_feature',
        role: 'feature_top',
        entityId: loopId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: item.fingerprint,
        scalar: { frame: 'machine', valueMm: top },
        feature,
      },
      {
        id: `${featureId}:floor`,
        kind: 'selected_feature',
        role: 'feature_floor',
        entityId: loopId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: item.fingerprint,
        scalar: { frame: 'machine', valueMm: floor },
        feature,
      },
    )
  }

  if (floorAllowance > 0) {
    nodes.push({
      id: `strategy-allowance:${input.operationId}:floor`,
      kind: 'strategy_allowance',
      role: 'cutter_end_allowance',
      entityId: input.operationId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: evidenceFingerprint(input.revision.operationRevision, floorAllowance),
      scalar: { frame: 'machine', valueMm: floorAllowance },
    })
  }

  return {
    revision: { ...input.revision },
    operationType: 'contour_2d',
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}

function sameFeature(left: StableFeatureReference, right: StableFeatureReference): boolean {
  return featureKey(left) === featureKey(right)
}

export function resolveContourSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  featureEvidence?: ContourSelectedFeatureEvidence[]
}): ResolvedContourSmartHeights {
  if (input.intent.policy.operationType !== 'contour_2d' || input.evidence.operationType !== 'contour_2d') {
    throw new ContourSmartHeightError({
      code: 'policy_mismatch',
      message: 'Contour Smart Height received non-Contour intent or evidence.',
    })
  }
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new ContourSmartHeightError(result.refusal)
  const plan = result.plan
  const feed = plan.safety.feed
  const resolvedFeatures = plan.machining.featureEndpoints ?? []
  const aggregateCutterEndWcsMm = plan.machining.cutterCenterEnd?.wcsMm
    ?? (resolvedFeatures.length > 0
      ? Math.min(...resolvedFeatures.map(item => item.cutterCenterEnd.wcsMm))
      : undefined)
  if (!feed || aggregateCutterEndWcsMm === undefined) {
    throw new ContourSmartHeightError({
      code: 'invalid_evidence',
      message: 'Contour Smart Height resolved an incomplete worker envelope.',
    })
  }

  const evidence = input.featureEvidence ?? []
  if (input.intent.policy.variant === 'selected_feature' && resolvedFeatures.length !== evidence.length) {
    throw new ContourSmartHeightError({
      code: 'invalid_evidence',
      message: 'Contour selected-feature endpoints do not match the selected loop evidence.',
    })
  }
  const featureEndpoints: ResolvedContourFeatureEndpoint[] = resolvedFeatures.map(endpoint => {
    const matches = evidence.filter(item => sameFeature(item.feature, endpoint.feature))
    if (matches.length !== 1) {
      throw new ContourSmartHeightError({
        code: matches.length === 0 ? 'missing_evidence' : 'ambiguous_evidence',
        evidenceKind: 'selected_feature',
        message: `Contour feature '${endpoint.feature.stableId}' does not map to exactly one selected loop.`,
      })
    }
    return {
      loopId: matches[0].loopId,
      feature: { ...endpoint.feature },
      physicalTargetWcsMm: endpoint.physicalTarget.wcsMm,
      cutterCenterEndWcsMm: endpoint.cutterCenterEnd.wcsMm,
    }
  })
  const loopBottoms = featureEndpoints.length > 0
    ? Object.fromEntries(featureEndpoints.map(item => [item.loopId, item.cutterCenterEndWcsMm]))
    : undefined

  const inferred = (offset: number): HeightIntentV1['top'] => ({
    reference: 'wcs_plane',
    offset,
    provenance: 'inferred',
  })
  const snapshotIntent: HeightIntentV1 = {
    version: 1,
    clearance: inferred(plan.safety.clearance.wcsMm),
    retract: inferred(plan.safety.retract.wcsMm),
    feed: inferred(feed.wcsMm),
    top: inferred(plan.machining.materialStart.wcsMm),
    bottom: inferred(aggregateCutterEndWcsMm),
  }
  const workerHeights: HeightParams = {
    clearanceHeight: plan.safety.clearance.wcsMm,
    clearanceHeightMode: 'absolute',
    retractHeight: plan.safety.retract.wcsMm,
    feedHeight: feed.wcsMm,
    topHeight: plan.machining.materialStart.wcsMm,
    topHeightMode: 'absolute',
    bottomHeight: aggregateCutterEndWcsMm,
    bottomHeightMode: 'absolute',
    heightIntent: snapshotIntent,
  }
  return {
    plan,
    workerHeights,
    workerFloorStockToLeaveMm: 0,
    ...(loopBottoms ? { loopBottoms } : {}),
    featureEndpoints,
    snapshotIntent,
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
  }
}
