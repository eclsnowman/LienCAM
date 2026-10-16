// @vitest-environment jsdom
//
// WO-1652 - a program's M-code runs whichever of the machine's macros carries
// it, at any number, and the clamp pause is a macro API call (`clampPause()`)
// running the same session code M2001 always ran.
//
// Two machine definitions through the production path (load the file, CYCLE
// START, the simulator):
//   - "another machine": M1500 -> a macro calling clampPause(), M700 -> a
//     position macro at its point 2, and NO macro on M2001;
//   - Operator's imported definition: his UCCNC profile, marked imported, whose
//     record carries the "Clamp pause" macro on M2001 as its own macro data.
//     WO-1743 outcome 2: the import adds no binding of its own - a machine
//     that wants the clamp pause opts into the example macro itself, exactly
//     as an operator adds it in the Macros panel.
// "Unchanged" is measured, not asserted: every controller call a clamp run
// makes is compared with the calls main's M2001 path made on the same file and
// definition, recorded in src/tests/evidence/WO-1652/ (re-record: check out
// main's versions of the changed src files, run with WO1652_RECORD=1).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const { machineRapidRate, positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  continueClampPause,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { importUccncProfile, markDefinitionImported } = await import('../../lib/machine/uccncProfileImport')

type MachineConfig = import('../../types').MachineConfig
type MachineMacro = import('../../types').MachineMacro

const ROOT = process.cwd()
const RECORD = process.env.WO1652_RECORD === '1'
const evidence = (machine: string): string => join(ROOT, `src/tests/evidence/WO-2586/m2001-sends-main-${machine}.json`)

/** Record main's calls, or compare this run's with them.
 *
 * `cappedRapid`: WO-1700 (Operator 2026-09-19) caps the typed rapid at the
 * definition's slowest axis max speed. Main's recording carried the fixture's
 * typed 60000 on its G0 steps; where the definition caps it, main's rapid
 * steps are compared at the capped rate. Every other call is compared as
 * recorded. */
function sameAsMain(machine: string, sends: string[], cappedRapid?: { from: number; to: number }): void {
  if (RECORD) {
    writeFileSync(evidence(machine), `${JSON.stringify(sends, null, 2)}\n`)
    return
  }
  expect(existsSync(evidence(machine))).toBe(true)
  // WO-2773: main's run pressed CYCLE START at the parked clamp card (its one
  // `cycleResume` press); the card's Continue is now the one door, and every
  // call the session sends from there on is main's.
  const recorded = (JSON.parse(readFileSync(evidence(machine), 'utf8')) as string[])
    .filter((call) => call !== 'cycleResume([])')
  const main = cappedRapid
    ? recorded.map((call) => call.split(`"feedMmMin":${cappedRapid.from},"rapid":true`)
      .join(`"feedMmMin":${cappedRapid.to},"rapid":true`))
    : recorded
  expect(main.length).toBeGreaterThan(0)
  expect(sends).toEqual(main)
}
const PARK = { id: 'clamp-park', label: 'Clamp park', x: 8, y: 9 }
const POINT_2 = { x: 20, y: 30, z: 6 }

const program = (code: string): string => [
  'G21 G90 G54',
  'G0 X0 Y0 Z2',
  code,
  'G0 X4 Y0 Z2',
  'M30',
  '',
].join('\n')

const ANOTHER_MACROS: MachineMacro[] = [
  { id: 'clamp-1500', name: 'Clamp here', mCode: 1500, body: 'clampPause()' },
  { id: 'park-2', name: 'Point 2', mCode: 700, body: positionMacroBody({ ...POINT_2, zFirst: true }) },
]

/** WO-1743 outcome 2: the import adds no built-in binding of its own. Operator's
 *  record carries LienCAM's clamp-pause example macro as its own macro data -
 *  the same id/name/code/body an operator gets by adding it in the Macros
 *  panel - and M2001 runs it like any other bound macro. */
