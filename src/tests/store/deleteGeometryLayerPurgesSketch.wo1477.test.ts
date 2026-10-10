// WO-1477: deleteGeometryLayer filtered geo.layers2d and geo.loops by the
// deleted layerId but never touched geo.sketches (the parametric-sketch-
// per-layer array, one document per layer, keyed by Sketch.layerId — see
// src/types/index.ts). The deleted layer's authored sketch document
// survived in the saved project with a layerId that no longer resolved to
// any layer. This asserts the same filter now applies to geo.sketches, and
// that a sketch belonging to a DIFFERENT (surviving) layer is untouched.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Loop2D, Layer2D } from '../../types'
import type { Sketch } from '../../lib/sketch/types'

const state = () => useCamStore.getState()
const geo = (id: string) => state().project.geometry.find(g => g.id === id)!

function squareLoop(id: string, layerId: string, x0: number, y0: number, s: number): Loop2D {
  return {
    id,
    points: [
      { x: x0, y: y0 }, { x: x0 + s, y: y0 },
      { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s },
    ],
    closed: true, type: 'contour', layerId, area: s * s,
  }
}

function sketchFor(id: string, layerId: string): Sketch {
  // solveStatus is required on Sketch; null is the codebase's own 'never solved'
  // fixture value (contourNoViolation, loop-consumer-census, wholeSketchExtrudeHoles).
  return { id, layerId, entities: [], constraints: [], dimensions: [], solveStatus: null }
}

function make2DGeoWithSketches(): ImportedGeometry {
  const layers: Layer2D[] = [
    { id: 'L-a', name: 'A', color: '#00ffff', visible: true, sourceType: 'sketch' },
    { id: 'L-b', name: 'B', color: '#ff00ff', visible: true, sourceType: 'sketch' },
  ]
  return {
    id: 'geo-1', name: 'Part', filename: 'part.svg', type: 'curves_2d', format: 'svg',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [
      squareLoop('loop-a', 'L-a', 0, 0, 10),
      squareLoop('loop-b', 'L-b', 0, 0, 10),
    ],
    layers2d: layers,
    sketches: [sketchFor('sketch-a', 'L-a'), sketchFor('sketch-b', 'L-b')],
  }
}

beforeEach(() => {
  useCamStore.setState(s => ({ project: { ...s.project, geometry: [] } }))
})

describe('deleteGeometryLayer purges the deleted layer\'s sketch (WO-1477)', () => {
  it('removes only the deleted layer\'s sketch document, leaving the other layer\'s sketch untouched', () => {
    useCamStore.setState(s => ({ project: { ...s.project, geometry: [make2DGeoWithSketches()] } }))

    state().deleteGeometryLayer('geo-1', 'L-a')

    const g = geo('geo-1')
    expect(g.sketches?.map(sk => sk.layerId)).toEqual(['L-b'])
    expect(g.sketches?.find(sk => sk.id === 'sketch-b')).toBeDefined()
  })

  it('leaves geo.sketches untouched when the geometry has no sketches at all', () => {
    const base = make2DGeoWithSketches()
    delete base.sketches
    useCamStore.setState(s => ({ project: { ...s.project, geometry: [base] } }))

    state().deleteGeometryLayer('geo-1', 'L-a')

    expect(geo('geo-1').sketches).toBeUndefined()
  })

  it('undo (pushHistory before delete) restores the deleted layer\'s sketch along with the layer and loops', () => {
    useCamStore.setState(s => ({ project: { ...s.project, geometry: [make2DGeoWithSketches()] } }))

    state().pushHistory()
    state().deleteGeometryLayer('geo-1', 'L-a')
    expect(geo('geo-1').sketches?.map(sk => sk.layerId)).toEqual(['L-b'])

    state().undo()

    const g = geo('geo-1')
    expect(g.sketches?.map(sk => sk.layerId).sort()).toEqual(['L-a', 'L-b'])
    expect(g.layers2d?.map(l => l.id).sort()).toEqual(['L-a', 'L-b'])
    expect(g.loops?.map(lp => lp.id).sort()).toEqual(['loop-a', 'loop-b'])
  })
})
