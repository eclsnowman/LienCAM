import { describe, it, expect } from 'vitest'
import {
  planVoxelGrid,
  VoxelField,
  type StockBounds,
  type VoxelGridDims,
} from '../../../lib/simulation/voxel/VoxelField'

const bounds = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): StockBounds => ({
  x0, y0, z0, x1, y1, z1,
})

describe('planVoxelGrid', () => {
  it('returns exact ceil dims and coarsened=false when within budget', () => {
    // 10x20x5 mm @ 1mm -> 10x20x5 = 1000 cells, budget plenty.
    const plan = planVoxelGrid(bounds(0, 0, 0, 10, 20, 5), 1, 1_000_000)
    expect(plan.dims.nx).toBe(10)
    expect(plan.dims.ny).toBe(20)
    expect(plan.dims.nz).toBe(5)
    expect(plan.dims.voxelSize).toBe(1)
    expect(plan.coarsened).toBe(false)
    expect(plan.requestedVoxelSize).toBe(1)
  })

  it('ceils non-integer extents per axis', () => {
    // 9.5 / 2 = 4.75 -> ceil 5 ; 4.0 / 2 = 2 ; 0.1 / 2 = 0.05 -> ceil 1
    const plan = planVoxelGrid(bounds(0, 0, 0, 9.5, 4, 0.1), 2, 1_000_000)
    expect(plan.dims.nx).toBe(5)
    expect(plan.dims.ny).toBe(2)
    expect(plan.dims.nz).toBe(1)
    expect(plan.coarsened).toBe(false)
  })

  it('floors every dim at 1 even for zero/negative extents', () => {
    const plan = planVoxelGrid(bounds(5, 5, 5, 5, 5, 4), 0.5, 1000)
    expect(plan.dims.nx).toBe(1)
    expect(plan.dims.ny).toBe(1)
    expect(plan.dims.nz).toBe(1)
  })

  it('coarsens uniformly when over budget: fits, grows voxelSize, flags coarsened', () => {
    // 100x100x100 mm @ 1mm -> 1,000,000 cells; budget 64,000.
    const requested = 1
    const max = 64_000
    const plan = planVoxelGrid(bounds(0, 0, 0, 100, 100, 100), requested, max)
    const total = plan.dims.nx * plan.dims.ny * plan.dims.nz
    expect(total).toBeLessThanOrEqual(max)
    expect(plan.dims.voxelSize).toBeGreaterThan(requested)
    expect(plan.coarsened).toBe(true)
    expect(plan.requestedVoxelSize).toBe(requested)
  })

  it('coarsening lands near but not wastefully under the budget', () => {
    // Sanity: the result should be reasonably close to the budget, not collapsed
    // to a tiny grid (cbrt scaling, not a naive halving loop).
    const max = 100_000
    const plan = planVoxelGrid(bounds(0, 0, 0, 200, 200, 200), 0.5, max)
    const total = plan.dims.nx * plan.dims.ny * plan.dims.nz
    expect(total).toBeLessThanOrEqual(max)
    // Within budget but using a meaningful fraction of it.
    expect(total).toBeGreaterThan(max * 0.3)
    expect(plan.coarsened).toBe(true)
  })

  it('throws on non-positive voxel size and sub-1 budget', () => {
    expect(() => planVoxelGrid(bounds(0, 0, 0, 1, 1, 1), 0, 100)).toThrow()
    expect(() => planVoxelGrid(bounds(0, 0, 0, 1, 1, 1), -1, 100)).toThrow()
    expect(() => planVoxelGrid(bounds(0, 0, 0, 1, 1, 1), 1, 0)).toThrow()
  })
})

const makeDims = (nx: number, ny: number, nz: number, voxelSize = 1, x0 = 0, y0 = 0, z0 = 0): VoxelGridDims => ({
  nx, ny, nz, voxelSize, x0, y0, z0,
})

describe('VoxelField construction', () => {
  it('allocates a zero-filled Float32Array of length nx*ny*nz', () => {
    const f = new VoxelField(makeDims(3, 4, 5))
    expect(f.data).toBeInstanceOf(Float32Array)
    expect(f.data.length).toBe(3 * 4 * 5)
    expect(Array.from(f.data).every((v) => v === 0)).toBe(true)
  })

  it('starts clean (dirty === null)', () => {
    const f = new VoxelField(makeDims(2, 2, 2))
    expect(f.dirty).toBeNull()
  })
})

