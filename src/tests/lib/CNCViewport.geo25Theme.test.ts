// GEO-25 / GEO-25b (Q-50 viewport display theme + Operator's reopen): CAM-viewport
// half. Verifies resolvePartTheme/setViewportTheme through the real
// add*/setViewportTheme public API (never the private methods directly)
// using the same Object.create(CNCViewport.prototype) harness the sibling
// CNCViewport.modelBodyDisplayMode.test.ts / geometry3dMoveGizmoPivot.test.ts
// files already use to avoid the real (DOM/WebGL-heavy) constructor.
//
// Coverage:
//   - classic keeps its body color while modeled topology is promoted to the
//     same fat-line technique required by the wireframe width contract.
//   - a non-classic theme paints the shared Q-50 card body/edge hex and
//     switches addModelBody's edges to the fat LineSegments2 technique.
//   - GEO-25b: addBrepModel's VISIBLE edge now goes fat on a non-classic
//     theme too (Operator rejected the thin-forever deferral), but it ALWAYS
//     keeps a second, invisible, always-thin THREE.LineSegments pick twin
//     (userData.isBrepEdges) alongside it -- Stage-2 edge picking
//     (collectBrepObjects) finds that twin by
//     `instanceof THREE.LineSegments && userData.isBrepEdges` regardless of
//     `.visible`, so picking never breaks. On 'classic' there is no second
//     object: the pick twin IS the visible edge (byte-identical control).
//   - a part with an EXPLICIT color override is never re-tinted by a theme
//     switch; a part on the theme default is.

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { ModelBodyDisplay } from '../../types'
import type { ViewportThemeId } from '../../lib/viewport/lighting/viewportThemes'
import {
  MODELED_BODY_EDGE_RENDER_ORDER,
  MODELED_BODY_REST_EDGE_HEX,
} from '../../lib/viewport/lighting/bodyVisualStyle'

// applyBodyAO (addBrepModel/addModelBody both call it) reads `window` in DEV
// builds for a debug probe -- same stub geometry3dMoveGizmoPivot.test.ts uses.
vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

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
  viewportThemeId: ViewportThemeId
  partUsesThemeColor: Map<string, boolean>
  partEdgePositions: Map<string, Float32Array>
  renderer: {
    localClippingEnabled: boolean
    domElement: { getBoundingClientRect: () => { width: number; height: number } }
    getPixelRatio: () => number
  }
}

function makeHarness(themeId: ViewportThemeId = 'classic'): CNCViewport {
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  Object.assign(vp as unknown as ViewportHarness, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map<string, THREE.MeshStandardMaterial>(),
    workpieceGroup: new THREE.Group(),
    stockGroup: new THREE.Group(),
    colors: { workpiece: 0x8ab4cc, workpieceEdge: 0xbfd8ec },
    materialBaselines: new Map<THREE.MeshStandardMaterial, unknown>(),
    currentShadingMode: 'shaded-edges',
    updateSelectableObjects: () => {},
    maybeAutoFit: () => {},
    rebuildStock: () => {},
    viewportThemeId: themeId,
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    partInteractionOutlines: new Map(),
    brepHoverObj: null,
    brepHoverKey: null,
    brepHighlights: new Map(),
    // buildPartEdgeOverlay's fat branch reads this to size LineMaterial.resolution.
    renderer: {
      localClippingEnabled: false,
      domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      getPixelRatio: () => 1,
    },
    clipPlane: new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    // addBrepModel re-attaches any pre-existing geometry-local derived-loop
    // overlay for this id (unrelated to GEO-25; just a field it dereferences).
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
  })
  return vp
}

type V3 = [number, number, number]

/** Box with exactly ONE edge segment (2 points) -- enough to exercise the
 *  edge-overlay construction path without a full 12-edge box. */
function boxDisplayWithOneEdge(min: V3, max: V3): ModelBodyDisplay {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]
  return {
    positions,
    normals: new Array(positions.length).fill(0),
    indices: [0, 1, 2, 4, 5, 6],
    edgePositions: [x0, y0, z0, x1, y1, z1],
    edgeOffsets: [0, 2],
    bbox: { min, max },
  }
}

function boxBrepPayloadWithOneEdge(min: V3, max: V3): BrepModelPayload {
  const d = boxDisplayWithOneEdge(min, max)
  return {
    faceCount: 1,
    edgeCount: 1,
    solidCount: 1,
    bbox: { min, max },
    mesh: {
      positions: new Float32Array(d.positions),
      normals: new Float32Array(d.normals),
      indices: new Uint32Array(d.indices),
      faceRanges: new Uint32Array([0, d.indices.length]),
    },
    edges: {
      positions: new Float32Array([min[0], min[1], min[2], max[0], max[1], max[2]]),
      edgeRanges: new Uint32Array([0, 2]),
    },
    faceTypes: new Uint8Array([0]),
  }
}

