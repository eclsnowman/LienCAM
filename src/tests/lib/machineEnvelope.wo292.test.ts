// ============================================================
// WO-292: the controller already tells us where the table is
// ============================================================
// The controller reports max travel ($130-$132), homing direction inversion
// ($23) and pull-off ($27) - this derivation turns that into "where is home,
// and where is the table", honestly distinguishes not-homed/homed/unknown,
// suppresses a machine coordinate the moment it would be a lie, and surfaces
// a Machine Library travel that disagrees with what the firmware reports.

import { describe, expect, it } from 'vitest'
import {
  deriveEnvelopeStatus,
  deriveMachineEnvelope,
  reconcileTravels,
  safeMachinePosition,
  TRAVEL_MISMATCH_TOLERANCE_MM,
  type EnvelopeStatus,
} from '../../lib/machine/machineEnvelope'

/** A firmware settings dump ($$ -> $N=value), exactly as GrblController's
 *  onSetting handler accumulates it. */
function settingsDump(entries: Record<number, string>): Record<number, string> {
  return { ...entries }
}

describe('deriveMachineEnvelope', () => {
  it('derives the far-corner convention (bit clear): home at 0, table entirely negative', () => {
    const settings = settingsDump({ 23: '0', 27: '3.000', 130: '740.000', 131: '724.000', 132: '130.000' })
    const envelope = deriveMachineEnvelope(settings)
    // homePositionMm: 0 (WO-300) - grbl always zeroes at the switch; the
    // numbers below are unchanged from before WO-300.
    expect(envelope.x).toEqual({ travelMm: 740, homesToward: 'max', homePositionMm: 0, pulloffMm: 3, min: -740, max: 0 })
    expect(envelope.y).toEqual({ travelMm: 724, homesToward: 'max', homePositionMm: 0, pulloffMm: 3, min: -724, max: 0 })
    expect(envelope.z).toEqual({ travelMm: 130, homesToward: 'max', homePositionMm: 0, pulloffMm: 3, min: -130, max: 0 })
  })

  it('derives the near-corner convention (bit set): home at 0, table entirely positive', () => {
    // $23 = 7 -> bits 0,1,2 all set (X, Y and Z all invert).
    const settings = settingsDump({ 23: '7', 27: '2.500', 130: '300.000', 131: '200.000', 132: '80.000' })
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope.x).toEqual({ travelMm: 300, homesToward: 'min', homePositionMm: 0, pulloffMm: 2.5, min: 0, max: 300 })
    expect(envelope.y).toEqual({ travelMm: 200, homesToward: 'min', homePositionMm: 0, pulloffMm: 2.5, min: 0, max: 200 })
    expect(envelope.z).toEqual({ travelMm: 80, homesToward: 'min', homePositionMm: 0, pulloffMm: 2.5, min: 0, max: 80 })
  })

  it('decides each axis independently from its own $23 bit', () => {
    // bit 0 (X) set, bits 1/2 (Y/Z) clear: X homes near/positive, Y and Z home far/negative.
    const settings = settingsDump({ 23: '1', 27: '1.000', 130: '600.000', 131: '400.000', 132: '100.000' })
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope.x).toMatchObject({ homesToward: 'min', min: 0, max: 600 })
    expect(envelope.y).toMatchObject({ homesToward: 'max', min: -400, max: 0 })
    expect(envelope.z).toMatchObject({ homesToward: 'max', min: -100, max: 0 })
  })

  it('defaults to the far-corner convention and zero pull-off when $23/$27 were never read', () => {
    const settings = settingsDump({ 130: '740.000', 131: '724.000', 132: '130.000' })
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope.x).toMatchObject({ homesToward: 'max', pulloffMm: 0, min: -740, max: 0 })
    expect(envelope.y).toMatchObject({ homesToward: 'max', pulloffMm: 0, min: -724, max: 0 })
    expect(envelope.z).toMatchObject({ homesToward: 'max', pulloffMm: 0, min: -130, max: 0 })
  })

  it('leaves an axis null when its travel is missing, non-finite, or non-positive - the others still derive', () => {
    const missing = deriveMachineEnvelope(settingsDump({ 130: '600.000', 131: '400.000' }))
    expect(missing.x).not.toBeNull()
    expect(missing.y).not.toBeNull()
    expect(missing.z).toBeNull()

    const zero = deriveMachineEnvelope(settingsDump({ 130: '0', 131: '400.000', 132: '100.000' }))
    expect(zero.x).toBeNull()
    expect(zero.y).not.toBeNull()

    const junk = deriveMachineEnvelope(settingsDump({ 130: 'not-a-number', 131: '400.000', 132: '100.000' }))
    expect(junk.x).toBeNull()
  })

  it('returns all-null for an empty dump without throwing', () => {
    expect(deriveMachineEnvelope({})).toEqual({ x: null, y: null, z: null })
  })
})

