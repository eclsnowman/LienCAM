// WO INT-13C, AC3 + AC7 (the pure half) -- the D5.3 dispatch rules that are decidable
// without a DOM.
//
// The two predicates below are where the routing DECISIONS live, extracted deliberately so
// they are testable headless (the same shape, and the same reason, as useGlobalShortcuts'
// existing `shortcutsAllowed`). The DOM half of AC3/AC4 -- which owner actually fires a real
// keystroke when three real listeners contend on window -- is in keyboardInterleave.int13c
// and the two mirrorDefect files; this file pins the rules those tests exercise.

import { describe, it, expect } from 'vitest'
import {
  resolveActiveWorkspaceHistory,
  type WorkspaceHistoryFacade,
} from '../../lib/workspace/activeWorkspaceHistory'
import { shortcutsAllowed, type ShortcutGuardState } from '../../hooks/useGlobalShortcuts'

const camHistory: WorkspaceHistoryFacade = { undo: () => {}, redo: () => {}, canUndo: true, canRedo: false }
const partHistory: WorkspaceHistoryFacade = { undo: () => {}, redo: () => {}, canUndo: false, canRedo: true }

describe('D5.4 - resolveActiveWorkspaceHistory: the buttons follow the ACTIVE workspace', () => {
  it('resolves to CAM project history while the CAM workspace is active', () => {
    expect(resolveActiveWorkspaceHistory('cam', camHistory, partHistory)).toBe(camHistory)
  })

  it('resolves to the PART workspace history while the Model workspace is active', () => {
    // The whole of D5.4 in one line: with the Part workspace active the Undo BUTTON must reach
    // the workbench's CommandHistory, or it and Ctrl+Z become two paths to one value doing
    // different things.
    expect(resolveActiveWorkspaceHistory('part', camHistory, partHistory)).toBe(partHistory)
  })

  it('resolves to CAM even when a Part history is published, as long as CAM is active', () => {
    // The Part host publishes while it is active and releases on suspend, but the resolver must
    // not DEPEND on that release being instantaneous: workspace is the authority, not "is
    // something published?".
    expect(resolveActiveWorkspaceHistory('cam', camHistory, partHistory)).toBe(camHistory)
  })

  it('REFUSES (null) when the Model workspace is active but its host has published nothing', () => {
    // The real window this covers: the Part host mounts LAZILY (App.tsx:281), so between the tab
    // click and that host's first effect the Part workspace is active with no history owner.
    // Falling back to CAM here would fire a CAM project undo from a button in the Model
    // workspace -- face (a) of the mirror defect, arriving through the buttons instead of the
    // keyboard. Refuse by name; the caller disables the buttons. This is the unnamed `else`
    // charter rule 2 is about.
    expect(resolveActiveWorkspaceHistory('part', camHistory, null)).toBeNull()
  })

  it('never returns CAM history for a non-cam workspace, for any published part value', () => {
    // Closed domain: Workspace is exactly 'cam' | 'part' (types/index.ts:1072), so these two
    // rows ARE the table. Enumerated rather than hand-picked.
    for (const part of [partHistory, null]) {
      expect(resolveActiveWorkspaceHistory('part', camHistory, part)).not.toBe(camHistory)
    }
  })
})

describe('P2 - shortcutsAllowed: CAM globals are cam-only', () => {
  const ok: ShortcutGuardState = {
    workspace: 'cam', activeModal: null, mode: 'setup', focusedTag: '', isContentEditable: false,
  }

  it('allows CAM shortcuts at rest in the CAM workspace', () => {
    expect(shortcutsAllowed(ok)).toBe(true)
  })

  it('REFUSES every CAM shortcut while the Model workspace is active', () => {
    // The live defect this closes: N is claimed by BOTH this hook (new CAM operation) and the
    // workbench's N-pick as unconditional bare-N bubble listeners, so before the guard, N in the
    // Model workspace armed the pick AND opened a CAM modal over it.
    expect(shortcutsAllowed({ ...ok, workspace: 'part' })).toBe(false)
  })

  it('refuses in the Model workspace even when every OTHER guard is satisfied', () => {
    // The workspace guard must not be reachable-only-by-accident behind the older guards: with
    // no modal, no sketch mode and nothing focused, workspace is the ONLY thing standing between
    // a bare G in the Model workspace and a CAM toolpath regenerate.
    expect(shortcutsAllowed({
      workspace: 'part', activeModal: null, mode: 'setup', focusedTag: '', isContentEditable: false,
    })).toBe(false)
  })

  it("the pre-existing sketch guard cannot substitute for it: CAM's viewer.mode never sees a Part sketch", () => {
    // Why the workspace guard is NOT redundant with `mode === 'sketch'`. A sketch open in the
    // MODEL workspace leaves CAM's viewer.mode wherever it was -- 'setup' here -- so the old
    // guard reads "no sketch is open" and would let `g` regenerate a CAM toolpath while the
    // sketcher arms its text tool on the same keystroke.
    expect(shortcutsAllowed({ ...ok, workspace: 'part', mode: 'setup' })).toBe(false)
  })
})
