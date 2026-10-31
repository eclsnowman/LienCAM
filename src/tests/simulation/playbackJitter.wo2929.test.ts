// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { Setup } from '../../types'
import type { VoxelField } from '../../lib/simulation/voxel/VoxelField'
import {
  drainGuard, getReclassifyPassCount, installOverlayAttachGuard,
  resetGuardRefusals, uninstallOverlayAttachGuard,
} from '../ui/support/overlayAttachGuard'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => [...memory.keys()][index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
} satisfies Storage })

const { SimulationPanel, formatPositionReadout } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeWcs, makeTool } = await import('../post/helpers')
const marker = vi.fn<(x: number, y: number, z: number) => void>()
let callbacks = new Map<number, FrameRequestCallback>()
let nextId = 0
let observer: MutationObserver | undefined

function tick(timestamp: number): void {
  const next = callbacks.entries().next().value
  if (!next) throw new Error('Playback did not schedule its next frame')
  callbacks.delete(next[0])
  act(() => next[1](timestamp))
  drainGuard()
}

function start(voxel = false): { container: HTMLElement; scrubber: HTMLInputElement } {
  const setup: Setup = {
    id: 'wo2929', name: 'Playback readout mutation fixture', wcs: makeWcs(),
    stock: { type: 'rectangular', width: 50, height: 50, depth: 10,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [makeOp({ id: 'cut', toolId: voxel ? 'voxel-tool' : 'missing-marker-only', toolpathMoves: [
      { type: 'feed', role: 'cut', x: 0, y: 0, z: 0, feed: 1200 },
      { type: 'feed', role: 'cut', x: 100, y: 0, z: 0, feed: 1200 },
    ] })], notes: '',
  }
  act(() => useCamStore.setState(state => ({
    project: { ...state.project, setups: [setup], activeSetupId: setup.id, activeOperationId: 'cut' },
    toolLibrary: voxel ? [makeTool({ id: 'voxel-tool', type: 'flat_end_mill', diameter: 6 })] : [],
    viewer: { ...state.viewer, mode: 'simulation', stockSimEnabled: voxel, stockSimResolution: 1 },
    appSettings: { ...state.appSettings, displayUnits: 'mm', simulationEngine: voxel ? 'voxel' : 'heightmap' },
  })))
  const { container } = render(createElement(SimulationPanel))
  installOverlayAttachGuard(document)
  fireEvent.click(container.querySelector('.sim-btn-primary')!)
  tick(100)
  marker.mockClear()
  return { container, scrubber: container.querySelector<HTMLInputElement>('.sim-scrubber')! }
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  callbacks = new Map()
  nextId = 0
  marker.mockClear()
  resetGuardRefusals()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id) })
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: {
    setToolMarkerPosition: marker, showToolMarker: vi.fn(), disposeStockSim: vi.fn(),
    disposeVoxelSim: vi.fn(), setStockSimOpacity: vi.fn(),
  } })
})
afterEach(() => {
  observer?.disconnect()
  observer = undefined
  uninstallOverlayAttachGuard()
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-2929 actual playback readouts with the real attach guard', () => {
  it('uploads only the changed prefix region on successive real voxel playback ticks', () => {
    const boxes: Array<VoxelField['dirty']> = []
    const vp = (window as unknown as { __cncViewport: Record<string, unknown> }).__cncViewport
    vp.supportsVoxelSim = () => true
    vp.initVoxelSim = () => {}
    vp.initStockSim = () => ({ x0: 0, y0: 0, nx: 50, ny: 50, cellSize: 1, stockTop: 0, stockBot: -10 })
    vp.syncVoxelSim = (field: VoxelField) => {
      boxes.push(field.dirty)
      field.clearDirty() // the actual texture consumes dirt after each upload
    }
    const { scrubber } = start(true)
    tick(116)
    tick(132)
    tick(148)
    expect(scrubber.value).toBe('48')
    const last = boxes.at(-1)!
    expect(last).toBeDefined()
    expect(last).not.toBeNull()
    expect(last!.ix1 - last!.ix0, 'real prefix rollback must not re-upload all 50 stock columns').toBeLessThan(49)
  })

  it('does not replace unchanged time/feed strings or announce the same slider time every frame', () => {
    const { container, scrubber } = start()
    const time = container.querySelector('.sim-time')!
    const feed = container.querySelector('.sim-move-readout')!
    const position = container.querySelector('[data-testid="sim-position-readout"]')!
    observer = new MutationObserver(() => {})
    observer.observe(container, { subtree: true, attributes: true, childList: true, characterData: true })
    for (let i = 1; i <= 30; i++) tick(100 + i * 16)
    const records = observer.takeRecords()
    const redundant = records.filter(record => record.target === time || record.target === feed
      || (record.target === scrubber && record.attributeName === 'aria-valuetext'))
    console.info(JSON.stringify({ frames: 30, records: records.length, redundantReadoutWrites: redundant.length,
      guardPasses: getReclassifyPassCount(), marker: marker.mock.lastCall }))
    expect(redundant, 'unchanged readouts must not invalidate the whole document').toHaveLength(0)
    expect(records.filter(record => record.target === position)).toHaveLength(30)
    expect(position.textContent).toBe('WCS X 9.600 Y 0.000 Z 0.000 mm')
    expect(scrubber.value).toBe('480')
    expect(marker).toHaveBeenLastCalledWith(9.6, 0, 0)
  })

  it('does not schedule any scan when only sub-display precision motion changes', () => {
    const { container, scrubber } = start()
    const position = container.querySelector('[data-testid="sim-position-readout"]')!
    const passes = getReclassifyPassCount()
    tick(100.001)
    expect(marker.mock.lastCall![0]).toBeGreaterThan(0)
    expect(position.textContent).toBe('WCS X 0.000 Y 0.000 Z 0.000 mm')
    console.info(JSON.stringify({ unchangedDisplayGuardPasses: getReclassifyPassCount() - passes }))
    expect(getReclassifyPassCount() - passes, 'unchanged display must emit no guard invalidations').toBe(0)
    expect(Number(scrubber.value)).toBeCloseTo(0.001, 10)
  })

  it.each([1, 5, 10])('keeps elapsed playback exact at %sx through a long frame, pause, seek and resume', speed => {
    const { container, scrubber } = start()
    if (speed !== 1) {
      fireEvent.click(container.querySelector('.sim-speed-chip')!)
      const option = [...container.querySelectorAll('button')].find(button => button.textContent === `${speed}x`)
      expect(option).toBeDefined()
      fireEvent.click(option!)
    }
    tick(116)
    tick(150)
    tick(350)
    expect(Number(scrubber.value)).toBeCloseTo(250 * speed, 10)
    expect(marker.mock.lastCall![0]).toBeCloseTo(5 * speed, 10)
    expect(container.querySelector('[data-testid="sim-position-readout"]')!.textContent)
      .toBe(formatPositionReadout({ x: 5 * speed, y: 0, z: 0 }, 'mm'))
    fireEvent.click(container.querySelector('.sim-btn-primary')!)
    expect(callbacks.size).toBe(0)
    fireEvent.change(scrubber, { target: { value: '1000' } })
    expect(marker).toHaveBeenLastCalledWith(20, 0, 0)
    fireEvent.click(container.querySelector('.sim-btn-primary')!)
    tick(2000)
    tick(2100)
    expect(Number(scrubber.value)).toBeCloseTo(1000 + 100 * speed, 10)
    act(() => useCamStore.setState(state => ({ appSettings: { ...state.appSettings, displayUnits: 'inch' } })))
    expect(container.querySelector('[data-testid="sim-position-readout"]')!.textContent)
      .toBe(formatPositionReadout({ x: (1000 + 100 * speed) / 50, y: 0, z: 0 }, 'inch'))
  })
})
