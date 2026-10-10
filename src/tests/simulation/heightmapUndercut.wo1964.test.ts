// @vitest-environment jsdom
//
// WO-1964: the Simulate screen's 2.5D (heightmap) view carved a lollipop /
// dovetail / slitting-saw head's full width straight up through the stock,
// removing the overhang the head passes UNDER. WO-1383 gave HeightmapSimulator
// an optional bodyTop(d) for exactly this, but SimulationPanel never passed it.
//
// Drives the real SimulationPanel (heightmap engine, production seek path
// through the scrubber) and reads the heights it hands the viewport.
//
// The real operation (Operator, 2026-09-25): an O-RING GROOVE round the outside of
// a square block, the lollipop coming in from OUTSIDE at groove depth and
// tracing the perimeter with its neck in air. Only the head cuts; the block
// above and below the groove stays. The 3D (voxel) view removes only the
// groove; the 2.5D view, which stores only the top surface, must leave that top
// untouched (before WO-1964 it cut the head's width off the top edge all the
// way round). holderClearance must see the neck and shank clear of the block.
//
// Negative control (NOT a real operation): the lollipop fed straight through
// the middle of a 40 x 20 x 12 stock at tip Z2, which drags its neck and shank
// through the stock. holderClearance must call that a NECK collision - a crash,
// not a cut. The 2.5D carve of it is still pinned (only the neck width opened
// above the head), but it proves nothing about a real cut.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import type { Setup, Tool, ToolpathMove } from '../../types'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import type { VoxelField } from '../../lib/simulation/voxel/VoxelField'
import { checkHolderAndShankClearance, toolNeckBand } from '../../lib/cam/holderClearance'
import { createStockState } from '../../lib/cam/stockState'
import { buildToolProfile, tipOffsetAtRadius, toolBodyTopAtRadius } from '../../lib/tool/toolProfile'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeTool, makeWcs } = await import('../post/helpers')

const STOCK = { x0: 0, y0: 0, nx: 80, ny: 40, cellSize: 0.5, stockTop: 12, stockBot: 0 }
type Grid = typeof STOCK
// The grid the (mock) viewport hands the panel; the O-ring groove uses its own.
let grid: Grid = STOCK
const TIP_Z = 2
const LINE_Y = 10
const HEAD_R = 3
const NECK_R = 1.2

// Every field the panel's tool config reads is set explicitly, so the witness
// below builds the very profile the panel builds.
const LOLLIPOP: Tool = makeTool({
  id: 't-lollipop', type: 'lollipop_mill', diameter: 6, neckDiameter: 2.4,
  shoulderLength: 8, fluteLength: 12, overallLength: 50, shankDiameter: 6,
  cornerRadius: 0, angleFromAxisDeg: 59,
})

function passAlongY10(tipZ: number): ToolpathMove[] {
  return [
    { type: 'rapid', role: 'rapid', x: -6, y: LINE_Y, z: 30 },
    { type: 'rapid', role: 'rapid', x: -6, y: LINE_Y, z: 20 },
    { type: 'feed', role: 'plunge', x: -6, y: LINE_Y, z: tipZ, feed: 300 },
    { type: 'feed', role: 'cut', x: 46, y: LINE_Y, z: tipZ, feed: 600 },
  ]
}

const mockVp = {
  setToolMarkerPosition: vi.fn(),
  showToolMarker: vi.fn(),
  updateToolGeometry: vi.fn(),
  disposeStockSim: vi.fn(),
  disposeVoxelSim: vi.fn(),
  setStockSimVisible: vi.fn(),
  setStockSimOpacity: vi.fn(),
  initStockSim: vi.fn(() => ({ ...grid })),
  updateStockSimHeights: vi.fn<(h: Float32Array) => void>(),
  initVoxelSim: vi.fn(),
  syncVoxelSim: vi.fn<(f: VoxelField) => void>(),
  supportsVoxelSim: vi.fn(() => false),
  setSimulationToolpathPreview: vi.fn(),
}

type Engine = 'heightmap' | 'voxel'

