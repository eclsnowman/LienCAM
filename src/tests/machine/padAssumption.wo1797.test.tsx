// @vitest-environment jsdom
//
// WO-1797: the Tools/Probe panel states the effective part-pad assumption
// before a probe can start. The same value must survive editing, selection,
// remount, export/import and a connected session without changing the existing
// probe button contract or the fixed-setter Measure tool path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
})

type RunProbe = typeof import('../../lib/machine/machineSession').runZProbeCycle
let probeStub: null | ((mode: Parameters<RunProbe>[0], config: Parameters<RunProbe>[1]) => ReturnType<RunProbe>) = null

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runZProbeCycle: (mode, config) =>
      probeStub ? probeStub(mode, config) : actual.runZProbeCycle(mode, config),
  })
})

const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { controlMachine, persistMerge, persistPartialize, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { saveMachineToolRecord, useMachineToolTable } = await import('../../store/machineToolTableStore')
const { machineProbeOverride, resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { setProbeSensing } = await import('../../lib/machine/machineSession')

// WO-2059: Work Z0 subtracts the pad only when it is sensed through a plate
// (the first-time default is the probe on the part, no pad). These tests pin
// how the pad is stated, so each machine they show is set to the plate.
function zeroThroughPlate(machineId: string) {
  setProbeSensing(machineId, 'workZero', 'plate')
}

const PROBE_FIELD_CASES = [
  { field: 'fastFeed', testId: 'control-probe-cfg-fast', initial: 400, next: 612, shown: '612.0', gesture: 'enter' },
  { field: 'slowFeed', testId: 'control-probe-cfg-slow', initial: 50, next: 37, shown: '37.0', gesture: 'tab' },
  { field: 'retract', testId: 'control-probe-cfg-retract', initial: 2, next: 7, shown: '7.00', gesture: 'blur' },
  { field: 'maxTravel', testId: 'control-probe-cfg-travel', initial: 50, next: 100, shown: '100.00', gesture: 'tab' },
  { field: 'padThickness', testId: 'control-probe-cfg-pad', initial: 10, next: 3.16, shown: '3.16', gesture: 'enter' },
] as const

type ProbeFieldCase = (typeof PROBE_FIELD_CASES)[number]

function currentMachine() {
  return useCamStore.getState().project.machine
}

function connectIdleWith(machine = currentMachine()) {
  useCamStore.getState().setControlSessionMachine(machine)
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

function effectiveControlConfig() {
  const machine = controlMachine(useCamStore.getState())
  return resolveProbeConfig(machine.probing, machineProbeOverride(machine))
}

function makeDifferentControlMachine() {
  const camMachine = currentMachine()
  const machine = {
    ...camMachine,
    id: `wo1797-control-${crypto.randomUUID()}`,
    name: 'WO-1797 separate Control machine',
    probeOverrides: {
      fastFeed: 400,
      slowFeed: 50,
      retract: 2,
      maxTravel: 50,
      padThickness: 10,
    },
    probePads: undefined,
    activeProbePadId: undefined,
  }
  useCamStore.getState().addMachineToLibrary(machine)
  useCamStore.getState().setControlMachineId(machine.id)
  return useCamStore.getState().machineLibrary.find((entry) => entry.id === machine.id)!
}

function installAppliedSnapshot(machine: ReturnType<typeof makeDifferentControlMachine>) {
  useCamStore.getState().setControlSessionMachine(machine)
  // A matched receipt normally creates this second snapshot. This test starts
  // after that receipt because it owns the edit contract, not connection I/O.
  useCamStore.setState((state) => ({
    control: { ...state.control, appliedMachine: structuredClone(machine) },
  }))
  useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
}

function commitProbeField(fieldCase: ProbeFieldCase) {
  const input = screen.getByTestId(fieldCase.testId) as HTMLInputElement
  input.focus()
  fireEvent.change(input, { target: { value: String(fieldCase.next) } })
  if (fieldCase.gesture === 'enter') {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
  } else if (fieldCase.gesture === 'tab') {
    fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' })
    fireEvent.blur(input, { relatedTarget: screen.getByTestId('control-probe-z0') })
  } else {
    fireEvent.blur(input)
  }
}

function persistedControlMachine(machineId: string) {
  const saved = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
  const reloaded = persistMerge(saved, useCamStore.getState())
  return reloaded.machineLibrary.find((entry) => entry.id === machineId)!
}

beforeEach(() => {
  probeStub = null
  useCamStore.setState({ machineLibrary: [] })
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: `wo1797-${crypto.randomUUID()}`,
    probeOverrides: { padThickness: 3.16 },
  })
  useUiPrefs.setState({ probeSensingByMachine: {} })
  zeroThroughPlate(useCamStore.getState().project.machine.id)
  useCamStore.getState().setControlSessionMachine(null)
  useCamStore.getState().setControlMachineId(null)
  useCamStore.getState().setDisplayUnits('mm')
  useUiPrefs.setState({ machineDisplayUnits: 'default' })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WO-1797: part-pad assumption is visible before probing', () => {
  it('shows the effective 3.16 mm assumption immediately before the unchanged Probe work Z0 button', () => {
    render(<ToolsProbePanel />)

    const assumption = screen.getByTestId('control-probe-pad-assumption')
    const button = screen.getByTestId('control-probe-z0') as HTMLButtonElement
    expect(assumption.textContent).toBe('Work Z0 will be set 3.16 mm below pad contact.')
    expect(assumption.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(button.textContent).toContain('Probe work Z0')
    expect(button.disabled).toBe(true)
  })

  it('updates the statement for 10 mm, inch display, and a different Control machine', () => {
    const first = currentMachine()
    const second = {
      ...first,
      id: `wo1797-ten-${crypto.randomUUID()}`,
      name: 'Ten millimeter pad',
      probeOverrides: { ...first.probeOverrides, padThickness: 10 },
    }
    useCamStore.getState().addMachineToLibrary(first)
    useCamStore.getState().addMachineToLibrary(second)
    zeroThroughPlate(second.id)
    render(<ToolsProbePanel />)

    expect(screen.getByTestId('control-probe-pad-assumption').textContent)
      .toBe('Work Z0 will be set 3.16 mm below pad contact.')
    act(() => useCamStore.getState().setDisplayUnits('inch'))
    expect(screen.getByTestId('control-probe-pad-assumption').textContent)
      .toBe('Work Z0 will be set 0.124 in below pad contact.')

    act(() => useCamStore.getState().setControlMachineId(second.id))
    expect(screen.getByTestId('control-probe-pad-assumption').textContent)
      .toBe('Work Z0 will be set 0.394 in below pad contact.')
    expect((screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).value).toBe('0.394')
  })

  it('uses a connected edit immediately at the real Probe work Z0 boundary and keeps it on remount', async () => {
    const machine = currentMachine()
    useCamStore.getState().addMachineToLibrary(machine)
    connectIdleWith(machine)
    const actualConfigs: Parameters<RunProbe>[1][] = []
    probeStub = async (mode, config) => {
      expect(mode).toBe('workZero')
      actualConfigs.push(config)
      return { ok: false, message: 'Intercepted before motion.', probedMachineZ: null }
    }

    render(<ToolsProbePanel />)
    const pad = screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement
    fireEvent.change(pad, { target: { value: '10' } })
    fireEvent.blur(pad)

    const shown = (screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).value
    const saved = useCamStore.getState().machineLibrary.find((entry) => entry.id === machine.id)!
    const resolved = resolveProbeConfig(
      controlMachine(useCamStore.getState()).probing,
      machineProbeOverride(controlMachine(useCamStore.getState())),
    )
    expect({ shown, saved: saved.probeOverrides?.padThickness, resolved: resolved.padThickness })
      .toEqual({ shown: '10.00', saved: 10, resolved: 10 })

    const button = screen.getByTestId('control-probe-z0') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => { fireEvent.click(button) })
    expect(actualConfigs.map((config) => config.padThickness)).toEqual([10])
    expect(screen.queryByRole('dialog')).toBeNull()

    cleanup()
    render(<ToolsProbePanel />)
    expect((screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).value).toBe('10.00')
    expect(screen.getByTestId('control-probe-pad-assumption').textContent)
      .toBe('Work Z0 will be set 10.00 mm below pad contact.')
  })

  it('adds, edits and selects saved pads through export/import, reconnect and two-machine isolation', () => {
    const original = currentMachine()
    useCamStore.getState().addMachineToLibrary(original)
    render(<ToolsProbePanel />)

    fireEvent.click(screen.getByTestId('control-probe-pad-add'))
    fireEvent.click(screen.getByTestId('control-probe-pad-add'))
    let pad = screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement
    fireEvent.change(pad, { target: { value: '10' } })
    fireEvent.blur(pad)

    const select = screen.getByTestId('control-probe-pad-select') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Pad 1 - 3.16 mm',
      'Pad 2 - 10.00 mm',
    ])
    fireEvent.change(select, { target: { value: 'pad-1' } })
    expect((screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).value).toBe('3.16')

    const savedOriginal = useCamStore.getState().machineLibrary.find((entry) => entry.id === original.id)!
    expect(savedOriginal).toMatchObject({
      activeProbePadId: 'pad-1',
      probePads: [
        { id: 'pad-1', thickness: 3.16 },
        { id: 'pad-2', thickness: 10 },
      ],
    })
    expect(savedOriginal.probeOverrides?.padThickness).toBeUndefined()

    const imported = {
      ...JSON.parse(JSON.stringify(savedOriginal)),
      id: `wo1797-imported-${crypto.randomUUID()}`,
      name: 'Imported pad choices',
    }
    zeroThroughPlate(imported.id)
    act(() => {
      useCamStore.getState().addMachineToLibrary(imported)
      useCamStore.getState().setControlMachineId(imported.id)
    })
    expect((screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).value).toBe('3.16')

    fireEvent.change(screen.getByTestId('control-probe-pad-select'), { target: { value: 'pad-2' } })
    expect((screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).value).toBe('10.00')
    const savedImported = useCamStore.getState().machineLibrary.find((entry) => entry.id === imported.id)!

    act(() => connectIdleWith(savedImported))
    cleanup()
    render(<ToolsProbePanel />)
    expect(screen.getByTestId('control-probe-pad-assumption').textContent)
      .toBe('Work Z0 will be set 10.00 mm below pad contact.')

    act(() => {
      useCamStore.getState().setControlSessionMachine(null)
      useCamStore.getState().setControlMachineId(original.id)
    })
    pad = screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement
    expect(pad.value).toBe('3.16')
    expect(useCamStore.getState().machineLibrary.find((entry) => entry.id === imported.id)?.activeProbePadId)
      .toBe('pad-2')
  })
})

