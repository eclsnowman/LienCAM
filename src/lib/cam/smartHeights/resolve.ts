import type { HeightPlaneName, HeightReference } from '../../../types'
import { operationHeightPolicy, type OperationHeightVariantPolicy } from './policies'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  type AuthoredPlaneIntentV2,
  type FeatureEndpointOverride,
  type HeightEvidenceContext,
  type MachiningEndIntent,
  type MaterialStartIntent,
  type OperationHeightIntentV2,
  type ResolvedFeatureEndpoint,
  type ResolvedHeightPlanV2,
  type ResolvedSmartHeightComponent,
  type SmartHeightEvidenceKind,
  type SmartHeightEvidenceNode,
  type SmartHeightEvidenceRole,
  type SmartHeightIntentOwner,
  type StableFeatureReference,
} from './types'

export type SmartHeightRefusalCode =
  | 'unsupported_operation'
  | 'inactive_variant'
  | 'policy_mismatch'
  | 'policy_version_unsupported'
  | 'invalid_revision'
  | 'invalid_intent'
  | 'invalid_evidence'
  | 'missing_evidence'
  | 'stale_dependency'
  | 'ambiguous_evidence'
  | 'evidence_cycle'
  | 'confirmation_required'
  | 'height_reference_cycle'
  | 'invalid_plane_order'

export interface SmartHeightRefusal {
  code: SmartHeightRefusalCode
  message: string
  evidenceKind?: SmartHeightEvidenceKind
  evidenceRole?: SmartHeightEvidenceRole
}

export type ResolveSmartHeightPlanResult =
  | { ok: true; plan: ResolvedHeightPlanV2 }
  | { ok: false; refusal: SmartHeightRefusal }

class ResolutionFailure extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(refusal.message)
    this.name = 'ResolutionFailure'
    this.refusal = refusal
  }
}

interface ResolvedNumber {
  wcsMm: number
  machineMm: number
  proofNodeIds: string[]
}

interface ResolvedEnd {
  physicalTarget?: ResolvedNumber
  cutterCenterEnd?: ResolvedNumber
  targetArtifactNode?: SmartHeightEvidenceNode
  featureEndpoints?: ResolvedFeatureEndpoint[]
}

const fail = (
  code: SmartHeightRefusalCode,
  message: string,
  detail: Pick<SmartHeightRefusal, 'evidenceKind' | 'evidenceRole'> = {},
): never => {
  throw new ResolutionFailure({ code, message, ...detail })
}

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) fail('invalid_evidence', `${label} must be finite.`)
  return value
}

const unique = <T>(values: T[]): T[] => [...new Set(values)]

const stableFeatureKey = (feature: StableFeatureReference): string => [
  feature.modelItemId,
  feature.bodyId,
  feature.featureKind,
  feature.stableId,
  String(feature.sourceVersion),
  feature.sourceFingerprint,
].join('\u001f')

function validateStableFeature(feature: StableFeatureReference, label: string): void {
  if (!feature.modelItemId.trim() || !feature.bodyId.trim() || !feature.featureKind.trim() ||
      !feature.stableId.trim() || !feature.sourceFingerprint.trim() ||
      !Number.isInteger(feature.sourceVersion) || feature.sourceVersion < 1) {
    fail('invalid_intent', `${label} has an incomplete stable feature reference.`)
  }
}

class EvidenceIndex {
  readonly nodes: SmartHeightEvidenceNode[]
  readonly byId = new Map<string, SmartHeightEvidenceNode>()
  readonly used = new Set<string>()

