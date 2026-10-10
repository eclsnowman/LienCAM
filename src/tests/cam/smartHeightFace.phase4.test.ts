import { describe, expect, it } from 'vitest'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import {
  buildFaceSmartHeightEvidenceContext,
  buildFaceSmartHeightIntent,
  faceSmartHeightDraftFromIntent,
  resolveFaceSmartHeights,
  resolveSmartHeightPlan,
  type FaceSmartHeightEvidenceInput,
  type FaceSmartHeightMode,
} from '../../lib/cam/smartHeights'

const bounds = (minZ: number, maxZ: number) => ({
  minX: 0, minY: 0, minZ, maxX: 100, maxY: 80, maxZ,
})

function fixture(options: {
  mode?: FaceSmartHeightMode
  wcs?: number
  stockCount?: number
  stock?: ReturnType<typeof bounds>
  targetPlaneMachineMm?: number
  explicitTargetWcsMm?: number
  floorStockToLeaveMm?: number
  includeTarget?: boolean
  remainingTopMachineMm?: number
} = {}) {
  const mode = options.mode ?? 'target_face'
  const wcs = options.wcs ?? 0
  const stock = options.stock ?? bounds(0, 20)
  const stockId = 'stock-1'
  const geometryIds = ['part-1']
  const intent = buildFaceSmartHeightIntent({
    setupId: 'setup-1',
    safetyIntent: defaultHeightIntent('face'),
    mode,
    geometryIds: mode === 'target_face' ? geometryIds : undefined,
    stockId: mode === 'explicit_depth' ? stockId : undefined,
    explicitTargetWcsMm: mode === 'explicit_depth'
      ? (options.explicitTargetWcsMm ?? 12)
      : undefined,
  })
  const evidenceInput: FaceSmartHeightEvidenceInput = {
    revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
    wcsOriginMachineMm: wcs,
    operationId: 'face-1',
    geometryIds: mode === 'target_face' ? geometryIds : [],
    owningStocks: Array.from({ length: options.stockCount ?? 1 }, (_, index) => ({
      stockId: `stock-${index + 1}`,
      artifactId: `stock-artifact-${index + 1}`,
      boundsMachineMm: stock,
      fingerprint: `stock-fp-${index + 1}`,
      representation: 'axis-aligned-stock-box',
    })),
    floorStockToLeaveMm: options.floorStockToLeaveMm ?? 0,
    target: mode === 'target_face' && options.includeTarget !== false ? {
      geometryId: 'part-1',
      artifactId: 'part-solid',
      boundsMachineMm: bounds(2 + wcs, 15 + wcs),
      selectedPlaneMachineMm: options.targetPlaneMachineMm ?? (12 + wcs),
      fingerprint: 'part-fp',
      representation: 'model-solid',
    } : undefined,
    remainingMaterial: options.remainingTopMachineMm === undefined ? undefined : {
      artifactId: 'remaining-1',
      boundsMachineMm: bounds(0 + wcs, options.remainingTopMachineMm),
      materialTopMachineMm: options.remainingTopMachineMm,
      fingerprint: 'remaining-fp',
      representation: 'retained-material-field',
      compatible: true,
    },
  }
  return { intent, evidence: buildFaceSmartHeightEvidenceContext(evidenceInput), geometryIds, stockId }
}

