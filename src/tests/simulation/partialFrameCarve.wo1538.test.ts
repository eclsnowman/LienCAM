// @vitest-environment jsdom
//
// WO-1538 (BUG-521, BUG-522): the simulation carved the WHOLE active move the
// instant playback entered it - material vanished before the marker reached it,
// and a backward seek within the move kept the premature result. During a
// scrubber drag the stock silently lagged the marker with nothing saying so.
//
// Drives the real SimulationPanel (production seek path through the scrubber)
// on both engines and checks the carved field against an independent witness
// simulator that sweeps ONLY the elapsed prefix of the active move.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Setup, Tool, ToolpathMove } from '../../types'
import { HeightmapSimulator } from '../../lib/simulation/HeightmapSimulator'
import { VoxelSimulator, type VoxelSimTool } from '../../lib/simulation/VoxelSimulator'
import type { VoxelField } from '../../lib/simulation/voxel/VoxelField'
import { buildToolProfile, tipOffsetAtRadius } from '../../lib/tool/toolProfile'

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

// Stock: 40 x 20 mm, top Z12, bottom Z0, 1 mm cells (both engines share it).
const STOCK = { x0: 0, y0: 0, nx: 40, ny: 20, cellSize: 1, stockTop: 12, stockBot: 0 }

// Timeline (world == work, WCS at the origin):
//   frame 0  rapid  (5,10,30) -> (5,10,20)   10 mm @ 5000  =  120 ms   [0, 120)
//   frame 1  plunge (5,10,20) -> (5,10,11)    9 mm @  450  = 1200 ms   [120, 1320)
//   frame 2  cut    (5,10,11) -> (35,10,11)  30 mm @  600  = 3000 ms   [1320, 4320]
const MOVES: ToolpathMove[] = [
  { type: 'rapid', role: 'rapid', x: 5, y: 10, z: 30 },
  { type: 'rapid', role: 'rapid', x: 5, y: 10, z: 20 },
  { type: 'feed', role: 'plunge', x: 5, y: 10, z: 11, feed: 450 },
  { type: 'feed', role: 'cut', x: 35, y: 10, z: 11, feed: 600 },
]
const FRAME_STARTS = [0, 120, 1320]
const FRAME_DURATIONS = [120, 1200, 3000]
const TOOL: Tool = makeTool({ id: 't-wo1538', diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 60 })

const mockVp = {
  setToolMarkerPosition: vi.fn(),
  showToolMarker: vi.fn(),
  updateToolGeometry: vi.fn(),
  disposeStockSim: vi.fn(),
  disposeVoxelSim: vi.fn(),
  setStockSimVisible: vi.fn(),
  setStockSimOpacity: vi.fn(),
  initStockSim: vi.fn(() => ({ ...STOCK })),
  updateStockSimHeights: vi.fn<(h: Float32Array) => void>(),
  initVoxelSim: vi.fn(),
  syncVoxelSim: vi.fn<(f: VoxelField) => void>(),
  supportsVoxelSim: vi.fn(() => false),
  setSimulationToolpathPreview: vi.fn(),
}

type Engine = 'heightmap' | 'voxel'

function seed(engine: Engine): void {
  const setup: Setup = {
    id: 'setup-wo1538',
    name: 'WO-1538 plunge fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: 40, height: 20, depth: 12,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [makeOp({ id: 'op-wo1538', toolId: TOOL.id, toolpathMoves: MOVES })],
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
        activeOperationId: 'op-wo1538',
      },
      toolLibrary: [TOOL],
      holders: [],
      viewer: { ...s.viewer, mode: 'simulation', stockSimEnabled: true, stockSimResolution: 1 },
      appSettings: { ...s.appSettings, displayUnits: 'mm', simulationEngine: engine },
    }))
  })
}

// ── The live field the panel is showing ──────────────────────────────────────
function liveField(engine: Engine): Float32Array {
  if (engine === 'heightmap') {
    const calls = mockVp.updateStockSimHeights.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    return calls[calls.length - 1][0]
  }
  const calls = mockVp.syncVoxelSim.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0].data
}

// ── Independent swept-prefix witness ─────────────────────────────────────────
// Carves frames strictly before `ms` in full and the active frame only up to
// its elapsed fraction - the physical stock at the marker's time.
function prefixSegments(ms: number): Array<[{ x: number; y: number; z: number }, { x: number; y: number; z: number }]> {
  const segs: Array<[{ x: number; y: number; z: number }, { x: number; y: number; z: number }]> = []
  for (let fi = 0; fi < FRAME_STARTS.length; fi++) {
    const from = MOVES[fi], to = MOVES[fi + 1]
    if (to.type === 'rapid') continue
    const t = Math.max(0, Math.min(1, (ms - FRAME_STARTS[fi]) / FRAME_DURATIONS[fi]))
    if (t <= 0) continue
    segs.push([
      { x: from.x, y: from.y, z: from.z },
      { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y), z: from.z + t * (to.z - from.z) },
    ])
  }
  return segs
}

