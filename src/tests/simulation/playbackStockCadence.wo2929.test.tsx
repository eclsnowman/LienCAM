import { describe, expect, it, vi } from 'vitest'
import { VoxelSimulator, toolShapeFromTool, type VoxelSimTool } from '../../lib/simulation/VoxelSimulator'
import { carvePoint } from '../../lib/simulation/voxel/carve'

const tool: VoxelSimTool = { type: 'flat_end_mill', diameter: 6, fluteLength: 20, overallLength: 50 }
type Point = { x: number; y: number; z: number }
const bounds = { x0: -3.17, y0: -2.13, z0: -4.2, x1: 28.31, y1: 17.83, z1: 0.43 }
const makeSim = () => new VoxelSimulator(bounds, 0.7, 8000000)

// Independent scheduling oracle: original discrete stamps and original CSG
// primitive, never the optimized sweep. Preserve exact f64 interpolation.
function stamps(sim: VoxelSimulator, from: Point, to: Point, t = tool): void {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz) / (0.5 * sim.field.dims.voxelSize)))
  const shape = toolShapeFromTool(t)
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    carvePoint(sim.field, from.x + dx * u, from.y + dy * u, from.z + dz * u, shape, sim.band)
  }
}
function identical(a: VoxelSimulator, b: VoxelSimulator): void {
  expect(Buffer.from(a.field.data.buffer).equals(Buffer.from(b.field.data.buffer)), 'all carved Float32 bytes must match original stamps').toBe(true)
}

