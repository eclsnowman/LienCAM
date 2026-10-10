// WO-377: the SIGNED result of a declared homing convention, in numbers and in
// plain words, and the loaded program's fit against the table.
//
// Operator's machine: Y travel 724.5, switch at the MAX end, machine zero at the
// MAX end -> machine Y -724.5..0. A program in positive Y with G54 on machine
// zero is outside the table; the UI must say so rather than look misplaced.

import { describe, expect, it } from 'vitest'
import {
  boundsOfPoints,
  deriveMachineEnvelopeFromConvention,
  describeSignedAxisRange,
  fitProgramToEnvelope,
  signedAxisRange,
} from '../../lib/machine/machineEnvelope'

type End = 'max' | 'min'
const ENDS: End[] = ['max', 'min']

describe('WO-377 signedAxisRange - every switch/zero combination', () => {
  const T = 500

  const EXPECTED: Record<string, { min: number; max: number; home: number; negative: boolean }> = {
    'max/max': { min: -T, max: 0, home: 0, negative: true },
    'max/min': { min: 0, max: T, home: T, negative: false },
    'min/min': { min: 0, max: T, home: 0, negative: false },
    'min/max': { min: -T, max: 0, home: -T, negative: true },
  }

  for (const homesToward of ENDS) {
    for (const machineZeroAt of ENDS) {
      const key = `${homesToward}/${machineZeroAt}`
      it(`switch ${homesToward}, zero ${machineZeroAt} -> ${EXPECTED[key].min}..${EXPECTED[key].max}, home at ${EXPECTED[key].home}`, () => {
        const r = signedAxisRange('x', { homesToward, machineZeroAt }, T)!
        expect(r).not.toBeNull()
        expect(r.min).toBe(EXPECTED[key].min)
        expect(r.max).toBe(EXPECTED[key].max)
        expect(r.homePositionMm).toBe(EXPECTED[key].home)
        expect(r.negative).toBe(EXPECTED[key].negative)
        expect(r.machineZeroAt).toBe(machineZeroAt)
        // Same numbers the Control grid derives - one derivation, not two.
        const env = deriveMachineEnvelopeFromConvention(
          { x: { homesToward, machineZeroAt }, y: { homesToward, machineZeroAt }, z: { homesToward, machineZeroAt } },
          { x: T, y: T, z: T },
        )
        expect(env.x!.min).toBe(r.min)
        expect(env.x!.max).toBe(r.max)
        expect(env.x!.homePositionMm).toBe(r.homePositionMm)
      })
    }
  }

  it("Operator's exact case: Y travel 724.5, switch max, zero max -> -724.5..0, home at Y 0", () => {
    const r = signedAxisRange('y', { homesToward: 'max', machineZeroAt: 'max' }, 724.5)!
    expect(r.min).toBe(-724.5)
    expect(r.max).toBe(0)
    expect(r.homePositionMm).toBe(0)
    expect(r.negative).toBe(true)
    const words = describeSignedAxisRange(r)
    expect(words).toContain('Y runs -724.5 to 0')
    expect(words).toContain('home lands at Y 0, the maximum end')
    expect(words).toContain('entirely in negative Y')
    expect(words).toContain('saved as typed')
  })

  it('min/min explains nothing negative; max/min says home lands at the far end', () => {
    const mm = describeSignedAxisRange(signedAxisRange('x', { homesToward: 'min', machineZeroAt: 'min' }, 800)!)
    expect(mm).toBe('X runs 0 to 800; home lands at X 0, the minimum end.')
    const mx = describeSignedAxisRange(signedAxisRange('z', { homesToward: 'max', machineZeroAt: 'min' }, 100)!)
    expect(mx).toBe('Z runs 0 to 100; home lands at Z 100, the maximum end.')
  })

  it('uses the caller formatter (display units) and refuses a non-positive travel', () => {
    const r = signedAxisRange('y', { homesToward: 'max', machineZeroAt: 'max' }, 254)!
    const inches = describeSignedAxisRange(r, (mm) => `${(mm / 25.4).toFixed(2)} in`)
    expect(inches).toContain('Y runs -10.00 in to 0.00 in')
    expect(signedAxisRange('y', { homesToward: 'max', machineZeroAt: 'max' }, 0)).toBeNull()
    expect(signedAxisRange('y', { homesToward: 'max', machineZeroAt: 'max' }, Number.NaN)).toBeNull()
  })

  it('honours an older profile that carries homePositionMm directly (WO-300 UCCNC)', () => {
    const r = signedAxisRange('y', { homesToward: 'max', homePositionMm: 724.5 }, 724.5)!
    expect(r.min).toBe(0)
    expect(r.max).toBe(724.5)
    expect(r.machineZeroAt).toBe('min')
    expect(r.negative).toBe(false)
  })
})

