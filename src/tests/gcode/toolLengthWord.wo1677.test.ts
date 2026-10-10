// WO-1677: `G43 H<n>` shifts every Z it governs by the length the machine's
// tool table holds for tool n. The reader folds that length into the staged
// Z, so the moves already carry it - no controller-side offset is written by a
// program, and none is left behind however the run ends.

import { describe, expect, it } from 'vitest'
import { readGcodeProgram, type GcodeReaderOptions, type GcodeReadProgram } from '../../lib/gcode'

const TABLE: Record<number, number> = { 3: 45.2, 5: -12.5 }

const OPTIONS: GcodeReaderOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
  workOffsets: { G54: { x: 10, y: 5, z: 2 } },
  // Unmeasured or absent: zero, what UCCNC's table answers for that row.
  toolLengthMm: (h) => TABLE[h] ?? 0,
}

function program(text: string, options: Partial<GcodeReaderOptions> = OPTIONS): GcodeReadProgram {
  const result = readGcodeProgram(text, { ...OPTIONS, ...options })
  if (!result.ok) throw new Error(result.refusal.message)
  return result.program
}

const zs = (read: GcodeReadProgram): number[] => read.moves.map((move) => Number(move.z.toFixed(4)))

describe('WO-1677: the tool table length is folded into the Z a G43 H governs', () => {
  it('shifts absolute Z by a measured tool\'s length, and G49 takes it back out', () => {
    const read = program('G21 G90\nG43 H3\nG0 X0 Y0 Z10\nG1 Z-1 F300\nG49\nG0 Z10\nM30')
    expect(zs(read)).toEqual([55.2, 44.2, 10])
  })

  it('an unmeasured tool, or one the table does not hold, shifts by zero', () => {
    expect(zs(program('G21 G90\nG43 H7\nG0 X0 Y0 Z10\nM30'))).toEqual([10])
    // No table passed at all: the same zero.
    expect(zs(program('G21 G90\nG43 H3\nG0 X0 Y0 Z10\nM30', { toolLengthMm: undefined }))).toEqual([10])
  })

  it('a tool change followed by a new G43 Hm switches to tool m\'s length', () => {
    const read = program('G21 G90\nT3 M6\nG43 H3\nG0 X0 Y0 Z10\nG0 Z20\nT5 M6\nG43 H5\nG0 Z10\nM30')
    expect(zs(read)).toEqual([55.2, 65.2, -2.5])
  })

  it('G43 Z.. H on the same block shifts that block\'s own Z', () => {
    const read = program('G21 G90\nG0 X0 Y0\nG43 Z10 H3\nG1 Z-1 F300\nM30')
    expect(zs(read).slice(-2)).toEqual([55.2, 44.2])
  })

  it('an incremental Z is a distance and is not shifted again', () => {
    const read = program('G21 G90\nG43 H3\nG0 X0 Y0 Z10\nG91\nG1 Z-5 F300\nM30')
    expect(zs(read)).toEqual([55.2, 50.2])
  })

  it('a G53 machine-frame Z is not shifted, as on the controller', () => {
    // G53 Z0 is machine Z 0 whatever tool is fitted: work Z = 0 - 2.
    const read = program('G21 G90\nG43 H3\nG0 X0 Y0 Z10\nG53 G0 Z0\nM30')
    expect(zs(read)).toEqual([55.2, -2])
  })

  it('asks the length per frame, so a length already in force in one frame is answered net there only', () => {
    // G54 holds 45.2 of tool 3 already (the panel's Apply); G55 holds none.
    const inForce: Record<string, number> = { G54: 45.2 }
    const read = program('G21 G90 G54\nG43 H3\nG0 X0 Y0 Z10\nG55\nG0 Z10\nM30', {
      workOffsets: { G54: { x: 10, y: 5, z: 2 }, G55: { x: 10, y: 5, z: 2 } },
      toolLengthMm: (h, wcs) => (TABLE[h] ?? 0) - (inForce[wcs] ?? 0),
    })
    expect(zs(read)).toEqual([10, 55.2])
  })
})
