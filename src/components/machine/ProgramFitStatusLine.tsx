import { liveCatalog } from './definition/catalogText'
import { textFor } from '../../i18n'
const controlText = textFor('control-screens-not-probing')

// ProgramFitStatusLine - WO-414 batch 2 (Operator 2026-08-21, on the Table card:
// "I have no idea how this is supposed to have value. I say remove it. The
// operator just needs to know if it is homed and we handle that elsewhere.")
//
// WO-414 (Operator 2026-08-21, on Chat: "The partially outside banner steals
// vertical pixels. Don't do that. Use console for messages."): the amber
// on-screen sentence this file used to render is gone entirely - no banner,
// no mounted component. What survives is WO-377's machine-coordinate fit
// verdict as CONSOLE lines only: one line naming the offending axes and
// numbers the moment a loaded program goes PARTLY OUTSIDE / OUTSIDE the
// table, and one line when it comes back INSIDE. INSIDE never writes on
// first paint (the absence of a line is the good news); homed is shown by
// the HOME LED already.
//
// The fit itself is still computed by ProgramPreview (fitProgramToEnvelope
// against the SAME envelope the grid draws - never a second derivation); it
// publishes the verdict here through publishProgramFit, which writes the
// console line directly. There is no React component, no store subscriber,
// no page mount - ControlPage no longer references this file at all.

import { type ProgramEnvelopeFit } from '../../lib/machine/machineEnvelope'
import { fmtMachineLength, unitLabel, type Units } from '../../lib/ui/unitFormat'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { PROGRAM_FIT_REMEDY } from '../../lib/machine/operatorTransport'
import { useMachineControl } from '../../store/machineControlStore'

export { PROGRAM_FIT_REMEDY } from '../../lib/machine/operatorTransport'

export interface PublishedProgramFit {
  fit: ProgramEnvelopeFit
  /** The work offset the program was placed with (named in the sentence). */
  wcs: string | null
}

let current: PublishedProgramFit | null = null

function sameFit(a: ProgramEnvelopeFit, b: ProgramEnvelopeFit): boolean {
  return a.state === b.state && JSON.stringify(a.offending) === JSON.stringify(b.offending)
}

export const FIT_WORD: Record<ProgramEnvelopeFit['state'], string> = liveCatalog(() => ({
  inside: controlText('ProgramFitStatusLine.text001'),
  partial: controlText('ProgramFitStatusLine.text002'),
  outside: controlText('ProgramFitStatusLine.text003'),
}))

/** The one sentence. Pure, so tests pin it without a render. Names every
 *  offending axis with the program's machine-coordinate extent beside the
 *  table's (WO-377's meaning, one line). */
export function programFitSentence(fit: ProgramEnvelopeFit, wcs: string | null, units: Units = 'mm'): string {
  const length = (mm: number) => fmtMachineLength(mm, units)
  const offsetName = wcs ?? controlText('ProgramFitStatusLine.text004')
  if (fit.state === 'inside') return controlText('ProgramFitStatusLine.text005', { value1: String(offsetName) })
  const axes = fit.state === 'outside'
    ? fit.offending.filter((a) => a.state === 'outside')
    : fit.offending
  const where = axes.map((a) => a.axis.toUpperCase()).join(', ')
  const extents = fit.offending
    .map((a) => `${a.axis.toUpperCase()}: program ${length(a.programMin)}..${length(a.programMax)}, table ${length(a.machineMin)}..${length(a.machineMax)} ${unitLabel(units)}`)
    .join('; ')
  const verb = fit.state === 'outside' ? controlText('ProgramFitStatusLine.text006') : controlText('ProgramFitStatusLine.text007')
  return controlText('ProgramFitStatusLine.text008', { value1: String(FIT_WORD[fit.state]), value2: String(offsetName), value3: String(verb), value4: String(where), value5: String(extents) })
}

/** Last verdict written to the console ('none' = nothing published yet). */
let lastConsoleFit: string = 'none'

/** Test hook: forget the last console verdict between cases. */
export function resetProgramFitConsole(): void {
  lastConsoleFit = 'none'
}

/** ProgramPreview publishes the verdict it computed (null = nothing to say:
 *  no program, no envelope, or the preview is not mounted). Writes ONE
 *  console line when the VERDICT changes: arriving at PARTLY OUTSIDE /
 *  OUTSIDE, moving between them, or coming back INSIDE from one of them.
 *  Never for INSIDE on first paint, never twice for the same verdict. */
export function publishProgramFit(next: PublishedProgramFit | null): void {
  const override = useUiPrefs.getState().machineDisplayUnits
  const units = override === 'default' ? useCamStore.getState().appSettings.displayUnits : override
  const sentence = next ? programFitSentence(next.fit, next.wcs, units) : ''
  const stored = useMachineControl.getState().programFit
  const storeMatches = next
    ? stored?.state === next.fit.state && stored.sentence === sentence
    : stored === null
  // The console cache intentionally survives a disconnect, but the motion
  // gate does not. Compare against the store itself so publishing the same
  // fit after reconnect heals the cleared gate without churning subscribers.
  if (!storeMatches) {
    useMachineControl.getState().setProgramFit(next ? { state: next.fit.state, sentence } : null)
  }

  if (next === current) return
  if (next && current && next.wcs === current.wcs && sameFit(next.fit, current.fit)) return
  current = next

  const state = next?.fit.state ?? 'none'
  const key = next ? `${state}|${sentence}` : 'none'
  if (key === lastConsoleFit) return
  const wasOff = lastConsoleFit.startsWith('partial|') || lastConsoleFit.startsWith('outside|')
  const isOff = state === 'partial' || state === 'outside'
  lastConsoleFit = key
  if (isOff) {
    useMachineControl.getState().pushConsole('tx', `${sentence} ${PROGRAM_FIT_REMEDY}`, 'error')
  } else if (wasOff && state === 'inside') {
    useMachineControl.getState().pushConsole('tx', sentence, 'info')
  }
}
