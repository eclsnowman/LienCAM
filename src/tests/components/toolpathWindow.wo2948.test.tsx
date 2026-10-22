// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Setup } from '../../types'
import type { ToolpathWindowSegment } from '../../lib/simulation/toolpathWindow'
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => mem.set(key, value),
  removeItem: (key: string) => mem.delete(key), clear: () => mem.clear(),
} })
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeWcs } = await import('../post/helpers')
let vp: Record<string, ReturnType<typeof vi.fn>>
function seedComputedToolpath(): void {
  const setup: Setup = {
    id: 'setup-wo2948',
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
      id: 'op-wo2948',
      toolId: 'missing-tool-is-safe-for-a11y-fixture',
      type: 'contour_2d',
      toolpathMoves: [
        { type: 'feed', role: 'cut', x: 0, y: 0, z: -1, feed: 600 },
        { type: 'feed', role: 'cut', x: 20, y: 0, z: -1, feed: 600 },
        { type: 'feed', role: 'cut', x: 20, y: 20, z: -1, feed: 600 },
        { type: 'rapid', role: 'rapid', x: 0, y: 20, z: 5 },
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
        activeOperationId: 'op-wo2948',
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
    value: vp = {
      setSimulationToolpathPreview: vi.fn(),
      setSimulationToolpathWindow: vi.fn(),
      initStockSim: vi.fn(() => null),
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


const selectTrail = (value = 'trail') => fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value } })
const seek = (value: number) => fireEvent.change(screen.getByRole('slider', { name: 'Simulation position' }), { target: { value: String(value) } })
const lastWindow = () => vp.setSimulationToolpathWindow.mock.calls.at(-1)![0] as ToolpathWindowSegment[]

describe('WO-2948 Simulation panel integration', () => {
  it('defaults to layer; paused toggle preserves cursor, frame identity and stock without rebuilding', () => {
    seedComputedToolpath()
    render(<SimulationPanel />)
    expect((screen.getByRole('combobox', { name: 'Path display' }) as HTMLSelectElement).value).toBe('layer')
    expect(vp.setSimulationToolpathWindow).not.toHaveBeenCalled()
    seek(1000)
    const marker = vp.setToolMarkerPosition.mock.calls.at(-1)
    const disposes = vp.disposeStockSim.mock.calls.length
    const moves = useCamStore.getState().project.setups[0].operations[0].toolpathMoves
    const before = structuredClone(moves)
    const layer = vp.setSimulationToolpathPreview.mock.calls.at(-1)![0]
    selectTrail()
    const segments = lastWindow()
    expect(segments.find(s => s.phase === 'recent' && s.frameIndex === 0)?.toX).toBe(10)
    expect(segments.find(s => s.phase === 'upcoming' && s.frameIndex === 0)?.fromX).toBe(10)
    expect(segments[0].frame.sourceMove).toBe(moves![1])
    expect(segments[0].frame.sourceOperationId).toBe('op-wo2948')
    expect(vp.setToolMarkerPosition.mock.calls.at(-1)).toEqual(marker)
    expect(vp.disposeStockSim.mock.calls.length).toBe(disposes)
    expect((screen.getByRole('slider', { name: 'Simulation position' }) as HTMLInputElement).value).toBe('1000')
    selectTrail('layer')
    expect(vp.setSimulationToolpathPreview.mock.calls.at(-1)![0]).toBe(layer)
    expect(moves).toEqual(before)
  })

  it('updates on seeks/start/end, retains play/pause state on toggles and clears on mode exit/unmount', () => {
    seedComputedToolpath()
    const rendered = render(<SimulationPanel />)
    selectTrail()
    seek(2500)
    expect(lastWindow().some(s => s.frameIndex === 1)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    selectTrail('layer')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    selectTrail()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    const count = vp.setSimulationToolpathWindow.mock.calls.length
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    expect(vp.setSimulationToolpathWindow.mock.calls.length).toBe(count)
    fireEvent.click(screen.getByRole('button', { name: 'Skip to end' }))
    expect(lastWindow().every(s => s.phase === 'recent')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to start' }))
    expect(lastWindow().every(s => s.phase === 'upcoming')).toBe(true)
    act(() => useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'toolpath' } })))
    expect(vp.setSimulationToolpathPreview.mock.calls.at(-1)![0]).toBeNull()
    act(() => useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'simulation' } })))
    expect(lastWindow().some(s => s.phase === 'upcoming')).toBe(true)
    rendered.unmount()
    expect(vp.setSimulationToolpathPreview.mock.calls.at(-1)![0]).toBeNull()
  })

  it('advances the live playback cursor after a display toggle without reinitializing stock', () => {
    let scheduled: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { scheduled = callback; return 1 })
    seedComputedToolpath()
    act(() => useCamStore.setState(s => ({ viewer: { ...s.viewer, stockSimEnabled: true } })))
    render(<SimulationPanel />)
    const stockInitializations = vp.initStockSim.mock.calls.length
    const stockDisposals = vp.disposeStockSim.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    act(() => scheduled(0))
    act(() => scheduled(100))
    selectTrail()
    const from = lastWindow().find(s => s.phase === 'upcoming')!.fromX
    act(() => scheduled(200))
    expect(lastWindow().find(s => s.phase === 'upcoming')!.fromX).toBeGreaterThan(from)
    expect(vp.initStockSim.mock.calls.length).toBe(stockInitializations)
    expect(vp.disposeStockSim.mock.calls.length).toBe(stockDisposals)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  it('replaces the trail after a path rebuild and clears an emptied context', () => {
    seedComputedToolpath()
    render(<SimulationPanel />)
    selectTrail()
    const oldFrame = lastWindow()[0].frame
    act(() => useCamStore.setState(s => ({ project: { ...s.project, setups: s.project.setups.map(setup => ({
      ...setup, operations: setup.operations.map(op => ({ ...op, toolpathMoves: [
        { type: 'feed' as const, role: 'cut' as const, x: 100, y: 0, z: -1, feed: 600 },
        { type: 'feed' as const, role: 'cut' as const, x: 110, y: 0, z: -1, feed: 600 },
      ] })),
    })) } })))
    expect(lastWindow()[0].frame).not.toBe(oldFrame)
    expect(lastWindow()[0].fromX).toBe(100)
    act(() => useCamStore.setState(s => ({ project: { ...s.project, setups: [] } })))
    expect(vp.setSimulationToolpathPreview.mock.calls.at(-1)![0]).toBeNull()
  })
})
