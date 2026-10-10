// previewGeometry - turns a g-code program into drawable XY polylines for the
// Control tab's live preview (MACHINE-CONTROL: "visual path" half of Operator's
// live-preview ask). Reuses the shared parser (src/lib/gcode) - segments come
// back with 1-based source-line attribution, which is exactly the key the
// sender's progress cursor uses, so "sent vs pending" coloring is a line-number
// comparison. Arc segments from the parser carry only from/to, so this module
// reconstructs centers from the source line's I/J/K/R words in the active
// G17/G18/G19 plane and G90.1/G91.1 center mode (incremental by default), sampling them
// into polylines.
//
// WO-1075: this builder is the ONLY parser of a program on the Control side.
// Every Control-side reader - the preview, the 3D program path, the material
// fit, the Z surface mesh and the CAM -> Control transfer check - judges the
// SAME move list. So the model carries, besides the drawable polylines:
//   - `moves`: the tessellated move list, each move with its coordinate frame,
//     arc plane, 3D endpoints and modal feed in mm/min;
//   - `spindleRpmMax`: the largest commanded S;
// and canned drilling cycles (G81/G82/G83 with G98/G99) are EXPANDED here into
// the rapid-to-R / feed-to-depth / retract moves the controller would execute,
// so no reader has to grow a second walk of the program text to see them.

import { parseGcode, type GcodeLine, type GcodePoint, type GcodeSegment } from '../gcode'
import {
  gcodeWordEntry,
  gcodeWordRefusal,
  gcodeWordTable,
  type GcodeWordCategory,
} from '../gcode/wordTable'
import type { WcsId } from './types'

export type CoordinateAxis = keyof GcodePoint
export type PreviewTargetMode = 'absolute' | 'incremental' | 'line-start'

/** Source geometry needed to resample an arc from a physical start once live
 * WCS offsets are available. The preview can sample immediately in its raw
 * work-coordinate model; the transfer checker uses this descriptor when a
 * preceding move ended in a different coordinate frame. */
export interface PreviewArcCommand {
  clockwise: boolean
  from: GcodePoint
  to: GcodePoint
  targetAxes: ReadonlyArray<CoordinateAxis>
  centerOffset?: Partial<GcodePoint>
  /** G90.1 coordinates stay absolute in the commanded work frame, including
   * when the transfer checker supplies a different physical arc start. */
  centerAbsolute?: Partial<GcodePoint>
  radius?: number
}

export interface PreviewAxisAddress {
  /** First 1-based source line that explicitly or geometrically commands it. */
  firstLine: number
}

export interface PreviewPolyline {
  /** 1-based source line that produced this move. */
  line: number
  kind: 'rapid' | 'feed' | 'arc'
  /** XY points in work coordinates; arcs are sampled. */
  points: Array<{ x: number; y: number }>
  /** Depth at the move's start point, for depth interpolation along the move. */
  z0: number
  /** Depth of the move's endpoint, for depth tinting. */
  z: number
  /** Modal feed in mm/min for feed/arc moves; null for a rapid. */
  feedMmMin: number | null
}

/** One tessellated straight move in work coordinates - the unit every
 * Control-side check judges. Arcs arrive here as their sampled chords, canned
 * cycles as their expanded rapids and plunges. */
export interface PreviewMove {
  /** 1-based source line that produced this move. */
  line: number
  kind: 'rapid' | 'feed' | 'arc'
  /** Active plane when the move was commanded (relevant to arcs). */
  plane: ArcPlane
  /** Coordinate frame that produced this move. G53 is one-shot machine
   * coordinates; a work move keeps the persistent G54..G59 selection, or null
   * when motion appeared before the program selected a work coordinate. */
  coordinateFrame: 'work' | 'machine'
  workCoordinateSystem: WcsId | null
  from: GcodePoint
  to: GcodePoint
  /** Axes this source command addresses. This survives zero-delta commands,
   * arc tessellation and canned-cycle expansion instead of being inferred
   * later from the sampled endpoints. */
  addressedAxes: ReadonlyArray<CoordinateAxis>
  /** How addressed targets become machine positions. Incremental moves apply
   * their sampled delta to the preceding machine endpoint. A G98 return uses
   * the machine position captured before the expanded cycle line began. */
  targetMode?: PreviewTargetMode
  /** Original unsampled arc command. Present on each chord so a consumer with
   * live WCS offsets can resample from the actual machine start. */
  sourceArc?: PreviewArcCommand
  /** Modal feed in mm/min for feed/arc moves; null for a rapid. */
  feedMmMin: number | null
}

