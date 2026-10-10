import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  readGcodeProgram,
  type GcodeReaderOptions,
  type GcodeReadProgram,
  type GcodeReadRefusal,
} from '../../lib/gcode'

const OPTIONS: GcodeReaderOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
}

function read(
  lines: string[],
  options: Partial<GcodeReaderOptions> = {},
): ReturnType<typeof readGcodeProgram> {
  return readGcodeProgram(lines.join('\n'), { ...OPTIONS, ...options })
}

function program(lines: string[]): GcodeReadProgram {
  const result = read(lines)
  expect(result.ok, result.ok ? undefined : result.refusal.message).toBe(true)
  if (!result.ok) throw new Error(result.refusal.message)
  return result.program
}

function refused(lines: string[], options: Partial<GcodeReaderOptions> = {}): GcodeReadRefusal {
  const result = read(lines, options)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected the whole file to be refused')
  expect('program' in result).toBe(false)
  return result.refusal
}

describe('WO-1363 inverse-time feed state', () => {
  it('pins a program with no G93 to the reader output from before this change', () => {
    const result = readGcodeProgram([
      'G21 G90',
      'G0 X0 Y0 Z5',
      'G1 X10 Y0 Z0 F240',
      'X20',
      'M30',
    ].join('\n'), OPTIONS)

    expect(result).toMatchInlineSnapshot(`
      {
        "ok": true,
        "program": {
          "end": {
            "coolant": {
              "flood": false,
              "mist": false,
            },
            "distanceMode": "absolute",
            "feedMmMin": 240,
            "inSpindleTool": null,
            "motion": "G1",
            "position": {
              "x": 20,
              "y": 0,
              "z": 0,
            },
            "positionKnown": {
              "x": true,
              "y": true,
              "z": true,
            },
            "selectedTool": null,
            "spindleRpm": null,
            "units": "mm",
            "wcs": "G54",
          },
          "items": [
            {
              "kind": "move",
              "line": 2,
              "moveIndex": 0,
              "wcs": "G54",
            },
            {
              "kind": "move",
              "line": 3,
              "moveIndex": 1,
              "wcs": "G54",
            },
            {
              "kind": "move",
              "line": 4,
              "moveIndex": 2,
              "wcs": "G54",
            },
            {
              "code": "M30",
              "kind": "program-end",
              "line": 5,
            },
          ],
          "moveLines": [
            2,
            3,
            4,
          ],
          "moveWcs": [
            "G54",
            "G54",
            "G54",
          ],
          "moves": [
            {
              "feed": undefined,
              "role": "rapid",
              "type": "rapid",
              "x": 0,
              "y": 0,
              "z": 5,
            },
            {
              "feed": 240,
              "role": "cut",
              "type": "feed",
              "x": 10,
              "y": 0,
              "z": 0,
            },
            {
              "feed": 240,
              "role": "cut",
              "type": "feed",
              "x": 20,
              "y": 0,
              "z": 0,
            },
          ],
        },
      }
    `)
  })

  it('refuses the first G94 cut without a newly commanded feed after G93', () => {
    const result = refused([
      'G21 G90',
      'G1 X10 F100',
      'G93',
      'G1 X20 F2',
      'G94',
      'G1 X30',
      'M30',
    ])

    expect(result.line).toBe(6)
    expect(result.reason).toMatch(/G93 inverse time left no units-per-minute feed.*F after G94/)
  })

  it('refuses a G53 G1 cut that bypasses the ordinary motion branch', () => {
    const result = refused([
      'G21 G90',
      'G1 X10 F100',
      'G93',
      'G1 X20 F2',
      'G94',
      'G53 G1 X30',
      'M30',
    ], { workOffsets: { G54: { x: 0, y: 0, z: 0 } } })

    expect(result.line).toBe(6)
    expect(result.reason).toMatch(/G53 G1 move has no feed rate.*G93 inverse time.*F after G94/)
  })

  it('stages a newly commanded G94 feed after the inverse-time block', () => {
    const result = program([
      'G21 G90',
      'G1 X10 F100',
      'G93',
      'G1 X20 F2',
      'G94',
      'G1 X30 F300',
      'M30',
    ])

    expect(result.moves.map((move) => move.feed)).toEqual([100, 20, 300])
    expect(result.end.feedMmMin).toBe(300)
  })

  it('refuses a canned cycle whose plunge feed is inverse time', () => {
    const result = refused([
      'G21 G90',
      'G0 Z5',
      'G1 X1 F100',
      'G93',
      'G81 X2 Z-2 R1 F2',
      'M30',
    ])

    expect(result.line).toBe(5)
    expect(result.reason).toMatch(/G81 canned cycle cannot use G93 inverse-time feed.*expanded plunges/)
  })

  it('refuses a G94 canned cycle without a newly commanded feed after G93', () => {
    const result = refused([
      'G21 G90',
      'G0 Z5',
      'G1 X1 F100',
      'G93',
      'G1 X2 F2',
      'G94 G81 X3 Z-2 R1',
      'M30',
    ])

    expect(result.line).toBe(6)
    expect(result.reason).toMatch(/G93 inverse time left no units-per-minute feed.*F after G94/)
  })

  it('writes the staged-feed desk evidence when requested', () => {
    if (process.env.WRITE_EVIDENCE !== '1') return

    const accepted = program([
      'G21 G90',
      'G1 X10 F100',
      'G93',
      'G1 X20 F2',
      'G94',
      'G1 X30 F300',
      'M30',
    ])
    const rejection = refused([
      'G21 G90',
      'G1 X10 F100',
      'G93',
      'G1 X20 F2',
      'G94',
      'G1 X30',
      'M30',
    ])

    mkdirSync('src/tests/evidence/WO-1363', { recursive: true })
    writeFileSync(
      'src/tests/evidence/WO-1363/staged-feeds.md',
      '# WO-1363 staged-feed evidence\n\n'
      + 'Generated by `inverseTimeFeedState.wo1363.test.ts` with `WRITE_EVIDENCE=1`.\n\n'
      + '| Source line | Feed mode | Command | Staged feed (mm/min) |\n'
      + '| --- | --- | --- | ---: |\n'
      + `| 2 | G94 | G1 X10 F100 | ${accepted.moves[0].feed} |\n`
      + `| 4 | G93 | G1 X20 F2 | ${accepted.moves[1].feed} |\n`
      + `| 6 | G94 | G1 X30 F300 | ${accepted.moves[2].feed} |\n\n`
      + 'The same line 6 without `F300` refuses the whole program:\n\n'
      + `> ${rejection.message}\n`,
    )
  })
})
