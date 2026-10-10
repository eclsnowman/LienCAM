// CAM-BINDING Stage 2: deriveModelBodyProfile - the "derive" half of
// derive-then-bind. Drives the function directly against several
// hand-built body shapes (charter's own minimum: simple prism, body with a
// hole, a filleted body), plus the world-space Placement bake and every
// fail-loud path, per ADR-0003.
//
// FIXTURE STRATEGY: rather than spinning up the real Model kernel
// (occt-wasm/brepjs) just to get a tessellated mesh, these fixtures hand-
// build the SAME shape ModelBodyDisplay already carries (plain triangle
// arrays) - deriveModelBodyProfile only reads that mesh, never how it was
// produced, so a hand-built mesh is a legitimate, deterministic unit-test
// input (mirrors how the existing STL-projection tests exercise
// sliceAtZ/buildLoops against synthetic meshes, not a real STL file).
//
// Only the vertical WALL triangles are built (no top/bottom caps) - the
// slicer only ever crosses wall triangles for a horizontal Z-plane cut, so
// caps are geometrically irrelevant to every assertion here (verified by a
// standalone script before this file was written; see the commit's own
// report for the trace).

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, BoundingBox, Vec3 } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveModelBodyProfile, ModelBodyDeriveError } from '../../lib/cam/modelBodyDerive'

// ─── mesh fixture builder ──────────────────────────────────────────────────

interface Pt2 { x: number; y: number }

/** Vertical wall-only triangle mesh for one or more closed XY polygons,
 *  extruded between z0 and z1. Winding note (empirically verified): an
 *  OUTER boundary polygon supplied in CLOCKWISE order slices to a
 *  POSITIVE-area loop ('contour'); a hole boundary supplied in
 *  COUNTER-CLOCKWISE order slices to a NEGATIVE-area loop ('hole') - the
 *  reverse of the input's own shoelace sign, an artifact of this
 *  triangulation's diagonal choice (b0,b1,t1 / b0,t1,t0), not a bug in the
 *  slicer itself (which the existing stlProjection.ts code owns, unchanged
 *  by this file). */
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
  // clockwise (as viewed from +Z) -> slices to a positive-area 'contour'
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
  ]
}

