// VoxelField — GL-FREE CPU storage for the voxel stock-removal simulation (ADR-0028).
//
// This is the dense V1 backing behind a FIXED interface. Per ADR-0028, a sparse
// brick-pool backing is a future drop-in behind these same method shapes — the
// carve API and the (separate) raymarch render path are final regardless of the
// backing chosen here. This module deliberately contains NO Three.js, NO WebGL,
// and NO DOM: it is a pure typed-array scalar field plus the world<->voxel math
// and dirty-region bookkeeping the renderer needs. All GPU/texture upload code
// (Data3DTexture, texSubImage3D, readback) is a SEPARATE later item.
//
// Field value convention (documentation only — NOT enforced by this module,
// which simply stores Float32 values):
//   value > 0  = inside remaining solid material
//   value < 0  = removed / air
//   value === 0 = on the surface
// interpreted as a clamped signed distance in mm.

// World-space stock bounds (axis-aligned). z up.
export interface StockBounds {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

export interface VoxelGridDims {
  nx: number
  ny: number
  nz: number // cell counts per axis (>=1)
  voxelSize: number // mm, uniform (one isotropic size)
  x0: number
  y0: number
  z0: number // world min corner
}

export interface VoxelGridPlan {
  dims: VoxelGridDims
  requestedVoxelSize: number
  coarsened: boolean // true if voxelSize was enlarged to fit the budget
}

/** A clamped, growing AABB over voxel indices. */
export interface DirtyBox {
  ix0: number
  iy0: number
  iz0: number
  ix1: number
  iy1: number
  iz1: number
}

/**
 * Derive grid dims from world bounds + a requested (isotropic) voxel size,
 * capped to `maxVoxels` total cells.
 *
 * Cell counts are ceil((extent) / voxelSize) on each axis, floored at 1 so a
 * zero- or sub-voxel-thin extent still yields a usable single cell. If the
 * product nx*ny*nz would exceed `maxVoxels`, the voxel size is uniformly
 * enlarged (scaled by cbrt(total/max), then dims re-ceiled) and the check
 * repeats until the cell count fits the budget. `coarsened` is true in that case.
 */
export function planVoxelGrid(
  bounds: StockBounds,
  requestedVoxelSize: number,
  maxVoxels: number,
): VoxelGridPlan {
  if (!(requestedVoxelSize > 0)) {
    throw new Error(`planVoxelGrid: requestedVoxelSize must be > 0, got ${requestedVoxelSize}`)
  }
  if (!(maxVoxels >= 1)) {
    throw new Error(`planVoxelGrid: maxVoxels must be >= 1, got ${maxVoxels}`)
  }

  const ex = Math.max(0, bounds.x1 - bounds.x0)
  const ey = Math.max(0, bounds.y1 - bounds.y0)
  const ez = Math.max(0, bounds.z1 - bounds.z0)

  const dimsFor = (vs: number): { nx: number; ny: number; nz: number } => ({
    nx: Math.max(1, Math.ceil(ex / vs)),
    ny: Math.max(1, Math.ceil(ey / vs)),
    nz: Math.max(1, Math.ceil(ez / vs)),
  })

  let voxelSize = requestedVoxelSize
  let { nx, ny, nz } = dimsFor(voxelSize)
  let coarsened = false

  // Uniformly enlarge the voxel size until the total cell count fits the budget.
  // cbrt(total/max) is the ideal uniform scale; re-ceiling the dims can leave us
  // slightly over (each axis rounds up independently), so loop until it fits.
  // A hard iteration cap guarantees termination even in pathological cases.
  let guard = 0
  while (nx * ny * nz > maxVoxels) {
    coarsened = true
    const total = nx * ny * nz
    const scale = Math.cbrt(total / maxVoxels)
    // Always grow by at least a hair so we make progress even when scale rounds
    // back to ~1 after re-ceiling.
    voxelSize = Math.max(voxelSize * scale, voxelSize * 1.000001)
    ;({ nx, ny, nz } = dimsFor(voxelSize))
    if (++guard > 1000) {
      throw new Error(
        `planVoxelGrid: failed to fit ${maxVoxels} voxel budget after 1000 iterations ` +
          `(dims ${nx}x${ny}x${nz}, voxelSize ${voxelSize})`,
      )
    }
  }

  return {
    dims: { nx, ny, nz, voxelSize, x0: bounds.x0, y0: bounds.y0, z0: bounds.z0 },
    requestedVoxelSize,
    coarsened,
  }
}

export class VoxelField {
  readonly dims: VoxelGridDims
  readonly data: Float32Array // length nx*ny*nz

