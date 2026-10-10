import { describe, it, expect } from 'vitest'
import { VoxelSimulator, toolShapeFromTool } from '../../lib/simulation/VoxelSimulator'
import { toolProfile } from '../../lib/simulation/voxel/carve'
import type { StockBounds } from '../../lib/simulation/voxel/VoxelField'

// A roomy budget for the small fields used here.
const BIG_BUDGET = 1_000_000

const bounds = (
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): StockBounds => ({ x0, y0, z0, x1, y1, z1 })

describe('toolShapeFromTool', () => {
  it('maps diameter -> radius (= d/2) and passes cornerRadius through', () => {
    const s = toolShapeFromTool({ type: 'bull_nose', diameter: 6, cornerRadius: 1.5 })
    expect(s.type).toBe('bull_nose')
    expect(s.radius).toBe(3)
    expect(s.cornerRadius).toBe(1.5)
  })

  it('passes angleFromAxisDeg through as the half-angle from axis (no conversion)', () => {
    // A "90 deg V-bit" stores angleFromAxisDeg = 45 (per side) -> slope 1/tan(45) = 1,
    // i.e. profile(d) = d. If toolShapeFromTool wrongly halved/doubled the angle, the
    // slope would be off and fail here.
    const s45 = toolShapeFromTool({ type: 'v_bit', diameter: 10, angleFromAxisDeg: 45 })
    expect(s45.angleFromAxisDeg).toBe(45)
    const p45 = toolProfile(s45)
    expect(p45(0)).toBeCloseTo(0)
    expect(p45(1)).toBeCloseTo(1)
    expect(p45(2)).toBeCloseTo(2)

    // A 30 deg from-axis V-bit (= 60 included) -> slope = 1/tan(30) = sqrt(3).
    const s30 = toolShapeFromTool({ type: 'v_bit', diameter: 10, angleFromAxisDeg: 30 })
    const p30 = toolProfile(s30)
    const slope = 1 / Math.tan((30 * Math.PI) / 180)
    expect(p30(1)).toBeCloseTo(slope)
    expect(p30(2)).toBeCloseTo(2 * slope)
  })

  it('maps a drill default (59 deg from axis = 118 included) without conversion', () => {
    // The drill default is 59 from axis (= the standard 118 FULL point angle). It must
    // pass through unchanged; carve treats drill as flat today but the value must survive.
    const s = toolShapeFromTool({ type: 'drill', diameter: 6, angleFromAxisDeg: 59 })
    expect(s.radius).toBe(3)
    expect(s.angleFromAxisDeg).toBe(59)
  })
})

describe('VoxelSimulator constructor', () => {
  it('builds a solid field (deep-interior voxel > 0) and is not coarsened within budget', () => {
    const sim = new VoxelSimulator(bounds(0, 0, 0, 10, 10, 10), 1, BIG_BUDGET)
    expect(sim.coarsened).toBe(false)
    expect(sim.band).toBe(3) // 3 * voxelSize(1)
    const { nx, ny, nz } = sim.field.dims
    expect(nx).toBe(10)
    expect(ny).toBe(10)
    expect(nz).toBe(10)
    // Deep interior voxel is solid (> 0); band clamps it to the band width.
    const c = sim.field.get(5, 5, 5)
    expect(c).toBeGreaterThan(0)
  })

  it('sets coarsened=true when bounds * small voxel exceed the budget', () => {
    // 100mm cube at 0.1mm -> 1000^3 = 1e9 cells, far over a tiny budget.
    const sim = new VoxelSimulator(bounds(0, 0, 0, 100, 100, 100), 0.1, 10_000)
    expect(sim.coarsened).toBe(true)
    const total = sim.field.dims.nx * sim.field.dims.ny * sim.field.dims.nz
    expect(total).toBeLessThanOrEqual(10_000)
    // The voxel size must have been enlarged past the requested 0.1mm.
    expect(sim.field.dims.voxelSize).toBeGreaterThan(0.1)
  })
})

describe('VoxelSimulator.sweepMove', () => {
  it('removes a channel along the path with a flat end mill', () => {
    // 20x20x10mm stock at 1mm voxels.
    const sim = new VoxelSimulator(bounds(0, 0, 0, 20, 20, 10), 1, BIG_BUDGET)
    const tool = { type: 'flat_end_mill', diameter: 4 }
    // Sweep along x at mid-y, cutting from the top (z=10) down to z=5.
    // Carve the tool TIP along a line that holds at z=5 across the middle.
    sim.sweepMove({ x: 2, y: 10, z: 5 }, { x: 18, y: 10, z: 5 }, tool)

    // A voxel under the path mid-segment, above the tip, is now air (< 0).
    const onPath = sim.field.worldToVoxel(10, 10, 8)
    expect(sim.field.get(onPath.ix, onPath.iy, onPath.iz)).toBeLessThan(0)

    // An off-path voxel (far in +y, well outside the 2mm tool radius) stays solid.
    const offPath = sim.field.worldToVoxel(10, 18, 8)
    expect(sim.field.get(offPath.ix, offPath.iy, offPath.iz)).toBeGreaterThan(0)
  })
})

describe('VoxelSimulator snapshot/restore', () => {
  it('round-trips: restore brings back the pre-carve solid', () => {
    const sim = new VoxelSimulator(bounds(0, 0, 0, 20, 20, 10), 1, BIG_BUDGET)
    const tool = { type: 'flat_end_mill', diameter: 4 }

    const probe = sim.field.worldToVoxel(10, 10, 8)
    const before = sim.field.get(probe.ix, probe.iy, probe.iz)
    expect(before).toBeGreaterThan(0)

    const snap = sim.snapshot()
    sim.sweepMove({ x: 2, y: 10, z: 5 }, { x: 18, y: 10, z: 5 }, tool)
    expect(sim.field.get(probe.ix, probe.iy, probe.iz)).toBeLessThan(0) // carved

    sim.restore(snap)
    expect(sim.field.get(probe.ix, probe.iy, probe.iz)).toBe(before) // restored
  })

  it('reset re-initializes solid stock after a carve', () => {
    const sim = new VoxelSimulator(bounds(0, 0, 0, 20, 20, 10), 1, BIG_BUDGET)
    const probe = sim.field.worldToVoxel(10, 10, 8)
    const before = sim.field.get(probe.ix, probe.iy, probe.iz)

    sim.sweepMove({ x: 2, y: 10, z: 5 }, { x: 18, y: 10, z: 5 }, { type: 'flat_end_mill', diameter: 4 })
    expect(sim.field.get(probe.ix, probe.iy, probe.iz)).toBeLessThan(0)

    sim.reset()
    expect(sim.field.get(probe.ix, probe.iy, probe.iz)).toBe(before)
  })
})
