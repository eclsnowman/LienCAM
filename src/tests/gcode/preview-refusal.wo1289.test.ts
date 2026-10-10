import { describe, expect, it } from 'vitest'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'

describe('WO-1289 preview refuses unread program text whole', () => {
  it.each([
    ['inverse-time feed', 'G21 G90\nG0 X10\nG93 G1 X20 F2', 'Line 3: G93'],
    ['cutter compensation', 'G21 G90\nG0 X10\nG41 G1 X20 F100', 'Line 3: G41'],
    ['LinuxCNC O-word', 'G21 G90\nG0 X10\nO100 repeat [4]\nG1 X20 F100', 'Line 3: O100'],
    ['LinuxCNC expression operator', 'G21 G90\nG0 X10\nG1 X10 @-.0025 F100', 'Line 3: @'],
    ['macro variable', 'G21 G90\nG0 X10\nG1 X#1 F100', 'Line 3: #'],
  ])('names %s and returns no partial geometry', (_name, program, namedWord) => {
    const preview = buildPreviewModel(program)

    expect(preview.refusal).toContain(namedWord)
    expect(preview.refusal).toContain('refusing to draw this program')
    expect(preview.moves).toEqual([])
    expect(preview.polylines).toEqual([])
    expect(preview.addressedAxes).toEqual({})
    expect(preview.spindleRpmMax).toBe(0)
    expect(preview.workBounds).toBeNull()
    expect(preview.machineCoordinateRanges).toEqual({})
  })

  it.each(['H1', 'D2', 'E4'])(
    'does not erase shared geometry for controller-ignored numeric word %s',
    (ignoredWord) => {
      const preview = buildPreviewModel([
        'G21 G90',
        'M3 S30000',
        'G0 X20 Y10 Z5',
        `G1 X60 ${ignoredWord} F2500`,
        'M30',
      ].join('\n'))

      expect(preview.refusal).toBeNull()
      expect(preview.moves).toHaveLength(2)
      expect(preview.addressedAxes).toMatchObject({ x: {}, y: {}, z: {} })
      expect(preview.spindleRpmMax).toBe(30000)
      expect(preview.workBounds).toMatchObject({ max: { x: 60, y: 10, z: 5 } })
    },
  )

  it.each(['A45', 'B30', 'C15', 'U4', 'V5', 'W6'])(
    'refuses unsupported coordinate word %s because it can change the path',
    (coordinateWord) => {
      const preview = buildPreviewModel(`G21 G90\nG0 X10\nG1 X20 ${coordinateWord} F100\nM30`)

      expect(preview.refusal).toContain(`Line 3: ${coordinateWord}`)
      expect(preview.moves).toEqual([])
      expect(preview.polylines).toEqual([])
    },
  )

  // WO-1644: G43 H is a zero Z shift on every route (reader.ts), so the preview
  // draws the path it applies to instead of refusing the program.
  it('draws through G43 H as the reader reads it - a zero Z shift', () => {
    const preview = buildPreviewModel('G21 G90\nG0 X10\nG43 Z0.6 H3\nG1 X20 F100\nM30')
    expect(preview.refusal).toBeNull()
    expect(preview.moves.at(-1)?.to).toMatchObject({ x: 20, z: 0.6 })
  })

  it.each(['M10', 'M42', 'M2001', 'M20002'])(
    'notes non-geometric M word %s without suppressing the path',
    (mWord) => {
      const preview = buildPreviewModel(`G21 G90\n${mWord}\nG0 X10\nG1 X20 F100\nM30`)

      expect(preview.refusal).toBeNull()
      expect(preview.notes).toContain(
        `Line 2: ${mWord} is not interpreted by the preview; it does not change the drawn path.`,
      )
      expect(preview.moves).toHaveLength(2)
    },
  )

  it('keeps the preview vocabulary in one explicit source for every consumer', () => {
    const preview = buildPreviewModel([
      'G20 G90 G18 G54',
      'G0 X1 Z1',
      'G2 X2 Z1 I0.5 K0 F10',
      'G53 G0 Z3',
      'G98 G81 X2 Y1 Z-0.1 R0.1 F5',
      'G80',
      'M30',
    ].join('\n'))

    expect(preview.refusal).toBeNull()
    expect(preview.moves.length).toBeGreaterThan(0)
  })

  it.each([
    ['G28 machine-reference return', 'G28 G91 Z0', 'G28'],
    ['G30 stored-reference return', 'G30 Z0', 'G30'],
    ['G38.2 probe contact', 'G38.2 Z-10 F100', 'G38.2'],
    ['G92 coordinate-frame shift', 'G92 X0', 'G92'],
    ['G10 coordinate-frame parameters', 'G10 L2 P1 X0', 'G10'],
  ])('refuses unmodeled %s instead of giving safety consumers incomplete geometry', (_name, command, namedWord) => {
    const preview = buildPreviewModel([
      'G21 G90 G54',
      'G1 X900 Y700 Z400 F9000',
      command,
      'G1 X20 Y30 Z40 F100',
      'M30',
    ].join('\n'))

    expect(preview.refusal).toContain(`Line 3: ${namedWord}`)
    expect(preview.refusal).toContain('refusing to draw this program')
    expect(preview.moves).toEqual([])
    expect(preview.polylines).toEqual([])
    expect(preview.addressedAxes).toEqual({})
    expect(preview.workBounds).toBeNull()
    expect(preview.machineCoordinateRanges).toEqual({})
  })

  it.each([
    ['parenthesized', 'G21 G90\n( G43 pocket )\nG0 X10\nG1 X20 F100\nM30'],
    ['nested parenthesized', 'G21 G90\nT19 M6 (flat end mill 1/8"(.1250") Single Flute DLC Carbide)\nG0 X10\nG1 X20 F100\nM30'],
    ['unclosed parenthesized', 'G21 G90\nG0 X10 ( G43 unfinished tool note\nG1 X20 F100\nM30'],
    ['semicolon', 'G21 G90\nG0 X10 ; finish pass R0.5\nG1 X20 F100\nM30'],
    ['semicolon on CRLF lines', 'G21 G90\r\nG0 X10 ; finish pass R0.5\r\nG1 X20 F100\r\nM30\r\n'],
  ])('ignores unsupported-looking words inside %s comments', (_style, program) => {
    const preview = buildPreviewModel(program)

    expect(preview.refusal).toBeNull()
    expect(preview.moves.length).toBeGreaterThan(0)
  })
})
