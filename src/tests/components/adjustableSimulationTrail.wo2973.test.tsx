// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Setup } from '../../types'
import type { ToolpathWindowSegment } from '../../lib/simulation/toolpathWindow'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')
const { makeOp, makeWcs } = await import('../post/helpers')

let viewport: Record<string, ReturnType<typeof vi.fn>>
const lastWindow = () => viewport.setSimulationToolpathWindow.mock.calls.at(-1)![0] as ToolpathWindowSegment[]
const phases = (phase: ToolpathWindowSegment['phase']) => lastWindow().filter(segment => segment.phase === phase)
const seek = (value: number) => fireEvent.change(screen.getByRole('slider', { name: 'Simulation position' }), { target: { value: String(value) } })

function seedComputedToolpath(): void {
  const setup: Setup = {
    id: 'setup-wo2973', name: 'adjustable trail', wcs: makeWcs(), notes: '',
    stock: { type: 'rectangular', width: 50, height: 50, depth: 10, offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [makeOp({ id: 'op-wo2973', toolId: 'missing-tool-is-safe-for-a11y-fixture', type: 'contour_2d', toolpathMoves: [
      { type: 'feed', role: 'cut', x: 0, y: 0, z: -1, feed: 600 },
      { type: 'feed', role: 'cut', x: 20, y: 0, z: -1, feed: 600 },
      { type: 'feed', role: 'cut', x: 20, y: 20, z: -1, feed: 600 },
      { type: 'rapid', role: 'rapid', x: 0, y: 20, z: 5 },
    ] })],
  }
  act(() => useCamStore.setState(state => ({
    project: { ...state.project, setups: [setup], activeSetupId: setup.id, activeOperationId: 'op-wo2973' },
    viewer: { ...state.viewer, mode: 'simulation', stockSimEnabled: false },
    appSettings: { ...state.appSettings, displayUnits: 'mm', simulationEngine: 'heightmap' },
  })))
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  vi.stubGlobal('requestAnimationFrame', (_callback: FrameRequestCallback) => 1)
  vi.stubGlobal('cancelAnimationFrame', (_id: number) => {})
  Object.defineProperty(window, '__cncViewport', { configurable: true, value: viewport = {
    setSimulationToolpathPreview: vi.fn(), setSimulationToolpathWindow: vi.fn(), initStockSim: vi.fn(() => null),
    setToolMarkerPosition: vi.fn(), showToolMarker: vi.fn(), disposeStockSim: vi.fn(), disposeVoxelSim: vi.fn(), setStockSimOpacity: vi.fn(),
  } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__cncViewport')
})

describe('WO-2973 Simulation panel controls', () => {
  it('keeps edited asymmetric windows through playback, transport, rebuild, and normal-preview restoration', () => {
    let scheduled: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { scheduled = callback; return 1 })
    seedComputedToolpath()
    render(<SimulationPanel />)
    const initialLayer = viewport.setSimulationToolpathPreview.mock.calls.at(-1)![0]
    const stockDisposals = viewport.disposeStockSim.mock.calls.length
    fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value: 'trail' } })
    expect((screen.getByRole('spinbutton', { name: 'Trail (recent seconds)' }) as HTMLInputElement).value).toBe('2')
    seek(2500)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trail (recent seconds)' }), { target: { value: '0.25' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Lead (upcoming seconds)' }), { target: { value: '1' } })
    expect(phases('recent')).toHaveLength(1)
    expect(phases('upcoming')).toHaveLength(1)
    expect(phases('recent')[0]).toMatchObject({ frameIndex: 1, fromY: 2.5, toY: 5 })
    expect(phases('upcoming')[0]).toMatchObject({ frameIndex: 1, fromY: 5, toY: 15 })

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    act(() => scheduled(0))
    act(() => scheduled(100))
    expect(phases('recent')[0]).toMatchObject({ fromY: 3.5, toY: 6 })
    expect(phases('upcoming')[0]).toMatchObject({ fromY: 6, toY: 16 })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Lead (upcoming seconds)' }), { target: { value: '0' } })
    expect(phases('recent')).toHaveLength(1)
    expect(phases('recent')[0]).toMatchObject({ fromY: 3.5, toY: 6 })
    expect(phases('upcoming')).toHaveLength(0)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Lead (upcoming seconds)' }), { target: { value: '1' } })
    expect(phases('upcoming')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    act(() => scheduled(200))
    act(() => scheduled(300))
    expect(phases('recent')[0]).toMatchObject({ fromY: 4.5, toY: 7 })
    expect(phases('upcoming')[0]).toMatchObject({ fromY: 7, toY: 17 })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))

    fireEvent.click(screen.getByRole('button', { name: 'Skip to end' }))
    expect(phases('recent')).not.toHaveLength(0)
    expect(phases('upcoming')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to start' }))
    expect(phases('recent')).toHaveLength(0)
    expect(phases('upcoming')).not.toHaveLength(0)

    fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value: 'layer' } })
    expect(viewport.setSimulationToolpathPreview.mock.calls.at(-1)![0]).toBe(initialLayer)
    fireEvent.change(screen.getByRole('combobox', { name: 'Path display' }), { target: { value: 'trail' } })
    seek(2500)
    expect(phases('recent')[0]).toMatchObject({ fromY: 2.5, toY: 5 })
    expect(phases('upcoming')[0]).toMatchObject({ fromY: 5, toY: 15 })
    expect(viewport.disposeStockSim.mock.calls.length).toBe(stockDisposals)

    act(() => useCamStore.setState(state => ({ project: { ...state.project, setups: state.project.setups.map(setup => ({
      ...setup, operations: setup.operations.map(operation => ({ ...operation, toolpathMoves: [
        { type: 'feed' as const, role: 'cut' as const, x: 100, y: 0, z: -1, feed: 600 },
        { type: 'feed' as const, role: 'cut' as const, x: 120, y: 0, z: -1, feed: 600 },
        { type: 'feed' as const, role: 'cut' as const, x: 120, y: 20, z: -1, feed: 600 },
      ] })),
    })) } })))
    expect(phases('recent')).toHaveLength(0)
    expect(phases('upcoming')).toHaveLength(1)
    expect(phases('upcoming')[0]).toMatchObject({ fromX: 100, toX: 110 })

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trail (recent seconds)' }), { target: { value: '0' } })
    expect(phases('recent')).toHaveLength(0)
    expect(phases('upcoming')).not.toHaveLength(0)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Lead (upcoming seconds)' }), { target: { value: '0' } })
    expect(lastWindow()).toEqual([])
  })
})
