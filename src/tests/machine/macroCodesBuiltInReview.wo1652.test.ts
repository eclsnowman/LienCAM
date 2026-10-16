// @vitest-environment jsdom
//
// WO-1652 review (opus, safety path): a machine whose tool-change park macro
// carries M-code 6 - the operator gave the "go to the tool-change position"
// macro the code M6 so a typed M6 goes there (WO-1680/1706 allowed this on
// main, where a PROGRAM's M6 still ran the guided tool change), or a UCCNC
// import turned a two-move M6.txt into a park bound to M6 (WO-1681).
//
// On main a posted `T2 M6` on that machine runs the guided fixed-pad tool
// change: park, the card, probe T2, apply its length; CYCLE START cannot
// release the boundary until then. After WO-1652 the binding wins over the
// dialect, so the program's M6 only runs the park macro and "press CYCLE
// START" resumes cutting with T2 never measured - the old tool's length.

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
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const MACHINE = 'wo1652-review-m6'
const PAD = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: 5 }
const PROGRAM = ['G21', 'G90', 'T1', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

describe('WO-1652 review: a program M6 on a machine whose tool-change park carries M6', () => {
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

  type MachineMacro = import('../../types').MachineMacro

  const PAD_MACRO = {
    id: PAD.id,
    name: PAD.label,
    usedForToolChange: true,
    body: positionMacroBody({ x: PAD.x, y: PAD.y, z: PAD.z, zFirst: true }),
  }

  /** Load PROGRAM on the machine with these macros and press CYCLE START at
   *  every hold, as an operator told "press CYCLE START" would. */
  async function pressThrough(macros: MachineMacro[]): Promise<{ sawGuidedChange: boolean; unmeasured: boolean }> {
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
      macros,
      safeZMachine: PAD.z,
    })
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE, 1, -42, 1)
    tools.setReference(MACHINE, 1)

    const connecting = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connecting
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      setWorkOffsetValue('G54', axis, 0)
      await vi.advanceTimersByTimeAsync(50)
    }

    const loaded = loadGcodeTextToolpathProgram('m6-bound.nc', PROGRAM)
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    let sawGuidedChange = false
    for (let i = 0; i < 6 && useMachineControl.getState().job.phase !== 'complete'; i += 1) {
      await vi.advanceTimersByTimeAsync(5000)
      if (useMachineControl.getState().toolChange?.mode === 'toolChange') sawGuidedChange = true
      await executeOperatorCycleStart()
    }
    await vi.advanceTimersByTimeAsync(5000)
    const t2 = useMachineToolTable.getState().tableFor(MACHINE).tools.find((tool) => tool.tool === 2)
    return {
      sawGuidedChange,
      unmeasured: useMachineControl.getState().job.phase === 'complete' && t2?.probedMachineZ == null,
    }
  }

  it('still runs the guided tool change - the program never resumes with T2 unmeasured', async () => {
    const run = await pressThrough([{ ...PAD_MACRO, mCode: 6 }])
    // Main: the T2 M6 opens the guided change at the pad, and CYCLE START
    // cannot pass it until T2 is probed and its length applied.
    expect(run.sawGuidedChange, consoleText()).toBe(true)
    expect(run.unmeasured, consoleText()).toBe(false)
    // Fix round 4 (re-scoped): the macro on M6 runs first, as a prelude, and
    // the program's own tool change follows it - the load line says so.
    expect(consoleText()).toContain(
      'At each tool change (M6) the program holds, runs this machine\'s macro "Fixed tool probe" first, '
        + 'then the tool change itself - however the macro ends.',
    )
    expect(consoleText()).toContain('Macro "Fixed tool probe" (M6) has ended - the tool change on line 5 follows.')
    expect(consoleText()).toContain('It runs 2 tools: T1, then T2')
  })

  it('a macro on M6 whose body calls toolChange() runs as a prelude, then the one guided change and its Z-zero gate', async () => {
    const extension: MachineMacro = {
      id: 'm6-extension', name: 'Tool change with a note', mCode: 6, body: 'say("changing tool")\ntoolChange()',
    }
    const run = await pressThrough([PAD_MACRO, extension])
    // Fix round 4: its toolChange() ends the prelude; the ONE M6 change follows.
    expect(consoleText()).toContain('changing tool')
    expect(consoleText()).toContain('Macro "Tool change with a note" (M6) has ended - the tool change on line 5 follows.')
    expect(consoleText().match(/M6 on line 5: moving to "Fixed tool probe"/g)).toHaveLength(1)
    expect(consoleText()).toContain('It runs 2 tools: T1, then T2')
    expect(run.sawGuidedChange, consoleText()).toBe(true)
    expect(run.unmeasured, consoleText()).toBe(false)
  })
})
