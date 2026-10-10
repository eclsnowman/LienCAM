// Smart Height V2 for waterline_3d (WO-1176). Mirrors parallel3d.ts.
//
// A waterline finishes the part surface between two planes: Material Start is
// the target model's Top and Cutter End is the lowest point of the target
// surface in scope, or the operator's finish-depth limit below Top. Every
// level the strategy cuts lies between the two. The evidence is the same
// target-surface field the raster finish uses; only the policy name differs,
// so a saved parallel and a saved waterline can never be confused for one
// another (policy_mismatch, by name).

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
import { bindUnprovenStockTopSafety, finishSafetyReference } from './parallel3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type Waterline3dHeightMode = 'target_surface' | 'bounded_surface'

export interface Waterline3dHeightDraft {
  mode: Waterline3dHeightMode
  finishDepthMm?: number
}

export interface Waterline3dIntentInput {
  setupId: string
  geometryIds: string[]
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  finishDepthMm?: number
}

export interface Waterline3dEvidenceInput {
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

export interface ResolvedWaterline3dSmartHeights {
  plan: ResolvedHeightPlanV2
  /** Same local shape the raster finish and the waterline bridge consume. */
  localHeights: ResolvedParallel3dHeights
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
  /** Undefined finishes down to the lowest target surface. */
  finishDepthMm?: number
}

export class Waterline3dSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Waterline 3D Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'Waterline3dSmartHeightError'
    this.refusal = refusal
  }
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function validBounds(bounds: SmartHeightBoundsMm): SmartHeightBoundsMm {
  for (const [axis, value] of Object.entries(bounds)) finite(value, `Waterline 3D target ${axis}`)
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new Error('Waterline 3D target has inverted bounds.')
  }
  return { ...bounds }
}

function owner(setupId: string) {
  return { kind: 'setup' as const, setupId }
}

/** Author the target-surface field as the machining authority; a finish-depth
 * limit is relative to the resolved target-model Top. */
export function buildWaterline3dSmartIntent(input: Waterline3dIntentInput): OperationHeightIntentV2 {
  if (input.geometryIds.length === 0) throw new Error('Waterline 3D Smart Height requires target geometry.')
  const bounded = input.finishDepthMm !== undefined
  if (bounded && finite(input.finishDepthMm!, 'Waterline 3D finish depth') <= 0) {
    throw new Error('Waterline 3D finish depth must be greater than zero.')
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
      operationType: 'waterline_3d',
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

export function waterline3dHeightDraftFromIntent(intent: OperationHeightIntentV2): Waterline3dHeightDraft {
  if (intent.policy.operationType !== 'waterline_3d') {
    throw new Error('Cannot edit a non-Waterline Smart Height intent as Waterline 3D.')
  }
  const end = intent.machining.end.value
  if (end.kind !== 'target_surface') {
    throw new Error('Waterline 3D Smart Height must end on a target-surface field.')
  }
  if (intent.policy.variant === 'target_surface') {
    if (end.lowerLimit !== undefined) throw new Error('Full-surface Waterline intent has an unexpected lower limit.')
    return { mode: 'target_surface' }
  }
  if (intent.policy.variant !== 'bounded_surface' || !end.lowerLimit ||
      end.lowerLimit.reference !== 'top') {
    throw new Error('Bounded Waterline Smart Height has no model-Top-relative finish limit.')
  }
  const finishDepthMm = -finite(end.lowerLimit.offsetMm, 'Waterline 3D finish depth')
  if (finishDepthMm <= 0) throw new Error('Waterline 3D finish depth must be greater than zero.')
  return { mode: 'bounded_surface', finishDepthMm }
}

export function buildWaterline3dEvidenceContext(input: Waterline3dEvidenceInput): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Waterline 3D WCS origin')
  if (input.geometryIds.length !== 1 || input.geometryIds[0] !== input.target.geometryId) {
    throw new Error('Waterline 3D target evidence must match its single authored target geometry.')
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
    operationType: 'waterline_3d',
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}

export function resolveWaterline3dSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds: string[]
  geometryPositionZ: number
  stockTopMachineMm?: number
}): ResolvedWaterline3dSmartHeights {
  if (input.intent.policy.operationType !== 'waterline_3d' || input.evidence.operationType !== 'waterline_3d') {
    throw new Waterline3dSmartHeightError({
      code: 'policy_mismatch',
      message: 'Waterline 3D Smart Height received non-Waterline intent or evidence.',
    })
  }
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'whole_target' || scope.geometryIds.length !== input.geometryIds.length ||
      scope.geometryIds.some((id, index) => id !== input.geometryIds[index])) {
    throw new Waterline3dSmartHeightError({
      code: 'policy_mismatch',
      message: 'Waterline 3D Smart Height scope no longer matches the operation target geometry.',
    })
  }
  const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(input.intent, input.evidence), input.evidence)
  if (!result.ok) throw new Waterline3dSmartHeightError(result.refusal)
  const plan = result.plan
  const end = plan.machining.cutterCenterEnd
  if (!end) {
    throw new Waterline3dSmartHeightError({
      code: 'invalid_evidence', message: 'Waterline 3D resolved no cutter-center Target End.',
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
  const draft = waterline3dHeightDraftFromIntent(input.intent)
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
