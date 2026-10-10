// C2: persistent construction "defining geometry" for the generated shape
// tools. This is the HARD gate against the SHARED planegcs solver (ADR-0003
// fail-loud): for every generated tool we prove
//   (a) the cut Loop2D is BYTE-IDENTICAL with vs without the defining geometry
//       (bake excludes construction + points), and
//   (b) the freshly-created tool still SOLVES cleanly -- no FALSE conflict, and
//       the defining ties add NO redundancy beyond the cut geometry's own.
//
// Builders are called directly with a deterministic id factory; the solve runs
// on a real GcsWrapper in node, exactly like solver.test.ts.

import { describe, it, expect } from 'vitest'
import { buildRectCommit, buildRotatedRectCommit } from '../../lib/sketch/tools/rectTools'
import {
  buildPolygonCommit, buildSlotCommit, buildArcSlotCommit,
} from '../../lib/sketch/tools/polygonSlotTools'
import { bakeSketch } from '../../lib/sketch/bake'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { constraintRefIds } from '../../lib/sketch/refIds'
import type {
  Sketch, SketchEntity, SketchConstraint,
} from '../../lib/sketch/types'

const TOL = 0.5
const LAYER = 'c2-layer'

function idFactory(): () => string {
  let n = 0
  return () => `id${n++}`
}

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return {
    id: 'sk', layerId: LAYER, entities, constraints, dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

/** Drop the construction defining geometry (construction entities + bare
 *  points) and any constraint that references it -> the pre-C2 cut geometry. */
function cutOnly(commit: { entities: SketchEntity[]; constraints: SketchConstraint[] }) {
  const entities = commit.entities.filter((e) => !e.construction && e.kind !== 'point')
  const keep = new Set(entities.map((e) => e.id))
  const constraints = commit.constraints.filter((c) =>
    constraintRefIds(c).every((id) => keep.has(id)))
  return { entities, constraints }
}

interface ToolCase {
  name: string
  build: () => { entities: SketchEntity[]; constraints: SketchConstraint[] }
  /** Defining ENTITIES the builder appends (construction + points). */
  definingEntities: number
}

const cases: ToolCase[] = [
  {
    name: 'rect',
    build: () => buildRectCommit({ x: 0, y: 0 }, { x: 40, y: 25 }, false, idFactory()),
    definingEntities: 2, // D1: center point + construction diagonal
  },
  {
    name: 'polygon',
    build: () => buildPolygonCommit({ x: 0, y: 0 }, { x: 12, y: 0 }, 6, false, idFactory()),
    definingEntities: 1, // dimensionable construction reference circle
  },
  {
    name: 'slot',
    build: () => buildSlotCommit({ x: 0, y: 0 }, { x: 30, y: 0 }, 6, false, idFactory()),
    definingEntities: 3, // 2 cap points + centerline line
  },
  {
    name: 'arc-slot',
    build: () => buildArcSlotCommit(
      { x: 10, y: 0 }, { x: 0, y: 10 },
      { x: Math.SQRT1_2 * 10, y: Math.SQRT1_2 * 10 }, 2, TOL, false, idFactory(),
    )!,
    definingEntities: 4, // 2 cap points + centerline arc + WO-1465 half-width line
  },
]

describe('C2 defining geometry: cut Loop2D is unchanged', () => {
  for (const tc of cases) {
    it(`${tc.name}: bake with vs without defining geometry is identical`, () => {
      const commit = tc.build()
      const cut = cutOnly(commit)

      // Same loop-id factory for both bakes so ids match and a deep compare
      // reflects ONLY geometry/typing differences.
      const full = bakeSketch(sketchOf(commit.entities, commit.constraints), { newId: idFactory() })
      const cutBake = bakeSketch(sketchOf(cut.entities, cut.constraints), { newId: idFactory() })

      expect(full.loops).toEqual(cutBake.loops)
      expect(full.bakedEntities).toBe(cutBake.bakedEntities)
      // Every defining entity is EXCLUDED (construction + points never bake).
      expect(full.excludedEntities).toBe(cutBake.excludedEntities + tc.definingEntities)
    })
  }
})

describe('C2 defining geometry: solve stays clean (no false conflict, no new redundancy)', () => {
  for (const tc of cases) {
    it(`${tc.name}: solves ok, conflicting empty, redundancy not increased`, async () => {
      const gcs = await createGcsWrapper()
      try {
        const commit = tc.build()
        const cut = cutOnly(commit)

        const baseline = solveSketchOnWrapper(gcs, sketchOf(cut.entities, cut.constraints))
        expect(baseline.ok).toBe(true)
        if (!baseline.ok) return
        expect(baseline.status.conflicting).toEqual([])

        const out = solveSketchOnWrapper(gcs, sketchOf(commit.entities, commit.constraints))
        // (a) NO false conflict: a freshly-built tool always converges.
        expect(out.ok).toBe(true)
        if (!out.ok) return
        // (b) FAIL-LOUD preserved: empty conflicting set.
        expect(out.status.conflicting).toEqual([])
        // (c) The defining ties add NO redundancy beyond the cut geometry's own.
        expect(out.status.redundant.length).toBeLessThanOrEqual(baseline.status.redundant.length)
      } finally {
        gcs.destroy_gcs_module()
      }
    })
  }
})

// D1: the rect center is TIED (construction diagonal + midpoint) so it TRACKS
// corner edits. These solve on a real GcsWrapper.
describe('D1 rect center: tied, DoF-neutral, and tracks edits', () => {
  // The tie invariant: after ANY solve the construction center sits exactly at
  // the midpoint of the two opposite corners it is diagonal-tied to. Those are
  // corners[0] (lines[0].start) and corners[2] (lines[2].start) in both builders.
  function assertCenterAtMidpoint(entities: SketchEntity[]) {
    const lines = entities.filter(
      (e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line' && !e.construction,
    )
    const center = entities.find(
      (e): e is Extract<SketchEntity, { kind: 'point' }> => e.kind === 'point',
    )!
    const c0 = lines[0].start
    const c2 = lines[2].start
    expect(center.at.x).toBeCloseTo((c0.x + c2.x) / 2, 6)
    expect(center.at.y).toBeCloseTo((c0.y + c2.y) / 2, 6)
    return { center, c0, c2 }
  }

  const builders: { name: string; build: () => { entities: SketchEntity[]; constraints: SketchConstraint[] } }[] = [
    {
      name: 'axis-aligned',
      build: () => buildRectCommit({ x: 0, y: 0 }, { x: 40, y: 25 }, false, idFactory()),
    },
    {
      name: 'rotated',
      build: () => buildRotatedRectCommit(
        { x: 0, y: 0 }, { x: 30, y: 40 }, { x: -20, y: 15 }, false, idFactory(),
      ),
    },
  ]

  for (const b of builders) {
    it(`${b.name}: solves clean, center at true geometric center, DoF unchanged by the tie`, async () => {
      const gcs = await createGcsWrapper()
      try {
        const commit = b.build()
        const full = sketchOf(commit.entities, commit.constraints)
        const cut = cutOnly(commit)

        const baseline = solveSketchOnWrapper(gcs, sketchOf(cut.entities, cut.constraints))
        const out = solveSketchOnWrapper(gcs, full)
        expect(out.ok).toBe(true)
        if (!out.ok || !baseline.ok) return
        expect(out.status.conflicting).toEqual([])
        // DoF-NEUTRAL: the tie (diagonal + midpoint) changes remaining DoF by 0.
        expect(out.status.dof).toBe(baseline.status.dof)
        // Center lands on the true geometric center of the built rectangle.
        assertCenterAtMidpoint(out.entities)
      } finally {
        gcs.destroy_gcs_module()
      }
    })

    it(`${b.name}: center TRACKS a corner edit (re-solves to the new center)`, async () => {
      const gcs = await createGcsWrapper()
      try {
        const commit = b.build()
        const full = sketchOf(commit.entities, commit.constraints)

        const before = solveSketchOnWrapper(gcs, full)
        expect(before.ok).toBe(true)
        if (!before.ok) return
        const built = assertCenterAtMidpoint(before.entities)

        // Drag corner[2] (lines[2].start) far from where it was drawn. The
        // dragged sketch carries the solved geometry so ids line up.
        const solved = sketchOf(before.entities, commit.constraints)
        const lines = before.entities.filter(
          (e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line' && !e.construction,
        )
        const target = { x: built.c2.x + 30, y: built.c2.y - 18 }
        const dragged = solveSketchOnWrapper(gcs, solved, {
          targets: [{ point: { entityId: lines[2].id, site: 'start' }, to: target }],
        })
        expect(dragged.ok).toBe(true)
        if (!dragged.ok) return

        // The corner actually moved (real edit, not a no-op) ...
        const after = assertCenterAtMidpoint(dragged.entities)
        expect(Math.hypot(after.c2.x - built.c2.x, after.c2.y - built.c2.y)).toBeGreaterThan(1)
        // ... and the center RE-SOLVED to the new geometric center (tracking).
        expect(after.center.at.x).not.toBeCloseTo(built.center.at.x, 3)
      } finally {
        gcs.destroy_gcs_module()
      }
    })
  }
})
