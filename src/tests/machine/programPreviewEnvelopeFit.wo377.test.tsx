// @vitest-environment jsdom
//
// WO-377: the Control preview warns when the loaded program, after the active
// work offset, lies partly or wholly outside the declared table - naming the
// axes and comparing program bounds with machine bounds - and the grid
// selector names its frame (machine vs work).
// WO-414 batch 2 (Operator: the Table card is removed): the verdict became ONE
// amber sentence under the Control strip.
// WO-414 (Operator 2026-08-21, on Chat: "The partially outside banner steals
// vertical pixels. Don't do that. Use console for messages."): that sentence
// is gone too - the verdict is CONSOLE lines only now (ProgramFitStatusLine
// no longer renders anything; publishProgramFit writes the console line
// directly). INSIDE still says nothing on first paint. The frame name is the
// grid select's tooltip (no caption).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createDefaultControllerDefinition } from '../../types'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
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
  },
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn(() => 1), configurable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { PROGRAM_FIT_REMEDY, resetProgramFitConsole } = await import('../../components/machine/ProgramFitStatusLine')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')

// A program in positive X/Y, 0..80 x 0..60, Z 5..-16 (work coordinates).
const PROGRAM = 'G21 G90 G54\nG0 X0 Y0 Z5\nG1 Z-16 F300\nG1 X80 Y0 F800\nG1 X80 Y60\nG1 X0 Y60\nG1 X0 Y0\nG0 Z5\nM30\n'

function sampleMachineDeclaredMachine() {
  return {
    id: 'wo377-negative-preview-machine',
    name: 'WO-377 negative preview fixture',
    controller: 'grbl' as const,
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 738, y: 724.5, z: 128.9 },
    homeConvention: {
      x: { homesToward: 'max' as const, machineZeroAt: 'max' as const },
      y: { homesToward: 'max' as const, machineZeroAt: 'max' as const },
      z: { homesToward: 'max' as const, machineZeroAt: 'max' as const },
    },
    noHomingSwitches: false,
  }
}

function setState(offsetG54: number[], programText: string | null = PROGRAM) {
  useCamStore.setState((s) => ({ project: { ...s.project, machine: { ...s.project.machine, ...sampleMachineDeclaredMachine() } } }))
  useMachineControl.setState({
    programText,
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    activeWcs: 'G54',
    offsets: { G54: offsetG54 },
    settings: { 130: '738.000', 131: '724.500', 132: '128.900' },
    homed: true,
    consoleLines: [],
  })
}

function lastConsoleText(): string | undefined {
  const lines = useMachineControl.getState().consoleLines
  return lines[lines.length - 1]?.text
}

beforeEach(() => { cleanup(); localStorage.clear(); resetProgramFitConsole() })
afterEach(cleanup)