function seed(
  tools: Tool[], ops: Array<{ id: string; tool: Tool; moves: ToolpathMove[] }>, activeId: string,
  engine: Engine = 'heightmap',
): void {
  const setup: Setup = {
    id: 'setup-wo1964',
    name: 'WO-1964 undercut fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: grid.nx * grid.cellSize, height: grid.ny * grid.cellSize, depth: grid.stockTop - grid.stockBot,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: ops.map((o) => makeOp({ id: o.id, name: o.id, toolId: o.tool.id, toolpathMoves: o.moves })),
    notes: '',
  }
  mockVp.supportsVoxelSim.mockImplementation(() => engine === 'voxel')
  act(() => {
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        machine: { ...s.project.machine, rapidRate: 5000 },
        setups: [setup],
        activeSetupId: setup.id,
        activeOperationId: activeId,
      },
      toolLibrary: tools,
      holders: [],
      viewer: { ...s.viewer, mode: 'simulation', stockSimEnabled: true, stockSimResolution: grid.cellSize },
      appSettings: { ...s.appSettings, displayUnits: 'mm', simulationEngine: engine },
    }))
  })
}

const scrubber = () => document.querySelector('input.sim-scrubber') as HTMLInputElement

// Play the whole program through the production seek path and return the
// heights the panel last handed the viewport.
function carvedToEnd(): Float32Array {
  seekToEnd()
  const calls = mockVp.updateStockSimHeights.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0].slice()
}

function seekToEnd(): void {
  render(createElement(SimulationPanel))
  const end = Number(scrubber().max)
  expect(end).toBeGreaterThan(0)
  act(() => { fireEvent.change(scrubber(), { target: { value: String(end) } }) })
}

// Same, voxel engine: the field the panel last handed the viewport.
function voxelCarvedToEnd(): VoxelField {
  seekToEnd()
  const calls = mockVp.syncVoxelSim.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0]
}

// Independent witness: HeightmapSimulator sweeps of every feed move, with the
// tool's bottom profile and (when given) its body top.
function witness(passes: Array<{ tool: Tool; moves: ToolpathMove[]; bounded: boolean }>, g: Grid = STOCK): Float32Array {
  const sim = new HeightmapSimulator(
    g.x0, g.y0, g.nx * g.cellSize, g.ny * g.cellSize,
    g.stockTop, g.stockBot, g.cellSize,
  )
  for (const { tool, moves, bounded } of passes) {
    const profile = buildToolProfile(tool)
    const bottom = (d: number) => tipOffsetAtRadius(profile, d)
    const top = bounded ? (d: number) => toolBodyTopAtRadius(profile, d) : undefined
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      if (b.type === 'rapid') continue
      sim.sweepMoveWithProfile(a.x, a.y, a.z, b.x, b.y, b.z, tool.diameter / 2, bottom, top)
    }
  }
  return sim.snapshot()
}

function countDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length)
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

// Section across the pass at X20 (cell 40, centre X20.25): [dy, top Z] per row.
function sectionAtX20(field: Float32Array): Array<{ dy: number; z: number }> {
  const out: Array<{ dy: number; z: number }> = []
  for (let iy = 0; iy < STOCK.ny; iy++) {
    const y = STOCK.y0 + (iy + 0.5) * STOCK.cellSize
    out.push({ dy: y - LINE_Y, z: field[iy * STOCK.nx + 40] })
  }
  return out
}

// Overhang census over the whole field: cells the head sweeps under (strictly
// outside the neck, inside the head) where the stock is above the head's top.
function overhangCells(field: Float32Array, xMin: number, xMax: number): { total: number; standing: number } {
  let total = 0, standing = 0
  for (let iy = 0; iy < STOCK.ny; iy++) {
    const ay = Math.abs(STOCK.y0 + (iy + 0.5) * STOCK.cellSize - LINE_Y)
    if (ay <= NECK_R + 0.1 || ay >= HEAD_R - 0.1) continue
    for (let ix = 0; ix < STOCK.nx; ix++) {
      const x = STOCK.x0 + (ix + 0.5) * STOCK.cellSize
      if (x < xMin || x > xMax) continue
      total++
      if (field[iy * STOCK.nx + ix] === STOCK.stockTop) standing++
    }
  }
  return { total, standing }
}