function witness(engine: Engine, ms: number): Float32Array {
  if (engine === 'heightmap') {
    const sim = new HeightmapSimulator(
      STOCK.x0, STOCK.y0, STOCK.nx * STOCK.cellSize, STOCK.ny * STOCK.cellSize,
      STOCK.stockTop, STOCK.stockBot, STOCK.cellSize,
    )
    const profile = buildToolProfile(TOOL)
    for (const [a, b] of prefixSegments(ms)) {
      sim.sweepMoveWithProfile(a.x, a.y, a.z, b.x, b.y, b.z, TOOL.diameter / 2, d => tipOffsetAtRadius(profile, d))
    }
    return sim.snapshot()
  }
  const voxelTool: VoxelSimTool = {
    type: TOOL.type, diameter: TOOL.diameter, cornerRadius: 0, angleFromAxisDeg: 59,
    fluteLength: TOOL.fluteLength, shankDiameter: TOOL.shankDiameter, overallLength: TOOL.overallLength,
    shoulderLength: TOOL.fluteLength,
  }
  const sim = new VoxelSimulator(
    { x0: STOCK.x0, y0: STOCK.y0, z0: STOCK.stockBot, x1: STOCK.nx, y1: STOCK.ny, z1: STOCK.stockTop },
    1, 8_000_000,
  )
  for (const [a, b] of prefixSegments(ms)) sim.sweepMove(a, b, voxelTool)
  return sim.snapshot()
}

function countDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length)
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

// Top-of-stock sample under the plunge axis (5,10): heightmap = the column's top
// Z; voxel = the solid/air sign of the cell centred at Z11.5, which the FULL
// plunge (to Z11) removes and a plunge still above Z12 must not.
function plungeAxisSample(engine: Engine, field: Float32Array): number {
  if (engine === 'heightmap') return field[10 * STOCK.nx + 5]
  const ix = 5, iy = 10, iz = 11
  return field[iz * STOCK.nx * STOCK.ny + iy * STOCK.nx + ix]
}
function heightAt(field: Float32Array, x: number): number {
  return field[10 * STOCK.nx + Math.floor(x)]
}

const scrubber = () => document.querySelector('input.sim-scrubber') as HTMLInputElement
const panel = () => document.querySelector('.sim-panel') as HTMLElement
function seek(ms: number): void {
  act(() => { fireEvent.change(scrubber(), { target: { value: String(ms) } }) })
}

const EVIDENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'evidence', 'WO-1538')
function writeSectionSvg(name: string, field: Float32Array, tipZ: number, caption: string): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const s = 16, w = STOCK.nx * s, h = 16 * s
  const y = (z: number) => h - z * s
  const cells: string[] = []
  for (let ix = 0; ix < STOCK.nx; ix++) {
    const top = field[10 * STOCK.nx + ix]
    cells.push(`<rect x="${ix * s}" y="${y(top)}" width="${s}" height="${top * s}" fill="#9aa7b4" stroke="#56616c" stroke-width="0.5"/>`)
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + 40}" viewBox="0 0 ${w} ${h + 40}">`,
    `<rect width="100%" height="100%" fill="#1d2126"/>`,
    ...cells,
    `<line x1="0" x2="${w}" y1="${y(STOCK.stockTop)}" y2="${y(STOCK.stockTop)}" stroke="#e0c050" stroke-dasharray="4 3"/>`,
    `<rect x="${2 * s}" y="${y(tipZ + 4)}" width="${6 * s}" height="${4 * s}" fill="none" stroke="#ff5a4e" stroke-width="2"/>`,
    `<line x1="${2 * s}" x2="${8 * s}" y1="${y(tipZ)}" y2="${y(tipZ)}" stroke="#ff5a4e" stroke-width="3"/>`,
    `<text x="8" y="${h + 16}" fill="#e8e8e8" font-family="monospace" font-size="13">${caption}</text>`,
    `<text x="8" y="${h + 33}" fill="#9aa" font-family="monospace" font-size="11">section Y10, 1 mm cells; red = cutter at marker (tip Z${tipZ.toFixed(3)}); dashed = stock top Z12</text>`,
    `</svg>`,
  ].join('\n')
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), svg)
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  Object.values(mockVp).forEach(fn => fn.mockClear())
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe.each<Engine>(['heightmap', 'voxel'])('WO-1538 (%s): the stock is carved by elapsed fraction of the active move', (engine) => {
  it('BUG-521: a seek partway into a plunge removes only what the elapsed prefix reaches, forward and backward', () => {
    seed(engine)
    render(createElement(SimulationPanel))
    const baseline = witness(engine, 0).slice()

    // The full plunge DOES remove the witness sample (test is not vacuous).
    const fullPlunge = witness(engine, 1320)
    if (engine === 'heightmap') expect(plungeAxisSample(engine, fullPlunge)).toBeCloseTo(11, 5)
    else expect(plungeAxisSample(engine, fullPlunge)).toBeLessThan(0)

    // 600 ms into the 1200 ms plunge: tip at Z15.5, still above the Z12 stock.
    seek(720)
    let field = liveField(engine)
    // Picture first, so a before-fix run still records what it showed.
    if (engine === 'heightmap') writeSectionSvg(`stock-at-plunge-midpoint-${process.env.WO1538_LABEL ?? 'after'}.svg`, field, 15.5,
      `WO-1538 ${process.env.WO1538_LABEL ?? 'after'}: seek 00:00.720, 50% into plunge Z20 -> Z11, tip Z15.500`)
    if (engine === 'heightmap') expect(plungeAxisSample(engine, field)).toBe(12)
    else expect(plungeAxisSample(engine, field)).toBeGreaterThan(0)
    expect(countDiff(field, witness(engine, 720)), 'seek 720 vs swept-prefix witness').toBe(0)
    expect(countDiff(field, baseline), 'plunge above the stock removes nothing').toBe(0)

    // Deeper, still short of the endpoint: tip at Z11.5025 - removes to the tip, not to Z11.
    seek(1253)
    field = liveField(engine)
    if (engine === 'heightmap') expect(plungeAxisSample(engine, field)).toBeCloseTo(20 - 9 * (1133 / 1200), 4)
    expect(countDiff(field, witness(engine, 1253)), 'seek 1253 vs witness').toBe(0)

    // Backward within the same active frame: never the premature (or deeper) result.
    seek(720)
    field = liveField(engine)
    expect(countDiff(field, witness(engine, 720)), 'backward seek 720 vs witness').toBe(0)

    // Half-way along the lateral cut, then back into the rapid before the plunge.
    seek(2820)
    field = liveField(engine)
    expect(countDiff(field, witness(engine, 2820)), 'seek 2820 vs witness').toBe(0)
    if (engine === 'heightmap') {
      expect(heightAt(field, 15)).toBeCloseTo(11, 5)  // behind the cutter: cut
      expect(heightAt(field, 30)).toBe(12)            // ahead of the cutter: untouched
    }
    seek(99)
    field = liveField(engine)
    expect(countDiff(field, baseline), 'backward seek 99 is the untouched stock').toBe(0)

    // Forward to the end still carves every move to its endpoint.
    seek(4320)
    expect(countDiff(liveField(engine), witness(engine, 4320)), 'seek to end vs witness').toBe(0)
    expect(panel().getAttribute('data-stock-sync')).toBe('exact')
  })

  it('BUG-522: a drag preview that lags the marker says so; release settles to the exact partial result', () => {
    seed(engine)
    render(createElement(SimulationPanel))
    const baseline = witness(engine, 0).slice()
    expect(panel().getAttribute('data-stock-sync')).toBe('exact')

    act(() => { fireEvent.pointerDown(scrubber()) })
    seek(2820)
    let field = liveField(engine)
    // Fast keyframe preview kept: nothing carved forward during the drag ...
    expect(countDiff(field, baseline)).toBe(0)
    // ... and the panel says the shown stock is a preview lagging the marker.
    expect(panel().getAttribute('data-stock-sync')).toBe('preview')
    expect(Number(panel().getAttribute('data-stock-ms'))).toBeLessThan(2820)
    const progress = document.querySelector('.sim-carve-progress') as HTMLElement
    expect(progress.style.display).toBe('flex')
    expect(progress.textContent).toContain('Stock preview')

    act(() => { fireEvent.pointerUp(scrubber()) })
    field = liveField(engine)
    expect(panel().getAttribute('data-stock-sync')).toBe('exact')
    expect(panel().getAttribute('data-stock-ms')).toBe('2820')
    expect(progress.style.display).toBe('none')
    expect(countDiff(field, witness(engine, 2820)), 'released at 2820 vs witness').toBe(0)
  })
})
