// WO-3257: the CAM shortcut registry, pure. The defaults, how a key press is matched, the
// conflict rule, how a stored blob is read, and the printable text.

import { describe, it, expect } from 'vitest'
import {
  CAM_SHORTCUT_IDS,
  camBindingLabel,
  camShortcutMapText,
  chordFromKeyEvent,
  editCamShortcut,
  effectiveCamBindings,
  matchCamShortcut,
  readCamShortcutOverrides,
  restoreAllCamShortcuts,
  type CamShortcutKeyEvent,
  type CamShortcutOverrides,
} from '../../lib/shortcuts/camShortcutRegistry'

const press = (key: string, extra: Partial<CamShortcutKeyEvent> = {}): CamShortcutKeyEvent => ({
  key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra,
})

const rForSelected: CamShortcutOverrides = {
  version: 1,
  bindings: { computeOperationToolpath: { key: 'r', shift: false } },
}

describe('camShortcutRegistry defaults', () => {
  it('names three stable actions', () => {
    expect([...CAM_SHORTCUT_IDS]).toEqual(['computeOperationToolpath', 'computeAllToolpaths', 'openModal:new-operation'])
  })

  it('maps G, Shift+G and N with no stored overrides', () => {
    expect(matchCamShortcut(press('g'), null)).toBe('computeOperationToolpath')
    expect(matchCamShortcut(press('G', { shiftKey: true }), null)).toBe('computeAllToolpaths')
    expect(matchCamShortcut(press('n'), null)).toBe('openModal:new-operation')
  })

  it('treats Caps Lock G (capital letter, no Shift) as the selected-operation compute', () => {
    expect(matchCamShortcut(press('G'), null)).toBe('computeOperationToolpath')
  })

  it('does nothing for Shift+N', () => {
    expect(matchCamShortcut(press('N', { shiftKey: true }), null)).toBeNull()
  })

  it('labels the defaults', () => {
    const eff = effectiveCamBindings(null)
    expect(camBindingLabel(eff.computeOperationToolpath)).toBe('G')
    expect(camBindingLabel(eff.computeAllToolpaths)).toBe('Shift+G')
    expect(camBindingLabel(eff['openModal:new-operation'])).toBe('N')
    expect(camBindingLabel(null)).toBeNull()
  })
})

describe('camShortcutRegistry matching', () => {
  it('matches the key the press produces, not the physical code', () => {
    expect(matchCamShortcut(press('r'), rForSelected)).toBe('computeOperationToolpath')
    // A layout that puts R on the physical Q position still produces key 'r'; the
    // physical code is not even looked at, and key 'q' does not match an R binding.
    expect(matchCamShortcut({ ...press('r'), code: 'KeyQ' } as CamShortcutKeyEvent, rForSelected)).toBe('computeOperationToolpath')
    expect(matchCamShortcut({ ...press('q'), code: 'KeyR' } as CamShortcutKeyEvent, rForSelected)).toBeNull()
  })

  it('frees the old letter once a row is remapped', () => {
    expect(matchCamShortcut(press('g'), rForSelected)).toBeNull()
    expect(matchCamShortcut(press('G', { shiftKey: true }), rForSelected)).toBe('computeAllToolpaths')
  })

  it('never fires with Ctrl, Cmd, Alt or AltGraph held', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(matchCamShortcut(press('g', mod), null)).toBeNull()
    }
    const altGr = { ...press('g'), getModifierState: (name: string) => name === 'AltGraph' }
    expect(matchCamShortcut(altGr, null)).toBeNull()
  })

  it('ignores keys that are not one plain letter', () => {
    for (const key of ['Shift', 'Delete', 'Backspace', '1', 'Enter', 'Dead', 'ж']) {
      expect(chordFromKeyEvent(press(key))).toBeNull()
    }
  })

  it('leaves an unassigned row without a key', () => {
    const cleared: CamShortcutOverrides = { version: 1, bindings: { 'openModal:new-operation': null } }
    expect(matchCamShortcut(press('n'), cleared)).toBeNull()
    expect(matchCamShortcut(press('g'), cleared)).toBe('computeOperationToolpath')
  })
})

