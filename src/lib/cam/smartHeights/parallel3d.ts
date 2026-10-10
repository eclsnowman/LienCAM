import type { HeightIntentV1 } from '../../../types'
import type { ResolvedParallel3dHeights } from '../../../cam3d/integration/parallel3dOperation'
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

export type Parallel3dHeightMode = 'target_surface' | 'bounded_surface'

export interface Parallel3dHeightDraft {
  mode: Parallel3dHeightMode
  finishDepthMm?: number
}

export interface Parallel3dIntentInput {
  setupId: string
  geometryIds: string[]
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  finishDepthMm?: number
}

export interface Parallel3dEvidenceInput {
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  geometryIds: string[]
  owningStock?: {
    stockId: string
    artifactId: string
    boundsMachineMm: SmartHeightBoundsMm
    fingerprint: string
    representation: string
    schemaVersion?: number
  }
  target: {
    geometryId: string
    artifactId: string
    boundsMachineMm: SmartHeightBoundsMm
    fingerprint: string
    representation: string
    schemaVersion?: number
  }
}

export interface ResolvedParallel3dSmartHeights {
  plan: ResolvedHeightPlanV2
  localHeights: ResolvedParallel3dHeights
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
  /** Undefined preserves the worker's full-surface behavior. */
  finishDepthMm?: number
}

export class Parallel3dSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Parallel 3D Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'Parallel3dSmartHeightError'
    this.refusal = refusal
  }
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function validBounds(bounds: SmartHeightBoundsMm): SmartHeightBoundsMm {
  for (const [axis, value] of Object.entries(bounds)) finite(value, `Parallel 3D target ${axis}`)
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new Error('Parallel 3D target has inverted bounds.')
  }
  return { ...bounds }
}

function owner(setupId: string) {
  return { kind: 'setup' as const, setupId }
}

/** Author the target-surface field as the machining authority. A finish-depth
 * limit is relative to the resolved target-model Top, so part placement and
 * WCS edits cannot silently change its physical meaning. */
export function buildParallel3dSmartIntent(input: Parallel3dIntentInput): OperationHeightIntentV2 {
  if (input.geometryIds.length === 0) throw new Error('Parallel 3D Smart Height requires target geometry.')
  const bounded = input.finishDepthMm !== undefined
  if (bounded && finite(input.finishDepthMm!, 'Parallel 3D finish depth') <= 0) {
    throw new Error('Parallel 3D finish depth must be greater than zero.')
  }
  const setupOwner = owner(input.setupId)
  const operationOwner = { kind: 'operation_policy' as const }
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: finishSafetyReference(value),
    offsetMm: value.offset,
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setupOwner,
  })
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: {
      operationType: 'parallel_3d',
      variant: bounded ? 'bounded_surface' : 'target_surface',
    },
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: { owner: operationOwner, value: { kind: 'target_model_top' } },
      end: {
        owner: bounded ? { kind: 'user_override' } : operationOwner,
        value: {
          kind: 'target_surface',
          ...(bounded ? {
            lowerLimit: {
              reference: 'top',
              offsetMm: -input.finishDepthMm!,
              owner: { kind: 'user_override' },
            },
          } : {}),
        },
      },
      scope: {
        owner: operationOwner,
        value: { kind: 'whole_target', geometryIds: [...input.geometryIds] },
      },
    },
  }
}

/** WO-1616: the reference a 3D surface finish authors for a Setup safety plane.
 * The Setup's untouched defaults are all measured from its stock top - Retract
 * "Stock top + 5" directly, Feed "Top + 5" through the Setup Top, which is the
 * stock top. A finish's own Top is the target-model Top, so an untouched Feed
 * default is authored against the stock top to keep the Setup's meaning; the
 * approach rapid then stops over the stock, not on it. Deliberate references
 * pass through. With no stock proven the resolver binds these to the model Top
 * (bindUnprovenStockTopSafety). */
export function finishSafetyReference(value: HeightIntentV1['clearance']): HeightIntentV1['clearance']['reference'] {
  return value.provenance === 'default' && value.reference === 'top' ? 'stock_top' : value.reference
}

