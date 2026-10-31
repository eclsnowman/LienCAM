// runFromLine - plan a mid-program start (MACHINE-CONTROL Tier 1).
//
// GRBL has no run-from-line; the SENDER must reconstruct the controller's
// modal state as of the target line and position the machine, then stream the
// remainder. This module builds that plan as data (pure, testable); the
// controller streams plan.prelude ahead of the remaining program lines.
//
// WO-1989 (rule 11, research doc 2026-09-10 "worth stealing #1"): the prelude
// SETS UP the state the program had at the line instead of listing it as
// cautions - the length offset the program applied, its work offset, spindle
// and outputs, and a lift to safe Z before any X/Y move. A requested line
// starts at that line; fitting the tool an earlier M6 called for is WO-2050's.
// Operator's ruling 2026-09-26: the operator's chosen line always starts. The
// prelude re-arms G91 and an arc mode the line relies on; what it cannot
// re-create (a G92 offset, a subroutine's state, tool-centre-point mode, an
// axis left at a machine position) is one console line each, never a block.
// The only refusals are a line outside the program, or no sendable g-code at
// or after it.

import { parseGcode, tokenizeLine, type GcodeLine } from '../gcode'
import { isSendableGcodeLine, stripGcodeComments } from '../gcode/text'
import { gcodeOutputWords, type GcodeOutputSource } from '../gcode/wordTable'

/** WO-1650: what the planner needs to know about the machine - its one output
 *  list, so a pump on M10 that was on at the line is on again. */
export interface RunFromLineOptions {
  outputs?: readonly GcodeOutputSource[] | null
  /** WO-1989: this machine's safe Z in MACHINE coordinates - supplied only
   *  when Z has a datum this session and the definition names one. The
   *  approach lifts there (G53 G0 Z) before any X/Y move. */
  safeZMachine?: number | null
  /** WO-3123: current controller-reported machine Z in mm, when known. */
  currentZMachine?: number | null
  /** WO-2237, a return to a pause point only: the work offset the controller
   *  reported the point in (54-59), for a program that selects none itself. */
  frameAtPause?: number | null
  /** WO-2237, a return to a pause point only: the tool in the spindle now. A
   *  tool changed during the stop runs the rest with its own length (G43 H). */
  toolNow?: number | null
}

export interface RunFromLinePlan {
  /** Commands to restore modal state + position; streamed before the rest. */
  prelude: string[]
  /** The line the operator or API asked for, before any snap. */
  requestedLine: number
  /** The actual first source line that will stream (snapped to a sendable
   *  line). */
  startLine: number
  /** Work position the machine will move to before streaming resumes. An axis
   *  is null when the program left it at a machine position (G53/G28/G30/a
   *  probe) or never placed it before the line - it is listed in notSetUp. */
  resumePosition: { x: number | null; y: number | null; z: number | null }
  /** Audit 10: where the prelude's own last Z move leaves the tool when
   *  resumePosition.z is null - 'at machine Z-2' or 'at Z10'; null when the
   *  prelude moves no Z and the tool stays where it is. */
  zRest: string | null
  /** WO-1989: the tool in the spindle at the line - the T of the last M6
   *  before it. Null when no tool change says. */
  tool: { number: number; changedOnLine: number } | null
  /** Operator-facing sentences: what the prelude does, and any snap. */
  warnings: string[]
  /** Operator's ruling 2026-09-26: one console line for each state the prelude
   *  could not re-create - information, never a block. */
  notSetUp: string[]
  /** The arc mode (G2/G3) a line relies on without naming it. GRBL takes no
   *  bare G2 in the prelude, so the session writes this word onto that line
   *  when it loads the slice (applyResumeMotion). Null when none relies on it. */
  resumeMotion: { line: number; word: string } | null
  /** WO-2237: a resume at the exact point a pause stopped the program. The
   *  prelude takes the tool back to `point` (work coordinates, program units,
   *  on the program's own path), and the interrupted line is sent as `text` -
   *  the rest of that move from the point. `pointMm` is the same point in work
   *  millimetres, for the operator's sentence (WO-1667 formatter). Absent for
   *  a start at a line. WO-2241: `cycle` is the canned cycle's G code when the
   *  line is one - `point` is then the start of the interrupted hole's cycle,
   *  and `text` runs that hole's cycle again and the holes after it. WO-2242:
   *  `toolChange` when the pause stopped inside a tool change (`on`, its line)
   *  - `point` is where the program stood when it reached it; `done` false:
   *  `line` is the change, run again; true: `line` is the one after it.
   *  WO-2243: `a`/`b`/`c` (degrees) for each rotary axis the line turns - the
   *  return turns it there before the tool comes down. */
  resumeAt?: {
    line: number
    text: string
    point: { x: number; y: number; z: number; a?: number; b?: number; c?: number }
    pointMm: { x: number; y: number; z: number; a?: number; b?: number; c?: number }
    cycle?: number
    toolChange?: { on: number; tool: number | null; done: boolean }
    /** WO-2437: the pause was the program's own stop (M0/M1) on line `on` -
     *  `point` is where the machine stood at it (the operator-stop park), and
     *  `line` is the one after it: the stop is done once CYCLE START answers. */
    programStop?: { on: number }
  }
}

export type RunFromLineResult =
  | { ok: true; plan: RunFromLinePlan }
  | {
      ok: false
      reason: string
      /**
       * This refusal means "the target IS the program start", not "that is
       * unsafe" (WO-082). It stays a refusal here - there is genuinely no
       * prefix to reconstruct and pretending otherwise would be a lie about
       * modal state - but callers serving an OPERATOR must route it to a
       * normal arm-from-top instead of handing back a dead end. Every other
       * refusal (out of range, no sendable line) leaves this undefined and
       * still means no.
       */
      atProgramStart?: true
    }

/**
 * Plan one operator-visible step backward from the live source-line cursor.
 * Reverse lookup uses the streamer's exact sendable predicate, then the
 * normal run-from planner remains the sole authority for modal reconstruction
 * and its program-start answer.
 */
export function buildStepBackPlan(
  programText: string,
  currentLine: number,
  options: RunFromLineOptions = {},
): RunFromLineResult {
  const rawLines = programText.split(/\r?\n/)
  if (!Number.isInteger(currentLine) || currentLine < 1 || currentLine > rawLines.length) {
    return { ok: false, reason: 'There is no completed program line to step back from.' }
  }

  let previousLine = -1
  for (let i = currentLine - 2; i >= 0; i--) {
    if (isSendableGcodeLine(rawLines[i])) {
      previousLine = i + 1
      break
    }
  }
  if (previousLine === -1) {
    return { ok: false, reason: 'The program is at its first sendable line - Back cannot go earlier.' }
  }

  const planned = planFrom(programText, previousLine, options)
  if (!planned.ok) return planned
  return {
    ok: true,
    plan: {
      ...planned.plan,
      warnings: [
        `Step Back will re-arm line ${planned.plan.startLine}, before the current cursor at line ${currentLine}.`,
        ...planned.plan.warnings,
      ],
    },
  }
}

const PLUNGE_FEED_CAP = 300 // mm/min for the prelude Z approach

function lastMatch(lines: string[], upTo: number, patterns: RegExp[]): string | null {
  for (let i = upTo - 1; i >= 0; i--) {
    const code = stripGcodeComments(lines[i]).toUpperCase()
    if (code === '') continue
    for (const re of patterns) {
      const m = re.exec(code)
      if (m) return m[0]
    }
  }
  return null
}

/**
 * WO-1650: EVERY OUTPUT ON AT THE LINE, in the order the file switched them on.
 * M7 and M8 are the dialect's coolant words, M9 stops everything, and a word
 * the machine's output list names (a pump on M10, its own off word M12) turns
 * that output on or off. Returned as the words that switch them back on.
 */
function outputsOnBefore(lines: string[], upTo: number, options: RunFromLineOptions): string[] {
  const listed = gcodeOutputWords('uccnc', options.outputs ?? [])
  let on: number[] = []
  for (let i = 0; i < upTo; i++) {
    const code = stripGcodeComments(lines[i]).toUpperCase()
    if (code === '') continue
    for (const match of code.matchAll(/M\s*(\d+)(?![.\d])/g)) {
      const m = Number(match[1])
      if (m === 7 || m === 8) {
        if (!on.includes(m)) on.push(m)
      } else if (m === 9) {
        on = []
      } else {
        for (const word of listed.get(m) ?? []) {
          if (word.on) {
            if (!on.includes(word.onCode)) on.push(word.onCode)
          } else {
            on = on.filter((c) => c !== word.onCode)
          }
        }
      }
    }
  }
  return on.map((c) => `M${c}`)
}

type Axis = 'x' | 'y' | 'z'
const AXES: readonly Axis[] = ['x', 'y', 'z']
const ROTARY = ['A', 'B', 'C'] as const
type RotaryLetter = (typeof ROTARY)[number]

/** G codes whose axis words are DATA, not a destination: an offset write, a
 *  stored position, a dynamic tool length. */
const DATA_AXIS_G = new Set([10, 28.1, 30.1, 43.1, 92, 92.1, 92.2, 92.3])
/** G codes that leave the named axes at a MACHINE position (or a probe's
 *  contact), which the work-coordinate prefix cannot express. */
function leavesMachinePosition(g: number): boolean {
  return g === 53 || g === 28 || g === 30 || (g >= 38.2 && g <= 38.5)
}

function gCodesOf(line: GcodeLine): number[] {
  return line.words
    .filter((w) => w.letter === 'G' && Number.isFinite(w.value))
    .map((w) => Math.round(w.value * 10) / 10)
}

function wordOf(line: GcodeLine, letter: string): number | null {
  const word = line.words.find((w) => w.letter === letter)
  return word !== undefined && Number.isFinite(word.value) ? word.value : null
}

function hasM(line: GcodeLine, codes: readonly number[]): boolean {
  return line.words.some((w) => w.letter === 'M' && codes.includes(w.value))
}

/** What the lines before the start establish that the shared parser does not
 *  track: a position that honours G91 and machine-coordinate moves, the
 *  program's own clearance height, its length offset, the tool in the spindle,
 *  and the states the prelude cannot re-create. */
interface PrefixState {
  /** Millimetres, whatever units each move was written in; `inch` says which
   *  units are in force at the line, and the prelude writes them back in those. */
  pos: Record<Axis, number | null>
  /** The line that last left each axis at a machine position. */
  lostAt: Record<Axis, number | null>
  rotary: Map<string, number | null>
  /** WO-2054: the work offset (G54-G59) in force at the line; null while the
   *  program has selected none, so every position is in the controller's own. */
  wcs: number | null
  /** WO-2054: the work offset each known position was set in. A change from
   *  G54 to G55 does not move the machine, so a position set in G54 is still
   *  that point in G54 numbers - never the same numbers in G55. */
  frameOf: Record<Axis, number | null>
  rotaryFrame: Map<string, number | null>
  /** WO-2054: the line whose work-offset change lost an axis the program
   *  placed before it named any offset - the offset the controller had then
   *  is not one the prelude can select again. Keyed by axis letter. */
  frameLostAt: Map<string, number>
  /** WO-2054: where a G53 line left an axis, in machine millimetres - the
   *  prelude puts X/Y back there, as the program did. */
  machine: Record<Axis, number | null>
  /** The highest work Z the program commanded in each work offset - its own
   *  clearance height there - and the offset it last raised one in. */
  clearance: Map<number | null, number>
  clearanceFrame: number | null | undefined
  /** The program's length offset in force: G43 with its H, or a G43.1
   *  dynamic length in millimetres. */
  lengthComp: { kind: 'G43'; h: number | null } | { kind: 'G43.1'; zMm: number } | null
  inch: boolean
  /** G91 in force at the line. */
  incremental: boolean
  /** WO-2243: G93 inverse-time feed in force at the line. */
  inverseTime: boolean
  /** WO-2244: G90.1 (absolute arc centres) in force at the line. */
  arcCentreAbsolute: boolean
  /** The plane (G17/G18/G19) the program selected before the line; null when
   *  it selected none. */
  plane: 17 | 18 | 19 | null
  tcpLine: number | null
  /** The G92 line whose offset is in force; `g92Set` survives a G92.2
   *  suspend so a G92.3 can put it back. */
  g92Line: number | null
  g92Set: number | null
  subroutineLine: number | null
  tool: { number: number; changedOnLine: number } | null
  /** The last T word, which the next M6 changes to. */
  selected: number | null
  /** Audit 14: the canned cycle still in force at the line - its G98/G99,
   *  its G code and its sticky words as written. */
  cycle: { retract: 98 | 99; code: number; words: Record<string, number> } | null
}

