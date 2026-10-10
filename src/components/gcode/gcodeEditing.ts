// WO-2651: the pure half of the G-code editor - what changed between two
// texts, the edit records undo/redo replays, the colouring tokens, and the
// shared reader's verdict on a text. No React here; the editor and both of its
// hosts (Post Process preview, Control > program panel) read these.

import { readGcodeProgram, type GcodeDialect, type GcodeWcs } from '../../lib/gcode/reader'
import type { MachineConfig } from '../../types'

// ---- line diff ----------------------------------------------------------------

/** One run of changed lines: `beforeCount` lines of the old text starting at
 *  1-based `beforeStart` became `afterCount` lines of the new text starting at
 *  `afterStart`. A pure insertion has beforeCount 0 and sits after line
 *  beforeStart - 1. */
export interface LineHunk {
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
}

export interface LineChanges {
  hunks: LineHunk[]
  added: number
  removed: number
  /** Lines touched in the new text: added plus replaced. */
  changed: number
  /** The diff gave up on an edit too large to align line by line (a replace
   *  over most of a 100k-line file); `hunks` is then one span. */
  coarse: boolean
}

/** Beyond this many differing lines, report one span instead of aligning. */
const MAX_ALIGNED_EDITS = 1000

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Myers' O(ND) shortest edit script over the middle that differs. Returns
 *  null when the edit distance passes the cap. */
function myers(a: readonly string[], b: readonly string[], cap: number): Array<[number, number]> | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, cap)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) {
        // Walk back to the matched pairs.
        const pairs: Array<[number, number]> = []
        let cx = n
        let cy = m
        for (let back = d; back > 0; back--) {
          const pv = trace[back]
          const kk = cx - cy
          const prevK = kk === -back || (kk !== back && pv[offset + kk - 1] < pv[offset + kk + 1]) ? kk + 1 : kk - 1
          const px = pv[offset + prevK]
          const py = px - prevK
          while (cx > px && cy > py) { cx--; cy--; pairs.push([cx, cy]) }
          cx = px
          cy = py
        }
        while (cx > 0 && cy > 0) { cx--; cy--; pairs.push([cx, cy]) }
        return pairs.reverse()
      }
    }
  }
  return null
}

/** What changed, line by line, from `before` to `after`. */
export function lineChanges(before: string, after: string): LineChanges {
  if (before === after) return { hunks: [], added: 0, removed: 0, changed: 0, coarse: false }
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const pairs = myers(midA, midB, MAX_ALIGNED_EDITS)
  const hunks: LineHunk[] = []
  let coarse = false
  if (pairs === null) {
    coarse = true
    hunks.push({ beforeStart: start + 1, beforeCount: midA.length, afterStart: start + 1, afterCount: midB.length })
  } else {
    let ia = 0
    let ib = 0
    for (const [pa, pb] of [...pairs, [midA.length, midB.length] as [number, number]]) {
      if (pa > ia || pb > ib) {
        hunks.push({ beforeStart: start + ia + 1, beforeCount: pa - ia, afterStart: start + ib + 1, afterCount: pb - ib })
      }
      ia = pa + 1
      ib = pb + 1
    }
  }
  let added = 0
  let removed = 0
  let changed = 0
  for (const h of hunks) {
    added += Math.max(0, h.afterCount - h.beforeCount)
    removed += Math.max(0, h.beforeCount - h.afterCount)
    changed += h.afterCount > 0 ? h.afterCount : h.beforeCount
  }
  return { hunks, added, removed, changed, coarse }
}

/** The words a change summary is built from (the i18n catalogue's, passed in
 *  so this module stays React- and i18next-free). */
export interface ChangeWords {
  added: (count: number, after: number) => string
  addedAtStart: (count: number) => string
  removed: (count: number, from: number) => string
  replacedOne: (line: number) => string
  replaced: (from: number, to: number, count: number) => string
  several: (changed: number, places: number) => string
  none: () => string
}

/** One sentence for the console and the post screen: "1 line added after
 *  line 240". Line numbers are the ORIGINAL text's, so the operator can find
 *  the place in the program he started from. */