const CLAMP_PAUSE_MACRO: MachineMacro = {
  id: 'clamp-pause-m2001', name: 'Clamp pause', mCode: 2001, body: 'clampPause()',
}

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
      z: { homesToward: 'max', homePositionMm: 200 },
    },
    ...extra,
  }
}

/** Operator's definition as the import leaves it: his profile, marked imported,
 *  and no macro the application invented (WO-1743 outcome 2). Scenarios that
 *  run the clamp pause add the example macro to the record themselves. */
function sampleMachineImported(): MachineConfig {
  const pro = readFileSync(join(ROOT, 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')
  const definition = importUccncProfile(pro).definition!
  return fixture('wo1652-operator', {
    controllerDefinition: markDefinitionImported(definition, 'LienCNCV2.pro', 'wo1652', '2026-09-19T00:00:00Z'),
  })
}

function selectMachine(machine: MachineConfig): void {
  useCamStore.getState().setProjectMachine(machine)
  useMachineActions.setState({
    byMachine: {
      [machine.id]: { overrides: {}, custom: [], parks: [PARK], toolChangeParkId: PARK.id },
    },
    macroArrangementByMachine: {},
  })
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

async function connect(): Promise<void> {
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
}

const SENDS = [
  'sendCommand', 'sendCommandAwait', 'jogToMachineZ', 'jogToWorkXY', 'jogToMachineZAwait', 'jogToWorkXYAwait',
  'loadProgram', 'loadJob', 'loadJobFrom', 'startJob', 'resumeJob', 'cycleResume', 'stepJob', 'pauseJob',
  'feedHold', 'stopJob', 'reset', 'setOutput',
] as const

/** Every call the session makes on the controller from here on, numbers to 0.001. */
function recordSends(): string[] {
  const ctrl = getMachineController() as unknown as Record<string, unknown>
  const calls: string[] = []
  const round = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null, (_k, v) => (
    typeof v === 'number' ? Number(v.toFixed(3)) : v
  )))
  for (const name of SENDS) {
    const original = ctrl[name]
    if (typeof original !== 'function') continue
    ctrl[name] = (...args: unknown[]) => {
      calls.push(`${name}(${JSON.stringify(args.map(round))})`)
      return (original as (...a: unknown[]) => unknown).apply(ctrl, args)
    }
  }
  return calls
}

/** Load `text`, CYCLE START, let it reach the boundary. */
async function runToBoundary(name: string, text: string): Promise<void> {
  expect(loadGcodeTextToolpathProgram(name, text)).toEqual({ ok: true, reason: null })
  expect(await executeOperatorCycleStart()).toBe(true)
  await advance(10_000)
}

/** The whole clamp-pause run of `text`: to the clamp card, its Continue, to the end. */
async function clampRun(name: string, text: string, park: { x: number; y: number; z: number }): Promise<string[]> {
  const sends = recordSends()
  await runToBoundary(name, text)
  const paused = useMachineControl.getState()
  expect(paused.job.phase).toBe('paused')
  expect(paused.toolChange).toMatchObject({ mode: 'clampPause', step: 'awaiting-swap' })
  expect(paused.mpos?.x).toBeCloseTo(park.x, 1)
  expect(paused.mpos?.y).toBeCloseTo(park.y, 1)
  expect(paused.mpos?.z).toBeCloseTo(park.z, 1)
  // WO-2773 (Operator 2026-10-13, "A - Continue on both"): the card's Continue is
  // the one door at the parked clamp pause - one release, the same calls.
  expect(continueClampPause()).toBe(true)
  expect(useMachineControl.getState().toolChange).toBeNull()
  await advance(10_000)
  expect(useMachineControl.getState().job.phase).toBe('complete')
  expect(useMachineControl.getState().mpos?.x).toBeCloseTo(4, 1)
  return [...sends]
}

describe('WO-1652 M-codes bind to built-in actions through the one macro system', () => {
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

  it("Operator's imported definition runs M2001 as the clamp pause - the same controller calls as main's M2001", async () => {
    // WO-1743: the record brings the example macro as its own data; the
    // import itself adds none.
    selectMachine({ ...sampleMachineImported(), macros: [CLAMP_PAUSE_MACRO] })
    await connect()
    // His profile states SafeZ=120 (machine), which the park rises to.
    const sends = await clampRun('operator-m2001.nc', program('M2001'), { x: PARK.x, y: PARK.y, z: 120 })
    // His profile's slowest axis max speed caps the fixture's typed 60000 rapid.
    const ceiling = machineRapidRate(useCamStore.getState().project.machine)?.ceiling
    expect(ceiling).toBeLessThan(60000)
    sameAsMain('sampleMachine', sends, { from: 60000, to: ceiling! })
    if (RECORD) return
    // The macro is on his record, visible and editable like any other.
    const record = useCamStore.getState().project.machine
    expect(record.macros).toContainEqual({
      id: 'clamp-pause-m2001', name: 'Clamp pause', mCode: 2001, body: 'clampPause()',
    })
  })

  it("another machine: M1500 runs its clampPause() macro - the same controller calls as main's M2001 there", async () => {
    selectMachine(fixture('wo1652-another', { macros: ANOTHER_MACROS }))
    await connect()
    // Record/compare the same explicit M1500 binding on both source versions.
    const sends = await clampRun('another-m1500.nc', program('M1500'), POINT_2)
    sameAsMain('another', sends)
    if (RECORD) return
    expect(consoleText()).toContain(
      'The file calls M1500 on line 3 (this machine\'s macro "Clamp here") - the program holds there and runs it.',
    )
    // No clamp pause macro was added to a machine not made from a UCCNC profile.
    expect(useCamStore.getState().project.machine.macros?.map((m) => m.mCode)).toEqual([1500, 700])
  })

  it('another machine: M700 parks at its point 2, then CYCLE START runs the rest', async () => {
    selectMachine(fixture('wo1652-another', { macros: ANOTHER_MACROS }))
    await connect()
    await runToBoundary('another-m700.nc', program('M700'))
    const held = useMachineControl.getState()
    expect(held.job.phase).toBe('paused')
    expect(held.toolChange).toBeNull()
    expect(held.mpos?.x).toBeCloseTo(POINT_2.x, 1)
    expect(held.mpos?.y).toBeCloseTo(POINT_2.y, 1)
    expect(held.mpos?.z).toBeCloseTo(POINT_2.z, 1)
    expect(consoleText()).toContain('"another-m700.nc" reached M700 on line 3: running this machine\'s macro "Point 2".')
    expect(consoleText()).toContain('Macro "Point 2" (M700) has finished - press CYCLE START to run the rest of the program.')
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(4, 1)
  })

  it('another machine: M2001 is no one\'s code there - the generic hold an unknown macro code always had', async () => {
    selectMachine(fixture('wo1652-another', { macros: ANOTHER_MACROS }))
    await connect()
    await runToBoundary('another-m2001.nc', program('M2001'))
    expect(consoleText()).toContain('The file calls a macro this app cannot run (M2001 on line 3)')
    expect(consoleText()).toContain('stopped at the M2001 macro call on line 3, which this app cannot run')
    const held = useMachineControl.getState()
    expect(held.job.phase).toBe('paused')
    expect(held.toolChange).toBeNull()
    expect(held.mpos?.x).toBeCloseTo(0, 1)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)
    expect(useMachineControl.getState().job.phase).toBe('complete')
  })

  it('a code the dialect already carries (M7) keeps its standard action; the load line names the unused binding', async () => {
    // Fix round 3: a park bound to M7 must not replace the coolant word in a
    // program. Measured against the same machine with no macro on M7 - main's
    // M7 - call for call.
    const m7Run = async (macros: MachineMacro[]): Promise<{ sends: string[]; mpos: unknown }> => {
      selectMachine(fixture('wo1652-m7', { macros }))
      await connect()
      const sends = recordSends()
      expect(loadGcodeTextToolpathProgram('another-m7.nc', program('M7'))).toEqual({ ok: true, reason: null })
      for (let i = 0; i < 4 && useMachineControl.getState().job.phase !== 'complete'; i += 1) {
        await executeOperatorCycleStart()
        await advance(10_000)
      }
      expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
      const result = { sends: [...sends], mpos: useMachineControl.getState().mpos }
      const disconnecting = disconnectMachine()
      await advance(100)
      await disconnecting
      return result
    }
    const plain = await m7Run([])
    useMachineControl.getState().clearConsole()
    const bound = await m7Run([
      { id: 'park-m7', name: 'Point 2 on M7', mCode: 7, body: positionMacroBody({ ...POINT_2, zFirst: true }) },
    ])
    expect(bound.sends.length).toBeGreaterThan(0)
    expect(bound.sends).toEqual(plain.sends)
    expect(bound.mpos).toEqual(plain.mpos)
    expect(consoleText()).toContain(
      'M7 on line 3 keeps its standard meaning; the macro "Point 2 on M7" bound to M7 runs only from its button '
        + 'or a typed M7.',
    )
    expect(consoleText()).not.toContain('running this machine\'s macro "Point 2 on M7"')
  })

  it('a code with no macro on a machine whose controller has no macro range is refused as before (rule 11: nothing new)', async () => {
    const grblMacros: MachineMacro[] = [
      ANOTHER_MACROS[0]!,
      { ...ANOTHER_MACROS[1]!, body: positionMacroBody({ ...POINT_2, z: -6, zFirst: true }) },
    ]
    selectMachine(fixture('wo1652-grbl', {
      controller: 'grbl',
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
      macros: grblMacros,
    }))
    await connect()
    // Bound: M700 is a macro call on GRBL too.
    const grblProgram = (code: string): string => program(code).replaceAll('Z2', 'Z-2')
    expect(loadGcodeTextToolpathProgram('grbl-m700.nc', grblProgram('M700'))).toEqual({ ok: true, reason: null })
    // Unbound: M2001 gets the table's refusal, exactly as before WO-1652.
    const unbound = loadGcodeTextToolpathProgram('grbl-m2001.nc', grblProgram('M2001'))
    expect(unbound.ok).toBe(false)
    expect(unbound.reason).toContain('M2001 is not in the GRBL G-code word table')
  })

  it('the import invents no Clamp pause, and a deleted example macro does not come back', async () => {
    // WO-1743 outcome 2 retired the automatic binding; this test now proves
    // the replacement premise: nothing is invented, and what the operator
    // deletes stays deleted.
    selectMachine(sampleMachineImported())
    await advance(0)
    const bare = useCamStore.getState().project.machine
    expect(bare.macros?.filter((m) => m.mCode === 2001) ?? []).toHaveLength(0)
    expect(bare.clampPauseMacroAdded).toBeUndefined()
    // The operator opts into the example macro - normal machine macro data.
    useCamStore.getState().setProjectMachine({ ...bare, macros: [CLAMP_PAUSE_MACRO] })
    await advance(0)
    expect(useCamStore.getState().project.machine.macros).toEqual([CLAMP_PAUSE_MACRO])
    // Deleting it is final: no subscription puts it back.
    useCamStore.getState().setProjectMachine({ ...bare, macros: [] })
    await advance(0)
    expect(useCamStore.getState().project.machine.macros).toEqual([])
  })

  it('clampPause() with no program held at its code says why and sends nothing', async () => {
    selectMachine(fixture('wo1652-another', { macros: ANOTHER_MACROS }))
    await connect()
    const { runUserMacro } = await import('../../lib/machine/macros/macroRuntime')
    const sends = recordSends()
    expect(runUserMacro(ANOTHER_MACROS[0])).toBe(true)
    await advance(1000)
    expect(consoleText()).toContain(
      'Macro "Clamp here" stopped at line 1: clampPause: no program is held at this macro\'s M-code',
    )
    expect(sends).toEqual([])
  })
})

