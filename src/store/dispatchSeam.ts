import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// WO-1823 stage 1 - the store's first extracted SEAM: the FIXED-STOCK TWIN WRITER.
//
// ABOUT THIS FILE NAME: `src/store/dispatchSeam.ts` is the path WO-1823's
// owned-paths grants for this stage's writer module, so stage 1's seam lives
// here even though the seam stage 1 extracts is the STOCK SYNC, not dispatch.
// Later slices (persistence, sketch port, model reconcile, dispatch) each get
// their own module; when the dispatch seam is actually extracted, this file's
// stock code moves to a stock-named module and the name stops lying. Until
// then: nothing about toolpath dispatch belongs in here.
//
// WHAT IT OWNS (ARCHITECTURE-AUDIT-2026-08-26 section 3.8): the
// FixedStockItem -> PhysicalStock TWIN invariant. Every FixedStockItem in
// project.sceneStock.fixedStocks has exactly one mode:'explicit' PhysicalStock
// in project.stocks carrying the same id, and project.stocks carries NO explicit
// stock without a live FixedStockItem source. The audit's finding was that this
// invariant "is maintained by five call sites each remembering" - addFixedStock,
// updateFixedStock, moveFixedStockLive, removeFixedStock and removeNest's
// bound-stock teardown - and that only ONE of the five (moveFixedStockLive)
// actually checked its own work. That is the shape that produced the twin-sync
// incidents: an edit that type-checks, and a twin that silently goes stale.
//
// THE FIX IS STRUCTURAL, NOT CLERICAL. A caller cannot get the two things it
// came here for - the synced twins AND the re-sorted geometry membership - and
// skip the invariant check, because writeFixedStockTwins does all three in one
// call and throws (ADR-0003 fail-loud) before it hands anything back. A sixth
// call site gets the check for free; a sixth call site that mangles the stock
// list on its way out (the `refine` hook - site 5 legitimately re-derives
// derived-stock bounds there) is caught by the same post-condition.
//
// NO BEHAVIOUR CHANGE. syncFixedStocksToPhysical is relocated verbatim from
// store/index.ts; the post-condition generalises moveFixedStockLive's existing
// fail-loud (same message, same wording) from "the one stock being moved" to
// "every twin this write produced", which is structurally satisfied at all five
// existing sites. assignStocks stays in store/index.ts (20 call sites, not this
// slice's concern) and is injected as `resort`.

import type { FixedStockItem, ImportedGeometry, PhysicalStock } from '../types'

// Coordinate hierarchy Phase 1: keep project.stocks' EXPLICIT entries in sync
// with the legacy sceneStock.fixedStocks after a fixed-stock mutation
// (add/update/move/remove). migrateProjectToHierarchy only ADDS missing
// explicit stocks (it returns an already-present one verbatim, so dimension /
// position edits would not propagate), and it does not drop explicit stocks for
// removed fixedStocks. This rebuilds the explicit set from the current
// fixedStocks (same min-corner -> bounds mapping migration uses) while
// PRESERVING the derived stock and any non-fixed stocks. Returns undefined when
// the project had no stocks yet (no migration run) so callers leave it absent.
//
// NO STORE ACTION MAY CALL THIS DIRECTLY: it gets you the sync WITHOUT the twin
// post-condition and without the membership re-sort, which is precisely the
// "each call site remembers" pattern the audit named. It is exported for the
// seam's own tests (which prove the writer's post-condition catches what the
// bare sync cannot) and for the follow-on slices. Store actions use
// writeFixedStockTwins.
export function syncFixedStocksToPhysical(
  existing: PhysicalStock[] | undefined,
  fixedStocks: FixedStockItem[],
): PhysicalStock[] | undefined {
  if (!existing) return undefined
  const fixedIds = new Set(fixedStocks.map((f) => f.id))
  const explicit: PhysicalStock[] = fixedStocks.map((fixed): PhysicalStock => {
    const prior = existing.find((stock) => stock.id === fixed.id)
    return {
      ...prior,
      id: fixed.id,
      name: fixed.name,
      mode: 'explicit',
      bounds: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: fixed.width, y: fixed.height, z: fixed.depth },
        size: { x: fixed.width, y: fixed.height, z: fixed.depth },
        center: { x: fixed.width / 2, y: fixed.height / 2, z: fixed.depth / 2 },
      },
      position: { x: fixed.position.x, y: fixed.position.y, z: fixed.position.z },
    }
  })
  // Keep the derived stock + any stock that is neither explicit-for-a-fixed
  // nor a now-removed fixed stock. A previously explicit stock whose fixed
  // source was removed is dropped (its geometry re-sorts to the derived stock).
  const preserved = existing.filter(
    (s) => s.mode !== 'explicit' && !fixedIds.has(s.id),
  )
  return [...preserved, ...explicit]
}

