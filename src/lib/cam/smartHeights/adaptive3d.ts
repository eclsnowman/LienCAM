import type { HeightIntentV1 } from '../../../types'
import type { PartMesh } from '../../../cam3d/kernel/types'
import type { ResolvedParallel3dHeights } from '../../../cam3d/integration/parallel3dOperation'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type SmartHeightBoundsMm,
  type SmartHeightEvidenceNode,
  type SmartHeightRevisionStamp,
  type ResolvedHeightPlanV2,
} from './types'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type Adaptive3dMaterialMode =
  | 'initial_stock'
  | 'current_material'
  | 'rest'
  | 'bounded_band'

export interface Adaptive3dIntentInput {
  setupId: string
  geometryIds: string[]
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  mode?: Adaptive3dMaterialMode
  boundedBand?: {
    topWcsMm: number
    bottomWcsMm: number
  }
}

export interface Adaptive3dHeightDraft {
  mode: Adaptive3dMaterialMode
  topWcsMm: number
  bottomWcsMm: number
}

export interface Adaptive3dArtifactEvidence {
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface Adaptive3dStockEvidence extends Adaptive3dArtifactEvidence {
  stockId: string
}

export interface Adaptive3dTargetEvidence extends Adaptive3dArtifactEvidence {
  geometryId: string
}

export interface Adaptive3dToolEvidence {
  toolId: string
  fingerprint: string
}

export interface Adaptive3dEvidenceInput {
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  geometryIds: string[]
  owningStocks: Adaptive3dStockEvidence[]
  target: Adaptive3dTargetEvidence
  tool: Adaptive3dToolEvidence
  axialStockToLeaveMm: number
  remainingMaterial?: Adaptive3dArtifactEvidence & {
    compatible: boolean
    materialTopMachineMm: number
  }
}

export class Adaptive3dSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Adaptive 3D Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'Adaptive3dSmartHeightError'
    this.refusal = refusal
  }
}

export interface ResolvedAdaptive3dSmartHeights {
  plan: ResolvedHeightPlanV2
  /** Strategy-local values handed to cam3d. Axial stock is already included. */
  localHeights: ResolvedParallel3dHeights
  /** Exact scalar snapshot of the resolved runtime envelope. */
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
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

function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Object.is(value, -0) ? 0 : value
  }
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]),
  )
}

/** Small deterministic identity used by Smart Height evidence and retained
 * material compatibility. It deliberately hashes values, not object identity. */
