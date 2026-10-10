// @vitest-environment jsdom
//
// WO-1681 - PARKS ARE A MACRO TYPE; THE SEPARATE PARK SECTION GOES.
//
// Operator's ruling: one system, not two ("I want to avoid a lot of similar
// systems to create specific functionality... write once run anywhere"). A
// park is now a macro whose body is the built-in "go to machine position (Z
// first)" step - on the SAME model as every other macro (WO-1680) - so it is
// a button like any other and can carry other steps before or after it.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { convertParksToMacros, createDefaultControllerDefinition, UNASSIGNED_PIN, positionMacroBody, parsePositionMacroBody } = await import('../../types')
type MachineConfig = import('../../types').MachineConfig
type MachineMacro = import('../../types').MachineMacro
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  __resetEstopInterlockForTest,
  __reportWorkOffsetsForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

// Operator's four corners, exactly as read off machine PC (LIENCNC_REFERENCE_POSITIONS).
// Z is positive here (this fixture's Z home convention is min/min, like X/Y).
const CORNERS: Array<{ id: string; label: string; x: number; y: number; z: number; mCode: number }> = [
  { id: 'p200', label: 'Corner 1', x: 738, y: 724.5, z: 128, mCode: 200 },
  { id: 'p201', label: 'Corner 2', x: 738, y: 50, z: 128, mCode: 201 },
  { id: 'p202', label: 'Corner 3', x: 50, y: 50, z: 128, mCode: 202 },
  { id: 'p203', label: 'Corner 4', x: 50, y: 724.5, z: 128, mCode: 203 },
]

describe('WO-1681: a saved park list is converted into macros at load', () => {
  it('a legacy `parks` list becomes position macros, and the field itself is gone', () => {
    const legacy = {
      ...useCamStore.getState().project.machine,
      id: 'wo1681-legacy',
      parks: CORNERS.map((c) => ({
        id: c.id, label: c.label, x: c.x, y: c.y, z: c.z, zFirst: true, mCode: c.mCode, source: { kind: 'typed' },
      })),
    }
    useCamStore.getState().setProjectMachine(legacy as unknown as MachineConfig)
    const loaded = useCamStore.getState().project.machine
    expect('parks' in loaded).toBe(false)
    expect(loaded.macros?.map((m) => [m.id, m.name, m.mCode, parsePositionMacroBody(m.body)])).toEqual(
      CORNERS.map((c) => [c.id, c.label, c.mCode, { x: c.x, y: c.y, z: c.z, zFirst: true }]),
    )
  })
})

describe('WO-1681: G30 Pn and a typed M-code reach the same position macro', () => {
  const HAND_MADE_ID = 'wo1681-hand-made'

  function selectMachine(macros: MachineMacro[]): void {
    // WO-1362: GRBL owns its own G30 register on the text route, so a
    // typed `G30 Pn` only resolves against the definition on a controller
    // that does NOT own it (UCCNC here) - the same split g30ParkPositions
    // tests. The bound-M-code route (used elsewhere in this file) works on
    // any controller.
    const machine = useCamStore.getState().project.machine
    const controllerDefinition = createDefaultControllerDefinition()
    for (const axis of controllerDefinition.axes) {
      axis.softLimitMin = 0
      axis.softLimitMax = axis.axis === 'Z' ? 200 : 800
    }
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: HAND_MADE_ID,
      name: 'WO-1681 corners',
      controller: 'uccnc',
      controllerDefinition,
      unsentSettings: undefined,
      travel: { x: 800, y: 800, z: 200 },
      rapidRate: 60000,
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'min', machineZeroAt: 'min' },
      },
      macros,
      safeZMachine: -1,
    })
  }

  const macros: MachineMacro[] = CORNERS.map((c) => ({
    id: c.id,
    name: c.label,
    mCode: c.mCode,
    body: positionMacroBody({ x: c.x, y: c.y, z: c.z, zFirst: true }),
  }))

  beforeEach(async () => {
    vi.useFakeTimers()
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine(macros)
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    act(() => { __resetEstopInterlockForTest() })
    act(() => { __reportWorkOffsetsForTest({ G54: { x: 0, y: 0, z: 0 } }) })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  })

  afterEach(async () => {
    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('the Macros panel shows all four corners as buttons, in order', () => {
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    const grid = screen.getByTestId('control-user-macro-grid')
    for (const c of CORNERS) {
      expect(grid.textContent).toContain(c.label)
    }
  })

  it('pressing a corner button moves Z first, then X Y, as a machine position', async () => {
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-user-macro-p201'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000)
    })
    const s = useMachineControl.getState()
    expect(s.mpos?.x).toBeCloseTo(738, 1)
    expect(s.mpos?.y).toBeCloseTo(50, 1)
    expect(s.mpos?.z).toBeCloseTo(128, 1)
  })

  it('G30 P2 and typed M201 both reach Corner 2', async () => {
    expect(sendMdiLine('M201')).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    const afterM = useMachineControl.getState().mpos
    expect(afterM?.x).toBeCloseTo(738, 1)
    expect(afterM?.y).toBeCloseTo(50, 1)
    expect(afterM?.z).toBeCloseTo(128, 1)

    // Move away, then let G30 P2 bring it back.
    getMachineController().jog('X', 10, 1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sendMdiLine('G30 P2')).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    const afterG30 = useMachineControl.getState().mpos
    expect(afterG30?.x).toBeCloseTo(738, 1)
    expect(afterG30?.y).toBeCloseTo(50, 1)
    expect(afterG30?.z).toBeCloseTo(128, 1)
  })
})

