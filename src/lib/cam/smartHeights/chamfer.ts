import type { HeightIntentV1, HeightParams, HeightPlaneName, HeightReference, Tool } from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type AuthoredPlaneIntentV2,
  type ChamferEdgeFormulaIntent,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type ResolvedHeightPlanV2,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
  type StableFeatureReference,
} from './types'

export interface ChamferSmartHeightDraft {
  datumReference: Exclude<HeightReference, HeightPlaneName>
  datumOffsetMm: number
  chamferWidthMm: number
  tipOffsetMm: number
}

export interface ChamferSelectedFeatureEvidence {
  loopId: string
  feature: StableFeatureReference
  fingerprint: string
}

export interface ChamferSmartHeightIntentInput extends ChamferSmartHeightDraft {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  features: ChamferSelectedFeatureEvidence[]
  /** WO-3188: 'policy' when the operator never chose a datum, so the runtime
   * may place a heightless 2D outline's chamfer at the material top. Any
   * chosen reference or offset is 'user' (the default) and means what it says. */
  datumOwner?: 'policy' | 'user'
}

export interface ChamferRemainingMaterialEvidence {
  artifactId: string
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
}

export interface ChamferSmartHeightEvidenceInput {
  intent: OperationHeightIntentV2
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  tool: Tool
  features: ChamferSelectedFeatureEvidence[]
  resolvedDatumMachineMm: number
  datumFingerprint: string
  referenceEvidence?: SmartHeightEvidenceNode[]
  remainingMaterial?: ChamferRemainingMaterialEvidence
}

export interface ResolvedChamferSmartHeights {
  plan: ResolvedHeightPlanV2
  workerHeights: HeightParams
  snapshotIntent: HeightIntentV1
  formula: ChamferEdgeFormulaIntent
  dependencyIds: string[]
}

export class ChamferSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Chamfer Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'ChamferSmartHeightError'
    this.refusal = refusal
  }
}

const policyOwner = { kind: 'operation_policy' as const }
const userOwner = { kind: 'user_override' as const }
const setupOwner = (setupId: string) => ({ kind: 'setup' as const, setupId })

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function positive(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked <= 0) throw new Error(`${label} must be greater than zero.`)
  return checked
}

