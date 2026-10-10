// WO-2712 (review + audits 10-09): the Sample router's home-at-max end is GRBL's
// default for the GRBL sample, supplied by machineHomeConvention() while the record
// stores none - never stored. So a record switched to another controller inherits
// nothing on ANY connection (main's behaviour), and a convention the operator saves
// always wins, whatever its value (audit 7:31 PM: an explicitly saved max/max on a
// native record was being discarded).
import { describe, expect, it } from 'vitest'
import { machineHomeConvention } from '../../types'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'

const MAX_MAX = {
  x: { homesToward: 'max', machineZeroAt: 'max' },
  y: { homesToward: 'max', machineZeroAt: 'max' },
  z: { homesToward: 'max', machineZeroAt: 'max' },
} as const

describe('WO-2712: the sample home end is a GRBL-sample default, never an inherited stored value', () => {
  it('the GRBL sample stores no convention and resolves X/Y -406..0, Z -95..0 on the simulator', () => {
    expect(createSampleMachine().homeConvention).toBeUndefined()
    expect(machineHomeConvention(createSampleMachine())).toEqual(MAX_MAX)
    const sim = resolveMachineMotion({ machine: createSampleMachine(), connectionKind: 'simulator', datumKnown: true })
    expect(sim.envelope.x).toMatchObject({ min: -406, max: 0 })
    expect(sim.envelope.z).toMatchObject({ min: -95, max: 0 })
  })

  it('switched to another controller, the record inherits nothing on any connection', () => {
    const switched = { ...createSampleMachine(), controller: 'uccnc' as const }
    expect(machineHomeConvention(switched)).toBeUndefined()
    for (const connectionKind of ['bridge', 'gateway', null, 'simulator'] as const) {
      const r = resolveMachineMotion({ machine: switched, connectionKind, datumKnown: true })
      expect(r.envelope.x, String(connectionKind)).toBeNull()
    }
  })

  it('an operator-saved max/max on the native sample record is kept (audit 7:31 PM) and supplies the envelope', () => {
    const saved = { ...createSampleMachine(), controller: 'uccnc' as const, homeConvention: MAX_MAX }
    expect(machineHomeConvention(saved)).toEqual(MAX_MAX)
    const r = resolveMachineMotion({ machine: saved, connectionKind: 'bridge', datumKnown: true })
    expect(r.envelope.x).toMatchObject({ min: -406, max: 0 })
    expect(r.envelope.z).toMatchObject({ min: -95, max: 0 })
  })

  it('a convention saved on the GRBL sample wins over the default', () => {
    const minMin = {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    } as const
    expect(machineHomeConvention({ ...createSampleMachine(), homeConvention: minMin })?.x.homesToward).toBe('min')
  })
})
