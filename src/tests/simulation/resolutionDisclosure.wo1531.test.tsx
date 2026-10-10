// @vitest-environment jsdom
//
// WO-1531 / BUG-431: the stock-sim init effect resolves two facts about what
// actually ran -- voxel-budget coarsening and the voxel-unavailable heightmap
// fallback -- and used to disclose neither anywhere but console.warn. This
// proves both facts now land on the app console (COHESION-STANDARD rule 13:
// no new panel badge/banner), exactly once each, and that a run needing
// neither logs no false-positive event.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { vi } from 'vitest'
import type { Setup } from '../../types'

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

function makeMockVp(opts: { supportsVoxel: boolean; nx: number; ny: number; cellSize: number; stockTop: number; stockBot: number }) {
  return {
    setToolMarkerPosition: vi.fn(),
    showToolMarker: vi.fn(),
    updateToolGeometry: vi.fn(),
    disposeStockSim: vi.fn(),
    disposeVoxelSim: vi.fn(),
    setStockSimVisible: vi.fn(),
    setStockSimOpacity: vi.fn(),
    initStockSim: vi.fn(() => ({
      x0: 0, y0: 0, nx: opts.nx, ny: opts.ny, cellSize: opts.cellSize,
      stockTop: opts.stockTop, stockBot: opts.stockBot,
    })),
    updateStockSimHeights: vi.fn(),
    initVoxelSim: vi.fn(),
    syncVoxelSim: vi.fn(),
    supportsVoxelSim: vi.fn(() => opts.supportsVoxel),
    setSimulationToolpathPreview: vi.fn(),
  }
}

// A large-in-real-mm stock (200 x 200 x 50) so a 0.5mm request blows the
// simulator's fixed 8,000,000-voxel budget ((200/0.5)^2 * (50/0.5) = 16M)
// and forces the same coarsening BUG-431 observed on main.
const LARGE_BOUNDS = { nx: 200, ny: 200, cellSize: 1, stockTop: 50, stockBot: 0 }
// A small stock/resolution pair that stays far under budget -- the
// no-false-positive control.
const SMALL_BOUNDS = { nx: 50, ny: 50, cellSize: 1, stockTop: 10, stockBot: 0 }

function seedSetup(resolution: number, simulationEngine: 'auto' | 'voxel' | 'heightmap'): void {
  const setup: Setup = {
    id: 'setup-wo1531',
    name: 'WO-1531 fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: 200, height: 200, depth: 50,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [makeOp({
      id: 'op-wo1531',
      toolId: 't-wo1531',
      toolpathMoves: [
        { type: 'feed', role: 'cut', x: 0, y: 0, z: 0, feed: 600 },
        { type: 'feed', role: 'cut', x: 10, y: 0, z: 0, feed: 600 },
      ],
    })],
    notes: '',
  }

  act(() => {
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        machine: { ...s.project.machine, rapidRate: 5000 },
        setups: [setup],
        activeSetupId: setup.id,
        activeOperationId: 'op-wo1531',
      },
      toolLibrary: [makeTool({ id: 't-wo1531', diameter: 6 })],
      viewer: {
        ...s.viewer,
        mode: 'simulation',
        stockSimEnabled: true,
        stockSimResolution: resolution,
      },
      appSettings: {
        ...s.appSettings,
        displayUnits: 'mm',
        simulationEngine,
      },
    }))
  })
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().clearConsoleEvents()
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-1531: the simulation panel discloses the effective resolution and engine on the console', () => {
  it('BUG-431: voxel-budget coarsening logs the effective (coarsened) voxel size on the console, once, and renders no badge', () => {
    const mockVp = makeMockVp({ supportsVoxel: true, ...LARGE_BOUNDS })
    Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
    seedSetup(0.5, 'voxel')

    const { container } = render(<SimulationPanel />)

    const events = useCamStore.getState().consoleEvents.filter(e => e.source === 'simulation')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('warning')
    // Requested 0.500mm; the coarsened size must be strictly larger and named
    // in the message, not merely a restatement of the requested size.
    expect(events[0].message).toMatch(/coarsened from 0\.500 mm to \d+\.\d+ mm/)
    expect(events[0].message).not.toContain('to 0.500 mm')

    expect(container.querySelector('[data-testid="sim-res-coarsened"]')).toBeNull()
    expect(container.textContent).not.toMatch(/coarsened/i)
  })

  it('names the heightmap engine as active on the console when the voxel engine is unavailable, once, and renders no badge', () => {
    const mockVp = makeMockVp({ supportsVoxel: false, ...SMALL_BOUNDS })
    Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
    seedSetup(1, 'auto')

    const { container } = render(<SimulationPanel />)

    const events = useCamStore.getState().consoleEvents.filter(e => e.source === 'simulation')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('warning')
    expect(events[0].message).toMatch(/heightmap/i)

    expect(container.querySelector('[data-testid="sim-res-engine-fallback"]')).toBeNull()
    expect(container.textContent).not.toMatch(/heightmap/i)
  })

  it('logs no coarsening or fallback event when the requested resolution needs neither (no false positive)', () => {
    const mockVp = makeMockVp({ supportsVoxel: true, ...SMALL_BOUNDS })
    Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
    seedSetup(1, 'voxel')

    const { container } = render(<SimulationPanel />)

    const events = useCamStore.getState().consoleEvents.filter(e => e.source === 'simulation')
    expect(events).toHaveLength(0)

    expect(container.querySelector('[data-testid="sim-res-coarsened"]')).toBeNull()
    expect(container.querySelector('[data-testid="sim-res-engine-fallback"]')).toBeNull()
  })
})
