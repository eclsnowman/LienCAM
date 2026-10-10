// WO-1972: the pocket helix starts at the material and stays down.
//
// Operator, 2026-09-25, on Full Suite Test / Setup 1 / Pocket 2: "It helixes down,
// then retracts, then helixes down to the next stepdown... It is helixing
// through air 90% of the cut... It should plunge to just before engagement with
// stock remaining, then helix prior to entry... the helix needs to be rest stock
// aware. Not stock top... but stock remaining."
//
// Part 1 runs his file through the production compute (the store's
// computeOperationToolpath, the same worker path the app uses). Part 2 is a rest
// case on the engine: an earlier cut that lowered the material under the helix.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { buildPocketToolpath } = await import('../../lib/cam/pocket2d')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')
const { createStockState, applyStockOperation } = await import('../../lib/cam/stockState')

// The worker runs in-process: the store posts to a Worker shim that hands the
// request straight to toolpathWorker's onmessage, exactly as the browser would.
type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
if (g.window === undefined) g.window = {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups[0]
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(setup, project)!)
  },
}
g.self = { postMessage: (m: unknown) => { activeShim?.onmessage?.({ data: m }) }, onmessage: null }
await import('../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) { activeShim = this; void workerSelf.onmessage?.({ data }) }
  terminate() { activeShim = null }
}

await ensureClipperReady()

interface HelixRun {
  /** Z where the helix begins (the move before its first arc). */
  startZ: number
  endZ: number
  /** Helix centre, rounded, to group runs into regions. */
  key: string
  firstIndex: number
  lastIndex: number
  arcLength: number
}

function helixRuns(moves: readonly ToolpathMove[]): HelixRun[] {
  const runs: HelixRun[] = []
  let i = 0
  while (i < moves.length) {
    if (moves[i].role !== 'helix') { i++; continue }
    const first = i
    let length = 0
    while (i < moves.length && moves[i].role === 'helix') {
      const a = moves[i - 1], b = moves[i]
      length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      i++
    }
    const before = moves[first - 1]
    const arc = moves[first] as ToolpathMove & { i?: number; j?: number }
    const cx = arc.i !== undefined ? before.x + arc.i : before.x
    const cy = arc.j !== undefined ? before.y + arc.j : before.y
    runs.push({
      startZ: before.z, endZ: moves[i - 1].z, key: `${cx.toFixed(1)},${cy.toFixed(1)}`,
      firstIndex: first, lastIndex: i - 1, arcLength: length,
    })
  }
  return runs
}

describe('WO-1972: Full Suite Test, Setup 1, Pocket 2 through the production compute', () => {
  let moves: ToolpathMove[] = []
  let originZ = 0
  let depths: number[] = []

  beforeAll(async () => {
    const text = readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8')
    await useCamStore.getState().loadProjectFromFile(text)
    let project = useCamStore.getState().project
    const setup = project.setups[0]
    const adapt = setup.operations.find(o => o.name === 'Adaptive Clearing 1')!
    const pocket = setup.operations.find(o => o.name === 'Pocket 2')!
    await useCamStore.getState().computeOperationToolpath(setup.id, adapt.id)
    await useCamStore.getState().computeOperationToolpath(setup.id, pocket.id)
    project = useCamStore.getState().project
    const op = project.setups[0].operations.find(o => o.id === pocket.id)! as unknown as {
      status: string; errorMessage?: string; toolpathMoves?: ToolpathMove[]
      heights: { retractHeight: number }
      estimatedCutTimeMs?: number
    }
    expect(op.errorMessage ?? '').toBe('')
    originZ = project.setups[0].wcs.origin.z
    moves = (op.toolpathMoves ?? []).map(m => ({ ...m, z: m.z - originZ }))
    depths = [...new Set(helixRuns(moves).map(r => Number(r.endZ.toFixed(3))))].sort((a, b) => b - a)
    const runs = helixRuns(moves)
    console.info('[WO-1972] Pocket 2', JSON.stringify({
      moves: moves.length, depths, estimatedCutTimeSec: op.estimatedCutTimeMs !== undefined
        ? +(op.estimatedCutTimeMs / 1000).toFixed(1) : null,
      roles: moves.reduce<Record<string, number>>((acc, m) => {
        const k = `${m.type}/${m.role ?? '-'}`
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {}),
      helix: runs.map(r => ({ key: r.key, from: +r.startZ.toFixed(3), to: +r.endZ.toFixed(3), len: +r.arcLength.toFixed(1) })),
      helixLengthMm: +runs.reduce((s, r) => s + r.arcLength, 0).toFixed(1),
    }))
  }, 600_000)

  it('cuts three levels in three regions with a helix at every level', () => {
    expect(depths.length).toBe(3)
    const runs = helixRuns(moves)
    expect(new Set(runs.map(r => r.key)).size).toBe(3)
    expect(runs.length).toBe(9)
  })

  it('each helix starts 1 mm above the material left: 1.0, then the level above + 1', () => {
    const runs = helixRuns(moves)
    for (const key of new Set(runs.map(r => r.key))) {
      const starts = runs.filter(r => r.key === key).map(r => Number(r.startZ.toFixed(3)))
      expect(starts).toEqual([1, -1, -3])
    }
  })

  it('stays down between levels inside a region: no retract between its helixes', () => {
    const runs = helixRuns(moves)
    for (let k = 1; k < runs.length; k++) {
      if (runs[k].key !== runs[k - 1].key) continue
      const between = moves.slice(runs[k - 1].lastIndex + 1, runs[k].firstIndex)
      // Nothing between two levels of one region rises above the next helix
      // start (the level just cut + clearance): no retract, no air re-helix.
      expect(Math.max(...between.map(m => m.z))).toBeLessThanOrEqual(runs[k - 1].endZ + 1 + 1e-6)
      // The link itself travels at that height, clear of the floor just cut.
      const rapids = between.filter(m => m.type === 'rapid')
      expect(rapids.length).toBeGreaterThan(0)
      for (const m of rapids) expect(m.z).toBeCloseTo(runs[k].startZ, 6)
    }
  })

  it('helixes through at most 1 mm of air per level', () => {
    const runs = helixRuns(moves)
    for (const key of new Set(runs.map(r => r.key))) {
      const mine = runs.filter(r => r.key === key)
      mine.forEach((run, level) => {
        const materialTop = level === 0 ? 0 : mine[level - 1].endZ
        expect(run.startZ - materialTop).toBeLessThanOrEqual(1 + 1e-6)
      })
    }
  })
})

// ── Part 2: rest-aware - an earlier cut lowered the material under the helix ───

const tool = {
  id: 't', name: '6 mm flat endmill', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 60, numberOfFlutes: 2, material: 'carbide',
  coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 900, plungeRate: 250, depthOfCut: 5, stepover: 2.4 } },
} as unknown as import('../../types').Tool