beforeEach(() => {
  grid = STOCK
  act(() => { useCamStore.getState().newProject() })
  Object.values(mockVp).forEach(fn => fn.mockClear())
  mockVp.supportsVoxelSim.mockImplementation(() => false)
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-1964: the 2.5D simulation knows an undercut cutter\'s head', () => {
  it('negative control - a lollipop fed THROUGH the stock is a neck collision (holderClearance); the 2.5D carve opens only the neck width above the head', () => {
    const moves = passAlongY10(TIP_Z)
    // The neck passing through stock is a crash, not a cut.
    const block = createStockState({ minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 20, maxZ: 12 }, 0.1)
    const crash = checkHolderAndShankClearance({ stock: block, moves, tool: LOLLIPOP })
    expect(crash.shankStatus).toBe('checked')
    expect(crash.collisions.map((c) => c.moveIndex), 'the feed through the stock collides').toEqual([3])
    expect(crash.collisions[0].components, 'reported as a NECK collision').toContain('neck')

    seed([LOLLIPOP], [{ id: 'op-lollipop', tool: LOLLIPOP, moves }], 'op-lollipop')
    const field = carvedToEnd()

    // The unbounded carve DOES remove this overhang (the test is not vacuous).
    const unbounded = witness([{ tool: LOLLIPOP, moves, bounded: false }])
    expect(overhangCells(unbounded, 3, 37).standing, 'overhang standing in the old carve').toBe(0)

    const { total, standing } = overhangCells(field, 3, 37)
    expect(total, 'overhang cells in the scenario').toBeGreaterThan(400)
    expect(standing, 'overhang cells above the head kept at Z12').toBe(total)

    // Across the section: above the head only the neck removes stock.
    const profile = buildToolProfile(LOLLIPOP)
    for (const { dy, z } of sectionAtX20(field)) {
      const ad = Math.abs(dy)
      if (ad < NECK_R - 0.1) expect(z, `neck column dy=${dy}`).toBeCloseTo(TIP_Z + tipOffsetAtRadius(profile, ad), 1)
      else if (ad > NECK_R + 0.1) expect(z, `dy=${dy}`).toBe(STOCK.stockTop)
    }

    expect(countDiff(field, witness([{ tool: LOLLIPOP, moves, bounded: true }])), 'panel vs bounded witness').toBe(0)
  })

  it('a head that reaches the surface still cuts to its full width (a pass above the stock top lowers it)', () => {
    // Tip at Z9: head spans Z9..Z15 through the Z12 top, so every column the
    // head crosses is reached from above and lowered to the head's bottom.
    const moves = passAlongY10(9)
    seed([LOLLIPOP], [{ id: 'op-lollipop', tool: LOLLIPOP, moves }], 'op-lollipop')
    const field = carvedToEnd()
    const profile = buildToolProfile(LOLLIPOP)
    for (const { dy, z } of sectionAtX20(field)) {
      const ad = Math.abs(dy)
      if (ad < HEAD_R - 0.1) expect(z, `dy=${dy}`).toBeCloseTo(Math.min(STOCK.stockTop, 9 + tipOffsetAtRadius(profile, ad)), 1)
    }
    expect(countDiff(field, witness([{ tool: LOLLIPOP, moves, bounded: false }])), 'same as the unbounded carve').toBe(0)
  })

  it('the pre-carve of an earlier lollipop operation keeps the overhang and uses the tool\'s own neck', () => {
    const FLAT: Tool = makeTool({
      id: 't-flat', type: 'flat_end_mill', diameter: 6, shoulderLength: 25, fluteLength: 25,
      overallLength: 60, shankDiameter: 6, cornerRadius: 0, angleFromAxisDeg: 59,
    })
    const lollipopMoves = passAlongY10(TIP_Z)
    const flatMoves: ToolpathMove[] = [
      { type: 'rapid', role: 'rapid', x: 30, y: 3, z: 20 },
      { type: 'feed', role: 'plunge', x: 30, y: 3, z: 11, feed: 300 },
      { type: 'feed', role: 'cut', x: 35, y: 3, z: 11, feed: 600 },
    ]
    seed([LOLLIPOP, FLAT], [
      { id: 'op-lollipop', tool: LOLLIPOP, moves: lollipopMoves },
      { id: 'op-flat', tool: FLAT, moves: flatMoves },
    ], 'op-flat')
    const field = carvedToEnd()
    const { total, standing } = overhangCells(field, 3, 37)
    expect(total).toBeGreaterThan(400)
    expect(standing, 'pre-carved overhang kept at Z12').toBe(total)
    expect(countDiff(field, witness([
      { tool: LOLLIPOP, moves: lollipopMoves, bounded: true },
      { tool: FLAT, moves: flatMoves, bounded: false },
    ])), 'panel vs witness (pre-carve + active op)').toBe(0)
  })

  const monotonic: Tool[] = [
    makeTool({ id: 't-m', type: 'flat_end_mill', diameter: 6 }),
    makeTool({ id: 't-m', type: 'ball_end_mill', diameter: 6 }),
    makeTool({ id: 't-m', type: 'bull_nose', diameter: 8, cornerRadius: 1 }),
    makeTool({ id: 't-m', type: 'drill', diameter: 5, angleFromAxisDeg: 59 }),
    makeTool({ id: 't-m', type: 'chamfer_mill', diameter: 10, angleFromAxisDeg: 45 }),
  ].map((t) => ({
    ...t,
    shoulderLength: t.shoulderLength ?? t.fluteLength,
    cornerRadius: t.cornerRadius ?? 0,
    angleFromAxisDeg: t.angleFromAxisDeg ?? 59,
  }))

  it.each(monotonic.map((t) => [t.type, t] as const))('%s: carve is identical to the unbounded carve', (_type, tool) => {
    const moves = passAlongY10(TIP_Z)
    seed([tool], [{ id: 'op-m', tool, moves }], 'op-m')
    const field = carvedToEnd()
    expect(countDiff(field, STOCK_BASELINE()), 'the pass cuts something').toBeGreaterThan(0)
    expect(countDiff(field, witness([{ tool, moves, bounded: false }])), 'panel vs pre-WO-1964 carve').toBe(0)
  })
})

function STOCK_BASELINE(): Float32Array {
  return new Float32Array(STOCK.nx * STOCK.ny).fill(STOCK.stockTop)
}

// ── The real operation: an O-ring groove round a 20 x 20 x 12 block ──────────
// Block X0..20 Y0..20 Z0..12, 0.25 mm cells (heightmap and voxel alike). The
// head's tip runs at Z4 (head centre Z7) with its axis 1.8 mm outside each wall,
// so the head cuts a groove 1.2 mm deep (Z4.6..Z9.4 on the wall) and the 1.2 mm
// neck radius keeps 0.6 mm of air to the wall. It comes down OUTSIDE the block,
// feeds in at groove depth, traces the perimeter and leaves the same way.
const BLOCK: Grid = { x0: 0, y0: 0, nx: 80, ny: 80, cellSize: 0.25, stockTop: 12, stockBot: 0 }
const GROOVE_TIP_Z = 4
const HEAD_CZ = GROOVE_TIP_Z + HEAD_R
const OFF = 1.8
const LO = -OFF, HI = 20 + OFF
const GROOVE: ToolpathMove[] = [
  { type: 'rapid', role: 'rapid', x: -10, y: LO, z: 30 },
  { type: 'rapid', role: 'rapid', x: -10, y: LO, z: 20 },
  { type: 'feed', role: 'plunge', x: -10, y: LO, z: GROOVE_TIP_Z, feed: 300 },
  { type: 'feed', role: 'cut', x: HI, y: LO, z: GROOVE_TIP_Z, feed: 600 },
  { type: 'feed', role: 'cut', x: HI, y: HI, z: GROOVE_TIP_Z, feed: 600 },
  { type: 'feed', role: 'cut', x: LO, y: HI, z: GROOVE_TIP_Z, feed: 600 },
  { type: 'feed', role: 'cut', x: LO, y: LO - 8, z: GROOVE_TIP_Z, feed: 600 },
  { type: 'rapid', role: 'rapid', x: LO, y: LO - 8, z: 30 },
]

// XY distance from a point to the groove's tool-centre path (all at tip Z4).
function distToGroovePath(x: number, y: number): number {
  let best = Infinity
  for (let i = 3; i <= 6; i++) {
    const a = GROOVE[i - 1], b = GROOVE[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)))
  }
  return best
}