describe('WO-2929 stock-on discrete sweep cadence without geometry changes', () => {
  it('undoes a prefix byte-exactly without dirtying untouched stock for upload', () => {
    const sim = makeSim()
    const baseline = sim.snapshot()
    sim.field.clearDirty()
    sim.sweepMove({ x: 3, y: 5, z: -1 }, { x: 8, y: 5, z: -1 }, tool)
    const box = sim.field.dirty!
    expect(box).not.toBeNull()
    sim.field.clearDirty() // production texture upload consumes the dirty box
    sim.field.restore(baseline, box)
    expect(Buffer.from(sim.field.data.buffer).equals(Buffer.from(baseline.buffer))).toBe(true)
    expect(sim.field.dirty, 'prefix rollback must retain its bounded texture upload').toEqual(box)
    // Restored solid must not be skipped by the column high-water optimization.
    const witness = makeSim()
    sim.sweepMove({ x: 4, y: 6, z: -3 }, { x: 10, y: 6, z: -3 }, tool)
    witness.sweepMove({ x: 4, y: 6, z: -3 }, { x: 10, y: 6, z: -3 }, tool)
    identical(sim, witness)
  })

  it('unions rollback dirt with pending cuts and retains whole keyframe restores', () => {
    const sim = makeSim()
    const baseline = sim.snapshot()
    sim.field.clearDirty()
    sim.sweepMove({ x: 3, y: 5, z: -1 }, { x: 8, y: 5, z: -1 }, tool)
    const box = sim.field.dirty!
    sim.field.clearDirty()
    sim.field.markDirty(0, 0, 0, 1, 1, 1)
    sim.field.restore(baseline, box)
    expect(sim.field.dirty).toEqual({ ...box, ix0: 0, iy0: 0, iz0: 0 })
    sim.field.restore(baseline)
    expect(sim.field.dirty).toEqual({ ix0: 0, iy0: 0, iz0: 0,
      ix1: sim.field.dims.nx - 1, iy1: sim.field.dims.ny - 1, iz1: sim.field.dims.nz - 1 })
  })

  it('traverses the field once for a long horizontal flat sweep instead of once per stamp', () => {
    const sim = makeSim()
    const mapping = vi.spyOn(sim.field, 'worldToVoxel')
    sim.sweepMove({ x: -4, y: 5.123, z: -0.91 }, { x: 29, y: 5.123, z: -0.91 }, tool)
    console.info(JSON.stringify({ fieldBoundsMappings: mapping.mock.calls.length }))
    expect(mapping.mock.calls.length, 'one CSG traversal must replace repeated discrete-stamp traversals').toBe(2)
  })

  it('traverses the field once for a vertical drill sweep instead of replaying nested stamps', () => {
    const sim = makeSim()
    const mapping = vi.spyOn(sim.field, 'worldToVoxel')
    sim.sweepMove({ x: 11.123, y: 5.123, z: 3.91 }, { x: 11.123, y: 5.123, z: -3.91 }, { ...tool, type: 'drill' })
    expect(mapping.mock.calls.length, 'nested vertical stamps must be evaluated in one CSG traversal').toBe(2)
  })

  it('traverses a long sloping face ramp once while retaining every discrete stamp', () => {
    const sim = makeSim()
    const mapping = vi.spyOn(sim.field, 'worldToVoxel')
    sim.sweepMove({ x: -4, y: 5.123, z: -0.91 }, { x: 29, y: 5.123, z: -1.031 }, tool)
    expect(mapping.mock.calls.length, 'sloping face ramps must not replay the field for every stamp').toBe(2)
  })

  it('traverses the measured horizontal chamfer pass once with its original radial profile', () => {
    const sim = makeSim(), mapping = vi.spyOn(sim.field, 'worldToVoxel')
    sim.sweepMove({ x: -4, y: 5.123, z: -0.8 }, { x: 29, y: 5.123, z: -0.8 }, { ...tool, type: 'chamfer_mill', angleFromAxisDeg: 45 })
    expect(mapping.mock.calls.length, 'horizontal chamfer prefixes must traverse the field once').toBe(2)
  })

  it.each(['x-forward', 'x-backward', 'y-forward', 'y-backward'])(
    'keeps horizontal chamfer prefixes byte-identical for %s', route => {
      const sim = makeSim(), oracle = makeSim(), baseline = sim.snapshot()
      const t = { ...tool, type: 'chamfer_mill', angleFromAxisDeg: 45 }
      const from = { x: -4.123, y: 5.127, z: -0.8 }, to = { ...from, x: 29.137 }
      if (route.startsWith('y')) { from.x = 4.123; to.x = 4.123; from.y = -3.173; to.y = 20.131 }
      if (route.endsWith('backward')) { const p = { ...from }; Object.assign(from, to); Object.assign(to, p) }
      for (const fraction of [0.001, 0.173, 0.719, 1]) {
        sim.restore(baseline); oracle.restore(baseline)
        const end = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z }
        sim.sweepMove(from, end, t); stamps(oracle, from, end, t)
        identical(sim, oracle)
      }
    },
  )

  it.each(['x-up', 'x-down', 'y-up', 'y-down'])(
    'preserves every sloping prefix byte for %s including reverse XY travel', route => {
      const sim = makeSim(), oracle = makeSim(), baseline = sim.snapshot()
      for (const reversed of [false, true]) {
        for (const fraction of [0.001, 0.173, 0.719, 1]) {
          const from = { x: -4.123, y: 5.127, z: route.endsWith('up') ? -2.31 : -0.71 }
          const to = { ...from, x: 29.137, z: route.endsWith('up') ? -0.71 : -2.31 }
          if (route.startsWith('y')) { from.x = 4.123; to.x = 4.123; from.y = -3.173; to.y = 20.131 }
          if (reversed) { const p = { ...from }; Object.assign(from, to); Object.assign(to, p) }
          const end = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z + (to.z - from.z) * fraction }
          sim.restore(baseline); oracle.restore(baseline)
          sim.sweepMove(from, end, tool); stamps(oracle, from, end)
          identical(sim, oracle)
        }
      }
    },
  )

  it.each(['flat_end_mill', 'drill', 'ball_end_mill', 'lollipop'])(
    'keeps vertical up/down prefixes byte-identical for %s', type => {
      const sim = makeSim(), oracle = makeSim(), t = { ...tool, type }
      const baseline = sim.snapshot()
      for (const [a, b] of [[3.913, -3.711], [-3.711, 3.913]]) {
        for (const fraction of [0.001, 0.173, 0.921, 1]) {
          sim.restore(baseline); oracle.restore(baseline)
          const from = { x: 11.123, y: 5.127, z: a }, to = { ...from, z: a + (b - a) * fraction }
          sim.sweepMove(from, to, t); stamps(oracle, from, to, t)
          identical(sim, oracle)
          const next = { ...to, x: 13.713 }
          sim.sweepMove(to, next, t); stamps(oracle, to, next, t)
          identical(sim, oracle)
        }
      }
    },
  )

  it.each(['x-forward', 'x-backward', 'y-forward', 'y-backward'])(
    'keeps every prefix and restored field byte-identical for %s', route => {
      const from = { x: -4.123, y: 5.127, z: -1.013 }
      const to = { x: 29.137, y: 5.127, z: -1.013 }
      if (route.startsWith('y')) { from.x = 4.123; to.x = 4.123; from.y = -3.173; to.y = 20.131 }
      if (route.endsWith('backward')) {
        const p = { ...from }; Object.assign(from, to); Object.assign(to, p)
      }
      const sim = makeSim(), oracle = makeSim()
      // Existing material removal, then repeated prefix restore as in seekCarve.
      const preA = { x: 9.1, y: 2.13, z: -2.111 }, preB = { ...preA, y: 12.721 }
      stamps(sim, preA, preB); stamps(oracle, preA, preB)
      const baseline = sim.snapshot()
      for (const fraction of [0.001, 0.0371, 0.173, 0.5, 0.921, 1, 0.113, 0]) {
        sim.restore(baseline); oracle.restore(baseline)
        const end = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, z: from.z }
        sim.sweepMove(from, end, tool); stamps(oracle, from, end)
        identical(sim, oracle)
        // A following cut must remain exact despite conservative columnTop.
        const next = { ...end, z: -2.713 }
        sim.sweepMove(end, next, tool); stamps(oracle, end, next)
        identical(sim, oracle)
      }
    },
  )

  it.each(['diagonal', 'sloped', 'ball', 'undercut', 'zero'])(
    'preserves original discrete field on the %s fallback route', route => {
      const sim = makeSim(), oracle = makeSim()
      const from = { x: 1.127, y: 4.211, z: -1.013 }, to = { ...from, x: 24.739 }
      let t = tool
      if (route === 'diagonal') to.y = 11.123
      if (route === 'sloped') to.z = -3.17
      if (route === 'ball') t = { ...tool, type: 'ball_end_mill' }
      if (route === 'undercut') t = { ...tool, type: 'lollipop' }
      if (route === 'zero') Object.assign(to, from)
      sim.sweepMove(from, to, t); stamps(oracle, from, to, t)
      identical(sim, oracle)
    },
  )
})