  constructor(
    context: HeightEvidenceContext,
  ) {
    this.nodes = context.evidence
    for (const node of this.nodes) {
      if (!node.id.trim()) fail('invalid_evidence', 'Evidence node id cannot be blank.')
      if (this.byId.has(node.id)) fail('invalid_evidence', `Evidence node '${node.id}' is duplicated.`)
      if (!node.entityId.trim()) fail('invalid_evidence', `Evidence node '${node.id}' has no entity id.`)
      if (!node.dependencyFingerprint.trim()) {
        fail('invalid_evidence', `Evidence node '${node.id}' has no dependency fingerprint.`)
      }
      if (node.scalar) {
        finite(node.scalar.valueMm, `Evidence '${node.id}' scalar`)
        if (node.scalar.frame === 'geometry_local') {
          finite(node.scalar.frameOriginMachineMm ?? NaN, `Evidence '${node.id}' geometry-local frame origin`)
        }
        if (node.scalar.frameOriginMachineMm !== undefined) {
          finite(node.scalar.frameOriginMachineMm, `Evidence '${node.id}' frame origin`)
        }
      }
      if (node.spatial) {
        const b = node.spatial.boundsMm
        for (const [axis, value] of Object.entries(b)) finite(value, `Evidence '${node.id}' spatial ${axis}`)
        if (b.minX > b.maxX || b.minY > b.maxY || b.minZ > b.maxZ) {
          fail('invalid_evidence', `Evidence '${node.id}' has inverted spatial bounds.`)
        }
        if (!node.spatial.artifactId.trim() || !node.spatial.fingerprint.trim()) {
          fail('invalid_evidence', `Evidence '${node.id}' has an incomplete spatial artifact reference.`)
        }
        if (node.spatial.frame === 'geometry_local') {
          finite(node.spatial.frameOriginMachineMm ?? NaN, `Evidence '${node.id}' spatial frame origin`)
        }
      }
      if (node.feature) {
        const feature = node.feature
        if (!feature.modelItemId.trim() || !feature.bodyId.trim() ||
            !feature.featureKind.trim() || !feature.stableId.trim() ||
            !feature.sourceFingerprint.trim() || !Number.isInteger(feature.sourceVersion) ||
            feature.sourceVersion < 1) {
          fail('invalid_evidence', `Evidence '${node.id}' has an incomplete stable feature reference.`)
        }
      }
      this.byId.set(node.id, node)
    }

    for (const node of this.nodes) {
      for (const dependencyId of node.dependencyNodeIds) {
        if (!this.byId.has(dependencyId)) {
          fail('invalid_evidence', `Evidence '${node.id}' depends on missing node '${dependencyId}'.`)
        }
      }
    }
    this.assertAcyclic()
  }

  private assertAcyclic(): void {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) fail('evidence_cycle', `Evidence dependency cycle includes '${id}'.`)
      visiting.add(id)
      const node = this.byId.get(id)!
      for (const dependencyId of node.dependencyNodeIds) visit(dependencyId)
      visiting.delete(id)
      visited.add(id)
    }
    for (const node of this.nodes) visit(node.id)
  }

  nodesOfKind(kind: SmartHeightEvidenceKind): SmartHeightEvidenceNode[] {
    return this.nodes.filter(node => node.kind === kind)
  }

  nodesOfRole(
    role: SmartHeightEvidenceRole,
    kind?: SmartHeightEvidenceKind,
  ): SmartHeightEvidenceNode[] {
    return this.nodes.filter(node => node.role === role && (kind === undefined || node.kind === kind))
  }

  requireKind(kind: SmartHeightEvidenceKind): void {
    const nodes = this.nodesOfKind(kind)
    if (nodes.length === 0) {
      fail('missing_evidence', `Smart Height requires '${kind}' evidence.`, { evidenceKind: kind })
    }
    for (const node of nodes) this.markUsed(node)
  }

  optionalUniqueRole(
    role: SmartHeightEvidenceRole,
    kind?: SmartHeightEvidenceKind,
  ): SmartHeightEvidenceNode | undefined {
    const nodes = this.nodesOfRole(role, kind)
    if (nodes.length > 1) {
      fail('ambiguous_evidence', `Smart Height found ${nodes.length} candidates for '${role}'.`, {
        evidenceKind: kind,
        evidenceRole: role,
      })
    }
    if (nodes[0]) this.markUsed(nodes[0])
    return nodes[0]
  }

  requireUniqueRole(
    role: SmartHeightEvidenceRole,
    kind?: SmartHeightEvidenceKind,
  ): SmartHeightEvidenceNode {
    return this.optionalUniqueRole(role, kind)
      ?? fail('missing_evidence', `Smart Height requires one '${role}' evidence value.`, {
        evidenceKind: kind,
        evidenceRole: role,
      })
  }

  markUsed(node: SmartHeightEvidenceNode): void {
    if (this.used.has(node.id)) return
    this.used.add(node.id)
    for (const dependencyId of node.dependencyNodeIds) this.markUsed(this.byId.get(dependencyId)!)
  }

  usedGraph(): SmartHeightEvidenceNode[] {
    return this.nodes.filter(node => this.used.has(node.id))
  }
}

function scalarToResolved(
  node: SmartHeightEvidenceNode,
  context: HeightEvidenceContext,
  index: EvidenceIndex,
): ResolvedNumber {
  const scalar = node.scalar ?? fail('invalid_evidence', `Evidence '${node.id}' has no scalar value.`)
  index.markUsed(node)
  let machineMm: number
  switch (scalar.frame) {
    case 'machine':
    case 'world':
      machineMm = scalar.valueMm + (scalar.frameOriginMachineMm ?? 0)
      break
    case 'wcs': {
      const origin = scalar.frameOriginMachineMm ?? context.wcsOriginMachineMm
      if (Math.abs(origin - context.wcsOriginMachineMm) > 1e-9) {
        fail('invalid_evidence', `Evidence '${node.id}' was resolved against a different WCS origin.`)
      }
      machineMm = scalar.valueMm + context.wcsOriginMachineMm
      break
    }
    case 'geometry_local':
      machineMm = scalar.valueMm + scalar.frameOriginMachineMm!
      break
  }
  finite(machineMm, `Evidence '${node.id}' machine value`)
  return {
    wcsMm: machineMm - context.wcsOriginMachineMm,
    machineMm,
    proofNodeIds: [node.id],
  }
}