describe('WO-1964: an O-ring groove cut with a lollipop from outside the block', () => {
  it('holderClearance: the neck and shank stay in air all the way round', () => {
    expect(toolNeckBand(LOLLIPOP), 'the tool has a neck to check').toBeDefined()
    const block = createStockState({ minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 12 }, 0.1)
    const report = checkHolderAndShankClearance({ stock: block, moves: GROOVE, tool: LOLLIPOP })
    expect(report.shankStatus).toBe('checked')
    expect(report.collisions, 'no neck or shank collision').toEqual([])
  })

  it('3D (voxel) view: only the groove is removed; the block above and below it is intact', () => {
    grid = BLOCK
    seed([LOLLIPOP], [{ id: 'op-groove', tool: LOLLIPOP, moves: GROOVE }], 'op-groove', 'voxel')
    const f = voxelCarvedToEnd()
    const { nx, ny, nz } = f.dims
    let groove = 0, grooveLeft = 0, far = 0, wronglyRemoved = 0, above = 0, below = 0
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const c = f.voxelCenterWorld(ix, iy, iz)
          const v = f.get(ix, iy, iz)
          // Distance from the swept head's centre line (Z7 along the path).
          const r = Math.hypot(distToGroovePath(c.x, c.y), c.z - HEAD_CZ)
          if (r < HEAD_R - 0.3) {
            groove++
            if (!(v < 0)) grooveLeft++
          } else if (r > HEAD_R + 0.3) {
            far++
            if (v <= 0) wronglyRemoved++
          }
          if (v <= 0 && c.z > HEAD_CZ + HEAD_R + 0.3) above++
          if (v <= 0 && c.z < GROOVE_TIP_Z - 0.3) below++
        }
      }
    }
    expect(groove, 'groove voxels in the scenario').toBeGreaterThan(3000)
    expect(grooveLeft, 'groove voxels left standing').toBe(0)
    expect(far, 'voxels out of the head reach').toBeGreaterThan(200_000)
    expect(wronglyRemoved, 'voxels removed that the head never reaches').toBe(0)
    expect(above, 'voxels removed above the groove').toBe(0)
    expect(below, 'voxels removed below the groove').toBe(0)
  })

  it('2.5D (heightmap) view: the top surface is untouched all the way round', () => {
    grid = BLOCK
    seed([LOLLIPOP], [{ id: 'op-groove', tool: LOLLIPOP, moves: GROOVE }], 'op-groove', 'heightmap')
    const field = carvedToEnd()
    // Not vacuous: the old carve (head width up to the top) cut the top edge away.
    const old = witness([{ tool: LOLLIPOP, moves: GROOVE, bounded: false }], BLOCK)
    let oldCut = 0
    for (let i = 0; i < old.length; i++) if (old[i] < BLOCK.stockTop) oldCut++
    expect(oldCut, 'top cells the old carve cut round the perimeter').toBeGreaterThan(500)

    let lowered = 0
    for (let i = 0; i < field.length; i++) if (field[i] !== BLOCK.stockTop) lowered++
    expect(field.length).toBe(BLOCK.nx * BLOCK.ny)
    expect(lowered, 'top cells lowered by a groove cut from the side').toBe(0)
  })
})
