// WO-2210: a 3D finish that must lift between passes lifts only as high as the
// proven material along the link + the standoff, rapids down only to the proven
// material + standoff, and feeds the rest of the way to the pass start.
//
// Operator, 2026-09-29, choosing 'low re-entry - lift only as high as the material
// along the link, rapid near the surface, short feed in'.
//
// What is pinned, on the two modules that plan these moves:
//   - buildLinkedPath (raw stock: the proven material is the stock top), and
//   - lowerFinishLinksOverRemovedStock (after a rough: the remaining stock),
// every RAPID that ends lower than it started ends at or above the proven
// material under the cutter + TRAVERSE_STANDOFF_MM; no link rides higher than
// the traverse plane; every pass is still cut from its first sample to its last.
//
//   npx vitest run src/tests/cam3d/finishLowReEntry.wo2210.test.ts

import { describe, expect, it } from 'vitest'
import { buildLinkedPath, TRAVERSE_STANDOFF_MM, type ConnectorSampler, type PathBuildHeights, type LinkPolicy } from '../../cam3d/pathbuild'
import type { IrMove } from '../../cam3d/ir/types'
import { lowerFinishLinksOverRemovedStock } from '../../cam3d/integration/finishLinksOverRemovedStock'
import { createStockState, type StockState } from '../../lib/cam/stockState'
import type { Tool, ToolpathMove } from '../../types'

const EPS = 1e-6

/** A wavy relief: the ball's tip (cutter-location) z at (x, y). Tops out at 8, bottoms at 4. */
const surfaceZ = (x: number, y: number): number => 6 + 1.5 * Math.sin(x / 4) * Math.cos(y / 6) + 0.5 * Math.sin(y / 3)

/** Passes along X at y = 1, 2, ..., sampled every 0.5 mm, 80 mm long (the portrait's are 70). */
function reliefPasses(count: number): Float64Array[] {
  const passes: Float64Array[] = []
  for (let p = 0; p < count; p++) {
    const y = 1 + p
    const n = 161
    const pass = new Float64Array(n * 3)
    for (let k = 0; k < n; k++) {
      const x = k * 0.5
      pass[k * 3] = x
      pass[k * 3 + 1] = y
      pass[k * 3 + 2] = surfaceZ(x, y)
    }
    passes.push(pass)
  }
  return passes
}