/** The words a canned cycle keeps between its repeats. */
const CYCLE_WORDS = ['Z', 'R', 'Q', 'P'] as const

function toolOf(t: number | null, changedOnLine: number): PrefixState['tool'] {
  return t !== null && Number.isInteger(t) && t >= 0 ? { number: t, changedOnLine } : null
}

/** WO-2237: the state in force at the START of one line - what the walk knows
 *  just before that line runs. Positions in millimetres, in `frameOf`. */
interface LineStart {
  pos: Record<Axis, number | null>
  frameOf: Record<Axis, number | null>
  wcs: number | null
  inch: boolean
  incremental: boolean
  plane: 17 | 18 | 19 | null
  /** The modal motion G code (0-3, or a canned cycle's), null before any. */
  motion: number | null
  /** G90.1: arc centres are absolute rather than offsets from the start. */
  arcCentreAbsolute: boolean
  /** The canned cycle modal at the line - its G code and its sticky words as
   *  written - or null. */
  cycle: { code: number; words: Record<string, number> } | null
  /** WO-2241: G98 (back to the level the cycle started from) or G99 (to R). */
  retract: 98 | 99
  /** WO-2242: the last T word before the line - the tool a bare M6 fits. */
  selected: number | null
  /** WO-2243: each rotary axis where the line starts, degrees in `wcs`; null
   *  when the program has not placed it there. */
  rotary: Record<RotaryLetter, number | null>
  /** WO-2243: G93 inverse-time feed in force at the line. */
  inverseTime: boolean
}

function walkPrefix(
  rawLines: string[],
  upTo: number,
  visit?: { lines: ReadonlySet<number>; at: (lineNo: number, start: LineStart) => void },
): PrefixState {
  const state: PrefixState = {
    pos: { x: null, y: null, z: null },
    lostAt: { x: null, y: null, z: null },
    rotary: new Map(),
    wcs: null,
    frameOf: { x: null, y: null, z: null },
    rotaryFrame: new Map(),
    frameLostAt: new Map(),
    machine: { x: null, y: null, z: null },
    clearance: new Map(),
    clearanceFrame: undefined,
    lengthComp: null,
    inch: false,
    incremental: false,
    inverseTime: false,
    arcCentreAbsolute: false,
    plane: null,
    tcpLine: null,
    g92Line: null,
    g92Set: null,
    subroutineLine: null,
    tool: null,
    selected: null,
    cycle: null,
  }
  let incremental = false
  let returnToInitial = true
  let cycle = null as { initialZ: number | null; r: number | null } | null
  let cycleDef = null as { code: number; words: Record<string, number> } | null
  // The G92 offset (mm, frame = machine-program frame minus offset); kept
  // through a G92.2 suspend so G92.3 can put it back.
  let g92Offset: Record<Axis, number | null> = { x: 0, y: 0, z: 0 }
  let g92Rotary: Record<string, number | null> = { A: 0, B: 0, C: 0 }
  let g92Active = false
  // WO-2054: a position is a number only in the work offset it was set in.
  const here = (a: Axis) => (state.frameOf[a] === state.wcs ? state.pos[a] : null)
  const raiseClearance = (frame: number | null, z: number) => {
    const was = state.clearance.get(frame)
    state.clearance.set(frame, was === undefined ? z : Math.max(was, z))
    state.clearanceFrame = frame
  }
  const placed = (a: Axis) => {
    state.frameOf[a] = state.wcs
    state.machine[a] = null
    state.frameLostAt.delete(a.toUpperCase())
  }
  let motion: number | null = null
  let arcCentreAbsolute = false
  let inverseTime = false
  const rotaryHere = (a: RotaryLetter) => {
    const v = state.rotary.get(a)
    return v !== undefined && v !== null && state.rotaryFrame.get(a) === state.wcs ? v : null
  }
  for (let i = 0; i < upTo; i++) {
    const lineNo = i + 1
    if (visit?.lines.has(lineNo)) {
      visit.at(lineNo, {
        pos: { ...state.pos },
        frameOf: { ...state.frameOf },
        wcs: state.wcs,
        inch: state.inch,
        incremental,
        plane: state.plane,
        motion,
        arcCentreAbsolute,
        cycle: cycle !== null && cycleDef !== null ? { code: cycleDef.code, words: { ...cycleDef.words } } : null,
        retract: returnToInitial ? 98 : 99,
        selected: state.selected,
        rotary: { A: rotaryHere('A'), B: rotaryHere('B'), C: rotaryHere('C') },
        inverseTime,
      })
    }
    const line = tokenizeLine(stripGcodeComments(rawLines[i]), lineNo)
    if (line.words.length === 0) continue
    const g = gCodesOf(line)
    for (const code of g) {
      if (code === 0 || code === 1 || code === 2 || code === 3 || code === 73 || (code >= 81 && code <= 89)) motion = code
      if (code === 80) motion = null
      if (code === 90.1) arcCentreAbsolute = true
      if (code === 91.1) arcCentreAbsolute = false
    }
    if (g.includes(90)) incremental = false
    if (g.includes(91)) incremental = true
    if (g.includes(93)) inverseTime = true
    if (g.includes(94) || g.includes(95)) inverseTime = false
    if (g.includes(20)) state.inch = true
    if (g.includes(21)) state.inch = false
    for (const p of [17, 18, 19] as const) if (g.includes(p)) state.plane = p
    const mm = (v: number) => (state.inch ? v * 25.4 : v)

    // WO-2054: a work-offset change moves nothing, so what the program set in
    // G54 stays a G54 position. What it set before naming any offset was in
    // whichever the controller had then, which the prelude cannot select.
    // (The same G54-G59 the shared parser reads, and it is set before motion.)
    const frame = g.find((code) => code >= 54 && code <= 59)
    if (frame !== undefined && frame !== state.wcs) {
      if (state.wcs === null) {
        for (const a of AXES) {
          if (state.pos[a] === null) continue
          state.pos[a] = null
          state.frameLostAt.set(a.toUpperCase(), lineNo)
        }
        for (const [a, v] of state.rotary) {
          if (v === null) continue
          state.rotary.set(a, null)
          state.frameLostAt.set(a, lineNo)
        }
        state.clearance.delete(null)
        if (state.clearanceFrame === null) state.clearanceFrame = undefined
      }
      state.wcs = frame
    }

    const t = wordOf(line, 'T')
    if (t !== null) state.selected = t
    if (hasM(line, [6])) state.tool = toolOf(state.selected, lineNo)

    if (g.includes(49)) {
      state.lengthComp = null
      state.tcpLine = null
    }
    if (g.includes(43)) {
      const h = wordOf(line, 'H')
      state.lengthComp = { kind: 'G43', h }
      state.tcpLine = null
    }
    if (g.includes(43.1)) {
      const z = wordOf(line, 'Z')
      state.lengthComp = z !== null ? { kind: 'G43.1', zMm: mm(z) } : null
      state.tcpLine = null
    }
    if (g.includes(43.4) || g.includes(43.5)) state.tcpLine = lineNo
    if (g.includes(92)) state.g92Line = state.g92Set = lineNo
    if (g.includes(92.1)) state.g92Line = state.g92Set = null
    if (g.includes(92.2)) state.g92Line = null
    if (g.includes(92.3)) state.g92Line = state.g92Set
    if (hasM(line, [97, 98]) || /\bCALL\b/i.test(stripGcodeComments(rawLines[i]))) state.subroutineLine = lineNo

    // Canned cycles (G73/G81-G89): the Z word is the hole's depth, not where
    // the tool stays. G98 (the power-on default) returns to the Z the cycle
    // started from, G99 to R - as the gcode reader simulates it.
    if (g.includes(98)) returnToInitial = true
    if (g.includes(99)) returnToInitial = false
    if (g.includes(80) || g.some((code) => code === 0 || code === 1 || code === 2 || code === 3)) cycle = null
    const cycleCode = g.find((code) => code === 73 || (code >= 81 && code <= 89))
    if (cycleCode !== undefined) {
      cycle = { initialZ: here('z'), r: cycle?.r ?? null }
      cycleDef = { code: cycleCode, words: cycleDef?.words ?? {} }
    }
    if (cycle === null) cycleDef = null
    if (cycle !== null) {
      const r = wordOf(line, 'R')
      const zHere = here('z')
      if (r !== null) cycle.r = incremental ? (zHere === null ? null : zHere + mm(r)) : mm(r)
      // Audit 14: the cycle's sticky words, as written, so a start on a bare
      // X/Y repeat can re-arm the same cycle on that line.
      for (const l of CYCLE_WORDS) {
        const v = wordOf(line, l)
        if (v !== null && cycleDef !== null) cycleDef.words[l] = v
      }
    }

    // Audit 11: G92 names where the tool IS in the new frame, so a start
    // right after it goes to those words, not the pre-G92 values. The walk
    // carries the offset, so G92.1/.2/.3 move the frame by exactly it.
    // Audit 12: the clearance is a Z in the same frame, so it moves with it.
    // G92 moves every work offset by the same amount.
    const moveClearance = (by: number | null) => {
      if (by === null) {
        state.clearance.clear()
        state.clearanceFrame = undefined
      } else {
        for (const [f, z] of state.clearance) state.clearance.set(f, z + by)
      }
    }
    const shift = (sign: 1 | -1) => {
      for (const a of AXES) {
        const o = g92Offset[a]
        state.pos[a] = state.pos[a] === null || o === null ? null : state.pos[a]! + sign * o
      }
      moveClearance(g92Offset.z === null ? null : sign * g92Offset.z)
      // Audit 13: G92 applies to rotary axes too.
      for (const a of ROTARY) {
        const at = state.rotary.get(a)
        if (at === undefined) continue
        const o = g92Rotary[a]
        state.rotary.set(a, at === null || o === null ? null : at + sign * o)
      }
    }
    if (g.includes(92)) {
      for (const a of AXES) {
        const v = wordOf(line, a.toUpperCase())
        if (v === null) continue
        const active = g92Active ? g92Offset[a] : 0
        const pos = here(a)
        g92Offset[a] = pos === null || active === null ? null : active + pos - mm(v)
        if (a === 'z') moveClearance(pos === null ? null : mm(v) - pos)
        state.pos[a] = mm(v)
        placed(a)
        // The tool is at this Z, so the offset it is in has a clearance.
        if (a === 'z' && !state.clearance.has(state.wcs)) raiseClearance(state.wcs, mm(v))
      }
      if (!g92Active) for (const a of AXES) if (wordOf(line, a.toUpperCase()) === null) g92Offset[a] = 0
      for (const a of ROTARY) {
        const v = wordOf(line, a)
        if (v === null) {
          if (!g92Active) g92Rotary[a] = 0
          continue
        }
        const active = g92Active ? g92Rotary[a] : 0
        const at = state.rotaryFrame.get(a) === state.wcs ? state.rotary.get(a) : null
        g92Rotary[a] = at === undefined || at === null || active === null ? null : active + at - v
        state.rotary.set(a, v)
        state.rotaryFrame.set(a, state.wcs)
        state.frameLostAt.delete(a)
      }
      g92Active = true
    } else if (g.includes(92.1) || g.includes(92.2)) {
      if (g92Active) shift(1)
      g92Active = false
      if (g.includes(92.1)) {
        g92Offset = { x: 0, y: 0, z: 0 }
        g92Rotary = { A: 0, B: 0, C: 0 }
      }
    } else if (g.includes(92.3) && !g92Active) {
      shift(-1)
      g92Active = true
    }

    if (g.some((code) => DATA_AXIS_G.has(code))) continue
    const named = AXES.filter((a) => wordOf(line, a.toUpperCase()) !== null)
    const rotaryNamed = ROTARY.filter((a) => wordOf(line, a) !== null)
    if (g.some(leavesMachinePosition)) {
      // A bare G28/G30 sends every axis to its stored position.
      const everyAxis = named.length === 0 && rotaryNamed.length === 0 && !g.includes(53)
      // WO-2054: G53 names the machine position (absolute in any distance
      // mode, G0 or G1 alike); G28/G30 go to a stored one and a probe stops
      // at contact, which the file does not say.
      const named53 = g.includes(53) && !g.some((code) => code !== 53 && leavesMachinePosition(code))
      for (const a of everyAxis ? AXES : named) {
        state.pos[a] = null
        state.lostAt[a] = lineNo
        state.frameLostAt.delete(a.toUpperCase())
        state.machine[a] = named53 ? mm(wordOf(line, a.toUpperCase()) as number) : null
      }
      for (const a of everyAxis ? [...state.rotary.keys()] : rotaryNamed) {
        state.rotary.set(a, null)
        state.frameLostAt.delete(a)
      }
      continue
    }
    const drills = cycle !== null && named.length > 0
    for (const a of named) {
      if (a === 'z' && drills) continue
      const v = mm(wordOf(line, a.toUpperCase()) as number)
      const prev = state.pos[a]
      if (incremental) {
        // An incremental move is the same distance in any frame, the machine's too.
        state.pos[a] = prev === null ? null : prev + v
        const at = state.machine[a]
        if (at !== null) state.machine[a] = at + v
      } else {
        state.pos[a] = v
        placed(a)
      }
      if (state.pos[a] !== null) state.lostAt[a] = null
    }
    if (cycle !== null && drills) {
      const { initialZ, r } = cycle
      // A start above R never goes below it: the reader raises the initial Z to R.
      state.pos.z = r === null ? null : !returnToInitial ? r : initialZ === null ? null : Math.max(initialZ, r)
      state.machine.z = null
      if (state.pos.z !== null) {
        state.lostAt.z = null
        placed('z')
      }
    }
    for (const a of rotaryNamed) {
      const v = wordOf(line, a) as number
      const prev = state.rotary.has(a) ? state.rotary.get(a) ?? null : incremental ? null : 0
      state.rotary.set(a, incremental ? (prev === null ? null : prev + v) : v)
      if (!incremental) {
        state.rotaryFrame.set(a, state.wcs)
        state.frameLostAt.delete(a)
      }
    }
    const z = state.pos.z
    if ((named.includes('z') || drills) && z !== null) raiseClearance(state.frameOf.z, z)
  }
  state.incremental = incremental
  state.inverseTime = inverseTime
  state.arcCentreAbsolute = arcCentreAbsolute
  state.cycle = cycleDef === null ? null : { retract: returnToInitial ? 98 : 99, ...cycleDef }
  return state
}

