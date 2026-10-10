// WO-2299: Engrave (Trace, on the line) cuts a trochoidal slot, through the production compute.
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts
//   -> buildEngraveToolpath -> the op's toolpathMoves
//
// The only stand-in is the Worker thread (node has none): the stub hands each request
// to the real worker module in-process (same harness as contourTrochoidal.wo2289).
// Moves are swept through the app's heightmap simulator (src/lib/simulation).
//
// Fixtures: an open S-curve polyline, an open half-circle arc and a closed 60 mm
// circle, a 6 mm flat end mill, slot width 9 mm (advance left to follow the tool),
// stock 12 mm thick cut 6 mm deep at 2 mm stepdowns. A 0.4 mm stroke is too short for
// one orbit and must be cut Plain with one console line.
//
// Deliberately imports nothing from the trochoidal module: on a main without the
// Style the same assertions fail on the moves themselves.

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
type Style = 'plain' | 'trochoidal'

const D = 6
const TR = D / 2
const W = 9            // slot width, 1.5 D
const HALF = W / 2
const TOP = 12
const DEPTH = 6
const FLOOR = TOP - DEPTH
const SAGITTA = 0.0022 * D

const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 17, feedHeight: 13,
  topHeight: TOP, topHeightMode: 'absolute',
  bottomHeight: FLOOR, bottomHeightMode: 'absolute',
}
const plungeLinking = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as LinkingParams
const rampLinking = { ...plungeLinking, entryType: 'ramp_linear' } as LinkingParams
const passes: PassParams = { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 }

function tool(): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: D, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 3 } },
  } as unknown as Tool
}

/** An S: one full sine period, 60 mm long, 10 mm amplitude (tightest bend radius ~9 mm). */
function sCurve(): Vec2[] {
  const pts: Vec2[] = []
  for (let k = 0; k <= 120; k++) {
    const x = 60 * k / 120
    pts.push({ x, y: 20 + 10 * Math.sin(2 * Math.PI * x / 60) })
  }
  return pts
}
/** A half circle of radius 20 about (110, 20), drawn from its right end over the top. */
function arc(): Vec2[] {
  const pts: Vec2[] = []
  for (let k = 0; k <= 90; k++) {
    const a = Math.PI * k / 90
    pts.push({ x: 110 + 20 * Math.cos(a), y: 20 + 20 * Math.sin(a) })
  }
  return pts
}
/** A 60 mm circle about (60, 90), CCW, not repeating its first point. */
function circle(): Vec2[] {
  const pts: Vec2[] = []
  for (let k = 0; k < 180; k++) {
    const a = 2 * Math.PI * k / 180
    pts.push({ x: 60 + 30 * Math.cos(a), y: 90 + 30 * Math.sin(a) })
  }
  return pts
}
const TINY: Vec2[] = [{ x: 140, y: 100 }, { x: 140.4, y: 100 }]

const geo: ImportedGeometry = {
  id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 140.4, y: 120, z: 0 },
    size: { x: 140.4, y: 120, z: 0 }, center: { x: 70.2, y: 60, z: 0 },
  },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  loaded: true,
  loops: [
    { id: 's', layerId: 'L1', closed: false, type: 'open', points: sCurve() },
    { id: 'arc', layerId: 'L1', closed: false, type: 'open', points: arc() },
    { id: 'circle', layerId: 'L1', closed: true, type: 'contour', area: Math.PI * 900, points: circle() },
    { id: 'tiny', layerId: 'L1', closed: false, type: 'open', points: TINY },
  ] as LoopData[],
  layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
} as ImportedGeometry

const STOCK = { x: -15, y: -10, w: 170, h: 140 }

function install(op: Operation): void {
  const stock: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: STOCK.w, height: STOCK.h, depth: TOP,
    position: { x: STOCK.x, y: STOCK.y, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: STOCK.w, fixedHeight: STOCK.h, fixedDepth: TOP, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: STOCK.x, y: STOCK.y, z: 0 }, max: { x: STOCK.x + STOCK.w, y: STOCK.y + STOCK.h, z: TOP },
      size: { x: STOCK.w, y: STOCK.h, z: TOP }, center: { x: STOCK.x + STOCK.w / 2, y: STOCK.y + STOCK.h / 2, z: TOP / 2 },
    },
    position: { x: STOCK.x, y: STOCK.y, z: 0 },
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

