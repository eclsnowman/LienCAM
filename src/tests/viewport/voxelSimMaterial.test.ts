// Structural smoke test for the voxel-sim GPU modules (ADR-0028). NO GL needed:
// Three.js geometry/material/texture CONSTRUCTION works headless; we never render.
// We assert the texture dimensions/type, the material uniform surface + defaults,
// the box mesh geometry/position, and the per-frame ray-dir update.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { VoxelField, planVoxelGrid } from '../../lib/simulation/voxel/VoxelField'
import { initSolidStock, carvePoint } from '../../lib/simulation/voxel/carve'
import { VoxelSimTexture } from '../../lib/viewport/voxelSimTexture'
import {
  applyVoxelSimDisplayMode,
  createVoxelSimMaterial,
  buildVoxelSimMesh,
  updateVoxelSimUniforms,
  VOXEL_SIM_DISPLAY_MODE,
  VOXEL_SIM_GRID_TARGET_PIXELS,
  voxelSimGridStride,
} from '../../lib/viewport/voxelSimMaterial'
import {
  MODELED_BODY_REST_EDGE_HEX,
  MODELED_BODY_WIREFRAME_EDGE_HEX,
} from '../../lib/viewport/lighting/bodyVisualStyle'
import { TRANSLUCENT_OPACITY } from '../../lib/viewport/displayModes'

// Mock WebGLRenderer whose properties.get() returns {} (no __webglTexture), so
// VoxelSimTexture.sync() always takes the allocation-fallback path (full upload
// via needsUpdate) -- exactly what we want to assert without a GPU. getContext /
// resetState are present but never reached on this path.
function makeMockRenderer(): THREE.WebGLRenderer {
  return {
    properties: { get: () => ({}) },
    getContext: () => {
      throw new Error('mock renderer: getContext should not be called on the fallback path')
    },
    resetState: () => {},
  } as unknown as THREE.WebGLRenderer
}

// A tiny 8x8x8 field over a 0..8mm cube (voxelSize 1mm).
function makeField(): VoxelField {
  const plan = planVoxelGrid({ x0: 0, y0: 0, z0: 0, x1: 8, y1: 8, z1: 8 }, 1, 1_000_000)
  const field = new VoxelField(plan.dims)
  initSolidStock(field, 2)
  carvePoint(field, 4, 4, 6, { type: 'flat_end_mill', radius: 1.5 }, 2)
  return field
}

describe('VoxelSimTexture', () => {
  it('builds a Data3DTexture matching field dims and FloatType', () => {
    const field = makeField()
    const { nx, ny, nz } = field.dims
    const vt = new VoxelSimTexture(field, makeMockRenderer())

    expect(vt.texture).toBeInstanceOf(THREE.Data3DTexture)
    expect(vt.texture.image.width).toBe(nx)
    expect(vt.texture.image.height).toBe(ny)
    expect(vt.texture.image.depth).toBe(nz)
    expect(vt.texture.type).toBe(THREE.FloatType)
    expect(vt.texture.format).toBe(THREE.RedFormat)
    // image data is the field's own Float32Array (direct, no copy).
    expect(vt.texture.image.data).toBe(field.data)

    vt.dispose()
  })

  it('sync flags re-upload only when the field is dirty, then clears dirty', () => {
    const field = makeField()
    const vt = new VoxelSimTexture(field, makeMockRenderer())

    // carve dirties the field; clear our knowledge first.
    field.clearDirty()
    expect(field.dirty).toBeNull()

    // Data3DTexture.needsUpdate is a write-only setter that bumps `version`;
    // observe re-upload via the version counter, not a readable flag.
    const v0 = vt.texture.version
    vt.sync(field) // clean -> no-op, no version bump
    expect(vt.texture.version).toBe(v0)

    carvePoint(field, 2, 2, 6, { type: 'flat_end_mill', radius: 1.5 }, 2)
    expect(field.dirty).not.toBeNull()
    vt.sync(field) // dirty -> re-upload flagged (version bumps), dirty cleared
    expect(vt.texture.version).toBe(v0 + 1)
    expect(field.dirty).toBeNull()

    vt.dispose()
  })
})