function nonNegative(value: number, label: string): number {
  const checked = finite(value, label)
  if (checked < 0) throw new Error(`${label} cannot be negative.`)
  return checked
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

function validateFeature(feature: StableFeatureReference, label: string): StableFeatureReference {
  if (!feature.modelItemId.trim() || !feature.bodyId.trim() || !feature.featureKind.trim() ||
      !feature.stableId.trim() || !feature.sourceFingerprint.trim() ||
      !Number.isInteger(feature.sourceVersion) || feature.sourceVersion < 1) {
    throw new Error(`${label} has an incomplete stable feature reference.`)
  }
  return { ...feature }
}

function validateFeatures(
  features: readonly ChamferSelectedFeatureEvidence[],
): ChamferSelectedFeatureEvidence[] {
  const checked = features.map((item, index) => {
    const loopId = item.loopId.trim()
    if (!loopId) throw new Error(`Chamfer edge ${index + 1} has a blank loop id.`)
    if (!item.fingerprint.trim()) throw new Error(`Chamfer edge '${loopId}' has no evidence fingerprint.`)
    return {
      ...item,
      loopId,
      feature: validateFeature(item.feature, `Chamfer edge '${loopId}'`),
    }
  })
  if (checked.length === 0) throw new Error('Chamfer Smart Height requires at least one selected edge loop.')
  if (new Set(checked.map(item => item.loopId)).size !== checked.length) {
    throw new Error('Chamfer Smart Height contains duplicate loop ids.')
  }
  if (new Set(checked.map(item => featureKey(item.feature))).size !== checked.length) {
    throw new Error('Chamfer Smart Height contains duplicate stable edge identities.')
  }
  return checked
}

function validateDatumReference(
  reference: HeightReference,
): Exclude<HeightReference, HeightPlaneName> {
  if (['clearance', 'retract', 'feed', 'top', 'bottom'].includes(reference)) {
    throw new Error(`Chamfer datum cannot reference derived '${reference}' height.`)
  }
  return reference as Exclude<HeightReference, HeightPlaneName>
}

function formulaFromIntent(intent: OperationHeightIntentV2): ChamferEdgeFormulaIntent {
  const end = intent.machining.end.value
  if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'chamfer_edge') {
    throw new ChamferSmartHeightError({
      code: 'invalid_intent',
      message: 'Chamfer authority does not contain an edge-width formula.',
    })
  }
  return end.formula
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${smartHeightEvidenceFingerprint(value)}`
}

export function chamferSmartHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
): ChamferSmartHeightDraft {
  if (intent.policy.operationType !== 'chamfer' || intent.policy.variant !== 'edge_width_formula') {
    throw new Error(`Cannot edit '${intent.policy.operationType}' as a Chamfer Smart Height policy.`)
  }
  if (intent.machining.start.value.kind !== 'geometry_tool_formula') {
    throw new Error('Chamfer Smart Height Material Start is not formula-owned.')
  }
  const formula = formulaFromIntent(intent)
  const scope = intent.machining.scope.value
  if (scope.kind !== 'selected_features' || scope.features.length === 0) {
    throw new Error('Chamfer Smart Height has lost its stable selected-edge scope.')
  }
  return {
    datumReference: validateDatumReference(formula.datumPlane.reference),
    datumOffsetMm: finite(formula.datumPlane.offsetMm, 'Chamfer datum offset'),
    chamferWidthMm: positive(formula.chamferWidthMm, 'Chamfer width'),
    tipOffsetMm: nonNegative(formula.tipOffsetMm, 'Chamfer tip offset'),
  }
}

/** Replace only user-authored Chamfer formula values. The operation policy,
 * selected-edge identities, and Setup-owned safety planes remain unchanged. */
export function rebuildChamferSmartHeightFormulaIntent(input: {
  intent: OperationHeightIntentV2
  patch: Partial<ChamferSmartHeightDraft>
}): OperationHeightIntentV2 {
  const current = chamferSmartHeightDraftFromIntent(input.intent)
  const next = { ...current, ...input.patch }
  const end = input.intent.machining.end.value
  if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'chamfer_edge') {
    throw new Error('Chamfer Smart Height formula authority is missing.')
  }
  const datumEdited = input.patch.datumReference !== undefined || input.patch.datumOffsetMm !== undefined
  const formula: ChamferEdgeFormulaIntent = {
    ...end.formula,
    datumPlane: {
      ...end.formula.datumPlane,
      ...(datumEdited ? { owner: userOwner } : {}),
      reference: validateDatumReference(next.datumReference),
      offsetMm: finite(next.datumOffsetMm, 'Chamfer datum offset'),
    },
    chamferWidthMm: positive(next.chamferWidthMm, 'Chamfer width'),
    tipOffsetMm: nonNegative(next.tipOffsetMm, 'Chamfer tip offset'),
  }
  return {
    ...input.intent,
    machining: {
      ...input.intent.machining,
      end: {
        ...input.intent.machining.end,
        value: { kind: 'geometry_tool_formula', formula },
      },
    },
  }
}

export function buildChamferSmartHeightIntent(
  input: ChamferSmartHeightIntentInput,
): OperationHeightIntentV2 {
  const features = validateFeatures(input.features)
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']): AuthoredPlaneIntentV2 => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'Chamfer safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const formula: ChamferEdgeFormulaIntent = {
    kind: 'chamfer_edge',
    datumPlane: {
      reference: validateDatumReference(input.datumReference),
      offsetMm: finite(input.datumOffsetMm, 'Chamfer datum offset'),
      owner: input.datumOwner === 'policy' ? policyOwner : userOwner,
    },
    chamferWidthMm: positive(input.chamferWidthMm, 'Chamfer width'),
    tipOffsetMm: nonNegative(input.tipOffsetMm, 'Chamfer tip offset'),
  }
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'chamfer', variant: 'edge_width_formula' },
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: { owner: policyOwner, value: { kind: 'geometry_tool_formula' } },
      end: { owner: policyOwner, value: { kind: 'geometry_tool_formula', formula } },
      scope: {
        owner: policyOwner,
        value: { kind: 'selected_features', features: features.map(item => ({ ...item.feature })) },
      },
    },
  }
}

/** Replace only Setup-owned approach planes. Edge identities, datum semantics,
 * width, and tip offset remain the exact persisted machining authority. */
export function rebuildChamferSmartHeightSafetyIntent(input: {
  intent: OperationHeightIntentV2
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
}): OperationHeightIntentV2 {
  chamferSmartHeightDraftFromIntent(input.intent)
  const seed = buildChamferSmartHeightIntent({
    setupId: input.setupId,
    safetyIntent: input.safetyIntent,
    datumReference: 'wcs_plane',
    datumOffsetMm: 0,
    chamferWidthMm: 1,
    tipOffsetMm: 0,
    features: [{
      loopId: '__safety_only__',
      feature: {
        modelItemId: '__safety_only__',
        bodyId: '__safety_only__',
        featureKind: 'chamfer_edge',
        stableId: '__safety_only__',
        sourceVersion: 1,
        sourceFingerprint: '__safety_only__',
      },
      fingerprint: '__safety_only__',
    }],
  })
  return { ...input.intent, safety: seed.safety, machining: input.intent.machining }
}

export function buildChamferSmartHeightEvidenceContext(
  input: ChamferSmartHeightEvidenceInput,
): HeightEvidenceContext {
  if (input.intent.policy.operationType !== 'chamfer') {
    throw new Error('Chamfer evidence requires Chamfer intent.')
  }
  const formula = formulaFromIntent(input.intent)
  chamferSmartHeightDraftFromIntent(input.intent)
  const features = validateFeatures(input.features)
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'selected_features') {
    throw new Error('Chamfer evidence requires selected-feature scope.')
  }
  const authoredKeys = scope.features.map(featureKey).sort()
  const evidenceKeys = features.map(item => featureKey(item.feature)).sort()
  if (authoredKeys.length !== evidenceKeys.length ||
      authoredKeys.some((key, index) => key !== evidenceKeys[index])) {
    throw new ChamferSmartHeightError({
      code: 'stale_dependency',
      message: 'The selected Chamfer edge scope changed. Re-open the operation and confirm the replacement edges.',
    })
  }

  const wcsOrigin = finite(input.wcsOriginMachineMm, 'Chamfer WCS origin')
  const datum = finite(input.resolvedDatumMachineMm, 'Chamfer resolved datum')
  const angle = finite(input.tool.angleFromAxisDeg ?? NaN, 'Chamfer tool half-angle')
  if (angle <= 0 || angle >= 90) {
    throw new Error('Chamfer tool half-angle must be greater than zero and less than 90 degrees.')
  }
  positive(input.tool.diameter, 'Chamfer tool diameter')
  const toolId = input.tool.id.trim()
  if (!toolId) throw new Error('Chamfer tool id cannot be blank.')
  if (!input.datumFingerprint.trim()) throw new Error('Chamfer datum fingerprint cannot be blank.')

  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const toolNodeId = `tool:${toolId}`
  const datumNodeId = `selected-plane:${input.operationId}`

  let effectiveDatum = datum
  const startDependencyNodeIds = [datumNodeId, toolNodeId]
  const remainingMaterialNodes: SmartHeightEvidenceNode[] = []

  if (input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const artifactId = remaining.artifactId.trim()
    if (!artifactId) throw new Error('Chamfer remaining material artifact id cannot be blank.')
    const materialId = `remaining-material:${artifactId}`
    const remainingTop = finite(remaining.materialTopMachineMm, 'Chamfer remaining material Top')
    remainingMaterialNodes.push(
      {
        id: materialId,
        kind: 'remaining_material',
        role: 'material_artifact',
        entityId: artifactId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: remaining.fingerprint,
      },
      {
        id: `${materialId}:top`,
        kind: 'remaining_material',
        role: 'material_top',
        entityId: artifactId,
        dependencyNodeIds: [materialId],
        dependencyFingerprint: remaining.fingerprint,
        scalar: {
          frame: 'machine',
          valueMm: remainingTop,
        },
      },
    )
    if (remainingTop < effectiveDatum) {
      effectiveDatum = remainingTop
      startDependencyNodeIds.push(`${materialId}:top`)
    }
  }

  const nodes: SmartHeightEvidenceNode[] = [
    {
      id: wcsId,
      kind: 'setup_wcs',
      role: 'wcs_origin',
      entityId: input.operationId,
      dependencyNodeIds: [],
      dependencyFingerprint: fingerprint(input.revision.setupRevision, wcsOrigin),
      scalar: { frame: 'machine', valueMm: wcsOrigin },
    },
    {
      id: scopeId,
      kind: 'operation_scope',
      role: 'scope',
      entityId: input.operationId,
      dependencyNodeIds: [wcsId],
      dependencyFingerprint: fingerprint(input.revision.operationRevision, scope),
    },
    ...(input.referenceEvidence ?? []),
    ...remainingMaterialNodes,
  ]
  const featureNodeIds: string[] = []
  for (const item of features) {
    const id = `selected-feature:${encodeURIComponent(featureKey(item.feature))}:scope`
    featureNodeIds.push(id)
    nodes.push({
      id,
      kind: 'selected_feature',
      role: 'scope',
      entityId: item.loopId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: item.fingerprint,
      feature: { ...item.feature },
    })
  }
  nodes.push(
    {
      id: datumNodeId,
      kind: 'selected_plane',
      role: 'selected_plane',
      entityId: input.operationId,
      dependencyNodeIds: featureNodeIds,
      dependencyFingerprint: fingerprint(input.datumFingerprint, {
        datumPlane: formula.datumPlane,
        datumMachineMm: datum,
      }),
      scalar: { frame: 'machine', valueMm: datum },
    },
    {
      id: toolNodeId,
      kind: 'tool_geometry',
      role: 'tool',
      entityId: toolId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: fingerprint(toolId, {
        type: input.tool.type,
        diameter: input.tool.diameter,
        tipDiameter: input.tool.tipDiameter,
        angleFromAxisDeg: angle,
        fluteLength: input.tool.fluteLength,
      }),
    },
  )

  const cutterEnd = effectiveDatum - formula.chamferWidthMm - formula.tipOffsetMm
  const formulaFingerprint = fingerprint(input.revision.operationRevision, {
    formula,
    datumMachineMm: effectiveDatum,
    cutterEndMachineMm: cutterEnd,
    toolAngleFromAxisDeg: angle,
  })
  nodes.push(
    {
      id: `chamfer-formula:${input.operationId}:start`,
      kind: 'strategy_allowance',
      role: 'formula_material_start',
      entityId: input.operationId,
      dependencyNodeIds: startDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: effectiveDatum },
    },
    {
      id: `chamfer-formula:${input.operationId}:end`,
      kind: 'strategy_allowance',
      role: 'formula_cutter_end',
      entityId: input.operationId,
      dependencyNodeIds: startDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: cutterEnd },
    },
  )
  return {
    revision: input.revision,
    operationType: 'chamfer',
    wcsOriginMachineMm: wcsOrigin,
    evidence: nodes,
  }
}

export function resolveChamferSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
}): ResolvedChamferSmartHeights {
  if (input.intent.policy.operationType !== 'chamfer' || input.evidence.operationType !== 'chamfer') {
    throw new ChamferSmartHeightError({
      code: 'policy_mismatch',
      message: 'Chamfer Smart Height received non-Chamfer intent or evidence.',
    })
  }
  const formula = formulaFromIntent(input.intent)
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new ChamferSmartHeightError(result.refusal)
  const plan = result.plan
  const feed = plan.safety.feed
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!feed || !cutterEnd) {
    throw new ChamferSmartHeightError({
      code: 'invalid_evidence',
      message: 'Chamfer Smart Height did not resolve Feed and cutter endpoints.',
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
  return {
    plan,
    formula,
    snapshotIntent,
    workerHeights: {
      clearanceHeight: plan.safety.clearance.wcsMm,
      clearanceHeightMode: 'absolute',
      retractHeight: plan.safety.retract.wcsMm,
      feedHeight: feed.wcsMm,
      topHeight: plan.machining.materialStart.wcsMm,
      topHeightMode: 'absolute',
      bottomHeight: cutterEnd.wcsMm,
      bottomHeightMode: 'absolute',
      heightIntent: snapshotIntent,
    },
    dependencyIds: plan.evidenceGraph.map(node => node.id),
  }
}
