// WO-1536: a closed solid sectioned at EXACTLY the height of one of its own
// vertices (a removal ceiling, a ridge, a blind-hole floor) must give a valid
// closed section - the same section the solid gives a hair above that height.
// No height may turn a closed solid into an "open profile".
//
// Every fixture here is a watertight triangle mesh and every case runs through
// the real deriveModelBodySection. Heights that never touch a vertex are also
// checked segment-for-segment against the strict-crossing slicer main shipped
// (copied below as a reference), so those results are provably unchanged.

import { describe, it, expect } from 'vitest'
import { sliceAtZ, buildLoops } from '../../lib/geometry/stlProjection'
import type { ImportedGeometry, BoundingBox, Vec3 } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveModelBodySection } from '../../lib/cam/modelBodyDerive'

interface Mesh { positions: number[]; indices: number[] }
interface Pt2 { x: number; y: number }

const HAIR = 1e-4

// ─── fixture builders ───────────────────────────────────────────────────────

/** Watertight boundary of a union of grid cells. Every face is split at every
 *  grid line, so vertices sit exactly on each internal transition height. */
function gridSolid(xs: number[], ys: number[], zs: number[], solid: (x: number, y: number, z: number) => boolean): Mesh {
  const nx = xs.length, ny = ys.length
  const positions: number[] = []
  for (const z of zs) for (const y of ys) for (const x of xs) positions.push(x, y, z)
  const v = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const filled = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < nx - 1 && j < ny - 1 && k < zs.length - 1 &&
    solid((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2)
  const indices: number[] = []
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d)
  for (let k = 0; k < zs.length - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (!filled(i, j, k)) continue
    if (!filled(i - 1, j, k)) quad(v(i, j, k), v(i, j + 1, k), v(i, j + 1, k + 1), v(i, j, k + 1))
    if (!filled(i + 1, j, k)) quad(v(i + 1, j, k), v(i + 1, j, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j + 1, k))
    if (!filled(i, j - 1, k)) quad(v(i, j, k), v(i, j, k + 1), v(i + 1, j, k + 1), v(i + 1, j, k))
    if (!filled(i, j + 1, k)) quad(v(i, j + 1, k), v(i + 1, j + 1, k), v(i + 1, j + 1, k + 1), v(i, j + 1, k + 1))
    if (!filled(i, j, k - 1)) quad(v(i, j, k), v(i + 1, j, k), v(i + 1, j + 1, k), v(i, j + 1, k))
    if (!filled(i, j, k + 1)) quad(v(i, j, k + 1), v(i, j + 1, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j, k + 1))
  }
  return { positions, indices }
}

/** Ear-clip a simple polygon (any winding) into triangles of its indices. */
function earClip(poly: Pt2[]): number[] {
  const area = poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p.x * q.y - q.x * p.y }, 0)
  const ring = poly.map((_, i) => i)
  if (area < 0) ring.reverse()
  const cross = (o: Pt2, a: Pt2, b: Pt2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const out: number[] = []
  while (ring.length > 3) {
    let clipped = false
    for (let r = 0; r < ring.length; r++) {
      const ia = ring[(r + ring.length - 1) % ring.length], ib = ring[r], ic = ring[(r + 1) % ring.length]
      const a = poly[ia], b = poly[ib], c = poly[ic]
      if (cross(a, b, c) <= 0) continue
      const blocked = ring.some((ip) => ip !== ia && ip !== ib && ip !== ic &&
        cross(a, b, poly[ip]) >= 0 && cross(b, c, poly[ip]) >= 0 && cross(c, a, poly[ip]) >= 0)
      if (blocked) continue
      out.push(ia, ib, ic)
      ring.splice(r, 1)
      clipped = true
      break
    }
    if (!clipped) throw new Error('earClip: polygon is not simple')
  }
  out.push(ring[0], ring[1], ring[2])
  return out
}

/** Watertight prism: an XZ outline extruded along Y, capped by ear-clipped
 *  end faces (long triangles, not a grid - a second tessellation style). */
function extrudeXZ(profile: { x: number; z: number }[], y0: number, y1: number): Mesh {
  const n = profile.length
  const positions: number[] = []
  for (const p of profile) positions.push(p.x, y0, p.z)
  for (const p of profile) positions.push(p.x, y1, p.z)
  const indices: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    indices.push(i, j, n + j, i, n + j, n + i)
  }
  const cap = earClip(profile.map((p) => ({ x: p.x, y: p.z })))
  indices.push(...cap, ...cap.map((i) => i + n))
  return { positions, indices }
}

// BUG-462: an L (wide leg X0..20 Y0..40, narrow leg X20..60 Y0..10), Z0..20,
// with a removal across the narrow leg's full width at X40..45, Z0..15.
const L_SOLID = gridSolid([0, 20, 40, 45, 60], [0, 10, 40], [0, 15, 20], (x, y, z) =>
  (x < 20 || y < 10) && !(x > 40 && x < 45 && z < 15))