describe('WO-377 fitProgramToEnvelope - program vs table after the work offset', () => {
  const sampleMachineY = deriveMachineEnvelopeFromConvention(
    {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    { x: 738, y: 724.5, z: 128.9 },
  )
  const program = boundsOfPoints([
    { x: 0, y: 0, z: 5 },
    { x: 80, y: 60, z: -16 },
  ])!
  const g54OnMachineZero = { x: 0, y: 0, z: 0 }

  it("Operator's screenshot: positive-Y program, G54 on machine zero -> X and Y entirely off the table", () => {
    const fit = fitProgramToEnvelope(program, g54OnMachineZero, sampleMachineY)!
    expect(fit.state).toBe('outside')
    const byAxis = Object.fromEntries(fit.axes.map((a) => [a.axis, a]))
    // X 0..80 and Y 0..60 only TOUCH the table edge at 0 from outside: that
    // is off the table, not "partly" on it. Z 5..-16 straddles Z 0: partial.
    expect(byAxis.x.state).toBe('outside')
    expect(byAxis.y.state).toBe('outside')
    expect(byAxis.z.state).toBe('partial')
    const shifted = fitProgramToEnvelope(program, { x: 1, y: 1, z: 0 }, sampleMachineY)!
    expect(shifted.offending.map((a) => `${a.axis}:${a.state}`)).toEqual(['x:outside', 'y:outside', 'z:partial'])
    expect(shifted.state).toBe('outside')
    expect(shifted.axes.find((a) => a.axis === 'y')).toMatchObject({
      programMin: 1, programMax: 61, machineMin: -724.5, machineMax: 0,
    })
  })

  it('the same program with G54 moved onto the table fits, touching the edge exactly', () => {
    const fit = fitProgramToEnvelope(program, { x: -738, y: -724.5, z: -20 }, sampleMachineY)!
    expect(fit.state).toBe('inside')
    expect(fit.offending).toEqual([])
  })

  it('partly off on one axis only names that axis', () => {
    const fit = fitProgramToEnvelope(program, { x: -100, y: -30, z: -20 }, sampleMachineY)!
    expect(fit.state).toBe('partial')
    expect(fit.offending.map((a) => a.axis)).toEqual(['y'])
    expect(fit.offending[0]).toMatchObject({ programMin: -30, programMax: 30, state: 'partial' })
  })

  it('is silent (null) without a program, an offset, or any envelope axis', () => {
    expect(fitProgramToEnvelope(null, g54OnMachineZero, sampleMachineY)).toBeNull()
    expect(fitProgramToEnvelope(program, null, sampleMachineY)).toBeNull()
    expect(fitProgramToEnvelope(program, g54OnMachineZero, { x: null, y: null, z: null })).toBeNull()
    expect(boundsOfPoints([])).toBeNull()
  })

  it('skips an axis the envelope does not know and compares the rest', () => {
    const fit = fitProgramToEnvelope(program, g54OnMachineZero, { ...sampleMachineY, z: null })!
    expect(fit.axes.map((a) => a.axis)).toEqual(['x', 'y'])
  })

  it('skips an axis whose work offset is not established and compares the rest', () => {
    const fit = fitProgramToEnvelope(program, { x: -738, y: -724.5 }, sampleMachineY)!
    expect(fit.axes.map((a) => a.axis)).toEqual(['x', 'y'])
    expect(fit.offending).toEqual([])
  })
})
