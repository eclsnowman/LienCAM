// DesignTree context-menu model (Phase 7, P12 / 7.2) — headless coverage.
//
// buildTreeContextMenu is pure: per type it returns the item list with the
// right actions, danger flags, separators, and disabled-state for move
// up/down + computing regenerate. Items whose capability lacks an existing
// store action are never emitted (2D geometry has no whole-part Hide).

import { describe, it, expect } from 'vitest'
import { buildTreeContextMenu } from '../../lib/tree/treeContextMenu'

describe('op context menu', () => {
  const base = { kind: 'op' as const, setupId: 's1', opId: 'o1', status: 'ready' }

  it('offers edit / regenerate / duplicate / rename / move / delete, Edit FIRST', () => {
    const items = buildTreeContextMenu({ ...base, index: 1, count: 3 })
    expect(items.map((i) => i.action)).toEqual([
      'op-edit', 'op-regenerate', 'op-toggle-enabled', 'op-duplicate', 'op-rename',
      'op-move-up', 'op-move-down', 'op-delete',
    ])
    expect(items[0].action).toBe('op-edit')
    expect(items[0].label).toBe('Edit operation')
    expect(items.find((i) => i.action === 'op-delete')?.danger).toBe(true)
  })

  it('disables regenerate while computing', () => {
    const items = buildTreeContextMenu({ ...base, index: 0, count: 2, status: 'computing' })
    expect(items.find((i) => i.action === 'op-regenerate')?.disabled).toBe(true)
  })

  it('disables move-up on the first op and move-down on the last', () => {
    const first = buildTreeContextMenu({ ...base, index: 0, count: 3 })
    expect(first.find((i) => i.action === 'op-move-up')?.disabled).toBe(true)
    expect(first.find((i) => i.action === 'op-move-down')?.disabled).toBe(false)

    const last = buildTreeContextMenu({ ...base, index: 2, count: 3 })
    expect(last.find((i) => i.action === 'op-move-up')?.disabled).toBe(false)
    expect(last.find((i) => i.action === 'op-move-down')?.disabled).toBe(true)
  })
})

describe('setup context menu', () => {
  it('offers edit / add-op / rename / delete, Edit FIRST (delete is danger)', () => {
    const items = buildTreeContextMenu({ kind: 'setup', setupId: 's1' })
    expect(items.map((i) => i.action)).toEqual([
      'setup-edit', 'setup-add-op', 'setup-rename', 'setup-delete',
    ])
    expect(items[0].action).toBe('setup-edit')
    expect(items[0].label).toBe('Edit setup')
    expect(items.find((i) => i.action === 'setup-delete')?.danger).toBe(true)
  })
})

