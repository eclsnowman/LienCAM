import type { HeightIntentV1, HeightParams, HeightPlaneName, HeightReference, Tool } from '../../../types'
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type AuthoredPlaneIntentV2,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type OperationHeightPolicyIntentFor,
  type ResolvedHeightPlanV2,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
  type StableFeatureReference,
  type ThreadBandFormulaIntent,
} from './types'

export type ThreadMillDetectedVariant = 'internal_top' | 'external_top' | 'external_base'
export type ThreadMillExplicitVariant =
  | 'internal_explicit'
  | 'external_top_explicit'
  | 'external_base_explicit'
export type ThreadMillSmartHeightVariant = ThreadMillDetectedVariant | ThreadMillExplicitVariant
export type ThreadMillSmartHeightSource = 'detected_feature' | 'explicit_band'

export interface ThreadMillSmartHeightDraft {
  source: ThreadMillSmartHeightSource
  threadKind: 'internal' | 'external'
  externalReference?: 'top' | 'base'
  threadDepthMm: number
  planeOffsetMm: number
  datumReference?: Exclude<HeightReference, HeightPlaneName>
}

export interface ThreadMillDetectedFeatureEvidence {
  loopId: string
  featureKind: 'bore' | 'boss'
  feature: StableFeatureReference
  topMachineMm: number
  floorMachineMm: number
  fingerprint: string
}

export interface ThreadMillSmartHeightIntentInput {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  source: ThreadMillSmartHeightSource
  threadKind: 'internal' | 'external'
  externalReference?: 'top' | 'base'
  threadDepthMm: number
  planeOffsetMm?: number
  datumReference?: Exclude<HeightReference, HeightPlaneName>
  features?: ThreadMillDetectedFeatureEvidence[]
  geometryIds?: string[]
}

export interface ThreadMillRemainingMaterialEvidence {
  artifactId: string
  materialTopMachineMm: number
  fingerprint: string
  representation: string
  compatible: boolean
}

export interface ThreadMillSmartHeightEvidenceInput {
  intent: OperationHeightIntentV2
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  tool: Tool
  features?: ThreadMillDetectedFeatureEvidence[]
  /** Resolved semantic datum, including its authored offset. Required for the
   * explicit-loop variants; detected variants derive the datum from topology. */
  explicitDatumMachineMm?: number
  explicitDatumFingerprint?: string
  referenceEvidence?: SmartHeightEvidenceNode[]
  remainingMaterial?: ThreadMillRemainingMaterialEvidence
}

export interface ResolvedThreadMillSmartHeights {
  plan: ResolvedHeightPlanV2
  workerHeights: HeightParams
  snapshotIntent: HeightIntentV1
  formula: ThreadBandFormulaIntent
  dependencyIds: string[]
}

export class ThreadMillSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Thread Mill Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'ThreadMillSmartHeightError'
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
  features: readonly ThreadMillDetectedFeatureEvidence[] | undefined,
): ThreadMillDetectedFeatureEvidence[] {
  const checked = (features ?? []).map((item, index) => {
    const loopId = item.loopId.trim()
    if (!loopId) throw new Error(`Thread Mill feature ${index + 1} has a blank loop id.`)
    const top = finite(item.topMachineMm, `Thread Mill feature '${loopId}' top`)
    const floor = finite(item.floorMachineMm, `Thread Mill feature '${loopId}' base`)
    if (floor > top) throw new Error(`Thread Mill feature '${loopId}' base is above its top.`)
    if (!item.fingerprint.trim()) throw new Error(`Thread Mill feature '${loopId}' has no evidence fingerprint.`)
    return {
      ...item,
      loopId,
      feature: validateFeature(item.feature, `Thread Mill feature '${loopId}'`),
      topMachineMm: top,
      floorMachineMm: floor,
    }
  })
  if (checked.length === 0) throw new Error('Thread Mill detected-feature mode requires at least one cylinder.')
  if (new Set(checked.map(item => item.loopId)).size !== checked.length) {
    throw new Error('Thread Mill detected-feature mode contains duplicate loop ids.')
  }
  if (new Set(checked.map(item => featureKey(item.feature))).size !== checked.length) {
    throw new Error('Thread Mill detected-feature mode contains duplicate stable feature identities.')
  }
  return checked
}

