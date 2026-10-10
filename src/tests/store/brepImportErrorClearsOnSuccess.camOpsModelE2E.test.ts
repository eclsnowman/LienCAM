// CAM-OPS-MODEL-E2E Part 1 (Operator 2026-07-24): the CAM-side error banner must
// clear on success -- a refusal that stays pinned after the user fixes its
// own cause is a fail-loud LIE by omission (ADR 0003 requires the message to
// track reality, not just appear truthfully once).
//
// Operator's screenshot (coordination/evidence/EDIT-MODEL-REGRESSION/
// operator-drill-tree-fail-loud.png) shows "B-rep derive (holes) failed: Model
// hole recognition is unavailable for body 'F1' - open the Model tab once
// so the live kernel mounts, then try Detect holes again." rendered at the
// TOP of the CAM Geometry panel -- that text comes from the store's
// `brepImportError` field (src/store/index.ts, `deriveBrepLayer`'s catch
// block, set({ brepImportError: msg })).
//
// ROOT CAUSE (pre-fix): deriveBrepLayer set brepImportError on failure but
// never cleared it on a later SUCCESSFUL derive -- only a brand-new STEP
// import's own load phase (a completely different flow) reset it to null.
// So even after the user did exactly what the refusal told them to (opened
// the Model tab, retried Detect holes, and it worked), the stale refusal
// banner stayed rendered in the tree/geometry panel, contradicting the
// operation that had just succeeded.
//
// THE FIX: deriveBrepLayer now clears brepImportError to null at the top of
// every call, before the derive itself runs -- a successful derive leaves it
// null (nothing re-sets it), a failing derive still sets it exactly as
// before.
import { describe, it, expect, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { setModelBodyHoleRecognizer } from '../../lib/cam/modelBodyHoleRecognition'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { ImportedGeometry, ModelItemPlacementRecord } from '../../types'

const GEO_ID = 'modelbody:F1'

function seedModelGeo(): void {
  const geometry = [{
    id: GEO_ID,
    name: 'Extrude F1',
    type: 'model',
    format: 'model',
    filename: 'Extrude F1',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 20 } },
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [], indices: [0, 1, 2],
        edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [40, 20, 20] },
      },
    },
  }] as unknown as ImportedGeometry[]
  const modelItemPlacements: ModelItemPlacementRecord[] = [
    { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  ]
  const current = useCamStore.getState()
  useCamStore.setState({ project: { ...current.project, geometry, modelItemPlacements } })
}

const oneHoleVerdict: FeatureVerdict[] = [{
  featureKey: 'hole:10:10:20:0:0:1:3',
  featureClass: 'throughHole',
  removable: true,
  effect: 'add',
  faceIds: [],
  neighbourIds: [],
  params: { diameter: 6, depth: 20, axisX: 0, axisY: 0, axisZ: 1, centerX: 10, centerY: 10, centerZ: 20 },
}]

describe('CAM-OPS-MODEL-E2E: brepImportError clears on the next successful derive', () => {
  afterEach(() => {
    setModelBodyHoleRecognizer(null)
  })

  it('a failed Detect-holes derive sets brepImportError; a SUBSEQUENT successful derive clears it back to null', async () => {
    useCamStore.getState().newProject()
    seedModelGeo()

    // 1. Recognition unavailable (no injected recognizer, no window hooks,
    //    and -- this test seeds geometry directly, never through a stashed
    //    document -- no document for WO-335's headless kernel mount to
    //    replay either) -> refuses, banner set.
    setModelBodyHoleRecognizer(null)
    await expect(useCamStore.getState().deriveBrepLayer(GEO_ID, 'holes')).rejects.toThrow(
      /no 3D model to read/,
    )
    expect(useCamStore.getState().brepImportError).toMatch(/no 3D model to read/)

    // 2. The remedy now genuinely works (recognizer available, same as
    //    reopening the Model tab mounting window.__solidsWorkbenchHooks for
    //    real) -> retry Detect holes -> succeeds.
    setModelBodyHoleRecognizer(async () => oneHoleVerdict)
    await useCamStore.getState().deriveBrepLayer(GEO_ID, 'holes')

    // THE ASSERTION: the stale refusal banner must be gone, not still
    // telling the user the operation that just succeeded is broken.
    expect(useCamStore.getState().brepImportError).toBeNull()
  })

  it('a successful derive on a FRESH geometry (no prior failure) leaves brepImportError null (no regression on the happy path)', async () => {
    useCamStore.getState().newProject()
    seedModelGeo()
    setModelBodyHoleRecognizer(async () => oneHoleVerdict)

    await useCamStore.getState().deriveBrepLayer(GEO_ID, 'holes')

    expect(useCamStore.getState().brepImportError).toBeNull()
  })
})
