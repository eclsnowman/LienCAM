// Regression (Operator, owner-decided fix, 2026-07-22): a sketch edits at the CONVENTIONAL
// workspace origin unless it belongs to a genuine NEST seed. Investigated bug: Viewport.tsx's
// sketch-editor display-offset lookup applied ANY owner's position/rotation.z unconditionally,
// so moving the shared ad hoc "New Sketch" container (every New-Sketch layer lived on it
// then; since WO-2189 each new sketch is its own part) -- or any plain/imported geometry that owns a sketch layer -- via
// updateGeometryTransform (PropertiesPanel position fields / the move gizmo) silently
// relocated where that sketch's editor opens. Nest seeds are the ONE deliberate exception
// (ADR 0024 slot pose) and must keep carrying their pose into the sketch editor.
//
// This test exercises the REAL store action (updateGeometryTransform -- moving stays fully
// allowed everywhere, unchanged) plus the REAL exported pure function extracted from
// Viewport.tsx's inline lookup, resolveSketchEditorOffset (src/lib/viewport/sketchEditorOffset.ts).
//
//   - moving a new sketch's own part -> offset stays identity (the reported bug, now fixed).
//   - moving a plain (non-nest) geometry that owns a sketch layer -> offset stays identity.
//   - a nest-seed-owned geometry (ownerNestId set) moved to a slot pose -> offset PRESERVED
//     (the deliberate nest behavior must not regress).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { resolveSketchEditorOffset } from '../../lib/viewport/sketchEditorOffset'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function squareLoop(id: string, layerId: string, s: number): Loop2D {
  return {
    id, layerId, closed: true, type: 'contour', area: s * s,
    points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }],
  }
}

// A plain imported part (DXF-like) that owns a sketch layer directly -- NOT nest-owned.
function makePlainGeoWithSketchLayer(id: string, layerId: string): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, layerId, 10)],
    layers2d: [{ id: layerId, name: 'Layer', color: '#00e5ff', visible: true }],
  }
}

// A nest's owned seed copy: ownerNestId set (ADR 0025 Sec.2), owns a sketch layer.
function makeNestSeedGeoWithSketchLayer(id: string, layerId: string, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Seed ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, layerId, 10)],
    layers2d: [{ id: layerId, name: 'Layer', color: '#00e5ff', visible: true }],
    ownerNestId,
  }
}

beforeEach(() => {
  useCamStore.getState().newProject()
})

describe('resolveSketchEditorOffset (sketch-editor DISPLAY offset owner rule)', () => {
  it('moving a new sketch part leaves the offset at identity', () => {
    // createSketchLayer is the REAL path "New Sketch" takes to materialize a
    // fresh layer on its own new sketch part (store/index.ts createSketchLayer).
    const layer = useCamStore.getState().createSketchLayer()
    // WO-2189: find the sketch's part through its layer's owner.
    const partId = useCamStore.getState().project.geometry
      .find((g) => g.layers2d?.some((l) => l.id === layer.id))!.id

    // Baseline: the part starts at the origin -> already identity.
    let geometry = useCamStore.getState().project.geometry
    expect(resolveSketchEditorOffset(geometry, layer.id)).toEqual({ x: 0, y: 0, rotationDeg: 0 })

    // The reported bug's repro: move the part via the REAL store action that
    // both the Properties panel position fields and the move gizmo commit through.
    useCamStore.getState().updateGeometryTransform(
      partId,
      { x: 120, y: -45, z: 0 },
      { x: 0, y: 0, z: 30 },
    )

    // Confirm the move actually landed (otherwise this test would pass for the wrong reason).
    const movedContainer = useCamStore.getState().project.geometry.find((g) => g.id === partId)!
    expect(movedContainer.position.x).toBe(120)
    expect(movedContainer.rotation.z).toBe(30)

    geometry = useCamStore.getState().project.geometry
    expect(resolveSketchEditorOffset(geometry, layer.id)).toEqual({ x: 0, y: 0, rotationDeg: 0 })
  })

  it('moving a plain (non-nest) geometry that owns a sketch layer leaves the offset at identity', () => {
    const layerId = 'L-plain'
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [...s.project.geometry, makePlainGeoWithSketchLayer('g1', layerId)] },
    }))

    useCamStore.getState().updateGeometryTransform(
      'g1',
      { x: 75, y: 200, z: 0 },
      { x: 0, y: 0, z: 90 },
    )

    const moved = useCamStore.getState().project.geometry.find((g) => g.id === 'g1')!
    expect(moved.position.x).toBe(75)
    expect(moved.rotation.z).toBe(90)

    const geometry = useCamStore.getState().project.geometry
    expect(resolveSketchEditorOffset(geometry, layerId)).toEqual({ x: 0, y: 0, rotationDeg: 0 })
  })

  it('a genuine nest-seed-owned geometry keeps its slot-pose offset (deliberate ADR 0024 behavior)', () => {
    const layerId = 'L-seed'
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [...s.project.geometry, makeNestSeedGeoWithSketchLayer('seed1', layerId, 'nest1')],
      },
    }))

    // Pose the seed at its (simulated) nest placement slot -- moving stays allowed for
    // nest seeds too (updateGeometryTransform is not restricted by ownerNestId).
    useCamStore.getState().updateGeometryTransform(
      'seed1',
      { x: 33, y: 17, z: 0 },
      { x: 0, y: 0, z: 15 },
    )

    const geometry = useCamStore.getState().project.geometry
    expect(resolveSketchEditorOffset(geometry, layerId)).toEqual({ x: 33, y: 17, rotationDeg: 15 })
  })

  it('returns undefined when no owner geometry is found for the layer (caller falls back to identity)', () => {
    const geometry = useCamStore.getState().project.geometry
    expect(resolveSketchEditorOffset(geometry, 'no-such-layer')).toBeUndefined()
  })
})