function detectedVariant(input: Pick<ThreadMillSmartHeightIntentInput, 'threadKind' | 'externalReference'>): ThreadMillDetectedVariant {
  if (input.threadKind === 'internal') return 'internal_top'
  return (input.externalReference ?? 'top') === 'base' ? 'external_base' : 'external_top'
}

function explicitVariant(variant: ThreadMillDetectedVariant): ThreadMillExplicitVariant {
  switch (variant) {
    case 'internal_top': return 'internal_explicit'
    case 'external_top': return 'external_top_explicit'
    case 'external_base': return 'external_base_explicit'
  }
}

function baseVariant(variant: ThreadMillSmartHeightVariant): ThreadMillDetectedVariant {
  switch (variant) {
    case 'internal_top':
    case 'internal_explicit': return 'internal_top'
    case 'external_top':
    case 'external_top_explicit': return 'external_top'
    case 'external_base':
    case 'external_base_explicit': return 'external_base'
  }
}

function isExplicitVariant(variant: ThreadMillSmartHeightVariant): variant is ThreadMillExplicitVariant {
  return variant.endsWith('_explicit')
}

function checkedVariant(value: string): ThreadMillSmartHeightVariant {
  switch (value) {
    case 'internal_top':
    case 'external_top':
    case 'external_base':
    case 'internal_explicit':
    case 'external_top_explicit':
    case 'external_base_explicit':
      return value
    default:
      throw new Error(`Unsupported Thread Mill Smart Height policy '${value}'.`)
  }
}

function formulaFromIntent(intent: OperationHeightIntentV2): ThreadBandFormulaIntent {
  const end = intent.machining.end.value
  if (end.kind !== 'geometry_tool_formula' || end.formula.kind !== 'thread_band') {
    throw new ThreadMillSmartHeightError({
      code: 'invalid_intent',
      message: 'Thread Mill authority does not contain a thread-band formula.',
    })
  }
  return end.formula
}

/** Decode persisted Thread Mill authority into its editable semantic fields.
 * This validates the policy/formula/scope relationship before any UI surface
 * is allowed to present the authority as usable. */
export function threadMillSmartHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
): ThreadMillSmartHeightDraft {
  if (intent.policy.operationType !== 'thread_mill') {
    throw new Error(`Thread Mill Smart Height cannot decode a ${intent.policy.operationType} policy.`)
  }
  const variant = checkedVariant(intent.policy.variant)
  const base = baseVariant(variant)
  const explicit = isExplicitVariant(variant)
  const formula = formulaFromIntent(intent)
  const expectedDatum = explicit
    ? 'authored_plane'
    : base === 'external_base' ? 'feature_base' : 'feature_top'
  const expectedDirection = base === 'external_base' ? 'up' : 'down'
  if (formula.datum !== expectedDatum || formula.direction !== expectedDirection) {
    throw new Error('Thread Mill Smart Height policy, datum, and cutting direction disagree.')
  }
  positive(formula.depthMm, 'Thread Mill thread length')
  const scope = intent.machining.scope.value
  if (explicit) {
    if (scope.kind !== 'selected_geometry' || scope.geometryIds.length === 0) {
      throw new Error('Explicit Thread Mill Smart Height has lost its selected geometry scope.')
    }
    if (!formula.datumPlane) {
      throw new Error('Explicit Thread Mill Smart Height has lost its authored datum plane.')
    }
  } else if (scope.kind !== 'selected_features' || scope.features.length === 0) {
    throw new Error('Detected Thread Mill Smart Height has lost its stable feature scope.')
  }
  const datumReference = explicit ? formula.datumPlane!.reference : undefined
  if (datumReference !== undefined &&
      ['clearance', 'retract', 'feed', 'top', 'bottom'].includes(datumReference)) {
    throw new Error(`Explicit Thread Mill datum cannot reference derived '${datumReference}' height.`)
  }
  return {
    source: explicit ? 'explicit_band' : 'detected_feature',
    threadKind: base === 'internal_top' ? 'internal' : 'external',
    ...(base === 'internal_top'
      ? {}
      : { externalReference: base === 'external_base' ? 'base' as const : 'top' as const }),
    threadDepthMm: formula.depthMm,
    planeOffsetMm: explicit ? formula.datumPlane!.offsetMm : formula.datumOffsetMm,
    ...(explicit ? {
      datumReference: datumReference as Exclude<HeightReference, HeightPlaneName>,
    } : {}),
  }
}

