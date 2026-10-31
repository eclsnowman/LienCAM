// @vitest-environment jsdom
//
// A STEP JOG NEVER LEAVES WITH A TARGET PAST A STATED SOFT LIMIT.
//
// The real board, 2026-10-30: Z sat at machine 128.9, the definition's Z soft
// max is 129.1, and a gamepad Z+ step of 1 mm went out whole (target 129.9).
// The controller clamped it at 129.1, latched SOFT LIMIT, and buffered motion
// stayed dead until the bridge restarted. The session now shortens the step to
// stop JOG_SOFT_LIMIT_MARGIN_MM inside the limit and says so; at the limit it
// sends nothing and says so; an axis with no stated limit is untouched.
//
// Driven through the real session singleton and the real SimulatedController
// on the shipped V2 machine profile (Z soft limits 0..129.1, UCCNC-stated). The spy
// sits on the controller's own jog - the call that becomes the bridge
// command - so what it records is what the board would be sent.
//
// Every step route reaches that call through getMachineController().jog: the
// Control panel step buttons (JogPanel), keyboard step jog (useControlJogKeys),
// the gamepad step (useControlGamepadJog), the held-jog bursts (heldJog) and
// the phone pendant step (pendantMachine). The panel/keyboard/gamepad call
// getMachineController().jog directly; the pendant goes through its own
// executor, so it is driven here as a second entry point.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { MachineConfig } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { SimulatedController } = await import('../../lib/machine/simulatedController')
const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')
const {
  __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController,
  jogStepWithinSoftLimits, JOG_SOFT_LIMIT_MARGIN_MM,
} = session

const PROFILE = JSON.parse(readFileSync(
  resolve('docs/machine/profiles/LienCNCV2.machine.json'),
  'utf8',
)) as MachineConfig

/** The same machine with its Z soft limits no longer stated. */
function withoutStatedZSoftLimits(machine: MachineConfig): MachineConfig {
  const def = machine.controllerDefinition!
  const isZSoftLimit = (entry: { key: string; appKey?: string }) =>
    /axessettingscontrolZ\.Softlimit|axes\.Z\.softLimit/i.test(entry.key)
    || (entry.appKey !== undefined && /axes\.Z\.softLimit/i.test(entry.appKey))
  return {
    ...machine,
    controllerDefinition: {
      ...def,
      settings: (def.settings ?? []).filter((entry) => !isZSoftLimit(entry)),
      stated: (def.stated ?? []).filter((entry) => !isZSoftLimit(entry)),
    },
  }
}

