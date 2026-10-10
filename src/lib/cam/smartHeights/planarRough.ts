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
import { smartHeightEvidenceFingerprint } from './adaptive3d'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type PlanarRoughOperationType = 'pocket_2d' | 'adaptive_clearing_2d'
export type PlanarRoughSmartHeightMode =
  | 'geometry_floor'
  | 'stock_rough'
  | 'through_stock'
  | 'explicit_depth'

export const PLANAR_ROUGH_TARGET_REPRESENTATION = 'prismatic-height-regions-v1' as const

export interface PlanarRoughSmartHeightIntentInput {
  setupId: string
  operationType: PlanarRoughOperationType
  safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'>
  mode: PlanarRoughSmartHeightMode
  geometryIds?: string[]
  stockId?: string
  explicitTargetWcsMm?: number
  throughAllowanceMm?: number
}

export interface PlanarRoughArtifactEvidence {
  artifactId: string
  boundsMachineMm: SmartHeightBoundsMm
  fingerprint: string
  representation: string
  schemaVersion?: number
}

export interface PlanarRoughStockEvidence extends PlanarRoughArtifactEvidence {
  stockId: string
}

export interface PlanarRoughTargetEvidence extends PlanarRoughArtifactEvidence {
  geometryId: string
}

export interface PlanarRoughSelectedFloorEvidence {
  geometryId: string
  planeMachineMm: number
  fingerprint: string
}

export interface PlanarRoughTargetCompilationEvidence extends PlanarRoughArtifactEvidence {
  stockId: string
  materialArtifactId: string
  targetGeometryIds: string[]
  floorMachineMm: number
  /**
   * Regions protected at every worker depth. Local material must already end
   * at the target top; otherwise a scalar worker would leave an uncut column.
   */
  keepOutRegions: Array<{
    loopId: string
    materialTopMachineMm: number
    targetTopMachineMm: number
  }>
}

export interface PlanarRoughRemainingEvidence extends PlanarRoughArtifactEvidence {
  stockId: string
  materialTopMachineMm: number
  compatible: boolean
}

export interface PlanarRoughSmartHeightEvidenceInput {
  revision: SmartHeightRevisionStamp
  wcsOriginMachineMm: number
  operationId: string
  operationType: PlanarRoughOperationType
  geometryIds: string[]
  owningStocks: PlanarRoughStockEvidence[]
  floorStockToLeaveMm: number
  targets?: PlanarRoughTargetEvidence[]
  selectedFloor?: PlanarRoughSelectedFloorEvidence
  targetCompilation?: PlanarRoughTargetCompilationEvidence
  remainingMaterial?: PlanarRoughRemainingEvidence
}

export interface ResolvedPlanarRoughSmartHeights {
  plan: ResolvedHeightPlanV2
  /** WCS-relative scalar envelope handed to the existing 2D worker. */
  workerHeights: HeightParams
  /**
   * V2 owns axial allowance: normally the worker bottom already carries it and
   * this is zero. With Adaptive floor finishing the worker bottom is the true
   * floor and this is the allowance, so the engine roughs at floor + allowance
   * and cleans the floor once (WO-2051).
   */
  workerFloorStockToLeaveMm: number
  /** Keep-out loops compiled from the same target artifact as the scalar floor. */
  keepOutLoopIds: string[]
  targetCompilationFingerprint?: string
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
}

export class PlanarRoughSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Planar rough Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'PlanarRoughSmartHeightError'
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