describe('idx', () => {
  it('matches the documented formula iz*nx*ny + iy*nx + ix and round-trips a manual decode', () => {
    const nx = 4, ny = 3, nz = 5
    const f = new VoxelField(makeDims(nx, ny, nz))
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const i = f.idx(ix, iy, iz)
          expect(i).toBe(iz * nx * ny + iy * nx + ix)
          // Manual decode back to (ix,iy,iz).
          const dix = i % nx
          const diy = Math.floor(i / nx) % ny
          const diz = Math.floor(i / (nx * ny))
          expect([dix, diy, diz]).toEqual([ix, iy, iz])
        }
      }
    }
  })

  it('produces a contiguous 0..n-1 permutation over the whole grid', () => {
    const nx = 3, ny = 3, nz = 3
    const f = new VoxelField(makeDims(nx, ny, nz))
    const seen = new Set<number>()
    for (let iz = 0; iz < nz; iz++)
      for (let iy = 0; iy < ny; iy++)
        for (let ix = 0; ix < nx; ix++) seen.add(f.idx(ix, iy, iz))
    expect(seen.size).toBe(nx * ny * nz)
    for (let i = 0; i < nx * ny * nz; i++) expect(seen.has(i)).toBe(true)
  })
})

describe('inBounds', () => {
  it('accepts interior and edge cells, rejects out-of-range on every axis', () => {
    const f = new VoxelField(makeDims(2, 3, 4))
    // edges
    expect(f.inBounds(0, 0, 0)).toBe(true)
    expect(f.inBounds(1, 2, 3)).toBe(true)
    // one past each upper edge
    expect(f.inBounds(2, 0, 0)).toBe(false)
    expect(f.inBounds(0, 3, 0)).toBe(false)
    expect(f.inBounds(0, 0, 4)).toBe(false)
    // negatives
    expect(f.inBounds(-1, 0, 0)).toBe(false)
    expect(f.inBounds(0, -1, 0)).toBe(false)
    expect(f.inBounds(0, 0, -1)).toBe(false)
  })
})

describe('get / set', () => {
  it('stores and retrieves arbitrary floats', () => {
    const f = new VoxelField(makeDims(2, 2, 2))
    f.set(1, 0, 1, -3.5)
    expect(f.get(1, 0, 1)).toBeCloseTo(-3.5)
    expect(f.data[f.idx(1, 0, 1)]).toBeCloseTo(-3.5)
  })

  it('set() marks that cell dirty', () => {
    const f = new VoxelField(makeDims(5, 5, 5))
    expect(f.dirty).toBeNull()
    f.set(2, 3, 4, 1)
    expect(f.dirty).toEqual({ ix0: 2, iy0: 3, iz0: 4, ix1: 2, iy1: 3, iz1: 4 })
  })
})

describe('world <-> voxel mapping', () => {
  it('voxel center maps back to the same cell (consistency)', () => {
    const f = new VoxelField(makeDims(6, 6, 6, 0.25, -1, 2, 0.5))
    for (const [ix, iy, iz] of [
      [0, 0, 0],
      [3, 2, 5],
      [5, 5, 5],
    ] as const) {
      const c = f.voxelCenterWorld(ix, iy, iz)
      const v = f.worldToVoxel(c.x, c.y, c.z)
      expect(v).toEqual({ ix, iy, iz })
    }
  })

  it('voxelCenterWorld uses x0 + (i+0.5)*voxelSize', () => {
    const f = new VoxelField(makeDims(4, 4, 4, 2, 10, 20, 30))
    expect(f.voxelCenterWorld(0, 0, 0)).toEqual({ x: 11, y: 21, z: 31 })
    expect(f.voxelCenterWorld(1, 2, 3)).toEqual({ x: 13, y: 25, z: 37 })
  })

  it('worldToVoxel floors to the containing cell', () => {
    const f = new VoxelField(makeDims(10, 10, 10, 1, 0, 0, 0))
    expect(f.worldToVoxel(0.0, 0.99, 1.0)).toEqual({ ix: 0, iy: 0, iz: 1 })
    expect(f.worldToVoxel(3.5, 3.5, 3.5)).toEqual({ ix: 3, iy: 3, iz: 3 })
    // below the origin -> negative index (out of bounds, but floored honestly)
    expect(f.worldToVoxel(-0.5, 0, 0)).toEqual({ ix: -1, iy: 0, iz: 0 })
  })
})

