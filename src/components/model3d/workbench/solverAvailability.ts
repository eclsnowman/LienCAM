import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
// WO-120: what the constraint solver's boot is doing, said ONCE, in the one
// place both action seams read it from.
//
// THE DEFECT THIS FILE EXISTS FOR. Until now the seams inferred the solver's
// state from `SketchSessionDeps.wrapper === null`, and a null wrapper meant two
// different things: "not ready YET" and "never will be". They guessed the
// optimistic one, so after the page's bounded recovery loop was exhausted
// `workbenchSketchDocumentPort.solved()` still said "The sketch solver is still
// loading" and `workbenchOverlaysPort.applyWithVerdict()` still said "Try again
// in a moment" -- forever. WO-108's status strip got this right and the seams
// did not, because the strip read React state the seams could not see.
//
// That is Operator's original defect one layer down: the screen says a thing is
// coming that is never coming. WO-091 section 11 forbids exactly this, and this
// lineage (WO-085 -> WO-091 -> WO-108 -> WO-120) is four work orders deep on it.
//
// SO THE STATE IS NAMED, NOT INFERRED. The host declares which of the four it
// is in; the seams read the name. Fixing only the message strings would have
// left the ambiguity in place, and it would have grown the same bug back the
// first time someone touched this code.

/**
 * The constraint solver's boot, as the seams need to see it.
 *
 *   'not-started'  -> no boot has been attempted yet in this host. Distinct
 *                     from 'loading' on purpose: "nothing is happening" and
 *                     "something is happening" are different things to say, and
 *                     collapsing them is how the ambiguity above was born.
 *   'loading'      -> a boot is in flight. Waiting is the right advice.
 *   'ready'        -> the wrapper is live. No seam ever asks in this state.
 *   'unavailable'  -> TERMINAL. The bounded recovery loop is spent. Waiting is
 *                     not advice, it is a lie; the app has already retried
 *                     every time it was ever going to.
 */
export type SolverAvailability = 'not-started' | 'loading' | 'ready' | 'unavailable'

/** What the host declared, or the legacy meaning when it declared nothing.
 *
 *  A live wrapper always wins: a host holding one is 'ready' whatever it said,
 *  and that ordering means a stale declaration can never suppress a real solve.
 *
 *  The DEFAULT is 'loading', which is exactly what every seam assumed before
 *  this WO -- so a host that predates `solverStatus` behaves byte-for-byte as
 *  it always did. The only host that can actually REACH exhaustion is
 *  SolidsWorkbenchPage, which declares the field from its one solver-state
 *  writer; the rest are test harnesses standing in for "the solver has not
 *  booted here". */
export function resolveSolverAvailability(
  deps: { wrapper: unknown; solverStatus?: SolverAvailability } | null,
): SolverAvailability {
  if (deps === null) return 'not-started'
  if (deps.wrapper !== null && deps.wrapper !== undefined) return 'ready'
  return deps.solverStatus ?? 'loading'
}

/**
 * The one recovery sentence for a terminally unavailable solver.
 *
 * NOT a retry prompt, and deliberately not a button. `planegcsLoader.ts`
 * memoises the module promise, so a "retry" is handed the same dead promise --
 * a button there would re-await a corpse. The app has already made every
 * attempt it is going to make (three, with backoff, each a fresh boot). A
 * reload re-fetches index.html and with it a fresh set of asset hashes, which
 * is what actually cures the documented stale-hash class -- the same advice the
 * geometry kernel's own exhausted status gives.
 */
const RELOAD_ADVICE = workbenchText('solverAvailability.reloadThePageToRestoreIt')

/**
 * What the DOCUMENT seam says when it cannot solve: geometry is always kept
 * exactly as drawn, and the reason is named.
 *
 * The 'unavailable' string must contain no word that promises a later success.
 * `SolidsWorkbenchPage.solverExhaustedSeams.wo120.test.tsx` asserts that
 * directly -- no "loading", no "try again", no "in a moment".
 */
export function unsolvedDocumentNotice(state: SolverAvailability): string {
  if (state === 'unavailable') {
    return workbenchText('solverAvailability.theSketchSolverIsUnavailableSoThisWasNot', { RELOAD_ADVICE: String(RELOAD_ADVICE) })
  }
  if (state === 'not-started') {
    return workbenchText('solverAvailability.theSketchSolverHasNotStartedGeometryIsPlaced')
  }
  return workbenchText('solverAvailability.theSketchSolverIsStillLoadingGeometryIsPlaced')
}

/**
 * What the VERDICT seam says when it refuses an application it cannot verify.
 *
 * `label` is the caller's own constraint/dimension name, so the user learns
 * WHICH action was refused as well as why. The refusal itself is unchanged and
 * deliberate: an unverified constraint can silently over-constrain a document
 * with nothing on screen to show it.
 */
export function unverifiableApplyNotice(state: SolverAvailability, label: string): string {
  if (state === 'unavailable') {
    return workbenchText('solverAvailability.wasNotAppliedTheSketchSolverIsUnavailableSo', { label: String(label), RELOAD_ADVICE: String(RELOAD_ADVICE) })
  }
  if (state === 'not-started') {
    return workbenchText('solverAvailability.theSketchSolverHasNotStartedSoThisCannot', { label: String(label) })
  }
  return workbenchText('solverAvailability.theSketchSolverIsStillLoadingTryAgainIn', { label: String(label) })
}
