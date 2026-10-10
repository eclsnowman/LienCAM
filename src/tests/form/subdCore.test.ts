// Form stage 1: cage topology, validator, starters, Catmull-Clark with creases,
// stencils, and undo/redo. Each block names the behaviour it proves; the
// negative controls recorded in docs/design/FORM-ENVIRONMENT.md (Progress)
// break exactly that behaviour and watch the block go red.

import { describe, expect, it } from 'vitest'
import { cloneCage, edgeKey, cageEdges, type Cage } from '../../form/cage'
import { validateCage } from '../../form/halfEdge'
import { boxCage, creaseRimAt, cylinderCage, planeCage, sphereCage } from '../../form/starters'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine } from '../../form/subdivide'
import { compileSkin, evaluateSkin, skinOf } from '../../form/surface'
import { emptyHistory, pushHistory, redoCage, undoCage } from '../../form/history'

/** Subdivide positions directly, step by step (no stencil composition). */
function directSubdivide(cage: Cage, levels: number, withLimit: boolean): Float64Array {
  let level = levelFromCage(cage)
  let pts = cagePositionArray(cage)
  for (let i = 0; i < levels; i++) {
    const r = refine(level)
    pts = applyRows(r.rows, pts)
    level = r.level
  }
  return withLimit && levels >= 1 ? applyRows(limitRows(level), pts) : pts
}

function point(pts: ArrayLike<number>, i: number): [number, number, number] {
  return [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]
}

describe('starters', () => {
  it('box, cylinder and sphere are closed, oriented, manifold; the plane is open', () => {
    for (const cage of [boxCage(), cylinderCage(), sphereCage()]) {
      const v = validateCage(cage, true)
      expect(v.problems).toEqual([])
      expect(v.ok).toBe(true)
      expect(v.closed).toBe(true)
      expect(v.eulerCharacteristic).toBe(2)
    }
    const plane = validateCage(planeCage(), false)
    expect(plane.ok).toBe(true)
    expect(plane.closed).toBe(false)
    expect(plane.boundaryEdgeCount).toBe(16)
  })

  it('segment counts set the face counts', () => {
    expect(boxCage({ segments: { x: 2, y: 2, z: 2 } }).faces).toHaveLength(24)
    expect(boxCage({ segments: { x: 3, y: 1, z: 2 } }).faces).toHaveLength(2 * 3 * 1 + 2 * 3 * 2 + 2 * 1 * 2)
    expect(cylinderCage({ segments: { x: 8, y: 1, z: 2 } }).faces).toHaveLength(8 * 2 + 2)
    expect(sphereCage({ segments: { x: 3, y: 3, z: 3 } }).faces).toHaveLength(54)
    expect(planeCage({ segments: { x: 5, y: 3, z: 1 } }).faces).toHaveLength(15)
  })

  it('starters sit on Z = 0 centred on the Z axis', () => {
    for (const cage of [boxCage(), cylinderCage(), sphereCage()]) {
      const zs = cage.positions.map((p) => p[2])
      expect(Math.min(...zs)).toBeCloseTo(0, 9)
      const cx = cage.positions.reduce((s, p) => s + p[0], 0) / cage.positions.length
      expect(Math.abs(cx)).toBeLessThan(1e-9)
    }
  })
})

describe('validator', () => {
  it('refuses a flipped face (inconsistent orientation)', () => {
    const cage = boxCage()
    cage.faces[0] = cage.faces[0].slice().reverse()
    const v = validateCage(cage, true)
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/oriented/)
  })

  it('refuses a non-manifold edge (three faces on one edge)', () => {
    const cage = planeCage({ segments: { x: 1, y: 1, z: 1 } })
    // add two more faces on edge 0-1, one on each side
    cage.positions.push([0, 0, 10], [0, 0, -10])
    cage.faces.push([1, 0, 4], [0, 1, 5])
    const v = validateCage(cage)
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/non-manifold|oriented/)
  })

  it('reports an open cage when closed is expected', () => {
    const cage = boxCage()
    cage.faces.pop()
    const v = validateCage(cage, true)
    expect(v.closed).toBe(false)
    expect(v.ok).toBe(false)
  })

  it('refuses a point shared by two separate fans (bow-tie)', () => {
    const cage: Cage = {
      positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]],
      faces: [[0, 1, 2], [0, 3, 4]],
      creases: [],
    }
    const v = validateCage(cage)
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/separate fans/)
  })

  it('refuses a crease that is not an edge', () => {
    const cage = boxCage()
    cage.creases.push(edgeKey(0, 999))
    expect(validateCage(cage).ok).toBe(false)
  })
})

