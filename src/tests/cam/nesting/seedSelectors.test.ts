import { describe, it, expect } from 'vitest'
import {
  seedGeometryIds,
  isSeedGeometry,
  seedPlacementIds,
  nestOwnedGeometryIds,
  visibleSeedLoops,
} from '../../../lib/cam/nesting/seedSelectors'
import type { ImportedGeometry, NestRecord } from '../../../types'
import type { Placement } from '../../../lib/cam/nesting/types'

// Pure seed-detection contract (ADR 0025 §2). A geometry is a seed iff some nest
// references it as a source. "Is a seed" is BINARY across the whole project.

/** Minimal NestRecord with just the fields the selector reads (sources[]). The
 *  rest is filled with inert values so the literal type-checks as a NestRecord. */
function nest(id: string, sourceIds: string[]): NestRecord {
  return {
    id,
    name: id,
    sheet: { width: 100, height: 100 },
    style: 'ninety',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources: sourceIds.map((geometryId) => ({ geometryId, quantity: 1 })),
    placements: [],
    unplaced: [],
    utilization: 0,
  }
}

/** A placement literal with inert pose defaults; only the fields under test are
 *  required. */
function placement(p: Partial<Placement> & { partId: string; instanceId: string }): Placement {
  return { x: 0, y: 0, rotationDeg: 0, depth: 0, ...p }
}

/** A NestRecord carrying explicit placements (and optionally owned sources). */
function nestWith(
  id: string,
  placements: Placement[],
  sources?: NestRecord['sources'],
): NestRecord {
  const base = nest(id, [])
  return { ...base, placements, sources: sources ?? base.sources }
}

describe('seedGeometryIds / isSeedGeometry (ADR 0025 §2)', () => {
  it('returns an empty set when the project has no nests', () => {
    expect(seedGeometryIds({}).size).toBe(0)
    expect(seedGeometryIds({ nests: [] }).size).toBe(0)
    expect(isSeedGeometry({}, 'g1')).toBe(false)
  })

  it('marks a geometry referenced by a nest as a seed, and an unreferenced one as not', () => {
    const project = { nests: [nest('n1', ['g-seed'])] }
    const seeds = seedGeometryIds(project)
    expect(seeds.has('g-seed')).toBe(true)
    expect(seeds.has('g-other')).toBe(false)
    expect(isSeedGeometry(project, 'g-seed')).toBe(true)
    expect(isSeedGeometry(project, 'g-other')).toBe(false)
  })

  it('is BINARY across multiple nests (a geometry in any nest is a seed; dedups)', () => {
    const project = {
      nests: [
        nest('n1', ['g-a', 'g-b']),
        nest('n2', ['g-b', 'g-c']), // g-b appears in both nests
      ],
    }
    const seeds = seedGeometryIds(project)
    // g-b is referenced twice but appears once (Set dedup), and every referenced
    // id across all nests is a seed.
    expect([...seeds].sort()).toEqual(['g-a', 'g-b', 'g-c'])
    expect(isSeedGeometry(project, 'g-b')).toBe(true)
    // A geometry referenced by no nest is not a seed.
    expect(isSeedGeometry(project, 'g-z')).toBe(false)
  })
})