describe('deriveEnvelopeStatus', () => {
  const cases: Array<[Parameters<typeof deriveEnvelopeStatus>[0], EnvelopeStatus]> = [
    [{ connected: false, settingsKnown: false, homed: false }, 'unknown'],
    [{ connected: false, settingsKnown: true, homed: true }, 'unknown'],
    [{ connected: true, settingsKnown: false, homed: false }, 'unknown'],
    [{ connected: true, settingsKnown: true, homed: false }, 'not-homed'],
    [{ connected: true, settingsKnown: true, homed: true }, 'homed'],
  ]

  it.each(cases)('%j -> %s', (args, expected) => {
    expect(deriveEnvelopeStatus(args)).toBe(expected)
  })

  it('distinguishes all three states from one another', () => {
    const statuses = cases.map(([args]) => deriveEnvelopeStatus(args))
    expect(new Set(statuses)).toEqual(new Set(['unknown', 'not-homed', 'homed']))
  })
})

describe('safeMachinePosition', () => {
  const mpos = { x: 12, y: -4, z: 0 }

  it('never yields a factual-looking machine coordinate unless homed', () => {
    expect(safeMachinePosition('unknown', mpos)).toBeNull()
    expect(safeMachinePosition('not-homed', mpos)).toBeNull()
  })

  it('passes the live coordinate through once homed', () => {
    expect(safeMachinePosition('homed', mpos)).toEqual(mpos)
  })

  it('a null mpos stays null in every state, including homed', () => {
    expect(safeMachinePosition('homed', null)).toBeNull()
    expect(safeMachinePosition('not-homed', null)).toBeNull()
  })
})

describe('reconcileTravels', () => {
  const envelope = deriveMachineEnvelope(
    settingsDump({ 23: '0', 27: '3.000', 130: '740.000', 131: '724.000', 132: '130.000' }),
  )

  it('surfaces a disagreement naming the axis and both numbers', () => {
    const mismatches = reconcileTravels(envelope, { x: 800, y: 724, z: 130 })
    expect(mismatches).toEqual([{ axis: 'x', typedMm: 800, reportedMm: 740, differenceMm: 60 }])
  })

  it('surfaces every disagreeing axis, not just the first', () => {
    const mismatches = reconcileTravels(envelope, { x: 800, y: 600, z: 100 })
    expect(mismatches.map((m) => m.axis)).toEqual(['x', 'y', 'z'])
    expect(mismatches).toContainEqual({ axis: 'y', typedMm: 600, reportedMm: 724, differenceMm: 124 })
    expect(mismatches).toContainEqual({ axis: 'z', typedMm: 100, reportedMm: 130, differenceMm: 30 })
  })

  it('is silent when every axis agrees exactly', () => {
    expect(reconcileTravels(envelope, { x: 740, y: 724, z: 130 })).toEqual([])
  })

  it('is silent under the tolerance and fires at or above it', () => {
    const justUnder = TRAVEL_MISMATCH_TOLERANCE_MM * 0.99
    const atOrOver = TRAVEL_MISMATCH_TOLERANCE_MM
    expect(reconcileTravels(envelope, { x: 740 + justUnder, y: 724, z: 130 })).toEqual([])
    expect(reconcileTravels(envelope, { x: 740 + atOrOver, y: 724, z: 130 })).toHaveLength(1)
  })

  it('never prefers either number - both are reported back verbatim', () => {
    const [mismatch] = reconcileTravels(envelope, { x: 900, y: 724, z: 130 })
    expect(mismatch.typedMm).toBe(900)
    expect(mismatch.reportedMm).toBe(740)
  })

  it('does not compare a configured axis GRBL has not reported yet', () => {
    const partial = deriveMachineEnvelope(settingsDump({ 130: '740.000' }))
    const mismatches = reconcileTravels(partial, { x: 740, y: 9999, z: 9999 })
    expect(mismatches).toEqual([])
  })

  it('does not compare against a machine with no configured travel', () => {
    expect(reconcileTravels(envelope, null)).toEqual([])
    expect(reconcileTravels(envelope, undefined)).toEqual([])
  })

  it('skips an axis whose configured travel is missing, zero, or invalid rather than inventing a mismatch', () => {
    expect(reconcileTravels(envelope, { x: 0, y: 724, z: 130 })).toEqual([])
    expect(reconcileTravels(envelope, { x: Number.NaN, y: 724, z: 130 })).toEqual([])
  })
})
