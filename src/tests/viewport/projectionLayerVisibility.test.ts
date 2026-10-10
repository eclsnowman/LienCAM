// B13 (docs/planning/POST-MERGE-WORKPLAN.md): the hide/show (eye) toggle on an
// STL-PROJECTION layer did not hide the projected curves in the viewport;
// plain SVG/DXF layer toggles worked.
//
// Root cause: projection layers (Layer2D.projectionPlane set) render through
// CNCViewport.setPartLoopsOnFacePlane into _worldPlaneLoopGroups (world-baked
// STL projections) / _geoLocalLoopGroups (B-rep 'geometry_local' derives) -
// NOT through geometry2dLayerMats (plain 2D imports) or projectedLoopGroups
// (local STL overlay). set2DLayerVisible - the method DesignTree's eye handler
// calls - only touched the latter two, and setPartLoopsOnFacePlane never
// tagged its lines with userData.layerId, so there was nothing to find. The
// store flag flipped (tooltip changed) but every line material stayed visible.
// Viewport.tsx's re-render effect keys on loops length/version only, so no
// rebuild rescued the toggle either.
//
// These tests drive the REAL user path (typedZTransform.test.ts conventions):
// the real store toggleGeometryLayer action + the real CNCViewport prototype
// methods bound to a minimal instance, asserting the THREE material visibility
// actually flips - for a projection-derived layer AND for a plain layer.

import * as THREE from 'three'
import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ImportedGeometry, Layer2D, Loop2D, ProjectionPlane } from '../../types'

// -- Minimal real-method viewport ---------------------------------------------

interface VpUnderTest {
  add2DGeometry: CNCViewport['add2DGeometry']
  setPartLoopsOnFacePlane: CNCViewport['setPartLoopsOnFacePlane']
  set2DLayerVisible: CNCViewport['set2DLayerVisible']
  geometry2dGroups: Map<string, THREE.Group>
  geometry2dLayerMats: Map<string, Map<string, THREE.LineBasicMaterial[]>>
  _worldPlaneLoopGroups: Map<string, THREE.Group>
  _geoLocalLoopGroups: Map<string, THREE.Group>
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    scene: new THREE.Scene(),
    partGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    sketchEditLayerId: null,
    selectedPartId: null,
    workpieceGroup: new THREE.Group(),
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    fitCameraToObject: () => {},
  })
  return vp as VpUnderTest
}

// Visibility of every line material the given layer owns inside a group tree.
function lineVisibilities(group: THREE.Group | undefined, layerId: string): boolean[] {
  const out: boolean[] = []
  group?.traverse(c => {
    if (c instanceof THREE.Line && c.userData.layerId === layerId) {
      out.push((c.material as THREE.LineBasicMaterial).visible)
    }
  })
  return out
}

// -- Store fixtures ------------------------------------------------------------

