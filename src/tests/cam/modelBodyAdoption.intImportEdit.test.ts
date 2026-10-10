// GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1 (plan sec 2): the pure adapter
// ADOPTION path -- a wrapped STEP row (pendingModelItemId set) is REPLACED in
// place by the item's first body on reconcile, id + fields preserved, pose reset
// to identity (it now rides the placement record), baked 2D projections carried
// forward, no duplicate row, and scoped so another item's sync never touches it.

import { describe, it, expect } from 'vitest'
import {
  reconcileModelBodies,
  adoptStepRowAsModelBody,
  type DerivedModelBody,
  type LiveModelBody,
} from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry, Layer2D, Loop2D, ModelBodyDisplay } from '../../types'

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

/** A wrapped STEP row: pendingModelItemId set, still format:'step', carrying the
 *  no-jump seated pose + baked 2D sections that must survive adoption. */
function pendingStepRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  const layer: Layer2D = { id: 'sec-1', name: 'Section', color: '#0ff', visible: true, sourceType: 'import', projectionPlane: { origin: { x: 0, y: 0, z: 3 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 } } }
  const loop: Loop2D = { id: 'lp-1', layerId: 'sec-1', closed: true, type: 'contour', area: 4, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }
  return {
    id: 'geo-step', name: 'Bracket', filename: 'bracket.step', type: 'brep', format: 'step',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 }, size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 } },
    position: { x: 7, y: -3, z: 0 }, rotation: { x: 0, y: 0, z: 90 }, loaded: true,
    color: '#c0ffee', hidden: true, folderId: 'fold-1', stockId: 'stock-1', stockIdLocked: true,
    layers2d: [layer], loops: [loop], loopsVersion: 4,
    pendingModelItemId: 'item-A',
    ...over,
  }
}

describe('GEO-UNIFY Stage 4: adoptStepRowAsModelBody (unit)', () => {
  it('preserves id + color/hidden/folder/stock, resets pose to identity, carries layers2d/loops, clears pending', () => {
    const row = pendingStepRow()
    const adopted = adoptStepRowAsModelBody(live('b1', 'Bracket'), derived('b1'), row, 'item-A')

    expect(adopted.id).toBe('geo-step')            // id continuity (op params/stock/folder stay bound)
    expect(adopted.format).toBe('model')
    expect(adopted.modelItemId).toBe('item-A')
    expect(adopted.color).toBe('#c0ffee')
    expect(adopted.hidden).toBe(true)
    expect(adopted.folderId).toBe('fold-1')
    expect(adopted.stockId).toBe('stock-1')
    expect(adopted.stockIdLocked).toBe(true)
    // Pose now lives in the placement record -> row is native coords + identity.
    expect(adopted.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(adopted.rotation).toEqual({ x: 0, y: 0, z: 0 })
    // Baked 2D sections carried forward (existing 2D ops keep working).
    expect(adopted.layers2d?.map((l) => l.id)).toEqual(['sec-1'])
    expect(adopted.loops?.map((l) => l.id)).toEqual(['lp-1'])
    expect(adopted.loopsVersion).toBe(4)
    // pendingModelItemId is gone (built from an explicit field list).
    expect(adopted.pendingModelItemId).toBeUndefined()
  })
})

describe('GEO-UNIFY Stage 4: reconcileModelBodies adoption path', () => {
  it('ADOPTS a pending STEP row in place (no duplicate, id kept, reports adopted)', () => {
    const r = reconcileModelBodies([pendingStepRow()], {
      live: [live('b1', 'Bracket')], derived: [derived('b1')], modelItemId: 'item-A',
    })
    // One row in, one row out -- replaced in place, not appended alongside.
    expect(r.geometry).toHaveLength(1)
    expect(r.geometry[0].id).toBe('geo-step')
    expect(r.geometry[0].format).toBe('model')
    expect(r.added).toEqual(['b1'])
    expect(r.adopted).toEqual(['geo-step'])
  })

  it('keeps the pending row at its ARRAY POSITION among other geometry', () => {
    const other = pendingStepRow({ id: 'stl-x', format: 'stl', filename: 'x.stl', type: 'mesh', pendingModelItemId: undefined, layers2d: undefined, loops: undefined })
    const r = reconcileModelBodies([other, pendingStepRow()], {
      live: [live('b1', 'Bracket')], derived: [derived('b1')], modelItemId: 'item-A',
    })
    expect(r.geometry.map((g) => g.id)).toEqual(['stl-x', 'geo-step'])  // order preserved
    expect(r.geometry[1].format).toBe('model')
  })

  it('does NOT adopt a pending row scoped to a DIFFERENT item (cross-item non-interference)', () => {
    // Sync item-B; the pending row belongs to item-A. It must pass through
    // untouched (still a STEP row, still pending), and item-B's body is a plain
    // appended ADD.
    const r = reconcileModelBodies([pendingStepRow()], {
      live: [live('b2', 'Other')], derived: [derived('b2')], modelItemId: 'item-B',
    })
    expect(r.adopted).toEqual([])
    const step = r.geometry.find((g) => g.id === 'geo-step')!
    expect(step.format).toBe('step')
    expect(step.pendingModelItemId).toBe('item-A')
    // item-B's body appended as a new (scoped) row.
    const b2 = r.geometry.find((g) => g.modelBody?.ref.bodyId === 'b2')!
    expect(b2).toBeDefined()
    expect(b2.id).toBe('modelbody:item-B:b2')
    expect(r.geometry).toHaveLength(2)
  })

  it('a SECOND regen updates the adopted row in place (still one row, id stable)', () => {
    const first = reconcileModelBodies([pendingStepRow()], {
      live: [live('b1', 'Bracket')], derived: [derived('b1', 1)], modelItemId: 'item-A',
    })
    const second = reconcileModelBodies(first.geometry, {
      live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 5)], modelItemId: 'item-A',
    })
    expect(second.adopted).toEqual([])           // already model, no re-adoption
    expect(second.updated).toEqual(['b1'])
    expect(second.geometry).toHaveLength(1)
    expect(second.geometry[0].id).toBe('geo-step')
    expect(second.geometry[0].position).toEqual({ x: 0, y: 0, z: 0 })  // stays identity
    expect(second.geometry[0].modelBody?.ref.version).toBe(2)
  })

  it('with NO derived body yet, the pending row stays a STEP row (missing, not adopted)', () => {
    const r = reconcileModelBodies([pendingStepRow()], {
      live: [live('b1', 'Bracket')], derived: [], modelItemId: 'item-A',
    })
    expect(r.missing).toEqual(['b1'])
    expect(r.adopted).toEqual([])
    expect(r.geometry).toHaveLength(1)
    expect(r.geometry[0].format).toBe('step')
    expect(r.geometry[0].pendingModelItemId).toBe('item-A')
  })
})
