// WO-1688 review (safety path) - the Overview's "Soft limits" line must say
// what the session actually enforces. The session's own answer is
// `resolveMachineMotion(...).axes[k].definitionState === 'bounded'` (via
// `controllerSoftLimitsEnabled` + `axisSoftLimitsAreStated` in
// resolvedMachineMotion.ts). `overviewFacts` derives its own answer instead
// (overviewFacts.ts:109-119) and the two disagree.

import { describe, expect, it } from 'vitest'
import {
  AXIS_NAMES,
  createDefaultControllerDefinition,
  type ControllerSetting,
  type MachineConfig,
} from '../../types'
import { overviewFacts } from '../../lib/machine/overviewFacts'
import { axisSoftLimitStatementKey, resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import { resolveHomingOrder } from '../../lib/machine/controller'

function uccncMachine(settings: ControllerSetting[], stated: { controller: 'uccnc'; key: string }[] = []): MachineConfig {
  const def = createDefaultControllerDefinition(AXIS_NAMES)
  return {
    id: 'wo1688-review', name: 'UCCNC review', type: 'gantry_router', controller: 'uccnc',
    travel: { x: 700, y: 700, z: 120 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 6000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: { ...def, settings: [...(def.settings ?? []), ...settings], stated: [...(def.stated ?? []), ...stated] },
  }
}

const softLine = (m: MachineConfig) => overviewFacts(m).machine.find((l) => l.startsWith('Soft limits:'))
const sessionBounded = (m: MachineConfig) => {
  const motion = resolveMachineMotion({ machine: m, connectionKind: 'bridge' })
  return (['x', 'y', 'z'] as const).map((k) => motion.axes[k].definitionState)
}

describe('WO-1688 review: Soft limits line vs what the session enforces', () => {
  it('Softlimitsenable=True with no stated limit values: card says "on", session enforces none', () => {
    const m = uccncMachine([
      { controller: 'uccnc', key: 'Generalsettings.Softlimitsenable', value: { kind: 'boolean', value: true } },
    ])
    // The session: no axis is bounded by soft limits (the limit numbers are placeholders).
    expect(sessionBounded(m).every((s) => s === 'unknown')).toBe(true)
    // The card must not tell the operator soft limits are on. DEFECT: it does.
    expect(softLine(m)).not.toBe('Soft limits: on')
  })

  it('Softlimitsenable=False with LienCAM-stated limits on every axis: card says "off", session enforces them', () => {
    const stated = AXIS_NAMES.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const, key: axisSoftLimitStatementKey(axis, end),
    })))
    const m = uccncMachine([
      { controller: 'uccnc', key: 'Generalsettings.Softlimitsenable', value: { kind: 'boolean', value: false } },
    ], stated)
    expect(sessionBounded(m).every((s) => s === 'bounded' || s === 'invalid')).toBe(true)
    expect(softLine(m)).not.toBe('Soft limits: off')
  })

  it('fix round: the line names each axis exactly as the session resolves it', () => {
    const none = uccncMachine([
      { controller: 'uccnc', key: 'Generalsettings.Softlimitsenable', value: { kind: 'boolean', value: true } },
    ])
    expect(softLine(none)).toBe('Soft limits: none enforced (no limit stated)')

    const xyStated = (['X', 'Y'] as const).flatMap((axis) => (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const, key: axisSoftLimitStatementKey(axis, end),
    })))
    const m = uccncMachine([], xyStated)
    m.controllerDefinition = {
      ...m.controllerDefinition!,
      axes: m.controllerDefinition!.axes.map((a) => (a.axis === 'X' || a.axis === 'Y'
        ? { ...a, softLimitMin: 0, softLimitMax: 700 } : a)),
    }
    expect(sessionBounded(m)).toEqual(['bounded', 'bounded', 'unknown'])
    expect(softLine(m)).toBe('Soft limits: X Y enforced, Z not (no limit stated)')

    // Stated but out of order (the 0/0 placeholders): the session marks it invalid, the card says so.
    const bad = uccncMachine([], xyStated)
    expect(sessionBounded(bad)).toEqual(['invalid', 'invalid', 'unknown'])
    expect(softLine(bad)).toBe('Soft limits: none enforced - X Y not (limits out of order), Z not (no limit stated)')
  })
})

describe('WO-1688 review: Home line says what homing will do', () => {
  it('an empty homing order shows the order resolveHomingOrder sends, not "not defined"', () => {
    const m = uccncMachine([])
    m.controllerDefinition = { ...m.controllerDefinition!, homing: { ...m.controllerDefinition!.homing, order: [] } }
    const home = overviewFacts(m).machine.find((l) => l.startsWith('Home:'))!
    expect(home.startsWith(`Home: ${resolveHomingOrder(m.controllerDefinition).join(' then ')} (default order)`)).toBe(true)
  })
})
