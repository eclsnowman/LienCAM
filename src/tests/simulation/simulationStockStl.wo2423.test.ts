// @vitest-environment jsdom
import React from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { Setup } from '../../types'
import type { VoxelField } from '../../lib/simulation/voxel/VoxelField'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => mem.set(k, v),
  removeItem: (k: string) => mem.delete(k), clear: () => mem.clear(),
} })
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { ExportModal } = await import('../../components/modals/ExportModal')
const { openExportWindow } = await import('../../lib/exportCenter')
const { useCamStore } = await import('../../store')
const { makeOp, makeTool, makeWcs } = await import('../post/helpers')
const { stockStl } = await import('../../lib/simulation/stockStl')
const { HeightmapSimulator } = await import('../../lib/simulation/HeightmapSimulator')

const save = vi.fn(async (_filename: string, _bytes: string | Uint8Array) => 'saved.stl')
let heights: Float32Array | null
let field: VoxelField | null

function seed(engine: 'heightmap' | 'voxel', prior = false) {
  const pocket = makeOp({ id: 'pocket', toolId: 't1', toolpathMoves: [
    { type: 'feed', role: 'cut', x: -2, y: 0, z: -2, feed: 600 },
    { type: 'feed', role: 'cut', x: 2, y: 0, z: -2, feed: 600 },
  ] })
  const active = makeOp({ id: 'active', toolId: 't1', toolpathMoves: [
    { type: 'rapid', x: -2, y: 4, z: 2 }, { type: 'rapid', x: 2, y: 4, z: 2 },
  ] })
  const setup: Setup = { id: 'setup', name: 'STL pocket', wcs: makeWcs(), notes: '',
    stock: { type: 'rectangular', width: 12, height: 12, depth: 4, offsetX: 0, offsetY: 0,
      offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: prior ? [pocket, active] : [pocket],
  }
  act(() => useCamStore.setState(s => ({
    project: { ...s.project, setups: [setup], activeSetupId: setup.id, activeOperationId: prior ? 'active' : 'pocket' },
    toolLibrary: [makeTool({ diameter: 4 })],
    viewer: { ...s.viewer, mode: 'simulation', stockSimEnabled: true, stockSimResolution: 1 },
    appSettings: { ...s.appSettings, simulationEngine: engine },
  })))
}

async function exported() {
  save.mockClear()
  await act(async () => { openExportWindow('simulation') })
  await act(async () => { fireEvent.click(screen.getByTestId('export-save-simulation')) })
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.lastCall![0]).toBe('simulation-stock.stl')
  const bytes = save.mock.lastCall![1] as Uint8Array
  return new STLLoader().parse(bytes.slice().buffer)
}

function checkClosed(geometry: ReturnType<STLLoader['parse']>) {
  const positions = geometry.getAttribute('position')
  const edges = new Map<string, { count: number; orientation: number }>()
  let volume = 0
  for (let i = 0; i < positions.count; i += 3) {
    const p = [0,1,2].map(j => [positions.getX(i+j), positions.getY(i+j), positions.getZ(i+j)])
    const keys = p.map(v => v.join(','))
    expect(new Set(keys).size).toBe(3)
    for (let j = 0; j < 3; j++) {
      const a = keys[j], b = keys[(j+1)%3], key = [a,b].sort().join('|')
      const entry = edges.get(key) ?? { count: 0, orientation: 0 }
      entry.count++; entry.orientation += a < b ? 1 : -1; edges.set(key, entry)
    }
    volume += (p[0][0]*(p[1][1]*p[2][2]-p[1][2]*p[2][1]) + p[0][1]*(p[1][2]*p[2][0]-p[1][0]*p[2][2]) + p[0][2]*(p[1][0]*p[2][1]-p[1][1]*p[2][0]))/6
  }
  expect(positions.count).toBeGreaterThan(0)
  expect([...edges.values()].every(e => e.count === 2 && e.orientation === 0)).toBe(true)
  expect(volume).toBeGreaterThan(0)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  for (const [actual, expected] of [[box.min.x,-6], [box.min.y,-6], [box.min.z,-4], [box.max.x,6], [box.max.y,6], [box.max.z,0]]) {
    expect(Math.abs(actual-expected)).toBeLessThanOrEqual(1)
  }
  return volume
}

