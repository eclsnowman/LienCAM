import type { MachineConfig, ToolpathMove } from '../../types'
import { controllerSettingBoolean, machineOutputForChannel, machineVacuumCapability } from '../../types'
import { enabledControlAxes, resolveHomingOrder, type ControlAxis } from '../machine/controller'
import {
  gcodeModalGroups,
  gcodeWordEntry,
  gcodeMacroRefusal,
  gcodeWordRefusal,
  gcodeOutputWords,
  gcodeWordTable,
  gcodeWordTableWithOutputs,
  gcodeWordTableForMachine,
  isGcodeMacroMCode,
  type GcodeWordEntry,
  type GcodeWordTable,
} from './wordTable'

export type GcodeDialect = 'uccnc' | 'grbl' | 'linuxcnc' | 'generic'
export type GcodeWcs = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59'
export type GcodeMotionAxis = 'x' | 'y' | 'z' | 'a' | 'b' | 'c'

export interface GcodeReaderPoint {
  x: number
  y: number
  z: number
  /** Rotary work coordinates, in degrees. Absent means this reader has not
   *  established that independent axis, not zero. */
  a?: number
  b?: number
  c?: number
}

/**
 * WO-2215: ONE WORK ORIGIN, in machine coordinates, and the XY rotation the
 * CONTROLLER holds for that work system (docs/design/WCS-ROTATION.md: degrees,
 * CCW seen from +Z; absent or 0 = none). The controller runs a work point as
 * machine = O + Rot(R)(work), so a machine point (G53, G28, G30) is the work
 * point Rot(-R)(machine - O). Z never turns. The reader never rotates a
 * program's own work moves - the controller does that - it only states a
 * machine point in the work frame the controller will report it in.
 */
export interface GcodeReaderWorkOffset extends GcodeReaderPoint {
  rotationDeg?: number
}

/** WO-2215: the rotation a work origin carries; 0 when it carries none. */
function offsetRotationDeg(offset: GcodeReaderWorkOffset): number {
  const degrees = offset.rotationDeg
  return typeof degrees === 'number' && Number.isFinite(degrees) ? degrees : 0
}

/** Rot(deg)(x, y) = (x cos a - y sin a, x sin a + y cos a) - the controller's. */
function rotateXY(degrees: number, x: number, y: number): { x: number; y: number } {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: x * c - y * s, y: x * s + y * c }
}

/**
 * WO-2215: THE WORK XY OF A MACHINE-FRAME XY TARGET under `offset`.
 *
 * `machineX` / `machineY` null mean the axis is not named and holds where the
 * machine already is (the machine point under the work point `pos`). Unrotated
 * this is exactly the arithmetic it always was - machine less offset per named
 * axis, the unnamed one untouched. Rotated, a machine X move changes work X
 * AND Y, so both come back through Rot(-R).
 */
function machineXYToWork(
  offset: GcodeReaderWorkOffset,
  pos: { x: number; y: number },
  machineX: number | null,
  machineY: number | null,
): { x: number; y: number } {
  const degrees = offsetRotationDeg(offset)
  if (degrees === 0) {
    return {
      x: machineX === null ? pos.x : machineX - offset.x,
      y: machineY === null ? pos.y : machineY - offset.y,
    }
  }
  if (machineX === null && machineY === null) return { x: pos.x, y: pos.y }
  const held = rotateXY(degrees, pos.x, pos.y)
  const mx = machineX ?? offset.x + held.x
  const my = machineY ?? offset.y + held.y
  return rotateXY(-degrees, mx - offset.x, my - offset.y)
}

/**
 * The reader keeps a complete endpoint for modal interpretation, but a posted
 * line does not necessarily command every coordinate in that endpoint.
 * `machineAbsolute` preserves the named G53 values before the active work
 * offset is used to continue interpreting later blocks.
 */
export interface GcodeReaderMove extends ToolpathMove {
  machineAbsolute?: Partial<GcodeReaderPoint>
  /** Axes whose endpoint belongs to the program rather than the reader's
   *  load-time starting point. Kept off the enumerable geometry surface: the
   *  preview still needs a complete modal endpoint, while a staged line must
   *  omit axes the file has never established so the controller holds their
   *  execution-time coordinates. */
  executionAxes?: readonly GcodeMotionAxis[]
}

export interface GcodeReaderOptions {
  /** Controls dialect-specific meanings, most importantly the G4/G82 P unit. */
  dialect: GcodeDialect
  /** The work system selected in the live machine session. */
  sessionWcs: GcodeWcs
  /** Current position in that work system when the first block is read. */
  initialPosition: GcodeReaderPoint
  /** Machine-native units, used only when the file has no G20/G21 word. */
  machineUnits?: 'mm' | 'inch'
  /**
   * WO-1335 re-scope: USER MACRO CALLS BECOME AN ITEM INSTEAD OF A REFUSAL.
   *
   * The dialect's word table names the M-code range its controller runs as
   * user macros, and Fusion's UCCNC post emits one (`M2001`, "Park Position to
   * Screw Down Material"). The reader cannot execute a macro and never
   * pretends to - it reports it, and the caller decides what a line it cannot
   * run means on its route. Absent, or outside that range, the M-code is
   * refused with the table's sentence.
   */
  macroMCodes?: 'refuse' | 'report'
  /** Machine coordinates of each work origin. Required to resolve a G53 block.
   *  WO-2215: with the rotation the controller holds for that system, if any. */
  workOffsets?: Partial<Record<GcodeWcs, GcodeReaderWorkOffset>>
  /**
   * WHERE `G28` GOES, IN MACHINE COORDINATES (WO-1337, WO-1644).
   *
   * `G28` is a rapid to the machine's stored home position. UCCNC and LinuxCNC
   * run it whether or not the machine has been homed - the position is in the
   * machine coordinates the controller holds - so this is the machine
   * definition's home position, supplied regardless of homing. ABSENT, it is
   * machine zero: the stored G28 position both controllers start from.
   *
   * With it, `G28` resolves at load exactly as `G53` does - through the
   * controller's own reported work offset, `work = machine - offset` - for the
   * modal position, while the home leg itself goes out machine-absolute on the
   * axes it names, as G53 and G30 do (WO-2207): a rotated work offset turns no
   * machine point.
   */
  machineHome?: GcodeReaderPoint
  /** Machine-frame G30 points from the active machine definition (WO-1362). */
  referencePositions?: Partial<Record<1 | 2 | 3 | 4, GcodeReaderPoint>>
  /**
   * THE MACHINE'S OWN DWELL P UNIT (WO-1559).
   *
   * UCCNC makes the G4/G82 P word a MACHINE SETTING, not a dialect constant:
   * `Generalsettings.Dwellinseconds` (imported by `uccncProfileImport.ts`,
   * shown in the definition's General section). Operator's machine states False, so
   * its P is milliseconds and `G4 P2000` dwells 2 s; a machine that states True
   * reads P as seconds. The active definition is passed here and the reader
   * reads that setting. ABSENT, or a definition that does not state the key,
   * means the machine has not said, and the DIALECT's own default decides -
   * UCCNC and Generic milliseconds, GRBL and LinuxCNC seconds.
   */
  machineDefinition?: (Pick<MachineConfig, 'controller' | 'controllerDefinition'>
    & Partial<Pick<MachineConfig, 'coolantCapability' | 'macros' | 'macroMCodeRange'>>) | null
  /**
   * WORDS THIS CALLER CANNOT HONOUR (WO-1335).
   *
   * The reader's own accepted set is what the SHARED vocabulary can carry. A
   * caller whose route is narrower - the geometry program route cannot express
   * a dwell, a machine-frame block or an inch file - names those words here and
   * gets the same refusal shape as any other: one line, one word, no partial
   * program. The alternative was a second tokenizer in the caller, which is
   * exactly the second authority WO-1288's consolidation boundary forbids.
   *
   * Checked BEFORE the block is applied, so a refused word never moves the
   * modal state or produces a move.
   */
  refuse?: readonly GcodeRefusedWord[]
  /**
   * THE LENGTH THE MACHINE'S TOOL TABLE HOLDS FOR TOOL n, in mm (WO-1677).
   *
   * A `G43 H<n>` shifts every absolute Z below it by what this answers for n -
   * the same number G43.1 applies from the tool-length panel. The shift is
   * folded into the staged Z itself, so the controller's work offset is never
   * written by a program and nothing is left shifted when the run ends, however
   * it ends. ABSENT, or answering zero for an unmeasured tool, the shift is
   * zero: what UCCNC's and LinuxCNC's tables answer for an unmeasured row.
   *
   * `wcs` is the frame the governed moves run in. A controller-side length
   * already in force there (the panel's, or a guided tool change's) is part
   * of that frame's offset, and `G43 H<n>` REPLACES it on a real controller,
   * so the caller answers net of it. Asked again when the file changes frame.
   */
  toolLengthMm?: (h: number, wcs: GcodeWcs) => number
}

/** One word a caller's route cannot honour, with the caller's own reason. The
 *  word is spelled as it appears in the file (`G20`, `G91`, `M8`); the reason
 *  completes the sentence "Line 12: G20 ...". */
export interface GcodeRefusedWord {
  word: string
  reason: string
}

