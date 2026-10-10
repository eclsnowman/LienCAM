import { describe, expect, it } from 'vitest'
import type { OperationType } from '../../types'
import type {
  HeightEvidenceContext,
  OperationHeightIntentV2,
  SmartHeightEvidenceKind,
  SmartHeightEvidenceNode,
  SmartHeightEvidenceRole,
  SmartHeightIntentOwner,
  StableFeatureReference,
} from '../../lib/cam/smartHeights'
import {
  SMART_HEIGHT_INTENT_VERSION,
  SMART_HEIGHT_POLICY_VERSION,
  resolveSmartHeightPlan,
  validatePersistedSmartHeightState,
} from '../../lib/cam/smartHeights'

const setupOwner: SmartHeightIntentOwner = { kind: 'setup', setupId: 'setup-1' }
const policyOwner: SmartHeightIntentOwner = { kind: 'operation_policy' }
const userOwner: SmartHeightIntentOwner = { kind: 'user_override' }

const safety = (): OperationHeightIntentV2['safety'] => ({
  clearance: { reference: 'retract', offsetMm: 10, owner: setupOwner },
  retract: { reference: 'stock_top', offsetMm: 5, owner: setupOwner },
  feed: { reference: 'top', offsetMm: 2, owner: setupOwner },
})

const node = (
  id: string,
  kind: SmartHeightEvidenceKind,
  role: SmartHeightEvidenceRole,
  valueMm?: number,
): SmartHeightEvidenceNode => ({
  id,
  kind,
  role,
  entityId: `${kind}:${id}`,
  dependencyNodeIds: [],
  dependencyFingerprint: `fp:${id}`,
  ...(valueMm === undefined ? {} : { scalar: { frame: 'wcs', valueMm } as const }),
})

const context = (
  operationType: HeightEvidenceContext['operationType'],
  evidence: SmartHeightEvidenceNode[],
  operationRevision = 'op-r1',
): HeightEvidenceContext => ({
  revision: { projectRevision: 'project-r1', setupRevision: 'setup-r1', operationRevision },
  operationType,
  wcsOriginMachineMm: 100,
  evidence,
})

const faceIntent = (endOwner: SmartHeightIntentOwner = policyOwner): OperationHeightIntentV2 => ({
  version: SMART_HEIGHT_INTENT_VERSION,
  policyVersion: SMART_HEIGHT_POLICY_VERSION,
  policy: { operationType: 'face', variant: 'target_face' },
  safety: safety(),
  machining: {
    start: { value: { kind: 'policy_default' }, owner: policyOwner },
    end: { value: { kind: 'policy_default' }, owner: endOwner },
    scope: {
      value: { kind: 'selected_geometry', geometryIds: ['part-1'] },
      owner: policyOwner,
    },
  },
})

const faceEvidence = (targetZ = -2): SmartHeightEvidenceNode[] => [
  node('stock-top', 'owning_stock', 'stock_top', 0),
  node('target-model', 'target_model', 'target_top', 0),
  node('target-face', 'selected_plane', 'selected_plane', targetZ),
  node('scope', 'operation_scope', 'scope'),
]

const feature = (stableId: string): StableFeatureReference => ({
  modelItemId: 'model-1',
  bodyId: 'body-1',
  featureKind: 'hole',
  stableId,
  sourceVersion: 1,
  sourceFingerprint: `feature-fp:${stableId}`,
})

