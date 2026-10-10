// ============================================================
// WO-300: machine zero is not always where the switch is
// ============================================================
// WO-292 assumed grbl's rule: the axis reads ZERO at the switch, so the
// reachable box always runs from there. Operator's own machine (UCCNC, "Write
// offset on homing") breaks that assumption - it homes to back-right-top and
// writes 738 / 724.5 / 128.9 at the switch, so machine zero sits at the
// OPPOSITE corner (front-left-bottom) and every coordinate is positive.
//
// The fix: every convention we have seen reduces to the same two facts per
// axis - which end of the travel the switch is at (homesToward), and what
// the axis reads once parked there (homePositionMm). grbl's "always zero" is
// just the special case homePositionMm = 0. This file proves the model
// expresses both conventions with the same formula, that grbl's own numbers
// are unchanged, and that a profile's declared convention disagreeing with
// what the controller reports is surfaced rather than silently resolved.

import { describe, expect, it } from 'vitest'
import {
  deriveAxisEnvelopeFromHome,
  deriveMachineEnvelope,
  deriveMachineEnvelopeFromConvention,
  reconcileHomeConvention,
  HOME_POSITION_MISMATCH_TOLERANCE_MM,
} from '../../lib/machine/machineEnvelope'
import type { MachineHomeConvention } from '../../types'

function settingsDump(entries: Record<number, string>): Record<number, string> {
  return { ...entries }
}

describe('machine-profile endpoint choices', () => {
  const travel = { x: 100, y: 100, z: 100 }
  const cases = [
    { home: 'max', zero: 'min', range: [0, 100], homePosition: 100 },
    { home: 'max', zero: 'max', range: [-100, 0], homePosition: 0 },
    { home: 'min', zero: 'min', range: [0, 100], homePosition: 0 },
    { home: 'min', zero: 'max', range: [-100, 0], homePosition: -100 },
  ] as const

  for (const test of cases) {
    it(`home ${test.home}, machine zero ${test.zero}`, () => {
      const axis = { homesToward: test.home, machineZeroAt: test.zero }
      const envelope = deriveMachineEnvelopeFromConvention({ x: axis, y: axis, z: axis }, travel)
      expect([envelope.x!.min, envelope.x!.max]).toEqual(test.range)
      expect(envelope.x!.homePositionMm).toBe(test.homePosition)
    })
  }
})

describe('deriveAxisEnvelopeFromHome - Operator real machine (UCCNC, write-offset-on-homing)', () => {
  // Authority: Operator, 2026-08-12, with two UCCNC screenshots - "It homes to
  // the back right top. I have that set to X738 Y724.5 Z128.9 ... front
  // left, bottom is machine zero." Soft limits 0 and +738 confirm it.
  it('home at back-right-top, home position 738/724.5/128.9, travel the same -> envelope 0 to 738/724.5/128.9', () => {
    const x = deriveAxisEnvelopeFromHome({ travelMm: 738, homesToward: 'max', homePositionMm: 738 })
    const y = deriveAxisEnvelopeFromHome({ travelMm: 724.5, homesToward: 'max', homePositionMm: 724.5 })
    const z = deriveAxisEnvelopeFromHome({ travelMm: 128.9, homesToward: 'max', homePositionMm: 128.9 })

    expect(x).toEqual({ travelMm: 738, homesToward: 'max', homePositionMm: 738, pulloffMm: 0, min: 0, max: 738 })
    expect(y).toEqual({ travelMm: 724.5, homesToward: 'max', homePositionMm: 724.5, pulloffMm: 0, min: 0, max: 724.5 })
    expect(z).toEqual({ travelMm: 128.9, homesToward: 'max', homePositionMm: 128.9, pulloffMm: 0, min: 0, max: 128.9 })

    // "front left, bottom is machine zero": that corner is where every axis
    // is at its min - and every axis's min here is exactly 0.
    expect([x.min, y.min, z.min]).toEqual([0, 0, 0])
  })
})

describe('deriveMachineEnvelope - grbl conventions are unchanged by the new model (WO-292 regression)', () => {
  it('far-corner convention (home position 0): envelope -738 to 0, unchanged', () => {
    const settings = settingsDump({ 23: '0', 27: '0', 130: '738.000', 131: '724.500', 132: '128.900' })
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope.x).toMatchObject({ homesToward: 'max', homePositionMm: 0, min: -738, max: 0 })
  })

  it('near-corner convention (home position 0): envelope 0 to 738, unchanged', () => {
    const settings = settingsDump({ 23: '1', 27: '0', 130: '738.000', 131: '724.500', 132: '128.900' })
    const envelope = deriveMachineEnvelope(settings)
    expect(envelope.x).toMatchObject({ homesToward: 'min', homePositionMm: 0, min: 0, max: 738 })
  })
})