export function describeLineChanges(changes: LineChanges, words: ChangeWords): string {
  if (changes.hunks.length === 0) return words.none()
  if (changes.hunks.length > 1) return words.several(changes.changed, changes.hunks.length)
  const h = changes.hunks[0]
  if (h.beforeCount === 0) {
    return h.beforeStart <= 1 ? words.addedAtStart(h.afterCount) : words.added(h.afterCount, h.beforeStart - 1)
  }
  if (h.afterCount === 0) return words.removed(h.beforeCount, h.beforeStart)
  if (h.beforeCount === 1 && h.afterCount === 1) return words.replacedOne(h.beforeStart)
  return words.replaced(h.beforeStart, h.beforeStart + h.beforeCount - 1, h.afterCount)
}

// ---- edit records (undo / redo) ------------------------------------------------

/** One reversible text edit: `removed` at `at` was replaced by `inserted`. */
export interface TextEdit {
  at: number
  removed: string
  inserted: string
}

/** The single span that differs between two texts (common prefix and suffix
 *  trimmed) - what a keystroke, a paste or a replace did. */
export function textEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null
  let start = 0
  const limit = Math.min(before.length, after.length)
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start
    && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--
    endAfter--
  }
  return { at: start, removed: before.slice(start, endBefore), inserted: after.slice(start, endAfter) }
}

export function applyTextEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.at) + edit.inserted + text.slice(edit.at + edit.removed.length)
}

export function invertTextEdit(edit: TextEdit): TextEdit {
  return { at: edit.at, removed: edit.inserted, inserted: edit.removed }
}

/** Typing a run of characters is one undo step, not one per key. */
export function mergeTypingEdit(previous: TextEdit, next: TextEdit): TextEdit | null {
  if (previous.removed !== '' || next.removed !== '') return null
  if (next.at !== previous.at + previous.inserted.length) return null
  if (next.inserted.includes('\n') || /\s$/.test(previous.inserted)) return null
  return { at: previous.at, removed: '', inserted: previous.inserted + next.inserted }
}

// ---- find ---------------------------------------------------------------------

/** Offsets of every case-insensitive match of `query` in `text`. */
export function findAll(text: string, query: string): number[] {
  if (query === '') return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const found: number[] = []
  let at = hay.indexOf(needle)
  while (at !== -1) {
    found.push(at)
    at = hay.indexOf(needle, at + Math.max(1, needle.length))
  }
  return found
}

/** Replace every case-insensitive match; returns the text and how many. */
export function replaceAll(text: string, query: string, replacement: string): { text: string; count: number } {
  const found = findAll(text, query)
  if (found.length === 0) return { text, count: 0 }
  let out = ''
  let last = 0
  for (const at of found) {
    out += text.slice(last, at) + replacement
    last = at + query.length
  }
  return { text: out + text.slice(last), count: found.length }
}

/** 1-based line of a character offset. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1
  let at = text.indexOf('\n')
  while (at !== -1 && at < offset) {
    line++
    at = text.indexOf('\n', at + 1)
  }
  return line
}

/** Character offset where 1-based `line` starts (clamped to the text). */
export function offsetOfLine(text: string, line: number): number {
  let offset = 0
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return offset
    offset = next + 1
  }
  return offset
}

// ---- colouring ----------------------------------------------------------------

export type GcodeTokenKind = 'comment' | 'g' | 'm' | 'tool' | 'axis' | 'feed' | 'number' | 'other' | 'space'

export interface GcodeToken {
  text: string
  kind: GcodeTokenKind
}

