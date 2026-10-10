// @vitest-environment jsdom
//
// WO-1660: the definition editor and the path check say only what is true.
//
// Two board findings from the 2026-09-17 machine session:
//   (f) after a gantry-skew Save that went LIVE, the editor still read "Saved
//       profile changes are pending and will become live after reconnect."
//   (g) one typed MDI `G53 G0 Z128` printed a "Path check" row plus FIVE
//       "limit:" rows for one obvious move.
//
// The editor half is driven through the real Save gesture. The path-check half
// goes through the MDI box's own entry point (`sendMdiLine`) on the geometry
// simulator - the route Operator's AXBB-E takes.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'

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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

/** Operator's definition shape: Z travel -0.1..129.1, UCCNC, linear error 0.03. */
function sampleMachineLikeMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const [index, axis] of controllerDefinition.axes.entries()) {
    axis.softLimitMin = axis.axis === 'Z' ? -0.1 : 0
    axis.softLimitMax = axis.axis === 'Z' ? 129.1 : 800
    axis.homePin = { port: 1, pin: index + 1, negate: false }
  }
  // Stated via `settings` (not `stated`): the definition is then already in its
  // persisted shape, so a Save does not rewrite it and the editor's note is
  // about the skew alone - exactly the board's state after a real Apply.
  controllerDefinition.settings = [
    ...(controllerDefinition.settings ?? []),
    { controller: 'uccnc' as const, key: 'Generalsettings.Linearerror', value: { kind: 'number' as const, value: 0.03 } },
    ...(['X', 'Y', 'Z'] as const).flatMap((axis) => {
      const configured = controllerDefinition.axes.find((a) => a.axis === axis)!
      return [
        { controller: 'uccnc' as const, key: `liencam.axes.${axis}.softLimitMin`, value: { kind: 'number' as const, value: configured.softLimitMin } },
        { controller: 'uccnc' as const, key: `liencam.axes.${axis}.softLimitMax`, value: { kind: 'number' as const, value: configured.softLimitMax } },
      ]
    }),
  ]
  return makeMachine({
    id: 'wo-1660-machine',
    name: 'WO-1660 machine',
    controller: 'uccnc',
    travel: { x: 800, y: 800, z: 200 },
    rapidRate: 3000,
    noHomingSwitches: false,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    controllerDefinition,
  })
}

function install(target: MachineConfig, pinned: boolean): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: pinned ? target : null,
      appliedMachine: null,
      sessionActiveMachineId: pinned ? target.id : undefined,
    },
  })
}

// ---------------------------------------------------------------------------
// The editor's authority note.

describe('WO-1660 the editor says only what is true', () => {
  let originalLibrary: MachineConfig[]
  let originalMachine: MachineConfig

  beforeEach(() => {
    originalLibrary = useCamStore.getState().machineLibrary
    originalMachine = useCamStore.getState().project.machine
    install(sampleMachineLikeMachine(), true)
    useMachineControl.setState({ connectionPhase: 'connected', connectionKind: 'simulator', consoleLines: [] })
  })

  afterEach(() => {
    cleanup()
    useCamStore.setState((state) => ({
      machineLibrary: originalLibrary,
      project: { ...state.project, machine: originalMachine },
      control: { activeMachineId: null, sessionMachine: null, appliedMachine: null, sessionActiveMachineId: undefined },
    }))
    useMachineControl.setState({ connectionPhase: 'disconnected', connectionKind: null, consoleLines: [] })
  })

  it('a saved skew the bridge applied live does not read "pending until reconnect"', () => {
    render(<MachineDefinitionPanel connectionKind="simulator" />)
    const status = () => screen.getByTestId('machine-def-panel-authority-status')

    // WO-1690: skew moved off Travel & Homing onto the outer Machine tab,
    // standalone below the axis table.
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))
    fireEvent.change(screen.getByTestId('machine-def-skew-offset'), { target: { value: '0.12' } })
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))

    const machineId = useCamStore.getState().machineLibrary[0].id
    expect(useCamStore.getState().machineLibrary.find((m) => m.id === machineId)?.skew)
      .toEqual({ offsetMm: 0.12 })
    expect(status().getAttribute('data-authority-state')).not.toBe('pending')
    expect(status().textContent).not.toMatch(/pending.*reconnect/i)
  })

  it('a saved profile change the bridge does NOT apply live still reads pending', () => {
    render(<MachineDefinitionPanel connectionKind="simulator" />)
    const status = () => screen.getByTestId('machine-def-panel-authority-status')

    // A record-level save of a reconnect-bound field (rapid rate lives in the
    // Machine Library modal, not this panel) - the panel reads the record, so
    // the same saved-vs-live difference is what the note is about.
    act(() => {
      const current = useCamStore.getState().machineLibrary[0]
      useCamStore.getState().updateMachineInLibrary(current.id, { ...current, rapidRate: 6000 })
    })

    expect(status().getAttribute('data-authority-state')).toBe('pending')
    expect(status().textContent).toMatch(/pending.*reconnect/i)
  })
})

