// WO-3037: adaptive keep-down links are smooth and short, and never ride through standing stock,
// behind one switch that ships OFF (src/kernel/ops/adaptive/policy.ts
// ADAPTIVE_MOTION_SWITCHES.keepDownLinksSmooth).
//
// Owner 2026-10-21 16:52 UTC on the form torus: "there would be no reason a part of this smooth
// geometry would have spikes in the toolpath that look like this." The spikes were keep-down links:
// a short hop between two points on the curved wall whose straight chord sags ~0.05 mm past the
// wall, so the router fed 2.5 mm out into cleared space and turned back (a V), and longer routed
// rides that meet the passes at sharp corners.
//
// Every number below is read off the production route (planChain = the store's
// computeOperationToolpath; scoreChain = the measuring stick), switch OFF against switch ON in the
// same run:
// 1. Ships OFF.
// 2. Form torus (3D adaptive, first tool): ON, no link ride turns back on itself in mid-air (no V
//    apex: every sharp link corner is where the ride leaves or rejoins a pass), the extra link feed
//    over the straight hops at least halves, the sharp link corners and the lifts drop, cycle time
//    holds, and M-SAFE-2 / M-PART-4 stay PASS.
// 3. 2D H-pocket, with the WO-3042 steering switch OFF and ON (the order's 10-22 addition): ON, no
//    link meets stock standing taller than the level above the one it travels on -- a column no
//    pass has cut down yet (main OFF: a router ride grazes the island wall 4-5 mm deep at the lower
//    levels), judged by a stock replay at 0.1 mm cells; no rapid meets stock at all (WO-3023's rule);
//    M-SAFE-2 no worse than OFF.
// The whole-stick before/after (main vs OFF identity, OFF vs ON on every adaptive row) is
// src/tests/evidence/WO-3037/.
// 4. WO-3068 (owner 2026-10-22 on the WO-3037 card: "Seems like a larger radius but have a shorter
//    path"): ON, each bowed hop is the flattest proven arc, not the first of six coarse steps. Form
//    torus: no kept-down link ride bows more than 33% longer than its chord (WO-3037 ON: the 40%
//    step, 1.38x, on ten 11-15 mm hops across the levels), and the extra link feed and the total link length drop
//    below WO-3037's ON numbers. Its before/after is src/tests/evidence/WO-3068/.
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'
import { chainScene, planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains, toolById, type BenchmarkChain } from '../benchmark/registry'
import { inventoryTools } from '../benchmark/alpha3Registry'
import { linkTurnMetrics, toIrMoves } from '../benchmark/metrics'
import { alpha3HardVerdicts } from '../benchmark/metrics.alpha3'
import { toolToCutterSpec } from '../../cam3d/integration/cutterSpec'
import { ZDexelField, removeSweep } from '../../cam3d/stock'
import { maxTraverseIntrusion } from '../../cam3d/stock/traverseClearance'
import { forEachLinearSweep, replaySagittaFor } from '../../cam3d/rough/replayStock'
import { effectiveMoveMotion, effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'

type PolicyModule = typeof import('../../kernel/ops/adaptive/policy')
const switches = vi.hoisted(() => ({ smooth: false, steering: false }))
vi.mock('../../kernel/ops/adaptive/policy', async (importOriginal) => {
  const real = await importOriginal<PolicyModule>()
  return typedMock<PolicyModule>({
    ...real,
    ADAPTIVE_MOTION_SWITCHES: {
      ...real.ADAPTIVE_MOTION_SWITCHES,
      get keepDownLinksSmooth() { return switches.smooth },
      get steeringSmoothing() { return switches.steering },
    },
  })
})

type Row = { stepId: string; status: string; metrics: Record<string, unknown> }
const metric = (row: Row, key: string): number => {
  const m = row.metrics[key] as { value?: number } | number
  return typeof m === 'number' ? m : m.value as number
}

/** The chain cut down to its first (roughing) step: the rows this order is about. */
const firstStep = (id: string): BenchmarkChain => {
  const chain = alpha3Chains().find(c => c.id === id)!
  return { ...chain, steps: chain.steps.slice(0, 1) }
}

const run = async (chain: BenchmarkChain, smooth: boolean, steering = false) => {
  switches.smooth = smooth
  switches.steering = steering
  try {
    const planned = await planChain(chain)
    const step = planned.steps[0]
    expect(step.status).toBe('ready')
    const row = ((await scoreChain(chain, planned)).rows as Row[]).find(r => r.stepId === step.stepId)!
    return { moves: step.moves as ToolpathMove[], row }
  } finally {
    switches.smooth = false
    switches.steering = false
  }
}

const isPass = (m: ToolpathMove): boolean => effectiveMoveMotion(m) === 'pass'
const isAir = (m: ToolpathMove): boolean => m.type === 'rapid' || effectiveMoveMotion(m) === 'air'

/** Heading the tool starts and leaves a move on (an arc's tangents, a line's chord). */
function headings(from: ToolpathMove, m: ToolpathMove): { entry: [number, number]; exit: [number, number] } | null {
  if ((m.type === 'arc_cw' || m.type === 'arc_ccw') && typeof m.cx === 'number' && typeof m.cy === 'number') {
    const side = m.type === 'arc_cw' ? -1 : 1
    const r0 = [from.x - m.cx, from.y - m.cy], r1 = [m.x - m.cx, m.y - m.cy]
    if (Math.hypot(r0[0], r0[1]) < 1e-9 || Math.hypot(r1[0], r1[1]) < 1e-9) return null
    return { entry: [-side * r0[1], side * r0[0]], exit: [-side * r1[1], side * r1[0]] }
  }
  const d: [number, number] = [m.x - from.x, m.y - from.y]
  return Math.hypot(d[0], d[1]) < 1e-9 ? null : { entry: d, exit: d }
}
const turnDeg = (a: [number, number], b: [number, number]): number =>
  Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI

/** Sharp corners (> 90 deg, linkTurnMetrics' own bound) INSIDE a kept-down link ride: between two
 *  of its own moves, never where it leaves or rejoins a pass. A V detour's apex is one. */
function midRideSharpCorners(moves: ToolpathMove[]): { at: [number, number, number]; deg: number }[] {
  const out: { at: [number, number, number]; deg: number }[] = []
  let heading: [number, number] | null = null
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]
    if (isPass(m) || isAir(m)) { heading = null; continue }
    const h = headings(moves[i - 1], m)
    if (!h) continue
    if (heading && turnDeg(heading, h.entry) > 90 + 1e-9) out.push({ at: [moves[i - 1].x, moves[i - 1].y, moves[i - 1].z], deg: turnDeg(heading, h.entry) })
    heading = h.exit
  }
  return out
}

