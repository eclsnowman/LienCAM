// WO-2289: closed Contour roughs in trochoidal orbits, through the production compute.
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts
//   -> buildContourToolpath -> the op's toolpathMoves
//
// The only stand-in is the Worker thread (node has none): the stub hands each request
// to the real worker module in-process (same harness as cornerReliefOperations.wo2287).
// Moves are swept through the app's heightmap simulator (src/lib/simulation).
//
// Fixtures: an outside Contour on a 100 x 60 mm rounded rectangle and an inside Contour
// on a 40 mm square hole, 6 mm flat end mill, roughing + final finish, 4 triangular
// tabs, stock 12 mm thick cut through at 4 mm stepdowns. A 10 mm hole is too small for
// the channel and must fall back to Offset with one console line.
//
// Deliberately imports nothing from the trochoidal module: on a main without the
// Roughing style the same assertions fail on the moves themselves.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
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
type Style = 'offset' | 'trochoidal'

const D = 6
const TR = D / 2
const S = 0.5
const W = 9          // channel width, 1.5 D
const ADVANCE = 0.75 // advance per orbit, mm (pinned, not the 0.6 default)
const A = 0.01 * D
const TOP = 12
const BOTTOM = 0
const TAB_H = 2
const TAB_TOP = BOTTOM + TAB_H
// Wide enough that the finish pass's own 45 deg ramps (cut by a 6 mm cutter) leave a
// plateau standing at the full tab top: width >= 2 x height + D.
const TAB_W = 12
const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: BOTTOM, bottomHeightMode: 'absolute',
}
const plungeLinking = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as LinkingParams
const rampLinking = { ...plungeLinking, entryType: 'ramp_linear' } as LinkingParams

function tool(): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: D, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 4, stepover: 2 } },
  } as unknown as Tool
}

// 100 x 60 rounded rectangle, corner radius 6, CCW.
const RR = { x0: 0, y0: 0, x1: 100, y1: 60, r: 6 }
function roundedRect(): Vec2[] {
  const { x0, y0, x1, y1, r } = RR
  const corners = [
    { c: { x: x1 - r, y: y0 + r }, a0: -Math.PI / 2 },
    { c: { x: x1 - r, y: y1 - r }, a0: 0 },
    { c: { x: x0 + r, y: y1 - r }, a0: Math.PI / 2 },
    { c: { x: x0 + r, y: y0 + r }, a0: Math.PI },
  ]
  const pts: Vec2[] = []
  for (const { c, a0 } of corners) {
    for (let k = 0; k <= 45; k++) {
      const a = a0 + (Math.PI / 2) * (k / 45)
      pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
    }
  }
  return pts
}
/** Signed distance to the rounded rectangle (positive outside). */
function sdRounded(p: Vec2): number {
  const cx = (RR.x0 + RR.x1) / 2, cy = (RR.y0 + RR.y1) / 2
  const qx = Math.abs(p.x - cx) - ((RR.x1 - RR.x0) / 2 - RR.r)
  const qy = Math.abs(p.y - cy) - ((RR.y1 - RR.y0) / 2 - RR.r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RR.r
}

const HOLE = { x0: 30, y0: 10, x1: 70, y1: 50 }
const SMALL = { x0: 8, y0: 25, x1: 18, y1: 35 }
const square = (b: typeof HOLE): Vec2[] =>
  [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }]
/** Distance from a point inside the square to its walls. */
const insideWallDist = (b: typeof HOLE, p: Vec2) =>
  Math.min(p.x - b.x0, b.x1 - p.x, p.y - b.y0, b.y1 - p.y)

const geo: ImportedGeometry = {
  id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 60, z: 0 },
    size: { x: 100, y: 60, z: 0 }, center: { x: 50, y: 30, z: 0 },
  },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  loaded: true,
  loops: [
    { id: 'outer', layerId: 'L1', closed: true, type: 'contour', area: 6000, points: roundedRect() },
    { id: 'hole', layerId: 'L1', closed: true, type: 'hole', area: 1600, points: square(HOLE) },
    { id: 'small', layerId: 'L1', closed: true, type: 'hole', area: 100, points: square(SMALL) },
  ] as LoopData[],
  layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
} as ImportedGeometry

function install(op: Operation): void {
  const stock: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: 130, height: 100, depth: TOP, position: { x: -15, y: -20, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: 130, fixedHeight: 100, fixedDepth: TOP, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: -15, y: -20, z: 0 }, max: { x: 115, y: 80, z: TOP },
      size: { x: 130, y: 100, z: TOP }, center: { x: 50, y: 30, z: TOP / 2 },
    },
    position: { x: -15, y: -20, z: 0 },
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

