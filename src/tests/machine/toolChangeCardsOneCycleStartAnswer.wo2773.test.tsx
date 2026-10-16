// @vitest-environment jsdom
//
// WO-2773 (Operator 2026-10-13, card Q-TOOL-CHANGE-CARDS-WHICH-WAY-SHOU: "A -
// Continue on both"): the guided tool-change card and the M2001 "Park + clamp"
// card answer "does CYCLE START continue?" the same way - no, the card's
// Continue is the one door. Desk kit 2026-10-08: during a guided change
// CYCLE START was greyed with "The tool-change card continues this program,
// not CYCLE START.", while the clamp card said "press CYCLE START or Continue
// to run the rest" with CYCLE START lit and the line under the bar reading
// "Cycle Start continues".
//
// Driven through the real session on the simulator with ProgramPanel (the
// card) and ControlTransportBar (the line under the bar, CYCLE START and its
// tip) mounted: the card text, the line, the tip, the button, the session's
// own Cycle Start and Single Block doors, and the console - then Continue on
// the card, which runs the rest exactly as it did.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlStepRow, ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setMachineSingleBlock,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { currentOperatorTransport, executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

type MachineConfig = import('../../types').MachineConfig

const MACHINE_ID = 'wo2773-simulator'
const PARK = { id: 'park-1', label: 'Park 1', x: 5, y: 5, z: -2 }
const GUIDED_PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')
const CLAMP_PROGRAM = ['G21 G90 G54', 'G0 X0 Y0 Z-3', 'M2001', 'G0 X4 Y0 Z-3', 'M30'].join('\n')
/** One answer on both cards: CYCLE START does not continue; Continue does. */
const CARD_OWNS_IT = /^The .+ card continues this program, not CYCLE START\.$/

function configureMachine(controller: MachineConfig['controller']): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2773 simulator',
    // WO-1644: M2001 is a UCCNC user macro; the guided case is the WO-2031 machine.
    controller,
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros: [
      {
        id: PARK.id,
        name: PARK.label,
        body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
        usedForToolChange: true,
      },
      // WO-1743: the record carries its own clamp macro, as the Macros panel adds it.
      { id: 'clamp-pause-m2001', name: 'Clamp pause', mCode: 2001, body: 'clampPause()' },
    ],
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

function cycleStart(): HTMLButtonElement {
  return screen.getByTestId('control-cyclestart') as HTMLButtonElement
}

/** What the operator reads at the card, and the door CYCLE START shows. */
function readCard(): { card: string; line: string; tip: string; lit: boolean } {
  return {
    card: screen.getByTestId('control-tc-message').textContent ?? '',
    line: screen.getByTestId('control-next-action').textContent ?? '',
    tip: cycleStart().getAttribute('data-tooltip') ?? '',
    lit: !cycleStart().disabled,
  }
}

async function connectAndHome(controller: MachineConfig['controller']): Promise<void> {
  configureMachine(controller)
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  act(() => { __resetEstopInterlockForTest() })
  getMachineController().home()
  await advance(2000)
  for (const axis of ['X', 'Y', 'Z'] as const) {
    expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
    await advance(50)
  }
  useMachineControl.getState().clearConsole()
  render(<><ControlTransportBar /><ControlStepRow /><ProgramPanel /></>)
}

async function runTo(name: string, program: string): Promise<void> {
  act(() => { expect(loadGcodeTextToolpathProgram(name, program).ok).toBe(true) })
  await act(async () => { expect(await executeOperatorCycleStart(), consoleText()).toBe(true) })
  await advance(10_000)
}

/** The card is up and the program held at it; every door but Continue stays shut. */
async function cycleStartDoesNotContinue(step: string): Promise<void> {
  const where = () => ({ ...useMachineControl.getState().mpos })
  const before = where()
  const words = readCard()
  expect(words.lit, JSON.stringify(words)).toBe(false)
  expect(words.tip).toMatch(CARD_OWNS_IT)
  expect(words.line).toContain('press Continue on the')
  expect(words.line).not.toMatch(/cycle start/i)
  expect(words.card).toContain('press Continue')
  expect(words.card).not.toMatch(/cycle start/i)
  expect(currentOperatorTransport()).toMatchObject({ action: 'none', cycleStartEnabled: false })

  // The button, the shortcut's executor and the session's own doors all refuse.
  fireEvent.click(cycleStart())
  await act(async () => { expect(await executeOperatorCycleStart()).toBe(false) })
  useMachineControl.getState().clearConsole()
  act(() => { expect(getMachineController().cycleResume()).toBe(false) })
  expect(consoleText()).toMatch(/^Cycle Start: .*\bContinue\b/m)
  act(() => { expect(getMachineController().resumeJob()).toBe(false) })
  act(() => { setMachineSingleBlock(true) })
  expect(readCard()).toMatchObject({ lit: false, line: words.line })
  act(() => { expect(getMachineController().stepJob()).toBe(false) })
  act(() => { setMachineSingleBlock(false) })
  await advance(2000)
  expect(where()).toEqual(before)
  expect(useMachineControl.getState().job.phase).toBe('paused')
  expect(useMachineControl.getState().toolChange?.step).toBe(step)
}

describe('WO-2773 both tool-change cards: Continue is the one door', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    setMachineSingleBlock(false)
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  it('guided M6 card: CYCLE START is dark and refused; Continue probes and runs on', async () => {
    await connectAndHome('grbl')
    act(() => { useMachineToolTable.getState().setProbeConfig(MACHINE_ID, { maxTravel: 50 }) })
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    await runTo('wo2773-guided.nc', GUIDED_PROGRAM)
    expect(useMachineControl.getState().toolChange, consoleText()).toMatchObject({ mode: 'toolChange', tool: 2, step: 'awaiting-swap' })

    await cycleStartDoesNotContinue('awaiting-swap')
    expect(readCard().tip).toBe('The tool-change card continues this program, not CYCLE START.')
    expect(readCard().line).toBe('Program held at part 1 of 2 for the T2 tool change - fit T2, then press Continue on the tool-change card')

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20_000)
    expect(useMachineControl.getState().toolChange, consoleText()).toBeNull()
    expect(useMachineControl.getState().job.phase).toBe('complete')
  })

  it('M2001 Park + clamp card: CYCLE START is dark and refused; Continue runs the rest', async () => {
    await connectAndHome('uccnc')
    await runTo('wo2773-clamp.nc', CLAMP_PROGRAM)
    const held = useMachineControl.getState()
    expect(held.toolChange, consoleText()).toMatchObject({ mode: 'clampPause', step: 'awaiting-swap' })
    expect(held.mpos).toMatchObject({ x: PARK.x, y: PARK.y })
    // Nothing said at the clamp hold points at CYCLE START.
    expect(consoleText()).toContain('reached M2001 on line 3: running this machine\'s macro "Clamp pause".')
    expect(consoleText()).not.toMatch(/cycle start/i)

    await cycleStartDoesNotContinue('awaiting-swap')
    expect(readCard()).toMatchObject({
      card: `Parked at "${PARK.label}". Screw down the material without moving its zero, then press Continue to run the rest.`,
      line: 'Program held at part 1 of 2 - screw down the material, then press Continue on the Park + clamp card',
      tip: 'The Park + clamp card continues this program, not CYCLE START.',
    })

    // Continue: the card's own button, unchanged - it runs the rest.
    expect(screen.getByTestId('control-tc-continue').textContent).toBe('Continue - re-arm program')
    fireEvent.click(screen.getByTestId('control-tc-continue'))
    expect(useMachineControl.getState().toolChange).toBeNull()
    await advance(10_000)
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(4, 1)
  })
})
