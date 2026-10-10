import { describe, expect, it } from 'vitest'
import type { HeightIntentV1, Tool } from '../../types'
import {
  buildDrillBoreSmartHeightEvidenceContext,
  buildDrillBoreSmartHeightIntent,
  drillPointCompensationMm,
  resolveDrillBoreSmartHeights,
  type DrillBoreDetectedFeatureEvidence,
  type StableFeatureReference,
} from '../../lib/cam/smartHeights'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 5, provenance: 'default' },
  retract: { reference: 'stock_top', offset: 3, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

const drillTool = (overrides: Partial<Tool> = {}): Tool => ({
  id: 'tool-drill',
  name: '10 mm drill',
  type: 'drill',
  diameter: 10,
  fluteLength: 30,
  shankDiameter: 10,
  overallLength: 70,
  numberOfFlutes: 2,
  angleFromAxisDeg: 59,
  tipDiameter: 0,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
  ...overrides,
})

const featureRef = (id: string): StableFeatureReference => ({
  modelItemId: 'model-1',
  bodyId: 'body-1',
  featureKind: 'detected_hole',
  stableId: id,
  sourceVersion: 1,
  sourceFingerprint: `topology:${id}`,
})

const feature = (id: string, floorMachineMm: number): DrillBoreDetectedFeatureEvidence => ({
  loopId: `loop:${id}`,
  feature: featureRef(id),
  topMachineMm: 100,
  floorMachineMm,
  fingerprint: `evidence:${id}:${floorMachineMm}`,
})

const revision = {
  projectRevision: 'project-r1',
  setupRevision: 'setup-r1',
  operationRevision: 'operation-r1',
}

describe('Drill/Bore Smart Height policy adapter', () => {
  it('keeps mixed physical hole floors and applies drill point plus breakthrough once', () => {
    const features = [feature('hole-1', 92), feature('hole-2', 84)]
    const tool = drillTool()
    const point = drillPointCompensationMm(tool)
    const intent = buildDrillBoreSmartHeightIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      mode: 'detected_features', features,
    })
    const evidence = buildDrillBoreSmartHeightEvidenceContext({
      operationType: 'drill', mode: 'detected_features', revision, wcsOriginMachineMm: 100, operationId: 'op-1',
      geometryIds: ['part-1'], features,
      owningStock: { stockId: 'stock-1', topMachineMm: 100, bottomMachineMm: 80, fingerprint: 'stock-r1' },
      tool, breakthroughMm: 0.5,
    })
    const resolved = resolveDrillBoreSmartHeights({
      operationType: 'drill', intent, evidence, features, tool, breakthroughMm: 0.5,
    })
    expect(resolved.featureEndpoints.map(item => ({
      id: item.feature.stableId,
      physical: item.physicalFloorWcsMm,
      cutter: item.cutterCenterEndWcsMm,
      source: item.source,
    }))).toEqual([
      { id: 'hole-1', physical: -8, cutter: expect.closeTo(-8.5 - point, 8), source: 'detected' },
      { id: 'hole-2', physical: -16, cutter: expect.closeTo(-16.5 - point, 8), source: 'detected' },
    ])
    expect(resolved.workerHeights.bottomHeight).toBeCloseTo(-16.5 - point, 8)
    expect(resolved.pointCompensationMm).toBeCloseTo(point, 8)
  })

  it('treats a manual per-hole bottom as an exact cutter endpoint', () => {
    const features = [feature('hole-1', 92), feature('hole-2', 84)]
    const tool = drillTool()
    const intent = buildDrillBoreSmartHeightIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      mode: 'detected_features', features,
      perFeatureEndOverridesWcsMm: { 'loop:hole-2': -12 },
    })
    const evidence = buildDrillBoreSmartHeightEvidenceContext({
      operationType: 'drill', mode: 'detected_features', revision, wcsOriginMachineMm: 100, operationId: 'op-1',
      geometryIds: ['part-1'], features,
      owningStock: { stockId: 'stock-1', topMachineMm: 100, bottomMachineMm: 80, fingerprint: 'stock-r1' },
      tool, breakthroughMm: 0.5,
    })
    const resolved = resolveDrillBoreSmartHeights({
      operationType: 'drill', intent, evidence, features, tool, breakthroughMm: 0.5,
    })
    expect(resolved.featureEndpoints[1]).toMatchObject({
      physicalFloorWcsMm: -16,
      cutterCenterEndWcsMm: -12,
      source: 'override',
    })
    expect(resolved.featureBottoms?.['loop:hole-2']).toBe(-12)
  })

  it('keeps Bore floors per feature without drill-point compensation', () => {
    const features = [feature('bore-1', 94), feature('bore-2', 88)]
    const tool = drillTool({ id: 'tool-endmill', type: 'flat_end_mill', diameter: 6 })
    const intent = buildDrillBoreSmartHeightIntent({
      operationType: 'bore', setupId: 'setup-1', safetyIntent: safety,
      mode: 'detected_features', features,
    })
    const evidence = buildDrillBoreSmartHeightEvidenceContext({
      operationType: 'bore', mode: 'detected_features', revision, wcsOriginMachineMm: 100, operationId: 'op-2',
      geometryIds: ['part-1'], features,
      owningStock: { stockId: 'stock-1', topMachineMm: 100, bottomMachineMm: 80, fingerprint: 'stock-r1' },
      tool,
    })
    const resolved = resolveDrillBoreSmartHeights({ operationType: 'bore', intent, evidence, features, tool })
    expect(resolved.pointCompensationMm).toBe(0)
    expect(resolved.featureBottoms).toEqual({ 'loop:bore-1': -6, 'loop:bore-2': -12 })
  })

  it('requires explicit start and end for plain circles with no physical floor', () => {
    const tool = drillTool()
    expect(() => buildDrillBoreSmartHeightIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      mode: 'explicit_depth', geometryIds: ['dxf-1'], explicitEndWcsMm: -5,
    })).toThrow('Material Start')
    const intent = buildDrillBoreSmartHeightIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      mode: 'explicit_depth', geometryIds: ['dxf-1'], explicitStartWcsMm: 0, explicitEndWcsMm: -5,
    })
    const evidence = buildDrillBoreSmartHeightEvidenceContext({
      operationType: 'drill', mode: 'explicit_depth', revision, wcsOriginMachineMm: 100, operationId: 'op-3',
      geometryIds: ['dxf-1'],
      owningStock: { stockId: 'stock-1', topMachineMm: 100, bottomMachineMm: 80, fingerprint: 'stock-r1' },
      tool,
    })
    const resolved = resolveDrillBoreSmartHeights({ operationType: 'drill', intent, evidence, tool })
    expect(resolved.workerHeights).toMatchObject({ topHeight: 0, bottomHeight: -5 })
    expect(resolved.featureEndpoints).toEqual([])
  })

  it('fails loud when owning material or a scoped feature becomes stale', () => {
    const features = [feature('hole-1', 92)]
    const tool = drillTool()
    const intent = buildDrillBoreSmartHeightIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      mode: 'detected_features', features,
    })
    const noStock = buildDrillBoreSmartHeightEvidenceContext({
      operationType: 'drill', mode: 'detected_features', revision, wcsOriginMachineMm: 100, operationId: 'op-4',
      geometryIds: ['part-1'], features, tool,
    })
    expect(() => resolveDrillBoreSmartHeights({
      operationType: 'drill', intent, evidence: noStock, features, tool,
    })).toThrow('owning_stock')

    const replacement = [{
      ...features[0],
      feature: { ...features[0].feature, sourceFingerprint: 'replacement-topology' },
    }]
    const replacedEvidence = buildDrillBoreSmartHeightEvidenceContext({
      operationType: 'drill', mode: 'detected_features', revision, wcsOriginMachineMm: 100, operationId: 'op-4',
      geometryIds: ['part-1'], features: replacement,
      owningStock: { stockId: 'stock-1', topMachineMm: 100, bottomMachineMm: 80, fingerprint: 'stock-r1' },
      tool,
    })
    expect(() => resolveDrillBoreSmartHeights({
      operationType: 'drill', intent, evidence: replacedEvidence, features: replacement, tool,
    })).toThrow('not in the authored feature scope')
  })
})
