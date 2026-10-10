// @vitest-environment jsdom
//
// WO-1755: GRBL and grblHAL make the homing switch machine zero. A stale
// definition may still carry the old LienCAM-only choice (home at max with a
// homing value of +travel), but neither reader nor editor may let that move
// zero away from the switch. UCCNC keeps its controller-defined home value.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  axisHomingIsStated,
  axisHomingStatementKey,
  createDefaultControllerDefinition,
  machineHomeConvention,
  withAxisHomingStated,
  type ControllerType,
  type MachineConfig,
  type Project,
} from '../../types'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import { withAxisTravelEdited } from '../../lib/machine/axisSoftLimitEdit'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __reportWorkOffsetsForTest,
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  stagedGeometryProgramPath,
} = await import('../../lib/machine/machineSession')
const realUpdateMachineInLibrary = useCamStore.getState().updateMachineInLibrary

function machine(controller: ControllerType): MachineConfig {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  definition.homing.perAxis.X = {
    ...definition.homing.perAxis.X!,
    direction: 'positive',
    homingValue: 738,
  }
  definition.stated = [
    { controller, key: axisHomingStatementKey('X', 'direction') },
    { controller, key: axisHomingStatementKey('X', 'homingValue') },
  ]
  return {
    id: `wo1755-${controller}`,
    name: `WO-1755 ${controller} router`,
    type: 'gantry_router',
    controller,
    travel: { x: 738, y: 400, z: 100 },
    rapidRate: 5000,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'min' },
    },
    controllerDefinition: definition,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
  }
}

function seedLibrary(value: MachineConfig): void {
  act(() => {
    useCamStore.setState((state) => ({
      machineLibrary: [value],
      project: { ...state.project, machine: value },
      updateMachineInLibrary: realUpdateMachineInLibrary,
      appSettings: { ...state.appSettings, defaultMachineId: null, displayUnits: 'mm' },
    }))
    useCamStore.getState().closeModal()
  })
}

function openHomingTable(value: MachineConfig): void {
  seedLibrary(value)
  render(createElement(MachineLibraryModal))
  act(() => { useCamStore.getState().openModal('machine-config') })
  const disclosure = screen.getByTestId('disclosure-machine-home-convention')
  if (disclosure.getAttribute('aria-expanded') !== 'true') fireEvent.click(disclosure)
}

