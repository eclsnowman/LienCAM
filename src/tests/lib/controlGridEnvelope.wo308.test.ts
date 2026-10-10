// ============================================================
// WO-308: the Control grid draws the real table
// ============================================================
// resolveProgramPreviewGrid's "machine" selection used to read $130/$131
// straight and always drew the box as if machine zero sat at (0,0,0) - it
// had no idea which corner the machine actually homes to, or whether the
// live position was ever anchored to reality. This proves the replacement:
// given an envelope (WO-292/300), the grid extent and machine-zero position
// it draws are correct for both homing conventions and for Operator's own
// machine, and that safeMachinePosition - the one honesty chokepoint, not a
// second one - refuses a confidently-placed grid until the machine is
// homed.

import { describe, expect, it } from 'vitest'
import {
  resolveProgramPreviewGrid,
  type ProgramPreviewGridResolution,
} from '../../components/machine/ProgramPreviewGridControl'
import {
  deriveAxisEnvelopeFromHome,
  type AxisEnvelope,
  type EnvelopeStatus,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'

const OFFSETS = { G54: [-10, -20, -3] }

function axis(args: Parameters<typeof deriveAxisEnvelopeFromHome>[0]): AxisEnvelope {
  return deriveAxisEnvelopeFromHome(args)
}

// Bit clear (grbl default): switch at the max-travel corner, home reads 0,
// table entirely <= 0.
const FAR_CORNER: MachineEnvelope = {
  x: axis({ travelMm: 800, homesToward: 'max', homePositionMm: 0 }),
  y: axis({ travelMm: 600, homesToward: 'max', homePositionMm: 0 }),
  z: null,
}

// Bit set: switch at the min-travel corner, home still reads 0 (grbl always
// zeroes at the switch), table entirely >= 0.
const NEAR_CORNER: MachineEnvelope = {
  x: axis({ travelMm: 800, homesToward: 'min', homePositionMm: 0 }),
  y: axis({ travelMm: 600, homesToward: 'min', homePositionMm: 0 }),
  z: null,
}

// WO-300: Operator's UCCNC machine writes an operator-chosen offset on homing -
// home at back-right-top reading 738/724.5/128.9, table entirely positive.
const ERICS_MACHINE: MachineEnvelope = {
  x: axis({ travelMm: 738, homesToward: 'max', homePositionMm: 738 }),
  y: axis({ travelMm: 724.5, homesToward: 'max', homePositionMm: 724.5 }),
  z: axis({ travelMm: 128.9, homesToward: 'max', homePositionMm: 128.9 }),
}

const EMPTY_ENVELOPE: MachineEnvelope = { x: null, y: null, z: null }

function resolveMachine(envelope: MachineEnvelope, status: EnvelopeStatus): ProgramPreviewGridResolution {
  return resolveProgramPreviewGrid('machine', 'G54', OFFSETS, envelope, status)
}

describe('WO-308 resolveProgramPreviewGrid - machine selection draws the real table', () => {
  it('far-corner (negative) convention: box runs negative from machine zero at the origin', () => {
    const r = resolveMachine(FAR_CORNER, 'homed')
    expect(r.available).toBe(true)
    expect(r.label).toBe('Machine')
    expect(r.gridOriginMachine).toEqual({ x: 0, y: 0, z: 0 })
    expect(r.travel).toEqual({ x: 800, y: 600 })
    expect(r.extentMachine).toEqual({ x: { min: -800, max: 0 }, y: { min: -600, max: 0 } })
  })

  it('near-corner (positive) convention: same machine-zero reading, opposite sign box', () => {
    const r = resolveMachine(NEAR_CORNER, 'homed')
    expect(r.available).toBe(true)
    expect(r.gridOriginMachine).toEqual({ x: 0, y: 0, z: 0 })
    expect(r.travel).toEqual({ x: 800, y: 600 })
    expect(r.extentMachine).toEqual({ x: { min: 0, max: 800 }, y: { min: 0, max: 600 } })
  })

  it("Operator's own machine: home reads 738/724.5/128.9, while the grid remains anchored at machine zero", () => {
    const r = resolveMachine(ERICS_MACHINE, 'homed')
    expect(r.available).toBe(true)
    expect(r.gridOriginMachine).toEqual({ x: 0, y: 0, z: 0 })
    expect(r.travel).toEqual({ x: 738, y: 724.5 })
    expect(r.extentMachine).toEqual({
      x: { min: 0, max: 738 },
      y: { min: 0, max: 724.5 },
    })
  })

  it('unknown envelope: no confidently-placed grid, and the reason (unknown) is the input the caller shows', () => {
    const r = resolveMachine(EMPTY_ENVELOPE, 'unknown')
    expect(r.available).toBe(false)
    expect(r.label).toBe('Machine unavailable')
    expect(r.gridOriginMachine).toBeNull()
    expect(r.travel).toBeNull()
    expect(r.extentMachine).toBeNull()
  })

  it('settings known but not homed this session: no confidently-placed grid even though the box is knowable', () => {
    const r = resolveMachine(FAR_CORNER, 'not-homed')
    expect(r.available).toBe(false)
    // WO-1327 (landed 2026-09-13): a CONNECTED machine that has not been homed
    // is not "unavailable" - it is present and one action away, and the select
    // already said HOME FIRST. Only 'unknown' is unavailable. This test lives in
    // src/tests/lib/, outside WO-1327's declared slice, so nothing repinned it
    // and it went red on main; the sweep is what found it.
    expect(r.label).toBe('Machine - HOME FIRST')
    expect(r.gridOriginMachine).toBeNull()
    expect(r.travel).toBeNull()
  })

  it('tells "not homed" apart from "unavailable" - the distinction WO-1327 exists for', () => {
    expect(resolveMachine(FAR_CORNER, 'not-homed').label)
      .not.toBe(resolveMachine(EMPTY_ENVELOPE, 'unknown').label)
  })

  it('no-datum (WO-301 switch-less machine): also refused by the same chokepoint', () => {
    const r = resolveMachine(FAR_CORNER, 'no-datum')
    expect(r.available).toBe(false)
    expect(r.gridOriginMachine).toBeNull()
  })

  it('homed with no active WCS offset: machine grid remains available independently', () => {
    const r = resolveProgramPreviewGrid('machine', null, {}, FAR_CORNER, 'homed')
    expect(r.available).toBe(true)
    expect(r.programOriginMachine).toBeNull()
    expect(r.extentMachine).toEqual({ x: { min: -800, max: 0 }, y: { min: -600, max: 0 } })
  })

  it('homed but the envelope is missing an axis: still unavailable - a partial box is not a real one', () => {
    const partial: MachineEnvelope = { x: FAR_CORNER.x, y: null, z: null }
    const r = resolveMachine(partial, 'homed')
    expect(r.available).toBe(false)
    expect(r.travel).toBeNull()
  })
})

describe('WO-308 resolveProgramPreviewGrid - WCS-frame selections are unaffected by homing', () => {
  // WO-414 batch 2: the selector lists G54..G59 by name (no "active" entry);
  // the WCS-frame rule is unchanged - a chosen G5x grid still resolves from
  // that offset while not-homed.
  it('a G54 grid still resolves while not-homed - it shows the same table from the G54 offset, not machine zero', () => {
    const r = resolveProgramPreviewGrid('G54', 'G54', OFFSETS, FAR_CORNER, 'not-homed')
    expect(r.available).toBe(true)
    expect(r.label).toBe('G54')
    expect(r.gridOriginMachine).toEqual({ x: -10, y: -20, z: -3 })
    expect(r.travel).toEqual({ x: 800, y: 600 })
  })

  it('off selection stays available with no grid regardless of envelope or status', () => {
    const r = resolveProgramPreviewGrid('off', 'G54', OFFSETS, EMPTY_ENVELOPE, 'unknown')
    expect(r.available).toBe(true)
    expect(r.gridOriginMachine).toBeNull()
    expect(r.travel).toBeNull()
    expect(r.extentMachine).toBeNull()
  })
})
