// @vitest-environment jsdom
//
// WO-1652 review (opus, safety path, fresh after fix round 3): a macro on M6
// that "extends the built-in" is judged by its TEXT at load (reader.ts
// `macroExtendsBuiltIn` - the body mentions `toolChange(`), so the file's
// `T2 M6` becomes a plain macro boundary: no tool-change hold, no Z-zero gate
// of its own. If the macro stops BEFORE it reaches `toolChange()` - a refused
// line, a `lines(...)` block (locked at a program boundary, decide-and-log
// #5), an output this machine does not have, the operator's macro Stop - the
// session prints "Macro ... has finished - press CYCLE START to run the rest
// of the program" and CYCLE START cuts the next section with T2 never
// measured, although the load line said "It runs 2 tools: T1, then T2".
//
// On main a posted `T2 M6` on this machine always opened the guided fixed-pad
// change, and CYCLE START could not pass it until T2 was probed.

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

const MACHINE = 'wo1652-review2-m6'
const PAD = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: 5 }
const PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')

type MachineMacro = import('../../types').MachineMacro

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

describe('WO-1652 review 2: an M6 macro that names toolChange() but stops before it', () => {
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

  const PAD_MACRO: MachineMacro = {
    id: PAD.id,
    name: PAD.label,
    usedForToolChange: true,
    body: positionMacroBody({ x: PAD.x, y: PAD.y, z: PAD.z, zFirst: true }),
  }

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

    const loaded = loadGcodeTextToolpathProgram('m6-extension.nc', PROGRAM)
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

  it('an M6 macro whose output() line is refused before toolChange() never lets the program cut with T2 unmeasured', async () => {
    // "Dust shoe up, then the tool change" - the machine has no output of
    // that name, so the macro stops at line 1, before toolChange().
    const extension: MachineMacro = {
      id: 'm6-shoe', name: 'Shoe up and change', mCode: 6, body: 'output("dust shoe", false)\ntoolChange()',
    }
    const run = await pressThrough([PAD_MACRO, extension])
    expect(consoleText()).toContain('It runs 2 tools: T1, then T2')
    expect(run.unmeasured, consoleText()).toBe(false)
  })

  it('an M6 macro whose body only MENTIONS toolChange( in a string is not the tool change', async () => {
    const mention: MachineMacro = {
      id: 'm6-say', name: 'Pad park', mCode: 6, body: `say("next: toolChange() at the pad")\n${PAD_MACRO.body}`,
    }
    const run = await pressThrough([{ ...PAD_MACRO, id: 'pad-2' }, mention])
    expect(run.unmeasured, consoleText()).toBe(false)
  })
})
