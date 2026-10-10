// CAM-BINDING Stage 5: model-body face picking in the CAM viewport.
// resolveBrepHit/collectBrepObjects gain a PARALLEL path for a model-pick
// mesh (addModelBody, tagged only when ModelBodyDisplay carries the new
// faceIds/triFace arrays) - a direct O(1) triFace lookup, never occt-model's
// faceRanges/faceTypes, so the two identity systems never cross. Mirrors
// CNCViewport.geo25bEdgePicking.test.ts's bare-harness pattern (no real
// WebGLRenderer in this repo's test env).

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ModelBodyDisplay } from '../../types'

vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

interface PickHarness {
  partGroups: Map<string, THREE.Group>
  raycaster: THREE.Raycaster
  resolveBrepHit: () => { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean } | null
  buildBrepHighlight: (
    geoId: string, kind: 'face' | 'edge', index: number, variant?: 'picked' | 'hover'
  ) => THREE.Object3D | null
}
function priv(vp: CNCViewport): PickHarness {
  return vp as unknown as PickHarness
}

function makeHarness(): CNCViewport {
  const vp = Object.create(CNCViewport.prototype) as CNCViewport
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  camera.zoom = 1
  camera.updateProjectionMatrix()
  Object.assign(vp, {
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
    viewportThemeId: 'classic',
    selectionGlow: 'current' as const,
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    // partInteractionVariant reads these class fields; Object.create skips
    // the initializers.
    partPickSelectedIds: new Set<string>(),
    partPickHoverId: null,
    renderer: {
      domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }), clientHeight: 500 },
      getPixelRatio: () => 1,
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    },
    camera,
    raycaster: new THREE.Raycaster(),
    brepPickKind: 'face' as const,
    brepPickAllowedGeoId: null,
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
  })
  return vp
}

/** A flat 40x30 rectangle (top face, 2 triangles, faceIndex 1) sitting above
 *  an unrelated 20x10 bottom rectangle (faceIndex 0) at z=0, so a hit on
 *  each resolves to a DISTINCT, verifiable face-array index. */
function twoFaceDisplay(): ModelBodyDisplay {
  const bottom = { positions: [-10, -5, 0, 10, -5, 0, 10, 5, 0, -10, 5, 0], indices: [0, 1, 2, 0, 2, 3] }
  const topBase = bottom.positions.length / 3
  const top = {
    positions: [-20, -15, 10, 20, -15, 10, 20, 15, 10, -20, 15, 10],
    indices: [0, 1, 2, 0, 2, 3].map((i) => i + topBase),
  }
  const positions = [...bottom.positions, ...top.positions]
  const indices = [...bottom.indices, ...top.indices]
  const normals = new Array(positions.length).fill(0)
  const triFace = [0, 0, 1, 1] // 4 triangles total: first 2 -> face 0 (bottom), last 2 -> face 1 (top)
  return {
    positions, normals, indices,
    edgePositions: [], edgeOffsets: [],
    bbox: { min: [-20, -15, 0], max: [20, 15, 10] },
    faceIds: ['F_bottom', 'F_top'],
    triFace,
  }
}

function aimRayDownAt(vp: CNCViewport, x: number, y: number) {
  priv(vp).raycaster.ray.set(new THREE.Vector3(x, y, 50), new THREE.Vector3(0, 0, -1))
}

describe('CAM-BINDING Stage 5: model-body face picking (CNCViewport)', () => {
  it('a ray through the TOP face resolves isModelFace + the local index for "F_top"', () => {
    const vp = makeHarness()
    vp.addModelBody('model:g1', twoFaceDisplay(), 'Box')
    aimRayDownAt(vp, 0, 0) // hits the top face (z=10) first, well inside its 40x30 extent
    const sel = priv(vp).resolveBrepHit()
    expect(sel).not.toBeNull()
    expect(sel!.geoId).toBe('model:g1')
    expect(sel!.kind).toBe('face')
    expect(sel!.isModelFace).toBe(true)
    const display = twoFaceDisplay()
    expect(display.faceIds![sel!.index]).toBe('F_top')
  })

  it('a ray aimed UP through the bottom footprint (from below, before reaching the top face) resolves "F_bottom"', () => {
    const vp = makeHarness()
    vp.addModelBody('model:g2', twoFaceDisplay(), 'Box')
    priv(vp).raycaster.ray.set(new THREE.Vector3(0, 0, -50), new THREE.Vector3(0, 0, 1))
    const sel = priv(vp).resolveBrepHit()
    expect(sel).not.toBeNull()
    expect(sel!.isModelFace).toBe(true)
    const display = twoFaceDisplay()
    expect(display.faceIds![sel!.index]).toBe('F_bottom')
  })

  it('collectBrepObjects never tags a model-pick mesh as isBrepMesh (identity boundary stays separate)', () => {
    const vp = makeHarness()
    vp.addModelBody('model:g3', twoFaceDisplay(), 'Box')
    const group = priv(vp).partGroups.get('model:g3')!
    const meshObj = group.children[0] as THREE.Mesh
    expect(meshObj.userData.isModelPickMesh).toBe(true)
    expect(meshObj.userData.isBrepMesh).toBeUndefined()
  })

  it('a body with NO faceIds/triFace (pre-Stage-5 display) stays pick-inert, exactly like Stage 1 left it', () => {
    const vp = makeHarness()
    const display = twoFaceDisplay()
    delete display.faceIds
    delete display.triFace
    vp.addModelBody('model:g4', display, 'Box')
    aimRayDownAt(vp, 0, 0)
    expect(priv(vp).resolveBrepHit()).toBeNull()
  })

  it('the face highlight overlay builds from the model-pick mesh\'s own triFace scan (not faceRanges)', () => {
    const vp = makeHarness()
    vp.addModelBody('model:g5', twoFaceDisplay(), 'Box')
    const hl = priv(vp).buildBrepHighlight('model:g5', 'face', 1, 'picked')
    expect(hl).not.toBeNull()
    const posAttr = (hl as unknown as { geometry: THREE.BufferGeometry }).geometry.getAttribute('position')
    // Face 1 ("F_top") has 2 triangles -> 6 vertices -> 18 floats.
    expect(posAttr.count).toBe(6)
  })
})
