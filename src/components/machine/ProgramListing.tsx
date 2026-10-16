import { textFor } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import type { ProgramStep } from '../../lib/machine/controller'
import { fmtNum } from '../../lib/post/format'
import type { StagedProgramView } from '../../store/machineControlStore'

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

/** Whether this row stands for the move the controller names. */
export function listingRowIsMove(line: ProgramListingLine, moveId: number | null): boolean {
  return moveId !== null && (line.moveId === moveId || (line.moreMoveIds?.includes(moveId) ?? false))
}

function word(letter: string, value: number | undefined): string | null {
  return value === undefined ? null : `${letter}${fmtNum(value, 3)}`
}

function words(values: Array<string | null>): string {
  return values.filter((value): value is string => value !== null).join(' ')
}

function formatStep(
  step: ProgramStep,
  previous: { x: number; y: number; z: number },
): string {
  if (step.kind === 'line') {
    const axes = words([
      word('X', step.to.x),
      word('Y', step.to.y),
      word('Z', step.to.z),
    ])
    return words([
      step.rapid ? 'G0' : 'G1',
      axes || null,
      step.rapid ? null : word('F', step.feedMmMin),
    ])
  }
  if (step.kind === 'arc') {
    const centre = step.plane === 'xy'
      ? [word('I', step.centre.x - previous.x), word('J', step.centre.y - previous.y)]
      : step.plane === 'xz'
        ? [word('I', step.centre.x - previous.x), word('K', step.centre.z - previous.z)]
        : [word('J', step.centre.y - previous.y), word('K', step.centre.z - previous.z)]
    return words([
      step.clockwise ? 'G2' : 'G3',
      words([word('X', step.to.x), word('Y', step.to.y), word('Z', step.to.z)]),
      words(centre),
      word('F', step.feedMmMin),
    ])
  }
  if (step.kind === 'dwell') return `G4 P${fmtNum(step.seconds, 3)}`
  if (step.kind === 'marker') return controlText('ProgramListing.text001')
  if (step.kind === 'spindle') {
    if (step.direction === 'off') return 'M5'
    return `${step.direction === 'cw' ? 'M3' : 'M4'} S${fmtNum(step.rpm, 3)}`
  }
  if (step.kind === 'coolant') {
    if (step.channel === 'air') return controlText('ProgramListing.text002', { value1: step.on ? controlText('ProgramListing.on') : controlText('ProgramListing.off') })
    if (!step.on) return 'M9'
    return step.channel === 'flood' ? 'M8' : 'M7'
  }
  if (step.kind === 'toolChange') {
    return `T${step.toolNumber} M6${step.description ? ` - ${step.description}` : ''}`
  }
  if (step.kind === 'toolLengthOffset') {
    return controlText('ProgramListing.text003', { value1: String(fmtNum(step.deltaMm, 3)) })
  }
  if (step.kind === 'workOffset') {
    return step.op === 'select'
      ? step.wcs
      : controlText('ProgramListing.text004', { value1: String(step.wcs), value2: String(step.axis), value3: String(fmtNum(step.valueMm, 3)) })
  }
  if (step.kind === 'park') return controlText('ProgramListing.text005', { value1: String(step.parkId) })
  return controlText('ProgramListing.text006', { value1: String(step.message) })
}

/** Render the exact staged program in the posted vocabulary operators know.
 *  Setup/frame rows are view-only annotations and never acquire move ids. */
export function stagedProgramListing(view: StagedProgramView): ProgramListingLine[] {
  const firstStepSetups = new Map(
    view.setups.map((setup) => [setup.firstStepId, setup] as const),
  )
  const lines: ProgramListingLine[] = []
  const previous = { x: 0, y: 0, z: 0 }
  for (const [index, step] of view.program.steps.entries()) {
    const setup = firstStepSetups.get(step.id)
    if (setup) {
      lines.push({ text: controlText('ProgramListing.text007', { value1: String(setup.setupName), value2: String(setup.wcs) }), moveId: null, lineNumber: null })
    }
    lines.push({
      text: formatStep(step, previous), moveId: step.id,
      lineNumber: view.sourceLines ? view.sourceLines[step.id] ?? null : index + 1,
    })
    if (step.kind === 'line' || step.kind === 'arc') Object.assign(previous, step.to)
  }
  return lines
}

/** WO-2680: a plain file's listing is every line of the file, in order, each
 *  at its own line number - the M7, the M9, the M0, the comments - not only
 *  the lines the controller is staged with a move for (machine seat 10-08:
 *  v68-m7-m9.nc listed without its lines 5 and 7). `staged` is the staged
 *  program's own listing (`stagedProgramListing`, at file lines); its rows
 *  keep their move ids, so the running highlight is unchanged. A line with
 *  no move is the file's text and addresses no move. The first section's
 *  heading heads the file; each later one stays on its first move, so the
 *  words that end a section (an M0, an M9, a tool change) list above it.
 *  WO-2683: every numbered row reads as the file's own line, as written - not
 *  the staged move with the coordinates it inherits (machine seat 10-08: line
 *  4 "G0 X0 Y0" listed "G0 X0 Y0 Z15"). A line staged as several moves is one
 *  row, lit for each of them. */
export function fileLinesListing(
  staged: readonly ProgramListingLine[],
  fileLines: readonly string[],
): ProgramListingLine[] {
  const lines: ProgramListingLine[] = []
  // A file's closing newline ends its last line; it opens no line after it.
  const count = fileLines.length > 1 && fileLines.at(-1) === '' ? fileLines.length - 1 : fileLines.length
  let next = 1
  const rowOfLine = new Map<number, number>()
  const listThrough = (last: number) => {
    for (; next <= Math.min(last, count); next++) {
      rowOfLine.set(next, lines.length)
      lines.push({ text: fileLines[next - 1], moveId: null, lineNumber: next })
    }
  }
  for (const [index, row] of staged.entries()) {
    if (row.lineNumber === null) {
      if (row.moveId === null && lines.length > 0) {
        let after = index + 1
        while (after < staged.length && staged[after].lineNumber === null) after++
        if (after < staged.length) listThrough(staged[after].lineNumber! - 1)
      }
      lines.push(row)
      continue
    }
    const listed = rowOfLine.get(row.lineNumber)
    if (listed !== undefined && row.moveId !== null) {
      const own = lines[listed]
      lines[listed] = own.moveId === null
        ? { ...own, moveId: row.moveId }
        : { ...own, moreMoveIds: [...own.moreMoveIds ?? [], row.moveId] }
      continue
    }
    listThrough(row.lineNumber - 1)
    rowOfLine.set(row.lineNumber, lines.length)
    lines.push({ ...row, text: fileLines[row.lineNumber - 1] ?? row.text })
    next = Math.max(next, row.lineNumber + 1)
  }
  listThrough(count)
  return lines
}