/** Replace only Setup-owned safety planes. Stable detected features, explicit
 * geometry scope, datum semantics, formula, and direction remain persisted
 * exactly as authored. */
export function rebuildThreadMillSmartHeightSafetyIntent(input: {
  intent: OperationHeightIntentV2
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
}): OperationHeightIntentV2 {
  threadMillSmartHeightDraftFromIntent(input.intent)
  const safetySeed = buildThreadMillSmartHeightIntent({
    setupId: input.setupId,
    safetyIntent: input.safetyIntent,
    source: 'explicit_band',
    threadKind: 'internal',
    threadDepthMm: 1,
    planeOffsetMm: 0,
    datumReference: 'wcs_plane',
    geometryIds: ['__safety_only__'],
  })
  return {
    ...input.intent,
    safety: safetySeed.safety,
    machining: input.intent.machining,
    ...(input.intent.featureOverrides
      ? { featureOverrides: input.intent.featureOverrides }
      : {}),
  }
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${smartHeightEvidenceFingerprint(value)}`
}

export function buildThreadMillSmartHeightIntent(
  input: ThreadMillSmartHeightIntentInput,
): OperationHeightIntentV2 {
  const depth = positive(input.threadDepthMm, 'Thread Mill thread length')
  const offset = finite(input.planeOffsetMm ?? 0, 'Thread Mill datum offset')
  const base = detectedVariant(input)
  const explicit = input.source === 'explicit_band'
  const variant: ThreadMillSmartHeightVariant = explicit ? explicitVariant(base) : base
  const expectedKind = base === 'internal_top' ? 'bore' : 'boss'
  const formula: ThreadBandFormulaIntent = {
    kind: 'thread_band',
    datum: explicit ? 'authored_plane' : base === 'external_base' ? 'feature_base' : 'feature_top',
    direction: base === 'external_base' ? 'up' : 'down',
    depthMm: depth,
    datumOffsetMm: explicit ? 0 : offset,
    ...(explicit ? {
      datumPlane: {
        reference: input.datumReference ?? 'wcs_plane',
        offsetMm: offset,
        owner: userOwner,
      } satisfies AuthoredPlaneIntentV2,
    } : {}),
  }
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']): AuthoredPlaneIntentV2 => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'Thread Mill safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const scope = explicit
    ? (() => {
        const geometryIds = (input.geometryIds ?? []).map(id => id.trim()).filter(Boolean)
        if (geometryIds.length === 0) throw new Error('Explicit Thread Mill authority requires selected geometry.')
        if (new Set(geometryIds).size !== geometryIds.length) {
          throw new Error('Explicit Thread Mill authority contains duplicate geometry ids.')
        }
        return { kind: 'selected_geometry' as const, geometryIds }
      })()
    : (() => {
        const features = validateFeatures(input.features)
        if (features.some(item => item.featureKind !== expectedKind)) {
          throw new Error(base === 'internal_top'
            ? 'Internal Thread Mill authority requires detected bore features.'
            : 'External Thread Mill authority requires detected boss features.')
        }
        return { kind: 'selected_features' as const, features: features.map(item => ({ ...item.feature })) }
      })()

  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'thread_mill', variant } as OperationHeightPolicyIntentFor<'thread_mill'>,
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: { owner: policyOwner, value: { kind: 'geometry_tool_formula' } },
      end: { owner: policyOwner, value: { kind: 'geometry_tool_formula', formula } },
      scope: { owner: policyOwner, value: scope },
    },
  }
}

export function buildThreadMillSmartHeightEvidenceContext(
  input: ThreadMillSmartHeightEvidenceInput,
): HeightEvidenceContext {
  if (input.intent.policy.operationType !== 'thread_mill') {
    throw new Error('Thread Mill evidence requires Thread Mill intent.')
  }
  const variant = input.intent.policy.variant as ThreadMillSmartHeightVariant
  const formula = formulaFromIntent(input.intent)
  const wcsOrigin = finite(input.wcsOriginMachineMm, 'Thread Mill WCS origin')
  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
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
      dependencyFingerprint: fingerprint(input.revision.operationRevision, input.intent.machining.scope.value),
    },
    ...(input.referenceEvidence ?? []),
  ]

  let remainingTop: number | undefined
  if (input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const artifactId = remaining.artifactId.trim()
    if (!artifactId) throw new Error('Thread Mill remaining material artifact id cannot be blank.')
    const materialId = `remaining-material:${artifactId}`
    remainingTop = finite(remaining.materialTopMachineMm, 'Thread Mill remaining material Top')
    nodes.push(
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
  }

  const toolId = input.tool.id.trim()
  if (!toolId) throw new Error('Thread Mill tool id cannot be blank.')
  nodes.push({
    id: `tool:${toolId}`,
    kind: 'tool_geometry',
    role: 'tool',
    entityId: toolId,
    dependencyNodeIds: [scopeId],
    dependencyFingerprint: fingerprint(toolId, {
      type: input.tool.type,
      diameter: input.tool.diameter,
      neckDiameter: input.tool.neckDiameter,
      shoulderLength: input.tool.shoulderLength,
      fluteLength: input.tool.fluteLength,
    }),
  })

  let datumMachineMm: number
  let physicalDatumNode: SmartHeightEvidenceNode
  if (isExplicitVariant(variant)) {
    if (formula.datum !== 'authored_plane' || !formula.datumPlane) {
      throw new Error('Explicit Thread Mill intent requires an authored datum plane.')
    }
    datumMachineMm = finite(input.explicitDatumMachineMm ?? NaN, 'Explicit Thread Mill datum')
    physicalDatumNode = {
      id: `selected-plane:${input.operationId}`,
      kind: 'selected_plane',
      role: 'selected_plane',
      entityId: input.operationId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: fingerprint(input.explicitDatumFingerprint ?? input.revision.operationRevision, {
        datumMachineMm,
        datumPlane: formula.datumPlane,
      }),
      scalar: { frame: 'machine', valueMm: datumMachineMm },
    }
  } else {
    const features = validateFeatures(input.features)
    const authoredScope = input.intent.machining.scope.value
    if (authoredScope.kind !== 'selected_features') {
      throw new Error('Detected Thread Mill intent requires selected-feature scope.')
    }
    const authoredKeys = authoredScope.features.map(featureKey).sort()
    const evidenceKeys = features.map(item => featureKey(item.feature)).sort()
    if (authoredKeys.length !== evidenceKeys.length || authoredKeys.some((key, index) => key !== evidenceKeys[index])) {
      throw new ThreadMillSmartHeightError({
        code: 'stale_dependency',
        message: 'The detected Thread Mill cylinder scope changed. Re-open the operation and confirm the replacement features.',
      })
    }
    const expectedKind = baseVariant(variant) === 'internal_top' ? 'bore' : 'boss'
    if (features.some(item => item.featureKind !== expectedKind)) {
      throw new ThreadMillSmartHeightError({
        code: 'policy_mismatch',
        message: expectedKind === 'bore'
          ? 'Internal Thread Mill authority no longer resolves to bore features.'
          : 'External Thread Mill authority no longer resolves to boss features.',
      })
    }
    for (const item of features) {
      nodes.push({
        id: `selected-feature:${encodeURIComponent(featureKey(item.feature))}:scope`,
        kind: 'selected_feature',
        role: 'scope',
        entityId: item.loopId,
        dependencyNodeIds: [scopeId],
        dependencyFingerprint: item.fingerprint,
        feature: { ...item.feature },
      })
    }
    const rawDatums = formula.datum === 'feature_base'
      ? features.map(item => item.floorMachineMm)
      : features.map(item => item.topMachineMm)
    const first = rawDatums[0]
    if (rawDatums.some(value => Math.abs(value - first) > 1e-6)) {
      throw new ThreadMillSmartHeightError({
        code: 'ambiguous_evidence',
        message: `Selected Thread Mill cylinders do not share one ${formula.datum === 'feature_base' ? 'base' : 'top'} datum plane. Split them into separate operations.`,
      })
    }
    datumMachineMm = first + formula.datumOffsetMm
    let effectiveDatum = datumMachineMm
    if (remainingTop !== undefined && formula.direction === 'down' && remainingTop < effectiveDatum) {
      effectiveDatum = remainingTop
    }
    const end = formula.direction === 'down' ? effectiveDatum - formula.depthMm : datumMachineMm
    const start = formula.direction === 'up'
      ? (remainingTop !== undefined ? Math.min(datumMachineMm + formula.depthMm, remainingTop) : datumMachineMm + formula.depthMm)
      : effectiveDatum
    if (formula.direction === 'down' && features.some(item => end < item.floorMachineMm - 1e-6)) {
      throw new ThreadMillSmartHeightError({
        code: 'invalid_plane_order',
        message: 'Thread length extends below at least one detected cylinder base.',
      })
    }
    if (formula.direction === 'up' && features.some(item => start > item.topMachineMm + 1e-6)) {
      throw new ThreadMillSmartHeightError({
        code: 'invalid_plane_order',
        message: 'Thread length extends above at least one detected boss top.',
      })
    }
    physicalDatumNode = {
      id: `selected-feature:${input.operationId}:datum`,
      kind: 'selected_feature',
      role: formula.datum === 'feature_base' ? 'feature_floor' : 'feature_top',
      entityId: input.operationId,
      dependencyNodeIds: nodes.filter(node => node.kind === 'selected_feature' && node.feature).map(node => node.id),
      dependencyFingerprint: fingerprint(input.revision.operationRevision, {
        formula,
        features: features.map(item => ({ key: featureKey(item.feature), fingerprint: item.fingerprint })),
      }),
      scalar: { frame: 'machine', valueMm: first },
    }
  }
  nodes.push(physicalDatumNode)

  let effectiveDatum = datumMachineMm
  if (remainingTop !== undefined && formula.direction === 'down' && remainingTop < effectiveDatum) {
    effectiveDatum = remainingTop
  }

  const materialStartMachineMm = formula.direction === 'up'
    ? (remainingTop !== undefined ? Math.min(datumMachineMm + formula.depthMm, remainingTop) : datumMachineMm + formula.depthMm)
    : effectiveDatum
  const cutterEndMachineMm = formula.direction === 'down'
    ? effectiveDatum - formula.depthMm
    : datumMachineMm
  const formulaFingerprint = fingerprint(input.revision.operationRevision, {
    formula,
    datumMachineMm: effectiveDatum,
    materialStartMachineMm,
    cutterEndMachineMm,
  })

  const formulaDependencyNodeIds = [physicalDatumNode.id, `tool:${toolId}`]
  if (input.remainingMaterial?.compatible && (effectiveDatum < datumMachineMm || (formula.direction === 'up' && remainingTop !== undefined && remainingTop < datumMachineMm + formula.depthMm))) {
    formulaDependencyNodeIds.push(`remaining-material:${input.remainingMaterial.artifactId.trim()}:top`)
  }

  nodes.push(
    {
      id: `thread-formula:${input.operationId}:start`,
      kind: 'strategy_allowance',
      role: 'formula_material_start',
      entityId: input.operationId,
      dependencyNodeIds: formulaDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: materialStartMachineMm },
    },
    {
      id: `thread-formula:${input.operationId}:end`,
      kind: 'strategy_allowance',
      role: 'formula_cutter_end',
      entityId: input.operationId,
      dependencyNodeIds: formulaDependencyNodeIds,
      dependencyFingerprint: formulaFingerprint,
      scalar: { frame: 'machine', valueMm: cutterEndMachineMm },
    },
  )

  return {
    revision: input.revision,
    operationType: 'thread_mill',
    wcsOriginMachineMm: wcsOrigin,
    evidence: nodes,
  }
}

export function resolveThreadMillSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
}): ResolvedThreadMillSmartHeights {
  if (input.intent.policy.operationType !== 'thread_mill' || input.evidence.operationType !== 'thread_mill') {
    throw new ThreadMillSmartHeightError({
      code: 'policy_mismatch',
      message: 'Thread Mill Smart Height received non-Thread Mill intent or evidence.',
    })
  }
  const formula = formulaFromIntent(input.intent)
  const variant = input.intent.policy.variant as ThreadMillSmartHeightVariant
  const base = baseVariant(variant)
  const expectedDatum = isExplicitVariant(variant)
    ? 'authored_plane'
    : base === 'external_base' ? 'feature_base' : 'feature_top'
  if ((base === 'external_base') !== (formula.direction === 'up') || formula.datum !== expectedDatum) {
    throw new ThreadMillSmartHeightError({
      code: 'policy_mismatch',
      message: 'Thread Mill direction/datum does not match its registered policy variant.',
    })
  }
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new ThreadMillSmartHeightError(result.refusal)
  const plan = result.plan
  const feed = plan.safety.feed
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!feed || !cutterEnd) {
    throw new ThreadMillSmartHeightError({
      code: 'invalid_evidence',
      message: 'Thread Mill Smart Height did not resolve Feed and cutter endpoints.',
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
