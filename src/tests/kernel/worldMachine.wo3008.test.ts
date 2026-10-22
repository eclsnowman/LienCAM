// WO-3008 08a: the machine record, read from the machine profile (A3-08 step 6).
// Independent truth: the profile file itself and alpha3-17 A.2 (M-SAFE-6 travel
// 738 x 724.5 x 129.2). Nothing plans against the record yet (MD-02).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { machineRecord } from '../../kernel/world'
import type { MachineConfig } from '../../types'

const PROFILE = 'docs/machine/profiles/LienCNCV2.machine.json'
const profile = () => JSON.parse(readFileSync(PROFILE, 'utf8')) as MachineConfig

describe('WO-3008 machine record', () => {
  it('machine record travel, axis limits, rapids, spindle and accelerations equal the profile', () => {
    const raw = profile()
    const record = machineRecord(raw)
    expect(record.travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
    expect(record.travel).toEqual(raw.travel)
    expect(record.rapidRate).toBe(8000)
    expect(record.spindle).toEqual({ minRpm: 8000, maxRpm: 24000 })
    const axes = raw.controllerDefinition!.axes
    for (const axis of ['x', 'y', 'z'] as const) {
      const definition = axes.find(entry => entry.axis === axis.toUpperCase())!
      expect(record.axes[axis]).toEqual({
        maxCutting: raw.axisLimits![axis].maxCutting, maxRapid: raw.axisLimits![axis].maxRapid,
        acceleration: definition.acceleration, softLimitMin: definition.softLimitMin, softLimitMax: definition.softLimitMax,
      })
    }
    expect(record.axes.x).toEqual({ maxCutting: 9000, maxRapid: 9000, acceleration: 1000, softLimitMin: 0, softLimitMax: 738 })
  })

  it('states no bound the profile does not state', () => {
    const raw = profile()
    const bare = machineRecord({ ...raw, minSpindleRpm: undefined, maxSpindleRpm: undefined, axisLimits: undefined, controllerDefinition: undefined })
    expect(bare.spindle).toEqual({})
    expect(bare.axes).toEqual({})
    expect(bare.travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
  })

  it('is deterministic and frozen', () => {
    const a = machineRecord(profile()), b = machineRecord(profile())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(Object.isFrozen(a) && Object.isFrozen(a.travel)).toBe(true)
  })
})