/** WO-1616: a 3D surface finish may run with no assigned stock. The Setup's
 * untouched "Stock top" safety default then has nothing to measure from, so it
 * binds to the target-model Top. When a stock is proven it stays the stock top.
 * A user-chosen Stock top is never rebound. */
export function bindUnprovenStockTopSafety(
  intent: OperationHeightIntentV2,
  evidence: HeightEvidenceContext,
): OperationHeightIntentV2 {
  if (evidence.evidence.some(node => node.kind === 'owning_stock' && node.role === 'stock_top')) return intent
  const bind = (plane: OperationHeightIntentV2['safety']['clearance']) =>
    plane.reference === 'stock_top' && plane.owner.kind === 'setup' ? { ...plane, reference: 'top' as const } : plane
  return {
    ...intent,
    safety: {
      clearance: bind(intent.safety.clearance),
      retract: bind(intent.safety.retract),
      feed: bind(intent.safety.feed),
    },
  }
}

export function parallel3dHeightDraftFromIntent(intent: OperationHeightIntentV2): Parallel3dHeightDraft {
  if (intent.policy.operationType !== 'parallel_3d') {
    throw new Error('Cannot edit a non-Parallel Smart Height intent as Parallel 3D.')
  }
  const end = intent.machining.end.value
  if (end.kind !== 'target_surface') {
    throw new Error('Parallel 3D Smart Height must end on a target-surface field.')
  }
  if (intent.policy.variant === 'target_surface') {
    if (end.lowerLimit !== undefined) throw new Error('Full-surface Parallel intent has an unexpected lower limit.')
    return { mode: 'target_surface' }
  }
  if (intent.policy.variant !== 'bounded_surface' || !end.lowerLimit ||
      end.lowerLimit.reference !== 'top') {
    throw new Error('Bounded Parallel Smart Height has no model-Top-relative finish limit.')
  }
  const finishDepthMm = -finite(end.lowerLimit.offsetMm, 'Parallel 3D finish depth')
  if (finishDepthMm <= 0) throw new Error('Parallel 3D finish depth must be greater than zero.')
  return { mode: 'bounded_surface', finishDepthMm }
}

export function buildParallel3dEvidenceContext(input: Parallel3dEvidenceInput): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Parallel 3D WCS origin')
  if (input.geometryIds.length !== 1 || input.geometryIds[0] !== input.target.geometryId) {
    throw new Error('Parallel 3D target evidence must match its single authored target geometry.')
  }
  const bounds = validBounds(input.target.boundsMachineMm)
  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const fingerprint = (prefix: string, values: readonly string[]) => [prefix, ...values].join(':')
  const nodes: SmartHeightEvidenceNode[] = [
    {
      id: wcsId, kind: 'setup_wcs', role: 'wcs_origin', entityId: input.operationId,
      dependencyNodeIds: [],
      dependencyFingerprint: fingerprint(input.revision.setupRevision, [String(input.wcsOriginMachineMm)]),
      scalar: { frame: 'machine', valueMm: input.wcsOriginMachineMm },
    },
    {
      id: scopeId, kind: 'operation_scope', role: 'scope', entityId: input.operationId,
      dependencyNodeIds: [wcsId],
      dependencyFingerprint: fingerprint(input.revision.operationRevision, input.geometryIds),
    },
  ]
  if (input.owningStock) {
    const stock = input.owningStock
    const stockBounds = validBounds(stock.boundsMachineMm)
    const stockArtifactId = `owning-stock:${stock.stockId}`
    nodes.push(
      {
        id: stockArtifactId, kind: 'owning_stock', role: 'material_artifact', entityId: stock.stockId,
        dependencyNodeIds: [scopeId], dependencyFingerprint: stock.fingerprint,
        spatial: {
          artifactId: stock.artifactId,
          schemaVersion: stock.schemaVersion ?? 1,
          representation: stock.representation,
          frame: 'machine', boundsMm: stockBounds, fingerprint: stock.fingerprint,
        },
      },
      {
        id: `${stockArtifactId}:top`, kind: 'owning_stock', role: 'stock_top', entityId: stock.stockId,
        dependencyNodeIds: [stockArtifactId], dependencyFingerprint: stock.fingerprint,
        scalar: { frame: 'machine', valueMm: stockBounds.maxZ },
      },
      {
        id: `${stockArtifactId}:bottom`, kind: 'owning_stock', role: 'stock_bottom', entityId: stock.stockId,
        dependencyNodeIds: [stockArtifactId], dependencyFingerprint: stock.fingerprint,
        scalar: { frame: 'machine', valueMm: stockBounds.minZ },
      },
    )
  }
  nodes.push(
    {
      id: `target-model:${input.target.geometryId}:top`, kind: 'target_model', role: 'target_top',
      entityId: input.target.geometryId, dependencyNodeIds: [scopeId],
      dependencyFingerprint: input.target.fingerprint,
      scalar: { frame: 'machine', valueMm: bounds.maxZ },
    },
    {
      id: `target-model:${input.target.geometryId}:bottom`, kind: 'target_model', role: 'target_bottom',
      entityId: input.target.geometryId, dependencyNodeIds: [scopeId],
      dependencyFingerprint: input.target.fingerprint,
      scalar: { frame: 'machine', valueMm: bounds.minZ },
    },
    {
      id: `target-surface:${input.target.geometryId}`, kind: 'target_surface_field', role: 'target_artifact',
      entityId: input.target.geometryId,
      dependencyNodeIds: [scopeId, `target-model:${input.target.geometryId}:top`],
      dependencyFingerprint: input.target.fingerprint,
      scalar: { frame: 'machine', valueMm: bounds.minZ },
      spatial: {
        artifactId: input.target.artifactId,
        schemaVersion: input.target.schemaVersion ?? 1,
        representation: input.target.representation,
        frame: 'machine',
        boundsMm: bounds,
        fingerprint: input.target.fingerprint,
      },
    },
  )
  return {
    revision: { ...input.revision },
    operationType: 'parallel_3d',
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}

