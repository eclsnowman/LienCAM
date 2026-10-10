import type { DefGroup } from './DefinitionNavigation'

// WO-1698: THE ONE DOOR INTO "OPEN THIS MACHINE'S DEFINITION ON SECTION X"
// FROM OUTSIDE THE DEFINITION PAGE ITSELF.
//
// `useMachineDefinitionPanel`'s `section` state (WO-1687) already answers
// "which of the seven areas is on screen", and OverviewCards (WO-1709)
// already has a way to change it while the page is open - but both live
// entirely inside that hook's own component tree. Nothing outside it (the
// Machine Library modal's disabled Travel row, ADR-0049's "two lenses, one
// record") could ask the Definition page to open on a particular area,
// because Control is mounted once and kept alive hidden (App.tsx) rather
// than remounted per navigation, so there is no prop path in.
//
// This is that door: a plain module-level request, consumed once, not store
// state - it is a navigation INTENT, never a machine fact, so it must not
// persist or rehydrate (unlike `machineLibrary`/`control`, which do). Any
// future caller that wants to land the Definition page on a specific area
// reuses this function; it is not to be copied.
const EVENT = 'liencam:open-machine-definition-section'

let pending: { machineId: string; section: DefGroup } | null = null

/** Ask the Definition page to open on `section` next time it renders for
 *  `machineId` - now, if it is already open and visible, or on arrival. Does
 *  NOT switch workspace or select the machine itself; the caller does that
 *  with the store actions it already has (Control Machine Selection is a
 *  CAM/Control fact, not a navigation-request fact - no second copy here). */
export function requestMachineDefinitionSection(machineId: string, section: DefGroup): void {
  pending = { machineId, section }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}

/** Read and clear the pending request for `machineId`, or null if there is
 *  none (none was made, or it named a different machine). Call once per
 *  mount/machine-switch and once per `EVENT`. */
export function consumeMachineDefinitionSection(machineId: string): DefGroup | null {
  if (pending === null || pending.machineId !== machineId) return null
  const { section } = pending
  pending = null
  return section
}

export function subscribeMachineDefinitionSectionRequests(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** WO-1698 review fix: peek at the pending request's machineId WITHOUT
 *  consuming it - a reader needs this to decide WHICH machine to resolve
 *  before it can know its own `source.id` (the id the request names IS the
 *  answer). `useMachineDefinitionPanel` reads this even with no explicit
 *  `machineId` prop, so a request made while a different machine is
 *  connected still lands the Definition page on the machine it named,
 *  rather than on the connected one - the "open this machine's definition
 *  by id" door WO-1696 built, reused here instead of a second one. */
export function peekMachineDefinitionSectionRequestMachineId(): string | null {
  return pending?.machineId ?? null
}
