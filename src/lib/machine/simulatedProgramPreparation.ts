// WO-3125: the simulator's own interpreter, factored from simulatedController.
// Pure cloneable inputs/results only. Execution, live receipts and publication
// remain on the controller. This is also the synchronous fallback's one parser.
import type { ControlAxis, GrblParserState, MachinePosition, QueuedMove, WcsId } from './controller'
import type { MachineSpindleLinkDefinition } from '../../types'
import type { PostConfig } from '../post/types'
import { prepareProgram, type StreamLine } from '../gcode/text'
import { gcodeWordRefusalIfAbsent, type GcodeWordTable } from '../gcode/wordTable'
import { expandCannedHole } from './pathFidelity'
type AxisKey = 'x' | 'y' | 'z'
type PositionAxisKey = Lowercase<ControlAxis>
const WCS_IDS: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
const positionAxisKey = (axis: ControlAxis): PositionAxisKey => axis.toLowerCase() as PositionAxisKey
export interface SimulatorParseInput {
  session: number
  controlAxes: ControlAxis[]
  activeWcs: WcsId
  lastEnqueuedTarget: MachinePosition
  dialect: PostConfig
  table: GcodeWordTable
  outputCodes: number[]
  wco: Record<WcsId, MachinePosition>
  tlo: number
  homePosition: MachinePosition
  rapidMmMin: number
  refusedAxes: AxisKey[]
  spindle: { minSpindleRpm?: number; maxSpindleRpm?: number; spindleDirection: 'cw' | 'ccw'; spindleLinkDefinition?: MachineSpindleLinkDefinition | null } | null
  rereadingStaged: boolean
  parser: GrblParserState
}
export type SimulatorParsedProgram = {
  ok: true; moves: QueuedMove[]; effects: Map<number, LineEffect>;
  lengthMoves: Set<QueuedMove>; start: MachinePosition; startRelative: Map<QueuedMove, StartRelativeAxes>
} | { ok: false; reason: string }
export interface PreparedSimulatedProgram {
  text: string
  identity: string
  prepared: ReturnType<typeof prepareProgram>
  parsed: SimulatorParsedProgram
  notices: string[]
}
export function simulatorParseIdentity(input: SimulatorParseInput): string { return JSON.stringify(input) }
export function prepareSimulatedProgram(text: string, input: SimulatorParseInput): PreparedSimulatedProgram {
  const prepared = prepareProgram(withoutNestedComments(text))
  const notices: string[] = []
  const parsed = parseSimulatedProgramLines(prepared.lines, input, notices)
  return { text, identity: simulatorParseIdentity(input), prepared, parsed, notices }
}
export function parseSimulatedProgramLines(lines: StreamLine[], input: SimulatorParseInput, notices: string[] = []): SimulatorParsedProgram {
    const moves: QueuedMove[] = []
    const effects = new Map<number, LineEffect>()
    const lengthMoves = new Set<QueuedMove>()
    const startRelative = new Map<QueuedMove, StartRelativeAxes>()
    // An axis leaves this set when an absolute word (or G53/G28) names it;
    // until then its value is the start position plus any G91 increments.
    const unanchored = new Set<PositionAxisKey>(input.controlAxes.map(positionAxisKey))
    const anchor = (keys: Iterable<PositionAxisKey>): void => { for (const key of keys) unanchored.delete(key) }
    const relativeOf = (point: Partial<MachinePosition>): PositionAxisKey[] =>
      [...unanchored].filter((key) => point[key] !== undefined)
    let zCarriesLength = false
    let scale = 1 // mm canonical; G20 switches to 25.4
    let distanceMode: 'absolute' | 'incremental' = 'absolute'
    let activeWcs: WcsId = input.activeWcs
    let motionMode: 'G0' | 'G1' | 'G2' | 'G3' | null = null
    let feed = 0 // canonical mm/min
    let pos: MachinePosition = { ...input.lastEnqueuedTarget }
    const readFrom = { ...pos }
    const supportedG = programGWords(input.dialect)
    const supportedM = programMWords(input.dialect)
    // WO-2687: the active G81/G82/G83 cycle, its modal R/Z/Q (work mm), G98/
    // G99 and G82 dwell P. Each hole is expanded by the SAME expansion the 3D
    // preview and the path check draw (expandCannedHole: the preview's
    // expandCannedCycle), from where this parse has the tool - so the simulator
    // moves where the check says it goes, and nothing else in the program (the
    // post's own G28 end) decides whether a hole runs.
    let cycle: 81 | 82 | 83 | null = null
    let cycleDwell: number | null = null
    let cycleR: number | null = null
    let cycleDepth: number | null = null
    let cycleQ: number | null = null
    let returnToInitial = true // G98 is the power-on default

    for (const line of lines) {
      const trimmed = line.text.trim()
      if (trimmed.startsWith('$')) {
        const homeCommand = String(input.dialect.options.homeCommand ?? '').trim().toUpperCase()
        const command = trimmed.split(/\s/, 1)[0].toUpperCase()
        if (command === homeCommand) {
          return {
            ok: false,
            reason: `Line ${line.sourceLine}: ${command} is ${input.dialect.label}'s homing command, which cannot be executed inside a loaded software-simulator program.`,
          }
        }
        return {
          ok: false,
          reason: `Line ${line.sourceLine}: ${command} is not a command the ${input.dialect.label} post emits - refusing to run it.`,
        }
      }
      const words = tokenizeWords(line.text)
      const gWords = words.filter((w) => w.letter === 'G').map((w) => w.value)
      const mWords = words.filter((w) => w.letter === 'M').map((w) => w.value)

      const unknown = simulatorTableRefusal(input.table, words)
      if (unknown !== null) return { ok: false, reason: `Line ${line.sourceLine}: ${unknown}` }
      for (const g of gWords) {
        if (!supportedG.has(g)) {
          return {
            ok: false,
            reason: `Line ${line.sourceLine}: G${g} is not a word the ${input.dialect.label} post emits - refusing to run it.`,
          }
        }
      }
      for (const m of mWords) {
        if (!supportedM.has(m) && !input.outputCodes.includes(m)) {
          return {
            ok: false,
            reason: `Line ${line.sourceLine}: M${m} is not a word the ${input.dialect.label} post emits - refusing to run it.`,
          }
        }
      }

      if (gWords.includes(20)) scale = 25.4
      if (gWords.includes(21)) scale = 1
      if (gWords.includes(90)) distanceMode = 'absolute'
      if (gWords.includes(91)) distanceMode = 'incremental'
      for (const id of WCS_IDS) {
        if (gWords.includes(Number(id.slice(1)))) activeWcs = id
      }
      if (gWords.includes(0)) motionMode = 'G0'
      else if (gWords.includes(1)) motionMode = 'G1'
      else if (gWords.includes(2)) motionMode = 'G2'
      else if (gWords.includes(3)) motionMode = 'G3'
      // WO-2687: G0-G3 and G80 end a canned cycle; G81/G82/G83 start one and
      // are themselves the motion mode until then.
      if (gWords.some((g) => g === 0 || g === 1 || g === 2 || g === 3 || g === 80)) cycle = null
      const cycleWord = gWords.find((g): g is 81 | 82 | 83 => g === 81 || g === 82 || g === 83)
      if (cycleWord !== undefined) {
        cycle = cycleWord
        cycleDwell = null
        cycleR = null
        cycleDepth = null
        cycleQ = null
        motionMode = null
      }
      if (gWords.includes(98)) returnToInitial = true
      if (gWords.includes(99)) returnToInitial = false

      const axisWords = new Map<ControlAxis, TextWord | undefined>(
        input.controlAxes.map((axis) => [axis, firstWord(words, axis)]),
      )
      const xw = axisWords.get('X')
      const yw = axisWords.get('Y')
      const zw = axisWords.get('Z')
      const iw = firstWord(words, 'I')
      const jw = firstWord(words, 'J')
      const fw = firstWord(words, 'F')
      if (fw) feed = fw.value * scale

      let effect: LineEffect | undefined
      if (mWords.includes(3) || mWords.includes(4)) {
        const sw = firstWord(words, 'S')
        const direction = mWords.includes(4) ? 'ccw' : 'cw'
        const refusal = simulatorSpindleDirectionRefusal(input.spindle, direction)
        if (refusal) return { ok: false, reason: `Line ${line.sourceLine}: ${refusal}` }
        const resolved = simulatorSpindleRpm(input.spindle, direction, sw?.value)
        if (resolved.notice && !input.rereadingStaged) {
          notices.push(`Line ${line.sourceLine}: ${resolved.notice}`)
        }
        effect = { ...effect, spindle: { on: true, dir: direction, rpm: resolved.rpm } }
      }
      if (mWords.includes(5)) effect = { ...effect, spindle: { on: false, dir: 'cw' } }
      if (mWords.includes(7)) effect = { ...effect, coolant: { ...effect?.coolant, mist: true } }
      if (mWords.includes(8)) effect = { ...effect, coolant: { ...effect?.coolant, flood: true } }
      if (mWords.includes(9)) effect = { ...effect, coolant: { flood: false, mist: false } }
      // WO-1650: the machine's own listed output words, applied with the line.
      const listed = mWords.filter((m) => m === 9 || input.outputCodes.includes(m))
      if (listed.length > 0 && input.outputCodes.length > 0) effect = { ...effect, outputs: listed }
      if (mWords.includes(0)) effect = { ...effect, pause: true }
      if (WCS_IDS.some((id) => gWords.includes(Number(id.slice(1))))) effect = { ...effect, wcs: activeWcs }
      const tw = firstWord(words, 'T')
      if (tw && Number.isInteger(tw.value) && tw.value >= 0) effect = { ...effect, tool: tw.value }

      // WO-2037: the G43.1 length in force is part of where an absolute work Z
      // lands - the register status() subtracts to report WPos, and the one
      // GRBL and UCCNC add to every work Z until G49. Without it a program run
      // after Apply cut the length away from where the DRO and the path check
      // said, and the check read "LEFT THE PATH" by exactly that length.
      const wco = { ...input.wco[activeWcs], z: input.wco[activeWcs].z + input.tlo }
      const applyAxis = (
        word: TextWord | undefined,
        current: number,
        offset: number,
        coordinateScale: number,
      ): number => {
        if (!word) return current
        return distanceMode === 'incremental'
          ? current + word.value * coordinateScale
          : word.value * coordinateScale + offset
      }

      if (gWords.includes(4)) {
        const pw = firstWord(words, 'P')
        const dwell = pw?.value ?? 0
        moves.push({
          id: line.sourceLine,
          kind: 'dwell',
          seconds: input.dialect.capabilities.dwellUnits === 'ms' ? dwell / 1000 : dwell,
        })
        if (effect) effects.set(line.sourceLine, effect)
        continue
      }

      if (gWords.includes(28)) {
        // Simplification carried over from the file header's spirit: this
        // dialect only ever emits a BARE G28 (no intermediate X/Y/Z point,
        // see uccnc.ts's homeCommand option), so this models the whole move
        // as a direct rapid to the machine's reference position.
        pos = { ...input.homePosition }
        anchor([...unanchored])
        zCarriesLength = false
        moves.push({ id: line.sourceLine, kind: 'line', to: { ...pos }, feedMmMin: input.rapidMmMin })
        if (effect) effects.set(line.sourceLine, effect)
        continue
      }

      const hasCoord = [...axisWords.values()].some((word) => word !== undefined)
      const explicitAxes = (['x', 'y', 'z'] as const).filter(
        (axis) => (axis === 'x' ? xw : axis === 'y' ? yw : zw) !== undefined,
      )
      const addressedAxes = motionMode === 'G2' || motionMode === 'G3'
        ? Array.from(new Set<AxisKey>([...explicitAxes, 'x', 'y']))
        : explicitAxes
      if (hasCoord && addressedAxes.some((axis) => input.refusedAxes.includes(axis))) {
        return { ok: false, reason: `Line ${line.sourceLine}: the program commands a disabled or undefined axis.` }
      }

      // WO-2687: one hole of a canned drill cycle - rapid to the hole and down
      // to R, feed to depth (G83 in Q pecks, back to R between them), G82's
      // dwell at the bottom, rapid back to the initial Z (G98) or R (G99).
      // Work targets cross the same offset and length every work move does; a
      // G98 return goes back to the Z this line started from, as the path
      // check resolves it (transferCheck's 'line-start').
      if (cycle !== null && !gWords.includes(4)) {
        const pw = firstWord(words, 'P')
        if (pw) cycleDwell = pw.value
      }
      if (cycle !== null && hasCoord && !gWords.includes(53)) {
        if (distanceMode === 'incremental') {
          return { ok: false, reason: `Line ${line.sourceLine}: a G${cycle} canned cycle under G91 incremental is not modelled.` }
        }
        const rotaryWord = (['A', 'B', 'C'] as const).find((axis) => axisWords.get(axis) !== undefined)
        if (rotaryWord) {
          return { ok: false, reason: `Line ${line.sourceLine}: a G${cycle} canned cycle with ${rotaryWord} motion is not modelled.` }
        }
        if (feed <= 0) {
          return { ok: false, reason: `Line ${line.sourceLine}: a G${cycle} canned cycle has no feed rate set.` }
        }
        const rw = firstWord(words, 'R')
        const qw = firstWord(words, 'Q')
        if (rw) cycleR = rw.value * scale
        if (zw) cycleDepth = zw.value * scale
        if (qw) cycleQ = qw.value * scale
        const expansion = expandCannedHole(
          { x: pos.x - wco.x, y: pos.y - wco.y, z: pos.z - wco.z },
          {
            code: cycle,
            returnToInitial,
            retractZ: cycleR,
            depthZ: cycleDepth,
            peckQ: cycleQ,
            feedMmMin: feed,
            x: xw ? xw.value * scale : null,
            y: yw ? yw.value * scale : null,
          },
        )
        if (typeof expansion === 'string') {
          return { ok: false, reason: `Line ${line.sourceLine}: the G${cycle} canned cycle cannot be expanded - ${expansion}` }
        }
        const lineStart = { ...pos }
        const first = moves.length
        let bottom = -1
        for (const step of expansion) {
          const returning = step.targetMode === 'line-start'
          const target = { ...pos }
          for (const key of step.addressedAxes) target[key] = returning ? lineStart[key] : step.to[key] + wco[key]
          if (!returning) {
            anchor(step.addressedAxes)
            if (step.addressedAxes.includes('z')) zCarriesLength = true
          }
          pos = target
          const move: QueuedMove = {
            id: line.sourceLine,
            kind: 'line',
            to: { ...target },
            feedMmMin: step.kind === 'rapid' ? input.rapidMmMin : feed,
          }
          moves.push(move)
          startRelative.set(move, { to: relativeOf(move.to), centre: [] })
          if (zCarriesLength) lengthMoves.add(move)
          if (step.kind !== 'rapid') bottom = moves.length
        }
        if (cycle === 82 && bottom >= 0 && cycleDwell !== null && cycleDwell > 0) {
          moves.splice(bottom, 0, {
            id: line.sourceLine,
            kind: 'dwell',
            seconds: input.dialect.capabilities.dwellUnits === 'ms' ? cycleDwell / 1000 : cycleDwell,
          })
        }
        if (moves.length === first) moves.push({ id: line.sourceLine, kind: 'marker' })
        if (effect) effects.set(line.sourceLine, effect)
        continue
      }

      // WO-2437: G53 G0/G1 - a machine target on this line only (the park our
      // posts write at an operator stop). No work offset, no length, no G91;
      // the motion mode it carries stays modal, as on every controller.
      if (hasCoord && gWords.includes(53)) {
        if (motionMode !== 'G0' && motionMode !== 'G1') {
          return { ok: false, reason: `Line ${line.sourceLine}: G53 moves only with G0 or G1.` }
        }
        if (motionMode === 'G1' && feed <= 0) {
          return { ok: false, reason: `Line ${line.sourceLine}: a feed move has no feed rate set.` }
        }
        const target = { ...pos }
        for (const axis of input.controlAxes) {
          const word = axisWords.get(axis)
          if (!word) continue
          const key = positionAxisKey(axis)
          target[key] = word.value * (axis === 'X' || axis === 'Y' || axis === 'Z' ? scale : 1)
          anchor([key])
        }
        pos = target
        if (zw) zCarriesLength = false
        const move: QueuedMove = {
          id: line.sourceLine,
          kind: 'line',
          to: { ...target },
          feedMmMin: motionMode === 'G0' ? input.rapidMmMin : feed,
        }
        moves.push(move)
        startRelative.set(move, { to: relativeOf(move.to), centre: [] })
        // An XY-only G53 keeps the work Z it inherited, length included.
        if (zCarriesLength) lengthMoves.add(move)
        if (effect) effects.set(line.sourceLine, effect)
        continue
      }

      if (hasCoord && (motionMode === 'G2' || motionMode === 'G3')) {
        const rotaryWord = (['A', 'B', 'C'] as const).find((axis) => axisWords.get(axis) !== undefined)
        if (rotaryWord) {
          return { ok: false, reason: `Line ${line.sourceLine}: an arc with ${rotaryWord} motion is not modelled.` }
        }
        if (!iw || !jw) {
          return { ok: false, reason: `Line ${line.sourceLine}: an arc move is missing its I/J center offset.` }
        }
        if (feed <= 0) {
          return { ok: false, reason: `Line ${line.sourceLine}: an arc move has no feed rate set.` }
        }
        const start = { ...pos }
        const target = {
          x: applyAxis(xw, pos.x, wco.x, scale),
          y: applyAxis(yw, pos.y, wco.y, scale),
          z: applyAxis(zw, pos.z, wco.z, scale),
        }
        const centre = { x: start.x + iw.value * scale, y: start.y + jw.value * scale, z: start.z }
        const centreRelative = relativeOf(centre)
        if (distanceMode === 'absolute') {
          anchor((['x', 'y', 'z'] as const).filter((key) => (key === 'x' ? xw : key === 'y' ? yw : zw) !== undefined))
        }
        pos = { ...pos, ...target }
        if (zw && distanceMode === 'absolute') zCarriesLength = true
        const arc: QueuedMove = {
          id: line.sourceLine,
          kind: 'arc',
          to: { ...target },
          centre,
          clockwise: motionMode === 'G2',
          plane: 'xy',
          feedMmMin: feed,
        }
        moves.push(arc)
        startRelative.set(arc, { to: relativeOf(arc.to), centre: centreRelative })
        if (zCarriesLength) lengthMoves.add(arc)
        if (effect) effects.set(line.sourceLine, effect)
        continue
      }

      if (hasCoord && motionMode !== null) {
        if (motionMode !== 'G0' && feed <= 0) {
          return { ok: false, reason: `Line ${line.sourceLine}: a feed move has no feed rate set.` }
        }
        const target = { ...pos }
        for (const axis of input.controlAxes) {
          const key = positionAxisKey(axis)
          const coordinateScale = axis === 'X' || axis === 'Y' || axis === 'Z' ? scale : 1
          target[key] = applyAxis(axisWords.get(axis), pos[key]!, wco[key]!, coordinateScale)
          if (axisWords.get(axis) && distanceMode === 'absolute') anchor([key])
        }
        pos = target
        if (zw && distanceMode === 'absolute') zCarriesLength = true
        const move: QueuedMove = {
          id: line.sourceLine,
          kind: 'line',
          to: { ...target },
          feedMmMin: motionMode === 'G0' ? input.rapidMmMin : feed,
        }
        moves.push(move)
        startRelative.set(move, { to: relativeOf(move.to), centre: [] })
        if (zCarriesLength) lengthMoves.add(move)
        if (effect) effects.set(line.sourceLine, effect)
        continue
      }

      if (hasCoord && motionMode === null) {
        return {
          ok: false,
          reason: `Line ${line.sourceLine}: a coordinate word appeared with no active motion mode.`,
        }
      }

      // Non-motion line: units, distance mode, WCS select, spindle/coolant,
      // tool select, M0/M6/M30 - advance the id (and apply any effect), no
      // motion.
      moves.push({ id: line.sourceLine, kind: 'marker' })
      if (effect) effects.set(line.sourceLine, effect)
    }

    return { ok: true, moves, effects, lengthMoves, start: readFrom, startRelative }
}

