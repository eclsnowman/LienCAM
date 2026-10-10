// @vitest-environment jsdom
//
// WO-1643 (re-pointed 2026-09-19) - what counts as a macro M-code comes from
// the MACHINE: the codes its macros are bound to, plus the range it states;
// the dialect's range is only the default for a machine that states nothing.
//
// Two definitions through the production path (load the file, CYCLE START,
// the simulator):
//   - Operator's imported UCCNC definition (this seed ships no macro files, so
//     nothing is bound; M2001 is a macro call by the table's stated range):
//     M150 is read exactly as it is today - the UCCNC table's refusal;
//   - a GRBL machine with a macro bound to M150: the file's M150 is a macro
//     call and runs that macro.
// Then the word table's own answer for a machine (`gcodeWordTableForMachine`).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
const { importUccncProfile, markDefinitionImported } = await import('../../lib/machine/uccncProfileImport')
const {
  builtInGcodeWordTable,
  gcodeWordRefusalIfAbsent,
  gcodeWordTableForMachine,
  isGcodeMacroMCode,
} = await import('../../lib/gcode/wordTable')

type MachineConfig = import('../../types').MachineConfig
type MachineMacro = import('../../types').MachineMacro

const ROOT = process.cwd()
// positionMacroBody is a machine-coordinate goTo/G53 target. GRBL's Z table
// is -400..0, so this point is inside that frame and above the Z -2 retract.
const POINT = { x: 20, y: 30, z: -1 }
const M150: MachineMacro = { id: 'park-150', name: 'Point on M150', mCode: 150, body: positionMacroBody({ ...POINT, zFirst: true }) }

const program = (code: string, workZ: number): string => [
  'G21 G90 G54',
  `G0 X0 Y0 Z${workZ}`,
  code,
  `G0 X4 Y0 Z${workZ}`,
  'M30',
  '',
].join('\n')

function fixture(id: string, extra: Partial<MachineConfig>): MachineConfig {
  return {
    ...useCamStore.getState().project.machine,
    id,
    name: id,
    controller: 'uccnc',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 1000, y: 1000, z: 400 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 0 },
    },
    ...extra,
  }
}