export interface PreviewModel {
  /** Whole-program refusal. Non-null means every geometry collection below is
   * empty: a partial preview would claim the unread remainder did not matter. */
  refusal: string | null
  /** Non-path words the preview does not interpret. They remain visible facts
   * without suppressing geometry or the safety checks that consume it. */
  notes: string[]
  polylines: PreviewPolyline[]
  /** Every resolved move, including one-shot G53 targets, in program order. */
  moves: PreviewMove[]
  /** Every program-commanded axis and its first relevant source line. */
  addressedAxes: Partial<Record<CoordinateAxis, PreviewAxisAddress>>
  /** Largest commanded spindle speed (S) in the program; 0 when none. */
  spindleRpmMax: number
  /** Bounds of work-coordinate geometry in canonical mm. Machine-coordinate
   * G53 targets are deliberately separate because no work offset is available
   * at parse time to put both frames into one honest box. */
  workBounds: PreviewBounds3 | null
  /** Per-axis targets of one-shot G53 moves, already converted to mm. */
  machineCoordinateRanges: Partial<Record<CoordinateAxis, PreviewAxisRange>>
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const ARC_CHORD_TOLERANCE = 0.05 // mm sagitta target for arc sampling
const MIN_ARC_STEPS = 8
const MAX_ARC_STEPS = 128
const CYCLE_EPS = 1e-9

// WO-1289: unknown G words can change where a move lands, so the preview must
// refuse the ones its modal interpreter cannot model. WO-1644: which words
// exist is the dialect's word table; a word the table does not carry is
// refused with the table's own sentence. Of the words it does carry, these
// categories name a point the preview has no machine state to place (home,
// stored reference points, a probe's contact, an offset write) or change how
// the numbers after them are read in a way this interpreter does not model.
const PREVIEW_CANNOT_PLACE: ReadonlySet<GcodeWordCategory> = new Set([
  'home', 'reference point', 'probe', 'offset write',
])
const PREVIEW_CANNOT_PLACE_WORDS: ReadonlySet<string> = new Set(['G93'])
/** The preview reads posted programs without a machine, so it reads them
 *  against the dialect LienCAM's own posts are run on. */
const PREVIEW_DIALECT = 'uccnc' as const
const UNSUPPORTED_COORDINATE_LETTERS = new Set(['A', 'B', 'C', 'U', 'V', 'W'])

/** Remove both comment forms before the parser can record or interpret their
 * contents as address words. Keep every newline so refusal and move source
 * lines still refer to the physical program text the operator loaded. Fusion
 * emits nested parentheses in tool descriptions even though RS-274 does not
 * permit them, so track depth instead of stopping at the first close paren. An
 * unclosed comment lasts through end-of-line, matching semicolon comments. */
function stripPreviewComments(programText: string): string {
  return programText
    .split('\n')
    .map((line) => {
      let depth = 0
      let code = ''
      for (const char of line) {
        if (char === '(') {
          depth += 1
          if (depth === 1) code += ' '
        } else if (char === ')' && depth > 0) {
          depth -= 1
        } else if (char === ';' && depth === 0) {
          break
        } else if (depth === 0) {
          code += char
        }
      }
      return code
    })
    .join('\n')
}

export type ArcPlane = 'xy' | 'xz' | 'yz'

interface PreviewAxisRange {
  min: number
  max: number
}

interface PreviewBounds3 {
  min: GcodePoint
  max: GcodePoint
}

function assessPreview(lines: GcodeLine[]): { refusal: string | null; notes: string[] } {
  const notes: string[] = []
  for (const line of lines) {
    const syntax = /[@^\[\]#=]/.exec(line.raw)?.[0]
    // LinuxCNC O-word control flow carries expression punctuation on the same
    // physical line. Name the construct before a later unsupported word on
    // that line, while allowing a standalone numeric O address that the
    // controller itself ignores.
    const oWord = syntax === undefined
      ? undefined
      : line.words.find((word) => word.letter === 'O' && !Number.isNaN(word.value))
    if (oWord !== undefined) {
      return {
        refusal: `Line ${line.number}: O${oWord.value} is not a word the preview can read - refusing to draw this program.`,
        notes,
      }
    }
    const table = gcodeWordTable(PREVIEW_DIALECT)
    for (const word of line.words) {
      const label = Number.isNaN(word.value) ? word.letter : `${word.letter}${word.value}`
      if (word.letter === 'G' && !Number.isNaN(word.value)) {
        const entry = gcodeWordEntry(table, 'G', word.value)
        if (entry === null) {
          return {
            refusal: `Line ${line.number}: ${gcodeWordRefusal(table, 'G', word.value)} Nothing is drawn - refusing to draw this program.`,
            notes,
          }
        }
        if (PREVIEW_CANNOT_PLACE.has(entry.category) || PREVIEW_CANNOT_PLACE_WORDS.has(entry.word)) {
          return {
            refusal: `Line ${line.number}: ${label} is not a word the preview can read - it ${entry.meaning}, `
              + 'which the preview has no machine state to draw - refusing to draw this program.',
            notes,
          }
        }
      }
      // Every M word is non-geometric, so one the table does not carry is
      // noted rather than refused. This covers operator-selected vacuum codes
      // and vendor macros without pretending the preview executes them.
      if (word.letter === 'M' && !Number.isNaN(word.value) && gcodeWordEntry(table, 'M', word.value) === null) {
        notes.push(`Line ${line.number}: ${label} is not interpreted by the preview; it does not change the drawn path.`)
      }
      if (UNSUPPORTED_COORDINATE_LETTERS.has(word.letter) && !Number.isNaN(word.value)) {
        return {
          refusal: `Line ${line.number}: ${label} is a coordinate the preview cannot place - refusing to draw this program.`,
          notes,
        }
      }
    }
    // Macro/expression punctuation never reaches parseGcode's word list. Scan
    // the uncommented source too, or expressions such as X#1 and @-.0025 are
    // still silently dropped even though every recorded word was accepted.
    if (syntax !== undefined) {
      return {
        refusal: `Line ${line.number}: ${syntax} expression syntax is not something the preview can read - refusing to draw this program.`,
        notes,
      }
    }
    const missingValue = line.words.find((word) => Number.isNaN(word.value))
    if (missingValue !== undefined) {
      return {
        refusal: `Line ${line.number}: ${missingValue.letter} has no numeric value the preview can read - refusing to draw this program.`,
        notes,
      }
    }
  }
  return { refusal: null, notes }
}

function refusedPreviewModel(refusal: string, notes: string[]): PreviewModel {
  return {
    refusal,
    notes,
    polylines: [],
    moves: [],
    addressedAxes: {},
    spindleRpmMax: 0,
    workBounds: null,
    machineCoordinateRanges: {},
    minX: 0,
    minY: 0,
    maxX: 1,
    maxY: 1,
  }
}

interface ResolvedSegment extends GcodeSegment {
  coordinateFrame: 'work' | 'machine'
  workCoordinateSystem: WcsId | null
  machineTarget?: Partial<GcodePoint>
  addressedAxes: ReadonlyArray<CoordinateAxis>
  targetMode: PreviewTargetMode
  /** Modal feed in mm/min; null for a rapid. */
  feedMmMin: number | null
}

/** The modal state of an active G81/G82/G83 drilling cycle. */
interface CannedCycleState {
  code: 81 | 82 | 83
  /** Z the tool sat at when the cycle was invoked - a G98 return goes here. */
  initialZ: number
  /** R approach plane, in work mm. */
  retractZ: number | null
  /** Hole bottom, in work mm (modal across repeated holes). */
  depthZ: number | null
  /** G83 peck increment, in work mm. */
  peckQ: number | null
}

interface ArcPlaneFrame {
  u: CoordinateAxis
  v: CoordinateAxis
  w: CoordinateAxis
  centerU: 'I' | 'J'
  centerV: 'J' | 'K'
}

// The same right-handed (u, v, w) frames used by pathFidelity. Center
// reconstruction and sampling both read this table, so G18/G19 do not grow
// plane-specific geometry branches of their own.
const ARC_PLANE_FRAME: Record<ArcPlane, ArcPlaneFrame> = {
  xy: { u: 'x', v: 'y', w: 'z', centerU: 'I', centerV: 'J' },
  xz: { u: 'x', v: 'z', w: 'y', centerU: 'I', centerV: 'K' },
  yz: { u: 'y', v: 'z', w: 'x', centerU: 'J', centerV: 'K' },
}

export function samplePreviewArc(
  from: GcodePoint,
  to: GcodePoint,
  command: PreviewArcCommand,
  plane: ArcPlane,
): GcodePoint[] {
  const center = arcCenter(from, to, command, plane)
  if (!center) return [{ ...from }, { ...to }]
  const frame = ARC_PLANE_FRAME[plane]
  const r = Math.hypot(from[frame.u] - center[frame.u], from[frame.v] - center[frame.v])
  if (!Number.isFinite(r) || r <= 0) return [{ ...from }, { ...to }]
  const a0 = Math.atan2(from[frame.v] - center[frame.v], from[frame.u] - center[frame.u])
  const a1 = Math.atan2(to[frame.v] - center[frame.v], to[frame.u] - center[frame.u])
  let sweep = a1 - a0
  // Normalize sweep to the commanded direction; a full circle is from==to.
  if (command.clockwise) {
    if (sweep >= -1e-9) sweep -= Math.PI * 2
  } else {
    if (sweep <= 1e-9) sweep += Math.PI * 2
  }
  const steps = Math.min(
    MAX_ARC_STEPS,
    Math.max(MIN_ARC_STEPS, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(0, 1 - ARC_CHORD_TOLERANCE / r))))),
  )
  const points: GcodePoint[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = a0 + (sweep * i) / steps
    const point = { ...from }
    point[frame.u] = center[frame.u] + r * Math.cos(a)
    point[frame.v] = center[frame.v] + r * Math.sin(a)
    point[frame.w] = from[frame.w] + (to[frame.w] - from[frame.w]) * t
    points.push(point)
  }
  // Pin exact endpoints (float drift on the last sample).
  points[0] = { ...from }
  points[points.length - 1] = { ...to }
  return points
}

