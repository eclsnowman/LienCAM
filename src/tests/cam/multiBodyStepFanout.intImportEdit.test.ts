// INT-IMPORT-EDIT stage 3 (multi-body STEP): the pure ADAPTER fanout. A wrapped
// multi-body STEP row (ONE pending row) plus N live bodies from the item's single
// regen must reconcile to: the wrapped row ADOPTED in place as solid 1 (id + op
// bindings preserved), and solids 2..N APPENDED as new model rows -- so every
// solid surfaces as its own editable CAM geometry row from one workspace open,
// with exactly one adoption and no duplicate of the wrapped row.

import { describe, it, expect } from 'vitest'
import {
  reconcileModelBodies,
  type DerivedModelBody,
  type LiveModelBody,
} from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry, ModelBodyDisplay } from '../../types'

function display(tag = 0): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}
function derived(bodyId: string, version = 1, tag = 0): DerivedModelBody {
  return { bodyId, version, stableIds: [`${bodyId}:F0`, `${bodyId}:E0`], display: display(tag) }
}
function live(bodyId: string, name: string): LiveModelBody {
  return { bodyId, name }
}

/** The single wrapped multi-body STEP CAM row: format:'step', pending for item-A,
 *  carrying id + folder/stock so we can prove those survive adoption. */
function pendingMultiBodyRow(): ImportedGeometry {
  return {
    id: 'geo-asm', name: 'Assembly', filename: 'assembly.step', type: 'brep', format: 'step',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 }, size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 } },
    position: { x: 4, y: 4, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    color: '#abcdef', folderId: 'fold-1', stockId: 'stock-1', stockIdLocked: true,
    pendingModelItemId: 'item-A',
  }
}

describe('INT-IMPORT-EDIT stage 3: reconcileModelBodies multi-body fanout', () => {
  it('adopts the wrapped row as solid 1 and appends solids 2..N as new rows (one adoption, no dup)', () => {
    const r = reconcileModelBodies([pendingMultiBodyRow()], {
      live: [live('b0', 'Assembly'), live('b1', 'Assembly (2)'), live('b2', 'Assembly (3)')],
      derived: [derived('b0', 1, 0), derived('b1', 1, 1), derived('b2', 1, 2)],
      modelItemId: 'item-A',
    })

    // Exactly one row adopted (the wrapped step row), two genuinely new rows.
    expect(r.adopted).toEqual(['geo-asm'])
    expect(r.added).toEqual(['b0', 'b1', 'b2'])
    expect(r.geometry).toHaveLength(3)

    // Solid 1 rode the wrapped row: id preserved (op params/stock/folder stay
    // bound), format flipped, pose reset to identity, pending cleared.
    const first = r.geometry.find((g) => g.modelBody?.ref.bodyId === 'b0')!
    expect(first.id).toBe('geo-asm')
    expect(first.format).toBe('model')
    expect(first.folderId).toBe('fold-1')
    expect(first.stockId).toBe('stock-1')
    expect(first.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(first.pendingModelItemId).toBeUndefined()

    // Solids 2..N are fresh scoped rows (their own derived ids, no wrapped id).
    const second = r.geometry.find((g) => g.modelBody?.ref.bodyId === 'b1')!
    const third = r.geometry.find((g) => g.modelBody?.ref.bodyId === 'b2')!
    expect(second.id).toBe('modelbody:item-A:b1')
    expect(third.id).toBe('modelbody:item-A:b2')
    expect(second.format).toBe('model')
    expect(third.format).toBe('model')
    // No row still carries the pending marker or the raw step format.
    expect(r.geometry.some((g) => g.format === 'step')).toBe(false)
    expect(r.geometry.filter((g) => g.id === 'geo-asm')).toHaveLength(1)
  })

  it('only the FIRST live body claims the single pending row; the rest never adopt', () => {
    // Even if the derived order is shuffled, exactly one pending row exists so
    // exactly one adoption happens; whichever body pass-2 reaches first claims it.
    const r = reconcileModelBodies([pendingMultiBodyRow()], {
      live: [live('b0', 'A'), live('b1', 'B')],
      derived: [derived('b1', 1, 1), derived('b0', 1, 0)],
      modelItemId: 'item-A',
    })
    expect(r.adopted).toHaveLength(1)
    expect(r.adopted[0]).toBe('geo-asm')
    expect(r.geometry.filter((g) => g.format === 'model')).toHaveLength(2)
  })

  it('a second regen updates all fanned-out rows in place (no re-adoption, ids stable)', () => {
    const first = reconcileModelBodies([pendingMultiBodyRow()], {
      live: [live('b0', 'A'), live('b1', 'B')],
      derived: [derived('b0', 1, 0), derived('b1', 1, 1)],
      modelItemId: 'item-A',
    })
    const idsBefore = first.geometry.map((g) => g.id).sort()
    const second = reconcileModelBodies(first.geometry, {
      live: [live('b0', 'A'), live('b1', 'B')],
      derived: [derived('b0', 2, 0), derived('b1', 2, 1)],
      modelItemId: 'item-A',
    })
    expect(second.adopted).toEqual([])
    expect(second.updated.sort()).toEqual(['b0', 'b1'])
    expect(second.geometry.map((g) => g.id).sort()).toEqual(idsBefore)
    expect(second.geometry.every((g) => g.modelBody?.ref.version === 2)).toBe(true)
  })
})
