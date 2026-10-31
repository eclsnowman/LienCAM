// WO-3080: a bottom-up (ascending) internal thread mill ends its helix at the hole top, not
// far above it. The owner (release review 2026-10-23, example 01 fixture plate, Thread Mill 3):
// "you are helixing up far beyond the part up. The end height seems excessive." The builder
// used to keep orbiting from the thread top up to the feed plane (ADR-0031 A2.1 "exit climb",
// 5 air turns per hole at the default 5 mm feed height). Now the helix stops at the thread top,
// the lead-out runs there, and the tool rapids straight up the open hole centre.
// 1. Production route: planChain (the store's computeOperationToolpath) on the declared fixture
//    plate; the thread_mill step's moves split per hole at the rapids to clearance.
// 2. Unit row: buildThreadMillToolpath directly (internal, climb, right-hand, feedZ = topZ + 5).
import { describe, expect, it } from 'vitest'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'
import type { ThreadMillParams, ThreadMillWorkerPayload, LoopData } from '../../lib/cam/types'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'

const EPS = 1e-6

// Split a thread_mill move list into one block per pass: each block starts at a rapid that
// follows a non-rapid move (the climb back to clearance closes the previous pass).
function passBlocks(moves: ToolpathMove[]): ToolpathMove[][] {
  const blocks: ToolpathMove[][] = []
  let cur: ToolpathMove[] = []
  for (const m of moves) {
    if (m.type === 'rapid' && cur.length > 0 && cur[cur.length - 1].type !== 'rapid') {
      blocks.push(cur)
      cur = []
    }
    cur.push(m)
  }
  if (cur.length > 0) blocks.push(cur)
  return blocks.filter(b => b.some(m => m.role === 'helix'))
}

describe('WO-3080 ascending thread mill ends at the hole top', () => {
  it('example 01 Thread Mill 3: every hole threads -8 -> -0.5 and no helix point is above the hole top', async () => {
    const plate = alpha3Chains().find(c => c.id === 'ex01-fixture-plate-declared')!
    const idx = plate.steps.findIndex(s => s.type === 'thread_mill')
    expect(idx, 'the fixture plate has a thread mill').toBeGreaterThanOrEqual(0)
    const planned = await planChain(plate)
    const step = planned.steps[idx]
    expect(step.status).toBe('ready')
    const blocks = passBlocks(step.moves)
    expect(blocks.length, 'one pass per hole').toBe(12)
    const topZ = -0.5
    const report = blocks.map(b => {
      const helix = b.filter(m => m.role === 'helix')
      const zs = helix.map(m => m.z)
      return {
        first: zs[0],
        max: Math.max(...zs),
        span: Math.max(...zs) - Math.min(...zs),
        above: zs.filter(z => z > topZ + EPS).length,
        leadOutZ: b.filter(m => m.role === 'lead_out').map(m => m.z),
      }
    })
    const above = report.reduce((n, r) => n + r.above, 0)
    console.log(`WO-3080 ex01 Thread Mill 3: blocks ${blocks.length}, max helix Z ${Math.max(...report.map(r => r.max))}, ` +
      `helix points above the hole top ${above}, cut time ms ${step.cutTimeMs}`)
    for (const r of report) {
      expect(r.first).toBeCloseTo(-8, 9)
      expect(r.max).toBeLessThanOrEqual(topZ + EPS)
      expect(r.span).toBeCloseTo(7.5, 6)
      expect(r.leadOutZ.length).toBeGreaterThan(0)
      for (const z of r.leadOutZ) expect(z).toBeCloseTo(topZ, 9)
    }
    expect(above, 'helix points above the hole top').toBe(0)
  }, 600_000)

  it('unit: internal climb right-hand with feedZ = topZ + 5 ends the helix at topZ and leads out there', () => {
    const tool = {
      id: 't1', name: 'O6 thread mill', type: 'thread_mill',
      diameter: 6, fluteLength: 30, shankDiameter: 6, overallLength: 60,
      numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
      feedsAndSpeeds: { default: { rpm: 6000, feedRate: 400, plungeRate: 120, depthOfCut: 5, stepover: 1 } },
    } as Tool
    const heights: HeightParams = {
      clearanceHeight: 10, clearanceHeightMode: 'absolute',
      retractHeight: 5, feedHeight: 5,
      topHeight: 0, topHeightMode: 'absolute',
      bottomHeight: -9, bottomHeightMode: 'absolute',
    }
    const passes: PassParams = { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
    const linking: LinkingParams = {
      entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    }
    const points = Array.from({ length: 64 }, (_, i) => ({ x: 4.25 * Math.cos(i / 32 * Math.PI), y: 4.25 * Math.sin(i / 32 * Math.PI) }))
    const loops: LoopData[] = [{ id: 'h1', closed: true, type: 'contour', points }]
    const params: ThreadMillParams = {
      geometryId: 'g1', loopIds: [], threadKind: 'internal', majorDiameter: 10, pitch: 1.5,
      handedness: 'right', cutDirection: 'climb', roughingPasses: 1, springPasses: 0,
      leadInOut: 'arc', compensation: 'computer',
    }
    const payload: ThreadMillWorkerPayload = {
      opId: 'op', setupId: 'su', params, heights, passes, linking, tool, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    const moves = buildThreadMillToolpath(payload)
    // The feed plane really is topZ + 5 here (the plunge passes through it).
    expect(moves.some(m => m.type === 'rapid' && Math.abs(m.z - 5) < 1e-9)).toBe(true)
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix[0].z).toBe(-9)
    expect(Math.max(...helix.map(m => m.z))).toBeCloseTo(0, 9)
    expect(helix.filter(m => m.z > EPS).length, 'air helix points above topZ').toBe(0)
    const leadOut = moves.filter(m => m.role === 'lead_out')
    expect(leadOut.length).toBeGreaterThan(0)
    for (const m of leadOut) expect(m.z).toBeCloseTo(0, 9)
    // Retract straight up the open hole centre.
    const last = moves[moves.length - 1]
    expect(last).toMatchObject({ type: 'rapid', z: 10 })
    expect(last.x).toBeCloseTo(0, 9)
    expect(last.y).toBeCloseTo(0, 9)
  })
})