describe('reconcileHomeConvention', () => {
  // A grbl machine: far-corner homing, so the controller reports
  // homesToward 'max' and homePositionMm 0 on every axis.
  const envelope = deriveMachineEnvelope(
    settingsDump({ 23: '0', 27: '3.000', 130: '740.000', 131: '724.000', 132: '130.000' }),
  )

  function convention(x: { homesToward: 'max' | 'min'; homePositionMm: number }): MachineHomeConvention {
    return {
      x,
      y: { homesToward: 'max', homePositionMm: 0 },
      z: { homesToward: 'max', homePositionMm: 0 },
    }
  }

  it('surfaces a declared-vs-reported home-position disagreement, naming the axis and both numbers', () => {
    const declared = convention({ homesToward: 'max', homePositionMm: 738 })
    const mismatches = reconcileHomeConvention(envelope, declared)
    expect(mismatches).toEqual([
      {
        axis: 'x',
        declaredHomesToward: 'max',
        reportedHomesToward: 'max',
        declaredHomePositionMm: 738,
        reportedHomePositionMm: 0,
      },
    ])
  })

  it('surfaces a disagreement on which corner the switch is at, even when the reported position number matches', () => {
    // Declared thinks X homes near/positive (min corner); the controller's
    // own settings say it homes far/negative (max corner). Both happen to
    // read 0 at the switch, but the reachable table is the mirror image -
    // exactly the "crash at the corner of the table" this order names.
    const declared = convention({ homesToward: 'min', homePositionMm: 0 })
    const mismatches = reconcileHomeConvention(envelope, declared)
    expect(mismatches).toEqual([
      {
        axis: 'x',
        declaredHomesToward: 'min',
        reportedHomesToward: 'max',
        declaredHomePositionMm: 0,
        reportedHomePositionMm: 0,
      },
    ])
  })

  it('is silent when the declared convention agrees with every axis', () => {
    const declared = convention({ homesToward: 'max', homePositionMm: 0 })
    expect(reconcileHomeConvention(envelope, declared)).toEqual([])
  })

  it('is silent under the tolerance and fires at or above it', () => {
    const justUnder = HOME_POSITION_MISMATCH_TOLERANCE_MM * 0.99
    const atOrOver = HOME_POSITION_MISMATCH_TOLERANCE_MM
    expect(reconcileHomeConvention(envelope, convention({ homesToward: 'max', homePositionMm: justUnder }))).toEqual([])
    expect(reconcileHomeConvention(envelope, convention({ homesToward: 'max', homePositionMm: atOrOver }))).toHaveLength(1)
  })

  it('never prefers either number - both are reported back verbatim', () => {
    const declared = convention({ homesToward: 'max', homePositionMm: 900 })
    const [mismatch] = reconcileHomeConvention(envelope, declared)
    expect(mismatch.declaredHomePositionMm).toBe(900)
    expect(mismatch.reportedHomePositionMm).toBe(0)
  })

  it('has nothing to reconcile when no convention is declared - absent means "the controller tells us"', () => {
    expect(reconcileHomeConvention(envelope, null)).toEqual([])
    expect(reconcileHomeConvention(envelope, undefined)).toEqual([])
  })

  it('does not compare an axis the controller has not reported yet', () => {
    const partial = deriveMachineEnvelope(settingsDump({ 130: '740.000' }))
    const declared: MachineHomeConvention = {
      x: { homesToward: 'max', homePositionMm: 0 },
      y: { homesToward: 'max', homePositionMm: 9999 },
      z: { homesToward: 'max', homePositionMm: 9999 },
    }
    expect(reconcileHomeConvention(partial, declared)).toEqual([])
  })

  // WO-301: a machine that declares no homing switches suppresses its
  // envelope entirely (deriveMachineEnvelope's noHomingSwitches option) -
  // reconciliation needs no special case for it, because an all-null
  // envelope already has nothing to compare against, the same as any axis
  // the controller has not reported yet.
  it('has nothing to reconcile against a no-homing-switches machine, even from a settings dump that would otherwise derive a real envelope', () => {
    const suppressed = deriveMachineEnvelope(
      settingsDump({ 23: '0', 27: '3.000', 130: '740.000', 131: '724.000', 132: '130.000' }),
      { noHomingSwitches: true },
    )
    const declared = convention({ homesToward: 'max', homePositionMm: 738 })
    expect(reconcileHomeConvention(suppressed, declared)).toEqual([])
  })
})