function component(value: ResolvedNumber, owner: SmartHeightIntentOwner): ResolvedSmartHeightComponent {
  return {
    wcsMm: value.wcsMm,
    machineMm: value.machineMm,
    owner,
    proofNodeIds: unique(value.proofNodeIds),
  }
}

function offset(value: ResolvedNumber, offsetMm: number): ResolvedNumber {
  finite(offsetMm, 'Height offset')
  return {
    wcsMm: value.wcsMm + offsetMm,
    machineMm: value.machineMm + offsetMm,
    proofNodeIds: [...value.proofNodeIds],
  }
}

function sumAllowance(
  base: ResolvedNumber,
  nodes: SmartHeightEvidenceNode[],
  index: EvidenceIndex,
): ResolvedNumber {
  let delta = 0
  const proofs = [...base.proofNodeIds]
  for (const node of nodes) {
    const scalar = node.scalar ?? fail('invalid_evidence', `Allowance evidence '${node.id}' has no scalar value.`)
    // Allowances are distances, not positions. Their frame must not change the
    // numeric delta, but it is still declared for auditability.
    delta += finite(scalar.valueMm, `Allowance '${node.id}'`)
    index.markUsed(node)
    proofs.push(node.id)
  }
  return offset({ ...base, proofNodeIds: proofs }, delta)
}

function validateScope(intent: OperationHeightIntentV2): void {
  const scope = intent.machining.scope.value
  switch (scope.kind) {
    case 'selected_geometry':
    case 'whole_target':
    case 'containment':
      if (scope.geometryIds.length === 0) fail('invalid_intent', `${scope.kind} requires geometry.`)
      return
    case 'selected_paths':
      if (scope.geometryIds.length === 0) fail('invalid_intent', 'selected_paths requires geometry.')
      if (scope.loopIds.length === 0) fail('invalid_intent', 'selected_paths requires at least one path.')
      if (!scope.includeOpen && !scope.includeClosed) {
        fail('invalid_intent', 'selected_paths must include open paths, closed paths, or both.')
      }
      if (new Set(scope.geometryIds).size !== scope.geometryIds.length ||
          new Set(scope.loopIds).size !== scope.loopIds.length) {
        fail('invalid_intent', 'selected_paths contains duplicate geometry or path ids.')
      }
      return
    case 'selected_features':
      if (scope.features.length === 0) fail('invalid_intent', 'selected_features requires at least one feature.')
      {
        const keys = scope.features.map((feature, index) => {
          validateStableFeature(feature, `Selected feature ${index + 1}`)
          return stableFeatureKey(feature)
        })
        if (new Set(keys).size !== keys.length) {
          fail('invalid_intent', 'selected_features contains duplicate stable feature identities.')
        }
      }
      return
    case 'selected_bodies':
      if (scope.bodyIds.length === 0) fail('invalid_intent', 'selected_bodies requires at least one body.')
      return
    case 'stock_footprint':
      if (!scope.stockId.trim()) fail('invalid_intent', 'stock_footprint requires a stock id.')
  }
}

function resolveExternalReference(
  reference: Exclude<HeightReference, HeightPlaneName>,
  context: HeightEvidenceContext,
  index: EvidenceIndex,
): ResolvedNumber {
  switch (reference) {
    case 'stock_top':
      return scalarToResolved(index.requireUniqueRole('stock_top', 'owning_stock'), context, index)
    case 'stock_bottom':
      return scalarToResolved(index.requireUniqueRole('stock_bottom', 'owning_stock'), context, index)
    case 'model_top':
      return scalarToResolved(index.requireUniqueRole('target_top', 'target_model'), context, index)
    case 'model_bottom':
      return scalarToResolved(index.requireUniqueRole('target_bottom', 'target_model'), context, index)
    case 'geometry_plane':
    case 'picked_surface':
      return scalarToResolved(index.requireUniqueRole('selected_plane'), context, index)
    case 'selected_feature_top':
      return scalarToResolved(index.requireUniqueRole('feature_top'), context, index)
    case 'selected_feature_bottom':
      return scalarToResolved(index.requireUniqueRole('feature_floor'), context, index)
    case 'wcs_plane':
      return { wcsMm: 0, machineMm: context.wcsOriginMachineMm, proofNodeIds: [] }
    case 'machine_plane':
      return { wcsMm: -context.wcsOriginMachineMm, machineMm: 0, proofNodeIds: [] }
    case 'remaining_stock':
      return scalarToResolved(index.requireUniqueRole('material_top', 'remaining_material'), context, index)
  }
}

