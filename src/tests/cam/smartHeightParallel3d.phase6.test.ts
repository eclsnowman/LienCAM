import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  bindUnprovenStockTopSafety,
  buildParallel3dEvidenceContext,
  buildParallel3dSmartIntent,
  parallel3dHeightDraftFromIntent,
  resolveParallel3dSmartHeights,
  resolveSmartHeightPlan,
} from '../../lib/cam/smartHeights'

const bounds = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) =>
  ({ minX, minY, minZ, maxX, maxY, maxZ })

function fixture(finishDepthMm?: number, target = bounds(10, 20, 102, 90, 80, 115)) {
  const intent = buildParallel3dSmartIntent({
    setupId: 'setup-1',
    geometryIds: ['part-1'],
    safetyIntent: defaultHeightIntent(),
    finishDepthMm,
  })
  const evidence = buildParallel3dEvidenceContext({
    revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
    wcsOriginMachineMm: 100,
    operationId: 'op-1',
    geometryIds: ['part-1'],
    target: {
      geometryId: 'part-1', artifactId: 'mesh:part-1', boundsMachineMm: target,
      fingerprint: 'part-fp', representation: 'parallel-target-surface-field',
    },
  })
  return { intent, evidence }
}

describe('Smart Height Phase 6 Parallel 3D policy fixtures', () => {
  it('authors full-surface and bounded finishing as explicit target-field policies', () => {
    const full = buildParallel3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
    })
    expect(parallel3dHeightDraftFromIntent(full)).toEqual({ mode: 'target_surface' })
    expect(full.machining.end.value).toEqual({ kind: 'target_surface' })

    const bounded = buildParallel3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
      finishDepthMm: 5,
    })
    expect(parallel3dHeightDraftFromIntent(bounded)).toEqual({
      mode: 'bounded_surface', finishDepthMm: 5,
    })
    expect(bounded.machining.end.value).toMatchObject({
      kind: 'target_surface',
      lowerLimit: { reference: 'top', offsetMm: -5, owner: { kind: 'user_override' } },
    })
    expect(() => buildParallel3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
      finishDepthMm: 0,
    })).toThrow(/greater than zero/)
  })

  it('resolves the full target mesh envelope in WCS and machine frames', () => {
    const { intent, evidence } = fixture()
    const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(intent, evidence), evidence)
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.materialStart).toMatchObject({ wcsMm: 15, machineMm: 115 })
    expect(result.plan.machining.physicalTarget).toMatchObject({ wcsMm: 2, machineMm: 102 })
    expect(result.plan.machining.cutterCenterEnd).toMatchObject({ wcsMm: 2, machineMm: 102 })
    expect(result.plan.machining.targetArtifact?.artifactId).toBe('mesh:part-1')
  })

  it('keeps the physical surface field while clamping cutter travel to a bounded depth', () => {
    const { intent, evidence } = fixture(5)
    const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(intent, evidence), evidence)
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.physicalTarget?.machineMm).toBe(102)
    expect(result.plan.machining.cutterCenterEnd?.machineMm).toBe(110)
    expect(result.plan.machining.targetArtifact?.boundsMm.minZ).toBe(102)
  })

  it('normalizes a limit deeper than the model to the actual surface envelope', () => {
    const { intent, evidence } = fixture(20)
    const resolved = resolveParallel3dSmartHeights({
      intent, evidence, geometryIds: ['part-1'], geometryPositionZ: 90,
    })
    expect(resolved.localHeights).toMatchObject({ topZ: 25, bottomZ: 12 })
    expect(resolved.finishDepthMm).toBe(13)
  })

  it('adapts one plan to local worker heights and an exact scalar snapshot', () => {
    const { intent, evidence } = fixture(5)
    const resolved = resolveParallel3dSmartHeights({
      intent, evidence, geometryIds: ['part-1'], geometryPositionZ: 90,
      stockTopMachineMm: 120,
    })
    expect(resolved.localHeights).toMatchObject({
      topZ: 25, feedZ: 30, bottomZ: 20, stockTopZ: 30,
    })
    expect(resolved.snapshotIntent.top).toMatchObject({
      reference: 'wcs_plane', offset: 15, provenance: 'inferred',
    })
    expect(resolved.snapshotIntent.bottom.offset).toBe(10)
    expect(resolved.finishDepthMm).toBe(5)
  })

  it('allows a zero-thickness planar surface field without inventing depth', () => {
    const { intent, evidence } = fixture(undefined, bounds(0, 0, 110, 20, 20, 110))
    const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(intent, evidence), evidence)
    expect(result.ok && result.plan.machining.materialStart.machineMm).toBe(110)
    expect(result.ok && result.plan.machining.cutterCenterEnd?.machineMm).toBe(110)
  })

  it('refuses stale scope identity and target evidence that does not match it', () => {
    const { intent, evidence } = fixture()
    expect(() => resolveParallel3dSmartHeights({
      intent, evidence, geometryIds: ['part-2'], geometryPositionZ: 0,
    })).toThrow(/scope no longer matches/)
    expect(() => buildParallel3dEvidenceContext({
      revision: { projectRevision: 'p', setupRevision: 's', operationRevision: 'o' },
      wcsOriginMachineMm: 0, operationId: 'op', geometryIds: ['part-2'],
      target: {
        geometryId: 'part-1', artifactId: 'mesh', boundsMachineMm: bounds(0, 0, 0, 1, 1, 1),
        fingerprint: 'fp', representation: 'field',
      },
    })).toThrow(/must match/)
  })
})