describe('seedPlacementIds (lower-left seed per partId)', () => {
  it('returns an empty set when there are no placements', () => {
    expect(seedPlacementIds(nestWith('n1', [])).size).toBe(0)
  })

  it('picks the min-(x+y) placement within a single partId group', () => {
    const n = nestWith('n1', [
      placement({ partId: 'A', instanceId: 'a-far', x: 50, y: 50 }),
      placement({ partId: 'A', instanceId: 'a-seed', x: 5, y: 5 }), // min x+y = 10
      placement({ partId: 'A', instanceId: 'a-mid', x: 20, y: 0 }), // x+y = 20
    ])
    const seeds = seedPlacementIds(n)
    expect([...seeds]).toEqual(['a-seed'])
  })

  it('yields exactly one seed per distinct partId across a multi-source nest', () => {
    const n = nestWith('n1', [
      placement({ partId: 'A', instanceId: 'a1', x: 100, y: 100 }),
      placement({ partId: 'A', instanceId: 'a2', x: 1, y: 1 }), // seed of A
      placement({ partId: 'B', instanceId: 'b1', x: 9, y: 9 }),
      placement({ partId: 'B', instanceId: 'b2', x: 2, y: 2 }), // seed of B
    ])
    const seeds = seedPlacementIds(n)
    expect([...seeds].sort()).toEqual(['a2', 'b2'])
  })

  it('applies the deterministic tie-break order x+y, then x, then y, then instanceId', () => {
    // (1) x+y ties (10): the one with smaller x wins.
    expect([
      ...seedPlacementIds(
        nestWith('t1', [
          placement({ partId: 'A', instanceId: 'big-x', x: 7, y: 3 }),
          placement({ partId: 'A', instanceId: 'small-x', x: 2, y: 8 }),
        ]),
      ),
    ]).toEqual(['small-x'])

    // (2) x+y ties and x ties: smaller y wins.
    expect([
      ...seedPlacementIds(
        nestWith('t2', [
          placement({ partId: 'A', instanceId: 'hi-y', x: 5, y: 7 }), // sum 12
          placement({ partId: 'A', instanceId: 'lo-y', x: 5, y: 3 }), // sum 8 -> wins on sum
        ]),
      ),
    ]).toEqual(['lo-y'])

    // (3) x+y, x, y all tie: lexicographically-smaller instanceId wins.
    expect([
      ...seedPlacementIds(
        nestWith('t3', [
          placement({ partId: 'A', instanceId: 'zzz', x: 4, y: 6 }),
          placement({ partId: 'A', instanceId: 'aaa', x: 4, y: 6 }),
        ]),
      ),
    ]).toEqual(['aaa'])
  })
})

describe('nestOwnedGeometryIds (geometries with ownerNestId set)', () => {
  // Minimal geometry literal: only id + ownerNestId matter to the selector.
  const geo = (id: string, ownerNestId?: string): ImportedGeometry =>
    ({ id, ownerNestId } as ImportedGeometry)

  it('returns only geometries whose ownerNestId is set; ignores undefined', () => {
    const project = {
      geometry: [
        geo('g-owned', 'n1'),
        geo('g-pre'), // ownerNestId undefined -> a workspace part
        geo('g-owned2', 'n2'),
      ],
    }
    const owned = nestOwnedGeometryIds(project)
    expect([...owned].sort()).toEqual(['g-owned', 'g-owned2'])
    expect(owned.has('g-pre')).toBe(false)
  })

  it('returns an empty set with no geometry', () => {
    expect(nestOwnedGeometryIds({}).size).toBe(0)
    expect(nestOwnedGeometryIds({ geometry: [] }).size).toBe(0)
  })
})

describe('visibleSeedLoops (seed-slot per-layer visibility filter)', () => {
  const loop = (id: string, layerId: string) => ({ id, layerId })

  it('keeps loops on visible layers and drops loops on hidden layers', () => {
    const loops = [loop('l1', 'A'), loop('l2', 'B'), loop('l3', 'A')]
    const layers = [{ id: 'A', visible: true }, { id: 'B', visible: false }]
    expect(visibleSeedLoops(loops, layers).map(l => l.id)).toEqual(['l1', 'l3'])
  })

  it('keeps every loop when all layers are visible', () => {
    const loops = [loop('l1', 'A'), loop('l2', 'B')]
    const layers = [{ id: 'A', visible: true }, { id: 'B', visible: true }]
    expect(visibleSeedLoops(loops, layers).map(l => l.id)).toEqual(['l1', 'l2'])
  })

  it('drops every loop when all layers are hidden', () => {
    const loops = [loop('l1', 'A'), loop('l2', 'B')]
    const layers = [{ id: 'A', visible: false }, { id: 'B', visible: false }]
    expect(visibleSeedLoops(loops, layers)).toEqual([])
  })

  it('keeps a loop whose layerId has no matching layer (unknown == visible)', () => {
    const loops = [loop('l1', 'ghost')]
    const layers = [{ id: 'A', visible: false }]
    expect(visibleSeedLoops(loops, layers).map(l => l.id)).toEqual(['l1'])
  })
})
