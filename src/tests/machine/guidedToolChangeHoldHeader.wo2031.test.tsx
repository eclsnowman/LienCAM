// @vitest-environment jsdom
//
// WO-2031 (Operator's session 2026-09-26, finding F3): while a guided M6 owns the
// program hold, the transport header read "Program held at part N of M - Cycle
// Start continues" with CYCLE START lit, but the session refuses Cycle Start
// there and the tool-change card's Continue is the only way on. The header and
// the button must agree with the session.
//
// Driven through the real session on the simulator with ProgramPanel (the card)
// and ControlTransportBar (header + CYCLE START) both mounted. The control is
// the same program with no measured reference tool: the M6 then takes the plain
// hold, which CYCLE START releases, and keeps its words.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const { activeMacroRun, runUserMacro } = await import('../../lib/machine/macros/macroRuntime')
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
const {
  currentOperatorTransport,
  deriveOperatorTransport,
  executeOperatorCycleStart,
} = await import('../../lib/machine/operatorTransport')
type TransportInput = Parameters<typeof deriveOperatorTransport>[0]
type ToolChangeStep = NonNullable<TransportInput['toolChange']>['step']

const MACHINE_ID = 'wo2031-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
const PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')
// WO-2764: WO-2478 runs a macro bound to M6 at every M6, the same-tool T1 M6 too;
// the M6-macro cases preselect T1 so their first held change is still the T2 M6.
const M6_BOUND_PROGRAM = PROGRAM.replace('T1 M6', 'T1')
const RUNNING = /^Program is running|^Program checks passed|^Cycle complete/
// A part boundary with no tool change: M700 runs this machine's "Note" macro.
const NOTE_PROGRAM = ['G21', 'G90', 'G1 X2 F6000', 'M700', 'G1 X4 F6000', 'M30'].join('\n')

