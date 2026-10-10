// WO UI-57-R1 blocker 2 -- the UI half of the shared face-id resolver.
//
// The audit's required fix: "route every face consumer through [one shared
// resolver] ... and use it for fillet/chamfer, measurement, visibility,
// appearance, and selections. Add a closed consumer census plus one
// merged-loser regression for every consumer class."
//
// The engine-side consumer classes are regression-tested against the REAL
// kernel in src/tests/geom/faceOffsetHealing.test.ts (the merged-loser step
// fixture). This file covers the UI-side classes, whose failure mode is worse
// because it is entirely SILENT: they compare a stored id against the
// tessellation's faceIds by string equality, and after a merge only the WINNER
// is there -- so a stale loser id matches nothing, with no error anywhere.
//
// The delta literals below use the exact shape #pairHealedFaces emits:
//     modified[loser]  = [winner]     (loser is an INPUT, winner its output)
//     modified[winner] = [winner]     (the live-survivor marker)
import { describe, it, expect } from 'vitest'
import type { ElementMapDelta, StableId } from '../../geom/geom-service.ts'
import { aliasesFromDelta, resolveFaceIdVia } from '../../geom/aliasLineage.ts'
import { migrateStoredFaceIds } from '../../components/model3d/workbench/faceIdMigration.ts'
import { SelectionState } from '../../viewport3d/SelectionState.ts'
import { AppearanceStore, type RGB } from '../../components/model3d/appearance/appearanceStore.ts'
import { VisibilityStore } from '../../components/model3d/visibility/visibilityStore.ts'

const WINNER = 'FA:XTR:SA:capEnd' as StableId
const LOSER = 'FB:XTR:SB:capEnd' as StableId
const UNTOUCHED = 'FA:XTR:SA:capStart' as StableId

/** The delta a real healed push/pull emits (verbatim shape, captured from the
 *  real-kernel step fixture in faceOffsetHealing.test.ts). */
const HEALED: ElementMapDelta = {
  featureId: 'E1',
  modified: { [LOSER]: [WINNER], [WINNER]: [WINNER], [UNTOUCHED]: [UNTOUCHED] },
  generated: [],
  deleted: [],
}

const stores = () => ({ selection: new SelectionState(), appearance: new AppearanceStore(), visibility: new VisibilityStore() })

describe('UI-57-R1 blocker 2: aliasesFromDelta (the ONE lineage rule both lanes read)', () => {
  it('reads loser -> winner out of a healed delta', () => {
    const a = aliasesFromDelta(HEALED)
    expect(a.get(LOSER)).toBe(WINNER)
    expect(a.has(WINNER)).toBe(false)
    expect(a.has(UNTOUCHED)).toBe(false)
  })

  it('REFUSES to invent an alias from a split/retrim entry (parent -> several different children)', () => {
    // A split's parent is genuinely replaced; it must stay 'lost', never be
    // silently rebound to one of its children.
    expect(aliasesFromDelta({
      featureId: 'F', modified: { p: ['c1', 'c2'] } as Record<string, StableId[]>, generated: [], deleted: [],
    }).size).toBe(0)
  })

  it('REFUSES a single-child entry whose child is not itself a live survivor (no winner -> [winner] marker)', () => {
    expect(aliasesFromDelta({
      featureId: 'F', modified: { p: ['c'] } as Record<string, StableId[]>, generated: [], deleted: [],
    }).size).toBe(0)
  })

  it('resolveFaceIdVia follows a CHAIN (a winner that later merged again) and terminates on a cycle', () => {
    const chain = new Map<StableId, StableId>([['a' as StableId, 'b' as StableId], ['b' as StableId, 'c' as StableId]])
    expect(resolveFaceIdVia(chain, 'a' as StableId)).toBe('c')
    const cyclic = new Map<StableId, StableId>([['x' as StableId, 'y' as StableId], ['y' as StableId, 'x' as StableId]])
    expect(['x', 'y']).toContain(resolveFaceIdVia(cyclic, 'x' as StableId))
  })
})

describe('UI-57-R1 blocker 2: SELECTION migrates across a merge', () => {
  it('#ui-merged-loser-selection: a selected face that merged away stays selected -- on the WINNER', () => {
    const s = stores()
    s.selection.select(LOSER)
    // Before migration the selection is silently dead: the viewport paints from
    // the tessellation's ids, where only the winner exists.
    expect(s.selection.highlightFor(WINNER)).toBe('none')
    migrateStoredFaceIds(HEALED, s)
    expect(s.selection.isSelected(WINNER)).toBe(true)
    expect(s.selection.isSelected(LOSER)).toBe(false)
    expect(s.selection.highlightFor(WINNER)).toBe('selected')
  })

  it('#ui-merged-loser-hover: a hovered face that merged away migrates too', () => {
    const s = stores()
    s.selection.setHover(LOSER)
    migrateStoredFaceIds(HEALED, s)
    expect(s.selection.hovered).toBe(WINNER)
    expect(s.selection.highlightFor(WINNER)).toBe('hovered')
  })

  it('emits exactly one select event for the migration, and leaves untouched ids alone', () => {
    const s = stores()
    s.selection.select(LOSER)
    s.selection.addToSelection(UNTOUCHED)
    let events = 0
    s.selection.subscribe((e) => { if (e.type === 'select') events++ })
    migrateStoredFaceIds(HEALED, s)
    expect(events).toBe(1)
    expect([...s.selection.selection].sort()).toEqual([WINNER, UNTOUCHED].sort())
  })
})

