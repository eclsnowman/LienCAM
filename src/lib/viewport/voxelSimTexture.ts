// voxelSimTexture.ts -- GPU 3D-texture wrapper for the voxel stock simulation
// (ADR-0028). Owns a THREE.Data3DTexture backed by a VoxelField's Float32 data.
//
// This is the ONLY place that bridges the GL-free VoxelField (typed arrays +
// world<->voxel math) to WebGL. The raymarch ShaderMaterial (voxelSimMaterial.ts)
// samples this texture; CNCViewport wiring is a SEPARATE item.
//
// Layout note: VoxelField.idx(ix,iy,iz) = iz*nx*ny + iy*nx + ix, i.e. x fastest,
// then y, then z. That is EXACTLY the memory order THREE.Data3DTexture expects for
// (width=nx, height=ny, depth=nz), so field.data is passed straight through with
// no repacking.
//
// Field value convention (from VoxelField): value > 0 = inside solid, value < 0 =
// air, clamped signed distance in mm. The shader treats value >= uIso (0) as solid.

import * as THREE from 'three'
import { VoxelField } from '../simulation/voxel/VoxelField'
import type { DirtyBox } from '../simulation/voxel/VoxelField'

/**
 * Pack a dirty sub-box of a voxel field's flat Float32 data compactly into a
 * staging buffer in x-fastest, then-y, then-z order -- exactly the (w, h, d)
 * memory layout gl.texSubImage3D expects for its data argument.
 *
 * `data` is the source field array (idx = iz*nx*ny + iy*nx + ix). `box` is an
 * INCLUSIVE voxel-index AABB. `out` is a reused staging buffer that must be at
 * least w*h*d long. Returns the packed sub-box extents.
 *
 * The axis traversal order here is the ONE place a bug silently corrupts the
 * uploaded field, so it is directly unit-tested (voxelSimTexture.packing.test).
 */
export function packDirtySubBox(
  data: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  box: { ix0: number; iy0: number; iz0: number; ix1: number; iy1: number; iz1: number },
  out: Float32Array, // reused staging buffer, length >= w*h*d
): { w: number; h: number; d: number } {
  void nz // part of the field-dims signature; z extent is implied by the box.
  const w = box.ix1 - box.ix0 + 1
  const h = box.iy1 - box.iy0 + 1
  const d = box.iz1 - box.iz0 + 1
  let p = 0
  for (let iz = box.iz0; iz <= box.iz1; iz++) {
    for (let iy = box.iy0; iy <= box.iy1; iy++) {
      const rowStart = iz * nx * ny + iy * nx + box.ix0
      out.set(data.subarray(rowStart, rowStart + w), p)
      p += w
    }
  }
  return { w, h, d }
}

export class VoxelSimTexture {
  readonly texture: THREE.Data3DTexture
  private readonly renderer: THREE.WebGLRenderer
  // Reused staging buffer for partial uploads; grown on demand to w*h*d.
  private _staging: Float32Array = new Float32Array(0)

  constructor(field: VoxelField, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    const { nx, ny, nz } = field.dims
    // field.data is the SAME Float32Array the field carves into; the texture
    // reads it directly (no copy). A full re-upload on sync() re-reads it.
    const tex = new THREE.Data3DTexture(field.data, nx, ny, nz)
    tex.format = THREE.RedFormat
    tex.type = THREE.FloatType
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.wrapR = THREE.ClampToEdgeWrapping
    tex.unpackAlignment = 1
    tex.needsUpdate = true
    this.texture = tex
  }

  /**
   * Re-upload only the carved region of the field to the GPU.
   *
   * The field tracks a clamped dirty AABB over the voxels touched since the last
   * sync. Instead of re-uploading the entire Data3DTexture every carve (the #1
   * voxel-sim perf bottleneck: a full nx*ny*nz upload x ~34k carve syncs), we
   * issue a raw gl.texSubImage3D over just that sub-box.
   *
   * Allocation fallback (ADR-0003: this is a NAMED explicit fallback, not a
   * silent one): on the very first sync before three has rendered the texture --
   * or after a WebGL context loss recreated it -- three has not yet allocated the
   * GL texture object, so there is no handle to texSubImage3D into. In that case
   * we flag a full needsUpdate upload (three allocates + uploads the whole field)
   * and resume partial uploads on the next sync once the handle exists.
   *
   * resetState() is REQUIRED after the raw GL calls: we bind the texture directly
   * with gl.bindTexture, which desyncs three's internal WebGLState per-unit
   * texture-binding cache. resetState() re-syncs that cache so the next normal
   * three render binds correctly. It runs once per carve-batch sync -- cheap.
   */
  sync(field: VoxelField): void {
    if (field.dirty === null) return
    const box: DirtyBox = field.dirty

    const props = this.renderer.properties.get(this.texture) as
      | { __webglTexture?: WebGLTexture }
      | undefined
    const glTex = props?.__webglTexture
    if (!glTex) {
      // Texture not yet allocated by three (first frame before any render, or
      // recreated after context loss). Named allocation fallback: do a full
      // upload so three allocates; partial uploads resume next sync.
      this.texture.needsUpdate = true
      field.clearDirty()
      return
    }

    const { nx, ny, nz } = field.dims
    const need = (box.ix1 - box.ix0 + 1) * (box.iy1 - box.iy0 + 1) * (box.iz1 - box.iz0 + 1)
    if (this._staging.length < need) {
      this._staging = new Float32Array(need)
    }
    const { w, h, d } = packDirtySubBox(field.data, nx, ny, nz, box, this._staging)

    const gl = this.renderer.getContext() as WebGL2RenderingContext
    gl.bindTexture(gl.TEXTURE_3D, glTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    // Reset unpack offsets to defaults so a tightly-packed staging buffer is read
    // correctly regardless of any state three left behind.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0)
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      box.ix0,
      box.iy0,
      box.iz0,
      w,
      h,
      d,
      gl.RED,
      gl.FLOAT,
      this._staging.subarray(0, w * h * d),
    )
    // Re-sync three's WebGLState cache after the raw gl.bindTexture above.
    this.renderer.resetState()
    field.clearDirty()
  }

  dispose(): void {
    this.texture.dispose()
  }
}