const passes: PassParams = { stepdown: 4, stepover: 2, stockToLeave: S, finishPasses: 1, springPasses: 0 }

function contourOp(
  loopId: string, side: 'outer' | 'inner', style: Style | undefined,
  opts: { tabs?: boolean; linking?: LinkingParams } = {},
): Operation {
  const tabs = opts.tabs ?? true
  const params: Record<string, unknown> = {
    geometryId: 'geo-1', loopIds: [loopId], side, direction: 'climb', contourFinishMode: 'final',
    tabs, ...(tabs ? { tabCount: 4, tabShape: 'triangular', tabWidth: TAB_W, tabHeight: TAB_H } : {}),
  }
  if (style !== undefined) params.roughingStyle = style
  if (style === 'trochoidal') { params.trochoidalWidth = W; params.trochoidalAdvance = ADVANCE }
  const linking = opts.linking ?? plungeLinking
  return {
    id: 'op-contour', name: 'Contour', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['geo-1'] }),
  } as unknown as Operation
}

async function compute(op: Operation): Promise<ToolpathMove[]> {
  install(op)
  await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
  const done = useCamStore.getState().project.setups[0].operations[0]
  expect(done.status, done.errorMessage).toBe('ready')
  return done.toolpathMoves ?? []
}

// ── Measurements ───────────────────────────────────────────────────────────────────

/** Index of the finish pass: its rapid entry, three rapids before its lead-in plunge. */
function finishStart(moves: readonly ToolpathMove[]): number {
  const i = moves.findIndex(m => m.role === 'lead_in')
  expect(i).toBeGreaterThan(3)
  // WO-3083: the finish approach is the run of rapids standing over the finish entry (it was
  // always three - Clearance, Retract, Feed; the hop now arrives at Retract and drops to Feed).
  let k = i
  while (k > 0 && moves[k - 1].type === 'rapid' && moves[k - 1].x === moves[i].x && moves[k - 1].y === moves[i].y) k--
  return k
}

/** Smallest wall distance along every cutting chord (both ends below the stock top). */
function minChordWallDistance(moves: readonly ToolpathMove[], wallDist: (p: Vec2) => number): number {
  let min = Infinity
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (a.z >= TOP || b.z >= TOP) continue
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.02))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      min = Math.min(min, wallDist({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }))
    }
  }
  return min
}

/** Orbits cut at one level: the trochoid's tangent turns once per orbit, the stationary
 *  entry orbit included, whatever the guide does (the orbit speed beats the advance). */
function orbitsAtLevel(moves: readonly ToolpathMove[], z: number): number {
  // The level's closed loop: its plunge point, then every cut at that Z back to it.
  const pts = moves.filter(m => (m.role === 'cut' || m.role === 'plunge') && m.z === z)
  expect(Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y)).toBeLessThan(1e-9)
  const chords = pts.slice(1).map((p, i) => Math.atan2(p.y - pts[i].y, p.x - pts[i].x))
  let turn = 0
  for (let i = 0; i < chords.length; i++) {
    let d = chords[(i + 1) % chords.length] - chords[i]
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    turn += d
  }
  return turn / (2 * Math.PI)
}

/** The rough pass's levels: where its plunges land. */
function cutLevels(moves: readonly ToolpathMove[]): number[] {
  return [...new Set(moves.filter(m => m.role === 'plunge').map(m => m.z))].sort((a, b) => b - a)
}

function simulate(
  moves: readonly ToolpathMove[], box: { x0: number; y0: number; w: number; h: number }, cell: number,
  keep: (a: ToolpathMove, b: ToolpathMove) => boolean = () => true,
): HeightmapSimulator {
  const sim = new HeightmapSimulator(box.x0, box.y0, box.w, box.h, TOP, -10, cell)
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (keep(a, b)) sim.sweepMove(a.x, a.y, a.z, b.x, b.y, b.z, TR)
  }
  return sim
}

function heightAt(sim: HeightmapSimulator, p: Vec2): number {
  const ix = Math.floor((p.x - sim.x0) / sim.cellSize)
  const iy = Math.floor((p.y - sim.y0) / sim.cellSize)
  return sim.heights[iy * sim.nx + ix]
}

function eachCell(sim: HeightmapSimulator, visit: (p: Vec2, h: number) => void): void {
  for (let iy = 0; iy < sim.ny; iy++) {
    for (let ix = 0; ix < sim.nx; ix++) {
      visit({ x: sim.x0 + (ix + 0.5) * sim.cellSize, y: sim.y0 + (iy + 0.5) * sim.cellSize }, sim.heights[iy * sim.nx + ix])
    }
  }
}

