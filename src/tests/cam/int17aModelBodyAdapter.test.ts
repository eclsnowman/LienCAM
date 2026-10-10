// INT-17A Stage 1 gate G1 (pure adapter): the body-to-CAM reconciliation and the
// stable BodyId -> entry-id map, exhaustively - add / update / delete / rename /
// keep / missing - plus the perf-critical changed-only selection (G3 invariant)
// and the identity-law SHAPE of a built entry (never occt-model identity).

import { describe, it, expect } from 'vitest'
import {
  modelBodyEntryId,
  isModelBodyEntry,
  buildModelBodyGeometry,
  adoptStepRowAsModelBody,
  reconcileModelBodies,
  repairDanglingModelBodyBindings,
  selectBodiesToDerive,
  findModelBodyGeometryRow,
  type DerivedModelBody,
  type LiveModelBody,
} from '../../lib/cam/modelBodyAdapter'
import type { ImportedGeometry, ModelBodyDisplay, Project } from '../../types'

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

function derived(bodyId: string, version = 1, tag = 0, lineageId?: string): DerivedModelBody {
  return { bodyId, lineageId, version, stableIds: [`${bodyId}:F0`, `${bodyId}:E0`], display: display(tag) }
}

function live(bodyId: string, name: string, lineageId?: string): LiveModelBody {
  return { bodyId, lineageId, name }
}

/** A non-model entry, to prove reconciliation never disturbs other geometry. */
function stlGeo(id: string): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

describe('INT-17A modelBodyAdapter - stable entry-id map', () => {
  it('derives a deterministic, stable entry id from the immutable bodyId', () => {
    expect(modelBodyEntryId('feat-7')).toBe('modelbody:feat-7')
    // The map IS the derivation: same body -> same id, every call.
    expect(modelBodyEntryId('feat-7')).toBe(modelBodyEntryId('feat-7'))
    expect(modelBodyEntryId('feat-7')).not.toBe(modelBodyEntryId('feat-8'))
  })

  it('builds an entry that rides Model-kernel identity ONLY, never occt-model', () => {
    const geo = buildModelBodyGeometry(live('b1', 'Bracket'), derived('b1'))
    expect(geo.format).toBe('model')
    expect(geo.type).toBe('model')
    expect(isModelBodyEntry(geo)).toBe(true)
    // The durable handle is the ElementMap identity (bodyId + stableIds), NOT an
    // occt BrepSelection {geoId,kind,index}.
    expect(geo.modelBody?.ref.bodyId).toBe('b1')
    expect(geo.modelBody?.ref.stableIds).toEqual(['b1:F0', 'b1:E0'])
    // A model entry carries NO 2D loops (so it can never satisfy the op-picker's
    // loops-based isSourceGeo) and is not a brep type.
    expect(geo.loops).toBeUndefined()
    expect(geo.type).not.toBe('brep')
  })
})