describe('WO-1681: a park that also switches an output runs both steps', () => {
  const HAND_MADE_ID = 'wo1681-park-plus-output'

  function selectMachine(): void {
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: HAND_MADE_ID,
      name: 'Park plus output',
      controller: 'grbl',
      controllerDefinition: {
        ...createDefaultControllerDefinition(),
        outputs: [{ name: 'Vacuum', onCode: 'M7', offCode: 'M9', pin: { ...UNASSIGNED_PIN } }],
      },
      unsentSettings: undefined,
      travel: { x: 800, y: 800, z: 200 },
      rapidRate: 60000,
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
      macros: [
        {
          id: 'p1',
          name: 'Park and vacuum',
          body: "goTo({x: 15, y: 25, z: -4})\noutput('Vacuum', true)",
        },
      ],
      safeZMachine: -1,
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  })

  afterEach(async () => {
    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('moves to the position, then switches the output', async () => {
    const ctrl = getMachineController()
    const original = ctrl.sendCommand.bind(ctrl)
    const sent: string[] = []
    vi.spyOn(ctrl, 'sendCommand').mockImplementation((text: string) => {
      sent.push(text)
      return original(text)
    })

    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-user-macro-p1'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    const s = useMachineControl.getState()
    expect(s.mpos?.x).toBeCloseTo(15, 1)
    expect(s.mpos?.y).toBeCloseTo(25, 1)
    expect(s.mpos?.z).toBeCloseTo(-4, 1)
    expect(sent).toContain('M7')
  })
})

describe('WO-1681: the definition editor has no Park section', () => {
  it('Machine actions shows no Park positions section', () => {
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {} })
    render(<MachineActionsModal open onClose={() => {}} />)
    expect(screen.queryByTestId('machine-parks-section')).toBeNull()
    expect(screen.queryByTestId('control-park-add')).toBeNull()
  })
})

// WO-1681 FIX ROUND: independent audit found guided tool change permanently
// unreachable once ParksSection (and its "mark TC" control) was deleted -
// nothing designated which park was over the probe pad. The outcome: which
// macro the guided change parks at is a property of THAT MACRO in the one
// macro model, set on the Macros panel - not a separate designation table.
describe('WO-1681 fix round: guided tool change reads the macro flagged "used for tool change"', () => {
  const MACHINE_ID = 'wo1681-tc-macro'
  const PARK_A: MachineMacro = {
    id: 'parkA',
    name: 'Park A',
    body: positionMacroBody({ x: 5, y: 5, z: -2, zFirst: true }),
  }
  const PARK_B: MachineMacro = {
    id: 'parkB',
    name: 'Park B (probe pad)',
    body: positionMacroBody({ x: 9, y: 9, z: -2, zFirst: true }),
  }
  const PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')

  function configureMachine(): void {
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: MACHINE_ID,
      name: 'WO-1681 TC macro simulator',
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
      macros: [PARK_A, PARK_B],
      safeZMachine: -2,
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    mem.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  })

  afterEach(async () => {
    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('setting the flag through the Macros panel makes that macro the tool-change park', async () => {
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)

    expect(screen.getByTestId('control-macro-tc-parkB').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTestId('control-macro-tc-parkB'))

    const macros = useCamStore.getState().project.machine.macros
    expect(macros?.find((m) => m.id === 'parkB')?.usedForToolChange).toBe(true)
    expect(macros?.find((m) => m.id === 'parkA')?.usedForToolChange).toBeFalsy()
    expect(screen.getByTestId('control-macro-tc-parkB').getAttribute('aria-pressed')).toBe('true')

    cleanup()
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    render(<ProgramPanel />)

    loadMachineProgram('wo1681-tc.nc', PROGRAM)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    // The macro flag alone (set through the Macros panel, above) is enough to
    // opt this machine into the automatic M6 flow - the same resolution the
    // manual "Guided change" button reads (`tcPark`/`toolChangePark`).
    const state = useMachineControl.getState()
    expect(state.toolChange?.step, JSON.stringify({ toolChange: state.toolChange, machineState: state.machineState })).toBe('awaiting-swap')
    expect(state.mpos?.x).toBeCloseTo(9, 1)
    expect(state.mpos?.y).toBeCloseTo(9, 1)
    expect(state.mpos?.z).toBeCloseTo(-2, 1)
  })

  async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }
})

