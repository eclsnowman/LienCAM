// WO-2287: Pocket and closed Contour relieve their inside corners, through the
// production compute.
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts
//   -> buildPocketToolpath / buildContourToolpath -> the op's toolpathMoves
//
// The only stand-in is the Worker thread (node has none): the stub hands each request
// to the real worker module in-process (same harness as generatorNoticesReachConsole.wo1540).
// The produced moves are swept through the app's heightmap simulator
// (src/lib/simulation/HeightmapSimulator) and every inside corner is read at full depth.
//
// Fixtures: (a) Contour, outside, on Sample Parts/Contour-Test-A-InsideCorner-Notch.dxf
// through the real DXF importer; (b) Pocket on a 60 x 40 rectangle with an L-shaped
// island. Both with a 6 mm flat end mill.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useCamStore } from '../../store'
import { importDXF } from '../../lib/import/dxfImporter'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import { createMachiningRecipe, deserializeRecipe, serializeRecipe } from '../../lib/recipes/recipeModel'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  FixedStockItem, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  SceneStock, Setup, Tool, ToolpathMove, Vec2,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────────────

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = { postMessage: (msg) => { deliver?.(msg) }, onmessage: null }

class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

// ── Scene ───────────────────────────────────────────────────────────────────────────

type LoopData = NonNullable<ImportedGeometry['loops']>[number]
type Style = 'none' | 'dogbone' | 't_bone' | 'longest_edge'

const R = 3
/** The stock top: the Smart Height authority starts the cut here whatever `heights` says. */
const TOP = 12
const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -4, bottomHeightMode: 'absolute',
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as LinkingParams

function tool(): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: 2 * R, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
  } as unknown as Tool
}

function geometry(loops: LoopData[]): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 60, z: 0 },
      size: { x: 80, y: 60, z: 0 }, center: { x: 40, y: 30, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, loops,
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

function install(geo: ImportedGeometry, op: Operation): void {
  const stock: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: 120, height: 100, depth: 12, position: { x: -20, y: -20, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: 120, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: -20, y: -20, z: 0 }, max: { x: 100, y: 80, z: 12 },
      size: { x: 120, y: 100, z: 12 }, center: { x: 40, y: 30, z: 6 },
    },
    position: { x: -20, y: -20, z: 0 },
  }
  const setup: Setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: [op],
    notes: '',
  } as Setup
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [{ ...geo, stockId: stock.id }],
      setups: [setup],
      sceneStock,
      stocks: [physicalStock],
      activeSetupId: 'setup-1',
      activeOperationId: op.id,
    },
    toolLibrary: [tool()],
    toolpathBatch: null,
    consoleEvents: [],
  }))
}

const passes: PassParams = { stepdown: 2, stepover: 2, stockToLeave: 0, finishPasses: 1, springPasses: 0 }

function withStyle<T extends Record<string, unknown>>(params: T, style: Style | undefined): T {
  return style === undefined ? params : { ...params, cornerRelief: style }
}

function contourOp(loopId: string, style: Style | undefined): Operation {
  const params = withStyle({
    geometryId: 'geo-1', loopIds: [loopId], side: 'outer', direction: 'climb', tabs: false,
  }, style)
  return {
    id: 'op-contour', name: 'Notch contour', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['geo-1'] }),
  } as unknown as Operation
}

function pocketOp(style: Style | undefined): Operation {
  const params = withStyle({
    geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: true,
    helixDiameter: 0, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }, style)
  return {
    id: 'op-pocket', name: 'L-island pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', { setupId: 'setup-1', heights, params, geometryIds: ['geo-1'] }),
  } as unknown as Operation
}

