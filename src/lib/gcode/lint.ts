// ============================================================
// G-code linter — the "loads on the first try" gate
// ============================================================
// Static checks over the SUBSET this project emits, returning structured
// findings rather than throwing. Built on the same tokenizer as parse.ts so the
// future in-app sender can lint a program before streaming it.
//
// Checks performed:
//   - balanced parentheses per line
//   - comment style matches the configured dialect (paren vs semicolon)
//   - every token is a recognized address letter + a valid number
//   - no stray / garbage tokens (a lone letter with no number, where a number
//     is required; or an unknown letter)
//   - first MOTION block carries an explicit motion mode
//   - a coordinate block with no active motion mode -> WARNING
//   - program end present (M30 or M2)
//   - spindle (M3/M4) started before the first feed move -> WARNING if not

import { tokenize, tokenizeLine, type GcodeLine } from './parse'
import { gcodeTableCategory, gcodeWordTable } from './wordTable'

export type LintLevel = 'error' | 'warning'

export interface LintFinding {
  level: LintLevel
  /** 1-based source line (0 for whole-program findings). */
  line: number
  code: string
  message: string
}

export interface LintOptions {
  /** Which comment delimiter the file is expected to use. Default 'paren'. */
  commentStyle?: 'paren' | 'semicolon'
}

// Address letters this subset recognises. A letter outside this set is garbage.
// Q is the canned-cycle peck/break increment (G83/G73); R is the retract plane
// and P the dwell, both already used by G4/G10 and the canned cycles. H is the
// tool-table index a `G43` names (WO-1677) - the shared reader carries it.
const KNOWN_LETTERS = new Set(['G', 'M', 'X', 'Y', 'Z', 'I', 'J', 'K', 'F', 'S', 'T', 'P', 'N', 'R', 'L', 'Q', 'H'])

// Letters that REQUIRE a numeric argument (e.g. "X" alone is garbage).
const NUMBER_REQUIRED = new Set(['G', 'M', 'X', 'Y', 'Z', 'I', 'J', 'K', 'F', 'S', 'T', 'P', 'N', 'R', 'L', 'Q', 'H'])

/** WO-1644: the motion words are the word table's (identical in every dialect). */
const MOTION_G = new Set(gcodeTableCategory(gcodeWordTable('uccnc'), 'motion').map((e) => e.value))

/** Strip parenthesised comments so token-level checks see only code. Depth-aware
 *  so a (mal)nested comment never leaks a stray ')' into the token scan: any
 *  character inside a paren of depth >= 1 becomes a space. */
function stripParens(s: string): string {
  let depth = 0
  let out = ''
  for (const ch of s) {
    if (ch === '(') {
      depth++
      out += ' '
    } else if (ch === ')') {
      if (depth > 0) depth--
      out += ' '
    } else {
      out += depth > 0 ? ' ' : ch
    }
  }
  return out
}

/** Lint a single line for lexical legality, pushing findings. */
function lintLineLexical(line: GcodeLine, opts: Required<LintOptions>, findings: LintFinding[]): void {
  const raw = line.raw

  // 1. Balanced parentheses (and no nesting — most controllers forbid nested
  //    comment parens even when they happen to balance).
  let depth = 0
  let balanced = true
  let nested = false
  for (const ch of raw) {
    if (ch === '(') {
      depth++
      if (depth > 1) nested = true
    } else if (ch === ')') {
      depth--
      if (depth < 0) {
        balanced = false
        break
      }
    }
  }
  if (!balanced || depth !== 0) {
    findings.push({
      level: 'error',
      line: line.number,
      code: 'UNBALANCED_PAREN',
      message: `Unbalanced parentheses in comment.`,
    })
  } else if (nested) {
    findings.push({
      level: 'error',
      line: line.number,
      code: 'NESTED_PAREN',
      message: `Nested parentheses in comment are not valid g-code.`,
    })
  }

  // 2. Comment style. A semicolon in a paren-only file is an error (and vice
  //    versa). We look at the raw line OUTSIDE of any balanced parens.
  const outsideParens = stripParens(raw)
  if (opts.commentStyle === 'paren' && outsideParens.includes(';')) {
    findings.push({
      level: 'error',
      line: line.number,
      code: 'WRONG_COMMENT_STYLE',
      message: `Semicolon comment found in a parentheses-style program.`,
    })
  }
  if (opts.commentStyle === 'semicolon') {
    // In a semicolon file, treat the first ';' as a comment start: only code to
    // its left is checked. Parenthesised comments stay valid too (RS274NGC reads both).
    // (Nothing to flag here beyond token checks below.)
  }

  // 3. Token-level legality. Re-scan the code portion for letter runs.
  const codePart =
    opts.commentStyle === 'semicolon' ? stripParensNoComment(outsideParens) : outsideParens
  // Find every maximal letter+number candidate and any leftover garbage.
  // We walk the string: a known letter optionally followed by a number is OK.
  const re = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))?|(\S)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(codePart)) !== null) {
    if (m[3] !== undefined) {
      // A non-letter, non-space stray character (e.g. '%', '@', '#').
      findings.push({
        level: 'error',
        line: line.number,
        code: 'STRAY_TOKEN',
        message: `Stray token "${m[3]}" is not a valid g-code address.`,
      })
      continue
    }
    const letter = m[1].toUpperCase()
    const hasNumber = m[2] !== undefined && m[2] !== ''
    if (!KNOWN_LETTERS.has(letter)) {
      findings.push({
        level: 'error',
        line: line.number,
        code: 'UNKNOWN_LETTER',
        message: `Unknown address letter "${letter}".`,
      })
      continue
    }
    if (NUMBER_REQUIRED.has(letter) && !hasNumber) {
      findings.push({
        level: 'error',
        line: line.number,
        code: 'MISSING_NUMBER',
        message: `Address "${letter}" is missing its numeric argument.`,
      })
    }
  }
}

