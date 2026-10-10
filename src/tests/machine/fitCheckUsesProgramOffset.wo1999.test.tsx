// @vitest-environment jsdom
//
// WO-1999: the program fit check is silent until the offset the program uses
// holds a work zero, and it measures against the offset the program's own G5x
// word selects (G58), not the active one (G54).

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn(() => 1), configurable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { resetProgramFitConsole } = await import('../../components/machine/ProgramFitStatusLine')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

const MACHINE_ID = 'wo1999-machine'
const G54_PROGRAM = 'G21 G90 G54\nG0 X0 Y0 Z10\nG1 X20 Y20 Z0 F500\nM30\n'
const G58_PROGRAM = 'G21 G90 G58\nG0 X0 Y0 Z10\nG1 X20 Y20 Z0 F500\nM30\n'
// X -10..10: partly off the table when measured at an all-zero offset, so the
// old check (finding 6) raised PARTLY OUTSIDE here before any work zero.
const G54_MINUS_X_PROGRAM = 'G21 G90 G54\nG0 X-10 Y0 Z10\nG1 X10 Y20 Z0 F500\nM30\n'
const G58_MINUS_X_PROGRAM = 'G21 G90 G58\nG0 X-10 Y0 Z10\nG1 X10 Y20 Z0 F500\nM30\n'

function machine() {
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1999 positive table',
    travel: { x: 100, y: 100, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  })
}

let originalProject: Project

function setControl(programText: string, activeWcs: string, offsets: Record<string, number[]>) {
  useMachineControl.setState({
    programText,
    connectionPhase: 'connected',
    connectionKind: 'bridge',
    activeWcs: activeWcs as never,
    offsets,
    homed: true,
    consoleLines: [],
    programFit: null,
  })
}

function fitLines() {
  return useMachineControl.getState().consoleLines.filter((line) =>
    line.text.includes('Program (after'))
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  resetProgramFitConsole()
  originalProject = useCamStore.getState().project
  useCamStore.setState({ project: { ...originalProject, machine: machine() } })
})

afterEach(() => {
  cleanup()
  useCamStore.setState({ project: originalProject })
  useMachineControl.setState({
    programText: null,
    connectionPhase: 'disconnected',
    connectionKind: null,
    offsets: {},
    consoleLines: [],
    programFit: null,
  })
})

describe('WO-1999: fit check waits for work zero and uses the program offset', () => {
  it('says nothing while the offset holds no work zero (all zero)', () => {
    setControl(G54_MINUS_X_PROGRAM, 'G54', { G54: [0, 0, 0] })
    render(<ProgramPreview />)
    expect(fitLines()).toEqual([])
  })

  it('says nothing when the program offset (G58) is unset even though G54 is set', () => {
    // Active G54 would put X -10..10 at machine X 110..130 (off a 100 mm table).
    setControl(G58_MINUS_X_PROGRAM, 'G54', { G54: [120, 20, 20], G58: [0, 0, 0] })
    render(<ProgramPreview />)
    expect(fitLines()).toEqual([])
  })

  it('a G58 program inside travel on G58 is clean even when active G54 would put it outside', () => {
    setControl(G58_PROGRAM, 'G54', { G54: [120, 20, 20], G58: [20, 20, 20] })
    render(<ProgramPreview />)
    // INSIDE is silent on first paint (WO-377); the G54 offset would have
    // raised an error line had the check measured against it.
    expect(fitLines()).toEqual([])
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it('a G58 program genuinely outside on G58 is still flagged, naming G58', () => {
    setControl(G58_PROGRAM, 'G54', { G54: [20, 20, 20], G58: [120, 20, 20] })
    render(<ProgramPreview />)
    expect(fitLines()).toHaveLength(1)
    expect(fitLines()[0]).toMatchObject({ severity: 'error' })
    expect(fitLines()[0].text).toContain('after G58')
  })

  it('speaks once the work zero is set after being unset', () => {
    setControl(G54_PROGRAM, 'G54', { G54: [0, 0, 0] })
    render(<ProgramPreview />)
    expect(fitLines()).toEqual([])
    act(() => { useMachineControl.setState({ offsets: { G54: [120, 20, 20] } }) })
    expect(fitLines()).toHaveLength(1)
    expect(fitLines()[0]).toMatchObject({ severity: 'error' })
  })
})
