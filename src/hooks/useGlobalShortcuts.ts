import { useEffect } from 'react'
import { useCamStore } from '../store'
import { useUiPrefs } from '../store/uiPrefs'
import { matchCamShortcut } from '../lib/shortcuts/camShortcutRegistry'
import type { Workspace } from '../types'

// Global CAM keyboard shortcuts (Phase 7, P12 / 7.3).
//   G          regenerate the selected operation
//   Shift+G    generate all toolpaths
//   N          new operation on the active setup
//   Delete     delete the selected tree item (geometry > op > setup), WITH confirm
// G, Shift+G and N are the defaults of three rows the operator can remap in Settings
// (WO-3257); lib/shortcuts decides which action a key means. Delete is not remappable.
//
// Active ONLY when the CAM workspace is active (WO INT-13C, see `workspace` below), no
// input/textarea/select/contenteditable is focused, and no modal is open. Sketch mode is
// excluded — it owns its own single-key tools. The guard is a pure, exported predicate so
// the "do nothing while typing" rule is unit-testable without a DOM.

export interface ShortcutGuardState {
  /** WO INT-13C (P2): which workspace is active. Every action this hook fires is a CAM
   *  PROJECT mutation, so none of them has any meaning while the Model workspace is on
   *  screen. */
  workspace: Workspace
  /** activeModal from the store (null = no modal). */
  activeModal: string | null
  /** Current viewer mode — sketch mode owns its own keys. */
  mode: string
  /** Tag name of the focused element, lowercased ('' when body/none). */
  focusedTag: string
  /** True when the focused element is contenteditable. */
  isContentEditable: boolean
}

/** True only when a global CAM shortcut is allowed to fire. */
export function shortcutsAllowed(s: ShortcutGuardState): boolean {
  // WO INT-13C (P2, Work item 2). These fire page-wide today and are NOT workspace-scoped,
  // which was a LIVE routing defect the ownership census surfaced rather than a hypothetical:
  //
  //  - N collided outright. The workbench arms its N-pick on a bare N
  //    (SolidsWorkbenchPage.tsx:4573) and this hook opens CAM's New Operation modal on the
  //    same bare N. Both are unconditional bubble-phase window listeners, so before this
  //    guard, pressing N in the Model workspace did BOTH: armed the pick and dropped a CAM
  //    modal on top of it.
  //  - G collided whenever a workbench sketch was open: `g` arms the sketcher's text tool
  //    (SKETCH_TOOL_SHORTCUTS.g) and this hook regenerates a CAM toolpath. The `mode` guard
  //    below does NOT save it -- that reads CAM's viewer.mode, which stays out of 'sketch'
  //    the entire time a PART-workspace sketch is open. It cannot see the other workspace.
  //  - Delete/Backspace never collided (the workbench's delete is its own), but it deletes CAM
  //    geometry/ops/setups behind a confirm dialog raised over the Model workspace.
  //
  // So the disposition is the whole hook, not a per-chord carve-out: the WO asks for "any that
  // would collide with a Model-workspace action" to be scoped, and the honest reading of a
  // closed enumeration whose every member mutates the CAM project is that ALL of it is
  // cam-only. Scoping the hook rather than three individual chords also means a shortcut added
  // here later is workspace-scoped by default instead of being a fresh routing defect that the
  // census would have to catch after the fact.
  if (s.workspace !== 'cam') return false
  if (s.activeModal) return false
  if (s.mode === 'sketch') return false
  if (s.isContentEditable) return false
  if (s.focusedTag === 'input' || s.focusedTag === 'textarea' || s.focusedTag === 'select') return false
  return true
}