  /**
   * Per-(ix,iy) column HIGH-WATER-MARK: the highest iz that is NOT guaranteed to
   * be saturated air. Indexed col = iy*nx + ix; length nx*ny.
   *
   * SAFETY INVARIANT: columnTop[col] is ALWAYS >= the true highest iz whose value
   * !== satAir(band). The carve loop may skip every iz ABOVE columnTop because
   * those voxels are provably saturated air and csgSubtract on saturated air is a
   * no-op (min(satAir, anything) clamps back to satAir). Setting columnTop too
   * HIGH only costs extra no-op scans (always byte-safe); too LOW would skip real
   * solid/band voxels (a correctness bug). When unsure, round UP.
   *
   * Because it SUMMARIZES field.data, it MUST be re-established (conservatively,
   * to all-solid nz-1) whenever data is bulk-replaced (restore/reset/init).
   */
  readonly columnTop: Int32Array // length nx*ny

  private _dirty: DirtyBox | null = null

  constructor(dims: VoxelGridDims) {
    this.dims = dims
    this.data = new Float32Array(dims.nx * dims.ny * dims.nz) // zero-filled
    this.columnTop = new Int32Array(dims.nx * dims.ny)
    this.resetColumnTopSolid()
  }

  /**
   * Re-establish the column high-water-mark to its most conservative (fully
   * solid) state: every column's top = nz-1. Always byte-safe. Call whenever
   * field.data is bulk-replaced so the carve loop cannot skip now-solid voxels.
   */
  resetColumnTopSolid(): void {
    this.columnTop.fill(this.dims.nz - 1)
  }

  /** Flat array index for a voxel: iz*nx*ny + iy*nx + ix. */
  idx(ix: number, iy: number, iz: number): number {
    const { nx, ny } = this.dims
    return iz * nx * ny + iy * nx + ix
  }

  inBounds(ix: number, iy: number, iz: number): boolean {
    const { nx, ny, nz } = this.dims
    return ix >= 0 && ix < nx && iy >= 0 && iy < ny && iz >= 0 && iz < nz
  }

  get(ix: number, iy: number, iz: number): number {
    return this.data[this.idx(ix, iy, iz)]
  }

  /** Set a voxel value and mark that single cell dirty. */
  set(ix: number, iy: number, iz: number, v: number): void {
    this.data[this.idx(ix, iy, iz)] = v
    this.markDirty(ix, iy, iz, ix, iy, iz)
  }

  /** Fill the whole field with `value` and mark the entire field dirty. */
  reset(value: number): void {
    this.data.fill(value)
    // data was bulk-replaced; re-establish the HWM conservatively (all solid).
    this.resetColumnTopSolid()
    this.markWholeDirty()
  }

  /** World-space center of voxel (ix,iy,iz): x0 + (ix+0.5)*voxelSize, etc. */
  voxelCenterWorld(ix: number, iy: number, iz: number): { x: number; y: number; z: number } {
    const { x0, y0, z0, voxelSize } = this.dims
    return {
      x: x0 + (ix + 0.5) * voxelSize,
      y: y0 + (iy + 0.5) * voxelSize,
      z: z0 + (iz + 0.5) * voxelSize,
    }
  }

  /** World point -> voxel index (floor to cell). May be out of bounds. */
  worldToVoxel(x: number, y: number, z: number): { ix: number; iy: number; iz: number } {
    const { x0, y0, z0, voxelSize } = this.dims
    return {
      ix: Math.floor((x - x0) / voxelSize),
      iy: Math.floor((y - y0) / voxelSize),
      iz: Math.floor((z - z0) / voxelSize),
    }
  }