// Audit 2's knife-edge ridge: a column X0..10 Z0..20 beside a gabled block
// (eaves Z10 at X10/X30, ridge X20 Z15), extruded Y0..10.
const RIDGE_SOLID = extrudeXZ([
  { x: 0, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 10 }, { x: 20, z: 15 },
  { x: 10, z: 10 }, { x: 10, z: 20 }, { x: 0, z: 20 },
], 0, 10)

// A block X0..40 Y0..30 Z0..20 with a blind hole X15..25 Y10..20 down to Z12.
const HOLE_SOLID = gridSolid([0, 15, 25, 40], [0, 10, 20, 30], [0, 12, 20], (x, y, z) =>
  !(x > 15 && x < 25 && y > 10 && y < 20 && z > 12))

// ─── deriveModelBodySection harness ─────────────────────────────────────────

function bounds(mesh: Mesh): [Vec3, Vec3] {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = mesh.positions.slice(i, i + 3)
    min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z)
    max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z)
  }
  return [min, max]
}

function makeGeo(id: string, mesh: Mesh): ImportedGeometry {
  const [min, max] = bounds(mesh)
  const box: BoundingBox = {
    min, max,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
  return {
    id, name: id, filename: '', type: 'model', format: 'model', boundingBox: box,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, modelItemId: `item-${id}`,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: { positions: mesh.positions, normals: [], indices: mesh.indices, edgePositions: [], edgeOffsets: [], bbox: { min, max } },
    },
  } as unknown as ImportedGeometry
}

function section(id: string, mesh: Mesh, z: number): string[] {
  const placements: ModelItemPlacementRegistryEntry[] = [{ modelItemId: `item-${id}`, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }]
  const { loops } = deriveModelBodySection(makeGeo(id, mesh), z, placements)
  return loops.map((l) => {
    const a = l.points.reduce((s, p, i) => { const q = l.points[(i + 1) % l.points.length]; return s + p.x * q.y - q.x * p.y }, 0) / 2
    return `${l.type}:${Math.abs(a).toFixed(1)}`
  }).sort()
}

// ─── reference: main's strict-crossing slicer, valid off every vertex height ─

function strictSliceKeys(pos: Float32Array, idx: Uint32Array, h: number): string[] {
  const key = (x: number, y: number) => `${Math.round(x / 0.01)},${Math.round(y / 0.01)}`
  const out: string[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const vs = [idx[t], idx[t + 1], idx[t + 2]].map((i) => ({ x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2] }))
    const pts: string[] = []
    for (let e = 0; e < 3; e++) {
      const p = vs[e], q = vs[(e + 1) % 3]
      if ((p.z - h) * (q.z - h) < 0) { const s = (h - p.z) / (q.z - p.z); pts.push(key(p.x + s * (q.x - p.x), p.y + s * (q.y - p.y))) }
    }
    if (pts.length === 2 && pts[0] !== pts[1]) out.push(pts.sort().join('|'))
  }
  return out.sort()
}

function sliceKeys(pos: Float32Array, idx: Uint32Array, h: number): string[] {
  const key = (p: Pt2) => `${Math.round(p.x / 0.01)},${Math.round(p.y / 0.01)}`
  return sliceAtZ(pos, idx, h).map(([a, b]) => [key(a), key(b)].sort().join('|')).sort()
}

function allChainsClose(mesh: Mesh, h: number): boolean {
  const segs = sliceAtZ(Float32Array.from(mesh.positions), Uint32Array.from(mesh.indices), h)
  const consumed = buildLoops(segs).reduce((s, c) => s + c.length, 0)
  return segs.length > 0 && consumed === segs.length
}

// ─── the rule, case by case ─────────────────────────────────────────────────

