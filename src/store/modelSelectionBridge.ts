// NAV-BODY-ROW (path 3, select-then-mode-switch): a SEPARATE, NOT-persisted
// zustand store -- mirrors src/store/uiPrefs.ts's own precedent of a store
// separate from src/store/index.ts for view/session state that is not
// project data, minus the persistence (this is deliberately volatile).
//
// The problem it solves: the Model workspace's tree/body-list selection
// (`selectedId` in SolidsWorkbenchPage.tsx) is plain component-local
// `useState`, invisible outside that component's own React subtree.
// ModeTabStrip.tsx, by contrast, is a separate floating-overlay component
// (App.tsx portals it into whichever workspace is active) that reads ONLY
// `useCamStore` -- it has no prop/context path back into
// SolidsWorkbenchPage's local state. Without a shared home for "which body
// is selected in the Model workspace right now", the CAM-tab click handler
// has nothing to carry over.
//
// This store is that shared home, and NOTHING else -- it does not replace
// `selectedId` (which still drives the Model workspace's own tree/body-list
// highlight and every in-workspace consumer, unchanged), it is a one-way
// mirror SolidsWorkbenchPage writes to and ModeTabStrip reads from. Kept OUT
// of src/store/index.ts on purpose (that file is a concurrent lane, PP-S3,
// during this WO) and OUT of uiPrefs.ts on purpose (persisting a selected
// body id across a reload/project-switch would resurrect a stale id from a
// closed project -- this must reset to null on every fresh page load,
// exactly like a plain `useState` would, which `create()` with no `persist`
// middleware gives for free).
//
// `bodyId` is the CURRENT LIVE LEAF id (BodyListPanel's own `body.bodyId`,
// which IS `modelBody.ref.bodyId` on the CAM side -- see
// src/lib/cam/modelBodyAdapter.ts's `findModelBodyGeometryRow`, the resolver
// this bridge's value feeds). `modelItemId` is the owning Model Item
// (SolidsWorkbenchPage's own `modelItemId` prop, default the legacy item) --
// both together are exactly what `findModelBodyGeometryRow` needs to resolve
// the scoped CAM Geometry row, mirroring `reconcileModelBodies`'s own
// item-scoping rule (INT-17C Stage C1 closure).
import { create } from 'zustand'

interface ModelSelectionBridgeState {
  /** The Model workspace tree/body-list's currently selected DAG node id, or
   *  null when nothing is selected (or the selection is a non-body node --
   *  the caller decides that by resolution failing, this store just carries
   *  whatever SolidsWorkbenchPage's own `selectedId` currently is). */
  selectedBodyId: string | null
  /** Which Model Item `selectedBodyId` belongs to (SolidsWorkbenchPage's own
   *  `modelItemId` prop at the time of selection). */
  selectedBodyModelItemId: string | undefined
  /** SolidsWorkbenchPage calls this on every `selectedId`/`modelItemId`
   *  change (a plain effect, not a new store action on the project store). */
  setModelSelection: (bodyId: string | null, modelItemId: string | undefined) => void
}

export const useModelSelectionBridge = create<ModelSelectionBridgeState>((set) => ({
  selectedBodyId: null,
  selectedBodyModelItemId: undefined,
  setModelSelection: (bodyId, modelItemId) =>
    set({ selectedBodyId: bodyId, selectedBodyModelItemId: modelItemId }),
}))