// THE twin post-condition (ADR-0003 fail-loud), in ONE place.
//
// Direction 1 is moveFixedStockLive's original check, word for word, widened
// from the single moved stock to every fixed stock in the write: a missing twin
// means a resolver would place the cut against a stale frame, so it surfaces
// instead of silently mis-placing. Direction 2 is its mirror, which no call site
// ever checked: an explicit twin left behind after its FixedStockItem is gone
// resolves to a stock the operator deleted (the dangling-id shape behind the
// false "stock reference is missing" flag).
//
// A project with no PhysicalStocks at all (`stocks` undefined - never migrated)
// has no twins to keep and is not an error: rule 11, the software refuses only
// what it cannot do, and "this scene predates the hierarchy" is something it
// handles everywhere else by leaving project.stocks absent.
export function assertFixedStockTwins(
  stocks: PhysicalStock[] | undefined,
  fixedStocks: FixedStockItem[],
  context: string,
): void {
  if (!stocks) return
  for (const fixed of fixedStocks) {
    if (!stocks.some((ps) => ps.id === fixed.id && ps.mode === 'explicit')) {
      throw new Error(
        operatorText('dispatchSeam1', { value1: String(context), value2: String(fixed.id) }),
      )
    }
  }
  const fixedIds = new Set(fixedStocks.map((f) => f.id))
  for (const ps of stocks) {
    if (ps.mode === 'explicit' && !fixedIds.has(ps.id)) {
      throw new Error(
        operatorText('dispatchSeam2', { value1: String(context), value2: String(ps.id) }),
      )
    }
  }
}

export interface FixedStockTwinWrite {
  /** project.stocks as it stands (undefined for a never-migrated scene). */
  existing: PhysicalStock[] | undefined
  /** The fixedStocks list this mutation is about to STORE - not the prior one. */
  fixedStocks: FixedStockItem[]
  /** The geometry this mutation is about to store, already carrying any member
   *  translate / membership clearing the caller does itself (rigid-fixture ride,
   *  removed-stock unassign). Re-sorted here, never mutated. */
  geometry: ImportedGeometry[]
  /** The action name, for the fail-loud message (e.g. 'moveFixedStockLive'). */
  context: string
  /** Optional post-sync stock derivation - removeNest re-derives the SURVIVING
   *  derived stock's bounds between the sync and the membership re-sort. Runs
   *  BEFORE the post-condition, so a refine that breaks a twin is caught here
   *  rather than in a resolver three screens later. */
  refine?: (stocks: PhysicalStock[] | undefined) => PhysicalStock[] | undefined
  /** store/index.ts's assignStocks, injected (it has 20 other call sites and is
   *  not this slice's to relocate). */
  resort: (
    geometry: ImportedGeometry[],
    stocks: PhysicalStock[] | undefined,
  ) => ImportedGeometry[]
}

/** The ONE writer for the fixed-stock twins. Sync -> optional refine -> twin
 *  post-condition -> membership re-sort, in that order, always. */
export function writeFixedStockTwins(
  write: FixedStockTwinWrite,
): { stocks: PhysicalStock[] | undefined; geometry: ImportedGeometry[] } {
  const synced = syncFixedStocksToPhysical(write.existing, write.fixedStocks)
  const stocks = write.refine ? write.refine(synced) : synced
  assertFixedStockTwins(stocks, write.fixedStocks, write.context)
  return { stocks, geometry: write.resort(write.geometry, stocks) }
}