async function compute(geo: ImportedGeometry, op: Operation): Promise<ToolpathMove[]> {
  install(geo, op)
  await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
  const done = useCamStore.getState().project.setups[0].operations[0]
  expect(done.status, done.errorMessage).toBe('ready')
  return done.toolpathMoves ?? []
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────

const NOTCH = importDXF(
  readFileSync(join(process.cwd(), 'Sample Parts/Contour-Test-A-InsideCorner-Notch.dxf'), 'utf8'),
  { keepOrigin: true },
)
const notchLoop = NOTCH.loops.find(l => l.closed)! as LoopData
const notchGeo = geometry([{ ...notchLoop, layerId: 'L1' } as LoopData])
// The slot (x 60..68, floor y 10) is the part's only pair of inside corners; the cleared
// side is the slot, so each corner's bisector points up into it.
const NOTCH_CORNERS = [
  { c: { x: 60, y: 10 }, b: { x: Math.SQRT1_2, y: Math.SQRT1_2 } },
  { c: { x: 68, y: 10 }, b: { x: -Math.SQRT1_2, y: Math.SQRT1_2 } },
]
const NOTCH_POLY: Vec2[] = [
  { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 50 }, { x: 68, y: 50 }, { x: 68, y: 10 },
  { x: 60, y: 10 }, { x: 60, y: 50 }, { x: 0, y: 50 },
]
/** Where the contour relief starts on this fixture: the (68, 10) notch corner approached
 *  at (65, 13), 3 mm out in -x and 3 mm along +y for the 6 mm mill. With relief enabled the
 *  main path's exit move travels here instead of lifting in place, at Retract (WO-3083
 *  rule 2). */
const RELIEF_APPROACH: Vec2 = { x: 65, y: 13 }

const POCKET_RECT: Vec2[] = [{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 50 }, { x: 10, y: 50 }]
// L-shaped island, its reflex corner at (38, 30).
const ISLAND_L: Vec2[] = [
  { x: 30, y: 22 }, { x: 50, y: 22 }, { x: 50, y: 30 }, { x: 38, y: 30 }, { x: 38, y: 38 }, { x: 30, y: 38 },
]
const pocketGeo = geometry([
  { id: 'pocket', layerId: 'L1', closed: true, type: 'contour', area: 2400, points: POCKET_RECT } as LoopData,
  { id: 'island', layerId: 'L1', closed: true, type: 'hole', area: 224, points: ISLAND_L } as LoopData,
])
const s = Math.SQRT1_2
const POCKET_CORNERS = [
  { c: { x: 10, y: 10 }, b: { x: s, y: s } },
  { c: { x: 70, y: 10 }, b: { x: -s, y: s } },
  { c: { x: 70, y: 50 }, b: { x: -s, y: -s } },
  { c: { x: 10, y: 50 }, b: { x: s, y: -s } },
  { c: { x: 38, y: 30 }, b: { x: s, y: s } },
]

// ── Heightmap ──────────────────────────────────────────────────────────────────────

const CELL = 0.1

function simulate(moves: readonly ToolpathMove[], x0: number, y0: number, w: number, h: number): HeightmapSimulator {
  const sim = new HeightmapSimulator(x0, y0, w, h, TOP, -10, CELL)
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && b.cx !== undefined && b.cy !== undefined) {
      const r = Math.hypot(a.x - b.cx, a.y - b.cy)
      const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
      let a1 = Math.atan2(b.y - b.cy, b.x - b.cx)
      if (b.type === 'arc_ccw' && a1 <= a0 + 1e-12) a1 += 2 * Math.PI
      if (b.type === 'arc_cw' && a1 >= a0 - 1e-12) a1 -= 2 * Math.PI
      const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) * r / CELL))
      let px = a.x, py = a.y, pz = a.z
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const ang = a0 + (a1 - a0) * t
        const nx = b.cx + r * Math.cos(ang), ny = b.cy + r * Math.sin(ang), nz = a.z + (b.z - a.z) * t
        sim.sweepMove(px, py, pz, nx, ny, nz, R)
        px = nx; py = ny; pz = nz
      }
    } else {
      sim.sweepMove(a.x, a.y, a.z, b.x, b.y, b.z, R)
    }
  }
  return sim
}

function heightAt(sim: HeightmapSimulator, p: Vec2): number {
  const ix = Math.floor((p.x - sim.x0) / sim.cellSize)
  const iy = Math.floor((p.y - sim.y0) / sim.cellSize)
  return sim.heights[iy * sim.nx + ix]
}

/** The material a fillet leaves: a point just inside the corner on its bisector. */
const cornerPoint = (k: { c: Vec2; b: Vec2 }): Vec2 => ({ x: k.c.x + k.b.x * 0.1, y: k.c.y + k.b.y * 0.1 })