/** Preserve the original G2/G3 geometry independently of the preview's
 * offset-free start point. I/J/K retain their distance mode; R keeps its sign so the
 * same command can be reconstructed from the live machine start later. */
function arcCommand(
  from: GcodePoint,
  to: GcodePoint,
  words: Map<string, number>,
  clockwise: boolean,
  plane: ArcPlane,
  absoluteCenter: boolean,
): PreviewArcCommand {
  const frame = ARC_PLANE_FRAME[plane]
  const targetAxes = (['x', 'y', 'z'] as const).filter((axis) => words.has(axis.toUpperCase()))
  const offsetU = words.get(frame.centerU)
  const offsetV = words.get(frame.centerV)
  if (offsetU !== undefined || offsetV !== undefined) {
    return {
      clockwise,
      from: { ...from },
      to: { ...to },
      targetAxes,
      ...(absoluteCenter ? { centerAbsolute: {
        ...(offsetU !== undefined ? { [frame.u]: offsetU } : {}),
        ...(offsetV !== undefined ? { [frame.v]: offsetV } : {}),
      } } : { centerOffset: {
        [frame.u]: offsetU ?? 0,
        [frame.v]: offsetV ?? 0,
      } }),
    }
  }
  const r = words.get('R')
  return {
    clockwise,
    from: { ...from },
    to: { ...to },
    targetAxes,
    ...(r !== undefined && r !== 0 ? { radius: r } : {}),
  }
}

