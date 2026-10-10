// WO INT-17C Stage C1 CLOSURE, gap 2: `reconcileModelBodies`/`modelBodyEntryId`
// item-scoping (INT-17C-C1-PREFLIGHT.md census 1b's flagged risk, closed).
//
// Sibling of src/tests/cam/int17aModelBodyAdapter.test.ts (left UNMODIFIED by
// this closure -- every assertion there is a single-implicit-legacy-item call,
// and this file's own "legacy stays byte-identical" tests below re-prove the
// SAME invariants explicitly, with `modelItemId` now a real, named axis).
//
// Two real risks this file proves closed, both found by reading the pre-closure
// code directly (not merely inferred from the preflight's own words):
//   1. bodyId COLLISION - two Model Items whose bodies mint the same raw
//      bodyId (bodyId is a per-item DAG node id, never project-wide-unique)
//      used to collide on ONE CAM geometry entry id (the preflight's own
//      census 1b finding).
//   2. CROSS-ITEM DELETION (found by this closure, not named in the preflight)
//      - reconcileModelBodies used to walk EVERY model row in `current`
//      regardless of which item owned it, so syncing item B's bodies would
//      treat item A's rows as "no longer live in B's sync" and silently
//      REMOVE them.

import { describe, it, expect } from 'vitest'
import {
  modelBodyEntryId,
  buildModelBodyGeometry,
  reconcileModelBodies,
  type DerivedModelBody,
  type LiveModelBody,
} from '../../lib/cam/modelBodyAdapter'
import type { ModelBodyDisplay } from '../../types'

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
  return { bodyId, version, stableIds: [`${bodyId}:F0`], display: display(tag) }
}
function live(bodyId: string, name: string): LiveModelBody {
  return { bodyId, name }
}

describe('CLOSURE gap 2: modelBodyEntryId scoping', () => {
  it('the legacy/omitted form is byte-identical to the pre-closure unscoped id', () => {
    expect(modelBodyEntryId('feat-7')).toBe('modelbody:feat-7')
    expect(modelBodyEntryId('feat-7', 'legacy')).toBe('modelbody:feat-7')
    expect(modelBodyEntryId('feat-7', undefined)).toBe('modelbody:feat-7')
  })

  it('a real Model Item folds its id into the entry id, so a collision on the raw bodyId cannot collide on the entry id', () => {
    const idA = modelBodyEntryId('b1', 'item-A')
    const idB = modelBodyEntryId('b1', 'item-B')
    const idLegacy = modelBodyEntryId('b1')
    expect(idA).not.toBe(idB)
    expect(idA).not.toBe(idLegacy)
    expect(idB).not.toBe(idLegacy)
  })
})

describe('CLOSURE gap 2: buildModelBodyGeometry tags ownership, legacy stays field-absent', () => {
  it('legacy scope omits modelItemId entirely (byte-identical shape to pre-closure rows)', () => {
    const geo = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1'))
    expect('modelItemId' in geo).toBe(false)
    expect(geo.modelItemId).toBeUndefined()
  })

  it('a real Model Item id is written onto the row it creates', () => {
    const geo = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1'), undefined, 'item-A')
    expect(geo.modelItemId).toBe('item-A')
  })

  it('ownership is set once, at creation, and survives a later regen even if the caller omits modelItemId', () => {
    const first = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1', 1, 0), undefined, 'item-A')
    // A later regen call that forgets to pass modelItemId must NOT silently
    // reassign an already-owned row to the legacy scope.
    const second = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1', 2, 9), first)
    expect(second.modelItemId).toBe('item-A')
  })
})

describe('CLOSURE gap 2: reconcileModelBodies is item-scoped', () => {
  it('REGRESSION (this is the bug the closure found): syncing item B never deletes item A\'s already-synced rows, even when their raw bodyId strings COLLIDE', () => {
    // Item A gets body "b1".
    const afterA = reconcileModelBodies([], {
      live: [live('b1', 'A Body')],
      derived: [derived('b1', 1, 0)],
      modelItemId: 'item-A',
    })
    expect(afterA.added).toEqual(['b1'])
    expect(afterA.geometry).toHaveLength(1)

    // Item B ALSO mints a body called "b1" (a real risk -- bodyId is a
    // per-item DAG node id, not project-wide-unique) and syncs it against
    // the SAME geometry array A's row already lives in.
    const afterB = reconcileModelBodies(afterA.geometry, {
      live: [live('b1', 'B Body')],
      derived: [derived('b1', 1, 4)],
      modelItemId: 'item-B',
    })

    // Pre-closure behavior: B's sync would have removed A's row (A's bodyId
    // "b1" is absent from B's `live` list under the OLD flat-namespace
    // read) and/or B's new row would have collided with A's row's id.
    // Closed behavior: BOTH items' rows coexist, distinct ids, distinct
    // ownership, A untouched.
    expect(afterB.removed).toEqual([])
    expect(afterB.added).toEqual(['b1'])
    expect(afterB.geometry).toHaveLength(2)

    const aRow = afterB.geometry.find((g) => g.modelItemId === 'item-A')
    const bRow = afterB.geometry.find((g) => g.modelItemId === 'item-B')
    expect(aRow).toBeDefined()
    expect(bRow).toBeDefined()
    expect(aRow!.id).not.toBe(bRow!.id)
    expect(aRow!.modelBody?.ref.bodyId).toBe('b1')
    expect(bRow!.modelBody?.ref.bodyId).toBe('b1')
    // A's row is byte-identical to what A's own sync produced -- B's sync
    // never touched it.
    expect(aRow).toBe(afterA.geometry[0])
  })

  it('a body deleted in item B never appears in item A\'s removed list, and vice versa', () => {
    const afterBoth = (() => {
      const afterA = reconcileModelBodies([], {
        live: [live('a1', 'A1')], derived: [derived('a1')], modelItemId: 'item-A',
      })
      return reconcileModelBodies(afterA.geometry, {
        live: [live('b1', 'B1')], derived: [derived('b1')], modelItemId: 'item-B',
      })
    })()
    // Now delete item B's body -- item A's row must be untouched and absent
    // from B's own removed/updated bookkeeping.
    const afterBDelete = reconcileModelBodies(afterBoth.geometry, {
      live: [], derived: [], modelItemId: 'item-B',
    })
    expect(afterBDelete.removed).toEqual(['b1'])
    expect(afterBDelete.geometry).toHaveLength(1)
    expect(afterBDelete.geometry[0].modelItemId).toBe('item-A')
  })

  it('legacy scope (modelItemId omitted) reconciles exactly as before, ignoring a co-existing real item\'s rows', () => {
    const withItemA = reconcileModelBodies([], {
      live: [live('a1', 'A1')], derived: [derived('a1')], modelItemId: 'item-A',
    })
    // A legacy sync (no modelItemId) that has never seen "a1" must not
    // report it as removed -- it is not in the legacy sync's scope at all.
    const legacySync = reconcileModelBodies(withItemA.geometry, {
      live: [live('leg1', 'Legacy Body')], derived: [derived('leg1')],
    })
    expect(legacySync.removed).toEqual([])
    expect(legacySync.added).toEqual(['leg1'])
    expect(legacySync.geometry).toHaveLength(2)
    const legacyRow = legacySync.geometry.find((g) => g.modelBody?.ref.bodyId === 'leg1')
    expect(legacyRow!.modelItemId).toBeUndefined()
    expect(legacyRow!.id).toBe('modelbody:leg1')
  })
})