function install(target: MachineConfig): void {
  useCamStore.setState((state) => ({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
}

let originalState: ReturnType<typeof useCamStore.getState>
let sent: MockInstance

beforeEach(() => {
  vi.useFakeTimers()
  originalState = useCamStore.getState()
  useMachineControl.setState({ consoleLines: [], alarm: null, singleBlock: false })
  sent = vi.spyOn(SimulatedController.prototype, 'jog')
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalState.project,
    machineLibrary: originalState.machineLibrary,
    control: originalState.control,
  })
  __resetEstopInterlockForTest()
  useMachineControl.setState({ consoleLines: [], alarm: null })
  sent.mockRestore()
  vi.useRealTimers()
})

/** Connect the simulator on `machine`, home it, park Z at machine `z`. */
async function connectAtZ(machine: MachineConfig, z: number) {
  install(machine)
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(1)
  await pending
  __resetEstopInterlockForTest()
  const ctrl = getMachineController()
  expect(ctrl.home()).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(ctrl.machineState()).toBe('idle')
  expect(ctrl.jog('Z', z - ctrl.status().machinePos!.z, 60_000)).toBe(true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(ctrl.machineState()).toBe('idle')
  expect(ctrl.status().machinePos!.z).toBeCloseTo(z, 6)
  useMachineControl.setState({ consoleLines: [] })
  sent.mockClear()
  return ctrl
}

function consoleTexts(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

describe('jogStepWithinSoftLimits (machine coordinates)', () => {
  const Z = { min: 0, max: 129.1 }
  it('the board case: Z 128.9 + 1.00 becomes 0.19 (stops at 129.09)', () => {
    expect(JOG_SOFT_LIMIT_MARGIN_MM).toBe(0.01)
    expect(jogStepWithinSoftLimits(128.9, 1, Z)).toEqual({ kind: 'clamped', deltaMm: 0.19, limitMm: 129.1 })
  })
  it('at the limit or within the margin of it: nothing to send', () => {
    expect(jogStepWithinSoftLimits(129.1, 1, Z)).toEqual({ kind: 'at-limit', limitMm: 129.1 })
    expect(jogStepWithinSoftLimits(129.09, 1, Z)).toEqual({ kind: 'at-limit', limitMm: 129.1 })
    expect(jogStepWithinSoftLimits(0.005, -1, Z)).toEqual({ kind: 'at-limit', limitMm: 0 })
  })
  it('inside the limits, or moving away from a limit, the step is unchanged', () => {
    expect(jogStepWithinSoftLimits(100, 1, Z)).toEqual({ kind: 'send' })
    expect(jogStepWithinSoftLimits(128.1, 1, Z)).toEqual({ kind: 'send' })
    expect(jogStepWithinSoftLimits(129.1, -1, Z)).toEqual({ kind: 'send' })
    expect(jogStepWithinSoftLimits(0, 5, Z)).toEqual({ kind: 'send' })
  })
  it('the minimum end clamps the same way', () => {
    expect(jogStepWithinSoftLimits(0.5, -1, Z)).toEqual({ kind: 'clamped', deltaMm: -0.49, limitMm: 0 })
  })
})

describe('a step jog through the session never targets past a stated soft limit', () => {
  it('Z 128.9, soft max 129.1: a 1.00 mm Z+ step sends 0.19 mm and says so', async () => {
    const ctrl = await connectAtZ(PROFILE, 128.9)
    expect(ctrl.jog('Z', 1, 600)).toBe(true)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][0]).toBe('Z')
    expect(sent.mock.calls[0][1]).toBeCloseTo(0.19, 9)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctrl.status().machinePos!.z).toBeCloseTo(129.09, 6)
    expect(consoleTexts().filter((t) => t.startsWith('Jog stopped at the Z soft limit ('))).toHaveLength(1)
    expect(consoleTexts().some((t) => t.includes('129.1'))).toBe(true)
    expect(useMachineControl.getState().alarm).toBeNull()
  })

  it('at the limit (within the margin): nothing is sent, one line says why', async () => {
    const ctrl = await connectAtZ(PROFILE, 129.09)
    expect(ctrl.jog('Z', 1, 600)).toBe(true)
    expect(sent).not.toHaveBeenCalled()
    const lines = consoleTexts()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Jog Z not sent: Z is at its soft limit \(129\.1/)
    // The other way still moves.
    expect(ctrl.jog('Z', -1, 600)).toBe(true)
    expect(sent).toHaveBeenCalledWith('Z', -1, 600)
  })

  it('a second step pressed while the first is still moving is measured from where the first will end', async () => {
    const ctrl = await connectAtZ(PROFILE, 128)
    expect(ctrl.jog('Z', 1, 600)).toBe(true)
    expect(ctrl.jog('Z', 1, 600)).toBe(true)
    expect(sent).toHaveBeenCalledTimes(2)
    expect(sent.mock.calls[0][1]).toBe(1)
    expect(sent.mock.calls[1][1]).toBeCloseTo(0.09, 9)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ctrl.status().machinePos!.z).toBeCloseTo(129.09, 6)
  })

  it('no stated Z soft limit: the step goes exactly as asked', async () => {
    const ctrl = await connectAtZ(withoutStatedZSoftLimits(PROFILE), 128.9)
    ctrl.jog('Z', 1, 600)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledWith('Z', 1, 600)
    expect(consoleTexts().some((t) => t.includes('soft limit'))).toBe(false)
  })

  it('the phone pendant step (its own entry point) is shortened the same way', async () => {
    await connectAtZ(PROFILE, 128.9)
    const answer = await executePendantMachineCommand(
      { kind: 'jog-step', axis: 'Z', deltaMm: 1, feedMmMin: 600 },
      { clientId: 'phone-softlimit', emit: vi.fn() },
    )
    expect(answer).toMatchObject({ ok: true })
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][1]).toBeCloseTo(0.19, 9)
  })
})
