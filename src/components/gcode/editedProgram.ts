// WO-2651: what the two editor hosts share besides the editor - the sentence
// that says what an edit changed, and the hand-off that carries a program from
// the Post Process screen to Control's own load path.

import { textFor } from '../../i18n'
import { computeMotionDigest, mintVerifiedExportContext, type ProgramContextV1 } from '../../lib/machine/programContext'
import { importProgramContextFromGcode } from '../../lib/post/programContextEnvelope'
import { describeLineChanges, lineChanges, type ChangeWords, type LineHunk } from './gcodeEditing'

/** The catalogue's words for a change summary. */
export function changeWords(): ChangeWords {
  const t = textFor('gcode-editor')
  return {
    added: (count, after) => count === 1 ? t('changes.addedOne', { after }) : t('changes.addedMany', { count, after }),
    addedAtStart: (count) => count === 1 ? t('changes.addedAtStartOne') : t('changes.addedAtStartMany', { count }),
    removed: (count, from) => count === 1 ? t('changes.removedOne', { from }) : t('changes.removedMany', { count, from }),
    replacedOne: (line) => t('changes.replacedOne', { line }),
    replaced: (from, to, count) => from === to ? t('changes.replacedLine', { line: from, count })
      : count === 1 ? t('changes.replacedByOne', { from, to }) : t('changes.replaced', { from, to, count }),
    several: (changed, places) => t('changes.several', { changed, places }),
    none: () => t('changes.none'),
  }
}

/** "1 line added after line 240" - `before` is the program the user started from. */
export function describeEdit(before: string, after: string): string {
  return describeLineChanges(lineChanges(before, after), changeWords())
}

// ---- The program's LienCAM context, through an edit -----------------------------

/** Where an inclusive span of `before` lines lies after the edit. A line
 *  inserted after a span's last line joins that span (the user put it after a
 *  line of that operation); a replaced region keeps the span's ends inside it. */
function spanAfterEdit(hunks: readonly LineHunk[], start: number, end: number): [number, number] {
  let shiftStart = 0
  let shiftEnd = 0
  let newStart: number | null = null
  let newEnd: number | null = null
  for (const h of hunks) {
    const delta = h.afterCount - h.beforeCount
    const last = h.beforeStart + h.beforeCount - 1
    if (newStart === null) {
      if (h.beforeCount === 0 ? h.beforeStart <= start : last < start) shiftStart += delta
      else if (h.beforeStart <= start && start <= last) newStart = h.afterStart
    }
    if (newEnd === null) {
      if (h.beforeCount === 0 ? h.beforeStart <= end + 1 : last < end) shiftEnd += delta
      else if (h.beforeStart <= end && end <= last) newEnd = h.afterStart + h.afterCount - 1
    }
  }
  return [newStart ?? start + shiftStart, newEnd ?? end + shiftEnd]
}

/** WO-2651 item 9: the LienCAM setup information a posted program carries,
 *  carried through the user's own edit of it. Its operation spans move with
 *  the lines the edit added or removed, and its motion digest is the edited
 *  program's, so run-from-line, the operation and tool names and the intended
 *  stock follow the edited text. Without this the context no longer matched
 *  the program and was dropped with a console warning - and on a controller
 *  whose run-from-line reads the context (the UCCNC file door), Run from here
 *  went away after any edit. A span the edit empties invalidates the context:
 *  the program loads without it, as any file without one does. */
export function programContextForEdit(
  before: string,
  after: string,
  /** The context the loaded program was bound to; absent, the one `before` carries. */
  known: ProgramContextV1 | null = null,
): ProgramContextV1 | null {
  const context = known ?? importProgramContextFromGcode(before).context
  if (!context || computeMotionDigest(before) !== context.motionDigest) return null
  if (before === after) return context
  const { hunks } = lineChanges(before, after)
  const operations = context.operations.map((operation) => {
    const [startLine, endLine] = spanAfterEdit(hunks, operation.startLine, operation.endLine)
    return { ...operation, startLine, endLine }
  })
  if (operations.some((o) => o.startLine < 1 || o.endLine < o.startLine)) return null
  const edited = { ...context, operations, motionDigest: computeMotionDigest(after) }
  try {
    // A context read from the file's own block is trusted only as minted; one
    // built from the live setup is accepted on its shape (programContext.ts).
    return edited.source === 'verified-export' ? mintVerifiedExportContext(edited, after) : edited
  } catch {
    return null
  }
}

// ---- Post Process -> Control ---------------------------------------------------

/** A program the Post Process screen handed to Control, waiting for the
 *  program panel to load it through its own Load path. */
export interface ProgramForControl {
  name: string
  text: string
  /** The posted text a hand edit started from (absent: not edited). */
  base?: string
}

let waiting: ProgramForControl | null = null
const listeners = new Set<() => void>()

/** Hand a program to Control. The program panel loads it exactly as it loads
 *  an opened file - the same door, the same checks, the same console lines. */
export function sendProgramToControl(program: ProgramForControl): void {
  waiting = { ...program }
  for (const listener of listeners) listener()
}

/** The program waiting for Control, taken (once). */
export function takeProgramForControl(): ProgramForControl | null {
  const taken = waiting
  waiting = null
  return taken
}

export function subscribeProgramForControl(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
