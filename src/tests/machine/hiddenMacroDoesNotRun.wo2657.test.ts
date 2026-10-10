// @vitest-environment jsdom
//
// WO-2657 - a macro hidden from the Macros panel does not run (machine session 2026-10-07:
// "If they're suppressed from view, they also need to be suppressed from
// running"). Through the production session on the simulator: the macro's
// M-code typed in MDI and met in a program behaves as if no macro were bound,
// with one console line saying the macro is off the panel and was not run.
// The same macro shown on the panel still runs, both ways.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  beginGuidedToolChange,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')
const { machineParkList, toolChangeMacroPark } = await import('../../lib/machine/machineActions')
const { activeMacroRun, boundMacro } = await import('../../lib/machine/macros/macroRuntime')
const { gcodeWordTable, gcodeWordTableForMachine, isGcodeMacroMCode } = await import('../../lib/gcode/wordTable')

type MachineConfig = import('../../types').MachineConfig
type MachineMacro = import('../../types').MachineMacro

const H100: MachineMacro = { id: 'h100', name: 'Hidden hundred', mCode: 100, body: "say('HIDDEN-100-RAN')", hidden: true }
const H8: MachineMacro = { id: 'h8', name: 'Flood on', mCode: 8, body: "say('HIDDEN-8-RAN')", hidden: true }
const H2010: MachineMacro = { id: 'h2010', name: 'ZK hidden', mCode: 2010, body: "say('ZK-HIDDEN-RAN')", hidden: true }
const S2011: MachineMacro = { id: 's2011', name: 'ZK shown', mCode: 2011, body: "say('ZK-SHOWN-RAN')" }
const H6: MachineMacro = { id: 'h6', name: 'Dust shoe off', mCode: 6, body: "say('HIDDEN-6-RAN')", hidden: true }

const shown = (macro: MachineMacro): MachineMacro => {
  const { hidden: _hidden, ...rest } = macro
  return rest
}

function machine(macros: MachineMacro[], extra: Partial<MachineConfig> = {}): MachineConfig {
  return {
    ...useCamStore.getState().project.machine,
    id: 'wo2657',
    name: 'wo2657',
    controller: 'uccnc',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 1000, y: 1000, z: 400 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 200 },
    },
    macros,
    ...extra,
  }
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

async function connect(macros: MachineMacro[], extra: Partial<MachineConfig> = {}): Promise<string[]> {
  useCamStore.getState().setProjectMachine(machine(macros, extra))
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
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
  useMachineControl.getState().clearConsole()
  const ctrl = getMachineController() as unknown as Record<string, unknown>
  const sent: string[] = []
  for (const name of ['sendCommand', 'sendCommandAwait'] as const) {
    const original = ctrl[name] as (...a: unknown[]) => unknown
    ctrl[name] = (...args: unknown[]) => {
      sent.push(String(args[0]))
      return original.apply(ctrl, args)
    }
  }
  return sent
}

async function typed(line: string): Promise<void> {
  sendMdiLine(line)
  await advance(3000)
}

/** Load and run `text` to its end, pressing CYCLE START at each hold. */
async function runProgram(name: string, text: string): Promise<void> {
  const loaded = loadGcodeTextToolpathProgram(name, text)
  expect(loaded.ok, loaded.reason ?? '').toBe(true)
  expect(await executeOperatorCycleStart()).toBe(true)
  await advance(10_000)
  for (let i = 0; i < 6 && useMachineControl.getState().job.phase !== 'complete'; i += 1) {
    expect(activeMacroRun(), consoleText()).toBeNull()
    await executeOperatorCycleStart()
    await advance(10_000)
  }
  expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
}

const program = (...codes: string[]): string => [
  'G21 G90 G54', 'G0 X0 Y0 Z2', ...codes.flatMap((code, i) => [code, `G0 X${i + 1} Y0 Z2`]), 'M30', '',
].join('\n')

