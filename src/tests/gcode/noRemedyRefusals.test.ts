// WO-1357 acceptance item 3, which nothing asserted until now.
//
// Operator, 2026-09-12, on his own Fusion file: "You have put so many blockers into
// using the software recently that it is unenjoyable to utilize by a user...
// It was your own bad code and blocks which caused your own issues, not bad
// gcode." The refusals that stopped him printed remedies like "Post the program
// in millimetres (G21)" and "Turn the post's spindle dwell option off and post
// again" - us handing him our problem. LIENCAM rule 11 came out of that day and
// the strings were deleted, but nothing stopped the next one being written.
//
// THE SHAPE OF THIS TEST MATTERS. It is a NEGATIVE invariant over the text the
// operator reads: no refusal may tell him to change his file, his post settings
// or his library. It never asserts that a particular implementation line
// EXISTS, so refactoring cannot break it - it fires only when someone
// reintroduces a banned remedy. That is deliberate: two orders were failed on
// 2026-09-12 by tests that sliced `Machine.cs` source text and asserted exact
// statements, which report "stale" when they mean "someone reworded a line".
//
// Both halves are needed. The behavioural half proves the refusals a real file
// actually produces are clean; the literal scan catches a remedy written into a
// string that no test happens to exercise yet.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram, type GcodeInterpretOptions } from '../../lib/gcode/interpret'
import { readGcodeProgram } from '../../lib/gcode/reader'

const GCODE_LIB = resolve(import.meta.dirname, '..', '..', 'lib', 'gcode')
const CORPUS = resolve(import.meta.dirname, '..', 'fixtures', 'foreign-gcode')

/** Remedies that hand the operator our problem. Each is the operator-facing
 *  shape, not a mechanism: "go and change what you gave us, then come back". */
const BANNED = [
  'post again',
  'post the program',
  'load the file again',
  'give the cutter',
  're-post',
  'repost',
  'renumber',
  'post it in millim',
  'post in millim',
  'turn the post',
  'change the post',
  'your post',
  'tool library to match',
]

const OPTIONS: GcodeInterpretOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
  machineUnits: 'mm',
  machineHome: { x: 0, y: 0, z: 0 },
  workOffsets: { G54: { x: 0, y: 0, z: 0 } },
}

/** Source with comments removed, so a historical note ABOUT a deleted remedy
 *  does not read as the remedy itself. Two such comments exist today. */
function stringsOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** Programs that are MEANT to refuse, so their messages are real refusals. */
const REFUSING = [
  ['cutter compensation', 'G21 G90\nG41 D1\nG1 X10 F100\nM30'],
  ['unsupported G', 'G21 G90\nG77\nM30'],
  ['unsupported M', 'G21 G90\nM19\nM30'],
  ['dwell with no P', 'G21 G90\nG4\nM30'],
  ['M6 with no T', 'G21 G90\nM6\nM30'],
  ['feed before units', 'G90\nG1 X10 F100\nM30'],
  ['G28 and G53 together', 'G21 G90\nG28 G53 Z0\nM30'],
  ['arc with no centre', 'G21 G90\nG0 X0 Y0\nG2 X10 F100\nM30'],
  ['O-word subroutine', 'G21\nO100 repeat [2]\nG0 X1\nO100 endrepeat\nM30'],
  ['G30 point not on this machine', 'G21 G90\nG30 P9\nM30'],
  ['unhomed G28', 'G21 G90 G54\nG0 X1 Y1 Z1\nG28 G91 Z0\nM30'],
] as const

describe('no G-code refusal tells the operator to change his file', () => {
  it('carries no banned remedy in any refusal a refusing program produces', () => {
    const seen: string[] = []
    for (const [name, gcode] of REFUSING) {
      // machineHome is withheld for the unhomed case, which is what makes it refuse.
      const options = name === 'unhomed G28' ? { ...OPTIONS, machineHome: undefined } : OPTIONS
      const result = interpretGcodeProgram(gcode, options)
      if (result.ok) continue
      seen.push(result.refusal.message)
      const message = result.refusal.message.toLowerCase()
      for (const banned of BANNED) {
        expect(message, `${name}: "${result.refusal.message}"`).not.toContain(banned)
      }
    }
    // A guard that exercised nothing would pass silently.
    expect(seen.length).toBeGreaterThanOrEqual(8)
  })

  it('carries no banned remedy in any refusal the real corpus produces', () => {
    const files = readdirSync(CORPUS).filter((name) => /\.(nc|ngc|tap)$/i.test(name))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(join(CORPUS, file), 'utf8')
      const result = readGcodeProgram(text, OPTIONS)
      if (result.ok) continue
      const message = result.refusal.message.toLowerCase()
      for (const banned of BANNED) {
        expect(message, `${file}: "${result.refusal.message}"`).not.toContain(banned)
      }
    }
  })

  it('has no banned remedy written into a string anywhere in src/lib/gcode', () => {
    const sources = readdirSync(GCODE_LIB).filter((name) => name.endsWith('.ts'))
    expect(sources.length).toBeGreaterThan(0)
    for (const name of sources) {
      const text = stringsOnly(readFileSync(join(GCODE_LIB, name), 'utf8')).toLowerCase()
      for (const banned of BANNED) {
        expect(text, `${name} contains the remedy "${banned}"`).not.toContain(banned)
      }
    }
  })
})