export type GcodeReadItem =
  | { kind: 'move'; line: number; moveIndex: number; wcs: GcodeWcs }
  | { kind: 'dwell'; line: number; seconds: number }
  | { kind: 'tool-select'; line: number; tool: number }
  | { kind: 'tool-change'; line: number; tool: number }
  | { kind: 'pause'; line: number; optional: boolean }
  | { kind: 'spindle'; line: number; on: boolean; direction?: 'cw' | 'ccw'; rpm?: number }
  /** M7/M8/M9, and (WO-1650) any word the machine definition points at one of
   *  its outputs. `outputs` is the set of listed outputs the file has ON after
   *  this word, each named by its on word's number; it is present only when
   *  the machine lists output words beyond the dialect's coolant words. */
  | { kind: 'coolant'; line: number; flood: boolean; mist: boolean; outputs?: number[] }
  | { kind: 'program-end'; line: number; code: 'M2' | 'M30' }
  | { kind: 'work-offset'; line: number; wcs: GcodeWcs }
  | { kind: 'tool-length-offset'; line: number; enabled: boolean; tool?: number }
  | { kind: 'path-control'; line: number; mode: 'exact-stop' | 'continuous' }
  /** WO-1335: a user macro call (`M2001`) this reader cannot execute and will
   *  not silently drop. Only produced under `macroMCodes: 'report'`.
   *  `toolChange` (WO-1652): the tool the bound macro's `toolChange()` fits,
   *  when its body calls it - the file's tool list counts it. */
  | { kind: 'macro'; line: number; code: number; toolChange?: number }
  /** WO-1335: a word this route honours by doing nothing, reported so the
   *  caller can SAY so once rather than leave the operator guessing whether it
   *  was read. `G94` is the only feed mode this app has; `G64` is a controller
   *  path-blending hint the geometry queue does not carry. */
  | { kind: 'accepted-no-op'; line: number; word: string }

export interface GcodeReaderState {
  position: GcodeReaderPoint
  /** False axes are not valid in the active WCS and must be re-established. */
  positionKnown: Record<'x' | 'y' | 'z', boolean>
  units: 'mm' | 'inch'
  distanceMode: 'absolute' | 'incremental'
  motion: 'G0' | 'G1' | 'G2' | 'G3' | null
  wcs: GcodeWcs
  feedMmMin: number | null
  spindleRpm: number | null
  /** THE PRESELECT: the last `T` word read. A `T` on its own tells the machine
   *  which cutter to have ready; it does NOT put it in the spindle. */
  selectedTool: number | null
  /** THE CUTTER ACTUALLY FITTED, changed by `M6` and by nothing else. This is
   *  the one a `G43 H` may name and the one a tool-change boundary reports. */
  inSpindleTool: number | null
  coolant: { flood: boolean; mist: boolean; outputs?: number[] }
}

export interface GcodeReadProgram {
  moves: GcodeReaderMove[]
  /** Source line for moves[i]. */
  moveLines: number[]
  /** Work offset active for moves[i]; the file door resolves it against the machine. */
  moveWcs: GcodeWcs[]
  /** Motion and non-motion commands in source order. */
  items: GcodeReadItem[]
  /** WO-1652: a code the dialect gives a standard meaning (M6, M7, ...) that
   *  one of this machine's macros also carries. The program ALWAYS keeps the
   *  standard meaning; the caller says what the binding does (M6: the macro
   *  runs first, then the tool change; any other code: not run by a program).
   *  Absent when there are none. */
  tableCodeMacroBindings?: { line: number; code: number }[]
  end: GcodeReaderState
}

export interface GcodeReadRefusal {
  line: number
  reason: string
  message: string
}

export type GcodeReadResult =
  | { ok: true; program: GcodeReadProgram }
  | { ok: false; refusal: GcodeReadRefusal }

interface Word {
  letter: string
  value: number
}

interface Block {
  line: number
  words: Word[]
}

interface Cycle {
  code: 81 | 82 | 83
  initialZ: number
  depthZ: number | null
  retractZ: number | null
  peckMm: number | null
  dwellSeconds: number | null
}

type PositionKnowledge = Record<'x' | 'y' | 'z', boolean>
type RotaryAxisKey = 'a' | 'b' | 'c'

const ROTARY_AXES: readonly { upper: Extract<ControlAxis, 'A' | 'B' | 'C'>; lower: RotaryAxisKey }[] = [
  { upper: 'A', lower: 'a' },
  { upper: 'B', lower: 'b' },
  { upper: 'C', lower: 'c' },
]

interface CoordinateFrameState {
  wcs: GcodeWcs
  /** The H index the file last named, for the record. The session resolves it
   *  against the machine's tool table when the program runs (WO-1677); the
   *  reader only carries the number. */
  toolLengthOffset: number | null
  /** The Z shift `G43 H<n>` applies, in mm: the length the caller's tool table
   *  answers for n (`toolLengthMm`, WO-1677), zero for an unmeasured tool, and
   *  null before any G43 is seen. A KNOWN shift is what lets Z carry across the frame instead of being
   *  invalidated, which is why a G53 Z after a G43 resolves. */
  toolLengthShiftMm: number | null
}

// CONSOLIDATION BOUNDARY (WO-1288): this is the one safety reader for a whole
// file. The older helpers remain only where they answer a different question.
// parse.ts is the total tokenizer/modal substrate used by lint and backplot;
// pathFidelity derives comparison geometry; runFromLine reconstructs a prefix;
// and simulatedController executes already-approved items with simulated state.
// previewGeometry and its programPath caller stay on the total parser until
// WO-1289 moves preview to this strict supported-set; that WO owns their files.
// None of those helpers is a second authority for whether a file may run.

const SUPPORTED_ADDRESSES = new Set([
  'G', 'M', 'N', 'X', 'Y', 'Z', 'A', 'B', 'C', 'I', 'J', 'K', 'R', 'F', 'S', 'T', 'P', 'Q', 'H', 'L',
])
// WO-1644: WHICH WORDS ARE ACCEPTED, THEIR MODAL GROUPS AND THE SENTENCE FOR A
// WORD THAT IS NOT are the dialect's word table (`wordTable.ts`), read at the
// moment a file is read. This reader keeps no list of its own.

/** Table words a file cannot carry on this reader, because each is a call the
 *  app makes on its own route (the offsets table, the probe cycle, the TLO
 *  panel) rather than a block with a place in a program's geometry. The
 *  sentence is built from the table's own meaning for the word. */
const NOT_A_PROGRAM_BLOCK = (entry: GcodeWordEntry): boolean =>
  entry.category === 'probe' || entry.category === 'offset write' || entry.word === 'G43.1'
const WORD_RE = /^([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/
const EPS = 1e-9
const NON_XY_ARC_TOLERANCE_MM = 0.05

/** WO-1650: the outputs a machine names words for - its one list, and the
 *  vacuum word its coolant record states when the list carries no vacuum
 *  entry. The post writes the vacuum word from that same answer
 *  (`machineVacuumCapability`), so the reader accepts exactly what the post
 *  can write. */
function readerOutputSources(
  machine: GcodeReaderOptions['machineDefinition'],
): { name: string; onCode: string; offCode: string | null; besideWord?: boolean }[] {
  const listed = machine?.controllerDefinition?.outputs ?? []
  if (machine == null || machineOutputForChannel(machine, 'vacuum') !== null) return [...listed]
  const vacuum = machineVacuumCapability(machine)?.onCode
  return vacuum ? [...listed, { name: 'vacuum', onCode: vacuum, offCode: null }] : [...listed]
}

function refusal(line: number, reason: string): GcodeReadResult {
  return { ok: false, refusal: { line, reason, message: `Line ${line}: ${reason}` } }
}

function codeOutsideComments(raw: string): { ok: true; code: string } | { ok: false; reason: string } {
  let depth = 0
  let code = ''
  for (const ch of raw.replace(/\r$/, '')) {
    if (ch === ';' && depth === 0) break
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')') {
      if (depth === 0) return { ok: false, reason: 'an unmatched comment terminator was found' }
      depth--
      continue
    }
    if (depth === 0) code += ch
  }
  if (depth !== 0) return { ok: false, reason: 'an unterminated comment was found' }
  return { ok: true, code: code.trim() }
}

function tokenizeStrict(text: string): { ok: true; blocks: Block[] } | { ok: false; result: GcodeReadResult } {
  const blocks: Block[] = []
  const physical = text.split('\n')
  for (let index = 0; index < physical.length; index++) {
    const line = index + 1
    const stripped = codeOutsideComments(physical[index])
    if (!stripped.ok) return { ok: false, result: refusal(line, stripped.reason) }
    if (stripped.code === '' || stripped.code === '%') continue
    const words: Word[] = []
    let rest = stripped.code
    while (rest.length > 0) {
      const whitespace = /^\s+/.exec(rest)
      if (whitespace) {
        rest = rest.slice(whitespace[0].length)
        continue
      }
      const match = WORD_RE.exec(rest)
      if (!match) return { ok: false, result: refusal(line, `token "${rest[0]}" is not understood`) }
      const letter = match[1].toUpperCase()
      if (!SUPPORTED_ADDRESSES.has(letter)) {
        return { ok: false, result: refusal(line, `address ${letter} is not understood`) }
      }
      words.push({ letter, value: Number(match[2]) })
      rest = rest.slice(match[0].length)
    }
    blocks.push({ line, words })
  }
  return { ok: true, blocks }
}

function values(block: Block, letter: string): number[] {
  return block.words.filter((word) => word.letter === letter).map((word) => word.value)
}

function first(block: Block, letter: string): number | null {
  const word = block.words.find((candidate) => candidate.letter === letter)
  return word?.value ?? null
}

function blockConflict(block: Block, table: GcodeWordTable): string | null {
  for (const letter of SUPPORTED_ADDRESSES) {
    if (letter === 'G' || letter === 'M') continue
    if (values(block, letter).length > 1) return `address ${letter} appears more than once in one block`
  }
  const gs = values(block, 'G')
  for (const group of gcodeModalGroups(table, 'G')) {
    const members = gs.filter((g) => group.codes.has(g))
    if (members.length > 1) {
      return `${members.map((g) => `G${g}`).join(' and ')} conflict in the ${group.name} modal group`
    }
  }
  return null
}

function wcsOf(code: number): GcodeWcs {
  return `G${code}` as GcodeWcs
}

/**
 * THE DIALECT'S OWN DWELL P UNIT, used only when the machine has not said
 * (WO-1559, WO-1741). UCCNC and Generic use milliseconds; GRBL and
 * LinuxCNC use seconds.
 */
function dialectDwellUnit(dialect: GcodeDialect): 'ms' | 's' {
  return dialect === 'uccnc' || dialect === 'generic' ? 'ms' : 's'
}

/**
 * THE MACHINE'S OWN DWELL P UNIT (WO-1559). Reads UCCNC's
 * `Generalsettings.Dwellinseconds` off the active definition under the
 * definition's own controller - so a GRBL machine's definition can never
 * answer a UCCNC key. When the machine states the setting it decides;
 * otherwise the dialect default does.
 */
export function dwellUnitsFromMachine(
  machine: Pick<MachineConfig, 'controller' | 'controllerDefinition'> | null | undefined,
  dialect: GcodeDialect,
): 'ms' | 's' {
  const stated = machine?.controllerDefinition
    ? controllerSettingBoolean(
      machine.controllerDefinition.settings,
      machine.controller,
      'Generalsettings.Dwellinseconds',
    )
    : null
  return stated === null ? dialectDwellUnit(dialect) : stated ? 's' : 'ms'
}

function dwellSeconds(value: number, unit: 'ms' | 's'): number {
  return unit === 'ms' ? value / 1000 : value
}

function directedSweep(
  from: GcodeReaderPoint,
  to: GcodeReaderPoint,
  centre: { x: number; y: number },
  clockwise: boolean,
): number {
  const start = Math.atan2(from.y - centre.y, from.x - centre.x)
  const end = Math.atan2(to.y - centre.y, to.x - centre.x)
  let sweep = end - start
  if (clockwise) {
    while (sweep >= 0) sweep -= Math.PI * 2
  } else {
    while (sweep <= 0) sweep += Math.PI * 2
  }
  return sweep
}

function minorRadiusCentre(
  from: GcodeReaderPoint,
  to: GcodeReaderPoint,
  radius: number,
  clockwise: boolean,
): { ok: true; centre: { x: number; y: number } } | { ok: false; reason: string } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const chord = Math.hypot(dx, dy)
  if (chord <= EPS) return { ok: false, reason: 'an R-form full circle is undefined' }
  if (radius <= 0) return { ok: false, reason: 'a negative R requests the ambiguous greater-than-180-degree arc' }
  if (chord > radius * 2 + EPS) return { ok: false, reason: 'the R radius is smaller than half the endpoint chord' }
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const height = Math.sqrt(Math.max(0, radius * radius - chord * chord / 4))
  const nx = -dy / chord
  const ny = dx / chord
  const candidates = [
    { x: mx + nx * height, y: my + ny * height },
    { x: mx - nx * height, y: my - ny * height },
  ]
  const centre = candidates.find((candidate) =>
    Math.abs(directedSweep(from, to, candidate, clockwise)) <= Math.PI + EPS,
  )
  return centre ? { ok: true, centre } : { ok: false, reason: 'the R-form minor arc could not be resolved' }
}