/** WO-2679: a staged move's coordinates that descend from the position its
 *  program was read from - `to` for its target, `centre` for an arc's centre
 *  (placed from the arc's start). */
export interface StartRelativeAxes {
  to: readonly PositionAxisKey[]
  centre: readonly PositionAxisKey[]
}

/** WO-428: a non-motion state change carried by one program line (M3/M4/M5/
 *  M7/M8/M9/M0), applied when EXECUTION reaches that line's move - never at
 *  parse time, so a program that has not started cannot turn the spindle on
 *  early. Keyed by the QueuedMove id that carries it: this class mints
 *  id = source line for every text-loaded move, so the two line up exactly.
 *  Not part of the QueuedMove contract (that union is fixed) - purely this
 *  class's own bookkeeping alongside it. */
export interface LineEffect {
  spindle?: { on: boolean; dir: 'cw' | 'ccw'; rpm?: number }
  coolant?: { flood?: boolean; mist?: boolean }
  /** WO-1650: the machine's own listed output words on this line. */
  outputs?: number[]
  /** M0: hold once this line's move completes. */
  pause?: boolean
  /** WO-2687: G54-G59 on this line - the frame status() reports from here on.
   *  A program's G56 used to change only the parse, so a G56 program's DRO
   *  and the path check's samples read in whatever frame was selected before. */
  wcs?: WcsId
  /** WO-2878: the T word on this line - the tool $G reports from here on. */
  tool?: number
}