describe('WO-1797: all five probe fields share the live definition commit path', () => {
  it.each(PROBE_FIELD_CASES)(
    'connected applied snapshot commits $field at the rendered panel -> routine boundary',
    async (fieldCase) => {
      const camMachine = currentMachine()
      const machine = makeDifferentControlMachine()
      expect(effectiveControlConfig()[fieldCase.field]).toBe(fieldCase.initial)
      installAppliedSnapshot(machine)

      const actualConfigs: Parameters<RunProbe>[1][] = []
      probeStub = async (mode, config) => {
        expect(mode).toBe('workZero')
        actualConfigs.push(config)
        return { ok: false, message: 'Intercepted before motion.', probedMachineZ: null }
      }

      render(<ToolsProbePanel />)
      commitProbeField(fieldCase)
      expect(actualConfigs).toHaveLength(0)

      // Keep this boundary assertion first. With the pre-WO-1797 save path,
      // the applied snapshot still supplies the old value here even though
      // the cache/library write succeeded; that is the decisive old-source
      // control, not an assertion about the new pad-choice UI.
      await act(async () => { fireEvent.click(screen.getByTestId('control-probe-z0')) })
      expect(actualConfigs.at(-1)?.[fieldCase.field]).toBe(fieldCase.next)

      const saved = useCamStore.getState().machineLibrary.find((entry) => entry.id === machine.id)!
      expect(saved.probeOverrides?.[fieldCase.field]).toBe(fieldCase.next)
      expect(effectiveControlConfig()[fieldCase.field]).toBe(fieldCase.next)
      expect((screen.getByTestId(fieldCase.testId) as HTMLInputElement).value).toBe(fieldCase.shown)
      expect(useCamStore.getState().project.machine).toBe(camMachine)

      cleanup()
      render(<ToolsProbePanel />)
      expect((screen.getByTestId(fieldCase.testId) as HTMLInputElement).value).toBe(fieldCase.shown)

      const reloaded = persistedControlMachine(machine.id)
      expect(reloaded.probeOverrides?.[fieldCase.field]).toBe(fieldCase.next)

      act(() => {
        useCamStore.getState().setControlSessionMachine(null)
        installAppliedSnapshot(reloaded)
      })
      cleanup()
      render(<ToolsProbePanel />)
      expect((screen.getByTestId(fieldCase.testId) as HTMLInputElement).value).toBe(fieldCase.shown)
      await act(async () => { fireEvent.click(screen.getByTestId('control-probe-z0')) })
      expect(actualConfigs.at(-1)?.[fieldCase.field]).toBe(fieldCase.next)
    },
  )

  it.each(PROBE_FIELD_CASES)(
    'disconnected selected Control machine commits $field through remount, persisted reload and reconnect',
    async (fieldCase) => {
      const camMachine = currentMachine()
      const machine = makeDifferentControlMachine()
      render(<ToolsProbePanel />)

      commitProbeField(fieldCase)
      const saved = useCamStore.getState().machineLibrary.find((entry) => entry.id === machine.id)!
      expect(saved.probeOverrides?.[fieldCase.field]).toBe(fieldCase.next)
      expect(effectiveControlConfig()[fieldCase.field]).toBe(fieldCase.next)
      expect((screen.getByTestId(fieldCase.testId) as HTMLInputElement).value).toBe(fieldCase.shown)
      expect(useCamStore.getState().project.machine).toBe(camMachine)

      cleanup()
      render(<ToolsProbePanel />)
      expect((screen.getByTestId(fieldCase.testId) as HTMLInputElement).value).toBe(fieldCase.shown)

      const reloaded = persistedControlMachine(machine.id)
      expect(reloaded.probeOverrides?.[fieldCase.field]).toBe(fieldCase.next)
      const actualConfigs: Parameters<RunProbe>[1][] = []
      probeStub = async (_mode, config) => {
        actualConfigs.push(config)
        return { ok: false, message: 'Intercepted before motion.', probedMachineZ: null }
      }

      act(() => installAppliedSnapshot(reloaded))
      cleanup()
      render(<ToolsProbePanel />)
      expect((screen.getByTestId(fieldCase.testId) as HTMLInputElement).value).toBe(fieldCase.shown)
      expect(actualConfigs).toHaveLength(0)
      await act(async () => { fireEvent.click(screen.getByTestId('control-probe-z0')) })
      expect(actualConfigs.at(-1)?.[fieldCase.field]).toBe(fieldCase.next)
    },
  )

  it('keeps the click-time config stable and the settings disabled while a probe is in flight', async () => {
    const machine = makeDifferentControlMachine()
    installAppliedSnapshot(machine)
    let release: ((result: { ok: false; message: string; probedMachineZ: null }) => void) | undefined
    const actualConfigs: Parameters<RunProbe>[1][] = []
    probeStub = (_mode, config) => {
      actualConfigs.push(config)
      return new Promise((resolve) => { release = resolve })
    }

    render(<ToolsProbePanel />)
    commitProbeField(PROBE_FIELD_CASES[4])
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-z0')) })
    const captured = actualConfigs[0]
    expect(captured.padThickness).toBe(3.16)
    expect((screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement).disabled).toBe(true)

    act(() => {
      useMachineToolTable.getState().setProbeConfig(machine.id, { padThickness: 8.5 })
      saveMachineToolRecord(controlMachine(useCamStore.getState()))
    })
    expect(captured.padThickness).toBe(3.16)

    await act(async () => {
      release?.({ ok: false, message: 'Intercepted before motion.', probedMachineZ: null })
      await Promise.resolve()
    })
  })
})