type ArcPlane = 'G17' | 'G18' | 'G19'

function planePoint(point: GcodeReaderPoint, plane: ArcPlane): { u: number; v: number; w: number } {
  if (plane === 'G18') return { u: point.z, v: point.x, w: point.y }
  if (plane === 'G19') return { u: point.y, v: point.z, w: point.x }
  return { u: point.x, v: point.y, w: point.z }
}

function fromPlanePoint(point: { u: number; v: number; w: number }, plane: ArcPlane): GcodeReaderPoint {
  if (plane === 'G18') return { x: point.v, y: point.w, z: point.u }
  if (plane === 'G19') return { x: point.w, y: point.u, z: point.v }
  return { x: point.u, y: point.v, z: point.w }
}

function arcSegmentCount(radius: number, sweep: number): number {
  if (radius <= NON_XY_ARC_TOLERANCE_MM) return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const maxAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - NON_XY_ARC_TOLERANCE_MM / radius)))
  return Math.max(1, Math.ceil(Math.abs(sweep) / maxAngle))
}

/**
 * The chord polyline a non-XY arc is staged as, and the distance actually
 * travelled along it. The plane mapping is an axis permutation, so a length
 * measured in (u, v, w) is the same length in machine coordinates.
 */
function linearisedArc(
  start: { u: number; v: number; w: number },
  end: { u: number; v: number; w: number },
  centre: { x: number; y: number },
  radius: number,
  sweep: number,
): { points: { u: number; v: number; w: number }[]; length: number } {
  const segments = arcSegmentCount(radius, sweep)
  const startAngle = Math.atan2(start.v - centre.y, start.u - centre.x)
  const points: { u: number; v: number; w: number }[] = []
  let length = 0
  let previous = start
  for (let segment = 1; segment <= segments; segment++) {
    const fraction = segment / segments
    const point = segment === segments ? end : {
      u: centre.x + radius * Math.cos(startAngle + sweep * fraction),
      v: centre.y + radius * Math.sin(startAngle + sweep * fraction),
      w: start.w + (end.w - start.w) * fraction,
    }
    length += Math.hypot(point.u - previous.u, point.v - previous.v, point.w - previous.w)
    points.push(point)
    previous = point
  }
  return { points, length }
}

function uncommentedBody(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** WO-1652: the tool a macro body's `toolChange()` fits, FOR THE LOAD LINE'S
 *  TOOL COUNT ONLY - its whole-number argument, or else the file's preselect
 *  (`T2 M1600` fits T2 as `T2 M6` does). Undefined when no such call is
 *  written or no tool is known. Only ever asked of a macro on a code the
 *  dialect gives no meaning (M1600, M2001): nothing about motion or the
 *  tool-change hold is decided from a macro's text. A call the text hides (in
 *  a string, a computed name) is miscounted here and nowhere else. */
function macroToolChangeTool(body: string | undefined, selectedTool: number | null): number | undefined {
  if (typeof body !== 'string') return undefined
  const call = /(^|[^\w.$])toolChange\s*\(\s*(\d*)\s*\)/.exec(uncommentedBody(body))
  if (call === null) return undefined
  if (call[2] !== '') return Number(call[2]) > 0 ? Number(call[2]) : undefined
  return selectedTool ?? undefined
}

/**
 * Read a complete G-code file into the app's canonical-mm move vocabulary.
 * A failure contains no partial program: callers cannot accidentally run the
 * prefix that happened to be understood before the refusing line.
 */