function edgeChildOf(mesh: THREE.Mesh): THREE.Object3D | undefined {
  return mesh.children.find((c) => c.userData?.isDisplayEdge === true)
}

function isFatLine(obj: THREE.Object3D | undefined): boolean {
  return obj !== undefined && typeof (obj as { geometry?: { setPositions?: unknown } }).geometry?.setPositions === 'function'
}

/** The always-present, always-thin Stage-2 edge-picking twin (GEO-25b) --
 *  never fat; visible in shaded modes and visually replaced in wireframe. */
function pickTwinOf(mesh: THREE.Mesh): THREE.LineSegments | undefined {
  return mesh.children.find(
    (c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.userData?.isBrepEdges === true
  )
}

describe('GEO-25 CAM viewport theme', () => {
  it('classic: addModelBody keeps the classic body color with native shaded topology', () => {
    const vp = makeHarness('classic')
    vp.addModelBody('modelbody:F1', boxDisplayWithOneEdge([0, 0, 0], [10, 10, 10]), 'Body')
    const harness = vp as unknown as ViewportHarness
    const group = harness.partGroups.get('modelbody:F1')!
    const mesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!
    const material = mesh.material as THREE.MeshStandardMaterial
    expect(material.color.getHex()).toBe(harness.colors.workpiece)
    const edge = edgeChildOf(mesh)
    expect(edge).toBeDefined()
    expect(isFatLine(edge)).toBe(false)
  })

  it('brand-blue: addModelBody gets the shared Q-50 hex + native shaded edges', () => {
    const vp = makeHarness('brand-blue')
    vp.addModelBody('modelbody:F1', boxDisplayWithOneEdge([0, 0, 0], [10, 10, 10]), 'Body')
    const harness = vp as unknown as ViewportHarness
    const group = harness.partGroups.get('modelbody:F1')!
    const mesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!
    const material = mesh.material as THREE.MeshStandardMaterial
    expect(material.color.getHexString()).toBe('7ec0ff')
    const edge = edgeChildOf(mesh)
    expect(isFatLine(edge)).toBe(false)
  })

  it('classic: addBrepModel edge is a SINGLE thin, visible, pickable object (byte-identical control)', () => {
    const vp = makeHarness('classic')
    vp.addBrepModel('step:S0', boxBrepPayloadWithOneEdge([0, 0, 0], [10, 10, 10]), 'Step')
    const harness = vp as unknown as ViewportHarness
    const group = harness.partGroups.get('step:S0')!
    const mesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!
    const pickTwin = pickTwinOf(mesh)
    expect(pickTwin).toBeDefined()
    expect(pickTwin!.visible).toBe(true)
    expect(pickTwin!.userData.isDisplayEdge).toBe(true) // it IS the visible edge
    expect(isFatLine(pickTwin)).toBe(false)
    // No second (fat) edge object exists on classic.
    const fatSiblings = mesh.children.filter((c) => c.userData?.isBrepFatEdge === true)
    expect(fatSiblings.length).toBe(0)
    const edgeMat = pickTwin!.material as THREE.LineBasicMaterial
    expect(edgeMat.color.getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
  })

  it('deep-slate addBrepModel uses its native pick twin as the visible shaded edge', () => {
    const vp = makeHarness('deep-slate')
    vp.addBrepModel('step:S1', boxBrepPayloadWithOneEdge([0, 0, 0], [10, 10, 10]), 'Step')
    const harness = vp as unknown as ViewportHarness
    const group = harness.partGroups.get('step:S1')!
    const mesh = group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!

    const visibleEdge = edgeChildOf(mesh)
    expect(visibleEdge).toBeDefined()
    expect(isFatLine(visibleEdge)).toBe(false)
    expect(visibleEdge!.userData.isBrepEdges).toBe(true)

    // The native Stage-2 picking twin also serves as shaded topology.
    const pickTwin = pickTwinOf(mesh)
    expect(pickTwin).toBeDefined()
    expect(isFatLine(pickTwin)).toBe(false)
    expect(pickTwin!.visible).toBe(true)
    expect(pickTwin!.userData.isDisplayEdge).toBe(true)
    expect(mesh.children.some((child) => child.userData.isBrepFatEdge === true)).toBe(false)

    // Its resting topology color follows the shared modeled-body policy.
    const pickMat = pickTwin!.material as THREE.LineBasicMaterial
    expect(pickMat.color.getHexString()).toBe(MODELED_BODY_REST_EDGE_HEX.slice(1))
  })

  it('B-rep mode transitions replace native shading with fat wireframe and restore the pick twin', () => {
    const vp = makeHarness('classic')
    vp.addBrepModel('step:S2', boxBrepPayloadWithOneEdge([0, 0, 0], [10, 10, 10]), 'Step')
    const harness = vp as unknown as ViewportHarness
    const mesh = harness.partGroups.get('step:S2')!.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!

    let pickTwin = pickTwinOf(mesh)
    expect(pickTwin).toBeDefined()
    expect(pickTwin!.visible).toBe(true)
    expect(pickTwin!.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect(isFatLine(edgeChildOf(mesh))).toBe(false)

    vp.setSectionView({ enabled: true, axis: 'z', position: 4, flip: false })
    const activePlane = (mesh.material as THREE.Material).clippingPlanes![0]
    expect((pickTwin!.material as THREE.Material).clippingPlanes).toEqual([activePlane])

    vp.setShadingMode('unshaded')
    pickTwin = pickTwinOf(mesh)
    expect(pickTwin).toBeDefined()
    expect(pickTwin!.visible).toBe(false)
    const wire = edgeChildOf(mesh)
    expect(wire).toBeInstanceOf(THREE.Mesh)
    expect(isFatLine(wire)).toBe(true)
    expect(wire!.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect((wire as LineSegments2).material).toMatchObject({
      depthTest: false,
      depthWrite: false,
    })
    expect(((wire as LineSegments2).material as THREE.Material).clippingPlanes).toEqual([activePlane])
    const geometryDispose = vi.spyOn((wire as LineSegments2).geometry, 'dispose')
    const materialDispose = vi.spyOn((wire as LineSegments2).material, 'dispose')

    vp.setShadingMode('shaded-edges')
    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(materialDispose).toHaveBeenCalledOnce()
    pickTwin = pickTwinOf(mesh)
    expect(pickTwin).toBeDefined()
    expect(pickTwin!.visible).toBe(true)
    expect(pickTwin!.renderOrder).toBe(MODELED_BODY_EDGE_RENDER_ORDER)
    expect((pickTwin!.material as THREE.Material).clippingPlanes).toEqual([activePlane])
    expect(edgeChildOf(mesh)).toBe(pickTwin)
    expect(mesh.children.some((child) => child.userData.isBrepFatEdge === true)).toBe(false)
  })

  it('setViewportTheme re-tints a part on the theme default, but never one with an explicit color override', () => {
    const vp = makeHarness('classic')
    vp.addModelBody('modelbody:default', boxDisplayWithOneEdge([0, 0, 0], [10, 10, 10]), 'Default')
    vp.addModelBody('modelbody:custom', boxDisplayWithOneEdge([20, 0, 0], [30, 10, 10]), 'Custom', undefined, undefined, '#ff00ff')
    const harness = vp as unknown as ViewportHarness

    vp.setViewportTheme('brand-blue')

    const defaultMesh = harness.partGroups.get('modelbody:default')!.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!
    expect((defaultMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('7ec0ff')
    expect(isFatLine(edgeChildOf(defaultMesh))).toBe(false)

    const customMesh = harness.partGroups.get('modelbody:custom')!.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!
    expect((customMesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff00ff')
    // The custom color remains untouched. Shaded topology stays native in
    // every theme, independently of whether body paint is theme-owned.
    expect(isFatLine(edgeChildOf(customMesh))).toBe(false)
  })

  it('setViewportTheme round-trips the default body color without changing the shaded topology renderer', () => {
    const vp = makeHarness('classic')
    vp.addModelBody('modelbody:F1', boxDisplayWithOneEdge([0, 0, 0], [10, 10, 10]), 'Body')
    const harness = vp as unknown as ViewportHarness
    const mesh = harness.partGroups.get('modelbody:F1')!.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!

    vp.setViewportTheme('brand-blue')
    expect(isFatLine(edgeChildOf(mesh))).toBe(false)

    vp.setViewportTheme('classic')
    expect(isFatLine(edgeChildOf(mesh))).toBe(false)
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(harness.colors.workpiece)

    vp.setViewportTheme('brand-blue')
    expect(isFatLine(edgeChildOf(mesh))).toBe(false)
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('7ec0ff')
  })
})