describe('Catmull-Clark refinement', () => {
  it('turns every n-gon into n quads and keeps the cage a closed surface', () => {
    const cage = cylinderCage({ segments: { x: 6, y: 1, z: 1 } })
    const r = refine(levelFromCage(cage))
    expect(r.level.faces).toHaveLength(6 * 4 + 6 + 6)
    expect(r.level.faces.every((f) => f.length === 4)).toBe(true)
    const pts = applyRows(r.rows, cagePositionArray(cage))
    const fine: Cage = { positions: Array.from({ length: r.level.vertexCount }, (_, i) => point(pts, i)), faces: r.level.faces, creases: [...r.level.creases] }
    const v = validateCage(fine, true)
    expect(v.problems).toEqual([])
    expect(v.eulerCharacteristic).toBe(2)
  })

  it('every refinement row sums to 1 (affine invariance)', () => {
    const r = refine(levelFromCage(creaseRimAt(boxCage(), 0)))
    for (let row = 0; row + 1 < r.rows.offsets.length; row++) {
      let sum = 0
      for (let k = r.rows.offsets[row]; k < r.rows.offsets[row + 1]; k++) sum += r.rows.weights[k]
      expect(sum).toBeCloseTo(1, 12)
    }
  })

  it('smooth rule: a smooth box shrinks toward a rounded shape (corner points move in)', () => {
    const cage = boxCage({ segments: { x: 1, y: 1, z: 1 }, size: { x: 30, y: 30, z: 30 } })
    const pts = directSubdivide(cage, 1, false)
    // Catmull-Clark on a cube corner of valence 3: new P = (F + 2R + 0 P) / 3
    // with F = average of the three face centres, R = average of the three edge midpoints.
    // For the corner (15,15,30) of a 30 mm cube on Z=0 that is (5/9 * 15 ...):
    const corner = cage.positions.findIndex((p) => p[0] > 0 && p[1] > 0 && p[2] > 0)
    const [x, y, z] = point(pts, corner)
    // face centres of the three faces at that corner: (15,0,15), (0,15,15), (0,0,30) relative
    // edge midpoints: (15,15,15), (15,0,30), (0,15,30)
    const F = [(15 + 0 + 0) / 3, (0 + 15 + 0) / 3, (15 + 15 + 30) / 3]
    const R = [(15 + 15 + 0) / 3, (15 + 0 + 15) / 3, (15 + 30 + 30) / 3]
    expect(x).toBeCloseTo((F[0] + 2 * R[0]) / 3, 9)
    expect(y).toBeCloseTo((F[1] + 2 * R[1]) / 3, 9)
    expect(z).toBeCloseTo((F[2] + 2 * R[2]) / 3, 9)
  })

  it('crease rule: a box with every edge creased keeps its sharp corners and flat sides', () => {
    const base = boxCage({ segments: { x: 2, y: 2, z: 2 }, size: { x: 30, y: 30, z: 30 } })
    const cage: Cage = { ...base, creases: cageEdges(base).filter(([a, b]) => {
      // cube edges: both points on two shared extreme planes
      const pa = base.positions[a], pb = base.positions[b]
      let shared = 0
      for (let k = 0; k < 3; k++) {
        for (const lim of k === 2 ? [0, 30] : [-15, 15]) if (Math.abs(pa[k] - lim) < 1e-9 && Math.abs(pb[k] - lim) < 1e-9) shared++
      }
      return shared >= 2
    }).map(([a, b]) => edgeKey(a, b)) }
    const { buffers } = skinOf(cage, 3)
    const n = buffers.points.length / 3
    // corners stay put
    for (let i = 0; i < cage.positions.length; i++) {
      const p = cage.positions[i]
      const isCorner = Math.abs(Math.abs(p[0]) - 15) < 1e-9 && Math.abs(Math.abs(p[1]) - 15) < 1e-9 && (Math.abs(p[2]) < 1e-9 || Math.abs(p[2] - 30) < 1e-9)
      if (!isCorner) continue
      const q = point(buffers.points, i)
      expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeLessThan(1e-9)
    }
    // every skin point lies on the surface of the cube (on at least one side plane)
    for (let i = 0; i < n; i++) {
      const [x, y, z] = point(buffers.points, i)
      const onSide = Math.abs(Math.abs(x) - 15) < 1e-6 || Math.abs(Math.abs(y) - 15) < 1e-6 || Math.abs(z) < 1e-6 || Math.abs(z - 30) < 1e-6
      expect(onSide).toBe(true)
    }
  })

  it('a creased bottom rim keeps the bottom of a cylinder flat on Z = 0', () => {
    const cage = creaseRimAt(cylinderCage({ segments: { x: 8, y: 1, z: 2 } }), 0)
    const { buffers } = skinOf(cage, 3)
    const zs: number[] = []
    for (let i = 0; i < buffers.points.length / 3; i++) zs.push(buffers.points[i * 3 + 2])
    const bottom = zs.filter((z) => z < 1)
    expect(bottom.length).toBeGreaterThan(20)
    for (const z of bottom) expect(Math.abs(z)).toBeLessThan(1e-9)
  })

  it('open plane: boundary follows the boundary curve rule and corners stay put', () => {
    const cage = planeCage({ segments: { x: 3, y: 3, z: 1 } })
    const { buffers } = skinOf(cage, 2)
    for (let i = 0; i < buffers.points.length / 3; i++) expect(Math.abs(buffers.points[i * 3 + 2])).toBeLessThan(1e-12)
    const corner = cage.positions.findIndex((p) => p[0] < -29 && p[1] < -29)
    const q = point(buffers.points, corner)
    expect(q[0]).toBeCloseTo(-30, 9)
    expect(q[1]).toBeCloseTo(-30, 9)
  })
})

