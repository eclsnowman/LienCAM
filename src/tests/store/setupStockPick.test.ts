// Unit tests for the new-setup smart stock pick (pure helpers in
// src/store/stockAssignment.ts):
//   geometryBearingStockIds(project) and pickDefaultSetupStock(project).
//
// BUG these guard (real, Operator-hit): a NEW setup's WCS/stock picker hard-defaulted
// to the catch-all auto stock (DERIVED_STOCK_ID) and derived wcs.origin.z from
// it. When machining a NEST, the seeds resolve their cut stock from the nest's
// BOUND fixed sheet (NestRecord.boundStockId, ADR 0025 Amd 3) — a different,
// thicker stock — so the silent auto default put Z0 on the wrong stock ->
// "Feed height below top height" fail-loud.
//
// The fix: default to the lone geometry-bearing stock; force an explicit choice
// when >1; fall back to DERIVED_STOCK_ID when none. A NEST's bound sheet is
// geometry-bearing even though it has NO member geometry (the seeds are explicit
// no-stock) — so a plain membership check is NOT enough.

import { describe, it, expect } from 'vitest'
import {
  geometryBearingStockIds,
  pickDefaultSetupStock,
} from '../../store/stockAssignment'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type { ImportedGeometry } from '../../types'

// Minimal project shape the helpers read. Only id-bearing fields matter here.
function proj(over: {
  geometry?: Array<{
    stockId?: string
    format?: ImportedGeometry['format']
    stockIdLocked?: boolean
  }>
  stocks?: Array<{ id: string }>
  nests?: Array<{ boundStockId?: string }>
}) {
  return {
    geometry: over.geometry ?? [],
    stocks: over.stocks ?? [],
    nests: over.nests ?? [],
  }
}

/** A model-origin row (CAM-BINDING Stage 3 shape: format:'model' + stockId +
 *  stockIdLocked). Mirrors the real "use this body as stock" state. */
function modelGeo(over: { stockId?: string; stockIdLocked?: boolean } = {}) {
  return {
    format: 'model' as const,
    stockId: over.stockId,
    stockIdLocked: over.stockIdLocked,
  }
}

describe('geometryBearingStockIds', () => {
  it('returns a normal member stock id', () => {
    const p = proj({
      stocks: [{ id: 'fixed-1' }],
      geometry: [{ stockId: 'fixed-1' }],
    })
    expect(geometryBearingStockIds(p)).toEqual(['fixed-1'])
  })

  it('includes a NEST bound sheet that has NO member geometry', () => {
    // The seed parts are explicit no-stock (stockId undefined); the nest sheet
    // is the actual cut stock. A pure membership check would miss it.
    const p = proj({
      stocks: [{ id: 'sheet-1' }],
      geometry: [{ stockId: undefined }],
      nests: [{ boundStockId: 'sheet-1' }],
    })
    expect(geometryBearingStockIds(p)).toEqual(['sheet-1'])
  })

  it('does NOT count the catch-all when no real part is assigned to it', () => {
    // The derived catch-all exists but bears nothing -> not a candidate.
    const p = proj({
      stocks: [{ id: DERIVED_STOCK_ID }],
      geometry: [],
    })
    expect(geometryBearingStockIds(p)).toEqual([])
  })

  it('DOES count the catch-all when a real part is assigned to it', () => {
    const p = proj({
      stocks: [{ id: DERIVED_STOCK_ID }],
      geometry: [{ stockId: DERIVED_STOCK_ID }],
    })
    expect(geometryBearingStockIds(p)).toEqual([DERIVED_STOCK_ID])
  })

  // MODEL-STOCK-NEW-SETUP-WCS-PICK (MODEL-ROW-CITIZEN find a): a model body a
  // user deliberately LOCKED as a stock ("use this body as stock", CAM-BINDING
  // Stage 3) must count as geometry-bearing, exactly like assignGeometryToStocks
  // already honors the same lock. An UNLOCKED model row must still be invisible
  // (it can never be auto-swept into a stock; unchanged Stage 3 behavior).
  it('counts a LOCKED model-origin row as geometry-bearing', () => {
    const p = proj({
      stocks: [{ id: 'body-stock' }],
      geometry: [modelGeo({ stockId: 'body-stock', stockIdLocked: true })],
    })
    expect(geometryBearingStockIds(p)).toEqual(['body-stock'])
  })

  it('does NOT count an UNLOCKED model-origin row (Stage 3 unchanged)', () => {
    const p = proj({
      stocks: [{ id: 'body-stock' }],
      geometry: [modelGeo({ stockId: 'body-stock', stockIdLocked: false })],
    })
    expect(geometryBearingStockIds(p)).toEqual([])
  })

  it('does NOT count a locked model row whose stockId is dangling', () => {
    const p = proj({
      stocks: [{ id: 'other' }],
      geometry: [modelGeo({ stockId: 'ghost', stockIdLocked: true })],
    })
    expect(geometryBearingStockIds(p)).toEqual([])
  })

  it('dedupes and drops dangling ids; order follows project.stocks', () => {
    const p = proj({
      stocks: [{ id: 'a' }, { id: 'b' }],
      geometry: [
        { stockId: 'a' },
        { stockId: 'a' },      // dup
        { stockId: 'ghost' },  // dangling -> dropped
      ],
      nests: [{ boundStockId: 'b' }, { boundStockId: 'b' }], // dup
    })
    expect(geometryBearingStockIds(p)).toEqual(['a', 'b'])
  })
})