/**
 * The first line at or after the start that moves under the modal motion mode
 * without naming its own - the line that relies on an arc mode set earlier.
 * Null when the program names a motion mode (or ends) before anything moves.
 */
function lineRelyingOnMotion(rawLines: string[], from: number): number | null {
  for (let i = from - 1; i < rawLines.length; i++) {
    const line = tokenizeLine(stripGcodeComments(rawLines[i]), i + 1)
    if (line.words.length === 0) continue
    const g = gCodesOf(line)
    if (g.some((code) => code <= 3 || (code >= 38.2 && code <= 38.5) || code === 73 || (code >= 80 && code <= 89))) {
      return null
    }
    if (g.some((code) => DATA_AXIS_G.has(code) || code === 53 || code === 28 || code === 30)) continue
    if (['X', 'Y', 'Z', 'A', 'B', 'C', 'I', 'J', 'K', 'R'].some((l) => wordOf(line, l) !== null)) return i + 1
    if (hasM(line, [2, 30])) return null
  }
  return null
}

/** Where the prelude's last Z move leaves the tool: 'at machine Z<v>' for the
 *  G53 lift, 'at Z<v>' for a work move, null when it moves no Z. WO-2054: a
 *  work move in another offset than the line's names it - 'at Z<v> in G54'. */
function lastZMove(prelude: readonly string[], frameAt: number | null): string | null {
  for (let i = prelude.length - 1; i >= 0; i--) {
    const m = /^(G53 )?G[01] Z(-?[\d.]+)(?:\s|$)/.exec(prelude[i])
    if (!m) continue
    if (m[1]) return `at machine Z${m[2]}`
    const frame = prelude.slice(0, i).reverse().find((c) => /^G5[4-9]$/.test(c))
    return frame !== undefined && frame !== `G${frameAt}` ? `at Z${m[2]} in ${frame}` : `at Z${m[2]}`
  }
  return null
}

/** The program text as the slice must be sent: the arc word a line relies on
 *  written onto that line (after any block delete or N word), every line
 *  number unchanged. */
export function applyResumeMotion(programText: string, plan: RunFromLinePlan): string {
  const motion = plan.resumeMotion
  const at = plan.resumeAt
  if (at !== undefined) {
    // WO-2242: a tool change (or the line after it) goes as the door staged
    // it - on a text controller with no M6 of its own, the change's hold.
    if (at.toolChange !== undefined && !(at.toolChange.done && at.line === at.toolChange.on)) return programText
    // WO-2237: the interrupted line becomes the rest of its move, in place.
    const lines = programText.split(/\r?\n/)
    if (at.line < 1 || at.line > lines.length) return programText
    lines[at.line - 1] = at.text
    return lines.join('\n')
  }
  if (motion === null) return programText
  const lines = programText.split(/\r?\n/)
  const i = motion.line - 1
  if (i < 0 || i >= lines.length) return programText
  lines[i] = lines[i].replace(/^(\s*\/?\s*(?:N\d+\s*)?)/i, `$1${motion.word} `)
  return lines.join('\n')
}

export function buildRunFromLinePlan(
  programText: string,
  requestedLine: number,
  options: RunFromLineOptions = {},
): RunFromLineResult {
  return planFrom(programText, requestedLine, options)
}