function readGuardState(): ShortcutGuardState {
  const st = useCamStore.getState()
  const el = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null
  return {
    workspace: st.workspace,
    activeModal: st.activeModal,
    mode: st.viewer.mode,
    focusedTag: el?.tagName?.toLowerCase() ?? '',
    isContentEditable: !!el?.isContentEditable,
  }
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack modifier combos (Ctrl/Cmd/Alt) — those belong to the
      // browser/OS and to existing Ctrl+Z. Shift is allowed (Shift+G).
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (!shortcutsAllowed(readGuardState())) return

      const s = useCamStore.getState()
      const { project } = s
      const setupId = project.activeSetupId
      const opId = project.activeOperationId
      const selectedGeoId = s.viewer.selectedGeometryId

      const key = e.key

      // G / Shift+G / N, or whatever the operator remapped them to. Read at event time, so a
      // change in Settings applies to the next key press with no re-subscription.
      const action = matchCamShortcut(e, useUiPrefs.getState().camShortcutOverrides)

      // Regenerate the selected operation.
      if (action === 'computeOperationToolpath') {
        e.preventDefault()
        if (setupId && opId) s.computeOperationToolpath(setupId, opId)
        return
      }

      // Generate all toolpaths.
      if (action === 'computeAllToolpaths') {
        e.preventDefault()
        s.computeAllToolpaths()
        return
      }

      // New operation on the active setup.
      if (action === 'openModal:new-operation') {
        if (!setupId) return
        e.preventDefault()
        s.setActiveSetup(setupId)
        s.openModal('new-operation')
        return
      }

      // Delete / Backspace — delete the selected tree item, with confirm.
      if (key === 'Delete' || key === 'Backspace') {
        // Selected geometry takes priority, then active op, then active setup.
        if (selectedGeoId) {
          e.preventDefault()
          const geo = project.geometry.find(g => g.id === selectedGeoId)
          // INT-17A Stage 1: a model-backed CAM entry is a live MIRROR of a Model-
          // workbench body. Deleting the card here would not delete the body, so
          // the next regen would resurrect it - a confusing no-op. Removal happens
          // by deleting the body in the Model tab (which drives the B3 delete
          // reconciliation). Refuse loudly rather than pretend to delete.
          if (geo && geo.format === 'model') {
            s.addConsoleEvent({
              severity: 'warning',
              source: 'app',
              message: `"${geo.name}" is a modeled part. To remove it from CAM, delete the body in the Model tab.`,
            })
            return
          }
          if (!geo) return
          // WO-1268: the app's own themed dialog (the same words as the tree's
          // Remove button); destructive in practice, see WO-1283.
          void (async () => {
            const ok = await s.requestConfirm({
              title: `Delete "${geo.name}"?`,
              body: 'Its file and mesh are removed from this project. Undo brings back the entry, not the part.',
              confirmLabel: 'Delete',
              cancelLabel: 'Cancel',
              tone: 'danger',
            })
            if (!ok) return
            // Mirror DesignTree.removeGeo viewport/cache cleanup so the mesh and
            // selection clear too (the store action only touches project state).
            const vp = (window as unknown as Record<string, unknown>).__cncViewport as {
              removeSTL?: (id: string) => void
              remove2DGeometry?: (id: string) => void
              setSelectedPart?: (id: string | null) => void
            } | null
            if (geo.format === 'stl' || geo.format === 'step') vp?.removeSTL?.(geo.id)
            else vp?.remove2DGeometry?.(geo.id)
            s.removeGeometry(selectedGeoId)
            s.setSelectedGeometry(null)
            vp?.setSelectedPart?.(null)
          })()
        } else if (setupId && opId) {
          e.preventDefault()
          // WO-1268: themed, not native. This delete IS undoable (the store
          // snapshots history), so the prompt itself is the nanny case the
          // follow-up order removes; it is only moved off the native bubble here.
          void s.requestConfirm({ title: 'Delete this operation?', confirmLabel: 'Delete', cancelLabel: 'Cancel', tone: 'danger' })
            .then((ok) => { if (ok) s.removeOperation(setupId, opId) })
        } else if (setupId) {
          e.preventDefault()
          // WO-1268: themed, not native; undoable, so the follow-up order decides
          // whether this prompt survives at all.
          void s.requestConfirm({ title: 'Delete this setup and its operations?', confirmLabel: 'Delete', cancelLabel: 'Cancel', tone: 'danger' })
            .then((ok) => { if (ok) s.removeSetup(setupId) })
        }
        return
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
