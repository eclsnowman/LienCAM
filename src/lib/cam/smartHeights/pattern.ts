// WO-3001: Smart Height V2 for the scripted pattern operation (pattern2d).
//
// One variant, `explicit_depth`, over the setup's stock footprint: Material
// Start is the owning stock's top (the generic current-or-initial rule), the
// Target End is the stated depth below it. One depth authority (fix round 2):
// a script with a constant depth feeds that Target End (withPatternScriptDepth),
// the operator's own Top/Bottom Height rows (planeOverrides) replace either
// plane exactly as for every family, and the worker cuts to the resolved
// Bottom Height - the plane the operator sees is the plane that is cut.
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

export interface PatternSmartHeightIntentInput {
  setupId: string
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  stockId: string
  /** Target End, mm below Material Start. */
  depthMm: number
}

export interface PatternSmartHeightStockEvidence {
  stockId: string
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface PatternSmartHeightEvidenceInput {
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  owningStock: PatternSmartHeightStockEvidence
}

export interface ResolvedPatternSmartHeights {
  plan: ResolvedHeightPlanV2
  /** WCS-relative scalar envelope handed to the pattern worker. */
  workerHeights: HeightParams
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
}

export class PatternSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Pattern Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'PatternSmartHeightError'
    this.refusal = refusal
  }
}

