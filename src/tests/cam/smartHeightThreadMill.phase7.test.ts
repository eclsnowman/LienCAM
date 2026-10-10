import { describe, expect, it } from 'vitest'
import type { HeightIntentV1, ImportedGeometry, Tool } from '../../types'
import {
  buildThreadMillSmartHeightEvidenceContext,
  buildThreadMillSmartHeightIntent,
  deriveThreadMillFeatureBindings,
  rebuildThreadMillSmartHeightSafetyIntent,
  resolveThreadMillSmartHeights,
  threadMillSmartHeightDraftFromIntent,
  ThreadMillSmartHeightError,
  type StableFeatureReference,
  type ThreadMillDetectedFeatureEvidence,
} from '../../lib/cam/smartHeights'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 2, provenance: 'default' },
  retract: { reference: 'feed', offset: 2, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

const tool: Tool = {
  id: 'thread-tool-1',
  name: 'Thread mill',
  type: 'thread_mill',
  diameter: 6,
  fluteLength: 12,
  shankDiameter: 6,
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

function featureRef(id: string, kind: 'bore' | 'boss'): StableFeatureReference {
  return {
    modelItemId: 'model-1',
    bodyId: 'body-1',
    featureKind: `detected_${kind}`,
    stableId: id,
    sourceVersion: 1,
    sourceFingerprint: `topology:${id}`,
  }
}

function feature(
  id: string,
  kind: 'bore' | 'boss',
  topMachineMm = 100,
  floorMachineMm = 80,
): ThreadMillDetectedFeatureEvidence {
  return {
    loopId: `loop:${id}`,
    featureKind: kind,
    feature: featureRef(id, kind),
    topMachineMm,
    floorMachineMm,
    fingerprint: `evidence:${id}:${topMachineMm}:${floorMachineMm}`,
  }
}

describe('Thread Mill Smart Height policy adapter', () => {
  it('resolves an internal detected bore down from its physical top', () => {
    const features = [feature('bore-1', 'bore')]
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
      threadKind: 'internal', threadDepthMm: 15, features,
    })
    const evidence = buildThreadMillSmartHeightEvidenceContext({
      intent, revision, wcsOriginMachineMm: 90, operationId: 'op-1', tool, features,
    })
    const resolved = resolveThreadMillSmartHeights({ intent, evidence })
    expect(intent.policy).toEqual({ operationType: 'thread_mill', variant: 'internal_top' })
    expect(resolved.workerHeights.topHeight).toBe(10)
    expect(resolved.workerHeights.bottomHeight).toBe(-5)
    expect(resolved.formula).toMatchObject({ datum: 'feature_top', direction: 'down', depthMm: 15 })
  })

  it('resolves an external base-referenced band upward without reversing worker planes', () => {
    const features = [feature('boss-1', 'boss')]
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
      threadKind: 'external', externalReference: 'base', threadDepthMm: 15, features,
    })
    const evidence = buildThreadMillSmartHeightEvidenceContext({
      intent, revision, wcsOriginMachineMm: 90, operationId: 'op-2', tool, features,
    })
    const resolved = resolveThreadMillSmartHeights({ intent, evidence })
    expect(intent.policy).toEqual({ operationType: 'thread_mill', variant: 'external_base' })
    expect(resolved.workerHeights.topHeight).toBe(5)
    expect(resolved.workerHeights.bottomHeight).toBe(-10)
    expect(resolved.formula).toMatchObject({ datum: 'feature_base', direction: 'up', depthMm: 15 })
  })

  it('keeps a plain loop explicit instead of pretending it has cylinder evidence', () => {
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'explicit_band',
      threadKind: 'internal', threadDepthMm: 12, geometryIds: ['part-1'],
      datumReference: 'wcs_plane', planeOffsetMm: 10,
    })
    const evidence = buildThreadMillSmartHeightEvidenceContext({
      intent, revision, wcsOriginMachineMm: 90, operationId: 'op-3', tool,
      explicitDatumMachineMm: 100, explicitDatumFingerprint: 'datum-r1',
    })
    const resolved = resolveThreadMillSmartHeights({ intent, evidence })
    expect(intent.policy).toEqual({ operationType: 'thread_mill', variant: 'internal_explicit' })
    expect(intent.machining.scope.value).toEqual({ kind: 'selected_geometry', geometryIds: ['part-1'] })
    expect(resolved.workerHeights.topHeight).toBe(10)
    expect(resolved.workerHeights.bottomHeight).toBe(-2)
  })

  it('decodes semantic authority and replaces only Setup-owned safety planes', () => {
    const features = [feature('boss-1', 'boss')]
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
      threadKind: 'external', externalReference: 'base', threadDepthMm: 15,
      planeOffsetMm: 0.5, features,
    })
    expect(threadMillSmartHeightDraftFromIntent(intent)).toEqual({
      source: 'detected_feature',
      threadKind: 'external',
      externalReference: 'base',
      threadDepthMm: 15,
      planeOffsetMm: 0.5,
    })

    const replacementSafety = {
      clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'user' as const },
      retract: { reference: 'top' as const, offset: 4, provenance: 'user' as const },
      feed: { reference: 'top' as const, offset: 1.5, provenance: 'user' as const },
    }
    const rebuilt = rebuildThreadMillSmartHeightSafetyIntent({
      intent, setupId: 'setup-1', safetyIntent: replacementSafety,
    })
    expect(rebuilt.machining).toEqual(intent.machining)
    expect(rebuilt.policy).toEqual(intent.policy)
    expect(rebuilt.safety.clearance).toMatchObject({ reference: 'wcs_plane', offsetMm: 30 })
    expect(rebuilt.safety.retract).toMatchObject({ reference: 'top', offsetMm: 4 })
  })

  it('refuses mixed detected datum planes instead of silently using the first cylinder', () => {
    const features = [feature('bore-1', 'bore', 100, 80), feature('bore-2', 'bore', 98, 80)]
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
      threadKind: 'internal', threadDepthMm: 10, features,
    })
    expect(() => buildThreadMillSmartHeightEvidenceContext({
      intent, revision, wcsOriginMachineMm: 90, operationId: 'op-4', tool, features,
    })).toThrow(/do not share one top datum plane/)
  })

  it('refuses a detected band that extends beyond the shallowest physical cylinder', () => {
    const features = [feature('bore-1', 'bore', 100, 92), feature('bore-2', 'bore', 100, 80)]
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
      threadKind: 'internal', threadDepthMm: 10, features,
    })
    expect(() => buildThreadMillSmartHeightEvidenceContext({
      intent, revision, wcsOriginMachineMm: 90, operationId: 'op-5', tool, features,
    })).toThrow(/extends below at least one detected cylinder base/)
  })

  it('refuses a replaced stable cylinder instead of reassigning by loop position', () => {
    const authored = [feature('bore-1', 'bore')]
    const intent = buildThreadMillSmartHeightIntent({
      setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
      threadKind: 'internal', threadDepthMm: 10, features: authored,
    })
    const replaced = [{
      ...authored[0],
      feature: { ...authored[0].feature, sourceFingerprint: 'topology:replacement' },
    }]
    expect(() => buildThreadMillSmartHeightEvidenceContext({
      intent, revision, wcsOriginMachineMm: 90, operationId: 'op-6', tool, features: replaced,
    })).toThrow(ThreadMillSmartHeightError)
  })
})

