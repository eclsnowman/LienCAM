// WO-3004: the kernel workholding and setup-tabs service (alpha.3 A3-19, P2 parity
// slice). Parity is judged against today's engine twice: unit controls against the
// engine's exported functions, and the engine's OWN calls recorded while the P0
// measuring-stick chains that carry workholding or tabs plan through the app.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { buildSolidColumns, type ClearanceMesh } from '../../lib/cam/holderClearance'
import {
  reduceRegionAroundKeepOuts, workholdingDepthBands, workholdingKeepOuts,
} from '../../lib/cam/adaptiveClearing2d/engine/workholdingIsland'
import { buildContourTabPlan, computeContourTabPreviewLoop } from '../../lib/cam/contour2d'
import { resolveHeights } from '../../lib/cam/heights'
import type { ContourWorkerPayload } from '../../lib/cam/types'
import { closestArcPosition } from '../../lib/viewport/tabPlacement'
import type { ToolpathMove } from '../../types'
import { createGeometryService, faceAdapter, signedArea } from '../../kernel/geometry'
import { createWorkholdingService, PARITY_POLICY, planTabs, resolveTabs, type ObstacleInput, type ResolvedTabs, type TabPlan } from '../../kernel/workholding'

type Pt = { x: number; y: number }
type Recorded = { fn: string; args: unknown[]; result?: unknown; error?: string }
const recorded = vi.hoisted((): Recorded[] => [])

// Record the engine's own calls on the production route; behaviour is unchanged.
vi.mock('../../lib/cam/adaptiveClearing2d/engine/workholdingIsland', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/cam/adaptiveClearing2d/engine/workholdingIsland')>()
  const { typedMock } = await import('../support/typedMock')
  const wrap = <F extends (...args: never[]) => unknown>(fn: string, f: F) => ((...args: Parameters<F>) => {
    const result = f(...args)
    recorded.push({ fn, args: structuredClone(args), result: structuredClone(result) })
    return result
  }) as F
  return typedMock<typeof import('../../lib/cam/adaptiveClearing2d/engine/workholdingIsland')>({ ...real,
    workholdingKeepOuts: wrap('workholdingKeepOuts', real.workholdingKeepOuts),
    workholdingDepthBands: wrap('workholdingDepthBands', real.workholdingDepthBands),
    reduceRegionAroundKeepOuts: wrap('reduceRegionAroundKeepOuts', real.reduceRegionAroundKeepOuts),
  })
})
vi.mock('../../lib/cam/contour2d', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/cam/contour2d')>()
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/cam/contour2d')>({ ...real,
    buildContourToolpath: (payload: ContourWorkerPayload, ...rest: unknown[]) => {
      const args = [structuredClone(payload)]
      try {
        const moves = (real.buildContourToolpath as (...a: unknown[]) => ToolpathMove[])(payload, ...rest)
        recorded.push({ fn: 'buildContourToolpath', args, result: structuredClone(moves) })
        return moves
      } catch (error) {
        recorded.push({ fn: 'buildContourToolpath', args, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
  })
})

let service: ReturnType<typeof createWorkholdingService>
beforeAll(async () => {
  await ensureClipperReady()
  service = createWorkholdingService({ geometry: createGeometryService(faceAdapter({ offsetLoop })), solidColumns: buildSolidColumns })
})

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ClearanceMesh {
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions, indices }
}
function merge(...meshes: ClearanceMesh[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const mesh of meshes) {
    const base = positions.length / 3
    positions.push(...Array.from(mesh.positions))
    indices.push(...Array.from(mesh.indices, i => i + base))
  }
  return { positions, indices }
}
const clamp = box(30, -5, -2, 45, 15, 12)
const viseBelow = box(-20, -30, -40, 80, 70, -25)
// A ring clamp (four bars around a 10 mm hole) whose hole must be filled, never cut into.
const ring = merge(box(60, 40, -5, 80, 45, 8), box(60, 55, -5, 80, 60, 8), box(60, 45, -5, 65, 55, 8), box(75, 45, -5, 80, 55, 8))
const meshes = [clamp, viseBelow, ring]
const obstacles: ObstacleInput[] = meshes.map((mesh, i) => ({ id: `wh-${i}`, mesh }))
const square = (x0: number, y0: number, x1: number, y1: number): Pt[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const region: Pt[][] = [square(0, 0, 100, 60), [...square(10, 10, 20, 20)].reverse()]
const levels = [
  { bottomZ: 0, topZ: 25, allowanceMm: 0.25 }, { bottomZ: 15, topZ: 30, allowanceMm: 0.25 },
  { bottomZ: -10, topZ: 20, allowanceMm: 1 }, { bottomZ: -30, topZ: 5, allowanceMm: 0 },
  { bottomZ: 11.9, topZ: 30, allowanceMm: Number.NaN },
]
const depthRequests = [
  { depths: [10, 8, 6, 4, 2, 0, -2, -4, -6], topZ: 22, allowanceMm: 0.25 },
  { depths: [5, 0, -5, -10, -15, -20, -26, -30], topZ: 25, allowanceMm: 0.5 },
  { depths: [20, 15], topZ: 40, allowanceMm: 0.25 },
]

function minDistanceToBox(loop: Pt[], b: { minX: number; minY: number; maxX: number; maxY: number }): number {
  let min = Number.POSITIVE_INFINITY
  for (const p of loop) {
    const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX)
    const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY)
    min = Math.min(min, Math.hypot(dx, dy))
  }
  return min
}

