// @vitest-environment jsdom
//
// WO-2016: a program that needs a reference tool says so at Load.
//
// Operator's 09-25 session: with no reference tool measured on the setter, the
// first mid-program M6 of his job (line 9908 of 49,549) could only print
// "cannot run the fixed-pad tool change: Measure a reference tool on the pad
// first" when the machine got there. Here a two-tool program runs on the
// simulator through the real session and the rendered Program panel, on both
// file doors loadGcodeFile picks (the text stream, and the staged program the
// machine bridge runs):
//  - Load says it once, naming the M6 line and the one action that fixes it;
//  - Cycle Start from the top points back to it and is not refused;
//  - measuring the reference ends it, and the M6 then runs its guided change
//    and the program runs to M30.
// The negative control: started without measuring, the M6 still fails there
// exactly as before - the Load line was telling the truth.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
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

const { controlMachine, useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
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
  loadGcodeFile,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const MACHINE_ID = 'wo2016-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
const NOTICE = 'Measure a reference tool on the setter first'
const POINTER = 'Cycle Start: no reference tool is measured yet'
const MID_PROGRAM_FAILURE = /cannot run the fixed-pad tool change/

/** Two tools, T1 fitted at the top, T2's M6 after T1 has cut. `staged` retracts
 *  for the change with a Fusion-style G53, and carries G91.1 (the interpreter's
 *  default arc mode, a no-op there) - a word the simulator's text reader
 *  refuses since WO-2437 taught it G53 - so the file door reads it through the
 *  interpreter the machine bridge uses (WO-1977). */
function twoToolProgram(staged: boolean, secondChange = 'M6'): string {
  const lines = staged ? ['G21', 'G90', 'G91.1', 'G17'] : ['G21', 'G90', 'G17']
  for (const tool of [1, 2]) {
    if (tool === 2) lines.push('M5', staged ? 'G53 G0 Z0.' : 'G0 Z-1')
    lines.push(`(Op T${tool})`, `T${tool} ${tool === 2 ? secondChange : 'M6'}`, 'G54', 'S12000 M3',
      `G0 X${tool * 10} Y${tool * 10}`, 'G1 Z-3 F1000', `G1 X${tool * 10 + 5} F6000`, 'G0 Z-1')
  }
  lines.push('M5', 'M30')
  return lines.join('\n')
}

function lineOf(text: string, content: string): number {
  return text.split('\n').indexOf(content) + 1
}

/** Audit (fix round): a machine-bound M-code whose macro calls `toolChange()`
 *  runs the same fixed-pad change as M6 (WO-1652). */
const TOOL_CHANGE_MACRO = { id: 'tc-1600', name: 'Tool change here', mCode: 1600, body: 'toolChange()' }

function configureMachine(withToolChangeMacro = true, extraMacros: readonly typeof TOOL_CHANGE_MACRO[] = []): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2016 simulator',
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
      usedForToolChange: withToolChangeMacro,
    }, ...extraMacros],
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function consoleText(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

function writeEvidence(name: string, evidence: unknown): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const directory = join(process.cwd(), 'src/tests/evidence/WO-2016')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`)
}

/** Measure T1 on the setter and make it the reference - what the Tools / Probe
 *  panel's measure writes into this machine's table. */
function measureReference(): void {
  const tools = useMachineToolTable.getState()
  tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
  tools.setReference(MACHINE_ID, 1)
}

interface RunRecord {
  started: boolean
  guidedStops: { tool: number | null; resumeLine: number }[]
  heldWithoutCard: boolean
  phase: string
}

/** CYCLE START as the transport button presses it, then play the operator:
 *  Continue on each tool-change card (the probe measures the fitted tool),
 *  CYCLE START on any other stop (a pause, the spindle the machine cannot start). A hold that never becomes a card is where the old failure
 *  stopped the program - recorded and left there. */
async function run(): Promise<RunRecord> {
  const record: RunRecord = { started: false, guidedStops: [], heldWithoutCard: false, phase: '' }
  await act(async () => { record.started = await executeOperatorCycleStart() })
  for (let tick = 0; tick < 120 && record.started; tick++) {
    await advance(500)
    const s = useMachineControl.getState()
    if (s.job.phase === 'complete' && s.machineState === 'idle' && s.toolChange === null) break
    if (record.guidedStops.length > 3) break
    if (s.toolChange?.step === 'awaiting-swap') {
      record.guidedStops.push({ tool: s.toolChange.tool, resumeLine: s.toolChange.resumeLine })
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)
    } else if (consoleText().some((line) => MID_PROGRAM_FAILURE.test(line))) {
      record.heldWithoutCard = true
      break
    } else if (s.toolChange === null && (s.machineState === 'hold' || s.job.phase === 'paused')) {
      await act(async () => { await executeOperatorCycleStart() })
    }
  }
  record.phase = useMachineControl.getState().job.phase
  return record
}

/** Connect the simulator to the machine Control runs, homed, G54 at zero. */
async function connectSimulator(): Promise<void> {
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  act(() => { __resetEstopInterlockForTest() })
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  for (const axis of ['X', 'Y', 'Z'] as const) {
    // WO-2037: Z 10 mm below the top of travel, so a longer tool's applied
    // length still has room at the retract height (a real controller refuses
    // a move past the top, as the simulator now does).
    expect(setWorkOffsetValue('G54', axis, axis === 'Z' ? -10 : 0)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
  }
  useMachineToolTable.getState().setProbeConfig(MACHINE_ID, { maxTravel: 50 })
  useMachineControl.getState().clearConsole()
}

async function disconnectSimulator(): Promise<void> {
  const disconnected = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await disconnected
}

describe('WO-2016 a program that needs a reference tool says so at Load', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    // Control follows the project's machine, and no library record carries a
    // reference measured by an earlier test (`controlRunsAnotherMachine`).
    const state = useCamStore.getState()
    useCamStore.setState({
      machineLibrary: [],
      control: {
        ...state.control,
        activeMachineId: null,
        sessionMachine: null,
        appliedMachine: null,
        sessionActiveMachineId: undefined,
      },
    })
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine()
    await connectSimulator()
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    await disconnectSimulator()
    vi.useRealTimers()
  })

  for (const staged of [false, true]) {
    const door = staged ? 'program' : 'text'

    it(`${door} door: Load says it once, measuring clears it, and the M6 runs its change to M30`, async () => {
      const text = twoToolProgram(staged)
      const t2 = lineOf(text, 'T2 M6')
      render(createElement(ProgramPanel))
      let outcome: ReturnType<typeof loadGcodeFile> | null = null
      act(() => { outcome = loadGcodeFile('two-tools.nc', text, null) })
      expect(outcome!.door).toBe(door)
      const atLoad = consoleText()
      const notices = atLoad.filter((line) => line.includes(NOTICE))
      expect(notices, JSON.stringify(atLoad)).toHaveLength(1)
      expect(notices[0]).toContain(`line ${t2} (T2)`)
      expect(useMachineControl.getState().programReadiness.ready, JSON.stringify(atLoad)).toBe(true)

      act(() => { measureReference() })
      const cleared = consoleText().filter((line) => line.startsWith('Reference tool measured'))
      expect(cleared).toHaveLength(1)
      expect(cleared[0]).toContain(`line ${t2} (T2)`)

      const record = await run()
      const all = consoleText()
      writeEvidence(`${door}-measured.json`, { door, program: text.split('\n'), ...record, console: all })
      const detail = JSON.stringify({ ...record, console: all.slice(-12) })
      expect(record.started, detail).toBe(true)
      expect(all.some((line) => line.startsWith(POINTER)), detail).toBe(false)
      expect(all.some((line) => MID_PROGRAM_FAILURE.test(line)), detail).toBe(false)
      expect(all.filter((line) => line.includes(NOTICE)), detail).toHaveLength(1)
      expect(record.guidedStops.map((stop) => stop.tool), detail).toEqual([2])
      expect(record.phase, detail).toBe('complete')
    }, 60000)

    it(`${door} door: unmeasured, Cycle Start points back and is not refused; the M6 is where it would fail`, async () => {
      const text = twoToolProgram(staged)
      const t2 = lineOf(text, 'T2 M6')
      render(createElement(ProgramPanel))
      act(() => { loadGcodeFile('two-tools.nc', text, null) })
      expect(consoleText().filter((line) => line.includes(NOTICE))).toHaveLength(1)

      const record = await run()
      const all = consoleText()
      writeEvidence(`${door}-unmeasured.json`, { door, program: text.split('\n'), ...record, console: all })
      const detail = JSON.stringify({ ...record, console: all.slice(-12) })
      expect(record.started, detail).toBe(true)
      const pointers = all.filter((line) => line.startsWith(POINTER))
      expect(pointers, detail).toHaveLength(1)
      expect(pointers[0]).toContain(`line ${t2} (T2)`)
      // The control: nothing measured, so the change still cannot measure T2 -
      // the program is held at its M6, the thing Load warned about.
      expect(record.heldWithoutCard, detail).toBe(true)
      expect(record.guidedStops, detail).toEqual([])
    }, 60000)
  }

  for (const staged of [false, true]) {
    it(`a bound M1600 whose macro calls toolChange() (${staged ? 'G53 retract' : 'plain retract'}): Load names it; measuring clears it; the change runs to M30`, async () => {
      configureMachine(true, [TOOL_CHANGE_MACRO])
      const text = twoToolProgram(staged, 'M1600')
      const t2 = lineOf(text, 'T2 M1600')
      render(createElement(ProgramPanel))
      act(() => { loadGcodeFile('macro-change.nc', text, null) })
      const atLoad = consoleText()
      const notices = atLoad.filter((line) => line.includes(NOTICE))
      expect(notices, JSON.stringify(atLoad)).toHaveLength(1)
      expect(notices[0]).toContain(`line ${t2} (T2)`)

      act(() => { measureReference() })
      expect(consoleText().filter((line) => line.startsWith('Reference tool measured'))).toHaveLength(1)

      const record = await run()
      const all = consoleText()
      const detail = JSON.stringify({ ...record, console: all.slice(-12) })
      expect(record.started, detail).toBe(true)
      expect(all.some((line) => MID_PROGRAM_FAILURE.test(line)), detail).toBe(false)
      expect(record.guidedStops.map((stop) => stop.tool), detail).toEqual([2])
      expect(record.phase, detail).toBe('complete')
    }, 60000)
  }

  it('a bound M1600 whose macro calls toolChange(), unmeasured: Cycle Start points to it; the change is where it would fail', async () => {
    configureMachine(true, [TOOL_CHANGE_MACRO])
    const text = twoToolProgram(false, 'M1600')
    const t2 = lineOf(text, 'T2 M1600')
    render(createElement(ProgramPanel))
    act(() => { loadGcodeFile('macro-change.nc', text, null) })
    expect(consoleText().filter((line) => line.includes(NOTICE))).toHaveLength(1)

    const record = await run()
    const all = consoleText()
    const detail = JSON.stringify({ ...record, console: all.slice(-12) })
    const pointers = all.filter((line) => line.startsWith(POINTER))
    expect(pointers, detail).toHaveLength(1)
    expect(pointers[0]).toContain(`line ${t2} (T2)`)
    expect(record.heldWithoutCard, detail).toBe(true)
    expect(record.guidedStops, detail).toEqual([])
  }, 60000)

  // Architect re-scope: Load reads the tool changes the loaded program will
  // run and asks the hold's own reference check - a macro bound to M6 (run as
  // the change's prelude), and Control running another machine than CAM's.
  const M6_PRELUDE = { id: 'm6-prelude', name: 'Dust shoe up', mCode: 6, body: 'say("dust shoe up")' }

  for (const staged of [false, true]) {
    it(`a macro bound to M6 (${staged ? 'G53 retract' : 'plain retract'}): Load names the M6; measuring clears it; the change runs to M30`, async () => {
      configureMachine(true, [M6_PRELUDE])
      const text = twoToolProgram(staged)
      const t2 = lineOf(text, 'T2 M6')
      render(createElement(ProgramPanel))
      act(() => { loadGcodeFile('m6-prelude.nc', text, null) })
      const atLoad = consoleText()
      const notices = atLoad.filter((line) => line.includes(NOTICE))
      expect(notices, JSON.stringify(atLoad)).toHaveLength(1)
      expect(notices[0]).toContain(`line ${t2} (T2)`)

      act(() => { measureReference() })
      expect(consoleText().filter((line) => line.startsWith('Reference tool measured'))).toHaveLength(1)

      const record = await run()
      const all = consoleText()
      const detail = JSON.stringify({ ...record, console: all.slice(-12) })
      expect(record.started, detail).toBe(true)
      expect(all.some((line) => MID_PROGRAM_FAILURE.test(line)), detail).toBe(false)
      expect(record.guidedStops.map((stop) => stop.tool), detail).toEqual([2])
      expect(record.phase, detail).toBe('complete')
    }, 60000)
  }

  it('a macro bound to M6, unmeasured: Cycle Start points to the M6; after the prelude the change is where it would fail', async () => {
    configureMachine(true, [M6_PRELUDE])
    const text = twoToolProgram(true)
    const t2 = lineOf(text, 'T2 M6')
    render(createElement(ProgramPanel))
    act(() => { loadGcodeFile('m6-prelude.nc', text, null) })
    expect(consoleText().filter((line) => line.includes(NOTICE))).toHaveLength(1)

    const record = await run()
    const all = consoleText()
    const detail = JSON.stringify({ ...record, console: all.slice(-12) })
    const pointers = all.filter((line) => line.startsWith(POINTER))
    expect(pointers, detail).toHaveLength(1)
    expect(pointers[0]).toContain(`line ${t2} (T2)`)
    expect(record.heldWithoutCard, detail).toBe(true)
    expect(record.guidedStops, detail).toEqual([])
  }, 60000)

  /** Control runs the machine that binds M1600 to `toolChange()`; the CAM
   *  project's machine is another one, with no such macro and no park. With
   *  `controlHasSetter` false it is the other way round: Control's machine has
   *  no tool setter (its park is not the fixed pad), and CAM's has one. */
  async function controlRunsAnotherMachine(controlHasSetter = true): Promise<void> {
    await disconnectSimulator()
    configureMachine(!controlHasSetter, [TOOL_CHANGE_MACRO])
    const withSetter = useCamStore.getState().project.machine
    configureMachine(controlHasSetter, [TOOL_CHANGE_MACRO])
    const controlled = useCamStore.getState().project.machine
    const cam = {
      ...controlled,
      id: 'wo2016-cam',
      name: 'WO-2016 CAM machine',
      macros: controlHasSetter ? [] : withSetter.macros,
    }
    const state = useCamStore.getState()
    useCamStore.setState({
      machineLibrary: [controlled],
      project: { ...state.project, machine: cam },
      control: {
        ...state.control,
        activeMachineId: controlled.id,
        sessionMachine: null,
        appliedMachine: null,
        sessionActiveMachineId: undefined,
      },
    })
    await connectSimulator()
    expect(controlMachine(useCamStore.getState()).id).toBe(MACHINE_ID)
    expect(useCamStore.getState().project.machine.id).not.toBe(MACHINE_ID)
  }

  for (const staged of [false, true]) {
    it(`Control runs another machine than CAM's, its bound M1600 (${staged ? 'G53 retract' : 'plain retract'}): Load names it; measuring clears it; the change runs to M30`, async () => {
      await controlRunsAnotherMachine()
      const text = twoToolProgram(staged, 'M1600')
      const t2 = lineOf(text, 'T2 M1600')
      render(createElement(ProgramPanel))
      act(() => { loadGcodeFile('control-machine.nc', text, null) })
      const atLoad = consoleText()
      const notices = atLoad.filter((line) => line.includes(NOTICE))
      expect(notices, JSON.stringify(atLoad)).toHaveLength(1)
      expect(notices[0]).toContain(`line ${t2} (T2)`)

      act(() => { measureReference() })
      expect(consoleText().filter((line) => line.startsWith('Reference tool measured'))).toHaveLength(1)

      const record = await run()
      const all = consoleText()
      const detail = JSON.stringify({ ...record, console: all.slice(-12) })
      expect(record.started, detail).toBe(true)
      expect(all.some((line) => MID_PROGRAM_FAILURE.test(line)), detail).toBe(false)
      expect(record.guidedStops.map((stop) => stop.tool), detail).toEqual([2])
      expect(record.phase, detail).toBe('complete')
    }, 60000)
  }

  it('Control runs another machine than CAM\'s, unmeasured: Cycle Start points to its M1600; the change is where it would fail', async () => {
    await controlRunsAnotherMachine()
    const text = twoToolProgram(false, 'M1600')
    const t2 = lineOf(text, 'T2 M1600')
    render(createElement(ProgramPanel))
    act(() => { loadGcodeFile('control-machine.nc', text, null) })
    expect(consoleText().filter((line) => line.includes(NOTICE))).toHaveLength(1)

    const record = await run()
    const all = consoleText()
    const detail = JSON.stringify({ ...record, console: all.slice(-12) })
    const pointers = all.filter((line) => line.startsWith(POINTER))
    expect(pointers, detail).toHaveLength(1)
    expect(pointers[0]).toContain(`line ${t2} (T2)`)
    expect(record.heldWithoutCard, detail).toBe(true)
    expect(record.guidedStops, detail).toEqual([])
  }, 60000)

  it('a bound macro that never calls toolChange(): nothing is said', () => {
    configureMachine(true, [{ ...TOOL_CHANGE_MACRO, body: 'say("clamp check")' }])
    act(() => { loadGcodeFile('macro-say.nc', twoToolProgram(false, 'M1600').replace('T1 M6', 'T1'), null) })
    expect(consoleText().some((line) => line.includes(NOTICE))).toBe(false)
  })

  it('a reference measured before Load: nothing is said', () => {
    measureReference()
    act(() => { loadGcodeFile('two-tools.nc', twoToolProgram(false), null) })
    expect(consoleText().some((line) => line.includes(NOTICE))).toBe(false)
  })

  // Architect 2026-09-26 10:08 PM CT (Operator kept the order on "the Load line
  // shows only on a machine with a tool setter set up"): a machine with no
  // tool setter - no park flagged as the fixed pad - never shows the line, on
  // any route, and Cycle Start points to nothing. Its M6 measures nothing, so
  // the run never stops for a missing reference either.
  const NO_SETTER_ROUTES: readonly { name: string; staged: boolean; change: string; extra: readonly typeof TOOL_CHANGE_MACRO[] }[] = [
    { name: 'literal M6, text door', staged: false, change: 'M6', extra: [] },
    { name: 'literal M6, program door', staged: true, change: 'M6', extra: [] },
    { name: 'a macro bound to M6', staged: true, change: 'M6', extra: [M6_PRELUDE] },
    { name: 'a bound M1600 whose macro calls toolChange(), plain retract', staged: false, change: 'M1600', extra: [TOOL_CHANGE_MACRO] },
    { name: 'a bound M1600 whose macro calls toolChange(), G53 retract', staged: true, change: 'M1600', extra: [TOOL_CHANGE_MACRO] },
  ]

  /** Load, then CYCLE START once: neither the Load line nor the pointer. */
  function expectSilentAtLoadAndStart(record: RunRecord | null, all: readonly string[]): void {
    const detail = JSON.stringify({ ...record, console: all.slice(-12) })
    expect(all.some((line) => line.includes(NOTICE)), detail).toBe(false)
    expect(all.some((line) => line.startsWith(POINTER)), detail).toBe(false)
    expect(all.some((line) => MID_PROGRAM_FAILURE.test(line)), detail).toBe(false)
    expect(record?.started, detail).toBe(true)
  }

  for (const route of NO_SETTER_ROUTES) {
    it(`a machine with no tool setter, ${route.name}: nothing at Load or Cycle Start, and the run never stops for a reference`, async () => {
      configureMachine(false, route.extra)
      render(createElement(ProgramPanel))
      act(() => { loadGcodeFile('no-setter.nc', twoToolProgram(route.staged, route.change), null) })
      expect(consoleText().some((line) => line.includes(NOTICE)), JSON.stringify(consoleText())).toBe(false)
      const record = await run()
      expectSilentAtLoadAndStart(record, consoleText())
      expect(record.heldWithoutCard).toBe(false)
    }, 60000)
  }

  it('Control runs a machine with no tool setter while CAM\'s has one: nothing at Load or Cycle Start', async () => {
    await controlRunsAnotherMachine(false)
    render(createElement(ProgramPanel))
    act(() => { loadGcodeFile('control-no-setter.nc', twoToolProgram(false, 'M1600'), null) })
    expect(consoleText().some((line) => line.includes(NOTICE)), JSON.stringify(consoleText())).toBe(false)
    const record = await run()
    expectSilentAtLoadAndStart(record, consoleText())
    expect(record.heldWithoutCard).toBe(false)
  }, 60000)

  it('no tool-change macro: the M6 is a manual change that measures nothing, so nothing is said', () => {
    configureMachine(false)
    act(() => { loadGcodeFile('two-tools.nc', twoToolProgram(false), null) })
    expect(consoleText().some((line) => line.includes(NOTICE))).toBe(false)
  })

  it('a program whose only M6 is before any motion: nothing is said', () => {
    const oneTool = ['G21', 'G90', 'T1 M6', 'G54', 'S12000 M3', 'G0 X10 Y10', 'G1 Z-3 F1000', 'G0 Z-1', 'M5', 'M30']
    act(() => { loadGcodeFile('one-tool.nc', oneTool.join('\n'), null) })
    expect(consoleText().some((line) => line.includes(NOTICE))).toBe(false)
  })
})
