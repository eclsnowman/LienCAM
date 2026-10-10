// CAM-BINDING Stage 5 (face boundaries): deriveModelBodyFace - the derive
// half of "pick a FACE (not the whole body) on a modeled body as a
// machining boundary". Mirrors Stage 2's own fixture strategy
// (modelBodyDerive.camBindingStage2.test.ts): hand-built triangle meshes
// (the same shape ModelBodyDisplay carries) rather than a real Model
// kernel, PLUS the per-face `faceIds`/`triFace` arrays this stage adds to
// ModelBodyDisplay.

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, BoundingBox, Vec3 } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveModelBodyFace, ModelBodyDeriveError } from '../../lib/cam/modelBodyDerive'

interface Pt2 { x: number; y: number }

function rectCW(w: number, h: number, cx = 0, cy = 0): Pt2[] {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
  ]
}

/** A flat rectangular cap at height z, triangulated as a fan (2 triangles). */
function rectCapMesh(w: number, h: number, z: number): { positions: number[]; indices: number[] } {
  const pts = rectCW(w, h)
  const positions = pts.flatMap((p) => [p.x, p.y, z])
  const indices = [0, 1, 2, 0, 2, 3]
  return { positions, indices }
}

/** A flat rectangular ANNULUS (picture-frame) at height z: outer w/h minus a
 *  smaller inner w/h hole, both rectangles CW-ordered and index-aligned so
 *  each i-th outer/inner pair forms one trapezoid (2 triangles). Radial
 *  edges (outer[i]-inner[i]) are shared by two adjacent trapezoids
 *  (interior, dropped by the boundary trace); outer/inner ring edges are
 *  each used once (boundary). */
function rectAnnulusMesh(
  outerW: number, outerH: number, innerW: number, innerH: number, z: number,
): { positions: number[]; indices: number[] } {
  const outer = rectCW(outerW, outerH)
  const inner = rectCW(innerW, innerH)
  const positions = [...outer.flatMap((p) => [p.x, p.y, z]), ...inner.flatMap((p) => [p.x, p.y, z])]
  const indices: number[] = []
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    const o0 = i, o1 = j, i0 = 4 + i, i1 = 4 + j
    indices.push(o0, o1, i1)
    indices.push(o0, i1, i0)
  }
  return { positions, indices }
}

/** Merge N sub-meshes into one flat positions/indices/triFace array, one
 *  faceId per sub-mesh (matching ModelBodyDisplay's own compact scheme). */
function mergeFaces(
  parts: Array<{ positions: number[]; indices: number[] }>,
  faceIds: string[],
): { positions: number[]; indices: number[]; triFace: number[]; faceIds: string[] } {
  const positions: number[] = []
  const indices: number[] = []
  const triFace: number[] = []
  for (let f = 0; f < parts.length; f++) {
    const base = positions.length / 3
    positions.push(...parts[f].positions)
    for (const idx of parts[f].indices) indices.push(idx + base)
    for (let t = 0; t < parts[f].indices.length / 3; t++) triFace.push(f)
  }
  return { positions, indices, triFace, faceIds }
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeModelGeo(
  id: string,
  name: string,
  mesh: { positions: number[]; indices: number[]; triFace?: number[]; faceIds?: string[] } | undefined,
  boundsMinMax: [Vec3, Vec3],
  modelItemId?: string,
): ImportedGeometry {
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox(boundsMinMax[0], boundsMinMax[1]),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...(modelItemId !== undefined ? { modelItemId } : {}),
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: mesh?.faceIds ?? [], version: 1 },
      ...(mesh ? {
        display: {
          positions: mesh.positions, normals: [], indices: mesh.indices,
          edgePositions: [], edgeOffsets: [],
          bbox: { min: boundsMinMax[0], max: boundsMinMax[1] },
          faceIds: mesh.faceIds, triFace: mesh.triFace,
        },
      } : {}),
    },
  } as unknown as ImportedGeometry
}