// ---------------------------------------------------------------------------
// The path check over one MDI move.

describe('WO-1660 one MDI move prints at most one path-check row', () => {
  let originalProject: Project
  let originalLibrary: MachineConfig[]
  let originalControl: ReturnType<typeof useCamStore.getState>['control']

  const SAMPLE_MACHINE_G54 = { x: 0, y: 0, z: 110 }

  beforeEach(async () => {
    vi.useFakeTimers()
    originalProject = useCamStore.getState().project
    originalLibrary = useCamStore.getState().machineLibrary
    originalControl = useCamStore.getState().control
    install(sampleMachineLikeMachine(), false)
    useMachineControl.setState({ consoleLines: [] })

    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    const ctrl = getMachineController()
    if (!ctrl.home()) throw new Error('simulator refused home')
    await vi.advanceTimersByTimeAsync(2_000)
    // WO-2004: G54 is written through the session's own work-offset route, so
    // the controller and the session agree on it - as they do on the bridge.
    // Writing it to the session store alone left the simulator's G54 at zero,
    // and a G53 move that correctly lands at machine Z128 then read as work
    // Z128 against an expected work Z18: a false 110 mm departure.
    for (const [axis, mm] of [['X', SAMPLE_MACHINE_G54.x], ['Y', SAMPLE_MACHINE_G54.y], ['Z', SAMPLE_MACHINE_G54.z]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(10)
    }
    // The geometry route: Operator's AXBB-E takes no G-code text.
    Object.defineProperty(ctrl, 'capabilities', {
      configurable: true,
      value: { ...ctrl.capabilities, gcodeText: false },
    })
  })

  afterEach(async () => {
    const ctrl = getMachineController()
    Reflect.deleteProperty(ctrl, 'capabilities')
    if (ctrl.connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    }
    useCamStore.setState({ project: originalProject, machineLibrary: originalLibrary, control: originalControl })
    useMachineControl.setState({ consoleLines: [] })
    vi.useRealTimers()
  })

  function pathRowsSince(index: number): string[] {
    return useMachineControl.getState().consoleLines
      .slice(index)
      .map((line) => line.text)
      .filter((text) => text.startsWith('Path check') || text.startsWith('  limit: '))
  }

  async function runLine(line: string): Promise<string[]> {
    const before = useMachineControl.getState().consoleLines.length
    expect(sendMdiLine(line)).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    return pathRowsSince(before)
  }

  it('a move fully inside travel prints no path-check row', async () => {
    const rows = await runLine('G53 G0 Z128')
    expect(rows).toEqual([])
  })

  it('a move that ends at the travel limit prints exactly one row', async () => {
    const rows = await runLine('G53 G0 Z129.1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/Z travel limit/)
  })
})
