import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { ShadingMode } from '../../types'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { VoxelSimulator } from '../../lib/simulation/VoxelSimulator'
import { TRANSLUCENT_OPACITY } from '../../lib/viewport/displayModes'
import { VOXEL_SIM_DISPLAY_MODE } from '../../lib/viewport/voxelSimMaterial'
import {
  MODELED_BODY_REST_EDGE_HEX,
  MODELED_BODY_WIREFRAME_EDGE_HEX,
  resolveModeledBodyEdgeModeStyle,
} from '../../lib/viewport/lighting/bodyVisualStyle'

interface SimDisplayHarness {
  initStockSim: CNCViewport['initStockSim']
  updateStockSimHeights: CNCViewport['updateStockSimHeights']
  disposeStockSim: CNCViewport['disposeStockSim']
  setStockSimOpacity: CNCViewport['setStockSimOpacity']
  setStockSimVisible: CNCViewport['setStockSimVisible']
  setStockVisible: CNCViewport['setStockVisible']
  setShadingMode: CNCViewport['setShadingMode']
  initVoxelSim: CNCViewport['initVoxelSim']
  disposeVoxelSim: CNCViewport['disposeVoxelSim']
  applyStockSimDisplayMode: () => void
  currentShadingMode: ShadingMode
  stockSimOpacity: number
  scene: THREE.Scene
  stockGroup: THREE.Group
  stockSimGroup: THREE.Group | null
  stockSimGeometry: THREE.BufferGeometry | null
  stockSimSurfaceMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null
  stockSimEdgeMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null
  voxelSimGroup: THREE.Group | null
  voxelSimMaterial: THREE.ShaderMaterial | null
}

function makeVp(): SimDisplayHarness {
  const vp = Object.create(CNCViewport.prototype)
  const scene = new THREE.Scene()
  const stockGroup = new THREE.Group()
  scene.add(stockGroup)
  Object.assign(vp, {
    scene,
    stockGroup,
    fixedStockBoxes: new Map<string, THREE.Group>(),
    carvedStockGroups: new Map<string, THREE.Group>(),
    stockVisibleRequested: true,
    partGroups: new Map<string, THREE.Group>(),
    partEdgePositions: new Map<string, Float32Array>(),
    materialBaselines: new Map<THREE.MeshStandardMaterial, unknown>(),
    partInteractionOutlines: new Map<string, THREE.Object3D>(),
    brepHighlights: new Map<string, THREE.Object3D>(),
    brepHoverObj: null,
    brepHoverKey: null,
    _stockBounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(8, 8, 8),
    },
    currentShadingMode: 'shaded-edges',
    stockSimOpacity: 1,
    stockSimGroup: null,
    stockSimGeometry: null,
    stockSimSurfaceMesh: null,
    stockSimEdgeMesh: null,
    stockSimLayout: null,
    stockSimNx: 0,
    stockSimNy: 0,
    voxelSimGroup: null,
    voxelSimTexture: null,
    voxelSimMaterial: null,
    voxelSimMesh: null,
  })
  return vp as SimDisplayHarness
}

function applyMode(vp: SimDisplayHarness, mode: ShadingMode): void {
  vp.currentShadingMode = mode
  vp.applyStockSimDisplayMode()
}

function makeVoxelSim(): VoxelSimulator {
  const sim = new VoxelSimulator(
    { x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 },
    1,
    1_000_000,
  )
  sim.sweepMove(
    { x: 4, y: 4, z: 8 },
    { x: 4, y: 4, z: 4 },
    { type: 'flat_end_mill', diameter: 3 },
  )
  return sim
}

