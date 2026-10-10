// AUTOSTOCK-MODEL-FAIL (Operator LIVE FAIL #3): a part created via the Model
// workspace (sketch -> extrude) sits in the default auto stock (its design-tree
// stock dropdown reads "Auto Stock 1") yet NO stock box renders around it.
//
// ROOT CAUSE (a GAP, not a regression): the viewport draws the derived-stock
// twin's stored `bounds`, computed by rederiveDerivedStockBounds ->
// deriveStockBounds, which counted only members with `geo.stockId === stock.id`.
// A model-origin row is deliberately never auto-swept into a stock's stockId
// membership (assignGeometryToStocks CLEARS it), so a fresh model part was never
// a member of the catch-all auto stock -> zero-volume bounds -> viewport skips
// the box. The design tree meanwhile showed the row as an 'auto-catch-all'
// member of that same stock. deriveAutoStockBounds (the whole-scene union used
// for WCS) already folded model rows in; only the per-stock RENDERED path did
// not. These pins hold the fix: the CATCH-ALL derived stock now folds in
// unassigned (auto-catch-all) model rows, read through the same placement-aware
// world bounds the viewport draws them with.

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, BoundingBox, Vec3, PhysicalStock } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveStockBounds } from '../../store/stockAssignment'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A Model-workspace part row (format:'model') with a tessellated display bbox. */
function makeModelGeo(
  id: string,
  boundsMinMax: [Vec3, Vec3] | undefined,
  opts: { modelItemId?: string; stockId?: string; stockIdLocked?: boolean } = {},
): ImportedGeometry {
  return {
    id, name: id, filename: '', type: 'model', format: 'model',
    boundingBox: boundsMinMax ? bbox(boundsMinMax[0], boundsMinMax[1]) : bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...(opts.modelItemId !== undefined ? { modelItemId: opts.modelItemId } : {}),
    ...(opts.stockId !== undefined ? { stockId: opts.stockId } : {}),
    ...(opts.stockIdLocked !== undefined ? { stockIdLocked: opts.stockIdLocked } : {}),
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      ...(boundsMinMax ? {
        display: {
          positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
          bbox: { min: [boundsMinMax[0].x, boundsMinMax[0].y, boundsMinMax[0].z], max: [boundsMinMax[1].x, boundsMinMax[1].y, boundsMinMax[1].z] },
        },
      } : {}),
    },
  } as unknown as ImportedGeometry
}

const IDENTITY = (modelItemId: string): ModelItemPlacementRegistryEntry => ({
  modelItemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
})

function catchAllStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), position: { x: 0, y: 0, z: 0 },
  }
}

const OFF = { autoOffsetXY: 2, autoOffsetZTop: 1 }