function engraveOp(loopId: string, style: Style | undefined, linking: LinkingParams = plungeLinking): Operation {
  const params: Record<string, unknown> = {
    geometryId: 'geo-1', loopIds: [loopId], includeOpen: true, includeClosed: true,
    mode: 'trace', depthModel: 'constant', side: 'center', sideOffset: 0, axialOffset: 0,
    targetLineWidth: 1, useWidthForDepth: false, direction: 'as_drawn',
    heightReference: 'stock_top', planeOffset: 0, tolerance: 0.01,
  }
  if (style !== undefined) params.engraveStyle = style
  if (style === 'trochoidal') params.trochoidalWidth = W
  return {
    id: 'op-engrave', name: 'Engrave', type: 'engrave', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('engrave', {
      setupId: 'setup-1', heights, params, geometryIds: ['geo-1'], explicitDepthMm: DEPTH,
    }),
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

function distPointSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
}

/** Distance to the drawn curve: an open one's ends are points, so its slot's ends are round. */
function curveDistance(pts: readonly Vec2[], closed: boolean, p: Vec2): number {
  let best = Infinity
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) best = Math.min(best, distPointSeg(p, pts[i], pts[(i + 1) % pts.length]))
  return best
}

function simulate(moves: readonly ToolpathMove[], box: { x0: number; y0: number; w: number; h: number }, cell: number) {
  const sim = new HeightmapSimulator(box.x0, box.y0, box.w, box.h, TOP, 0, cell)
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (a.z < TOP || b.z < TOP) sim.sweepMove(a.x, a.y, a.z, b.x, b.y, b.z, TR)
  }
  return sim
}

function heightAt(sim: HeightmapSimulator, p: Vec2): number {
  const ix = Math.floor((p.x - sim.x0) / sim.cellSize)
  const iy = Math.floor((p.y - sim.y0) / sim.cellSize)
  return sim.heights[iy * sim.nx + ix]
}

/** Cutting turn of the moves at one Z, in turns (+ = counter-clockwise, Y-up). */
function turnsAtLevel(moves: readonly ToolpathMove[], z: number): number {
  const pts = moves.filter(m => m.role === 'cut' && m.z === z)
  let turn = 0
  let prev: number | null = null
  for (let i = 1; i < pts.length; i++) {
    const h = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x)
    if (prev !== null) {
      let d = h - prev
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      turn += d
    }
    prev = h
  }
  return turn / (2 * Math.PI)
}

// ── Tests ──────────────────────────────────────────────────────────────────────────

const CELL = 0.1
/** Width tolerance: the slot is the requested width +/- 0.05 mm. */
const BAND = 0.05