function planFrom(
  programText: string,
  requestedLine: number,
  options: RunFromLineOptions,
  resumeAt?: NonNullable<RunFromLinePlan['resumeAt']>,
): RunFromLineResult {
  // Fail-loud (WO-006, d20f0892e audit finding 3): a fractional or non-finite
  // line number is operator input error, never something to round silently.
  if (!Number.isInteger(requestedLine)) {
    return { ok: false, reason: `"${requestedLine}" is not a whole line number.` }
  }
  const rawLines = programText.split(/\r?\n/)
  if (requestedLine < 1 || requestedLine > rawLines.length) {
    return { ok: false, reason: `Line ${requestedLine} is outside the program (1-${rawLines.length}).` }
  }

  // Snap to the first sendable line at or after the request, using THE SAME
  // predicate the streamer's prepareProgram uses to drop lines (WO-029, the
  // WO-024 audit's % hole): anything else lets the planner pick a line the
  // streamer will silently skip - blank, comment-only, or a '%' marker.
  let startLine = -1
  for (let i = requestedLine - 1; i < rawLines.length; i++) {
    if (isSendableGcodeLine(rawLines[i])) {
      startLine = i + 1
      break
    }
  }
  if (startLine === -1) {
    return { ok: false, reason: `No sendable g-code at or after line ${requestedLine}.` }
  }
  // "Program start" means the first line the machine RECEIVES, not raw line 1:
  // a %-wrapped program's first sendable line has nothing ahead of it to
  // reconstruct either, so run-from there is just Start with extra steps.
  const firstSendable = rawLines.findIndex((l) => isSendableGcodeLine(l)) + 1
  // WO-2237: a return to a pause point inside the first line is still a return.
  if (startLine === firstSendable && resumeAt === undefined) {
    return {
      ok: false,
      reason: `Line ${startLine} is the program start - use Start instead.`,
      atProgramStart: true,
    }
  }

  // Interpret the prefix to recover the core modal state.
  const prefix = rawLines.slice(0, startLine - 1).join('\n')
  const program = parseGcode(prefix)
  const end = program.end
  const state = walkPrefix(rawLines, startLine - 1)

  // Modal facts the shared parser does not track - scan the prefix directly.
  const spindleWord = lastMatch(rawLines, startLine - 1, [/(?:^|\s)M0?[345](?:\D|$)/]) ?? 'M5'

  // Operator's ruling 2026-09-26: the start stands. What the prelude cannot
  // re-create is one console line each - information, never a block.
  const notSetUp: string[] = []
  if (state.g92Line !== null) {
    notSetUp.push(`Not set up: the G92 offset from line ${state.g92Line} - the controller's own G92 offset stays in force.`)
  }
  if (state.subroutineLine !== null) {
    notSetUp.push(`Not set up: anything the subroutine called on line ${state.subroutineLine} changed.`)
  }
  if (state.tcpLine !== null) {
    notSetUp.push(`Not set up: tool-centre-point mode from line ${state.tcpLine}.`)
  }
  const warnings: string[] = []
  // Operator's ruling (Q-RUNFROM-CONTRACT-2): snapping forward is allowed,
  // silence is not - the operator is told which line actually starts.
  if (startLine !== requestedLine) {
    const requestedStripped = stripGcodeComments(rawLines[requestedLine - 1])
    const skippedKind =
      requestedStripped === '%' ? 'a % program marker' : 'a comment or blank line'
    warnings.push(
      `The program will start from line ${startLine} instead of ${requestedLine} - ` +
        `line ${requestedLine} is ${skippedKind}.`,
    )
  }

  const fmt = (v: number) => Number(v.toFixed(4))
  const prelude: string[] = []
  let lastMotion: 'G0' | 'G1' | null = null
  const units = state.inch ? 'G20' : 'G21'
  const inUnits = (v: number | null) => (v === null ? null : state.inch ? v / 25.4 : v)
  const authoredSafeZ = options.safeZMachine
  const liveZ = options.currentZMachine
  const safeZ = typeof authoredSafeZ === 'number' && Number.isFinite(authoredSafeZ)
    ? Math.max(authoredSafeZ, typeof liveZ === 'number' && Number.isFinite(liveZ) ? liveZ : -Infinity)
    : null
  const machineLift = typeof safeZ === 'number' && Number.isFinite(safeZ)
    && authoredSafeZ !== 0 && (fmt(safeZ) !== 0 || safeZ === liveZ)

  // WO-2054: every move goes in the work offset its numbers were set in, and
  // the one in force at the line goes on last. X/Y a G53 line left at a
  // machine position it names go back there with G53, as the program did.
  const frameAt = resumeAt && state.wcs === null ? options.frameAtPause ?? null : state.wcs
  // WO-2237: a return to a pause point goes to that point, in the line's own
  // offset - the one the controller reported it in.
  const frameOf = (a: Axis): number | null => (resumeAt ? frameAt : state.frameOf[a])
  const pos = resumeAt
    ? { ...resumeAt.point }
    : { x: inUnits(state.pos.x), y: inUnits(state.pos.y), z: inUnits(state.pos.z) }
  // WO-2054 fix round: only a plan that lifts to the machine safe Z puts X/Y
  // back with G53. A text door that refuses G53 (the native simulator) is
  // retried with no safe Z (loadRunFromSlice), so that plan carries no G53
  // word - X/Y left by G53 stay, and the console names them.
  const atMachine = (a: Axis) => !resumeAt && machineLift && a !== 'z' && state.pos[a] === null && state.machine[a] !== null
  // The lift runs in Z's own offset; with Z unknown, in the line's offset or
  // the last one the program lifted in.
  const liftFrame = resumeAt || state.pos.z !== null
    ? frameOf('z')
    : state.clearance.has(frameAt) ? frameAt : state.clearanceFrame ?? frameAt
  // WO-2237 review 2: a return's moves go in the reported offset, but the walk
  // recorded a program that names no offset under its own key (null).
  const programClearance = inUnits(state.clearance.get(resumeAt ? state.wcs : liftFrame) ?? null)
  // WO-2237: X/Y never travel below the pause point itself; with no machine
  // safe Z the tool first rises to the higher of the program's clearance and
  // the point.
  const clearance = resumeAt
    ? Math.max(programClearance ?? resumeAt.point.z, resumeAt.point.z)
    : programClearance
  type Frame = number | null | 'G53'
  const groups: Array<{ frame: Frame; words: string[]; letters: string[] }> = []
  const place = (frame: Frame, letter: string, v: number) => {
    let group = groups.find((g) => g.frame === frame)
    if (group === undefined) groups.push((group = { frame, words: [], letters: [] }))
    group.words.push(`${letter}${fmt(v)}`)
    group.letters.push(letter)
  }
  for (const a of ['x', 'y'] as const) {
    const v = pos[a]
    if (v !== null) place(frameOf(a), a.toUpperCase(), v)
    else if (atMachine(a)) place('G53', a.toUpperCase(), inUnits(state.machine[a]) as number)
  }
  // WO-2243: a rotary axis the interrupted line turns goes to the pause
  // point's angle, in the line's offset, with X/Y at the lifted height.
  const rotaryAt = new Map(state.rotary)
  const rotaryFrame = new Map(state.rotaryFrame)
  for (const a of ROTARY) {
    const v = resumeAt?.point[rotaryKey(a)]
    if (v === undefined) continue
    rotaryAt.set(a, v)
    rotaryFrame.set(a, frameAt)
  }
  for (const [a, v] of rotaryAt) if (v !== null) place(rotaryFrame.get(a) ?? null, a, v)
  // Other offsets first, then the line's own, then G53 (which selects none).
  const rank = (f: Frame) => (f === 'G53' ? 2 : f === frameAt ? 1 : 0)
  groups.sort((a, b) => rank(a.frame) - rank(b.frame))
  const frames: Frame[] = [
    ...(!machineLift && clearance !== null ? [liftFrame] : []),
    ...groups.map((g) => g.frame),
    ...(pos.z !== null ? [frameOf('z')] : []),
  ]
  const first = frames.find((f): f is number => typeof f === 'number') ?? frameAt
  let emitted: number | null = first
  const inFrame = (f: Frame) => {
    if (typeof f === 'number' && f !== emitted) {
      prelude.push(`G${f}`)
      emitted = f
    }
  }
  const inOther = (f: Frame) => (typeof f === 'number' && f !== frameAt ? ` in G${f}` : '')

  if (machineLift) {
    // The safe Z is a millimetre machine coordinate: lift in G21, then put
    // the program's units back. G53 is absolute in any distance mode.
    prelude.push('G21', 'G90')
    // Never command machine zero. If live Z is already zero and above the
    // authored safe height, keep it there for XY without a redundant Z move.
    if (fmt(safeZ) !== 0) {
      prelude.push(`G53 G0 Z${fmt(safeZ)}`)
      lastMotion = 'G0'
    }
    if (units === 'G20') prelude.push('G20')
    warnings.push(`The tool ${fmt(safeZ) === 0 ? 'stays at' : 'lifts to'} machine Z${fmt(safeZ)} (${safeZ === authoredSafeZ ? "this machine's safe Z" : 'the higher current Z'}) before any X/Y move.`)
  } else {
    prelude.push(units)
    prelude.push('G90')
  }
  // WO-2243: a return inside a G93 program comes down at the capped feed in
  // millimetres per minute - under G93 that F would be a time - and G93 goes
  // back on for the rest of the move (a G93 the line names comes with it).
  const lineG = resumeAt ? gCodesOf(tokenizeLine(stripGcodeComments(rawLines[resumeAt.line - 1] ?? ''), resumeAt.line)) : []
  const inverseTime = resumeAt !== undefined && state.inverseTime
  if (inverseTime || lineG.includes(93)) prelude.push('G94')
  if (first !== null) prelude.push(`G${first}`)
  // Audit 10: the plane gives an arc (inherited or named) and its centre
  // words their meaning - put back the one the program selected.
  if (state.plane !== null) prelude.push(`G${state.plane}`)
  // WO-2244: so are absolute arc centres (G90.1) - a slice read from its own
  // first line starts in offsets from each arc start.
  if (state.arcCentreAbsolute) prelude.push('G90.1')
  // WO-2237: the rest of an interrupted move is cut with the tool in the
  // spindle now, at its own length.
  const toolNow = resumeAt ? options.toolNow ?? null : null
  const comp = state.lengthComp?.kind === 'G43' && toolNow !== null && state.lengthComp.h !== toolNow
    ? { kind: 'G43' as const, h: toolNow }
    : state.lengthComp
  if (comp !== null) {
    const words = comp.kind === 'G43'
      ? (comp.h !== null ? `G43 H${comp.h}` : 'G43')
      : `G43.1 Z${fmt(inUnits(comp.zMm) as number)}`
    prelude.push(words)
    warnings.push(`The program's tool length offset is applied again (${words}).`)
  }
  if (!machineLift) {
    if (clearance !== null) {
      inFrame(liftFrame)
      prelude.push(`G0 Z${fmt(clearance)}`)
      lastMotion = 'G0'
      warnings.push(
        `The tool moves to Z${fmt(clearance)} - the highest Z the program used${inOther(liftFrame)} before this line - before any X/Y move.`,
      )
    } else {
      warnings.push(
        "The program sets no Z before this line, so X/Y move at the machine's current Z, as the program itself would.",
      )
    }
  }

  const spindle = spindleWord.replace(/[^A-Z0-9]/g, '')
  const spindleOn = spindle === 'M3' || spindle === 'M03' || spindle === 'M4' || spindle === 'M04'
  if (spindleOn) {
    const rpm = end.spindle ?? 0
    if (rpm > 0) {
      prelude.push(`${spindle.length === 3 ? spindle.replace('0', '') : spindle} S${rpm}`)
      warnings.push(`The spindle will START (${rpm} rpm) before motion begins.`)
    } else {
      warnings.push('The program had the spindle on with no S value - it will NOT be restarted; start it manually if needed.')
    }
  }
  // WO-1650: every output that was on at that line, not only the last M7/M8.
  const outputsOn = outputsOnBefore(rawLines, startLine - 1, options)
  // WO-2237: what the operator switched during the stop goes back to the
  // program's own state - off where the program had it off.
  if (resumeAt && !spindleOn) prelude.push('M5')
  if (resumeAt && outputsOn.length === 0) prelude.push('M9')
  prelude.push(...outputsOn)

  // Positioning: X/Y (and any rotary the program set) at the lifted height,
  // then down to the resume Z.
  for (const group of groups) {
    const them = group.letters.join(' and ')
    if (group.frame === 'G53') {
      prelude.push(`G53 G0 ${group.words.join(' ')}`)
      warnings.push(`${them} ${group.letters.length === 1 ? 'goes' : 'go'} back to machine ${group.words.join(' ')}, where the program left ${group.letters.length === 1 ? 'it' : 'them'} (G53).`)
    } else {
      inFrame(group.frame)
      prelude.push(`G0 ${group.words.join(' ')}`)
      if (group.frame !== frameAt) {
        warnings.push(`${them} ${group.letters.length === 1 ? 'goes' : 'go'} back to ${group.words.join(' ')}${inOther(group.frame)}, where the program set ${group.letters.length === 1 ? 'it' : 'them'} before it changed to G${frameAt}.`)
      }
    }
    lastMotion = 'G0'
  }
  const why = (letter: string, lostAt: number | null): 'machine' | 'frame' | 'unplaced' =>
    state.frameLostAt.has(letter) ? 'frame' : lostAt !== null ? 'machine' : 'unplaced'
  const lostSentence = (a: Axis) => {
    const reason = why(a.toUpperCase(), state.lostAt[a])
    return `${a.toUpperCase()} is not set in work coordinates at that line` +
      (reason === 'machine' ? ` (line ${state.lostAt[a]} left it at a machine position)`
        : reason === 'frame' ? ` (it was placed before line ${state.frameLostAt.get(a.toUpperCase())} selected a work offset)` : '')
  }
  for (const a of ['x', 'y'] as const) {
    if (pos[a] === null && state.lostAt[a] === null) {
      warnings.push(`${lostSentence(a)} - it stays where it is.`)
    }
  }
  // WO-2243: under G93 the program's last F is a time, not a speed.
  const plungeFeed = inverseTime || lineG.includes(93)
    ? PLUNGE_FEED_CAP
    : Math.min(PLUNGE_FEED_CAP, end.feed && end.feed > 0 ? end.feed : PLUNGE_FEED_CAP)
  if (pos.z !== null) {
    // Every known Z raised the clearance in its own offset, so it is set
    // whenever Z is.
    const at = clearance as number
    inFrame(frameOf('z'))
    if (machineLift) {
      prelude.push(`G0 Z${fmt(at)}`)
      lastMotion = 'G0'
    }
    if (pos.z < at) {
      // WO-2237: the whole way down to a pause point is at the capped feed -
      // the point may be inside the cut, whatever sign its Z has.
      if (pos.z < 0 || resumeAt) {
        prelude.push(`G1 Z${fmt(pos.z)} F${plungeFeed}`)
        lastMotion = 'G1'
        warnings.push(`Then the tool plunges to Z${fmt(pos.z)} at F${plungeFeed}${inOther(frameOf('z'))}.`)
      } else {
        prelude.push(`G0 Z${fmt(pos.z)}`)
        lastMotion = 'G0'
      }
    }
  }
  // Audit 10: every Z sentence is read from the prelude's own last Z move -
  // the machine safe-Z lift, the program's clearance, or none.
  const zRest = pos.z === null ? lastZMove(prelude, frameAt) : null
  if (pos.z === null) {
    warnings.push(`${lostSentence('z')} - the tool stays ${zRest ?? 'where it is'}.`)
  }
  inFrame(frameAt)

  // Restore the feed and the modal motion group so the first streamed line
  // can rely on them. When the approach ended on G0 but the program resumes in
  // modal G1, the feed line carries the G1 to re-arm it (a motion word with
  // an F and no axis words sets modal state without moving).
  if (end.feed && end.feed > 0) {
    if (end.motion === 'G1' && lastMotion !== 'G1') prelude.push(`G1 F${fmt(end.feed)}`)
    else prelude.push(`F${fmt(end.feed)}`)
  }
  if (end.motion === 'G0' && lastMotion === 'G1') prelude.push('G0')

  // An arc mode a line relies on is written onto that line when the slice
  // loads (applyResumeMotion) - GRBL takes no bare G2/G3 in the prelude.
  // WO-2237: the rest of an interrupted move names its own motion word, and
  // every later line inherits it from there.
  const reliesOn = resumeAt === undefined && (end.motion === 'G2' || end.motion === 'G3' || state.cycle !== null)
    ? lineRelyingOnMotion(rawLines, startLine)
    : null
  let resumeMotion: RunFromLinePlan['resumeMotion'] = null
  if (reliesOn !== null && state.cycle !== null) {
    // Audit 14: a bare X/Y repeat of a canned cycle drills only while that
    // cycle is modal - it is re-armed on the line (the line's own words win).
    const own = tokenizeLine(stripGcodeComments(rawLines[reliesOn - 1]), reliesOn)
    const sticky = CYCLE_WORDS.filter((l) => state.cycle!.words[l] !== undefined && wordOf(own, l) === null)
      .map((l) => `${l}${fmt(state.cycle!.words[l])}`)
    const word = [`G${state.cycle.retract}`, `G${state.cycle.code}`, ...sticky].join(' ')
    resumeMotion = { line: reliesOn, word }
    warnings.push(`Line ${reliesOn} repeats the program's G${state.cycle.code} cycle, so it is sent with ${word}.`)
  } else if (reliesOn !== null) {
    resumeMotion = { line: reliesOn, word: end.motion as 'G2' | 'G3' }
    warnings.push(`Line ${resumeMotion.line} continues the program's ${resumeMotion.word} arc mode, so it is sent as ${resumeMotion.word}.`)
  }
  if (inverseTime) prelude.push('G93')
  // The approach runs in G90; the program's own G91 goes back on last.
  if (state.incremental) {
    prelude.push('G91')
    warnings.push('The program is in incremental mode (G91) at that line - the approach runs in G90, then G91 goes back on.')
  }

  // An axis left at a machine position, or never placed before the line
  // (e.g. incremental moves only), is not set up - said the way the prelude
  // leaves it, never promised (audit 9). Z joins X/Y only when the prelude
  // moves no Z; otherwise it has its own line saying where it stays.
  const notSetUpAxes = (axes: string[], why: (one: boolean) => string, rest: string | null) => {
    if (axes.length === 0) return
    const one = axes.length === 1
    const stays = rest === null ? (one ? 'it stays where it is' : 'they stay where they are') : `${one ? 'it stays' : 'they stay'} ${rest}`
    notSetUp.push(`Not set up: ${axes.join(' and ')} - ${why(one)}; ${stays} until the program moves ${one ? 'it' : 'them'}.`)
  }
  const zWithXY = zRest === null
  type Why = ReturnType<typeof why>
  const unknown = (reason: Why) => [
    ...(zWithXY ? AXES : (['x', 'y'] as const))
      .filter((a) => state.pos[a] === null && !atMachine(a) && why(a.toUpperCase(), state.lostAt[a]) === reason)
      .map((a) => a.toUpperCase()),
    // A rotary axis is unknown only when left at a machine position or lost
    // with the offset it was set in.
    ...(reason === 'unplaced' ? [] : [...state.rotary]
      .filter(([a, v]) => v === null && why(a, 0) === reason).map(([a]) => a)),
  ]
  const lostWhy = () => `left at a machine position before line ${startLine}`
  const frameLine = [...state.frameLostAt.values()][0]
  const frameWhy = (one: boolean) =>
    `the program placed ${one ? 'it' : 'them'} before line ${frameLine} selected a work offset, in the one the controller had then`
  const unplacedWhy = (one: boolean) => `the program has not placed ${one ? 'it' : 'them'} before line ${startLine}`
  const whyText = { machine: lostWhy, frame: frameWhy, unplaced: unplacedWhy }
  for (const reason of ['machine', 'frame', 'unplaced'] as const) notSetUpAxes(unknown(reason), whyText[reason], null)
  if (!zWithXY && state.pos.z === null) {
    notSetUpAxes(['Z'], whyText[why('Z', state.lostAt.z)], zRest)
  }

  return {
    ok: true,
    plan: {
      prelude,
      requestedLine,
      startLine,
      resumePosition: { x: pos.x, y: pos.y, z: pos.z },
      zRest,

      tool: state.tool,
      warnings,
      notSetUp,
      resumeMotion,
      ...(resumeAt ? { resumeAt } : {}),
    },
  }
}