describe('WO-1536: an exact vertex height sections a closed solid like a hair above it', () => {
  it('BUG-462 L solid at exactly Z15 (the removal ceiling): closed, same as Z15+hair (the bridged L)', () => {
    expect(allChainsClose(L_SOLID, 15)).toBe(true)
    const above = section('l', L_SOLID, 15 + HAIR)
    expect(above).toEqual(['contour:1200.0'])
    expect(section('l', L_SOLID, 15)).toEqual(above)
  })

  it('BUG-462 L solid below/above the ceiling keeps its two-contour / one-L topology', () => {
    expect(section('l', L_SOLID, 10)).toEqual(['contour:1000.0', 'contour:150.0'])
    expect(section('l', L_SOLID, 14.999)).toEqual(['contour:1000.0', 'contour:150.0'])
    expect(section('l', L_SOLID, 15.001)).toEqual(['contour:1200.0'])
    expect(section('l', L_SOLID, 17)).toEqual(['contour:1200.0'])
  })

  it('audit 1 through-removal bar (T-junction end faces) at exactly Z15: closed, same as a hair above', () => {
    // Bar X0..60 Y0..10 Z0..20, removal X25..35 Z0..15; end faces are three
    // separate rectangles whose edges meet the side faces in T-junctions.
    const side = extrudeXZ([
      { x: 0, z: 0 }, { x: 0, z: 20 }, { x: 60, z: 20 }, { x: 60, z: 0 },
      { x: 35, z: 0 }, { x: 35, z: 15 }, { x: 25, z: 15 }, { x: 25, z: 0 },
    ], 0, 10)
    const n = side.positions.length / 3
    const sideOnly = { positions: side.positions, indices: side.indices.slice(0, 8 * 6) }
    const rects: [number, number, number, number][] = [[0, 25, 0, 20], [35, 60, 0, 20], [25, 35, 15, 20]]
    let k = n
    for (const y of [0, 10]) for (const [x0, x1, z0, z1] of rects) {
      sideOnly.positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1)
      sideOnly.indices.push(k, k + 1, k + 2, k, k + 2, k + 3)
      k += 4
    }
    expect(allChainsClose(sideOnly, 15)).toBe(true)
    expect(section('bar', sideOnly, 15)).toEqual(section('bar', sideOnly, 15 + HAIR))
    expect(section('bar', sideOnly, 15)).toEqual(['contour:600.0'])
    expect(section('bar', sideOnly, 14.999)).toEqual(['contour:250.0', 'contour:250.0'])
  })

  it('knife-edge ridge at exactly its ridge height Z15 and at Z14.999: closed, same as a hair above', () => {
    for (const h of [15, 14.999]) {
      expect(allChainsClose(RIDGE_SOLID, h)).toBe(true)
      expect(section('ridge', RIDGE_SOLID, h)).toEqual(section('ridge', RIDGE_SOLID, h + HAIR))
    }
    expect(section('ridge', RIDGE_SOLID, 15)).toEqual(['contour:100.0'])
    // The eaves height Z10 touches vertices too: the gable a hair above is one closed contour.
    expect(section('ridge', RIDGE_SOLID, 10)).toEqual(section('ridge', RIDGE_SOLID, 10 + HAIR))
  })

  it('blind-hole floor at exactly Z12: closed, same as a hair above (block contour + hole)', () => {
    expect(allChainsClose(HOLE_SOLID, 12)).toBe(true)
    const above = section('hole', HOLE_SOLID, 12 + HAIR)
    expect(above).toEqual(['contour:1200.0', 'hole:100.0'])
    expect(section('hole', HOLE_SOLID, 12)).toEqual(above)
  })

  it('the bottom face height sections like a hair above it (the whole footprint)', () => {
    expect(section('l', L_SOLID, 0)).toEqual(section('l', L_SOLID, HAIR))
    expect(section('hole', HOLE_SOLID, 0)).toEqual(['contour:1200.0'])
  })

  it('heights that touch no vertex give exactly the segments main gave', () => {
    const cases: [Mesh, number[]][] = [
      [L_SOLID, [10, 14.999, 15.001, 17]],
      [RIDGE_SOLID, [5, 12.5, 14.999, 15.001, 17]],
      [HOLE_SOLID, [6, 11.999, 12.001, 19]],
    ]
    for (const [mesh, heights] of cases) {
      const pos = Float32Array.from(mesh.positions), idx = Uint32Array.from(mesh.indices)
      for (const h of heights) expect(sliceKeys(pos, idx, h)).toEqual(strictSliceKeys(pos, idx, h))
    }
  })

  it('the top face is still a tangent slice', () => {
    expect(() => section('l', L_SOLID, 20)).toThrow(/tangent slice/)
  })

  it('a mesh with a missing face still refuses as an open profile, at an exact and an ordinary height', () => {
    // Drop one outer wall quad of the bridge band (Z15..20 at X0 face).
    const tris: number[][] = []
    for (let t = 0; t < L_SOLID.indices.length; t += 3) tris.push(L_SOLID.indices.slice(t, t + 3))
    const isGap = (tri: number[]) => tri.every((i) => L_SOLID.positions[i * 3] === 0 && L_SOLID.positions[i * 3 + 2] >= 15) &&
      tri.some((i) => L_SOLID.positions[i * 3 + 1] === 40)
    const open: Mesh = { positions: L_SOLID.positions, indices: tris.filter((t) => !isGap(t)).flat() }
    expect(open.indices.length).toBe(L_SOLID.indices.length - 6)
    expect(() => section('open', open, 15)).toThrow(/open profile/)
    expect(() => section('open', open, 17)).toThrow(/open profile/)
  })
})
