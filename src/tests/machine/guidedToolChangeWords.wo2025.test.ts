// @vitest-environment jsdom
//
// WO-2025: the guided tool change says what it does. Driven on the simulator
// through the production ProgramPanel (the WO-2017 staged-M6 harness):
//   1. the M6 hold console no longer tells the operator to set the work Z zero;
//   2. the card names the setter;
//   3. after Continue one console line gives the measured length and the offset.
// (The path check across the guided excursion is WO-2033's.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')

const SIM_ID = 'wo2025-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 60, y: 70, z: -20 }
const SAFE_Z = -2
const PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X40 F6000', 'M30'].join('\n')

async function advance(ms: number): Promise<void> {
  const { act } = await import('@testing-library/react')
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text)
const holdLine = () => consoleText().find((l) => l.includes('is finished') && l.includes('retracted clear'))

beforeEach(async () => {
  vi.useFakeTimers()
  mem.clear()
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null })
  useMachineToolTable.setState({ byMachine: {} })
  const { positionMacroBody } = await import('../../types')
  const { useMachineActions } = await import('../../store/machineActionsStore')
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: SIM_ID,
    name: 'WO-2025 simulator',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros: [{
      id: PARK.id,
      name: PARK.label,
      body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
      usedForToolChange: true,
    }],
    safeZMachine: SAFE_Z,
  } as never)
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  useMachineControl.getState().clearConsole()
  __resetEstopInterlockForTest()
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  const tools = useMachineToolTable.getState()
  tools.recordProbedZ(SIM_ID, 1, -42, 1)
  tools.setReference(SIM_ID, 1)
  tools.setProbeConfig(SIM_ID, { maxTravel: 50 })
})

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  cancelGuidedToolChange()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-2025: the guided tool change says what it does', () => {
  it('the words match what the guided change does', async () => {
    const { createElement } = await import('react')
    const { fireEvent, render, screen } = await import('@testing-library/react')
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    render(createElement(ProgramPanel))
    expect(loadGcodeTextToolpathProgram('words.nc', PROGRAM).ok).toBe(true)
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    // The simulator speaks the text spindle route: the app cannot stop the spindle,
    // so the hold still hands it to the operator (review FAIL, opus-critic).
    const hold = holdLine()
    expect(hold).toContain('This app has no link to the spindle, so it cannot stop it - switch it off at the machine.')
    expect(hold).toContain('Z work zero is not changed')
    expect(hold).not.toMatch(/then set the .* Z work zero/)

    const card = useMachineControl.getState().toolChange
    expect(card?.step).toBe('awaiting-swap')
    expect(card?.message).toContain('tool setter')
    expect(card?.message).not.toContain('right where the machine is parked')

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    for (let t = 0; t <= 20000 && useMachineControl.getState().job.phase !== 'complete'; t += 10) await advance(10)
    expect(useMachineControl.getState().job.phase).toBe('complete')

    const lines = consoleText()
    expect(lines.some((l) => /then set the .* Z work zero/.test(l))).toBe(false)
    expect(lines.some((l) => l.includes('Z work zero is not changed'))).toBe(true)
    const measured = lines.filter((l) => /^T2 measured: contact at machine Z .* Tool length offset .* mm applied\.$/.test(l))
    expect(measured).toHaveLength(1)
  })

  it('a macro bound to M6 runs first, and the hold still does not tell the operator to re-zero Z', async () => {
    const { createElement } = await import('react')
    const { fireEvent, render, screen } = await import('@testing-library/react')
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      macros: [...(machine.macros ?? []), { id: 'm6-shoe', name: 'Dust shoe off', mCode: 6, body: 'say("shoe off")' }],
    } as never)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    render(createElement(ProgramPanel))
    expect(loadGcodeTextToolpathProgram('prelude.nc', PROGRAM).ok).toBe(true)
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    expect(consoleText().some((l) => l.includes('Macro "Dust shoe off" (M6) has ended'))).toBe(true)
    expect(holdLine()).toContain('switch it off at the machine')
    expect(holdLine()).toContain('Z work zero is not changed')
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
    fireEvent.click(screen.getByTestId('control-tc-continue'))
    for (let t = 0; t <= 20000 && useMachineControl.getState().job.phase !== 'complete'; t += 10) await advance(10)
    expect(useMachineControl.getState().job.phase).toBe('complete')

    const lines = consoleText()
    expect(lines.some((l) => /then set the .* Z work zero/.test(l))).toBe(false)
    expect(lines.some((l) => l.includes('Z work zero is not changed'))).toBe(true)
    expect(lines.filter((l) => /^T2 measured: contact at machine Z .* Tool length offset .* mm applied\.$/.test(l))).toHaveLength(1)
  })

  it('does not promise a setter measure at the hold when the machine has no safe Z', async () => {
    const { createElement } = await import('react')
    const { render } = await import('@testing-library/react')
    const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
    const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({ ...machine, safeZMachine: null } as never)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    render(createElement(ProgramPanel))
    expect(loadGcodeTextToolpathProgram('nosafez.nc', PROGRAM).ok).toBe(true)
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)
    const lines = consoleText()
    expect(lines.some((l) => l.includes('safe Z for the tool-change park'))).toBe(true)
    expect(lines.some((l) => l.includes('is measured at the setter'))).toBe(false)
    expect(lines.some((l) => /^T\d+ measured: contact/.test(l))).toBe(false)
  })

  it('on a controller that stops the spindle, the hold says it is stopped and does not ask for a Z zero', async () => {
    const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    // The calls route (the UC100's): the controller declares spindle calls.
    const ctrl = getMachineController() as unknown as {
      capabilities: { spindleCommands: boolean }
      spindleOn?: () => boolean
      spindleOff?: () => void
    }
    ctrl.capabilities.spindleCommands = true
    const spindleOff = vi.fn()
    ctrl.spindleOn = () => true
    ctrl.spindleOff = spindleOff
    try {
      expect(loadGcodeTextToolpathProgram('calls.nc', PROGRAM).ok).toBe(true)
      expect(getMachineController().startJob()).toBe(true)
      await advance(4000)
      const hold = holdLine()
      expect(hold).toContain('the tool has retracted clear and the spindle is stopped.')
      expect(hold).toContain('Z work zero is not changed')
      expect(hold).not.toMatch(/then set the .* Z work zero/)
      expect(hold).not.toContain('cannot stop it')
      expect(spindleOff).toHaveBeenCalled()
    } finally {
      ctrl.capabilities.spindleCommands = false
      delete ctrl.spindleOn
      delete ctrl.spindleOff
    }
  })
})

