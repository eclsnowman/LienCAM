// @vitest-environment jsdom
//
// WO-1500 (Codex audit BUG-434, family K10b): the simulation transport
// Play/Pause button and the scrub timeline were the two controls the labeling
// pass missed -- Rewind and Skip-to-end already carry aria-labels. Tier 2 desk
// evidence: rendered-component accessibility-tree assertions (getByRole with
// name), no visual change.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Setup } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: key => mem.get(key) ?? null,
  key: index => Array.from(mem.keys())[index] ?? null,
  removeItem: key => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeWcs } = await import('../post/helpers')

// Two 10mm feed moves at F600 => ~1000ms each, ~2000ms total, so a scrub past
// 1000ms crosses the MM:SS second boundary and the announced value must change.
function seedComputedToolpath(): void {
  const setup: Setup = {
    id: 'setup-wo1500',
    name: 'WO-1500 computed toolpath fixture',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular',
      width: 50,
      height: 50,
      depth: 10,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [makeOp({
      id: 'op-wo1500',
      toolId: 'missing-tool-is-safe-for-a11y-fixture',
      toolpathMoves: [
        { type: 'feed', role: 'cut', x: 10, y: 0, z: 0, feed: 600 },
        { type: 'feed', role: 'cut', x: 20, y: 0, z: 0, feed: 600 },
      ],
    })],
    notes: '',
  }

  act(() => {
    useCamStore.setState(state => ({
      project: {
        ...state.project,
        setups: [setup],
        activeSetupId: setup.id,
        activeOperationId: 'op-wo1500',
      },
      viewer: { ...state.viewer, mode: 'simulation', stockSimEnabled: false },
      appSettings: { ...state.appSettings, displayUnits: 'mm', simulationEngine: 'heightmap' },
    }))
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  // rAF is only needed so handlePlay's scheduling call does not throw; the
  // tests assert the rendered label, not the playback advance.
  vi.stubGlobal('requestAnimationFrame', (_callback: FrameRequestCallback) => 1)
  vi.stubGlobal('cancelAnimationFrame', (_id: number) => {})
  Object.defineProperty(window, '__cncViewport', {
    configurable: true,
    value: {
      setToolMarkerPosition: vi.fn(),
      showToolMarker: vi.fn(),
      disposeStockSim: vi.fn(),
      disposeVoxelSim: vi.fn(),
      setStockSimOpacity: vi.fn(),
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-1500 simulation transport accessible names', () => {
  it('exposes Play while idle and Pause after play starts', () => {
    seedComputedToolpath()
    render(<SimulationPanel />)

    const play = screen.getByRole('button', { name: 'Play' })
    expect(play).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()

    act(() => { fireEvent.click(play) })

    expect(screen.getByRole('button', { name: 'Pause' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
  })

  it('names the scrub slider and announces an MM:SS aria-valuetext that tracks the value', () => {
    seedComputedToolpath()
    render(<SimulationPanel />)

    const slider = screen.getByRole('slider', { name: 'Simulation position' }) as HTMLInputElement
    const timeNow = document.querySelectorAll('.sim-time')[0]

    const initial = slider.getAttribute('aria-valuetext')
    expect(initial).toBeTruthy()
    expect(initial).toBe(timeNow.textContent)

    act(() => { fireEvent.change(slider, { target: { value: '1500' } }) })

    const moved = slider.getAttribute('aria-valuetext')
    expect(moved).toBeTruthy()
    expect(moved).not.toBe(initial)
    expect(moved).toBe(document.querySelectorAll('.sim-time')[0].textContent)
  })

  it('keeps the existing Rewind and Skip-to-end names', () => {
    seedComputedToolpath()
    render(<SimulationPanel />)

    expect(screen.getByRole('button', { name: 'Rewind to start' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Skip to end' })).not.toBeNull()
  })
})