function resolveAuthoredPlane(
  authored: AuthoredPlaneIntentV2,
  resolvePlane: (plane: HeightPlaneName) => ResolvedNumber,
  context: HeightEvidenceContext,
  index: EvidenceIndex,
): ResolvedNumber {
  const reference = authored.reference
  const base = reference === 'clearance' || reference === 'retract' || reference === 'feed' || reference === 'top' || reference === 'bottom'
    ? resolvePlane(reference)
    : resolveExternalReference(reference, context, index)
  return offset(base, authored.offsetMm)
}

function resolveMaterialStart(
  authored: MaterialStartIntent,
  policy: OperationHeightVariantPolicy,
  context: HeightEvidenceContext,
  index: EvidenceIndex,
): ResolvedNumber {
  const currentOrInitial = (): ResolvedNumber => {
    const remaining = index.optionalUniqueRole('material_top', 'remaining_material')
    if (remaining) return scalarToResolved(remaining, context, index)
    const initial = index.optionalUniqueRole('stock_top', 'initial_stock')
      ?? index.requireUniqueRole('stock_top', 'owning_stock')
    return scalarToResolved(initial, context, index)
  }
  const explicitReference = (value: MaterialStartIntent): ResolvedNumber | undefined => {
    switch (value.kind) {
      case 'current_material': return currentOrInitial()
      case 'initial_stock': {
        const node = index.optionalUniqueRole('stock_top', 'initial_stock')
          ?? index.requireUniqueRole('stock_top', 'owning_stock')
        return scalarToResolved(node, context, index)
      }
      case 'selected_feature_top':
        return scalarToResolved(index.requireUniqueRole('feature_top'), context, index)
      case 'target_model_top':
        return scalarToResolved(index.requireUniqueRole('target_top'), context, index)
      case 'geometry_tool_formula':
        return scalarToResolved(
          index.requireUniqueRole('formula_material_start', 'strategy_allowance'),
          context,
          index,
        )
      case 'explicit_plane': {
        const resolveNoPlane = (plane: HeightPlaneName): ResolvedNumber =>
          fail('invalid_intent', `Material Start cannot reference unresolved '${plane}'.`)
        return resolveAuthoredPlane(value.plane, resolveNoPlane, context, index)
      }
      case 'policy_default': return undefined
    }
  }
  const explicit = explicitReference(authored)
  if (explicit) return explicit
  switch (policy.materialStart) {
    case 'current_or_initial_material': return currentOrInitial()
    case 'remaining_material_required':
      return scalarToResolved(index.requireUniqueRole('material_top', 'remaining_material'), context, index)
    case 'selected_feature_top':
      return scalarToResolved(index.requireUniqueRole('feature_top'), context, index)
    case 'target_model_top':
      return scalarToResolved(index.requireUniqueRole('target_top'), context, index)
    case 'geometry_tool_formula':
      return scalarToResolved(
        index.requireUniqueRole('formula_material_start', 'strategy_allowance'),
        context,
        index,
      )
    case 'explicit_required':
      return fail('confirmation_required', 'This operation has no physical Material Start; confirm an explicit start plane.')
    case 'unsupported':
      return fail('unsupported_operation', 'This operation has no live Smart Height policy.')
  }
}