const IDENTITY_PLACEMENT = (modelItemId: string): ModelItemPlacementRegistryEntry => ({
  modelItemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
})

describe('CAM-BINDING Stage 5: deriveModelBodyFace - shape fixtures', () => {
  it('a box\'s flat top face derives one closed contour matching the top rectangle', () => {
    const top = rectCapMesh(40, 30, 10)
    const bottom = rectCapMesh(40, 30, 0)
    const mesh = mergeFaces([bottom, top], ['F_bottom', 'F_top'])
    const geo = makeModelGeo('g1', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-1')

    const { loops, z } = deriveModelBodyFace(geo, 'F_top', [IDENTITY_PLACEMENT('item-1')])

    expect(loops).toHaveLength(1)
    expect(loops[0].closed).toBe(true)
    expect(loops[0].type).toBe('contour')
    expect(loops[0].area).toBeCloseTo(1200, 0)
    expect(z).toBeCloseTo(10, 3)
  })

  it('a face with a through-hole (annulus) derives an outer contour + an inner hole loop', () => {
    const annulus = rectAnnulusMesh(40, 30, 10, 8, 10)
    const mesh = mergeFaces([annulus], ['F_top'])
    const geo = makeModelGeo('g2', 'Box with hole', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-2')

    const { loops } = deriveModelBodyFace(geo, 'F_top', [IDENTITY_PLACEMENT('item-2')])

    expect(loops).toHaveLength(2)
    const contour = loops.find((l) => l.type === 'contour')
    const hole = loops.find((l) => l.type === 'hole')
    expect(contour).toBeDefined()
    expect(hole).toBeDefined()
    expect(contour!.area).toBeCloseTo(1200, 0)
    expect(hole!.area).toBeCloseTo(80, 0)
  })

  it('picking a DIFFERENT face id on the same body derives only that face\'s boundary', () => {
    const top = rectCapMesh(40, 30, 10)
    const bottom = rectCapMesh(20, 10, 0) // deliberately different size, provably distinct
    const mesh = mergeFaces([bottom, top], ['F_bottom', 'F_top'])
    const geo = makeModelGeo('g3', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-3')

    const bottomResult = deriveModelBodyFace(geo, 'F_bottom', [IDENTITY_PLACEMENT('item-3')])
    expect(bottomResult.loops).toHaveLength(1)
    expect(bottomResult.loops[0].area).toBeCloseTo(200, 0)
    expect(bottomResult.z).toBeCloseTo(0, 3)
  })
})

describe('CAM-BINDING Stage 5: deriveModelBodyFace - world-space Placement bake', () => {
  it('a translated Placement shifts every loop point by the same offset - mutation-provable: remove the transformLoopPoints call and this goes RED', () => {
    const top = rectCapMesh(40, 30, 10)
    const mesh = mergeFaces([top], ['F_top'])
    const geo = makeModelGeo('g4', 'Moved box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-4')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-4', position: { x: 100, y: 50, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]

    const { loops } = deriveModelBodyFace(geo, 'F_top', placements)

    const xs = loops[0].points.map((p) => p.x)
    const ys = loops[0].points.map((p) => p.y)
    expect(Math.min(...xs)).toBeCloseTo(80, 0)
    expect(Math.max(...xs)).toBeCloseTo(120, 0)
    expect(Math.min(...ys)).toBeCloseTo(35, 0)
    expect(Math.max(...ys)).toBeCloseTo(65, 0)
  })
})

describe('CAM-BINDING Stage 5: deriveModelBodyFace - fail-loud paths', () => {
  it('refuses a non-model-origin geometry by name', () => {
    const geo = { id: 'g', name: 'Not a model', format: 'dxf', type: 'curves_2d' } as unknown as ImportedGeometry
    expect(() => deriveModelBodyFace(geo, 'F_top', [])).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodyFace(geo, 'F_top', [])).toThrow(/not a modeled body/)
  })

  it('refuses a modeled body with no display payload yet', () => {
    const geo = makeModelGeo('g5', 'No display yet', undefined, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }], 'item-5')
    expect(() => deriveModelBodyFace(geo, 'F_top', [IDENTITY_PLACEMENT('item-5')])).toThrow(/no tessellated geometry/)
  })

  it('refuses a display payload with no per-face identity data yet (pre-Stage-5 project)', () => {
    const top = rectCapMesh(40, 30, 10)
    const geo = makeModelGeo(
      'g6', 'Pre-Stage-5 box',
      { positions: top.positions, indices: top.indices }, // no faceIds/triFace
      [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-6',
    )
    expect(() => deriveModelBodyFace(geo, 'F_top', [IDENTITY_PLACEMENT('item-6')])).toThrow(/no per-face identity data/)
  })

  it('refuses an unknown/gone faceStableId by name', () => {
    const top = rectCapMesh(40, 30, 10)
    const mesh = mergeFaces([top], ['F_top'])
    const geo = makeModelGeo('g7', 'Box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-7')
    expect(() => deriveModelBodyFace(geo, 'F_gone', [IDENTITY_PLACEMENT('item-7')])).toThrow(/no longer exists/)
  })

  it('refuses when no Placement record exists for the body\'s Model Item', () => {
    const top = rectCapMesh(40, 30, 10)
    const mesh = mergeFaces([top], ['F_top'])
    const geo = makeModelGeo('g8', 'Unplaced box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-unplaced')
    expect(() => deriveModelBodyFace(geo, 'F_top', [])).toThrow(/could not resolve its world placement/)
  })

  it('refuses a tilted (off-Z) Placement rather than deriving a mirrored/skewed boundary', () => {
    const top = rectCapMesh(40, 30, 10)
    const mesh = mergeFaces([top], ['F_top'])
    const geo = makeModelGeo('g9', 'Tilted box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }], 'item-9')
    const placements: ModelItemPlacementRegistryEntry[] = [
      { modelItemId: 'item-9', position: { x: 0, y: 0, z: 0 }, rotation: { x: 45, y: 0, z: 0 } },
    ]
    expect(() => deriveModelBodyFace(geo, 'F_top', placements)).toThrow(/tilted/)
  })

  // Mutation-provable: relaxing FACE_Z_EPS (or dropping the check) would let
  // a genuinely non-planar/non-Z-normal "face" (built here from mismatched
  // top-cap heights within the SAME face id, standing in for a slanted or
  // curved surface) silently derive a skewed boundary instead of refusing.
  it('refuses a non-planar/non-Z-normal face (vertices spanning more than the coplanarity tolerance)', () => {
    const skewed = {
      // A quad whose two far corners sit at a different Z - not flat.
      positions: [-20, -15, 10, -20, 15, 10, 20, 15, 25, 20, -15, 25],
      indices: [0, 1, 2, 0, 2, 3],
    }
    const mesh = mergeFaces([skewed], ['F_top'])
    const geo = makeModelGeo('g10', 'Skewed face box', mesh, [{ x: -20, y: -15, z: 10 }, { x: 20, y: 15, z: 25 }], 'item-10')
    expect(() => deriveModelBodyFace(geo, 'F_top', [IDENTITY_PLACEMENT('item-10')])).toThrow(/not a flat, horizontal/)
  })

  it('a legacy (no modelItemId) row resolves against the "legacy" placement key', () => {
    const top = rectCapMesh(40, 30, 10)
    const mesh = mergeFaces([top], ['F_top'])
    const geo = makeModelGeo('g11', 'Legacy box', mesh, [{ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }])
    const { loops } = deriveModelBodyFace(geo, 'F_top', [IDENTITY_PLACEMENT('legacy')])
    expect(loops).toHaveLength(1)
  })
})
