// WO-1335 - THE INTERPRETER: posted text in, the stages the geometry route runs out.
//
// Operator, at the machine 2026-09-11: "A CNC control software that cannot load the
// most standard file format for controlling a CNC is not complete (.gcode and
// .nc)." This file tests the step that makes that true on a controller whose
// wire takes geometry and not text.
//
// WHAT IS PROVEN HERE (the pure half; `gcodeTextRoute.wo1335.test.tsx` drives
// the whole route through the rendered panel):
//   - every word LienCAM's own post emits is understood, and the two-setup
//     posted file becomes two stages in two frames with the file's own moves,
//   - a frame change and an M0 both end a stage, because both are the boundary
//     WO-1323's parts run already executes,
//   - every word this route cannot honour is REFUSED by line and word, before a
//     single move exists: inches, G91, a dwell, G43, cutter comp, a via point -
//     and the words that are NOT refused because they resolve exactly (G53) or
//     expand into the moves this route already stages (canned cycles),
//   - a second spindle speed, a tool change and an M3 with no S are refused
//     naming the lines they happened on,
//   - a refusal carries NO partial program.

import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import type { GcodeInterpretOptions } from '../../lib/gcode/interpret'
import { secondStopMessage } from '../../lib/machine/operatorMessages'

const OPTIONS: GcodeInterpretOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
  machineUnits: 'mm',
  workOffsets: {
    G54: { x: 10, y: 5, z: 2 },
    G55: { x: 110, y: 5, z: 2 },
  },
}

/** The file LienCAM's own post produces for the WO-1323 two-setup fixture,
 *  verbatim - the bytes `postProject(..., mode: 'combined')` emitted on
 *  2026-09-11 for two setups 100 mm apart in X. */
const TWO_SETUP_NC = [
  'G90 G94 G17 G21 G64',
  '( Setup 1 )',
  'G54',
  '( Op op1 )',
  'T1',
  'M3 S12000',
  'M8',
  'G0 X0 Y0 Z10',
  'G1 Z-1 F300',
  'X50 F900',
  'Y40',
  'G0 Z10',
  '( Setup 2 )',
  'G55',
  '( Op op2 )',
  'G0 X0 Y0 Z10',
  'G1 Z-1 F300',
  'X50 F900',
  'Y40',
  'M5',
  'M9',
  'G0 Z10',
  'M30',
  '',
].join('\n')

function read(text: string, overrides: Partial<GcodeInterpretOptions> = {}) {
  return interpretGcodeProgram(text, { ...OPTIONS, ...overrides })
}

function refusalOf(text: string, overrides: Partial<GcodeInterpretOptions> = {}) {
  const result = read(text, overrides)
  if (result.ok) throw new Error('expected a refusal, got a program')
  return result.refusal
}

function programOf(text: string, overrides: Partial<GcodeInterpretOptions> = {}) {
  const result = read(text, overrides)
  if (!result.ok) throw new Error(`expected a program, got: ${result.refusal.message}`)
  return result.program
}

describe("WO-1335: LienCAM's own posted file becomes the stages the geometry route runs", () => {
  it('reads the two-setup post as its sections, in two frames, with the file\'s own moves', () => {
    const program = programOf(TWO_SETUP_NC)

    // THREE STAGES, TWO FRAMES, TEN MOVES. The third stage exists because the
    // file stops its spindle on line 20 and then retracts on line 22: the
    // retract runs with the spindle OFF, which it can only do if the program
    // has an instant between the two to command the inverter in. No move is
    // added, moved or lost by that split - the count below is the file's.
    expect(program.frames).toEqual(['G54', 'G55', 'G55'])
    expect(program.moveCount).toBe(10)
    // Stage 1 is everything the file runs in G54, ending on the file's OWN
    // inter-setup retract (line 12). Nothing is appended: the lift is a line in
    // the file, not something this route invents.
    expect(program.stages[0].moves).toEqual([
      { type: 'rapid', role: 'rapid', feed: undefined, x: 0, y: 0, z: 10 },
      { type: 'feed', role: 'cut', feed: 300, x: 0, y: 0, z: -1 },
      { type: 'feed', role: 'cut', feed: 900, x: 50, y: 0, z: -1 },
      { type: 'feed', role: 'cut', feed: 900, x: 50, y: 40, z: -1 },
      { type: 'rapid', role: 'rapid', feed: undefined, x: 50, y: 40, z: 10 },
    ])
    expect(program.stages[0].moveLines).toEqual([8, 9, 10, 11, 12])
    expect(program.stages[0].ends).toEqual({ kind: 'frame', line: 14, next: 'G55' })

    // Stage 2 runs the SAME numbers in a frame 100 mm away - the file states
    // them in G55 work coordinates - and ends at the M5 on line 20.
    expect(program.stages[1].wcs).toBe('G55')
    expect(program.stages[1].spindleOn).toBe(true)
    expect(program.stages[1].moves.map((move) => ({ x: move.x, y: move.y, z: move.z }))).toEqual([
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: -1 },
      { x: 50, y: 0, z: -1 },
      { x: 50, y: 40, z: -1 },
    ])
    expect(program.stages[1].ends).toEqual({ kind: 'spindle', line: 20, on: false })

    // Stage 3 is the postamble's own retract, AFTER the M5 - and it is the
    // whole point of the split: it runs with the spindle off.
    expect(program.stages[2].wcs).toBe('G55')
    expect(program.stages[2].spindleOn).toBe(false)
    expect(program.stages[2].moveLines).toEqual([22])
    expect(program.stages[2].moves.map((move) => ({ x: move.x, y: move.y, z: move.z }))).toEqual([
      { x: 50, y: 40, z: 10 },
    ])
    expect(program.stages[2].ends).toEqual({ kind: 'end' })
  })

  it('carries the file\'s one spindle intent, its tool and the coolant it commands', () => {
    const program = programOf(TWO_SETUP_NC)
    expect(program.spindle).toEqual({ rpm: 12000, direction: 'cw', line: 6 })
    expect(program.tool).toBe(1)
    // M8 then M9: the file EXPECTED coolant, which is what the load line says.
    expect(program.coolant).toEqual({ flood: true, mist: false })
  })

  it('runs a file that names no frame of its own in the frame the session holds', () => {
    const program = programOf('G21 G90\nG0 X1 Y1 Z1\nM30\n', { sessionWcs: 'G56' })
    expect(program.frames).toEqual(['G56'])
    expect(program.stages[0].moves).toHaveLength(1)
  })

  it('reads G2/G3 with I/J and with R as arcs the geometry wire carries', () => {
    const program = programOf(
      'G21 G90\nG0 X0 Y0 Z0 F100\nG2 X10 Y10 I10 J0 F200\nG3 X0 Y0 R10\nM30\n',
    )
    expect(program.stages[0].moves.map((move) => move.type)).toEqual(['rapid', 'arc_cw', 'arc_ccw'])
    expect(program.stages[0].moves[1]).toMatchObject({ cx: 10, cy: 0, feed: 200 })
  })

  it('M0 ends a stage exactly as a frame change does - the hold WO-1323 already runs', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nM0\nG0 X2 Y2 Z2\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].ends).toEqual({ kind: 'hold', line: 3, optional: false })
    expect(program.stages[1].wcs).toBe('G54')
    expect(program.stages[1].moves).toHaveLength(1)
  })

  it('WO-2556 retains an M1 after the last motion as a terminal hold', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nM1\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].ends).toEqual({ kind: 'hold', line: 3, optional: true })
    expect(program.stages[1].moves).toEqual([])
    expect(program.holdsWithNoMotion).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// FIX ROUND, AUDIT FINDING 1: "M5 is accepted but silently discarded before
// later staged motion." It was: the interpreter's spindle case began `if
// (!item.on) break`, so an M5 produced nothing at all and the moves after it
// were staged into the same run as the moves before it - which on a machine
// with a VFD means the post-M5 retract ran with the spindle still commanded on.
// Every case below is that word, honoured.
//
// FIX ROUND, AUDIT FINDING 2: an M0/M1 with no motion YET in the stage being
// built was pushed straight onto `holdsWithNoMotion` ("no motion after it")
// without looking at whether motion followed. Where it did, the hold vanished
// and the moves ran through it.
// ---------------------------------------------------------------------------

describe('WO-1335 fix round: a spindle word with motion after it is honoured, not dropped', () => {
  it('M5 ends the stage, and the moves after it are a section that runs spindle-off', () => {
    const program = programOf('G21 G90 G54\nM3 S9000\nG0 X1 Y1 Z1\nM5\nG0 Z10\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].spindleOn).toBe(true)
    expect(program.stages[0].ends).toEqual({ kind: 'spindle', line: 4, on: false })
    expect(program.stages[1].spindleOn).toBe(false)
    expect(program.stages[1].moveLines).toEqual([5])
    // No move is gained or lost by honouring it.
    expect(program.moveCount).toBe(2)
  })

  it('M3 after an M5 re-arms the spindle for the moves behind it', () => {
    const program = programOf(
      'G21 G90 G54\nM3 S9000\nG0 X1 Y1 Z1\nM5\nG0 Z10\nM3 S9000\nG1 Z-1 F100\nM30\n',
    )
    expect(program.stages.map((stage) => stage.spindleOn)).toEqual([true, false, true])
    expect(program.stages[1].ends).toEqual({ kind: 'spindle', line: 6, on: true })
    expect(program.spindle).toEqual({ rpm: 9000, direction: 'cw', line: 2 })
  })

  it('a second M5 with the spindle already stopped changes nothing', () => {
    const program = programOf('G21 G90 G54\nM3 S9000\nG0 X1 Y1 Z1\nM5\nG0 Z10\nM5\nG0 Z20\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[1].moveLines).toEqual([5, 7])
  })

  it('a file whose M3 comes after some positioning starts with the spindle OFF', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z10\nM3 S9000\nG1 Z-1 F100\nM30\n')
    expect(program.stages.map((stage) => stage.spindleOn)).toEqual([false, true])
    expect(program.stages[0].ends).toEqual({ kind: 'spindle', line: 3, on: true })
  })

  it('an M5 the file never moves after is still the end of the program', () => {
    const program = programOf('G21 G90 G54\nM3 S9000\nG0 X1 Y1 Z1\nM5\nM30\n')
    expect(program.stages).toHaveLength(1)
    expect(program.stages[0].ends).toEqual({ kind: 'end' })
  })
})

describe('WO-1335 fix round: an M0 with motion after it holds, wherever it sits', () => {
  it('an M0 before the first move opens the first stage instead of being reported dead', () => {
    const program = programOf('G21 G90 G54\nM0\nG0 X1 Y1 Z1\nM30\n')
    expect(program.holdsWithNoMotion).toEqual([])
    expect(program.stages).toHaveLength(1)
    expect(program.stages[0].heldBefore).toEqual({ line: 2, optional: false })
    expect(program.stages[0].moves).toHaveLength(1)
  })

  it('an M0 between a frame change and its first move holds at that boundary', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nG55\nM1\nG0 X2 Y2 Z2\nM30\n')
    expect(program.holdsWithNoMotion).toEqual([])
    expect(program.stages).toHaveLength(2)
    expect(program.stages[1].wcs).toBe('G55')
    expect(program.stages[1].heldBefore).toEqual({ line: 4, optional: true })
  })

  it('an M0 between an M5 and the next move holds at that boundary', () => {
    const program = programOf('G21 G90 G54\nM3 S9000\nG0 X1 Y1 Z1\nM5\nM0\nG0 Z10\nM30\n')
    expect(program.holdsWithNoMotion).toEqual([])
    expect(program.stages).toHaveLength(2)
    expect(program.stages[1].heldBefore).toEqual({ line: 5, optional: false })
    expect(program.stages[1].spindleOn).toBe(false)
  })

  it('WO-2556 an M0 after a frame change still holds at the end', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nG55\nM0\nM30\n')
    expect(program.holdsWithNoMotion).toEqual([])
    expect(program.stages).toHaveLength(2)
    expect(program.stages[1].heldBefore).toEqual({ line: 4, optional: false })
    expect(program.stages[0].ends).toEqual({ kind: 'frame', line: 3, next: 'G55' })
  })

  it('refuses two stops with nothing moving between them rather than honouring one', () => {
    const refusal = refusalOf('G21 G90 G54\nG0 X1 Y1 Z1\nM0\nM0\nG0 Z10\nM30\n')
    expect(refusal.line).toBe(4)
    expect(refusal.message).toContain(secondStopMessage(0, 3))
    expect(refusal.message).toContain('line 3')
  })
})

