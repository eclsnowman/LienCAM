// @vitest-environment jsdom
//
// WO-988: datum-dependent controls stay closed on a switchless machine, but
// their refusal must point at the action that can establish a datum. The
// switched-machine wording is printed as the work order's watched negative
// control; assertions pin the changed switchless branch and every gate.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  },
}))

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { topics } = await import('../../help/topics/machine')
const { useCamStore } = await import('../../store')
const { useMachineActions, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { __resetEstopInterlockForTest } = await import('../../lib/machine/machineSession')
const { createDefaultControllerDefinition, withMachineSafeZ } = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

const PARK = { id: 'park-1', label: 'Park', x: 100, y: 200 }
const PROGRAM = [
  'G21 G90 G54',
  'G0 X10 Y20 Z5',
  'G1 Z-0.2 F100',
  'G1 X30 Y20 F400',
  'G1 X30 Y40',
  'G1 X10 Y40',
  'G1 X10 Y20',
].join('\n')

function definition(withSwitches: boolean): ControllerDefinition {
  const value = createDefaultControllerDefinition()
  if (withSwitches) {
    value.axes.forEach((axis, index) => {
      axis.homePin = { port: 2, pin: index + 1, negate: false }
    })
  }
  return value
}

function setDefinition(value: ControllerDefinition): void {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({
    ...machine,
    noHomingSwitches: false,
    controllerDefinition: value,
  })
}

function tooltip(element: HTMLElement): string {
  return element.getAttribute('data-tooltip') ?? ''
}

function watchSwitched(label: string, textElement: HTMLElement, gate = textElement): void {
  const disabled = gate instanceof HTMLButtonElement || gate instanceof HTMLInputElement
    ? gate.disabled
    : undefined
  console.info(`[WO-988 negative control] ${label}: ${JSON.stringify({
    text: tooltip(textElement) || textElement.textContent,
    disabled,
  })}`)
}

function seedActions(): void {
  const machineId = useCamStore.getState().project.machine?.id ?? 'default'
  useMachineActions.setState({
    byMachine: {
      [machineId]: {
        overrides: {},
        custom: [],
        parks: [PARK],
        toolChangeParkId: PARK.id,
      },
    },
    macroArrangementByMachine: {},
  })
  // WO-1702: Safe Z is one field on the machine record, not a value stored
  // separately with the wiring. Read the record `setDefinition` (above) just
  // wrote - never `parkCarrierMachine`, which can resolve to a stale
  // `machineLibrary` copy that predates this test's definition and would
  // overwrite it on save.
  saveParkMachineRecord(withMachineSafeZ(useCamStore.getState().project.machine!, -2))
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  setDefinition(definition(false))
  seedActions()
  useMachineToolTable.setState({ byMachine: {} })
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: 1,
    homed: false,
    mpos: { x: 0, y: 0, z: 10 },
    wpos: { x: 0, y: 0, z: 0 },
    settings: { 23: '7', 130: '740', 131: '724', 132: '130' },
    alarm: null,
    programText: PROGRAM,
    fitTrace: null,
    toolChange: null,
    surfaceMesh: null,
    job: { ...useMachineControl.getState().job, phase: 'empty', name: 'part.nc' },
  })
  // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
  // no-datum wording, not the E-STOP latch, which starts armed by default
  // and would otherwise cover these tooltips with ESTOP_BLOCKS_MOTION.
  __resetEstopInterlockForTest()
})

afterEach(cleanup)

describe('WO-988 switchless datum wording keeps every gate closed', () => {
  it('parks stay disabled and point at setting the machine position', () => {
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    const park = screen.getByTestId('control-park-park-1') as HTMLButtonElement

    expect(park.disabled).toBe(true)
    expect(tooltip(park)).toContain('no machine datum')
    expect(tooltip(park)).toContain('set the machine position first')
    expect(tooltip(park)).not.toMatch(/home the machine/i)

    act(() => setDefinition(definition(true)))
    expect(park.disabled).toBe(true)
    watchSwitched('MacroPanel park', park)
  })

  it('clamp parking stays disabled and names its datum dependency', () => {
    useMachineControl.setState({
      job: { ...useMachineControl.getState().job, phase: 'streaming' },
    })
    render(<ProgramPanel />)
    const clamp = screen.getByTestId('control-clamp-pause') as HTMLButtonElement

    expect(clamp.disabled).toBe(true)
    expect(tooltip(clamp)).toContain('set the machine position first')
    expect(tooltip(clamp)).toContain('parking uses machine coordinates')
    expect(tooltip(clamp)).not.toMatch(/home the machine/i)

    act(() => setDefinition(definition(true)))
    expect(clamp.disabled).toBe(true)
    watchSwitched('ProgramPanel park + clamp', clamp)
  })

  it('fit trace stays disabled and names its safe-Z datum dependency', () => {
    render(<ProgramPanel />)
    const trace = screen.getByTestId('control-fittrace') as HTMLButtonElement

    expect(trace.disabled).toBe(true)
    expect(tooltip(trace)).toContain('set the machine position first')
    expect(tooltip(trace)).toContain('machine-coordinate safe Z')
    expect(tooltip(trace)).not.toMatch(/home the machine/i)

    act(() => setDefinition(definition(true)))
    expect(trace.disabled).toBe(true)
    watchSwitched('ProgramPanel fit trace', trace)
  })

  // WO-2063 (v2 brief): the plan text and the path-clear tick went with the
  // old screen; Start probing carries the refusal in its hover.
  it('automatic feature planning stays disabled and points at setting a datum', () => {
    render(<ProbingPanel />)
    const run = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement

    expect(run.disabled).toBe(true)
    expect(tooltip(run)).toContain('no machine datum')
    expect(tooltip(run)).toContain('set the machine position')
    expect(tooltip(run)).not.toMatch(/home the machine/i)

    act(() => setDefinition(definition(true)))
    expect(run.disabled).toBe(true)
    watchSwitched('ProbingPanel automatic feature plan', run)
  })

  it('mesh planning stays disabled and points at setting a datum', () => {
    render(<ProbingPanel />)
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))
    const run = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement

    expect(run.disabled).toBe(true)
    expect(tooltip(run)).toContain('no machine datum')
    expect(tooltip(run)).toContain('set the machine position')
    expect(tooltip(run)).not.toMatch(/home the machine/i)

    act(() => setDefinition(definition(true)))
    expect(run.disabled).toBe(true)
    watchSwitched('ProbingPanel mesh plan', run)
  })

  it('the envelope help entry gives both valid ways to establish a datum', () => {
    const probeRoutines = topics.find((topic) => topic.id === 'probe-routines')!
    const row = probeRoutines.sections
      .flatMap((section) => section.kind === 'table' ? section.rows : [])
      .find((candidate) => candidate.cells[0] === 'E_ENVELOPE_INCOMPLETE')
    if (!row) throw new Error('E_ENVELOPE_INCOMPLETE help row is missing.')
    const explanation = row.cells[2]

    expect(explanation).toContain('home the machine first')
    expect(explanation).toContain('set the machine position')
    expect(explanation).toContain('Complete its declaration in the Machine library')
  })
})
