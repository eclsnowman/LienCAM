// Structural test for the voxel stock-sim render path on CNCViewport (ADR-0028).
// Mirrors stockSimVisibility.test.ts: it binds the real CNCViewport methods to a
// minimal instance over a real THREE.Scene/Group (Object.create + Object.assign,
// the typedZTransform pattern) and asserts the scene-graph side effects. No
// renderer is needed -- initVoxelSim only CONSTRUCTS THREE objects (Data3DTexture,
// ShaderMaterial, BoxGeometry); nothing renders here.

import * as THREE from 'three'
import { describe, it, expect } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { VoxelSimulator } from '../../lib/simulation/VoxelSimulator'

interface VoxelVpUnderTest {
  initVoxelSim: CNCViewport['initVoxelSim']
  syncVoxelSim: CNCViewport['syncVoxelSim']
  disposeVoxelSim: CNCViewport['disposeVoxelSim']
  scene: THREE.Scene
  stockGroup: THREE.Group
  voxelSimGroup: THREE.Group | null
  voxelSimTexture: unknown
  voxelSimMaterial: THREE.ShaderMaterial | null
  voxelSimMesh: THREE.Mesh | null
}

function makeVp(): VoxelVpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  const scene = new THREE.Scene()
  const stockGroup = new THREE.Group()
  scene.add(stockGroup)
  Object.assign(vp, {
    scene,
    stockGroup,
    voxelSimGroup: null,
    voxelSimTexture: null,
    voxelSimMaterial: null,
    voxelSimMesh: null,
  })
  return vp as VoxelVpUnderTest
}

// A small field (8mm cube @ 1mm) carved once so it has real content.
function makeSim(): VoxelSimulator {
  const sim = new VoxelSimulator({ x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 }, 1, 1_000_000)
  sim.sweepMove({ x: 4, y: 4, z: 8 }, { x: 4, y: 4, z: 4 }, { type: 'flat_end_mill', diameter: 3 })
  return sim
}

const groupInScene = (vp: VoxelVpUnderTest) =>
  vp.voxelSimGroup !== null && vp.scene.children.includes(vp.voxelSimGroup)

describe('ADR-0028: voxel stock-sim render path on CNCViewport', () => {
  it('initVoxelSim adds a group to the scene and hides the wireframe stock', () => {
    const vp = makeVp()
    const sim = makeSim()
    expect(vp.stockGroup.visible).toBe(true)

    vp.initVoxelSim(sim.field)

    expect(groupInScene(vp)).toBe(true)
    expect(vp.stockGroup.visible).toBe(false) // wireframe stock hidden during sim
    expect(vp.voxelSimMaterial).toBeInstanceOf(THREE.ShaderMaterial)
    expect(vp.voxelSimMesh).toBeInstanceOf(THREE.Mesh)
    expect(vp.voxelSimTexture).not.toBeNull()

    vp.disposeVoxelSim()
  })

  it('disposeVoxelSim removes the group and restores stock visibility', () => {
    const vp = makeVp()
    const sim = makeSim()
    vp.initVoxelSim(sim.field)
    expect(groupInScene(vp)).toBe(true)

    vp.disposeVoxelSim()

    expect(vp.voxelSimGroup).toBeNull()
    expect(vp.voxelSimMesh).toBeNull()
    expect(vp.voxelSimMaterial).toBeNull()
    expect(vp.voxelSimTexture).toBeNull()
    expect(vp.scene.children.length).toBe(1) // only stockGroup remains
    expect(vp.stockGroup.visible).toBe(true) // wireframe stock restored
  })

  it('initVoxelSim disposes a prior voxel sim before building a new one', () => {
    const vp = makeVp()
    vp.initVoxelSim(makeSim().field)
    const first = vp.voxelSimGroup
    vp.initVoxelSim(makeSim().field)

    expect(vp.voxelSimGroup).not.toBe(first)
    expect(groupInScene(vp)).toBe(true)
    // The old group was removed; only the new sim group + stockGroup are present.
    expect(vp.scene.children.includes(first as THREE.Group)).toBe(false)
    expect(vp.scene.children.length).toBe(2)

    vp.disposeVoxelSim()
  })
})