describe('UI-57-R1 blocker 2: APPEARANCE migrates across a merge', () => {
  it('#ui-merged-loser-appearance: a face colour survives the merge instead of silently reverting to the body base', () => {
    const s = stores()
    const red: RGB = [1, 0, 0]
    s.appearance.setFaceColor(LOSER, red)
    expect(s.appearance.faceColor(WINNER)).toBeUndefined() // dead before migration
    migrateStoredFaceIds(HEALED, s)
    expect(s.appearance.faceColor(WINNER)).toEqual(red)
    expect(s.appearance.faceColor(LOSER)).toBeUndefined()
  })

  it('the WINNER\'s own colour wins when both contributors were painted', () => {
    const s = stores()
    s.appearance.setFaceColor(LOSER, [1, 0, 0])
    s.appearance.setFaceColor(WINNER, [0, 0, 1])
    migrateStoredFaceIds(HEALED, s)
    expect(s.appearance.faceColor(WINNER)).toEqual([0, 0, 1])
  })

  it('pruneDeleted CANNOT do this job: a merged-away id is not deleted, so its entry would orphan forever', () => {
    const s = stores()
    s.appearance.setFaceColor(LOSER, [1, 0, 0])
    // isDeleted comes from the delta's `deleted` list, which correctly does NOT
    // contain the loser (it has a survivor). So pruning is a no-op here -- this
    // is exactly the gap migrateFaceIds fills.
    expect(s.appearance.pruneDeleted((id) => HEALED.deleted.includes(id))).toEqual([])
    expect(s.appearance.faceColor(LOSER)).toBeDefined()
  })
})

describe('UI-57-R1 blocker 2: VISIBILITY migrates across a merge', () => {
  it('#ui-merged-loser-visibility: a HIDDEN face does not reappear when its id merges away', () => {
    const s = stores()
    s.visibility.setFaceHidden(LOSER, true)
    expect(s.visibility.isFaceHidden(WINNER)).toBe(false) // would reappear
    migrateStoredFaceIds(HEALED, s)
    expect(s.visibility.isFaceHidden(WINNER)).toBe(true)
    expect(s.visibility.isFaceHidden(LOSER)).toBe(false)
  })

  it('#ui-merged-loser-isolate: an active isolate\'s face set migrates too', () => {
    const s = stores()
    const body = 'B1' as never
    s.visibility.isolateIds([body], [LOSER])
    expect(s.visibility.isFaceVisible(body, WINNER)).toBe(false) // wrongly hidden
    migrateStoredFaceIds(HEALED, s)
    expect(s.visibility.isFaceVisible(body, WINNER)).toBe(true)
  })
})

describe('UI-57-R1 blocker 2: migrateStoredFaceIds is safe on every non-merge delta', () => {
  it('a delta with NO merges touches nothing (so it is safe to call after every edit)', () => {
    const s = stores()
    s.selection.select(UNTOUCHED)
    s.appearance.setFaceColor(UNTOUCHED, [1, 1, 1])
    s.visibility.setFaceHidden(UNTOUCHED, true)
    const r = migrateStoredFaceIds({ featureId: 'F', modified: { [UNTOUCHED]: [UNTOUCHED] }, generated: [], deleted: [] }, s)
    expect(r.aliasCount).toBe(0)
    expect(s.selection.isSelected(UNTOUCHED)).toBe(true)
    expect(s.appearance.faceColor(UNTOUCHED)).toEqual([1, 1, 1])
    expect(s.visibility.isFaceHidden(UNTOUCHED)).toBe(true)
  })

  it('an undefined elementMap is a no-op, not a throw', () => {
    expect(migrateStoredFaceIds(undefined, stores()).aliasCount).toBe(0)
  })

  it('reports what it migrated, per store', () => {
    const s = stores()
    s.selection.select(LOSER)
    s.appearance.setFaceColor(LOSER, [1, 0, 0])
    s.visibility.setFaceHidden(LOSER, true)
    const r = migrateStoredFaceIds(HEALED, s)
    expect(r.aliasCount).toBe(1)
    expect(r.selection).toEqual([[LOSER, WINNER]])
    expect(r.appearance).toEqual([[LOSER, WINNER]])
    expect(r.visibility).toEqual([[LOSER, WINNER]])
  })
})