  /**
   * Expand the dirty AABB to include the given voxel-index box (inclusive),
   * clamped to the grid. Calling repeatedly grows the union. The box is
   * normalized so callers may pass corners in any order.
   */
  markDirty(ix0: number, iy0: number, iz0: number, ix1: number, iy1: number, iz1: number): void {
    const { nx, ny, nz } = this.dims
    let lo0 = Math.min(ix0, ix1)
    let lo1 = Math.min(iy0, iy1)
    let lo2 = Math.min(iz0, iz1)
    let hi0 = Math.max(ix0, ix1)
    let hi1 = Math.max(iy0, iy1)
    let hi2 = Math.max(iz0, iz1)

    // Clamp to the grid extents.
    lo0 = Math.max(0, Math.min(lo0, nx - 1))
    lo1 = Math.max(0, Math.min(lo1, ny - 1))
    lo2 = Math.max(0, Math.min(lo2, nz - 1))
    hi0 = Math.max(0, Math.min(hi0, nx - 1))
    hi1 = Math.max(0, Math.min(hi1, ny - 1))
    hi2 = Math.max(0, Math.min(hi2, nz - 1))

    if (this._dirty === null) {
      this._dirty = { ix0: lo0, iy0: lo1, iz0: lo2, ix1: hi0, iy1: hi1, iz1: hi2 }
      return
    }
    const d = this._dirty
    d.ix0 = Math.min(d.ix0, lo0)
    d.iy0 = Math.min(d.iy0, lo1)
    d.iz0 = Math.min(d.iz0, lo2)
    d.ix1 = Math.max(d.ix1, hi0)
    d.iy1 = Math.max(d.iy1, hi1)
    d.iz1 = Math.max(d.iz1, hi2)
  }

  /** The accumulated dirty AABB (inclusive voxel indices), or null when clean. */
  get dirty(): DirtyBox | null {
    if (this._dirty === null) return null
    // Hand back a copy so callers cannot mutate internal state.
    return { ...this._dirty }
  }

  clearDirty(): void {
    this._dirty = null
  }

  /** Copy of the field data — per-op baseline / seek-backward snapshot. */
  snapshot(): Float32Array {
    return this.data.slice()
  }

  /**
   * Copy `snap` into the field and mark the whole field dirty. `snap` must match
   * the field length; a mismatch is a programmer error and fails loud (ADR-0003).
   */
  restore(snap: Float32Array, region?: DirtyBox): void {
    if (snap.length !== this.data.length) {
      throw new Error(
        `VoxelField.restore: snapshot length ${snap.length} != field length ${this.data.length}`,
      )
    }
    if (region) {
      // WO-2929: undoing an elapsed prefix only changes the box that prefix
      // touched. Re-uploading the whole stock here stalls foreground playback.
      // The caller must retain that box BEFORE the texture sync clears dirty.
      const { nx, ny, nz } = this.dims
      for (let z = region.iz0; z <= region.iz1; z++) {
        for (let y = region.iy0; y <= region.iy1; y++) {
          const start = z * nx * ny + y * nx + region.ix0
          this.data.set(snap.subarray(start, start + region.ix1 - region.ix0 + 1), start)
        }
      }
      for (let y = region.iy0; y <= region.iy1; y++) {
        this.columnTop.fill(nz - 1, y * nx + region.ix0, y * nx + region.ix1 + 1)
      }
      this.markDirty(region.ix0, region.iy0, region.iz0, region.ix1, region.iy1, region.iz1)
      return
    }
    this.data.set(snap)
    // data was bulk-replaced; re-establish the HWM conservatively (all solid).
    // A loose/high HWM only costs extra no-op scans, never wrong results; this is
    // exactly the SimulationPanel seek-backward path, so it MUST NOT skip
    // now-restored solid voxels.
    this.resetColumnTopSolid()
    this.markWholeDirty()
  }

  private markWholeDirty(): void {
    const { nx, ny, nz } = this.dims
    this._dirty = { ix0: 0, iy0: 0, iz0: 0, ix1: nx - 1, iy1: ny - 1, iz1: nz - 1 }
  }
}