describe('WO-2025: describeToolChangeHold keeps every spindle clause when the change measures', () => {
  const hold = { finishedName: 'Section 1 (G54)', nextName: 'Section 2', wcs: 'G54', leaving: 'T1', fit: 'T2' }
  const spindle = { rpm: 18000, direction: 'cw' as const }

  it('text route: the switch-off clause and the speed to start at are unchanged', async () => {
    const { describeToolChangeHold } = await import('../../lib/program/multiSetupProgram')
    const manual = describeToolChangeHold(hold, false, spindle)
    const guided = describeToolChangeHold(hold, false, spindle, true)
    const switchOff = 'This app has no link to the spindle, so it cannot stop it - switch it off at the machine.'
    expect(manual).toContain(switchOff)
    expect(guided).toContain(switchOff)
    expect(guided).toContain('at 18000 RPM CW')
    expect(guided).toContain('G54 Z work zero is not changed; the new tool is measured at the setter.')
    expect(guided).not.toMatch(/then set the .* Z work zero/)
    expect(manual).toMatch(/then set the G54 Z work zero/)
    // Continue measures and resumes in one press: no promised step in between.
    expect(guided).toContain('Continue measures it and the program resumes at once, with no stop in between.')
    expect(guided).not.toContain('once it is measured')
    expect(guided).not.toContain('before the program resumes')
  })

  it('calls route: "the spindle is stopped" is unchanged', async () => {
    const { describeToolChangeHold } = await import('../../lib/program/multiSetupProgram')
    const stopped = 'Section 1 (G54) is finished, the tool has retracted clear and the spindle is stopped.'
    expect(describeToolChangeHold(hold, true, spindle).startsWith(stopped)).toBe(true)
    const guided = describeToolChangeHold(hold, true, spindle, true)
    expect(guided.startsWith(stopped)).toBe(true)
    expect(guided).toContain('Take T1 out and fit T2 - the G54 Z work zero is not changed')
    expect(guided).not.toMatch(/then set the .* Z work zero/)
  })
})
