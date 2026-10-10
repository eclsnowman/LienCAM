// INT-IMPORT-EDIT stage 2 (post-wrap lifecycle hardening): a model-body regen
// must NOT drop the row's baked 2D sections/projections. The plan (sec 5) flagged
// a HAZARD that buildModelBodyGeometry rebuilt an updated row from an explicit
// field list that omitted layers2d, so editing an imported-now-editable body
// (defeature a hole -> Finish -> regen) would silently wipe its baked sections.
//
// This suite PINS that the passthrough is present on the UPDATE path (not just
// the adoption path): the four snapshot fields (layers2d / sketches / loops /
// loopsVersion) survive a regen of an EXISTING model row. Mutation-proof: delete
// the passthrough block in buildModelBodyGeometry and these go RED (the fields
// come back undefined). The hazard was independently resolved upstream
// (fb410c5bc, SECTION-STALENESS work); this locks it so it cannot regress.

import { describe, it, expect } from 'vitest'
import {
  buildModelBodyGeometry,
  reconcileModelBodies,
  type DerivedModelBody,
  type LiveModelBody,
} from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry, Layer2D, Loop2D, ModelBodyDisplay } from '../../types'

type BakedSketch = NonNullable<ImportedGeometry['sketches']>[number]

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

const layer: Layer2D = {
  id: 'sec-1', name: 'Section', color: '#0ff', visible: true, sourceType: 'import',
  projectionPlane: { origin: { x: 0, y: 0, z: 3 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 } },
}
const loop: Loop2D = {
  id: 'lp-1', layerId: 'sec-1', closed: true, type: 'contour', area: 4,
  points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
}
const sketch = { id: 'sk-1', entities: [], constraints: [], dimensions: [] } as unknown as BakedSketch

/** An EXISTING model-body row carrying baked 2D snapshot data (the state after an
 *  imported STEP was wrapped, adopted, and then had a section/projection taken). */
function existingModelRowWithSections(): ImportedGeometry {
  return {
    id: 'modelbody:item-A:b1', name: 'Bracket', filename: 'Bracket', type: 'model', format: 'model',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'item-A',
    modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 }, display: display(0) },
    layers2d: [layer], sketches: [sketch], loops: [loop], loopsVersion: 7,
  }
}

describe('INT-IMPORT-EDIT stage 2: baked sections survive a model-body regen (UPDATE path)', () => {
  it('buildModelBodyGeometry carries layers2d/sketches/loops/loopsVersion from the existing row', () => {
    const existing = existingModelRowWithSections()
    const rebuilt = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1', 2, 5), existing, 'item-A')

    // The 3D body was refreshed (new version), but the baked 2D snapshots survive.
    expect(rebuilt.modelBody?.ref.version).toBe(2)
    expect(rebuilt.layers2d?.map((l) => l.id)).toEqual(['sec-1'])
    expect(rebuilt.sketches).toBe(existing.sketches)
    expect(rebuilt.loops?.map((l) => l.id)).toEqual(['lp-1'])
    expect(rebuilt.loopsVersion).toBe(7)
  })

  it('a full reconcile UPDATE (defeature -> Finish -> regen) keeps the sections on the same row', () => {
    const r = reconcileModelBodies([existingModelRowWithSections()], {
      live: [live('b1', 'Bracket')], derived: [derived('b1', 3, 9)], modelItemId: 'item-A',
    })
    expect(r.updated).toEqual(['b1'])
    expect(r.geometry).toHaveLength(1)
    const row = r.geometry[0]
    expect(row.id).toBe('modelbody:item-A:b1')            // same row (id continuity)
    expect(row.modelBody?.ref.version).toBe(3)            // body genuinely re-derived
    expect(row.layers2d?.map((l) => l.id)).toEqual(['sec-1'])  // sections NOT dropped
    expect(row.loops?.map((l) => l.id)).toEqual(['lp-1'])
    expect(row.loopsVersion).toBe(7)
  })

  it('a row with NO sections rebuilds without inventing empty snapshot fields', () => {
    const bare = existingModelRowWithSections()
    delete bare.layers2d
    delete bare.sketches
    delete bare.loops
    delete bare.loopsVersion
    const rebuilt = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1', 2), bare, 'item-A')
    expect(rebuilt.layers2d).toBeUndefined()
    expect(rebuilt.sketches).toBeUndefined()
    expect(rebuilt.loops).toBeUndefined()
    expect(rebuilt.loopsVersion).toBeUndefined()
  })
})
