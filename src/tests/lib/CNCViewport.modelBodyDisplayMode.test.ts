import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ModelBodyDisplay } from '../../types'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import {
  MODELED_BODY_REST_EDGE_HEX,
  MODELED_BODY_EDGE_RENDER_ORDER,
  MODELED_BODY_WIREFRAME_EDGE_HEX,
  MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX,
} from '../../lib/viewport/lighting/bodyVisualStyle'
import {
  makeFilletedStepEdgeFixture,
} from '../../viewport3d/fixtures'
import type { TessBuffers } from '../../viewport3d/types'

interface ViewportHarness {
  partGroups: Map<string, THREE.Group>
  partMaterials: Map<string, THREE.MeshStandardMaterial>
  workpieceGroup: THREE.Group
  stockGroup: THREE.Group
  colors: { workpiece: number; workpieceEdge: number }
  materialBaselines: Map<THREE.MeshStandardMaterial, unknown>
  currentShadingMode: string
  updateSelectableObjects: () => void
  maybeAutoFit: () => void
  rebuildStock: () => void
  // GEO-25: viewport display theme bookkeeping -- this harness bypasses the
  // real constructor (Object.create), so these Map fields need stubbing too
  // (resolvePartTheme() itself degrades a missing/invalid viewportThemeId to
  // classic on its own; only the Maps are hard-required by addSTL/
  // addBrepModel/addModelBody's unconditional `.set()` calls).
  viewportThemeId: string
  partUsesThemeColor: Map<string, boolean>
  partEdgePositions: Map<string, Float32Array>
  renderer: {
    localClippingEnabled: boolean
    domElement: { getBoundingClientRect(): { width: number; height: number } }
    getPixelRatio(): number
  }
}

function modeledDisplay(buffers: TessBuffers): ModelBodyDisplay {
  return {
    positions: Array.from(buffers.position),
    normals: Array.from(buffers.normal),
    indices: Array.from(buffers.index),
    edgePositions: Array.from(buffers.edgePositions),
    edgeOffsets: Array.from(buffers.edgeOffsets),
    edgeIds: [...buffers.edgeIds],
    bbox: { min: [-20, -10, -10], max: [20, 10, 10] },
  }
}

function makeHarness(): CNCViewport {
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  Object.assign(vp as unknown as ViewportHarness, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map<string, THREE.MeshStandardMaterial>(),
    workpieceGroup: new THREE.Group(),
    stockGroup: new THREE.Group(),
    colors: { workpiece: 0x8a9bb0, workpieceEdge: 0x42546a },
    materialBaselines: new Map<THREE.MeshStandardMaterial, unknown>(),
    currentShadingMode: 'shaded-edges',
    updateSelectableObjects: () => {},
    maybeAutoFit: () => {},
    rebuildStock: () => {},
    viewportThemeId: 'classic',
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    partInteractionOutlines: new Map(),
    brepHoverObj: null,
    brepHoverKey: null,
    brepHighlights: new Map(),
    renderer: {
      localClippingEnabled: false,
      domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      getPixelRatio: () => 1,
    },
    clipPlane: new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
  })
  return vp
}

function segmentEndpoints(overlay: THREE.LineSegments | LineSegments2): number[] {
  if (!(overlay instanceof LineSegments2)) {
    return Array.from(overlay.geometry.getAttribute('position').array as ArrayLike<number>)
  }
  const geometry = overlay.geometry as LineSegmentsGeometry
  const starts = geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
  const ends = geometry.getAttribute('instanceEnd') as THREE.InterleavedBufferAttribute
  const points: number[] = []
  for (let i = 0; i < starts.count; i += 1) {
    points.push(
      starts.getX(i), starts.getY(i), starts.getZ(i),
      ends.getX(i), ends.getY(i), ends.getZ(i),
    )
  }
  return points
}

function addGenericPart(vp: CNCViewport, id: string) {
  const material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material)
  const edgeLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial(),
  )
  edgeLines.userData.isDisplayEdge = true
  mesh.add(edgeLines)
  const group = new THREE.Group()
  group.add(mesh)
  const harness = vp as unknown as ViewportHarness
  harness.partGroups.set(id, group)
  harness.partMaterials.set(id, material)
  return { material, edgeLines }
}

