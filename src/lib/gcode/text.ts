// G-code text handling: comment stripping, sendable-line predicate, and
// program preparation. None of this is a GRBL concept - it applies to any
// G-code text regardless of which controller streams it.

import type { ProgramStep } from '../machine/controller'
import { GRBL_MAX_LINE_CHARS } from '../machine/grbl/constants'

/** WO-3125: a real task continuation without the nested-timer clamp or a
 * dependency on viewport frames. Close both ports after each single-use task;
 * no idle channel keeps a worker/renderer alive. */
export function yieldSetupLoadTask(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** A sendable line with its 1-based line number in the ORIGINAL program text. */
export interface StreamLine {
  text: string
  sourceLine: number
}

export interface LoadResult {
  lines: StreamLine[]
  /** Lines dropped at load: blanks, comment-only, % program markers. */
  skipped: number
  /** Lines exceeding GRBL's 80-char line buffer - refuse to stream if present. */
  overlongLines: number[]
}

const strippedLines = new Map<string, string>()
const MAX_STRIPPED_LINES = 32768

/** Strip parenthesis and semicolon comments; GRBL accepts both styles. */
export function stripGcodeComments(line: string): string {
  const cached = strippedLines.get(line)
  if (cached !== undefined) return cached
  let out = ''
  let inParen = false
  for (const ch of line) {
    if (inParen) {
      if (ch === ')') inParen = false
      continue
    }
    if (ch === '(') {
      inParen = true
      continue
    }
    if (ch === ';') break
    out += ch
  }
  const stripped = out.trim()
  if (strippedLines.size >= MAX_STRIPPED_LINES) strippedLines.delete(strippedLines.keys().next().value!)
  strippedLines.set(line, stripped)
  return stripped
}

/**
 * The canonical "will this raw line stream" test: prepareProgram drops blank,
 * comment-only, and '%' program-marker lines. Any UI gesture that targets a
 * streamable line (run-from-here) must use this same predicate.
 */
export function isSendableGcodeLine(raw: string): boolean {
  return sendable(stripGcodeComments(raw))
}

function sendable(stripped: string): boolean {
  return stripped !== '' && stripped !== '%'
}

export function prepareProgram(text: string): LoadResult {
  const rawLines = text.split(/\r?\n/)
  const lines: StreamLine[] = []
  const overlongLines: number[] = []
  let skipped = 0
  for (let i = 0; i < rawLines.length; i++) {
    const stripped = stripGcodeComments(rawLines[i])
    if (!sendable(stripped)) {
      skipped++
      continue
    }
    if (stripped.length > GRBL_MAX_LINE_CHARS) overlongLines.push(i + 1)
    lines.push({ text: stripped, sourceLine: i + 1 })
  }
  return { lines, skipped, overlongLines }
}

// Pure listing lexical facts are shared with worker preparation.
export type ProgramListingKind = 'header' | 'comment' | 'rapid' | 'feed' | 'arc' | 'tool-change' | 'm-code' | 'code'

/** G/M-looking text inside an expression, parameter name or quoted payload
 * is not a word. Keep its delimiters so dynamic G[#...] remains unresolved. */
function displayWordsSource(code: string): string {
  let result = ''
  let depth = 0
  let quote: string | null = null
  for (let at = 0; at < code.length; at++) {
    const ch = code[at]
    if (quote !== null) { if (ch === quote) quote = null; result += ' '; continue }
    if (ch === '"' || ch === "'") { quote = ch; result += ' '; continue }
    if (ch === '#' && code[at + 1] === '<') {
      result += '#'
      while (++at < code.length) { result += ' '; if (code[at] === '>') break }
      continue
    }
    if (ch === '[') { depth++; result += '['; continue }
    if (ch === ']') { depth = Math.max(0, depth - 1); result += ']'; continue }
    result += depth > 0 ? ' ' : ch
  }
  return result
}

/** Display spans only: concatenation is the original line, including whitespace. */
export function listingCommentParts(text: string): Array<{ text: string; comment: boolean }> {
  const parts: Array<{ text: string; comment: boolean }> = []
  let start = 0
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '(' && text[at] !== ';') continue
    if (at > start) parts.push({ text: text.slice(start, at), comment: false })
    const begin = at
    if (text[at] === ';') at = text.length
    else {
      let depth = 1
      while (++at < text.length && depth > 0) {
        if (text[at] === '(') depth++
        else if (text[at] === ')') depth--
      }
    }
    parts.push({ text: text.slice(begin, at), comment: true })
    start = at
    at--
  }
  if (start < text.length) parts.push({ text: text.slice(start), comment: false })
  return parts
}

