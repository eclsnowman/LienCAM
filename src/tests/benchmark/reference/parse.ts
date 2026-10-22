// WO-3009: reference-CAM programs are read by an INDEPENDENT reader (cncjs
// gcode-parser + gcode-toolpath, MIT, dev/test only), never by src/lib/gcode,
// so the round trip cannot check LienCAM against itself. This file only
// classifies the words the reader saw; it does not interpret motion itself.
import Toolpath from 'gcode-toolpath'

export interface Point3 { x: number; y: number; z: number }
export interface RawSegment {
  motion: 'G0' | 'G1' | 'G2' | 'G3'
  start: Point3
  end: Point3
  /** Absolute arc centre, program frame, mm (G2/G3 only). */
  centre?: Point3
  /** Programmed feed, mm/min, after unit conversion. Undefined on G0. */
  feed?: number
  /** 1-based program line. */
  line: number
}
export interface ParsedProgram {
  segments: RawSegment[]
  /** Every word the harness ignored (non-motion), with its count. */
  ignoredWords: Record<string, number>
  /** The first word that changes motion and cannot be interpreted. When set, the row is n/a. */
  unparsedMotionWord?: string
  unitsSeen: ('G20' | 'G21')[]
  /** Spindle speeds programmed (S words), settings data only. */
  spindleRpm: number[]
  /** Blocks dropped because the machine position was not yet fully known. */
  unknownStartBlocks: number
  /** Blocks that move nothing (e.g. `G0 Z10` when already at Z10). */
  zeroLengthBlocks: number
}

/** G words the reader turns into motion. */
const MOTION = new Set([0, 1, 2, 3])
/** G words that only set modal state the reader applies (plane, units, distance mode). */
const MODAL = new Set([17, 20, 21, 90, 91, 91.1])
/**
 * G words that do not move the tool in the program's own frame. They are
 * listed in the ignored-word report. G10/G54..G59 select or set work offsets:
 * the harness places the program by the RECORDED WCS offset instead.
 */
const NON_MOTION = new Set([4, 10, 18, 19, 40, 43, 43.1, 49, 54, 55, 56, 57, 58, 59, 54.1, 61, 61.1, 64, 80, 93, 94, 95, 98, 99])
const AXES = new Set(['X', 'Y', 'Z'])
const ARC_WORDS = new Set(['I', 'J', 'K', 'R'])
/** Rotary and extra linear axes: motion this harness cannot represent. */
const OTHER_AXES = new Set(['A', 'B', 'C', 'U', 'V', 'W', 'E'])
const LENGTH_EPS = 1e-9

const word = (letter: string, value: unknown) => `${letter}${value}`

export function parseProgram(text: string): ParsedProgram {
  const out: ParsedProgram = { segments: [], ignoredWords: {}, unitsSeen: [], spindleRpm: [], unknownStartBlocks: 0, zeroLengthBlocks: 0 }
  const ignore = (w: string) => { out.ignoredWords[w] = (out.ignoredWords[w] ?? 0) + 1 }
  const unparsed = (w: string) => { out.unparsedMotionWord ??= w }
  let pending: RawSegment[] = []
  let feed: number | undefined
  const known = new Set<string>()
  const toolpath = new Toolpath({
    addLine: (modal: { motion: string }, start: Point3, end: Point3) => {
      pending.push({ motion: modal.motion as RawSegment['motion'], start: { ...start }, end: { ...end }, line: 0 })
    },
    addArcCurve: (modal: { motion: string; plane: string }, start: Point3, end: Point3, centre: Point3) => {
      if (modal.plane !== 'G17') unparsed(modal.plane)
      pending.push({ motion: modal.motion as RawSegment['motion'], start: { ...start }, end: { ...end }, centre: { ...centre }, line: 0 })
    },
  })
  let lineNo = 0
  toolpath.loadFromStringSync(text, (data: { words: [string, number | string][]; line: string; cmds?: string[]; ln?: number }) => {
    lineNo++
    if (data.ln !== undefined) ignore('N')
    const stripped = stripComments(data.line)
    if (/[#[]/.test(stripped)) unparsed(stripped.includes('#') ? '#' : '[')
    for (const cmd of data.cmds ?? []) ignore(cmd.startsWith('%') ? '%' : cmd)
    const letters = new Set(data.words.map(([letter]) => letter))
    const inch = toolpath.getModal().units === 'G20'
    for (const [letter, value] of data.words) {
      if (typeof value !== 'number') { unparsed(word(letter, value)); continue }
      if (letter === 'G') {
        if (MOTION.has(value) || MODAL.has(value)) { if (value === 20 || value === 21) out.unitsSeen.push(`G${value}` as 'G20' | 'G21'); continue }
        if (NON_MOTION.has(value)) ignore(word('G', value))
        else unparsed(word('G', value))
      } else if (letter === 'F') feed = inch ? value * 25.4 : value
      else if (letter === 'S') out.spindleRpm.push(value)
      else if (AXES.has(letter) || ARC_WORDS.has(letter)) continue
      else if (OTHER_AXES.has(letter)) unparsed(letter)
      else if (letter === 'M' || letter === 'T') ignore(word(letter, value))
      else ignore(letter)
    }
    const moves = [...letters].some(letter => AXES.has(letter) || ARC_WORDS.has(letter))
    for (const segment of pending) {
      if (!moves) continue
      segment.line = lineNo
      if (segment.motion !== 'G0') segment.feed = feed
      // A move list is a list of END points: the first block whose end is fully
      // programmed starts the list; blocks before it end at a position the
      // program never stated (the reader's assumed origin) and are dropped.
      for (const axis of ['X', 'Y', 'Z']) if (letters.has(axis)) known.add(axis)
      if (!['X', 'Y', 'Z'].every(axis => known.has(axis))) { out.unknownStartBlocks++; continue }
      const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y, segment.end.z - segment.start.z)
      if (out.segments.length && !segment.centre && length < LENGTH_EPS) { out.zeroLengthBlocks++; continue }
      out.segments.push(segment)
    }
    pending = []
  })
  return out
}

function stripComments(line: string): string {
  return line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '')
}
