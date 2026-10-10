// WO-347: the simulated controller must report the ACTIVE machine profile's
// travel at $130/$131/$132, so a simulated connection describes the machine
// the operator actually selected instead of a hardcoded literal nobody owns
// (docs/research/simulator-envelope-gap.md, finding 2 - "the simulator
// hardcodes its own travel literals instead of reading his profile"). This
// does NOT touch the GRBL-vs-UCCNC home-position question that research
// settled separately (deriveAxisEnvelope's homePositionMm: 0 stays put).
//
// Reuses machineEnvelope.ts's existing, unmodified reconcileTravels/
// deriveMachineEnvelope (WO-292/WO-300) to prove the travel-mismatch warning
// is corrected, not silenced - it must still fire for a genuine disagreement.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} from '../../lib/machine/machineSession'
import { useMachineControl } from '../../store/machineControlStore'
import { useCamStore } from '../../store'
import { deriveMachineEnvelope, reconcileTravels } from '../../lib/machine/machineEnvelope'
import type { MachineConfig } from '../../types'

// Operator's own Machine Library profile (authority line, WO-347).
const ERICS_TRAVEL = { x: 738, y: 724.5, z: 128.9 }
const ERICS_HOME = {
  x: { homesToward: 'max' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'max' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'max' as const, machineZeroAt: 'min' as const },
}

function makeMachine(overrides: Partial<MachineConfig> = {}): MachineConfig {
  return {
    id: 'wo347-machine',
    name: 'WO-347 Test Machine',
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { ...ERICS_TRAVEL },
    rapidRate: 5000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
    ...overrides,
  }
}

// WO-433: the "SimulatedGrblTransport $$ dump reports the connecting travel"
// block that lived here drove GrblController over SimulatedGrblTransport,
// which this WO deleted (the simulator no longer speaks GRBL - see
// src/lib/machine/simulatedController.ts). SimulatedController.querySettings()
// ports the identical $130/$131/$132/travel-fallback/homing behaviour, and
// the block below - driving the same assertions through the real
// machineSession.connectMachine('simulator') singleton - already proves it
// end to end; nothing here needs a direct-transport duplicate any more.

describe('machineSession.connectMachine seeds the simulator from the active machine profile (WO-347)', () => {
  let originalMachine: MachineConfig

  beforeEach(() => {
    vi.useFakeTimers()
    originalMachine = useCamStore.getState().project.machine
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(100)
      await pending
    }
    useCamStore.setState((s) => ({ project: { ...s.project, machine: originalMachine } }))
    vi.useRealTimers()
  })

  it('a simulated connection under Operator\'s profile reports his travel and raises no mismatch', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, machine: makeMachine({ homeConvention: ERICS_HOME }) },
    }))

    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    expect(getMachineController().connectionPhase()).toBe('connected')
    expect(useMachineControl.getState().connectionKind).toBe('simulator')

    getMachineController().querySettings()
    await vi.advanceTimersByTimeAsync(10)

    const settings = useMachineControl.getState().settings
    expect(settings[130]).toBe('738.000')
    expect(settings[131]).toBe('724.500')
    expect(settings[132]).toBe('128.900')

    const envelope = deriveMachineEnvelope(settings)
    const mismatches = reconcileTravels(envelope, useCamStore.getState().project.machine?.travel)
    expect(mismatches).toEqual([])

    // Travel seeding is inspected after the startup E-STOP has been cleared.
    __resetEstopInterlockForTest()
    expect(getMachineController().home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    getMachineController().queryStatus()
    await vi.advanceTimersByTimeAsync(10)
    expect(useMachineControl.getState().mpos).toEqual(ERICS_TRAVEL)
  })

  it('the mismatch warning still fires when the profile genuinely disagrees with what the controller already reported', async () => {
    useCamStore.setState((s) => ({ project: { ...s.project, machine: makeMachine() } }))

    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    getMachineController().querySettings()
    await vi.advanceTimersByTimeAsync(10)

    // The controller already answered with Operator's 738/724.5/128.9 at connect
    // time. The operator now edits the Machine Library profile without
    // reconnecting - a real disagreement, exactly what reconcileTravels
    // exists to catch. The fix must not silence this.
    useCamStore.setState((s) => ({
      project: { ...s.project, machine: makeMachine({ travel: { x: 800, y: 600, z: 100 } }) },
    }))

    const envelope = deriveMachineEnvelope(useMachineControl.getState().settings)
    const mismatches = reconcileTravels(envelope, useCamStore.getState().project.machine?.travel)
    expect(mismatches.map((m) => m.axis).sort()).toEqual(['x', 'y', 'z'])
  })

  it('a profile with no travel set still connects and degrades sensibly, never reporting zeros as real travel', async () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, machine: makeMachine({ travel: { x: 0, y: 0, z: 0 } }) },
    }))

    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending // must not throw
    expect(getMachineController().connectionPhase()).toBe('connected')

    getMachineController().querySettings()
    await vi.advanceTimersByTimeAsync(10)

    const settings = useMachineControl.getState().settings
    expect(settings[130]).toBe('0.000')
    expect(settings[131]).toBe('0.000')
    expect(settings[132]).toBe('0.000')

    // machineEnvelope.ts's own positiveNumber guard (unmodified by this WO)
    // already treats a non-positive $130-$132 as "not reported" - proving the
    // zero is never mistaken for a real zero-size table.
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope).toEqual({ x: null, y: null, z: null })

    const mismatches = reconcileTravels(envelope, useCamStore.getState().project.machine?.travel)
    expect(mismatches).toEqual([])
  })
})
