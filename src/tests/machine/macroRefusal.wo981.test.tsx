// @vitest-environment jsdom
// WO-981: a refused macro press must show the session's OWN refusal
// sentence, never a second opinion invented by the panel.
//
// WO-1707: a custom button is a macro now, and every press - macro or
// former custom button - runs through the real macro runtime
// (`lib/machine/macros/macroRuntime.ts`); a former button's body is one
// `lines(...)` call, which reaches the board through `runMachineAction` - the
// SAME path the button always took, and the one place that owns the refusal
// wording (ACTION_REFUSAL, WO-963). Mocking `machineSession`
// wholesale (the pre-1707 version of this file) breaks that: macroRuntime
// imports several of its own functions from the same module, and a partial
// mock leaves them undefined. This proves the same claim - the panel adds no
// gate and invents no reason - against the REAL session on the simulator.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacroPanel } from '../../components/machine/MacroPanel'
import { createDefaultControllerDefinition } from '../../types'
import { useCamStore } from '../../store'
import { useMachineActions } from '../../store/machineActionsStore'
import { useMachineControl } from '../../store/machineControlStore'
import {
  ACTION_REFUSAL,
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} from '../../lib/machine/machineSession'
import { __resetMacroRuntimeForTest } from '../../lib/machine/macros/macroRuntime'
import { executePendantMachineCommand } from '../../lib/machine/pendantMachine'

const ESTOP_SENTENCE = ACTION_REFUSAL.estop

const MACHINE_ID = 'wo981-machine'

// Each seed moves onto the machine record at once (WO-1707's one-time move),
// so a second seed needs its own id - the move never re-adds an id the record
// already carries.
function seedVacuumButton(lines: string[] = ['M8'], id = 'vacuum'): void {
  useMachineActions.setState({
    byMachine: {
      [MACHINE_ID]: {
        overrides: {},
        custom: [{ id, label: 'Vacuum', color: 'green', lines }],
        parks: [],
      },
    },
    macroArrangementByMachine: {},
  })
}

async function connect(): Promise<void> {
  vi.useFakeTimers()
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-981 test bench',
    controller: 'grbl',
    controllerDefinition: createDefaultControllerDefinition(),
    unsentSettings: undefined,
    travel: { x: 738, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
  seedVacuumButton()
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(50)
  act(() => { __resetEstopInterlockForTest() })
  useMachineControl.setState({ consoleLines: [] })
}

function renderPanel(): void {
  render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

async function press(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`control-user-macro-${id}`))
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
}

beforeEach(async () => {
  await connect()
})

afterEach(async () => {
  cleanup()
  __resetMacroRuntimeForTest()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

describe('WO-981/WO-1707: MacroPanel reports the session refusal, never its own', () => {
  it('renders the E-STOP sentence in the console after a refused macro press', async () => {
    act(() => { __armEstopInterlockForTest() })
    renderPanel()

    await press('vacuum')

    expect(consoleText()).toContain(ESTOP_SENTENCE)
  })

  // WO-1707 fix round: restored from the pre-1707 file. A line the transport
  // could not send must NOT blame the E-STOP (WO-474 item 1 / WO-963) - here
  // on the real session, the board refusing the line itself.
  it('renders a transport refusal without inventing an E-STOP cause', async () => {
    renderPanel()
    const refuse = vi.spyOn(getMachineController(), 'sendCommand').mockReturnValue(false)

    await press('vacuum')

    expect(refuse).toHaveBeenCalledWith('M8')
    expect(consoleText()).toContain(ACTION_REFUSAL.notSent)
    expect(consoleText()).not.toMatch(/E-STOP/)
    refuse.mockRestore()
  })

  it.each(['M5', 'M9'])('adds no panel gate before the stop command %s - it passes even under the latch', async (line) => {
    seedVacuumButton([line], `stop-${line}`)
    act(() => { __armEstopInterlockForTest() })
    renderPanel()

    await press(`stop-${line}`)

    expect(consoleText()).not.toContain(ESTOP_SENTENCE)
  })
})

describe('WO-981: pendant spindle refusal retains the session reason', () => {
  it('passes the exact refusal sentence through instead of inventing an E-STOP cause of its own', async () => {
    act(() => { __armEstopInterlockForTest() })

    const outcome = await executePendantMachineCommand(
      { kind: 'spindle', direction: 'cw' },
      { clientId: 'phone-a', emit: vi.fn() },
    )

    expect(outcome).toEqual({ ok: false, error: ESTOP_SENTENCE })
  })
})