describe('geometry context menu', () => {
  it('offers Rename + Hide/Show + Delete for STL/STEP (canToggleVisibility)', () => {
    const visible = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
    })
    expect(visible.map((i) => i.action)).toEqual(['geo-rename', 'geo-toggle-visibility', 'geo-delete'])
    expect(visible[1].label).toBe('Hide')

    const hidden = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: true,
    })
    expect(hidden[1].label).toBe('Show')
  })

  it('OMITS Hide/Show for 2D geometry (no whole-part visibility action exists)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: false, hidden: false,
    })
    // P2: Rename precedes Delete on every geometry menu.
    expect(items.map((i) => i.action)).toEqual(['geo-rename', 'geo-delete'])
    // Delete is separated from the non-destructive items above it.
    expect(items.find((i) => i.action === 'geo-delete')?.separatorBefore).toBe(true)
  })

  // UI-EDIT-MODEL-FROM-BODY: a model-origin row (has modelItemId) gets an
  // "Edit model" item FIRST, mirroring where layer-edit-sketch sits.
  // GEO-UNIFY Stage 1 sec 1.2: "Rename model..." / "Delete model" follow it
  // immediately (model-row affordance parity for the removed Model Items
  // section's verbs); the generic Delete is OMITTED for a model row since
  // "Delete model" now owns that job.
  it('puts Edit model FIRST for a model-origin row, then Rename model.../Delete model, then the row\'s own Rename/Hide (modelItemId set)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
      modelItemId: 'm1',
    })
    expect(items.map((i) => i.action)).toEqual([
      'geo-edit-model', 'geo-rename-model', 'geo-delete-model', 'geo-rename', 'geo-toggle-visibility',
    ])
    expect(items[0].action).toBe('geo-edit-model')
    expect(items[0].label).toBe('Edit model')
    expect(items[1].label).toBe('Rename model...')
    expect(items[2].label).toBe('Delete model')
    expect(items[2].danger).toBe(true)
    expect(items.find((i) => i.action === 'geo-rename')?.separatorBefore).toBe(true)
    expect(items.find((i) => i.action === 'geo-delete')).toBeUndefined()
  })

  it('OMITS Edit model for a non-model-origin row (no modelItemId)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
    })
    expect(items.find((i) => i.action === 'geo-edit-model')).toBeUndefined()
    expect(items.map((i) => i.action)).toEqual(['geo-rename', 'geo-toggle-visibility', 'geo-delete'])
  })

  // GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stages 1+4: a wrappable imported STEP
  // part OR STL mesh row gets "Edit as model" FIRST (the geo-edit-model slot,
  // mutually exclusive by format), then a separator before Rename/Hide/Delete.
  it('puts Edit as model FIRST for a wrappable row (wrappable set), before Rename/Hide/Delete', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
      wrappable: true,
    })
    expect(items[0].action).toBe('geo-edit-as-model')
    expect(items.map((i) => i.action)).toEqual([
      'geo-edit-as-model', 'geo-rename', 'geo-toggle-visibility', 'geo-delete',
    ])
    expect(items.find((i) => i.action === 'geo-rename')?.separatorBefore).toBe(true)
    // A wrappable STEP row is still deletable from CAM (unlike a model row).
    expect(items.find((i) => i.action === 'geo-delete')).toBeDefined()
    // Never both wrap AND edit-model (mutually exclusive by format).
    expect(items.find((i) => i.action === 'geo-edit-model')).toBeUndefined()
  })

  it('OMITS Edit as model for an ordinary non-wrappable row (wrappable falsy)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: false, hidden: false,
    })
    expect(items.find((i) => i.action === 'geo-edit-as-model')).toBeUndefined()
  })

  it('a MODEL row never shows Edit as model (model-origin wins; wrappable ignored)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
      modelItemId: 'm1', wrappable: true,
    })
    expect(items[0].action).toBe('geo-edit-model')
    expect(items.find((i) => i.action === 'geo-edit-as-model')).toBeUndefined()
  })

  // IMPORT-MULTIBODY-CHOICE (Operator Q-76): re-choose item on a combined multi-body row.
  it('shows Choose body split... after Edit as model for a multi-body STEP row (multiBodySplit set)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
      wrappable: true, multiBodySplit: true,
    })
    expect(items[0].action).toBe('geo-edit-as-model')
    expect(items[1].action).toBe('geo-choose-multibody-split')
    expect(items[1].label).toBe('Choose body split...')
  })

  it('OMITS Choose body split... for a single-body row (multiBodySplit falsy)', () => {
    const items = buildTreeContextMenu({
      kind: 'geometry', geoId: 'g1', canToggleVisibility: true, hidden: false,
      wrappable: true,
    })
    expect(items.find((i) => i.action === 'geo-choose-multibody-split')).toBeUndefined()
  })
})