/** The finish pass's tab tops: runs of consecutive finish moves at the tab-top Z. */
function finishTabCentres(finish: readonly ToolpathMove[]): Vec2[] {
  const centres: Vec2[] = []
  let run: ToolpathMove[] = []
  const flush = () => {
    if (run.length >= 2) {
      const a = run[0], b = run[run.length - 1]
      centres.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    }
    run = []
  }
  for (const m of finish) {
    if (m.role === 'cut' && Math.abs(m.z - TAB_TOP) < 1e-9) run.push(m)
    else flush()
  }
  flush()
  return centres
}

// ── Tests ──────────────────────────────────────────────────────────────────────────

const CELL = 0.2
const TOL = 2 * CELL

describe('WO-2289: Contour Roughing style Trochoidal through the production compute', () => {
  beforeAll(async () => {
    ;(globalThis as { self?: unknown }).self = workerSelf
    vi.stubGlobal('Worker', InProcessToolpathWorker)
    // Tabs prove a cut-through against the rendered stock's bottom; CNCViewport
    // installs this in the app, jsdom has none (same stub as the store E2E tests).
    vi.stubGlobal('window', {
      __cncViewport: {
        getStockBounds: () => ({ min: { x: -15, y: -20, z: 0 }, max: { x: 115, y: 80, z: TOP } }),
      },
    })
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

  const cases = [
    {
      name: 'outside Contour on a 100 x 60 rounded rectangle',
      loop: 'outer', side: 'outer' as const,
      box: { x0: -14, y0: -14, w: 128, h: 88 },
      wallDist: (p: Vec2) => sdRounded(p),
      // Analytic guide: the rounded rectangle offset by S + W/2 + 0.01 D.
      guideLength: (g: number) => 2 * (100 - 2 * RR.r) + 2 * (60 - 2 * RR.r) + 2 * Math.PI * (RR.r + g),
      /** Away from inside corners every channel cell is reachable. */
      awayFromCorners: () => true,
      outward: (p: Vec2) => sdRounded(p),
    },
    {
      name: 'inside Contour on a 40 mm square hole',
      loop: 'hole', side: 'inner' as const,
      box: { x0: HOLE.x0 - 1, y0: HOLE.y0 - 1, w: 42, h: 42 },
      wallDist: (p: Vec2) => insideWallDist(HOLE, p),
      guideLength: (g: number) => 4 * (40 - 2 * g),
      // A round cutter leaves a fillet in an inside corner, Offset and Trochoidal alike.
      awayFromCorners: (p: Vec2) =>
        Math.min(...square(HOLE).map(c => Math.hypot(p.x - c.x, p.y - c.y))) > S + A + W + D,
      outward: (p: Vec2) => insideWallDist(HOLE, p),
    },
  ]

  for (const c of cases) {
    describe(c.name, () => {
      let offset: ToolpathMove[] = []
      let troch: ToolpathMove[] = []
      let levels: number[] = []

      beforeAll(async () => {
        offset = await compute(contourOp(c.loop, c.side, 'offset'))
        troch = await compute(contourOp(c.loop, c.side, 'trochoidal'))
        levels = cutLevels(offset)
        expect(levels).toEqual([8, 4, 0])
      })

      it('Offset is the operation without the setting, move for move', async () => {
        const plain = await compute(contourOp(c.loop, c.side, undefined))
        expect(offset).toEqual(plain)
      })

      it('the finish pass is unchanged from Offset roughing', () => {
        expect(troch.slice(finishStart(troch))).toEqual(offset.slice(finishStart(offset)))
        expect(troch.length).toBeGreaterThan(offset.length)
      })

      it('no rough chord comes closer to the finished wall than tool radius + radial stock', () => {
        const rough = troch.slice(0, finishStart(troch))
        const min = minChordWallDistance(rough, c.wallDist)
        expect(min).toBeGreaterThanOrEqual(TR + S - 1e-9)
        // ... and it reaches the 0.01 D allowance line, not further out.
        expect(min).toBeLessThanOrEqual(TR + S + A + 0.0022 * D)
      })

      it('the orbit advance between loops is the requested advance within 1%', () => {
        const g = S + W / 2 + A
        const orbits = orbitsAtLevel(troch, levels[0])
        const loops = Math.abs(orbits) - 1 // less the stationary entry orbit
        expect(Math.abs(loops - Math.round(loops))).toBeLessThan(1e-6)
        const advance = c.guideLength(g) / Math.round(loops)
        expect(Math.abs(advance - ADVANCE) / ADVANCE).toBeLessThan(0.01)
        // Climb with a right-hand cutter orbits counter-clockwise (Y-up).
        expect(Math.sign(orbits)).toBe(1)
      })

      it('each level cuts the channel to the requested width and the seam leaves no ridge', () => {
        const top = levels[0]
        const sim = simulate(troch, c.box, CELL, (a, b) => a.z === top && b.z === top)
        let uncut = 0, overcut = 0, inChannel = 0
        eachCell(sim, (p, h) => {
          const d = c.outward(p)
          if (d > S + A + TOL && d < S + A + W - TOL && c.awayFromCorners(p)) {
            inChannel++
            if (h > top + 1e-6) uncut++
          }
          if ((d > S + A + W + TOL || (d > -1 && d < S + A - TOL)) && h < TOP) overcut++
        })
        expect(inChannel).toBeGreaterThan(1000)
        expect(uncut).toBe(0)
        expect(overcut).toBe(0)
      })

      it('the four tabs stand at their height through the whole operation', () => {
        const sim = simulate(troch, c.box, CELL)
        const centres = finishTabCentres(troch.slice(finishStart(troch)))
        expect(centres.length).toBe(4)
        for (const centre of centres) {
          // Walk out from the wall across the channel, through the tab's middle.
          const d0 = c.outward(centre)
          const e = 0.01
          const grad = {
            x: (c.outward({ x: centre.x + e, y: centre.y }) - c.outward({ x: centre.x - e, y: centre.y })) / (2 * e),
            y: (c.outward({ x: centre.x, y: centre.y + e }) - c.outward({ x: centre.x, y: centre.y - e })) / (2 * e),
          }
          const wall = { x: centre.x - grad.x * d0, y: centre.y - grad.y * d0 }
          let low = Infinity
          for (let t = 0.3; t < S + A + W - TOL; t += CELL) {
            low = Math.min(low, heightAt(sim, { x: wall.x + grad.x * t, y: wall.y + grad.y * t }))
          }
          expect(low, JSON.stringify(centre)).toBeGreaterThanOrEqual(TAB_TOP - 1e-6)
          // The channel over the tab is cut down to the tab top, not left at full height.
          const mid = { x: wall.x + grad.x * (S + A + W / 2), y: wall.y + grad.y * (S + A + W / 2) }
          expect(heightAt(sim, mid), JSON.stringify(centre)).toBeCloseTo(TAB_TOP, 6)
        }
      })
    })
  }

  describe('Ramp entry: a helix on the orbit circle, same clearance', () => {
    it('descends by helix moves and keeps every chord clear of the wall', async () => {
      const moves = await compute(contourOp('outer', 'outer', 'trochoidal', { linking: rampLinking, tabs: false }))
      expect(moves.some(m => m.role === 'helix')).toBe(true)
      expect(moves.some(m => m.role === 'plunge')).toBe(false)
      const rough = moves.slice(0, moves.findIndex(m => m.role === 'lead_in'))
      expect(minChordWallDistance(rough, sdRounded)).toBeGreaterThanOrEqual(TR + S - 1e-9)
      // Without tabs the rough pass bridges into the finish without a retract.
      const firstFinishCut = moves.findIndex(m => m.role === 'lead_in')
      expect(moves.slice(0, firstFinishCut).filter(m => m.type === 'rapid' && m.z === 25).length).toBe(1)
    })
  })

  describe('A hole smaller than the channel', () => {
    it('is roughed with Offset and one plain console line names it', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const offset = await compute(contourOp('small', 'inner', 'offset', { tabs: false }))
      info.mockClear()
      const troch = await compute(contourOp('small', 'inner', 'trochoidal', { tabs: false }))
      expect(troch).toEqual(offset)
      const lines = info.mock.calls.map(args => String(args[0])).filter(l => l.includes('trochoidal'))
      expect(lines).toEqual([
        // The operator sees no internal loop id (WO-2880); an unnamed loop is "a selected loop".
        'Contour: a selected loop was roughed with Offset - the trochoidal channel does not fit it. ' +
        'Narrow the Channel width to rough it in orbits.',
      ])
    })
  })
})

describe('WO-2289: recipes carry the roughing style', () => {
  it('a recipe captured from a Contour keeps Trochoidal, its width and its advance', () => {
    const recipe = createMachiningRecipe('Troch', [contourOp('outer', 'outer', 'trochoidal')], [tool()])
    const loaded = deserializeRecipe(serializeRecipe(recipe))
    const p = loaded.operations[0].params
    expect([p.roughingStyle, p.trochoidalWidth, p.trochoidalAdvance]).toEqual(['trochoidal', W, ADVANCE])
  })
})
