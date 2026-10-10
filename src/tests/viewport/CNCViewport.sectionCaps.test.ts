import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { createSectionCapController, type SectionCapController } from '../../lib/viewport/sectionCaps'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { ModelBodyDisplay } from '../../types'

interface SectionCapHarness {
  addSTL: CNCViewport['addSTL']
  addBrepModel: CNCViewport['addBrepModel']
  addModelBody: CNCViewport['addModelBody']
  removeSTL: CNCViewport['removeSTL']
  setSectionView: CNCViewport['setSectionView']
  setShadingMode: CNCViewport['setShadingMode']
  setSTLVisible: CNCViewport['setSTLVisible']
  setWorkpieceVisible: CNCViewport['setWorkpieceVisible']
  partGroups: Map<string, THREE.Group>
  scene: THREE.Scene
  workpieceGroup: THREE.Group
  stockSimGroup: THREE.Group | null
  voxelSimGroup: THREE.Group | null
  sectionCaps: SectionCapController
  renderer: {
    localClippingEnabled: boolean
    domElement: { getBoundingClientRect(): { width: number; height: number } }
    getPixelRatio(): number
  }
}

type V3 = [number, number, number]

function bodyDisplay(min: V3, max: V3): ModelBodyDisplay {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]
  return {
    positions,
    normals: new Array(positions.length).fill(0),
    indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6],
    edgePositions: [x0, y0, z0, x1, y0, z0],
    edgeOffsets: [0, 2],
    edgeIds: ['edge-1'],
    bbox: { min, max },
  }
}

function brepPayload(min: V3, max: V3): BrepModelPayload {
  const display = bodyDisplay(min, max)
  return {
    faceCount: 1,
    edgeCount: 1,
    solidCount: 1,
    bbox: { min, max },
    mesh: {
      positions: new Float32Array(display.positions),
      normals: new Float32Array(display.normals),
      indices: new Uint32Array(display.indices),
      faceRanges: new Uint32Array([0, display.indices.length]),
    },
    edges: {
      positions: new Float32Array(display.edgePositions),
      edgeRanges: new Uint32Array([0, 2]),
    },
    faceTypes: new Uint8Array([0]),
  }
}

function stlBuffer(min: V3, max: V3): ArrayBuffer {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const triangles: V3[][] = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0]],
    [[x0, y0, z0], [x1, y1, z1], [x0, y1, z1]],
  ]
  const buffer = new ArrayBuffer(84 + triangles.length * 50)
  const view = new DataView(buffer)
  view.setUint32(80, triangles.length, true)
  let offset = 84
  for (const triangle of triangles) {
    offset += 12
    for (const [x, y, z] of triangle) {
      view.setFloat32(offset, x, true)
      view.setFloat32(offset + 4, y, true)
      view.setFloat32(offset + 8, z, true)
      offset += 12
    }
    offset += 2
  }
  return buffer
}

function roleMeshes(scene: THREE.Scene, role: string): THREE.Mesh[] {
  return scene.children.filter(
    (object): object is THREE.Mesh =>
      object instanceof THREE.Mesh && object.userData.sectionCapRole === role,
  )
}

function stencilHelpers(scene: THREE.Scene): THREE.Mesh[] {
  return [
    ...roleMeshes(scene, 'stencil-back'),
    ...roleMeshes(scene, 'stencil-front'),
  ]
}

function makeHarness(): SectionCapHarness {
  const viewport = Object.create(CNCViewport.prototype)
  const scene = new THREE.Scene()
  const workpieceGroup = new THREE.Group()
  const stockGroup = new THREE.Group()
  scene.add(workpieceGroup, stockGroup)
  const sectionCaps = createSectionCapController(scene)
  Object.assign(viewport, {
    scene,
    sectionCaps,
    workpieceGroup,
    stockGroup,
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map<string, THREE.MeshStandardMaterial>(),
    partUsesThemeColor: new Map<string, boolean>(),
    partEdgePositions: new Map<string, Float32Array>(),
    materialBaselines: new Map<THREE.MeshStandardMaterial, unknown>(),
    currentShadingMode: 'shaded-edges',
    viewportThemeId: 'classic',
    colors: { workpiece: 0x8a9bb0, workpieceEdge: 0x42546a },
    partInteractionOutlines: new Map<string, THREE.Object3D>(),
    partSelectedMaterialStates: new Map(),
    brepHighlights: new Map<string, THREE.Object3D>(),
    brepHoverObj: null,
    brepHoverKey: null,
    pickedBrepKeys: new Set<string>(),
    selectedPartId: null,
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    stockSimGroup: null,
    stockSimSurfaceMesh: null,
    stockSimEdgeMesh: null,
    voxelSimGroup: null,
    voxelSimMaterial: null,
    renderer: {
      localClippingEnabled: false,
      domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      getPixelRatio: () => 1,
    },
    clipPlane: new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    updateSelectableObjects: () => {},
    maybeAutoFit: () => {},
    rebuildStock: () => {},
  })
  return viewport as SectionCapHarness
}

