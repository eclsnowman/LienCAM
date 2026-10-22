import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildPlaneFrame, projectSTLToLoops, projectSTLToLoopsInPlane } from '../../lib/geometry/stlProjection'
import type { Loop2D, Project, Vec2 } from '../../types'

const opts = { simplificationTolerance: 0.02, minPerimeter: 0.12 }
const rect = (a: number, b: number, c: number, d: number): Vec2[] =>
  [{ x: a, y: b }, { x: c, y: b }, { x: c, y: d }, { x: a, y: d }]
// Four nesting depths plus a disconnected exterior; every wall has the SAME
// winding deliberately. These are exact analytic boundaries, not slicer output.
const rings = [rect(-20, -20, 20, 20), rect(-15, -15, 15, 15),
  rect(-10, -10, 10, 10), rect(-5, -5, 5, 5), rect(30, 0, 36, 6)]
const types = ['contour', 'hole', 'contour', 'hole', 'contour']
function walls(polygons: Vec2[][]) {
  const triangles: number[][] = []
  for (const points of polygons) for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    triangles.push([a.x, a.y, -2, b.x, b.y, -2, b.x, b.y, 2],
      [a.x, a.y, -2, b.x, b.y, 2, a.x, a.y, 2])
  }
  return triangles
}
function toBoundary(p: Vec2, points: Vec2[]) {
  return Math.min(...points.map((a, i) => {
    const b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
  }))
}
function deviation(a: Vec2[], b: Vec2[]) {
  return Math.max(...a.map(p => toBoundary(p, b)), ...b.map(p => toBoundary(p, a)))
}
function assertBoundaries(loops: Loop2D[], expected: Vec2[][], expectedTypes: string[], tolerance = 0.02) {
  expect(loops).toHaveLength(expected.length)
  const used = new Set<number>()
  for (const loop of loops) {
    const matches = expected.flatMap((boundary, index) => deviation(loop.points, boundary) < tolerance ? [index] : [])
    expect(matches, 'Exactly one independent boundary must match bidirectionally').toHaveLength(1)
    expect(used.has(matches[0]), 'Boundary mapping must be bijective').toBe(false)
    used.add(matches[0])
    expect(loop.closed).toBe(true)
    expect(loop.type, `containment depth for boundary ${matches[0]}`).toBe(expectedTypes[matches[0]])
  }
  expect(used.size).toBe(expected.length)
}

