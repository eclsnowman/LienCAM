// ============================================================
// WO-301: machines with no homing switches
// ============================================================
// Plenty of hobby machines have no switches at all: the operator jogs to a
// corner by eye, zeroes the work coordinate system there, and runs. Machine
// coordinates on such a machine are not "unknown until homed" - there is no
// datum, by design, and never will be. This proves the model gains an
// honest fourth status distinct from 'not-homed', that the single
// safeMachinePosition chokepoint refuses it exactly as it refuses an unhomed
// machine, that no envelope is derived for it (never a fictional box, never
// a quiet zero), and that none of this touches work-coordinate behaviour or
// any existing profile that declares nothing.

import { describe, expect, it } from 'vitest'
import {
  deriveEnvelopeStatus,
  deriveMachineEnvelope,
  safeMachinePosition,
  type EnvelopeStatus,
} from '../../lib/machine/machineEnvelope'
import type { MachineConfig } from '../../types'

function settingsDump(entries: Record<number, string>): Record<number, string> {
  return { ...entries }
}

describe('a machine that declares no homing switches', () => {
  // A perfectly normal settings dump - if this machine DID have switches,
  // it would derive a real envelope. Proves the declaration, not bad
  // settings, is what suppresses everything downstream.
  const settings = settingsDump({ 23: '0', 27: '0', 130: '740.000', 131: '724.000', 132: '130.000' })

  it('yields a status of its own: no-datum', () => {
    const status = deriveEnvelopeStatus({ connected: true, settingsKnown: true, homed: true, noHomingSwitches: true })
    expect(status).toBe('no-datum')
  })

  it('wins over every other input - disconnected, connected, settings known or not, even a claimed homed', () => {
    const cases = [
      { connected: false, settingsKnown: false, homed: false },
      { connected: false, settingsKnown: true, homed: false },
      { connected: true, settingsKnown: false, homed: false },
      { connected: true, settingsKnown: true, homed: false },
      { connected: true, settingsKnown: true, homed: true },
    ]
    for (const c of cases) {
      expect(deriveEnvelopeStatus({ ...c, noHomingSwitches: true })).toBe('no-datum')
    }
  })

  it('safeMachinePosition refuses for it, exactly as it refuses when unhomed - no new path around the chokepoint', () => {
    const mpos = { x: 12, y: -4, z: 0 }
    const status = deriveEnvelopeStatus({ connected: true, settingsKnown: true, homed: true, noHomingSwitches: true })
    expect(safeMachinePosition(status, mpos)).toBeNull()
    expect(safeMachinePosition(status, mpos)).toEqual(safeMachinePosition('not-homed', mpos))
  })

  it('derives no envelope at all, even from a settings dump that would otherwise derive a real one', () => {
    const suppressed = deriveMachineEnvelope(settings, { noHomingSwitches: true })
    expect(suppressed).toEqual({ x: null, y: null, z: null })

    // Same dump, no declaration: a real envelope comes back - proves the
    // suppression above is the declaration at work, not a coincidence.
    const real = deriveMachineEnvelope(settings)
    expect(real.x).not.toBeNull()
  })

  it('never substitutes zero for the missing datum - a suppressed axis is null, not a coordinate', () => {
    const suppressed = deriveMachineEnvelope(settings, { noHomingSwitches: true })
    expect(suppressed.x).toBeNull()
    expect(suppressed.y).toBeNull()
    expect(suppressed.z).toBeNull()
  })
})

describe('no-datum is distinguishable from not-homed', () => {
  it('is a different status value for the same connected/settings-known/homed inputs, never an alias', () => {
    const shared = { connected: true, settingsKnown: true, homed: false }
    const noDatum = deriveEnvelopeStatus({ ...shared, noHomingSwitches: true })
    const notHomed = deriveEnvelopeStatus({ ...shared, noHomingSwitches: false })
    expect(noDatum).toBe('no-datum')
    expect(notHomed).toBe('not-homed')
    expect(noDatum).not.toBe(notHomed)
  })

  it('all four statuses are distinct values - a consumer keying off the string cannot collapse any two', () => {
    const statuses: EnvelopeStatus[] = ['unknown', 'not-homed', 'homed', 'no-datum']
    expect(new Set(statuses).size).toBe(4)
  })
})

describe('work-coordinate behaviour is untouched by a no-homing-switches declaration', () => {
  it('noHomingSwitches is one fact on the machine profile, alongside every other - it reshapes nothing else a work-coordinate consumer reads', () => {
    const profile: MachineConfig = {
      id: 'no-switches-hobby-router',
      name: 'Hobby router, no switches',
      type: 'gantry_router',
      controller: 'grbl',
      travel: { x: 600, y: 400, z: 100 },
      noHomingSwitches: true,
      rapidRate: 3000,
      maxSpindleRpm: 24000,
      minSpindleRpm: 8000,
      spindleDirection: 'cw',
      toolChanger: 'none',
      coolant: false,
      notes: 'Operator jogs to a corner by eye and zeroes WCS there.',
    }
    expect(profile.noHomingSwitches).toBe(true)
    expect(profile.travel).toEqual({ x: 600, y: 400, z: 100 })
    expect(profile.homeConvention).toBeUndefined()
  })

  it('safeMachinePosition only ever gates the machine coordinate passed to it - an arbitrary work-coordinate-shaped value passes through identically regardless of status, once status is homed', () => {
    const workLikeValue = { wx: 10, wy: 20, wz: -5 }
    expect(safeMachinePosition('homed', workLikeValue)).toEqual(workLikeValue)
  })
})

describe('an existing profile with nothing declared behaves exactly as it does today', () => {
  const settings = settingsDump({ 23: '0', 27: '3.000', 130: '740.000', 131: '724.000', 132: '130.000' })

  it('deriveEnvelopeStatus is unaffected when noHomingSwitches is absent', () => {
    expect(deriveEnvelopeStatus({ connected: true, settingsKnown: true, homed: true })).toBe('homed')
    expect(deriveEnvelopeStatus({ connected: true, settingsKnown: true, homed: false })).toBe('not-homed')
    expect(deriveEnvelopeStatus({ connected: false, settingsKnown: false, homed: false })).toBe('unknown')
  })

  it('deriveEnvelopeStatus is unaffected when noHomingSwitches is explicitly false', () => {
    expect(deriveEnvelopeStatus({ connected: true, settingsKnown: true, homed: true, noHomingSwitches: false })).toBe(
      'homed',
    )
  })

  it('deriveMachineEnvelope is unaffected when opts are absent', () => {
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope.x).toMatchObject({ homesToward: 'max', min: -740, max: 0 })
    expect(envelope.y).toMatchObject({ homesToward: 'max', min: -724, max: 0 })
    expect(envelope.z).toMatchObject({ homesToward: 'max', min: -130, max: 0 })
  })

  it('a profile object with nothing declared type-checks and carries no noHomingSwitches fact', () => {
    const profile: MachineConfig = {
      id: 'ordinary-grbl-router',
      name: 'Ordinary router',
      type: 'gantry_router',
      controller: 'grbl',
      travel: { x: 740, y: 724, z: 130 },
      rapidRate: 3000,
      maxSpindleRpm: 24000,
      minSpindleRpm: 8000,
      spindleDirection: 'cw',
      toolChanger: 'none',
      coolant: false,
      notes: '',
    }
    expect(profile.noHomingSwitches).toBeUndefined()
  })
})
