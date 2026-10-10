// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineProgram } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
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
  } as never,
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

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useCamStore } = await import('../../store')
const { useMachineActions, parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { withMachineSafeZ } = await import('../../types')

const PROGRAM: MachineProgram = {
  frame: 'work',
  units: 'mm',
  steps: [
    { id: 1, kind: 'line', rapid: true, to: { x: 0, y: 0, z: 5 }, feedMmMin: 3000 },
    { id: 2, kind: 'line', to: { x: 10, y: 0, z: -1 }, feedMmMin: 400 },
    { id: 3, kind: 'line', rapid: true, to: { x: 10, y: 0, z: 8 }, feedMmMin: 3000 },
    { id: 4, kind: 'line', rapid: true, to: { x: 2, y: 3, z: 5 }, feedMmMin: 3000 },
    { id: 5, kind: 'line', to: { x: 12, y: 3, z: -2 }, feedMmMin: 500 },
  ],
  index: {
    1: { opId: 'op-1', setupId: 'setup-1', moveOrdinal: 0 },
    2: { opId: 'op-1', setupId: 'setup-1', moveOrdinal: 1 },
    3: { opId: 'op-1', setupId: 'setup-1', moveOrdinal: 2 },
    4: { opId: 'op-2', setupId: 'setup-2', moveOrdinal: 0 },
    5: { opId: 'op-2', setupId: 'setup-2', moveOrdinal: 1 },
  },
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  // WO-1702: Safe Z is one field on the machine record, not a value stored
  // separately with the wiring - write it through the same path the Machine
  // actions modal uses, which updates the library copy `parkCarrierMachine`
  // resolves to as well as the project's.
  saveParkMachineRecord(withMachineSafeZ(parkCarrierMachine(useCamStore.getState()), -2))
  const machineId = useCamStore.getState().project.machine?.id ?? 'default'
  useMachineActions.setState({
    byMachine: {
      [machineId]: {
        overrides: {},
        custom: [],
        parks: [],
        toolChangeParkId: null,
      },
    },
    macroArrangementByMachine: {},
  })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    homed: true,
    programText: null,
    stagedProgram: {
      program: PROGRAM,
      setups: [
        { setupName: 'Setup 1', wcs: 'G54', firstStepId: 1 },
        { setupName: 'Setup 2', wcs: 'G55', firstStepId: 4 },
      ],
    },
    executingMoveId: null,
    fitTrace: null,
    toolChange: null,
    job: {
      ...useMachineControl.getState().job,
      phase: 'ready',
      name: 'Setup 1 + Setup 2 (toolpath)',
      totalLines: 5,
      sentLines: 5,
      ackedLines: 0,
      ackedSourceLine: 0,
    },
  })
})

afterEach(cleanup)

describe('WO-1328 toolpath program listing', () => {
  it('renders staged moves and both setup frames without the empty placeholder', () => {
    render(<ProgramPanel />)
    const list = screen.getByTestId('control-gcode-list')

    expect(list.textContent).toContain('Setup 1 in G54')
    expect(list.textContent).toContain('G0 X0 Y0 Z5')
    expect(list.textContent).toContain('G1 X10 Y0 Z-1 F400')
    expect(list.textContent).toContain('Setup 2 in G55')
    expect(list.textContent).toContain('G1 X12 Y3 Z-2 F500')
    expect(list.textContent).not.toContain('Load a posted setup')
    expect(screen.queryByTestId('control-runfrom-input')).toBeNull()
  })

  it('moves the highlight with advancing status executingMoveId values', () => {
    useMachineControl.setState({
      job: { ...useMachineControl.getState().job, phase: 'streaming', startedAt: 1 },
    })
    render(<ProgramPanel />)

    act(() => useMachineControl.getState().setExecutingMoveId(2))
    expect(document.querySelector('.gcode-line-hl')?.textContent).toContain('G1 X10 Y0 Z-1 F400')

    act(() => useMachineControl.getState().setExecutingMoveId(5))
    expect(document.querySelector('.gcode-line-hl')?.textContent).toContain('G1 X12 Y3 Z-2 F500')
  })

  it('enables Fit Trace for a loaded toolpath program with a preview', () => {
    render(<ProgramPanel />)
    const fitTrace = screen.getByTestId('control-fittrace') as HTMLButtonElement

    expect(fitTrace.disabled).toBe(false)
    expect(fitTrace.getAttribute('data-tooltip')).not.toContain('Load a program first')
  })
})