function pointInPoly(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Every cell of kept material farther than 2r from all relieved corners is uncut: the
 *  relief notches the corners and nothing else. (The cutter ends r from the corner, so
 *  its notch reaches 2r from it.) */
function keptMaterialCut(sim: HeightmapSimulator, kept: (p: Vec2) => boolean, corners: readonly Vec2[]): number {
  let cut = 0
  for (let iy = 0; iy < sim.ny; iy++) {
    for (let ix = 0; ix < sim.nx; ix++) {
      const p = { x: sim.x0 + (ix + 0.5) * CELL, y: sim.y0 + (iy + 0.5) * CELL }
      if (!kept(p)) continue
      if (corners.some(c => Math.hypot(p.x - c.x, p.y - c.y) <= 2 * R + CELL)) continue
      // A cell whose centre sits within half a cell of a wall reads the wall's own sweep.
      if (sim.heights[iy * sim.nx + ix] < TOP - 1e-6) cut++
    }
  }
  return cut
}

const distToPolyEdges = (p: Vec2, poly: readonly Vec2[]): number => {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t))
  }
  return best
}

/** The main path's cutting levels, top down, read from what it emitted. */
function cutLevels(moves: readonly ToolpathMove[]): number[] {
  return [...new Set(moves.filter(m => m.role === 'cut' && m.z < TOP).map(m => m.z))].sort((a, b) => b - a)
}

// ── Tests ──────────────────────────────────────────────────────────────────────────

const STYLES: Style[] = ['dogbone', 't_bone', 'longest_edge']

