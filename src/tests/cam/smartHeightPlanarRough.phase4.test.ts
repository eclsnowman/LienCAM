import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  PLANAR_ROUGH_TARGET_REPRESENTATION,
  PlanarRoughSmartHeightError,
  buildPlanarRoughSmartHeightEvidenceContext,
  buildPlanarRoughSmartHeightIntent,
  resolvePlanarRoughSmartHeights,
  resolveSmartHeightPlan,
  type PlanarRoughOperationType,
  type PlanarRoughSmartHeightMode,
  type PlanarRoughTargetCompilationEvidence,
} from '../../lib/cam/smartHeights'

const bounds = (minZ: number, maxZ: number) => ({
  minX: 0, minY: 0, minZ, maxX: 100, maxY: 80, maxZ,
})

function fixture(options: {
  operationType?: PlanarRoughOperationType
  mode?: PlanarRoughSmartHeightMode
  wcsOriginMachineMm?: number
  stockCount?: number
  stockId?: string
  intentStockId?: string
  stockBounds?: ReturnType<typeof bounds>
  targetBounds?: ReturnType<typeof bounds>
  targetPlaneMachineMm?: number
  targetFloorMachineMm?: number
  targetRepresentation?: string
  includeTarget?: boolean
  includeCompilation?: boolean
  explicitTargetWcsMm?: number
  throughAllowanceMm?: number
  floorStockToLeaveMm?: number
  remainingTopMachineMm?: number
  geometryIds?: string[]
  keepOutLoopIds?: string[]
  keepOutMaterialTopMachineMm?: number
  keepOutTargetTopMachineMm?: number
} = {}) {
  const operationType = options.operationType ?? 'pocket_2d'
  const mode = options.mode ?? 'geometry_floor'
  const wcs = options.wcsOriginMachineMm ?? 0
  const stockId = options.stockId ?? 'stock-1'
  const geometryIds = options.geometryIds ?? ['part-1']
  const stockBounds = options.stockBounds ?? bounds(wcs, wcs + 20)
  const targetBounds = options.targetBounds ?? bounds(wcs + 2, wcs + 20)
  const intent = buildPlanarRoughSmartHeightIntent({
    setupId: 'setup-1',
    operationType,
    safetyIntent: defaultHeightIntent(operationType),
    mode,
    geometryIds: mode === 'stock_rough' ? undefined : geometryIds,
    stockId: mode === 'stock_rough' ? (options.intentStockId ?? stockId) : undefined,
    explicitTargetWcsMm: mode === 'explicit_depth'
      ? (options.explicitTargetWcsMm ?? 8)
      : undefined,
    throughAllowanceMm: mode === 'through_stock'
      ? (options.throughAllowanceMm ?? 0.5)
      : undefined,
  })
  const targets = options.includeTarget === false ? [] : geometryIds.map((geometryId, index) => ({
    geometryId,
    artifactId: `target-artifact-${index + 1}`,
    boundsMachineMm: targetBounds,
    fingerprint: `target-fp-${index + 1}`,
    representation: 'model-solid',
  }))
  const targetCompilation: PlanarRoughTargetCompilationEvidence | undefined =
    mode === 'stock_rough' && options.includeCompilation !== false
      ? {
          stockId,
          materialArtifactId: options.remainingTopMachineMm === undefined
            ? 'stock-artifact-1'
            : 'remaining-1',
          targetGeometryIds: [...geometryIds],
          artifactId: 'prismatic-target-1',
          boundsMachineMm: targetBounds,
          floorMachineMm: options.targetFloorMachineMm ?? (wcs + 5),
          keepOutRegions: (options.keepOutLoopIds ?? ['boss-loop-1']).map(loopId => ({
            loopId,
            materialTopMachineMm: options.keepOutMaterialTopMachineMm
              ?? options.remainingTopMachineMm
              ?? stockBounds.maxZ,
            targetTopMachineMm: options.keepOutTargetTopMachineMm
              ?? options.remainingTopMachineMm
              ?? stockBounds.maxZ,
          })),
          fingerprint: 'prismatic-fp-1',
          representation: options.targetRepresentation ?? PLANAR_ROUGH_TARGET_REPRESENTATION,
        }
      : undefined
  const evidence = buildPlanarRoughSmartHeightEvidenceContext({
    revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
    wcsOriginMachineMm: wcs,
    operationId: `${operationType}-1`,
    operationType,
    geometryIds,
    owningStocks: Array.from({ length: options.stockCount ?? 1 }, (_, index) => ({
      stockId: index === 0 ? stockId : `stock-${index + 1}`,
      artifactId: `stock-artifact-${index + 1}`,
      boundsMachineMm: stockBounds,
      fingerprint: `stock-fp-${index + 1}`,
      representation: 'axis-aligned-stock-box',
    })),
    targets,
    selectedFloor: mode === 'geometry_floor' && options.includeTarget !== false
      ? {
          geometryId: geometryIds[0],
          planeMachineMm: options.targetPlaneMachineMm ?? (wcs + 5),
          fingerprint: 'selected-floor-fp',
        }
      : undefined,
    targetCompilation,
    floorStockToLeaveMm: options.floorStockToLeaveMm ?? 0,
    remainingMaterial: options.remainingTopMachineMm === undefined
      ? undefined
      : {
          artifactId: 'remaining-1',
          stockId,
          boundsMachineMm: bounds(wcs, options.remainingTopMachineMm),
          materialTopMachineMm: options.remainingTopMachineMm,
          fingerprint: 'remaining-fp',
          representation: 'retained-material-field',
          compatible: true,
        },
  })
  return { intent, evidence, geometryIds, stockId, targetCompilation }
}