// ---- WO-2237: back to the point a pause stopped the program at -------------
//
// Operator ruling 2026-09-29: "It essentially needs to save its place and perform the
// tasks that I'm asking and then it can resume from where the pause was." A
// pause the operator moved out of is a kept stop; CYCLE START goes back to the
// point (the run-from prelude: safe Z, X/Y, down at the capped feed) and
// finishes the interrupted move from there. The point is put ON the program's
// own path - the reported position projected onto the move - so the rest of
// the move is the same line or arc, from exactly there.

type Point3 = Record<Axis, number>
/** WO-2243: the rotary axes of a point, degrees, lower-case as a controller
 *  reports them (MachinePosition). */
type RotaryKey = 'a' | 'b' | 'c'
type PausePoint = Point3 & Partial<Record<RotaryKey, number>>
const rotaryKey = (a: RotaryLetter) => a.toLowerCase() as RotaryKey

/** WO-2243: a rotary axis the line turns, degrees in the line's offset. */
type RotaryTurn = { axis: RotaryLetter; from: number; to: number }

/** The move one line commands, in millimetres in the line's own offset. */
type LineMove =
  | { kind: 'line'; motion: 0 | 1; from: Point3; to: Point3; rotary: RotaryTurn[] }
  | {
      kind: 'arc'
      motion: 2 | 3
      from: Point3
      to: Point3
      centre: Point3
      /** WO-2244: the line's centre words are the centre itself (G90.1). */
      centreAbsolute: boolean
      /** In-plane axes (first, second) and the linear one, as G17/G18/G19 name them. */
      axes: readonly [Axis, Axis, Axis]
      /** Angle travelled from the start to the end, radians, > 0 - more than
       *  a turn for a helix with a P (WO-2244). */
      sweep: number
      rotary: RotaryTurn[]
    }
  | {
      /** WO-2241: a canned-cycle line (G73, G81-G89, named or repeated).
       *  Each hole: where its cycle starts - the return ends there - and the
       *  path the tool takes through it (across, down, back up). */
      kind: 'cycle'
      code: number
      retract: 98 | 99
      holes: Array<{ start: Point3; path: Point3[] }>
      /** The repeat word (L, or K) and how many the line drills; null: once. */
      repeat: { letter: 'L' | 'K'; count: number } | null
      /** The cycle's sticky words the line relies on without naming them. */
      sticky: Record<string, number>
    }

const PLANE_AXES: Record<17 | 18 | 19, readonly [Axis, Axis, Axis]> = {
  17: ['x', 'y', 'z'],
  18: ['z', 'x', 'y'],
  19: ['y', 'z', 'x'],
}
const CENTRE_WORD: Record<Axis, 'I' | 'J' | 'K'> = { x: 'I', y: 'J', z: 'K' }
const TWO_PI = Math.PI * 2

/** An angle brought into [0, 2 pi). */
function turn(a: number): number {
  const r = a % TWO_PI
  return r < 0 ? r + TWO_PI : r
}

/** The move a line makes from the state in force before it, or why this line
 *  has no single move a pause point can be put on (the caller then starts the
 *  line from its beginning). */
type LineMoveResult =
  | { ok: true; move: LineMove; incremental: boolean; words: GcodeLine['words'] }
  | { ok: false; reason: string }

