import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { VoxelSimulator } from '../../lib/simulation/VoxelSimulator'
import {
  shouldDisplayAdaptiveCarvedStock,
  stockRemovalBodyKind,
  visibleStockRemovalBodies,
} from '../../lib/viewport/stockRemovalDisplayAuthority'

interface Sim6Viewport {
  initStockSim: CNCViewport['initStockSim']
  disposeStockSim: CNCViewport['disposeStockSim']
  initVoxelSim: CNCViewport['initVoxelSim']
  disposeVoxelSim: CNCViewport['disposeVoxelSim']
  showCarvedStock: CNCViewport['showCarvedStock']
  clearCarvedStock: CNCViewport['clearCarvedStock']
  scene: THREE.Scene
  stockGroup: THREE.Group
  stockSimGroup: THREE.Group | null
  voxelSimGroup: THREE.Group | null
}

function makeViewport(): Sim6Viewport {
  const viewport = Object.create(CNCViewport.prototype)
  const scene = new THREE.Scene()
  const stockGroup = new THREE.Group()
  scene.add(stockGroup)
  Object.assign(viewport, {
    scene,
    stockGroup,
    fixedStockBoxes: new Map<string, THREE.Group>(),
    _stockBounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(8, 8, 8),
    },
    carvedStockGroups: new Map<string, THREE.Group>(),
    stockSimGroup: null,
    stockSimGeometry: null,
    stockSimNx: 0,
    stockSimNy: 0,
    stockSimLayout: null,
    stockSimThreshold: 0,
    stockSimTopVertCount: 0,
    voxelSimGroup: null,
    voxelSimTexture: null,
    voxelSimMaterial: null,
    voxelSimMesh: null,
  })
  return viewport as Sim6Viewport
}

function showAdaptivePreview(viewport: Sim6Viewport): void {
  const positions = new Float32Array([
    0, 0, 0,
    8, 0, 0,
    0, 8, 0,
  ])
  viewport.showCarvedStock(
    'adaptive-3d-ready',
    positions,
    new Uint32Array([0, 1, 2]),
    { x: 0, y: 0, z: 0 },
    0,
  )
}

function bodyKinds(viewport: Sim6Viewport): Array<string | null> {
  return visibleStockRemovalBodies(viewport.scene).map(stockRemovalBodyKind).sort()
}

describe('SIM-6: one scene-graph authority for carved stock', () => {
  it('shows exactly the heightmap body during 3D stock-removal playback', () => {
    const viewport = makeViewport()
    viewport.initStockSim(0.5)

    if (shouldDisplayAdaptiveCarvedStock('simulation')) showAdaptivePreview(viewport)

    expect(bodyKinds(viewport)).toEqual(['heightmap'])
  })

  it('shows exactly the voxel body during 3D stock-removal playback', () => {
    const viewport = makeViewport()
    const simulator = new VoxelSimulator(
      { x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 },
      1,
      1_000_000,
    )
    viewport.initVoxelSim(simulator.field)

    if (shouldDisplayAdaptiveCarvedStock('simulation')) showAdaptivePreview(viewport)

    expect(bodyKinds(viewport)).toEqual(['voxel'])
  })

  it('keeps the adaptive preview in Toolpath mode and disposes it on clear', () => {
    const viewport = makeViewport()
    expect(shouldDisplayAdaptiveCarvedStock('toolpath')).toBe(true)
    showAdaptivePreview(viewport)

    const preview = visibleStockRemovalBodies(viewport.scene)[0]
    const mesh = preview.children[0] as THREE.Mesh
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose')
    const materialDispose = vi.spyOn(mesh.material as THREE.Material, 'dispose')

    expect(bodyKinds(viewport)).toEqual(['adaptive-preview'])
    viewport.clearCarvedStock()

    expect(bodyKinds(viewport)).toEqual([])
    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(materialDispose).toHaveBeenCalledOnce()
    expect(viewport.stockGroup.visible).toBe(true)
  })
})
