import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project } from '../../types'

const project = JSON.parse(readFileSync(process.env.LIENCAM_WO2547_PROJECT ?? path.resolve(__dirname,
  '../../../examples/04-tool-storage-bar/tool-storage-bar.camproject'), 'utf8')) as Project

// Compare physical features after undoing the Y flip, not drawing loop IDs:
// the two drawings intentionally give the same holes different IDs and X values.
function features(setup: Project['setups'][number], type: string) {
  return setup.operations.filter(op => op.enabled && op.type === type).flatMap(op => {
    const params = op.params as { geometryId: string; loopIds: string[] }
    const geometry = project.geometry.find(g => g.id === params.geometryId)!
    return params.loopIds.map(id => {
      const loop = geometry.loops!.find(l => l.id === id)!
      expect(loop.type).toBe('hole')
      const xs = loop.points.map(p => p.x), ys = loop.points.map(p => p.y)
      const x = (Math.min(...xs) + Math.max(...xs)) / 2
      const y = (Math.min(...ys) + Math.max(...ys)) / 2
      const diameter = Math.max(...xs) - Math.min(...xs)
      return [setup.flipOf ? -x : x, y, diameter].map(v => v.toFixed(3)).join(',')
    })
  }).sort()
}

const expected = ['-55.000,0.000,6.500', '-12.000,0.000,8.500', '41.000,0.000,12.500'].sort()

describe('WO-2547: one side makes each storage-bar hole', () => {
  it('makes every required hole once, with no drilling or boring from the opposite side', () => {
    for (const type of ['drill', 'bore']) {
      const sides = project.setups.map(setup => features(setup, type))
      expect(sides.flat().sort()).toEqual(expected)
      expect(sides[0].filter(hole => sides[1].includes(hole))).toEqual([])
    }
  })

  it('breaks through the bottom face from G54 and clears the drill point into the spoilboard', () => {
    for (const op of project.setups[0].operations.filter(o => ['drill', 'bore'].includes(o.type))) {
      const intent = op.smartHeight as { intent: { machining: { end: { value: { plane: { offsetMm: number } } } } } }
      expect(intent.intent.machining.end.value.plane.offsetMm).toBe(op.type === 'drill' ? -13 : -12.5)
    }
  })

  it('chamfers both accessible rims, with only chamfers in G55', () => {
    expect(project.setups[1].operations.map(o => o.type)).toEqual(['chamfer'])
    for (const setup of project.setups) expect(features(setup, 'chamfer')).toEqual(expected)
  })

  it('preserves the stock, two work offsets and Y flip', () => {
    expect(project.sceneStock.fixedStocks[0]).toMatchObject({ width: 160, height: 50, depth: 12 })
    expect(project.setups.map(s => s.wcs.fixtureOffset)).toEqual([54, 55])
    expect(project.setups[1].flipOf).toEqual({ setupId: project.setups[0].id, axis: 'y' })
    expect(project.setups[1].wcs.origin).toEqual(project.setups[0].wcs.origin)
    expect(project.workholding?.instances).toHaveLength(4)
  })

  it('saves production-generated full-depth paths at every pilot and finished bore diameter', () => {
    const top = project.setups[0]
    const drill = top.operations.find(o => o.type === 'drill')!
    const bore = top.operations.find(o => o.type === 'bore')!
    expect(top.operations.map(o => o.status)).toEqual(['ready', 'ready', 'ready'])
    expect(project.setups[1].operations.map(o => o.status)).toEqual(['ready'])
    for (const [x, diameter] of [[-55, 6.5], [-12, 8.5], [41, 12.5]]) {
      const pilot = drill.toolpathMoves!.filter(m => Math.abs(m.x - x) < 0.001 && Math.abs(m.y) < 0.001)
      expect(Math.min(...pilot.map(m => m.z))).toBe(-13)
      const floor = bore.toolpathMoves!.filter(m => m.z <= -12.5 && Math.hypot(m.x - x, m.y) < diameter / 2)
      expect(Math.min(...bore.toolpathMoves!.map(m => m.z))).toBe(-12.5)
      expect(floor.length).toBeGreaterThan(0)
      const largestOrbit = Math.max(...floor.map(m => Math.hypot(m.x - x, m.y)))
      expect(largestOrbit * 2 + 3).toBeCloseTo(diameter, 3)
    }
  })

  it('pecks every pilot in 3 mm increments with full retracts and a reachable break-through bore', () => {
    const drill = project.setups[0].operations.find(o => o.type === 'drill')!
    const bore = project.setups[0].operations.find(o => o.type === 'bore')!
    expect(drill.params).toMatchObject({ cycleType: 'peck', peckDepth: 3 })
    expect(project.toolLibrary.find(t => t.id === bore.toolId)).toMatchObject({ diameter: 3, fluteLength: 15 })
    expect(bore.params.clearanceAllowanceMm).toBe(0.25)
    for (const x of [-55, -12, 41]) {
      const moves = drill.toolpathMoves!.filter(m => Math.abs(m.x - x) < 0.001 && Math.abs(m.y) < 0.001)
      const plunges = moves.filter(m => m.type === 'feed' && m.role === 'plunge')
      expect(plunges.map(m => m.z)).toEqual([-3, -6, -9, -12, -13])
      for (const plunge of plunges.slice(0, -1)) {
        expect(moves[moves.indexOf(plunge) + 1]).toMatchObject({ type: 'rapid', z: 5 })
      }
    }
  })

  it('explains the pecks, break-through and long-flute specification in the saved setup and exported sheet', () => {
    const notes = project.setups[0].notes
    const sheet = readFileSync(path.resolve(__dirname, '../../../examples/04-tool-storage-bar/job-sheet.txt'), 'utf8')
    for (const text of [notes, sheet]) {
      expect(text).toContain('G83 Q3')
      expect(text).toContain('Z-12.5')
      expect(text).toContain('15 mm flutes')
      expect(text).toContain('0.25 mm shank clearance')
    }
  })

  it('ships five combined programs that only chamfer after the flip', () => {
    for (const dialect of ['generic', 'grbl', 'grblhal', 'linuxcnc', 'uccnc']) {
      const nc = readFileSync(path.resolve(__dirname, `../../../examples/gcode/04-tool-storage-bar-${dialect}.nc`), 'utf8')
      const top = nc.split(/\bG55\b/)[0]
      expect(top).toContain('Z-12.5')
      expect(top).not.toMatch(/\bG81\b/)
      if (['uccnc', 'linuxcnc'].includes(dialect)) expect(top).toMatch(/\bG83\b[^\n]*\bQ3\b/)
      else {
        expect(top).not.toMatch(/\bG83\b/)
        for (const z of [-3, -6, -9, -12, -13]) expect(top).toContain(`Z${z}`)
      }
      const bottom = nc.split(/\bG55\b/).at(-1)!
      expect(bottom).toContain('Chamfer underside')
      expect(bottom).not.toMatch(/Drill|Bore|\bG8[123]\b|\bZ-1[23]\b/)
      expect(nc).toMatch(/M0[\s\S]*G55/)
    }
  })
})