function lineMoveOf(raw: string, lineNo: number, start: LineStart): LineMoveResult {
  const code = stripGcodeComments(raw)
  const no = (reason: string) => ({ ok: false as const, reason: `line ${lineNo} ${reason}` })
  if (/[#[\]]/.test(code)) return no('uses expressions or parameters')
  const line = tokenizeLine(code, lineNo)
  const g = gCodesOf(line)
  if ((g.includes(20) && !start.inch) || (g.includes(21) && start.inch)) return no('changes units')
  if (g.some((c) => c >= 54 && c <= 59 && c !== start.wcs)) return no('changes the work offset')
  if (g.some((c) => leavesMachinePosition(c) || DATA_AXIS_G.has(c) || c === 43 || c === 49 || c === 92.3)) {
    return no('is not a plain move')
  }
  const named = g.filter((c) => c === 0 || c === 1 || c === 2 || c === 3).at(-1)
  if (g.includes(80) && named === undefined) return no('has no move')
  const cycleCode = g.find((c) => c === 73 || (c >= 81 && c <= 89))
  if (cycleCode !== undefined && named !== undefined) return no('names a canned cycle and a move together')
  if (cycleCode !== undefined || (named === undefined && start.cycle !== null)) {
    return cycleMoveOf(line, g, cycleCode ?? start.cycle!.code, start, no)
  }
  const motion = named ?? start.motion
  if (motion !== 0 && motion !== 1 && motion !== 2 && motion !== 3) return no('has no move')
  if (hasM(line, [6])) return no('changes the tool')
  // WO-2244: a helix's P is how many turns it makes (LinuxCNC): P1 is the arc
  // as written, each one more a full turn.
  const turns = motion >= 2 ? wordOf(line, 'P') ?? 1 : 1
  if (!(Number.isInteger(turns) && turns >= 1)) return no('is an arc this cannot resume inside')
  const centreAbsolute = g.includes(90.1) ? true : g.includes(91.1) ? false : start.arcCentreAbsolute
  const incremental = g.includes(91) ? true : g.includes(90) ? false : start.incremental
  const mm = (v: number) => (start.inch ? v * 25.4 : v)
  const from = {} as Point3
  for (const a of AXES) {
    const v = start.pos[a]
    if (v === null || start.frameOf[a] !== start.wcs) return no(`starts where ${a.toUpperCase()} is not known`)
    from[a] = v
  }
  const to = { ...from }
  let moves = false
  for (const a of AXES) {
    const v = wordOf(line, a.toUpperCase())
    if (v === null) continue
    moves = true
    to[a] = incremental ? from[a] + mm(v) : mm(v)
  }
  // WO-2243: a rotary axis turns along the same move, from where the line
  // starts it (degrees, whatever the units).
  const rotary: RotaryTurn[] = []
  for (const a of ROTARY) {
    const v = wordOf(line, a)
    if (v === null) continue
    const at = start.rotary[a]
    if (at === null) return no(`starts where ${a} is not known`)
    rotary.push({ axis: a, from: at, to: incremental ? at + v : v })
    moves = true
  }
  if (motion <= 1) {
    if (!moves) return no('has no move')
    return { ok: true, move: { kind: 'line', motion: motion as 0 | 1, from, to, rotary }, incremental, words: line.words }
  }
  const plane = ([17, 18, 19] as const).find((p) => g.includes(p)) ?? start.plane ?? 17
  const axes = PLANE_AXES[plane]
  const [a1, a2] = axes
  const centre = { ...from }
  const r = wordOf(line, 'R')
  if (r !== null) {
    // The R-form centre, as GRBL finds it (gcode.c): the chord's perpendicular.
    const dx = to[a1] - from[a1]
    const dy = to[a2] - from[a2]
    const radius = mm(r)
    const chord = Math.hypot(dx, dy)
    if (chord === 0) return no('is an R arc with no chord')
    const h2 = 4 * radius * radius - dx * dx - dy * dy
    let h = -Math.sqrt(Math.max(0, h2)) / chord
    if (motion === 3) h = -h
    if (radius < 0) h = -h
    centre[a1] = from[a1] + 0.5 * (dx - dy * h)
    centre[a2] = from[a2] + 0.5 * (dy + dx * h)
  } else if (centreAbsolute) {
    // WO-2244: G90.1 - the centre words are the centre itself, in the line's
    // offset; one left out is the start's (as the gcode reader reads it).
    for (const a of [a1, a2]) {
      const v = wordOf(line, CENTRE_WORD[a])
      centre[a] = v === null ? from[a] : mm(v)
    }
  } else {
    centre[a1] = from[a1] + mm(wordOf(line, CENTRE_WORD[a1]) ?? 0)
    centre[a2] = from[a2] + mm(wordOf(line, CENTRE_WORD[a2]) ?? 0)
  }
  const aStart = Math.atan2(from[a2] - centre[a2], from[a1] - centre[a1])
  const aEnd = Math.atan2(to[a2] - centre[a2], to[a1] - centre[a1])
  const closed = Math.hypot(to[a1] - from[a1], to[a2] - from[a2]) < 1e-9
  const sweep = (closed ? TWO_PI : motion === 2 ? turn(aStart - aEnd) : turn(aEnd - aStart)) + (turns - 1) * TWO_PI
  if (!(sweep > 0)) return no('is an arc with no sweep')
  return {
    ok: true,
    move: { kind: 'arc', motion: motion as 2 | 3, from, to, centre, centreAbsolute, axes, sweep, rotary },
    incremental,
    words: line.words,
  }
}

/**
 * WO-2241: a canned-cycle line as the holes it drills, the way the gcode
 * reader and LinuxCNC run it: Z up to R first when it starts below, across at
 * that level, down to R and the depth, back to the level the cycle started
 * from (G98) or to R (G99). In G91 R is measured from the Z the line starts at
 * and the depth from R, and each repeat (L) steps by the line's X/Y; in G90 the
 * repeats drill the same hole. Operator ruling 2026-09-30: "jump back to the start of
 * the cycle that it was only partially through completing" - each hole's
 * `start` is where that cycle starts, and the return ends there.
 */
function cycleMoveOf(
  line: GcodeLine,
  g: number[],
  code: number,
  start: LineStart,
  no: (reason: string) => { ok: false; reason: string },
): LineMoveResult {
  if (ROTARY.some((a) => wordOf(line, a) !== null)) return no('moves a rotary axis')
  if (hasM(line, [6])) return no('changes the tool')
  const plane = ([17, 18, 19] as const).find((p) => g.includes(p)) ?? start.plane ?? 17
  if (plane !== 17) return no('is a canned cycle outside the XY plane')
  const named = g.some((c) => c === 73 || (c >= 81 && c <= 89))
  // A repeat drills only on a line with an axis word, as the reader runs it.
  if (!named && !AXES.some((a) => wordOf(line, a.toUpperCase()) !== null)) return no('has no move')
  const incremental = g.includes(91) ? true : g.includes(90) ? false : start.incremental
  const mm = (v: number) => (start.inch ? v * 25.4 : v)
  const from = {} as Point3
  for (const a of AXES) {
    const v = start.pos[a]
    if (v === null || start.frameOf[a] !== start.wcs) return no(`starts where ${a.toUpperCase()} is not known`)
    from[a] = v
  }
  const carried = start.cycle?.words ?? {}
  const r = wordOf(line, 'R') ?? carried.R ?? null
  const z = wordOf(line, 'Z') ?? carried.Z ?? null
  if (r === null || z === null) return no('is a canned cycle with no R plane or depth')
  const rZ = incremental ? from.z + mm(r) : mm(r)
  const depth = incremental ? rZ + mm(z) : mm(z)
  if (!(depth < rZ)) return no('is a canned cycle whose depth is not below its R plane')
  const retract: 98 | 99 = g.includes(98) ? 98 : g.includes(99) ? 99 : start.retract
  const level = Math.max(from.z, rZ)
  const rest = retract === 98 ? level : rZ
  // G87 (back boring) reads K as a depth; elsewhere K is a repeat count.
  const l = wordOf(line, 'L')
  const k = code === 87 ? null : wordOf(line, 'K')
  const repeat = l !== null ? { letter: 'L' as const, count: l } : k !== null ? { letter: 'K' as const, count: k } : null
  if (repeat !== null && !(Number.isInteger(repeat.count) && repeat.count >= 1)) return no('has a repeat count this cannot follow')
  const x = wordOf(line, 'X')
  const y = wordOf(line, 'Y')
  const holes: Array<{ start: Point3; path: Point3[] }> = []
  let prev = { x: from.x, y: from.y }
  for (let i = 0; i < (incremental ? repeat?.count ?? 1 : 1); i++) {
    const p = incremental
      ? { x: prev.x + mm(x ?? 0), y: prev.y + mm(y ?? 0) }
      : { x: x === null ? from.x : mm(x), y: y === null ? from.y : mm(y) }
    const path = i === 0
      ? [{ ...from }, { x: from.x, y: from.y, z: level }, { ...p, z: level }]
      : [{ ...prev, z: rest }, { ...p, z: rest }]
    path.push({ ...p, z: depth }, { ...p, z: rest })
    // In G91 the cycle starts where the line (or the repeat before) left the
    // tool - its X/Y and R are measured from there.
    holes.push({ start: incremental ? { ...prev, z: from.z } : { ...p, z: level }, path })
    prev = p
  }
  const sticky: Record<string, number> = {}
  for (const w of CYCLE_WORDS) if (carried[w] !== undefined && wordOf(line, w) === null) sticky[w] = carried[w]
  return {
    ok: true,
    move: { kind: 'cycle', code, retract, holes, repeat, sticky },
    incremental,
    words: line.words,
  }
}

/**
 * WO-2242: a line whose job is a tool change - M6, with no axis word and no
 * machine-position move. The program stands still while it runs, so a pause
 * inside it stopped where the line starts; `tool` is the one it fits (its T,
 * or the last T before it). Null for any other line.
 */
function toolChangeLineOf(raw: string, lineNo: number, start: LineStart): { tool: number | null; point: Point3 } | null {
  const code = stripGcodeComments(raw)
  if (/[#[\]]/.test(code)) return null
  const line = tokenizeLine(code, lineNo)
  if (!hasM(line, [6])) return null
  if ([...AXES.map((a) => a.toUpperCase()), ...ROTARY].some((l) => wordOf(line, l) !== null)) return null
  const g = gCodesOf(line)
  if ((g.includes(20) && !start.inch) || (g.includes(21) && start.inch)) return null
  if (g.some((c) => (c >= 54 && c <= 59 && c !== start.wcs) || leavesMachinePosition(c))) return null
  const point = {} as Point3
  for (const a of AXES) {
    const v = start.pos[a]
    if (v === null || start.frameOf[a] !== start.wcs) return null
    point[a] = v
  }
  const tool = wordOf(line, 'T') ?? start.selected
  return { tool: tool !== null && Number.isInteger(tool) && tool >= 0 ? tool : null, point }
}

/** The point of segment a-b nearest `at`, and how far along it (0-1). */
function nearestOnSegment(a: Point3, b: Point3, at: Point3): { point: Point3; t: number } {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const len2 = d.x * d.x + d.y * d.y + d.z * d.z
  const t = len2 === 0
    ? 0
    : Math.min(1, Math.max(0, ((at.x - a.x) * d.x + (at.y - a.y) * d.y + (at.z - a.z) * d.z) / len2))
  return { point: { x: a.x + t * d.x, y: a.y + t * d.y, z: a.z + t * d.z }, t }
}

/** Less arc than this left after the point is finished as a straight line to
 *  the end: an arc written from its own end point runs as a full circle. */
const ARC_REST_AS_LINE_MM = 0.01

/** WO-2243: the rotary axes a move has turned to `f` (0-1) of the way along,
 *  and how far (degrees) the reported ones are from there. */
function turnedAt(rotary: readonly RotaryTurn[], f: number, at: PausePoint): { turned: Partial<Record<RotaryKey, number>>; off: number } {
  const turned: Partial<Record<RotaryKey, number>> = {}
  let off2 = 0
  for (const r of rotary) {
    const v = r.from + f * (r.to - r.from)
    turned[rotaryKey(r.axis)] = v
    const reported = at[rotaryKey(r.axis)]
    if (reported !== undefined && Number.isFinite(reported)) off2 += (reported - v) ** 2
  }
  return { turned, off: Math.sqrt(off2) }
}

/** WO-2243: the point of a straight move nearest `at`, every axis it moves
 *  together - X/Y/Z in millimetres and each rotary axis the controller
 *  reported, in degrees - so a move that only turns is placed by its turn. */
function nearestOnLine(move: Extract<LineMove, { kind: 'line' }>, at: PausePoint): { point: PausePoint; t: number; off: number } {
  const dims: Array<[number, number, number]> = AXES.map((a) => [move.from[a], move.to[a], at[a]])
  for (const r of move.rotary) {
    const reported = at[rotaryKey(r.axis)]
    if (reported !== undefined && Number.isFinite(reported)) dims.push([r.from, r.to, reported])
  }
  let len2 = 0
  let dot = 0
  for (const [f, e, p] of dims) {
    len2 += (e - f) ** 2
    dot += (p - f) * (e - f)
  }
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, dot / len2))
  const point: PausePoint = { x: 0, y: 0, z: 0 }
  for (const a of AXES) point[a] = move.from[a] + t * (move.to[a] - move.from[a])
  const { turned, off: offTurn } = turnedAt(move.rotary, t, at)
  const offXyz = Math.hypot(at.x - point.x, at.y - point.y, at.z - point.z)
  return { point: { ...point, ...turned }, t, off: Math.hypot(offXyz, offTurn) }
}

/** The point on a move nearest the reported one, how far off it was, and how
 *  much of an arc's turn is left after it. `atEnd`: the point is the move's end.
 *  `fraction`: how much of the move is done at the point (0-1). WO-2243: a
 *  rotary axis the move turns is part of the point, and a reported one off the
 *  move's turn counts as off the path (a degree as a millimetre). */
function pointOnMove(
  move: LineMove,
  at: PausePoint,
): { point: PausePoint; offPathMm: number; atEnd: boolean; arcLeftMm: number; fraction: number; hole?: number } {
  const off = (q: Point3) => Math.hypot(at.x - q.x, at.y - q.y, at.z - q.z)
  if (move.kind === 'line') {
    const { point, t, off: offPath } = nearestOnLine(move, at)
    return { point, offPathMm: offPath, atEnd: t >= 1, arcLeftMm: 0, fraction: t }
  }
  if (move.kind === 'cycle') {
    // WO-2241: the hole whose path passes nearest (a later one on a tie - the
    // start of one hole's cycle is where the one before it ended), and the
    // point is the start of that hole's cycle. A hole's own start - a kept
    // stop's point, planned again - is that hole.
    const last = move.holes.length - 1
    for (let i = last; i >= 0; i--) {
      if (off(move.holes[i].start) < 1e-6) return { point: { ...move.holes[i].start }, offPathMm: 0, atEnd: false, arcLeftMm: 0, fraction: 0, hole: i }
    }
    let best = { d: Infinity, hole: 0, atEnd: false }
    move.holes.forEach((hole, i) => {
      for (let s = 1; s < hole.path.length; s++) {
        const q = nearestOnSegment(hole.path[s - 1], hole.path[s], at)
        const d = off(q.point)
        if (d <= best.d + 1e-9) best = { d, hole: i, atEnd: i === last && s === hole.path.length - 1 && q.t >= 1 }
      }
    })
    return { point: { ...move.holes[best.hole].start }, offPathMm: best.d, atEnd: best.atEnd, arcLeftMm: 0, fraction: 0, hole: best.hole }
  }
  const [a1, a2, lin] = move.axes
  const c = move.centre
  const radius = Math.hypot(move.from[a1] - c[a1], move.from[a2] - c[a2])
  const aStart = Math.atan2(move.from[a2] - c[a2], move.from[a1] - c[a1])
  const aAt = Math.atan2(at[a2] - c[a2], at[a1] - c[a1])
  const cw = move.motion === 2
  if (move.sweep > TWO_PI + 1e-9) return pointOnTurns(move, at, radius, aStart, aAt)
  let travelled = cw ? turn(aStart - aAt) : turn(aAt - aStart)
  if (travelled > move.sweep) {
    // Outside the arc's span: the nearer end.
    const past = travelled - move.sweep
    travelled = past < TWO_PI - travelled ? move.sweep : 0
  }
  if (move.sweep === TWO_PI && radius * Math.min(travelled, TWO_PI - travelled) < ARC_REST_AS_LINE_MM) {
    // A full circle's seam is both its start and its end: a helix tells them
    // apart by the linear axis; a flat circle is taken as its start (cut again,
    // never skipped).
    const toEnd = Math.abs(at[lin] - move.to[lin]) < Math.abs(at[lin] - move.from[lin])
    travelled = toEnd ? move.sweep : 0
  }
  const f = travelled / move.sweep
  const arcLeftMm = radius * (move.sweep - travelled)
  if (f >= 1) {
    const end = turnedAt(move.rotary, 1, at)
    return { point: { ...move.to, ...end.turned }, offPathMm: Math.hypot(off(move.to), end.off), atEnd: true, arcLeftMm: 0, fraction: 1 }
  }
  const angle = cw ? aStart - travelled : aStart + travelled
  const point = { ...move.from }
  point[a1] = c[a1] + radius * Math.cos(angle)
  point[a2] = c[a2] + radius * Math.sin(angle)
  point[lin] = move.from[lin] + f * (move.to[lin] - move.from[lin])
  const { turned, off: offTurn } = turnedAt(move.rotary, f, at)
  return { point: { ...point, ...turned }, offPathMm: Math.hypot(off(point), offTurn), atEnd: false, arcLeftMm, fraction: f }
}

/** WO-2244: the point on a helix of more than one turn (a P word) nearest the
 *  reported one. The angle names a place on every turn; the turn is the one
 *  whose height (the linear axis) is nearest - the earliest on a tie, so a
 *  flat circle cut more than once is cut again, never skipped. A point within
 *  ARC_REST_AS_LINE_MM of the end's angle is put on it exactly: the rest is
 *  then whole turns, never a sliver a rounded start could make one turn more. */
function pointOnTurns(
  move: Extract<LineMove, { kind: 'arc' }>,
  at: PausePoint,
  radius: number,
  aStart: number,
  aAt: number,
): ReturnType<typeof pointOnMove> {
  const [a1, a2, lin] = move.axes
  const c = move.centre
  const cw = move.motion === 2
  const off = (q: Point3) => Math.hypot(at.x - q.x, at.y - q.y, at.z - q.z)
  const endAngle = turn(move.sweep) > TWO_PI - 1e-9 ? 0 : turn(move.sweep)
  let angleAt = cw ? turn(aStart - aAt) : turn(aAt - aStart)
  const onEnd = radius * Math.min(turn(angleAt - endAngle), turn(endAngle - angleAt)) < ARC_REST_AS_LINE_MM
  if (onEnd) angleAt = endAngle
  const candidates: Array<{ travelled: number; point: Point3 }> = [
    { travelled: 0, point: { ...move.from } },
    { travelled: move.sweep, point: { ...move.to } },
  ]
  for (let t = angleAt; t < move.sweep - 1e-9; t += TWO_PI) {
    const point = { ...move.from }
    const angle = cw ? aStart - t : aStart + t
    point[a1] = onEnd ? move.to[a1] : c[a1] + radius * Math.cos(angle)
    point[a2] = onEnd ? move.to[a2] : c[a2] + radius * Math.sin(angle)
    point[lin] = move.from[lin] + (t / move.sweep) * (move.to[lin] - move.from[lin])
    candidates.push({ travelled: t, point })
  }
  candidates.sort((p, q) => p.travelled - q.travelled)
  let best = candidates[0]
  for (const k of candidates) if (off(k.point) < off(best.point) - 1e-9) best = k
  if (best.travelled >= move.sweep - 1e-9) {
    const end = turnedAt(move.rotary, 1, at)
    return { point: { ...move.to, ...end.turned }, offPathMm: Math.hypot(off(move.to), end.off), atEnd: true, arcLeftMm: 0, fraction: 1 }
  }
  const f = best.travelled / move.sweep
  const { turned, off: offTurn } = turnedAt(move.rotary, f, at)
  return {
    point: { ...best.point, ...turned },
    offPathMm: Math.hypot(off(best.point), offTurn),
    atEnd: false,
    arcLeftMm: radius * (move.sweep - best.travelled),
    fraction: f,
  }
}

/** WO-2244: the P (turns) the rest of a helix from `point` is written with:
 *  the turn the controller reads from the point to the end - all of one when
 *  they are the same place - and one more for each full turn left after it. */
function turnsLeft(move: Extract<LineMove, { kind: 'arc' }>, point: Point3, arcLeftMm: number): number {
  const [a1, a2] = move.axes
  const c = move.centre
  const radius = Math.hypot(move.from[a1] - c[a1], move.from[a2] - c[a2])
  const aPoint = Math.atan2(point[a2] - c[a2], point[a1] - c[a1])
  const aEnd = Math.atan2(move.to[a2] - c[a2], move.to[a1] - c[a1])
  const closed = Math.hypot(move.to[a1] - point[a1], move.to[a2] - point[a2]) < 1e-9
  const first = closed ? TWO_PI : move.motion === 2 ? turn(aPoint - aEnd) : turn(aEnd - aPoint)
  return Math.max(1, Math.round((arcLeftMm / radius - first) / TWO_PI) + 1)
}

/** The interrupted line written as the rest of its move from `point`: its own
 *  words, with the end (absolute, or the distance left in G91) and an arc's
 *  centre measured from the point. An arc with (almost) nothing left is a
 *  straight G1 to its end - never an arc whose start is its end. */
function restOfLine(
  words: GcodeLine['words'],
  move: Exclude<LineMove, { kind: 'cycle' }>,
  point: PausePoint,
  arcLeftMm: number,
  incremental: boolean,
  inch: boolean,
  inverseTimeLeft: number | null,
): string {
  const units = (vMm: number) => Number((inch ? vMm / 25.4 : vMm).toFixed(inch ? 5 : 4))
  const say = (w: GcodeLine['words'][number]) => {
    if (Number.isNaN(w.value)) return w.letter
    // WO-2243: under G93 the F is the time for the whole move - the rest
    // takes its share of that time, at the program's own speed.
    if (w.letter === 'F' && inverseTimeLeft !== null) return `F${Number((w.value / inverseTimeLeft).toFixed(4))}`
    return `${w.letter}${w.value}`
  }
  const out: string[] = []
  const lineNumber = words.find((w) => w.letter === 'N')
  if (lineNumber) out.push(say(lineNumber))
  for (const w of words) {
    if (w.letter === 'G' && !Number.isNaN(w.value) && ![0, 1, 2, 3].includes(w.value)) out.push(say(w))
  }
  const asArc = move.kind === 'arc' && arcLeftMm >= ARC_REST_AS_LINE_MM
  out.push(move.kind === 'arc' && !asArc ? 'G1' : `G${move.motion}`)
  for (const a of AXES) out.push(`${a.toUpperCase()}${units(incremental ? move.to[a] - point[a] : move.to[a])}`)
  // WO-2243: each rotary axis the move turns, on to its end from the point.
  for (const r of move.rotary) {
    const at = point[rotaryKey(r.axis)] ?? r.from
    out.push(`${r.axis}${Number((incremental ? r.to - at : r.to).toFixed(4))}`)
  }
  if (move.kind === 'arc' && asArc) {
    // WO-2244: under G90.1 the centre words are the centre itself.
    for (const a of [move.axes[0], move.axes[1]]) {
      out.push(`${CENTRE_WORD[a]}${units(move.centreAbsolute ? move.centre[a] : move.centre[a] - point[a])}`)
    }
    // WO-2244: a helix of more than one turn keeps the turns left after the point.
    const turns = move.sweep > TWO_PI + 1e-9 ? turnsLeft(move, point, arcLeftMm) : 1
    if (turns > 1) out.push(`P${turns}`)
  }
  for (const w of words) {
    if (!['N', 'G', 'X', 'Y', 'Z', 'A', 'B', 'C', 'I', 'J', 'K', 'R'].includes(w.letter) && !(move.kind === 'arc' && w.letter === 'P')) out.push(say(w))
  }
  return out.join(' ')
}

/** WO-2241: the interrupted cycle line written to drill `hole` and the holes
 *  after it: its own words with the cycle named again (its G98/G99 and the
 *  sticky words it relied on, as a start on a repeat does - audit 14), and a
 *  G91 repeat count less the holes already drilled. */
function restOfCycle(words: GcodeLine['words'], move: Extract<LineMove, { kind: 'cycle' }>, hole: number): string {
  const say = (w: GcodeLine['words'][number]) => (Number.isNaN(w.value) ? w.letter : `${w.letter}${w.value}`)
  const cycleG = (v: number) => v === 73 || (v >= 80 && v <= 89) || v === 98 || v === 99
  const out: string[] = []
  const lineNumber = words.find((w) => w.letter === 'N')
  if (lineNumber) out.push(say(lineNumber))
  for (const w of words) if (w.letter === 'G' && !Number.isNaN(w.value) && !cycleG(w.value)) out.push(say(w))
  out.push(`G${move.retract}`, `G${move.code}`)
  for (const w of words) {
    if (w.letter !== 'N' && w.letter !== 'G' && w.letter !== move.repeat?.letter) out.push(say(w))
  }
  for (const [letter, v] of Object.entries(move.sticky)) out.push(`${letter}${Number(v.toFixed(4))}`)
  if (move.repeat !== null) out.push(`${move.repeat.letter}${move.holes.length > 1 ? move.repeat.count - hole : move.repeat.count}`)
  return out.join(' ')
}

/** The state before each of `lines`, from one walk of the program. */
function lineStarts(rawLines: string[], lines: readonly number[]): Map<number, LineStart> {
  const wanted = new Set(lines.filter((n) => Number.isInteger(n) && n >= 1 && n <= rawLines.length))
  const starts = new Map<number, LineStart>()
  if (wanted.size === 0) return starts
  walkPrefix(rawLines, Math.max(...wanted), { lines: wanted, at: (n, start) => starts.set(n, start) })
  return starts
}

/**
 * WO-2237: WHICH LINE THE PAUSE STOPPED INSIDE. `candidates` are the lines the
 * controller's own cursor points at, most likely first; the first whose move
 * passes within `toleranceMm` of the reported work position (mm, the line's
 * offset) is the one. Null when none does - the caller starts its best line
 * from the beginning instead.
 */
export function locatePausedLine(
  programText: string,
  candidates: readonly number[],
  atMm: PausePoint,
  toleranceMm: number,
): { line: number; pointMm: PausePoint; offPathMm: number } | null {
  const rawLines = programText.split(/\r?\n/)
  const starts = lineStarts(rawLines, candidates)
  // A match only at a candidate's end (the tool at or past it) gives way to a
  // later candidate the point is nearer: the move after it has begun.
  let atEnd: { line: number; pointMm: PausePoint; offPathMm: number } | null = null
  for (const line of candidates) {
    const start = starts.get(line)
    if (start === undefined) continue
    const found = lineMoveOf(rawLines[line - 1], line, start)
    // WO-2242: a tool change is where the program stood when it reached it.
    const change = found.ok ? null : toolChangeLineOf(rawLines[line - 1], line, start)
    if (!found.ok && change === null) continue
    const on = found.ok
      ? pointOnMove(found.move, atMm)
      : { point: change!.point, offPathMm: Math.hypot(atMm.x - change!.point.x, atMm.y - change!.point.y, atMm.z - change!.point.z), atEnd: false }
    if (on.offPathMm > toleranceMm) continue
    if (atEnd !== null) {
      // A program that finished the line before a tool change and stands at
      // it is inside the change: the move after it has not begun.
      if (on.offPathMm < atEnd.offPathMm || (change !== null && on.offPathMm <= atEnd.offPathMm)) {
        return { line, pointMm: on.point, offPathMm: on.offPathMm }
      }
      continue
    }
    if (!on.atEnd) return { line, pointMm: on.point, offPathMm: on.offPathMm }
    atEnd = { line, pointMm: on.point, offPathMm: on.offPathMm }
  }
  return atEnd
}

export type ResumeAtPointResult =
  | { ok: true; plan: RunFromLinePlan & { resumeAt: NonNullable<RunFromLinePlan['resumeAt']> }; offPathMm: number }
  | { ok: false; reason: string }

/**
 * WO-2237: THE RETURN TO A PAUSE POINT, AND THE REST OF THE PROGRAM FROM IT.
 * `atMm` is where the controller reported the tool when the pause became a
 * kept stop (work millimetres, the line's offset). The plan's prelude restores
 * the program's own state at that line - units, distance mode, offset, plane,
 * length offset, spindle, outputs, feed - lifts to safe Z, crosses in X/Y and
 * comes down to the point at the capped approach feed; the line itself is sent
 * as the rest of its move (`applyResumeMotion`). WO-2241: a canned-cycle line
 * goes back to the start of the hole's cycle it stopped in, not the point, and
 * drills that hole and the rest again. A line that is not one plain move (a
 * machine-coordinate move, a units or offset change) is refused here, and the
 * caller starts it from its beginning.
 */
export function buildResumeAtPointPlan(
  programText: string,
  line: number,
  atMm: PausePoint,
  options: RunFromLineOptions = {},
): ResumeAtPointResult {
  const rawLines = programText.split(/\r?\n/)
  if (!Number.isInteger(line) || line < 1 || line > rawLines.length) {
    return { ok: false, reason: `Line ${line} is outside the program (1-${rawLines.length}).` }
  }
  const start = lineStarts(rawLines, [line]).get(line)
  if (start === undefined) return { ok: false, reason: `Line ${line} is outside the program.` }
  const found = lineMoveOf(rawLines[line - 1], line, start)
  if (!found.ok) {
    if (isProgramStopLine(rawLines[line - 1])) return resumeAfterProgramStop(programText, rawLines, line, start, atMm, options)
    const change = toolChangeLineOf(rawLines[line - 1], line, start)
    if (change !== null) return resumeAtToolChange(programText, rawLines, line, start, change, atMm, options)
    return { ok: false, reason: `The pause point cannot be resumed inside ${found.reason}.` }
  }
  const on = pointOnMove(found.move, atMm)
  const inUnits = (v: number) => Number((start.inch ? v / 25.4 : v).toFixed(start.inch ? 5 : 4))
  const move = found.move
  // WO-2243: the rotary axes the line turns are part of the point (degrees).
  const turned: Partial<Record<RotaryKey, number>> = {}
  for (const r of move.kind === 'cycle' ? [] : move.rotary) {
    const v = on.point[rotaryKey(r.axis)]
    if (v !== undefined) turned[rotaryKey(r.axis)] = Number(v.toFixed(4))
  }
  const point = { x: inUnits(on.point.x), y: inUnits(on.point.y), z: inUnits(on.point.z), ...turned }
  // WO-2243: under G93 the rest of the move takes its share of the line's time.
  const left = 1 - on.fraction
  const g = gCodesOf(tokenizeLine(stripGcodeComments(rawLines[line - 1]), line))
  const lineInverseTime = g.includes(93) || (start.inverseTime && !g.includes(94) && !g.includes(95))
  const inverseTimeLeft = lineInverseTime && left >= 1e-3 ? left : null
  const text = move.kind === 'cycle'
    ? restOfCycle(found.words, move, on.hole ?? 0)
    : restOfLine(found.words, move, on.point, on.arcLeftMm, found.incremental, start.inch, inverseTimeLeft)
  const pointMm = { x: on.point.x, y: on.point.y, z: on.point.z, ...turned }
  const cycle = move.kind === 'cycle' ? { cycle: move.code } : {}
  const planned = planFrom(programText, line, options, { line, text, point, pointMm, ...cycle })
  if (!planned.ok) return planned
  const plan = planned.plan as RunFromLinePlan & { resumeAt: NonNullable<RunFromLinePlan['resumeAt']> }
  const where = `X${point.x} Y${point.y} Z${point.z}${ROTARY.map((a) => (turned[rotaryKey(a)] === undefined ? '' : ` ${a}${turned[rotaryKey(a)]}`)).join('')}`
  plan.warnings.unshift(
    move.kind === 'cycle'
      ? `CYCLE START goes back to ${where}, the start of the G${move.code} cycle the pause `
        + `stopped on line ${line}, and runs that hole's cycle again from there.`
      : `CYCLE START goes back to ${where}, where the pause stopped line ${line}, `
        + 'and finishes that move from there.',
  )
  return { ok: true, plan, offPathMm: on.offPathMm }
}

/** WO-2242: the line a program carries on from once its tool change on `line`
 *  is done - the next sendable one, including any M0 the file states.
 *  Null when nothing follows. */
function lineAfterToolChange(rawLines: string[], line: number): number | null {
  for (let n = line + 1; n <= rawLines.length; n++) {
    if (!isSendableGcodeLine(rawLines[n - 1])) continue
    return n
  }
  return null
}

/**
 * WO-2242: THE RETURN TO A PAUSE INSIDE A TOOL CHANGE. The program carries on
 * with the right tool: the return goes back to where the program stood when it
 * reached the change (safe Z, X/Y, down at the capped feed), then - with the
 * tool the change fits now in the spindle (`toolNow`: answered, typed or
 * measured in the stop) - carries on after the change, cutting with that
 * tool's length (G43 H); otherwise the change runs again from its start, as
 * the program's own change runs on this controller.
 */
function resumeAtToolChange(
  programText: string,
  rawLines: string[],
  line: number,
  start: LineStart,
  change: { tool: number | null; point: Point3 },
  atMm: Point3,
  options: RunFromLineOptions,
): ResumeAtPointResult {
  const fitted = change.tool !== null && change.tool > 0 && options.toolNow === change.tool
  const sameLineStop = /(?:^|\s)M0?[01](?:\s|$)/i.test(stripGcodeComments(rawLines[line - 1]))
  const at = (fitted ? (sameLineStop ? line : lineAfterToolChange(rawLines, line)) : null) ?? line
  const done = fitted && (sameLineStop || at !== line)
  const inUnits = (v: number) => Number((start.inch ? v / 25.4 : v).toFixed(start.inch ? 5 : 4))
  const point = { x: inUnits(change.point.x), y: inUnits(change.point.y), z: inUnits(change.point.z) }
  const planned = planFrom(programText, at, options, {
    line: at,
    text: done && sameLineStop
      ? stripGcodeComments(rawLines[at - 1]).replace(/(?:^|\s)(?:T\d+|M0?6)(?=\s|$)/gi, ' ').trim()
      : rawLines[at - 1],
    point,
    pointMm: { ...change.point },
    toolChange: { on: line, tool: change.tool, done },
  })
  if (!planned.ok) return planned
  const plan = planned.plan as RunFromLinePlan & { resumeAt: NonNullable<RunFromLinePlan['resumeAt']> }
  const which = change.tool === null ? 'the tool change' : `the T${change.tool} change`
  plan.warnings.unshift(
    `CYCLE START goes back to X${point.x} Y${point.y} Z${point.z}, where the program stood at ${which} on line ${line}, `
      + (done ? `and carries on after it with T${change.tool}.` : 'and runs that change again from its start.'),
  )
  const off = Math.hypot(atMm.x - change.point.x, atMm.y - change.point.y, atMm.z - change.point.z)
  return { ok: true, plan, offPathMm: off }
}

/** WO-2437: a line that is the program's own stop and nothing else - M0 or
 *  M1 (the post writes the operator stop's M0 alone on its line). */
function isProgramStopLine(raw: string | undefined): boolean {
  return /^(?:N\d+\s+)?M0?[01]$/i.test(stripGcodeComments(raw ?? '').trim())
}

/** WO-2437: `line` is the program's own stop (M0/M1). */
export function programStopAt(programText: string, line: number): boolean {
  return isProgramStopLine(programText.split(/\r?\n/)[line - 1])
}

/** WO-2437 fix round 4 (LinuxCNC rehearsal): a controller held on a program
 *  stop can report the last MOTION line (LinuxCNC's motionLine) rather than
 *  the M0. The stop that follows `line` with no motion between - only
 *  comments, messages, M5/M9 and the like - or null. `endOf` is where `line`
 *  ends: machine coordinates for a G53 line, else work; null when the line
 *  names no axis. The caller checks the machine stands there. */
export function programStopFollowing(
  programText: string,
  line: number,
): { stopLine: number; endOf: { frame: 'machine' | 'work'; at: Partial<Point3> } | null } | null {
  const rawLines = programText.split(/\r?\n/)
  let stopLine: number | null = null
  for (let n = line + 1; n <= rawLines.length; n++) {
    const raw = rawLines[n - 1]
    if (!isSendableGcodeLine(raw)) continue
    if (isProgramStopLine(raw)) { stopLine = n; break }
    const words = tokenizeLine(stripGcodeComments(raw), n).words
    const moves = words.some((w) => 'XYZABC'.includes(w.letter))
      || words.some((w) => w.letter === 'G' && [0, 1, 2, 3, 28, 30, 38, 53].includes(Math.trunc(w.value)))
      || words.some((w) => w.letter === 'M' && [6, 2, 30].includes(w.value))
    if (moves) return null
  }
  if (stopLine === null) return null
  const own = tokenizeLine(stripGcodeComments(rawLines[line - 1] ?? ''), line).words
  const at: Partial<Point3> = {}
  for (const w of own) {
    if (w.letter === 'X') at.x = w.value
    else if (w.letter === 'Y') at.y = w.value
    else if (w.letter === 'Z') at.z = w.value
  }
  const frame = own.some((w) => w.letter === 'G' && Math.trunc(w.value) === 53) ? 'machine' : 'work'
  return { stopLine, endOf: Object.keys(at).length === 0 ? null : { frame, at } }
}

/**
 * WO-2437 fix round 4: the operator moved the machine at the program's own
 * stop (an operator stop's M0 at its park). CYCLE START goes back to where
 * the machine stood at the stop the WO-2237 way - up first, then X/Y, then
 * down to it - and carries on from the line after the stop: the stop was
 * answered, so it is not held a second time.
 */
function resumeAfterProgramStop(
  programText: string,
  rawLines: string[],
  line: number,
  start: LineStart,
  atMm: PausePoint,
  options: RunFromLineOptions,
): ResumeAtPointResult {
  let next: number | null = null
  for (let n = line + 1; n <= rawLines.length; n++) {
    if (isSendableGcodeLine(rawLines[n - 1])) { next = n; break }
  }
  if (next === null) return { ok: false, reason: `Nothing follows the stop on line ${line}.` }
  const inUnits = (v: number) => Number((start.inch ? v / 25.4 : v).toFixed(start.inch ? 5 : 4))
  const point = { x: inUnits(atMm.x), y: inUnits(atMm.y), z: inUnits(atMm.z) }
  const planned = planFrom(programText, next, options, {
    line: next,
    text: rawLines[next - 1],
    point,
    pointMm: { x: atMm.x, y: atMm.y, z: atMm.z },
    programStop: { on: line },
  })
  if (!planned.ok) return planned
  const plan = planned.plan as RunFromLinePlan & { resumeAt: NonNullable<RunFromLinePlan['resumeAt']> }
  plan.warnings.unshift(
    `CYCLE START goes back to X${point.x} Y${point.y} Z${point.z}, where the program stopped at line ${line}, `
      + 'and carries on after that stop.',
  )
  return { ok: true, plan, offPathMm: 0 }
}

/**
 * WO-2242: where the program stood when it reached the tool change on `line`
 * (work millimetres, the line's offset), or null when `line` is not one. A
 * controller whose own M6 moves the machine (LinuxCNC's tool-change position,
 * measured on its simulator 2026-09-30: X0 Y0 at machine Z50.8) is paused off
 * every path; the change's place is still this point.
 */
export function toolChangeStartOf(programText: string, line: number): Point3 | null {
  const rawLines = programText.split(/\r?\n/)
  const start = lineStarts(rawLines, [line]).get(line)
  if (start === undefined) return null
  return toolChangeLineOf(rawLines[line - 1], line, start)?.point ?? null
}

/**
 * WO-2400: the tools a program has where `line` starts, as the file reader
 * reads its T and M6 words. `inSpindle` is the T of the last M6 before the
 * line or, with no M6 yet, the first T the file names (a post that omits M6
 * runs on that tool); `selected` is the last T word, the one a bare M6 fits.
 * A return staged from `line` names them first, so a later `T1 M6` is read as
 * the change from the tool the run had at the pause, as the whole file reads it.
 */
export function toolWordsBefore(programText: string, line: number): { inSpindle: number | null; selected: number | null } {
  const rawLines = programText.split(/\r?\n/)
  let inSpindle: number | null = null
  let selected: number | null = null
  for (let n = 1; n < line && n <= rawLines.length; n++) {
    const parsed = tokenizeLine(stripGcodeComments(rawLines[n - 1]), n)
    const t = wordOf(parsed, 'T')
    if (t !== null && Number.isInteger(t) && t >= 0) {
      selected = t
      if (inSpindle === null) inSpindle = t
    }
    if (hasM(parsed, [6]) && selected !== null) inSpindle = selected
  }
  return { inSpindle, selected }
}