describe('Thread Mill stable cylinder binding', () => {
  it('binds bore and boss loops and leaves a flat circle unproven', () => {
    const geometry = {
      id: 'part-1',
      name: 'Part',
      type: 'step',
      visible: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      loops: [
        { id: 'bore-loop', layerId: 'layer-1', closed: true, type: 'contour', points: [] },
        { id: 'boss-loop', layerId: 'layer-1', closed: true, type: 'hole', points: [] },
        { id: 'flat-loop', layerId: 'layer-1', closed: true, type: 'contour', points: [] },
      ],
      layers2d: [{
        id: 'layer-1', name: 'Cylinders', visible: true, frame: 'geometry_local',
        cylinders: [
          { kind: 'bore', loopId: 'bore-loop', center: { x: 0, y: 0 }, diameter: 10, topZ: 20, bottomZ: 5, through: false },
          { kind: 'boss', loopId: 'boss-loop', center: { x: 20, y: 0 }, diameter: 12, topZ: 25, bottomZ: 5, through: false },
        ],
      }],
    } as unknown as ImportedGeometry

    const bore = deriveThreadMillFeatureBindings([geometry], ['bore-loop'])
    const boss = deriveThreadMillFeatureBindings([geometry], ['boss-loop'])
    const flat = deriveThreadMillFeatureBindings([geometry], ['flat-loop'])
    expect(bore).toMatchObject({ ok: true, bindings: [{ featureKind: 'bore', topMm: 20, floorMm: 5 }] })
    expect(boss).toMatchObject({ ok: true, bindings: [{ featureKind: 'boss', topMm: 25, floorMm: 5 }] })
    expect(flat).toMatchObject({ ok: false, refusals: [{ code: 'no_physical_feature' }] })
  })
})
