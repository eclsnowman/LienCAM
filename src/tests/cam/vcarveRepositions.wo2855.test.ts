// WO-2855: V-carve links its cuts without a ton of repositions.
//
// The owner (2026-10-15, on the hero video of example 05 Name sign, V-carve 1):
// "the toolpath of the vcarve ... really jumps and repositions a ton".
//
// Planned through the app's own compute (the P0 measuring stick's chain
// runner, alpha3 ex05 chains, both parameter modes), then counted with the
// stick's own path metrics:
//   - repositions (rapid XY moves) at most three per letter per depth pass:
//     one entry, and room for a floor that is split in two or a letter with a
//     counter. Before this order: 78 (default, one pass) and 169 (declared,
//     two passes) for 7 letters; after: 18 and 40.
//   - between cuts the tool rises only to Retract, or rides just above the
//     groove it has already carved; Clearance is crossed once on the way in
//     and once on the way out.
//   - the carve never cuts deeper than the drawing anywhere (a column grid
//     against the analytic V-carve depth from the outlines).
//   - the carve is the one the engine left before this order, column for
//     column within 0.02 mm both ways (the old moves, planned at main
//     97c7fa1c7e, are in src/tests/evidence/WO-2855/before-carve-moves.json):
//     fewer repositions must not leave material, or take any.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildVCarveToolpath, ensureVCarveClipperReady } from '../../lib/cam/vcarve2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { outlineTextToContours } from '../../lib/sketch/textOutline'
import type { LoopData, VCarveParams, VCarveWorkerPayload } from '../../lib/cam/types'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains, toolById } from '../benchmark/registry'
import { pathMetrics } from '../benchmark/metrics'
import type { Tool, ToolpathMove } from '../../types'

const LETTERS = 7

async function plannedVCarve(mode: 'default' | 'declared') {
  const chain = alpha3Chains().find(c => c.id === `ex05-name-sign-${mode}`)!
  const step = chain.steps.find(s => s.type === 'vcarve')!
  const planned = await planChain({ ...chain, steps: [step] })
  const done = planned.steps[0]
  expect(done.status, done.operatorText).toBe('ready')
  const spec = toolById(step.toolId)
  return { moves: done.moves, heights: done.heights!, tool: (spec.libraryTool ?? spec) as unknown as Tool }
}

type XYZ = { x: number; y: number; z: number }

/** The surface a V-bit leaves: every column ends at the lowest cone surface
 *  over every sample of every move (exact cone stamp, the tip at the move's
 *  z, a quarter cell apart). Stock stands at `topZ`. The moves into the
 *  indices in `skip` are left out. */
function carve(
  moves: readonly XYZ[], tool: Tool, grid: { minX: number; minY: number; nx: number; ny: number; cell: number; topZ: number },
  skip?: ReadonlySet<number>,
): Float64Array {
  const { minX, minY, nx, ny, cell, topZ } = grid
  const tanHalf = Math.tan((tool.angleFromAxisDeg! * Math.PI) / 180)
  const tipR = (tool.tipDiameter ?? 0) / 2
  const top = new Float64Array(nx * ny).fill(topZ)
  const stamp = (x: number, y: number, z: number) => {
    if (z >= topZ) return
    const R = tipR + (topZ - z) * tanHalf
    const i0 = Math.max(0, Math.floor((x - R - minX) / cell)), i1 = Math.min(nx - 1, Math.ceil((x + R - minX) / cell))
    const j0 = Math.max(0, Math.floor((y - R - minY) / cell)), j1 = Math.min(ny - 1, Math.ceil((y + R - minY) / cell))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const h = z + Math.max(0, Math.hypot(minX + (i + 0.5) * cell - x, minY + (j + 0.5) * cell - y) - tipR) / tanHalf
      if (h < top[j * nx + i]) top[j * nx + i] = h
    }
  }
  for (let k = 1; k < moves.length; k++) {
    if (skip?.has(k)) continue
    const a = moves[k - 1], b = moves[k]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / (cell / 4)))
    for (let s = 1; s <= n; s++) stamp(a.x + (b.x - a.x) * s / n, a.y + (b.y - a.y) * s / n, a.z + (b.z - a.z) * s / n)
  }
  return top
}

/** How far the carve goes below the drawing anywhere (overcut), and how far
 *  it differs from the carve the engine left before this order, column by
 *  column, both ways: `higher` is material the old carve removed and this
 *  one leaves, `lower` is material this one removes that the old one left. */