function arcCenter(
  from: GcodePoint,
  to: GcodePoint,
  command: PreviewArcCommand,
  plane: ArcPlane,
): GcodePoint | null {
  const frame = ARC_PLANE_FRAME[plane]
  if (command.centerAbsolute) {
    const center = { ...from }
    center[frame.u] = command.centerAbsolute[frame.u] ?? from[frame.u]
    center[frame.v] = command.centerAbsolute[frame.v] ?? from[frame.v]
    return center
  }
  if (command.centerOffset) {
    const center = { ...from }
    center[frame.u] = from[frame.u] + (command.centerOffset[frame.u] ?? 0)
    center[frame.v] = from[frame.v] + (command.centerOffset[frame.v] ?? 0)
    return center
  }
  const r = command.radius
  if (r !== undefined) {
    const dx = to[frame.u] - from[frame.u]
    const dy = to[frame.v] - from[frame.v]
    const d = Math.hypot(dx, dy)
    if (d === 0 || d > Math.abs(r) * 2 + 1e-9) return null
    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4))
    // Perpendicular sign: positive R takes the short arc.
    const sign = (command.clockwise ? -1 : 1) * Math.sign(r)
    const mx = (from[frame.u] + to[frame.u]) / 2
    const my = (from[frame.v] + to[frame.v]) / 2
    const center = { ...from }
    center[frame.u] = mx - (sign * h * dy) / d
    center[frame.v] = my + (sign * h * dx) / d
    return center
  }
  return null
}

function arcPlanesByLine(lines: GcodeLine[]): Map<number, ArcPlane> {
  const result = new Map<number, ArcPlane>()
  let plane: ArcPlane = 'xy'
  for (const line of lines) {
    for (const word of line.words) {
      if (word.letter !== 'G') continue
      if (word.value === 17) plane = 'xy'
      else if (word.value === 18) plane = 'xz'
      else if (word.value === 19) plane = 'yz'
    }
    result.set(line.number, plane)
  }
  return result
}

function absoluteArcCentersByLine(lines: GcodeLine[]): Map<number, boolean> {
  const result = new Map<number, boolean>()
  let absolute = false
  for (const line of lines) {
    for (const word of line.words) {
      if (word.letter !== 'G') continue
      if (word.value === 90.1) absolute = true
      else if (word.value === 91.1) absolute = false
    }
    result.set(line.number, absolute)
  }
  return result
}

