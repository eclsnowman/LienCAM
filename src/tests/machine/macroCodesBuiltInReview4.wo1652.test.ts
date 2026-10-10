// @vitest-environment jsdom
//
// WO-1652 review 4 (opus, safety path, the tightening): a no-meaning macro
// (M1600) the reader marked as a tool change gets the tool-change hold however
// it ends - but never a second one, never after Stop/Reset or E-STOP ended the
// program, always for the tool the load counted, and a clampPause() inside it
// is refused. An unmarked clamp-pause macro is unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { positionMacroBody } = await import('../../types')
const session = await import('../../lib/machine/machineSession')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = session
const { executeOperatorCycleStart, executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const { activeMacroRun, stopUserMacro } = await import('../../lib/machine/macros/macroRuntime')

const MACHINE = 'wo1652-review4'
const PAD = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: 0 }
const FAR = { x: 95, y: 95, z: -5 }

type MachineMacro = import('../../types').MachineMacro

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

const PAD_MACRO: MachineMacro = {
  id: PAD.id,
  name: PAD.label,
  usedForToolChange: true,
  body: positionMacroBody({ x: PAD.x, y: PAD.y, z: PAD.z, zFirst: true }),
}

const SENDS = [
  'sendCommand', 'sendCommandAwait', 'jogToMachineZ', 'jogToWorkXY', 'jogToMachineZAwait', 'jogToWorkXYAwait',
  'loadProgram', 'loadJob', 'loadJobFrom', 'startJob', 'resumeJob', 'cycleResume', 'stepJob', 'pauseJob',
  'feedHold', 'stopJob', 'reset', 'setOutput', 'spindleOff', 'spindleOn',
] as const

function recordSends(): string[] {
  const ctrl = getMachineController() as unknown as Record<string, unknown>
  const calls: string[] = []
  for (const name of SENDS) {
    const original = ctrl[name]
    if (typeof original !== 'function') continue
    ctrl[name] = (...args: unknown[]) => {
      calls.push(`${name}(${JSON.stringify(args)})`)
      return (original as (...a: unknown[]) => unknown).apply(ctrl, args)
    }
  }
  return calls
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

async function setUp(prelude: MachineMacro, pad = true, program?: string): Promise<string[]> {
  useMachineControl.getState().clearConsole()
  const base = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...base,
    id: MACHINE,
    name: MACHINE,
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    macros: [...(pad ? [PAD_MACRO] : []), prelude],
    safeZMachine: PAD.z,
  })
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  const tools = useMachineToolTable.getState()
  tools.recordProbedZ(MACHINE, 1, -42, 1)
  tools.setReference(MACHINE, 1)

  const connecting = connectMachine('simulator', 115200)
  await advance(300)
  await connecting
  __resetEstopInterlockForTest()
  getMachineController().home()
  await advance(2000)
  for (const axis of ['X', 'Y', 'Z'] as const) {
    setWorkOffsetValue('G54', axis, 0)
    await advance(50)
  }
  const sends = recordSends()
  const text = program ?? ['G21', 'G90', 'T1 M6', 'M3 S10000', 'G1 X2 F6000', 'M5', 'T2 M6', 'M3 S10000', 'G1 X4 F6000', 'M30'].join('\n')
  const loaded = loadGcodeTextToolpathProgram('review4.nc', text)
  expect(loaded.ok, loaded.reason ?? '').toBe(true)
  expect(await executeOperatorCycleStart()).toBe(true)
  const began = (): boolean => activeMacroRun() !== null || consoleText().includes(`Macro "${prelude.name}" (M`)
    || consoleText().includes(`running this machine's macro "${prelude.name}"`)
  for (let i = 0; i < 600 && !began(); i += 1) await advance(10)
  expect(began(), consoleText()).toBe(true)
  return sends
}