describe('WO-3037 keep-down link switch', () => {
  it('ships OFF', async () => {
    const real = await vi.importActual<PolicyModule>('../../kernel/ops/adaptive/policy')
    expect(real.ADAPTIVE_MOTION_SWITCHES.keepDownLinksSmooth).toBe(false)
    expect(Object.isFrozen(real.ADAPTIVE_MOTION_SWITCHES)).toBe(true)
  })
})

describe('WO-3037 form torus: keep-down links are smooth (production route, OFF vs ON)', () => {
  it('ON: no V apex in any link ride, half the extra link feed or less, fewer sharp corners and lifts, M-SAFE-2 / M-PART-4 PASS', async () => {
    const chain = firstStep('form-torus-default')
    const off = await run(chain, false)
    const on = await run(chain, true)
    const linksOff = linkTurnMetrics(off.moves), linksOn = linkTurnMetrics(on.moves)
    const report = JSON.stringify({ off: linksOff, on: linksOn })

    // The order's own premise holds on today's planner: the spikes are there with the switch OFF.
    expect(midRideSharpCorners(off.moves).length, report).toBeGreaterThan(0)
    expect(linksOff.linkSpikeExtraMm, report).toBeGreaterThan(100)

    // ON: no ride turns back on itself in mid-air.
    expect(midRideSharpCorners(on.moves), report).toEqual([])
    // The extra feed the spikes cost over the straight hops at least halves (measured 247 -> 73 mm),
    // and the sharp corners and spike rides drop.
    expect(linksOn.linkSpikeExtraMm, report).toBeLessThanOrEqual(linksOff.linkSpikeExtraMm / 2)
    expect(linksOn.linkSharpTurns, report).toBeLessThan(linksOff.linkSharpTurns)
    expect(linksOn.linkSpikeRides, report).toBeLessThan(linksOff.linkSpikeRides)
    // Smooth links keep the tool down more, never less, and the cycle holds or improves.
    expect(metric(on.row, 'liftedLinks')).toBeLessThanOrEqual(metric(off.row, 'liftedLinks'))
    expect(metric(on.row, 'cutTimeMs')).toBeLessThanOrEqual(metric(off.row, 'cutTimeMs') * 1.005)
    // Safety and the part: unchanged verdicts.
    const verdictOn = alpha3HardVerdicts(on.row.metrics as Parameters<typeof alpha3HardVerdicts>[0])
    expect(verdictOn['M-SAFE-2']).toBe('PASS')
    expect(verdictOn['M-PART-4']).toBe('PASS')
    expect(metric(on.row, 'M-SAFE-2')).toBeLessThanOrEqual(metric(off.row, 'M-SAFE-2'))
  }, 900_000)
})

