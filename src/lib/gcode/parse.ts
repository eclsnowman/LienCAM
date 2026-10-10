// ============================================================
// G-code tokenizer + modal interpreter (reusable groundwork)
// ============================================================
// A dependency-free g-code reader for the SUBSET this project emits, designed
// to double as the parsing core of a future in-app GRBL sender (cf. the
// cncjs/gSender `gcode-parser`: a line tokenizer feeding a modal interpreter).
//
// Two layers:
//   1. tokenize  — split each physical line into address words + comment,
//      stripping parenthesised/end-of-line comments and blank/whitespace lines.
//   2. interpret — walk the lines as a MODAL machine (G90 absolute assumed):
//      remember the active motion mode (G0/G1/G2/G3), the modal X/Y/Z/F/S, and
//      the active WCS, emitting one GcodeSegment per motion block.
//
// Unknown words are RECORDED on the line (never crash). Non-motion modal words
// (G90/G94/G17/G21/G64, G10, dwell G4, M-codes, T/S) update state or are simply
// carried through; they do not produce motion segments.

export interface GcodeWord {
  letter: string // upper-cased address letter, e.g. 'G','X','M'
  value: number // numeric argument (NaN if the address carried no number)
}

export interface GcodeLine {
  /** 1-based source line number. */
  number: number
  /** Raw source text of the line (comment included, trailing CR stripped). */
  raw: string
  /** Parsed address words in source order. */
  words: GcodeWord[]
  /** First comment text, if any (without its delimiter). */
  comment?: string
}

export type SegmentKind = 'rapid' | 'feed' | 'arc'

export interface GcodePoint {
  x: number
  y: number
  z: number
}

export interface GcodeSegment {
  kind: SegmentKind
  from: GcodePoint
  to: GcodePoint
  /** Active feed (mm/min) for feed/arc segments. */
  feed?: number
  /** Arc direction for kind==='arc'. */
  arc?: 'cw' | 'ccw'
  /** 1-based source line that produced this segment. */
  line: number
}

export interface GcodeProgram {
  lines: GcodeLine[]
  segments: GcodeSegment[]
  /** Final modal snapshot after interpreting the whole program. */
  end: {
    position: GcodePoint
    motion: string | null
    feed: number | null
    spindle: number | null
    wcs: number | null
  }
}

// --- tokenizer ---------------------------------------------------------------

// Match in source order: a semicolon inside parentheses is comment text;
// parentheses after a semicolon are part of the end-of-line comment.
const COMMENT_RE = /\(([^)]*)\)|;([^\r\n]*)/g
// One address word: a letter then an optional signed/decimal number. Letters we
// expect: G M X Y Z I J K F S T P N R L. Anything else still tokenizes (so it
// is RECORDED), letting the linter — not the parser — judge legality.
const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))?/g

/** Strip comments from a line, returning the cleaned code and the
 *  first comment found (if any). */
function extractComment(raw: string): { code: string; comment?: string } {
  let comment: string | undefined
  const code = raw.replace(COMMENT_RE, (_m, paren: string | undefined, eol: string | undefined) => {
    if (comment === undefined) comment = (paren ?? eol ?? '').trim()
    return ' '
  })
  return { code, comment }
}

/** Tokenize one physical line into words + comment. Pure, never throws. */
export function tokenizeLine(raw: string, number: number): GcodeLine {
  const clean = raw.replace(/\r$/, '')
  const { code, comment } = extractComment(clean)
  const words: GcodeWord[] = []
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(code)) !== null) {
    const letter = m[1].toUpperCase()
    const value = m[2] !== undefined && m[2] !== '' ? Number(m[2]) : NaN
    words.push({ letter, value })
  }
  return { number, raw: clean, words, comment }
}

/** Tokenize a whole program into lines (blank lines are dropped). */
export function tokenize(text: string): GcodeLine[] {
  const out: GcodeLine[] = []
  const physical = text.split('\n')
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i]
    if (raw.trim().length === 0) continue
    out.push(tokenizeLine(raw, i + 1))
  }
  return out
}

// --- modal interpreter -------------------------------------------------------