function resolveFixture(value: ReturnType<typeof fixture>) {
  return resolvePlanarRoughSmartHeights({
    intent: value.intent,
    evidence: value.evidence,
    geometryIds: value.geometryIds,
    stockId: value.stockId,
    targetCompilation: value.targetCompilation,
  })
}

describe('Smart Height Phase 4 planar roughing contract', () => {
  it.each<PlanarRoughOperationType>(['pocket_2d', 'adaptive_clearing_2d'])(
    '%s resolves a selected geometry floor from current material',
    operationType => {
      const resolved = resolveFixture(fixture({ operationType, mode: 'geometry_floor' }))
      expect(resolved.plan.policy).toEqual({ operationType, variant: 'geometry_floor' })
      expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
      expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(5)
      expect(resolved.workerHeights).toMatchObject({ topHeight: 20, bottomHeight: 5 })
    },
  )

  it.each<PlanarRoughOperationType>(['pocket_2d', 'adaptive_clearing_2d'])(
    '%s accepts only a prismatic stock-rough compilation and preserves its keep-outs',
    operationType => {
      const resolved = resolveFixture(fixture({ operationType, mode: 'stock_rough' }))
      expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(5)
      expect(resolved.plan.machining.targetArtifact).toMatchObject({
        artifactId: 'prismatic-target-1',
        representation: PLANAR_ROUGH_TARGET_REPRESENTATION,
      })
      expect(resolved.keepOutLoopIds).toEqual(['boss-loop-1'])
      expect(resolved.targetCompilationFingerprint).toMatch(/^smart-height-/)
    },
  )

  it('prefers compatible remaining material over initial stock for Material Start', () => {
    const resolved = resolveFixture(fixture({
      mode: 'stock_rough', remainingTopMachineMm: 17,
    }))
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(17)
    expect(resolved.plan.machining.materialArtifact?.artifactId).toBe('remaining-1')
  })

  it('resolves an explicit WCS target without restoring a generic depth', () => {
    const resolved = resolveFixture(fixture({ mode: 'explicit_depth', explicitTargetWcsMm: 8 }))
    expect(resolved.plan.policy.variant).toBe('explicit_depth')
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(8)
    expect(resolved.workerHeights.bottomHeight).toBe(8)
  })

  it('resolves through-stock from the proven stock bottom and allowance', () => {
    const resolved = resolveFixture(fixture({ mode: 'through_stock', throughAllowanceMm: 0.75 }))
    expect(resolved.plan.policy.variant).toBe('through_stock')
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(0)
    expect(resolved.plan.machining.cutterCenterEnd?.wcsMm).toBe(-0.75)
    expect(resolved.workerHeights.bottomHeight).toBe(-0.75)
  })

  it('applies axial floor allowance exactly once before the scalar worker', () => {
    const resolved = resolveFixture(fixture({
      mode: 'stock_rough', floorStockToLeaveMm: 0.6,
    }))
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(5)
    expect(resolved.plan.machining.cutterCenterEnd?.wcsMm).toBe(5.6)
    expect(resolved.workerHeights.bottomHeight).toBe(5.6)
    expect(resolved.workerFloorStockToLeaveMm).toBe(0)
  })

  it('refuses non-prismatic spatial targets instead of flattening them', () => {
    const value = fixture({
      mode: 'stock_rough', targetRepresentation: 'triangle-mesh-height-field',
    })
    expect(() => resolveFixture(value)).toThrowError(PlanarRoughSmartHeightError)
    try {
      resolveFixture(value)
    } catch (error) {
      expect((error as PlanarRoughSmartHeightError).refusal).toMatchObject({
        code: 'invalid_evidence', evidenceKind: 'target_surface_field',
      })
    }
  })

  it('refuses missing target compilation instead of restoring Top minus 5 mm', () => {
    const value = fixture({ mode: 'stock_rough', includeCompilation: false })
    expect(() => resolveFixture(value)).toThrow(/requires a proven prismatic target compilation/)
  })

  it('refuses missing and ambiguous owning stock', () => {
    const missing = fixture({ mode: 'geometry_floor', stockCount: 0 })
    expect(resolveSmartHeightPlan(missing.intent, missing.evidence)).toMatchObject({
      ok: false, refusal: { code: 'missing_evidence', evidenceKind: 'owning_stock' },
    })

    const ambiguous = fixture({ mode: 'geometry_floor', stockCount: 2 })
    expect(resolveSmartHeightPlan(ambiguous.intent, ambiguous.evidence)).toMatchObject({
      ok: false, refusal: { code: 'ambiguous_evidence', evidenceRole: 'stock_top' },
    })
  })

  it('refuses stale geometry and stock scopes before resolution', () => {
    const geometry = fixture({ mode: 'geometry_floor' })
    expect(() => resolvePlanarRoughSmartHeights({
      ...geometry, geometryIds: ['other-part'],
    })).toThrow(/scope no longer matches/)

    const stock = fixture({ mode: 'stock_rough' })
    expect(() => resolvePlanarRoughSmartHeights({
      ...stock, stockId: 'other-stock',
    })).toThrow(/no longer matches/)
  })

  it('refuses target geometry or a compiled target outside its owning stock', () => {
    expect(() => fixture({
      mode: 'geometry_floor', targetBounds: bounds(-1, 15),
    })).toThrow(/outside owning stock/)
    expect(() => fixture({
      mode: 'stock_rough', targetBounds: bounds(-1, 15),
    })).toThrow(/outside owning stock/)
  })

  it('refuses a stale compilation identity after evidence was built', () => {
    const value = fixture({ mode: 'stock_rough' })
    const stale = {
      ...value.targetCompilation!,
      fingerprint: 'replaced-target-fingerprint',
    }
    expect(() => resolvePlanarRoughSmartHeights({
      ...value, targetCompilation: stale,
    })).toThrow(/no longer matches the prismatic compilation/)
  })

  it('refuses changed keep-out loops even when the artifact id is reused', () => {
    const value = fixture({ mode: 'stock_rough' })
    const stale = {
      ...value.targetCompilation!,
      keepOutRegions: [{
        ...value.targetCompilation!.keepOutRegions[0],
        loopId: 'different-boss-loop',
      }],
    }
    expect(() => resolvePlanarRoughSmartHeights({
      ...value, targetCompilation: stale,
    })).toThrow(/no longer matches the prismatic compilation/)
  })

  it('refuses a static keep-out when removable material remains above its target', () => {
    const value = fixture({
      mode: 'stock_rough',
      keepOutMaterialTopMachineMm: 20,
      keepOutTargetTopMachineMm: 15,
    })
    expect(() => resolveFixture(value)).toThrow(/cannot clear material above keep-out/)
  })

  it('refuses keep-out evidence above the resolved current-material envelope', () => {
    const value = fixture({
      mode: 'stock_rough',
      keepOutMaterialTopMachineMm: 25,
      keepOutTargetTopMachineMm: 25,
    })
    expect(() => resolveFixture(value)).toThrow(/invalid material or target height/)
  })

  it('refuses conflicting through-stock and axial-stock intent', () => {
    const value = fixture({
      mode: 'through_stock', throughAllowanceMm: 0.5, floorStockToLeaveMm: 0.25,
    })
    expect(() => resolveFixture(value)).toThrow(/cannot also leave axial floor stock/)
  })

  it('converts machine evidence through a translated WCS', () => {
    const resolved = resolveFixture(fixture({
      mode: 'stock_rough',
      wcsOriginMachineMm: 100,
      stockBounds: bounds(100, 120),
      targetBounds: bounds(102, 120),
      targetFloorMachineMm: 105,
    }))
    expect(resolved.plan.machining.materialStart).toMatchObject({ wcsMm: 20, machineMm: 120 })
    expect(resolved.plan.machining.physicalTarget).toMatchObject({ wcsMm: 5, machineMm: 105 })
  })

  it('produces the same semantic result for both scalar roughing families', () => {
    const pocket = resolveFixture(fixture({
      operationType: 'pocket_2d', mode: 'stock_rough', floorStockToLeaveMm: 0.4,
    }))
    const adaptive = resolveFixture(fixture({
      operationType: 'adaptive_clearing_2d', mode: 'stock_rough', floorStockToLeaveMm: 0.4,
    }))
    expect(adaptive.workerHeights).toEqual(pocket.workerHeights)
    expect(adaptive.keepOutLoopIds).toEqual(pocket.keepOutLoopIds)
  })
})