describe('INT-17A modelBodyAdapter - exhaustive reconcile paths', () => {
  it('ADD: a new live body with a derived payload appears as one entry', () => {
    const r = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1')] })
    expect(r.added).toEqual(['b1'])
    expect(r.geometry).toHaveLength(1)
    expect(r.geometry[0].id).toBe('modelbody:b1')
    expect(r.geometry[0].modelBody?.display?.positions[0]).toBe(0)
  })

  it('UPDATE: a re-derived body replaces display in place, SAME id, no churn', () => {
    const first = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1', 1, 0)] })
    const idBefore = first.geometry[0].id
    const second = reconcileModelBodies(first.geometry, {
      live: [live('b1', 'A')],
      derived: [derived('b1', 2, 9)],
    })
    expect(second.updated).toEqual(['b1'])
    expect(second.added).toEqual([])
    expect(second.geometry).toHaveLength(1)
    expect(second.geometry[0].id).toBe(idBefore)            // stable id across an edit
    expect(second.geometry[0].modelBody?.ref.version).toBe(2)
    expect(second.geometry[0].modelBody?.display?.positions[0]).toBe(9) // fresh payload
  })

  it('LOAD REPAIR: refuses an ambiguous lineage instead of guessing a body row', () => {
    const first = buildModelBodyGeometry(
      live('F8', 'Part A', 'F1'),
      derived('F8', 8, 0, 'F1'),
      undefined,
      'item-1',
    )
    const duplicate: ImportedGeometry = {
      ...buildModelBodyGeometry(
        live('F9', 'Part B', 'F1'),
        derived('F9', 9, 0, 'F1'),
        undefined,
        'item-1',
      ),
      id: 'modelbody:item-1:duplicate',
    }
    const project = {
      geometry: [first, duplicate],
      setups: [{
        id: 'setup-1',
        operations: [{ id: 'op-1', params: { geometryId: 'modelbody:item-1:F4' } }],
      }],
    } as unknown as Project

    const repaired = repairDanglingModelBodyBindings(project, [{
      modelItemId: 'item-1',
      lineageByBodyId: new Map([['F4', 'F1'], ['F8', 'F1'], ['F9', 'F1']]),
    }])

    expect(repaired.repairs).toEqual([])
    expect(repaired.project.setups[0].operations[0].params.geometryId)
      .toBe('modelbody:item-1:F4')
  })

  it('UPDATE: an appended feature changes the leaf but keeps the lineage row id', () => {
    const first = reconcileModelBodies([], {
      modelItemId: 'item-1',
      live: [live('F4', 'Part', 'F1')],
      derived: [derived('F4', 4, 0, 'F1')],
    })
    expect(first.geometry[0].id).toBe('modelbody:item-1:F1')

    const second = reconcileModelBodies(first.geometry, {
      modelItemId: 'item-1',
      live: [live('F8', 'Part', 'F1')],
      derived: [derived('F8', 8, 9, 'F1')],
    })

    expect(second.added).toEqual([])
    expect(second.removed).toEqual([])
    expect(second.updated).toEqual(['F8'])
    expect(second.geometry).toHaveLength(1)
    expect(second.geometry[0].id).toBe(first.geometry[0].id)
    expect(second.geometry[0].modelBody?.ref).toMatchObject({
      bodyId: 'F8',
      lineageId: 'F1',
      version: 8,
    })
  })

  it('RENAME: an unchanged (not re-derived) body updates its name, same id + display', () => {
    const first = reconcileModelBodies([], { live: [live('b1', 'Old')], derived: [derived('b1')] })
    const second = reconcileModelBodies(first.geometry, { live: [live('b1', 'New')], derived: [] })
    expect(second.updated).toEqual(['b1'])
    expect(second.geometry[0].id).toBe('modelbody:b1')
    expect(second.geometry[0].name).toBe('New')
    // display byte-identical (not re-derived): same object reference is preserved.
    expect(second.geometry[0].modelBody?.display).toBe(first.geometry[0].modelBody?.display)
  })

  it('KEEP: an unchanged body with the same name is byte-identical (no update)', () => {
    const first = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1')] })
    const second = reconcileModelBodies(first.geometry, { live: [live('b1', 'A')], derived: [] })
    expect(second.updated).toEqual([])
    expect(second.geometry[0]).toBe(first.geometry[0])   // same reference, no churn
  })

  it('DELETE: a body no longer live drops its entry loudly (returned in removed)', () => {
    const first = reconcileModelBodies([], {
      live: [live('b1', 'A'), live('b2', 'B')],
      derived: [derived('b1'), derived('b2')],
    })
    const second = reconcileModelBodies(first.geometry, { live: [live('b1', 'A')], derived: [] })
    expect(second.removed).toEqual(['b2'])
    expect(second.geometry.map((g) => g.modelBody?.ref.bodyId)).toEqual(['b1'])
  })

  it('DELETE-then-recreate-same-NAME keys on bodyId, never the mutable name', () => {
    // Delete "Bracket" (b1), create an unrelated body ALSO named "Bracket" (b2).
    const first = reconcileModelBodies([], { live: [live('b1', 'Bracket')], derived: [derived('b1')] })
    const second = reconcileModelBodies(first.geometry, {
      live: [live('b2', 'Bracket')],
      derived: [derived('b2')],
    })
    expect(second.removed).toEqual(['b1'])
    expect(second.added).toEqual(['b2'])
    expect(second.geometry).toHaveLength(1)
    expect(second.geometry[0].id).toBe('modelbody:b2')      // NOT conflated with b1
  })

  it('MISSING: a live body with no entry AND no derived payload is surfaced, not dropped silently', () => {
    const r = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [] })
    expect(r.missing).toEqual(['b1'])
    expect(r.geometry).toHaveLength(0)   // cannot draw it, but it is REPORTED
  })

  it('preserves non-model geometry in place and in order', () => {
    const current: ImportedGeometry[] = [stlGeo('s1'), stlGeo('s2')]
    const r = reconcileModelBodies(current, { live: [live('b1', 'A')], derived: [derived('b1')] })
    expect(r.geometry.map((g) => g.id)).toEqual(['s1', 's2', 'modelbody:b1'])
    expect(r.geometry[0]).toBe(current[0])   // untouched references
    expect(r.geometry[1]).toBe(current[1])
  })

  it('preserves user visibility/color across a re-derive', () => {
    const first = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1')] })
    const hidden = { ...first.geometry[0], hidden: true, color: '#abcdef' }
    const second = reconcileModelBodies([hidden], { live: [live('b1', 'A')], derived: [derived('b1', 2)] })
    expect(second.geometry[0].hidden).toBe(true)
    expect(second.geometry[0].color).toBe('#abcdef')
  })
})