describe('CAM section-cap integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests a stencil buffer from the real CAM renderer', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'viewport', 'CNCViewport.ts'),
      'utf8',
    )
    expect(source).toMatch(
      /new THREE\.WebGLRenderer\(\{\s*antialias: true,\s*alpha: false,\s*stencil: true\s*\}\)/,
    )
  })

  it('caps only the closed workpiece and follows section, transform, mode, and visibility state', () => {
    const viewport = makeHarness()
    viewport.addModelBody(
      'modelbody:1',
      bodyDisplay([-4, -3, 0], [8, 7, 6]),
      'Body',
      { x: 11, y: -5, z: 2 },
      { x: 15, y: 25, z: 35 },
    )
    const group = viewport.partGroups.get('modelbody:1')!
    const body = group.children.find(
      (object): object is THREE.Mesh => object instanceof THREE.Mesh,
    )!

    const heightmapProxy = new THREE.Mesh(new THREE.PlaneGeometry(20, 20))
    const voxelProxy = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20))
    viewport.stockSimGroup = new THREE.Group().add(heightmapProxy)
    viewport.voxelSimGroup = new THREE.Group().add(voxelProxy)
    viewport.scene.add(viewport.stockSimGroup, viewport.voxelSimGroup)

    const helpers = stencilHelpers(viewport.scene)
    expect(helpers).toHaveLength(2)
    expect(helpers.every((helper) => helper.geometry === body.geometry)).toBe(true)
    expect(helpers.some((helper) => helper.geometry === heightmapProxy.geometry)).toBe(false)
    expect(helpers.some((helper) => helper.geometry === voxelProxy.geometry)).toBe(false)

    viewport.setSectionView({ enabled: true, axis: 'z', position: 4, flip: false })
    expect(viewport.renderer.localClippingEnabled).toBe(true)
    expect(roleMeshes(viewport.scene, 'fill')).toHaveLength(1)
    expect((body.material as THREE.Material).clippingPlanes).toHaveLength(1)

    viewport.scene.updateMatrixWorld(true)
    for (const helper of helpers) {
      ;(helper.onBeforeRender as () => void)()
      expect(helper.matrixWorld.equals(body.matrixWorld)).toBe(true)
    }

    viewport.setSTLVisible('modelbody:1', false)
    expect(helpers.every((helper) => helper.visible === false)).toBe(true)
    viewport.setSTLVisible('modelbody:1', true)
    expect(helpers.every((helper) => helper.visible === true)).toBe(true)

    viewport.setWorkpieceVisible(false)
    expect(helpers.every((helper) => helper.visible === false)).toBe(true)
    viewport.setWorkpieceVisible(true)
    expect(helpers.every((helper) => helper.visible === true)).toBe(true)

    viewport.setShadingMode('unshaded')
    expect(helpers.every((helper) => helper.visible === false)).toBe(true)
    viewport.setShadingMode('shaded-edges')
    expect(helpers.every((helper) => helper.visible === true)).toBe(true)

    viewport.removeSTL('modelbody:1')
    expect(stencilHelpers(viewport.scene)).toHaveLength(0)
    viewport.setSectionView({ enabled: false, axis: 'z', position: 4, flip: false })
    expect(roleMeshes(viewport.scene, 'fill')).toHaveLength(0)
  })

  it('registers and unregisters STL, STEP B-rep, and Model body paths exactly once', async () => {
    vi.stubGlobal('window', {})
    const viewport = makeHarness()
    viewport.addModelBody('model', bodyDisplay([0, 0, 0], [4, 5, 6]), 'Model')
    viewport.addBrepModel('step', brepPayload([10, 0, 0], [14, 5, 6]), 'STEP')
    await viewport.addSTL(stlBuffer([20, 0, 0], [24, 5, 6]), 'stl', 'STL')
    expect(stencilHelpers(viewport.scene)).toHaveLength(6)

    viewport.removeSTL('model')
    expect(stencilHelpers(viewport.scene)).toHaveLength(4)
    viewport.removeSTL('step')
    expect(stencilHelpers(viewport.scene)).toHaveLength(2)
    viewport.removeSTL('stl')
    expect(stencilHelpers(viewport.scene)).toHaveLength(0)
  })
})
