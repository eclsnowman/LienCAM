// @vitest-environment jsdom
//
// WO-1652 review 3 (opus, safety path, after the fix-round-4 re-scope): a
// macro bound to M6 runs as a PRELUDE with the M6 hold already entered, and
// however it ends the tool change follows. These drive every way the prelude
// can end and assert the one safety outcome: the program never cuts Section 2
// with T2 unmeasured, and nothing moves after an E-STOP.

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
const { executeOperatorCycleStart, executeOperatorFeedHold } = await import('../../lib/machine/operatorTransport')
const { activeMacroRun, stopUserMacro } = await import('../../lib/machine/macros/macroRuntime')

const MACHINE = 'wo1652-review3-m6'
const PAD = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: 5 }
const FAR = { x: 95, y: 95, z: 0 }

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
      z: { homesToward: 'max', homePositionMm: 5 },
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
  const loaded = loadGcodeTextToolpathProgram('review3.nc', text)
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

describe('WO-1652 review 3: every way an M6 prelude ends', () => {
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

  const FAR_PRELUDE: MachineMacro = {
    id: 'm6-far', name: 'Out of the way', mCode: 6, body: positionMacroBody({ ...FAR, zFirst: true }),
  }

  it('the operator\'s macro Stop: the guided change follows and CYCLE START never cuts T2 unmeasured', async () => {
    await setUp(FAR_PRELUDE)
    await advance(200)
    expect(stopUserMacro()).toBe(true)
    await advance(8000)
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('toolChange')
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('hold() inside the prelude: CYCLE START continues the macro, never the program past the change', async () => {
    await setUp({ id: 'm6-hold', name: 'Hold first', mCode: 6, body: 'say("remove the shoe")\nhold()\nsay("after hold")' })
    await advance(500)
    expect(activeMacroRun()?.phase).toBe('held')
    // Two quick presses: the first continues the hold, the second lands while
    // the tool-change card owns the boundary.
    await executeOperatorCycleStart()
    await executeOperatorCycleStart()
    await advance(8000)
    expect(consoleText()).toContain('after hold')
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('toolChange')
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('a lines(...) block in the prelude (locked at a boundary) ends it; the change follows', async () => {
    await setUp({ id: 'm6-lines', name: 'Lines', mCode: 6, body: 'lines("G91 G0 Z1", "G90")\nsay("never")' })
    await advance(8000)
    expect(consoleText()).not.toContain('\nnever')
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('a runtime error in the prelude ends it; the change follows', async () => {
    await setUp({ id: 'm6-err', name: 'Err', mCode: 6, body: 'goTo({ x: "a" })' })
    await advance(8000)
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('feed hold during the prelude move, then CYCLE START: never cuts T2 unmeasured', async () => {
    await setUp(FAR_PRELUDE)
    await advance(150)
    executeOperatorFeedHold()
    await advance(1000)
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('E-STOP during the prelude move: nothing moves afterwards, and after the E-STOP is cleared nothing cuts T2 unmeasured', async () => {
    const sends = await setUp(FAR_PRELUDE)
    await advance(150)
    session.triggerEmergencyStop()
    const at = sends.length
    await advance(10_000)
    const afterEstop = sends.slice(at)
    const moves = afterEstop.filter((send) => /jogTo|G0|G1|G53|startJob|loadJob|loadProgram|resumeJob|cycleResume/.test(send))
    expect(moves, `${afterEstop.join('\n')}\n---\n${consoleText()}`).toEqual([])
    // Clear the E-STOP, then press CYCLE START as an operator would.
    __resetEstopInterlockForTest()
    const cleared = sends.length
    await advance(5000)
    const afterClear = sends.slice(cleared).filter((send) => /jogTo|G53/.test(send))
    expect(afterClear, `${afterClear.join('\n')}\n---\n${consoleText()}`).toEqual([])
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('no pad park: the prelude ends, the plain M6 hold (main) follows; CYCLE START is refused while it runs', async () => {
    // WO-2764: WO-2478 runs the M6 macro at the same-tool T1 M6 too, and with no pad park
    // that is a plain hold of its own; preselect T1 so the prelude under test is at T2.
    await setUp(FAR_PRELUDE, false,
      ['G21', 'G90', 'T1', 'M3 S10000', 'G1 X2 F6000', 'M5', 'T2 M6', 'M3 S10000', 'G1 X4 F6000', 'M30'].join('\n'))
    await advance(100)
    expect(activeMacroRun()).not.toBeNull()
    expect(await executeOperatorCycleStart()).toBe(false)
    expect(Math.abs((useMachineControl.getState().mpos?.x ?? 0) - 4) < 0.01).toBe(false)
    await advance(10_000)
    expect(consoleText()).toContain('(M6) has ended - the tool change on line 7 follows: fit T2')
  })

  it('m06 spelling with T in the previous block: the prelude runs and the change follows', async () => {
    const text = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T3', 'm06', 'G1 X4 F6000', 'M30'].join('\n')
    await setUp(FAR_PRELUDE, true, text)
    await advance(8000)
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('toolChange')
    expect(await cutWithT2Unmeasured(8, 3), consoleText()).toBe(false)
  })
})

// WO-1652 tightening (architect 11:30Z): a macro on a code with no standard
// meaning whose body calls toolChange() is counted by the load line as a tool
// change ("It runs 2 tools"). However that macro ends, the tool change follows
// - text may only ADD a hold, never remove one.
describe('WO-1652 tightening: a no-meaning macro counted as a tool change', () => {
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

  it('the macro errors before reaching toolChange(): the guided change for T2 opens, CYCLE START never cuts T2 unmeasured', async () => {
    const macro: MachineMacro = { id: 'm1600-err', name: 'Shoe then change', mCode: 1600, body: 'goTo({ x: "a" })\ntoolChange()' }
    await setUp(macro, true, program(1600))
    expect(consoleText()).toContain('It runs 2 tools')
    await advance(8000)
    expect(consoleText()).toContain('(M1600) has ended without reaching its tool change - the tool change to T2 follows.')
    expect(consoleText()).not.toContain('has finished - press CYCLE START')
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('toolChange')
    expect(useMachineControl.getState().toolChange?.tool, consoleText()).toBe(2)
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('the macro reaches toolChange(): exactly one tool change, no second', async () => {
    const macro: MachineMacro = { id: 'm1600-ok', name: 'Shoe then change', mCode: 1600, body: 'say("shoe off")\ntoolChange()' }
    await setUp(macro, true, program(1600))
    await advance(8000)
    expect(consoleText()).toContain('shoe off')
    expect(consoleText()).not.toContain('has ended without reaching its tool change')
    expect(useMachineControl.getState().toolChange?.mode, consoleText()).toBe('toolChange')
    const parks = consoleText().split('\n').filter((row) => row.includes('moving to "Fixed tool probe"'))
    expect(parks, consoleText()).toHaveLength(1)
    expect(await cutWithT2Unmeasured(), consoleText()).toBe(false)
  })

  it('an unmarked M1500 macro (no toolChange() in its body) behaves as before', async () => {
    const macro: MachineMacro = { id: 'm1500', name: 'Plain', mCode: 1500, body: 'say("m1500 ran")' }
    await setUp(macro, true, program(1500))
    await advance(8000)
    expect(consoleText()).toContain('m1500 ran')
    expect(consoleText()).toContain('Macro "Plain" (M1500) has finished - press CYCLE START to run the rest of the program.')
    expect(consoleText()).not.toContain('has ended without reaching its tool change')
    expect(useMachineControl.getState().toolChange ?? null, consoleText()).toBeNull()
  })
})