function scaledWordsByLine(lines: GcodeLine[]): Map<number, Map<string, number>> {
  const result = new Map<number, Map<string, number>>()
  let scale = 1
  for (const line of lines) {
    for (const word of line.words) {
      if (word.letter === 'G' && word.value === 20) scale = 25.4
      else if (word.letter === 'G' && word.value === 21) scale = 1
    }
    const words = new Map<string, number>()
    for (const word of line.words) {
      const letter = word.letter.toUpperCase()
      const dimensioned = letter === 'X' || letter === 'Y' || letter === 'Z'
        || letter === 'I' || letter === 'J' || letter === 'K' || letter === 'R'
      words.set(letter, dimensioned ? word.value * scale : word.value)
    }
    result.set(line.number, words)
  }
  return result
}

/** First usable (numeric) value of an address word on a line, if any. */
function coordWord(line: GcodeLine, letter: string): number | undefined {
  const w = line.words.find((w) => w.letter === letter)
  return w !== undefined && !Number.isNaN(w.value) ? w.value : undefined
}

/**
 * Expand ONE hole of an active drilling cycle into the moves the controller
 * executes, exactly as `emitDrillCycles` writes them (post/emit.ts):
 *   1. rapid across to the hole at the current height;
 *   2. rapid down to the R plane;
 *   3. feed to the hole bottom - G83 pecks by Q, retracting to R between
 *      pecks and rapiding back down to the last depth;
 *   4. rapid retract to R (G99) or to the cycle's initial Z (G98).
 * `pos` is advanced to where the cycle leaves the tool. A cycle with no depth
 * yet commanded drills nothing and only moves the work cursor in XY.
 */
function expandCannedCycle(
  cycle: CannedCycleState,
  pos: GcodePoint,
  targetX: number,
  targetY: number,
  returnToInitial: boolean,
  feedMmMin: number | null,
  line: number,
  explicitAxes: ReadonlyArray<CoordinateAxis>,
  workCoordinateSystem: WcsId | null,
  positionFrameChanged: boolean,
): ResolvedSegment[] {
  const out: ResolvedSegment[] = []
  const push = (
    kind: 'rapid' | 'feed',
    from: GcodePoint,
    to: GcodePoint,
    addressedAxes: ReadonlyArray<CoordinateAxis>,
    targetMode: PreviewTargetMode = 'absolute',
  ): void => {
    out.push({
      kind,
      from,
      to,
      line,
      coordinateFrame: 'work',
      workCoordinateSystem,
      addressedAxes,
      targetMode,
      feedMmMin: kind === 'rapid' ? null : feedMmMin,
    })
  }
  if (cycle.depthZ === null) {
    pos.x = targetX
    pos.y = targetY
    return out
  }
  const depth = cycle.depthZ
  const positionAxes = explicitAxes.filter((axis) => axis === 'x' || axis === 'y')
  // Equal work coordinates can still be real XY motion after a WCS change.
  // Preserve the implied rapid so the transfer checker resolves that target.
  if (Math.abs(targetX - pos.x) > CYCLE_EPS
    || Math.abs(targetY - pos.y) > CYCLE_EPS
    || (positionFrameChanged && positionAxes.length > 0)) {
    const from = { ...pos }
    pos.x = targetX
    pos.y = targetY
    push('rapid', from, { ...pos }, positionAxes)
  }
  const top = cycle.retractZ ?? pos.z
  // Keep an established R-plane target even when its raw number equals the
  // prior frame's Z. Across a WCS transition that apparent zero delta can be
  // real machine motion, and the transfer checker needs the implied move.
  if (Math.abs(top - pos.z) > CYCLE_EPS || (positionFrameChanged && cycle.retractZ !== null)) {
    const from = { ...pos }
    pos.z = top
    push('rapid', from, { ...pos }, ['z'])
  }
  const plunge = (to: number): void => {
    const from = { ...pos }
    pos.z = to
    push('feed', from, { ...pos }, ['z'])
  }
  const peck = cycle.code === 83 && cycle.peckQ !== null && cycle.peckQ > CYCLE_EPS
    ? cycle.peckQ
    : null
  if (peck !== null && top - depth > peck + CYCLE_EPS) {
    let cut = top
    while (cut - depth > CYCLE_EPS) {
      const next = Math.max(depth, cut - peck)
      plunge(next)
      if (next - depth > CYCLE_EPS) {
        // Full retract to R clears the chips, then rapid back to the cut.
        const up = { ...pos }
        pos.z = top
        push('rapid', up, { ...pos }, ['z'])
        const down = { ...pos }
        pos.z = next
        push('rapid', down, { ...pos }, ['z'])
      }
      cut = next
    }
  } else if (Math.abs(depth - pos.z) > CYCLE_EPS) {
    plunge(depth)
  }
  const retract = returnToInitial ? cycle.initialZ : (cycle.retractZ ?? cycle.initialZ)
  if (Math.abs(retract - pos.z) > CYCLE_EPS) {
    const from = { ...pos }
    pos.z = retract
    push('rapid', from, { ...pos }, ['z'], returnToInitial ? 'line-start' : 'absolute')
  }
  return out
}

