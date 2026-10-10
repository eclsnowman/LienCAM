// CAM-BINDING Stage 4 (slicing): deriveModelBodySection - the model-kernel
// counterpart of occt-model/derive.ts's sectionAtZ, extending the existing
// generic "Section at Z -> pocket" flow to a modeled body. Drives the
// function directly against hand-built body shapes (mirroring Stage 2's own
// fixture strategy - deriveModelBodySection only reads the tessellated mesh,
// never how it was produced), plus a PLACED (translated+rotated) item
// sectioned at a world Z (charter-required), and every fail-loud path
// (Z above/below the body, tangent slice, open profile) per ADR-0003.

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, BoundingBox, Vec3 } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveModelBodySection, ModelBodyDeriveError } from '../../lib/cam/modelBodyDerive'

// ─── mesh fixture builder (mirrors modelBodyDerive.camBindingStage2.test.ts) ──

interface Pt2 { x: number; y: number }

/** Vertical wall-only triangle mesh for one or more closed XY polygons,
 *  extruded between z0 and z1. Same winding note as Stage 2's fixtures: an
 *  OUTER boundary supplied CLOCKWISE slices to a POSITIVE-area 'contour'. */
function buildWallMesh(polygons: Pt2[][], z0: number, z1: number): { positions: number[]; indices: number[] } {
  const positions: number[] = []
  const indices: number[] = []
  for (const pts of polygons) {
    const n = pts.length
    const base = positions.length / 3
    for (let i = 0; i < n; i++) {
      positions.push(pts[i].x, pts[i].y, z0)
      positions.push(pts[i].x, pts[i].y, z1)
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const b0 = base + 2 * i, t0 = base + 2 * i + 1
      const b1 = base + 2 * j, t1 = base + 2 * j + 1
      indices.push(b0, b1, t1)
      indices.push(b0, t1, t0)
    }
  }
  return { positions, indices }
}

function rectCW(w: number, h: number, cx = 0, cy = 0): Pt2[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
  ]
}

