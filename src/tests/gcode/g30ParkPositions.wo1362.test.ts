import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram, type GcodeInterpretOptions } from '../../lib/gcode/interpret'
import { readGcodeProgram, type GcodeReaderMove, type GcodeReaderOptions } from '../../lib/gcode/reader'

const WORK_OFFSET = { x: 10, y: 5, z: 2 }
const PARKS = {
  1: { x: 738, y: 724.5, z: 128 },
  3: { x: 50, y: 50, z: 128 },
  4: { x: 50, y: 724.5, z: 128 },
} as const

const READER_OPTIONS: GcodeReaderOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 1, y: 2, z: 3 },
  machineUnits: 'mm',
  workOffsets: { G54: WORK_OFFSET },
  referencePositions: PARKS,
}

const INTERPRET_OPTIONS: GcodeInterpretOptions = {
  ...READER_OPTIONS,
}

function read(text: string, options: GcodeReaderOptions = READER_OPTIONS) {
  return readGcodeProgram(text, options)
}

describe('WO-1362 G30 reference positions', () => {
  it('stages Operator\'s point 1 as machine Z first, then machine X/Y', () => {
    const result = read('G21 G90 G54\nG30\nM30\n')
    if (!result.ok) throw new Error(result.refusal.message)

    expect(result.program.moves).toHaveLength(2)
    expect(result.program.moves[0]).toEqual({
      type: 'rapid', role: 'rapid', x: 1, y: 2, z: 126,
    })
    expect(result.program.moves[1]).toEqual({
      type: 'rapid', role: 'rapid', x: 728, y: 719.5, z: 126,
    })
    expect((result.program.moves[0] as GcodeReaderMove).machineAbsolute).toEqual({ z: 128 })
    expect((result.program.moves[1] as GcodeReaderMove).machineAbsolute).toEqual({ x: 738, y: 724.5 })
    expect(result.program.moveLines).toEqual([2, 2])
  })

  it.each([
    [3, PARKS[3]],
    [4, PARKS[4]],
  ] as const)('G30 P%i selects that numbered point', (number, point) => {
    const result = interpretGcodeProgram(`G21 G90 G54\nG30 P${number}\nM30\n`, INTERPRET_OPTIONS)
    if (!result.ok) throw new Error(result.refusal.message)
    const moves = result.program.stages.flatMap((stage) => stage.moves)
    expect(moves).toHaveLength(2)
    expect(moves[0].machineAbsolute).toEqual({ z: point.z })
    expect(moves[1].machineAbsolute).toEqual({ x: point.x, y: point.y })
  })

  it('refuses an unstored P number by number and returns no partial program', () => {
    const result = read('G21 G90 G54\nG30 P2\nM30\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.line).toBe(2)
    expect(result.refusal.reason).toContain('G30 via-point return P2')
    expect(result.refusal.reason).toContain('stores no controller-stored point 2')
    expect(Object.hasOwn(result, 'program')).toBe(false)
  })

  it('keeps legacy machines unchanged: absent positions refuse G30 and name the absence', () => {
    const result = read('G21 G90 G54\nG30\nM30\n', {
      ...READER_OPTIONS,
      referencePositions: undefined,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.reason).toContain('G30 via-point return P1')
    expect(result.refusal.reason).toContain('stores no controller-stored point 1')
  })

  it('carries a standard intermediate point before the same Z-first park sequence', () => {
    const result = read('G21 G90 G54\nG30 X20 Y30\nM30\n')
    if (!result.ok) throw new Error(result.refusal.message)
    expect(result.program.moves).toHaveLength(3)
    expect(result.program.moves[0]).toEqual({ type: 'rapid', role: 'rapid', x: 20, y: 30, z: 3 })
    expect(result.program.moves[1].machineAbsolute).toEqual({ z: 128 })
    expect(result.program.moves[2].machineAbsolute).toEqual({ x: 738, y: 724.5 })
  })
})
