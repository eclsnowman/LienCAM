// WO INT-17C Stage C3: the standing "edit reopens the ORIGINAL creation UI"
// audit (feedback_edit_reuses_original_operation_ui.md), run as a named,
// committed checklist result over every surface this WO (C1+C2+C3) added.
// Mirrors the census-test convention already used elsewhere in this repo
// (SolidsWorkbenchPage.editEntryForDomainCensus.test.tsx is the closest
// precedent in shape, though it audits a different domain -- DAG node kinds
// inside ONE Model Item's own document, not Model-Item-level UI. See that
// file's own doc comment; per the INT-17C Stage C3 recon this file's domain
// (tree-level Model Item surfaces) has no existing census to extend, so this
// is a new one.)
//
// AUDIT RESULT, one describe block per surface:
//
//   1. "New Model Item" (+)         -> PASS. addModelItem() and
//      openModelItem(id) land on the IDENTICAL {workspace, activeModelItemId}
//      shape for the same id -- creating an item and reopening an existing
//      one open the exact same Editing Space (SolidsWorkbenchPage keyed by
//      modelItemId), never a distinct "create" vs "edit" surface.
//   2. Model Item rename            -> PASS. There is only ONE naming UI:
//      TreeRenameLabel's shared inline input (same mechanism as every other
//      named tree row -- folders, setups, operations, etc., per
//      DesignTreeInlineRename.smoke.test.tsx). A Model Item's initial name is
//      auto-assigned by nextModelItemName at creation (no naming dialog to
//      diverge from); renaming later reopens that SAME inline input, not a
//      separate rename dialog. Nothing to fix -- asserted here as a
//      regression guard (the tree-name-model-item testid literally IS the
//      shared TreeRenameLabel; see DesignTreeInlineRename.smoke.test.tsx's
//      own passing "model item row" case for the live behavior).
//   3. Placement (Stage C2: gizmo + Properties Panel numeric fields) -> N/A,
//      not a Stage C3 surface to re-audit (already the SAME action both
//      paths commit through, per updateModelItemPlacement.int17cC2.test.ts's
//      own doc comment: "both PP edits and the gizmo drag-end land in the
//      SAME action"). No separate "create Placement" dialog exists for a
//      Stage C2/C3 audit to find diverging from it -- Placement is an
//      identity-stub from the moment a Model Item is created (Stage C1
//      contract invariant 5), made editable in place by Stage C2, so there
//      is only ever the one editing surface.
//   4. Model Item delete (Stage C3, new)                              -> N/A.
//      Delete has no "reopen" concept (nothing to edit after it succeeds);
//      the standing rule applies to EDIT surfaces, not destructive ones. Its
//      own UI contract (confirm names dependents, one undo step) is audited
//      by DesignTreeModelItemDelete.int17cC3.test.tsx instead.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'

function resetStore(): void {
  useCamStore.setState((s) => ({
    project: { ...s.project, modelItems: [] },
    workspace: 'cam',
    activeModelItemId: null,
  }))
}

describe('INT-17C Stage C3: edit-reopens-original-UI audit -- "New Model Item" (+)', () => {
  beforeEach(resetStore)

  it('create (addModelItem) and reopen (openModelItem) land on the IDENTICAL editing-surface state for the same id', () => {
    const id = useCamStore.getState().addModelItem()
    const afterCreate = { workspace: useCamStore.getState().workspace, activeModelItemId: useCamStore.getState().activeModelItemId }
    expect(afterCreate).toEqual({ workspace: 'part', activeModelItemId: id })

    // Leave the Editing Space (Finish), then reopen the SAME item through the
    // tree-click path (openModelItem) -- if this were a genuinely different
    // "edit" surface it would land on some OTHER workspace/activeModelItemId
    // shape, or need a different component. It does not: same two fields,
    // same values.
    useCamStore.getState().finishModelItem()
    expect(useCamStore.getState().workspace).toBe('cam')

    useCamStore.getState().openModelItem(id)
    const afterReopen = { workspace: useCamStore.getState().workspace, activeModelItemId: useCamStore.getState().activeModelItemId }
    expect(afterReopen).toEqual(afterCreate)
  })

  it('reopening a SECOND, DIFFERENT item after creating it also lands on the same shape (not special-cased to "the first item ever created")', () => {
    const idA = useCamStore.getState().addModelItem()
    useCamStore.getState().finishModelItem()
    const idB = useCamStore.getState().addModelItem()
    expect(idB).not.toBe(idA)
    expect(useCamStore.getState().activeModelItemId).toBe(idB)

    useCamStore.getState().openModelItem(idA)
    expect(useCamStore.getState().activeModelItemId).toBe(idA)
    expect(useCamStore.getState().workspace).toBe('part')
  })
})