describe('Smart Height V2 pure resolver', () => {
  it('rejects a persisted V2 operation that omits mandatory Feed Height', () => {
    const intent = faceIntent()
    delete (intent.safety as Partial<OperationHeightIntentV2['safety']>).feed
    expect(validatePersistedSmartHeightState({ kind: 'smart_v2', intent }))
      .toMatchObject({ ok: false, code: 'invalid_envelope' })
  })

  it('resolves one revision-stamped face plan with independent owner and proof provenance', () => {
    const result = resolveSmartHeightPlan(faceIntent(userOwner), context('face', faceEvidence()))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.plan.machining.materialStart).toMatchObject({ wcsMm: 0, machineMm: 100, owner: policyOwner })
    expect(result.plan.machining.physicalTarget).toMatchObject({ wcsMm: -2, machineMm: 98, owner: userOwner })
    expect(result.plan.machining.cutterCenterEnd).toMatchObject({ wcsMm: -2, machineMm: 98, owner: userOwner })
    expect(result.plan.machining.physicalTarget?.proofNodeIds).toEqual(['target-face'])
    expect(result.plan.safety).toMatchObject({
      feed: { wcsMm: 2 },
      retract: { wcsMm: 5 },
      clearance: { wcsMm: 15 },
    })
    expect(result.plan.revision.operationRevision).toBe('op-r1')
    expect(result.plan.warnings).toContain('Fixture/clamp clearance is unverified.')
  })

  it("WO-183 (Operator: 'they stack'): editing retract moves clearance by the same delta - derived, never stored", () => {
    const base = resolveSmartHeightPlan(faceIntent(), context('face', faceEvidence(-2), 'r1'))
    const raised: OperationHeightIntentV2 = {
      ...faceIntent(),
      safety: { ...safety(), retract: { reference: 'stock_top', offsetMm: 12, owner: setupOwner } },
    }
    const after = resolveSmartHeightPlan(raised, context('face', faceEvidence(-2), 'r2'))
    expect(base.ok && after.ok).toBe(true)
    if (!base.ok || !after.ok) return
    expect(after.plan.safety.retract.wcsMm - base.plan.safety.retract.wcsMm).toBe(7)
    expect(after.plan.safety.clearance.wcsMm - base.plan.safety.clearance.wcsMm).toBe(7)
    // Never an inversion: clearance stays above retract, retract above feed.
    expect(after.plan.safety.clearance.wcsMm).toBeGreaterThan(after.plan.safety.retract.wcsMm)
    expect(after.plan.safety.retract.wcsMm).toBeGreaterThan(after.plan.safety.feed.wcsMm)
  })

  it('re-resolves from new evidence instead of caching a preview result', () => {
    const preview = resolveSmartHeightPlan(faceIntent(), context('face', faceEvidence(-2), 'preview-r1'))
    const dispatch = resolveSmartHeightPlan(faceIntent(), context('face', faceEvidence(-3), 'dispatch-r2'))
    expect(preview.ok && preview.plan.machining.cutterCenterEnd?.wcsMm).toBe(-2)
    expect(dispatch.ok && dispatch.plan.machining.cutterCenterEnd?.wcsMm).toBe(-3)
    expect(dispatch.ok && dispatch.plan.revision.operationRevision).toBe('dispatch-r2')
  })

  it('converts geometry-local evidence through its declared frame origin', () => {
    const evidence = faceEvidence()
    evidence[2] = {
      ...evidence[2],
      scalar: { frame: 'geometry_local', valueMm: -2, frameOriginMachineMm: 120 },
    }
    evidence[0] = { ...evidence[0], scalar: { frame: 'wcs', valueMm: 20 } }
    const result = resolveSmartHeightPlan(faceIntent(), context('face', evidence))
    expect(result.ok && result.plan.machining.materialStart.wcsMm).toBe(20)
    expect(result.ok && result.plan.machining.physicalTarget?.wcsMm).toBe(18)
  })

  it('raises Clearance inside the resolver when proven safety minimum evidence requires it', () => {
    const evidence = [
      ...faceEvidence(),
      node('fixture-clearance', 'fixture_envelope', 'safety_clearance_min', 22),
    ]
    const result = resolveSmartHeightPlan(faceIntent(), context('face', evidence))
    expect(result.ok && result.plan.safety.clearance.wcsMm).toBe(22)
    expect(result.ok && result.plan.safety.clearance.proofNodeIds).toContain('fixture-clearance')
    expect(result.ok && result.plan.warnings).toEqual([])
  })

  it('names missing and ambiguous evidence rather than guessing', () => {
    const missing = resolveSmartHeightPlan(faceIntent(), context('face', faceEvidence().filter(item => item.kind !== 'selected_plane')))
    expect(missing).toMatchObject({ ok: false, refusal: { code: 'missing_evidence', evidenceKind: 'selected_plane' } })

    const ambiguous = resolveSmartHeightPlan(faceIntent(), context('face', [
      ...faceEvidence(),
      node('stock-top-2', 'owning_stock', 'stock_top', 1),
    ]))
    expect(ambiguous).toMatchObject({ ok: false, refusal: { code: 'ambiguous_evidence', evidenceRole: 'stock_top' } })
  })

  it('refuses evidence dependency cycles', () => {
    const evidence = faceEvidence()
    evidence[0] = { ...evidence[0], dependencyNodeIds: ['target-model'] }
    evidence[1] = { ...evidence[1], dependencyNodeIds: ['stock-top'] }
    const result = resolveSmartHeightPlan(faceIntent(), context('face', evidence))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'evidence_cycle' } })
  })

  it('refuses safety-plane cycles and invalid final ordering', () => {
    const cyclic = faceIntent()
    cyclic.safety.clearance = { reference: 'retract', offsetMm: 1, owner: setupOwner }
    cyclic.safety.retract = { reference: 'clearance', offsetMm: 1, owner: setupOwner }
    expect(resolveSmartHeightPlan(cyclic, context('face', faceEvidence())))
      .toMatchObject({ ok: false, refusal: { code: 'height_reference_cycle' } })

    // WO-1621: a setup-owned Feed below Top is lifted, not refused.
    const lifted = faceIntent()
    lifted.safety.feed = { reference: 'top', offsetMm: -1, owner: setupOwner }
    const liftedResult = resolveSmartHeightPlan(lifted, context('face', faceEvidence()))
    expect(liftedResult.ok).toBe(true)
    if (liftedResult.ok) {
      expect(liftedResult.plan.safety.feed.wcsMm).toBe(liftedResult.plan.machining.materialStart.wcsMm)
      expect(liftedResult.plan.safety.retract.wcsMm).toBeGreaterThanOrEqual(liftedResult.plan.safety.feed.wcsMm)
    }

    const inverted = faceIntent()
    inverted.safety.feed = { reference: 'top', offsetMm: -1, owner: userOwner }
    expect(resolveSmartHeightPlan(inverted, context('face', faceEvidence())))
      .toMatchObject({ ok: false, refusal: { code: 'invalid_plane_order' } })

    // Two planes the operator set himself that contradict each other still refuse, naming both.
    const contradiction = faceIntent()
    contradiction.safety.retract = { reference: 'top', offsetMm: 1, owner: userOwner }
    contradiction.safety.feed = { reference: 'top', offsetMm: 3, owner: userOwner }
    expect(resolveSmartHeightPlan(contradiction, context('face', faceEvidence()))).toMatchObject({
      ok: false, refusal: { code: 'invalid_plane_order', message: expect.stringMatching(/Retract .* below Feed/) },
    })
  })

  it('requires an explicit end condition when a flat contour contains no physical Z intent', () => {
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'contour_2d', variant: 'explicit_depth' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_geometry', geometryIds: ['dxf-1'] }, owner: userOwner },
      },
    }
    const result = resolveSmartHeightPlan(intent, context('contour_2d', [
      node('scope', 'operation_scope', 'scope'),
    ]))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'confirmation_required' } })
  })

  it('keeps Adaptive target and material spatial artifacts while applying axial allowance once', () => {
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'adaptive_3d', variant: 'rest' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'whole_target', geometryIds: ['part-1'] }, owner: policyOwner },
      },
    }
    const spatial = (artifactId: string, minZ: number, maxZ: number) => ({
      artifactId, schemaVersion: 1, representation: 'z-dexel', frame: 'wcs' as const,
      boundsMm: { minX: 0, minY: 0, minZ, maxX: 20, maxY: 20, maxZ },
      fingerprint: `artifact-fp:${artifactId}`,
    })
    const evidence: SmartHeightEvidenceNode[] = [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      node('remaining-top', 'remaining_material', 'material_top', 0),
      { ...node('remaining-field', 'remaining_material', 'material_artifact'), spatial: spatial('remaining', -6, 0) },
      node('target-model', 'target_model', 'target_top', 0),
      {
        ...node('target-field', 'target_surface_field', 'target_artifact', -10),
        spatial: spatial('target', -10, 0),
      },
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
      node('axial-stock', 'strategy_allowance', 'cutter_end_allowance', 1),
    ]
    const result = resolveSmartHeightPlan(intent, context('adaptive_3d', evidence))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.machining.materialStart.wcsMm).toBe(0)
    expect(result.plan.machining.physicalTarget?.wcsMm).toBe(-10)
    expect(result.plan.machining.cutterCenterEnd?.wcsMm).toBe(-9)
    expect(result.plan.machining.materialArtifact?.artifactId).toBe('remaining')
    expect(result.plan.machining.targetArtifact?.artifactId).toBe('target')
    expect(result.plan.machining.cutterCenterEnd?.proofNodeIds).toEqual(['target-field', 'axial-stock'])
  })

  it('refuses explicit Adaptive rest when compatible remaining material is absent', () => {
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'adaptive_3d', variant: 'rest' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'whole_target', geometryIds: ['part-1'] }, owner: policyOwner },
      },
    }
    const result = resolveSmartHeightPlan(intent, context('adaptive_3d', [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      node('target-model', 'target_model', 'target_top', 0),
      node('target-field', 'target_surface_field', 'target_artifact', -10),
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
    ]))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'missing_evidence', evidenceKind: 'remaining_material' } })
  })

  it('preserves per-feature physical floors and applies global cutter allowance once', () => {
    const f1 = feature('hole-1')
    const f2 = feature('hole-2')
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'drill', variant: 'detected_features' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_features', features: [f1, f2] }, owner: policyOwner },
      },
    }
    const evidence: SmartHeightEvidenceNode[] = [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      { ...node('floor-1', 'detected_feature_floor', 'feature_floor', -5), feature: f1 },
      { ...node('floor-2', 'detected_feature_floor', 'feature_floor', -10), feature: f2 },
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
      node('breakthrough', 'strategy_allowance', 'cutter_end_allowance', -0.5),
    ]
    const result = resolveSmartHeightPlan(intent, context('drill', evidence))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.machining.physicalTarget).toBeUndefined()
    expect(result.plan.machining.cutterCenterEnd).toBeUndefined()
    expect(result.plan.machining.featureEndpoints?.map(endpoint => ({
      id: endpoint.feature.stableId,
      physical: endpoint.physicalTarget.wcsMm,
      cutter: endpoint.cutterCenterEnd.wcsMm,
    }))).toEqual([
      { id: 'hole-1', physical: -5, cutter: -5.5 },
      { id: 'hole-2', physical: -10, cutter: -10.5 },
    ])
  })

  it('applies a cutter-center override only to its exact stable feature', () => {
    const f1 = feature('hole-1')
    const f2 = feature('hole-2')
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'drill', variant: 'detected_features' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_features', features: [f1, f2] }, owner: policyOwner },
      },
      featureOverrides: [{
        feature: f2,
        cutterCenterEnd: { reference: 'wcs_plane', offsetMm: -8, owner: userOwner },
      }],
    }
    const result = resolveSmartHeightPlan(intent, context('drill', [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      { ...node('floor-1', 'detected_feature_floor', 'feature_floor', -5), feature: f1 },
      { ...node('floor-2', 'detected_feature_floor', 'feature_floor', -10), feature: f2 },
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
      node('point-compensation', 'strategy_allowance', 'cutter_end_allowance', -0.5),
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.machining.featureEndpoints?.map(endpoint => ({
      id: endpoint.feature.stableId,
      physical: endpoint.physicalTarget.wcsMm,
      cutter: endpoint.cutterCenterEnd.wcsMm,
      owner: endpoint.cutterCenterEnd.owner.kind,
    }))).toEqual([
      { id: 'hole-1', physical: -5, cutter: -5.5, owner: 'operation_policy' },
      { id: 'hole-2', physical: -10, cutter: -8, owner: 'user_override' },
    ])
  })

  it('refuses a per-feature override after the feature identity changes', () => {
    const original = feature('hole-1')
    const replacement = { ...original, sourceFingerprint: 'replacement-fingerprint' }
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'drill', variant: 'detected_features' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_features', features: [replacement] }, owner: policyOwner },
      },
      featureOverrides: [{
        feature: original,
        cutterCenterEnd: { reference: 'wcs_plane', offsetMm: -8, owner: userOwner },
      }],
    }
    const result = resolveSmartHeightPlan(intent, context('drill', [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      { ...node('replacement-floor', 'detected_feature_floor', 'feature_floor', -7), feature: replacement },
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
    ]))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'stale_dependency' } })
  })

  it('refuses missing scoped feature evidence instead of reassigning a floor by order', () => {
    const f1 = feature('hole-1')
    const f2 = feature('hole-2')
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'drill', variant: 'detected_features' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_features', features: [f1, f2] }, owner: policyOwner },
      },
    }
    const result = resolveSmartHeightPlan(intent, context('drill', [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      { ...node('floor-2', 'detected_feature_floor', 'feature_floor', -10), feature: f2 },
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
    ]))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'stale_dependency' } })
  })

  it('refuses duplicate stable feature floors instead of transferring an override by position', () => {
    const same = feature('hole-1')
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'drill', variant: 'detected_features' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_features', features: [same] }, owner: policyOwner },
      },
    }
    const result = resolveSmartHeightPlan(intent, context('drill', [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      { ...node('floor-1a', 'detected_feature_floor', 'feature_floor', -5), feature: same },
      { ...node('floor-1b', 'detected_feature_floor', 'feature_floor', -6), feature: same },
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
    ]))
    expect(result).toMatchObject({ ok: false, refusal: { code: 'ambiguous_evidence' } })
  })

  it('composes selected feature and tool formula evidence for Chamfer', () => {
    const selected = feature('edge-1')
    const intent: OperationHeightIntentV2 = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: 'chamfer', variant: 'edge_width_formula' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'geometry_tool_formula' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'selected_features', features: [selected] }, owner: policyOwner },
      },
    }
    const result = resolveSmartHeightPlan(intent, context('chamfer', [
      node('stock-top', 'owning_stock', 'stock_top', 0),
      { ...node('edge-scope', 'selected_feature', 'scope'), feature: selected },
      node('edge-plane', 'selected_plane', 'selected_plane', 0),
      node('formula-start', 'strategy_allowance', 'formula_material_start', 0),
      node('formula-end', 'strategy_allowance', 'formula_cutter_end', -1.2),
      node('scope', 'operation_scope', 'scope'),
      node('tool', 'tool_geometry', 'tool'),
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.machining.physicalTarget?.wcsMm).toBe(0)
    expect(result.plan.machining.cutterCenterEnd?.wcsMm).toBeCloseTo(-1.2, 9)
    expect(result.plan.evidenceGraph.map(item => item.id)).toEqual(expect.arrayContaining([
      'edge-scope', 'edge-plane', 'formula-start', 'formula-end', 'scope', 'tool',
    ]))
  })

  it('refuses unsupported operations and policy/context mismatches by name', () => {
    // The real union has no unwired member after WO-1196. Keep the corruption
    // guard on a synthetic type that can never accidentally become live.
    const neverWired = '__never_wired_3d' as OperationType
    const unsupported = {
      version: SMART_HEIGHT_INTENT_VERSION,
      policyVersion: SMART_HEIGHT_POLICY_VERSION,
      policy: { operationType: neverWired, variant: 'unsupported' },
      safety: safety(),
      machining: {
        start: { value: { kind: 'policy_default' }, owner: policyOwner },
        end: { value: { kind: 'policy_default' }, owner: policyOwner },
        scope: { value: { kind: 'whole_target', geometryIds: ['part-1'] }, owner: policyOwner },
      },
    } as unknown as OperationHeightIntentV2
    expect(resolveSmartHeightPlan(unsupported, context(neverWired, [])))
      .toMatchObject({ ok: false, refusal: { code: 'unsupported_operation' } })
    expect(resolveSmartHeightPlan(faceIntent(), context('pocket_2d', faceEvidence())))
      .toMatchObject({ ok: false, refusal: { code: 'policy_mismatch' } })
  })
})