function resolveEndValue(
  authored: MachiningEndIntent,
  policy: OperationHeightVariantPolicy,
  start: ResolvedNumber,
  owner: SmartHeightIntentOwner,
  context: HeightEvidenceContext,
  index: EvidenceIndex,
  featureScope: readonly StableFeatureReference[] | undefined,
  featureOverrides: readonly FeatureEndpointOverride[] | undefined,
): ResolvedEnd {
  const allowanceNodes = (): SmartHeightEvidenceNode[] =>
    index.nodesOfRole('cutter_end_allowance').filter(node => node.feature === undefined)

  const scalarEnd = (physical: ResolvedNumber, authoredAllowanceMm = 0): ResolvedEnd => {
    const afterAuthored = offset(physical, authoredAllowanceMm)
    return {
      physicalTarget: physical,
      cutterCenterEnd: sumAllowance(afterAuthored, allowanceNodes(), index),
    }
  }

  const targetSurface = (lowerLimit?: AuthoredPlaneIntentV2): ResolvedEnd => {
    const node = index.requireUniqueRole('target_artifact', 'target_surface_field')
    if (!node.spatial) fail('invalid_evidence', `Target surface evidence '${node.id}' has no spatial artifact.`)
    const physical = scalarToResolved(node, context, index)
    const resolved = scalarEnd(physical)
    if (!lowerLimit) return { ...resolved, targetArtifactNode: node }
    const limit = resolveAuthoredPlane(
      lowerLimit,
      plane => plane === 'top'
        ? start
        : fail('invalid_intent', `Target-surface lower limit cannot reference unresolved '${plane}'.`),
      context,
      index,
    )
    const cutterCenterEnd = resolved.cutterCenterEnd!
    return {
      ...resolved,
      cutterCenterEnd: limit.wcsMm > cutterCenterEnd.wcsMm
        ? {
            ...limit,
            proofNodeIds: [...new Set([...cutterCenterEnd.proofNodeIds, ...limit.proofNodeIds])],
          }
        : cutterCenterEnd,
      targetArtifactNode: node,
    }
  }

  const detectedFeatures = (): ResolvedEnd => {
    // Per-feature endpoints are shared by automatically detected Drill/Bore
    // features and explicitly selected Contour features. The evidence kind
    // records how the feature entered the operation; the stable feature
    // reference, not array position or evidence kind, owns endpoint identity.
    const nodes = index.nodesOfRole('feature_floor').filter(node =>
      node.kind === 'detected_feature_floor' || node.kind === 'selected_feature',
    )
    if (nodes.length === 0) {
      fail('missing_evidence', 'Detected-feature policy requires at least one feature floor.', {
        evidenceKind: 'detected_feature_floor', evidenceRole: 'feature_floor',
      })
    }
    const scopedFeatures = featureScope
      ?? fail('invalid_intent', 'Detected-feature policy requires an exact selected-feature scope.')
    if (scopedFeatures.length === 0) {
      fail('invalid_intent', 'Detected-feature policy requires an exact selected-feature scope.')
    }
    const scopeByKey = new Map<string, StableFeatureReference>()
    for (const feature of scopedFeatures) scopeByKey.set(stableFeatureKey(feature), feature)

    const floorByKey = new Map<string, SmartHeightEvidenceNode>()
    for (const node of nodes) {
      const feature = node.feature
        ?? fail('invalid_evidence', `Detected floor '${node.id}' has no stable feature reference.`)
      const featureKey = stableFeatureKey(feature)
      if (!scopeByKey.has(featureKey)) {
        fail('stale_dependency', `Detected feature '${feature.stableId}' is not in the authored feature scope.`)
      }
      if (floorByKey.has(featureKey)) {
        fail('ambiguous_evidence', `Detected feature '${feature.stableId}' has more than one floor.`)
      }
      floorByKey.set(featureKey, node)
    }

    const overrideByKey = new Map<string, FeatureEndpointOverride>()
    for (const [overrideIndex, override] of (featureOverrides ?? []).entries()) {
      validateStableFeature(override.feature, `Feature override ${overrideIndex + 1}`)
      const key = stableFeatureKey(override.feature)
      if (!scopeByKey.has(key)) {
        fail('stale_dependency', `Feature override '${override.feature.stableId}' no longer matches the authored feature scope.`)
      }
      if (overrideByKey.has(key)) {
        fail('invalid_intent', `Feature '${override.feature.stableId}' has more than one endpoint override.`)
      }
      overrideByKey.set(key, override)
    }

    const featureEndpoints = scopedFeatures.map(feature => {
      const key = stableFeatureKey(feature)
      const node = floorByKey.get(key)
        ?? fail('stale_dependency', `Authored feature '${feature.stableId}' no longer has matching floor evidence.`)
      const physical = scalarToResolved(node, context, index)
      const override = overrideByKey.get(key)
      if (override) {
        const cutter = resolveAuthoredPlane(
          override.cutterCenterEnd,
          plane => plane === 'top'
            ? start
            : fail('invalid_intent', `Per-feature endpoint cannot reference unresolved '${plane}'.`),
          context,
          index,
        )
        return {
          feature,
          physicalTarget: component(physical, owner),
          cutterCenterEnd: component(cutter, override.cutterCenterEnd.owner),
        }
      }
      const featureAllowances = index.nodesOfRole('cutter_end_allowance').filter(candidate =>
        candidate.feature === undefined || (
          candidate.feature.modelItemId === feature.modelItemId &&
          candidate.feature.bodyId === feature.bodyId &&
          candidate.feature.featureKind === feature.featureKind &&
          candidate.feature.stableId === feature.stableId &&
          candidate.feature.sourceVersion === feature.sourceVersion &&
          candidate.feature.sourceFingerprint === feature.sourceFingerprint
        ))
      const cutter = sumAllowance(physical, featureAllowances, index)
      return {
        feature,
        physicalTarget: component(physical, owner),
        cutterCenterEnd: component(cutter, owner),
      }
    })
    return { featureEndpoints }
  }

  const formula = (): ResolvedEnd => {
    const formulaNode = index.requireUniqueRole('formula_cutter_end', 'strategy_allowance')
    const cutter = scalarToResolved(formulaNode, context, index)
    const physicalNode = index.optionalUniqueRole('selected_plane')
      ?? index.optionalUniqueRole('feature_top')
      ?? index.optionalUniqueRole('feature_floor')
    const physical = physicalNode ? scalarToResolved(physicalNode, context, index) : undefined
    return { physicalTarget: physical, cutterCenterEnd: cutter }
  }

  const byRule = (rule: OperationHeightVariantPolicy['machiningEnd']): ResolvedEnd => {
    switch (rule) {
      case 'selected_target_face':
        return scalarEnd(scalarToResolved(index.requireUniqueRole('selected_plane'), context, index))
      case 'selected_plane':
        return scalarEnd(scalarToResolved(index.requireUniqueRole('selected_plane'), context, index))
      case 'selected_feature_floor':
        return scalarEnd(scalarToResolved(index.requireUniqueRole('feature_floor'), context, index))
      case 'target_surface_in_scope': return targetSurface()
      case 'detected_feature_floors': return detectedFeatures()
      case 'thread_band_formula':
      case 'edge_tool_formula':
      case 'engrave_tool_formula':
      case 'vcarve_tool_formula': return formula()
      case 'stock_bottom':
        return scalarEnd(scalarToResolved(index.requireUniqueRole('stock_bottom'), context, index))
      case 'model_bottom':
        return scalarEnd(scalarToResolved(index.requireUniqueRole('target_bottom'), context, index))
      case 'through_stock':
        return scalarEnd(scalarToResolved(index.requireUniqueRole('stock_bottom'), context, index))
      case 'explicit_depth':
        return fail('confirmation_required', 'This operation has no physical Target End; confirm an explicit end condition.')
      case 'unsupported':
        return fail('unsupported_operation', 'This operation has no live Smart Height policy.')
    }
  }

  switch (authored.kind) {
    case 'policy_default': return byRule(policy.machiningEnd)
    case 'target_surface': return targetSurface(authored.lowerLimit)
    case 'selected_feature_floor':
      return scalarEnd(scalarToResolved(index.requireUniqueRole('feature_floor'), context, index))
    case 'detected_feature_floors': return detectedFeatures()
    case 'selected_plane': {
      const resolveNoPlane = (plane: HeightPlaneName): ResolvedNumber =>
        fail('invalid_intent', `Target End cannot reference unresolved '${plane}'.`)
      return scalarEnd(resolveAuthoredPlane(authored.plane, resolveNoPlane, context, index))
    }
    case 'model_bottom':
      return scalarEnd(scalarToResolved(index.requireUniqueRole('target_bottom'), context, index), authored.allowanceMm)
    case 'stock_bottom':
      return scalarEnd(scalarToResolved(index.requireUniqueRole('stock_bottom'), context, index), authored.allowanceMm)
    case 'through_stock':
      return scalarEnd(scalarToResolved(index.requireUniqueRole('stock_bottom'), context, index), -Math.abs(authored.allowanceMm))
    case 'depth_from_start': {
      if (!Number.isFinite(authored.depthMm) || authored.depthMm <= 0) {
        fail('invalid_intent', 'Depth from Material Start must be finite and greater than zero.')
      }
      return scalarEnd(offset(start, -authored.depthMm))
    }
    case 'geometry_tool_formula': return formula()
    case 'bounded_plane': {
      const resolveNoPlane = (plane: HeightPlaneName): ResolvedNumber =>
        fail('invalid_intent', `Bounded Target End cannot reference unresolved '${plane}'.`)
      return scalarEnd(resolveAuthoredPlane(authored.plane, resolveNoPlane, context, index))
    }
  }
}