export function readGcodeProgram(text: string, options: GcodeReaderOptions): GcodeReadResult {
  const tokenized = tokenizeStrict(text)
  if (!tokenized.ok) return tokenized.result
  const blocks = tokenized.blocks
  const firstLine = blocks[0]?.line ?? 1
  if (
    options.dialect !== 'uccnc'
    && options.dialect !== 'grbl'
    && options.dialect !== 'linuxcnc'
    && options.dialect !== 'generic'
  ) {
    return refusal(firstLine, `dialect "${String(options.dialect)}" is not recognised, so dwell P units are unknown`)
  }
  // WO-1559: the P unit is fixed once per file, from the machine when it
  // states `Dwellinseconds` and from the dialect otherwise.
  const dwellUnit = dwellUnitsFromMachine(options.machineDefinition, options.dialect)
  // WO-1650: the dialect's table WITH THIS MACHINE'S OWN OUTPUT WORDS - a pump
  // the definition puts on M10 is a word this file may carry.
  const definedOutputs = readerOutputSources(options.machineDefinition)
  const table = gcodeWordTableForMachine(
    gcodeWordTableWithOutputs(gcodeWordTable(options.dialect), definedOutputs),
    options.machineDefinition,
  )
  const outputWords = gcodeOutputWords(options.dialect, definedOutputs)
  // One definition decides which coordinates exist. Enabled slave motors do
  // not: Operator's A follows Y and is not a second coordinate a file may command.
  const controlAxes = new Set(enabledControlAxes(options.machineDefinition?.controllerDefinition))
  // WO-1652: A CODE ONE OF THIS MACHINE'S MACROS CARRIES IS A MACRO CALL, at
  // any number - the dialect's user-macro range is only what the controller
  // does with a code nobody bound. Reported like any other macro call; the
  // caller runs the macro.
  //
  // ONE RULE for a code the dialect table ALREADY gives a meaning (M3, M6, M7,
  // an output word): in a running program that meaning ALWAYS happens, and no
  // macro's text is inspected to decide otherwise (fix round 4, re-scoped).
  // The code is read as its standard word and the binding is reported: the
  // session runs a macro on M6 as a PRELUDE before the one tool-change hold,
  // and says a macro on any other table code is not run by a program. The
  // binding still answers its button and a typed code. The macro meant is the
  // first carrying the code - the one the session runs (`boundMacro`).
  const boundMacroCodes = new Set<number>()
  const tableCodesWithMacro = new Set<number>()
  const boundMacroBodies = new Map<number, string | undefined>()
  // WO-2657: A MACRO HIDDEN FROM THE MACROS PANEL IS OFF. Its code reads as if
  // no macro carried it; the name is kept only to say why a code is refused.
  const hiddenMacroNames = new Map<number, string>()
  for (const macro of options.machineDefinition?.macros ?? []) {
    const code = macro.mCode
    if (typeof code !== 'number' || !Number.isInteger(code)) continue
    if (macro.hidden) {
      if (!hiddenMacroNames.has(code)) hiddenMacroNames.set(code, macro.name)
      continue
    }
    if (boundMacroCodes.has(code) || tableCodesWithMacro.has(code)) continue
    if (gcodeWordEntry(table, 'M', code) === null) {
      boundMacroCodes.add(code)
      boundMacroBodies.set(code, macro.body)
    } else tableCodesWithMacro.add(code)
  }
  const tableCodeMacroBindings: { line: number; code: number }[] = []
  const hasUnits = blocks.some((block) => values(block, 'G').some((g) => g === 20 || g === 21))
  if (!hasUnits && options.machineUnits === undefined) {
    return refusal(firstLine, 'no G20 or G21 units word appears in the file and the machine units are unknown')
  }

  const refusedWords = new Map<string, string>(
    (options.refuse ?? []).map((entry) => [entry.word.toUpperCase(), entry.reason]),
  )

  const moves: GcodeReaderMove[] = []
  const moveLines: number[] = []
  const moveWcs: GcodeWcs[] = []
  const items: GcodeReadItem[] = []
  // The reader starts with a complete point for geometry, but none of those
  // coordinates came from the file. Once a program motion establishes an axis,
  // later modal lines carry it; axes never established remain controller-modal
  // at execution. This is deliberately separate from positionKnown, which says
  // whether interpretation is possible, not who owns the coordinate.
  const programAxes = new Set<GcodeMotionAxis>()
  let pos = { ...options.initialPosition }
  let positionKnown: PositionKnowledge = { x: true, y: true, z: true }
  let scale: number | null = options.machineUnits === 'inch' ? 25.4 : options.machineUnits === 'mm' ? 1 : null
  let units: GcodeReaderState['units'] | null = options.machineUnits ?? null
  let distanceMode: GcodeReaderState['distanceMode'] = 'absolute'
  let arcCentreMode: 'absolute' | 'incremental' = 'incremental'
  let plane: ArcPlane = 'G17'
  let feedMode: 'inverse-time' | 'units-per-minute' = 'units-per-minute'
  // UCCNC starts with G0 active (its manual's Run-screen reset state shows
  // "ACTIVE G0|G90"). A coordinate on an opening G43 block therefore uses
  // the controller's real reset mode instead of being rejected as ambiguous.
  let motion: GcodeReaderState['motion'] = 'G0'
  let feedMmMin: number | null = null
  // G93's F is a duration for one block, not a units-per-minute speed that can
  // survive a later G94. Keep the invalidation explicit so the first G94 cut
  // names the missing command instead of silently reviving an older feed.
  let feedMmMinInvalidatedByG93 = false
  let spindleRpm: number | null = null
  // PRESELECT AND IN-SPINDLE ARE TWO STATES (WO-1335 architect ruling,
  // 2026-09-11T05:31Z). A standalone `T` is a preselection - it names the
  // cutter to have ready and changes nothing about the machine's Z. `M6` is
  // what FITS the preselected tool, and only then is a different cutter in the
  // spindle. Holding both in one variable is what let a `T2` typed after a
  // `T1 M6` decide what `G43 H1` resolved against, and so what depth every
  // subsequent absolute Z cut at.
  let selectedTool: number | null = null
  let inSpindleTool: number | null = null
  let coolant = { flood: false, mist: false }
  // WO-1650: the listed outputs the file has on, by on-word number, sorted.
  let outputsOn: number[] = []
  const coolantState = (): { flood: boolean; mist: boolean; outputs?: number[] } =>
    (outputWords.size === 0 ? { ...coolant } : { ...coolant, outputs: [...outputsOn] })
  let returnToInitial = true
  let cycle: Cycle | null = null
  let programEndSeen = false
  let programEndCode: 'M2' | 'M30' | null = null
  let activeWcs = options.sessionWcs
  let coordinateFrame: CoordinateFrameState = {
    wcs: options.sessionWcs,
    toolLengthOffset: null,
    toolLengthShiftMm: null,
  }
  /** The Z shift an active, RESOLVED `G43 H<n>` adds to every absolute Z below.
   *  Zero while no G43 is active; after one, the length the machine's tool
   *  table holds for the H it names (WO-1677), zero for an unmeasured tool -
   *  what the operator's own controller applies for that row. */
  let zShiftMm = 0

  const pushMove = (line: number, move: GcodeReaderMove): void => {
    // These are execution facts, not geometric coordinates. Keep them off the
    // enumerable ToolpathMove surface so existing preview/backplot consumers
    // continue to see the canonical geometry object they already understand.
    if (move.machineAbsolute !== undefined) {
      Object.defineProperty(move, 'machineAbsolute', { value: move.machineAbsolute, enumerable: false })
    }
    Object.defineProperty(move, 'executionAxes', { value: [...programAxes], enumerable: false })
    moves.push(move)
    moveLines.push(line)
    moveWcs.push(activeWcs)
    items.push({ kind: 'move', line, moveIndex: moves.length - 1, wcs: activeWcs })
  }
  const targetAxis = (raw: number | null, current: number): number => {
    if (raw === null || scale === null) return current
    return distanceMode === 'incremental' ? current + raw * scale : raw * scale
  }
  /** Z is the one axis a resolved `G43 H` moves the reference of. An INCREMENTAL
   *  Z is a distance and a distance is unaffected by where the reference sits,
   *  so the shift is added to absolute targets only. */
  const targetZ = (raw: number | null, current: number): number => {
    if (raw === null || scale === null) return current
    return distanceMode === 'incremental' ? current + raw * scale : raw * scale + zShiftMm
  }
  const targetRotary = (raw: number | null, current: number | undefined): number | undefined => {
    if (raw === null) return current
    if (distanceMode === 'absolute') return raw
    return current === undefined ? undefined : current + raw
  }
  const rotaryPosition = (point: GcodeReaderPoint): Partial<GcodeReaderPoint> => ({
    ...(typeof point.a === 'number' && Number.isFinite(point.a) ? { a: point.a } : {}),
    ...(typeof point.b === 'number' && Number.isFinite(point.b) ? { b: point.b } : {}),
    ...(typeof point.c === 'number' && Number.isFinite(point.c) ? { c: point.c } : {}),
  })
  const unknownAxes = (knowledge: PositionKnowledge): string[] => (
    (['x', 'y', 'z'] as const).filter((axis) => !knowledge[axis]).map((axis) => axis.toUpperCase())
  )
  const toolLengthShiftFor = (h: number, wcs: GcodeWcs): number => {
    const answered = options.toolLengthMm?.(h, wcs) ?? 0
    return Number.isFinite(answered) ? answered : 0
  }
  const transitionCoordinateFrame = (next: CoordinateFrameState): void => {
    if (next.wcs !== coordinateFrame.wcs) {
      const previousOffset = options.workOffsets?.[coordinateFrame.wcs]
      const nextOffset = options.workOffsets?.[next.wcs]
      // The same physical point can be rebased only when both work origins are
      // known. An active, controller-owned H offset cancels because it is the
      // same on both sides of this WCS-only transition.
      if (previousOffset && nextOffset) {
        // WO-2215: through each frame's rotation when either carries one -
        // machine = O + Rot(R)(work) on one side, back through the other.
        const turned = offsetRotationDeg(previousOffset) === 0 && offsetRotationDeg(nextOffset) === 0
          ? null
          : (() => {
              const held = rotateXY(offsetRotationDeg(previousOffset), pos.x, pos.y)
              return rotateXY(
                -offsetRotationDeg(nextOffset),
                previousOffset.x + held.x - nextOffset.x,
                previousOffset.y + held.y - nextOffset.y,
              )
            })()
        pos = {
          x: turned === null ? pos.x + previousOffset.x - nextOffset.x : turned.x,
          y: turned === null ? pos.y + previousOffset.y - nextOffset.y : turned.y,
          z: pos.z + previousOffset.z - nextOffset.z,
          ...Object.fromEntries(ROTARY_AXES.flatMap(({ upper, lower }) => {
            if (!controlAxes.has(upper)) return []
            const current = pos[lower]
            const previous = previousOffset[lower]
            const following = nextOffset[lower]
            return typeof current === 'number' && typeof previous === 'number' && typeof following === 'number'
              ? [[lower, current + previous - following]]
              : []
          })),
        }
      } else {
        positionKnown = { x: false, y: false, z: false }
      }
    }
    if (next.toolLengthOffset !== coordinateFrame.toolLengthOffset && next.toolLengthShiftMm === null) {
      // H changes the Z reference by a controller-owned magnitude. X/Y and all
      // unrelated modal state carry; Z cannot carry into the new frame.
      //
      // WO-1335: A RESOLVED SHIFT IS NOT A CONTROLLER-OWNED MAGNITUDE. When the
      // caller answered for this H the reader knows exactly where Z sits either
      // side of the change - the tool has not moved, only the reference the
      // file's numbers are stated against - so Z carries and `zShiftMm` below
      // carries the arithmetic.
      positionKnown = { ...positionKnown, z: false }
    }
    // WO-1677: the length in force can differ between frames, so an active
    // G43 H is answered again for the frame the file moves into.
    if (next.wcs !== coordinateFrame.wcs && next.toolLengthOffset !== null
      && next.toolLengthShiftMm !== null && options.toolLengthMm !== undefined) {
      coordinateFrame = { ...next, toolLengthShiftMm: toolLengthShiftFor(next.toolLengthOffset, next.wcs) }
    } else {
      coordinateFrame = next
    }
    zShiftMm = coordinateFrame.toolLengthShiftMm ?? 0
    activeWcs = next.wcs
  }

  for (const block of blocks) {
    if (programEndSeen) return refusal(block.line, `block appears after ${programEndCode} program end`)
    const conflict = blockConflict(block, table)
    if (conflict !== null) return refusal(block.line, conflict)
    const gs = values(block, 'G')
    const ms = values(block, 'M')
    // THE CALLER'S NARROWER ROUTE, FIRST (WO-1335). Before the shared accepted
    // set, before any modal state moves: a word the caller cannot honour is
    // refused at the block that uses it, with the caller's own reason.
    if (refusedWords.size > 0) {
      for (const g of gs) {
        const reason = refusedWords.get(`G${g}`)
        if (reason !== undefined) return refusal(block.line, `G${g} ${reason}`)
      }
      for (const m of ms) {
        const reason = refusedWords.get(`M${m}`)
        if (reason !== undefined) return refusal(block.line, `M${m} ${reason}`)
      }
    }
    for (const g of gs) {
      const known = gcodeWordEntry(table, 'G', g)
      if (known === null) return refusal(block.line, gcodeWordRefusal(table, 'G', g))
      if (NOT_A_PROGRAM_BLOCK(known)) {
        return refusal(
          block.line,
          `${known.word} ${known.meaning}, which is a call of its own and not a block with a place in a `
          + 'program - type it on the MDI line',
        )
      }
    }
    for (const m of ms) {
      // WO-1652: a code this machine's macros carry is the macro's, at any
      // number the table does not carry (see `boundMacroCodes`).
      if (boundMacroCodes.has(m)) {
        if (options.macroMCodes === 'report') continue
        return refusal(block.line, gcodeMacroRefusal(table, m))
      }
      if (gcodeWordEntry(table, 'M', m) !== null) continue
      // WO-1335 re-scope: A USER MACRO IS REPORTED, NOT GUESSED AT. The table
      // says which M-codes the dialect's controller runs as user macros
      // (Fusion's UCCNC post calls `M2001`). Outside that range an M-code the
      // table does not carry is refused with the table's own sentence.
      if (isGcodeMacroMCode(table, m)) {
        if (options.macroMCodes === 'report') continue
        return refusal(block.line, gcodeMacroRefusal(table, m))
      }
      const hidden = hiddenMacroNames.get(m)
      return refusal(block.line, gcodeWordRefusal(table, 'M', m) + (hidden === undefined ? '' : ` This machine's `
        + `macro "${hidden}" on M${m} is hidden from the Macros panel, so it does not run - show it on the panel `
        + 'to turn it back on.'))
    }

    if (gs.includes(20)) { scale = 25.4; units = 'inch' }
    if (gs.includes(21)) { scale = 1; units = 'mm' }
    if (gs.includes(90)) distanceMode = 'absolute'
    if (gs.includes(91)) distanceMode = 'incremental'
    if (gs.includes(90.1)) arcCentreMode = 'absolute'
    if (gs.includes(91.1)) arcCentreMode = 'incremental'
    if (gs.includes(17)) plane = 'G17'
    if (gs.includes(18)) plane = 'G18'
    if (gs.includes(19)) plane = 'G19'
    if (gs.includes(93)) {
      feedMode = 'inverse-time'
      feedMmMin = null
      feedMmMinInvalidatedByG93 = true
    }
    if (gs.includes(94)) feedMode = 'units-per-minute'
    if (gs.includes(98)) returnToInitial = true
    if (gs.includes(99)) returnToInitial = false
    for (const g of gs) {
      if (g >= 54 && g <= 59) {
        const nextWcs = wcsOf(g)
        if (nextWcs !== activeWcs) {
          if (cycle !== null && !gs.includes(80)) {
            return refusal(block.line, `${nextWcs} work-offset change cannot carry an active G${cycle.code} canned cycle across coordinate frames; cancel it with G80 first`)
          }
          // Modal-state boundary table (WO-1288 audit round 3):
          // - WCS change carries motion/distance/feed/spindle/coolant, but not a
          //   work-coordinate position or an active canned cycle.
          // - Canned-cycle entry carries its R/retract mode, but current Z is
          //   never presumed safe; expansion retracts before XY.
          // - G17/G18/G19 changes centre interpretation, never position.
          // - G53 is one machine-frame block; it never applies the active WCS.
          // - G43/G49 changes the Z frame; X/Y carry, but Z must be re-established.
          // All modal coordinate-frame changes flow through one transition so
          // position carry is conditional on the frame remaining resolvable.
          transitionCoordinateFrame({ ...coordinateFrame, wcs: nextWcs })
        }
        items.push({ kind: 'work-offset', line: block.line, wcs: activeWcs })
      }
    }
    if (gs.includes(61)) items.push({ kind: 'path-control', line: block.line, mode: 'exact-stop' })
    if (gs.includes(64)) items.push({ kind: 'path-control', line: block.line, mode: 'continuous' })
    if (gs.includes(20)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G20' })
    if (gs.includes(18)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G18' })
    if (gs.includes(19)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G19' })
    if (gs.includes(90.1)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G90.1' })
    if (gs.includes(91.1)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G91.1' })
    if (gs.includes(93)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G93' })
    if (gs.includes(94)) items.push({ kind: 'accepted-no-op', line: block.line, word: 'G94' })
    if (gs.includes(43)) {
      const h = first(block, 'H')
      if (h === null || !Number.isInteger(h) || h <= 0) {
        return refusal(block.line, 'G43 requires a positive integer H tool-table index')
      }
      // G43 H<n> SHIFTS Z BY THE LENGTH THE MACHINE'S TOOL TABLE HOLDS FOR n.
      // UCCNC and LinuxCNC read their table at this block and apply what they
      // find. That table is the MACHINE's, not the file's, so the caller
      // answers for it (`toolLengthMm`, WO-1677), and the answer is FOLDED
      // INTO EVERY ABSOLUTE Z BELOW - the moves reach the controller already
      // carrying the length, in effect before the first move it governs is
      // staged, with no controller-side offset to write and none to restore
      // when the run ends, is stopped or loses its link. A machine-frame
      // block (G53, G28, G30) is not shifted, exactly as on the controller.
      //
      // This used to refuse: first when no tool library was passed, then when
      // the library did not carry H's number, then when H named a tool other
      // than the fitted one. Every one of those paths, on success, returned
      // zero. They were gates in front of a constant. Operator's own Fusion file -
      // which UCCNC runs - died at line 22 on `G43 H19` because his Tool
      // Library had no tool numbered 19, and the remedy we printed asked him to
      // renumber his library to match Fusion so we could return the zero we
      // were always going to return. The premise was wrong, so the block is
      // gone rather than softened. The load line states the length the
      // machine's table resolves for this H, and a tool with no measured
      // length applies zero - what the operator's controller would answer -
      // and says so once.
      const shiftMm = toolLengthShiftFor(h, coordinateFrame.wcs)
      transitionCoordinateFrame({
        ...coordinateFrame,
        toolLengthOffset: h,
        toolLengthShiftMm: shiftMm,
      })
      items.push({ kind: 'tool-length-offset', line: block.line, enabled: true, tool: h })
    }
    if (gs.includes(49)) {
      transitionCoordinateFrame({
        ...coordinateFrame,
        toolLengthOffset: null,
        toolLengthShiftMm: coordinateFrame.toolLengthShiftMm === null ? null : 0,
      })
      items.push({ kind: 'tool-length-offset', line: block.line, enabled: false })
    }

    const f = first(block, 'F')
    if (f !== null) {
      if (scale === null) return refusal(block.line, 'feed appears before G20/G21 establishes units')
      if (feedMode === 'units-per-minute') {
        feedMmMin = f * scale
        feedMmMinInvalidatedByG93 = false
      }
    }
    const s = first(block, 'S')
    if (s !== null) spindleRpm = s
    const t = first(block, 'T')
    if (t !== null) {
      // THE PRESELECT ONLY. The spindle still holds whatever `M6` last fitted.
      selectedTool = t
      items.push({ kind: 'tool-select', line: block.line, tool: t })
    }

    for (const m of ms) {
      // A bound code runs its macro; a table code keeps its standard action
      // whatever macro carries it, and that binding is reported.
      if (tableCodesWithMacro.has(m)) tableCodeMacroBindings.push({ line: block.line, code: m })
      if (boundMacroCodes.has(m)) {
        const toolChange = macroToolChangeTool(boundMacroBodies.get(m), selectedTool)
        items.push({ kind: 'macro', line: block.line, code: m, ...(toolChange === undefined ? {} : { toolChange }) })
      }
      else if (m === 0 || m === 1) items.push({ kind: 'pause', line: block.line, optional: m === 1 })
      else if (m === 2 || m === 30) {
        programEndCode = m === 2 ? 'M2' : 'M30'
        items.push({ kind: 'program-end', line: block.line, code: programEndCode })
        programEndSeen = true
      } else if (m === 3 || m === 4) {
        items.push({
          kind: 'spindle', line: block.line, on: true,
          direction: m === 3 ? 'cw' : 'ccw', rpm: spindleRpm ?? undefined,
        })
      } else if (m === 5) items.push({ kind: 'spindle', line: block.line, on: false })
      else if (m === 6) {
        if (selectedTool === null) return refusal(block.line, 'M6 tool change has no selected T word')
        // M6 IS WHERE THE CUTTER CHANGES. The preselect becomes the fitted
        // tool here and nowhere else, and the boundary the operator fits a
        // cutter at is named from THIS state - never from a preselect the file
        // has not executed.
        inSpindleTool = selectedTool
        items.push({ kind: 'tool-change', line: block.line, tool: inSpindleTool })
      } else if (m === 7) {
        coolant = { ...coolant, mist: true }
        items.push({ kind: 'coolant', line: block.line, ...coolantState() })
      } else if (m === 8) {
        coolant = { ...coolant, flood: true }
        items.push({ kind: 'coolant', line: block.line, ...coolantState() })
      } else if (m === 9) {
        // M9 stops coolant AND every listed output (the shared off word).
        coolant = { flood: false, mist: false }
        outputsOn = []
        items.push({ kind: 'coolant', line: block.line, ...coolantState() })
      } else if (outputWords.has(m)) {
        // WO-1650: A WORD THE DEFINITION POINTS AT ONE OF ITS OUTPUTS.
        const on = new Set(outputsOn)
        for (const word of outputWords.get(m)!) {
          if (word.on) on.add(word.onCode)
          else on.delete(word.onCode)
        }
        outputsOn = [...on].sort((a, b) => a - b)
        items.push({ kind: 'coolant', line: block.line, ...coolantState() })
      } else if (gcodeWordEntry(table, 'M', m) === null) {
        // Only reachable under `macroMCodes: 'report'` - the loop above refuses
        // every other unaccepted M-code before any modal state moves.
        items.push({ kind: 'macro', line: block.line, code: m })
      }
    }

    if (gs.includes(4)) {
      const p = first(block, 'P')
      if (p === null || p < 0) return refusal(block.line, 'G4 dwell requires a non-negative P word')
      items.push({ kind: 'dwell', line: block.line, seconds: dwellSeconds(p, dwellUnit) })
    }

    if (gs.includes(80)) {
      cycle = null
      motion = null
    }
    const cycleCode = gs.find((g): g is 81 | 82 | 83 => g === 81 || g === 82 || g === 83) ?? null
    if (cycleCode !== null) {
      if (scale === null) return refusal(block.line, `G${cycleCode} appears before G20/G21 establishes units`)
      const z = first(block, 'Z')
      const r = first(block, 'R')
      const q = first(block, 'Q')
      const p = first(block, 'P')
      const base = pos.z
      const retractZ = r === null ? null : (distanceMode === 'incremental' ? base + r * scale : r * scale + zShiftMm)
      cycle = {
        code: cycleCode,
        initialZ: pos.z,
        depthZ: z === null ? null : (distanceMode === 'incremental' && retractZ !== null
          ? retractZ + z * scale
          : z * scale + zShiftMm),
        retractZ,
        peckMm: q === null ? null : q * scale,
        dwellSeconds: p === null ? null : dwellSeconds(p, dwellUnit),
      }
    }

    const explicitMotion = gs.find((g) => g >= 0 && g <= 3)
    if (explicitMotion !== undefined) {
      motion = `G${explicitMotion}` as GcodeReaderState['motion']
      cycle = null
    }

    const x = first(block, 'X')
    const y = first(block, 'Y')
    const z = first(block, 'Z')
    const a = first(block, 'A')
    const b = first(block, 'B')
    const c = first(block, 'C')
    const i = first(block, 'I')
    const j = first(block, 'J')
    const k = first(block, 'K')
    const r = first(block, 'R')
    const rotaryWords = { A: a, B: b, C: c } as const
    const hasRotary = a !== null || b !== null || c !== null
    const hasAxis = x !== null || y !== null || z !== null || hasRotary
    const machineFrame = gs.includes(53)
    // WO-1337: `G28` is a HOME BLOCK, not a motion mode. Like `G53` it is
    // non-modal and it OWNS this block's axis words, so it is dispatched ahead
    // of the canned cycle and the motion section and neither of them sees it.
    const homeBlock = gs.includes(28)
    const referenceBlock = gs.includes(30)
    const invokesCycle = !machineFrame && !homeBlock && !referenceBlock
      && cycle !== null && (cycleCode !== null || hasAxis)

    for (const [axis, raw] of [
      ['x', x], ['y', y], ['z', z], ['a', a], ['b', b], ['c', c],
    ] as const) {
      if (raw !== null) programAxes.add(axis)
    }

    for (const { upper } of ROTARY_AXES) {
      if (rotaryWords[upper] !== null && !controlAxes.has(upper)) {
        return refusal(
          block.line,
          `${upper} is not an enabled independent control axis in this machine definition`,
        )
      }
    }
    if (hasRotary && (motion === 'G2' || motion === 'G3')) {
      return refusal(block.line, 'a rotary A/B/C word on an arc is not modeled, so the arc was not staged')
    }
    if (hasRotary && (homeBlock || referenceBlock || invokesCycle)) {
      const route = homeBlock ? 'G28' : referenceBlock ? 'G30' : `G${cycle?.code} canned cycle`
      return refusal(block.line, `${route} does not model rotary A/B/C motion, so the block was not staged`)
    }
    if (hasRotary && feedMode === 'inverse-time') {
      return refusal(
        block.line,
        'G93 inverse-time feed cannot combine linear millimetres and rotary degrees on this geometry route',
      )
    }

    if (referenceBlock) {
      if (scale === null) return refusal(block.line, 'G30 appears before G20/G21 establishes units')
      if (machineFrame || homeBlock) {
        return refusal(block.line, 'G30 cannot share a block with G28 or G53: each names a machine-reference move')
      }
      const rawPoint = first(block, 'P') ?? 1
      if (!Number.isInteger(rawPoint) || rawPoint < 1 || rawPoint > 4) {
        return refusal(block.line, `G30 P${rawPoint} does not name one of this machine's reference points P1-P4`)
      }
      const pointNumber = rawPoint as 1 | 2 | 3 | 4
      const reference = options.referencePositions?.[pointNumber]
      if (reference === undefined) {
        return refusal(
          block.line,
          `G30 via-point return P${pointNumber} cannot be resolved because this machine stores no controller-stored point ${pointNumber}`,
        )
      }
      if (![reference.x, reference.y, reference.z].every(Number.isFinite)) {
        return refusal(block.line, `G30 P${pointNumber} cannot be resolved because reference point ${pointNumber} is incomplete`)
      }
      const offset = options.workOffsets?.[activeWcs]
      if (!offset) return refusal(block.line, `G30 P${pointNumber} cannot be resolved because the ${activeWcs} work offset is unknown`)
      if (coordinateFrame.toolLengthOffset !== null && coordinateFrame.toolLengthShiftMm === null) {
        return refusal(block.line, `G30 P${pointNumber} cannot resolve Z while G43 H${coordinateFrame.toolLengthOffset} tool length is unknown to the reader`)
      }
      const referenceUnknown = unknownAxes(positionKnown)
      if (referenceUnknown.length > 0) {
        return refusal(
          block.line,
          `G30 P${pointNumber} cannot resolve ${referenceUnknown.join(', ')} because the position is unknown in ${activeWcs}`,
        )
      }

      // G30's two legs explicitly place Z and then X/Y, even when its source
      // block names no ordinary axis word. Later modal lines must preserve the
      // park coordinates rather than revive the pre-program starting point.
      programAxes.add('x'); programAxes.add('y'); programAxes.add('z')

      // Axis words name the standard intermediate point, as they do on G28.
      // The park itself remains two moves: machine Z first, then machine X/Y,
      // matching Operator's M200/M2001-M203 macros and clearing the work before XY.
      if (hasAxis) {
        const via = { x: targetAxis(x, pos.x), y: targetAxis(y, pos.y), z: targetZ(z, pos.z) }
        if (Math.abs(via.x - pos.x) > EPS || Math.abs(via.y - pos.y) > EPS || Math.abs(via.z - pos.z) > EPS) {
          pos = via
          pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
        }
      }
      pos = { ...pos, z: reference.z - offset.z }
      pushMove(block.line, {
        type: 'rapid', role: 'rapid', machineAbsolute: { z: reference.z }, ...pos,
      })
      // WO-2215: the work point the controller will report there - turned back
      // through the frame's rotation, so the path check and the MDI row read the
      // G55 X/Y the DRO shows, not machine less offset.
      pos = { ...machineXYToWork(offset, pos, reference.x, reference.y), z: pos.z }
      pushMove(block.line, {
        type: 'rapid', role: 'rapid', machineAbsolute: { x: reference.x, y: reference.y }, ...pos,
      })
      positionKnown = { x: true, y: true, z: true }
    } else if (homeBlock) {
      // THE HOME BLOCK, RESOLVED AT LOAD (WO-1337).
      //
      // `G28 G91 Z0` is how every Fusion post begins and ends a program, and
      // refusing it turned two third-party files away at their first and
      // seventh lines. It is not a mystery word: it is a rapid to the
      // machine's home position on the axes it names, through an intermediate
      // point the block states in the ACTIVE frame - which is the same two
      // arithmetics this reader already does for `G53` and for a rapid.
      //
      // WHAT MAKES IT SAFE IS THAT IT IS RESOLVED HERE, NOT PASSED ON. The
      // wire has no "go home" step and this reader does not invent one: what
      // leaves here is rapids to numbers, in work coordinates, which the
      // soft-limit and table checks downstream see exactly as they see every
      // other move. A word that reached the board unresolved would be a move
      // nothing in this app had checked.
      if (scale === null) return refusal(block.line, 'G28 appears before G20/G21 establishes units')
      if (machineFrame) {
        return refusal(block.line, 'G28 and G53 cannot share a block: both say which frame the axis words are in')
      }
      // WO-1644: G28 DOES NOT REQUIRE HOMING. UCCNC and LinuxCNC both run it on
      // an unhomed machine: it rapids to the stored G28 position in whatever
      // machine coordinates the controller holds, and that stored position is
      // machine zero until something sets it. So does this reader.
      const home = options.machineHome ?? { x: 0, y: 0, z: 0 }
      const offset = options.workOffsets?.[activeWcs]
      if (!offset) return refusal(block.line, `G28 cannot be resolved because the ${activeWcs} work offset is unknown`)
      // THE AXES IT NAMES, or all three when it names none - the bare `G28`
      // that sends every axis home.
      const named = hasAxis
        ? { x: x !== null, y: y !== null, z: z !== null }
        : { x: true, y: true, z: true }
      if (named.x) programAxes.add('x')
      if (named.y) programAxes.add('y')
      if (named.z) programAxes.add('z')
      // WO-2215: under a rotated offset one machine axis moves both work axes.
      if (offsetRotationDeg(offset) !== 0 && (named.x || named.y)) { programAxes.add('x'); programAxes.add('y') }
      if (named.z && coordinateFrame.toolLengthOffset !== null && coordinateFrame.toolLengthShiftMm === null) {
        return refusal(block.line, `G28 Z cannot be resolved while G43 H${coordinateFrame.toolLengthOffset} tool length is unknown to the reader`)
      }
      // EVERY AXIS HAS TO BE KNOWN, even the ones not going home: both legs are
      // whole points, and an axis this block does not name holds the position
      // it already had. The same rule a canned cycle applies, for the same
      // reason.
      const homeUnknown = unknownAxes(positionKnown)
      if (homeUnknown.length > 0) {
        return refusal(block.line, `G28 cannot resolve ${homeUnknown.join(', ')} because the position is unknown in ${activeWcs}`)
      }
      // LEG ONE: the intermediate point, stated in the active frame and in the
      // active distance mode. `G91 Z0` - what every Fusion post writes - makes
      // it the position the tool is already at, so no move is emitted for it.
      const via = { x: targetAxis(x, pos.x), y: targetAxis(y, pos.y), z: targetZ(z, pos.z) }
      if (Math.abs(via.x - pos.x) > EPS || Math.abs(via.y - pos.y) > EPS || Math.abs(via.z - pos.z) > EPS) {
        pos = via
        pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
      }
      // LEG TWO: home, on the named axes only. `pos` keeps the work-coordinate
      // equivalent (the G53 arithmetic, against the controller's own reported
      // offset) for modal interpretation after this block; the move itself is
      // a MACHINE target, as G30's legs are (WO-2207). Home is a machine point:
      // a rotated work offset turns the intermediate point above (LinuxCNC)
      // and never this leg - unmarked, the AXBB-E bridge turned it off home.
      // WO-2215: that work equivalent is turned back through the frame's
      // rotation - the work point the controller reports at home - so a home
      // leg under a rotated offset is not scored against machine less offset.
      // WO-2596: the definition's order is sequential, not a straight rapid
      // through the work to all three home coordinates. Update the work
      // equivalent after EACH machine-axis step, including rotated X/Y.
      for (const axis of resolveHomingOrder(options.machineDefinition?.controllerDefinition)) {
        if (axis !== 'X' && axis !== 'Y' && axis !== 'Z') continue
        const key = axis === 'X' ? 'x' : axis === 'Y' ? 'y' : 'z'
        if (!named[key]) continue
        const homedXY = machineXYToWork(offset, pos, key === 'x' ? home.x : null, key === 'y' ? home.y : null)
        const homed = {
          x: homedXY.x,
          y: homedXY.y,
          z: key === 'z' ? home.z - offset.z : pos.z,
        }
        if (Math.abs(homed.x - pos.x) > EPS || Math.abs(homed.y - pos.y) > EPS || Math.abs(homed.z - pos.z) > EPS) {
          pos = homed
          pushMove(block.line, {
            type: 'rapid',
            role: 'rapid',
            machineAbsolute: { [key]: home[key] },
            ...pos,
          })
        }
      }
    } else if (invokesCycle && cycle) {
      // R/Z own the cycle's vertical motion even when a repeated cycle block
      // carries only X or Y. Its expanded plunges and retracts therefore keep Z
      // modal for every later move in the file.
      programAxes.add('z')
      if (scale === null) return refusal(block.line, 'canned cycle appears before G20/G21 establishes units')
      if (feedMode === 'inverse-time') {
        return refusal(block.line, `G${cycle.code} canned cycle cannot use G93 inverse-time feed because its expanded plunges have no units-per-minute feed rate`)
      }
      if (cycleCode === null) {
        if (r !== null) cycle.retractZ = distanceMode === 'incremental' ? pos.z + r * scale : r * scale + zShiftMm
        if (z !== null) cycle.depthZ = distanceMode === 'incremental' && cycle.retractZ !== null
          ? cycle.retractZ + z * scale
          : z * scale + zShiftMm
        if (first(block, 'Q') !== null) cycle.peckMm = first(block, 'Q')! * scale
        if (first(block, 'P') !== null) cycle.dwellSeconds = dwellSeconds(first(block, 'P')!, dwellUnit)
      }
      if (cycle.depthZ === null || cycle.retractZ === null) {
        return refusal(block.line, `G${cycle.code} requires resolved Z and R planes`)
      }
      const cycleUnknown = unknownAxes(positionKnown)
      if (cycleUnknown.length > 0) {
        return refusal(block.line, `G${cycle.code} cannot start because ${cycleUnknown.join(', ')} position is unknown in ${activeWcs}`)
      }
      if (feedMmMin === null || feedMmMin <= 0) {
        if (feedMmMinInvalidatedByG93) {
          return refusal(block.line, `G${cycle.code} canned cycle has no feed rate because G93 inverse time left no units-per-minute feed; program F after G94`)
        }
        return refusal(block.line, `G${cycle.code} canned cycle has no positive feed rate`)
      }
      if (cycle.depthZ >= cycle.retractZ - EPS) {
        return refusal(block.line, `G${cycle.code} depth Z must be below its R retract plane`)
      }
      if (cycle.code === 83 && (!(cycle.peckMm && cycle.peckMm > 0))) {
        return refusal(block.line, 'G83 requires a positive Q peck distance')
      }
      if (cycle.code === 82 && cycle.dwellSeconds === null) {
        return refusal(block.line, 'G82 requires P and a recognised dwell dialect')
      }
      const targetX = targetAxis(x, pos.x)
      const targetY = targetAxis(y, pos.y)
      if (cycle.initialZ < cycle.retractZ) cycle.initialZ = cycle.retractZ
      if (pos.z < cycle.retractZ - EPS) {
        pos = { ...pos, z: cycle.retractZ }
        pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
      }
      if (Math.abs(targetX - pos.x) > EPS || Math.abs(targetY - pos.y) > EPS) {
        pos = { ...pos, x: targetX, y: targetY }
        pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
      }
      if (Math.abs(cycle.retractZ - pos.z) > EPS) {
        pos = { ...pos, z: cycle.retractZ }
        pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
      }
      if (cycle.code === 83) {
        let cutZ = pos.z
        while (cutZ - cycle.depthZ > EPS) {
          const next = Math.max(cycle.depthZ, cutZ - cycle.peckMm!)
          pos = { ...pos, z: next }
          pushMove(block.line, { type: 'feed', role: 'plunge', feed: feedMmMin ?? undefined, ...pos })
          cutZ = next
          if (cutZ - cycle.depthZ > EPS) {
            pos = { ...pos, z: cycle.retractZ }
            pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
            pos = { ...pos, z: cutZ }
            pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
          }
        }
      } else {
        pos = { ...pos, z: cycle.depthZ }
        pushMove(block.line, { type: 'feed', role: 'plunge', feed: feedMmMin ?? undefined, ...pos })
      }
      if (cycle.code === 82) {
        items.push({ kind: 'dwell', line: block.line, seconds: cycle.dwellSeconds! })
      }
      pos = { ...pos, z: returnToInitial ? cycle.initialZ : cycle.retractZ }
      pushMove(block.line, { type: 'rapid', role: 'rapid', ...pos })
    } else {
      const isArc = motion === 'G2' || motion === 'G3'
      const hasArcCentre = i !== null || j !== null || k !== null || r !== null
      if ((hasAxis || (isArc && hasArcCentre)) && machineFrame) {
        if (scale === null) return refusal(block.line, 'G53 appears before G20/G21 establishes units')
        if (motion !== 'G0' && motion !== 'G1') {
          return refusal(block.line, 'G53 machine-frame move requires an active G0 or G1 motion mode')
        }
        if (motion === 'G1' && feedMode === 'units-per-minute' && feedMmMinInvalidatedByG93) {
          return refusal(block.line, 'G53 G1 move has no feed rate because G93 inverse time left no units-per-minute feed; program F after G94')
        }
        const offset = options.workOffsets?.[activeWcs]
        if (!offset) return refusal(block.line, `G53 cannot be resolved because ${activeWcs} offset is unknown`)
        for (const { upper, lower } of ROTARY_AXES) {
          if (rotaryWords[upper] !== null && !Number.isFinite(offset[lower])) {
            return refusal(block.line, `G53 ${upper} cannot be resolved because ${activeWcs} ${upper} offset is unknown`)
          }
        }
        if (z !== null && coordinateFrame.toolLengthOffset !== null
          && coordinateFrame.toolLengthShiftMm === null) {
          return refusal(block.line, `G53 Z cannot be resolved while G43 H${coordinateFrame.toolLengthOffset} tool length is unknown to the reader`)
        }
        const nextKnowledge: PositionKnowledge = {
          x: x !== null || positionKnown.x,
          y: y !== null || positionKnown.y,
          z: z !== null || positionKnown.z,
        }
        const machineUnknown = unknownAxes(nextKnowledge)
        if (machineUnknown.length > 0) {
          return refusal(block.line, `G53 partial move cannot resolve ${machineUnknown.join(', ')} because the position is unknown in ${activeWcs}`)
        }
        // WO-2215: X/Y turned back through the frame's rotation (unrotated,
        // machine less offset per named axis, as always).
        const machineXY = machineXYToWork(offset, pos, x === null ? null : x * scale, y === null ? null : y * scale)
        if (offsetRotationDeg(offset) !== 0 && (x !== null || y !== null)) { programAxes.add('x'); programAxes.add('y') }
        pos = {
          x: machineXY.x,
          y: machineXY.y,
          z: z === null ? pos.z : z * scale - offset.z,
          ...rotaryPosition(pos),
          ...(a !== null ? { a: a - offset.a! } : {}),
          ...(b !== null ? { b: b - offset.b! } : {}),
          ...(c !== null ? { c: c - offset.c! } : {}),
        }
        positionKnown = nextKnowledge
        pushMove(block.line, {
          type: motion === 'G0' ? 'rapid' : 'feed',
          role: motion === 'G0' ? 'rapid' : 'cut',
          feed: motion === 'G0' ? undefined : feedMmMin ?? undefined,
          // Keep the source values in the machine frame. `pos` above is still
          // the equivalent work-coordinate endpoint so modal interpretation
          // after this block remains correct, but no later work-zero edit may
          // alter what this block sends to the controller.
          machineAbsolute: {
            ...(x !== null ? { x: x * scale } : {}),
            ...(y !== null ? { y: y * scale } : {}),
            ...(z !== null ? { z: z * scale } : {}),
            ...(a !== null ? { a } : {}),
            ...(b !== null ? { b } : {}),
            ...(c !== null ? { c } : {}),
          },
          ...pos,
        })
      } else if (hasAxis || (isArc && hasArcCentre)) {
        if (scale === null) return refusal(block.line, 'motion appears before G20/G21 establishes units')
        if (motion === null) return refusal(block.line, 'coordinate word appears with no active motion mode')
        const nextKnowledge: PositionKnowledge = {
          x: x === null ? positionKnown.x : distanceMode === 'absolute' || positionKnown.x,
          y: y === null ? positionKnown.y : distanceMode === 'absolute' || positionKnown.y,
          z: z === null ? positionKnown.z : distanceMode === 'absolute' || positionKnown.z,
        }
        const motionUnknown = unknownAxes(isArc ? positionKnown : nextKnowledge)
        if (motionUnknown.length > 0) {
          const detail = distanceMode === 'incremental'
            ? 'incremental motion needs a known starting position'
            : 'the block does not establish every unknown axis'
          return refusal(block.line, `${motion} cannot resolve ${motionUnknown.join(', ')} in ${activeWcs}: ${detail}`)
        }
        for (const { upper, lower } of ROTARY_AXES) {
          if (rotaryWords[upper] !== null && distanceMode === 'incremental'
            && !Number.isFinite(pos[lower])) {
            return refusal(
              block.line,
              `${motion} cannot resolve incremental ${upper} because its starting position is unknown in ${activeWcs}`,
            )
          }
        }
        const from = { ...pos }
        const to: GcodeReaderPoint = {
          x: targetAxis(x, pos.x),
          y: targetAxis(y, pos.y),
          z: targetZ(z, pos.z),
          ...rotaryPosition(pos),
          ...(a !== null ? { a: targetRotary(a, pos.a)! } : {}),
          ...(b !== null ? { b: targetRotary(b, pos.b)! } : {}),
          ...(c !== null ? { c: targetRotary(c, pos.c)! } : {}),
        }
        if (isArc) {
          // WO-1337: A HELICAL ARC IS CARRIED. This is where Operator's own Fusion
          // file stopped, at line 31, on a `G3` whose Z ramps while it sweeps -
          // and the refusal that stopped it said the wire could not carry one,
          // which was never true of the wire. `ToolpathMove` has always had an
          // endpoint Z and the bridge has always submitted
          // `AddCircularMoveP(X, Y, Z, CX, CY, CZ, ...)`; what the builder
          // downstream refused (until WO-1337) was a Z change, not a missing
          // field. So `to.z` simply carries, and a ramping arc reads as one arc
          // move with the Z it ramps to.
          //
          // EVERYTHING STILL CHECKED BELOW IS AN XY FACT - the centre form, the
          // centre's equidistance, a zero radius - because the circle a helix
          // is projected onto is the circle those checks are about. A Z ramp
          // makes none of them true and none of them false.
          const start = planePoint(from, plane)
          const end = planePoint(to, plane)
          const centreWords = plane === 'G17' ? [i, j] : plane === 'G18' ? [k, i] : [j, k]
          const unusedCentre = plane === 'G17' ? k : plane === 'G18' ? j : i
          if (unusedCentre !== null) return refusal(block.line, `${plane === 'G17' ? 'K' : plane === 'G18' ? 'J' : 'I'} on a ${plane}-plane arc is not understood`)
          let centre: { x: number; y: number }
          if (r !== null) {
            if (centreWords[0] !== null || centreWords[1] !== null) return refusal(block.line, 'arc mixes R form with centre form')
            const resolved = minorRadiusCentre(
              { x: start.u, y: start.v, z: 0 }, { x: end.u, y: end.v, z: 0 },
              r * scale, motion === 'G2',
            )
            if (!resolved.ok) return refusal(block.line, resolved.reason)
            centre = resolved.centre
          } else {
            if (centreWords[0] === null && centreWords[1] === null) {
              return refusal(block.line, `arc move has no ${plane === 'G17' ? 'I/J' : 'I/J/K'} centre or R radius`)
            }
            centre = arcCentreMode === 'incremental'
              ? { x: start.u + (centreWords[0] ?? 0) * scale, y: start.v + (centreWords[1] ?? 0) * scale }
              : {
                  x: centreWords[0] === null ? start.u : centreWords[0] * scale,
                  y: centreWords[1] === null ? start.v : centreWords[1] * scale,
                }
            const startRadius = Math.hypot(start.u - centre.x, start.v - centre.y)
            const endRadius = Math.hypot(end.u - centre.x, end.v - centre.y)
            if (startRadius <= EPS) return refusal(block.line, 'arc centre equals its start point')
            if (Math.abs(startRadius - endRadius) > Math.max(0.01, startRadius * 0.001)) {
              return refusal(block.line, 'arc centre is not equidistant from the arc endpoints')
            }
          }
          const radius = Math.hypot(start.u - centre.x, start.v - centre.y)
          const sweep = directedSweep(
            { x: start.u, y: start.v, z: 0 }, { x: end.u, y: end.v, z: 0 }, centre, motion === 'G2',
          )
          // A G17 arc reaches the controller as an arc and travels the true arc
          // length. A G18/G19 arc is linearised here, so what is actually
          // travelled is the chord polyline, which is shorter. Under G93 the F
          // word commands the block's DURATION, so inverse time has to be
          // computed from the path that is really staged: computing it from the
          // arc length finishes the block early (a G18 semicircle at F2 ran
          // 27.009 s of its commanded 30 s).
          const chords = plane === 'G17' ? null : linearisedArc(start, end, centre, radius, sweep)
          const pathLength = chords
            ? chords.length
            : Math.hypot(Math.abs(sweep) * radius, end.w - start.w)
          const blockFeed = feedMode === 'inverse-time'
            ? (f !== null && f > 0 ? pathLength * f : null)
            : feedMmMin
          if (blockFeed === null || blockFeed <= 0) {
            if (feedMode === 'units-per-minute' && feedMmMinInvalidatedByG93) {
              return refusal(block.line, 'arc move has no feed rate because G93 inverse time left no units-per-minute feed; program F after G94')
            }
            return refusal(block.line, 'arc move has no positive feed rate')
          }
          pos = to
          positionKnown = nextKnowledge
          if (chords === null) {
            pushMove(block.line, {
              type: motion === 'G2' ? 'arc_cw' : 'arc_ccw', role: 'cut', feed: blockFeed,
              // Rotary state remains modal in `pos`, but the arc payload names
              // only coordinates this block actually commands. An explicit
              // A/B/C word was refused above; copying carried rotary state here
              // makes the builder mistake an ordinary XY arc for rotary motion.
              cx: centre.x, cy: centre.y, x: to.x, y: to.y, z: to.z,
            })
          } else {
            // G18/G19 arcs are expanded into line chords. The two plane axes
            // are commanded by every chord even when a full-circle source omits
            // its endpoint words; the invariant third axis remains sparse.
            if (plane === 'G18') { programAxes.add('x'); programAxes.add('z') }
            if (plane === 'G19') { programAxes.add('y'); programAxes.add('z') }
            for (const point of chords.points) {
              pushMove(block.line, { type: 'feed', role: 'cut', feed: blockFeed, ...fromPlanePoint(point, plane) })
            }
          }
        } else {
          const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
          const blockFeed = feedMode === 'inverse-time'
            ? (f !== null && f > 0 ? distance * f : null)
            : feedMmMin
          if (blockFeed === null && motion !== 'G0') {
            if (feedMode === 'units-per-minute' && feedMmMinInvalidatedByG93) {
              return refusal(block.line, 'feed move has no feed rate because G93 inverse time left no units-per-minute feed; program F after G94')
            }
            return refusal(block.line, 'feed move has no feed rate')
          }
          pos = to
          positionKnown = nextKnowledge
          pushMove(block.line, {
            type: motion === 'G0' ? 'rapid' : 'feed',
            role: motion === 'G0' ? 'rapid' : 'cut',
            feed: motion === 'G0' ? undefined : blockFeed ?? undefined,
            ...to,
          })
        }
      }
    }

    const contextual = new Set(['G', 'M', 'N', 'F', 'S', 'T'])
    if (gs.includes(43)) contextual.add('H')
    if (hasAxis || invokesCycle || homeBlock) {
      for (const axis of ['X', 'Y', 'Z', 'A', 'B', 'C']) contextual.add(axis)
    }
    if (motion === 'G2' || motion === 'G3') for (const address of ['I', 'J', 'K', 'R']) contextual.add(address)
    if (gs.includes(4) || (cycle?.code === 82 && invokesCycle)) contextual.add('P')
    if (gs.includes(61) || gs.includes(64)) { contextual.add('P'); contextual.add('Q') }
    if (referenceBlock) contextual.add('P')
    if (cycle?.code === 83 && invokesCycle) contextual.add('Q')
    if (invokesCycle) contextual.add('R')
    for (const word of block.words) {
      if (!contextual.has(word.letter)) {
        return refusal(block.line, `address ${word.letter} is not understood on this block`)
      }
    }
  }

  if (!programEndSeen) items.push({ kind: 'accepted-no-op', line: blocks.at(-1)?.line ?? 1, word: 'EOF' })
  return {
    ok: true,
    program: {
      moves,
      moveLines,
      moveWcs,
      items,
      // Present only when a table code carries a macro: a program on a
      // machine with none reads exactly as it did before WO-1652.
      ...(tableCodeMacroBindings.length === 0 ? {} : { tableCodeMacroBindings }),
      end: {
        position: { ...pos },
        positionKnown: { ...positionKnown },
        units: units!,
        distanceMode,
        motion,
        wcs: activeWcs,
        feedMmMin,
        spindleRpm,
        selectedTool,
        inSpindleTool,
        coolant: coolantState(),
      },
    },
  }
}