/** Find the first word with the given letter on a line. */
function find(line: GcodeLine, letter: string): GcodeWord | undefined {
  return line.words.find((w) => w.letter === letter)
}

/** All G-word integer codes present on a line (e.g. [90,94,17] or [0],[1]). */
function gCodes(line: GcodeLine): number[] {
  return line.words
    .filter((w) => w.letter === 'G' && !Number.isNaN(w.value))
    .map((w) => w.value)
}

const MOTION_BY_G: Record<number, { mode: string; kind: SegmentKind; arc?: 'cw' | 'ccw' }> = {
  0: { mode: 'G0', kind: 'rapid' },
  1: { mode: 'G1', kind: 'feed' },
  2: { mode: 'G2', kind: 'arc', arc: 'cw' },
  3: { mode: 'G3', kind: 'arc', arc: 'ccw' },
}

/** Interpret tokenized lines into ordered motion segments + a final snapshot. */
export function interpret(lines: GcodeLine[]): Omit<GcodeProgram, 'lines'> {
  const segments: GcodeSegment[] = []
  const pos: GcodePoint = { x: 0, y: 0, z: 0 }
  let motion: string | null = null
  let feed: number | null = null
  let spindle: number | null = null
  let wcs: number | null = null

  for (const line of lines) {
    const codes = gCodes(line)

    // WCS select (G54..G59). G53 is a one-shot machine-coord modifier; we note
    // motion off it but do not change the persistent WCS.
    for (const g of codes) {
      if (g >= 54 && g <= 59) wcs = g
    }

    // Motion mode: an explicit G0/1/2/3 on the line sets the modal mode.
    let blockMotion: (typeof MOTION_BY_G)[number] | undefined
    for (const g of codes) {
      if (MOTION_BY_G[g]) {
        blockMotion = MOTION_BY_G[g]
        motion = blockMotion.mode
      }
    }

    // Feed / spindle modal words.
    const fWord = find(line, 'F')
    if (fWord && !Number.isNaN(fWord.value)) feed = fWord.value
    const sWord = find(line, 'S')
    if (sWord && !Number.isNaN(sWord.value)) spindle = sWord.value

    // Coordinate words present on this block.
    const xW = find(line, 'X')
    const yW = find(line, 'Y')
    const zW = find(line, 'Z')
    const hasCoord =
      (xW && !Number.isNaN(xW.value)) ||
      (yW && !Number.isNaN(yW.value)) ||
      (zW && !Number.isNaN(zW.value))

    if (!hasCoord) continue // non-motion block (modal setup, M-code, dwell, ...)

    // A coordinate block with no active motion mode is malformed for OUR subset
    // (the linter flags it). We default such a block to a feed move so the
    // interpreter stays total, but it never invents a rapid.
    const active = blockMotion ??
      (motion ? MOTION_BY_G[motionCodeOf(motion)] : undefined) ??
      MOTION_BY_G[1]

    const from: GcodePoint = { ...pos }
    if (xW && !Number.isNaN(xW.value)) pos.x = xW.value
    if (yW && !Number.isNaN(yW.value)) pos.y = yW.value
    if (zW && !Number.isNaN(zW.value)) pos.z = zW.value
    const to: GcodePoint = { ...pos }

    const seg: GcodeSegment = { kind: active.kind, from, to, line: line.number }
    if (active.kind !== 'rapid') seg.feed = feed ?? undefined
    if (active.arc) seg.arc = active.arc
    segments.push(seg)
  }

  return {
    segments,
    end: { position: { ...pos }, motion, feed, spindle, wcs },
  }
}

/** Map an active motion mode word back to its G integer (for re-lookup). */
function motionCodeOf(mode: string): number {
  switch (mode) {
    case 'G0':
      return 0
    case 'G1':
      return 1
    case 'G2':
      return 2
    case 'G3':
      return 3
    default:
      return 1
  }
}

// --- public entry ------------------------------------------------------------

/** Parse g-code text into a tokenized + modally-interpreted program. */
export function parseGcode(text: string): GcodeProgram {
  const lines = tokenize(text)
  const rest = interpret(lines)
  return { lines, ...rest }
}