function circleCCW(cx: number, cy: number, r: number, n = 32): Pt2[] {
  // counter-clockwise -> slices to a negative-area 'hole'
  const pts: Pt2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** Rounded-rectangle outline (CW), approximating a body whose 4 VERTICAL
 *  edges are filleted - a constant cross-section along Z, exactly the
 *  "filleted body" the charter's Stage 2 test plan names. */
function roundedRectCW(w: number, h: number, r: number, segsPerCorner = 8): Pt2[] {
  const hw = w / 2, hh = h / 2
  const centers: Array<[number, number, number]> = [
    [hw - r, hh - r, 0],            // top-right, angles 0..90
    [-(hw - r), hh - r, 90],        // top-left, 90..180
    [-(hw - r), -(hh - r), 180],    // bottom-left, 180..270
    [hw - r, -(hh - r), 270],       // bottom-right, 270..360
  ]
  const pts: Pt2[] = []
  for (const [cx, cy, startDeg] of centers) {
    for (let i = 0; i <= segsPerCorner; i++) {
      const a = ((startDeg + (i * 90) / segsPerCorner) * Math.PI) / 180
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
  }
  // CCW by construction (angles increase) -> reverse for the CW convention
  // this file's other fixtures use.
  return pts.reverse()
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

// ─── the three charter-minimum shapes ──────────────────────────────────────

describe('CAM-BINDING Stage 2: deriveModelBodyProfile - shape fixtures', () => {
  it('simple prism (40x30x10 box): derives one closed contour loop matching the rectangle', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('g1', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-1')

    const { loops } = deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-1')])

    expect(loops).toHaveLength(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
    expect(Math.abs(signedArea(loops[0].points))).toBeCloseTo(1200, 0)
  })

  it('body with a hole (40x30 box, 5mm-radius through-hole at center): derives an outer contour + an inner hole loop', () => {
    const mesh = buildWallMesh([rectCW(40, 30), circleCCW(0, 0, 5, 48)], 0, 10)
    const geo = makeModelGeo('g2', 'Box with hole', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-2')

    const { loops } = deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-2')])

    expect(loops).toHaveLength(2)
    const contour = loops.find((l) => l.type === 'contour')
    const hole = loops.find((l) => l.type === 'hole')
    expect(contour).toBeDefined()
    expect(hole).toBeDefined()
    expect(Math.abs(contour!.area)).toBeCloseTo(1200, 0)
    // pi*5^2 = 78.5, allow simplification/tessellation tolerance
    expect(Math.abs(hole!.area)).toBeGreaterThan(60)
    expect(Math.abs(hole!.area)).toBeLessThan(90)
  })

  it('filleted body (40x30 box, 6mm corner fillets on the vertical edges): derives one rounded contour loop', () => {
    const mesh = buildWallMesh([roundedRectCW(40, 30, 6, 12)], 0, 10)
    const geo = makeModelGeo('g3', 'Filleted box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-3')

    const { loops } = deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-3')])

    expect(loops).toHaveLength(1)
    expect(loops[0].type).toBe('contour')
    // Full 40x30 rect area minus the 4 corners cut off by the fillets
    // (each corner loses r^2 - pi*r^2/4 of area vs a square corner).
    const r = 6
    const expectedArea = 40 * 30 - 4 * (r * r - (Math.PI * r * r) / 4)
    expect(Math.abs(signedArea(loops[0].points))).toBeCloseTo(expectedArea, -1)
    // More than 4 points (not degenerated back to a plain rectangle) -
    // proves the fillet actually survives simplification.
    expect(loops[0].points.length).toBeGreaterThan(4)
  })

  // Reproduces a REAL bug found against the live Model kernel: a real
  // occt-wasm/brepjs extrude's triangle winding produced the OPPOSITE
  // raw sign from this file's other hand-built fixtures (all wound to
  // match rectCW's convention by construction), so projectSTLToLoops'
  // sign-based type ended up 'hole' for the body's ONLY loop - leaving
  // pocket2d's classifyLoops with zero outer bounds ("Pocket: the selected
  // loops contain no usable closed boundary to pocket") for what is
  // trivially a single outer contour. deriveModelBodyProfile's nesting-
  // based reclassification (winding-independent) fixes this - a lone loop
  // with nothing to nest inside is ALWAYS a contour, regardless of raw
  // sign. Mutation-provable: drop the reclassifyLoopsByNesting call
  // (use projectSTLToLoops' raw type instead) and this goes RED.
  it('a single loop wound OPPOSITE to this file\'s other fixtures still derives as a contour, not a hole', () => {
    const reversed = [...rectCW(40, 30)].reverse()
    const mesh = buildWallMesh([reversed], 0, 10)
    const geo = makeModelGeo('g11', 'Reverse-wound box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-11')

    const { loops } = deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-11')])

    expect(loops).toHaveLength(1)
    expect(loops[0].type).toBe('contour')
  })
})

// ─── world-space Placement bake ────────────────────────────────────────────

describe('CAM-BINDING Stage 2: deriveModelBodyProfile - world-space Placement bake', () => {
  it('a translated Placement shifts every loop point by the same offset - mutation-provable: remove the transformLoopPoints call and this goes RED (points stay in local space)', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('g4', 'Moved box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-4')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-4', position: { x: 100, y: 50, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]

    const { loops } = deriveModelBodyProfile(geo, placements)

    expect(loops).toHaveLength(1)
    const xs = loops[0].points.map((p) => p.x)
    const ys = loops[0].points.map((p) => p.y)
    // Local rect spans x in [-20,20], y in [-15,15]; world should be
    // shifted by (100, 50).
    expect(Math.min(...xs)).toBeCloseTo(80, 0)
    expect(Math.max(...xs)).toBeCloseTo(120, 0)
    expect(Math.min(...ys)).toBeCloseTo(35, 0)
    expect(Math.max(...ys)).toBeCloseTo(65, 0)
  })

  it('a 90deg Z-rotated Placement rotates every loop point about the world origin before translating', () => {
    const mesh = buildWallMesh([rectCW(40, 20)], 0, 10) // asymmetric so rotation is provable
    const geo = makeModelGeo('g5', 'Rotated box', mesh, [{ x: -20, y: -10, z: 0 }, { x: 20, y: 10, z: 10 }], 'item-5')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-5', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 } },
    ]

    const { loops } = deriveModelBodyProfile(geo, placements)

    const xs = loops[0].points.map((p) => p.x)
    const ys = loops[0].points.map((p) => p.y)
    // A 40(x)x20(y) rect rotated 90deg about Z becomes 20(x)x40(y).
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 0)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 0)
  })
})

// ─── fail-loud paths (ADR-0003) ────────────────────────────────────────────

describe('CAM-BINDING Stage 2: deriveModelBodyProfile - fail-loud paths', () => {
  it('refuses a non-model-origin geometry by name', () => {
    const geo = { id: 'g', name: 'Not a model', format: 'dxf', type: 'curves_2d' } as unknown as ImportedGeometry
    expect(() => deriveModelBodyProfile(geo, [])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodyProfile(geo, [])).toThrow(/not a modeled body/)
  })

  it('refuses a modeled body with no display payload yet (never regenerated)', () => {
    const geo = makeModelGeo('g6', 'No display yet', undefined, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }], 'item-6')
    expect(() => deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-6')])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-6')])).toThrow(/no tessellated geometry/)
  })

  it('refuses when no Placement record exists for the body\'s Model Item - mutation-provable: silently defaulting to identity instead of throwing would make this pass with a wrong result', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('g7', 'Unplaced box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-unplaced')
    expect(() => deriveModelBodyProfile(geo, [])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodyProfile(geo, [])).toThrow(/could not resolve its world placement/)
  })

  it('derives a tilted (off-Z) Placement\'s world-XY outline instead of refusing (WO-1543)', () => {
    // Walls plus top/bottom caps: once tilted, an open wall-only fixture is no
    // longer a closed solid's shadow.
    const walls = buildWallMesh([rectCW(40, 30)], 0, 10)
    const corners = rectCW(40, 30)
    const base = walls.positions.length / 3
    const mesh = {
      positions: [...walls.positions, ...corners.flatMap(p => [p.x, p.y, 0]), ...corners.flatMap(p => [p.x, p.y, 10])],
      indices: [...walls.indices, base, base + 1, base + 2, base, base + 2, base + 3,
        base + 4, base + 5, base + 6, base + 4, base + 6, base + 7],
    }
    const geo = makeModelGeo('g8', 'Tilted box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-8')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-8', position: { x: 0, y: 0, z: 0 }, rotation: { x: 45, y: 0, z: 0 } },
    ]
    // Its shadow: 40 x (30 cos45 + 10 sin45) = 40 x 28.28 in world XY.
    const { loops } = deriveModelBodyProfile(geo, placements)
    expect(loops.filter(l => l.type === 'contour')).toHaveLength(1)
    const ys = loops[0].points.map(p => p.y)
    const xs = loops[0].points.map(p => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40 * Math.SQRT1_2, 1)
  })

  it('refuses a body whose mesh produces no closed cross-section (degenerate/open mesh)', () => {
    // A single free-floating triangle - no wall loop can ever close.
    const geo = makeModelGeo(
      'g9', 'Degenerate mesh',
      { positions: [0, 0, 0, 1, 0, 0, 0, 1, 10], indices: [0, 1, 2] },
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 10 }], 'item-9',
    )
    expect(() => deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-9')])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('item-9')])).toThrow(/no closed cross-section/)
  })

  it('a legacy (no modelItemId) row resolves against the "legacy" placement key', () => {
    const mesh = buildWallMesh([rectCW(40, 30)], 0, 10)
    const geo = makeModelGeo('g10', 'Legacy box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }])
    // no modelItemId passed -> geo.modelItemId is undefined
    const { loops } = deriveModelBodyProfile(geo, [IDENTITY_PLACEMENT('legacy')])
    expect(loops).toHaveLength(1)
  })
})
