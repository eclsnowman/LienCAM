// @vitest-environment jsdom
//
// WO-1756: the simulator is selected by connection kind, but its language is
// selected by the session machine. These checks connect the real session
// singleton twice so the SimulatedController constructor seam is covered, not
// just a direct fixture that supplies its own PostConfig.

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
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')

type MachineController = import('../../lib/machine/controller').MachineController
type MachineConfig = import('../../types').MachineConfig
type Project = import('../../types').Project

function machine(controller: 'uccnc' | 'grbl'): MachineConfig {
  return {
    ...useCamStore.getState().project.machine,
    id: `wo1756-${controller}`,
    name: `WO-1756 ${controller}`,
    controller,
    controllerDefinition: undefined,
    unsentSettings: undefined,
    macros: undefined,
    macroMCodeRange: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 4000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  }
}

function install(target: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

async function connectSimulator(target: MachineConfig): Promise<MachineController> {
  install(target)
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  return getMachineController()
}

describe("WO-1756: the simulator speaks the session machine's declared dialect", () => {
  let originalProject: Project
  let originalLibrary: MachineConfig[]
  let originalControl: ReturnType<typeof useCamStore.getState>['control']

  beforeEach(() => {
    vi.useFakeTimers()
    memory.clear()
    const state = useCamStore.getState()
    originalProject = state.project
    originalLibrary = state.machineLibrary
    originalControl = state.control
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
    })
    useMachineControl.setState({ consoleLines: [] })
    vi.useRealTimers()
  })

  it('keeps UCCNC typed M2001 wording and executes a G53 machine-coordinate move', async () => {
    const controller = await connectSimulator(machine('uccnc'))
    expect(controller.home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)

    const macro = await controller.sendCommandAwait('M2001')
    expect(macro).toEqual({
      ok: false,
      message: 'M2001 calls a UCCNC user macro, and this route does not run macros, so it was not run.',
    })

    expect(await controller.sendCommandAwait('G53 G0 X5')).toEqual({ ok: true, message: null })
    await vi.advanceTimersByTimeAsync(250)
    expect(controller.status().machinePos?.x).toBeCloseTo(5, 3)
  })

  it('routes a GRBL session to GRBL word handling and GRBL homing wording', async () => {
    const controller = await connectSimulator(machine('grbl'))

    const word = await controller.sendCommandAwait('M2001')
    expect(word?.ok).toBe(false)
    expect(word?.message).toContain('M2001 is not in the GRBL G-code word table')
    expect(word?.message).not.toContain('UCCNC')

    expect(controller.loadJob('$H\n')).toEqual({
      ok: false,
      reason: "Line 1: $H is GRBL's homing command, which cannot be executed inside a loaded software-simulator program.",
    })
  })

  it('keeps the app-native M6 boundary loadable for a GRBL session', async () => {
    const controller = await connectSimulator(machine('grbl'))

    expect(controller.loadJob('G21\nT1 M6\nM30\n')).toMatchObject({ ok: true })
  })
})