describe('WO-1335: every word this route cannot honour is refused by line and word', () => {
  it('converts an inch file to canonical millimetres and says so', () => {
    const program = programOf('G90\nG20\nG0 X1 Y1 Z1\nM30\n')
    expect(program.stages[0].moves[0]).toMatchObject({ x: 25.4, y: 25.4, z: 25.4 })
    expect(program.accepted.find((entry) => entry.word === 'G20')?.note).toContain('converted to millimetres')
  })

  // G91 IS CONVERTED, NOT REFUSED (architect re-scope, 2026-09-11T03:23Z):
  // "Two third-party Fusion files and one of our own die on this refusal for no
  // reason." The reader already resolved every incremental block against the
  // position before it, so what this route stages is absolute BY CONSTRUCTION.
  it('converts incremental distance mode into the absolute moves it means', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nG91\nG0 X1\nX2\nG90\nG0 X10\nM30\n')
    expect(program.stages[0].moves.map((move) => move.x)).toEqual([1, 2, 4, 10])
    // Y and Z carry untouched across the incremental blocks - an incremental
    // word that named no axis moved none.
    expect(program.stages[0].moves.every((move) => move.y === 1 && move.z === 1)).toBe(true)
  })

  // G53 IS NOT ON THAT LIST, AND THE FIRST ROUND WAS WRONG TO PUT IT THERE. A
  // machine-frame block resolves against the controller's own reported offset,
  // and refusing it turned Operator's own Fusion-posted file away at its first line
  // of motion (`G53 G0 Z128.`). Round trip: work = machine - offset here; the
  // bridge adds offsets[activeWcs] back when it stages the move.
  it('resolves a machine-frame block against the reported offset instead of refusing it', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nG53 G0 X20 Y10 Z30\nM30\n')
    expect(program.stages[0].moves.at(-1)).toMatchObject({ x: 10, y: 5, z: 28 })
  })

  it('refuses a machine-frame block whose frame the controller has not reported', () => {
    const refusal = refusalOf('G21 G90 G56\nG0 X1 Y1 Z1\nG53 G0 Z30\nM30\n')
    expect(refusal.line).toBe(3)
    expect(refusal.message).toContain('G56 offset is unknown')
  })

  it('loads a dwell and preserves its duration in the program report', () => {
    const program = programOf('G21 G90 G54\nM3 S1000\nG4 P500\nG0 X1 Y1 Z1\nM30\n')
    expect(program.accepted).toContainEqual({
      word: 'G4 P (0.5s)',
      line: 3,
      note: 'dwell will execute on the controller for 0.5 seconds',
    })
    expect(program.stages[0].dwells).toEqual([{ line: 3, seconds: 0.5, afterMove: 0 }])
  })

  it('keeps a dwell after the last stage-closing word in the resulting machine state', () => {
    const program = programOf('G21 G90 G54\nM3 S1000\nG1 X10 F300\nM5\nG4 P500\nM30\n')

    expect(program.stages).toHaveLength(2)
    expect(program.stages[0]).toMatchObject({
      spindleOn: true,
      dwells: [],
      ends: { kind: 'spindle', on: false },
    })
    expect(program.stages[1]).toMatchObject({
      moves: [],
      spindleOn: false,
      dwells: [{ line: 5, seconds: 0.5, afterMove: 0 }],
      ends: { kind: 'end' },
    })
  })

  // NOR IS A CANNED CYCLE. It needs no new wire vocabulary - the reader expands
  // it into the rapids and plunges that drill the hole - so refusing it would
  // have turned away any LienCAM-posted program with a drilling operation.
  it('expands a canned cycle into the moves that drill the hole', () => {
    const program = programOf('G21 G90 G54\nG0 X0 Y0 Z5 F100\nG81 X1 Y1 Z-2 R1\nM30\n')
    const cycle = program.stages[0].moves.slice(1)
    expect(cycle.map((move) => ({ type: move.type, z: move.z }))).toEqual([
      { type: 'rapid', z: 5 },
      { type: 'rapid', z: 1 },
      { type: 'feed', z: -2 },
      { type: 'rapid', z: 5 },
    ])
    // Every expanded move belongs to the line that commanded the cycle.
    expect(program.stages[0].moveLines.slice(1)).toEqual([3, 3, 3, 3])
  })

  it('refuses a word outside the shared vocabulary, naming it', () => {
    const refusal = refusalOf('G21 G90 G54\nG33 X1\nM30\n')
    expect(refusal.line).toBe(2)
    expect(refusal.message).toContain('G33')
  })

  // TWO SPEEDS IN ONE FILE ARE ALLOWED (architect re-scope): "the up-to-speed
  // gate re-arms on every release, so the one-intent rule that belongs to the
  // multi-setup toolpath route must not leak into the file route."
  it('carries a second spindle speed as its own section, at the line that states it', () => {
    const program = programOf('G21 G90 G54\nM3 S12000\nG0 X1 Y1 Z1\nM3 S8000\nG0 X2\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].spindle).toMatchObject({ rpm: 12000, direction: 'cw' })
    expect(program.stages[0].ends).toEqual({ kind: 'spindle', line: 4, on: true })
    expect(program.stages[1].spindle).toMatchObject({ rpm: 8000, direction: 'cw' })
    expect(program.spindleSpeeds.map((entry) => entry.rpm)).toEqual([12000, 8000])
    // NO MOVE IS ADDED OR LOST BY THE SPLIT - the section boundary is an
    // instant, not motion.
    expect(program.moveCount).toBe(2)
  })

  it('carries a direction reversal on the same speed as its own section', () => {
    const program = programOf('G21 G90 G54\nM3 S9000\nG0 X1 Y1 Z1\nM4 S9000\nG0 X2\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].spindle).toMatchObject({ direction: 'cw' })
    expect(program.stages[1].spindle).toMatchObject({ direction: 'ccw', rpm: 9000 })
  })

  it('does not split a section when the same M3 speed is restated', () => {
    const program = programOf('G21 G90 G54\nM3 S12000\nG0 X1 Y1 Z1\nM3 S12000\nG0 X2\nM30\n')
    expect(program.stages).toHaveLength(1)
    expect(program.spindleSpeeds).toHaveLength(1)
  })

  it('refuses M3 with no S rather than inventing a speed', () => {
    const refusal = refusalOf('G21 G90 G54\nM3\nG0 X1 Y1 Z1\nM30\n')
    expect(refusal.line).toBe(2)
    expect(refusal.message).toContain('never invented')
  })

  // A TOOL CHANGE IS A BOUNDARY, NOT A REFUSAL (architect re-scope): "Until
  // WO-1330 lands, a file with a tool change may LOAD and hold at the change
  // with the console naming both tools; it must not be refused at the door."
  it('ends a section at a tool change, naming both tools', () => {
    const program = programOf('G21 G90 G54\nT1\nG0 X1 Y1 Z1\nT2 M6\nG0 X2\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].ends).toEqual({ kind: 'tool-change', line: 4, from: 1, to: 2 })
    expect(program.stages[0].tool).toBe(1)
    expect(program.stages[1].tool).toBe(2)
    expect(program.tools).toEqual([1, 2])
    expect(program.moveCount).toBe(2)
  })

  // THE ONE REFUSAL LEFT AT A TOOL CHANGE. Every UCCNC post emits M5 before M6,
  // and nobody fits a cutter into a turning spindle - so a file that asks for
  // one is refused rather than held at a boundary this route would then have to
  // stop the spindle at on its own authority.
  it('refuses a tool change with the spindle still commanded on', () => {
    const refusal = refusalOf('G21 G90 G54\nT1\nM3 S9000\nG0 X1 Y1 Z1\nT2 M6\nG0 X2\nM30\n')
    expect(refusal.line).toBe(5)
    expect(refusal.message).toContain('T1')
    expect(refusal.message).toContain('T2')
    expect(refusal.message).toContain('M5')
  })

  it('refuses a file that commands no motion at all', () => {
    const refusal = refusalOf('G21 G90 G54\nM3 S1000\nM5\nM30\n')
    expect(refusal.message).toContain('no motion at all')
  })

  it('treats end of text as program end and says so', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\n')
    expect(program.accepted.find((entry) => entry.word === 'EOF')?.note).toContain('end of program')
  })
})

// ---------------------------------------------------------------------------
// G43 H / G49 - RETIRED REFUSALS, 2026-09-12. Operator's own Fusion file, which
// UCCNC runs without complaint, died at line 22 on `G43 H19`.
//
// The block that stopped it was three stacked refusals - no tool library, no
// tool carrying H's number, H naming a tool other than the fitted one - in
// front of a resolver whose ONLY successful answer was `shiftMm: 0`. Every
// path through it returned zero. The remedy the app printed asked Operator to
// renumber his Tool Library to match Fusion's tool numbering so we could hand
// back the zero we already had.
//
// WO-1677: the H is resolved against the machine's tool table, which only the
// session holds - it passes `toolLengthMm` and the length is folded into every
// Z the H governs. With no table passed (these tests) or an unmeasured row the
// length is zero and the file's own Z stages as written, which is what UCCNC
// applies for an unmeasured row. The refusals guarded a constant, so they stay
// gone.
// ---------------------------------------------------------------------------

