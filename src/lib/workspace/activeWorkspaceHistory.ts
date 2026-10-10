// WO INT-13C (spec D5.4): the seam that lets TopToolbar's Undo/Redo BUTTONS reach the
// ACTIVE workspace's history.
//
// WHY THIS FILE EXISTS. TopToolbar renders ABOVE both workspace hosts (App.tsx:202) and
// is visible in BOTH -- but it can only see the CAM store, so its Undo button has always
// meant "CAM project undo" no matter what is on screen. D5.2 fixes the KEYBOARD by making
// the Part host's capture listener claim Ctrl+Z only while its workspace is active; that
// alone would ship exactly the split D5.4 forbids: in the Model workspace Ctrl+Z would undo
// the workbench command in front of you while the Undo button six inches above it undid a
// CAM project step. "Two paths to the same value, doing different things" is the wrong side
// of the many-paths-good/many-modes-bad line (feedback_properties_panel_first_class_edits),
// and it is why D5.4 ships in the same stage as D5.2.
//
// WHY A MODULE SINGLETON AND NOT THE STORE. The obvious home is a `workspace`-adjacent field
// in src/store/index.ts, and that file is NOT in INT-13C's ownership manifest (INT-13B hit
// the identical wall and self-drove off the `workspace` value for the same reason --
// SolidsWorkbenchPage.tsx:3855-3871). The workbench's CommandHistory is also not store-
// shaped: it is a command-pattern history, uncapped, semantically incompatible with the
// store's 10-deep paired snapshot arrays, and D5.1 rules that unification out. So the
// smallest correct thing is the subscribe/getSnapshot pair the workbench already uses for
// its own store-free reactivity (workbench/sketchSessionStore.ts, menuStore.ts): a
// publisher (the host that owns a history) and one subscriber (TopToolbar), with no state-
// management dependency and no workbench state entering the CAM store.
//
// WHAT IS PUBLISHED IS A FACADE, NOT A HISTORY. The Part host publishes four values it
// already computes for its own toolbar rail (SolidsWorkbenchPage.tsx:6330-6331), so the
// button and the chord end up calling the SAME `handleUndo` function object. That identity
// is what makes AC7's "the button and Ctrl+Z resolve to the same history" a structural
// fact rather than a coincidence two code paths have to keep agreeing on.

import type { Workspace } from '../../types'

/** The four values any workspace's history must expose to drive TopToolbar's buttons. */
export interface WorkspaceHistoryFacade {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

let current: WorkspaceHistoryFacade | null = null
/** Which mount owns the slot. See publishPartWorkspaceHistory's release rule. */
let owner: symbol | null = null
const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) cb()
}

function sameFacade(a: WorkspaceHistoryFacade, b: WorkspaceHistoryFacade): boolean {
  return a.undo === b.undo && a.redo === b.redo && a.canUndo === b.canUndo && a.canRedo === b.canRedo
}

/**
 * Publish (or release, with `next === null`) the Part workspace's history facade.
 *
 * `token` identifies the publishing MOUNT. The release path refuses to clear a slot it does
 * not own, which is the cleanup-tail case charter rule 5 is about: React mounts a
 * replacement component BEFORE unmounting the outgoing one, so a naive `current = null` in
 * the outgoing mount's cleanup would run AFTER the incoming mount published and would blank
 * a live workspace's Undo button until its next render. The token makes the release
 * last-writer-safe instead of order-dependent.
 *
 * Publishing an identical facade is a no-op: the Part host publishes from a
 * dependency-less effect (it must, since `history.canUndo()` is a method call and not
 * reactive state), so without this bail-out every workbench render would notify TopToolbar
 * and re-render it for nothing.
 */
export function publishPartWorkspaceHistory(token: symbol, next: WorkspaceHistoryFacade | null): void {
  if (next === null) {
    if (owner !== token) return // a stale mount releasing after a newer one claimed the slot
    owner = null
    current = null
    notify()
    return
  }
  if (owner === token && current !== null && sameFacade(current, next)) return
  owner = token
  current = next
  notify()
}

export function subscribePartWorkspaceHistory(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** Stable between publishes, so useSyncExternalStore's Object.is bail-out works. */
export function getPartWorkspaceHistory(): WorkspaceHistoryFacade | null {
  return current
}

/**
 * Resolve the history the ACTIVE workspace owns (spec D5.4). Pure, so the dispatch rule is
 * testable without a DOM -- same shape as useGlobalShortcuts' `shortcutsAllowed`.
 *
 * Returns null to REFUSE BY NAME (charter rule 2) in exactly one case: the Model workspace
 * is active but its host has published no history yet (it mounts lazily -- App.tsx:281 --
 * so between the tab click and the host's first effect there is a real window where the
 * Part workspace is active and nothing owns a history). The caller DISABLES the buttons for
 * a null. It must never fall back to CAM's history: doing so would fire a CAM project undo
 * from a button in the Model workspace, which is face (a) of the very mirror defect this WO
 * exists to close -- the fail-open an unnamed `else` would hide.
 */
export function resolveActiveWorkspaceHistory(
  workspace: Workspace,
  cam: WorkspaceHistoryFacade,
  part: WorkspaceHistoryFacade | null,
): WorkspaceHistoryFacade | null {
  if (workspace === 'cam') return cam
  if (workspace === 'part') return part
  // No third workspace exists today. If one is ever added, it arrives here with no history
  // owner rather than silently inheriting CAM's -- refuse, do not guess.
  return null
}

/** Test seam: this module is a singleton, so it leaks across test files without it. */
export function __resetPartWorkspaceHistory(): void {
  current = null
  owner = null
  subscribers.clear()
}