function pocketDepth(geometry: ReturnType<STLLoader['parse']>) {
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal')
  const floor: number[] = []
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i)) < 1 && Math.abs(p.getY(i)) < 1 && n.getZ(i) > 0.9) floor.push(p.getZ(i))
  }
  expect(floor.length).toBeGreaterThan(0)
  return Math.max(...floor)
}

beforeEach(() => {
  heights = null; field = null; save.mockClear()
  act(() => useCamStore.getState().newProject())
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('liencamHost', { saveFile: save })
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: {
    initStockSim: () => ({ x0: -6, y0: -6, nx: 12, ny: 12, cellSize: 1, stockTop: 0, stockBot: -4 }),
    updateStockSimHeights: (h: Float32Array) => { heights = h },
    initVoxelSim: (f: VoxelField) => { field = f }, syncVoxelSim: (f: VoxelField) => { field = f },
    supportsVoxelSim: () => true,
  } })
})
afterEach(() => { cleanup(); Reflect.deleteProperty(window, '__cncViewport'); vi.unstubAllGlobals() })

describe('WO-2423 cut stock STL via the production simulation panel', () => {
  it.each(['heightmap', 'voxel'] as const)('exports a closed %s pocket with live cut depth and rewound stock', async engine => {
    seed(engine); render(React.createElement(SimulationPanel)); render(React.createElement(ExportModal))
    const scrubber = document.querySelector('.sim-scrubber')!
    fireEvent.change(scrubber, { target: { value: '400' } })
    const cut = await exported()
    checkClosed(cut)
    expect(Math.abs(pocketDepth(cut) - -2)).toBeLessThan(0.01)
    if (heights) expect(heights[6*12+6]).toBe(-2)
    if (field) {
      expect(field.get(6,6,2)).toBeLessThan(0)
      expect(field.get(6,6,1)).toBeGreaterThan(0)
    }
    fireEvent.change(scrubber, { target: { value: '0' } })
    const rewound = await exported(); checkClosed(rewound)
    expect(Math.abs(pocketDepth(rewound))).toBeLessThan(0.01)
  })
  it.each(['heightmap', 'voxel'] as const)('includes the %s rest-machining baseline before active playback', async engine => {
    seed(engine, true); render(React.createElement(SimulationPanel)); render(React.createElement(ExportModal))
    const baseline = await exported(); checkClosed(baseline)
    expect(Math.abs(pocketDepth(baseline) - -2)).toBeLessThan(0.01)
  })
  it('offers export only while there is simulated stock to export', () => {
    seed('heightmap'); render(React.createElement(SimulationPanel))
    fireEvent.click(screen.getByLabelText('Simulate Stock Removal'))
    render(React.createElement(ExportModal))
    act(() => { openExportWindow() })
    expect(screen.queryByTestId('export-row-simulation')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
  it('exports fully removed heightmap stock as an empty STL', () => {
    const sim = new HeightmapSimulator(-6,-6,12,12,0,-4,1)
    sim.heights.fill(-4)
    expect(new STLLoader().parse(stockStl(sim)).getAttribute('position').count).toBe(0)
  })
  it('keeps heightmap stock thinner than one cell', () => {
    const sim = new HeightmapSimulator(-6,-6,12,12,0,-0.2,1)
    const geometry = new STLLoader().parse(stockStl(sim))
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0)
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.min.z).toBeCloseTo(-0.2, 3)
    expect(geometry.boundingBox!.max.z).toBeCloseTo(0, 3)
  })
  it.each(['heightmap', 'voxel'] as const)('exports only the elapsed %s cut during a partial frame', async engine => {
    seed(engine); render(React.createElement(SimulationPanel)); render(React.createElement(ExportModal))
    const scrubber = document.querySelector('.sim-scrubber')!
    fireEvent.change(scrubber, { target: { value: '100' } })
    const partialVolume = checkClosed(await exported())
    fireEvent.change(scrubber, { target: { value: '400' } })
    const finalVolume = checkClosed(await exported())
    expect(partialVolume).toBeGreaterThan(finalVolume + 2)
  })
})