function circleCCW(cx: number, cy: number, r: number, n = 32): Pt2[] {
  const pts: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** A stepped body (wide base, narrower top) - two different cross-sections
 *  at two different Z's, so a section derive is provably NOT the whole-body
 *  profile (which would only ever see the base). */
function buildSteppedMesh(): { positions: number[]; indices: number[] } {
  const base = buildWallMesh([rectCW(40, 30)], 0, 5)
  const top = buildWallMesh([rectCW(20, 15)], 5, 10)
  return {
    positions: [...base.positions, ...top.positions],
    indices: [...base.indices, ...top.indices.map((i) => i + base.positions.length / 3)],
  }
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function signedArea(pts: Pt2[]): number {
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

function makeModelGeo(
  id: string,
  name: string,
  mesh: { positions: number[]; indices: number[] } | undefined,
  boundsMinMax: [Vec3, Vec3],
  modelItemId?: string,
): ImportedGeometry {
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox(boundsMinMax[0], boundsMinMax[1]),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...(modelItemId !== undefined ? { modelItemId } : {}),
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      ...(mesh ? {
        display: {
          positions: mesh.positions, normals: [], indices: mesh.indices,
          edgePositions: [], edgeOffsets: [],
          bbox: { min: boundsMinMax[0], max: boundsMinMax[1] },
        },
      } : {}),
    },
  } as unknown as ImportedGeometry
}

const IDENTITY_PLACEMENT = (modelItemId: string): ModelItemPlacementRegistryEntry => ({
  modelItemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
})

// ─── basic section derive ──────────────────────────────────────────────────

describe('CAM-BINDING Stage 4: deriveModelBodySection - basic derive', () => {
  it('a simple prism (40x30x10 box): sections at mid-height derive the rectangle, not the default near-bottom profile', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('s1', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s1')

    const { loops, z } = deriveModelBodySection(geo, 5, [IDENTITY_PLACEMENT('item-s1')])

    expect(z).toBe(5)
    expect(loops).toHaveLength(1)
    expect(loops[0].type).toBe('contour')
    expect(Math.abs(signedArea(loops[0].points))).toBeCloseTo(1200, 0)
  })

  it('a body with a hole: sections derive an outer contour + an inner hole loop', () => {
    const mesh = buildWallMesh([rectCW(40, 30), circleCCW(0, 0, 5, 48)], 0, 10)
    const geo = makeModelGeo('s2', 'Box with hole', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s2')

    const { loops } = deriveModelBodySection(geo, 5, [IDENTITY_PLACEMENT('item-s2')])

    expect(loops).toHaveLength(2)
    expect(loops.find((l) => l.type === 'contour')).toBeDefined()
    expect(loops.find((l) => l.type === 'hole')).toBeDefined()
  })

  it('a stepped body: sections at two different Z heights derive TWO different cross-sections (proves this is a real per-Z section, not the whole-body default)', () => {
    const mesh = buildSteppedMesh()
    const geo = makeModelGeo('s3', 'Stepped', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s3')

    const low = deriveModelBodySection(geo, 2, [IDENTITY_PLACEMENT('item-s3')])
    const high = deriveModelBodySection(geo, 8, [IDENTITY_PLACEMENT('item-s3')])

    expect(Math.abs(signedArea(low.loops[0].points))).toBeCloseTo(1200, 0) // 40x30
    expect(Math.abs(signedArea(high.loops[0].points))).toBeCloseTo(300, 0) // 20x15
  })
})

// ─── PLACED (translated + rotated) item sectioned at a world Z ─────────────

describe('CAM-BINDING Stage 4: deriveModelBodySection - Placement composition', () => {
  it('a translated Placement: sectioning at a WORLD Z picks the correct LOCAL slice, and the resulting loop is shifted to world XY - pinned loop numbers', () => {
    const mesh = buildSteppedMesh() // local Z range [0,10]: base 40x30 below z=5, top 20x15 above
    const geo = makeModelGeo('s4', 'Moved stepped', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s4')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-s4', position: { x: 100, y: 50, z: 20 }, rotation: { x: 0, y: 0, z: 0 } },
    ]

    // World Z 22 -> local Z 22-20=2 -> base cross-section (40x30 rect).
    const { loops, z } = deriveModelBodySection(geo, 22, placements)
    expect(z).toBe(22)
    expect(loops).toHaveLength(1)
    expect(Math.abs(signedArea(loops[0].points))).toBeCloseTo(1200, 0)
    const xs = loops[0].points.map((p) => p.x)
    const ys = loops[0].points.map((p) => p.y)
    // Local rect spans x in [-20,20], y in [-15,15]; world shifted by (100,50).
    expect(Math.min(...xs)).toBeCloseTo(80, 0)
    expect(Math.max(...xs)).toBeCloseTo(120, 0)
    expect(Math.min(...ys)).toBeCloseTo(35, 0)
    expect(Math.max(...ys)).toBeCloseTo(65, 0)

    // World Z 28 -> local Z 8 -> top cross-section (20x15 rect), pinned distinct
    // from the base - proves the world-Z-to-local-Z conversion picks the RIGHT
    // slice, not just re-labels the same one.
    const upper = deriveModelBodySection(geo, 28, placements)
    expect(Math.abs(signedArea(upper.loops[0].points))).toBeCloseTo(300, 0)
  })

  it('a 90deg Z-rotated Placement rotates the sectioned loop about the world origin before translating - same world Z as the local Z (rotation about Z never changes Z)', () => {
    const mesh = buildWallMesh([rectCW(40, 20)], 0, 10) // asymmetric so rotation is provable
    const geo = makeModelGeo('s5', 'Rotated box', mesh, [{ x: -20, y: -10, z: 0 }, { x: 20, y: 10, z: 10 }], 'item-s5')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-s5', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 } },
    ]

    const { loops } = deriveModelBodySection(geo, 5, placements)

    const xs = loops[0].points.map((p) => p.x)
    const ys = loops[0].points.map((p) => p.y)
    // A 40(x)x20(y) rect rotated 90deg about Z becomes 20(x)x40(y).
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 0)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 0)
  })
})

// ─── fail-loud paths (ADR-0003, charter-named degenerate cases) ───────────

