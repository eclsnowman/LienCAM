import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { resolveAdaptive3dFloorZ } from '../../cam3d/integration/adaptive3dOperation'
import {
  buildAdaptive3dEvidenceContext,
  buildAdaptive3dSmartIntent,
  adaptive3dHeightDraftFromIntent,
  adaptive3dTargetMachineBounds,
  resolveAdaptive3dSmartHeights,
  resolveSmartHeightPlan,
  type Adaptive3dEvidenceInput,
  type Adaptive3dMaterialMode,
} from '../../lib/cam/smartHeights'

const bounds = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) =>
  ({ minX, minY, minZ, maxX, maxY, maxZ })

function fixture(options: {
  mode?: Adaptive3dMaterialMode
  stock?: ReturnType<typeof bounds>
  target?: ReturnType<typeof bounds>
  wcs?: number
  axial?: number
  stockCount?: number
  remaining?: Adaptive3dEvidenceInput['remainingMaterial']
  boundedBand?: { topWcsMm: number; bottomWcsMm: number }
} = {}) {
  const wcs = options.wcs ?? 0
  const stock = options.stock ?? bounds(0, 0, 0, 100, 80, 20)
  const target = options.target ?? bounds(10, 10, 2, 90, 70, 15)
  const intent = buildAdaptive3dSmartIntent({
    setupId: 'setup-1',
    geometryIds: ['part-1'],
    safetyIntent: defaultHeightIntent(),
    mode: options.mode,
    boundedBand: options.boundedBand,
  })
  const context = buildAdaptive3dEvidenceContext({
    revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
    wcsOriginMachineMm: wcs,
    operationId: 'op-1',
    geometryIds: ['part-1'],
    owningStocks: Array.from({ length: options.stockCount ?? 1 }, (_, index) => ({
      stockId: `stock-${index + 1}`,
      artifactId: `stock-artifact-${index + 1}`,
      boundsMachineMm: stock,
      fingerprint: `stock-fp-${index + 1}`,
      representation: 'axis-aligned-stock-box',
    })),
    target: {
      geometryId: 'part-1', artifactId: 'part-zmax', boundsMachineMm: target,
      fingerprint: 'part-fp', representation: 'top-down-zmax-field',
    },
    tool: { toolId: 'tool-1', fingerprint: 'tool-fp' },
    axialStockToLeaveMm: options.axial ?? 0,
    remainingMaterial: options.remaining,
  })
  return resolveSmartHeightPlan(intent, context)
}