/** For semicolon-style files: drop everything from the first ';' to end. */
function stripParensNoComment(raw: string): string {
  const idx = raw.indexOf(';')
  return idx >= 0 ? raw.slice(0, idx) : raw
}

/** Run all lint checks. Pure; never throws. */
export function lintGcode(text: string, options: LintOptions = {}): LintFinding[] {
  const opts: Required<LintOptions> = { commentStyle: options.commentStyle ?? 'paren' }
  const findings: LintFinding[] = []
  const lines = tokenize(text)

  // Per-line lexical checks.
  for (const line of lines) {
    lintLineLexical(line, opts, findings)
  }

  // Modal / structural checks across the program.
  let activeMotion: number | null = null
  let firstMotionSeen = false
  let firstFeedLine: number | null = null
  let spindleLine: number | null = null
  let endSeen = false

  for (const line of lines) {
    const gWords = line.words.filter((w) => w.letter === 'G' && !Number.isNaN(w.value))
    const mWords = line.words.filter((w) => w.letter === 'M' && !Number.isNaN(w.value))

    // Spindle on (M3/M4).
    for (const w of mWords) {
      if ((w.value === 3 || w.value === 4) && spindleLine === null) spindleLine = line.number
      if (w.value === 30 || w.value === 2) endSeen = true
    }

    // Track active motion mode from explicit motion G-words.
    let blockMotion: number | null = null
    for (const w of gWords) {
      if (MOTION_G.has(w.value)) {
        blockMotion = w.value
        activeMotion = w.value
      }
    }

    const hasCoord = line.words.some(
      (w) => (w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z') && !Number.isNaN(w.value),
    )

    if (hasCoord) {
      if (!firstMotionSeen) {
        firstMotionSeen = true
        if (blockMotion === null) {
          findings.push({
            level: 'error',
            line: line.number,
            code: 'NO_INITIAL_MOTION_MODE',
            message: `First motion block has no explicit motion mode (G0/G1/G2/G3).`,
          })
        }
      } else if (blockMotion === null && activeMotion === null) {
        findings.push({
          level: 'warning',
          line: line.number,
          code: 'COORD_WITHOUT_MOTION_MODE',
          message: `Coordinate word with no active motion mode.`,
        })
      }
      // Record first FEED move (active mode G1) for the spindle-order check.
      const effective = blockMotion ?? activeMotion
      if (effective === 1 && firstFeedLine === null) firstFeedLine = line.number

      // Circular-interpolation well-formedness (the C-P2 syntax risk). A G2/G3
      // block carrying an endpoint move (explicit or modally inherited) MUST
      // carry a center offset (I/J/K) or a radius (R). Endpoint is detected via
      // X/Y so a plane-axis-only move never trips the check spuriously.
      if (effective === 2 || effective === 3) {
        const hasEndpoint = line.words.some(
          (w) => (w.letter === 'X' || w.letter === 'Y') && !Number.isNaN(w.value),
        )
        if (hasEndpoint) {
          const hasIJK = line.words.some(
            (w) =>
              (w.letter === 'I' || w.letter === 'J' || w.letter === 'K') &&
              !Number.isNaN(w.value),
          )
          const hasR = line.words.some((w) => w.letter === 'R' && !Number.isNaN(w.value))
          if (!hasIJK && !hasR) {
            findings.push({
              level: 'error',
              line: line.number,
              code: 'ARC_NO_CENTER',
              message: `Circular move (G${effective}) has an endpoint but no center offset (I/J/K) or radius (R).`,
            })
          } else if (hasR && hasIJK) {
            findings.push({
              level: 'warning',
              line: line.number,
              code: 'ARC_R_AND_IJK',
              message: `Circular move (G${effective}) specifies both R and I/J/K; mixing radius and center-offset forms is contradictory.`,
            })
          }
        }
      }
    }
  }

  // Program end present?
  if (!endSeen) {
    findings.push({
      level: 'error',
      line: 0,
      code: 'NO_PROGRAM_END',
      message: `Program has no end code (M30 or M2).`,
    })
  }

  // Spindle started before the first feed?
  if (firstFeedLine !== null && (spindleLine === null || spindleLine > firstFeedLine)) {
    findings.push({
      level: 'warning',
      line: firstFeedLine,
      code: 'SPINDLE_NOT_STARTED',
      message: `First feed move occurs before the spindle is started (M3/M4).`,
    })
  }

  return findings
}

/** Throw if any error-level finding exists. Warnings are tolerated. */
export function assertClean(text: string, options: LintOptions = {}): void {
  const findings = lintGcode(text, options)
  const errors = findings.filter((f) => f.level === 'error')
  if (errors.length > 0) {
    const detail = errors.map((f) => `  L${f.line} [${f.code}] ${f.message}`).join('\n')
    throw new Error(`g-code lint found ${errors.length} error(s):\n${detail}`)
  }
}

// Re-export for callers that want a one-line lint of a single source line.
export { tokenizeLine }