// Separate raw binary-STL intersection/graph, without production slicing,
// snapping, simplification, loop building or point-in-polygon implementation.
function plateBoundaries(project: Project): Vec2[][] {
  const plate = project.geometry.find(g => g.name === 'Plate')!
  const bytes = Buffer.from(project.binaries![plate.id].stl!, 'base64')
  const edges: Vec2[][] = []
  for (let t = 0; t < bytes.readUInt32LE(80); t++) {
    const vertices = [0, 1, 2].map(v => {
      const offset = 84 + t * 50 + 12 + v * 12
      return { x: bytes.readFloatLE(offset) + plate.position.x,
        y: bytes.readFloatLE(offset + 4) + plate.position.y, z: bytes.readFloatLE(offset + 8) + plate.position.z }
    })
    const hits: Vec2[] = []
    for (let i = 0; i < 3; i++) {
      const a = vertices[i], b = vertices[(i + 1) % 3]
      if ((a.z < 2) === (b.z < 2)) continue
      const f = (2 - a.z) / (b.z - a.z)
      hits.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) })
    }
    if (hits.length === 2) edges.push(hits)
  }
  const key = (p: Vec2) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`
  const adjacency = new Map<string, number[]>()
  edges.forEach((edge, i) => edge.forEach(p => adjacency.set(key(p), [...(adjacency.get(key(p)) ?? []), i])))
  expect([...adjacency.values()].every(es => es.length === 2)).toBe(true)
  const used = new Set<number>(), boundaries: Vec2[][] = []
  edges.forEach(([a, b], i) => {
    if (used.has(i)) return
    used.add(i)
    const chain = [a]; let next = b
    while (key(next) !== key(a)) {
      chain.push(next)
      const index = adjacency.get(key(next))!.find(e => !used.has(e))
      expect(index, 'independent boundary must close').toBeDefined()
      used.add(index!)
      const edge = edges[index!]
      next = key(edge[0]) === key(next) ? edge[1] : edge[0]
    }
    boundaries.push(chain)
  })
  return boundaries.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))
}
function area(points: Vec2[]) {
  return points.reduce((s, a, i) => { const b = points[(i + 1) % points.length]; return s + a.x * b.y - a.y * b.x }, 0) / 2
}

describe('WO-2935 STL containment', () => {
  it.each(['original', 'reversed triangles', 'reversed winding', 'mixed winding'] as const)('%s: both wrappers classify nested islands and disjoint contours', variant => {
    let triangles = walls(rings)
    if (variant === 'reversed triangles') triangles = triangles.reverse()
    if (variant === 'reversed winding' || variant === 'mixed winding') triangles = triangles.map((t, i) =>
      variant === 'reversed winding' || i % 2 ? [...t.slice(6, 9), ...t.slice(3, 6), ...t.slice(0, 3)] : t)
    const positions = Float32Array.from(triangles.flat())
    assertBoundaries(projectSTLToLoops(positions, null, { ...opts, sliceZ: 0 }).loops, rings, types)
    assertBoundaries(projectSTLToLoopsInPlane(positions, { ...opts,
      planeNormal: { x: 0, y: 0, z: 1 }, planeOrigin: { x: 0, y: 0, z: 0 } }).loops, rings, types)
  })

  it('retains containment for indexed input and the default slice height', () => {
    const pos = Float32Array.from(walls(rings).flat())
    for (const Index of [Uint16Array, Uint32Array]) {
      assertBoundaries(projectSTLToLoops(pos, new Index(Array.from({ length: pos.length / 3 }, (_, i) => i)), opts).loops, rings, types)
    }
  })

  it.each([0, Math.PI / 3])('preserves translated/rotated coordinates at angle %s', angle => {
    const transform = (x: number, y: number) => ({ x: 83 + Math.cos(angle) * x - Math.sin(angle) * y,
      y: -27 + Math.sin(angle) * x + Math.cos(angle) * y })
    const translated = rings.map(points => points.map(p => transform(p.x, p.y)))
    assertBoundaries(projectSTLToLoops(Float32Array.from(walls(translated).flat()), null, { ...opts, sliceZ: 0 }).loops, translated, types)
  })

  it('classifies a tilted oblique slice in its own frame without moving it', () => {
    const normal = { x: 0.36, y: 0.48, z: 0.8 }, origin = { x: 71, y: -22, z: 13 }
    const { xAxis: X, yAxis: Y } = buildPlaneFrame(normal)
    const positions = walls(rings).flatMap(t => [0, 3, 6].flatMap(i => [
      origin.x + t[i] * X.x + t[i + 1] * Y.x + t[i + 2] * normal.x,
      origin.y + t[i] * X.y + t[i + 1] * Y.y + t[i + 2] * normal.y,
      origin.z + t[i] * X.z + t[i + 1] * Y.z + t[i + 2] * normal.z,
    ]))
    const result = projectSTLToLoopsInPlane(Float32Array.from(positions), { ...opts, planeNormal: normal, planeOrigin: origin })
    assertBoundaries(result.loops, rings, types)
    expect(result.frame).toEqual({ origin, normal, xAxis: X, yAxis: Y })
  })

  it('uses a boundary vertex rather than a concave child centroid outside its parent', () => {
    const outer = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 12 }, { x: 0, y: 12 }]
    const inner = [{ x: 0.3, y: 0.3 }, { x: 11, y: 0.3 }, { x: 11, y: 1.3 }, { x: 1.3, y: 1.3 }, { x: 1.3, y: 11 }, { x: 0.3, y: 11 }]
    const expected = [outer, inner]
    assertBoundaries(projectSTLToLoops(Float32Array.from(walls(expected).flat()), null, { ...opts, sliceZ: 0 }).loops, expected, ['contour', 'hole'])
  })

  it('matches the exact Plate boundaries bijectively and classifies all five openings', () => {
    const project = JSON.parse(gunzipSync(readFileSync('src/tests/evidence/WO-2935/original.camproject.gz')).toString()) as Project
    const mesh = JSON.parse(readFileSync('src/tests/evidence/WO-2935/world-mesh.json', 'utf8')) as { positions: number[] }
    const expected = plateBoundaries(project)
    expect(expected).toHaveLength(6)
    assertBoundaries(projectSTLToLoopsInPlane(Float32Array.from(mesh.positions), { ...opts,
      planeNormal: { x: 0, y: 0, z: 1 }, planeOrigin: { x: 0, y: 0, z: 2 } }).loops,
    expected, ['contour', 'hole', 'hole', 'hole', 'hole', 'hole'])
  })
})