describe('limit surface and stencils', () => {
  it('the limit mask agrees with refining further (a skin point sits on the limit surface)', () => {
    const cage = sphereCage({ segments: { x: 2, y: 2, z: 2 } })
    cage.positions[5] = [cage.positions[5][0] * 1.4, cage.positions[5][1], cage.positions[5][2] + 6]
    const limit = directSubdivide(cage, 1, true)
    const deep = directSubdivide(cage, 7, false)
    // cage point indices are kept at every level, so compare point for point
    const pointsAtLevel1 = refine(levelFromCage(cage)).level.vertexCount
    let worst = 0
    for (let i = 0; i < pointsAtLevel1; i++) {
      const a = point(limit, i), b = point(deep, i)
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('stencil evaluation equals direct subdivision, before and after a cage point moves', () => {
    const cage = creaseRimAt(cylinderCage({ segments: { x: 6, y: 1, z: 2 } }), 0)
    const skin = compileSkin(cage, 3)
    const a = evaluateSkin(skin, cagePositionArray(cage)).points
    const b = directSubdivide(cage, 3, true)
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 9)

    // drag: only positions change, the compiled stencils are reused
    const moved = cloneCage(cage)
    moved.positions[moved.positions.length - 1] = [4, 30, 40]
    const c = evaluateSkin(skin, cagePositionArray(moved)).points
    const d = directSubdivide(moved, 3, true)
    for (let i = 0; i < c.length; i++) expect(c[i]).toBeCloseTo(d[i], 9)
    expect(c.some((v, i) => Math.abs(v - a[i]) > 1e-3)).toBe(true)
  })

  it('shading splits across creases only', () => {
    const smooth = compileSkin(sphereCage(), 2)
    expect(smooth.renderSource.length).toBe(smooth.topology.vertexCount)
    const creased = compileSkin(creaseRimAt(cylinderCage(), 0), 2)
    expect(creased.renderSource.length).toBeGreaterThan(creased.topology.vertexCount)
    // normals on the flat creased bottom face straight down
    const buf = evaluateSkin(creased, cagePositionArray(creaseRimAt(cylinderCage(), 0)))
    let bottomDown = 0
    for (let r = 0; r < creased.renderSource.length; r++) {
      if (Math.abs(buf.positions[r * 3 + 2]) < 1e-9 && buf.normals[r * 3 + 2] < -0.5) {
        expect(buf.normals[r * 3 + 2]).toBeLessThan(-0.999)
        bottomDown++
      }
    }
    expect(bottomDown).toBeGreaterThan(5)
  })

  it('normals point outward on a closed starter', () => {
    const { skin, buffers } = skinOf(sphereCage(), 2)
    for (let r = 0; r < skin.renderSource.length; r++) {
      const dx = buffers.positions[r * 3], dy = buffers.positions[r * 3 + 1], dz = buffers.positions[r * 3 + 2] - 20
      const dot = dx * buffers.normals[r * 3] + dy * buffers.normals[r * 3 + 1] + dz * buffers.normals[r * 3 + 2]
      expect(dot).toBeGreaterThan(0)
    }
  })
})

describe('undo / redo', () => {
  it('whole-cage snapshots walk back and forward', () => {
    let history = emptyHistory()
    const c0 = boxCage()
    const c1 = cloneCage(c0); c1.positions[0] = [99, 0, 0]
    history = pushHistory(history, c0)
    const c2 = cloneCage(c1); c2.positions[1] = [0, 99, 0]
    history = pushHistory(history, c1)
    const u1 = undoCage(history, c2)!
    expect(u1.cage.positions[1]).toEqual(c1.positions[1])
    const u2 = undoCage(u1.history, u1.cage)!
    expect(u2.cage.positions[0]).toEqual(c0.positions[0])
    expect(undoCage(u2.history, u2.cage)).toBeNull()
    const r1 = redoCage(u2.history, u2.cage)!
    expect(r1.cage.positions[0]).toEqual([99, 0, 0])
    // a new change clears redo
    const branched = pushHistory(r1.history, r1.cage)
    expect(redoCage(branched, r1.cage)).toBeNull()
  })

  it('snapshots do not share arrays with the live cage', () => {
    const c0 = boxCage()
    const history = pushHistory(emptyHistory(), c0)
    c0.positions[0][0] = 1234
    expect(history.past[0].positions[0][0]).not.toBe(1234)
  })
})
