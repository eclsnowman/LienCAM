// @vitest-environment jsdom
//
// WO-1537 / BUG-515: opening Simulate on an operation whose real tool is a
// non-default cutter + holder used to show a plausible-looking DEFAULT marker
// (the viewport's own fallback assembly) until the first seek, because the
// frame-rebuild effect that resolves the initial timeline never pushed its
// cfg to the marker -- only seekTo did. Fixed on main by WO-1403's
// `applyToolCfg(timeline[0]?.cfg ?? null)` call in that same effect
// (SimulationPanel.tsx ~701). This test proves the INITIAL-ENTRY case: the
// marker must show the real assembly on the very first render, with no
// seek/play/rewind interaction anywhere in the test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
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

// The real (non-default) assembly BUG-515 was verified against: a 6.35mm
// cutter with a 12.7mm flute, 50.8mm overall length and a holder. Distinct
// from the viewport's own DEFAULT marker fallback (flat_end_mill, diameter 6,
// fluteLength 20, overallLength 50, no holder -- CNCViewport.ts ~4104), so a
// stale-default marker and the real one can never be confused for each other.
function seedRealToolSetup(): void {
  const setup: Setup = {
    id: 'setup-wo1537',
    name: 'WO-1537 fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: 50, height: 50, depth: 10,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [makeOp({
      id: 'op-wo1537',
      toolId: 't-wo1537',
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
        activeOperationId: 'op-wo1537',
      },
      toolLibrary: [makeTool({
        id: 't-wo1537',
        diameter: 6.35,
        fluteLength: 12.7,
        overallLength: 50.8,
        holderId: 'h-wo1537',
      })],
      holders: [{
        id: 'h-wo1537',
        name: 'WO-1537 Holder',
        segments: [{ height: 30, lowerDiameter: 25, upperDiameter: 25 }],
      }],
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

describe('WO-1537: initial simulation marker shows the real tool, not the viewport default', () => {
  it('BUG-515: entering Simulate resolves the real assembly on the very first render, before any seek', () => {
    seedRealToolSetup()
    render(<SimulationPanel />)

    // No seek/play/rewind interaction happened above -- render() alone must
    // have pushed the real assembly to the marker.
    expect(mockVp.updateToolGeometry).toHaveBeenCalledWith(
      expect.objectContaining({
        diameter: 6.35,
        fluteLength: 12.7,
        overallLength: 50.8,
        holderSegments: [expect.objectContaining({ height: 30, lowerDiameter: 25, upperDiameter: 25 })],
      }),
    )
    // Never the viewport's own default fallback shape.
    expect(mockVp.updateToolGeometry).not.toHaveBeenCalledWith(
      expect.objectContaining({ diameter: 6, fluteLength: 20, overallLength: 50 }),
    )
  })
})
