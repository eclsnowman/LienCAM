import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  ContourSmartHeightError,
  buildContourSmartHeightEvidenceContext,
  buildContourSmartHeightIntent,
  contourSmartHeightDraftFromIntent,
  operationHeightPolicy,
  resolveContourSmartHeights,
  resolveSmartHeightPlan,
  type ContourSelectedFeatureEvidence,
  type ContourSmartHeightMode,
  type StableFeatureReference,
} from '../../lib/cam/smartHeights'

const bounds = (minZ: number, maxZ: number) => ({
  minX: 0, minY: 0, minZ, maxX: 100, maxY: 80, maxZ,
})

function feature(stableId: string, bodyId = 'body-1'): StableFeatureReference {
  return {
    modelItemId: 'model-1',
    bodyId,
    featureKind: 'vertical_cylinder',
    stableId,
    sourceVersion: 4,
    sourceFingerprint: `source-${bodyId}-v4`,
  }
}

function selectedFeature(
  loopId: string,
  stableId: string,
  topMachineMm: number,
  floorMachineMm: number,
  bodyId = 'body-1',
): ContourSelectedFeatureEvidence {
  return {
    loopId,
    feature: feature(stableId, bodyId),
    topMachineMm,
    floorMachineMm,
    fingerprint: `feature-${stableId}-${topMachineMm}-${floorMachineMm}`,
  }
}

function fixture(options: {
  mode?: ContourSmartHeightMode
  wcsOriginMachineMm?: number
  stockCount?: number
  stockBounds?: ReturnType<typeof bounds>
  selectedFeatures?: ContourSelectedFeatureEvidence[]
  targetCount?: number
  targetBounds?: ReturnType<typeof bounds>
  explicitTargetWcsMm?: number
  throughAllowanceMm?: number
  floorStockToLeaveMm?: number
  remainingTopMachineMm?: number
} = {}) {
  const mode = options.mode ?? 'selected_feature'
  const wcs = options.wcsOriginMachineMm ?? 100
  const geometryIds = ['part-1']
  const selectedFeatures = options.selectedFeatures ?? [
    selectedFeature('loop-high', 'cylinder-high', wcs + 10, wcs + 6),
    selectedFeature('loop-low', 'cylinder-low', wcs + 8, wcs + 2),
  ]
  const intent = buildContourSmartHeightIntent({
    setupId: 'setup-1',
    safetyIntent: defaultHeightIntent('contour_2d'),
    mode,
    geometryIds: mode === 'selected_feature' ? undefined : geometryIds,
    features: mode === 'selected_feature' ? selectedFeatures.map(item => item.feature) : undefined,
    explicitTargetWcsMm: mode === 'explicit_depth' ? (options.explicitTargetWcsMm ?? 3) : undefined,
    throughAllowanceMm: mode === 'through_stock' ? (options.throughAllowanceMm ?? 0.5) : undefined,
  })
  const evidence = buildContourSmartHeightEvidenceContext({
    revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
    wcsOriginMachineMm: wcs,
    operationId: 'contour-1',
    geometryIds,
    owningStocks: Array.from({ length: options.stockCount ?? 1 }, (_, index) => ({
      stockId: `stock-${index + 1}`,
      artifactId: `stock-artifact-${index + 1}`,
      boundsMachineMm: options.stockBounds ?? bounds(wcs, wcs + 20),
      fingerprint: `stock-fp-${index + 1}`,
      representation: 'axis-aligned-stock-box',
    })),
    floorStockToLeaveMm: options.floorStockToLeaveMm ?? 0,
    selectedFeatures: mode === 'selected_feature' ? selectedFeatures : undefined,
    targets: Array.from({ length: options.targetCount ?? 1 }, (_, index) => ({
      geometryId: index === 0 ? 'part-1' : `part-${index + 1}`,
      artifactId: `target-artifact-${index + 1}`,
      boundsMachineMm: options.targetBounds ?? bounds(wcs + 4, wcs + 14),
      fingerprint: `target-fp-${index + 1}`,
      representation: 'model-solid',
    })),
    remainingMaterial: options.remainingTopMachineMm === undefined ? undefined : {
      artifactId: 'remaining-1',
      boundsMachineMm: bounds(wcs, options.remainingTopMachineMm),
      materialTopMachineMm: options.remainingTopMachineMm,
      fingerprint: 'remaining-fp',
      representation: 'retained-material-field',
      compatible: true,
    },
  })
  return { intent, evidence, selectedFeatures }
}

function resolveFixture(value: ReturnType<typeof fixture>) {
  return resolveContourSmartHeights({
    intent: value.intent,
    evidence: value.evidence,
    featureEvidence: value.selectedFeatures,
  })
}