// WO-1681 FIX ROUND 2: an independent audit found the pre-1681 wiring-store
// `toolChangeParkId` still resolving the tool-change park as a hidden second
// source, unconverted - a designated machine worked but showed unmarked on
// the Macros panel. The outcome: `convertParksToMacros` bakes that legacy id
// onto the macro it becomes, once, at load; after that the macro flag is the
// ONLY thing the guided/automatic tool change reads.
describe('WO-1681 fix round 2: a legacy toolChangeParkId converts once into the macro flag', () => {
  const MACHINE_ID = 'wo1681-legacy-tc-id'
  const LEGACY_PARKS = [
    { id: 'parkA', label: 'Park A', x: 5, y: 5, z: -2, zFirst: true },
    { id: 'parkB', label: 'Park B (probe pad)', x: 9, y: 9, z: -2, zFirst: true },
  ]
  const PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')

  // The pre-1681 wiring-store designation, set BEFORE the record carrying the
  // legacy `parks` list is adopted - `adoptMachineDocument` reads it for this
  // machine id (through the reader `machineActionsStore` registers on
  // `store/index.ts`) and bakes it onto the matching converted macro.
  function configureLegacyMachine(): void {
    useMachineActions.setState((s) => ({
      byMachine: {
        ...s.byMachine,
        [MACHINE_ID]: { overrides: {}, custom: [], toolChangeParkId: 'parkB' },
      },
    }))
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: MACHINE_ID,
      name: 'WO-1681 legacy TC id simulator',
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
      parks: LEGACY_PARKS,
      safeZMachine: -2,
    } as unknown as MachineConfig)
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    mem.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureLegacyMachine()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  })

  afterEach(async () => {
    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('the legacy id lands as the macro flag on load, and an M6 program parks there', async () => {
    const macros = useCamStore.getState().project.machine.macros
    expect(macros?.find((m) => m.id === 'parkB')?.usedForToolChange).toBe(true)
    expect(macros?.find((m) => m.id === 'parkA')?.usedForToolChange).toBeFalsy()

    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    render(<ProgramPanel />)

    loadMachineProgram('wo1681-legacy-tc.nc', PROGRAM)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    const state = useMachineControl.getState()
    expect(
      state.toolChange?.step,
      JSON.stringify({ toolChange: state.toolChange, machineState: state.machineState }),
    ).toBe('awaiting-swap')
    expect(state.mpos?.x).toBeCloseTo(9, 1)
    expect(state.mpos?.y).toBeCloseTo(9, 1)
    expect(state.mpos?.z).toBeCloseTo(-2, 1)
  })

  it('clearing the flag on the Macros panel stops the old id from steering the tool change', async () => {
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    expect(screen.getByTestId('control-macro-tc-parkB').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('control-macro-tc-parkB'))
    expect(useCamStore.getState().project.machine.macros?.find((m) => m.id === 'parkB')?.usedForToolChange)
      .toBeFalsy()
    cleanup()

    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    render(<ProgramPanel />)

    loadMachineProgram('wo1681-legacy-tc-cleared.nc', PROGRAM)
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    // No macro carries the flag any more, so the old wiring-store id (still
    // sitting unread in the machine-actions store) does not steer anything -
    // the program stays on its ordinary manual M6 hold.
    const state = useMachineControl.getState()
    expect(state.machineState).toBe('hold')
    expect(state.toolChange).toBeNull()
  })

  async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }
})

// WO-1681 safety round: a WO-1670 park saved with no Z meant "this machine's
// safe Z". With none stated it must never become a move to a height nobody
// stated (the review's machine Z 0).
describe('WO-1681 safety round: a converted park with no Z never gets an invented height', () => {
  function noZPark(axes: { softLimitMax: number; stated: boolean }): MachineConfig {
    const controllerDefinition = createDefaultControllerDefinition()
    for (const axis of controllerDefinition.axes) if (axis.axis === 'Z') axis.softLimitMax = axes.softLimitMax
    if (axes.stated) {
      controllerDefinition.stated = [{ controller: 'uccnc', key: 'axessettingscontrolZ.Softlimitpositive' }]
    }
    return {
      ...useCamStore.getState().project.machine,
      id: 'wo1681-no-z',
      controller: 'uccnc',
      controllerDefinition,
      safeZMachine: undefined,
      macros: [],
      parks: [{ id: 'front', label: 'Front', x: 100, y: 50, z: null, zFirst: true, mCode: 300, source: { kind: 'typed' } }],
    } as unknown as MachineConfig
  }

  it('with no safe Z, the stated top of Z travel is the height', () => {
    const [macro] = convertParksToMacros(noZPark({ softLimitMax: 130, stated: true })).macros!
    expect(parsePositionMacroBody(macro.body)).toEqual({ x: 100, y: 50, z: 130, zFirst: true })
    expect(macro.mCode).toBe(300)
  })

  it('with neither, the macro moves nothing and says why (a placeholder soft limit is not a height)', () => {
    const [macro] = convertParksToMacros(noZPark({ softLimitMax: 0, stated: false })).macros!
    expect(parsePositionMacroBody(macro.body)).toBeNull()
    expect(macro.body).not.toMatch(/goTo|line\(/)
    expect(macro.body).toContain('say(')
    expect(macro.body).toContain('no safe height is known')
    expect(macro.body).toContain('X100 Y50')
  })
})