type Loop = import('../../lib/cam/types').LoopData
const rect = (id: string, type: 'contour' | 'hole', x0: number, y0: number, x1: number, y1: number): Loop => ({
  id, closed: true, type,
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
})
const OUTER = rect('outer', 'contour', 0, 0, 60, 40)
// An island off the centre line, so the straight line from where a level ends to
// the next helix can cross it.
const ISLAND = rect('island', 'hole', 36, 12, 48, 28)
// A small island near a corner, clear of the line most levels end on.
const CORNER_ISLAND = rect('corner', 'hole', 46, 26, 52, 32)

function restPocket(over: {
  remainingStock?: ReturnType<typeof createStockState>
  entryClearance?: number
  orderStrategy?: 'by_region' | 'by_depth'
  loops?: Loop[]
  finishContour?: boolean
} = {}) {
  const loops = over.loops ?? [OUTER]
  return buildPocketToolpath({
    opId: 'o', setupId: 's',
    params: {
      geometryId: 'g', loopIds: loops.map(l => l.id), direction: 'climb',
      orderStrategy: over.orderStrategy ?? 'by_region',
      fillStrategy: 'inside_out', floorStockToLeave: 0, finishContour: over.finishContour ?? false,
      helixDiameter: 80, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
      ...(over.entryClearance !== undefined ? { entryClearance: over.entryClearance } : {}),
    },
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 2.4, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'ramp_helical', rampAngle: 3, rampLength: 8, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'minimum', transitionType: 'avoid_stock',
    },
    tool,
    loops,
    wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(over.remainingStock ? { remainingStock: over.remainingStock } : {}),
  } as unknown as import('../../lib/cam/types').PocketWorkerPayload)
}

const starts = (moves: ToolpathMove[]) => helixRuns(moves).map(r => Number(r.startZ.toFixed(3)))

function retractsBetweenLevels(moves: ToolpathMove[]): number {
  const runs = helixRuns(moves)
  let lifts = 0
  for (let k = 1; k < runs.length; k++) {
    const between = moves.slice(runs[k - 1].lastIndex + 1, runs[k].firstIndex)
    if (between.some(m => m.type === 'rapid' && m.z >= 5 - 1e-6)) lifts++
  }
  return lifts
}