/**
 * Recompute segment positions in canonical mm while honoring G20/G21 and
 * G90/G91. The shared parser treats raw coordinate words as absolute numbers,
 * so this is the one geometry seam that resolves units and distance mode for
 * every preview/path consumer. G53 is one-shot machine coordinates: record
 * only its explicitly commanded machine targets and do not fold them into the
 * work-coordinate path before a caller has a live work offset.
 *
 * It is also where the modal feed and spindle speed are read, and where a
 * canned drilling cycle becomes real moves - the shared parser knows neither.
 */
function resolveProgramSegments(
  lines: GcodeLine[],
  segments: GcodeSegment[],
): {
  resolved: ResolvedSegment[]
  spindleRpmMax: number
  addressedAxes: Partial<Record<CoordinateAxis, PreviewAxisAddress>>
} {
  const out: ResolvedSegment[] = []
  const addressedAxes: Partial<Record<CoordinateAxis, PreviewAxisAddress>> = {}
  const pos: GcodePoint = { x: 0, y: 0, z: 0 }
  let scale = 1
  let incremental = false
  let segIdx = 0
  let feedMmMin: number | null = null
  let spindleRpmMax = 0
  // G98 (return to the initial plane) is the controller power-on default.
  let returnToInitial = true
  let cycle: CannedCycleState | null = null
  let plane: ArcPlane = 'xy'
  let workCoordinateSystem: WcsId | null = null
  let positionFrame: WcsId | 'G53' | null = null
  for (const line of lines) {
    let machineCoordinates = false
    let startCycle: 81 | 82 | 83 | null = null
    for (const w of line.words) {
      if (w.letter !== 'G' || Number.isNaN(w.value)) continue
      if (w.value === 20) scale = 25.4
      else if (w.value === 21) scale = 1
      else if (w.value === 17) plane = 'xy'
      else if (w.value === 18) plane = 'xz'
      else if (w.value === 19) plane = 'yz'
      else if (w.value === 53) machineCoordinates = true
      else if (Number.isInteger(w.value) && w.value >= 54 && w.value <= 59) {
        workCoordinateSystem = `G${w.value}` as WcsId
      }
      else if (w.value === 90) incremental = false
      else if (w.value === 91) incremental = true
      else if (w.value === 98) returnToInitial = true
      else if (w.value === 99) returnToInitial = false
      else if (w.value === 0 || w.value === 1 || w.value === 2 || w.value === 3) cycle = null
      else if (w.value === 80) cycle = null
      else if (w.value === 81 || w.value === 82 || w.value === 83) startCycle = w.value
    }
    const feed = coordWord(line, 'F')
    if (feed !== undefined) feedMmMin = feed * scale
    const spindle = coordWord(line, 'S')
    if (spindle !== undefined && spindle > spindleRpmMax) spindleRpmMax = spindle
    if (startCycle !== null) {
      cycle = { code: startCycle, initialZ: pos.z, retractZ: null, depthZ: null, peckQ: null }
    }

    const seg = segments[segIdx]
    const attributed = seg !== undefined && seg.line === line.number
    const x = coordWord(line, 'X')
    const y = coordWord(line, 'Y')
    const z = coordWord(line, 'Z')
    const explicitAxes = (['x', 'y', 'z'] as const).filter(
      (axis) => (axis === 'x' ? x : axis === 'y' ? y : z) !== undefined,
    )
    const rememberAxes = (axes: ReadonlyArray<CoordinateAxis>): void => {
      for (const axis of axes) addressedAxes[axis] ??= { firstLine: line.number }
    }

    // The shared parser deliberately stays total and currently emits a modal
    // segment for coordinate-bearing parameter commands. G10 and G92 consume
    // X/Y/Z as parameters; they do not command axis motion or coverage.
    const parameterCoordinates = line.words.some(
      (word) => word.letter === 'G' && (word.value === 10 || word.value === 92),
    )
    if (parameterCoordinates) {
      if (attributed) segIdx++
      continue
    }

    // A drilling cycle's block is not the straight move the shared parser
    // inferred from the previous modal motion: expand it. Incremental cycles
    // (G91) are left to the plain path - LienCAM posts G90 cycles only.
    if (cycle && !incremental && !machineCoordinates
      && (x !== undefined || y !== undefined || z !== undefined)) {
      if (attributed) segIdx++
      const r = coordWord(line, 'R')
      const q = coordWord(line, 'Q')
      if (r !== undefined) cycle.retractZ = r * scale
      if (q !== undefined) cycle.peckQ = q * scale
      if (z !== undefined) cycle.depthZ = z * scale
      rememberAxes(explicitAxes)
      const positionFrameChanged = positionFrame !== workCoordinateSystem
      out.push(...expandCannedCycle(
        cycle,
        pos,
        x !== undefined ? x * scale : pos.x,
        y !== undefined ? y * scale : pos.y,
        returnToInitial,
        feedMmMin,
        line.number,
        explicitAxes,
        workCoordinateSystem,
        positionFrameChanged,
      ))
      positionFrame = workCoordinateSystem
      continue
    }

    if (!attributed) continue
    segIdx++
    const from: GcodePoint = { ...pos }
    if (machineCoordinates) {
      const machineTarget: Partial<GcodePoint> = {}
      if (x !== undefined) machineTarget.x = x * scale
      if (y !== undefined) machineTarget.y = y * scale
      if (z !== undefined) machineTarget.z = z * scale
      rememberAxes(explicitAxes)
      out.push({
        ...seg,
        from,
        to: { ...from },
        coordinateFrame: 'machine',
        workCoordinateSystem: null,
        machineTarget,
        addressedAxes: explicitAxes,
        targetMode: 'absolute',
        feedMmMin: null,
      })
      positionFrame = 'G53'
      continue
    }
    if (x !== undefined) pos.x = incremental ? from.x + x * scale : x * scale
    if (y !== undefined) pos.y = incremental ? from.y + y * scale : y * scale
    if (z !== undefined) pos.z = incremental ? from.z + z * scale : z * scale
    const segmentAxes = seg.kind === 'arc'
      ? Array.from(new Set<CoordinateAxis>([
          ...explicitAxes,
          ARC_PLANE_FRAME[plane].u,
          ARC_PLANE_FRAME[plane].v,
        ]))
      : explicitAxes
    rememberAxes(segmentAxes)
    out.push({
      ...seg,
      from,
      to: { ...pos },
      coordinateFrame: 'work',
      workCoordinateSystem,
      addressedAxes: segmentAxes,
      targetMode: incremental ? 'incremental' : 'absolute',
      feedMmMin: seg.kind === 'rapid' ? null : feedMmMin,
    })
    positionFrame = workCoordinateSystem
  }
  return { resolved: out, spindleRpmMax, addressedAxes }
}