describe('WO-2299: Engrave Style Trochoidal through the production compute', () => {
  beforeAll(async () => {
    ;(globalThis as { self?: unknown }).self = workerSelf
    vi.stubGlobal('Worker', InProcessToolpathWorker)
    vi.stubGlobal('window', {
      __cncViewport: {
        getStockBounds: () => ({
          min: { x: STOCK.x, y: STOCK.y, z: 0 }, max: { x: STOCK.x + STOCK.w, y: STOCK.y + STOCK.h, z: TOP },
        }),
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
    { name: 'an open S-curve polyline', loop: 's', pts: sCurve(), closed: false },
    { name: 'an open half-circle arc', loop: 'arc', pts: arc(), closed: false },
    { name: 'a closed 60 mm circle', loop: 'circle', pts: circle(), closed: true },
  ]

  for (const c of cases) {
    describe(c.name, () => {
      let plain: ToolpathMove[] = []
      let troch: ToolpathMove[] = []
      let sim: HeightmapSimulator
      const dist = (p: Vec2) => curveDistance(c.pts, c.closed, p)

      beforeAll(async () => {
        plain = await compute(engraveOp(c.loop, 'plain'))
        troch = await compute(engraveOp(c.loop, 'trochoidal'))
        const xs = c.pts.map(p => p.x), ys = c.pts.map(p => p.y)
        const m = HALF + 1
        const x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m
        sim = simulate(troch, { x0, y0, w: Math.max(...xs) + m - x0, h: Math.max(...ys) + m - y0 }, CELL)
      }, 60_000)

      it('Plain is the operation without the setting, move for move', async () => {
        const absent = await compute(engraveOp(c.loop, undefined))
        expect(plain).toEqual(absent)
        if (process.env.WO2299_PLAIN_DUMP) {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(`${process.env.WO2299_PLAIN_DUMP}-${c.loop}.json`, JSON.stringify(absent))
        }
      })

      it('cuts a slot of the requested width (+/- 0.05 mm) centred on the curve, to the full depth', () => {
        let inSlot = 0, uncut = 0, overcut = 0, wrongDepth = 0
        for (let iy = 0; iy < sim.ny; iy++) {
          for (let ix = 0; ix < sim.nx; ix++) {
            const p = { x: sim.x0 + (ix + 0.5) * CELL, y: sim.y0 + (iy + 0.5) * CELL }
            const h = sim.heights[iy * sim.nx + ix]
            const d = dist(p)
            if (d < HALF - BAND) {
              inSlot++
              if (h > FLOOR + 1e-6) uncut++
            } else if (d > HALF + BAND && h < TOP) {
              overcut++
            }
            if (h < FLOOR - 1e-6) wrongDepth++
          }
        }
        expect(inSlot).toBeGreaterThan(10_000)
        expect(uncut).toBe(0)
        expect(overcut).toBe(0)
        expect(wrongDepth).toBe(0)
        // ... and the plain pass is a tool-wide groove, not this slot.
        expect(troch.length).toBeGreaterThan(plain.length)
      })

      it('no emitted point lies outside the slot by more than the 0.0022 D sagitta bound', () => {
        let worst = -Infinity
        for (const m of troch) {
          if (m.z >= TOP) continue
          worst = Math.max(worst, dist(m) + TR - HALF)
        }
        expect(worst).toBeLessThanOrEqual(SAGITTA)
        // It reaches the slot edge, not short of it.
        expect(worst).toBeGreaterThan(-SAGITTA)
      })

      it('cuts in orbits that turn counter-clockwise for climb with a right-hand cutter', () => {
        const levels = [...new Set(troch.filter(m => m.role === 'plunge').map(m => m.z))].sort((a, b) => b - a)
        expect(levels).toEqual([10, 8, 6])
        const turns = turnsAtLevel(troch, FLOOR)
        // Many orbits, every one counter-clockwise (the guide's own turning is at most one).
        expect(turns).toBeGreaterThan(50)
      })

      if (!c.closed) {
        it('rounds each end on the curve end point and stops half the slot width past it', () => {
          const ends = [
            { p: c.pts[0], t: { x: c.pts[0].x - c.pts[1].x, y: c.pts[0].y - c.pts[1].y } },
            {
              p: c.pts[c.pts.length - 1],
              t: {
                x: c.pts[c.pts.length - 1].x - c.pts[c.pts.length - 2].x,
                y: c.pts[c.pts.length - 1].y - c.pts[c.pts.length - 2].y,
              },
            },
          ]
          for (const { p, t } of ends) {
            const len = Math.hypot(t.x, t.y)
            const out = { x: t.x / len, y: t.y / len }
            // Across the cap: out along the tangent and at 45 and 90 deg either side.
            for (const deg of [-90, -45, 0, 45, 90]) {
              const a = deg * Math.PI / 180
              const dir = {
                x: out.x * Math.cos(a) - out.y * Math.sin(a),
                y: out.x * Math.sin(a) + out.y * Math.cos(a),
              }
              const inside = { x: p.x + dir.x * (HALF - 0.15), y: p.y + dir.y * (HALF - 0.15) }
              const beyond = { x: p.x + dir.x * (HALF + 0.15), y: p.y + dir.y * (HALF + 0.15) }
              expect(heightAt(sim, inside), `${deg} deg inside the cap`).toBe(FLOOR)
              expect(heightAt(sim, beyond), `${deg} deg past the cap`).toBe(TOP)
            }
          }
        })
      } else {
        it('closes the loop with no ridge at the seam', () => {
          // The seam is where every level enters: the first plunge, beside the first point.
          const seam = c.pts[0]
          for (let off = -(HALF - 0.15); off <= HALF - 0.15 + 1e-9; off += 0.25) {
            for (const along of [-1, -0.5, 0, 0.5, 1]) {
              const p = { x: seam.x + off, y: seam.y + along }
              expect(heightAt(sim, p), JSON.stringify(p)).toBe(FLOOR)
            }
          }
        })
      }
    })
  }

  describe('Ramp entry', () => {
    it('descends by a helix inside the slot, never a plunge into material', async () => {
      const pts = sCurve()
      const moves = await compute(engraveOp('s', 'trochoidal', rampLinking))
      expect(moves.some(m => m.role === 'helix')).toBe(true)
      // The only plunges run down the bore an earlier level cut, to that level's floor.
      const plunges = moves.filter(m => m.role === 'plunge').map(m => m.z)
      expect(plunges).toEqual([10, 8])
      let worst = -Infinity
      for (const m of moves) if (m.z < TOP) worst = Math.max(worst, curveDistance(pts, false, m) + TR - HALF)
      expect(worst).toBeLessThanOrEqual(SAGITTA)
    })
  })

  describe('A curve too short for one orbit', () => {
    it('is cut Plain and one plain console line names it', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const plain = await compute(engraveOp('tiny', 'plain'))
      info.mockClear()
      const troch = await compute(engraveOp('tiny', 'trochoidal'))
      expect(troch).toEqual(plain)
      const lines = info.mock.calls.map(args => String(args[0])).filter(l => l.includes('trochoidal'))
      expect(lines).toEqual(['Engrave: curve "tiny" was cut Plain - it is too short for one trochoidal orbit.'])
    })
  })
})

describe('WO-2299: recipes carry the Engrave style', () => {
  it('a recipe captured from an Engrave keeps Trochoidal and its slot width', () => {
    const recipe = createMachiningRecipe('Slot', [engraveOp('s', 'trochoidal')], [tool()])
    const loaded = deserializeRecipe(serializeRecipe(recipe))
    const p = loaded.operations[0].params
    expect([p.engraveStyle, p.trochoidalWidth]).toEqual(['trochoidal', W])
  })
})