function sampleMachineImported(): MachineConfig {
  const pro = readFileSync(join(ROOT, 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')
  const definition = importUccncProfile(pro).definition!
  return fixture('wo1643-operator', {
    controllerDefinition: markDefinitionImported(definition, 'LienCNCV2.pro', 'wo1643', '2026-09-19T00:00:00Z'),
  })
}

function selectMachine(machine: MachineConfig): void {
  useCamStore.getState().setProjectMachine(machine)
  useMachineActions.setState({
    byMachine: { [machine.id]: { overrides: {}, custom: [], parks: [], toolChangeParkId: null } },
    macroArrangementByMachine: {},
  })
}

const consoleText = (): string => useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
const advance = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined)

async function connect(): Promise<void> {
  const connecting = connectMachine('simulator', 115200)
  await advance(300)
  await connecting
  __resetEstopInterlockForTest()
  getMachineController().home()
  await advance(2000)
  // Establish the real G54 frame through the production receipt path. The
  // GRBL program uses negative work Z; Operator's imported UCCNC profile uses
  // positive work Z. The macro target is machine-coordinate in both cases.
  for (const [axis, offset] of [['X', 0], ['Y', 0], ['Z', 0]] as const) {
    if (!setWorkOffsetValue('G54', axis, offset)) throw new Error(`The simulator refused G54 ${axis} ${offset}.`)
    await advance(50)
  }
}

describe('WO-1643 the macro M-codes come from the machine - two definitions, the production path', () => {
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

  it("a GRBL machine with a macro on M150: the file's M150 is a macro call and runs that macro", async () => {
    selectMachine(fixture('wo1643-grbl', { controller: 'grbl', macros: [M150] }))
    await connect()
    expect(loadGcodeTextToolpathProgram('grbl-m150.nc', program('M150', -2))).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    const held = useMachineControl.getState()
    expect(held.job.phase).toBe('paused')
    expect(held.mpos?.x).toBeCloseTo(POINT.x, 1)
    expect(held.mpos?.y).toBeCloseTo(POINT.y, 1)
    expect(held.mpos?.z).toBeCloseTo(POINT.z, 1)
    expect(consoleText()).toContain('"grbl-m150.nc" reached M150 on line 3: running this machine\'s macro "Point on M150".')
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(4, 1)
  })

  it("Operator's imported definition: M150 is read as it is today - the UCCNC table's refusal", async () => {
    selectMachine(sampleMachineImported())
    await connect()
    // WO-1743: an import that found no macro files brings no macros and injects
    // none - this seed carries no M2001 binding (no macro list at all).
    expect((useCamStore.getState().project.machine.macros ?? []).some((m) => m.mCode === 2001)).toBe(false)
    const result = loadGcodeTextToolpathProgram('operator-m150.nc', program('M150', 2))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('M150 is not in the UCCNC G-code word table')
    // M2001 still loads as a macro call - recognized by the DECLARED UCCNC
    // macro range (1000 and up, the dialect default this machine states
    // nothing over), not by a stored body: nothing is bound to it, so the
    // reader reports the call without any injected macro existing.
    expect(loadGcodeTextToolpathProgram('operator-m2001.nc', program('M2001', 2))).toEqual({ ok: true, reason: null })
  })

  it('a GRBL machine STATING a macro range with no individual binding: M150 is reported as a macro call, by file and by typed line, not the ordinary refusal', async () => {
    selectMachine(fixture('wo1643-grbl-range', { controller: 'grbl', macroMCodeRange: { from: 100, to: 199 } }))
    await connect()
    // Loaded through the production reader: reported as a macro call (WO-1643
    // fix round item 1-2), not the "not in the word table" refusal - even
    // though nothing is bound to M150, the machine's stated range alone says
    // this number is a macro's.
    expect(loadGcodeTextToolpathProgram('grbl-range-m150.nc', program('M150', -2))).toEqual({ ok: true, reason: null })
    // Typed MDI (WO-1643 fix round item 4): the simulator's own table now
    // carries the machine's stated range too, so the refusal it gives is the
    // macro-call sentence, never the blanket manual-command-vocabulary one and
    // never the ordinary "not in the word table" one either. (The simulator's
    // own text dialect is a pre-existing, separate gap - it runs UCCNC's table
    // regardless of the session machine's declared controller - so the
    // sentence names UCCNC's label; the behavioural point under test is which
    // KIND of sentence M150 gets, not the dialect word in it.)
    const ctrl = getMachineController()
    const typed = await ctrl.sendCommandAwait('M150')
    expect(typed).not.toBeNull()
    expect(typed!.ok).toBe(false)
    expect(typed!.message).toContain('calls a')
    expect(typed!.message).toContain('user macro')
    expect(typed!.message).not.toContain('is not in the')
    expect(typed!.message).not.toContain('not part of the manual-command vocabulary')
  })

  it('the same file on a GRBL machine stating nothing is refused exactly as today', async () => {
    selectMachine(fixture('wo1643-grbl-none', { controller: 'grbl' }))
    await connect()
    const result = loadGcodeTextToolpathProgram('grbl-none-m150.nc', program('M150', -2))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('M150 is not in the GRBL G-code word table')
    // Typed MDI: same kind of refusal as the file - the ordinary "not in the
    // word table" sentence, never the macro-call one.
    const ctrl = getMachineController()
    const typed = await ctrl.sendCommandAwait('M150')
    expect(typed).not.toBeNull()
    expect(typed!.ok).toBe(false)
    expect(typed!.message).toContain('M150 is not in the')
    expect(typed!.message).toContain('G-code word table')
    expect(typed!.message).not.toContain('calls a')
  })
})

describe('WO-1643 gcodeWordTableForMachine - the table answers for one machine', () => {
  const uccnc = builtInGcodeWordTable('uccnc')
  const grbl = builtInGcodeWordTable('grbl')

  it('a machine that states nothing keeps the dialect range - the table is unchanged', () => {
    expect(gcodeWordTableForMachine(uccnc, {})).toBe(uccnc)
    expect(gcodeWordTableForMachine(uccnc, null)).toBe(uccnc)
    expect(isGcodeMacroMCode(gcodeWordTableForMachine(uccnc, {}), 2001)).toBe(true)
    expect(isGcodeMacroMCode(gcodeWordTableForMachine(grbl, {}), 150)).toBe(false)
  })

  it("a bound code is a macro call at any number; the dialect's range still stands beside it", () => {
    const table = gcodeWordTableForMachine(grbl, { macros: [{ mCode: 150 }, { mCode: 150 }, {}] })
    expect(table.boundMacroMCodes).toEqual([150])
    expect(isGcodeMacroMCode(table, 150)).toBe(true)
    expect(isGcodeMacroMCode(table, 151)).toBe(false)
    expect(gcodeWordRefusalIfAbsent(table, 'M', 150)).toBeNull()
    expect(gcodeWordRefusalIfAbsent(table, 'M', 151)).toContain('M151 is not in the GRBL G-code word table')
    // UCCNC: M150 bound, M2001 unbound but in the dialect's range.
    const onUccnc = gcodeWordTableForMachine(uccnc, { macros: [{ mCode: 150 }] })
    expect(isGcodeMacroMCode(onUccnc, 150)).toBe(true)
    expect(isGcodeMacroMCode(onUccnc, 2001)).toBe(true)
  })

  it('a code the table carries keeps its standard meaning, bound or not', () => {
    const table = gcodeWordTableForMachine(grbl, { macros: [{ mCode: 6 }, { mCode: 7 }] })
    expect(table).toBe(grbl)
    expect(isGcodeMacroMCode(table, 6)).toBe(false)
  })

  it("the machine's stated range replaces the dialect's", () => {
    const table = gcodeWordTableForMachine(uccnc, { macroMCodeRange: { from: 100, to: 199 } })
    expect(table.macroMCodes).toEqual({ from: 100, to: 199 })
    expect(isGcodeMacroMCode(table, 150)).toBe(true)
    expect(isGcodeMacroMCode(table, 2001)).toBe(false)
    expect(gcodeWordRefusalIfAbsent(table, 'M', 2001)).toContain('M2001 is not in the UCCNC G-code word table')
    const openEnded = gcodeWordTableForMachine(grbl, { macroMCodeRange: { from: 500, to: null } })
    expect(isGcodeMacroMCode(openEnded, 900)).toBe(true)
    expect(isGcodeMacroMCode(openEnded, 499)).toBe(false)
  })

  it('a machine stating null runs no range - only its bound codes are macro calls', () => {
    const table = gcodeWordTableForMachine(uccnc, { macroMCodeRange: null, macros: [{ mCode: 1500 }] })
    expect(table.macroMCodes).toBeNull()
    expect(isGcodeMacroMCode(table, 1500)).toBe(true)
    expect(isGcodeMacroMCode(table, 2001)).toBe(false)
  })

  it('a stated range that is not a range states nothing - the dialect default stands (no new refusal)', () => {
    for (const bad of [{ from: 200, to: 100 }, { from: -1, to: null }, { from: 1.5, to: null }]) {
      expect(gcodeWordTableForMachine(uccnc, { macroMCodeRange: bad })).toBe(uccnc)
    }
  })
})