export interface TextWord {
  letter: string
  value: number
}

/** The interpreter's executable core intersected with what this PostConfig can
 * emit. Config framing contributes its own modal words, so G64 is accepted for
 * UCCNC/LinuxCNC without becoming a hand-maintained dialect table. */
function programGWords(config: PostConfig): Set<number> {
  // 53: every dialect's operator stop parks with G53 G0 (WO-2437).
  const words = new Set([0, 1, 4, 17, 20, 21, 53, 54, 55, 56, 57, 58, 59, 90, 91, 94])
  if (config.capabilities.arcs) {
    words.add(2)
    words.add(3)
  }
  // WO-2687: a post that emits canned drill cycles (emit.ts emitDrillCycles)
  // writes these, and the controller it posts for runs them.
  if (config.capabilities.cannedCycles) {
    for (const word of [80, 81, 82, 83, 98, 99]) words.add(word)
  }
  for (const text of [...config.framing.programStart, ...config.framing.programEnd, String(config.options.homeCommand ?? '')]) {
    for (const word of tokenizeWords(text)) if (word.letter === 'G') words.add(word.value)
  }
  return words
}

function programMWords(config: PostConfig): Set<number> {
  // M6 is an app-native execution boundary even when this post emits a pause
  // instead. The reader and session still perform the one guided/manual tool
  // change; the post capability controls generated text, not load acceptance.
  const words = new Set([3, 4, 5, 6, 7, 8, 9, 30])
  if (config.capabilities.toolChange === 'pause' || config.options.toolChangePause !== false) words.add(0)
  for (const text of config.framing.programEnd) {
    for (const word of tokenizeWords(text)) if (word.letter === 'M') words.add(word.value)
  }
  return words
}

