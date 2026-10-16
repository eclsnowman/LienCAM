// @vitest-environment jsdom
//
// WO-2769 (the owner 2026-10-13, "Fix the wording"): with a macro bound to M6 and no
// pad park, the program-start T1 M6 hold said the file "has finished everything
// it cuts with T1" before anything had cut. Driven through the production
// session route on the simulator: (a) the first change names the tool it asks
// for and the next step and claims nothing finished, (b) an ordinary T1 -> T2
// change after cutting is byte-identical to before, (c) a same-tool T1 -> T1
// change after cutting does not say T1 finished.
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
  __resetEstopInterlockForTest, cancelGuidedToolChange, connectMachine, disconnectMachine,
  getMachineController, loadGcodeTextToolpathProgram, setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const MACHINE = 'wo2769'
type MachineMacro = import('../../types').MachineMacro
const consoleText = (): string => useMachineControl.getState().consoleLines.map((e) => e.text).join('\n')

async function run(program: string[], macros: MachineMacro[]): Promise<string> {
  useMachineControl.getState().clearConsole()
  const base = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...base, id: MACHINE, name: MACHINE, controller: 'grbl', controllerDefinition: undefined, unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 }, rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' }, y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros, safeZMachine: 5,
  })
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineToolTable.getState().recordProbedZ(MACHINE, 1, -42, 1)
  useMachineToolTable.getState().setReference(MACHINE, 1)
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
  const loaded = loadGcodeTextToolpathProgram('wo2769.nc', program.join('\n'))
  expect(loaded.ok, loaded.reason ?? '').toBe(true)
  await executeOperatorCycleStart()
  await vi.advanceTimersByTimeAsync(8000)
  return consoleText()
}

const REST = ' The spindle is stopped and the tool is where the file left it: fit T1, set its Z zero, then '
  + 'press CYCLE START to run the rest.'

describe('WO-2769: a tool-change hold says what is happening', () => {
  beforeEach(() => { vi.useFakeTimers(); memory.clear(); useCamStore.getState().newProject() })
  afterEach(async () => {
    cancelGuidedToolChange()
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    vi.useRealTimers()
  })

  const M6_MACRO: MachineMacro = {
    id: 'm6-far', name: 'Out of the way', mCode: 6, body: positionMacroBody({ x: 95, y: 95, z: 0, zFirst: true }),
  }

  it('(a) the program-start T1 M6 with an M6 macro and no pad park asks for T1 before it starts cutting', async () => {
    const text = await run(
      ['G21', 'G90', 'T1 M6', 'M3 S10000', 'G1 X2 F6000', 'M5', 'T2 M6', 'M3 S10000', 'G1 X4 F6000', 'M30'], [M6_MACRO])
    expect(text).toContain(`"wo2769.nc" asks for T1 on line 3 before it starts cutting.${REST}`)
    expect(text).not.toContain('has finished everything it cuts')
  })

  it('(b) an ordinary T1 -> T2 change after cutting is unchanged', async () => {
    const text = await run(
      ['G21', 'G90', 'T1 M6', 'M3 S10000', 'G1 X2 F6000', 'M5', 'T2 M6', 'M3 S10000', 'G1 X4 F6000', 'M30'], [])
    expect(text).toContain('"wo2769.nc" has finished everything it cuts with T1 and asks for T2 on line 7. The '
      + 'spindle is stopped and the tool is where the file left it: fit T2, set its Z zero, then press CYCLE START '
      + 'to run the rest.')
  })

  it('(c) a same-tool T1 -> T1 change after cutting asks for T1 again and does not say T1 finished', async () => {
    const text = await run(
      ['G21', 'G90', 'T1', 'M3 S10000', 'G1 X2 F6000', 'M5', 'T1 M6', 'M3 S10000', 'G1 X4 F6000', 'M30'], [M6_MACRO])
    expect(text).toContain(`"wo2769.nc" asks for T1 again on line 7.${REST}`)
    expect(text).not.toContain('has finished everything it cuts')
  })
})