describe('Smart Height Contour contract', () => {
  it('registers selected features as per-feature rather than one operation floor', () => {
    expect(operationHeightPolicy('contour_2d').variants.selected_feature).toMatchObject({
      machiningEnd: 'detected_feature_floors',
      endpointCardinality: 'per_feature',
      requiredEvidence: ['owning_stock', 'selected_feature', 'operation_scope'],
    })
  })

  it('preserves mixed feature floors in the exact worker loop map', () => {
    const resolved = resolveFixture(fixture())
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
    expect(resolved.featureEndpoints).toEqual([
      expect.objectContaining({ loopId: 'loop-high', physicalTargetWcsMm: 6, cutterCenterEndWcsMm: 6 }),
      expect.objectContaining({ loopId: 'loop-low', physicalTargetWcsMm: 2, cutterCenterEndWcsMm: 2 }),
    ])
    expect(resolved.loopBottoms).toEqual({ 'loop-high': 6, 'loop-low': 2 })
    expect(resolved.workerHeights.bottomHeight).toBe(2)
  })

  it('applies floor stock to leave once to every selected feature', () => {
    const resolved = resolveFixture(fixture({ floorStockToLeaveMm: 0.4 }))
    expect(resolved.featureEndpoints.map(item => item.physicalTargetWcsMm)).toEqual([6, 2])
    expect(resolved.loopBottoms).toEqual({ 'loop-high': 6.4, 'loop-low': 2.4 })
    expect(resolved.workerHeights.bottomHeight).toBe(2.4)
    expect(resolved.workerFloorStockToLeaveMm).toBe(0)
  })

  it('uses compatible remaining material as Material Start', () => {
    const resolved = resolveFixture(fixture({ remainingTopMachineMm: 117 }))
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(17)
    expect(resolved.plan.machining.materialArtifact?.artifactId).toBe('remaining-1')
  })

  it('resolves stock-bottom, model-bottom, through-stock, and explicit endpoints distinctly', () => {
    expect(resolveFixture(fixture({ mode: 'stock_bottom' })).workerHeights.bottomHeight).toBe(0)
    expect(resolveFixture(fixture({ mode: 'model_bottom' })).workerHeights.bottomHeight).toBe(4)
    expect(resolveFixture(fixture({ mode: 'through_stock', throughAllowanceMm: 0.75 })).workerHeights.bottomHeight).toBe(-0.75)
    expect(resolveFixture(fixture({ mode: 'explicit_depth', explicitTargetWcsMm: 3.25 })).workerHeights.bottomHeight).toBe(3.25)
  })

  it('uses stock rather than target-model top as model-bottom Material Start', () => {
    const resolved = resolveFixture(fixture({ mode: 'model_bottom' }))
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(4)
  })

  it('refuses missing or ambiguous owning stock', () => {
    const missing = fixture({ stockCount: 0 })
    expect(resolveSmartHeightPlan(missing.intent, missing.evidence)).toMatchObject({
      ok: false,
      refusal: { code: 'missing_evidence', evidenceKind: 'owning_stock' },
    })
    const ambiguous = fixture({ stockCount: 2 })
    expect(resolveSmartHeightPlan(ambiguous.intent, ambiguous.evidence)).toMatchObject({
      ok: false,
      refusal: { code: 'ambiguous_evidence', evidenceRole: 'stock_top' },
    })
  })

  it('refuses ambiguous model-bottom evidence', () => {
    const value = fixture({ mode: 'model_bottom', targetCount: 2 })
    expect(resolveSmartHeightPlan(value.intent, value.evidence)).toMatchObject({
      ok: false,
      refusal: { code: 'ambiguous_evidence', evidenceRole: 'target_bottom' },
    })
  })

  it('matches feature allowance by complete stable identity, not stableId alone', () => {
    const selectedFeatures = [
      selectedFeature('loop-a', 'same-local-id', 110, 106, 'body-a'),
      selectedFeature('loop-b', 'same-local-id', 108, 102, 'body-b'),
    ]
    const value = fixture({ selectedFeatures, floorStockToLeaveMm: 0.25 })
    expect(resolveFixture(value).loopBottoms).toEqual({ 'loop-a': 6.25, 'loop-b': 2.25 })
  })

  it('refuses duplicate loop or feature identity before resolution', () => {
    const duplicateLoop = [
      selectedFeature('loop-a', 'a', 110, 106),
      selectedFeature('loop-a', 'b', 108, 102),
    ]
    expect(() => fixture({ selectedFeatures: duplicateLoop })).toThrow(/more than one feature endpoint/)

    const duplicateFeature = [
      selectedFeature('loop-a', 'same', 110, 106),
      selectedFeature('loop-b', 'same', 108, 102),
    ]
    expect(() => fixture({ selectedFeatures: duplicateFeature })).toThrow(/duplicate stable features/)
  })

  it('refuses missing preview-to-worker loop mapping', () => {
    const value = fixture()
    expect(() => resolveContourSmartHeights({
      intent: value.intent,
      evidence: value.evidence,
      featureEvidence: value.selectedFeatures.slice(0, 1),
    })).toThrowError(ContourSmartHeightError)
  })

  it('requires an explicit endpoint for flat 2D geometry', () => {
    expect(() => buildContourSmartHeightIntent({
      setupId: 'setup-1',
      safetyIntent: defaultHeightIntent('contour_2d'),
      mode: 'explicit_depth',
      geometryIds: ['flat-dxf'],
    })).toThrow(/explicit Target End/)
  })

  it('round-trips editable endpoint values from V2 intent without legacy scalars', () => {
    const explicit = fixture({ mode: 'explicit_depth', explicitTargetWcsMm: -3.75 }).intent
    expect(contourSmartHeightDraftFromIntent(explicit)).toEqual({
      mode: 'explicit_depth', explicitTargetWcsMm: -3.75, throughAllowanceMm: 0,
    })
    const through = fixture({ mode: 'through_stock', throughAllowanceMm: 0.8 }).intent
    expect(contourSmartHeightDraftFromIntent(through)).toEqual({
      mode: 'through_stock', explicitTargetWcsMm: 0, throughAllowanceMm: 0.8,
    })
  })
})