export function smartHeightEvidenceFingerprint(value: unknown): string {
  const text = JSON.stringify(canonical(value)) ?? 'undefined'
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0
  }
  return `smart-height-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/** Transform the acquired mesh AABB into the machine/world frame used by
 * stock ownership evidence. Adaptive currently permits translation and Z spin
 * only, so all four XY corners plus the two Z endpoints are sufficient. */
export function adaptive3dTargetMachineBounds(input: {
  meshBounds: PartMesh['bounds']
  position: { x: number; y: number; z: number }
  rotationZDeg: number
}): SmartHeightBoundsMm {
  const { min, max } = input.meshBounds
  const radians = input.rotationZDeg * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const corners = [
    [min[0], min[1]], [min[0], max[1]], [max[0], min[1]], [max[0], max[1]],
  ] as const
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of corners) {
    xs.push(input.position.x + x * cos - y * sin)
    ys.push(input.position.y + x * sin + y * cos)
  }
  return validBounds({
    minX: Math.min(...xs), minY: Math.min(...ys), minZ: input.position.z + min[2],
    maxX: Math.max(...xs), maxY: Math.max(...ys), maxZ: input.position.z + max[2],
  }, 'Adaptive 3D transformed target')
}

/** Convert one resolved V2 plan into the exact local scalar envelope consumed
 * by the existing cam3d strategy. This is shared by preview and dispatch.
 * The cutter endpoint already contains axial stock-to-leave exactly once. */
export function resolveAdaptive3dSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds: string[]
  geometryPositionZ: number
}): ResolvedAdaptive3dSmartHeights {
  const authoredScope = input.intent.machining.scope.value
  const authoredGeometryIds = authoredScope.kind === 'whole_target'
    ? authoredScope.geometryIds
    : []
  if (authoredScope.kind !== 'whole_target' || authoredGeometryIds.length === 0 ||
      authoredGeometryIds.length !== input.geometryIds.length ||
      authoredGeometryIds.some((id, index) => id !== input.geometryIds[index])) {
    throw new Adaptive3dSmartHeightError({
      code: 'policy_mismatch',
      message: 'Adaptive 3D Smart Height scope no longer matches the operation target geometry.',
    })
  }
  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new Adaptive3dSmartHeightError(result.refusal)
  const plan = result.plan
  const cutterEnd = plan.machining.cutterCenterEnd
  if (!cutterEnd) {
    throw new Adaptive3dSmartHeightError({
      code: 'invalid_evidence',
      message: 'Adaptive 3D resolved no cutter-center Target End.',
    })
  }
  const materialStartMachine = plan.machining.materialStart.machineMm
  const feedMachine = plan.safety.feed.machineMm
  const retractMachine = plan.safety.retract.machineMm
  const clearanceMachine = plan.safety.clearance.machineMm
  const local = (machineMm: number) => machineMm - input.geometryPositionZ
  const localHeights: ResolvedParallel3dHeights = {
    clearanceZ: local(clearanceMachine),
    retractZ: local(retractMachine),
    feedZ: local(feedMachine),
    topZ: local(materialStartMachine),
    bottomZ: local(cutterEnd.machineMm),
    stockTopZ: local(materialStartMachine),
  }
  const inferred = (offset: number) => ({
    reference: 'wcs_plane' as const,
    offset,
    provenance: 'inferred' as const,
  })
  const snapshotIntent: HeightIntentV1 = {
    version: 1,
    clearance: inferred(clearanceMachine - input.evidence.wcsOriginMachineMm),
    retract: inferred(retractMachine - input.evidence.wcsOriginMachineMm),
    feed: inferred(feedMachine - input.evidence.wcsOriginMachineMm),
    top: inferred(materialStartMachine - input.evidence.wcsOriginMachineMm),
    bottom: inferred(cutterEnd.machineMm - input.evidence.wcsOriginMachineMm),
  }
  return {
    plan,
    localHeights,
    snapshotIntent,
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
  }
}

function intersectBounds(
  left: SmartHeightBoundsMm,
  right: SmartHeightBoundsMm,
): SmartHeightBoundsMm | undefined {
  const intersection = {
    minX: Math.max(left.minX, right.minX),
    minY: Math.max(left.minY, right.minY),
    minZ: Math.max(left.minZ, right.minZ),
    maxX: Math.min(left.maxX, right.maxX),
    maxY: Math.min(left.maxY, right.maxY),
    maxZ: Math.min(left.maxZ, right.maxZ),
  }
  return intersection.minX <= intersection.maxX &&
    intersection.minY <= intersection.maxY &&
    intersection.minZ <= intersection.maxZ
    ? intersection
    : undefined
}

function owner(setupId: string) {
  return { kind: 'setup' as const, setupId }
}

/** Author Adaptive 3D semantics without collapsing them into the legacy five
 * scalar fields. Current material is the new-operation default; an explicit
 * bounded band is stored only when the operator chose one. */
export function buildAdaptive3dSmartIntent(input: Adaptive3dIntentInput): OperationHeightIntentV2 {
  const mode = input.mode ?? 'current_material'
  if (input.geometryIds.length === 0) throw new Error('Adaptive 3D Smart Height requires target geometry.')
  if (mode === 'bounded_band' && !input.boundedBand) {
    throw new Error('Adaptive 3D bounded-band intent requires explicit Top and Bottom planes.')
  }
  if (mode === 'bounded_band' && input.boundedBand!.topWcsMm < input.boundedBand!.bottomWcsMm) {
    throw new Error('Adaptive 3D bounded-band Top must be greater than or equal to Bottom.')
  }
  const setupOwner = owner(input.setupId)
  const operationOwner = { kind: 'operation_policy' as const }
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: value.reference,
    offsetMm: value.offset,
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setupOwner,
  })
  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: { operationType: 'adaptive_3d', variant: mode },
    safety: {
      clearance: safetyPlane(input.safetyIntent.clearance),
      retract: safetyPlane(input.safetyIntent.retract),
      feed: safetyPlane(input.safetyIntent.feed),
    },
    machining: {
      start: {
        owner: mode === 'bounded_band' ? { kind: 'user_override' } : operationOwner,
        value: mode === 'bounded_band'
          ? {
              kind: 'explicit_plane',
              plane: {
                reference: 'wcs_plane',
                offsetMm: finite(input.boundedBand!.topWcsMm, 'Adaptive 3D bounded Top'),
                owner: { kind: 'user_override' },
              },
            }
          : mode === 'initial_stock'
            ? { kind: 'initial_stock' }
            : mode === 'current_material'
              ? { kind: 'current_material' }
              : { kind: 'policy_default' },
      },
      end: {
        owner: mode === 'bounded_band' ? { kind: 'user_override' } : operationOwner,
        value: mode === 'bounded_band'
          ? {
              kind: 'bounded_plane',
              plane: {
                reference: 'wcs_plane',
                offsetMm: finite(input.boundedBand!.bottomWcsMm, 'Adaptive 3D bounded Bottom'),
                owner: { kind: 'user_override' },
              },
            }
          : { kind: 'target_surface' },
      },
      scope: {
        owner: operationOwner,
        value: { kind: 'whole_target', geometryIds: [...input.geometryIds] },
      },
    },
  }
}

/** Recover the operator-editable Adaptive policy without consulting legacy
 * scalar heights. A malformed bounded intent is rejected instead of being
 * presented as a plausible default. */
export function adaptive3dHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
): Adaptive3dHeightDraft {
  if (intent.policy.operationType !== 'adaptive_3d') {
    throw new Error('Cannot edit a non-Adaptive Smart Height intent as Adaptive 3D.')
  }
  const mode = intent.policy.variant
  if (mode !== 'initial_stock' && mode !== 'current_material' &&
      mode !== 'rest' && mode !== 'bounded_band') {
    throw new Error(`Unsupported Adaptive 3D Smart Height policy "${String(mode)}".`)
  }
  if (mode !== 'bounded_band') {
    return { mode, topWcsMm: 0, bottomWcsMm: 0 }
  }
  const start = intent.machining.start.value
  const end = intent.machining.end.value
  if (start.kind !== 'explicit_plane' || end.kind !== 'bounded_plane') {
    throw new Error('Adaptive 3D bounded-band intent has no explicit Top and Bottom planes.')
  }
  return {
    mode,
    topWcsMm: finite(start.plane.offsetMm, 'Adaptive 3D bounded Top'),
    bottomWcsMm: finite(end.plane.offsetMm, 'Adaptive 3D bounded Bottom'),
  }
}

/** Re-author the mutable scope and safety inputs of an existing Adaptive V2
 * request without changing its material policy. Explicit bounded bands remain
 * explicit user authority across ordinary modal edits. */
export function refreshAdaptive3dSmartIntent(
  existing: OperationHeightIntentV2,
  input: Omit<Adaptive3dIntentInput, 'mode' | 'boundedBand'>,
): OperationHeightIntentV2 {
  if (existing.policy.operationType !== 'adaptive_3d') {
    throw new Error('Cannot refresh a non-Adaptive Smart Height intent as Adaptive 3D.')
  }
  const mode = existing.policy.variant
  const start = existing.machining.start.value
  const end = existing.machining.end.value
  const boundedBand = mode === 'bounded_band'
    ? {
        topWcsMm: start.kind === 'explicit_plane' ? start.plane.offsetMm : NaN,
        bottomWcsMm: end.kind === 'bounded_plane' ? end.plane.offsetMm : NaN,
      }
    : undefined
  return buildAdaptive3dSmartIntent({ ...input, mode, boundedBand })
}

function fingerprint(prefix: string, values: readonly string[]): string {
  return [prefix, ...values].join(':')
}

function artifact(
  value: Adaptive3dArtifactEvidence,
  boundsMm = value.boundsMachineMm,
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

/** Adapt proven machine-space stock, target, tool, scope, and retained-material
 * facts into the exact evidence graph consumed by preview and dispatch. A
 * compatible retained field is evidence; a stale/incompatible field is omitted
 * so current-material policy safely falls back and rest policy refuses. */
export function buildAdaptive3dEvidenceContext(input: Adaptive3dEvidenceInput): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Adaptive 3D WCS origin')
  finite(input.axialStockToLeaveMm, 'Adaptive 3D axial stock to leave')
  if (input.axialStockToLeaveMm < 0) throw new Error('Adaptive 3D axial stock to leave cannot be negative.')
  const targetBounds = validBounds(input.target.boundsMachineMm, 'Adaptive 3D target')
  const stocks = input.owningStocks.map(stock => ({
    ...stock,
    boundsMachineMm: validBounds(stock.boundsMachineMm, `Adaptive 3D stock '${stock.stockId}'`),
  }))
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
      dependencyFingerprint: fingerprint(input.revision.operationRevision, input.geometryIds),
    },
  ]
  for (const stock of stocks) {
    const stockNodeId = `owning-stock:${stock.stockId}`
    const stockFingerprint = fingerprint(stock.fingerprint, [stock.stockId])
    nodes.push(
      {
        id: `${stockNodeId}:material`, kind: 'owning_stock', role: 'material_artifact', entityId: stock.stockId,
        dependencyNodeIds: [scopeId], dependencyFingerprint: stockFingerprint, spatial: artifact(stock),
      },
      {
        id: `${stockNodeId}:top`, kind: 'owning_stock', role: 'stock_top', entityId: stock.stockId,
        dependencyNodeIds: [`${stockNodeId}:material`], dependencyFingerprint: stockFingerprint,
        scalar: { frame: 'machine', valueMm: stock.boundsMachineMm.maxZ },
      },
      {
        id: `${stockNodeId}:bottom`, kind: 'owning_stock', role: 'stock_bottom', entityId: stock.stockId,
        dependencyNodeIds: [`${stockNodeId}:material`], dependencyFingerprint: stockFingerprint,
        scalar: { frame: 'machine', valueMm: stock.boundsMachineMm.minZ },
      },
      {
        id: `${stockNodeId}:initial-material`, kind: 'initial_stock', role: 'material_artifact', entityId: stock.stockId,
        dependencyNodeIds: [`${stockNodeId}:material`],
        dependencyFingerprint: stockFingerprint, spatial: artifact(stock),
      },
      {
        id: `${stockNodeId}:initial-top`, kind: 'initial_stock', role: 'stock_top', entityId: stock.stockId,
        dependencyNodeIds: [`${stockNodeId}:initial-material`], dependencyFingerprint: stockFingerprint,
        scalar: { frame: 'machine', valueMm: stock.boundsMachineMm.maxZ },
      },
    )
  }

  const clippedTarget = stocks.length === 1
    ? intersectBounds(targetBounds, stocks[0].boundsMachineMm)
    : targetBounds
  if (stocks.length === 1 && !clippedTarget) {
    throw new Error(`Adaptive 3D target '${input.target.geometryId}' does not intersect its owning stock.`)
  }
  const targetArtifactId = `target-surface:${input.target.geometryId}`
  nodes.push(
    {
      id: `target-model:${input.target.geometryId}:top`, kind: 'target_model', role: 'target_top',
      entityId: input.target.geometryId, dependencyNodeIds: [scopeId],
      dependencyFingerprint: input.target.fingerprint,
      scalar: { frame: 'machine', valueMm: targetBounds.maxZ },
    },
    {
      id: `target-model:${input.target.geometryId}:bottom`, kind: 'target_model', role: 'target_bottom',
      entityId: input.target.geometryId, dependencyNodeIds: [scopeId],
      dependencyFingerprint: input.target.fingerprint,
      scalar: { frame: 'machine', valueMm: targetBounds.minZ },
    },
    {
      id: targetArtifactId, kind: 'target_surface_field', role: 'target_artifact',
      entityId: input.target.geometryId,
      dependencyNodeIds: [scopeId, `target-model:${input.target.geometryId}:top`],
      dependencyFingerprint: input.target.fingerprint,
      scalar: { frame: 'machine', valueMm: clippedTarget!.minZ },
      spatial: artifact(input.target, clippedTarget),
    },
    {
      id: `tool:${input.tool.toolId}`, kind: 'tool_geometry', role: 'tool',
      entityId: input.tool.toolId, dependencyNodeIds: [targetArtifactId],
      dependencyFingerprint: input.tool.fingerprint,
    },
    {
      id: `allowance:${input.operationId}:axial`, kind: 'strategy_allowance', role: 'cutter_end_allowance',
      entityId: input.operationId, dependencyNodeIds: [targetArtifactId],
      dependencyFingerprint: fingerprint(input.revision.operationRevision, [String(input.axialStockToLeaveMm)]),
      scalar: { frame: 'machine', valueMm: input.axialStockToLeaveMm },
    },
  )

  if (input.remainingMaterial?.compatible) {
    const remaining = input.remainingMaterial
    const remainingBounds = validBounds(remaining.boundsMachineMm, 'Adaptive 3D remaining material')
    const remainingArtifactId = `remaining-material:${remaining.artifactId}`
    nodes.push(
      {
        id: remainingArtifactId, kind: 'remaining_material', role: 'material_artifact',
        entityId: remaining.artifactId, dependencyNodeIds: [scopeId],
        dependencyFingerprint: remaining.fingerprint, spatial: artifact(remaining, remainingBounds),
      },
      {
        id: `${remainingArtifactId}:top`, kind: 'remaining_material', role: 'material_top',
        entityId: remaining.artifactId, dependencyNodeIds: [remainingArtifactId],
        dependencyFingerprint: remaining.fingerprint,
        scalar: {
          frame: 'machine',
          valueMm: finite(remaining.materialTopMachineMm, 'Adaptive 3D remaining material Top'),
        },
      },
    )
  }

  return {
    revision: { ...input.revision },
    operationType: 'adaptive_3d',
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}