describe('INT-17A selectBodiesToDerive - changed-only invariant (G3)', () => {
  it('re-derives ONLY the changed body among many - independent of total count', () => {
    const liveIds = Array.from({ length: 24 }, (_, i) => `b${i}`)
    const existing = new Set(liveIds)                 // all already have entries
    const chosen = selectBodiesToDerive(liveIds, ['b7'], existing)
    // CAN-FAIL: a "re-derive all" regression would return 24 here.
    expect(chosen).toEqual(['b7'])
    expect(chosen.length).toBe(1)
  })

  it('re-derives every body that has no entry yet (first surfacing)', () => {
    const liveIds = ['b0', 'b1', 'b2']
    const chosen = selectBodiesToDerive(liveIds, [], new Set())
    expect(chosen).toEqual(['b0', 'b1', 'b2'])
  })

  it('re-derives a changed body even when it already has an entry', () => {
    const chosen = selectBodiesToDerive(['b0', 'b1'], ['b0'], new Set(['b0', 'b1']))
    expect(chosen).toEqual(['b0'])
  })
})

// NAV-BODY-ROW: the forward lookup ("given a body, which CAM row") the nav
// paths (Feature Tree body row -> CAM Geometry row) use instead of
// re-deriving the modelbody:<bodyId> id shape by hand.
describe('NAV-BODY-ROW findModelBodyGeometryRow - forward lookup', () => {
  it('finds the legacy-scope row for a live body (undefined modelItemId)', () => {
    const r = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1')] })
    const found = findModelBodyGeometryRow(r.geometry, 'b1')
    expect(found?.id).toBe('modelbody:b1')
  })

  it('is undefined for a body with no live CAM row yet (unsynced body)', () => {
    const r = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1')] })
    expect(findModelBodyGeometryRow(r.geometry, 'never-synced')).toBeUndefined()
  })

  it('scopes by modelItemId exactly like reconcileModelBodies itself -- two items, same raw bodyId, never cross-resolved', () => {
    const itemA = reconcileModelBodies([], { live: [live('b1', 'A')], derived: [derived('b1')], modelItemId: 'item-a' })
    const itemB = reconcileModelBodies(itemA.geometry, { live: [live('b1', 'B')], derived: [derived('b1', 1, 1)], modelItemId: 'item-b' })
    const foundA = findModelBodyGeometryRow(itemB.geometry, 'b1', 'item-a')
    const foundB = findModelBodyGeometryRow(itemB.geometry, 'b1', 'item-b')
    expect(foundA?.id).not.toBe(foundB?.id)
    expect(foundA?.name).toBe('A')
    expect(foundB?.name).toBe('B')
    // 'legacy' (the explicit LEGACY_MODEL_ITEM_ID string, e.g. what a caller
    // defaulting modelItemId to the constant would pass) resolves nothing --
    // neither item is the legacy scope.
    expect(findModelBodyGeometryRow(itemB.geometry, 'b1', 'legacy')).toBeUndefined()
  })

  it('resolves a GEO-UNIFY Stage 4 adopted body by its ORIGINAL (preserved) row id, not the modelbody: shape', () => {
    const stepRow: ImportedGeometry = {
      ...stlGeo('step-import-42'), format: 'step', type: 'brep',
    }
    const adopted = adoptStepRowAsModelBody(live('leaf-9', 'Bracket'), derived('leaf-9'), stepRow)
    const geometry = [adopted]
    // The adopted row's id is the ORIGINAL STEP row's id, verbatim -- NOT modelBodyEntryId('leaf-9').
    expect(adopted.id).toBe('step-import-42')
    expect(modelBodyEntryId('leaf-9')).not.toBe('step-import-42')
    const found = findModelBodyGeometryRow(geometry, 'leaf-9')
    expect(found?.id).toBe('step-import-42')
  })
})
