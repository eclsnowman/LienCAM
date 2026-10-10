// @vitest-environment jsdom
//
// WO-1533 / BUG-433: switching the active stock-sim engine or resolution on a
// nested/multi-operation project re-carved the ENTIRE rest-machining baseline
// (every prior op's moves) on the main thread with no yield, freezing the page
// for seconds to tens of seconds. This proves the init effect now chunks that
// pre-carve across macrotasks -- the same CARVE_SYNC_MAX / CARVE_CHUNK_BUDGET_MS
// split seekCarve already uses for a large scrub -- instead of always blocking
// to completion in one synchronous call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import React from 'react'
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
const { makeOp, makeTool, makeWcs, move } = await import('../post/helpers')

// A small, un-coarsened voxel field (matches SMALL_BOUNDS in
// resolutionDisclosure.wo1531.test.tsx) so the pre-carve baseline is cheap
// enough for a fixture to build quickly but the effect still has to sweep
// every prior-op move to produce it.
const BOUNDS = { nx: 50, ny: 50, cellSize: 1, stockTop: 10, stockBot: 0 }

function makeMockVp() {
  return {
    setToolMarkerPosition: vi.fn(),
    showToolMarker: vi.fn(),
    updateToolGeometry: vi.fn(),
    disposeStockSim: vi.fn(),
    disposeVoxelSim: vi.fn(),
    setStockSimVisible: vi.fn(),
    setStockSimOpacity: vi.fn(),
    initStockSim: vi.fn(() => ({
      x0: 0, y0: 0, nx: BOUNDS.nx, ny: BOUNDS.ny, cellSize: BOUNDS.cellSize,
      stockTop: BOUNDS.stockTop, stockBot: BOUNDS.stockBot,
    })),
    updateStockSimHeights: vi.fn(),
    initVoxelSim: vi.fn(),
    syncVoxelSim: vi.fn(),
    supportsVoxelSim: vi.fn(() => true),
    setSimulationToolpathPreview: vi.fn(),
  }
}

/** A prior op with `count` cutting segments (a rest-machining baseline), plus a
 *  trivial active op after it -- prevSectionsFor() carves the FIRST op's moves
 *  as the baseline before the SECOND (active) op's frames start playing. */
function seedSetup(count: number): void {
  const prevMoves = [move({ x: 5, y: 25, z: 5 })]
  for (let i = 1; i <= count; i++) {
    prevMoves.push(move({ x: 5 + i * 0.2, y: 25, z: 5, feed: 600 }))
  }

  const setup: Setup = {
    id: 'setup-wo1533',
    name: 'WO-1533 fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: 50, height: 50, depth: 10,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [
      makeOp({ id: 'op-prev', name: 'Rest-machining source', toolId: 't-wo1533', toolpathMoves: prevMoves }),
      makeOp({
        id: 'op-active', name: 'Active', toolId: 't-wo1533',
        toolpathMoves: [move({ x: 5, y: 25, z: 5 }), move({ x: 6, y: 25, z: 5, feed: 600 })],
      }),
    ],
    notes: '',
  }

  act(() => {
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        machine: { ...s.project.machine, rapidRate: 5000 },
        setups: [setup],
        activeSetupId: setup.id,
        activeOperationId: 'op-active',
      },
      toolLibrary: [makeTool({ id: 't-wo1533', diameter: 6 })],
      viewer: {
        ...s.viewer,
        mode: 'simulation',
        stockSimEnabled: true,
        stockSimResolution: 1,
      },
      appSettings: {
        ...s.appSettings,
        displayUnits: 'mm',
        simulationEngine: 'voxel',
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
  vi.restoreAllMocks()
})

