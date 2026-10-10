// Global CAM shortcut guard (Phase 7, P12 / 7.3) — headless coverage.
//
// shortcutsAllowed is the single predicate that decides whether G / Shift+G /
// N / Delete may fire. It must REFUSE while a modal is open, while sketch mode
// is active, and while any text-entry element is focused — so typing in a feed
// field never triggers a regenerate or a delete.

import { describe, it, expect } from 'vitest'
import { shortcutsAllowed, type ShortcutGuardState } from '../../hooks/useGlobalShortcuts'

// WO INT-13C (P2): `workspace` joined ShortcutGuardState when these shortcuts became
// cam-only. This fixture gains the field and nothing else -- every assertion below already
// meant "in the CAM workspace" (it was the only workspace that existed when they were
// written), so naming it preserves their original coverage exactly rather than relaxing it.
// The new refusal branch (workspace !== 'cam') is asserted by the INT-13C dispatch-table
// test, src/tests/workspace/dispatchTable.int13c.test.ts.
const ok: ShortcutGuardState = {
  workspace: 'cam', activeModal: null, mode: 'setup', focusedTag: '', isContentEditable: false,
}

describe('shortcutsAllowed', () => {
  it('allows shortcuts at rest in a CAM mode with nothing focused', () => {
    expect(shortcutsAllowed(ok)).toBe(true)
    expect(shortcutsAllowed({ ...ok, focusedTag: 'button' })).toBe(true)
    expect(shortcutsAllowed({ ...ok, focusedTag: 'div' })).toBe(true)
  })

  it('blocks while typing in an input / textarea / select', () => {
    expect(shortcutsAllowed({ ...ok, focusedTag: 'input' })).toBe(false)
    expect(shortcutsAllowed({ ...ok, focusedTag: 'textarea' })).toBe(false)
    expect(shortcutsAllowed({ ...ok, focusedTag: 'select' })).toBe(false)
  })

  it('blocks while a contenteditable element is focused', () => {
    expect(shortcutsAllowed({ ...ok, isContentEditable: true })).toBe(false)
  })

  it('blocks while a modal is open', () => {
    expect(shortcutsAllowed({ ...ok, activeModal: 'new-operation' })).toBe(false)
  })

  it('blocks in sketch mode (sketch owns its own single-key tools)', () => {
    expect(shortcutsAllowed({ ...ok, mode: 'sketch' })).toBe(false)
  })
})
