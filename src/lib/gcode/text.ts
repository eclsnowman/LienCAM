// G-code text handling: comment stripping, sendable-line predicate, and
// program preparation. None of this is a GRBL concept - it applies to any
// G-code text regardless of which controller streams it.

import { GRBL_MAX_LINE_CHARS } from '../machine/grbl/constants'

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

/** Strip parenthesis and semicolon comments; GRBL accepts both styles. */
export function stripGcodeComments(line: string): string {
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
  return out.trim()
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