describe('layer context menu (P13)', () => {
  const base = {
    kind: 'layer' as const, geoId: 'g1', layerId: 'lyr1',
    canRename: true, locked: false, visible: true,
  }

  it('puts Edit sketch FIRST, then Convert to model, then Rename/Hide/Lock/Delete for a sketch-editable layer', () => {
    const items = buildTreeContextMenu({ ...base, sketchEditable: true })
    expect(items.map((i) => i.action)).toEqual([
      'layer-edit-sketch', 'layer-convert-to-model', 'layer-rename',
      'layer-toggle-visibility', 'layer-toggle-lock', 'layer-delete',
    ])
    // The P13 requirement: Edit sketch is literally the first item.
    expect(items[0].action).toBe('layer-edit-sketch')
    expect(items.find((i) => i.action === 'layer-delete')?.danger).toBe(true)
    expect(items.find((i) => i.action === 'layer-delete')?.separatorBefore).toBe(true)
  })

  it('GEO-UNIFY Stage 3: Convert to model sits DIRECTLY below Edit sketch, with the D2 label', () => {
    const items = buildTreeContextMenu({ ...base, sketchEditable: true })
    const editIdx = items.findIndex((i) => i.action === 'layer-edit-sketch')
    expect(items[editIdx + 1].action).toBe('layer-convert-to-model')
    expect(items[editIdx + 1].label).toBe('Convert to model...')
  })

  it('OMITS Edit sketch AND Convert to model for a non-sketch-editable layer (locked / projection / STL)', () => {
    const items = buildTreeContextMenu({ ...base, sketchEditable: false })
    expect(items.map((i) => i.action)).toEqual([
      'layer-rename', 'layer-toggle-visibility', 'layer-toggle-lock', 'layer-delete',
    ])
    expect(items.find((i) => i.action === 'layer-edit-sketch')).toBeUndefined()
    expect(items.find((i) => i.action === 'layer-convert-to-model')).toBeUndefined()
  })

  it('OMITS Rename for a seed layer row (canRename: false); Edit sketch + Convert to model stay first', () => {
    const items = buildTreeContextMenu({ ...base, sketchEditable: true, canRename: false })
    expect(items.map((i) => i.action)).toEqual([
      'layer-edit-sketch', 'layer-convert-to-model',
      'layer-toggle-visibility', 'layer-toggle-lock', 'layer-delete',
    ])
    expect(items[0].action).toBe('layer-edit-sketch')
  })

  it('labels Hide/Show and Lock/Unlock from the layer state', () => {
    const shown = buildTreeContextMenu({ ...base, sketchEditable: true, visible: true, locked: false })
    expect(shown.find((i) => i.action === 'layer-toggle-visibility')?.label).toBe('Hide')
    expect(shown.find((i) => i.action === 'layer-toggle-lock')?.label).toBe('Lock')

    const hiddenLocked = buildTreeContextMenu({ ...base, sketchEditable: false, visible: false, locked: true })
    expect(hiddenLocked.find((i) => i.action === 'layer-toggle-visibility')?.label).toBe('Show')
    expect(hiddenLocked.find((i) => i.action === 'layer-toggle-lock')?.label).toBe('Unlock')
  })
})

// NAV-PARITY-SMALLS gap 4: the Model Items tree-section rows had no context
// menu at all before this. Edit / Rename / Delete mirror the row's own
// always-on affordances (click-to-open, rename icon, delete icon).
describe('model-item context menu (NAV-PARITY-SMALLS)', () => {
  it('offers Edit (FIRST) / Rename / Delete, delete is danger + separated', () => {
    const items = buildTreeContextMenu({ kind: 'model-item', modelItemId: 'mi1' })
    expect(items.map((i) => i.action)).toEqual([
      'model-item-edit', 'model-item-rename', 'model-item-delete',
    ])
    expect(items[0].action).toBe('model-item-edit')
    expect(items[0].label).toBe('Edit model')
    const del = items.find((i) => i.action === 'model-item-delete')
    expect(del?.danger).toBe(true)
    expect(del?.separatorBefore).toBe(true)
  })
})

// NAV-MENUS: PP-SELECTION-UTILITY.recon.md Matrix 2 flagged five row types
// with NO context menu at all (no TreeContextKind existed): Fixed stock, Auto
// stock, Geometry folder, Operation folder, Nest. Every item below mirrors an
// EXISTING row-button handler — no new business logic.

describe('stock-fixed context menu (NAV-MENUS)', () => {
  it('offers gizmo toggle / Rename / Delete, delete is danger + separated', () => {
    const items = buildTreeContextMenu({ kind: 'stock-fixed', stockId: 's1', gizmoActive: false })
    expect(items.map((i) => i.action)).toEqual([
      'stock-fixed-toggle-gizmo', 'stock-fixed-rename', 'stock-fixed-delete',
    ])
    expect(items[0].label).toBe('Move with gizmo')
    const del = items.find((i) => i.action === 'stock-fixed-delete')
    expect(del?.danger).toBe(true)
    expect(del?.separatorBefore).toBe(true)
  })

  it('labels the gizmo item from gizmoActive', () => {
    const active = buildTreeContextMenu({ kind: 'stock-fixed', stockId: 's1', gizmoActive: true })
    expect(active[0].label).toBe('Exit gizmo')
  })
})

