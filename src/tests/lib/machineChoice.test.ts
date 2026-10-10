// Unit test for the pure machineNeedsChoice predicate (the load-time
// machine-choice gate). Covers the three TRUE cases (missing / unknown-id /
// generic placeholder) and the FALSE case (known non-generic library machine
// honored silently).

import { describe, it, expect } from 'vitest'
import { machineNeedsChoice, GENERIC_MACHINE_ID } from '../../lib/machine/machineChoice'
import type { MachineConfig } from '../../types'

function mk(id: string, name = id): MachineConfig {
  return {
    id,
    name,
    type: 'gantry_router',
    controller: 'grbl',
    travel: { x: 100, y: 100, z: 50 },
    rapidRate: 5000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
  }
}

describe('machineNeedsChoice', () => {
  const known = mk('mach-a', 'Operator Machine')
  const library = [known, mk('mach-b')]

  it('returns true when the machine is missing (undefined)', () => {
    expect(machineNeedsChoice(undefined, library)).toBe(true)
  })

  it('returns true when the machine is null', () => {
    expect(machineNeedsChoice(null, library)).toBe(true)
  })

  it('returns true when the machine id is not found in the library', () => {
    expect(machineNeedsChoice(mk('stale-id'), library)).toBe(true)
  })

  it('returns true for the generic default-machine placeholder', () => {
    // Generic id even if (improbably) also present in the library -> still prompt.
    expect(machineNeedsChoice(mk(GENERIC_MACHINE_ID), library)).toBe(true)
    expect(machineNeedsChoice(mk(GENERIC_MACHINE_ID), [mk(GENERIC_MACHINE_ID)])).toBe(true)
  })

  it('returns false for a known, non-generic library machine (silent honor)', () => {
    expect(machineNeedsChoice(known, library)).toBe(false)
    // Matching by id, not reference identity.
    expect(machineNeedsChoice(mk('mach-a', 'renamed copy'), library)).toBe(false)
  })
})
