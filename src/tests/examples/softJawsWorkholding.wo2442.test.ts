// Production-button readback from tools/examples/build-soft-jaws.mjs.
// Per-setup coverage authorized by the architect's 8:00 AM assignment.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const evidence = path.resolve(__dirname, '../evidence/WO-2442/rebuild')
const readback = JSON.parse(readFileSync(path.join(evidence, 'readback.json'), 'utf8'))
const shipped = JSON.parse(readFileSync(path.resolve(__dirname, '../../../examples/03-soft-jaws/soft-jaws.camproject'), 'utf8'))

describe('WO-2442 two-setup soft jaws through production buttons', () => {
  it('saves and reopens two 80 x 18 x 16 jaw blanks on the saved vise', () => {
    expect(readback.reopenedStocks).toEqual(readback.savedStocks)
    expect(shipped.sceneStock.fixedStocks).toEqual(readback.savedStocks)
    expect(readback.reopenedStocks.map((s: any) => [s.width, s.height, s.depth, s.position])).toEqual([
      [80, 18, 16, { x: 0, y: 0, z: 0 }], [80, 18, 16, { x: 0, y: 38, z: 0 }],
    ])
    expect(readback.workholding).toEqual(shipped.workholding)
    expect(readback.workholding.definitions.some((d: any) => d.kind === 'vise')).toBe(true)
  })
  it('binds G54 and G55 to separate blanks with a vise and spacer on each', () => {
    expect(readback.setups).toHaveLength(2)
    expect(shipped.setups).toHaveLength(2)
    expect(shipped.setups.map((s: any) => s.wcs)).toEqual(readback.setups.map((s: any) => s.wcs))
    readback.setups.forEach((s: any, i: number) => {
      expect(s.wcs.stockId).toBe(readback.reopenedStocks[i].id)
      expect(s.wcs.fixtureOffset).toBe(54 + i)
      expect(s.holdingMethod).toBe('vise')
      expect(s.notes).toMatch(/20 mm spacer/)
      expect(s.notes).toMatch(/temporary clamps/i)
      const vise = readback.workholding.instances.find((v: any) => v.setupScope.kind === 'all' || v.setupScope.setupIds.includes(s.id))
      expect(vise).toBeDefined()
      expect(vise.definitionId).toBe(readback.workholding.instances[0].definitionId)
      expect(vise.worldPose).toEqual(readback.workholding.instances[0].worldPose)
      expect(vise.jointValuesMm).toEqual(readback.workholding.instances[0].jointValuesMm)
    })
  })
  it('recomputes face, grip pocket, drill and counterbore without contours', () => {
    readback.setups.forEach((s: any, i: number) => {
      expect(s.operations.map((o: any) => [o.type, o.status])).toEqual([
        ['face', 'ready'], ['pocket_2d', 'ready'], ['drill', 'ready'], ['bore', 'ready'],
      ])
      expect(shipped.setups[i].operations.map((o: any) => [o.type, o.params]))
        .toEqual(s.operations.map((o: any) => [o.type, o.params]))
      const mounting = readback.geometry.find((g: any) => g.name === `mounting-jaw-${i + 1}`)
      expect(mounting.stockId).toBe(readback.reopenedStocks[i].id)
      expect(mounting.loops).toHaveLength(2)
      expect(s.operations[2].params.loopIds).toHaveLength(2)
      expect(s.operations[3].params.loopIds).toHaveLength(2)
    })
    const steps = JSON.parse(readFileSync(path.join(evidence, 'steps.json'), 'utf8'))
    expect(steps.every((s: any) => s.status === 'passed')).toBe(true)
    expect(steps.some((s: any) => s.label === 'Reopen saved project in a fresh context')).toBe(true)
    expect(readback.errors).toEqual([])
  })
  it('posts both programs with their own work offsets and no post errors', () => {
    expect(readback.posts.map((p: any) => p.offset)).toEqual(['G54', 'G55'])
    readback.posts.forEach((p: any, i: number) => {
      expect(p.setupId).toBe(readback.setups[i].id)
      expect(p.diagnostics).toEqual([])
      expect(p.bytes).toBeGreaterThan(100)
      expect(readFileSync(path.join(evidence, p.file), 'utf8')).toMatch(new RegExp(`G${54 + i}\\b`))
    })
    const combined = readFileSync(path.join(evidence, 'soft-jaws.nc'), 'utf8')
    expect(combined).toMatch(/G54\b/)
    expect(combined).toMatch(/G55\b/)
  })
  it('exports job sheets listing both setups, their vise and spacer', () => {
    for (let i = 1; i <= 2; i++) {
      const sheet = readFileSync(path.join(evidence, `jaw-${i}.setup.txt`), 'utf8')
      expect(sheet).toContain(`Jaw ${i} - G${53 + i}`)
      expect(sheet).toMatch(/vise/i)
      expect(sheet).toMatch(/20 mm spacer/)
    }
    const combined = readFileSync(path.join(evidence, 'soft-jaws.setup.txt'), 'utf8')
    expect(combined).toMatch(/Jaw 1 - G54/)
    expect(combined).toMatch(/Jaw 2 - G55/)
  })
  for (let i = 0; i < 2; i++) {
    it(`simulates jaw ${i + 1} to the end in its own stock field with a carved grip`, () => {
      const sim = readback.simulations[i]
      expect(sim.setupId).toBe(readback.setups[i].id)
      expect([sim.final.x0, sim.final.x1, sim.final.y0, sim.final.y1, sim.final.z0, sim.final.z1])
        .toEqual([0, 80, i * 38, i * 38 + 18, 0, 16])
      expect(Math.abs(sim.positionMs - sim.totalMs)).toBeLessThanOrEqual(1)
      expect(sim.initial.volumeMm3).toBeGreaterThan(sim.final.volumeMm3)
      expect(sim.initial.samples.grip).toBeGreaterThan(0)
      expect(sim.final.samples.grip).toBeLessThan(0)
      expect(sim.final.samples.retained).toBeGreaterThan(0)
      expect(sim.final.samples.hole).toBeLessThan(0)
      expect(sim.final.samples.counterbore).toBeLessThan(0)
    })
  }
})