describe('WO-1972: the helix is rest-stock aware', () => {
  // An earlier 10 mm flat cut the middle of the block down to Z -1: the whole
  // helix footprint of this pocket's entry sits in that cleared bowl.
  const block = createStockState({ minX: -10, minY: -10, minZ: -20, maxX: 70, maxY: 50, maxZ: 0 }, 0.5)
  const earlier = applyStockOperation(block, [15, 20, 25].map(y => ({
    move: { x0: 15, y0: y, z0: -1, x1: 45, y1: y, z1: -1 },
    cutter: { kind: 'flat' as const, diameter: 10 },
  })))

  it('starts the first helix at the lowered material + 1 mm, not the stock top', () => {
    // Level 1 (Z -2) starts at the bowl floor -1 + 1; later levels at the level above + 1.
    expect(starts(restPocket({ remainingStock: earlier }))).toEqual([0, -1, -3])
  })

  it('with no earlier operation starts at Top + 1 mm', () => {
    expect(starts(restPocket())).toEqual([1, -1, -3])
  })

  it('with only the stock block as loaded starts at the block top + 1 mm', () => {
    const out = buildPocketToolpath({
      ...(restPocketPayload()),
      stockBlock: { min: { x: -10, y: -10, z: -20 }, max: { x: 70, y: 50, z: 0.5 } },
    })
    expect(starts(out)).toEqual([1.5, -1, -3])
  })

  it('honours the operator entry clearance', () => {
    expect(starts(restPocket({ entryClearance: 2.5 }))).toEqual([2.5, 0.5, -1.5])
  })

  it('stays down between levels with no rapid to retract, in both orderings', () => {
    for (const orderStrategy of ['by_region', 'by_depth'] as const) {
      const out = restPocket({ orderStrategy })
      expect(helixRuns(out).length).toBe(3)
      expect(starts(out)).toEqual([1, -1, -3])
      expect(retractsBetweenLevels(out)).toBe(0)
    }
  })
})

// The rapid traverse between levels must never carry the cutter over the island
// or the pocket wall: it runs 1 mm above a floor whose walls stand full height.
describe('WO-1972: the stay-down traverse is collision-free over an island', () => {
  const R = 3
  // The island keep-out is an offset polygon: its corner arcs are chords, so the
  // cuts themselves come to 2.997 mm of a rectangular island's corner.
  const TOL = 0.01
  function distToRect(p: { x: number; y: number }, r: Loop): number {
    const xs = r.points.map(q => q.x), ys = r.points.map(q => q.y)
    const dx = Math.max(Math.min(...xs) - p.x, 0, p.x - Math.max(...xs))
    const dy = Math.max(Math.min(...ys) - p.y, 0, p.y - Math.max(...ys))
    return Math.hypot(dx, dy)
  }

  for (const island of [ISLAND, CORNER_ISLAND]) for (const orderStrategy of ['by_region', 'by_depth'] as const) {
    for (const finishContour of [false, true]) {
      it(`${island.id} island, ${orderStrategy}, finish ${finishContour}: every low rapid keeps the cutter off the island and the wall`, () => {
        const out = restPocket({ orderStrategy, finishContour, loops: [OUTER, island] })
        expect(helixRuns(out).length).toBe(3)
        let lowRapids = 0
        for (let i = 1; i < out.length; i++) {
          const m = out[i]
          if (m.type !== 'rapid' || m.z >= 0) continue
          lowRapids++
          const a = out[i - 1]
          for (let s = 0; s <= 200; s++) {
            const t = s / 200
            const p = { x: a.x + (m.x - a.x) * t, y: a.y + (m.y - a.y) * t }
            expect(distToRect(p, island)).toBeGreaterThanOrEqual(R - TOL)
            expect(p.x).toBeGreaterThanOrEqual(R - 1e-6)
            expect(p.x).toBeLessThanOrEqual(60 - R + 1e-6)
            expect(p.y).toBeGreaterThanOrEqual(R - 1e-6)
            expect(p.y).toBeLessThanOrEqual(40 - R + 1e-6)
          }
        }
        console.info(`[WO-1972] ${island.id} island ${orderStrategy} finish=${finishContour}: low rapids ${lowRapids}, retracts between levels ${retractsBetweenLevels(out)}`)
        // The corner island leaves the link clear, so the tool stays down; across
        // the middle island the link is unproven and the tool retracts instead.
        expect(lowRapids).toBeGreaterThan(0)
        expect(retractsBetweenLevels(out)).toBe(island === CORNER_ISLAND ? 0 : 2)
      })
    }
  }
})

function restPocketPayload(): import('../../lib/cam/types').PocketWorkerPayload {
  return {
    opId: 'o', setupId: 's',
    params: {
      geometryId: 'g', loopIds: ['outer'], direction: 'climb', orderStrategy: 'by_region',
      fillStrategy: 'inside_out', floorStockToLeave: 0, finishContour: false, helixDiameter: 80,
      overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
    },
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 2.4, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'ramp_helical', rampAngle: 3, rampLength: 8, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'minimum', transitionType: 'avoid_stock',
    },
    tool, loops: [OUTER], wcsOrigin: { x: 0, y: 0, z: 0 },
  } as unknown as import('../../lib/cam/types').PocketWorkerPayload
}
