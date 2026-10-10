// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const harness = vi.hoisted(() => ({
  instances: [] as Array<{
    renderToolpath: ReturnType<typeof vi.fn>
    setSimulationToolpathPreview: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    renderToolpath = vi.fn()
    setSimulationToolpathPreview = vi.fn()
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    setToolMarkerPosition = vi.fn()
    setOrbitFocus = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
    constructor() { harness.instances.push(this) }
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: vi.fn(() => 1),
  configurable: true,
})
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const {
  ProgramPreview,
  REMAINING_PATH_PREF_KEY,
  remainingProgramPath,
} = await import('../../components/machine/ProgramPreview')
const { buildProgramPath } = await import('../../lib/machine/programPath')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

const PROGRAM = [
  'G21 G90 G54',
  'G0 X0 Y0 Z5',
  'G1 Z-2 F300',
  'G1 X10 Y0 F800',
  'G1 X0 Y0',
  'G1 Z-4 F300',
  'G1 X10 Y0 F800',
  'G1 X0 Y0',
  'G1 Z-5 F300',
  'G1 X10 Y0 F800',
  'G1 X0 Y0',
  'M30',
].join('\n')

function setPreviewState() {
  const current = useMachineControl.getState()
  useMachineControl.setState({
    programText: PROGRAM,
    programContext: null,
    job: {
      ...current.job,
      name: 'three-levels.nc',
      phase: 'ready',
      ackedSourceLine: 0,
    },
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    activeWcs: 'G54',
    offsets: { G54: [10, 10, 10] },
    settings: { 130: '300.000', 131: '200.000', 132: '100.000' },
    homed: true,
  })
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  harness.instances.length = 0
  setPreviewState()
})

afterEach(cleanup)

describe('WO-2049 remaining-path Control viewport', () => {
  it('keeps the cursor segment and only moves at or after the running cursor', () => {
    const full = buildProgramPath(PROGRAM)
    const remaining = remainingProgramPath(full, 7)

    expect(remaining.moves).toHaveLength(6)
    expect(remaining.moveLines).toEqual([6, 7, 8, 9, 10, 11])
    expect(remaining.moves.map((move) => move.z)).toEqual([-4, -4, -4, -5, -5, -5])
    expect(remaining.moves.some((move) => move.z === -2)).toBe(false)
    expect(remainingProgramPath(full, 12)).toEqual({ moves: [], moveLines: [] })
  })

  it('is off by default, remembered, and filters only while running or paused', () => {
    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    const toggle = screen.getByTestId('program-preview-remaining-path')

    expect(toggle.textContent).toBe('ALL')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(viewport.setSimulationToolpathPreview).toHaveBeenLastCalledWith(null)

    fireEvent.click(toggle)
    expect(toggle.textContent).toBe('REM')
    expect(toggle.getAttribute('data-path-view')).toBe('remaining')
    expect(useUiPrefs.getState().collapsedPropsGroups[REMAINING_PATH_PREF_KEY]).toBe(true)
    // The choice is armed while idle, but browsing still shows the full path.
    expect(viewport.setSimulationToolpathPreview).toHaveBeenLastCalledWith(null)

    act(() => {
      const job = useMachineControl.getState().job
      useMachineControl.setState({ job: { ...job, phase: 'streaming', ackedSourceLine: 7 } })
    })
    const streaming = viewport.setSimulationToolpathPreview.mock.calls.at(-1)?.[0]
    expect(streaming).toHaveLength(6)
    expect(streaming.map((move: { z: number }) => move.z)).toEqual([-4, -4, -4, -5, -5, -5])

    act(() => {
      const job = useMachineControl.getState().job
      useMachineControl.setState({ job: { ...job, phase: 'paused', ackedSourceLine: 10 } })
    })
    const paused = viewport.setSimulationToolpathPreview.mock.calls.at(-1)?.[0]
    expect(paused.map((move: { z: number }) => move.z)).toEqual([-5, -5, -5])

    act(() => {
      const job = useMachineControl.getState().job
      useMachineControl.setState({ job: { ...job, phase: 'complete' } })
    })
    expect(viewport.setSimulationToolpathPreview).toHaveBeenLastCalledWith(null)
  })

  it('clears the drawing when no moves remain and restores the full path when switched off', () => {
    useUiPrefs.setState({
      collapsedPropsGroups: { [REMAINING_PATH_PREF_KEY]: true },
    })
    const job = useMachineControl.getState().job
    useMachineControl.setState({
      job: { ...job, phase: 'streaming', ackedSourceLine: 12 },
    })

    render(<ProgramPreview />)
    const viewport = harness.instances[0]
    expect(viewport.renderToolpath).toHaveBeenLastCalledWith([], true)

    fireEvent.click(screen.getByTestId('program-preview-remaining-path'))
    const restored = viewport.renderToolpath.mock.calls.at(-1)?.[0]
    expect(restored).toHaveLength(buildProgramPath(PROGRAM).moves.length)
    expect(viewport.setSimulationToolpathPreview).toHaveBeenLastCalledWith(null)
  })
})