const sampler: ConnectorSampler = async (xy) => {
  const out = new Float64Array(xy.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = surfaceZ(xy[i * 2], xy[i * 2 + 1])
  return out
}

/** The portrait's shape of problem: a 1.6 mm ball at stepover 1, so proof P1 fails and every link retracts. */
const POLICY: LinkPolicy = { stepover: 1, cutterContactRadiusMm: 0.8 }
/** Stock top 10; the resolver's defaults over it: Feed and Retract + 5, Clearance + 15. */
const STOCK_TOP = 10
const HEIGHTS: PathBuildHeights = { clearanceZ: STOCK_TOP + 15, retractZ: STOCK_TOP + 5, feedZ: STOCK_TOP + 5, materialTopZ: STOCK_TOP }

const BALL = {
  id: 'tool-1', name: 'Ball1.6', type: 'ball_end_mill', diameter: 1.6,
  fluteLength: 10, shankDiameter: 3, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', toolNumber: 1,
} as unknown as Tool

const toToolpath = (moves: readonly IrMove[]): ToolpathMove[] => moves.map(m => ({
  type: m.t === 'rapid' ? 'rapid' : 'feed', x: m.x, y: m.y, z: m.z,
  ...(m.role ? { role: m.role } : {}),
  ...(m.t === 'rapid' ? {} : { feed: m.role === 'cut' ? 1200 : 400 }),
}) as ToolpathMove)
const isRapid = (m: { type?: string; t?: string; role?: string }): boolean => m.type === 'rapid' || m.t === 'rapid' || m.role === 'rapid'

/** Rapids that end lower than the move before them left the tool: the descents the order is about. */
function rapidDescents<M extends { x: number; y: number; z: number }>(moves: readonly M[], rapid: (m: M) => boolean): M[] {
  const out: M[] = []
  for (let i = 1; i < moves.length; i++) if (rapid(moves[i]) && moves[i].z < moves[i - 1].z - EPS) out.push(moves[i])
  return out
}

/**
 * The highest material the remaining stock holds anywhere the cutter can reach at (x, y): every column whose
 * cell comes within the cutter radius of the tool axis (a column's material may stand anywhere in its cell).
 * Written here, from the state's own arrays, independently of the product's helpers.
 */
function provenTopUnderCutter(stock: StockState, x: number, y: number, radius: number): number {
  const cell = stock.resolutionMm
  const reach = radius + cell * Math.SQRT1_2
  let top = Number.NEGATIVE_INFINITY
  for (let j = 0; j < stock.ny; j++) {
    const cy = stock.bounds.minY + (j + 0.5) * cell
    if (Math.abs(cy - y) > reach) continue
    for (let i = 0; i < stock.nx; i++) {
      const cx = stock.bounds.minX + (i + 0.5) * cell
      if (Math.hypot(cx - x, cy - y) > reach) continue
      top = Math.max(top, stock.topZ[j * stock.nx + i])
    }
  }
  return top
}

/** The raw block (-1..81 x 0..20 x 0..10) after a rough that left 0.5 mm over the relief. */
function roughedRelief(): StockState {
  const state = createStockState({ minX: -1, minY: 0, minZ: 0, maxX: 81, maxY: 20, maxZ: STOCK_TOP }, 0.25)
  const topZ = new Float32Array(state.topZ.length)
  for (let j = 0; j < state.ny; j++) {
    for (let i = 0; i < state.nx; i++) {
      const x = state.bounds.minX + (i + 0.5) * state.resolutionMm
      const y = state.bounds.minY + (j + 0.5) * state.resolutionMm
      topZ[j * state.nx + i] = Math.min(STOCK_TOP, surfaceZ(x, y) + 0.5)
    }
  }
  return { ...state, topZ }
}

/** The 'cut' moves of a path in order: what the finish takes off the part. */
const cuts = (moves: readonly { role?: string; x: number; y: number; z: number }[]) =>
  moves.filter(m => m.role === 'cut').map(m => [m.x, m.y, m.z])

describe('WO-2210 low re-entry on raw stock (buildLinkedPath, proven stock top)', () => {
  it('every rapid descent ends at or above the proven stock top + standoff; links never above the traverse plane', async () => {
    const passes = reliefPasses(8)
    const moves = await buildLinkedPath(passes, HEIGHTS, POLICY, sampler)
    const traverseZ = Math.max(HEIGHTS.clearanceZ, STOCK_TOP + TRAVERSE_STANDOFF_MM)
    const descents = rapidDescents(moves, m => m.t === 'rapid')
    // The first approach and one per retract link: 8 entries, every link retracts (P1 fails at stepover 1 > r 0.8).
    expect(descents).toHaveLength(1)
    for (const m of moves.filter(isRapid)) {
      expect(m.z, 'a rapid below the proven top + standoff').toBeGreaterThanOrEqual(STOCK_TOP + TRAVERSE_STANDOFF_MM - EPS)
      expect(m.z, 'no rapid above the traverse plane').toBeLessThanOrEqual(traverseZ + EPS)
    }
    // Between passes the tool lifts to the stock top + standoff, not to Clearance.
    const interior = moves.slice(1, -1).filter(isRapid)
    expect(interior.length).toBeGreaterThan(0)
    for (const m of interior) {
      if (m === descents[0]) continue
      expect(m.z).toBeCloseTo(STOCK_TOP + TRAVERSE_STANDOFF_MM, 9)
    }
    // Each entry's first fed move leaves the stock top + standoff, not Feed Height.
    for (let i = 1; i < moves.length; i++) {
      if (moves[i - 1].t === 'rapid' && moves[i].t === 'feed') {
        expect(moves[i].role).toBe('lead_in')
        expect(moves[i - 1].z).toBeCloseTo(STOCK_TOP + TRAVERSE_STANDOFF_MM, 9)
      }
    }
    // Every pass cut end to end (WO-2209).
    const expected: number[][] = []
    passes.forEach((p, i) => {
      const n = p.length / 3
      for (let k = 1; k < n; k++) {
        const j = i % 2 === 1 ? n - 1 - k : k
        expected.push([p[j * 3], p[j * 3 + 1], p[j * 3 + 2]])
      }
    })
    expect(cuts(moves)).toEqual(expected)
  })

  it('the lift is lower and the entry ramp shorter than over the traverse plane from Feed Height', async () => {
    const passes = reliefPasses(4)
    const low = await buildLinkedPath(passes, HEIGHTS, POLICY, sampler)
    const plane = await buildLinkedPath(passes, { ...HEIGHTS, materialTopZ: undefined }, POLICY, sampler)
    /** xy length of the entry ramps. */
    const fed = (ms: IrMove[]) => ms.reduce((sum, m, i) =>
      m.role === 'lead_in' && i > 0 ? sum + Math.hypot(m.x - ms[i - 1].x, m.y - ms[i - 1].y) : sum, 0)
    expect(fed(plane)).toBeGreaterThan(0)
    expect(fed(low)).toBeLessThan(0.7 * fed(plane))
    expect(Math.max(...low.slice(1, -1).filter(isRapid).map(m => m.z))).toBeLessThan(Math.max(...plane.slice(1, -1).filter(isRapid).map(m => m.z)))
    expect(cuts(low)).toEqual(cuts(plane))
  })

  it('an authored Feed Height below the proven top + standoff is kept (this only lowers)', async () => {
    const heights: PathBuildHeights = { ...HEIGHTS, feedZ: STOCK_TOP + 0.5, retractZ: STOCK_TOP + 0.5 }
    const moves = await buildLinkedPath(reliefPasses(3), heights, POLICY, sampler)
    const entries = moves.filter((m, i) => m.t === 'rapid' && i + 1 < moves.length && moves[i + 1].t === 'feed')
    expect(entries.length).toBe(3)
    for (const m of entries) expect(m.z).toBe(heights.feedZ)
    for (const m of moves.slice(1, -1).filter(isRapid)) expect(m.z).toBeLessThanOrEqual(STOCK_TOP + TRAVERSE_STANDOFF_MM + EPS)
  })
})

describe('WO-2210 low re-entry after a rough (lowerFinishLinksOverRemovedStock, remaining stock)', () => {
  it('every rapid descent ends at or above the remaining material under the cutter + standoff', async () => {
    const remaining = roughedRelief()
    const passes = reliefPasses(8)
    const built = toToolpath(await buildLinkedPath(passes, HEIGHTS, POLICY, sampler))
    const result = lowerFinishLinksOverRemovedStock({ moves: built, tool: BALL, remaining, clearanceZ: HEIGHTS.clearanceZ })
    expect(result.candidates, 'every link between passes is a candidate').toBe(passes.length - 1)
    // Every rapid that ends lower than it started, and every rapid the tool leaves at feed (a landing).
    const landings = result.moves.filter((m, i) => isRapid(m) && i + 1 < result.moves.length && !isRapid(result.moves[i + 1]))
    expect(landings).toHaveLength(passes.length)
    const descents = [...new Set([...rapidDescents(result.moves, isRapid), ...landings])]
    for (const m of descents) {
      const proven = provenTopUnderCutter(remaining, m.x, m.y, BALL.diameter / 2)
      expect(m.z - proven, `rapid descent to (${m.x}, ${m.y}, ${m.z.toFixed(3)}) over material at ${proven.toFixed(3)}`)
        .toBeGreaterThanOrEqual(TRAVERSE_STANDOFF_MM - 1e-3)
    }
    // No link higher than the builder's own.
    const builtTop = Math.max(...built.slice(1, -1).filter(isRapid).map(m => m.z))
    for (const m of result.moves.slice(1, -1).filter(isRapid)) expect(m.z).toBeLessThanOrEqual(builtTop + EPS)
    // Nothing of the passes skipped: the cutting moves are the builder's, in order.
    expect(cuts(result.moves)).toEqual(cuts(built))
    // And the re-entry really is lower than the builder's ramp top: the rapid lands on the ramp below it.
    const rampTops = built.filter((m, i) => isRapid(m) && i + 1 < built.length && built[i + 1].role === 'lead_in')
    const lowerLandings = landings.filter(m => m.z < STOCK_TOP + TRAVERSE_STANDOFF_MM - 0.5)
    expect(rampTops.length).toBe(passes.length)
    expect(lowerLandings.length, 'links that re-enter below the stock top').toBeGreaterThanOrEqual(passes.length - 1)
  })

  describe('only the links it was built for, never higher than built', () => {
    const FLAT = { ...BALL, type: 'flat_end_mill', diameter: 6 } as unknown as Tool
    /** A 40 x 40 x 10 block machined flat to Z 2: the low plane is 11, Clearance 20. */
    const floor = (): StockState => {
      const state = createStockState({ minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 10 }, 0.5)
      return { ...state, topZ: new Float32Array(state.topZ.length).fill(2) }
    }
    /** Three cuts on the floor, joined by a lift to `first` and then a lift to `second` (plunge entries). */
    const path = (first: number, second: number): ToolpathMove[] => [
      { type: 'rapid', x: 5, y: 5, z: 20, role: 'rapid' },
      { type: 'rapid', x: 5, y: 5, z: 4, role: 'rapid' },
      { type: 'feed', x: 5, y: 5, z: 2, role: 'plunge', feed: 300 },
      { type: 'feed', x: 10, y: 5, z: 2, role: 'cut', feed: 1000 },
      { type: 'rapid', x: 10, y: 5, z: first, role: 'rapid' },
      { type: 'rapid', x: 30, y: 10, z: first, role: 'rapid' },
      { type: 'rapid', x: 30, y: 10, z: 4, role: 'rapid' },
      { type: 'feed', x: 30, y: 10, z: 2, role: 'plunge', feed: 300 },
      { type: 'feed', x: 35, y: 10, z: 2, role: 'cut', feed: 1000 },
      { type: 'rapid', x: 35, y: 10, z: second, role: 'rapid' },
      { type: 'rapid', x: 35, y: 30, z: second, role: 'rapid' },
      { type: 'feed', x: 35, y: 30, z: 2, role: 'plunge', feed: 300 },
      { type: 'feed', x: 30, y: 30, z: 2, role: 'cut', feed: 1000 },
      { type: 'rapid', x: 30, y: 30, z: 20, role: 'rapid' },
    ]

    it('a link lifted to neither Clearance nor the low plane (a Retract) is left alone', () => {
      const moves = path(15, 15)
      const result = lowerFinishLinksOverRemovedStock({ moves, tool: FLAT, remaining: floor(), clearanceZ: 20 })
      expect(result.candidates).toBe(0)
      expect(result.moves).toEqual(moves)
    })

    it('links on the low plane lower onto the floor + standoff when they are the only kind', () => {
      const result = lowerFinishLinksOverRemovedStock({ moves: path(11, 11), tool: FLAT, remaining: floor(), clearanceZ: 20 })
      expect(result.candidates).toBe(2)
      const interior = result.moves.slice(1, -1).filter(isRapid)
      expect(Math.max(...interior.map(m => m.z))).toBeLessThanOrEqual(11 + EPS)
      for (const m of rapidDescents(result.moves, isRapid)) expect(m.z).toBeGreaterThanOrEqual(2 + TRAVERSE_STANDOFF_MM - 1e-3)
      expect(interior.some(m => m.z < 4)).toBe(true)
    })

    it('with a Clearance link in the same path, a low-plane link stays exactly as built', () => {
      const moves = path(20, 11)
      const result = lowerFinishLinksOverRemovedStock({ moves, tool: FLAT, remaining: floor(), clearanceZ: 20 })
      expect(result.candidates).toBe(1)
      // The second link (lift to 11, across, plunge) is the builder's, move for move.
      expect(result.moves.slice(-5)).toEqual(moves.slice(-5))
      for (const m of result.moves.slice(1, -1).filter(isRapid)) expect(m.z).toBeLessThanOrEqual(20 + EPS)
    })
  })

  it('a ramp vertex the remaining stock cannot prove clear is never a rapid endpoint', async () => {
    // Nothing removed: the remaining stock is the whole block, so no ramp vertex under its top can be proven.
    const full = createStockState({ minX: -1, minY: 0, minZ: 0, maxX: 81, maxY: 20, maxZ: STOCK_TOP }, 0.25)
    const built = toToolpath(await buildLinkedPath(reliefPasses(4), HEIGHTS, POLICY, sampler))
    const result = lowerFinishLinksOverRemovedStock({ moves: built, tool: BALL, remaining: full, clearanceZ: HEIGHTS.clearanceZ })
    const landings = result.moves.filter((m, i) => isRapid(m) && i + 1 < result.moves.length && !isRapid(result.moves[i + 1]))
    for (const m of [...rapidDescents(result.moves, isRapid), ...landings]) {
      expect(m.z).toBeGreaterThanOrEqual(STOCK_TOP + TRAVERSE_STANDOFF_MM - 1e-3)
    }
    expect(cuts(result.moves)).toEqual(cuts(built))
  })
})
