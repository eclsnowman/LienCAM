// @vitest-environment jsdom
//
// MACHINE-CONTROL stage 11: park positions - sequence math, per-machine store
// CRUD (incl. configs persisted before parks existed), the homing guard end
// to end against the simulator, and the Macros-panel park buttons.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

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

const { buildParkSequence } = await import('../../lib/machine/machineActions')
const { useMachineActions, parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { withMachineSafeZ } = await import('../../types')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runParkMove,
  sendAppCommand,
} = await import('../../lib/machine/machineSession')

const PARK = { id: 'p1', label: 'Corner NE', x: 700, y: 700 }

/** Park exercises a positive XY table and a negative Z safe-height frame.
 * Declare that mixed coordinate convention before connecting the simulator. */
function selectParkMachineFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'park-mixed-frame-machine',
    name: 'Park mixed-frame fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 738, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

describe('buildParkSequence', () => {
  it('refuses without a safe Z and never guesses one', () => {
    const out = buildParkSequence(PARK, null)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('safe Z')
  })

  it('raises to safe Z first, then rapids XY, all in machine coords and millimetres', () => {
    const out = buildParkSequence(PARK, -2)
    expect(out).toEqual({ ok: true, lines: ['G21 G90 G53 G0 Z-2', 'G21 G90 G53 G0 X700 Y700'] })
  })
})

describe('machineActionsStore parks', () => {
  beforeEach(() => useMachineActions.setState({ byMachine: {} }))

  it('CRUD per machine, including configs saved before parks existed', () => {
    const s = () => useMachineActions.getState()
    // A stage-9-era config with no parks key at all. Safe Z is no longer a
    // key on this config at all (WO-1710: it lives only on the machine
    // record, read through withMachineSafeZ/machineSafeZ - see
    // safeZOnePlace.wo1702.test.ts for a leftover-key config that persists
    // that field anyway and is still ignored).
    useMachineActions.setState({ byMachine: { m1: { overrides: {}, custom: [] } } })
    s().addPark('m1', PARK)
    expect(s().byMachine.m1.parks).toEqual([PARK])
    s().updatePark('m1', { ...PARK, x: 10 })
    expect(s().byMachine.m1.parks![0].x).toBe(10)
    s().removePark('m1', 'p1')
    expect(s().byMachine.m1.parks).toEqual([])
    // Other machines untouched.
    expect(s().byMachine.m2).toBeUndefined()
  })
})

describe('runParkMove end to end (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectParkMachineFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    // WO-328 (47b49e15/d9557456): a session starts E-STOP-latched and
    // refuses all motion until reset, per controlTabRegrid.test.tsx.
    act(() => { __resetEstopInterlockForTest() })
  })

  afterEach(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('refuses unhomed, then parks in machine coords ignoring work offsets', async () => {
    const refused = runParkMove(PARK, -2)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('Home')

    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    // A non-zero work offset must NOT bend a park move (G53 = machine frame).
    getMachineController().sendCommand('G10 L2 P1 X100 Y100 Z-50')
    await vi.advanceTimersByTimeAsync(50)

    const park = { id: 'p2', label: 'Near', x: 20, y: 10 }
    const ok = runParkMove(park, -2)
    expect(ok.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(3000) // rapids finish
    const s = useMachineControl.getState()
    expect(s.mpos?.x).toBeCloseTo(20, 1)
    expect(s.mpos?.y).toBeCloseTo(10, 1)
    expect(s.mpos?.z).toBeCloseTo(-2, 1) // parked at safe Z, not work Z
  })

  it('an inch operator (G20) parks at the same machine position and is in inch again after', async () => {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    sendAppCommand('G20')
    getMachineController().refreshState()
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')

    const ok = runParkMove({ id: 'p2', label: 'Near', x: 20, y: 10 }, -2)
    expect(ok.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    getMachineController().refreshState()
    await vi.advanceTimersByTimeAsync(100)
    const s = useMachineControl.getState()
    expect(s.mpos?.x).toBeCloseTo(20, 1)
    expect(s.mpos?.y).toBeCloseTo(10, 1)
    expect(s.mpos?.z).toBeCloseTo(-2, 1)
    expect(s.parserModal?.units).toBe('inch')
  })

  it('refuses with a plain reason when safe Z is unset', async () => {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    const out = runParkMove(PARK, null)
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('safe Z')
  })
})

describe('MacroPanel park buttons', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {} })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: false,
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
    // homed gate on park buttons, not the E-STOP latch.
    __resetEstopInterlockForTest()
  })

  afterEach(() => cleanup())

  it('renders park buttons, disabled until homed', () => {
    const machineId = useCamStore.getState().project.machine?.id ?? 'default'
    useMachineActions.getState().addPark(machineId, PARK)
    // WO-1710: Safe Z has one editor - the machine record itself.
    saveParkMachineRecord(withMachineSafeZ(parkCarrierMachine(useCamStore.getState()), -2))
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    const btn = screen.getByTestId('control-park-p1') as HTMLButtonElement
    expect(btn.textContent).toContain('Corner NE')
    expect(btn.disabled).toBe(true) // not homed
    act(() => useMachineControl.setState({ homed: true }))
    expect((screen.getByTestId('control-park-p1') as HTMLButtonElement).disabled).toBe(false)
  })

  it('surfaces a park refusal reason in the panel', () => {
    const machineId = useCamStore.getState().project.machine?.id ?? 'default'
    useMachineActions.getState().addPark(machineId, PARK)
    // No safe Z set; homed so the button is enabled and the refusal comes
    // from the sequence builder. (The module-side controller is disconnected
    // in jsdom, so the click path refuses even earlier - either message is a
    // plain-language refusal shown in the panel.)
    useMachineControl.setState({ homed: true })
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    fireEvent.click(screen.getByTestId('control-park-p1'))
    expect(screen.getByTestId('control-park-error').textContent?.length).toBeGreaterThan(10)
  })
})