describe('WO-2657: a macro hidden from the Macros panel does not run', () => {
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

  it('typed M100 of a hidden macro does not run it and says so in one line', async () => {
    await connect([H100, S2011])
    await typed('M100')
    const text = consoleText()
    expect(text).not.toContain('HIDDEN-100-RAN')
    expect(text.split('\n').filter((row) => row.includes('"Hidden hundred"') && row.includes('was not run')), text)
      .toHaveLength(1)
    await typed('M2011')
    expect(consoleText()).toContain('ZK-SHOWN-RAN')
  })

  it('typed M2010 of a hidden macro says so once - no second "does not run macros" refusal (machine seat zk, 10-07)', async () => {
    await connect([H2010, S2011])
    await typed('M2010')
    const text = consoleText()
    expect(text).not.toContain('ZK-HIDDEN-RAN')
    expect(text).toContain('"ZK hidden", which is hidden from the Macros panel, so it was not run')
    expect(text).toContain('Nothing on this line was sent.')
    expect(text).not.toContain('does not run macros')
    await typed('M2011')
    expect(consoleText()).toContain('ZK-SHOWN-RAN')
  })

  it('typed M8 of a hidden macro goes to the controller as M8 itself', async () => {
    const sent = await connect([H8])
    await typed('M8')
    expect(consoleText()).not.toContain('HIDDEN-8-RAN')
    expect(consoleText()).toContain('"Flood on"')
    expect(sent).toContain('M8')
  })

  it('the same macros shown on the panel still run when typed', async () => {
    await connect([shown(H100), shown(H8)])
    await typed('M100')
    expect(consoleText()).toContain('HIDDEN-100-RAN')
    await typed('M8')
    expect(consoleText()).toContain('HIDDEN-8-RAN')
  })

  it('a program with hidden M2010 then shown M2011 runs only the shown one and completes (kit row zk)', async () => {
    await connect([H2010, S2011])
    await runProgram('zk.nc', program('M2010', 'M2011'))
    const text = consoleText()
    expect(text).not.toContain('ZK-HIDDEN-RAN')
    expect(text).toContain('ZK-SHOWN-RAN')
    expect(text.split('\n').filter((row) => row.includes('"ZK hidden"') && row.includes('not run')).length, text)
      .toBeGreaterThan(0)
  })

  it('a program with hidden M100 does not run it; shown, the same program runs it', async () => {
    await connect([H100])
    const refused = loadGcodeTextToolpathProgram('m100.nc', program('M100'))
    expect(refused.ok).toBe(false)
    expect(refused.reason ?? '').toContain('"Hidden hundred"')
    expect(consoleText()).not.toContain('HIDDEN-100-RAN')
    const disconnecting = disconnectMachine()
    await advance(100)
    await disconnecting

    await connect([shown(H100)])
    await runProgram('m100.nc', program('M100'))
    expect(consoleText()).toContain('HIDDEN-100-RAN')
  })

  it('a program with M8 under a hidden macro keeps M8 and never names the macro', async () => {
    await connect([H8])
    await runProgram('m8.nc', program('M8', 'M9'))
    const text = consoleText()
    expect(text).not.toContain('HIDDEN-8-RAN')
    expect(text).not.toContain('"Flood on"')
  })

  it('a hidden macro on M6 is no prelude to the program tool change', async () => {
    await connect([H6])
    const loaded = loadGcodeTextToolpathProgram('m6.nc', ['G21 G90 G54', 'T1 M6', 'G0 X1 Y0 Z2', 'T2 M6', 'G0 X2 Y0 Z2', 'M30', ''].join('\n'))
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    expect(activeMacroRun()).toBeNull()
    expect(consoleText()).not.toContain('HIDDEN-6-RAN')
    expect(consoleText()).not.toContain('"Dust shoe off"')
  })

  it('binding: boundMacro and the machine word table skip a hidden macro', () => {
    useCamStore.getState().setProjectMachine(machine([H100, { ...S2011, mCode: 100, id: 'second' }]))
    expect(boundMacro(100)?.id).toBe('second')
    useCamStore.getState().setProjectMachine(machine([H100]))
    expect(boundMacro(100)).toBeNull()
    expect(isGcodeMacroMCode(gcodeWordTableForMachine(gcodeWordTable('grbl'), { macros: [H100] }), 100)).toBe(false)
    expect(isGcodeMacroMCode(gcodeWordTableForMachine(gcodeWordTable('grbl'), { macros: [shown(H100)] }), 100)).toBe(true)
  })

  // The WO-1652 review-4 GRBL machine, whose fixed pad parks the program M6.
  const PAD: MachineMacro = {
    id: 'pad', name: 'Fixed tool probe', usedForToolChange: true,
    body: positionMacroBody({ x: 5, y: 5, z: 0, zFirst: true }),
  }
  const parkedAtPad = async (pad: MachineMacro): Promise<boolean> => {
    useMachineToolTable.setState({ byMachine: {} })
    useMachineToolTable.getState().recordProbedZ('wo2657', 1, -42, 1)
    useMachineToolTable.getState().setReference('wo2657', 1)
    await connect([pad], {
      controller: 'grbl',
      travel: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
      safeZMachine: 0,
    })
    const text = ['G21', 'G90', 'T1 M6', 'M3 S10000', 'G1 X2 F6000', 'M5', 'T2 M6', 'M3 S10000', 'G1 X4 F6000', 'M30'].join('\n')
    const loaded = loadGcodeTextToolpathProgram('tc.nc', text)
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    return consoleText().includes('moving to "Fixed tool probe"')
  }

  it('a shown tool-change macro parks the program M6 (control)', async () => {
    expect(await parkedAtPad(PAD), consoleText()).toBe(true)
  })

  it('a hidden tool-change macro is no tool-change park: the M6 holds as with none flagged', async () => {
    expect(await parkedAtPad({ ...PAD, hidden: true }), consoleText()).toBe(false)
    expect(consoleText()).toContain('fit T2, set its Z zero, then press CYCLE START')
  })

  // Review fix round: callers outside the session (pendant Rear, ProgramPanel's
  // guided / automatic M6) resolve parks from the whole macro list and hand the
  // park to the session. The session does not move to a hidden macro's park.
  const REAR: MachineMacro = {
    id: 'rear', name: 'Rear', usedForToolChange: true,
    body: positionMacroBody({ x: 8, y: 9, z: 5, zFirst: true }),
  }
  const parkLinesSent = (sent: readonly string[]): string[] => sent.filter((line) => /G53/i.test(line))

  it('pendant Rear on a hidden position macro does not move; shown, it parks (control)', async () => {
    let sent = await connect([{ ...REAR, hidden: true }], { safeZMachine: 5 })
    const before = { ...useMachineControl.getState().mpos }
    const refused = await executePendantMachineCommand({ kind: 'macro', id: 'park-rear' }, { clientId: 'wo2657', emit: () => {} })
    await advance(10_000)
    expect(refused.ok).toBe(false)
    expect(refused.error ?? '').toContain('hidden from the Macros panel')
    expect(parkLinesSent(sent)).toEqual([])
    expect(useMachineControl.getState().mpos).toEqual(before)
    expect(consoleText().split('\n').filter((row) => row.includes('"Rear"') && row.includes('was not run'))).toHaveLength(1)
    const disconnecting = disconnectMachine()
    await advance(100)
    await disconnecting

    sent = await connect([REAR], { safeZMachine: 5 })
    expect(await executePendantMachineCommand({ kind: 'macro', id: 'park-rear' }, { clientId: 'wo2657', emit: () => {} }))
      .toEqual({ ok: true })
    await advance(10_000)
    expect(parkLinesSent(sent).length).toBeGreaterThan(0)
    expect(useMachineControl.getState().mpos).toMatchObject({ x: 8, y: 9, z: 5 })
  })

  /** What ProgramPanel hands the session for its guided / automatic M6. */
  const panelPark = () => {
    const parkMachine = useCamStore.getState().project.machine
    return toolChangeMacroPark(parkMachine, machineParkList(parkMachine, undefined))
  }

  it('the program panel guided change with a hidden flagged park does not park; shown, it parks (control)', async () => {
    let sent = await connect([{ ...REAR, hidden: true }], { safeZMachine: 5 })
    const hiddenPark = panelPark()
    expect(hiddenPark?.id).toBe('rear') // the panel's lookup still sees it - the session is the guard
    expect(await beginGuidedToolChange({ tool: 2, resumeLine: 1, park: hiddenPark!, safeZMachine: 5 })).toBe(false)
    await advance(10_000)
    expect(parkLinesSent(sent)).toEqual([])
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(consoleText()).toContain('"Rear" is hidden from the Macros panel, so it was not run')
    const disconnecting = disconnectMachine()
    await advance(100)
    await disconnecting

    sent = await connect([REAR], { safeZMachine: 5 })
    const shownPark = panelPark()
    const started = beginGuidedToolChange({ tool: 2, resumeLine: 1, park: shownPark!, safeZMachine: 5 })
    await advance(10_000)
    expect(await started, consoleText()).toBe(true)
    expect(parkLinesSent(sent).length).toBeGreaterThan(0)
    expect(useMachineControl.getState().toolChange).toMatchObject({ step: 'awaiting-swap' })
  })
})
