// Form - a face by clicks: corners clicked on a work
// plane, or on the form's own points, make a face.
//
// A click is a new point on the work plane (the ray meets the plane there) or
// an existing cage point (a click on it snaps), so a new face can share an
// edge with the form and a strip of faces grows one face at a time. The new
// face is wound to agree with any face it shares an edge with (a shared edge
// runs the other way in each); with none, it faces the work plane's normal.
// An edge already joining two faces cannot take a third, and a face needs
// three distinct, non-collinear corners: those are the only refusals.

import type { Cage, Vec3 } from './cage'
import { validateCage } from './halfEdge'

/** A clicked corner: a point of the cage, or a new point at `at`. */
export type FaceClick = { point: number } | { at: Vec3 }

export interface WorkPlane { origin: Vec3; normal: Vec3 }

/**
 * The cage with a face through `clicks` added (`replace`: the face alone, a
 * new form), or why it cannot be.
 */
export function addClickedFace(cage: Cage, clicks: readonly FaceClick[], plane: WorkPlane, replace = false): { cage: Cage; face: number[]; corners: number[] } | { reason: string } {
  const base: Cage = replace ? { positions: [], faces: [], creases: [] } : cage
  const positions = base.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  const loop: number[] = []
  for (const c of clicks) {
    if ('point' in c && !replace) loop.push(c.point)
    else {
      const at: Vec3 = 'at' in c ? c.at : cage.positions[c.point]
      // a click where an earlier click of this face already put a point is that point
      const again = loop.find((i) => i >= base.positions.length && dist(positions[i], at) < 1e-9)
      if (again !== undefined) loop.push(again)
      else { positions.push([at[0], at[1], at[2]]); loop.push(positions.length - 1) }
    }
  }
  if (new Set(loop).size !== loop.length || loop.length < 3) return { reason: 'A face needs three or more different corners' }
  const corners = loop.map((i) => positions[i])
  const n = newell(corners)
  const size = Math.max(...corners.map((p) => dist(p, corners[0])))
  if (!(Math.hypot(n[0], n[1], n[2]) > 1e-9 * Math.max(1, size * size))) return { reason: 'Those corners are on one line: a face needs some width' }
  // wind it against a face it shares an edge with; else toward the work plane's normal
  const directed = new Set<string>()
  for (const f of base.faces) for (let i = 0; i < f.length; i++) directed.add(`${f[i]}>${f[(i + 1) % f.length]}`)
  let flip: boolean | null = null
  for (let i = 0; i < loop.length && flip === null; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    if (directed.has(`${a}>${b}`)) flip = true
    else if (directed.has(`${b}>${a}`)) flip = false
  }
  if (flip === null) flip = n[0] * plane.normal[0] + n[1] * plane.normal[1] + n[2] * plane.normal[2] < 0
  const face = flip ? [...loop].reverse() : loop
  const next: Cage = { ...base, positions, faces: [...base.faces, face], creases: base.creases.slice() }
  // an edge can join only two faces; the new face must also agree with its neighbours round every edge
  for (let i = 0; i < face.length; i++) {
    const a = face[i], b = face[(i + 1) % face.length]
    const on = base.faces.filter((f) => f.some((p, k) => (p === a && f[(k + 1) % f.length] === b) || (p === b && f[(k + 1) % f.length] === a)))
    if (on.length >= 2) return { reason: `The edge between those corners already joins two faces; an edge can join only two` }
    if (directed.has(`${a}>${b}`)) return { reason: 'That face would turn against the faces beside it (its corners go round the other way to theirs on two sides)' }
  }
  const problems = validateCage(next, false).problems
  if (problems.length > 0) return { reason: `That face would leave the form invalid: ${problems[0]}` }
  // `corners`: the new face's points in the order they were clicked (the face itself may run the other way)
  return { cage: next, face, corners: loop }
}

/** Where the pointer ray (origin, unit direction) meets the work plane, or null when it runs along it or away. */
export function rayOnPlane(origin: Vec3, dir: Vec3, plane: WorkPlane): Vec3 | null {
  const d = dir[0] * plane.normal[0] + dir[1] * plane.normal[1] + dir[2] * plane.normal[2]
  if (Math.abs(d) < 1e-9) return null
  const t = ((plane.origin[0] - origin[0]) * plane.normal[0] + (plane.origin[1] - origin[1]) * plane.normal[1] + (plane.origin[2] - origin[2]) * plane.normal[2]) / d
  if (t < 0) return null
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]
}

function newell(pts: readonly Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    n[0] += (a[1] - b[1]) * (a[2] + b[2])
    n[1] += (a[2] - b[2]) * (a[0] + b[0])
    n[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return n
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
