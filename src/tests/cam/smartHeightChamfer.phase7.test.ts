import { describe, expect, it } from 'vitest'
import type { HeightIntentV1, ImportedGeometry, Tool } from '../../types'
import {
  buildChamferSmartHeightEvidenceContext,
  buildChamferSmartHeightIntent,
  chamferSmartHeightDraftFromIntent,
  ChamferSmartHeightError,
  deriveChamferEdgeBindings,
  rebuildChamferSmartHeightFormulaIntent,
  rebuildChamferSmartHeightSafetyIntent,
  resolveChamferSmartHeights,
  type ChamferSelectedFeatureEvidence,
  type StableFeatureReference,
} from '../../lib/cam/smartHeights'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 2, provenance: 'default' },
  retract: { reference: 'feed', offset: 2, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

const tool: Tool = {
  id: 'chamfer-tool-1',
  name: '90 degree chamfer mill',
  type: 'chamfer_mill',
  diameter: 10,
  tipDiameter: 0,
  angleFromAxisDeg: 45,
  fluteLength: 12,
  shankDiameter: 10,
  overallLength: 50,
  numberOfFlutes: 3,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
}

const revision = {
  projectRevision: 'project-r1',
  setupRevision: 'setup-r1',
  operationRevision: 'operation-r1',
}

function featureRef(id: string): StableFeatureReference {
  return {
    modelItemId: 'model-1',
    bodyId: 'body-1',
    featureKind: 'contour_selected_plane',
    stableId: id,
    sourceVersion: 1,
    sourceFingerprint: `topology:${id}`,
  }
}

function feature(id: string): ChamferSelectedFeatureEvidence {
  return {
    loopId: id,
    feature: featureRef(id),
    fingerprint: `edge-evidence:${id}`,
  }
}

function resolve(input: {
  datumReference?: 'geometry_plane' | 'stock_top' | 'wcs_plane' | 'picked_surface'
  datumOffsetMm?: number
  datumMachineMm?: number
  chamferWidthMm?: number
  tipOffsetMm?: number
  features?: ChamferSelectedFeatureEvidence[]
  currentFeatures?: ChamferSelectedFeatureEvidence[]
  currentTool?: Tool
} = {}) {
  const features = input.features ?? [feature('edge-1')]
  const intent = buildChamferSmartHeightIntent({
    setupId: 'setup-1',
    safetyIntent: safety,
    datumReference: input.datumReference ?? 'geometry_plane',
    datumOffsetMm: input.datumOffsetMm ?? 0,
    chamferWidthMm: input.chamferWidthMm ?? 1,
    tipOffsetMm: input.tipOffsetMm ?? 0.25,
    features,
  })
  const evidence = buildChamferSmartHeightEvidenceContext({
    intent,
    revision,
    wcsOriginMachineMm: 90,
    operationId: 'op-1',
    tool: input.currentTool ?? tool,
    features: input.currentFeatures ?? features,
    resolvedDatumMachineMm: input.datumMachineMm ?? 100,
    datumFingerprint: 'datum-r1',
  })
  return { intent, resolved: resolveChamferSmartHeights({ intent, evidence }) }
}

describe('Chamfer Smart Height policy adapter', () => {
  it('resolves both Material Start and cutter end from the semantic datum formula', () => {
    const { intent, resolved } = resolve({ chamferWidthMm: 1.2, tipOffsetMm: 0.3 })
    expect(intent.policy).toEqual({ operationType: 'chamfer', variant: 'edge_width_formula' })
    expect(intent.machining.scope.value).toMatchObject({ kind: 'selected_features' })
    expect(resolved.workerHeights.topHeight).toBe(10)
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(8.5, 9)
    expect(resolved.plan.machining.physicalTarget?.wcsMm).toBe(10)
    expect(resolved.formula).toMatchObject({
      kind: 'chamfer_edge', chamferWidthMm: 1.2, tipOffsetMm: 0.3,
    })
  })

  it('preserves stock, WCS, and picked-surface datum semantics in authority', () => {
    for (const datumReference of ['stock_top', 'wcs_plane', 'picked_surface'] as const) {
      const { intent } = resolve({ datumReference, datumOffsetMm: 0.4 })
      expect(chamferSmartHeightDraftFromIntent(intent)).toMatchObject({
        datumReference, datumOffsetMm: 0.4,
      })
    }
  })

  it('rebuilds Setup safety without changing edge, datum, or formula authority', () => {
    const { intent } = resolve()
    const replacement = {
      clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'user' as const },
      retract: { reference: 'top' as const, offset: 4, provenance: 'user' as const },
      feed: { reference: 'top' as const, offset: 1.5, provenance: 'user' as const },
    }
    const rebuilt = rebuildChamferSmartHeightSafetyIntent({
      intent, setupId: 'setup-1', safetyIntent: replacement,
    })
    expect(rebuilt.machining).toEqual(intent.machining)
    expect(rebuilt.policy).toEqual(intent.policy)
    expect(rebuilt.safety.clearance).toMatchObject({ reference: 'wcs_plane', offsetMm: 30 })
  })

  it('edits formula values without changing the stable edge scope or safety authority', () => {
    const { intent } = resolve()
    const rebuilt = rebuildChamferSmartHeightFormulaIntent({
      intent,
      patch: {
        datumReference: 'stock_top', datumOffsetMm: 0.75,
        chamferWidthMm: 2.5, tipOffsetMm: 1.25,
      },
    })
    expect(rebuilt.policy).toEqual(intent.policy)
    expect(rebuilt.safety).toEqual(intent.safety)
    expect(rebuilt.machining.scope).toEqual(intent.machining.scope)
    expect(chamferSmartHeightDraftFromIntent(rebuilt)).toEqual({
      datumReference: 'stock_top', datumOffsetMm: 0.75,
      chamferWidthMm: 2.5, tipOffsetMm: 1.25,
    })
  })

  it('refuses a replaced edge instead of transferring authority by loop position', () => {
    const authored = [feature('edge-1')]
    const replaced = [{
      ...authored[0],
      feature: { ...authored[0].feature, sourceFingerprint: 'topology:replacement' },
    }]
    expect(() => resolve({ features: authored, currentFeatures: replaced })).toThrow(ChamferSmartHeightError)
  })

  it('refuses missing or invalid tool geometry before resolution', () => {
    expect(() => resolve({ currentTool: { ...tool, angleFromAxisDeg: undefined } })).toThrow(/half-angle must be finite/)
    expect(() => resolve({ currentTool: { ...tool, angleFromAxisDeg: 90 } })).toThrow(/less than 90 degrees/)
  })

  it('refuses non-positive width and negative tip offset at authoring', () => {
    expect(() => resolve({ chamferWidthMm: 0 })).toThrow(/width must be greater than zero/)
    expect(() => resolve({ tipOffsetMm: -0.1 })).toThrow(/tip offset cannot be negative/)
  })
})