// Drains real setTimeout(fn, 0) chunks until the given mock has fired (or the
// attempt budget runs out), wrapped in act() so ref-driven DOM updates inside
// the chunk loop don't warn.
async function drainUntilCalled(fn: { mock: { calls: unknown[][] } }, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks && fn.mock.calls.length === 0; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

describe('WO-1533: the stock-sim init effect chunks a large rest-machining pre-carve', () => {
  it('BUG-433: a large rest-machining baseline yields to the event loop before the bake completes, instead of blocking in one synchronous call', async () => {
    // Force the chunk loop's time budget to expire after a handful of ops
    // regardless of this machine's real speed, so the yield is deterministic.
    let calls = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (calls++) * 5)

    const mockVp = makeMockVp()
    Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
    seedSetup(400) // far above CARVE_SYNC_MAX (64)

    render(React.createElement(SimulationPanel))

    // On main (no chunking) this call has already fired by the time render()
    // returns -- the whole baseline was carved inline. The fix must NOT have
    // finished yet: it should still be mid-chunk-loop.
    expect(mockVp.initVoxelSim).not.toHaveBeenCalled()

    await drainUntilCalled(mockVp.initVoxelSim)

    expect(mockVp.initVoxelSim).toHaveBeenCalledTimes(1)
  })

  it('a small baseline still carves inline, synchronously -- existing behavior stays unchanged', () => {
    const mockVp = makeMockVp()
    Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
    seedSetup(10) // well under CARVE_SYNC_MAX (64) -- no performance.now mock needed

    render(React.createElement(SimulationPanel))

    expect(mockVp.initVoxelSim).toHaveBeenCalledTimes(1)
  })

  it('the final baseline field is identical no matter where the chunk boundaries fall (chunking changes only scheduling)', async () => {
    async function runOnce(tickMs: number): Promise<Float32Array> {
      let calls = 0
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => (calls++) * tickMs)

      const mockVp = makeMockVp()
      Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
      seedSetup(400)

      render(React.createElement(SimulationPanel))
      await drainUntilCalled(mockVp.initVoxelSim)

      expect(mockVp.initVoxelSim).toHaveBeenCalledTimes(1)
      const field = mockVp.initVoxelSim.mock.calls[0][0] as { data: Float32Array }
      const data = field.data.slice()

      cleanup()
      Reflect.deleteProperty(window, '__cncViewport')
      spy.mockRestore()
      return data
    }

    // tickMs=5: the 16ms chunk budget expires after ~3 ops -> many small
    // chunks. tickMs=0.001: the budget never expires within 400 ops -> the
    // whole pre-carve completes in ONE synchronous chunk (the old behavior).
    const chunked = await runOnce(5)
    const oneShot = await runOnce(0.001)

    expect(Array.from(chunked)).toEqual(Array.from(oneShot))
  })

  it('a Rewind click landing mid-bake does not corrupt the rest-machining baseline -- audit repro', async () => {
    async function runOnce(tickMs: number, clickRewindMidBake: boolean): Promise<Float32Array> {
      let calls = 0
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => (calls++) * tickMs)

      const mockVp = makeMockVp()
      Object.defineProperty(window, '__cncViewport', { configurable: true, value: mockVp })
      seedSetup(400) // far above CARVE_SYNC_MAX (64) -- forces the chunked path

      const { container } = render(React.createElement(SimulationPanel))

      if (clickRewindMidBake) {
        // The bake is still mid-chunk-loop here (proven by the first test above --
        // initVoxelSim has not fired yet). Before the fix, this click's seekTo
        // found voxelSimRef already published to the half-carved sim (no
        // baseline, no keyframe yet) and carved active-op frames into it.
        const rewindBtn = container.querySelector('[aria-label="Rewind to start"]') as HTMLButtonElement
        expect(rewindBtn).toBeTruthy()
        expect(rewindBtn.disabled).toBe(false)
        fireEvent.click(rewindBtn)
      }

      await drainUntilCalled(mockVp.initVoxelSim)

      expect(mockVp.initVoxelSim).toHaveBeenCalledTimes(1)
      const field = mockVp.initVoxelSim.mock.calls[0][0] as { data: Float32Array }
      const data = field.data.slice()

      cleanup()
      Reflect.deleteProperty(window, '__cncViewport')
      spy.mockRestore()
      return data
    }

    // Ground truth: no chunking, no mid-bake interaction.
    const reference = await runOnce(0.001, false)
    // Chunked, with a Rewind click landing squarely inside the bake window.
    const withMidBakeSeek = await runOnce(5, true)

    expect(Array.from(withMidBakeSeek)).toEqual(Array.from(reference))
  })
})