const evidence: Record<string, unknown> = { order: 'WO-3004', policy: PARITY_POLICY }
function writeEvidence() {
  const path = 'src/tests/evidence/WO-3004/parity.json'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(evidence, null, 1) + '\n')
}

describe('WO-3004 workholding service: keep-out at parity', () => {
  it('ships every carded flag OFF and routes families as today', () => {
    expect(service.policy).toEqual({ keepout_in_planning: false, tabs_all_routes: false })
    expect(PARITY_POLICY).toEqual(service.policy)
    expect(service.islandRouting('pocket_2d').route).toBe('plan-around')
    expect(service.islandRouting('adaptive_clearing_2d').route).toBe('plan-around')
    for (const family of ['adaptive_3d', 'contour_2d', 'face', 'parallel_3d', 'drill'] as const) {
      expect(service.islandRouting(family)).toEqual({ family, route: 'trim-after', backstop: 'reach-trim' })
    }
    expect(service.tabRoutes()).toEqual({ 'offset-rough': 'honoured', 'trochoidal-rough': 'honoured', finish: 'honoured',
      'multi-region': 'not-honoured', 'split-finish': 'refused', 'open-chain': 'refused' })
  })

  it('equals the engine keep-outs, depth bands and reduced regions on unit fixtures', () => {
    const setup = service.setup({ setupId: 's1', frame: { id: 'world' }, obstacles })
    let compared = 0
    for (const level of levels) {
      expect(setup.keepOuts(level)).toEqual(workholdingKeepOuts({ meshes, ...level }))
      const engineIslands = workholdingKeepOuts({ meshes, ...level })
      expect(setup.reduceRegion(region, engineIslands)).toEqual(reduceRegionAroundKeepOuts(region, engineIslands))
      compared += 2
    }
    for (const request of depthRequests) {
      expect(setup.depthBands(request)).toEqual(workholdingDepthBands({ meshes, ...request }))
      compared++
    }
    expect(setup.reduceRegion(region, [])).toBeNull()
    evidence.unit = { compared, equal: compared }
  })

  it('keepout-level-z: an obstacle below the cutting level does not block it', () => {
    const setup = service.setup({ setupId: 's1', frame: null, obstacles: [{ id: 'vise', mesh: viseBelow }] })
    expect(setup.keepOuts({ bottomZ: -20, topZ: 10, allowanceMm: 0.25 })).toEqual([])
    expect(setup.keepOuts({ bottomZ: -30, topZ: 10, allowanceMm: 0.25 }).length).toBe(1)
    // The allowance reaches down: a level 0.2 mm above the top is within a 0.25 mm allowance.
    const [band] = setup.depthBands({ depths: [-24.8], topZ: 10, allowanceMm: 0.25 })
    expect(band.keepOuts.length).toBe(1)
  })

  it('keepout-inflation: islands carry the allowance, the tool-centre keep-out adds the radius', () => {
    const setup = service.setup({ setupId: 's1', frame: null, obstacles: [{ id: 'clamp', mesh: clamp }] })
    const [obstacle] = setup.record.obstacles
    const allowance = 0.25
    const islands = setup.keepOuts({ bottomZ: 0, topZ: 20, allowanceMm: allowance })
    expect(islands.length).toBe(1)
    expect(minDistanceToBox(islands[0], { minX: 30, minY: -5, maxX: 45, maxY: 15 })).toBeGreaterThanOrEqual(allowance)
    const radius = 3
    const centre = setup.toolCentreKeepOuts(islands, radius)
    expect(centre.length).toBe(1)
    expect(minDistanceToBox(centre[0], { minX: 30, minY: -5, maxX: 45, maxY: 15 })).toBeGreaterThanOrEqual(radius + allowance - 0.005)
    expect(signedArea(centre[0])).toBeGreaterThan(signedArea(islands[0]))
    expect(obstacle.topZ).toBeGreaterThan(11.9)
    expect(setup.obstacleTops()).toEqual([{ id: 'clamp', topZ: obstacle.topZ }])
  })

  it('fills a ring clamp and proceeds without a missing mesh, saying so in one line', () => {
    const setup = service.setup({ setupId: 's1', frame: null, flipOf: 's0', envelope: { machineId: 'm' },
      obstacles: [{ id: 'ring', mesh: ring }, { id: 'lost', name: 'Toe clamp 2', mesh: null }] })
    const islands = setup.keepOuts({ bottomZ: 0, topZ: 10, allowanceMm: 0.25 })
    expect(islands.length).toBe(1)
    expect(islands.every(loop => signedArea(loop) > 0)).toBe(true)
    expect(setup.record.omissions).toEqual([{ id: 'lost', reason: 'no-mesh',
      line: 'Toe clamp 2: the workholding has no readable shape, so planning goes ahead without keeping clear of it.' }])
    expect(setup.record.flipOf).toBe('s0')
    expect(Object.isFrozen(setup.record.obstacles[0].footprint)).toBe(true)
  })

  it('is deterministic and headless (same answer twice, no viewport, no store)', () => {
    const run = () => {
      const setup = service.setup({ setupId: 's1', frame: { id: 'world' }, obstacles })
      return JSON.stringify({ record: setup.record, bands: depthRequests.map(r => setup.depthBands(r)), levels: levels.map(l => setup.keepOuts(l)) })
    }
    expect(run()).toBe(run())
  })
})