interface StockHit { index: number; role: string; type: string; from: number[]; to: number[]; materialTopZ: number; levelAboveZ: number }

/** Replay a step's moves into a 0.1 mm stock field (the stick's own field, sweep and intrusion
 *  functions, a finer cell). Returns every LINK move (non-cutting, at depth) that meets a column
 *  standing taller than the level above the one it travels on -- stock no pass has cut down to
 *  that level yet -- and every RAPID that meets stock at all. */
async function standingStockHits(chain: BenchmarkChain, moves: ToolpathMove[]): Promise<{ links: StockHit[]; rapids: StockHit[] }> {
  const { box } = await chainScene(chain)
  const cutter = toolToCutterSpec(inventoryTools([toolById(chain.steps[0].toolId).libraryTool!])[0])
  const field = ZDexelField.fromBox(box, 0.1)
  const levels = [...new Set(moves.filter(m => effectiveMoveRole(m) === 'cut').map(m => m.z))].sort((a, b) => b - a)
  const stockTop = box.maxZ
  const levelAbove = (z: number): number => {
    const above = levels.filter(l => l > z + 1e-6)
    return above.length > 0 ? above[above.length - 1] : stockTop
  }
  const ir = toIrMoves(moves)
  const links: StockHit[] = [], rapids: StockHit[] = []
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i], from = moves[i - 1]
    const role = effectiveMoveRole(m)
    const cuts = isStockCuttingRole(role)
    let worst = { intrusionMm: -Infinity, materialTopZ: NaN }
    forEachLinearSweep(from, ir[i], replaySagittaFor(field), sweep => {
      const hit = maxTraverseIntrusion(field, sweep, cutter)
      if (hit.intrusionMm > worst.intrusionMm) worst = hit
      if (cuts) removeSweep(field, sweep, cutter)
    })
    if (cuts || !(worst.intrusionMm > 1e-3)) continue
    const hit = { index: i, role, type: m.type, from: [from.x, from.y, from.z], to: [m.x, m.y, m.z], materialTopZ: worst.materialTopZ, levelAboveZ: levelAbove(Math.min(from.z, m.z)) }
    if (m.type === 'rapid') rapids.push(hit)
    else if (worst.materialTopZ > hit.levelAboveZ + 1e-3) links.push(hit)
  }
  return { links, rapids }
}

