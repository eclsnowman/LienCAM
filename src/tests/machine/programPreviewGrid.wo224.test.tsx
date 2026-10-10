// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const harness = vi.hoisted(() => ({
  instances: [] as Array<{
    setMachinePreviewCoordinateFrame: ReturnType<typeof vi.fn>
    renderToolpath: ReturnType<typeof vi.fn>
    setToolMarkerPosition: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }>,
}))

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
    constructor() { harness.instances.push(this) }
  },
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const frames: FrameRequestCallback[] = []
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }),
  configurable: true,
})
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const {
  PROGRAM_PREVIEW_GRID_STORAGE_KEY,
} = await import('../../components/machine/ProgramPreviewGridControl')
const { useMachineControl } = await import('../../store/machineControlStore')
// WO-414 batch 2 (Operator): the grid control IS the select - one line, eight
// options (Off, Machine, G54..G59), always visible; nothing to open first.

function setMachineState(overrides: Record<string, unknown> = {}) {
  useMachineControl.setState({
    programText: 'G0 X0 Y0\nG1 X10 Y20 F100',
    connectionPhase: 'connected',
    activeWcs: 'G54',
    offsets: { G54: [-100, -50, -2], G55: [-25, -75, -4] },
    settings: { 130: '300.000', 131: '200.000' },
    homed: true,
    wpos: { x: 10, y: 20, z: -1 },
    ...overrides,
  })
}

function selectedGridLabel() {
  const select = screen.getByTestId('program-preview-grid-label') as HTMLSelectElement
  return select.selectedOptions[0]?.textContent
}

beforeEach(() => {
  cleanup()
  mem.clear()
  frames.length = 0
  harness.instances.length = 0
  setMachineState()
})

afterEach(cleanup)

describe('WO-224 mounted ProgramPreview grid control', () => {
  it('offers exactly Off / Machine / G54..G59 (Operator: "No more than that"), defaults to Machine, and the program still sits at the ACTIVE offset', async () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]

    const select = screen.getByTestId('program-preview-grid-label') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['off', 'machine', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59'])
    expect(selectedGridLabel()).toBe('Machine')
    // No card, no chevron, no caption: the select is the whole control.
    expect(screen.queryByTestId('program-preview-grid-toggle')).toBeNull()
    expect(screen.queryByTestId('program-preview-grid-caption')).toBeNull()
    await waitFor(() => expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: -100, y: -50, z: -2 },
      grid: {
        travel: { x: 300, y: 200 },
        originMachine: { x: 0, y: 0, z: 0 },
        extentMachine: { x: { min: -300, max: 0 }, y: { min: -200, max: 0 } },
     },
    }))

    // A G54 grid draws from the G54 offset; switching the ACTIVE WCS moves the
    // program (its origin follows the controller) but never the chosen grid.
    fireEvent.change(select, { target: { value: 'G54' } })
    await waitFor(() => expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: -100, y: -50, z: -2 },
      grid: {
        travel: { x: 300, y: 200 },
        originMachine: { x: -100, y: -50, z: -2 },
        extentMachine: { x: { min: -300, max: 0 }, y: { min: -200, max: 0 } },
     },
    }))
    act(() => useMachineControl.setState({ activeWcs: 'G55' }))
    await waitFor(() => {
      expect(selectedGridLabel()).toBe('G54')
      expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
        programOriginMachine: { x: -25, y: -75, z: -4 },
        grid: {
          travel: { x: 300, y: 200 },
          originMachine: { x: -100, y: -50, z: -2 },
        extentMachine: { x: { min: -300, max: 0 }, y: { min: -200, max: 0 } },
       },
      })
    })
  })

  it('keeps a specific G55 grid distinct from the active G54 program/cutter frame and persists only the choice', async () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    fireEvent.change(screen.getByLabelText('Preview coordinate grid'), { target: { value: 'G55' } })

    await waitFor(() => expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: -100, y: -50, z: -2 },
      grid: {
        travel: { x: 300, y: 200 },
        originMachine: { x: -25, y: -75, z: -4 },
        extentMachine: { x: { min: -300, max: 0 }, y: { min: -200, max: 0 } },
     },
    }))
    expect(selectedGridLabel()).toBe('G55')
    expect(mem.get(PROGRAM_PREVIEW_GRID_STORAGE_KEY)).toBe('G55')
    // WO-414: the card's fold state rides in the shared liencam-ui-prefs
    // record (the same one every Control-tab fold uses); the grid CHOICE is
    // still the only thing written under its own key.
    expect([...mem.entries()].filter(([k]) => k !== 'liencam-ui-prefs')).toEqual([[PROGRAM_PREVIEW_GRID_STORAGE_KEY, 'G55']])

    act(() => { frames.shift()?.(0) })
    expect(viewport.setToolMarkerPosition).toHaveBeenCalledWith(10, 20, -1)
  })

  it('names unavailable offsets/extents and draws no authoritative grid', async () => {
    setMachineState({ offsets: {}, settings: { 130: '300.000' } })
    render(<ProgramPreview />)
    const viewport = harness.instances[0]

    expect(selectedGridLabel()).toBe('Machine unavailable')
    await waitFor(() => expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: null,
      grid: null,
    }))

    // Every G5x is always listed; an unknown one says so while selected.
    fireEvent.change(screen.getByLabelText('Preview coordinate grid'), { target: { value: 'G56' } })
    await waitFor(() => {
      expect(selectedGridLabel()).toBe('G56 unavailable')
      expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
        programOriginMachine: null,
        grid: null,
      })
    })
  })

  it('turns grid and origin off while retaining the program coordinate transform', async () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    fireEvent.change(screen.getByLabelText('Preview coordinate grid'), { target: { value: 'off' } })

    await waitFor(() => expect(viewport.setMachinePreviewCoordinateFrame).toHaveBeenLastCalledWith({
      programOriginMachine: { x: -100, y: -50, z: -2 },
      grid: null,
    }))
    expect(selectedGridLabel()).toBe('Off')
    expect(mem.get(PROGRAM_PREVIEW_GRID_STORAGE_KEY)).toBe('off')
  })
})