describe('G43 H stages the file own numbers and never refuses', () => {
  it("loads Operator's own header shape - T19 M6, G43 H19 - with no tool library at all", () => {
    const program = programOf('G21 G90 G54\nT19 M6\nG43 H19\nG0 X1 Y1 Z10\nM30\n')
    expect(program.stages[0].moves.map((move) => move.z)).toEqual([10])
  })

  it('stages absolute Z as the file states it - the controller applies the offset', () => {
    const program = programOf(
      'G21 G90 G54\nT19 M6\nG43 H19\nG0 X1 Y1 Z30\nG1 Z-1 F100\nM30\n',
    )
    expect(program.stages[0].moves.map((move) => move.z)).toEqual([30, -1])
  })

  it('accepts an H no tool library could resolve - the session answers for the table', () => {
    const program = programOf('G21 G90 G54\nT4 M6\nG43 H4\nG0 X1 Y1 Z10\nM30\n')
    expect(program.stages[0].moves.map((move) => move.z)).toEqual([10])
  })

  it('accepts an H naming a tool other than the one fitted, staging the file own Z', () => {
    // `T1 M6` then `G43 H2`. Which tool H names is the machine table's
    // business at run time, not the reader's at load. This used to refuse.
    const program = programOf(
      'G21 G90 G54\nT1 M6\nG43 H2\nG0 X1 Y1 Z10\nG1 Z-1 F100\nM30\n',
    )
    expect(program.stages[0].moves.map((move) => move.z)).toEqual([10, -1])
  })

  it('accepts an H naming a tool a standalone T merely preselected', () => {
    const program = programOf(
      'G21 G90 G54\nT1 M6\nG0 X1 Y1 Z10\nT2\nG43 H2\nG1 Z-1 F100\nM30\n',
    )
    expect(program.stages[0].moves.map((move) => move.z)).toEqual([10, -1])
  })

  it('accepts a block that fits and offsets at once - T2 M6 G43 H2', () => {
    const program = programOf(
      'G21 G90 G54\nT1 M6\nG0 X1 Y1 Z10\nT2 M6 G43 H2\nG1 Z-1 F100\nM30\n',
    )
    expect(program.stages.at(-1)!.moves.map((move) => move.z)).toEqual([-1])
  })

  it('still refuses G43 with no H, or a non-positive H - that is a malformed block', () => {
    expect(refusalOf('G21 G90 G54\nT1 M6\nG43\nG0 Z10\nM30\n').line).toBe(3)
    expect(refusalOf('G21 G90 G54\nT1 M6\nG43 H0\nG0 Z10\nM30\n').line).toBe(3)
  })

  it('G49 cancels the offset the controller holds, staging the file own Z either way', () => {
    const program = programOf(
      'G21 G90 G54\nT1 M6\nG43 H1\nG0 X1 Y1 Z10\nG49\nG0 Z20\nM30\n',
    )
    expect(program.stages[0].moves.map((move) => move.z)).toEqual([10, 20])
  })

  it('a G53 machine-frame Z after G43 is unaffected by the offset', () => {
    const program = programOf(
      'G21 G90 G54\nT19 M6\nG43 H19\nG0 X1 Y1 Z10\nG53 G0 Z30\nM30\n',
    )
    expect(program.stages[0].moves.at(-1)).toMatchObject({ z: 28 })
  })
})

describe('WO-1335 re-scope: a macro call holds and names itself', () => {
  it('ends a section at a user macro, carrying its number', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nM2001\nG0 X2\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].ends).toEqual({ kind: 'macro', line: 3, code: 2001 })
    expect(program.macros).toEqual([{ line: 3, code: 2001 }])
    expect(program.moveCount).toBe(2)
  })

  it('carries a macro stated before the first move as that section`s opening hold', () => {
    const program = programOf('G21 G90 G54\nM2001\nG0 X1 Y1 Z1\nM30\n')
    expect(program.stages[0].macroBefore).toEqual({ line: 2, code: 2001 })
  })

  it('still refuses an M-code below the user-macro range, which is a real word', () => {
    // M62 is a digital output and M19 is a spindle orient - words with meanings
    // this route does not carry. Only UCCNC's user macros (M1000 up) hold.
    const refusal = refusalOf('G21 G90 G54\nG0 X1 Y1 Z1\nM62 P1\nG0 X2\nM30\n')
    expect(refusal.line).toBe(3)
    expect(refusal.message).toContain('M62')
  })
})

describe('WO-1335 re-scope: words that change nothing are accepted and said once', () => {
  it('reads G64 and G94 and reports each once, with the line it fell on', () => {
    const program = programOf('G21 G90 G94 G64 G54\nG0 X1 Y1 Z1\nG64\nG0 X2\nM30\n')
    expect(program.accepted.map((entry) => entry.word)).toEqual(['G64', 'G94'])
    expect(program.accepted.find((entry) => entry.word === 'G64')?.line).toBe(1)
    // AND THEY CHANGE NOTHING: the restated G64 on line 3 does not split a
    // section the way a spindle or coolant word does.
    expect(program.stages).toHaveLength(1)
  })

  it('ends a section at a coolant change so the word falls due with its own moves', () => {
    const program = programOf('G21 G90 G54\nM8\nG0 X1 Y1 Z1\nM9\nG0 X2\nM30\n')
    expect(program.stages).toHaveLength(2)
    expect(program.stages[0].coolant).toEqual({ flood: true, mist: false })
    expect(program.stages[0].ends).toEqual({ kind: 'coolant', line: 4, flood: false, mist: false })
    expect(program.stages[1].coolant).toEqual({ flood: false, mist: false })
    expect(program.coolant).toEqual({ flood: true, mist: false })
  })
})

// ---------------------------------------------------------------------------
// OPERATOR'S ACCEPTANCE, 2026-09-11T02:00Z, item 1: "every G-code word the UCCNC
// post processors emit ... is translated into exactly what goes through the
// bridge, and the evidence is a table: every supported word, its translation,
// and the test that pins it ... There can be no doubt that it has it right."
//
// THIS IS THAT TABLE, AND EVERY SENTENCE IN IT IS ASSERTED AGAINST WHAT THE
// ROUTE WAS OBSERVED TO DO.
//
// FIX ROUND 3 - THE AUDIT'S FINDING, WHICH WAS THE IMPORTANT ONE. Round 2's
// generator copied a row's free-text `translation` into the artifact without
// asserting it, so "the declared executable evidence can stay green while
// making a false wire-level claim" - and it did: the coolant row described a
// command the route did not send. A table nobody can tell from a table of
// wishes is not evidence.
//
// So a row no longer carries prose. It carries CLAIMS, and a claim is a
// sentence bolted to the observation that proves it - the staged wire calls,
// the console line the operator read, or the refusal. `WordObservation` holds
// NOTHING ELSE: there is no interpreter object to reach for, so a sentence
// that cannot be proven from observed behaviour cannot be written at all.
// `gcodeTextRoute.wo1335.test.tsx` drives every row below through the rendered
// panel onto a real controller, proves every claim, and only then renders the
// artifact - from the claims it just proved, and never from the row.
// ---------------------------------------------------------------------------

/** One move exactly as the bridge receives it. */
export interface WireStagedMove {
  kind: string
  to?: { x?: number; y?: number; z: number }
  feedMmMin?: number
  rapid?: true
  centre?: { x: number; y: number; z: number }
  clockwise?: boolean
  seconds?: number
}

/** WHAT THE ROUTE DID WITH ONE FILE, and nothing else. */
export interface WordObservation {
  /** The load verdict, as the operator reads it. */
  readiness: { ready: boolean; reason: string }
  /** Every move that reached the bridge, in order, across every frame. */
  staged: WireStagedMove[]
  /** Every `selectWcs(...)` / `loadMoves(n)` call, in the order the wire
   *  carried them. */
  calls: string[]
  /** Everything the operator read in the console. */
  console: string
  /** How many times the program HELD and waited for the operator's CYCLE
   *  START before it would run on. */
  holds: number
}

/** One sentence of a row's translation, and the observation that proves it. */
export interface WordClaim {
  /** The sentence the table prints. */
  says: string
  /** WHICH OBSERVED THING PROVES IT, printed in the table beside the sentence
   *  so a reader can see that no row rests on this software's opinion of
   *  itself. */
  from: 'wire' | 'console' | 'refusal'
  /** Throws when the sentence is not true of what the route did. */
  proves: (seen: WordObservation) => void
}

const onWire = (says: string, proves: WordClaim['proves']): WordClaim =>
  ({ says, from: 'wire', proves })
const inConsole = (says: string, proves: WordClaim['proves']): WordClaim =>
  ({ says, from: 'console', proves })
const asRefusal = (says: string, proves: WordClaim['proves']): WordClaim =>
  ({ says, from: 'refusal', proves })

/** The refusal a row declares, named at its own line, with nothing staged. */
const refusedAt = (line: number, naming: string, says: string): WordClaim =>
  asRefusal(says, (seen) => {
    expect(seen.readiness.ready).toBe(false)
    expect(seen.readiness.reason).toContain(`Line ${line}`)
    expect(seen.readiness.reason).toContain(naming)
    expect(seen.staged).toEqual([])
  })

export interface WordRow {
  word: string
  meaning: string
  /** What this route does with it. Every one is proven before the table that
   *  prints it is written. */
  claims: WordClaim[]
  /** A whole program exercising the word. */
  program: string
  /** The line the file is refused at, or null when it loads. */
  refusedAtLine: number | null
  /** Every staged move the program produces, in order, when it loads - read
   *  back off the BRIDGE by the route test, not off the interpreter. */
  staged?: { x: number; y: number; z: number }[]
  /** Extra checks a column cannot carry, against the interpreter itself. */
  check?: (program: ReturnType<typeof programOf>) => void
  /** What the SESSION brings to this word - the tool library, for `G43 H`. */
  options?: Partial<GcodeInterpretOptions>
  /** WHAT THE MACHINE RECORD MUST STATE for this row to mean what it says.
   *  Coolant is the one word whose translation DEPENDS on the record, so the
   *  two answers are two rows against two fixtures rather than one row whose
   *  sentence is proven against whichever machine happened to be connected. */
  statesCoolant?: boolean
}

const PRELUDE = 'G21 G90 G54\n'
const AT_ORIGIN = 'G0 X0 Y0 Z10\n'