const WORD = /^([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+)|#\d+|\[[^\]]*\])?/

function letterKind(letter: string): GcodeTokenKind {
  switch (letter.toUpperCase()) {
    case 'G': return 'g'
    case 'M': return 'm'
    case 'T': case 'H': case 'D': return 'tool'
    case 'X': case 'Y': case 'Z': case 'A': case 'B': case 'C':
    case 'I': case 'J': case 'K': case 'R': return 'axis'
    case 'F': case 'S': return 'feed'
    case 'N': case 'O': return 'number'
    default: return 'other'
  }
}

/** Colour one line. Every character of the line lands in exactly one token,
 *  so the coloured copy is the same width as the text under it. */
export function gcodeTokens(line: string): GcodeToken[] {
  const tokens: GcodeToken[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === ';') {
      tokens.push({ text: line.slice(i), kind: 'comment' })
      break
    }
    if (ch === '(') {
      const close = line.indexOf(')', i)
      const end = close === -1 ? line.length : close + 1
      tokens.push({ text: line.slice(i, end), kind: 'comment' })
      i = end
      continue
    }
    if (ch === ' ' || ch === '\t') {
      let end = i
      while (end < line.length && (line[end] === ' ' || line[end] === '\t')) end++
      tokens.push({ text: line.slice(i, end), kind: 'space' })
      i = end
      continue
    }
    const word = WORD.exec(line.slice(i))
    if (word && word[2] !== undefined) {
      tokens.push({ text: word[0], kind: letterKind(word[1]) })
      i += word[0].length
      continue
    }
    tokens.push({ text: ch, kind: 'other' })
    i++
  }
  return tokens
}

// ---- the reader's verdict -------------------------------------------------------

/** A line the reader cannot run, in the reader's own words. */
export interface GcodeLineMark {
  line: number
  message: string
}

const WCS: readonly GcodeWcs[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']

/** The machine's declared controller as the shared reader's dialect - the
 *  mapping Control's run estimate already uses. */
export function readerDialectOf(controller: string | null | undefined): GcodeDialect {
  if (controller === 'uccnc' || controller === 'linuxcnc') return controller
  if (controller === 'grbl' || controller === 'grblhal') return 'grbl'
  return 'generic'
}

/**
 * WO-2651: THE SHARED READER'S VERDICT ON A TEXT - the line it stops at and its
 * own message, or none. It is what the editor marks; it never blocks typing
 * and never refuses a load (rule 11): the load itself is the authority, and a
 * load that refuses a line is marked with ITS message by the host.
 *
 * Positions are not what is checked here, so every work origin is at machine
 * zero, home is machine zero and a G43 H word reads a zero length: a line is
 * marked only for a word or a construct the reader cannot run at all.
 */
export function readerMarks(text: string, machine: MachineConfig | null | undefined): GcodeLineMark[] {
  if (text.trim() === '') return []
  const zero = { x: 0, y: 0, z: 0 }
  try {
    const read = readGcodeProgram(text, {
      dialect: readerDialectOf(machine?.controller),
      sessionWcs: 'G54',
      initialPosition: zero,
      machineUnits: 'mm',
      workOffsets: Object.fromEntries(WCS.map((wcs) => [wcs, zero])),
      machineHome: zero,
      referencePositions: { 1: zero, 2: zero, 3: zero, 4: zero },
      ...(machine ? { machineDefinition: machine } : {}),
      toolLengthMm: () => 0,
      macroMCodes: 'report',
    })
    return read.ok ? [] : [{ line: read.refusal.line, message: read.refusal.message }]
  } catch {
    // The marks are advice; a reader fault never takes the editor down.
    return []
  }
}

/** A load refusal names its line as "line N" in its own sentence; mark it
 *  there, or on line 0 (the whole program) when it names none. */
export function markFromRefusal(reason: string): GcodeLineMark {
  const named = /\bline (\d+)\b/i.exec(reason)
  return { line: named ? Number(named[1]) : 0, message: reason }
}

/** The text with the same line endings as `like` (a file opened with CRLF is
 *  saved and loaded with CRLF; the editor itself works in LF). */
export function withLineEndingsOf(like: string, text: string): string {
  return like.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text
}

/** The program with each LCX1 context line reduced to a marker. The context
 *  block is re-stamped (generatedAt, its checksum) every time the program is
 *  posted, so two posts of the same program differ there and nowhere else;
 *  whether a block is present still counts. */
export function withoutContextStamp(text: string): string {
  return text.replace(/^[ \t]*([(;])[ \t]*LCX1\b.*$/gm, '$1LCX1')
}