function installSessionMachine(value: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [value],
    project: { ...state.project, machine: value, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: value.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

afterEach(() => {
  cleanup()
  mem.clear()
  useCamStore.setState({ updateMachineInLibrary: realUpdateMachineInLibrary })
})

describe('WO-1755 GRBL zero follows the homing switch', () => {
  it.each(['grbl', 'grblhal'] as const)(
    '%s ignores a persisted +738 homing value and resolves -738..0 with G28 at machine zero',
    (controller) => {
      const value = machine(controller)
      expect(value.controllerDefinition!.homing.perAxis.X!.homingValue).toBe(738)
      expect(machineHomeConvention(value)!.x).toEqual({ homesToward: 'max', machineZeroAt: 'max' })

      const motion = resolveMachineMotion({ machine: value, connectionKind: null })
      expect(motion.envelope.x).toMatchObject({
        min: -738,
        max: 0,
        homesToward: 'max',
        homePositionMm: 0,
      })
    },
  )

  it('also binds zero to the switch for a GRBL record with only the CAM lens', () => {
    const value = machine('grbl')
    delete value.controllerDefinition
    expect(machineHomeConvention(value)).toEqual({
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    })
  })

  it('normalizes a Machine-area homing-value write to zero instead of stating it', () => {
    const value = machine('grbl')
    const written = withAxisHomingStated(value.controllerDefinition!, 'grbl', 'X', ['homingValue'])
    expect(written.homing.perAxis.X!.homingValue).toBe(0)
    expect(axisHomingIsStated({ controller: 'grbl', controllerDefinition: written }, 'X', 'homingValue')).toBe(false)
  })

  it('a travel edit cannot carry a stale GRBL homing value to the new far end', () => {
    const value = machine('grbl')
    const written = withAxisTravelEdited(value, 'X', -700, 0)!
    expect(written.homing.perAxis.X!.homingValue).toBe(0)
  })

  it('does not offer a machine-zero-end choice in the GRBL Machine Library lens', () => {
    openHomingTable(machine('grbl'))
    expect(screen.getByTestId('disclosure-machine-home-convention').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('X home switch location')).toBeTruthy()
    expect(screen.queryByLabelText('X machine zero location')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Machine zero location' })).toBeNull()
    expect(screen.getByTestId('machine-envelope-range-x').textContent).toBe('-738 .. 0')
  })

  it('keeps UCCNC homing value 738, 0..738 envelope, and both library choices', () => {
    const value = machine('uccnc')
    const written = withAxisHomingStated(value.controllerDefinition!, 'uccnc', 'X', ['homingValue'])
    expect(written.homing.perAxis.X!.homingValue).toBe(738)
    expect(axisHomingIsStated({ controller: 'uccnc', controllerDefinition: written }, 'X', 'homingValue')).toBe(true)
    expect(machineHomeConvention({ ...value, controllerDefinition: written })!.x)
      .toEqual({ homesToward: 'max', machineZeroAt: 'min' })
    expect(resolveMachineMotion({ machine: value, connectionKind: null }).envelope.x)
      .toMatchObject({ min: 0, max: 738, homesToward: 'max', homePositionMm: 738 })

    openHomingTable(value)
    expect(screen.getByLabelText('X machine zero location')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Machine zero location' })).toBeTruthy()
  })
})

describe('WO-1755 G28 reads the same controller-shaped home as motion resolution', () => {
  let originalProject: Project
  let originalLibrary: MachineConfig[]
  let originalControl: ReturnType<typeof useCamStore.getState>['control']
  let originalMachineWorkOffsets: ReturnType<typeof useCamStore.getState>['machineWorkOffsets']

  beforeEach(() => {
    vi.useFakeTimers()
    const state = useCamStore.getState()
    originalProject = state.project
    originalLibrary = state.machineLibrary
    originalControl = state.control
    originalMachineWorkOffsets = state.machineWorkOffsets
    useMachineControl.setState({ consoleLines: [] })
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    }
    useCamStore.setState({
      project: originalProject,
      machineLibrary: originalLibrary,
      control: originalControl,
      machineWorkOffsets: originalMachineWorkOffsets,
    })
    clearPathFidelity()
    useMachineControl.setState({ consoleLines: [], parserModal: null })
    useMachineControl.getState().setProgram(null, null, [], null)
    vi.useRealTimers()
  })

  async function connectSimulatorTo(value: MachineConfig): Promise<void> {
    installSessionMachine(value)
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    // The audit reproduction's work move remains inside GRBL's signed table;
    // only the machine-frame G28 target distinguishes the broken reader.
    __reportWorkOffsetsForTest({ G54: { x: -10, y: -10, z: -10 } })
    useMachineControl.getState().setProgram(null, null, [], null)
  }

  it.each([
    ['grbl', 'a stated definition', true],
    ['grbl', 'only the CAM lens', false],
    ['grblhal', 'a stated definition', true],
    ['grblhal', 'only the CAM lens', false],
  ] as const)(
    '%s with %s resolves the audit G28 reproduction to machine zero',
    async (controller, _lens, withDefinition) => {
      const value = machine(controller)
      value.homeConvention = {
        x: { homesToward: 'max', machineZeroAt: 'min' },
        y: { homesToward: 'max', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'min' },
      }
      if (!withDefinition) delete value.controllerDefinition
      await connectSimulatorTo(value)

      const loaded = loadGcodeTextToolpathProgram(
        'audit-g28.nc',
        'G28\nG1 X0.5 Y0.5 F100',
      )
      expect(loaded).toEqual({ ok: true, reason: null })
      // G54 is machine {-10, -10, -10}; the staged work-coordinate home legs
      // therefore end at machine {0, 0, 0}, the three switches. WO-2596: G28
      // goes home in the homing order, one axis per rapid - Z, then X, then Y.
      expect(stagedGeometryProgramPath()?.moves.slice(0, 3)).toMatchObject([
        { type: 'rapid', role: 'rapid', x: -5, y: -5, z: 10 },
        { type: 'rapid', role: 'rapid', x: 10, y: -5, z: 10 },
        { type: 'rapid', role: 'rapid', x: 10, y: 10, z: 10 },
      ])
    },
  )

  it('keeps UCCNC G28 on its stated nonzero home coordinates', async () => {
    await connectSimulatorTo(machine('uccnc'))
    expect(loadGcodeTextToolpathProgram('uccnc-g28.nc', 'G28')).toEqual({ ok: true, reason: null })
    // The same G54 maps these staged work rapids back to machine
    // {738, -400, 100}, preserving UCCNC's stored/stated semantics. WO-2596:
    // one axis per rapid in the homing order - Z, then X, then Y.
    expect(stagedGeometryProgramPath()?.moves).toMatchObject([
      { type: 'rapid', role: 'rapid', x: 733, y: -395, z: 110 },
      { type: 'rapid', role: 'rapid', x: 748, y: -395, z: 110 },
      { type: 'rapid', role: 'rapid', x: 748, y: -390, z: 110 },
    ])
  })
})