function configureMachine(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2031 simulator',
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
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function header(): string {
  return screen.getByTestId('control-next-action').textContent ?? ''
}

function cycleStart(): HTMLButtonElement {
  return screen.getByTestId('control-cyclestart') as HTMLButtonElement
}

function readback(): Record<string, unknown> {
  const s = useMachineControl.getState()
  return {
    header: screen.queryByTestId('control-next-action')?.textContent ?? null,
    cycleStartDisabled: (screen.queryByTestId('control-cyclestart') as HTMLButtonElement | null)?.disabled ?? null,
    verdict: currentOperatorTransport(),
    toolChange: s.toolChange,
    job: { phase: s.job.phase, ackedLines: s.job.ackedLines, totalLines: s.job.totalLines },
    machineState: s.machineState,
    machinePosition: s.mpos,
    controllerTlo: s.tlo,
    card: screen.queryByTestId('control-toolchange-card')?.textContent ?? null,
  }
}

function writeEvidence(name: string, evidence: unknown): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const directory = join(process.cwd(), 'src/tests/evidence/WO-2031')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`)
}

/** Stage the two-tool program through the geometry (program-parts) door and
 * run it to the T2 M6. */
async function runToT2Hold(program = PROGRAM): Promise<void> {
  for (const axis of ['X', 'Y', 'Z'] as const) {
    expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
    await advance(50)
  }
  render(<><ControlTransportBar /><ControlStepRow /><ProgramPanel /></>)
  act(() => { expect(loadGcodeTextToolpathProgram('wo2031.nc', program).ok).toBe(true) })
  expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  expect(cycleStart().disabled).toBe(false)
  expect(header()).toMatch(RUNNING)

  await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
  await advance(4000)
}

describe('WO-2031 a guided tool change hold points at Continue', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine()
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    act(() => { useMachineToolTable.getState().setProbeConfig(MACHINE_ID, { maxTravel: 50 }) })
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

  it('guided M6 hold: header names the card Continue, CYCLE START is off and refused; Continue resumes', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    const evidence: Record<string, unknown> = {}
    await runToT2Hold()

    // The hold: the guided card is up, the program is held at part 1 of 2.
    evidence.hold = readback()
    const state = useMachineControl.getState()
    expect(state.toolChange, JSON.stringify(evidence.hold)).toMatchObject({ mode: 'toolChange', tool: 2, step: 'awaiting-swap' })
    expect(state.mpos).toMatchObject({ x: PARK.x, y: PARK.y, z: PARK.z })
    expect(state.job.phase).toBe('paused')
    expect(screen.getByTestId('control-tc-continue').textContent).toBe('Continue - probe T2')

    expect(header()).toBe('Program held at part 1 of 2 for the T2 tool change - fit T2, then press Continue on the tool-change card')
    expect(header()).not.toContain('Cycle Start continues')
    expect(cycleStart().disabled).toBe(true)
    expect(currentOperatorTransport()).toMatchObject({ action: 'none', cycleStartEnabled: false })

    // Pressing it anyway moves nothing and leaves the hold as it was.
    fireEvent.click(cycleStart())
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(false) })
    await advance(2000)
    expect(useMachineControl.getState().mpos).toMatchObject({ x: PARK.x, y: PARK.y, z: PARK.z })
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')

    // Single Block on: same hold, same words, the Step control is not armed either.
    act(() => { setMachineSingleBlock(true) })
    expect(header()).toContain('press Continue on the tool-change card')
    expect(cycleStart().disabled).toBe(true)
    expect(currentOperatorTransport()).toMatchObject({ action: 'none', cycleStartEnabled: false })
    act(() => { setMachineSingleBlock(false) })

    // The card's Continue probes T2 and resumes the program.
    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20000)

    evidence.afterContinue = readback()
    const after = useMachineControl.getState()
    expect(after.job.phase, JSON.stringify(evidence.afterContinue)).toBe('complete')
    expect(after.toolChange).toBeNull()
    expect(after.mpos?.x).toBeCloseTo(4, 1)
    expect(header()).not.toContain('tool-change card')
    expect(header()).toMatch(RUNNING)
    writeEvidence('guided-m6-hold-header.json', evidence)
  })

  it('the header follows the card through a missed measure to Retry, then Continue from the M6', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    act(() => { useMachineToolTable.getState().setProbeConfig(MACHINE_ID, { maxTravel: 20 }) })
    await runToT2Hold()

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20000)
    expect(screen.getByTestId('control-tc-retry').textContent).toBe('Retry measure T2')
    expect(cycleStart().disabled).toBe(true)
    // GRBL (and the simulator) raise ALARM:5 on a missed probe; the alarm's own
    // sentence takes the header ahead of the hold (unchanged here). What must
    // not appear is Cycle Start as the way on. The Retry wording itself is
    // pinned in the verdict table below.
    expect(useMachineControl.getState().machineState).toBe('alarm')
    expect(header()).not.toContain('Cycle Start continues')

    act(() => { useMachineToolTable.getState().setProbeConfig(MACHINE_ID, { maxTravel: 50 }) })
    fireEvent.click(screen.getByTestId('control-tc-retry'))
    await advance(20000)
    expect(useMachineControl.getState().toolChange?.step).toBe('ready')
    expect(header()).toBe('Program held at part 1 of 2 for the T2 tool change - press Continue from the M6 on the tool-change card')
    expect(cycleStart().disabled).toBe(true)
    expect(currentOperatorTransport()).toMatchObject({ action: 'none', cycleStartEnabled: false })

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(header()).not.toContain('tool-change card')
  })

  it('control: an M6 with no guided card (no measured reference) keeps "Cycle Start continues" with CYCLE START enabled', async () => {
    await runToT2Hold()

    const evidence = readback()
    const state = useMachineControl.getState()
    expect(state.toolChange, JSON.stringify(evidence)).toBeNull()
    expect(state.job.phase).toBe('paused')
    expect(header()).toBe('Program held at part 1 of 2 - Cycle Start continues')
    expect(cycleStart().disabled).toBe(false)
    expect(currentOperatorTransport()).toMatchObject({ action: 'resume', cycleStartEnabled: true })
    writeEvidence('plain-m6-hold-header.json', evidence)
  })

  // Fix round (audit: "M6 macro prelude under Single Block still enables a
  // transport action the session refuses"). The session refuses stepJob while
  // the boundary macro runs and sends Cycle Start to the macro's hold() instead.
  for (const singleBlock of [true, false]) {
    it(`M6 macro prelude${singleBlock ? ' under Single Block' : ''}: CYCLE START continues the macro at hold(), is off while it moves, then the card owns the hold`, async () => {
      const machine = useCamStore.getState().project.machine
      useCamStore.getState().setProjectMachine({
        ...machine,
        macros: [...(machine.macros ?? []), {
          id: 'm6-prelude',
          name: 'Shoe off',
          mCode: 6,
          body: `say("shoe off")\nhold()\n${positionMacroBody({ x: 60, y: 70, z: 0, zFirst: true })}\nsay("prelude done")`,
        }],
      })
      const tools = useMachineToolTable.getState()
      tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
      tools.setReference(MACHINE_ID, 1)
      if (singleBlock) act(() => { setMachineSingleBlock(false) })
      await runToT2Hold(M6_BOUND_PROGRAM)
      if (singleBlock) act(() => { setMachineSingleBlock(true) })

      // The prelude waits at hold(): no card yet, the program is held.
      const atHold = readback()
      const state = useMachineControl.getState()
      expect(state.toolChange, JSON.stringify(atHold)).toBeNull()
      expect(state.job.phase).toBe('paused')
      expect(header()).toBe('Program held at part 1 of 2 - macro "Shoe off" is waiting - Cycle Start continues it')
      expect(cycleStart().disabled).toBe(false)
      expect(currentOperatorTransport()).toMatchObject({ action: 'resume', cycleStartEnabled: true })
      const parked = { ...state.mpos }

      // The door the header names is the one the session opens: the macro
      // continues and makes its move (the step door would be refused here).
      await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
      await advance(50)
      expect(useMachineControl.getState().mpos).toMatchObject(parked)
      expect(header()).toBe('Program held at part 1 of 2 - macro "Shoe off" is running - let it finish, or Stop it')
      expect(cycleStart().disabled).toBe(true)
      expect(currentOperatorTransport()).toMatchObject({ action: 'none', cycleStartEnabled: false })

      // The prelude ends, the guided change parks and its card takes the hold.
      await advance(8000)
      const rows = useMachineControl.getState().consoleLines.map((row) => row.text).join('\n')
      expect(rows).toContain('prelude done')
      expect(useMachineControl.getState().toolChange, JSON.stringify(readback())).toMatchObject({ mode: 'toolChange', tool: 2, step: 'awaiting-swap' })
      expect(header()).toBe('Program held at part 1 of 2 for the T2 tool change - fit T2, then press Continue on the tool-change card')
      expect(cycleStart().disabled).toBe(true)
      if (singleBlock) writeEvidence('m6-prelude-single-block.json', atHold)
    })
  }

  // Second audit: an operator's own macro waiting at hold() is NOT the held
  // boundary's macro. The session refuses the boundary's M6 prelude (a macro is
  // already running), so CYCLE START releases the program, not that macro -
  // and the header must say so.
  it('an operator macro left waiting at hold() is not the boundary\'s: the plain M6 hold keeps "Cycle Start continues" and CYCLE START runs the program', async () => {
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      macros: [...(machine.macros ?? []), {
        id: 'm6-prelude', name: 'Shoe off', mCode: 6, body: 'say("prelude ran")',
      }],
    })
    act(() => { expect(runUserMacro({ id: 'wait-here', name: 'Wait here', body: 'hold()' })).toBe(true) })
    await advance(200)
    expect(activeMacroRun()).toMatchObject({ name: 'Wait here', phase: 'held' })

    await runToT2Hold(M6_BOUND_PROGRAM)
    const evidence = readback()
    const state = useMachineControl.getState()
    expect(state.toolChange, JSON.stringify(evidence)).toBeNull()
    expect(state.job.phase).toBe('paused')
    expect(activeMacroRun()).toMatchObject({ name: 'Wait here', phase: 'held' })
    const rows = state.consoleLines.map((row) => row.text).join('\n')
    expect(rows).not.toContain('prelude ran')
    expect(header()).toBe('Program held at part 1 of 2 - Cycle Start continues')
    expect(cycleStart().disabled).toBe(false)
    expect(currentOperatorTransport()).toMatchObject({ action: 'resume', cycleStartEnabled: true })

    // The door the header names: the plain M6 hold wants T2's Z zero, then
    // CYCLE START runs the rest of the program. The operator's macro stays put.
    expect(setWorkOffsetValue('G54', 'Z', 0)).toBe(true)
    await advance(200)
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    await advance(8000)
    expect(useMachineControl.getState().job.phase, JSON.stringify(readback())).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(4, 1)
    expect(activeMacroRun()).toMatchObject({ name: 'Wait here', phase: 'held' })
    writeEvidence('operator-macro-plain-m6-hold.json', evidence)
  })

  // A plain part boundary with no tool change: its macro has finished, and
  // CYCLE START (or Single Block's step) runs on - words and behaviour unchanged.
  for (const singleBlock of [false, true]) {
    it(`plain part boundary, no tool change${singleBlock ? ', Single Block' : ''}: "Cycle Start continues" and CYCLE START ${singleBlock ? 'steps' : 'runs'} on`, async () => {
      const machine = useCamStore.getState().project.machine
      useCamStore.getState().setProjectMachine({
        ...machine,
        macros: [...(machine.macros ?? []), { id: 'note-700', name: 'Note', mCode: 700, body: 'say("hello")' }],
      })
      await runToT2Hold(NOTE_PROGRAM)
      if (singleBlock) act(() => { setMachineSingleBlock(true) })

      const evidence = readback()
      const state = useMachineControl.getState()
      expect(state.job.phase, JSON.stringify(evidence)).toBe('paused')
      expect(state.toolChange).toBeNull()
      expect(activeMacroRun()).toBeNull()
      expect(state.mpos?.x).toBeCloseTo(2, 1)
      expect(header()).toBe('Program held at part 1 of 2 - Cycle Start continues')
      expect(cycleStart().disabled).toBe(false)
      expect(currentOperatorTransport()).toMatchObject({
        action: singleBlock ? 'single-block' : 'resume',
        cycleStartEnabled: true,
      })

      await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
      await advance(8000)
      expect(useMachineControl.getState().mpos?.x, JSON.stringify(readback())).toBeCloseTo(4, 1)
      if (!singleBlock) expect(useMachineControl.getState().job.phase).toBe('complete')
    })
  }
})

describe('WO-2031 verdict: every step of a guided M6 hold, plain and Single Block', () => {
  const held = { completedPart: 5, nextPart: 6, totalParts: 9, held: true }
  function input(step: ToolChangeStep | null, extra: Partial<TransportInput> = {}): TransportInput {
    return {
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      activeWcs: 'G54',
      job: {
        ...useMachineControl.getState().job,
        phase: 'paused',
        name: 'operator.nc',
        totalLines: 90,
        sentLines: 50,
        ackedLines: 50,
      },
      programReadiness: { ready: true, reason: '' },
      singleBlock: false,
      fitTrace: null,
      toolChange: step === null ? null : { step, mode: 'toolChange', tool: 3, resumeLine: 40, message: '', warnings: [] },
      programText: null,
      programParts: held,
      // The session's own decision: a guided card up at a held boundary is the
      // guided change that owns it (machineSession.programHoldCycleStartDecision).
      programHold: step === null ? null : { owner: 'tool-change-card' },
      ...extra,
    }
  }

  const words: Array<[ToolChangeStep, string]> = [
    // WO-2520: a tool-change park names its own place (the card's message), never the probe pad by default.
    ['stopping', 'stopping for the tool change'],
    ['parking', 'parking for the tool change'],
    ['awaiting-swap', 'fit T3, then press Continue on the tool-change card'],
    ['probing', 'measuring the new tool'],
    ['arming', 'finishing the tool change'],
    ['ready', 'press Continue from the M6 on the tool-change card'],
    ['failed', 'the tool change stopped - see the tool-change card'],
  ]
  for (const singleBlock of [false, true]) {
    for (const [step, next] of words) {
      it(`${step}${singleBlock ? ' (Single Block)' : ''}: names the card, CYCLE START off`, () => {
        expect(deriveOperatorTransport(input(step, { singleBlock }))).toMatchObject({
          action: 'none',
          cycleStartEnabled: false,
          nextAction: `Program held at part 5 of 9 for the T3 tool change - ${next}`,
        })
      })
    }
  }

  it('a missed measure names Retry measure, the button the card draws', () => {
    expect(deriveOperatorTransport(input('awaiting-swap', { guidedMeasure: { missed: true, measured: false } })).nextAction)
      .toBe('Program held at part 5 of 9 for the T3 tool change - press Retry measure on the tool-change card')
  })

  for (const singleBlock of [false, true]) {
    it(`M6 prelude macro${singleBlock ? ' (Single Block)' : ''}: at hold() Cycle Start continues it, never a step; moving, CYCLE START off`, () => {
      expect(deriveOperatorTransport(input(null, { singleBlock, programHold: { owner: 'boundary-macro', macro: 'Shoe off', macroWaiting: true } }))).toMatchObject({
        action: 'resume',
        cycleStartEnabled: true,
        nextAction: 'Program held at part 5 of 9 - macro "Shoe off" is waiting - Cycle Start continues it',
      })
      expect(deriveOperatorTransport(input(null, { singleBlock, programHold: { owner: 'boundary-macro', macro: 'Shoe off', macroWaiting: false } }))).toMatchObject({
        action: 'none',
        cycleStartEnabled: false,
        nextAction: 'Program held at part 5 of 9 - macro "Shoe off" is running - let it finish, or Stop it',
      })
    })
  }

  it('unchanged: a part-boundary hold with no tool-change card still says Cycle Start continues', () => {
    expect(deriveOperatorTransport(input(null))).toMatchObject({
      action: 'resume',
      cycleStartEnabled: true,
      nextAction: 'Program held at part 5 of 9 - Cycle Start continues',
    })
  })

  it('unchanged: a guided card with no program-parts hold (text route) keeps its own verdict', () => {
    const verdict = deriveOperatorTransport(input('ready', { programParts: null, programHold: null, job: { ...input(null).job, phase: 'ready' } }))
    expect(verdict.nextAction).toBe('Guided recovery is armed. Review its cautions, then press CYCLE START.')
    expect(verdict.cycleStartEnabled).toBe(true)
  })
})
