// WO-1400: refreshModelSectionStaleness must track a tracked model section's
// provenance, not just an exact bodyId + content-fingerprint match -
//
//  - BUG-456: a feature edit that publishes a new bodyId on the SAME lineage
//    (e.g. F1 replaces IMP1) must still be checked against the tracked
//    section, and stale it when content actually changed. On main this
//    misses entirely: hasTrackedSection filters on exact bodyId equality, so
//    the evolved body is never fingerprint-checked.
//  - BUG-460: a moved/rotated source body must stale a world-space tracked
//    section even when its content fingerprint is unchanged. On main this
//    never fires: the fingerprint hashes triangle positions only, so a pure
//    Placement move is invisible to it.
//  - No false positive: same bodyId, same content, same placement must stay
//    non-stale across a real regen.
//
// Driven through the REAL regen action (syncModelBodies) and the REAL
// refreshModelSectionStaleness it calls internally (Tier 2 desk, per the WO's
// evidence-tier - a status-flag correctness fix draws no toolpath/drawn shape,
// so Tier 3 evidence is not required).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project, ImportedGeometry, ModelBodyDisplay } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { modelBodyGeometryFingerprint } = await import('../../lib/cam/modelBodyFingerprint')
const { modelReferenceFrameFingerprint } = await import('../../lib/cam/modelReferenceFrame')
const { resetDocumentHolder, LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')

function display(tag = 0): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}
const derived = (bodyId: string, lineageId: string, version = 1, tag = 0): DerivedModelBody =>
  ({ bodyId, lineageId, version, stableIds: [`${bodyId}:F0`, `${bodyId}:E0`], display: display(tag) })
const live = (bodyId: string, lineageId: string, name = 'Bracket'): LiveModelBody =>
  ({ bodyId, lineageId, name })

function makeProject(): Project {
  return {
    id: 'p1', name: 'Section Provenance', version: '1.0.0',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000, maxSpindleRpm: 24000,
      minSpindleRpm: 8000, spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
  } as Project
}

const modelRow = (): ImportedGeometry =>
  useCamStore.getState().project.geometry.find((g) => g.format === 'model')!

const IDENTITY_FRAME = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }

// Hand-attach a Section-at-Z snapshot the same shape the real capture path
// (deriveBrepLayer's 'section' kind, store/index.ts) writes: bodyId + lineageId
// + content fingerprint + frame fingerprint, all read off the row as it stood
// at capture time - mirrors the existing SECTION-STALENESS-MARK precedent
// (int17aModelBodySync.test.ts) for hand-crafting a tracked section without
// driving the full mesh-slice derive.
function trackSection(geo: ImportedGeometry, capturedDisplay: ModelBodyDisplay): ImportedGeometry {
  const ref = geo.modelBody!.ref
  return {
    ...geo,
    layers2d: [{
      id: 'section-1', name: 'Section z=0', color: '#ff8c00', visible: true, derived: true,
      sectionSource: {
        bodyId: ref.bodyId,
        lineageId: ref.lineageId,
        geometryFingerprint: modelBodyGeometryFingerprint(capturedDisplay),
        frameFingerprint: modelReferenceFrameFingerprint(IDENTITY_FRAME),
      },
    }],
    loops: [{
      id: 'section-loop-1', layerId: 'section-1', closed: true, type: 'contour', area: 0.5,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    }],
    loopsVersion: 1,
  }
}

beforeEach(() => {
  resetDocumentHolder()
  vi.clearAllMocks()
  useCamStore.setState({ project: makeProject() })
})

describe('WO-1400 tracked model section provenance', () => {
  it('BUG-456: a same-lineage id swap (feature edit) is still checked and stales on real content change', () => {
    useCamStore.getState().syncModelBodies({
      live: [live('IMP1', 'L1')], derived: [derived('IMP1', 'L1', 1, 0)],
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) => (g.format === 'model' ? trackSection(g, display(0)) : g)),
      },
    }))

    // F1 replaces IMP1 on the same lineage, with different content.
    useCamStore.getState().syncModelBodies({
      live: [live('F1', 'L1')], derived: [derived('F1', 'L1', 2, 9)],
    })

    expect(modelRow().modelBody?.ref.bodyId).toBe('F1')
    expect(modelRow().layers2d?.[0].sectionSource?.bodyId).toBe('IMP1') // untouched snapshot
    expect(modelRow().layers2d?.[0].sectionStale).toBe(true)
  })

  it('BUG-460: a Placement move stales a world-space tracked section with unchanged content', () => {
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'L1')], derived: [derived('b1', 'L1', 1, 0)],
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) => (g.format === 'model' ? trackSection(g, display(0)) : g)),
      },
    }))

    useCamStore.getState().updateModelItemPlacement(
      LEGACY_MODEL_ITEM_ID, undefined, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
    )
    // sectionStale is recomputed on the next real model-body sync, same as
    // every other staleness check this store makes.
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'L1')], derived: [derived('b1', 'L1', 1, 0)],
    })

    expect(modelRow().layers2d?.[0].sectionStale).toBe(true)
  })

  it('no false positive: same bodyId, content and placement stay non-stale across a real regen', () => {
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'L1')], derived: [derived('b1', 'L1', 1, 0)],
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) => (g.format === 'model' ? trackSection(g, display(0)) : g)),
      },
    }))

    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'L1')], derived: [derived('b1', 'L1', 1, 0)],
    })

    expect(modelRow().layers2d?.[0].sectionStale).toBe(false)
  })
})