function addStock(vp: CNCViewport) {
  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
  })
  const fill = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), material)
  const edgeLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(fill.geometry),
    new THREE.LineBasicMaterial(),
  )
  edgeLines.userData.isDisplayEdge = true
  const group = new THREE.Group()
  group.add(edgeLines, fill)
  ;(vp as unknown as ViewportHarness).stockGroup.add(group)
  return { material, edgeLines }
}

describe('UI-84 CAM modeled-body display mode', () => {
  it('swaps native shaded topology to fat wireframe and back without drawing triangles', () => {
    const vp = makeHarness()
    const fixture = makeFilletedStepEdgeFixture()
    vp.addModelBody('modelbody:F1', modeledDisplay(fixture.buffers), 'Extrude F1')

    const harness = vp as unknown as ViewportHarness
    const group = harness.partGroups.get('modelbody:F1')
    expect(group).toBeDefined()
    const mesh = group!.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh)
    expect(mesh).toBeDefined()
    const shadedEdge = mesh!.children.find(
      (child): child is THREE.LineSegments => child instanceof THREE.LineSegments && child.userData.isDisplayEdge === true,
    )!
    const shadedMaterial = shadedEdge.material as THREE.LineBasicMaterial
    const shadedEndpoints = segmentEndpoints(shadedEdge)
    expect(shadedEdge).toBeInstanceOf(THREE.LineSegments)
    expect(shadedEdge).not.toBeInstanceOf(LineSegments2)
    expect(shadedEdge.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect(shadedEndpoints).toHaveLength(141 * 6)
    expect(shadedMaterial.color.getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
    expect(shadedMaterial.opacity).toBe(0.72)
    expect(shadedMaterial.depthTest).toBe(true)
    expect(shadedMaterial.depthWrite).toBe(false)
    const shadedGeometryDispose = vi.spyOn(shadedEdge.geometry, 'dispose')
    const shadedMaterialDispose = vi.spyOn(shadedMaterial, 'dispose')

    vp.setShadingMode('unshaded')
    const wireEdge = mesh!.children.find(
      (child): child is LineSegments2 => child instanceof LineSegments2 && child.userData.isDisplayEdge === true,
    )!
    const wireMaterial = wireEdge.material as LineMaterial
    expect(wireEdge).not.toBe(shadedEdge)
    expect(shadedGeometryDispose).toHaveBeenCalledOnce()
    expect(shadedMaterialDispose).toHaveBeenCalledOnce()
    const bodyMaterial = mesh!.material as THREE.MeshStandardMaterial
    expect(mesh!.userData.isModelBodyMesh).toBe(true)
    expect(mesh!.visible).toBe(true)
    expect(bodyMaterial.wireframe).toBe(false)
    expect(bodyMaterial.transparent).toBe(true)
    expect(bodyMaterial.opacity).toBe(0)
    expect(bodyMaterial.depthWrite).toBe(false)
    expect(wireEdge.visible).toBe(true)
    expect(wireEdge.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect(segmentEndpoints(wireEdge)).toEqual(shadedEndpoints)
    expect(wireMaterial.color.getHexString()).toBe(MODELED_BODY_WIREFRAME_EDGE_HEX.slice(1))
    expect(wireMaterial.opacity).toBe(1)
    expect(wireMaterial.linewidth).toBe(MODELED_BODY_WIREFRAME_EDGE_WIDTH_PX)
    expect(wireMaterial.depthTest).toBe(false)
    expect(wireMaterial.depthWrite).toBe(false)
    const wireGeometryDispose = vi.spyOn(wireEdge.geometry, 'dispose')
    const wireMaterialDispose = vi.spyOn(wireMaterial, 'dispose')

    vp.setShadingMode('shaded-edges')
    const restoredEdge = mesh!.children.find(
      (child): child is THREE.LineSegments => child instanceof THREE.LineSegments && child.userData.isDisplayEdge === true,
    )!
    const restoredMaterial = restoredEdge.material as THREE.LineBasicMaterial
    expect(restoredEdge).not.toBe(wireEdge)
    expect(restoredEdge).not.toBeInstanceOf(LineSegments2)
    expect(restoredEdge.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect(wireGeometryDispose).toHaveBeenCalledOnce()
    expect(wireMaterialDispose).toHaveBeenCalledOnce()
    expect(segmentEndpoints(restoredEdge)).toEqual(shadedEndpoints)
    expect(restoredMaterial.color.getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
    expect(restoredMaterial.opacity).toBe(0.72)
    expect(restoredMaterial.depthTest).toBe(true)
    expect(restoredMaterial.depthWrite).toBe(false)

    vp.setShadingMode('translucent')
    const translucentEdge = mesh!.children.find(
      (child): child is THREE.LineSegments => child instanceof THREE.LineSegments && child.userData.isDisplayEdge === true,
    )!
    expect(translucentEdge).toBe(restoredEdge)
    expect(translucentEdge.visible).toBe(true)
    expect(translucentEdge.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect(translucentEdge.renderOrder).toBeGreaterThan(mesh!.renderOrder)
  })

  it('preserves active section clipping through native-fat-native edge swaps', () => {
    const vp = makeHarness()
    const fixture = makeFilletedStepEdgeFixture()
    vp.addModelBody('modelbody:F1', modeledDisplay(fixture.buffers), 'Extrude F1')
    const harness = vp as unknown as ViewportHarness
    const mesh = harness.partGroups.get('modelbody:F1')!.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    )!

    vp.setSectionView({ enabled: true, axis: 'x', position: 2, flip: false })
    const activePlane = (mesh.material as THREE.Material).clippingPlanes![0]
    const shadedEdge = mesh.children.find((child) => child.userData.isDisplayEdge === true) as THREE.LineSegments
    expect((shadedEdge.material as THREE.Material).clippingPlanes).toEqual([activePlane])

    vp.setShadingMode('unshaded')
    const wireEdge = mesh.children.find((child) => child.userData.isDisplayEdge === true) as LineSegments2
    expect(wireEdge).toBeInstanceOf(LineSegments2)
    expect((wireEdge.material as THREE.Material).clippingPlanes).toEqual([activePlane])

    vp.setShadingMode('shaded-edges')
    const restoredEdge = mesh.children.find((child) => child.userData.isDisplayEdge === true) as THREE.LineSegments
    expect(restoredEdge).not.toBeInstanceOf(LineSegments2)
    expect((restoredEdge.material as THREE.Material).clippingPlanes).toEqual([activePlane])

    vp.setSectionView({ enabled: false, axis: 'x', position: 2, flip: false })
    expect((restoredEdge.material as THREE.Material).clippingPlanes).toEqual([])
  })

  it('keeps generic imported parts on the established material and edge route', () => {
    const vp = makeHarness()
    const { material, edgeLines } = addGenericPart(vp, 'imported:part')

    vp.setShadingMode('unshaded')
    expect({
      wireframe: material.wireframe,
      transparent: material.transparent,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
      edgesVisible: edgeLines.visible,
    }).toEqual({
      wireframe: true,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      edgesVisible: false,
    })

    vp.setShadingMode('translucent')
    expect({
      wireframe: material.wireframe,
      transparent: material.transparent,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
      edgesVisible: edgeLines.visible,
    }).toEqual({
      wireframe: false,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      edgesVisible: true,
    })
  })

  it('keeps stock on the established material and edge route', () => {
    const vp = makeHarness()
    const { material, edgeLines } = addStock(vp)

    vp.setShadingMode('unshaded')
    expect({
      wireframe: material.wireframe,
      transparent: material.transparent,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
      edgesVisible: edgeLines.visible,
    }).toEqual({
      wireframe: true,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      edgesVisible: false,
    })

    vp.setShadingMode('translucent')
    expect({
      wireframe: material.wireframe,
      transparent: material.transparent,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
      edgesVisible: edgeLines.visible,
    }).toEqual({
      wireframe: false,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      edgesVisible: true,
    })
  })
})
