// WO INT-17C Stage C2: `updateModelItemPlacement` is the ONE sanctioned write
// path for a Model Item's Placement. This file drives the store action
// directly (the real user paths -- gizmo drag-end and the Properties Panel's
// typed commit -- both land here; Viewport.tsx's handlePartTransformChange
// and PropertiesPanel.tsx's commitModelItemPlacementAxis are covered by their
// own render-gate/unit tests) and proves the Placement Composition Contract's
// isolation guarantee as a can-fail mutation probe, per the WO's Stage C2
// acceptance test: "(a) A's model archive bytes are unchanged (hash
// equality) and (b) project undo restores the prior position in one step."
//
// Granularity contract (mirrors undoMove.test.ts's B1 contract for
// updateGeometryTransform, restated one layer down for Placement):
//   - The gizmo commits the store exactly once per completed drag gesture
//     (CNCViewport 'dragging-changed' -> Viewport.handlePartTransformChange
//     -> updateModelItemPlacement). One gesture = one history entry.
//   - A zero-delta commit (handle grabbed without moving, or a typed-field
//     blur re-commit after Enter already committed the same value) must NOT
//     push, or Ctrl+Z appears dead.
//   - The typed Properties Panel commit lands in the SAME action, so it is
//     the same kind of undo step.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { getDocumentGeneration } from '../../doc/documentHolder'
import type { ImportedGeometry, ModelItemPlacementRecord, SceneStock } from '../../types'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function modelGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'modelbody:item-a:b1', name: 'Bracket', filename: 'Bracket', type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId: 'item-a',
    modelBody: {
      ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    },
    ...over,
  }
}

function resetStore(): void {
  useCamStore.setState(s => ({
    project: {
      ...s.project, geometry: [], setups: [], sceneStock: autoStock,
      modelItems: [{ id: 'item-a', name: 'Item A' }],
      modelItemPlacements: [],
    },
    projectHistory: [],
    sketchHistory: [],
    canUndo: false,
  }))
}

const state = () => useCamStore.getState()
const historyLen = () => state().projectHistory.length
const placements = () => state().project.modelItemPlacements ?? []

