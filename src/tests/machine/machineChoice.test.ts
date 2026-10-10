// Forced load-time machine-picker predicate (src/lib/machine/machineChoice.ts).
//
// Regression guard for the first-start TRAP: on a fresh install the machine
// library holds ONLY the generic 'default-machine' placeholder, and the project is
// bound to that same placeholder. The picker must NOT fire there - its only option
// would be the generic machine, and picking it re-trips machineNeedsChoice forever
// (an unescapable modal). shouldPromptMachineChoice encodes "only prompt when a REAL
// machine exists to pick".

import { describe, it, expect } from 'vitest'
import {
  GENERIC_MACHINE_ID,
  machineNeedsChoice,
  choosableMachines,
  shouldPromptMachineChoice,
} from '../../lib/machine/machineChoice'
import type { MachineConfig } from '../../types'

function mk(id: string, name = id): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'grbl',
    travel: { x: 100, y: 100, z: 50 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

const generic = mk(GENERIC_MACHINE_ID, 'My CNC Router')
const real = mk('operator-machine', 'Operator Machine')

describe('machineNeedsChoice', () => {
  it('TRUE when the project has no machine', () => {
    expect(machineNeedsChoice(null, [real])).toBe(true)
    expect(machineNeedsChoice(undefined, [real])).toBe(true)
  })
  it('TRUE for the generic placeholder', () => {
    expect(machineNeedsChoice(generic, [generic, real])).toBe(true)
  })
  it('TRUE when the machine id is not in the library (stale/foreign)', () => {
    expect(machineNeedsChoice(mk('foreign'), [real])).toBe(true)
  })
  it('FALSE for a known, non-generic library machine', () => {
    expect(machineNeedsChoice(real, [real])).toBe(false)
  })
})

describe('choosableMachines', () => {
  it('excludes the generic placeholder', () => {
    expect(choosableMachines([generic]).length).toBe(0)
    expect(choosableMachines([generic, real]).map((m) => m.id)).toEqual(['operator-machine'])
  })
})

describe('shouldPromptMachineChoice (the App-level gate)', () => {
  it('DOES NOT prompt on a fresh install: generic project + library of only the generic placeholder', () => {
    // THE BUG: this used to prompt and trap the user forever.
    expect(shouldPromptMachineChoice(generic, [generic])).toBe(false)
  })
  it('does not prompt when the library is empty', () => {
    expect(shouldPromptMachineChoice(generic, [])).toBe(false)
  })
  it('prompts when a generic project has a REAL machine available to pick', () => {
    expect(shouldPromptMachineChoice(generic, [generic, real])).toBe(true)
    expect(shouldPromptMachineChoice(generic, [real])).toBe(true)
  })
  it('prompts when a foreign/stale machine is bound but the user has real machines', () => {
    expect(shouldPromptMachineChoice(mk('foreign'), [real])).toBe(true)
  })
  it('does not prompt when the project is already on a known real machine', () => {
    expect(shouldPromptMachineChoice(real, [generic, real])).toBe(false)
  })
})