function compare(moves: ToolpathMove[], before: XYZ[], tool: Tool, cell: number) {
  const project = JSON.parse(readFileSync('examples/05-name-sign/name-sign.camproject', 'utf8'))
  const op = project.setups[0].operations.find((o: { type: string }) => o.type === 'vcarve')
  const ids = new Set(op.params.loopIds as string[])
  const loops: { x: number; y: number }[][] = project.geometry
    .flatMap((g: { loops?: { id: string; points: { x: number; y: number }[] }[] }) => g.loops ?? [])
    .filter((l: { id: string }) => ids.has(l.id)).map((l: { points: { x: number; y: number }[] }) => l.points)
  const tanHalf = Math.tan((tool.angleFromAxisDeg! * Math.PI) / 180)
  const tipR = (tool.tipDiameter ?? 0) / 2
  const cuts = moves.filter(m => m.type !== 'rapid')
  // The corner ridges run up to the surface, so the highest cut is Material Start.
  const topZ = Math.max(...moves.filter(m => m.role === 'cut').map(m => m.z))
  const xs = loops.flat().map(p => p.x), ys = loops.flat().map(p => p.y)
  const minX = Math.min(...xs) - 1, minY = Math.min(...ys) - 1
  const nx = Math.ceil((Math.max(...xs) + 1 - minX) / cell), ny = Math.ceil((Math.max(...ys) + 1 - minY) / cell)
  const grid = { minX, minY, nx, ny, cell, topZ }
  const top = carve(moves, tool, grid)
  const old = carve(before, tool, grid)
  const maxDepth = topZ - Math.min(...cuts.map(m => m.z))
  let overcut = 0, higher = 0, lower = 0
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = minX + (i + 0.5) * cell, y = minY + (j + 0.5) * cell
    let inside = false, D = Infinity
    for (const pts of loops) {
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const p0 = pts[b], p1 = pts[a]
        if ((p1.y > y) !== (p0.y > y) && x < ((p0.x - p1.x) * (y - p1.y)) / (p0.y - p1.y) + p1.x) inside = !inside
        const dx = p1.x - p0.x, dy = p1.y - p0.y, l2 = dx * dx + dy * dy
        let t = l2 > 0 ? ((x - p0.x) * dx + (y - p0.y) * dy) / l2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        D = Math.min(D, Math.hypot(p0.x + t * dx - x, p0.y + t * dy - y))
      }
    }
    const k = j * nx + i
    const design = inside ? topZ - Math.min(maxDepth, Math.max(0, (D - tipR) / tanHalf)) : topZ
    overcut = Math.max(overcut, design - top[k])
    higher = Math.max(higher, top[k] - old[k])
    lower = Math.max(lower, old[k] - top[k])
  }
  return { overcut, higher, lower }
}

const before: Record<string, number[][]> = JSON.parse(readFileSync('src/tests/evidence/WO-2855/before-carve-moves.json', 'utf8'))

describe('WO-2855 V-carve links its cuts without a ton of repositions (05 Name sign)', () => {
  for (const [mode, passes] of [['default', 1], ['declared', 2]] as const) {
    it(`${mode}: at most three repositions per letter per depth pass, Clearance only in and out, the same carve as before`, async () => {
      const { moves, tool } = await plannedVCarve(mode)
      const metrics = pathMetrics(moves)
      expect(metrics.rapidRepositions).toBeLessThanOrEqual(3 * LETTERS * passes)

      const clearanceZ = Math.max(...moves.map(m => m.z))
      const atClearance = moves.filter((m, i) => m.type === 'rapid' && m.z === clearanceZ && !(i > 0 && moves[i - 1].z === clearanceZ))
      expect(atClearance.length).toBe(2)

      const old = before[`ex05-name-sign-${mode}`].map(([x, y, z]) => ({ x, y, z }))
      const { overcut, higher, lower } = compare(moves, old, tool, 0.1)
      expect(overcut).toBeLessThan(0.02)
      // No column is left more than 0.02 mm above the old carve, and none is
      // cut more than 0.02 mm below it.
      expect(higher).toBeLessThanOrEqual(0.02)
      expect(lower).toBeLessThanOrEqual(0.02)
    }, 120_000)
  }
})