/** Feed length of one move: an arc's own sweep, a line's chord. */
function moveLength(from: ToolpathMove, m: ToolpathMove): number {
  if ((m.type === 'arc_cw' || m.type === 'arc_ccw') && typeof m.cx === 'number' && typeof m.cy === 'number') {
    const r = Math.hypot(from.x - m.cx, from.y - m.cy)
    const t0 = Math.atan2(from.y - m.cy, from.x - m.cx), t1 = Math.atan2(m.y - m.cy, m.x - m.cx)
    const sweep = m.type === 'arc_ccw' ? t1 - t0 : t0 - t1
    return r * (((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
  }
  return Math.hypot(m.x - from.x, m.y - from.y)
}

/** Every kept-down link ride (the run of moves between two passes that is neither pass nor air):
 *  its feed length and the straight distance between its ends, for rides on one level. */
function linkRides(moves: ToolpathMove[]): { length: number; chord: number; at: [number, number, number] }[] {
  const out: { length: number; chord: number; at: [number, number, number] }[] = []
  let start: ToolpathMove | null = null, length = 0
  for (let i = 1; i <= moves.length; i++) {
    const m = moves[i]
    if (m && !isPass(m) && !isAir(m)) {
      if (!start) { start = moves[i - 1]; length = 0 }
      length += moveLength(moves[i - 1], m)
      continue
    }
    const end = moves[i - 1]
    if (start && Math.abs(end.z - start.z) < 1e-6) out.push({ length, chord: Math.hypot(end.x - start.x, end.y - start.y), at: [start.x, start.y, start.z] })
    start = null
  }
  return out
}

describe('WO-3068 form torus: smooth keep-down links take the shortest proven arc (production route, ON)', () => {
  it('ON: no link ride over 3 mm bows past 1.33x its chord, extra link feed and total link length under WO-3037 ON', async () => {
    const on = await run(firstStep('form-torus-default'), true)
    const links = linkTurnMetrics(on.moves)
    const rides = linkRides(on.moves)
    const loops = rides.filter(r => r.chord > 3 && r.length > 1.33 * r.chord)
    const total = rides.reduce((sum, r) => sum + r.length, 0)
    const report = JSON.stringify({ links, total, loops })
    // WO-3037 ON took the 40% bow (1.38x its chord) on ten 11-15 mm hops; the flattest proven arc
    // is 1.27x or less on every one (measured 2026-10-22, linux-x64). The bounds sit midway between
    // the two sides' numbers so another host's float noise does not decide them.
    expect(rides.length, report).toBeGreaterThan(50)
    expect(loops, report).toEqual([])
    // WO-3037 ON measured 72.5 mm extra link feed and 549.9 mm of link rides; WO-3068 48.7 / 520.2.
    expect(links.linkSpikeExtraMm, report).toBeLessThan(60)
    expect(total, report).toBeLessThan(540)
    // The order's other bounds: sharp link corners no worse than WO-3037 ON (46), M-SAFE-2 / M-PART-4 PASS.
    expect(links.linkSharpTurns, report).toBeLessThanOrEqual(46)
    const verdict = alpha3HardVerdicts(on.row.metrics as Parameters<typeof alpha3HardVerdicts>[0])
    expect(verdict['M-SAFE-2']).toBe('PASS')
    expect(verdict['M-PART-4']).toBe('PASS')
  }, 900_000)
})

describe('WO-3037 2D H-pocket: no keep-down link rides through standing stock (production route)', () => {
  const chain = firstStep('engagement-pocket-adaptive_clearing_2d-default')
  for (const steering of [false, true]) {
    it(`ON, WO-3042 steering ${steering ? 'ON' : 'OFF'}: no link meets a column taller than the level above, no rapid meets stock, M-SAFE-2 no worse`, async () => {
      const off = await run(chain, false, steering)
      const on = await run(chain, true, steering)
      const hitsOff = await standingStockHits(chain, off.moves)
      const hitsOn = await standingStockHits(chain, on.moves)
      expect(on.moves.length).toBeGreaterThan(1000)
      // premise: the replay sees today's router ride through the island's standing stock
      expect(hitsOff.links.length, 'OFF standing-stock link hits').toBeGreaterThan(0)
      expect(hitsOn.links, JSON.stringify(hitsOn.links.slice(0, 5))).toEqual([])
      expect(hitsOn.rapids, JSON.stringify(hitsOn.rapids.slice(0, 5))).toEqual([])
      expect(metric(on.row, 'M-SAFE-2')).toBeLessThanOrEqual(metric(off.row, 'M-SAFE-2'))
    }, 900_000)
  }
})