const policyOwner = { kind: 'operation_policy' as const }
const userOwner = { kind: 'user_override' as const }

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`)
  return value
}

function fingerprint(prefix: string, values: readonly string[]): string {
  return [prefix, ...values].join(':')
}

/** A script's constant depth in mm (`depth` in its own units), or undefined for a depth expression or an unreadable script. */
export function patternScriptDepthMm(spec: unknown): number | undefined {
  if (typeof spec !== 'object' || spec === null) return undefined
  const { depth, units } = spec as { depth?: unknown; units?: unknown }
  if (typeof depth !== 'number' || !Number.isFinite(depth) || depth <= 0) return undefined
  if (units === 'mm') return depth
  if (units === 'in') return depth * 25.4
  return undefined
}

/** The intent with its Target End fed from the script's constant depth, when the script states one. */
export function withPatternScriptDepth(intent: OperationHeightIntentV2, spec: unknown): OperationHeightIntentV2 {
  const depthMm = patternScriptDepthMm(spec)
  const end = intent.machining.end
  if (depthMm === undefined || end.value.kind !== 'depth_from_start' || end.value.depthMm === depthMm) return intent
  return { ...intent, machining: { ...intent.machining, end: { ...end, value: { kind: 'depth_from_start', depthMm } } } }
}

function patternSafety(setupId: string, safetyIntent: PatternSmartHeightIntentInput['safetyIntent']): OperationHeightIntentV2['safety'] {
  const setup = { kind: 'setup' as const, setupId }
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: value.reference,
    offsetMm: value.offset,
    owner: value.provenance === 'user' ? userOwner : setup,
  })
  return {
    clearance: safetyPlane(safetyIntent.clearance),
    retract: safetyPlane(safetyIntent.retract),
    feed: safetyPlane(safetyIntent.feed),
  }
}

export function buildPatternSmartHeightIntent(input: PatternSmartHeightIntentInput): OperationHeightIntentV2 {
  const stockId = input.stockId.trim()
  if (!stockId) throw new Error('Pattern Smart Height needs the setup\'s stock.')
  const depthMm = finite(input.depthMm, 'Pattern depth')
  if (depthMm <= 0) throw new Error('Pattern depth must be greater than zero.')
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'pattern', variant: 'explicit_depth' },
    safety: patternSafety(input.setupId, input.safetyIntent),
    machining: {
      start: { owner: policyOwner, value: { kind: 'current_material' } },
      end: { owner: userOwner, value: { kind: 'depth_from_start', depthMm } },
      scope: { owner: policyOwner, value: { kind: 'stock_footprint', stockId } },
    },
  }
}

/** The intent with new Clearance/Retract/Feed planes (a Properties edit); depth, scope and plane overrides kept. */
export function rebuildPatternSmartHeightIntent(input: {
  intent: OperationHeightIntentV2
  setupId: string
  safetyIntent: PatternSmartHeightIntentInput['safetyIntent']
}): OperationHeightIntentV2 {
  if (input.intent.policy.operationType !== 'pattern') throw new Error('Pattern Smart Height received a non-Pattern intent.')
  return { ...input.intent, safety: patternSafety(input.setupId, input.safetyIntent) }
}

export function buildPatternSmartHeightEvidenceContext(input: PatternSmartHeightEvidenceInput): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Pattern WCS origin')
  const stock = input.owningStock
  for (const [axis, value] of Object.entries(stock.boundsMachineMm)) finite(value, `Pattern stock '${stock.stockId}' ${axis}`)
  const b = stock.boundsMachineMm
  if (b.minX > b.maxX || b.minY > b.maxY || b.minZ > b.maxZ) {
    throw new Error(`Pattern stock '${stock.stockId}' has inverted bounds.`)
  }
  const wcsId = `setup-wcs:${input.operationId}`
  const scopeId = `operation-scope:${input.operationId}`
  const materialId = `owning-stock:${stock.stockId}:material`
  const stockFingerprint = fingerprint(stock.fingerprint, [stock.stockId])
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
      dependencyFingerprint: fingerprint(input.revision.operationRevision, []),
    },
    {
      id: materialId,
      kind: 'owning_stock',
      role: 'material_artifact',
      entityId: stock.stockId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: stockFingerprint,
      spatial: {
        artifactId: stock.artifactId,
        schemaVersion: stock.schemaVersion ?? 1,
        representation: stock.representation,
        frame: 'machine',
        boundsMm: { ...b },
        fingerprint: stock.fingerprint,
      },
    },
    {
      id: `owning-stock:${stock.stockId}:top`,
      kind: 'owning_stock',
      role: 'stock_top',
      entityId: stock.stockId,
      dependencyNodeIds: [materialId],
      dependencyFingerprint: stockFingerprint,
      scalar: { frame: 'machine', valueMm: b.maxZ },
    },
    {
      id: `owning-stock:${stock.stockId}:bottom`,
      kind: 'owning_stock',
      role: 'stock_bottom',
      entityId: stock.stockId,
      dependencyNodeIds: [materialId],
      dependencyFingerprint: stockFingerprint,
      scalar: { frame: 'machine', valueMm: b.minZ },
    },
  ]
  return {
    revision: { ...input.revision },
    operationType: 'pattern',
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}

/** Resolve once and adapt the immutable plan to the worker's scalar heights. */
export function resolvePatternSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  stockId: string
}): ResolvedPatternSmartHeights {
  if (input.intent.policy.operationType !== 'pattern') {
    throw new PatternSmartHeightError({ code: 'policy_mismatch', message: 'Pattern Smart Height received a non-Pattern intent.' })
  }
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'stock_footprint' || scope.stockId !== input.stockId) {
    throw new PatternSmartHeightError({
      code: 'policy_mismatch',
      message: 'Pattern Smart Height stock scope no longer matches the setup\'s stock.',
    })
  }
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new PatternSmartHeightError(result.refusal)
  const plan = result.plan
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!cutterEnd) {
    throw new PatternSmartHeightError({ code: 'invalid_evidence', message: 'Pattern Smart Height resolved no Target End.' })
  }
  const feed = plan.safety.feed
  if (!feed) {
    throw new PatternSmartHeightError({ code: 'invalid_intent', message: 'Pattern Smart Height requires a Feed plane.' })
  }
  const inferred = (offset: number) => ({ reference: 'wcs_plane' as const, offset, provenance: 'inferred' as const })
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
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) => ids.indexOf(id) === index),
  }
}