// WO-1652 fix round 2: THE GUIDED TOOL CHANGE IS A MACRO API CALL.
// A macro bound to M1600 whose body is `toolChange()` runs the programmed
// tool change (`T2 M6`) on its held boundary - measured by running the same
// file both ways on the same machine and comparing every controller call and
// every state the tool-change card showed, then Stop/Reset during the park
// both ways.
const { createElement } = await import('react')
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const { activeMacroRun, runUserMacro } = await import('../../lib/machine/macros/macroRuntime')

describe('WO-1652 toolChange(): a macro runs the programmed tool change', () => {
  const MACHINE = 'wo1652-toolchange'
  const PAD = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
  const TOOL_CHANGE_MACRO: MachineMacro = { id: 'tc-1600', name: 'Tool change here', mCode: 1600, body: 'toolChange()' }
  const toolProgram = (code: string): string => [
    'G21', 'G90', 'T1 M6', 'G1 X2 F6000', `T2 ${code}`, 'G1 X4 F6000', 'M30',
  ].join('\n')

  /** Fix round 4: a prelude on M6 - "dust shoe off", then out of the way. */
  const PRELUDE_POINT = { x: 60, y: 70, z: 0 }
  const M6_PRELUDE: MachineMacro = {
    id: 'm6-prelude',
    name: 'Shoe off',
    mCode: 6,
    body: `say("shoe off")\n${positionMacroBody({ ...PRELUDE_POINT, zFirst: true })}\nsay("prelude done")`,
  }

  function selectToolMachine(extra: MachineMacro[] = [], pad = true): void {
    useCamStore.getState().setProjectMachine(fixture(MACHINE, {
      controller: 'grbl',
      travel: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', homePositionMm: 5 },
      },
      macros: [
        ...(pad
          ? [{
              id: PAD.id,
              name: PAD.label,
              usedForToolChange: true,
              body: positionMacroBody({ x: PAD.x, y: PAD.y, z: PAD.z, zFirst: true }),
            }]
          : []),
        TOOL_CHANGE_MACRO,
        ...extra,
      ],
      safeZMachine: PAD.z,
    }))
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE, 1, -42, 1)
    tools.setReference(MACHINE, 1)
  }

  async function connectToolMachine(): Promise<void> {
    const connecting = connectMachine('simulator', 115200)
    await advance(300)
    await connecting
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await advance(2000)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
  }

  async function reconnectFresh(): Promise<void> {
    cleanup()
    cancelGuidedToolChange()
    const disconnecting = disconnectMachine()
    await advance(100)
    await disconnecting
    memory.clear()
    useCamStore.getState().newProject()
  }

  /** Every distinct state the tool-change card shows, in order. */
  function recordCard(): { cards: string[]; off: () => void } {
    const cards: string[] = []
    const off = useMachineControl.subscribe((state) => {
      const text = JSON.stringify(state.toolChange)
      if (cards.at(-1) !== text) cards.push(text)
    })
    return { cards, off }
  }

  function loadAndStart(name: string, code: string, program = toolProgram(code)): void {
    render(createElement(ProgramPanel))
    const loaded = loadGcodeTextToolpathProgram(name, program)
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    expect(getMachineController().startJob()).toBe(true)
  }

  /** The whole change: to the pad, Continue (probe, offset, resume), to the end. */
  async function wholeChange(code: string): Promise<{ sends: string[]; cards: string[]; tlo: number | null }> {
    selectToolMachine()
    await connectToolMachine()
    const sends = recordSends()
    const card = recordCard()
    loadAndStart('tool-change.nc', code) // one name: it is in every staged call
    await act(async () => { await advance(4000) })
    const atPad = useMachineControl.getState()
    expect(atPad.toolChange, consoleText()).toMatchObject({ mode: 'toolChange', step: 'awaiting-swap', tool: 2 })
    expect(atPad.mpos).toMatchObject({ x: PAD.x, y: PAD.y, z: PAD.z })
    // The card owns the boundary: CYCLE START does not release it.
    expect(await executeOperatorCycleStart()).toBe(false)
    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await act(async () => { await advance(20_000) })
    card.off()
    const done = useMachineControl.getState()
    expect(done.job.phase, consoleText()).toBe('complete')
    expect(done.mpos?.x).toBeCloseTo(4, 1)
    expect(done.toolChange).toBeNull()
    const t2 = useMachineToolTable.getState().tableFor(MACHINE).tools.find((tool) => tool.tool === 2)
    expect(t2?.probedMachineZ).toBeCloseTo(-40, 1)
    return { sends: [...sends], cards: card.cards, tlo: done.tlo }
  }

  /** Stop/Reset while the M6 prelude macro is moving: what is left afterwards. */
  async function stopDuringPrelude(): Promise<{ sends: string[]; cards: string[]; after: unknown }> {
    selectToolMachine([{ ...M6_PRELUDE, body: positionMacroBody({ x: 95, y: 95, z: 0, zFirst: true }) }])
    await connectToolMachine()
    const sends = recordSends()
    const card = recordCard()
    loadAndStart('tool-change.nc', 'M6')
    for (let i = 0; i < 400 && activeMacroRun() === null; i += 1) {
      await act(async () => { await advance(10) })
    }
    expect(activeMacroRun()?.name, consoleText()).toBe('Shoe off')
    await act(async () => { await advance(300) })
    expect(activeMacroRun()?.name, consoleText()).toBe('Shoe off')
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await act(async () => { await advance(10_000) })
    const state = useMachineControl.getState()
    const after = {
      machineState: state.machineState,
      job: state.job.phase,
      toolChange: state.toolChange,
      macroRunning: activeMacroRun() !== null,
      cycleStartReleases: await executeOperatorCycleStart(),
    }
    await act(async () => { await advance(2000) })
    card.off()
    return { sends: [...sends], cards: card.cards, after }
  }

  /** Stop/Reset while the change is parking: what is left afterwards. */
  async function stopWhileParking(code: string): Promise<{ sends: string[]; cards: string[]; after: unknown }> {
    selectToolMachine()
    await connectToolMachine()
    const sends = recordSends()
    const card = recordCard()
    loadAndStart('tool-change.nc', code)
    for (let i = 0; i < 400 && useMachineControl.getState().toolChange?.step !== 'parking'; i += 1) {
      await act(async () => { await advance(10) })
    }
    expect(useMachineControl.getState().toolChange?.step, consoleText()).toBe('parking')
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await act(async () => { await advance(10_000) })
    const state = useMachineControl.getState()
    const after = {
      machineState: state.machineState,
      job: state.job.phase,
      toolChange: state.toolChange,
      mpos: state.mpos,
      cycleStartReleases: await executeOperatorCycleStart(),
    }
    await act(async () => { await advance(2000) })
    card.off()
    return { sends: [...sends], cards: card.cards, after }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    vi.useRealTimers()
  })

  it('M1600 -> toolChange() makes the same controller calls and shows the same card as a programmed T2 M6', async () => {
    const programmed = await wholeChange('M6')
    const programmedConsole = consoleText()
    await reconnectFresh()
    const byMacro = await wholeChange('M1600')
    expect(byMacro.sends.length).toBeGreaterThan(10)
    expect(byMacro.sends).toEqual(programmed.sends)
    expect(byMacro.cards).toEqual(programmed.cards)
    expect(byMacro.tlo).toBeCloseTo(programmed.tlo ?? Number.NaN, 3)
    expect(programmedConsole).toContain('M6 on line 5: moving to "Fixed tool probe". Fit T2')
    expect(consoleText()).toContain('M1600 on line 5: moving to "Fixed tool probe". Fit T2')
    expect(consoleText()).toContain('running this machine\'s macro "Tool change here"')
    expect(consoleText()).not.toContain('has finished - press CYCLE START')
  })

  it('the load line counts a tool change run through a toolChange() macro: T1 M6 ... T2 M1600 runs T1, then T2', async () => {
    selectToolMachine()
    await connectToolMachine()
    const loaded = loadGcodeTextToolpathProgram('tool-list.nc', toolProgram('M1600'))
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    expect(consoleText()).toContain('It runs 2 tools: T1, then T2 - it holds at each change.')
    // Same list as the programmed T2 M6.
    useMachineControl.getState().clearConsole()
    expect(loadGcodeTextToolpathProgram('tool-list-m6.nc', toolProgram('M6')).ok).toBe(true)
    expect(consoleText()).toContain('It runs 2 tools: T1, then T2 - it holds at each change.')
  })

  it('Stop/Reset during the park ends a macro tool change exactly as it ends a programmed one', async () => {
    const programmed = await stopWhileParking('M6')
    await reconnectFresh()
    const byMacro = await stopWhileParking('M1600')
    expect(byMacro.sends.length).toBeGreaterThan(0)
    expect(byMacro.sends).toEqual(programmed.sends)
    expect(byMacro.cards).toEqual(programmed.cards)
    expect(byMacro.after).toEqual(programmed.after)
  })

  it('fix round 4: a macro on M6 runs its lines first as a prelude, then the guided change opens and completes', async () => {
    selectToolMachine([M6_PRELUDE])
    await connectToolMachine()
    const sends = recordSends()
    // WO-2764: WO-2478 runs the M6 macro at the same-tool T1 M6 too; preselect T1 so the
    // prelude under test is the one at the T2 change.
    loadAndStart('tool-change.nc', 'M6', toolProgram('M6').replace('T1 M6', 'T1'))
    // The prelude's move ends at its point before the change parks.
    let sawPrelude = false
    for (let i = 0; i < 400 && useMachineControl.getState().toolChange?.step !== 'parking'; i += 1) {
      await act(async () => { await advance(10) })
      const at = useMachineControl.getState().mpos
      if (at && Math.abs(at.x - PRELUDE_POINT.x) < 0.01 && Math.abs(at.y - PRELUDE_POINT.y) < 0.01) sawPrelude = true
    }
    expect(sawPrelude, consoleText()).toBe(true)
    await act(async () => { await advance(4000) })
    const atPad = useMachineControl.getState()
    expect(atPad.toolChange, consoleText()).toMatchObject({ mode: 'toolChange', step: 'awaiting-swap', tool: 2 })
    expect(atPad.mpos).toMatchObject({ x: PAD.x, y: PAD.y, z: PAD.z })
    const text = consoleText()
    expect(text.indexOf('shoe off')).toBeGreaterThan(-1)
    expect(text.indexOf('prelude done')).toBeGreaterThan(text.indexOf('shoe off'))
    expect(text.indexOf('Macro "Shoe off" (M6) has ended - the tool change on line 5 follows.'))
      .toBeGreaterThan(text.indexOf('prelude done'))
    expect(text.indexOf('M6 on line 5: moving to "Fixed tool probe". Fit T2'))
      .toBeGreaterThan(text.indexOf('has ended'))
    // The prelude's move went out before the change's park moves.
    const preludeSend = sends.findIndex((send) => send.includes('X60') && send.includes('Y70'))
    const parkSend = sends.findIndex((send) => send.includes(`X${PAD.x} Y${PAD.y}`))
    expect(preludeSend, sends.join('\n')).toBeGreaterThan(-1)
    expect(parkSend, sends.join('\n')).toBeGreaterThan(preludeSend)
    // The card owns the boundary: CYCLE START does not release it.
    expect(await executeOperatorCycleStart()).toBe(false)
    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await act(async () => { await advance(20_000) })
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    const t2 = useMachineToolTable.getState().tableFor(MACHINE).tools.find((tool) => tool.tool === 2)
    expect(t2?.probedMachineZ).toBeCloseTo(-40, 1)
  })

  it('fix round 4: Stop/Reset during the M6 prelude leaves the same state as Stop/Reset at a posted M6', async () => {
    const programmed = await stopWhileParking('M6')
    await reconnectFresh()
    const prelude = await stopDuringPrelude()
    const stopText = consoleText()
    // The same end: the program is over (failed - Stop/Reset at the tool
    // change, nothing loaded), the machine idle, CYCLE START releases nothing.
    // Where the machine stands differs (the Stop caught a different move), and
    // so does the card: a posted M6's Stop cuts its park short and leaves that
    // card; the prelude's Stop comes before the change starts, so no card
    // opens and nothing moves behind the Stop.
    const { mpos: _mpos, toolChange: _card, ...programmedAfter } = programmed.after as Record<string, unknown>
    const { toolChange: preludeCard, ...preludeAfter } = prelude.after as Record<string, unknown>
    // Operator ruling WO-2599: "Cancel = Stop program"; "the button says Stop program
    // and does exactly what Stop does". A posted M6 Stop now re-stages from
    // the top. The macro prelude still keeps its previous terminal contract.
    expect(preludeAfter).toEqual({ ...programmedAfter, job: 'failed', cycleStartReleases: false, macroRunning: false })
    expect(programmedAfter).toMatchObject({ job: 'ready', cycleStartReleases: true })
    expect(preludeCard).toBeNull()
    expect(stopText).toContain('Program stopped by Stop/Reset at the tool change')
    expect(prelude.cards.some((text) => text.includes('parking'))).toBe(false)
    expect(prelude.sends.some((send) => send.includes(`X${PAD.x} Y${PAD.y}`))).toBe(false)
  })

  it('fix round 4: toolChange() in a macro on a code with no meaning, on a machine with no pad park, holds for the tool', async () => {
    selectToolMachine([], false)
    await connectToolMachine()
    loadAndStart('tool-change.nc', 'M1600')
    await act(async () => { await advance(6000) })
    const text = consoleText()
    expect(text).toContain(
      'M1600 on line 5 runs the tool change. The spindle is stopped and the tool is where the file left it: fit T2, '
        + 'set its Z zero, then press CYCLE START to run the rest.',
    )
    expect(text).not.toContain('has finished - press CYCLE START')
    expect(useMachineControl.getState().job.phase).toBe('paused')
  })

  it('fix round 4: a macro on a code with no meaning that never calls toolChange() claims no tool in the load line', async () => {
    selectToolMachine([{ id: 'note-1700', name: 'Note', mCode: 1700, body: 'say("hello")' }])
    await connectToolMachine()
    expect(loadGcodeTextToolpathProgram('no-tool.nc', toolProgram('M1700')).ok).toBe(true)
    expect(consoleText()).not.toContain('T1, then T2')
  })

  it('toolChange() with no program held at its code says why and sends nothing', async () => {
    selectToolMachine()
    await connectToolMachine()
    const sends = recordSends()
    expect(runUserMacro(TOOL_CHANGE_MACRO)).toBe(true)
    await advance(1000)
    expect(consoleText()).toContain(
      'Macro "Tool change here" stopped at line 1: toolChange: no program is held at this macro\'s M-code',
    )
    expect(sends).toEqual([])
    expect(useMachineControl.getState().toolChange).toBeNull()
  })
})
