// WO-1526 / BUG-533: exploding a nest whose seed is a Model-workbench-derived
// source (ImportedGeometry.format === 'model', carrying a durable `modelBody`
// kernel handle) must not leave the ORIGINAL untransformed 3D body glued to
// the baked 2D copy. explodeNest's copy-construction spread (src/store/
// index.ts) was written for ordinary 2D-loop sources (svg/dxf/sketch) and
// never cleared the model-only fields (`modelBody`, `modelItemId`,
// `pendingModelItemId`) or flipped `type`/`format` away from 'model' -- so a
// model-derived exploded copy kept format:'model' (still MODEL-labelled in
// the DesignTree) and the source's own modelBody (describing the ORIGINAL,
// untransformed pose) sitting beside baked 2D loops at a DIFFERENT pose.
//
// Coverage:
//  - the exploded copy of a model-derived source sheds format/type/modelBody/
//    modelItemId/pendingModelItemId and bakes its loops at the placement's pose;
//  - every placement is desanitized, not just the first (perSourceCount loop);
//  - the consistent shape survives a project-persist round trip;
//  - undo restores the original model-backed seed exactly (no regression to
//    explode's existing undo contract);
//  - an svg/dxf-sourced nest's explode output is unchanged (no regression to
//    the working non-model path).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, BoundingBox, Vec3, Loop2D, NestRecord, ModelBody,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A closed square loop of side `s` with its lower-left at the origin.
function squareLoop(id: string, s: number): Loop2D {
  return {
    id, layerId: 'L', closed: true, type: 'contour', area: s * s,
    points: [
      { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
    ],
  }
}

const MODEL_BODY: ModelBody = {
  ref: { bodyId: 'body-1', lineageId: 'body-1', stableIds: ['s1'], version: 1 },
  display: undefined,
}

// A Model-workbench-derived OWNED SEED (ownerNestId set): format 'model'
// carrying the durable kernel handle (modelBody) plus the baked section loops
// a nest built from a Model body deep-copies and explodes -- BUG-533's shared
// cause. pendingModelItemId is not a realistic combination on a live 'model'
// row (it belongs to a still-'step' row awaiting adoption), but the spread
// explodeNest builds from copies EVERY field present on the seed, so it must
// be cleared here too if a stale/legacy row carries one.
function makeModelSeed(id: string, side: number, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Body ${id}`, filename: `Body ${id}`, type: 'model', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
    layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
    modelBody: MODEL_BODY,
    modelItemId: 'item-1',
    pendingModelItemId: 'pending-1',
    ownerNestId,
  } as ImportedGeometry
}

// Build a NestRecord whose sources/placements reference the owned seed id.
function makeNest(id: string, seedId: string, placements: NestRecord['placements']): NestRecord {
  return {
    id, name: `Nest ${id}`,
    sheet: { width: 200, height: 200 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources: [{ geometryId: seedId, quantity: placements.length }],
    placements,
    unplaced: [],
    utilization: 0.5,
  }
}

function installProject(geometry: ImportedGeometry[], nests: NestRecord[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests,
      setups: [],
      stocks: undefined,
    },
    projectHistory: [],
    canUndo: false,
  }))
}

// M(p): translate(x,y) . rotate(deg). Mirrors the store's transform.
function applyM(pt: { x: number; y: number }, deg: number, dx: number, dy: number) {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad), sn = Math.sin(rad)
  return { x: pt.x * c - pt.y * sn + dx, y: pt.x * sn + pt.y * c + dy }
}

beforeEach(() => {
  useCamStore.getState().newProject()
})

describe('explodeNest on a model-derived source (WO-1526 / BUG-533)', () => {
  it('sheds format/type/modelBody/modelItemId/pendingModelItemId and bakes the placement pose', () => {
    const seed = makeModelSeed('m1', 10, 'n1')
    const placements: NestRecord['placements'] = [
      { partId: 'm1', instanceId: 'm1#0', x: 50, y: 20, rotationDeg: 90, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'm1', placements)])

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    expect(st.project.geometry.length).toBe(1)
    const copy = st.project.geometry[0]

    // Acceptance 1: one consistent 2D-baked representation, no model handle or
    // Model-Item ownership riding along beside the freshly baked loops.
    expect(copy.format).not.toBe('model')
    expect(copy.type).not.toBe('model')
    expect(copy.modelBody).toBeUndefined()
    expect(copy.modelItemId).toBeUndefined()
    expect(copy.pendingModelItemId).toBeUndefined()
    expect(copy.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(copy.rotation).toEqual({ x: 0, y: 0, z: 0 })

    // The baked loops carry the PLACEMENT's transform, not the identity pose a
    // surviving `modelBody`/original position would otherwise describe:
    // square vertex (10,0) under rotate(90).translate(50,20).
    const expected = applyM({ x: 10, y: 0 }, 90, 50, 20)
    const hit = (copy.loops ?? []).some((l) =>
      l.points.some((p) => Math.abs(p.x - expected.x) < 1e-6 && Math.abs(p.y - expected.y) < 1e-6),
    )
    expect(hit).toBe(true)
  })

  it('desanitizes every placement of a model-derived source, not just the first', () => {
    const seed = makeModelSeed('m1', 10, 'n1')
    const placements: NestRecord['placements'] = [
      { partId: 'm1', instanceId: 'm1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'm1', instanceId: 'm1#1', x: 30, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'm1', instanceId: 'm1#2', x: 60, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'm1', placements)])

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    expect(st.project.geometry.length).toBe(3)
    for (const g of st.project.geometry) {
      expect(g.format).not.toBe('model')
      expect(g.type).not.toBe('model')
      expect(g.modelBody).toBeUndefined()
      expect(g.modelItemId).toBeUndefined()
      expect(g.pendingModelItemId).toBeUndefined()
    }
  })

  it('survives a project-persist round trip with the same consistent shape', () => {
    const seed = makeModelSeed('m1', 10, 'n1')
    const placements: NestRecord['placements'] = [
      { partId: 'm1', instanceId: 'm1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'm1', placements)])
    useCamStore.getState().explodeNest('n1')

    // Plain-data round trip (mirrors the JSON.stringify/JSON.parse pattern this
    // suite already uses to prove persistence -- e.g. sketchBakeBoundingBox,
    // projectMigration): explode's field set is ordinary JSON, so a store
    // save/reopen cannot resurrect a field the copy never carried.
    const before = useCamStore.getState().project.geometry[0]
    const after = JSON.parse(JSON.stringify(before)) as ImportedGeometry

    expect(after.format).not.toBe('model')
    expect(after.type).not.toBe('model')
    expect(after.modelBody).toBeUndefined()
    expect(after.modelItemId).toBeUndefined()
    expect(after.pendingModelItemId).toBeUndefined()
  })

  it('undo after explode restores the original model-backed seed exactly', () => {
    const seed = makeModelSeed('m1', 10, 'n1')
    const placements: NestRecord['placements'] = [
      { partId: 'm1', instanceId: 'm1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'm1', placements)])

    useCamStore.getState().explodeNest('n1')
    useCamStore.getState().undo()
    const st = useCamStore.getState()

    expect(st.project.geometry.length).toBe(1)
    const restored = st.project.geometry[0]
    expect(restored.id).toBe('m1')
    expect(restored.format).toBe('model')
    expect(restored.type).toBe('model')
    expect(restored.modelBody).toEqual(MODEL_BODY)
    expect(restored.modelItemId).toBe('item-1')
    expect(restored.pendingModelItemId).toBe('pending-1')
    expect((st.project.nests ?? []).map((n) => n.id)).toEqual(['n1'])
  })

  it('an svg/dxf-sourced nest explode is unchanged (no regression to the working path)', () => {
    const seed: ImportedGeometry = {
      id: 'g1', name: 'Part g1', filename: 'g1.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      loops: [squareLoop('g1-outer', 10)],
      layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
      ownerNestId: 'n1',
    } as ImportedGeometry
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'g1', placements)])

    useCamStore.getState().explodeNest('n1')
    const copy = useCamStore.getState().project.geometry[0]

    // Byte-identical field set to today: still a plain dxf-sourced 2D copy.
    expect(copy.type).toBe('curves_2d')
    expect(copy.format).toBe('dxf')
  })
})