function nonBlankIds(values: string[] | undefined, label: string): string[] {
  const ids = (values ?? []).map(value => value.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error(`${label} requires at least one id.`)
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids.`)
  return ids
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function validBounds(bounds: SmartHeightBoundsMm, label: string): SmartHeightBoundsMm {
  for (const [axis, value] of Object.entries(bounds)) finite(value, `${label} ${axis}`)
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ) {
    throw new Error(`${label} has inverted bounds.`)
  }
  return { ...bounds }
}

function boundsContainedBy(
  inner: SmartHeightBoundsMm,
  outer: SmartHeightBoundsMm,
  toleranceMm = 1e-6,
): boolean {
  return inner.minX >= outer.minX - toleranceMm && inner.maxX <= outer.maxX + toleranceMm &&
    inner.minY >= outer.minY - toleranceMm && inner.maxY <= outer.maxY + toleranceMm &&
    inner.minZ >= outer.minZ - toleranceMm && inner.maxZ <= outer.maxZ + toleranceMm
}

function artifact(value: PlanarRoughArtifactEvidence, boundsMm: SmartHeightBoundsMm) {
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

/**
 * Author Pocket 2D and Adaptive Clearing 2D meaning without inventing a
 * generic Top-minus-5 depth. Every mode names its physical endpoint.
 */
export function buildPlanarRoughSmartHeightIntent(
  input: PlanarRoughSmartHeightIntentInput,
): OperationHeightIntentV2 {
  const setup = setupOwner(input.setupId)
  const safetyPlane = (value: HeightIntentV1['clearance']) => ({
    reference: value.reference,
    offsetMm: finite(value.offset, 'Planar rough safety offset'),
    owner: value.provenance === 'user' ? { kind: 'user_override' as const } : setup,
  })
  const safety = {
    clearance: safetyPlane(input.safetyIntent.clearance),
    retract: safetyPlane(input.safetyIntent.retract),
    feed: safetyPlane(input.safetyIntent.feed),
  }

  if (input.mode === 'stock_rough') {
    const stockId = input.stockId?.trim() ?? ''
    if (!stockId) throw new Error('Planar stock-rough intent requires an owning stock.')
    return {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: input.operationType, variant: 'stock_rough' },
      safety,
      machining: {
        start: { owner: policyOwner, value: { kind: 'current_material' } },
        end: { owner: policyOwner, value: { kind: 'target_surface' } },
        scope: { owner: policyOwner, value: { kind: 'stock_footprint', stockId } },
      },
    }
  }

  const geometryIds = nonBlankIds(input.geometryIds, `Planar ${input.mode} scope`)
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
  if (input.mode === 'geometry_floor') {
    return {
      ...common,
      policy: { operationType: input.operationType, variant: 'geometry_floor' },
      machining: {
        ...common.machining,
        end: {
          owner: userOwner,
          value: {
            kind: 'selected_plane',
            plane: { reference: 'picked_surface', offsetMm: 0, owner: userOwner },
          },
        },
      },
    }
  }
  if (input.mode === 'through_stock') {
    return {
      ...common,
      policy: { operationType: input.operationType, variant: 'through_stock' },
      machining: {
        ...common.machining,
        end: {
          owner: userOwner,
          value: {
            kind: 'through_stock',
            allowanceMm: nonNegative(input.throughAllowanceMm ?? 0, 'Through-stock allowance'),
          },
        },
      },
    }
  }
  return {
    ...common,
    policy: { operationType: input.operationType, variant: 'explicit_depth' },
    machining: {
      ...common.machining,
      end: {
        owner: userOwner,
        value: {
          kind: 'bounded_plane',
          plane: {
            reference: 'wcs_plane',
            offsetMm: finite(input.explicitTargetWcsMm ?? NaN, 'Explicit Target End'),
            owner: userOwner,
          },
        },
      },
    },
  }
}

/** Build the revision-stamped graph used by both preview and dispatch. */
export function buildPlanarRoughSmartHeightEvidenceContext(
  input: PlanarRoughSmartHeightEvidenceInput,
): HeightEvidenceContext {
  finite(input.wcsOriginMachineMm, 'Planar rough WCS origin')
  const floorAllowance = nonNegative(input.floorStockToLeaveMm, 'Planar rough floor stock to leave')
  const geometryIds = input.geometryIds.map(id => id.trim()).filter(Boolean)
  if (new Set(geometryIds).size !== geometryIds.length) {
    throw new Error('Planar rough evidence scope contains duplicate geometry ids.')
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
      dependencyFingerprint: evidenceFingerprint(input.revision.operationRevision, geometryIds),
    },
  ]

  const stocks = input.owningStocks.map(stock => ({
    ...stock,
    stockId: stock.stockId.trim(),
    boundsMachineMm: validBounds(stock.boundsMachineMm, `Planar rough stock '${stock.stockId}'`),
  }))
  for (const stock of stocks) {
    if (!stock.stockId) throw new Error('Planar rough stock id cannot be blank.')
    const materialId = `owning-stock:${stock.stockId}:material`
    const stockFingerprint = evidenceFingerprint(stock.fingerprint, {
      stockId: stock.stockId,
      bounds: stock.boundsMachineMm,
    })
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
    const owningStock = stocks.find(stock => stock.stockId === remaining.stockId)
    if (!owningStock) {
      throw new Error(`Remaining material names unproven stock '${remaining.stockId}'.`)
    }
    const bounds = validBounds(remaining.boundsMachineMm, 'Planar rough remaining material')
    if (!boundsContainedBy(bounds, owningStock.boundsMachineMm)) {
      throw new Error(`Remaining material is outside owning stock '${owningStock.stockId}'.`)
    }
    const materialTop = finite(remaining.materialTopMachineMm, 'Planar rough remaining material Top')
    if (materialTop < bounds.minZ - 1e-6 || materialTop > bounds.maxZ + 1e-6) {
      throw new Error('Remaining material Top is outside its artifact bounds.')
    }
    const materialId = `remaining-material:${remaining.artifactId}`
    nodes.push(
      {
        id: materialId,
        kind: 'remaining_material',
        role: 'material_artifact',
        entityId: remaining.artifactId,
        dependencyNodeIds: [scopeId, `owning-stock:${owningStock.stockId}:material`],
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
        scalar: {
          frame: 'machine',
          valueMm: materialTop,
        },
      },
    )
  }

  const targets = (input.targets ?? []).map(target => ({
    ...target,
    boundsMachineMm: validBounds(target.boundsMachineMm, `Planar rough target '${target.geometryId}'`),
  }))
  if (new Set(targets.map(target => target.geometryId)).size !== targets.length) {
    throw new Error('Planar rough target evidence contains duplicate geometry ids.')
  }
  for (const target of targets) {
    if (!geometryIds.includes(target.geometryId)) {
      throw new Error(`Planar rough target '${target.geometryId}' is outside the operation scope.`)
    }
    if (stocks.length === 1 && !boundsContainedBy(target.boundsMachineMm, stocks[0].boundsMachineMm)) {
      throw new Error(`Planar rough target '${target.geometryId}' is outside owning stock '${stocks[0].stockId}'.`)
    }
    nodes.push({
      id: `target-model:${target.geometryId}`,
      kind: 'target_model',
      role: 'target_artifact',
      entityId: target.geometryId,
      dependencyNodeIds: [scopeId],
      dependencyFingerprint: target.fingerprint,
      spatial: artifact(target, target.boundsMachineMm),
    })
  }

  if (input.selectedFloor) {
    const selected = input.selectedFloor
    const target = targets.find(candidate => candidate.geometryId === selected.geometryId)
    if (!target) {
      throw new Error(`Selected floor target '${selected.geometryId}' is not present in target evidence.`)
    }
    const plane = finite(selected.planeMachineMm, 'Planar rough selected floor')
    if (plane < target.boundsMachineMm.minZ - 1e-6 || plane > target.boundsMachineMm.maxZ + 1e-6) {
      throw new Error(`Selected floor for '${selected.geometryId}' is outside the target bounds.`)
    }
    nodes.push({
      id: `selected-plane:${selected.geometryId}`,
      kind: 'selected_plane',
      role: 'selected_plane',
      entityId: selected.geometryId,
      dependencyNodeIds: [`target-model:${selected.geometryId}`],
      dependencyFingerprint: selected.fingerprint,
      scalar: {
        frame: 'machine',
        valueMm: plane,
      },
    })
  }

  if (input.targetCompilation) {
    const compilation = input.targetCompilation
    const bounds = validBounds(compilation.boundsMachineMm, 'Planar rough target compilation')
    const stock = stocks.find(candidate => candidate.stockId === compilation.stockId)
    if (!stock) {
      throw new Error(`Target compilation names unproven stock '${compilation.stockId}'.`)
    }
    const targetIds = targets.map(target => target.geometryId)
    if (!sameIds(compilation.targetGeometryIds, targetIds)) {
      throw new Error('Target compilation geometry no longer matches target evidence.')
    }
    if (!boundsContainedBy(bounds, stock.boundsMachineMm)) {
      throw new Error(`Target compilation is outside owning stock '${stock.stockId}'.`)
    }
    const floor = finite(compilation.floorMachineMm, 'Planar rough compiled target floor')
    if (floor < bounds.minZ - 1e-6 || floor > bounds.maxZ + 1e-6) {
      throw new Error('Target compilation floor is outside its artifact bounds.')
    }
    const targetNodeIds = targetIds.map(id => `target-model:${id}`)
    const compatibleRemaining = input.remainingMaterial?.compatible
      ? input.remainingMaterial
      : undefined
    const expectedMaterialArtifactId = compatibleRemaining?.artifactId ?? stock.artifactId
    if (compilation.materialArtifactId !== expectedMaterialArtifactId) {
      throw new Error('Target compilation no longer matches the current-material artifact.')
    }
    const materialNodeId = compatibleRemaining
      ? `remaining-material:${compatibleRemaining.artifactId}`
      : `owning-stock:${stock.stockId}:material`
    nodes.push({
      id: `target-field:${compilation.artifactId}`,
      kind: 'target_surface_field',
      role: 'target_artifact',
      entityId: compilation.artifactId,
      dependencyNodeIds: [scopeId, materialNodeId, ...targetNodeIds],
      dependencyFingerprint: evidenceFingerprint(compilation.fingerprint, {
        stockId: compilation.stockId,
        materialArtifactId: compilation.materialArtifactId,
        targetGeometryIds: compilation.targetGeometryIds,
        floorMachineMm: compilation.floorMachineMm,
        keepOutRegions: compilation.keepOutRegions,
      }),
      scalar: {
        frame: 'machine',
        valueMm: floor,
      },
      spatial: artifact(compilation, bounds),
    })
  }

  if (floorAllowance > 0) {
    const targetDependency = input.targetCompilation
      ? `target-field:${input.targetCompilation.artifactId}`
      : input.selectedFloor
        ? `selected-plane:${input.selectedFloor.geometryId}`
        : scopeId
    nodes.push({
      id: `allowance:${input.operationId}:floor`,
      kind: 'strategy_allowance',
      role: 'cutter_end_allowance',
      entityId: input.operationId,
      dependencyNodeIds: [targetDependency],
      dependencyFingerprint: evidenceFingerprint(input.revision.operationRevision, floorAllowance),
      scalar: { frame: 'machine', valueMm: floorAllowance },
    })
  }

  return {
    revision: { ...input.revision },
    operationType: input.operationType,
    wcsOriginMachineMm: input.wcsOriginMachineMm,
    evidence: nodes,
  }
}

function assertGeometryScope(intent: OperationHeightIntentV2, geometryIds: string[]): void {
  const scope = intent.machining.scope.value
  if (scope.kind !== 'selected_geometry' || !sameIds(scope.geometryIds, geometryIds)) {
    throw new PlanarRoughSmartHeightError({
      code: 'policy_mismatch',
      message: 'Planar rough Smart Height scope no longer matches selected geometry.',
    })
  }
}

/**
 * Resolve the shared V2 plan and prove that a scalar-only 2D worker can
 * represent it. Spatial stock roughing is legal only as a verified prismatic
 * compilation: one floor plus explicit keep-out loops for all higher regions.
 */
export function resolvePlanarRoughSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds: string[]
  stockId: string
  targetCompilation?: PlanarRoughTargetCompilationEvidence
  /** Adaptive floor finishing: the op cleans the physical floor after roughing. */
  floorFinish?: boolean
}): ResolvedPlanarRoughSmartHeights {
  const operationType = input.intent.policy.operationType
  if (operationType !== 'pocket_2d' && operationType !== 'adaptive_clearing_2d') {
    throw new PlanarRoughSmartHeightError({
      code: 'policy_mismatch',
      message: 'Planar rough Smart Height received a non-planar-rough operation.',
    })
  }
  if (input.evidence.operationType !== operationType) {
    throw new PlanarRoughSmartHeightError({
      code: 'policy_mismatch',
      message: 'Planar rough intent and evidence operation types do not match.',
    })
  }
  const stockId = input.stockId.trim()
  if (!stockId) {
    throw new PlanarRoughSmartHeightError({
      code: 'missing_evidence',
      evidenceKind: 'owning_stock',
      message: 'Planar rough Smart Height requires a proven owning stock.',
    })
  }
  const stockArtifacts = input.evidence.evidence.filter(node =>
    node.kind === 'owning_stock' && node.role === 'material_artifact',
  )
  if (stockArtifacts.length === 0) {
    throw new PlanarRoughSmartHeightError({
      code: 'missing_evidence',
      evidenceKind: 'owning_stock',
      message: 'Planar rough Smart Height has no owning-stock artifact.',
    })
  }
  if (stockArtifacts.length > 1) {
    throw new PlanarRoughSmartHeightError({
      code: 'ambiguous_evidence',
      evidenceKind: 'owning_stock',
      message: 'Planar rough Smart Height found more than one owning stock.',
    })
  }
  if (stockArtifacts[0].entityId !== stockId) {
    throw new PlanarRoughSmartHeightError({
      code: 'policy_mismatch',
      message: 'Planar rough Smart Height owning stock no longer matches live evidence.',
    })
  }

  const variant = input.intent.policy.variant
  if (variant === 'stock_rough') {
    const scope = input.intent.machining.scope.value
    if (scope.kind !== 'stock_footprint' || scope.stockId !== stockId) {
      throw new PlanarRoughSmartHeightError({
        code: 'policy_mismatch',
        message: 'Planar stock-rough scope no longer matches the owning stock.',
      })
    }
    const compilation = input.targetCompilation
    if (!compilation) {
      throw new PlanarRoughSmartHeightError({
        code: 'missing_evidence',
        evidenceKind: 'target_surface_field',
        message: 'Stock roughing requires a proven prismatic target compilation.',
      })
    }
    if (compilation.representation !== PLANAR_ROUGH_TARGET_REPRESENTATION) {
      throw new PlanarRoughSmartHeightError({
        code: 'invalid_evidence',
        evidenceKind: 'target_surface_field',
        message: `Scalar 2D roughing cannot represent target '${compilation.representation}'.`,
      })
    }
    if (compilation.stockId !== stockId) {
      throw new PlanarRoughSmartHeightError({
        code: 'policy_mismatch',
        message: 'Target compilation belongs to a different stock.',
      })
    }
  } else {
    assertGeometryScope(input.intent, input.geometryIds)
    if (input.targetCompilation) {
      throw new PlanarRoughSmartHeightError({
        code: 'invalid_evidence',
        message: `Planar rough variant '${variant}' must not consume a stock-rough target compilation.`,
      })
    }
    if (variant === 'through_stock' && input.evidence.evidence.some(node =>
      node.role === 'cutter_end_allowance' && Math.abs(node.scalar?.valueMm ?? 0) > 1e-9,
    )) {
      throw new PlanarRoughSmartHeightError({
        code: 'invalid_intent',
        message: 'Through-stock intent cannot also leave axial floor stock.',
      })
    }
  }

  const result = resolveSmartHeightPlan(input.intent, input.evidence)
  if (!result.ok) throw new PlanarRoughSmartHeightError(result.refusal)
  const plan = result.plan
  const cutterEnd = plan.machining.cutterCenterEnd
  const feed = plan.safety.feed
  if (!cutterEnd || !feed) {
    throw new PlanarRoughSmartHeightError({
      code: 'invalid_evidence',
      message: 'Planar rough Smart Height resolved an incomplete scalar worker envelope.',
    })
  }

  let keepOutLoopIds: string[] = []
  let targetCompilationFingerprint: string | undefined
  if (variant === 'stock_rough') {
    const compilation = input.targetCompilation!
    const targetArtifact = plan.machining.targetArtifact
    const materialNode = plan.evidenceGraph.find(node =>
      node.spatial?.artifactId === compilation.materialArtifactId,
    )
    const targetNode = plan.evidenceGraph.find(node =>
      node.kind === 'target_surface_field' && node.role === 'target_artifact' &&
      node.entityId === compilation.artifactId,
    )
    const expectedDependencyFingerprint = evidenceFingerprint(compilation.fingerprint, {
      stockId: compilation.stockId,
      materialArtifactId: compilation.materialArtifactId,
      targetGeometryIds: compilation.targetGeometryIds,
      floorMachineMm: compilation.floorMachineMm,
      keepOutRegions: compilation.keepOutRegions,
    })
    if (!targetArtifact || !materialNode?.spatial ||
        targetArtifact.artifactId !== compilation.artifactId ||
        targetArtifact.fingerprint !== compilation.fingerprint ||
        targetArtifact.representation !== PLANAR_ROUGH_TARGET_REPRESENTATION ||
        targetNode?.dependencyFingerprint !== expectedDependencyFingerprint) {
      throw new PlanarRoughSmartHeightError({
        code: 'invalid_evidence',
        evidenceKind: 'target_surface_field',
        message: 'Resolved target artifact no longer matches the prismatic compilation.',
      })
    }
    const compiledLoopIds = compilation.keepOutRegions.map(region => region.loopId)
    if (new Set(compiledLoopIds).size !== compiledLoopIds.length ||
        compiledLoopIds.some(id => !id.trim())) {
      throw new PlanarRoughSmartHeightError({
        code: 'invalid_evidence',
        evidenceKind: 'target_surface_field',
        message: 'Prismatic target compilation contains invalid keep-out loop identities.',
      })
    }
    for (const region of compilation.keepOutRegions) {
      const materialTop = finite(region.materialTopMachineMm, `Keep-out '${region.loopId}' material Top`)
      const targetTop = finite(region.targetTopMachineMm, `Keep-out '${region.loopId}' target Top`)
      if (materialTop > plan.machining.materialStart.machineMm + 1e-6 ||
          materialTop < materialNode.spatial.boundsMm.minZ - 1e-6 ||
          materialTop > materialNode.spatial.boundsMm.maxZ + 1e-6 ||
          targetTop < targetArtifact.boundsMm.minZ - 1e-6 ||
          targetTop > targetArtifact.boundsMm.maxZ + 1e-6 ||
          targetTop < compilation.floorMachineMm - 1e-6) {
        throw new PlanarRoughSmartHeightError({
          code: 'invalid_evidence',
          evidenceKind: 'target_surface_field',
          message: `Keep-out '${region.loopId}' has an invalid material or target height.`,
        })
      }
      if (Math.abs(materialTop - targetTop) > 1e-6) {
        throw new PlanarRoughSmartHeightError({
          code: 'invalid_evidence',
          evidenceKind: 'target_surface_field',
          message: `Scalar 2D roughing cannot clear material above keep-out '${region.loopId}'.`,
        })
      }
    }
    keepOutLoopIds = [...compiledLoopIds]
    targetCompilationFingerprint = smartHeightEvidenceFingerprint({
      artifactId: compilation.artifactId,
      fingerprint: compilation.fingerprint,
      stockId: compilation.stockId,
      materialArtifactId: compilation.materialArtifactId,
      targetGeometryIds: compilation.targetGeometryIds,
      floorMachineMm: compilation.floorMachineMm,
      keepOutRegions: compilation.keepOutRegions,
    })
  }

  // Floor finishing cleans the physical floor, so the worker gets that floor and
  // the axial allowance above it instead of a bottom already raised by it.
  const physicalFloor = plan.machining.physicalTarget
  const floorAllowance = input.floorFinish === true && operationType === 'adaptive_clearing_2d' &&
    physicalFloor !== undefined
    ? cutterEnd.wcsMm - physicalFloor.wcsMm
    : 0
  const floorFinishesPhysicalFloor = floorAllowance > 1e-6
  const workerBottomWcs = floorFinishesPhysicalFloor ? physicalFloor!.wcsMm : cutterEnd.wcsMm

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
    bottom: inferred(workerBottomWcs),
  }
  const workerHeights: HeightParams = {
    clearanceHeight: plan.safety.clearance.wcsMm,
    clearanceHeightMode: 'absolute',
    retractHeight: plan.safety.retract.wcsMm,
    feedHeight: feed.wcsMm,
    topHeight: plan.machining.materialStart.wcsMm,
    topHeightMode: 'absolute',
    bottomHeight: workerBottomWcs,
    bottomHeightMode: 'absolute',
    heightIntent: snapshotIntent,
  }
  return {
    plan,
    workerHeights,
    workerFloorStockToLeaveMm: floorFinishesPhysicalFloor ? floorAllowance : 0,
    keepOutLoopIds,
    targetCompilationFingerprint,
    snapshotIntent,
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
  }
}