describe('INT-17C Stage C2: updateModelItemPlacement', () => {
  beforeEach(resetStore)

  it('writes a whole-item Placement record (bodyId omitted) when none exists yet', () => {
    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 5, z: 3 }, { x: 0, y: 0, z: 0 })
    expect(placements()).toHaveLength(1)
    expect(placements()[0]).toEqual({
      modelItemId: 'item-a', position: { x: 10, y: 5, z: 3 }, rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('one completed gesture = exactly one history entry; zero-delta commits push nothing', () => {
    const baseline = historyLen()

    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(historyLen()).toBe(baseline + 1)

    // Zero-delta re-commit (gizmo handle grabbed without moving).
    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(historyLen()).toBe(baseline + 1)

    // A second real gesture -> a second entry.
    state().updateModelItemPlacement('item-a', 'b1', { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(historyLen()).toBe(baseline + 2)
  })

  it('undo restores the prior Placement in one step (WO Stage C2 acceptance test, part b)', () => {
    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 5, z: 3 }, { x: 0, y: 0, z: 0 })
    expect(placements()[0].position).toEqual({ x: 10, y: 5, z: 3 })

    state().undo()
    expect(placements()).toHaveLength(0)
  })

  it('rotation-only gesture is also one undoable step', () => {
    state().updateModelItemPlacement('item-a', 'b1', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 45 })
    expect(placements()[0].rotation.z).toBe(45)

    state().undo()
    expect(placements()).toHaveLength(0)
  })

  it('ISOLATION (Placement Composition Contract invariant 3): a Placement move never touches project.geometry', () => {
    useCamStore.setState(s => ({ project: { ...s.project, geometry: [modelGeo()] } }))
    const geoBefore = state().project.geometry[0]

    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 5, z: 3 }, { x: 90, y: 0, z: 0 })

    const geoAfter = state().project.geometry[0]
    // The geometry row is BYTE-IDENTICAL (same reference even, since the
    // action's set() never touches project.geometry) -- position/rotation on
    // the row itself stay whatever they were, never mirroring the Placement.
    expect(geoAfter).toBe(geoBefore)
    expect(geoAfter.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(geoAfter.rotation).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('ISOLATION: a Placement move never touches project.modelItems (feature-history identity)', () => {
    const itemsBefore = state().project.modelItems
    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 5, z: 3 }, { x: 0, y: 0, z: 0 })
    expect(state().project.modelItems).toBe(itemsBefore)
  })

  it('ISOLATION (WO Stage C2 acceptance test, part a -- "archive bytes unchanged"): a Placement move never touches the item\'s documentHolder generation', () => {
    const generationBefore = getDocumentGeneration('item-a')
    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 5, z: 3 }, { x: 90, y: 0, z: 0 })
    expect(getDocumentGeneration('item-a')).toBe(generationBefore)
  })

  it('write granularity: a body WITHOUT its own record updates the whole-item record, moving every body sharing it', () => {
    state().updateModelItemPlacement('item-a', 'b1', { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    // b2 (a sibling body, no bodyId hint override) shares the same whole-item record.
    state().updateModelItemPlacement('item-a', 'b2', { x: 8, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(placements()).toHaveLength(1)
    expect(placements()[0]).toMatchObject({ modelItemId: 'item-a', position: { x: 8, y: 0, z: 0 } })
  })

  it('ISOLATION (reverse direction, undo-scope regression per the WO): a feature-edit regen (syncModelBodies re-deriving an UPDATED body) never touches an existing Placement record or pushes an undo step', () => {
    // First sync: item's first body appears, whole-item Placement seeded.
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'b1', name: 'Bracket' }],
      derived: [{ bodyId: 'b1', version: 1, stableIds: ['b1:F0'], display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 0] },
      } }],
      modelItemId: 'item-a',
    })
    // User moves it (a real gesture, so a real Placement value to protect).
    state().updateModelItemPlacement('item-a', 'b1', { x: 10, y: 5, z: 3 }, { x: 0, y: 0, z: 0 })
    const placementAfterMove = placements()[0]
    const historyAfterMove = historyLen()

    // A feature edit inside the item's Editing Space (resize a sketch
    // dimension, Finish) re-derives the SAME body at a new version -- this is
    // exactly what a real regen->syncModelBodies call looks like: an UPDATED
    // entry, not an ADDED one.
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'b1', name: 'Bracket' }],
      derived: [{ bodyId: 'b1', version: 2, stableIds: ['b1:F0'], display: {
        positions: [0, 0, 0, 2, 0, 0, 2, 2, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [2, 2, 0] },
      } }],
      modelItemId: 'item-a',
    })

    // The Placement is byte-identical (WO Stage C2 acceptance test, part c) --
    // a feature edit NEVER touches Placement, and pushes no undo step of its
    // own (part d: "no extra undo entry").
    expect(placements()).toHaveLength(1)
    expect(placements()[0]).toEqual(placementAfterMove)
    expect(historyLen()).toBe(historyAfterMove)
    // The body itself DID update (proves this was a real regen, not a no-op).
    expect(state().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'b1')?.modelBody?.ref.version).toBe(2)
  })

  it('write granularity: a body WITH its own pre-existing body-filtered record updates THAT record, never the whole-item one', () => {
    // Simulates the v12-migration legacy shape: item-a already has independent
    // per-body records for b1 and b2 (as if two unrelated bodies shared one
    // old pre-C2 document).
    const seeded: ModelItemPlacementRecord[] = [
      { modelItemId: 'item-a', bodyId: 'b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      { modelItemId: 'item-a', bodyId: 'b2', position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    useCamStore.setState(s => ({ project: { ...s.project, modelItemPlacements: seeded } }))

    state().updateModelItemPlacement('item-a', 'b1', { x: 99, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    expect(placements()).toHaveLength(2)
    const b1 = placements().find(p => p.bodyId === 'b1')!
    const b2 = placements().find(p => p.bodyId === 'b2')!
    expect(b1.position).toEqual({ x: 99, y: 0, z: 0 })
    // b2's independent record is untouched -- moving one legacy body never
    // silently drags an unrelated sibling.
    expect(b2.position).toEqual({ x: 4, y: 0, z: 0 })
  })
})