export function buildPreviewModel(programText: string): PreviewModel {
  const program = parseGcode(stripPreviewComments(programText))
  const assessment = assessPreview(program.lines)
  if (assessment.refusal !== null) return refusedPreviewModel(assessment.refusal, assessment.notes)
  const polylines: PreviewPolyline[] = []
  const moves: PreviewMove[] = []
  const machineCoordinateRanges: PreviewModel['machineCoordinateRanges'] = {}
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const wordsByLine = scaledWordsByLine(program.lines)
  const planeByLine = arcPlanesByLine(program.lines)
  const absoluteCenterByLine = absoluteArcCentersByLine(program.lines)

  const pushPolyline = (
    seg: ResolvedSegment,
    points: Array<{ x: number; y: number }>,
    z0: number,
    z: number,
  ): void => {
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    polylines.push({ line: seg.line, kind: seg.kind, points, z0, z, feedMmMin: seg.feedMmMin })
  }

  const { resolved, spindleRpmMax, addressedAxes } = resolveProgramSegments(program.lines, program.segments)
  for (const seg of resolved) {
    if (seg.coordinateFrame === 'machine') {
      for (const axis of ['x', 'y', 'z'] as const) {
        const value = seg.machineTarget?.[axis]
        if (value === undefined) continue
        const range = machineCoordinateRanges[axis]
        machineCoordinateRanges[axis] = range
          ? { min: Math.min(range.min, value), max: Math.max(range.max, value) }
          : { min: value, max: value }
      }
      const target = { ...seg.from, ...seg.machineTarget }
      moves.push({
        line: seg.line,
        kind: seg.kind,
        plane: planeByLine.get(seg.line) ?? 'xy',
        coordinateFrame: 'machine',
        workCoordinateSystem: null,
        from: { ...target },
        to: { ...target },
        addressedAxes: seg.addressedAxes,
        targetMode: seg.targetMode,
        feedMmMin: seg.feedMmMin,
      })
      continue
    }
    const plane = planeByLine.get(seg.line) ?? 'xy'
    const pushMoves = (samples: GcodePoint[], sourceArc?: PreviewArcCommand): void => {
      for (let i = 1; i < samples.length; i++) {
        moves.push({
          line: seg.line,
          kind: seg.kind,
          plane,
          coordinateFrame: 'work',
          workCoordinateSystem: seg.workCoordinateSystem,
          from: { ...samples[i - 1] },
          to: { ...samples[i] },
          addressedAxes: seg.addressedAxes,
          targetMode: seg.targetMode,
          sourceArc,
          feedMmMin: seg.feedMmMin,
        })
      }
    }
    if (seg.kind === 'arc') {
      const words = wordsByLine.get(seg.line)
      const clockwise = seg.arc === 'cw'
      const sourceArc = words ? arcCommand(
        seg.from, seg.to, words, clockwise, plane, absoluteCenterByLine.get(seg.line) ?? false,
      ) : {
        clockwise,
        from: { ...seg.from },
        to: { ...seg.to },
        targetAxes: [],
      }
      const samples = samplePreviewArc(seg.from, seg.to, sourceArc, plane)
      pushMoves(samples, sourceArc)
      if (plane === 'xy') {
        // Preserve G17's established single-polyline representation byte for
        // byte; its Z is the helix axis and existing consumers interpolate it.
        pushPolyline(seg, samples.map((point) => ({ x: point.x, y: point.y })), seg.from.z, seg.to.z)
      } else {
        // PreviewPolyline carries only XY samples plus one Z range. Emit each
        // sampled non-XY edge separately so every existing 3D consumer sees
        // the arc's nonlinear Z without growing a second program-path adapter.
        for (let i = 1; i < samples.length; i++) {
          const from = samples[i - 1]
          const to = samples[i]
          pushPolyline(seg, [{ x: from.x, y: from.y }, { x: to.x, y: to.y }], from.z, to.z)
        }
      }
    } else {
      pushMoves([seg.from, seg.to])
      pushPolyline(seg, [
        { x: seg.from.x, y: seg.from.y },
        { x: seg.to.x, y: seg.to.y },
      ], seg.from.z, seg.to.z)
    }
  }

  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 1
    maxY = 1
  }
  // WO-1639: `buildPreviewModel` has no live machine position, so it starts
  // every program at an assumed work (0,0,0) - the ONLY way it can carry that
  // through the modal state needed to resolve every later move. That assumed
  // start is not a position the program commanded, so the table-fit bounds
  // must not include it. Using a move's END instead of its START (the first
  // attempt at this fix) is not enough: a move's END still carries the
  // assumed 0 on any axis IT did not command either (e.g. `G0 X500 Y300` /
  // `G0 Z-400` - the first move's end is (500,300,0), and that phantom Z0
  // leaked into workBounds exactly like a phantom start would). So each axis
  // is only let into workBounds once SOME work-frame move has actually
  // commanded it (`move.addressedAxes`, in program order) - before that, the
  // axis's value is still the unaddressed modal default, not a position the
  // program asked for. An axis the program never commands at all (a job with
  // no Z word anywhere) has no real value to fall back to either, so it keeps
  // today's default (0) for every move, unchanged. The drawn preview
  // (`polylines`, `moves`, `minX`/`minY`/`maxX`/`maxY` above) is untouched and
  // still starts at the assumed origin, exactly as it draws today.
  const workMoves = moves.filter((move) => move.coordinateFrame === 'work')
  const everAddressedByWorkMove = new Set<CoordinateAxis>()
  for (const move of workMoves) {
    for (const axis of move.addressedAxes) everAddressedByWorkMove.add(axis)
  }
  const axisRanges: Partial<Record<CoordinateAxis, PreviewAxisRange>> = {}
  const addressedSoFar = new Set<CoordinateAxis>()
  for (const move of workMoves) {
    for (const axis of move.addressedAxes) addressedSoFar.add(axis)
    const p = move.to
    for (const axis of ['x', 'y', 'z'] as const) {
      if (everAddressedByWorkMove.has(axis) && !addressedSoFar.has(axis)) continue
      const range = axisRanges[axis]
      axisRanges[axis] = range
        ? { min: Math.min(range.min, p[axis]), max: Math.max(range.max, p[axis]) }
        : { min: p[axis], max: p[axis] }
    }
  }
  const workBounds: PreviewBounds3 | null = axisRanges.x && axisRanges.y && axisRanges.z
    ? {
      min: { x: axisRanges.x.min, y: axisRanges.y.min, z: axisRanges.z.min },
      max: { x: axisRanges.x.max, y: axisRanges.y.max, z: axisRanges.z.max },
    }
    : null
  return {
    refusal: null,
    notes: assessment.notes,
    polylines,
    moves,
    addressedAxes,
    spindleRpmMax,
    workBounds,
    machineCoordinateRanges,
    minX,
    minY,
    maxX,
    maxY,
  }
}