/** The operator's Bottom Height replaces the policy endpoint. The policy end is
 * still tried so a spatial target artifact or per-feature identity it proves
 * stays attached (strategies read both); every feature now ends at the
 * operator's plane. The operation's own stock-to-leave allowance applies to it
 * exactly as it does to an explicit bounded Target End. */
function operatorEnd(
  authored: AuthoredPlaneIntentV2,
  policyEnd: () => ResolvedEnd,
  start: ResolvedNumber,
  owner: SmartHeightIntentOwner,
  context: HeightEvidenceContext,
  index: EvidenceIndex,
): ResolvedEnd {
  let policy: ResolvedEnd | undefined
  try {
    policy = policyEnd()
  } catch (error) {
    if (!(error instanceof ResolutionFailure)) throw error
  }
  const physical = resolveAuthoredPlane(
    authored,
    plane => plane === 'top'
      ? start
      : fail('invalid_intent', `Bottom Height cannot reference unresolved '${plane}'.`),
    context,
    index,
  )
  const cutter = sumAllowance(
    physical,
    index.nodesOfRole('cutter_end_allowance').filter(node => node.feature === undefined),
    index,
  )
  return {
    physicalTarget: physical,
    cutterCenterEnd: cutter,
    ...(policy?.targetArtifactNode ? { targetArtifactNode: policy.targetArtifactNode } : {}),
    ...(policy?.featureEndpoints
      ? {
          featureEndpoints: policy.featureEndpoints.map(endpoint => ({
            ...endpoint,
            cutterCenterEnd: component(cutter, owner),
          })),
        }
      : {}),
  }
}