describe('Smart Height Phase 3 Adaptive 3D policy fixtures', () => {
  it('round-trips each operator material policy without consulting legacy scalar heights', () => {
    for (const mode of ['current_material', 'initial_stock', 'rest'] as const) {
      const intent = buildAdaptive3dSmartIntent({
        setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(), mode,
      })
      expect(adaptive3dHeightDraftFromIntent(intent)).toEqual({
        mode, topWcsMm: 0, bottomWcsMm: 0,
      })
    }
    const bounded = buildAdaptive3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
      mode: 'bounded_band', boundedBand: { topWcsMm: 12.5, bottomWcsMm: -3 },
    })
    expect(adaptive3dHeightDraftFromIntent(bounded)).toEqual({
      mode: 'bounded_band', topWcsMm: 12.5, bottomWcsMm: -3,
    })
    expect(() => buildAdaptive3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
      mode: 'bounded_band', boundedBand: { topWcsMm: -3, bottomWcsMm: 12.5 },
    })).toThrow(/Top must be greater than or equal to Bottom/)
  })

  it('defaults current material to owning stock and the clipped target-surface field', () => {
    const result = fixture()
    expect(result).toMatchObject({ ok: true, plan: { policy: { variant: 'current_material' } } })
    if (!result.ok) return
    expect(result.plan.machining.materialStart.wcsMm).toBe(20)
    expect(result.plan.machining.physicalTarget?.wcsMm).toBe(2)
    expect(result.plan.machining.cutterCenterEnd?.wcsMm).toBe(2)
    expect(result.plan.machining.targetArtifact?.boundsMm).toEqual(bounds(10, 10, 2, 90, 70, 15))
  })

  it('handles a target flush with stock Top without inventing a depth', () => {
    const result = fixture({ target: bounds(10, 10, 4, 90, 70, 20) })
    expect(result.ok && result.plan.machining.materialStart.wcsMm).toBe(20)
    expect(result.ok && result.plan.machining.physicalTarget?.wcsMm).toBe(4)
  })

  it('clips a target below and partly outside stock instead of cutting below material', () => {
    const result = fixture({ target: bounds(-10, 10, -8, 70, 90, 12) })
    expect(result.ok && result.plan.machining.physicalTarget?.wcsMm).toBe(0)
    expect(result.ok && result.plan.machining.targetArtifact?.boundsMm)
      .toEqual(bounds(0, 10, 0, 70, 80, 12))
  })

  it('resolves translated WCS and translated geometry in both frames', () => {
    const result = fixture({
      wcs: 100,
      stock: bounds(25, 30, 100, 125, 110, 120),
      target: bounds(35, 40, 102, 115, 100, 115),
    })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.materialStart).toMatchObject({ wcsMm: 20, machineMm: 120 })
    expect(result.plan.machining.physicalTarget).toMatchObject({ wcsMm: 2, machineMm: 102 })
  })

  it('refuses ambiguous stock ownership', () => {
    const result = fixture({ stockCount: 2 })
    expect(result).toMatchObject({ ok: false, refusal: { code: 'ambiguous_evidence' } })
  })

  it('keeps an explicit 5 mm bounded band authoritative', () => {
    const result = fixture({
      mode: 'bounded_band', boundedBand: { topWcsMm: 18, bottomWcsMm: 13 },
    })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.materialStart.wcsMm).toBe(18)
    expect(result.plan.machining.cutterCenterEnd?.wcsMm).toBe(13)
  })

  it('applies axial stock to leave exactly once after physical target resolution', () => {
    const result = fixture({ axial: 0.75 })
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.plan.machining.physicalTarget?.wcsMm).toBe(2)
    expect(result.plan.machining.cutterCenterEnd?.wcsMm).toBe(2.75)
  })

  it('uses compatible remaining material for current-material planning', () => {
    const result = fixture({ remaining: {
      compatible: true, materialTopMachineMm: 12, artifactId: 'rest-1',
      boundsMachineMm: bounds(0, 0, 0, 100, 80, 12), fingerprint: 'rest-fp',
      representation: 'retained-zdexel-field',
    } })
    expect(result.ok && result.plan.machining.materialStart.wcsMm).toBe(12)
    expect(result.ok && result.plan.machining.materialArtifact?.artifactId).toBe('rest-1')
  })

  it('keeps initial-stock policy on the original block when retained material exists', () => {
    const result = fixture({
      mode: 'initial_stock',
      remaining: {
        compatible: true, materialTopMachineMm: 12, artifactId: 'rest-1',
        boundsMachineMm: bounds(0, 0, 0, 100, 80, 12), fingerprint: 'rest-fp',
        representation: 'retained-zdexel-field',
      },
    })
    expect(result.ok && result.plan.machining.materialStart.wcsMm).toBe(20)
    expect(result.ok && result.plan.machining.materialArtifact?.artifactId)
      .toBe('stock-artifact-1')
  })

  it('falls back for current material but refuses explicit rest when retained evidence is stale', () => {
    const remaining = {
      compatible: false, materialTopMachineMm: 12, artifactId: 'stale-rest',
      boundsMachineMm: bounds(0, 0, 0, 100, 80, 12), fingerprint: 'stale-fp',
      representation: 'retained-zdexel-field',
    }
    const current = fixture({ remaining })
    expect(current.ok && current.plan.machining.materialStart.wcsMm).toBe(20)
    const rest = fixture({ mode: 'rest', remaining })
    expect(rest).toMatchObject({
      ok: false, refusal: { code: 'missing_evidence', evidenceKind: 'remaining_material' },
    })
  })

  it('refuses a target with no physical overlap with its proven stock', () => {
    expect(() => fixture({ target: bounds(200, 200, 30, 220, 220, 40) }))
      .toThrow(/does not intersect its owning stock/)
  })

  it('transforms a spun local mesh AABB into exact machine-space evidence bounds', () => {
    const transformed = adaptive3dTargetMachineBounds({
      meshBounds: { min: [0, 0, 2], max: [10, 20, 12] },
      position: { x: 100, y: 50, z: 7 },
      rotationZDeg: 90,
    })
    expect(transformed.minX).toBeCloseTo(80)
    expect(transformed.maxX).toBeCloseTo(100)
    expect(transformed.minY).toBeCloseTo(50)
    expect(transformed.maxY).toBeCloseTo(60)
    expect(transformed.minZ).toBe(9)
    expect(transformed.maxZ).toBe(19)
  })

  it('adapts one V2 plan into local dispatch heights with authored Feed Height and one allowance', () => {
    const intent = buildAdaptive3dSmartIntent({
      setupId: 'setup-1', geometryIds: ['part-1'], safetyIntent: defaultHeightIntent(),
    })
    const evidence = buildAdaptive3dEvidenceContext({
      revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
      wcsOriginMachineMm: 100,
      operationId: 'op-1', geometryIds: ['part-1'],
      owningStocks: [{
        stockId: 'stock-1', artifactId: 'stock-artifact',
        boundsMachineMm: bounds(20, 30, 100, 120, 110, 120),
        fingerprint: 'stock-fp', representation: 'axis-aligned-stock-box',
      }],
      target: {
        geometryId: 'part-1', artifactId: 'part-zmax',
        boundsMachineMm: bounds(30, 40, 102, 110, 100, 115),
        fingerprint: 'part-fp', representation: 'top-down-zmax-field',
      },
      tool: { toolId: 'tool-1', fingerprint: 'tool-fp' },
      axialStockToLeaveMm: 0.75,
    })
    const resolved = resolveAdaptive3dSmartHeights({
      intent, evidence, geometryIds: ['part-1'], geometryPositionZ: 90,
    })
    expect(resolved.localHeights).toMatchObject({
      topZ: 30,
      feedZ: 35,
      retractZ: 35,
      clearanceZ: 45,
      bottomZ: 12.75,
      stockTopZ: 30,
    })
    expect(resolved.plan.machining.physicalTarget?.machineMm).toBe(102)
    expect(resolved.plan.machining.cutterCenterEnd?.machineMm).toBe(102.75)
    expect(resolved.snapshotIntent.bottom).toMatchObject({
      reference: 'wcs_plane', offset: 2.75, provenance: 'inferred',
    })
    expect(resolveAdaptive3dFloorZ({
      resolvedHeights: resolved.localHeights,
    })).toBe(12.75)
    expect(resolveAdaptive3dFloorZ({
      resolvedHeights: { ...resolved.localHeights, bottomZ: 12 },
    })).toBe(12)
  })
})