const finishSquare = (): Pt[] => computeContourTabPreviewLoop(square(0, 0, 60, 40), 'outer', 'climb', 6)!.path
const resolved: ResolvedTabs = { width: 8, count: 4, tabTopZ: -10, stockBottomZ: -12, shape: 'box' }

describe('WO-3004 workholding service: the one tab block at parity', () => {
  it('tab-top lifts: a depth level at the tab top is not a lift; a lift outside every tab is caught (WO-3223)', () => {
    const plan = planTabs(finishSquare(), resolved)
    if (!plan.ok) throw new Error(plan.line)
    const { path, tabTopZ, intervals } = plan.value
    const feed = (p: Pt, z: number): ToolpathMove => ({ type: 'feed', x: p.x, y: p.y, z, feed: 800, role: 'cut' })
    // A whole lap at a depth level equal to the tab top, entered from above.
    const level = [feed(path[0], tabTopZ + 2), ...path.map(p => feed(p, tabTopZ)), feed(path[0], tabTopZ)]
    expect(tabTopLifts(plan.value, level)).toEqual([])
    // A lift from below at the path seam, which sits in a gap between tabs.
    expect(intervals[0].start).toBeGreaterThan(1)
    expect(intervals[intervals.length - 1].end).toBeLessThan(plan.value.perimeter - 1)
    const wrong = [feed(path[0], tabTopZ - 2), feed(path[0], tabTopZ)]
    expect(tabTopLifts(plan.value, wrong).map(l => l.inside)).toEqual([false])
  })

  it('plans the same tabs as the engine (even, custom, seam-spanning, triangular)', () => {
    const path = finishSquare()
    const cases: [typeof resolved, number[] | undefined][] = [
      [resolved, undefined], [{ ...resolved, count: 7 }, undefined], [resolved, [0.1, 0.4, 0.75]],
      [resolved, [0.001, 0.5]], [resolved, [0.999, 0.3, Number.NaN]], [{ ...resolved, shape: 'triangular', width: 6 }, [0.2, 0.6]],
    ]
    for (const [tabs, custom] of cases) {
      const kernel = planTabs(path, tabs, custom)
      expect(kernel).toEqual({ ok: true, value: buildContourTabPlan(path, tabs, custom) })
    }
    for (const [tabs, custom] of [[{ ...resolved, count: 40 }, undefined], [resolved, [0.1, 0.11]], [resolved, [Number.NaN]]] as const) {
      const kernel = planTabs(path, tabs, custom as number[] | undefined)
      expect(kernel.ok).toBe(false)
      expect(() => buildContourTabPlan(path, tabs, custom as number[] | undefined)).toThrow(kernel.ok ? 'unreachable' : kernel.line)
    }
    evidence.tabPlanUnit = { compared: cases.length + 3, equal: cases.length + 3 }
  })

  it('tabs-headless: the same tabs with and without a viewport (stock bottom from the planning record)', () => {
    const path = finishSquare()
    const request = { params: { tabs: true }, entryType: 'plunge' as const, topZ: 0, stockBottomWcsZ: -12, wcsOriginZ: 0, doFinish: true }
    const headless = service.tabBlock(request, [{ loopId: 'l', path }])
    // A viewport that reports a different stock must not move a tab.
    vi.stubGlobal('window', { __cncViewport: { getStockBounds: () => ({ min: { x: 0, y: 0, z: -40 }, max: { x: 60, y: 40, z: 0 } }) } })
    try {
      expect(service.tabBlock(request, [{ loopId: 'l', path }])).toEqual(headless)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(headless.ok && headless.value?.tabs.stockBottomZ).toBe(-12)
  })

  it('tab-single-block: one resolved tab block for every loop, stable tab ids', () => {
    const request = { params: { tabs: true, tabCount: 3 }, entryType: 'ramp_linear' as const, topZ: 0, stockBottomWcsZ: -12, wcsOriginZ: 0, doFinish: true }
    const block = service.tabBlock(request, [{ loopId: 'a', path: finishSquare() }, { loopId: 'b', path: finishSquare() }])
    if (!block.ok || !block.value) throw new Error('expected a tab block')
    expect(block.value.loops.map(l => l.tabIds)).toEqual([['a#0', 'a#1', 'a#2'], ['b#0', 'b#1', 'b#2']])
    for (const loop of block.value.loops) {
      expect({ width: loop.plan.width, count: loop.plan.count, tabTopZ: loop.plan.tabTopZ, stockBottomZ: loop.plan.stockBottomZ, shape: loop.plan.shape })
        .toEqual(block.value.tabs)
    }
    expect(service.tabBlock({ ...request, params: { tabs: false } }, [])).toEqual({ ok: true, value: null })
  })

  it('refuses with the engine words wherever the engine refuses', () => {
    const base = { params: { tabs: true }, entryType: 'plunge' as const, topZ: 0, stockBottomWcsZ: -12, wcsOriginZ: 0, doFinish: true }
    const lines = [
      resolveTabs({ ...base, params: { tabs: true, tabWidth: 0 } }),
      resolveTabs({ ...base, params: { tabs: true, tabHeight: Number.NaN } }),
      resolveTabs({ ...base, params: { tabs: true, tabCount: 2.5 } }),
      resolveTabs({ ...base, params: { tabs: true, tabShape: 'triangular', tabWidth: 3, tabHeight: 2 } }),
      resolveTabs({ ...base, doFinish: false }),
      resolveTabs({ ...base, entryType: 'arc' }),
      resolveTabs({ ...base, stockBottomWcsZ: undefined }),
      resolveTabs({ ...base, stockBottomWcsZ: -1, params: { tabs: true, tabHeight: 2 } }),
    ].map(outcome => (outcome.ok ? '' : outcome.line))
    expect(lines).toEqual([
      'Contour tabs: tab width must be a finite value greater than 0 mm.',
      'Contour tabs: tab height must be a finite value greater than 0 mm.',
      'Contour tabs: tab count must be a positive whole number.',
      'Contour tabs: triangular tabs ramp at 45 deg from both ends, so the tab width must be at least 2 x the tab height. ' +
        'Height 2.000 mm needs width >= 4.000 mm (or reduce the tab height).',
      'Contour tabs: a finish/profile pass is required. Roughing-only contours leave wall stock and cannot create holding tabs.',
      'Contour tabs: entry type "arc" is not supported with tabs. Use Plunge or Ramp (linear).',
      'Contour tabs: stock bottom could not be resolved. Bind the setup to visible stock before computing tabs.',
      'Contour tabs: tab height 2.000 mm does not fit below the contour top 0.000 mm.',
    ])
  })
})

interface Counters { keepOutCalls: number; tabCalls: number; tabRefusalsEqual: number; earlierRefusals: string[]; tabMovesChecked: number }
const counters = (): Counters => ({ keepOutCalls: 0, tabCalls: 0, tabRefusalsEqual: 0, earlierRefusals: [], tabMovesChecked: 0 })

/** Recompute one recorded engine call with the service and require the same answer. */
function compareCall(label: string, call: Recorded, count: Counters): void {
  if (call.fn === 'workholdingDepthBands' || call.fn === 'workholdingKeepOuts') {
    const input = call.args[0] as { meshes: ClearanceMesh[] } & Record<string, unknown>
    const setup = service.setup({ setupId: label, frame: null, obstacles: input.meshes.map((mesh, i) => ({ id: `m${i}`, mesh })) })
    const kernel = call.fn === 'workholdingDepthBands' ? setup.depthBands(input as never) : setup.keepOuts(input as never)
    expect(kernel, `${label} ${call.fn}`).toEqual(call.result)
    count.keepOutCalls++
    return
  }
  if (call.fn === 'reduceRegionAroundKeepOuts') {
    const setup = service.setup({ setupId: label, frame: null, obstacles: [] })
    expect(setup.reduceRegion(call.args[0] as Pt[][], call.args[1] as Pt[][]), `${label} reduce`).toEqual(call.result)
    count.keepOutCalls++
    return
  }
  const payload = call.args[0] as ContourWorkerPayload
  if (call.fn !== 'buildContourToolpath' || !payload.params.tabs) return
  const { topZ } = resolveHeights(payload.heights, payload.wcsOrigin)
  const outcome = service.tabBlock({ params: payload.params, entryType: payload.linking.entryType, topZ,
    stockBottomWcsZ: payload.stockBottomZ, wcsOriginZ: payload.wcsOrigin.z, doFinish: payload.passes.finishPasses > 0 }, [])
  count.tabCalls++
  if (!outcome.ok) {
    // The engine checks its loops, cutting mode and flute reach before the tabs; a
    // payload it refused there never reaches tab resolution.
    if (call.error !== outcome.line) {
      expect(call.error, `${label} tab refusal`).toMatch(/^Contour: /)
      count.earlierRefusals.push(call.error!)
    } else count.tabRefusalsEqual++
    return
  }
  const tabs = outcome.value!.tabs
  for (const loop of payload.loops) {
    const preview = computeContourTabPreviewLoop(loop.points as Pt[], payload.params.side, payload.params.direction,
      payload.tool.diameter, payload.tool.cutHand)
    if (!preview) continue
    const custom = payload.params.tabLocations?.[loop.id]
    const fractions = Array.isArray(custom) && custom.length > 0 ? custom : undefined
    const kernel = planTabs(preview.path, tabs, fractions)
    let engine: unknown
    try { engine = { ok: true, value: buildContourTabPlan(preview.path, tabs, fractions) } } catch (error) { engine = { ok: false, line: (error as Error).message } }
    expect(kernel, `${label} ${loop.id} tab plan`).toEqual(engine)
    if (!kernel.ok || call.error) continue
    // Independent check on the moves the engine emitted: every tab-top lift on the
    // finish contour lies inside one of the kernel's tab intervals.
    const plan = kernel.value
    for (const { distance: d, inside } of tabTopLifts(plan, call.result as ToolpathMove[])) {
      expect(inside, `${label} ${loop.id} tab-top move at ${d.toFixed(3)} mm`).toBe(true)
      count.tabMovesChecked++
    }
  }
}

/** The feeds at the tab top on the finish contour while the pass cuts below the tab
 * top, with whether each lies inside a tab interval. A run of tab-top feeds entered
 * from below is a tab lift; one entered from above is a depth level that sits exactly
 * at the tab top (WO-3223: a 2 mm stepdown over a 2 mm tab), which cuts the whole lap
 * there and leaves every tab whole, so it is not a lift. */
function tabTopLifts(plan: TabPlan, moves: readonly ToolpathMove[]): Array<{ distance: number; inside: boolean }> {
  const out: Array<{ distance: number; inside: boolean }> = []
  const atTop = (z: number) => Math.abs(z - plan.tabTopZ) <= 1e-6
  let lifted = false
  let prevZ = Number.POSITIVE_INFINITY
  for (const move of moves) {
    const tabTop = move.type === 'feed' && atTop(move.z)
    if (tabTop && !atTop(prevZ)) lifted = prevZ < plan.tabTopZ
    prevZ = move.type === 'feed' ? move.z : Number.POSITIVE_INFINITY
    if (!tabTop || !lifted) continue
    const at = closestArcPosition(plan.path, move)
    if (!at || at.euclidean > 1e-3) continue
    const d = at.distance
    out.push({ distance: d, inside: plan.intervals.some(({ start, end }) => [d, d + plan.perimeter, d - plan.perimeter]
      .some(x => x >= start - 1e-4 && x <= end + 1e-4)) })
  }
  return out
}

describe('WO-3004 workholding service: the engine\'s own calls on the P0 measuring stick', () => {
  it('equals every keep-out and tab call the engine made while the P0 chains with workholding or tabs planned', async () => {
    const { alpha3Chains } = await import('../benchmark/registry')
    const { planChain } = await import('../benchmark/chainRunner')
    const covered = alpha3Chains()
      .filter(chain => ['ex02-toe-clamps', 'ex03-soft-jaws', 'ex07-relief-medallion'].some(id => chain.id.startsWith(id)))
      .map(chain => ({ ...chain, steps: chain.steps.filter(step => ['pocket_2d', 'adaptive_clearing_2d', 'contour_2d'].includes(step.type)) }))
    // The default rows switch tabs off; since WO-3218 the tab stock bottom comes from the
    // stock record, so a declared row with tabs on cuts them headless. One supplement row
    // runs ex02's contour with tabs ON through the same app route; it is labelled a
    // supplement, never a P0 row. Its 2 mm stepdown puts a depth level exactly at the
    // 2 mm tab top (WO-3223).
    const ex02 = covered.find(chain => chain.id === 'ex02-toe-clamps-default')!
    const contour = ex02.steps.find(step => step.type === 'contour_2d' && !step.unavailableReason)!
    const supplement = { ...ex02, id: 'supplement-ex02-contour-tabs-on', steps: [{ ...contour, params: { ...contour.params, tabs: true } }] }
    const rows: Record<string, unknown>[] = []
    let supplementPayload: ContourWorkerPayload | undefined
    for (const chain of [...covered, supplement]) {
      recorded.length = 0
      const planned = await planChain(chain)
      const count = counters()
      for (const call of [...recorded]) {
        compareCall(chain.id, call, count)
        if (chain === supplement && call.fn === 'buildContourToolpath') supplementPayload = call.args[0] as ContourWorkerPayload
      }
      rows.push({ chain: chain.id, steps: planned.steps.map(s => ({ step: s.stepId, status: s.status, operatorText: s.operatorText })),
        ...count, equal: true })
    }
    expect(rows.find(r => r.chain === supplement.id)?.tabMovesChecked).toBeGreaterThan(0)
    // Control, not app truth: that same app payload with the stock bottom at the contour's
    // own bottom (a cut-through), so the tab top falls between depth levels.
    expect(supplementPayload).toBeDefined()
    const { buildContourToolpath } = await import('../../lib/cam/contour2d')
    const { bottomZ } = resolveHeights(supplementPayload!.heights, supplementPayload!.wcsOrigin)
    recorded.length = 0
    buildContourToolpath({ ...supplementPayload!, stockBottomZ: bottomZ - supplementPayload!.wcsOrigin.z })
    const control = counters()
    for (const call of [...recorded]) compareCall('control', call, control)
    expect(control.tabMovesChecked).toBeGreaterThan(0)
    rows.push({ chain: 'control-ex02-app-payload-stock-bottom-supplied', ...control, equal: true })

    evidence.p0 = rows
    const sum = (key: keyof Counters) => rows.reduce((n, r) => n + (typeof r[key] === 'number' ? r[key] as number : 0), 0)
    evidence.p0Totals = { rows: rows.length, keepOutCalls: sum('keepOutCalls'), tabCalls: sum('tabCalls'),
      tabRefusalsEqual: sum('tabRefusalsEqual'), tabMovesChecked: sum('tabMovesChecked') }
    writeEvidence()
    expect(rows.length).toBeGreaterThan(0)
  }, 1_800_000)
})