const PLANE: ProjectionPlane = {
  origin: { x: 0, y: 0, z: 10 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
}

function loop(id: string, layerId: string): Loop2D {
  return {
    id, layerId, closed: true, type: 'contour', area: 100,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  }
}

const projLayer: Layer2D = {
  id: 'proj-1', name: 'STL Projection 1', color: '#00e5ff', visible: true,
  projectionPlane: PLANE,
}
const projLayer2: Layer2D = {
  id: 'proj-2', name: 'STL Projection 2', color: '#ff8c00', visible: true,
  projectionPlane: PLANE,
}
const localLayer: Layer2D = {
  id: 'derive-1', name: 'Section z=5', color: '#44ff88', visible: true,
  projectionPlane: PLANE, frame: 'geometry_local',
}
const plainLayer: Layer2D = { id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }

function makeStlGeo(): ImportedGeometry {
  return {
    id: 'geo-stl', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [loop('pl-1', 'proj-1'), loop('pl-2', 'proj-1'), loop('pl-3', 'proj-2'), loop('ll-1', 'derive-1')],
    layers2d: [projLayer, projLayer2, localLayer],
  }
}

function makeDxfGeo(): ImportedGeometry {
  return {
    id: 'geo-dxf', name: 'Sketch', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [loop('dl-1', 'L1')],
    layers2d: [plainLayer],
  }
}

const state = () => useCamStore.getState()
const storeLayer = (geoId: string, layerId: string) =>
  state().project.geometry.find(g => g.id === geoId)!.layers2d!.find(l => l.id === layerId)!

// DesignTree.handleToggleVisible, verbatim: store flag + viewport call.
function clickEye(vp: VpUnderTest, geoId: string, layerId: string) {
  const layer = storeLayer(geoId, layerId)
  state().toggleGeometryLayer(geoId, layerId)
  vp.set2DLayerVisible(geoId, layerId, !layer.visible)
}

describe('B13: eye toggle hides/shows projection-derived layers in the viewport', () => {
  let vp: VpUnderTest

  beforeEach(() => {
    useCamStore.setState(s => ({
      project: { ...s.project, geometry: [makeStlGeo(), makeDxfGeo()] },
    }))
    vp = makeVp()
    const stl = state().project.geometry.find(g => g.id === 'geo-stl')!
    // Viewport.tsx STL-loop effect, verbatim routing: projectionPlane layers
    // go through the face-plane renderer.
    vp.setPartLoopsOnFacePlane(stl.id, stl.loops!, stl.layers2d!)
    const dxf = state().project.geometry.find(g => g.id === 'geo-dxf')!
    vp.add2DGeometry(dxf.id, dxf.loops!, dxf.layers2d!, dxf.position, dxf.rotation)
  })

  it('world-baked STL projection layer: THREE line visibility flips with the toggle', () => {
    const group = vp._worldPlaneLoopGroups.get('geo-stl')
    expect(lineVisibilities(group, 'proj-1')).toEqual([true, true])

    clickEye(vp, 'geo-stl', 'proj-1')
    expect(storeLayer('geo-stl', 'proj-1').visible).toBe(false)
    // The bug: these stayed [true, true] - tooltip flipped, curves did not.
    expect(lineVisibilities(group, 'proj-1')).toEqual([false, false])

    clickEye(vp, 'geo-stl', 'proj-1')
    expect(storeLayer('geo-stl', 'proj-1').visible).toBe(true)
    expect(lineVisibilities(group, 'proj-1')).toEqual([true, true])
  })

  it('only the toggled projection layer is affected (sibling stays visible)', () => {
    const group = vp._worldPlaneLoopGroups.get('geo-stl')
    clickEye(vp, 'geo-stl', 'proj-1')
    expect(lineVisibilities(group, 'proj-1')).toEqual([false, false])
    expect(lineVisibilities(group, 'proj-2')).toEqual([true])
  })

  it('geometry-local derived layer (B-rep section path) flips too', () => {
    const local = vp._geoLocalLoopGroups.get('geo-stl')
    expect(lineVisibilities(local, 'derive-1')).toEqual([true])

    clickEye(vp, 'geo-stl', 'derive-1')
    expect(storeLayer('geo-stl', 'derive-1').visible).toBe(false)
    expect(lineVisibilities(local, 'derive-1')).toEqual([false])
  })

  it('plain DXF layer still works (materials-map path, regression guard)', () => {
    const mats = vp.geometry2dLayerMats.get('geo-dxf')!.get('L1')!
    expect(mats.every(m => m.visible)).toBe(true)

    clickEye(vp, 'geo-dxf', 'L1')
    expect(storeLayer('geo-dxf', 'L1').visible).toBe(false)
    expect(mats.every(m => !m.visible)).toBe(true)

    clickEye(vp, 'geo-dxf', 'L1')
    expect(storeLayer('geo-dxf', 'L1').visible).toBe(true)
    expect(mats.every(m => m.visible)).toBe(true)
  })

  it('a scene rebuild while hidden honors the store flag (no resurrection)', () => {
    clickEye(vp, 'geo-stl', 'proj-1')
    // Viewport.tsx re-runs the renderer on loops change; it passes the store
    // layers, whose visible flag the toggle updated.
    const stl = state().project.geometry.find(g => g.id === 'geo-stl')!
    vp.setPartLoopsOnFacePlane(stl.id, stl.loops!, stl.layers2d!)
    const group = vp._worldPlaneLoopGroups.get('geo-stl')
    expect(lineVisibilities(group, 'proj-1')).toEqual([false, false])
    expect(lineVisibilities(group, 'proj-2')).toEqual([true])
  })
})