function resolveSmartHeightPlanOrThrow(
  intent: OperationHeightIntentV2,
  context: HeightEvidenceContext,
): ResolvedHeightPlanV2 {
  if (intent.version !== SMART_HEIGHT_INTENT_VERSION || intent.policyVersion !== SMART_HEIGHT_POLICY_VERSION) {
    fail('policy_version_unsupported', `Smart Height intent/policy version ${intent.version}/${intent.policyVersion} is unsupported.`)
  }
  if (intent.policy.operationType !== context.operationType) {
    fail('policy_mismatch', `Intent is for '${intent.policy.operationType}' but evidence is for '${context.operationType}'.`)
  }
  for (const [name, value] of Object.entries(context.revision)) {
    if (!value.trim()) fail('invalid_revision', `Smart Height ${name} cannot be blank.`)
  }
  finite(context.wcsOriginMachineMm, 'WCS origin')
  validateScope(intent)

  const registered = operationHeightPolicy(context.operationType)
  if (!registered || registered.support !== 'live') {
    fail('unsupported_operation', `${context.operationType} is not a live Smart Height operation.`)
  }
  const variant = (registered.variants as Record<string, OperationHeightVariantPolicy>)[intent.policy.variant]
  if (!variant) {
    fail('policy_mismatch', `Variant '${intent.policy.variant}' is not registered for '${context.operationType}'.`)
  }
  if (variant.activation.status !== 'live' && variant.activation.status !== 'provisional') {
    fail(
      'inactive_variant',
      `${context.operationType} Smart Height variant '${intent.policy.variant}' is ` +
      `${variant.activation.status}: ${variant.activation.reason}`,
    )
  }

  const index = new EvidenceIndex(context)
  for (const kind of variant.requiredEvidence) index.requireKind(kind)

  const planeOverrides = intent.planeOverrides
  const startOwner = planeOverrides?.top?.owner ?? intent.machining.start.owner
  const endOwner = planeOverrides?.bottom?.owner ?? intent.machining.end.owner
  const start = planeOverrides?.top
    ? resolveAuthoredPlane(
        planeOverrides.top,
        plane => fail('invalid_intent', `Top Height cannot reference unresolved '${plane}'.`),
        context,
        index,
      )
    : resolveMaterialStart(intent.machining.start.value, variant, context, index)
  const policyEnd = () => resolveEndValue(
    intent.machining.end.value,
    variant,
    start,
    intent.machining.end.owner,
    context,
    index,
    intent.machining.scope.value.kind === 'selected_features'
      ? intent.machining.scope.value.features
      : undefined,
    intent.featureOverrides,
  )
  const end = planeOverrides?.bottom
    ? operatorEnd(planeOverrides.bottom, policyEnd, start, endOwner, context, index)
    : policyEnd()
  const featureFloor = end.featureEndpoints?.length
    ? Math.min(...end.featureEndpoints.map(item => item.cutterCenterEnd.wcsMm))
    : undefined
  const cutterEnd: ResolvedNumber = end.cutterCenterEnd ?? (featureFloor === undefined ? undefined : {
    wcsMm: featureFloor,
    machineMm: featureFloor + context.wcsOriginMachineMm,
    proofNodeIds: end.featureEndpoints!.flatMap(item => item.cutterCenterEnd.proofNodeIds),
  }) ?? fail('invalid_evidence', 'Smart Height resolved no cutter-center endpoint.')

  const resolvedPlanes = new Map<HeightPlaneName, ResolvedNumber>([
    ['top', start],
    ['bottom', cutterEnd],
  ])
  const resolvingPlanes = new Set<HeightPlaneName>()
  const authoredSafety = new Map<HeightPlaneName, AuthoredPlaneIntentV2>([
    ['clearance', intent.safety.clearance],
    ['retract', intent.safety.retract],
    ['feed', intent.safety.feed],
  ])
  const resolvePlane = (plane: HeightPlaneName): ResolvedNumber => {
    const existing = resolvedPlanes.get(plane)
    if (existing) return existing
    if (resolvingPlanes.has(plane)) fail('height_reference_cycle', `Height reference cycle includes '${plane}'.`)
    const authored = authoredSafety.get(plane)
      ?? fail('invalid_intent', `No authored '${plane}' safety plane exists.`)
    resolvingPlanes.add(plane)
    const value = resolveAuthoredPlane(authored, resolvePlane, context, index)
    resolvingPlanes.delete(plane)
    resolvedPlanes.set(plane, value)
    return value
  }

  let clearance = resolvePlane('clearance')
  const unliftedRetract = resolvePlane('retract')
  const unliftedFeed = resolvePlane('feed')
  const clearanceMinimum = index.optionalUniqueRole('safety_clearance_min')
  if (clearanceMinimum) {
    const minimum = scalarToResolved(clearanceMinimum, context, index)
    if (minimum.wcsMm > clearance.wcsMm) {
      clearance = { ...minimum, proofNodeIds: [...clearance.proofNodeIds, ...minimum.proofNodeIds] }
    }
  }

  // WO-1621: a safety plane the operator did not set is lifted as far as the
  // ordering needs (Feed to Material Start, Retract to Feed, Clearance to
  // Retract). Only planes the operator set can contradict each other.
  const lift = (
    plane: ResolvedNumber,
    owner: SmartHeightIntentOwner,
    floor: ResolvedNumber,
  ): ResolvedNumber => owner.kind === 'user_override' || plane.wcsMm >= floor.wcsMm
    ? plane
    : { ...floor, proofNodeIds: unique([...plane.proofNodeIds, ...floor.proofNodeIds]) }
  const feed = lift(unliftedFeed, intent.safety.feed.owner, start)
  const retract = lift(unliftedRetract, intent.safety.retract.owner, feed)
  clearance = lift(clearance, intent.safety.clearance.owner, retract)

  const order: Array<[string, ResolvedNumber]> = [
    ['Clearance', clearance], ['Retract', retract], ['Feed', feed], ['Material Start', start],
  ]
  for (let i = 0; i + 1 < order.length; i++) {
    const [upperName, upper] = order[i]
    const [lowerName, lower] = order[i + 1]
    if (upper.wcsMm < lower.wcsMm) {
      fail(
        'invalid_plane_order',
        `${upperName} (${upper.wcsMm}) is below ${lowerName} (${lower.wcsMm}); ` +
        'safety planes must satisfy Clearance >= Retract >= Feed >= Material Start.',
      )
    }
  }
  if (start.wcsMm < cutterEnd.wcsMm ||
      (start.wcsMm === cutterEnd.wcsMm && end.targetArtifactNode === undefined)) {
    fail(
      'invalid_plane_order',
      `Material Start (${start.wcsMm}) must be above the cutter-center Target End (${cutterEnd.wcsMm}).`,
    )
  }

  const materialStartKinds = start.proofNodeIds
    .map(id => index.byId.get(id)?.kind)
    .filter((kind): kind is SmartHeightEvidenceKind => kind !== undefined)
  const materialKind = materialStartKinds.includes('remaining_material')
    ? 'remaining_material'
    : materialStartKinds.includes('initial_stock')
      ? 'initial_stock'
      : materialStartKinds.includes('owning_stock')
        ? 'owning_stock'
        : undefined
  const materialArtifactNode = materialKind
    ? index.optionalUniqueRole('material_artifact', materialKind)
    : undefined
  const usedGraph = index.usedGraph()
  const warnings = index.nodesOfKind('fixture_envelope').length === 0
    ? ['Fixture/clamp clearance is unverified.']
    : []

  return {
    version: SMART_HEIGHT_INTENT_VERSION,
    policyVersion: SMART_HEIGHT_POLICY_VERSION,
    policy: intent.policy,
    revision: { ...context.revision },
    safety: {
      clearance: component(clearance, intent.safety.clearance.owner),
      retract: component(retract, intent.safety.retract.owner),
      feed: component(feed, intent.safety.feed.owner),
    },
    machining: {
      materialStart: component(start, startOwner),
      ...(end.physicalTarget ? { physicalTarget: component(end.physicalTarget, endOwner) } : {}),
      ...(end.cutterCenterEnd ? { cutterCenterEnd: component(end.cutterCenterEnd, endOwner) } : {}),
      ...(end.targetArtifactNode?.spatial ? { targetArtifact: end.targetArtifactNode.spatial } : {}),
      ...(materialArtifactNode?.spatial ? { materialArtifact: materialArtifactNode.spatial } : {}),
      ...(end.featureEndpoints ? { featureEndpoints: end.featureEndpoints } : {}),
    },
    evidenceGraph: usedGraph,
    dependencyFingerprints: unique(usedGraph.map(node => node.dependencyFingerprint)).sort(),
    warnings,
  }
}

export function resolveSmartHeightPlan(
  intent: OperationHeightIntentV2,
  context: HeightEvidenceContext,
): ResolveSmartHeightPlanResult {
  try {
    return { ok: true, plan: resolveSmartHeightPlanOrThrow(intent, context) }
  } catch (error) {
    if (error instanceof ResolutionFailure) return { ok: false, refusal: error.refusal }
    throw error
  }
}