describe('Chamfer stable edge binding', () => {
  it('accepts a flat loop without cylinder, hole-floor, or projection-plane evidence', () => {
    const geometry = {
      id: 'flat-dxf', name: 'Flat DXF', type: 'dxf',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      loops: [{
        id: 'edge-1', layerId: 'layer-1', closed: true, type: 'contour',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      }],
      layers2d: [{ id: 'layer-1', name: 'Layer 1', visible: true }],
    } as unknown as ImportedGeometry
    expect(deriveChamferEdgeBindings([geometry], ['edge-1']))
      .toMatchObject({ ok: true, bindings: [{ loopId: 'edge-1' }] })
  })

  it('refuses open and duplicate edge identities', () => {
    const geometry = {
      id: 'flat-dxf', name: 'Flat DXF', type: 'dxf',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      loops: [{ id: 'edge-1', layerId: 'layer-1', closed: false, type: 'contour', points: [] }],
      layers2d: [{ id: 'layer-1', name: 'Layer 1', visible: true }],
    } as unknown as ImportedGeometry
    expect(deriveChamferEdgeBindings([geometry], ['edge-1']))
      .toMatchObject({ ok: false, refusals: [{ code: 'open_loop' }] })
    expect(deriveChamferEdgeBindings([geometry], ['edge-1', 'edge-1']))
      .toMatchObject({ ok: false, refusals: [{ code: 'ambiguous_loop' }] })
  })
})