export function resolveParallel3dSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds: string[]
  geometryPositionZ: number
  stockTopMachineMm?: number
}): ResolvedParallel3dSmartHeights {
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'whole_target' || scope.geometryIds.length !== input.geometryIds.length ||
      scope.geometryIds.some((id, index) => id !== input.geometryIds[index])) {
    throw new Parallel3dSmartHeightError({
      code: 'policy_mismatch',
      message: 'Parallel 3D Smart Height scope no longer matches the operation target geometry.',
    })
  }
  const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(input.intent, input.evidence), input.evidence)
  if (!result.ok) throw new Parallel3dSmartHeightError(result.refusal)
  const plan = result.plan
  const end = plan.machining.cutterCenterEnd
  if (!end) {
    throw new Parallel3dSmartHeightError({
      code: 'invalid_evidence', message: 'Parallel 3D resolved no cutter-center Target End.',
    })
  }
  const local = (machineMm: number) => machineMm - input.geometryPositionZ
  const topMachine = plan.machining.materialStart.machineMm
  const localHeights: ResolvedParallel3dHeights = {
    clearanceZ: local(plan.safety.clearance.machineMm),
    retractZ: local(plan.safety.retract.machineMm),
    feedZ: local(plan.safety.feed.machineMm),
    topZ: local(topMachine),
    bottomZ: local(end.machineMm),
    ...(input.stockTopMachineMm === undefined ? {} : { stockTopZ: local(input.stockTopMachineMm) }),
  }
  const inferred = (machineMm: number) => ({
    reference: 'wcs_plane' as const,
    offset: machineMm - input.evidence.wcsOriginMachineMm,
    provenance: 'inferred' as const,
  })
  const draft = parallel3dHeightDraftFromIntent(input.intent)
  return {
    plan,
    localHeights,
    snapshotIntent: {
      version: 1,
      clearance: inferred(plan.safety.clearance.machineMm),
      retract: inferred(plan.safety.retract.machineMm),
      feed: inferred(plan.safety.feed.machineMm),
      top: inferred(topMachine),
      bottom: inferred(end.machineMm),
    },
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
    ...(draft.finishDepthMm === undefined
      ? {}
      : { finishDepthMm: Math.max(0, topMachine - end.machineMm) }),
  }
}