/** Press CYCLE START repeatedly; true when the program ran Section 2 with T2 never probed. */
async function cutWithT2Unmeasured(presses = 8, tool = 2): Promise<boolean> {
  for (let i = 0; i < presses && useMachineControl.getState().job.phase !== 'complete'; i += 1) {
    await executeOperatorCycleStart()
    await advance(5000)
  }
  const t2 = useMachineToolTable.getState().tableFor(MACHINE).tools.find((entry) => entry.tool === tool)
  const reachedX4 = Math.abs((useMachineControl.getState().mpos?.x ?? 0) - 4) < 0.01
  return (useMachineControl.getState().job.phase === 'complete' || reachedX4) && t2?.probedMachineZ == null
}

describe('WO-1652 review 4: the tightening - a marked no-meaning macro', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
  })

  afterEach(async () => {
    cancelGuidedToolChange()
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    vi.useRealTimers()
  })

  const program = (code: number): string =>
    ['G21', 'G90', 'T1 M6', 'M3 S10000', 'G1 X2 F6000', 'M5', `T2 M${code}`, 'M3 S10000', 'G1 X4 F6000', 'M30'].join('\n')
  const FAR_THEN_CHANGE: MachineMacro = {
    id: 'm1600-far', name: 'Far then change', mCode: 1600,
    body: `${positionMacroBody({ ...FAR, zFirst: true })}\ntoolChange()`,
  }
  const parks = (): number => consoleText().split('\n').filter((row) => row.includes('moving to "Fixed tool probe"')).length

  // The E-STOP latches but leaves the program held between parts (as for the
  // M6 prelude, review 3): the follow-up may say its tool change follows, but
  // nothing moves - the tool is low, so the retract check ends the program.
  it('E-STOP during the marked macro move: nothing moves, nothing cuts T2 unmeasured', async () => {
    const sends = await setUp(FAR_THEN_CHANGE, true, program(1600))
    await advance(150)
    expect(activeMacroRun()).not.toBeNull()
    session.triggerEmergencyStop()
    const at = sends.length
    await advance(10_000)
    const afterEstop = sends.slice(at)
    const moves = afterEstop.filter((send) => /jogTo|G0|G1|G53|startJob|loadJob|loadProgram|resumeJob|cycleResume/.test(send))
    expect(moves, `${afterEstop.join('\n')}\n---\n${consoleText()}`).toEqual([])
    expect(parks(), consoleText()).toBe(0)
    __resetEstopInterlockForTest()
    const cleared = sends.length
    await advance(5000)
    expect(sends.slice(cleared).filter((send) => /jogTo|G53/.test(send))).toEqual([])
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('E-STOP during the marked macro XY move at clear height: nothing moves after the E-STOP, even once it is cleared', async () => {
    const sends = await setUp({ ...FAR_THEN_CHANGE, body: `${positionMacroBody({ ...FAR, z: 0, zFirst: true })}\ntoolChange()` }, true, program(1600))
    await advance(150)
    expect(activeMacroRun()).not.toBeNull()
    session.triggerEmergencyStop()
    const at = sends.length
    await advance(10_000)
    const afterEstop = sends.slice(at)
    const moves = afterEstop.filter((send) => /jogTo|G0|G1|G53|startJob|loadJob|loadProgram|resumeJob|cycleResume/.test(send))
    // Observation (identical on the M6 prelude, review 3): the macro ends on
    // the E-STOP before the alarm ends the program, so the follow-up's park is
    // ATTEMPTED and its "moving to" line is printed - but nothing reaches the
    // board, and the alarm then ends the program.
    expect(moves, `${afterEstop.join('\n')}\n---\n${consoleText()}`).toEqual([])
    __resetEstopInterlockForTest()
    const cleared = sends.length
    await advance(5000)
    const afterClear = sends.slice(cleared).filter((send) => /jogTo|G53/.test(send))
    expect(afterClear, `${afterClear.join('\n')}\n---\n${consoleText()}`).toEqual([])
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('E-STOP while the marked macro waits at hold() (tool clear): nothing moves after the E-STOP, even once it is cleared', async () => {
    const macro: MachineMacro = { id: 'm1600-hold', name: 'Hold then change', mCode: 1600, body: 'say("shoe off")\nhold()\ntoolChange()' }
    const sends = await setUp(macro, true, program(1600))
    await advance(500)
    expect(activeMacroRun()?.phase).toBe('held')
    session.triggerEmergencyStop()
    const at = sends.length
    await advance(10_000)
    const afterEstop = sends.slice(at)
    const moves = afterEstop.filter((send) => /jogTo|G0|G1|G53|startJob|loadJob|loadProgram|resumeJob|cycleResume/.test(send))
    expect(moves, `${afterEstop.join('\n')}\n---\n${consoleText()}`).toEqual([])
    expect(parks(), consoleText()).toBe(0)
    __resetEstopInterlockForTest()
    const cleared = sends.length
    await advance(5000)
    const afterClear = sends.slice(cleared).filter((send) => /jogTo|G53/.test(send))
    expect(afterClear, `${afterClear.join('\n')}\n---\n${consoleText()}`).toEqual([])
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('transport Stop/Reset during the marked macro: the program ends, no tool change follows', async () => {
    await setUp(FAR_THEN_CHANGE, true, program(1600))
    await advance(150)
    expect(activeMacroRun()).not.toBeNull()
    executeOperatorStopReset()
    await advance(10_000)
    expect(consoleText()).not.toContain('has ended without reaching its tool change')
    expect(parks(), consoleText()).toBe(0)
    expect(useMachineControl.getState().toolChange ?? null, consoleText()).toBeNull()
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('the operator\'s macro Stop with the tool clear: exactly one tool change follows, for T2', async () => {
    await setUp({ ...FAR_THEN_CHANGE, body: `${positionMacroBody({ ...FAR, z: 0, zFirst: true })}\ntoolChange()` }, true, program(1600))
    await advance(150)
    expect(stopUserMacro()).toBe(true)
    await advance(10_000)
    expect(consoleText()).toContain('the tool change to T2 follows.')
    expect(useMachineControl.getState().toolChange?.tool, consoleText()).toBe(2)
    expect(parks(), consoleText()).toBe(1)
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('body toolChange(3) with the file saying T2: the load counts T3 and the follow-up changes to T3', async () => {
    const macro: MachineMacro = { id: 'm1600-t3', name: 'T3 change', mCode: 1600, body: 'goTo({ x: "a" })\ntoolChange(3)' }
    await setUp(macro, true, program(1600))
    await advance(8000)
    expect(consoleText()).toContain('the tool change to T3 follows.')
    expect(useMachineControl.getState().toolChange?.tool, consoleText()).toBe(3)
    expect(parks(), consoleText()).toBe(1)
    expect(await cutWithT2Unmeasured(8, 3), consoleText()).toBe(false)
  })

  it('body reaches toolChange(3) with the file saying T2: one change, to T3', async () => {
    const macro: MachineMacro = { id: 'm1600-t3ok', name: 'T3 ok', mCode: 1600, body: 'toolChange(3)' }
    await setUp(macro, true, program(1600))
    await advance(8000)
    expect(consoleText()).not.toContain('has ended without reaching its tool change')
    expect(useMachineControl.getState().toolChange?.tool, consoleText()).toBe(3)
    expect(parks(), consoleText()).toBe(1)
  })

  it('clampPause() inside a marked macro is refused; no clamp card, the tool change follows once', async () => {
    const macro: MachineMacro = { id: 'm1600-clamp', name: 'Clamp then change', mCode: 1600, body: 'clampPause()\ntoolChange()' }
    await setUp(macro, true, program(1600))
    await advance(8000)
    expect(consoleText()).toContain('the tool change owns this hold')
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('toolChange')
    expect(useMachineControl.getState().toolChange?.tool, consoleText()).toBe(2)
    expect(parks(), consoleText()).toBe(1)
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('an unmarked M2001 clampPause() macro still opens the clamp pause, no tool change', async () => {
    const macro: MachineMacro = { id: 'clamp-pause-m2001', name: 'Clamp pause', mCode: 2001, body: 'clampPause()' }
    await setUp(macro, true, program(2001))
    await advance(8000)
    expect(consoleText()).not.toContain('has ended without reaching its tool change')
    expect(consoleText()).not.toContain('the tool change owns this hold')
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('clampPause')
  })
})