describe('stock-simulation display-mode parity', () => {
  it.each([
    ['shaded-edges', true, true, 1, false, true],
    ['shaded-no-edges', true, false, 1, false, true],
    ['unshaded', false, true, 1, false, true],
    ['translucent', true, true, TRANSLUCENT_OPACITY, true, false],
  ] as const)('applies %s to the dynamic heightmap fill and real topology edges', (
    mode,
    fillVisible,
    edgesVisible,
    opacity,
    transparent,
    depthWrite,
  ) => {
    const vp = makeVp()
    expect(vp.initStockSim(1)).not.toBeNull()
    applyMode(vp, mode)

    expect(vp.stockSimSurfaceMesh?.visible).toBe(fillVisible)
    expect(vp.stockSimEdgeMesh?.visible).toBe(edgesVisible)
    expect(vp.stockSimSurfaceMesh?.material.opacity).toBe(opacity)
    expect(vp.stockSimSurfaceMesh?.material.transparent).toBe(transparent)
    expect(vp.stockSimSurfaceMesh?.material.depthWrite).toBe(depthWrite)
    const edgeStyle = resolveModeledBodyEdgeModeStyle(mode)
    expect(vp.stockSimEdgeMesh?.material.opacity).toBe(opacity * edgeStyle.opacity)
    expect(vp.stockSimEdgeMesh?.material.color.getHexString()).toBe(
      (mode === 'unshaded'
        ? MODELED_BODY_WIREFRAME_EDGE_HEX
        : MODELED_BODY_REST_EDGE_HEX
      ).slice(1),
    )
    expect(vp.stockSimEdgeMesh?.material.depthWrite).toBe(false)
    expect(vp.stockSimEdgeMesh?.geometry).toBe(vp.stockSimGeometry)
    expect(vp.stockSimEdgeMesh?.material.userData.bodyEdgeNdcDepthBias).toBe(2e-5)
    expect(vp.stockSimEdgeMesh?.material.customProgramCacheKey()).toContain(
      'stock-sim-edge-ndc-bias',
    )

    vp.disposeStockSim()
  })

  it.each([
    ['shaded-edges', 1, 1, false, true],
    ['shaded-no-edges', 0, 1, false, true],
    ['unshaded', 2, 1, false, true],
    ['translucent', 3, TRANSLUCENT_OPACITY, true, false],
  ] as const)('applies %s to the raymarched voxel surface', (
    mode,
    shaderMode,
    opacity,
    transparent,
    depthWrite,
  ) => {
    const vp = makeVp()
    vp.initVoxelSim(makeVoxelSim().field)
    applyMode(vp, mode)

    expect(vp.voxelSimMaterial?.uniforms.uDisplayMode.value).toBe(shaderMode)
    expect(vp.voxelSimMaterial?.uniforms.uDisplayMode.value).toBe(VOXEL_SIM_DISPLAY_MODE[mode])
    expect(vp.voxelSimMaterial?.uniforms.uAlpha.value).toBe(opacity)
    expect(vp.voxelSimMaterial?.transparent).toBe(transparent)
    expect(vp.voxelSimMaterial?.depthWrite).toBe(depthWrite)

    vp.disposeVoxelSim()
  })

  it('preserves Compare opacity through mode changes for both engines', () => {
    const vp = makeVp()
    vp.initStockSim(1)
    vp.setStockSimOpacity(0.2)
    expect(vp.stockSimSurfaceMesh?.material.opacity).toBe(0.2)

    applyMode(vp, 'translucent')
    expect(vp.stockSimSurfaceMesh?.material.opacity).toBe(0.2)
    applyMode(vp, 'shaded-edges')
    expect(vp.stockSimSurfaceMesh?.material.opacity).toBe(0.2)

    vp.initVoxelSim(makeVoxelSim().field)
    expect(vp.voxelSimMaterial?.uniforms.uAlpha.value).toBe(0.2)
    applyMode(vp, 'translucent')
    expect(vp.voxelSimMaterial?.uniforms.uAlpha.value).toBe(0.2)
    applyMode(vp, 'shaded-edges')
    expect(vp.voxelSimMaterial?.uniforms.uAlpha.value).toBe(0.2)

    vp.disposeVoxelSim()
  })

  it('switches engines in both directions without coexistence and inherits live style', () => {
    const vp = makeVp()
    vp.initStockSim(1)
    vp.setStockSimOpacity(0.42)
    applyMode(vp, 'unshaded')
    const firstHeightmapGroup = vp.stockSimGroup

    vp.initVoxelSim(makeVoxelSim().field)
    expect(vp.stockSimGroup).toBeNull()
    expect(vp.scene.children.includes(firstHeightmapGroup as THREE.Group)).toBe(false)
    expect(vp.voxelSimGroup).not.toBeNull()
    expect(vp.voxelSimMaterial?.uniforms.uDisplayMode.value).toBe(
      VOXEL_SIM_DISPLAY_MODE.unshaded,
    )
    expect(vp.voxelSimMaterial?.uniforms.uAlpha.value).toBe(0.42)
    const voxelGroup = vp.voxelSimGroup

    vp.initStockSim(1)
    expect(vp.voxelSimGroup).toBeNull()
    expect(vp.scene.children.includes(voxelGroup as THREE.Group)).toBe(false)
    expect(vp.stockSimGroup).not.toBeNull()
    expect(vp.stockSimSurfaceMesh?.visible).toBe(false)
    expect(vp.stockSimEdgeMesh?.visible).toBe(true)
    expect(vp.stockSimEdgeMesh?.material.opacity).toBe(0.42)
    expect(vp.scene.children).toHaveLength(2) // stock group + one sim engine

    vp.disposeStockSim()
  })

  it('keeps static fallback hidden when viewer visibility replays during a public mode change', () => {
    const vp = makeVp()
    vp.initVoxelSim(makeVoxelSim().field)
    vp.setStockSimVisible(true) // Cut Stock

    // Viewport.tsx replays showStock before setShadingMode on every viewer patch.
    vp.setStockVisible(true)
    vp.setShadingMode('unshaded')
    vp.setStockVisible(true)

    expect(vp.stockGroup.visible).toBe(false)
    expect(vp.voxelSimGroup?.visible).toBe(true)
    expect(vp.voxelSimMaterial?.uniforms.uDisplayMode.value).toBe(
      VOXEL_SIM_DISPLAY_MODE.unshaded,
    )

    vp.setShadingMode('shaded-edges')
    expect(vp.stockGroup.visible).toBe(false)
    expect(vp.voxelSimGroup).not.toBeNull()

    vp.disposeVoxelSim()
    expect(vp.stockGroup.visible).toBe(true)
  })

  it('restores the last requested static-stock visibility after a replacement is disposed', () => {
    const vp = makeVp()
    vp.setStockVisible(false)
    vp.initStockSim(1)
    expect(vp.stockGroup.visible).toBe(false)

    vp.disposeStockSim()
    expect(vp.stockGroup.visible).toBe(false)

    vp.setStockVisible(true)
    expect(vp.stockGroup.visible).toBe(true)
  })

  it('disposes shared heightmap geometry once and both materials once', () => {
    const vp = makeVp()
    vp.initStockSim(1)
    const geometry = vp.stockSimGeometry!
    const surfaceMaterial = vp.stockSimSurfaceMesh!.material
    const edgeMaterial = vp.stockSimEdgeMesh!.material
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const surfaceDispose = vi.spyOn(surfaceMaterial, 'dispose')
    const edgeDispose = vi.spyOn(edgeMaterial, 'dispose')

    vp.disposeStockSim()

    expect(geometryDispose).toHaveBeenCalledTimes(1)
    expect(surfaceDispose).toHaveBeenCalledTimes(1)
    expect(edgeDispose).toHaveBeenCalledTimes(1)
    expect(vp.stockSimGeometry).toBeNull()
    expect(vp.stockSimSurfaceMesh).toBeNull()
    expect(vp.stockSimEdgeMesh).toBeNull()
  })
})
