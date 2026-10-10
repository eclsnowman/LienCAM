// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Setup, WCS } from '../../types'

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

const {
  SimulationPanel,
  formatPositionReadout,
  resolvePlaybackPosition,
} = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeWcs } = await import('../post/helpers')

const NON_ZERO_WCS = makeWcs({ origin: { x: 100, y: 200, z: 300 } })
const markerPosition = vi.fn<(x: number, y: number, z: number) => void>()
let rafCallbacks = new Map<number, FrameRequestCallback>()
let nextRafId = 1

function seedSimulation(wcs: WCS = NON_ZERO_WCS): void {
  const setup: Setup = {
    id: 'setup-sim5',
    name: 'SIM-5 non-zero WCS fixture',
    wcs,
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
      id: 'op-sim5',
      toolId: 'missing-tool-is-safe-for-marker-fixture',
      toolpathMoves: [
        { type: 'feed', role: 'cut', x: 110, y: 220, z: 330, feed: 600 },
        { type: 'feed', role: 'cut', x: 120, y: 220, z: 330, feed: 600 },
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
        activeOperationId: 'op-sim5',
      },
      viewer: {
        ...state.viewer,
        mode: 'simulation',
        stockSimEnabled: false,
      },
      appSettings: {
        ...state.appSettings,
        displayUnits: 'mm',
        simulationEngine: 'heightmap',
      },
    }))
  })
}

function runNextAnimationFrame(time: number): void {
  const next = rafCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined
  if (!next) throw new Error(`no requestAnimationFrame callback queued for t=${time}`)
  rafCallbacks.delete(next[0])
  act(() => { next[1](time) })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  markerPosition.mockClear()
  rafCallbacks = new Map()
  nextRafId = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextRafId++
    rafCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafCallbacks.delete(id) })
  Object.defineProperty(window, '__cncViewport', {
    configurable: true,
    value: {
      setToolMarkerPosition: markerPosition,
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

describe('SIM-5 WCS playback position readout', () => {
  it('interpolates a known crossing from the marker point through the canonical non-zero WCS transform', () => {
    const frame = {
      fromX: 110, fromY: 220, fromZ: 330,
      toX: 120, toY: 240, toZ: 360,
      startMs: 1000, durationMs: 1000,
    }

    const crossing = resolvePlaybackPosition(frame, 1500, NON_ZERO_WCS)

    expect(crossing).toEqual({
      machine: { x: 115, y: 230, z: 345 },
      work: { x: 15, y: 30, z: 45 },
    })
    expect(formatPositionReadout(crossing!.work, 'mm')).toBe('WCS X 15.000 Y 30.000 Z 45.000 mm')
  })

  it('updates continuously while playing from the exact world point sent to the viewport marker', () => {
    seedSimulation()
    render(<SimulationPanel />)
    markerPosition.mockClear()

    const play = document.querySelector('.sim-btn-primary') as HTMLButtonElement | null
    expect(play).not.toBeNull()
    act(() => { fireEvent.click(play!) })
    runNextAnimationFrame(100)
    runNextAnimationFrame(600)

    expect(screen.getByTestId('sim-position-readout').textContent)
      .toBe('WCS X 15.000 Y 20.000 Z 30.000 mm')
    expect(markerPosition).toHaveBeenLastCalledWith(115, 220, 330)

    const marker = markerPosition.mock.lastCall!
    expect([marker[0] - 100, marker[1] - 200, marker[2] - 300]).toEqual([15, 20, 30])
  })

  it('updates on paused scrub, reformats the same point on a unit switch, and clears to dashes', () => {
    seedSimulation()
    render(<SimulationPanel />)
    markerPosition.mockClear()

    const scrubber = document.querySelector('.sim-scrubber') as HTMLInputElement | null
    expect(scrubber).not.toBeNull()
    act(() => { fireEvent.change(scrubber!, { target: { value: '250' } }) })

    expect(screen.getByTestId('sim-position-readout').textContent)
      .toBe('WCS X 12.500 Y 20.000 Z 30.000 mm')
    expect(markerPosition).toHaveBeenLastCalledWith(112.5, 220, 330)

    act(() => {
      useCamStore.setState(state => ({
        appSettings: { ...state.appSettings, displayUnits: 'inch' },
      }))
    })
    expect(screen.getByTestId('sim-position-readout').textContent)
      .toBe('WCS X 0.4921 Y 0.7874 Z 1.1811 in')
    expect(markerPosition).toHaveBeenCalledTimes(1)

    act(() => {
      useCamStore.setState(state => ({
        project: {
          ...state.project,
          setups: [],
          activeSetupId: null,
          activeOperationId: null,
        },
      }))
    })
    expect(screen.getByTestId('sim-position-readout').textContent).toBe('WCS X - Y - Z -')
  })

  it('refuses non-finite frame and WCS data instead of displaying rounded NaN', () => {
    const frame = {
      fromX: 0, fromY: 0, fromZ: 0,
      toX: Number.NaN, toY: 1, toZ: 1,
      startMs: 0, durationMs: 1000,
    }
    const invalidWcs = makeWcs({ origin: { x: Number.NaN, y: 0, z: 0 } })

    expect(resolvePlaybackPosition(frame, 500, NON_ZERO_WCS)).toBeNull()
    expect(resolvePlaybackPosition({ ...frame, toX: 1 }, 500, invalidWcs)).toBeNull()
    expect(formatPositionReadout({ x: Number.NaN, y: 0, z: 0 }, 'mm')).toBe('WCS X - Y - Z -')
  })
})