describe('AUTOSTOCK-MODEL-FAIL: catch-all derived stock folds in an unassigned model part', () => {
  it('THE BUG: a model row in the (catch-all) auto stock sizes + renders the box when allStocks is passed', () => {
    const stock = catchAllStock()
    // stockId undefined + not locked = the exact "auto-catch-all" state the design
    // tree shows as "Auto Stock 1" for a fresh extruded part.
    const geo = makeModelGeo('extrude-f1', [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], { modelItemId: 'item-1' })
    const bounds = deriveStockBounds(stock, [geo], OFF, [IDENTITY('item-1')], [stock])
    expect(bounds).not.toBeNull()
    expect(bounds!.min).toEqual({ x: -22, y: -17, z: 0 })
    expect(bounds!.max).toEqual({ x: 22, y: 17, z: 11 })
  })

  it('MUTATION PROOF / regression guard: WITHOUT allStocks the model row is NOT folded (the old, boxless behavior) - so the strict dispatch/compute path is unchanged', () => {
    const stock = catchAllStock()
    const geo = makeModelGeo('extrude-f1', [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], { modelItemId: 'item-1' })
    // No allStocks arg => byte-identical pre-fix behavior: an unassigned model row
    // is not a member, so the catch-all derives to null (viewport draws nothing).
    expect(deriveStockBounds(stock, [geo], OFF, [IDENTITY('item-1')])).toBeNull()
  })

  it('body syncs LATE (cold kernel): before the display exists the box is null; once it exists the box appears', () => {
    const stock = catchAllStock()
    const cold = makeModelGeo('extrude-f1', undefined, { modelItemId: 'item-1' }) // no display yet
    expect(deriveStockBounds(stock, [cold], OFF, [IDENTITY('item-1')], [stock])).toBeNull()
    const warm = makeModelGeo('extrude-f1', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 5 }], { modelItemId: 'item-1' })
    const bounds = deriveStockBounds(stock, [warm], OFF, [IDENTITY('item-1')], [stock])
    expect(bounds).not.toBeNull()
    expect(bounds!.max).toEqual({ x: 12, y: 12, z: 6 })
  })

  it('model EDITED (bbox grows): the derived box tracks the new bbox', () => {
    const stock = catchAllStock()
    const before = makeModelGeo('extrude-f1', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 5 }], { modelItemId: 'item-1' })
    const after = makeModelGeo('extrude-f1', [{ x: 0, y: 0, z: 0 }, { x: 30, y: 10, z: 5 }], { modelItemId: 'item-1' })
    const b0 = deriveStockBounds(stock, [before], OFF, [IDENTITY('item-1')], [stock])!
    const b1 = deriveStockBounds(stock, [after], OFF, [IDENTITY('item-1')], [stock])!
    expect(b1.max.x).toBeGreaterThan(b0.max.x)
    expect(b1.max.x).toBe(32)
  })

  it('row REMOVED: the catch-all shrinks back to null (viewport zero-volume -> no box)', () => {
    const stock = catchAllStock()
    expect(deriveStockBounds(stock, [], OFF, [], [stock])).toBeNull()
  })

  it('deliberate NONE (stockIdLocked, no stockId): NOT folded - the user explicitly chose no stock (ADR-0003 respect)', () => {
    const stock = catchAllStock()
    const geo = makeModelGeo('extrude-f1', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 5 }], {
      modelItemId: 'item-1', stockIdLocked: true, // stockId stays undefined = deliberate None
    })
    expect(deriveStockBounds(stock, [geo], OFF, [IDENTITY('item-1')], [stock])).toBeNull()
  })

  it('a model row LOCKED to this catch-all stock is counted exactly once (no double-count with the fold)', () => {
    const stock = catchAllStock()
    const geo = makeModelGeo('extrude-f1', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 5 }], {
      modelItemId: 'item-1', stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    })
    const bounds = deriveStockBounds(stock, [geo], { autoOffsetXY: 0, autoOffsetZTop: 0 }, [IDENTITY('item-1')], [stock])
    expect(bounds).not.toBeNull()
    expect(bounds!.min).toEqual({ x: 0, y: 0, z: 0 })
    expect(bounds!.max).toEqual({ x: 10, y: 10, z: 5 })
  })

  it('a NON-catch-all named derived stock does NOT fold an unassigned model row (only its own locked members)', () => {
    const catchAll = catchAllStock()
    const named: PhysicalStock = {
      id: 'auto-2', name: 'Auto Stock 2', mode: 'derived',
      bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), position: { x: 0, y: 0, z: 0 },
    }
    const geo = makeModelGeo('extrude-f1', [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 5 }], { modelItemId: 'item-1' })
    // The catch-all (DERIVED_STOCK_ID) folds it; the named 2nd stock must not.
    expect(deriveStockBounds(named, [geo], OFF, [IDENTITY('item-1')], [catchAll, named])).toBeNull()
    expect(deriveStockBounds(catchAll, [geo], OFF, [IDENTITY('item-1')], [catchAll, named])).not.toBeNull()
  })

  it('the fold does not disturb an ordinary imported/2D part (non-model geometry is unaffected by the model branch)', () => {
    const stock = catchAllStock()
    // A regular mesh already assigned to the catch-all by stockId (as
    // assignGeometryToStocks would). It must derive identically with or without
    // the fold path being enabled.
    const mesh = {
      id: 'stl-1', name: 'stl-1', filename: '', type: 'mesh', format: 'stl',
      boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 20, z: 8 }),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      stockId: DERIVED_STOCK_ID,
    } as unknown as ImportedGeometry
    const withFold = deriveStockBounds(stock, [mesh], OFF, [], [stock])
    const withoutFold = deriveStockBounds(stock, [mesh], OFF, [])
    expect(withFold).toEqual(withoutFold)
    expect(withFold!.max).toEqual({ x: 42, y: 22, z: 9 })
  })
})