describe('WO-377 Control preview: program vs declared envelope (console only, WO-414)', () => {
  // WO-1999: an all-zero G54 row is "no work zero set yet" - the fit check is
  // silent until one is set (no false OUTSIDE at connect). Operator's case now
  // sets a real work zero just past machine zero, still off the table.
  it('G54 all zero (no work zero set yet) -> no fit verdict, no console line', () => {
    setState([0, 0, 0])
    render(<ProgramPreview />)
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it("Operator's case: positive-Y program with G54 set just past machine zero -> OUTSIDE console line, X and Y named with both bounds", () => {
    setState([10, 10, 0])
    render(<ProgramPreview />)
    // No on-screen banner anywhere (WO-414: console only).
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    const text = lastConsoleText() ?? ''
    expect(text.startsWith('OUTSIDE')).toBe(true)
    expect(text).toContain('after G54')
    expect(text).toContain('entirely off the table on X, Y')
    expect(text).toContain('X: program 10.00..90.00, table -738.00..0.00')
    expect(text).toContain('Y: program 10.00..70.00, table -724.50..0.00')
    expect(text).toContain('Z: program -16.00..5.00, table -128.90..0.00')
    expect(text).toContain('machine coordinates')
    // The remedy rides in the console line.
    expect(text).toContain(PROGRAM_FIT_REMEDY)
    // No Table card in the viewport any more (Operator: "remove it").
    expect(screen.queryByTestId('program-preview-envelope')).toBeNull()
    // Exactly one console line for the verdict, with the signed table in it.
    const lines = useMachineControl.getState().consoleLines
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('error')
  })

  it('G54 moved onto the table -> INSIDE, no console line on first paint, no amber state', () => {
    setState([-400, -400, -20])
    render(<ProgramPreview />)
    // INSIDE says nothing: no banner (never existed), no console line on first paint.
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it('straddling one edge -> PARTLY OUTSIDE console line on that axis only', () => {
    setState([-400, -30, -20])
    render(<ProgramPreview />)
    const text = lastConsoleText() ?? ''
    expect(text.startsWith('PARTLY OUTSIDE')).toBe(true)
    expect(text).toContain('runs partly off the table on Y')
    expect(text).toContain('Y: program -30.00..30.00, table -724.50..0.00')
    expect(text).not.toContain('X:')
  })

  it('the console gets one line per verdict CHANGE - and one when it comes back inside', () => {
    setState([-400, -30, -20])
    render(<ProgramPreview />)
    expect(useMachineControl.getState().consoleLines.map((l) => l.text.split(' - ')[0])).toEqual(['PARTLY OUTSIDE'])
    // Same verdict again: nothing new.
    act(() => { useMachineControl.setState({ offsets: { G54: [-400, -30, -20] } }) })
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)
    // Moved onto the table: the console says so once, no banner appears.
    act(() => { useMachineControl.setState({ offsets: { G54: [-400, -400, -20] } }) })
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    const lines = useMachineControl.getState().consoleLines
    expect(lines).toHaveLength(2)
    expect(lines[1].text).toBe('Program (after G54) fits inside the table.')
    expect(lines[1].severity).toBe('info')
  })

  it('does not publish an inside verdict when the program addresses a disabled controller axis', () => {
    setState([-400, -30, -20])
    render(<ProgramPreview />)
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)

    const controllerDefinition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
    controllerDefinition.axes.find((axis) => axis.axis === 'X')!.enabled = false
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          machine: { ...state.project.machine, controllerDefinition },
        },
      }))
      useMachineControl.setState({ offsets: { G54: [-400, -400, -20] } })
    })

    expect(useMachineControl.getState().consoleLines).toHaveLength(1)
    expect(lastConsoleText()).not.toBe('Program (after G54) fits inside the table.')
  })

  it('says nothing about fit when no program is loaded', () => {
    setState([0, 0, 0], null)
    render(<ProgramPreview />)
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it('labels the grid frame: machine grid vs work grid, and says the program does not move (the select tooltip)', () => {
    setState([0, 0, 0])
    render(<ProgramPreview />)
    const select = screen.getByTestId('program-preview-grid-label') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'machine' } })
    expect(select.getAttribute('data-grid-frame')).toBe('machine')
    expect(select.title).toContain('Machine grid - numbers are machine coordinates from machine zero')
    expect(select.title).toContain('The program does not move when you switch grids.')
    fireEvent.change(select, { target: { value: 'G54' } })
    expect(select.getAttribute('data-grid-frame')).toBe('work')
    expect(select.title).toContain('Work grid - numbers are G54 work coordinates')
    fireEvent.change(select, { target: { value: 'off' } })
    expect(select.getAttribute('data-grid-frame')).toBe('none')
    // WO-414 batch 2: no caption under the select - one line, nothing more.
    expect(screen.queryByTestId('program-preview-grid-caption')).toBeNull()
  })

  // WO-1630: on the board, MDI `G53 G0 Z128.` ran and finished; then G54 Z was
  // edited and the console painted a false OUTSIDE - a MACHINE coordinate had
  // been shifted by a work offset that never applies to it. Operator's table here
  // is negative Z (-128.9..0, "far corner" homing); the G53 target and the G54
  // edit are picked to land the same way relative to it.
  it('WO-1630: a G53 machine-coordinate move stays INSIDE, and silent, across a G54 Z edit', () => {
    setState([0, 0, -50], 'G21 G90 G54\nG53 G0 Z-64\nM30\n')
    render(<ProgramPreview />)
    expect(useMachineControl.getState().consoleLines).toEqual([])
    expect(useMachineControl.getState().programFit?.state).toBe('inside')

    // The exact gesture from the finding: only the work offset moves.
    act(() => { useMachineControl.setState({ offsets: { G54: [0, 0, -10] } }) })

    // Rule 11: CYCLE START is refused on an OUTSIDE verdict
    // (operatorTransport.ts:277) - so the store state IS the claim.
    expect(useMachineControl.getState().programFit?.state).toBe('inside')
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })
})