describe('pickDefaultSetupStock', () => {
  it('one nest-bound stock + no other members -> defaults to the nest sheet', () => {
    const p = proj({
      stocks: [{ id: 'sheet-1' }],
      geometry: [{ stockId: undefined }],
      nests: [{ boundStockId: 'sheet-1' }],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ stockId: 'sheet-1' })
  })

  it('one normal member stock -> defaults to it', () => {
    const p = proj({
      stocks: [{ id: 'fixed-1' }],
      geometry: [{ stockId: 'fixed-1' }],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ stockId: 'fixed-1' })
  })

  it('a nest sheet PLUS another member stock -> forceChoice', () => {
    const p = proj({
      stocks: [{ id: 'sheet-1' }, { id: 'fixed-2' }],
      geometry: [{ stockId: 'fixed-2' }],
      nests: [{ boundStockId: 'sheet-1' }],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ forceChoice: true })
  })

  it('nothing geometry-bearing -> DERIVED_STOCK_ID fallback', () => {
    // Catch-all present but empty, plus an unused fixed stock -> no candidates.
    const p = proj({
      stocks: [{ id: DERIVED_STOCK_ID }, { id: 'fixed-unused' }],
      geometry: [],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ stockId: DERIVED_STOCK_ID })
  })

  // MODEL-STOCK-NEW-SETUP-WCS-PICK: the convenience gap itself. Before the fix,
  // a model-locked stock was invisible here, so with another bearing stock also
  // present the picker force-prompted instead of correctly recognizing TWO real
  // candidates exist (still forceChoice, but now for the right reason - and the
  // lone-candidate case below now defaults silently instead of blind-prompting).
  it('a LOCKED model-derived stock alone -> defaults to it (the fixed gap)', () => {
    const p = proj({
      stocks: [{ id: 'body-stock' }],
      geometry: [modelGeo({ stockId: 'body-stock', stockIdLocked: true })],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ stockId: 'body-stock' })
  })

  it('a LOCKED model-derived stock PLUS another real stock -> forceChoice', () => {
    const p = proj({
      stocks: [{ id: 'body-stock' }, { id: 'fixed-2' }],
      geometry: [
        modelGeo({ stockId: 'body-stock', stockIdLocked: true }),
        { stockId: 'fixed-2' },
      ],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ forceChoice: true })
  })

  it('the lone candidate IS the derived stock -> byte-identical old behavior', () => {
    const p = proj({
      stocks: [{ id: DERIVED_STOCK_ID }],
      geometry: [{ stockId: DERIVED_STOCK_ID }],
    })
    expect(pickDefaultSetupStock(p)).toEqual({ stockId: DERIVED_STOCK_ID })
  })
})