describe('Smart Height Phase 4 Face policy fixtures', () => {
  it('round-trips both authoring modes from the persisted intent', () => {
    const target = fixture({ mode: 'target_face' })
    expect(faceSmartHeightDraftFromIntent(target.intent)).toEqual({
      mode: 'target_face', explicitTargetWcsMm: 0,
    })

    const explicit = fixture({ mode: 'explicit_depth', explicitTargetWcsMm: -2.5 })
    expect(faceSmartHeightDraftFromIntent(explicit.intent)).toEqual({
      mode: 'explicit_depth', explicitTargetWcsMm: -2.5,
    })
  })
  it('authors target-face and explicit-depth scopes without a generic depth', () => {
    const target = fixture()
    expect(target.intent.policy).toEqual({ operationType: 'face', variant: 'target_face' })
    expect(target.intent.machining.scope.value).toEqual({
      kind: 'selected_geometry', geometryIds: ['part-1'],
    })
    expect(target.intent.machining.end.value.kind).toBe('selected_plane')

    const explicit = fixture({ mode: 'explicit_depth', explicitTargetWcsMm: 11 })
    expect(explicit.intent.policy).toEqual({ operationType: 'face', variant: 'explicit_depth' })
    expect(explicit.intent.machining.scope.value).toEqual({
      kind: 'stock_footprint', stockId: 'stock-1',
    })
    expect(explicit.intent.machining.end.value).toMatchObject({
      kind: 'bounded_plane', plane: { reference: 'wcs_plane', offsetMm: 11 },
    })
  })

  it('resolves current stock top to a selected physical target face', () => {
    const { intent, evidence, geometryIds } = fixture()
    const resolved = resolveFaceSmartHeights({ intent, evidence, geometryIds })
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(12)
    expect(resolved.plan.machining.cutterCenterEnd?.wcsMm).toBe(12)
    expect(resolved.workerHeights).toMatchObject({ topHeight: 20, bottomHeight: 12 })
  })

  it('keeps an explicit WCS target authoritative while deriving start from stock', () => {
    const { intent, evidence, stockId } = fixture({
      mode: 'explicit_depth', explicitTargetWcsMm: 13,
    })
    const resolved = resolveFaceSmartHeights({ intent, evidence, stockId })
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(20)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(13)
    expect(resolved.workerHeights.bottomHeight).toBe(13)
  })

  it('applies floor stock to leave exactly once after the physical target', () => {
    const { intent, evidence, geometryIds } = fixture({ floorStockToLeaveMm: 0.75 })
    const resolved = resolveFaceSmartHeights({ intent, evidence, geometryIds })
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(12)
    expect(resolved.plan.machining.cutterCenterEnd?.wcsMm).toBe(12.75)
    expect(resolved.workerHeights.bottomHeight).toBe(12.75)
  })

  it('resolves translated WCS values in both frames', () => {
    const { intent, evidence, geometryIds } = fixture({
      wcs: 100,
      stock: bounds(100, 120),
      targetPlaneMachineMm: 112,
    })
    const resolved = resolveFaceSmartHeights({ intent, evidence, geometryIds })
    expect(resolved.plan.machining.materialStart).toMatchObject({ wcsMm: 20, machineMm: 120 })
    expect(resolved.plan.machining.physicalTarget).toMatchObject({ wcsMm: 12, machineMm: 112 })
  })

  it('uses compatible retained material as current material start', () => {
    const { intent, evidence, geometryIds } = fixture({ remainingTopMachineMm: 17 })
    const resolved = resolveFaceSmartHeights({ intent, evidence, geometryIds })
    expect(resolved.plan.machining.materialStart.wcsMm).toBe(17)
    expect(resolved.plan.machining.materialArtifact?.artifactId).toBe('remaining-1')
  })

  it('refuses missing or ambiguous owning stock instead of guessing', () => {
    const missing = fixture({ stockCount: 0 })
    expect(resolveSmartHeightPlan(missing.intent, missing.evidence)).toMatchObject({
      ok: false, refusal: { code: 'missing_evidence', evidenceKind: 'owning_stock' },
    })
    const ambiguous = fixture({ stockCount: 2 })
    expect(resolveSmartHeightPlan(ambiguous.intent, ambiguous.evidence)).toMatchObject({
      ok: false, refusal: { code: 'ambiguous_evidence', evidenceRole: 'stock_top' },
    })
  })

  it('refuses target-face mode without selected-plane evidence', () => {
    const { intent, evidence } = fixture({ includeTarget: false })
    expect(resolveSmartHeightPlan(intent, evidence)).toMatchObject({
      ok: false, refusal: { code: 'missing_evidence', evidenceKind: 'target_model' },
    })
  })

  it('refuses stale target and stock scopes before resolution', () => {
    const target = fixture()
    expect(() => resolveFaceSmartHeights({
      intent: target.intent, evidence: target.evidence, geometryIds: ['other-part'],
    })).toThrow(/scope no longer matches/)

    const explicit = fixture({ mode: 'explicit_depth' })
    expect(() => resolveFaceSmartHeights({
      intent: explicit.intent, evidence: explicit.evidence, stockId: 'other-stock',
    })).toThrow(/scope no longer matches/)
  })

  it('lifts a setup-owned Feed below Top, refuses user-set contradictions and inverted final ordering', () => {
    // WO-1621: the Setup's Feed is not the operator's; it is lifted to Material Start.
    const lifted = fixture()
    lifted.intent.safety.feed = {
      reference: 'top', offsetMm: -1, owner: { kind: 'setup', setupId: 'setup-1' },
    }
    const liftedResult = resolveSmartHeightPlan(lifted.intent, lifted.evidence)
    expect(liftedResult.ok).toBe(true)
    if (liftedResult.ok) {
      expect(liftedResult.plan.safety.feed.wcsMm).toBe(liftedResult.plan.machining.materialStart.wcsMm)
    }

    const unsafe = fixture()
    unsafe.intent.safety.feed = { reference: 'top', offsetMm: -1, owner: { kind: 'user_override' } }
    expect(resolveSmartHeightPlan(unsafe.intent, unsafe.evidence)).toMatchObject({
      ok: false, refusal: { code: 'invalid_plane_order', message: expect.stringMatching(/Feed .* Material Start/) },
    })

    const inverted = fixture({ mode: 'explicit_depth', explicitTargetWcsMm: 25 })
    expect(resolveSmartHeightPlan(inverted.intent, inverted.evidence)).toMatchObject({
      ok: false, refusal: { code: 'invalid_plane_order' },
    })
  })

  it('refuses a selected target outside its owning stock', () => {
    expect(() => fixture({ targetPlaneMachineMm: -2 }))
      .toThrow(/outside owning stock/)
  })
})