describe('camShortcutRegistry conflicts', () => {
  it('refuses a chord another row has and names that row', () => {
    const first = editCamShortcut(null, 'computeOperationToolpath', { key: 'r', shift: false })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = editCamShortcut(first.overrides, 'computeAllToolpaths', { key: 'r', shift: false })
    expect(second).toEqual({ ok: false, conflictWith: 'computeOperationToolpath' })
  })

  it('counts an inherited default as taken', () => {
    expect(editCamShortcut(null, 'openModal:new-operation', { key: 'g', shift: true }))
      .toEqual({ ok: false, conflictWith: 'computeAllToolpaths' })
    expect(editCamShortcut(null, 'openModal:new-operation', { key: 'g', shift: false }))
      .toEqual({ ok: false, conflictWith: 'computeOperationToolpath' })
  })

  it('lets a row keep its own chord and lets Shift tell two rows apart', () => {
    expect(editCamShortcut(null, 'computeOperationToolpath', { key: 'g', shift: false }).ok).toBe(true)
    expect(editCamShortcut(null, 'openModal:new-operation', { key: 'n', shift: true }).ok).toBe(true)
  })

  it('refuses to restore a row into a chord another row has since taken, naming that row', () => {
    const moved = editCamShortcut(null, 'computeOperationToolpath', { key: 'r', shift: false })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    const taken = editCamShortcut(moved.overrides, 'computeAllToolpaths', { key: 'g', shift: false })
    expect(taken.ok).toBe(true)
    if (!taken.ok) return
    expect(editCamShortcut(taken.overrides, 'computeOperationToolpath', 'default'))
      .toEqual({ ok: false, conflictWith: 'computeAllToolpaths' })
    // The map in force is unchanged by the refused restore.
    expect(matchCamShortcut(press('r'), taken.overrides)).toBe('computeOperationToolpath')
    expect(matchCamShortcut(press('g'), taken.overrides)).toBe('computeAllToolpaths')
  })

  it('frees a chord when its row is cleared or restored', () => {
    const cleared = editCamShortcut(null, 'computeAllToolpaths', null)
    expect(cleared.ok && editCamShortcut(cleared.overrides, 'openModal:new-operation', { key: 'g', shift: true }).ok).toBe(true)
  })
})

describe('camShortcutRegistry stored blob', () => {
  it('reads a well formed blob and normalises it', () => {
    expect(readCamShortcutOverrides(rForSelected)).toEqual(rForSelected)
    expect(effectiveCamBindings(rForSelected).computeOperationToolpath).toEqual({ key: 'r', shift: false })
    expect(effectiveCamBindings(rForSelected).computeAllToolpaths).toEqual({ key: 'g', shift: true })
  })

  it('falls back to every default for malformed or duplicate data', () => {
    const bad: unknown[] = [
      'text', 7, [], { version: 2, bindings: {} }, { version: 1 }, { version: 1, bindings: [] },
      { version: 1, bindings: { computeOperationToolpath: { key: 'rr', shift: false } } },
      { version: 1, bindings: { computeOperationToolpath: { key: 'r' } } },
      { version: 1, bindings: { unknownAction: null } },
      { version: 1, bindings: { computeOperationToolpath: { key: 'q', shift: false }, computeAllToolpaths: { key: 'q', shift: false } } },
      { version: 1, bindings: { computeOperationToolpath: { key: 'g', shift: true } } },
    ]
    for (const raw of bad) {
      expect(readCamShortcutOverrides(raw)).toBeNull()
      expect(matchCamShortcut(press('g'), raw)).toBe('computeOperationToolpath')
      expect(matchCamShortcut(press('G', { shiftKey: true }), raw)).toBe('computeAllToolpaths')
    }
  })

  it('a deliberate edit replaces a malformed blob with a fresh valid one', () => {
    const edit = editCamShortcut({ version: 9 }, 'computeOperationToolpath', { key: 'r', shift: false })
    expect(edit.ok && edit.overrides).toEqual(rForSelected)
  })

  it('restores one row or all rows', () => {
    const edit = editCamShortcut(rForSelected, 'computeOperationToolpath', 'default')
    expect(edit.ok && edit.overrides).toEqual({ version: 1, bindings: {} })
    expect(restoreAllCamShortcuts()).toEqual({ version: 1, bindings: {} })
  })
})

describe('camShortcutRegistry printable text', () => {
  const words = {
    title: 'LienCAM CAM shortcuts',
    scope: 'Scope: CAM, outside Sketch',
    unassigned: 'Unassigned',
    actions: {
      computeOperationToolpath: 'Generate selected operation',
      computeAllToolpaths: 'Generate all toolpaths',
      'openModal:new-operation': 'New operation',
    },
  }

  it('prints the defaults', () => {
    expect(camShortcutMapText(null, words)).toBe([
      'LienCAM CAM shortcuts', 'Scope: CAM, outside Sketch', '',
      'Generate selected operation: G', 'Generate all toolpaths: Shift+G', 'New operation: N', '',
    ].join('\n'))
  })

  it('prints a remapped and an unassigned row', () => {
    const raw: CamShortcutOverrides = { version: 1, bindings: { computeOperationToolpath: { key: 'r', shift: false }, 'openModal:new-operation': null } }
    const text = camShortcutMapText(raw, words)
    expect(text).toContain('Generate selected operation: R')
    expect(text).toContain('New operation: Unassigned')
    expect(text).toContain('Generate all toolpaths: Shift+G')
  })
})