export const WORD_TABLE: WordRow[] = [
  {
    word: 'G0',
    meaning: 'rapid positioning',
    claims: [
      onWire(
        "a staged line marked `rapid`, carrying the machine's declared rapid rate as its feed",
        (seen) => {
          expect(seen.staged).toHaveLength(1)
          expect(seen.staged[0].kind).toBe('line')
          expect(seen.staged[0].rapid).toBe(true)
          expect(seen.staged[0].feedMmMin).toBe(5000)
        },
      ),
    ],
    program: PRELUDE + 'G0 X1 Y2 Z3\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 1, y: 2, z: 3 }],
    check: (p) => { expect(p.stages[0].moves[0].type).toBe('rapid') },
  },
  {
    word: 'G1 / F',
    meaning: 'feed move at the modal feed',
    claims: [
      onWire('a staged line carrying the modal F as its feed, and never marked rapid', (seen) => {
        expect(seen.staged.map((move) => move.feedMmMin)).toEqual([5000, 300, 300])
        expect(seen.staged.slice(1).every((move) => move.rapid === undefined)).toBe(true)
      }),
    ],
    program: PRELUDE + AT_ORIGIN + 'G1 Z-1 F300\nX50\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }, { x: 50, y: 0, z: -1 }],
    check: (p) => { expect(p.stages[0].moves[2].feed).toBe(300) },
  },
  {
    word: 'G2 / G3 with I J',
    meaning: 'arc, centre given as an offset from the start',
    claims: [
      onWire(
        'a staged ARC STEP carrying its centre and its direction - never linearised into chords',
        (seen) => {
          expect(seen.staged.map((move) => move.kind)).toEqual(['line', 'arc', 'arc'])
          expect(seen.staged[1].centre).toMatchObject({ x: 10, y: 0 })
          expect(seen.staged[1].clockwise).toBe(true)
          expect(seen.staged[2].clockwise).toBe(false)
        },
      ),
    ],
    program: PRELUDE + 'G0 X0 Y0 Z0\nG2 X10 Y10 I10 J0 F200\nG3 X0 Y0 I0 J-10\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }],
    check: (p) => {
      expect(p.stages[0].moves.map((m) => m.type)).toEqual(['rapid', 'arc_cw', 'arc_ccw'])
      expect(p.stages[0].moves[1]).toMatchObject({ cx: 10, cy: 0 })
    },
  },
  {
    word: 'G2 / G3 with R',
    meaning: 'arc, centre given as a radius',
    claims: [
      onWire('a staged arc whose centre is resolved from the radius, the MINOR arc', (seen) => {
        expect(seen.staged[1].kind).toBe('arc')
        const centre = seen.staged[1].centre!
        // Equidistant from both ends, by the radius the file stated.
        expect(Math.hypot(centre.x, centre.y)).toBeCloseTo(10, 6)
        expect(Math.hypot(centre.x - 10, centre.y - 10)).toBeCloseTo(10, 6)
      }),
    ],
    program: PRELUDE + 'G0 X0 Y0 Z0\nG2 X10 Y10 R10 F200\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }],
  },
  {
    word: 'G2 / G3 with a negative R',
    meaning: 'the greater-than-180-degree arc of a radius',
    claims: [
      refusedAt(
        3,
        'negative R',
        'REFUSED by line - the major arc of an R is not carried by this route',
      ),
    ],
    program: PRELUDE + 'G0 X0 Y0 Z0\nG2 X10 Y0 R-10 F200\nM30\n',
    refusedAtLine: 3,
  },
  {
    word: 'G4',
    meaning: 'dwell',
    claims: [
      onWire('accepted and retained with its duration in the interpreted program', (seen) => {
        expect(seen.readiness.ready).toBe(true)
        expect(seen.staged[0]).toMatchObject({ kind: 'dwell', seconds: 0.5 })
      }),
    ],
    program: PRELUDE + 'G4 P500\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
    check: (p) => { expect(p.accepted.some((entry) => entry.word.startsWith('G4 P'))).toBe(true) },
  },
  {
    word: 'G17',
    meaning: 'XY plane',
    claims: [
      onWire('accepted; it adds no staged step - the only plane this wire carries', (seen) => {
        expect(seen.staged).toHaveLength(1)
        expect(seen.readiness.ready).toBe(true)
      }),
    ],
    program: 'G21 G90 G17 G54\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G18 / G19',
    meaning: 'XZ / YZ plane',
    claims: [
      onWire('accepted; non-XY arcs are linearised before staging', (seen) => {
        expect(seen.readiness.ready).toBe(true)
      }),
    ],
    program: 'G21 G90 G54\nG18\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G20',
    meaning: 'inch units',
    claims: [
      onWire('converted to canonical millimetres', (seen) => {
        expect(seen.staged.map((move) => move.to)).toEqual([{ x: 25.4, y: 25.4, z: 25.4 }])
      }),
    ],
    program: 'G90 G20 G54\nG0 X1 Y1 Z1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 25.4, y: 25.4, z: 25.4 }],
  },
  {
    word: 'G21',
    meaning: 'millimetre units',
    claims: [
      onWire('accepted; it adds no staged step - the frame this product works in', (seen) => {
        expect(seen.staged).toHaveLength(1)
        expect(seen.readiness.ready).toBe(true)
      }),
    ],
    program: PRELUDE + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G28',
    meaning: 'rapid to the machine home position',
    claims: [
      onWire(
        'ACCEPTED, homed or not (WO-1644) - it rapids to the home position the machine definition '
        + 'states, machine zero when it states none, as UCCNC and LinuxCNC do',
        (seen) => {
          expect(seen.readiness.ready).toBe(true)
          expect(seen.staged.length).toBeGreaterThanOrEqual(1)
        },
      ),
    ],
    program: PRELUDE + AT_ORIGIN + 'G28\nM30\n',
    refusedAtLine: null,
    check: (p) => { expect(p.moveCount).toBe(4) },
  },
  {
    word: 'G30',
    meaning: 'return through a stored reference point',
    claims: [
      refusedAt(3, 'G30', 'REFUSED when the machine definition stores no reference point to return to'),
    ],
    program: PRELUDE + AT_ORIGIN + 'G30\nM30\n',
    refusedAtLine: 3,
  },
  {
    word: 'G40',
    meaning: 'cutter compensation off',
    claims: [
      onWire('accepted; it adds no staged step', (seen) => {
        expect(seen.staged).toHaveLength(1)
        expect(seen.readiness.ready).toBe(true)
      }),
    ],
    program: 'G21 G90 G40 G54\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G41 / G42',
    meaning: 'cutter compensation on',
    claims: [
      refusedAt(
        2,
        'G41',
        'REFUSED - it changes the commanded path and nothing here can reproduce it',
      ),
    ],
    program: PRELUDE + 'G41\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: 2,
  },
  {
    word: 'G43 H',
    meaning: 'tool length offset, indexed by tool number',
    claims: [
      onWire(
        "ACCEPTED, staging the file's own Z10 as written: tool 3 is unmeasured on this "
        + "machine's tool table, so the length folded into Z is zero, as UCCNC's table "
        + 'answers for an unmeasured row (WO-1677)',
        (seen) => { expect(seen.staged.map((move) => move.to?.z)).toEqual([10]) },
      ),
      inConsole('and the load line says what the machine table resolved for this H', (seen) => {
        expect(seen.console).toContain('G43 H3 on line 3 shifts Z by zero')
        expect(seen.console).toContain('tool 3 has no measured length on this machine')
      }),
    ],
    program: PRELUDE + 'T3 M6\nG43 H3\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
    check: (p) => { expect(p.toolLengthOffsets).toEqual([{ line: 3, h: 3 }]) },
  },
  {
    word: 'G43 H (a number no tool library holds)',
    meaning: 'tool length offset naming a tool nothing here knows',
    claims: [
      onWire(
        "ACCEPTED, staging the file's own numbers. The H indexes the MACHINE's tool table at "
        + "run time, not the project's tool library at load - a row with no measured length "
        + "applies zero, exactly as the operator's controller answers. This used to refuse, and "
        + "it is what stopped Operator's own Fusion file.",
        (seen) => { expect(seen.staged.map((move) => move.to?.z)).toEqual([10]) },
      ),
    ],
    program: PRELUDE + 'T9 M6\nG43 H9\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G43 H (not the tool in the spindle)',
    meaning: 'tool length offset naming a tool that is not fitted',
    claims: [
      onWire(
        'ACCEPTED, staging the file\'s own numbers. Which tool H names is the machine table\'s '
        + 'business when the program runs - UCCNC applies whatever row H indexes, and so does '
        + 'the session (WO-1677). Refusing it protected nothing.',
        (seen) => { expect(seen.staged.map((move) => move.to?.z)).toEqual([10]) },
      ),
    ],
    program: PRELUDE + 'T1 M6\nG43 H3\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G43 H (after a standalone T preselect)',
    meaning: 'a T word with no M6 preselects a cutter and fits nothing',
    claims: [
      onWire(
        'H resolves against the tool M6 FITTED, never against a later preselect: after `T1 M6` a '
        + 'standalone `T2` leaves T1 in the spindle, so `G43 H1` is the word that loads and every '
        + "Z stages at the file's own number",
        (seen) => { expect(seen.staged.map((move) => move.to?.z)).toEqual([10, 10]) },
      ),
      inConsole('and the program still runs one tool - a preselect fits nothing', (seen) => {
        expect(seen.console).toContain('It runs one tool')
      }),
    ],
    program: PRELUDE + 'T1 M6\n' + AT_ORIGIN + 'T2\nG43 H1\nG0 Z10\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }],
    check: (p) => {
      expect(p.toolLengthOffsets).toEqual([{ line: 5, h: 1 }])
      expect(p.tools).toEqual([1])
    },
  },
  {
    word: 'G49',
    meaning: 'cancel tool length offset',
    claims: [
      onWire(
        'accepted, and the absolute Z below it is staged at what it says - which is what the Z '
        + "above it staged at too, because the reader stages the file's own numbers and the "
        + 'controller owns the offset the G49 cancels',
        (seen) => { expect(seen.staged.map((move) => move.to?.z)).toEqual([10, 10]) },
      ),
    ],
    program: PRELUDE + 'T3 M6\nG43 H3\n' + AT_ORIGIN + 'G49\nG0 Z10\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G53',
    meaning: 'one block in machine coordinates',
    claims: [
      onWire(
        "resolved into the active frame against the CONTROLLER'S OWN reported offset "
        + '(work = machine - offset): with G54 at machine X10 Y5 Z2, `G53 G0 X20 Y10 Z30` is '
        + 'staged as work X10 Y5 Z28, which is the same point',
        (seen) => {
          expect(seen.staged.at(-1)!.to).toMatchObject({ x: 10, y: 5, z: 28 })
        },
      ),
    ],
    program: PRELUDE + AT_ORIGIN + 'G53 G0 X20 Y10 Z30\nM30\n',
    refusedAtLine: null,
    // G54 sits at machine (10, 5, 2) in these options.
    staged: [{ x: 0, y: 0, z: 10 }, { x: 10, y: 5, z: 28 }],
  },
  {
    word: 'G54 - G59',
    meaning: 'work coordinate system',
    claims: [
      onWire(
        'the frame of the stage that follows it: the controller is asked for it and must CONFIRM '
        + 'it before any of that stage is staged - so the wire carries select, stage, select, stage '
        + 'and never a move ahead of its frame',
        (seen) => {
          expect(seen.calls).toEqual([
            'selectWcs(G54)', 'loadMoves(1)', 'selectWcs(G55)', 'loadMoves(1)',
          ])
        },
      ),
      inConsole('and the program HOLDS at the change until the operator presses CYCLE START', (seen) => {
        expect(seen.holds).toBe(1)
      }),
    ],
    program: PRELUDE + AT_ORIGIN + 'G55\nG0 X1 Y1 Z1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 1, y: 1, z: 1 }],
    check: (p) => { expect(p.frames).toEqual(['G54', 'G55']) },
  },
  {
    word: 'G61 / G64',
    meaning: 'exact stop / continuous path control',
    claims: [
      onWire("accepted; it adds no staged step - the board's own path mode is not ours to set", (seen) => {
        expect(seen.staged).toHaveLength(1)
      }),
      inConsole('and the load line says ONCE that it was read and changes nothing here', (seen) => {
        expect(seen.console).toContain('G64 (path blending')
      }),
    ],
    program: 'G21 G90 G64 G54\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G80',
    meaning: 'cancel canned cycle',
    claims: [
      onWire(
        'ends the cycle; the next coordinate block needs its own motion word, and the move after '
        + 'G80 is staged as the plain rapid it states',
        (seen) => {
          expect(seen.staged.at(-1)).toMatchObject({ kind: 'line', rapid: true })
          expect(seen.staged.at(-1)!.to?.x).toBe(5)
        },
      ),
    ],
    program: PRELUDE + 'G0 X0 Y0 Z5 F100\nG81 X1 Y1 Z-2 R1\nG80\nG0 X5\nM30\n',
    refusedAtLine: null,
    check: (p) => { expect(p.stages[0].moves.at(-1)).toMatchObject({ x: 5, type: 'rapid' }) },
  },
  {
    word: 'G81 / G82 / G83',
    meaning: 'drill / dwell-drill / peck-drill canned cycle',
    claims: [
      onWire(
        'EXPANDED into the plain rapids and plunges that drill the hole - no new wire vocabulary, '
        + 'so a drilled hole reaches the board as the moves that drill it',
        (seen) => {
          expect(seen.staged.length).toBeGreaterThan(2)
          expect(seen.staged.every((move) => move.kind === 'line')).toBe(true)
          expect(seen.staged.some((move) => move.to?.z === -2 && move.rapid === undefined)).toBe(true)
        },
      ),
    ],
    program: PRELUDE + 'G0 X0 Y0 Z5 F100\nG81 X1 Y1 Z-2 R1\nM30\n',
    refusedAtLine: null,
    check: (p) => {
      expect(p.stages[0].moves.length).toBeGreaterThan(2)
      expect(p.stages[0].moves.some((m) => m.type === 'feed' && m.z === -2)).toBe(true)
    },
  },
  {
    word: 'G90',
    meaning: 'absolute distance mode',
    claims: [
      onWire('required - every staged move is an absolute position in its frame', (seen) => {
        expect(seen.staged.map((move) => move.to)).toEqual([{ x: 0, y: 0, z: 10 }])
      }),
    ],
    program: PRELUDE + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G91',
    meaning: 'incremental distance mode',
    claims: [
      onWire(
        'CONVERTED - each incremental block is resolved against the position before it, so what '
        + 'reaches the board is absolute by construction, which is what a program executed by '
        + 'move id needs',
        (seen) => {
          expect(seen.staged.map((move) => move.to?.x)).toEqual([0, 1, 3, 10])
        },
      ),
    ],
    program: PRELUDE + AT_ORIGIN + 'G91\nG0 X1\nX2\nG90\nG0 X10\nM30\n',
    refusedAtLine: null,
    staged: [
      { x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 }, { x: 3, y: 0, z: 10 }, { x: 10, y: 0, z: 10 },
    ],
  },
  {
    word: 'G94',
    meaning: 'feed per minute',
    claims: [
      onWire('accepted; it adds no staged step - the only feed mode this product posts', (seen) => {
        expect(seen.staged).toHaveLength(1)
      }),
      inConsole('and the load line says ONCE that it was read', (seen) => {
        expect(seen.console).toContain('G94 (feed per minute')
      }),
    ],
    program: 'G21 G90 G94 G54\n' + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'G98 / G99',
    meaning: 'canned-cycle return to initial / R plane',
    claims: [
      onWire('the height the expanded cycle returns to between holes - under G99, the R plane', (seen) => {
        expect(seen.staged.at(-1)!.to?.z).toBe(1)
      }),
    ],
    program: PRELUDE + 'G0 X0 Y0 Z5 F100\nG99\nG81 X1 Y1 Z-2 R1\nM30\n',
    refusedAtLine: null,
    check: (p) => { expect(p.stages[0].moves.at(-1)!.z).toBe(1) },
  },
  {
    word: 'M0 / M1',
    meaning: 'program stop / optional stop',
    claims: [
      inConsole(
        'ENDS A STAGE: the program HOLDS, names the line it stopped at, and CYCLE START runs the '
        + 'rest - the same hold the two-setup toolpath program already uses',
        (seen) => {
          expect(seen.holds).toBe(1)
          expect(seen.console).toContain('line 3')
        },
      ),
      onWire(
        'and the moves after it reach the board only once the operator has released them - the '
        + 'frame is re-confirmed and only then is the next section staged',
        (seen) => {
          expect(seen.calls).toEqual([
            'selectWcs(G54)', 'loadMoves(1)', 'selectWcs(G54)', 'loadMoves(1)',
          ])
        },
      ),
    ],
    program: PRELUDE + AT_ORIGIN + 'M0\nG0 X1\nM30\n',
    refusedAtLine: null,
    check: (p) => {
      expect(p.stages).toHaveLength(2)
      expect(p.stages[0].ends).toEqual({ kind: 'hold', line: 3, optional: false })
      // The same word one line earlier - before any motion - is honoured too.
      const early = read(PRELUDE + 'M0\n' + AT_ORIGIN + 'M30\n')
      if (!early.ok) throw new Error(early.refusal.message)
      expect(early.program.stages[0].heldBefore).toEqual({ line: 2, optional: false })
      expect(early.program.holdsWithNoMotion).toEqual([])
    },
  },
  {
    word: 'M2 / M30',
    meaning: 'program end',
    claims: [
      onWire('ends the program; what the file states before it is staged, and nothing after', (seen) => {
        expect(seen.staged).toHaveLength(1)
        expect(seen.readiness.ready).toBe(true)
      }),
    ],
    program: PRELUDE + AT_ORIGIN + 'M30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }],
  },
  {
    word: 'M3 / M4 with S',
    meaning: 'spindle clockwise / counter-clockwise at S RPM',
    claims: [
      inConsole(
        'the speed and direction the moves after it run at - the load line names every speed the '
        + 'file states, in order. A SECOND SPEED IS ALLOWED: it ends the section, and on a machine '
        + 'with no link to the spindle the program HOLDS there so the operator can set it',
        (seen) => {
          expect(seen.console).toContain('the spindle at 12000 RPM CW, then 8000 RPM CW')
          expect(seen.holds).toBe(1)
        },
      ),
      onWire('and the moves the new speed governs are staged only after that hold is released', (seen) => {
        expect(seen.calls).toEqual([
          'selectWcs(G54)', 'loadMoves(1)', 'selectWcs(G54)', 'loadMoves(1)',
        ])
      }),
    ],
    program: PRELUDE + 'M3 S12000\n' + AT_ORIGIN + 'M3 S8000\nG0 X1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 }],
    check: (p) => {
      expect(p.spindleSpeeds.map((entry) => entry.rpm)).toEqual([12000, 8000])
      expect(p.stages.map((stage) => stage.spindle?.rpm)).toEqual([12000, 8000])
    },
  },
  {
    word: 'M5',
    meaning: 'spindle stop',
    claims: [
      inConsole(
        'STOPS THE SPINDLE AT THAT LINE. The section ends there and the moves after it are a '
        + 'section of their own, so a post-M5 retract never runs on a spinning tool',
        (seen) => {
          expect(seen.console).toContain('The file stops the spindle on line 4')
        },
      ),
      onWire('and the retract after it is staged as its own part, in the gap after the stop', (seen) => {
        expect(seen.calls).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'loadMoves(1)'])
      }),
    ],
    program: PRELUDE + 'M3 S9000\n' + AT_ORIGIN + 'M5\nG0 Z20\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 20 }],
    check: (p) => {
      expect(p.spindle).toMatchObject({ rpm: 9000 })
      expect(p.stages.map((stage) => stage.spindleOn)).toEqual([true, false])
      expect(p.stages[0].ends).toEqual({ kind: 'spindle', line: 4, on: false })
    },
  },
  {
    word: 'T / M6',
    meaning: 'tool select / tool change',
    claims: [
      inConsole(
        'a BOUNDARY, not a refusal: the section ends there, the program HOLDS, and the console '
        + "names BOTH tools by their library names so the operator can pick one up",
        (seen) => {
          expect(seen.holds).toBe(1)
          expect(seen.console).toContain('T1 (6 mm flat end mill)')
          expect(seen.console).toContain('T2 (3 mm ball nose)')
        },
      ),
      onWire('and no move is added or lost by the split - the file\'s own moves, in its own order', (seen) => {
        expect(seen.staged.map((move) => move.to)).toEqual([
          { x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 },
        ])
      }),
    ],
    program: PRELUDE + 'T1\n' + AT_ORIGIN + 'T2 M6\nG0 X1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 }],
    check: (p) => {
      expect(p.tools).toEqual([1, 2])
      expect(p.stages[0].ends).toEqual({ kind: 'tool-change', line: 4, from: 1, to: 2 })
    },
  },
  {
    word: 'T / M6 (spindle still on)',
    meaning: 'a tool change with no M5 before it',
    claims: [
      refusedAt(
        5,
        'M5',
        'REFUSED, naming the missing M5 - a cutter is never fitted to a turning spindle',
      ),
    ],
    program: PRELUDE + 'T1\nM3 S9000\n' + AT_ORIGIN + 'T2 M6\nG0 X1\nM30\n',
    refusedAtLine: 5,
  },
  {
    word: 'M2001 (a user macro)',
    meaning: "a UCCNC user macro call - Fusion's post emits one to park the machine",
    claims: [
      inConsole(
        'a BOUNDARY: the program holds at the line, the console names the macro BY NUMBER, and the '
        + 'operator does at the machine whatever it does. Never refused at the door and never '
        + 'dropped silently',
        (seen) => {
          expect(seen.holds).toBe(1)
          expect(seen.console).toContain('M2001 on line 3')
        },
      ),
      onWire('and the moves after it reach the board only once that hold is released', (seen) => {
        expect(seen.calls).toEqual([
          'selectWcs(G54)', 'loadMoves(1)', 'selectWcs(G54)', 'loadMoves(1)',
        ])
      }),
    ],
    program: PRELUDE + AT_ORIGIN + 'M2001\nG0 X1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 }],
    check: (p) => { expect(p.macros).toEqual([{ line: 3, code: 2001 }]) },
  },
  {
    word: 'M62 (a word below the macro range)',
    meaning: 'a digital output, and every other standard M-code this reader does not carry',
    claims: [
      refusedAt(
        3,
        'M62',
        'REFUSED by number - only UCCNC user macros (M1000 and up) become a hold',
      ),
    ],
    program: PRELUDE + AT_ORIGIN + 'M62 P1\nG0 X1\nM30\n',
    refusedAtLine: 3,
  },
  {
    word: 'T / M6, twice with nothing moving between',
    meaning: 'a second tool change before any motion has been interpreted under the first',
    claims: [
      refusedAt(
        5,
        'tool change to T2 on line 4',
        'REFUSED, naming BOTH lines - one boundary is one hold, so the operator would be told to fit '
        + 'T2 for moves this route already interpreted under T3',
      ),
    ],
    program: PRELUDE + 'T1\n' + AT_ORIGIN + 'T2 M6\nT3 M6\nG0 X1\nM30\n',
    refusedAtLine: 5,
  },
  {
    word: 'M2001, twice with nothing moving between',
    meaning: 'a second user macro before any motion has been interpreted under the first',
    claims: [
      refusedAt(
        4,
        'M2001 macro call on line 3',
        'REFUSED, naming BOTH lines - one boundary is one hold, so the second macro would be accepted '
        + 'and never named to the operator',
      ),
    ],
    program: PRELUDE + AT_ORIGIN + 'M2001\nM2002\nG0 X1\nM30\n',
    refusedAtLine: 4,
  },
  {
    word: 'M7 / M8 / M9 (the record states the output)',
    meaning: 'mist / flood coolant on, coolant off, on a machine that has it',
    statesCoolant: true,
    claims: [
      inConsole(
        "COMMANDED THROUGH THE MACHINE'S OWN CONFIGURED COOLANT ACTION LINES - the same lines the "
        + "Control page's Mist and Flood buttons send, this operator's override for this machine "
        + "else its declared controller's default - at the line that states it, because a coolant "
        + 'change is what ends the section there. THE LINE IS TRANSLATED AT THAT LINE (WO-1635) into '
        + 'the pins the machine definition names (WO-1637); this record assigns no relay pin, so the '
        + 'word is refused naming the setting to fill in, and the refusal is named instead of swallowed',
        (seen) => {
          // THE TRANSLATION'S OWN WORDS, naming the machine's own resolved flood
          // line - past the MDI lockout, in the gap between two staged parts.
          expect(seen.console).toContain('MDI M8: M8 switches flood coolant, and this machine definition assigns it no pin')
          expect(seen.console).toContain('MDI M9: M9 switches coolant and accessories, and this machine definition assigns it no pin')
          expect(seen.console).not.toContain('Refused text:')
          expect(seen.console).toContain(
            'Line 2: the file switches flood coolant on here, and it could not be sent',
          )
          expect(seen.console).toContain(
            'Line 4: the file switches coolant off here, and it could not be sent',
          )
        },
      ),
      onWire('and the word never holds the program - the file asked the operator for nothing', (seen) => {
        expect(seen.holds).toBe(0)
        expect(seen.staged.map((move) => move.to?.z)).toEqual([10, 20])
      }),
    ],
    program: PRELUDE + 'M8\n' + AT_ORIGIN + 'M9\nG0 Z20\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 20 }],
    check: (p) => {
      expect(p.coolant).toEqual({ flood: true, mist: false })
      expect(p.stages[0].ends).toEqual({ kind: 'coolant', line: 4, flood: false, mist: false })
    },
  },
  {
    word: 'M7 / M8 / M9 (the record states no output)',
    meaning: 'the same words on a machine that declares no coolant',
    statesCoolant: false,
    claims: [
      inConsole(
        'NOTHING IS SENT - a channel the machine record does not state has no output to switch, '
        + "which is Operator's own rule for the Control page's buttons. The load line says ONCE what "
        + 'the file asked for, and each change is still named at its own line as the operator\'s '
        + 'to switch',
        (seen) => {
          expect(seen.console).toContain(
            'The file commands flood coolant, and this machine states no such output',
          )
          expect(seen.console).toContain(
            'Line 2: the file switches flood coolant on here, and this machine states no such output',
          )
          expect(seen.console).toContain(
            'Line 4: the file switches coolant off here, and this machine states no such output',
          )
          expect(seen.console).not.toContain('Refused text:')
        },
      ),
      onWire('and nothing but motion reaches the wire', (seen) => {
        expect(seen.holds).toBe(0)
        expect(seen.staged.map((move) => move.to?.z)).toEqual([10, 20])
      }),
    ],
    program: PRELUDE + 'M8\n' + AT_ORIGIN + 'M9\nG0 Z20\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 20 }],
  },
  {
    word: 'N',
    meaning: 'block number',
    claims: [
      onWire('ignored - it numbers the line, it does not command anything', (seen) => {
        expect(seen.staged.map((move) => move.to)).toEqual([{ x: 1, y: 1, z: 1 }])
      }),
    ],
    program: 'N10 ' + PRELUDE + 'N20 G0 X1 Y1 Z1\nN30 M30\n',
    refusedAtLine: null,
    staged: [{ x: 1, y: 1, z: 1 }],
  },
  {
    word: '( ) and ;',
    meaning: 'comments',
    claims: [
      onWire('ignored - a commented file stages exactly the moves the uncommented one does', (seen) => {
        expect(seen.staged.map((move) => move.to)).toEqual([{ x: 1, y: 1, z: 1 }])
      }),
    ],
    program: '(a comment)\n' + PRELUDE + '; another\nG0 X1 Y1 Z1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 1, y: 1, z: 1 }],
  },
  {
    word: '( ) and ; (line numbering)',
    meaning: 'a comment between two commanding blocks',
    claims: [
      onWire('comments still count toward the retained dwell source line', (seen) => {
        expect(seen.readiness.ready).toBe(true)
      }),
    ],
    program: '(a comment)\n' + PRELUDE + '; another\nG0 X1 Y1 Z1\nG4 P1\nM30\n',
    refusedAtLine: null,
    staged: [{ x: 1, y: 1, z: 1 }],
    check: (p) => { expect(p.accepted.some((entry) => entry.line === 5 && entry.word.startsWith('G4 P'))).toBe(true) },
  },
]