describe('WO-2287: Pocket and Contour relieve inside corners through the production compute', () => {
  beforeAll(async () => {
    ;(globalThis as { self?: unknown }).self = workerSelf
    // Stubbed here, not per test: the fixture computes run in nested beforeAll hooks.
    vi.stubGlobal('Worker', InProcessToolpathWorker)
    await import('../../lib/cam/toolpathWorker')
    expect(typeof workerSelf.onmessage).toBe('function')
  })
  afterAll(() => {
    delete (globalThis as { self?: unknown }).self
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  describe('(a) Contour, outside, on Contour-Test-A-InsideCorner-Notch.dxf, 6 mm flat end mill', () => {
    const area = { x0: -10, y0: -10, w: 100, h: 70 }
    let plain: ToolpathMove[] = []
    let levels: number[] = []

    beforeAll(async () => {
      expect(notchLoop.points.length).toBeGreaterThanOrEqual(8)
      plain = await compute(notchGeo, contourOp(notchLoop.id, undefined))
      levels = cutLevels(plain)
      expect(levels.length).toBeGreaterThan(1)
    })

    it('None produces exactly the moves of an operation without the setting', async () => {
      const none = await compute(notchGeo, contourOp(notchLoop.id, 'none'))
      expect(none).toEqual(plain)
    })

    it('with None both slot corners keep their r-radius fillet of material', () => {
      const sim = simulate(plain, area.x0, area.y0, area.w, area.h)
      for (const k of NOTCH_CORNERS) expect(heightAt(sim, cornerPoint(k)), JSON.stringify(k.c)).toBe(TOP)
    })

    for (const style of STYLES) {
      it(`${style}: both slot corners are cut to the corner point at full depth; nothing else changes`, async () => {
        const moves = await compute(notchGeo, contourOp(notchLoop.id, style))
        // The main path is untouched: relief is appended after it. Its EXIT move is the one
        // move that IS different, and it is pinned move for move: instead of lifting in
        // place to Clearance (25) the tool travels to the relief's approach point at Retract
        // (17), because WO-3083 rule 2 crosses into a corner relief of the same operation at
        // Retract. Type, role and every other field of that move still compare equal.
        expect(plain[plain.length - 1]).toMatchObject({ type: 'rapid', z: heights.clearanceHeight })
        expect(moves.slice(0, plain.length - 1)).toEqual(plain.slice(0, -1))
        expect(moves[plain.length - 1]).toEqual({
          ...plain[plain.length - 1],
          x: RELIEF_APPROACH.x, y: RELIEF_APPROACH.y, z: heights.retractHeight,
        })
        expect(moves.length).toBeGreaterThan(plain.length)
        const sim = simulate(moves, area.x0, area.y0, area.w, area.h)
        const bottom = levels[levels.length - 1]
        for (const k of NOTCH_CORNERS) {
          expect(heightAt(sim, cornerPoint(k)), `${style} ${JSON.stringify(k.c)}`).toBe(bottom)
        }
        // The relief cuts at the operation's own stepdown levels, never deeper.
        const extra = moves.slice(plain.length)
        expect(Math.min(...extra.map(m => m.z))).toBe(bottom)
        expect(cutLevels(extra)).toEqual(levels)
        const kept = (p: Vec2) => pointInPoly(p, NOTCH_POLY) && distToPolyEdges(p, NOTCH_POLY) > CELL
        expect(keptMaterialCut(sim, kept, NOTCH_CORNERS.map(k => k.c))).toBe(0)
      })
    }
  })

  describe('(b) Pocket on a 60 x 40 rectangle with an L-shaped island, 6 mm flat end mill', () => {
    const area = { x0: 5, y0: 5, w: 70, h: 50 }
    let plain: ToolpathMove[] = []
    let levels: number[] = []

    beforeAll(async () => {
      plain = await compute(pocketGeo, pocketOp(undefined))
      levels = cutLevels(plain)
      expect(levels.length).toBeGreaterThan(1)
    })

    it('None produces exactly the moves of an operation without the setting', async () => {
      const none = await compute(pocketGeo, pocketOp('none'))
      expect(none).toEqual(plain)
    })

    it("with None the pocket's four corners and the island's reflex corner keep their fillet", () => {
      const sim = simulate(plain, area.x0, area.y0, area.w, area.h)
      for (const k of POCKET_CORNERS) expect(heightAt(sim, cornerPoint(k)), JSON.stringify(k.c)).toBe(TOP)
    })

    for (const style of STYLES) {
      it(`${style}: all four pocket corners and the island's reflex corner are cut at full depth`, async () => {
        const moves = await compute(pocketGeo, pocketOp(style))
        // The whole main path is compared, exit move included: the relief behind a pocket's
        // exit does not change it (measured 2026-10-29: rapid to Clearance, unchanged).
        expect(moves.slice(0, plain.length)).toEqual(plain)
        const sim = simulate(moves, area.x0, area.y0, area.w, area.h)
        const bottom = levels[levels.length - 1]
        for (const k of POCKET_CORNERS) {
          expect(heightAt(sim, cornerPoint(k)), `${style} ${JSON.stringify(k.c)}`).toBe(bottom)
        }
        expect(cutLevels(moves.slice(plain.length))).toEqual(levels)
        // The island's convex corners get no relief: their material is intact.
        for (const c of [{ x: 30, y: 22 }, { x: 50, y: 22 }, { x: 50, y: 30 }, { x: 38, y: 38 }, { x: 30, y: 38 }]) {
          const inward = { x: c.x + (c.x === 30 ? 0.1 : -0.1), y: c.y + (c.y === 22 ? 0.1 : -0.1) }
          expect(heightAt(sim, inward), `${style} island corner ${JSON.stringify(c)}`).toBe(TOP)
        }
        const kept = (p: Vec2) =>
          (!pointInPoly(p, POCKET_RECT) && distToPolyEdges(p, POCKET_RECT) > CELL) ||
          (pointInPoly(p, ISLAND_L) && distToPolyEdges(p, ISLAND_L) > CELL)
        expect(keptMaterialCut(sim, kept, POCKET_CORNERS.map(k => k.c))).toBe(0)
      })
    }
  })
})

describe('WO-2287: recipes carry the corner relief', () => {
  it('a recipe captured from a Pocket and a Contour keeps each style through save and load', () => {
    const recipe = createMachiningRecipe('Relief', [pocketOp('dogbone'), contourOp('loop', 'longest_edge')], [tool()])
    const loaded = deserializeRecipe(serializeRecipe(recipe))
    expect(loaded.operations.map(o => o.params.cornerRelief)).toEqual(['dogbone', 'longest_edge'])
  })
})