/** One display-only pass over all rows, so a window's continuation lines inherit
 * their preceding G0/G1/G2/G3. Never changes text, ids or controller parsing.
 * Unknown/canned motion cancels our colour inference; it cannot authorize a move. */
export function programListingKinds(
  lines: readonly ProgramListingLine[], steps: readonly ProgramStep[] = [],
): ProgramListingKind[] {
  const byId = new Map(steps.map(step => [step.id, step]))
  const passive = [17, 18, 19, 20, 21, 40, 41, 42, 43, 49, 54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3, 61, 64, 90, 91, 90.1, 91.1, 93, 94, 95, 98, 99]
  const nonmodal = [4, 10, 28, 30, 52, 53, 92, 92.1, 92.2, 92.3]
  const knownG = new Set([0, 1, 2, 3, ...passive, ...nonmodal])
  let motion: 'rapid' | 'feed' | 'arc' | null = null
  return lines.map(line => {
    if (line.lineNumber === null && line.moveId === null) return 'header'
    // Typed staged rows need no lexical guess about translated descriptions.
    // Raw file rows deliberately omit steps at the call site below.
    const step = line.moveId === null ? undefined : byId.get(line.moveId)
    if (step?.kind === 'line') { motion = step.rapid ? 'rapid' : 'feed'; return motion }
    if (step?.kind === 'arc') { motion = 'arc'; return motion }
    if (step?.kind === 'toolChange') return 'tool-change'
    if (step?.kind === 'spindle' || step?.kind === 'coolant') return 'm-code'
    if (step) return 'code'
    // Use the renderer's nested-comment boundaries too: a word inside an
    // outer comment must neither acquire a colour nor change later modal rows.
    const stripped = listingCommentParts(line.text)
      .filter(part => !part.comment).map(part => part.text).join('').trim()
    if (!stripped) return line.text.trim() ? 'comment' : 'code'
    // Parameter names are not axes; subprogram calls can change modal state.
    if (/^\s*#/i.test(stripped)) return 'code'
    if (/^\s*O\s*(?:\d|<)/i.test(stripped)) { motion = null; return 'code' }
    const code = displayWordsSource(stripped)
    const g = [...code.matchAll(/(?<![A-Z])G\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gi)].map(word => Number(word[1]))
    const m = [...code.matchAll(/(?<![A-Z])M\s*(\d+(?:\.\d*)?)/gi)].map(word => Number(word[1]))
    const explicit = g.findLast(value => value === 0 || value === 1 || value === 2 || value === 3)
    const unknownMotion = /G\s*(?:#|\[)/i.test(code) || g.some(value => !knownG.has(value))
    if (unknownMotion) motion = null
    else if (explicit !== undefined) motion = explicit === 0 ? 'rapid' : explicit === 1 ? 'feed' : 'arc'
    if (m.includes(98) || m.includes(99)) { motion = null; return 'm-code' }
    if (m.includes(6)) return 'tool-change'
    if (!unknownMotion && explicit !== undefined) return motion!
    if (m.length) return 'm-code'
    if (!unknownMotion && !g.some(value => nonmodal.includes(value))
      && /[XYZABCUVWIJKR]\s*(?:[+-]?(?:\d|\.)|#|\[)/i.test(code)) return motion ?? 'code'
    return 'code'
  })
}

export interface ProgramListingLine {
  text: string
  /** Controller status ids address steps, while setup boundary rows do not. */
  moveId: number | null
  /** File line, or step ordinal for a toolpath; dividers are not file lines. */
  lineNumber: number | null
  /** WO-2683: the further moves a file line's one row stands for (a line the
   *  session staged as several moves); the row is lit for any of them. */
  moreMoveIds?: readonly number[]
}
