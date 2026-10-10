// @vitest-environment jsdom
//
// WO-1403: the simulation panel's rebuild effect owns "what the viewport
// currently shows for the simulated assembly" and used to be incomplete on
// both ends of that job:
//   - BUG-517: it read state.toolLibrary/state.holders via getState() inside
//     the effect body instead of subscribing, so editing a tool's own
//     dimensions while paused never re-fired the rebuild.
//   - BUG-523: clear() (the empty/invalidated-context exit path) never called
//     the viewport disposal its OTHER exit paths already make, so an empty
//     setup left a prior stock-removal mesh / tool marker on screen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
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

const { SimulationPanel, formatMoveReadout, formatPositionReadout } =
  await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeTool, makeWcs } = await import('../post/helpers')

const mockVp = {
  setToolMarkerPosition: vi.fn(),
  showToolMarker: vi.fn(),
  updateToolGeometry: vi.fn(),
  disposeStockSim: vi.fn(),
  disposeVoxelSim: vi.fn(),
  setStockSimVisible: vi.fn(),
  setStockSimOpacity: vi.fn(),
  initStockSim: vi.fn(() => ({ x0: 0, y0: 0, nx: 10, ny: 10, cellSize: 1, stockTop: 10, stockBot: 0 })),
  updateStockSimHeights: vi.fn(),
  supportsVoxelSim: vi.fn(() => false),
  setSimulationToolpathPreview: vi.fn(),
}

function seedValidSetup(): void {
  const setup: Setup = {
    id: 'setup-wo1403',
    name: 'WO-1403 fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: 50, height: 50, depth: 10,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [makeOp({
      id: 'op-wo1403',
      toolId: 't-wo1403',
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
        activeOperationId: 'op-wo1403',
      },
      toolLibrary: [makeTool({
        id: 't-wo1403',
        fluteLength: 25,
        shoulderLength: 20,
        lengthBelowHolder: 15,
        overallLength: 60,
      })],
      holders: [],
      viewer: {
        ...s.viewer,
        mode: 'simulation',
        stockSimEnabled: true,
        stockSimResolution: 1,
      },
      appSettings: {
        ...s.appSettings,
        displayUnits: 'mm',
        simulationEngine: 'heightmap',
      },
    }))
  })
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

describe('WO-1403: simulation panel rebuild-context invalidation', () => {
  it('BUG-517: a tool dimension edit while paused reaches the marker without any seek', () => {
    seedValidSetup()
    render(<SimulationPanel />)

    // Initial mount already resolved tool T's assembly onto the marker.
    expect(mockVp.updateToolGeometry).toHaveBeenLastCalledWith(
      expect.objectContaining({ fluteLength: 25, shoulderLength: 20, lengthBelowHolder: 15 }),
    )
    mockVp.updateToolGeometry.mockClear()

    // Edit flute length, shoulder length and length-below-holder on tool T
    // while paused -- no play/seek/scrub interaction anywhere in this test.
    // A direct toolLibrary write (not the updateTool() action) isolates the
    // rebuild-effect subscription under test from the UNRELATED generation-
    // freshness reconcile that updateTool() also runs (BUG-506): that reconcile
    // downgrades ANY 'ready' op referencing an edited tool to 'outdated' and
    // wipes its toolpathMoves on every field edit, which would make this
    // fixture's operation empty regardless of BUG-517 and defeat the test.
    act(() => {
      useCamStore.setState(s => ({
        toolLibrary: s.toolLibrary.map(t => t.id === 't-wo1403'
          ? { ...t, fluteLength: 40, shoulderLength: 32, lengthBelowHolder: 22 }
          : t),
      }))
    })

    expect(mockVp.updateToolGeometry).toHaveBeenCalledWith(
      expect.objectContaining({ fluteLength: 40, shoulderLength: 32, lengthBelowHolder: 22 }),
    )
  })

  it('BUG-517: a holder segment edit while paused also reaches the marker without any seek', () => {
    seedValidSetup()
    act(() => {
      useCamStore.setState(s => ({
        holders: [{ id: 'h-wo1403', name: 'Test Holder', segments: [{ height: 10, lowerDiameter: 20, upperDiameter: 20 }] }],
        toolLibrary: s.toolLibrary.map(t => t.id === 't-wo1403' ? { ...t, holderId: 'h-wo1403' } : t),
      }))
    })
    render(<SimulationPanel />)
    mockVp.updateToolGeometry.mockClear()

    act(() => {
      useCamStore.getState().updateHolder('h-wo1403', {
        segments: [{ height: 30, lowerDiameter: 20, upperDiameter: 20 }],
      })
    })

    expect(mockVp.updateToolGeometry).toHaveBeenCalledWith(
      expect.objectContaining({
        holderSegments: [expect.objectContaining({ height: 30 })],
      }),
    )
  })

  it('BUG-523: selecting an empty setup retires the prior stock-removal mesh and tool marker', () => {
    seedValidSetup()
    render(<SimulationPanel />)

    // A live rebuild must have happened first (sanity: the marker was placed).
    expect(mockVp.setToolMarkerPosition).toHaveBeenCalled()
    mockVp.disposeStockSim.mockClear()
    mockVp.disposeVoxelSim.mockClear()
    mockVp.showToolMarker.mockClear()

    act(() => {
      useCamStore.setState(s => ({
        project: { ...s.project, setups: [], activeSetupId: null, activeOperationId: null },
      }))
    })

    expect(mockVp.disposeStockSim).toHaveBeenCalled()
    expect(mockVp.disposeVoxelSim).toHaveBeenCalled()
    expect(mockVp.showToolMarker).toHaveBeenCalledWith(false)

    expect(document.querySelector('.sim-move-readout')?.textContent)
      .toBe(formatMoveReadout(null, 'mm'))
    expect(screen.getByTestId('sim-position-readout').textContent)
      .toBe(formatPositionReadout(null, 'mm'))
  })

  it('returning to a valid setup after an empty one rebuilds cleanly with no stale graphics', () => {
    seedValidSetup()
    render(<SimulationPanel />)

    act(() => {
      useCamStore.setState(s => ({
        project: { ...s.project, setups: [], activeSetupId: null, activeOperationId: null },
      }))
    })
    mockVp.setToolMarkerPosition.mockClear()
    mockVp.updateToolGeometry.mockClear()

    seedValidSetup()

    expect(mockVp.setToolMarkerPosition).toHaveBeenCalled()
    expect(mockVp.updateToolGeometry).toHaveBeenLastCalledWith(
      expect.objectContaining({ fluteLength: 25 }),
    )
    // The empty setup hid the marker; the rebuild must show it again (audit round 2).
    expect(mockVp.showToolMarker.mock.calls.at(-1)).toEqual([true])
    const scrubber = document.querySelector('.sim-scrubber') as HTMLInputElement | null
    expect(scrubber).not.toBeNull()
    expect(scrubber!.max).not.toBe('0')
  })
})