const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))?/g

/** Tokenize one already-stripped line into address words. An address with no
 *  number is dropped rather than crashing - not expected in this dialect, but
 *  defensive against hand-typed text. */
export function tokenizeWords(text: string): TextWord[] {
  const out: TextWord[] = []
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(text)) !== null) {
    if (m[2] === undefined || m[2] === '') continue
    out.push({ letter: m[1].toUpperCase(), value: Number(m[2]) })
  }
  return out
}

/** WO-2004: a comment that nests another - Fusion writes the tool's own
 *  description inside one, `(flat end mill D=3.15 Rennie 1/8"(.1250") Single
 *  Flute)` - is ONE comment, as the file reader the machine bridge uses reads it
 *  (reader.ts, codeOutsideComments). prepareProgram closes a comment at its
 *  first `)`, which left `Single Flute)` behind to be read as code. Each line
 *  keeps its place, so source line numbers are unchanged; anything else
 *  prepareProgram already tolerated (an unclosed comment, a stray `)`) reads
 *  exactly as it did. */
export function withoutNestedComments(text: string): string {
  if (!/\([^)]*\(/.test(text)) return text
  return text.split(/\r?\n/).map((line) => {
    let depth = 0
    let out = ''
    for (const ch of line) {
      if (ch === ';' && depth === 0) break
      if (ch === '(') {
        depth++
        continue
      }
      if (ch === ')' && depth > 0) {
        depth--
        continue
      }
      if (depth === 0) out += ch
    }
    return out
  }).join('\n')
}

export function firstWord(words: TextWord[], letter: string): TextWord | undefined {
  return words.find((w) => w.letter === letter)
}
export function simulatorSpindleDirectionRefusal(spindle: SimulatorParseInput['spindle'], direction: 'cw' | 'ccw'): string | null {
    if (!spindle) return null
    const mCode = direction === 'cw' ? 'M3' : 'M4'
    if (direction !== spindle.spindleDirection) {
      const allowed = spindle.spindleDirection === 'cw' ? 'clockwise' : 'counter-clockwise'
      return `${mCode} was refused: this machine's spindle is configured for ${allowed} rotation only.`
    }
    return null
  }

export function simulatorSpindleRpm(
    spindle: SimulatorParseInput['spindle'],
    direction: 'cw' | 'ccw',
    requestedRpm: number | undefined,
  ): { rpm: number | undefined; notice: string | null } {
    if (!spindle || requestedRpm === undefined) return { rpm: requestedRpm, notice: null }
    const minimum = spindle.minSpindleRpm
    const maximum = spindle.maxSpindleRpm
    const aboveMinimum = minimum === undefined ? requestedRpm : Math.max(requestedRpm, minimum)
    const rpm = maximum === undefined ? aboveMinimum : Math.min(aboveMinimum, maximum)
    if (rpm === requestedRpm) return { rpm, notice: null }
    const mCode = direction === 'cw' ? 'M3' : 'M4'
    const statedRange = minimum !== undefined && maximum !== undefined
      ? `${minimum}-${maximum} RPM`
      : minimum !== undefined
        ? `at least ${minimum} RPM`
        : `at most ${maximum} RPM`
    return {
      rpm,
      notice: `${mCode} S${requestedRpm} was clamped to ${rpm} RPM: this machine allows ${statedRange}.`,
    }
  }

export function simulatorTableRefusal(table: GcodeWordTable, words: readonly TextWord[]): string | null {
    for (const word of words) {
      if (word.letter !== 'G' && word.letter !== 'M') continue
      const sentence = gcodeWordRefusalIfAbsent(table, word.letter, word.value)
      if (sentence !== null) return sentence
    }
    return null
  }


/** Freeze the received graph in its own safe preparation task. Map/Set keys
 * retain move identity across structured clone; the controller only reads
 * these collections and replaces, rather than mutates, moves when rebasing. */
export function freezeSimulatedProgram(value: PreparedSimulatedProgram): void {
  const seen = new Set<object>()
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return
    seen.add(item)
    if (item instanceof Map) for (const [key, child] of item) { visit(key); visit(child) }
    else if (item instanceof Set) for (const child of item) visit(child)
    else for (const child of Object.values(item)) visit(child)
    Object.freeze(item)
  }
  visit(value)
}
