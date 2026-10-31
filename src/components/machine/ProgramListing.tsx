import { textFor } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

import type { ProgramStep } from '../../lib/machine/controller'
import { fmtNum } from '../../lib/post/format'
import type { StagedProgramView } from '../../store/machineControlStore'

import type { ProgramListingLine } from '../../lib/gcode/text'
export { programListingKinds, listingCommentParts, type ProgramListingLine, type ProgramListingKind } from '../../lib/gcode/text'


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
