// WO-1176: the waterline_3d Smart Height V2 policy contract, mirroring the
// Parallel 3D phase-6 fixtures: full-surface and bounded variants, evidence
// resolution in WCS and machine frames, local worker heights, and the named
// refusals for stale scope and mismatched families.

import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  bindUnprovenStockTopSafety,
  buildParallel3dEvidenceContext,
  buildWaterline3dEvidenceContext,
  buildWaterline3dSmartIntent,
  operationHeightPolicy,
  resolveSmartHeightPlan,
  resolveWaterline3dSmartHeights,
  waterline3dHeightDraftFromIntent,
} from '../../lib/cam/smartHeights'

const bounds = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) =>
  ({ minX, minY, minZ, maxX, maxY, maxZ })

function fixture(finishDepthMm?: number, target = bounds(10, 20, 102, 90, 80, 115)) {
  const intent = buildWaterline3dSmartIntent({
    setupId: 'setup-1',
    geometryIds: ['part-1'],
    safetyIntent: defaultHeightIntent(),
    finishDepthMm,
  })
  const evidence = buildWaterline3dEvidenceContext({
    revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
    wcsOriginMachineMm: 100,
    operationId: 'op-1',
    geometryIds: ['part-1'],
    target: {
      geometryId: 'part-1', artifactId: 'mesh:part-1', boundsMachineMm: target,
      fingerprint: 'part-fp', representation: 'waterline-target-surface-field',
    },
  })
  return { intent, evidence }
}

describe('Smart Height V2 waterline_3d policy', () => {
  it('is live with the two target-field variants', () => {
    const policy = operationHeightPolicy('waterline_3d')
    expect(policy.support).toBe('live')
    expect(Object.keys(policy.variants).sort()).toEqual(['bounded_surface', 'target_surface'])
    expect(policy.variants.target_surface.endpointCardinality).toBe('spatial_field')
    expect(policy.variants.target_surface.requiredEvidence).toEqual(['target_model', 'target_surface_field', 'operation_scope'])
  })

  it('authors full-surface and bounded finishing as explicit target-field policies', () => {
    const full = buildWaterline3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
    })
    expect(full.policy).toEqual({ operationType: 'waterline_3d', variant: 'target_surface' })
    expect(waterline3dHeightDraftFromIntent(full)).toEqual({ mode: 'target_surface' })
    expect(full.machining.start.value).toEqual({ kind: 'target_model_top' })
    expect(full.machining.end.value).toEqual({ kind: 'target_surface' })
    expect(full.machining.scope.value).toEqual({ kind: 'whole_target', geometryIds: ['part-1'] })

    const bounded = buildWaterline3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(), finishDepthMm: 5,
    })
    expect(bounded.policy.variant).toBe('bounded_surface')
    expect(waterline3dHeightDraftFromIntent(bounded)).toEqual({ mode: 'bounded_surface', finishDepthMm: 5 })
    expect(bounded.machining.end.value).toMatchObject({
      kind: 'target_surface',
      lowerLimit: { reference: 'top', offsetMm: -5, owner: { kind: 'user_override' } },
    })
    expect(() => buildWaterline3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(), finishDepthMm: 0,
    })).toThrow(/greater than zero/)
    expect(() => buildWaterline3dSmartIntent({
      setupId: 'setup-1', geometryIds: [], safetyIntent: defaultHeightIntent(),
    })).toThrow(/requires target geometry/)
  })

  it('binds the untouched stock-top default to the target-model Top only when no stock is proven', () => {
    const { intent, evidence } = fixture()
    expect(intent.safety.retract.reference).toBe('stock_top')
    expect(intent.safety.clearance.reference).toBe('retract')
    expect(bindUnprovenStockTopSafety(intent, evidence).safety.retract.reference).toBe('top')
  })

  it('resolves the full target mesh envelope in WCS and machine frames', () => {
    const { intent, evidence } = fixture()
    const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(intent, evidence), evidence)
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.materialStart).toMatchObject({ wcsMm: 15, machineMm: 115 })
    expect(result.plan.machining.cutterCenterEnd).toMatchObject({ wcsMm: 2, machineMm: 102 })
    expect(result.plan.machining.targetArtifact?.artifactId).toBe('mesh:part-1')
  })

  it('clamps cutter travel to a bounded depth while keeping the physical field', () => {
    const { intent, evidence } = fixture(5)
    const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(intent, evidence), evidence)
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.physicalTarget?.machineMm).toBe(102)
    expect(result.plan.machining.cutterCenterEnd?.machineMm).toBe(110)
  })

  it('adapts one plan to local worker heights, an exact snapshot, and the finish depth', () => {
    const { intent, evidence } = fixture(5)
    const resolved = resolveWaterline3dSmartHeights({
      intent, evidence, geometryIds: ['part-1'], geometryPositionZ: 90, stockTopMachineMm: 120,
    })
    expect(resolved.localHeights).toMatchObject({ topZ: 25, feedZ: 30, bottomZ: 20, stockTopZ: 30 })
    expect(resolved.snapshotIntent.top).toMatchObject({ reference: 'wcs_plane', offset: 15, provenance: 'inferred' })
    expect(resolved.snapshotIntent.bottom.offset).toBe(10)
    expect(resolved.finishDepthMm).toBe(5)
    const full = resolveWaterline3dSmartHeights({
      intent: fixture().intent, evidence: fixture().evidence, geometryIds: ['part-1'], geometryPositionZ: 90,
    })
    expect(full.finishDepthMm).toBeUndefined()
    expect(full.localHeights.bottomZ).toBe(12)
  })

  it('normalizes a limit deeper than the model to the actual surface envelope', () => {
    const { intent, evidence } = fixture(20)
    const resolved = resolveWaterline3dSmartHeights({
      intent, evidence, geometryIds: ['part-1'], geometryPositionZ: 90,
    })
    expect(resolved.localHeights).toMatchObject({ topZ: 25, bottomZ: 12 })
    expect(resolved.finishDepthMm).toBe(13)
  })

  it('refuses stale scope and a parallel intent or evidence by name', () => {
    const { intent, evidence } = fixture()
    expect(() => resolveWaterline3dSmartHeights({
      intent, evidence, geometryIds: ['part-2'], geometryPositionZ: 0,
    })).toThrow(/policy_mismatch/)
    const parallelEvidence = buildParallel3dEvidenceContext({
      revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
      wcsOriginMachineMm: 100, operationId: 'op-1', geometryIds: ['part-1'],
      target: {
        geometryId: 'part-1', artifactId: 'mesh:part-1', boundsMachineMm: bounds(10, 20, 102, 90, 80, 115),
        fingerprint: 'part-fp', representation: 'parallel-target-surface-field',
      },
    })
    expect(() => resolveWaterline3dSmartHeights({
      intent, evidence: parallelEvidence, geometryIds: ['part-1'], geometryPositionZ: 0,
    })).toThrow(/non-Waterline intent or evidence/)
    expect(() => waterline3dHeightDraftFromIntent({
      ...intent, policy: { operationType: 'parallel_3d', variant: 'target_surface' },
    })).toThrow(/non-Waterline/)
  })

  it('refuses evidence whose geometry does not match the authored target', () => {
    expect(() => buildWaterline3dEvidenceContext({
      revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
      wcsOriginMachineMm: 0, operationId: 'op-1', geometryIds: ['part-1'],
      target: {
        geometryId: 'part-2', artifactId: 'mesh:part-2', boundsMachineMm: bounds(0, 0, 0, 1, 1, 1),
        fingerprint: 'fp', representation: 'x',
      },
    })).toThrow(/single authored target geometry/)
  })
})