// A link that rides over the groove instead of climbing to Retract lifts to
// just above the material the earlier cuts can have left; it must cut nothing.
// Carved with and without those link moves, every column comes out the same.
describe('WO-2855 a link that rides over the carved groove cuts nothing', () => {
  beforeAll(async () => {
    await ensureVCarveClipperReady()
    await ensureClipperReady()
  })

  const vbit = (tipDiameter = 0) => ({
    id: 'v60', name: '60 deg V-bit', type: 'v_bit', diameter: 6, fluteLength: 10, shankDiameter: 6, overallLength: 50,
    angleFromAxisDeg: 30, tipDiameter, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300 } },
  }) as unknown as Tool
  const text = (t: string, h: number): LoopData[] =>
    outlineTextToContours(t, h).map((c, i) => ({ id: `t${i}`, closed: true, type: 'closed', points: c.points }))
  // Two squares joined by a neck narrower than the flat: one floor in two lobes.
  const dumbbell: LoopData[] = [{ id: 'd', closed: true, type: 'closed', points: [
    { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3.4 }, { x: 12, y: 3.4 }, { x: 12, y: 0 }, { x: 20, y: 0 },
    { x: 20, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 4.6 }, { x: 8, y: 4.6 }, { x: 8, y: 8 }, { x: 0, y: 8 },
  ] }]
  const field: LoopData = { id: 'f', closed: true, type: 'closed', points: [{ x: -3, y: -3 }, { x: 16, y: -3 }, { x: 16, y: 11 }, { x: -3, y: 11 }] }
  const cases: { name: string; loops: LoopData[]; tip?: number; stepdown?: number; clearing?: VCarveParams['flatClearing']['mode'] }[] = [
    { name: 'letters with counters', loops: text('BOX8e', 12) },
    { name: 'letters, two depth passes', loops: text('BOX8e', 12), stepdown: 0.4 },
    { name: 'letters, flat tip', loops: text('BOX8e', 12), tip: 0.4 },
    { name: 'letters, no floor clearing', loops: text('BOX8e', 12), clearing: 'none' },
    { name: 'a carved field around raised letters', loops: [field, ...text('HI', 8)] },
    { name: 'one floor in two lobes', loops: dumbbell },
    { name: 'one floor in two lobes, two depth passes', loops: dumbbell, stepdown: 0.5 },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const tool = vbit(c.tip)
      const payload: VCarveWorkerPayload = {
        opId: 'op', setupId: 'setup', tool, loops: c.loops, wcsOrigin: { x: 0, y: 0, z: 0 },
        params: {
          geometryId: 'g', loopIds: [], role: 'carve', flatDepthMm: 1, startDepthMm: 0, allowanceMm: 0,
          flatClearing: { mode: c.clearing ?? 'vbit', stepoverMm: 0.5 }, tolerance: 0.01,
        },
        heights: {
          clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
          topHeight: 0, topHeightMode: 'absolute', bottomHeight: -1, bottomHeightMode: 'absolute',
        },
        passes: { stepdown: c.stepdown ?? 0, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
        linking: { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
      } as unknown as VCarveWorkerPayload
      const moves = buildVCarveToolpath(payload)
      // The riding link: a lift and a feed across, then the plunge.
      const riding = new Set<number>()
      moves.forEach((m, i) => {
        if (m.role !== 'stepover' || moves[i + 1]?.role !== 'plunge' || !(m.z > moves[i + 1].z)) return
        riding.add(i)
        const prev = moves[i - 1]
        if (prev?.role === 'stepover' && prev.x === moves[i - 2]?.x && prev.y === moves[i - 2]?.y) riding.add(i - 1)
      })
      expect(riding.size).toBeGreaterThan(0)
      const xs = moves.map(m => m.x), ys = moves.map(m => m.y)
      const cell = 0.1
      const minX = Math.min(...xs) - 2, minY = Math.min(...ys) - 2
      const grid = { minX, minY, nx: Math.ceil((Math.max(...xs) + 2 - minX) / cell), ny: Math.ceil((Math.max(...ys) + 2 - minY) / cell), cell, topZ: 0 }
      const all = carve(moves, tool, grid)
      const without = carve(moves, tool, grid, riding)
      let worst = 0
      for (let k = 0; k < all.length; k++) worst = Math.max(worst, without[k] - all[k])
      expect(worst).toBeLessThan(1e-9)
    }, 120_000)
  }
})
