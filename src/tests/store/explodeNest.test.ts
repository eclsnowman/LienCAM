// explodeNest store action (N1c, classic CAD explode; ADR 0024 instance transform,
// ADR 0025 §2 deep-copy owned-seed model). Proves the STORE STATE LOGIC + the
// viewport-paint seam. The seeds a nest explodes are now its OWNED SEEDS
// (ImportedGeometry.ownerNestId === the nest id), so explode absorbs by
// ownerNestId (mirrors removeNest), not by a shared-source ref count.
//
// Coverage:
//  - each placement becomes its OWN independent root ImportedGeometry at its
//    packed pose (transformed loop points match M(p) = translate(x,y).rotate(deg))
//    with ownerNestId UNSET (a free root part, not owned by any nest);
//  - the owned seed (ownerNestId === nestId) is ABSORBED (removed);
//  - the nest record is gone from project.nests;
//  - the viewport add2DGeometry seam is invoked once per baked copy;
//  - a single undo restores the pre-explode state (one history entry pushed);
//  - selectedNestId is cleared if it pointed at the exploded nest.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D } from '../../types'
import type { NestRecord } from '../../types'

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

// An OWNED SEED geometry (ownerNestId set) — what a nest deep-copies and explodes.
function makeSeed(id: string, side: number, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
    layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
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

describe('explodeNest (N1c, owned-seed model)', () => {
  it('replaces N placements with N independent root geometries (ownerNestId UNSET)', () => {
    const seed = makeSeed('g1', 10, 'n1')
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'g1', instanceId: 'g1#1', x: 50, y: 20, rotationDeg: 90, depth: 0 },
      { partId: 'g1', instanceId: 'g1#2', x: 5, y: 80, rotationDeg: 180, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'g1', placements)])

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    // (a) Three new geometries; the absorbed owned seed 'g1' is gone -> exactly 3.
    expect(st.project.geometry.length).toBe(3)
    expect(st.project.geometry.some((g) => g.id === 'g1')).toBe(false)

    // (a cont.) Every baked copy is a FREE ROOT part: no ownerNestId, no folder,
    // a fresh uuid (not the seed's id).
    for (const g of st.project.geometry) {
      expect(g.ownerNestId).toBeUndefined()
      expect(g.folderId).toBeUndefined()
      expect(g.id).not.toBe('g1')
    }

    // Names increment across the source's placements.
    const names = st.project.geometry.map((g) => g.name).sort()
    expect(names).toEqual(['Part g1 1', 'Part g1 2', 'Part g1 3'])

    // (a cont.) Transformed point check for the rotated/translated placements.
    // The square's vertex (10,0) under each placement's M(p).
    for (const pl of placements) {
      const expected = applyM({ x: 10, y: 0 }, pl.rotationDeg, pl.x, pl.y)
      const hit = st.project.geometry.some((g) =>
        (g.loops ?? []).some((l) =>
          l.points.some((p) =>
            Math.abs(p.x - expected.x) < 1e-6 && Math.abs(p.y - expected.y) < 1e-6,
          ),
        ),
      )
      expect(hit).toBe(true)
    }

    // (c) The nest record is gone.
    expect((st.project.nests ?? []).some((n) => n.id === 'n1')).toBe(false)
  })

  it('absorbs the owned seed (ownerNestId === nestId) and leaves a pre-existing original alone', () => {
    const seed = makeSeed('g1', 10, 'n1')
    // A pre-existing workspace original (NO ownerNestId) -> must survive explode.
    const pre = makeSeed('g-pre', 12, 'n1')
    delete (pre as { ownerNestId?: string }).ownerNestId
    const pls: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed, pre], [makeNest('n1', 'g1', pls)])

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    // The owned seed is absorbed; the pre-existing original survives; one copy added.
    expect(st.project.geometry.some((g) => g.id === 'g1')).toBe(false)
    expect(st.project.geometry.some((g) => g.id === 'g-pre')).toBe(true)
    expect(st.project.geometry.length).toBe(2) // g-pre + one baked copy
  })

  describe('viewport paint seam', () => {
    let added: Array<{ id: string; loops: unknown; layers: unknown }>

    beforeEach(() => {
      added = []
      vi.stubGlobal('window', {
        __cncViewport: {
          add2DGeometry: (id: string, loops: unknown, layers: unknown) => {
            added.push({ id, loops, layers })
          },
          // Teardown seams the explode also reaches for — no-ops here.
          removeNestInstances: () => {},
          remove2DGeometry: () => {},
          removeSTL: () => {},
          removeBrepModel: () => {},
        },
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('invokes add2DGeometry once per baked copy (BUG P6 render fix)', () => {
      const seed = makeSeed('g1', 10, 'n1')
      const placements: NestRecord['placements'] = [
        { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
        { partId: 'g1', instanceId: 'g1#1', x: 50, y: 20, rotationDeg: 90, depth: 0 },
      ]
      installProject([seed], [makeNest('n1', 'g1', placements)])

      useCamStore.getState().explodeNest('n1')
      const st = useCamStore.getState()

      // One paint call per new baked copy, each keyed by the new geometry id.
      expect(added.length).toBe(2)
      const paintedIds = added.map((a) => a.id).sort()
      const geoIds = st.project.geometry.map((g) => g.id).sort()
      expect(paintedIds).toEqual(geoIds)
    })
  })

  it('single undo restores the pre-explode state', () => {
    const seed = makeSeed('g1', 10, 'n1')
    const pls: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'g1', instanceId: 'g1#1', x: 30, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'g1', pls)])

    const histBefore = useCamStore.getState().projectHistory.length
    useCamStore.getState().explodeNest('n1')
    // Exactly one history entry pushed by the whole explode.
    expect(useCamStore.getState().projectHistory.length).toBe(histBefore + 1)

    useCamStore.getState().undo()
    const st = useCamStore.getState()
    // The owned seed + the nest are back; the baked copies are gone.
    expect(st.project.geometry.length).toBe(1)
    expect(st.project.geometry[0].id).toBe('g1')
    expect(st.project.geometry[0].ownerNestId).toBe('n1')
    expect((st.project.nests ?? []).map((n) => n.id)).toEqual(['n1'])
  })

  it('clears selectedNestId if it pointed at the exploded nest', () => {
    const seed = makeSeed('g1', 10, 'n1')
    const pls: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([seed], [makeNest('n1', 'g1', pls)])
    useCamStore.setState((s) => ({ viewer: { ...s.viewer, selectedNestId: 'n1' } }))

    useCamStore.getState().explodeNest('n1')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })
})
