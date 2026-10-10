import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import {
  AO_ATTRIBUTE,
  applyBodyAO,
} from '../../lib/viewport/lighting/vertexAO'

function bodyMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1))
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
}

beforeEach(() => vi.stubGlobal('window', {}))
afterEach(() => vi.restoreAllMocks())

describe('UI-86 persisted vertex AO', () => {
  it('installs valid cached AO and skips the BVH raycast path', () => {
    const raycast = vi.spyOn(MeshBVH.prototype, 'raycastFirst')
    const mesh = bodyMesh()
    // The renderer clamps to double 0.12, then Float32 storage quantizes it to
    // 0.119999997... . That exact valid bake must remain reusable.
    const cached = new Float32Array([0.12, 0.75, 0.5])

    const result = applyBodyAO(mesh, cached)

    expect(raycast).not.toHaveBeenCalled()
    expect(result.bakeMs).toBe(0)
    expect(result.ao).toBe(cached)
    expect((mesh.geometry as THREE.BufferGeometry).getAttribute(AO_ATTRIBUTE).array).toBe(cached)
    expect((mesh.material as THREE.MeshStandardMaterial).customProgramCacheKey()).toBe('geo23-ao')
    const telemetry = (window as unknown as { __geo23AoBakes: Array<Record<string, unknown>> })
      .__geo23AoBakes.at(-1)!
    expect(telemetry).toEqual({ bakeMs: 0, vertices: 3, attributeBytes: 12 })
    expect(telemetry).not.toHaveProperty('ao')
  })

  it('ignores invalid cached AO and computes the full-quality attribute safely', () => {
    const raycast = vi.spyOn(MeshBVH.prototype, 'raycastFirst')
    const mesh = bodyMesh()

    const result = applyBodyAO(mesh, new Float32Array([1]))

    expect(raycast).toHaveBeenCalled()
    expect(result.ao).toHaveLength(3)
    expect((mesh.geometry as THREE.BufferGeometry).getAttribute(AO_ATTRIBUTE).count).toBe(3)
  })
})