describe('stock-auto context menu (NAV-MENUS)', () => {
  it('offers Rename / Delete only (no gizmo — member-derived box)', () => {
    const items = buildTreeContextMenu({ kind: 'stock-auto', stockId: 'a1' })
    expect(items.map((i) => i.action)).toEqual(['stock-auto-rename', 'stock-auto-delete'])
    const del = items.find((i) => i.action === 'stock-auto-delete')
    expect(del?.danger).toBe(true)
    expect(del?.separatorBefore).toBe(true)
  })
})

describe('geometry folder context menu (NAV-MENUS)', () => {
  it('offers Rename / Delete, mirroring the row\'s only two icon buttons', () => {
    const items = buildTreeContextMenu({ kind: 'folder', folderId: 'f1' })
    expect(items.map((i) => i.action)).toEqual(['folder-rename', 'folder-delete'])
    const del = items.find((i) => i.action === 'folder-delete')
    expect(del?.danger).toBe(true)
    expect(del?.separatorBefore).toBe(true)
  })
})

describe('operation folder context menu (NAV-MENUS)', () => {
  it('offers Rename / enable-all-or-suppress-all / Delete', () => {
    const items = buildTreeContextMenu({
      kind: 'op-folder', setupId: 's1', folderId: 'f1', enableState: 'suppressed', hasOperations: true,
    })
    expect(items.map((i) => i.action)).toEqual([
      'op-folder-rename', 'op-folder-toggle-enabled', 'op-folder-delete',
    ])
    expect(items.find((i) => i.action === 'op-folder-toggle-enabled')?.label).toBe('Enable all')
    const del = items.find((i) => i.action === 'op-folder-delete')
    expect(del?.danger).toBe(true)
    expect(del?.separatorBefore).toBe(true)
  })

  it('labels the toggle Suppress all when the folder is fully enabled', () => {
    const items = buildTreeContextMenu({
      kind: 'op-folder', setupId: 's1', folderId: 'f1', enableState: 'enabled', hasOperations: true,
    })
    expect(items.find((i) => i.action === 'op-folder-toggle-enabled')?.label).toBe('Suppress all')
  })

  it('labels the toggle Enable all for a mixed folder', () => {
    const items = buildTreeContextMenu({
      kind: 'op-folder', setupId: 's1', folderId: 'f1', enableState: 'mixed', hasOperations: true,
    })
    expect(items.find((i) => i.action === 'op-folder-toggle-enabled')?.label).toBe('Enable all')
  })

  it('disables the toggle when the folder has no operations, mirroring the row\'s own guard', () => {
    const items = buildTreeContextMenu({
      kind: 'op-folder', setupId: 's1', folderId: 'f1', enableState: 'suppressed', hasOperations: false,
    })
    expect(items.find((i) => i.action === 'op-folder-toggle-enabled')?.disabled).toBe(true)
  })
})

describe('nest context menu (NAV-MENUS)', () => {
  it('offers Edit nest FIRST, then Rename / Hide-Show / Explode / Delete (no Recompute when not stale)', () => {
    const items = buildTreeContextMenu({ kind: 'nest', nestId: 'n1', visible: true, stale: false })
    expect(items.map((i) => i.action)).toEqual([
      'nest-edit', 'nest-rename', 'nest-toggle-visibility', 'nest-explode', 'nest-delete',
    ])
    expect(items[0].label).toBe('Edit nest')
    expect(items.find((i) => i.action === 'nest-toggle-visibility')?.label).toBe('Hide')
    const del = items.find((i) => i.action === 'nest-delete')
    expect(del?.danger).toBe(true)
    expect(del?.separatorBefore).toBe(true)
  })

  it('includes Recompute only when the nest is stale (mirrors the row\'s conditional RefreshCw button)', () => {
    const items = buildTreeContextMenu({ kind: 'nest', nestId: 'n1', visible: false, stale: true })
    expect(items.map((i) => i.action)).toEqual([
      'nest-edit', 'nest-rename', 'nest-toggle-visibility', 'nest-recompute', 'nest-explode', 'nest-delete',
    ])
    expect(items.find((i) => i.action === 'nest-toggle-visibility')?.label).toBe('Show')
  })
})