describe('WO-1335 acceptance item 1: every word the UCCNC posts emit, and what it becomes', () => {
  it.each(WORD_TABLE.map((row) => [row.word, row] as const))('%s', (_word, row) => {
    const result = read(row.program, row.options)
    if (row.refusedAtLine !== null) {
      if (result.ok) throw new Error(`${row.word} was expected to be refused and loaded instead`)
      expect(result.refusal.line).toBe(row.refusedAtLine)
      return
    }
    if (!result.ok) throw new Error(`${row.word} was refused: ${result.refusal.message}`)
    const program = result.program
    if (row.staged) {
      expect(
        program.stages.flatMap((stage) => stage.moves).map((m) => ({ x: m.x, y: m.y, z: m.z })),
      ).toEqual(row.staged)
    }
    row.check?.(program)
  })

  // THE ARTIFACT IS NOT WRITTEN HERE ANY MORE, and that is the audit's finding
  // closed. A table generated beside the interpreter can only ever assert what
  // the interpreter thinks; the sentences Operator reads are about what reaches the
  // MACHINE. `gcodeTextRoute.wo1335.test.tsx` drives every row above through
  // the rendered panel, proves every claim against the wire, the console or the
  // refusal, and writes the table from the claims it proved.
  it('states a claim for every row, and no row states prose nobody can check', () => {
    for (const row of WORD_TABLE) {
      expect(row.claims.length, `${row.word} states no claim at all`).toBeGreaterThan(0)
      for (const claim of row.claims) {
        expect(['wire', 'console', 'refusal']).toContain(claim.from)
        expect(typeof claim.proves).toBe('function')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// OPERATOR'S ACCEPTANCE, item 1, second half: THE CORPUS. Every posted file this
// repository holds - ours and the foreign ones WO-1287 collected, including his
// own Fusion 360 output for the LienCNC V2 - read by the real interpreter, with
// the verdict PINNED. A file that loads names its stages, frames and move
// count; a file that is refused names the LINE and the WORD.
//
// This is the row nobody can argue with: it is measured, not asserted about,
// and `WRITE_EVIDENCE=1` writes the same verdicts to
// `src/tests/evidence/WO-1335/corpus.md`.
//
// WHERE THE CORPUS SAYS "REFUSED", THAT IS THE ANSWER AND NOT A GAP TO PAPER
// OVER. After the architect's re-scope (2026-09-11T03:23Z) every one of our own
// post's files loads, including the two-setup program with a tool change in it,
// and so do the incremental and two-speed ones.
//
// OPERATOR'S OWN FUSION FILE NOW LOADS (WO-1337, 2026-09-11). It stopped at line 31
// on a HELICAL ARC - a `G3` whose Z ramps while it sweeps - and that refusal
// existed twice, in `reader.ts` and again in `buildMachineProgram.ts`. Neither
// was about the wire: `ToolpathMove` and the bridge's
// `AddCircularMoveP(X, Y, Z, CX, CY, CZ, ...)` have always carried an endpoint
// Z, and what the builder did was force it equal to the start. WO-1337 stops
// forcing it, so the file reads as the 110,615 moves it is. NO HELIX HAS FLOWN
// ON THE BOARD YET; that gates CUTTING with one, and the air-run fixture is in
// WO-1337.
//
// TWO FILES ARE STILL REFUSED AND NEITHER IS A HOME BLOCK ANY MORE. `G28` is
// resolved at load on a HOMED machine (WO-1337) - work = machine - offset, the
// same arithmetic `G53` gets - so the two Fusion excerpts read past their
// opening `G28 G91 Z0` and stop on what is actually wrong with them for this
// route: `fusion360-issue395-xy.nc` cuts a `G18` arc in a plane `ToolpathMove`
// does not carry, and `fusion360-drilling-excerpt.nc` puts a Z on a `G43` block
// before any motion word has established a modal motion mode. The LinuxCNC file
// is an O-word subroutine - a programming language, not a UCCNC post's output.
//
// That each of those two files still refuses at its OWN home block on an
// UNHOMED machine is pinned in `src/tests/machine/helicalArc.wo1337.test.ts`,
// which measures both verdicts side by side.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'

interface CorpusCase {
  path: string
  source: string
  /** The verdict this file gets, pinned. */
  verdict:
    | { kind: 'loads'; stages: number; moves: number; frames: string[] }
    | { kind: 'refused'; line: number; contains: string; why: string }
}

const CORPUS: CorpusCase[] = [
  {
    path: 'src/tests/fixtures/foreign-gcode/liencam-own-post-baseline.nc',
    source: "LienCAM's own post (WO-023 output)",
    // Three stages for two setups: the file's M5 (line 17) is honoured, so its
    // final retract (line 19) is a section of its own that runs spindle-off.
    verdict: { kind: 'loads', stages: 3, moves: 7, frames: ['G54', 'G55', 'G55'] },
  },
  {
    path: 'src/tests/evidence/WO-240/wo240-export.nc',
    source: "LienCAM's own post, WO-240 export",
    verdict: { kind: 'loads', stages: 3, moves: 7, frames: ['G54', 'G55', 'G55'] },
  },
  {
    path: 'src/tests/evidence/WO-023/wo023-square.nc',
    source: "LienCAM's own post, single setup",
    verdict: { kind: 'loads', stages: 1, moves: 6, frames: ['G54'] },
  },
  {
    path: 'src/tests/evidence/WO-1171/same-program-grblhal.nc',
    source: "LienCAM's own post, grblHAL dialect, 36 moves",
    // THE FILE THAT EXERCISES EVERY SPINDLE WORD: M5 (30), a retract, M0 (34),
    // M3 again (36), and a last M5 (51) before the final retract. Four
    // sections, still 36 moves - the splits are instants, not motion.
    verdict: { kind: 'loads', stages: 4, moves: 36, frames: ['G54', 'G54', 'G54', 'G54'] },
  },
  {
    path: 'src/tests/evidence/WO-387/wo387-mesh-sim.nc',
    source: "LienCAM's own post, mesh-compensated program",
    verdict: { kind: 'loads', stages: 1, moves: 8, frames: ['G54'] },
  },
  {
    path: 'src/tests/evidence/WO-416/mesh-program.nc',
    source: "LienCAM's own post, mesh viewer program",
    verdict: { kind: 'loads', stages: 1, moves: 7, frames: ['G54'] },
  },
  {
    path: 'src/tests/evidence/WO-1312/two-setup-combined-posted.nc',
    source: "LienCAM's own post, the 237-line two-setup program from the machine session",
    // THE SECOND FILE THE ACCEPTANCE NAMES. It was refused at line 86 for the
    // `T2 M6` in our own post's output; the tool change is now a hold.
    verdict: { kind: 'loads', stages: 5, moves: 147, frames: ['G54', 'G55', 'G55', 'G55', 'G55'] }, // +1: the M0 after T2 M6 is its own stop (owner ruling 10-04)
  },
  {
    path: 'src/tests/evidence/WO-1277/two-speed-same-tool.nc',
    source: "LienCAM's own post, two spindle speeds on one tool",
    // WO-2023 added only the opening Z lift before the unchanged XY travel.
    verdict: { kind: 'loads', stages: 3, moves: 6, frames: ['G54', 'G54', 'G54'] },
  },
  {
    path: 'src/tests/evidence/WO-023/wo023-g91.nc',
    source: "LienCAM's own post, incremental output",
    verdict: { kind: 'loads', stages: 1, moves: 3, frames: ['G54'] },
  },
  {
    path: 'src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc',
    source: "Fusion 360, Operator's own UCCNC post for the LienCNC V2",
    // THE FILE THIS WHOLE ROUTE WAS BUILT FOR. It is a helical ramp entry -
    // thousands of short `G3` arcs, each with an I/J centre and a Z step of
    // about 0.1 mm - and it stopped at line 31 until WO-1337 stopped forcing
    // an arc's endpoint Z equal to its start. Four sections: the `M2001` park
    // macro and the `M0` it holds at split it, and the file runs in G54
    // throughout.
    verdict: { kind: 'loads', stages: 5, moves: 110_615, frames: ['G54', 'G54', 'G54', 'G54', 'G54'] }, // +1: the M0 after M2001 is its own stop (owner ruling 10-04)
  },
  {
    path: 'src/tests/fixtures/foreign-gcode/fusion360-issue395-xy.nc',
    source: 'Fusion 360, third-party posted output (GRBL issue 395)',
    verdict: { kind: 'loads', stages: 3, moves: 18, frames: ['G54', 'G54', 'G54'] },
  },
  {
    path: 'src/tests/fixtures/foreign-gcode/fusion360-drilling-excerpt.nc',
    source: 'Fusion 360, third-party drilling excerpt',
    verdict: { kind: 'loads', stages: 2, moves: 10, frames: ['G54', 'G54'] },
  },
  {
    path: 'src/tests/fixtures/foreign-gcode/linuxcnc-spiral.ngc',
    source: 'LinuxCNC nc_files/spiral.ngc',
    verdict: {
      kind: 'refused',
      line: 1,
      contains: 'address O is not understood',
      why: 'an O-word subroutine - a language this route does not read, refused on its first line.',
    },
  },
]

/** Every corpus file is read with every frame reported by a controller, because
 *  a frame the controller has not set is a DIFFERENT refusal and this table is
 *  measuring the FILE, not the machine. For the same reason the machine is
 *  HOMED here (WO-1337): "this machine has not been homed" is a fact about a
 *  machine at an instant, and a table that let it stand would be recording the
 *  fixture's state as a property of somebody's file. */
const CORPUS_OPTIONS: GcodeInterpretOptions = {
  ...OPTIONS,
  machineHome: { x: 0, y: 0, z: 0 },
  // THE TOOL LIBRARY THE SESSION BRINGS, as the file door brings it: the
  // cutters these posted files name, each with a stated length. Operator's Fusion
  // file runs T19 and applies `G43 H19`, so T19 is in it - "LienCAM owns the
  // tool data" means the operator's library holds the tool the file runs.
  workOffsets: {
    G54: { x: 10, y: 5, z: 2 },
    G55: { x: 110, y: 5, z: 2 },
    G56: { x: 0, y: 0, z: 0 },
    G57: { x: 0, y: 0, z: 0 },
    G58: { x: 0, y: 0, z: 0 },
    G59: { x: 0, y: 0, z: 0 },
  },
}

describe('WO-1335 acceptance item 1: the corpus, with every verdict pinned', () => {
  const verdicts: string[] = []

  it.each(CORPUS.map((entry) => [entry.path.split('/').at(-1)!, entry] as const))(
    '%s',
    (_name, entry) => {
      const text = readFileSync(entry.path, 'utf8')
      const result = interpretGcodeProgram(text, CORPUS_OPTIONS)
      if (entry.verdict.kind === 'loads') {
        if (!result.ok) throw new Error(`${entry.path} was refused: ${result.refusal.message}`)
        expect({
          stages: result.program.stages.length,
          moves: result.program.moveCount,
          frames: result.program.frames,
        }).toEqual({
          stages: entry.verdict.stages,
          moves: entry.verdict.moves,
          frames: entry.verdict.frames,
        })
        // EVERY STAGED MOVE COMES FROM A LINE OF THE FILE. A move this route
        // could not point at would be a move nobody authored.
        for (const stage of result.program.stages) {
          expect(stage.moveLines).toHaveLength(stage.moves.length)
          expect(stage.moveLines.every((line) => line >= 1)).toBe(true)
        }
        verdicts.push(
          `| \`${entry.path}\` | ${entry.source} | LOADS | ${entry.verdict.moves} moves, `
          + `${entry.verdict.stages} section(s), ${entry.verdict.frames.join(' -> ')} |`)
        return
      }
      if (result.ok) throw new Error(`${entry.path} was expected to be refused and loaded instead`)
      expect(result.refusal.line).toBe(entry.verdict.line)
      expect(result.refusal.message).toContain(entry.verdict.contains)
      verdicts.push(
        `| \`${entry.path}\` | ${entry.source} | REFUSED at line ${entry.verdict.line} | `
        + `${entry.verdict.why.replace(/\s+/g, ' ')} |`)
    },
  )

  it('renders the corpus verdicts to evidence when asked', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1335', { recursive: true })
    writeFileSync(
      'src/tests/evidence/WO-1335/corpus.md',
      '# WO-1335 - every posted file in this repository, and what this route does with it\n\n'
      + 'Generated by `src/tests/gcode/interpret.wo1335.test.ts` (`WRITE_EVIDENCE=1`).\n'
      + 'Each verdict below is pinned by an assertion in that test.\n\n'
      + '| File | Source | Verdict | Detail |\n| --- | --- | --- | --- |\n'
      + `${verdicts.join('\n')}\n`,
    )
  })
})

// ---------------------------------------------------------------------------
// OPERATOR'S ACCEPTANCE, item 2: "Malformed G-code is handled properly and safely:
// refused by line and word before a single move is staged, never partially
// executed, never silently dropped - with a NEGATIVE-CONTROL corpus."
//
// The pure half is here - every case refuses, at the right line, carrying NO
// program. `gcodeTextRoute.wo1335.test.tsx` runs the same corpus through the
// rendered panel and proves that nothing reached the wire for any of them.
// ---------------------------------------------------------------------------

export const NEGATIVE_CORPUS: {
  name: string
  gcode: string
  line: number
  contains: string
  /** Present, and undefined, only where the case needs no declared machine units. */
  machineUnits?: 'mm' | 'inch'
}[] = [
  {
    name: 'truncated mid-block',
    gcode: 'G21 G90 G54\nG0 X1 Y1 Z1\nG1 X',
    line: 3,
    contains: 'token "X" is not understood',
  },
  {
    name: 'an unknown G word',
    gcode: 'G21 G90 G54\nG33 X1\nM30\n',
    line: 2,
    contains: 'G33 is not in the UCCNC G-code word table',
  },
  {
    name: 'an unknown M word',
    gcode: 'G21 G90 G54\nM47\nG0 X1 Y1 Z1\nM30\n',
    line: 2,
    contains: 'M47 is not in the UCCNC G-code word table',
  },
  {
    name: 'an address that is not a word at all',
    gcode: 'G21 G90 G54\nG0 X1 Y1 Z1 Q9\nM30\n',
    line: 2,
    contains: 'address Q is not understood on this block',
  },
  {
    name: 'a feed move with no feed',
    gcode: 'G21 G90 G54\nG1 X1 Y1 Z1\nM30\n',
    line: 2,
    contains: 'feed move has no feed rate',
  },
  {
    name: 'two motion words in one block',
    gcode: 'G21 G90 G54\nG0 G1 X1 Y1 Z1 F100\nM30\n',
    line: 2,
    contains: 'conflict in the motion modal group',
  },
  {
    name: 'the same address twice in one block',
    gcode: 'G21 G90 G54\nG0 X1 X2 Y1 Z1\nM30\n',
    line: 2,
    contains: 'address X appears more than once',
  },
  {
    name: 'an unterminated comment',
    gcode: 'G21 G90 G54\n( never closed\nG0 X1 Y1 Z1\nM30\n',
    line: 2,
    contains: 'unterminated comment',
  },
  {
    name: 'a block after the program end',
    gcode: 'G21 G90 G54\nG0 X1 Y1 Z1\nM30\nG0 X2\n',
    line: 4,
    contains: 'after M30 program end',
  },
  {
    name: 'an arc whose I/J centre is not equidistant',
    gcode: 'G21 G90 G54\nG0 X0 Y0 Z0\nG2 X10 Y10 I2 J0 F200\nM30\n',
    line: 3,
    contains: 'not equidistant',
  },
  {
    // A HELICAL ARC IS NO LONGER REFUSED (WO-1337) - the wire always carried
    // an endpoint Z. What is still refused is a ramping arc in a plane this
    // reader does not carry, which is the shape `fusion360-issue395-xy.nc`
    // actually stops on, and it is the case worth proving reaches no wire.
    name: 'a malformed helical arc with a non-equidistant centre',
    gcode: 'G21 G90 G54\nG0 X0 Y0 Z0\nG18 G2 X10 Z-5 I10 K0 F200\nM30\n',
    line: 3,
    contains: 'arc centre is not equidistant',
  },
  {
    name: 'an arc with no centre and no radius',
    gcode: 'G21 G90 G54\nG0 X0 Y0 Z0\nG2 X10 Y10 F200\nM30\n',
    line: 3,
    contains: 'no I/J centre or R radius',
  },
  {
    // G91 IS NO LONGER HERE - it is converted, not refused (architect
    // re-scope). What Fusion's home block actually leaves behind is `G28`, a
    // return to a point stored in a controller this bridge does not read, and
    // that is the case worth proving reaches no wire.
    name: 'a return to a controller-stored via point',
    gcode: 'G21 G90 G54\nG0 X1 Y1 Z1\nG30\nM30\n',
    line: 3,
    contains: 'G30',
  },
  {
    // The live door always declares millimetres, so this case can only be
    // reached by a caller that does not - and it still refuses rather than
    // picking a unit. `machineUnits: undefined` is what "nobody said" looks like.
    name: 'no units word and no machine units',
    gcode: 'G90 G54\nG0 X1 Y1 Z1\nM30\n',
    line: 1,
    contains: 'machine units are unknown',
    machineUnits: undefined,
  },
  {
    name: 'a file that commands nothing at all',
    gcode: 'G21 G90 G54\nM30\n',
    line: 2,
    contains: 'no motion at all',
  },
  {
    // A TOOL CHANGE IS NOW A HOLD, so what is refused here is the unsafe shape
    // of one: fitting a cutter into a spindle the file never stopped.
    name: 'a tool change with the spindle still commanded on',
    gcode: 'G21 G90 G54\nT1\nM3 S9000\nG0 X1 Y1 Z1\nT2 M6\nG0 X2\nM30\n',
    line: 5,
    contains: 'still commanded on',
  },
  {
    name: 'M3 with no S',
    gcode: 'G21 G90 G54\nM3\nG0 X1 Y1 Z1\nM30\n',
    line: 2,
    contains: 'never invented here',
  },
  {
    name: 'a mid-file frame the reader has no offset for, under G53',
    gcode: 'G21 G90 G54\nG0 X1 Y1 Z1\nG53 G0 Z30\nM30\n',
    line: 3,
    contains: 'G53',
  },
  {
    // AUDIT ROUND 4: the stage model carries ONE boundary, so a second tool
    // change behind the first named the wrong cutter at the hold. Refused at
    // the door instead, naming both lines.
    name: 'a second tool change with nothing moving between it and the first',
    gcode: 'G21 G90 G54\nT1\nG0 X1 Y1 Z1\nT2 M6\nT3 M6\nG0 X2 Y2 Z2\nM30\n',
    line: 5,
    contains: 'tool change to T2 on line 4',
  },
  {
    name: 'a second user macro with nothing moving between it and the first',
    gcode: 'G21 G90 G54\nG0 X1 Y1 Z1\nM2001\nM2002\nG0 X2 Y2 Z2\nM30\n',
    line: 4,
    contains: 'M2001 macro call on line 3',
  },
]

describe('WO-1335 acceptance item 2: malformed G-code refuses, by line, carrying no program', () => {
  it.each(NEGATIVE_CORPUS.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    // NO G53 OFFSETS HERE, deliberately: the last case needs a frame the
    // controller has not reported, which is what an unset offset looks like.
    const result = interpretGcodeProgram(entry.gcode, {
      ...OPTIONS,
      // The SAME options the live door brings, tool library included, so a case
      // is refused for the reason the operator would actually meet.
      workOffsets: entry.name.includes('G53') ? {} : OPTIONS.workOffsets,
      machineUnits: 'machineUnits' in entry ? entry.machineUnits : OPTIONS.machineUnits,
    })
    if (result.ok) throw new Error(`"${entry.name}" was expected to be refused and loaded instead`)
    expect(result.refusal.line).toBe(entry.line)
    expect(result.refusal.message).toContain(entry.contains)
    // NO PARTIAL PROGRAM, EVER. A caller that reached for `.program` on a
    // refusal would be running the prefix that happened to be understood.
    expect(result).not.toHaveProperty('program')
  })
})

describe('WO-1335 audit round 4: two boundary commands with no motion between them are refused', () => {
  // THE AUDIT'S SEQUENCE, VERBATIM: `T1`, motion, `T2 M6`, `T3 M6`, motion. The
  // stage model carries ONE boundary, so the hold named the completed T1 -> T2
  // change while the stage behind it already ran under T3 - the operator was
  // told to fit the wrong cutter. Refused now, by line, naming both.
  it('refuses a second tool change with nothing moving between it and the first', () => {
    const refusal = refusalOf('G21 G90 G54\nT1\nG0 X1 Y1 Z1\nT2 M6\nT3 M6\nG0 X2 Y2 Z2\nM30\n')
    expect(refusal.line).toBe(5)
    expect(refusal.message).toContain('a tool change to T3')
    expect(refusal.message).toContain('tool change to T2 on line 4')
  })

  it('refuses a second user macro with nothing moving between it and the first', () => {
    const refusal = refusalOf('G21 G90 G54\nG0 X1 Y1 Z1\nM2001\nM2002\nG0 X2 Y2 Z2\nM30\n')
    expect(refusal.line).toBe(4)
    expect(refusal.message).toContain('an M2002 macro call')
    expect(refusal.message).toContain('M2001 macro call on line 3')
  })

  // IN EITHER ORDER. A macro and a tool change at one boundary lose whichever
  // one the hold does not name: the operator fits a cutter and never runs the
  // macro, or runs the macro and cuts with the cutter the file replaced.
  it('refuses a tool change with nothing moving between it and a macro call', () => {
    const refusal = refusalOf('G21 G90 G54\nT1\nG0 X1 Y1 Z1\nM2001\nT2 M6\nG0 X2 Y2 Z2\nM30\n')
    expect(refusal.line).toBe(5)
    expect(refusal.message).toContain('a tool change to T2')
    expect(refusal.message).toContain('M2001 macro call on line 4')
  })

  it('refuses a macro call with nothing moving between it and a tool change', () => {
    const refusal = refusalOf('G21 G90 G54\nT1\nG0 X1 Y1 Z1\nT2 M6\nM2001\nG0 X2 Y2 Z2\nM30\n')
    expect(refusal.line).toBe(5)
    expect(refusal.message).toContain('an M2001 macro call')
    expect(refusal.message).toContain('tool change to T2 on line 4')
  })

  it('refuses a second tool change stated before the stage`s first move', () => {
    // BOTH PENDING: no motion has landed since either, so the second change is
    // read against the first while that one is still the opening boundary of
    // the stage the next move will open.
    const refusal = refusalOf('G21 G90 G54\nT1\nG0 X1 Y1 Z1\nM5\nT2 M6\nT3 M6\nG0 Z10\nM30\n')
    expect(refusal.line).toBe(6)
    expect(refusal.message).toContain('a tool change to T3')
    expect(refusal.message).toContain('tool change to T2 on line 5')
  })

  // WHAT MUST STILL LOAD: our own post writes `T2 M6` and then `M0` with no
  // motion between them (`WO-1312/two-setup-combined-posted.nc`, lines 86-87).
  // A stop asks the operator for nothing the hold does not already do, so it is
  // not one of the two commands that collapse - and the hold names the change.
  it('still loads the tool change and stop our own post writes back to back', () => {
    const program = programOf(
      'G21 G90 G54\nT1\nM3 S9000\nG0 X1 Y1 Z1\nM5\nG0 Z15\nT2 M6\nM0\nG55\nM3 S9000\nG0 X2 Y2 Z2\nM30\n',
    )
    // owner ruling 10-04: "if it's there it stops the machine" - the M0 after the M6 is
    // its own stop (a motionless stage), not cleared by the tool change's Continue.
    expect(program.stages).toHaveLength(4)
    expect(program.stages[1].ends).toEqual({ kind: 'tool-change', line: 7, from: 1, to: 2 })
    expect(program.stages[2].ends).toEqual({ kind: 'hold', line: 8, optional: false })
    expect(program.stages[2].moves).toHaveLength(0)
    expect(program.stages[3].tool).toBe(2)
  })

  // AND THE FUSION TAIL: `M2001` then `M0`, back to back
  // (`fusion-liencnc-v2-operator.nc`, lines 110354-110355).
  it('still loads a macro call followed by a stop', () => {
    const program = programOf('G21 G90 G54\nG0 X1 Y1 Z1\nM2001\nM0\nG0 Z10\nM30\n')
    // The M0 after the macro is its own stop (owner ruling 10-04).
    expect(program.stages).toHaveLength(3)
    expect(program.stages[0].ends).toEqual({ kind: 'macro', line: 3, code: 2001 })
    expect(program.stages[1].ends).toEqual({ kind: 'hold', line: 4, optional: false })
  })

  // A REPEATED `T1 M6` FOR THE TOOL ALREADY IN THE SPINDLE IS NOT A BOUNDARY at
  // all, so it is not a second one either.
  it('does not refuse an M6 that re-states the tool already in the spindle', () => {
    const program = programOf('G21 G90 G54\nT1 M6\nG0 X1 Y1 Z1\nT1 M6\nG0 Z10\nM30\n')
    expect(program.stages).toHaveLength(1)
    expect(program.tools).toEqual([1])
  })
})
