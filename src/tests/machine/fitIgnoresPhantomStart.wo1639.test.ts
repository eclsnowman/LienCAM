// WO-1639: `buildPreviewModel` has no live machine position when it parses a
// loaded text program, so it assumes a work (0,0,0) start it cannot actually
// know. That assumed start used to count in `workBounds`, so a program that
// is really entirely off the table (WO-1630's `G54 Z 66.57` finding: every
// real Z is -333.43, below the table) read 'partial' instead of 'outside' -
// 'partial' does not block CYCLE START. `workBounds` must cover only
// positions the program text actually commands.

import { describe, expect, it } from 'vitest'
import {
  deriveAxisEnvelopeFromHome,
  ENVELOPE_FIT_TOLERANCE_MM,
  fitProgramToEnvelope,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'

// X/Y travel is generous so every case below is decided purely by Z, the
// axis the finding was about. Z's table is machine -200..0mm (home at
// machine Z 0, homing toward the max end).
function envelopeFixture(): MachineEnvelope {
  return {
    x: deriveAxisEnvelopeFromHome({ travelMm: 1000, homesToward: 'min', homePositionMm: 0 }),
    y: deriveAxisEnvelopeFromHome({ travelMm: 1000, homesToward: 'min', homePositionMm: 0 }),
    z: deriveAxisEnvelopeFromHome({ travelMm: 200, homesToward: 'max', homePositionMm: 0 }),
  }
}

function fitFor(programText: string, offsetZ: number) {
  const model = buildPreviewModel(programText)
  return fitProgramToEnvelope(
    model.workBounds, { x: 0, y: 0, z: offsetZ }, envelopeFixture(), ENVELOPE_FIT_TOLERANCE_MM,
    model.machineCoordinateRanges,
  )
}

describe('WO-1639: the table fit of a loaded file ignores the phantom start at work zero', () => {
  it("the finding's exact repro: a program that never touches the table reads OUTSIDE", () => {
    // G0 Z-400 / G1 X550 (Z stays -400, modal): every REAL Z is -400 work,
    // -333.43 machine, entirely below the table (-200..0). The old bug
    // blended in an assumed work Z=0 start (machine 66.57, above the table)
    // and read 'partial', which does not block CYCLE START.
    const program = 'G21 G90 G54\nG0 X500 Y300 Z-400\nG1 X550 F300\n'
    const fit = fitFor(program, 66.57)
    expect(fit?.state).toBe('outside')
    expect(fit?.offending.map((a) => a.axis)).toContain('z')
  })

  it('a program that stays on the table reads INSIDE', () => {
    const program = 'G21 G90 G54\nG1 X100 Y100 Z-50 F300\n'
    expect(fitFor(program, 0)?.state).toBe('inside')
  })

  it('a program that really straddles the table edge reads partial', () => {
    const program = 'G21 G90 G54\nG1 Z-50 F300\nG1 Z-250\n'
    expect(fitFor(program, 0)?.state).toBe('partial')
  })

  it('the assumed (0,0,0) start never leaks into workBounds', () => {
    const model = buildPreviewModel('G21 G90 G54\nG1 X10 Y10 Z-5 F100\n')
    expect(model.workBounds).toEqual({ min: { x: 10, y: 10, z: -5 }, max: { x: 10, y: 10, z: -5 } })
  })

  it('an XY rapid followed by Z on the next line still reads OUTSIDE (audit repro)', () => {
    // The most common post shape: `G0 X500 Y300` addresses only X/Y, so its
    // OWN end still carries an unaddressed Z. That Z must not count as a real
    // 0 until the next line actually commands it.
    const program = 'G21 G90 G54\nG0 X500 Y300\nG0 Z-400\nG1 X550 F300\n'
    const fit = fitFor(program, 66.57)
    expect(fit?.state).toBe('outside')
    expect(fit?.offending.map((a) => a.axis)).toContain('z')
  })

  it('a Z-first move does not leak a phantom X0/Y0 into workBounds once XY is later addressed', () => {
    const model = buildPreviewModel('G21 G90 G54\nG0 Z-400\nG0 X500 Y300\nG1 X550 F300\n')
    expect(model.workBounds).toEqual({ min: { x: 500, y: 300, z: -400 }, max: { x: 550, y: 300, z: -400 } })
  })
})