describe('markDirty accumulation and clamping', () => {
  it('accumulates a growing union AABB across calls', () => {
    const f = new VoxelField(makeDims(10, 10, 10))
    f.markDirty(2, 2, 2, 4, 4, 4)
    expect(f.dirty).toEqual({ ix0: 2, iy0: 2, iz0: 2, ix1: 4, iy1: 4, iz1: 4 })
    f.markDirty(5, 1, 3, 6, 1, 3) // extends +x and -y
    expect(f.dirty).toEqual({ ix0: 2, iy0: 1, iz0: 2, ix1: 6, iy1: 4, iz1: 4 })
  })

  it('normalizes reversed corners', () => {
    const f = new VoxelField(makeDims(10, 10, 10))
    f.markDirty(7, 8, 9, 1, 2, 3)
    expect(f.dirty).toEqual({ ix0: 1, iy0: 2, iz0: 3, ix1: 7, iy1: 8, iz1: 9 })
  })

  it('clamps to the grid extents', () => {
    const f = new VoxelField(makeDims(4, 4, 4))
    f.markDirty(-5, -5, -5, 100, 100, 100)
    expect(f.dirty).toEqual({ ix0: 0, iy0: 0, iz0: 0, ix1: 3, iy1: 3, iz1: 3 })
  })

  it('returns a copy so callers cannot mutate internal state', () => {
    const f = new VoxelField(makeDims(4, 4, 4))
    f.markDirty(1, 1, 1, 2, 2, 2)
    const d = f.dirty!
    d.ix0 = 99
    expect(f.dirty).toEqual({ ix0: 1, iy0: 1, iz0: 1, ix1: 2, iy1: 2, iz1: 2 })
  })
})

describe('clearDirty', () => {
  it('resets dirty to null', () => {
    const f = new VoxelField(makeDims(3, 3, 3))
    f.set(0, 0, 0, 1)
    expect(f.dirty).not.toBeNull()
    f.clearDirty()
    expect(f.dirty).toBeNull()
  })
})

describe('reset', () => {
  it('fills the whole field and marks the entire grid dirty', () => {
    const f = new VoxelField(makeDims(3, 2, 4))
    f.reset(7)
    expect(Array.from(f.data).every((v) => v === 7)).toBe(true)
    expect(f.dirty).toEqual({ ix0: 0, iy0: 0, iz0: 0, ix1: 2, iy1: 1, iz1: 3 })
  })
})

describe('snapshot / restore', () => {
  it('snapshot is an independent copy', () => {
    const f = new VoxelField(makeDims(3, 3, 3))
    f.set(1, 1, 1, 5)
    f.clearDirty()
    const snap = f.snapshot()
    f.set(1, 1, 1, -5) // mutate after snapshot
    expect(snap[f.idx(1, 1, 1)]).toBe(5)
    expect(f.get(1, 1, 1)).toBe(-5)
  })

  it('restore round-trips the field contents', () => {
    const f = new VoxelField(makeDims(2, 2, 2))
    f.set(0, 0, 0, 1)
    f.set(1, 1, 1, 2)
    const snap = f.snapshot()
    f.reset(0)
    f.restore(snap)
    expect(f.get(0, 0, 0)).toBe(1)
    expect(f.get(1, 1, 1)).toBe(2)
  })

  it('restore marks the whole field dirty', () => {
    const f = new VoxelField(makeDims(2, 3, 2))
    const snap = f.snapshot()
    f.clearDirty()
    f.restore(snap)
    expect(f.dirty).toEqual({ ix0: 0, iy0: 0, iz0: 0, ix1: 1, iy1: 2, iz1: 1 })
  })

  it('restore fails loud on length mismatch', () => {
    const f = new VoxelField(makeDims(2, 2, 2))
    expect(() => f.restore(new Float32Array(7))).toThrow()
  })
})