describe('createVoxelSimMaterial', () => {
  const REQUIRED_UNIFORMS = [
    'uField', 'uFieldMin', 'uFieldMax', 'uVoxelSize', 'uIso', 'uRayDir',
    'uStepScale', 'uBaseColor', 'uAmbient', 'uKeyDir', 'uKeyColor', 'uFillDir',
    'uFillColor', 'uRimDir', 'uRimColor', 'uEdgeColor', 'uExposure', 'uAlpha',
    'uDisplayMode',
  ]

  function makeMaterial(): THREE.ShaderMaterial {
    const field = makeField()
    const tex = new VoxelSimTexture(field, makeMockRenderer()).texture
    return createVoxelSimMaterial({
      texture: tex,
      fieldMin: new THREE.Vector3(0, 0, 0),
      fieldMax: new THREE.Vector3(8, 8, 8),
      voxelSize: 1,
    })
  }

  it('returns a ShaderMaterial with every named uniform present', () => {
    const mat = makeMaterial()
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial)
    for (const name of REQUIRED_UNIFORMS) {
      expect(mat.uniforms[name], `missing uniform ${name}`).toBeDefined()
    }
  })

  it('uses the documented default uniform values + GL config', () => {
    const mat = makeMaterial()
    expect(mat.uniforms.uIso.value).toBe(0.0)
    expect(mat.uniforms.uExposure.value).toBe(1.2)
    expect(mat.uniforms.uStepScale.value).toBe(0.5)
    expect(mat.uniforms.uDisplayMode.value).toBe(VOXEL_SIM_DISPLAY_MODE['shaded-edges'])
    expect(mat.uniforms.uAlpha.value).toBe(1)
    expect(mat.glslVersion).toBe(THREE.GLSL3)
    expect(mat.side).toBe(THREE.BackSide)
    expect(mat.transparent).toBe(false)
    expect(mat.depthWrite).toBe(true)
    // light directions = normalize(position)
    const key = mat.uniforms.uKeyDir.value as THREE.Vector3
    expect(key.length()).toBeCloseTo(1, 6)
  })

  it.each([
    ['shaded-edges', 1, false, true],
    ['shaded-no-edges', 0, false, true],
    ['unshaded', 2, false, true],
    ['translucent', 3, true, false],
  ] as const)('applies %s through one shader-mode contract', (
    mode,
    shaderMode,
    transparent,
    depthWrite,
  ) => {
    const mat = makeMaterial()
    applyVoxelSimDisplayMode(mat, mode, 1)
    expect(mat.uniforms.uDisplayMode.value).toBe(shaderMode)
    expect(mat.uniforms.uAlpha.value).toBe(
      mode === 'translucent' ? TRANSLUCENT_OPACITY : 1,
    )
    expect(mat.transparent).toBe(transparent)
    expect(mat.depthWrite).toBe(depthWrite)
    expect((mat.uniforms.uEdgeColor.value as THREE.Color).getHexString()).toBe(
      (mode === 'unshaded'
        ? MODELED_BODY_WIREFRAME_EDGE_HEX
        : MODELED_BODY_REST_EDGE_HEX
      ).slice(1),
    )
  })

  it('composes Compare opacity and restores it after a Translucent round trip', () => {
    const mat = makeMaterial()
    applyVoxelSimDisplayMode(mat, 'shaded-edges', 0.2)
    expect(mat.uniforms.uAlpha.value).toBe(0.2)
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)

    applyVoxelSimDisplayMode(mat, 'translucent', 0.8)
    expect(mat.uniforms.uAlpha.value).toBe(TRANSLUCENT_OPACITY)

    applyVoxelSimDisplayMode(mat, 'shaded-edges', 0.8)
    expect(mat.uniforms.uAlpha.value).toBe(0.8)
  })

  it('derives wireframe and edge treatment from the raymarched isosurface', () => {
    const shader = makeMaterial().fragmentShader
    expect(shader).toContain('nativeGridPos = (phit - uFieldMin) / uVoxelSize')
    expect(shader).toContain('gridPos = nativeGridPos / gridStride')
    expect(shader).toContain(`maxNativeFootprint * ${VOXEL_SIM_GRID_TARGET_PIXELS}.0`)
    expect(shader).toContain('fwidth(gridPos)')
    expect(shader).toContain('wireCoverage = max(gridCoverage, silhouette)')
    expect(shader).toContain('wireCoverage < 0.16) discard')
    expect(shader).toContain('clamp(silhouette * 0.9')
    expect(shader).not.toContain('clamp(gridCoverage * 0.9')
  })

  it.each([0.02, 0.1, 0.2, 0.75, 2])(
    'keeps a %s-native-voxels-per-pixel lattice sparse enough for wireframe gaps',
    (nativeFootprint) => {
      const stride = voxelSimGridStride(nativeFootprint)
      const displayedFootprint = nativeFootprint / stride
      expect(stride).toBeGreaterThanOrEqual(1)
      expect(Math.log2(stride) % 1).toBe(0)
      expect(displayedFootprint).toBeLessThanOrEqual(1 / VOXEL_SIM_GRID_TARGET_PIXELS)
    },
  )
})

describe('buildVoxelSimMesh', () => {
  it('geometry extent ~= field extent and position ~= centre', () => {
    const field = makeField()
    const tex = new VoxelSimTexture(field, makeMockRenderer()).texture
    const fieldMin = new THREE.Vector3(0, 0, 0)
    const fieldMax = new THREE.Vector3(8, 8, 8)
    const mat = createVoxelSimMaterial({ texture: tex, fieldMin, fieldMax, voxelSize: 1 })
    const mesh = buildVoxelSimMesh(mat, fieldMin, fieldMax)

    expect(mesh).toBeInstanceOf(THREE.Mesh)
    expect(mesh.frustumCulled).toBe(false)

    mesh.geometry.computeBoundingBox()
    const size = new THREE.Vector3()
    mesh.geometry.boundingBox!.getSize(size)
    expect(size.x).toBeCloseTo(8, 5)
    expect(size.y).toBeCloseTo(8, 5)
    expect(size.z).toBeCloseTo(8, 5)

    // centre of a 0..8 box is (4,4,4)
    expect(mesh.position.x).toBeCloseTo(4, 5)
    expect(mesh.position.y).toBeCloseTo(4, 5)
    expect(mesh.position.z).toBeCloseTo(4, 5)
  })
})

describe('updateVoxelSimUniforms', () => {
  it('sets uRayDir to a unit vector from the camera world direction', () => {
    const field = makeField()
    const tex = new VoxelSimTexture(field, makeMockRenderer()).texture
    const mat = createVoxelSimMaterial({
      texture: tex,
      fieldMin: new THREE.Vector3(0, 0, 0),
      fieldMax: new THREE.Vector3(8, 8, 8),
      voxelSize: 1,
    })

    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 10000)
    cam.up.set(0, 0, 1)
    cam.position.set(100, 100, 100)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)

    updateVoxelSimUniforms(mat, cam)
    const dir = mat.uniforms.uRayDir.value as THREE.Vector3
    expect(dir.length()).toBeCloseTo(1, 6)
  })
})