describe('CAM-BINDING Stage 4: deriveModelBodySection - fail-loud paths', () => {
  it('refuses a non-model-origin geometry by name', () => {
    const geo = { id: 'g', name: 'Not a model', format: 'dxf', type: 'curves_2d' } as unknown as ImportedGeometry
    expect(() => deriveModelBodySection(geo, 5, [])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodySection(geo, 5, [])).toThrow(/not a modeled body/)
  })

  it('refuses a modeled body with no display payload yet', () => {
    const geo = makeModelGeo('s6', 'No display', undefined, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }], 'item-s6')
    expect(() => deriveModelBodySection(geo, 0.5, [IDENTITY_PLACEMENT('item-s6')])).toThrow(/no tessellated geometry/)
  })

  it('refuses when no Placement record exists for the body\'s Model Item', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('s7', 'Unplaced box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s7-unplaced')
    expect(() => deriveModelBodySection(geo, 5, [])).toThrow(/could not resolve its world placement/)
  })

  it('sections a tilted (off-Z) Placement at world Z instead of refusing (WO-1543)', () => {
    // Walls plus top/bottom caps: tilted, a plane can cross the caps, so the
    // fixture must be a closed solid for its section to close.
    const walls = buildWallMesh([rectCW(40, 30)], 0, 10)
    const corners = rectCW(40, 30)
    const base = walls.positions.length / 3
    const mesh = {
      positions: [...walls.positions, ...corners.flatMap(p => [p.x, p.y, 0]), ...corners.flatMap(p => [p.x, p.y, 10])],
      indices: [...walls.indices, base, base + 1, base + 2, base, base + 2, base + 3,
        base + 4, base + 5, base + 6, base + 4, base + 6, base + 7],
    }
    const geo = makeModelGeo('s8', 'Tilted box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s8')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-s8', position: { x: 0, y: 0, z: 0 }, rotation: { x: 45, y: 0, z: 0 } },
    ]
    // World Z 5 is the local plane y + z = 5 / sin45 through the box: one
    // closed 40-wide loop, not a refusal.
    const { loops } = deriveModelBodySection(geo, 5, placements)
    expect(loops).toHaveLength(1)
    const xs = loops[0].points.map(p => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 1)
  })

  it('refuses a Z ABOVE the body\'s world range, naming the range', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('s9', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s9')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-s9', position: { x: 0, y: 0, z: 20 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    // World range is [20, 30]; ask for 50.
    expect(() => deriveModelBodySection(geo, 50, placements)).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodySection(geo, 50, placements)).toThrow(/outside the body's world Z range/)
    expect(() => deriveModelBodySection(geo, 50, placements)).toThrow(/\[20\.000, 30\.000\]/)
  })

  it('refuses a Z BELOW the body\'s world range', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('s10', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s10')
    expect(() => deriveModelBodySection(geo, -5, [IDENTITY_PLACEMENT('item-s10')])).toThrow(/outside the body's world Z range/)
  })

  it('refuses a TANGENT slice exactly at the body\'s top face (grazes a flat face, zero crossings)', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('s11', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-s11')
    expect(() => deriveModelBodySection(geo, 10, [IDENTITY_PLACEMENT('item-s11')])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodySection(geo, 10, [IDENTITY_PLACEMENT('item-s11')])).toThrow(/tangent slice/)
  })

  it('refuses an OPEN profile - a mesh whose slice segments never close into a loop', () => {
    // Two disjoint wall segments at the slice height that never meet: build a
    // wall mesh for a triangle (3 verts) but strip one wall panel's index pair
    // so its two endpoints never reconnect - the remaining segments form an
    // open chain, not a closed loop.
    const tri = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 0, y: 10 }]
    const full = buildWallMesh([tri], 0, 10)
    // Drop the last wall panel's 2 triangles (indices for edge 2->0) so that
    // wall is missing - the remaining 2 walls' segments cannot close.
    const openIndices = full.indices.slice(0, full.indices.length - 6)
    const geo = makeModelGeo(
      's12', 'Open profile',
      { positions: full.positions, indices: openIndices },
      [{ x: -10, y: -10, z: 0 }, { x: 10, y: 10, z: 10 }], 'item-s12',
    )
    expect(() => deriveModelBodySection(geo, 5, [IDENTITY_PLACEMENT('item-s12')])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodySection(geo, 5, [IDENTITY_PLACEMENT('item-s12')])).toThrow(/open profile/)
  })

  it('a legacy (no modelItemId) row resolves against the "legacy" placement key', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('s13', 'Legacy box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }])
    const { loops } = deriveModelBodySection(geo, 5, [IDENTITY_PLACEMENT('legacy')])
    expect(loops).toHaveLength(1)
  })

  it('refuses a section whose ONLY loop is below the min-perimeter simplification floor (CAM-BINDING-S4b: a needle-thin sliver too small to machine, not an empty/tangent slice)', () => {
    // A tiny equilateral-ish triangle (side ~0.03mm, perimeter ~0.09mm) held
    // well clear of the SNAP grid (0.01mm) so its 3 vertices stay distinct
    // after snapping, and well clear of the DP simplification tolerance
    // (0.02mm) so its 3 points survive simplification undamaged (triangle
    // height ~0.026mm > tol, so Douglas-Peucker does not collapse it to a
    // line) - the ONLY thing that removes it is minPerimeterFor(0.02) =
    // max(0.1, 0.02*6) = 0.12mm, and 0.09mm < 0.12mm. This exercises the
    // modelBodyDerive.ts deriveModelBodySection refusal distinct from the
    // "tangent slice" (zero crossings) and "open profile" (unclosed chain)
    // paths already covered above - here the slice DOES cross material and
    // DOES close into a valid loop, it is just too small to be worth
    // machining.
    const tinyTri: Pt2[] = [
      { x: 0, y: 0 },
      { x: 0.03, y: 0 },
      { x: 0.015, y: 0.026 },
    ]
    const mesh = buildWallMesh([tinyTri], 0, 1)
    const geo = makeModelGeo(
      's14', 'Sliver pin', mesh,
      [{ x: 0, y: 0, z: 0 }, { x: 0.03, y: 0.026, z: 1 }], 'item-s14',
    )
    expect(() => deriveModelBodySection(geo, 0.5, [IDENTITY_PLACEMENT('item-s14')])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodySection(geo, 0.5, [IDENTITY_PLACEMENT('item-s14')])).toThrow(/no loop large enough to machine/)
  })
})
