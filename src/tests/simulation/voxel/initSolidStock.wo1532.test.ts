import { describe, it, expect } from 'vitest'
import { VoxelSimulator } from '../../../lib/simulation/VoxelSimulator'
import { initSolidStock } from '../../../lib/simulation/voxel/carve'
import { VoxelField, type VoxelGridDims, type StockBounds } from '../../../lib/simulation/voxel/VoxelField'

// 10x10x10mm nominal stock at 7mm voxels: ceil(10/7) = 2 cells/axis, so the
// field's own (padded) AABB is 0..14mm on every axis — 4mm of rounded-up
// padding past the true 10mm stock. The far voxel's center (10.5mm) sits past
// the nominal face (10mm) but well inside the padded field AABB (14mm) — the
// exact shape of BUG-432 (observed on main as a 300x300x12mm stock whose
// 300..300.19mm / 0..12.49mm padding rendered as solid material).
const bounds: StockBounds = { x0: 0, y0: 0, z0: 0, x1: 10, y1: 10, z1: 10 }

describe('WO-1532: initSolidStock uses nominal stock bounds, not the padded field AABB', () => {
  it('a real VoxelSimulator does not solidify grid padding for a non-divisible stock size', () => {
    const sim = new VoxelSimulator(bounds, 7, 100_000)
    expect(sim.coarsened).toBe(false)
    expect(sim.field.dims).toMatchObject({ nx: 2, ny: 2, nz: 2, voxelSize: 7 })

    const padded = sim.field.voxelCenterWorld(1, 1, 1)
    expect(padded.x).toBeCloseTo(10.5)
    expect(padded.y).toBeCloseTo(10.5)
    expect(padded.z).toBeCloseTo(10.5)

    // Past the nominal 10mm face on every axis -> must be air (< 0), not
    // solid, even though it sits inside the field's padded 14mm AABB.
    expect(sim.field.get(1, 1, 1)).toBeLessThan(0)

    // The near-origin voxel is genuinely inside the nominal stock -> solid.
    expect(sim.field.get(0, 0, 0)).toBeGreaterThan(0)
  })

  it('every voxel matches the signed distance to the nominal bounds, clamped to the band', () => {
    const sim = new VoxelSimulator(bounds, 7, 100_000)
    const { nx, ny, nz } = sim.field.dims
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const c = sim.field.voxelCenterWorld(ix, iy, iz)
          const dist = Math.min(
            c.x - bounds.x0,
            bounds.x1 - c.x,
            c.y - bounds.y0,
            bounds.y1 - c.y,
            c.z - bounds.z0,
            bounds.z1 - c.z,
          )
          const expected = Math.max(-sim.band, Math.min(dist, sim.band))
          expect(sim.field.get(ix, iy, iz)).toBeCloseTo(expected)
        }
      }
    }
  })

  it('reset() reproduces the same corrected boundary, not the old padded one', () => {
    const sim = new VoxelSimulator(bounds, 7, 100_000)
    sim.reset()
    expect(sim.field.get(1, 1, 1)).toBeLessThan(0)
    expect(sim.field.get(0, 0, 0)).toBeGreaterThan(0)
  })

  it('a stock size that divides the resolution exactly is unaffected (byte-identical to the no-bounds path)', () => {
    const dims: VoxelGridDims = { nx: 4, ny: 4, nz: 4, voxelSize: 2.5, x0: 0, y0: 0, z0: 0 }
    const exactBounds: StockBounds = { x0: 0, y0: 0, z0: 0, x1: 10, y1: 10, z1: 10 }
    const band = 3 * dims.voxelSize

    const withBounds = new VoxelField(dims)
    initSolidStock(withBounds, band, exactBounds)

    const withoutBounds = new VoxelField(dims)
    initSolidStock(withoutBounds, band)

    expect(withBounds.data).toEqual(withoutBounds.data)
  })
})
