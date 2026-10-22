// WO-2750 Slice A (WO-2981): orthographic projection for technical drawings.
//
// Two producers, one scene type (types.ts ProjectionScene):
//
//   - projectBrepHlr: the pinned occt-wasm kernel's own hidden-line removal
//     (HLRBRep, exposed as `projectEdges`). Measured in
//     src/tests/drawing/projection.wo2750.test.ts. It needs NO OCCT source
//     change: the binding already ships in the pinned build.
//   - projectMesh: a raw (edited) triangle mesh, no BREP conversion. Lines are
//     the mesh's boundary/sharp chains (extractMeshEdgeChains) plus the
//     view-dependent silhouette where a front-facing and a back-facing
//     triangle meet. Visibility is decided per short piece by a ray from the
//     piece toward the viewer against the triangles (a uniform grid keeps it
//     fast). Approximate by construction; the scene says so.
//
// Both producers then drop hidden pieces that a visible line covers (a box's
// back edges sit exactly under its front edges in an orthographic view).
//
// Coordinates: view mm, u along frame.xAxis (paper right), v along
// frame.upAxis (paper up). toSheet() applies a rational scale and places the
// view on paper (sheet mm, origin top-left, Y down). Scale never changes a
// measured value; it only changes paper length.

import type { OcctKernel, ShapeHandle } from 'occt-wasm'
import { extractMeshEdgeChains } from '../../mesh/edgeChains'
import type { MeshBuffers } from '../../mesh/types'
import type {
  DrawingVec3,
  LineCategory,
  LineVisibility,
  ProjectedLine,
  ProjectionScene,
  RationalScale,
  SheetLine,
  StandardViewName,
  ViewFrame,
} from './types'

export const OCCT_HLR_PRODUCER = 'occt-wasm-3.6.1/HLRBRep'
export const MESH_OCCLUSION_PRODUCER = 'liencam-mesh-occlusion/1'

/** Default chord deflection when discretizing projected curves, model mm. */
export const DEFAULT_CHORD_MM = 0.01

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function v3(x: number, y: number, z: number): DrawingVec3 {
  return [x, y, z]
}

function sub(a: DrawingVec3, b: DrawingVec3): DrawingVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a: DrawingVec3, b: DrawingVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: DrawingVec3, b: DrawingVec3): DrawingVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function unit(a: DrawingVec3): DrawingVec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  if (l === 0) throw new Error('drawing view frame: zero-length direction')
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * Build an orthonormal frame. `xAxis` is made perpendicular to `towardViewer`;
 * paper up is towardViewer x xAxis, so (x, up, towardViewer) is right-handed.
 */
export function makeViewFrame(towardViewer: DrawingVec3, xAxis: DrawingVec3, origin: DrawingVec3 = [0, 0, 0], name?: StandardViewName): ViewFrame {
  const z = unit(towardViewer)
  const x = unit(sub(xAxis, scale3(z, dot(xAxis, z))))
  const up = cross(z, x)
  return { ...(name ? { name } : {}), origin, towardViewer: z, xAxis: x, upAxis: up }
}

function scale3(a: DrawingVec3, k: number): DrawingVec3 {
  return [a[0] * k, a[1] * k, a[2] * k]
}

/**
 * Standard views, Z up. Front looks along +Y (viewer on -Y), top looks down
 * -Z, right looks along -X (viewer on +X), iso looks from (+1, -1, +1).
 * Their placement on the sheet (first or third angle) is a layout concern and
 * does not change the frames.
 */
export function standardViewFrame(name: StandardViewName, origin: DrawingVec3 = [0, 0, 0]): ViewFrame {
  switch (name) {
    case 'front': return makeViewFrame(v3(0, -1, 0), v3(1, 0, 0), origin, name)
    case 'top': return makeViewFrame(v3(0, 0, 1), v3(1, 0, 0), origin, name)
    case 'right': return makeViewFrame(v3(1, 0, 0), v3(0, 1, 0), origin, name)
    case 'iso': return makeViewFrame(v3(1, -1, 1), v3(1, 1, 0), origin, name)
  }
}

/** Orthographic projection of a model point to view mm. */
export function projectPoint(frame: ViewFrame, p: DrawingVec3): [number, number] {
  const d = sub(p, frame.origin)
  return [dot(d, frame.xAxis), dot(d, frame.upAxis)]
}

/** Depth toward the viewer (bigger = nearer the eye). */
function depthOf(frame: ViewFrame, p: DrawingVec3): number {
  return dot(sub(p, frame.origin), frame.towardViewer)
}

// ---------------------------------------------------------------------------
// BREP: the kernel's hidden-line removal
// ---------------------------------------------------------------------------

/** The slice of OcctKernel this module uses (kept narrow so tests can see it). */
export type HlrKernel = Pick<OcctKernel, 'projectEdges' | 'wireframe' | 'release'>

export interface BrepProjectionOptions {
  /** chord deflection for curved edges, model mm (default 0.01) */
  chordMm?: number
  /** hidden pieces within this distance of a visible line are dropped, model mm */
  coincidenceMm?: number
  now?: () => number
}

const HLR_GROUPS: Array<[keyof ReturnType<OcctKernel['projectEdges']>, LineVisibility, LineCategory]> = [
  ['visibleSharp', 'visible', 'sharp'],
  ['visibleSmooth', 'visible', 'smooth'],
  ['visibleOutline', 'visible', 'outline'],
  ['hiddenSharp', 'hidden', 'sharp'],
  ['hiddenSmooth', 'hidden', 'smooth'],
  ['hiddenOutline', 'hidden', 'outline'],
]

/**
 * Project a BREP shape with the kernel's HLR. The kernel returns edges already
 * flattened into its projection plane, (u, v, 0) with u along xAxis and v along
 * towardViewer x xAxis, relative to the frame origin - the same convention as
 * makeViewFrame (asserted against analytic vertices in the projection test).
 */
export function projectBrepHlr(kernel: HlrKernel, shape: ShapeHandle, frame: ViewFrame, opts: BrepProjectionOptions = {}): ProjectionScene {
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  const chord = opts.chordMm ?? DEFAULT_CHORD_MM
  const o = { x: frame.origin[0], y: frame.origin[1], z: frame.origin[2] }
  const dir = { x: frame.towardViewer[0], y: frame.towardViewer[1], z: frame.towardViewer[2] }
  const xa = { x: frame.xAxis[0], y: frame.xAxis[1], z: frame.xAxis[2] }
  const proj = kernel.projectEdges(shape, o, dir, xa)
  const raw: ProjectedLine[] = []
  try {
    for (const [key, visibility, category] of HLR_GROUPS) {
      const h = proj[key]
      if (Number(h) === 0) continue
      const { points, edgeGroups } = kernel.wireframe(h, chord)
      for (let g = 0; g < edgeGroups.length; g += 3) {
        const start = edgeGroups[g]
        const count = edgeGroups[g + 1]
        const line: Array<[number, number]> = []
        for (let i = 0; i < count; i += 3) line.push([points[start + i], points[start + i + 1]])
        if (line.length >= 2) raw.push({ visibility, category, points: line })
      }
    }
  } finally {
    for (const [key] of HLR_GROUPS) {
      const h = proj[key]
      if (Number(h) !== 0) try { kernel.release(h) } catch { /* already released */ }
    }
  }
  const { lines, suppressedMm, duplicateMm } = suppressHiddenUnderVisible(raw, opts.coincidenceMm ?? Math.max(chord * 2, 1e-3))
  return {
    frame,
    producer: 'occt-hlr',
    producerVersion: OCCT_HLR_PRODUCER,
    chordToleranceMm: chord,
    lines,
    limits: [
      'Curved silhouettes ("outline") are view-dependent; they are not model edges and cannot carry a dimension reference.',
      'Seam edges of periodic faces are reported as sharp edges by the kernel.',
    ],
    stats: { ...lengths(lines), hiddenSuppressedLengthMm: suppressedMm, duplicateSuppressedLengthMm: duplicateMm, ms: now() - t0 },
  }
}

// ---------------------------------------------------------------------------
// Raw mesh: chains + silhouettes, ray occlusion
// ---------------------------------------------------------------------------

export interface MeshProjectionOptions {
  /** sharp-edge threshold passed to extractMeshEdgeChains, degrees */
  featureAngleDeg?: number
  /** longest piece classified as one unit, model mm (default 0.5) */
  pieceMm?: number
  /** depth slack against self-occlusion, as a fraction of the bbox diagonal */
  depthEpsFraction?: number
  coincidenceMm?: number
  now?: () => number
}

interface Tri {
  a: DrawingVec3
  b: DrawingVec3
  c: DrawingVec3
  /** view coords of a, b, c */
  pa: [number, number]
  pb: [number, number]
  pc: [number, number]
}

/**
 * Project a triangle mesh (already the EDITED mesh: resolveEditedStlMesh) into
 * a view. Approximate: visibility is sampled per piece, silhouettes follow the
 * facets, and the chord error is the mesh's own facet error, which this
 * producer cannot know - it reports 0 and lists that limit.
 */
export function projectMesh(mesh: MeshBuffers, frame: ViewFrame, opts: MeshProjectionOptions = {}): ProjectionScene {
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  const pos = mesh.positions
  const idx = mesh.indices
  const P = (i: number): DrawingVec3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]
  const tris: Tri[] = []
  const min: DrawingVec3 = [Infinity, Infinity, Infinity]
  const max: DrawingVec3 = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = P(idx[t]), b = P(idx[t + 1]), c = P(idx[t + 2])
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]) }
    tris.push({ a, b, c, pa: projectPoint(frame, a), pb: projectPoint(frame, b), pc: projectPoint(frame, c) })
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  const eps = diag * (opts.depthEpsFraction ?? 1e-4)
  const piece = opts.pieceMm ?? 0.5
  const grid = buildGrid(tris)

  const sources: Array<{ pts: DrawingVec3[]; closed: boolean; category: LineCategory; id?: string }> = []
  for (const chain of extractMeshEdgeChains(mesh, { featureAngleDeg: opts.featureAngleDeg })) {
    sources.push({ pts: chain.points, closed: chain.closed, category: 'feature', id: chain.id })
  }
  for (const seg of silhouetteSegments(tris, frame, diag)) sources.push({ pts: seg, closed: false, category: 'silhouette' })

  const raw: ProjectedLine[] = []
  for (const src of sources) {
    const pts = src.closed ? [...src.pts, src.pts[0]] : src.pts
    let cur: ProjectedLine | undefined
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      const n = Math.max(1, Math.ceil(len / piece))
      for (let k = 0; k < n; k++) {
        const s0 = lerp(a, b, k / n), s1 = lerp(a, b, (k + 1) / n)
        const vis: LineVisibility = occluded(lerp(a, b, (k + 0.5) / n), frame, grid, eps) ? 'hidden' : 'visible'
        const p0 = projectPoint(frame, s0), p1 = projectPoint(frame, s1)
        if (cur && cur.visibility === vis) {
          cur.points.push(p1)
        } else {
          cur = { visibility: vis, category: src.category, points: [p0, p1], ...(src.id ? { sourceId: src.id } : {}) }
          raw.push(cur)
        }
      }
    }
  }
  const { lines, suppressedMm, duplicateMm } = suppressHiddenUnderVisible(raw, opts.coincidenceMm ?? Math.max(diag * 1e-5, 1e-3))
  return {
    frame,
    producer: 'mesh-occlusion',
    producerVersion: MESH_OCCLUSION_PRODUCER,
    chordToleranceMm: 0,
    lines,
    limits: [
      'Raw mesh: lines follow the facets; a round edge is a polygon with the mesh\'s own facet error, which is not measured here.',
      `Visibility is sampled every ${piece} mm along each line; a change of visibility inside one piece is placed at its end.`,
      'Silhouettes are view-dependent facet contours, never durable references.',
    ],
    stats: { ...lengths(lines), hiddenSuppressedLengthMm: suppressedMm, duplicateSuppressedLengthMm: duplicateMm, ms: now() - t0 },
  }
}

function lerp(a: DrawingVec3, b: DrawingVec3, t: number): DrawingVec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * Edges where a triangle facing the viewer meets one facing away. Welded by
 * position (1e-6 of the bbox diagonal) so a triangle-soup STL still has
 * neighbours. Edges with one triangle (open meshes) are boundary chains and
 * already come from extractMeshEdgeChains.
 */
function silhouetteSegments(tris: Tri[], frame: ViewFrame, diag: number): DrawingVec3[][] {
  const tol = diag * 1e-6
  const key = (p: DrawingVec3) => p.map(c => Math.round(c / tol)).join(':')
  const edges = new Map<string, { a: DrawingVec3; b: DrawingVec3; facing: number[] }>()
  for (const t of tris) {
    const n = cross(sub(t.b, t.a), sub(t.c, t.a))
    const nl = Math.hypot(n[0], n[1], n[2])
    if (nl === 0) continue
    const f = dot(n, frame.towardViewer) / nl
    for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as Array<[DrawingVec3, DrawingVec3]>) {
      const kp = key(p), kq = key(q)
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`
      const e = edges.get(k)
      if (e) e.facing.push(f)
      else edges.set(k, { a: p, b: q, facing: [f] })
    }
  }
  const out: DrawingVec3[][] = []
  // The contour of the front-facing region: one triangle faces the viewer,
  // its neighbour faces away OR is seen exactly edge-on. A facet exactly
  // edge-on (a tessellated bore with a facet square to the view) would
  // otherwise hide the contour on both of its sides.
  const band = 1e-9
  for (const e of edges.values()) {
    if (e.facing.length !== 2) continue
    const [f0, f1] = e.facing
    if ((f0 > band) !== (f1 > band)) out.push([e.a, e.b])
  }
  return out
}

interface Grid {
  minU: number
  minV: number
  cell: number
  nu: number
  nv: number
  cells: Map<number, Tri[]>
}

function buildGrid(tris: Tri[]): Grid {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
  for (const t of tris) for (const p of [t.pa, t.pb, t.pc]) {
    minU = Math.min(minU, p[0]); maxU = Math.max(maxU, p[0]); minV = Math.min(minV, p[1]); maxV = Math.max(maxV, p[1])
  }
  const span = Math.max(maxU - minU, maxV - minV, 1e-9)
  const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(tris.length))))
  const cell = span / n
  const nu = Math.ceil((maxU - minU) / cell) + 1
  const nv = Math.ceil((maxV - minV) / cell) + 1
  const cells = new Map<number, Tri[]>()
  for (const t of tris) {
    const u0 = Math.floor((Math.min(t.pa[0], t.pb[0], t.pc[0]) - minU) / cell)
    const u1 = Math.floor((Math.max(t.pa[0], t.pb[0], t.pc[0]) - minU) / cell)
    const v0 = Math.floor((Math.min(t.pa[1], t.pb[1], t.pc[1]) - minV) / cell)
    const v1 = Math.floor((Math.max(t.pa[1], t.pb[1], t.pc[1]) - minV) / cell)
    for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) {
      const k = u * nv + v
      const list = cells.get(k)
      if (list) list.push(t)
      else cells.set(k, [t])
    }
  }
  return { minU, minV, cell, nu, nv, cells }
}

/** Is `p` behind any triangle, seen from the viewer? */
function occluded(p: DrawingVec3, frame: ViewFrame, grid: Grid, eps: number): boolean {
  const [u, v] = projectPoint(frame, p)
  const depth = depthOf(frame, p)
  const cu = Math.floor((u - grid.minU) / grid.cell)
  const cv = Math.floor((v - grid.minV) / grid.cell)
  const list = grid.cells.get(cu * grid.nv + cv)
  if (!list) return false
  for (const t of list) {
    const bary = barycentric(u, v, t.pa, t.pb, t.pc)
    if (!bary) continue
    // Strictly inside the triangle (the edge itself lies on its own facets).
    const inset = 1e-9
    if (bary[0] <= inset || bary[1] <= inset || bary[2] <= inset) continue
    const d = bary[0] * depthOf(frame, t.a) + bary[1] * depthOf(frame, t.b) + bary[2] * depthOf(frame, t.c)
    if (d > depth + eps) return true
  }
  return false
}

function barycentric(u: number, v: number, a: [number, number], b: [number, number], c: [number, number]): [number, number, number] | undefined {
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
  if (Math.abs(den) < 1e-18) return undefined
  const l0 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / den
  const l1 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / den
  return [l0, l1, 1 - l0 - l1]
}

// ---------------------------------------------------------------------------
// Shared post-processing
// ---------------------------------------------------------------------------

/**
 * Clean coincident lines (within `tol` view mm). Lines are cut into short
 * pieces; a piece is dropped when its ends and middle all sit on a line already
 * kept. Visible lines are kept first, so a hidden piece under a visible line
 * goes (a box's back edges lie exactly under its front edges), and a second
 * copy of a visible or hidden line goes too (mesh chains often meet there).
 */
export function suppressHiddenUnderVisible(lines: ProjectedLine[], tol: number): { lines: ProjectedLine[]; suppressedMm: number; duplicateMm: number } {
  const index = new SegmentIndex(Math.max(tol * 20, 1))
  const out: ProjectedLine[] = []
  let suppressed = 0
  let duplicate = 0
  const ordered = [...lines.filter(l => l.visibility === 'visible'), ...lines.filter(l => l.visibility === 'hidden')]
  let lineNo = 0
  for (const l of ordered) {
    lineNo++
    let cur: ProjectedLine | undefined
    let along = 0
    for (let i = 0; i + 1 < l.points.length; i++, along += Math.hypot(l.points[i][0] - l.points[i - 1][0], l.points[i][1] - l.points[i - 1][1])) {
      const a = l.points[i], b = l.points[i + 1]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const step = Math.max(tol * 10, 0.05)
      const n = Math.max(1, Math.ceil(len / step))
      for (let k = 0; k < n; k++) {
        const p0 = lerp2(a, b, k / n), p1 = lerp2(a, b, (k + 1) / n)
        const pm = lerp2(a, b, (k + 0.5) / n)
        const here = { line: lineNo, along: along + (k * len) / n, near: 4 * tol }
        const on = (vis: LineVisibility | undefined) => index.covers(p0, tol, vis, here) && index.covers(p1, tol, vis, here) && index.covers(pm, tol, vis, here)
        if (l.visibility === 'hidden' && on('visible')) {
          suppressed += len / n
          cur = undefined
          continue
        }
        if (on(l.visibility)) {
          duplicate += len / n
          cur = undefined
          continue
        }
        // Indexed at once, so a line that retraces itself (a side face's
        // contour seen edge-on) is drawn once. A neighbouring piece shares only
        // an end point with it, never its middle, so it does not cover the next.
        index.add(p0, p1, l.visibility, lineNo, along + ((k + 1) * len) / n)
        if (cur) cur.points.push(p1)
        else { cur = { ...l, points: [p0, p1] }; out.push(cur) }
      }
    }
  }
  // The cut into pieces added points along straight runs; take them out again.
  for (const l of out) l.points = dropCollinear(l.points)
  return { lines: out, suppressedMm: suppressed, duplicateMm: duplicate }
}

/** Remove interior points that lie on the line through their neighbours (1e-9 mm). */
function dropCollinear(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length < 3) return points
  const out: Array<[number, number]> = [points[0]]
  for (let i = 1; i + 1 < points.length; i++) {
    const a = out[out.length - 1], p = points[i], b = points[i + 1]
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    // only a point strictly BETWEEN its neighbours; a turn-back is kept
    const along = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])
    const between = along > 0 && along < len * len
    if (!(len > 0 && Math.abs(cross) / len <= 1e-9 && between)) out.push(p)
  }
  out.push(points[points.length - 1])
  return out
}

/** Uniform-grid index of 2D segments for the coincidence test. */
class SegmentIndex {
  private readonly cells = new Map<string, Array<{ a: [number, number]; b: [number, number]; vis: LineVisibility; line: number; along: number }>>()
  private readonly cell: number

  constructor(cell: number) {
    this.cell = cell
  }

  /** `along` = distance along its own line at the segment's end */
  add(a: [number, number], b: [number, number], vis: LineVisibility, line: number, along: number): void {
    const seg = { a, b, vis, line, along }
    const [u0, u1] = [Math.floor(Math.min(a[0], b[0]) / this.cell), Math.floor(Math.max(a[0], b[0]) / this.cell)]
    const [v0, v1] = [Math.floor(Math.min(a[1], b[1]) / this.cell), Math.floor(Math.max(a[1], b[1]) / this.cell)]
    for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) {
      const key = `${u}:${v}`
      const list = this.cells.get(key)
      if (list) list.push(seg)
      else this.cells.set(key, [seg])
    }
  }

  /**
   * Is `p` within `tol` of a kept segment? The piece's own line counts only
   * further back than `here.near`: its immediate predecessors touch it by
   * construction, while a line that turns back over itself is a real repeat.
   */
  covers(p: [number, number], tol: number, vis: LineVisibility | undefined, here: { line: number; along: number; near: number }): boolean {
    const cu = Math.floor(p[0] / this.cell), cv = Math.floor(p[1] / this.cell)
    for (let u = cu - 1; u <= cu + 1; u++) for (let v = cv - 1; v <= cv + 1; v++) {
      for (const s of this.cells.get(`${u}:${v}`) ?? []) {
        if (vis && s.vis !== vis) continue
        if (s.line === here.line && here.along - s.along < here.near) continue
        if (pointSegDist(p, s.a, s.b) <= tol) return true
      }
    }
    return false
  }
}

function lerp2(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

function pointSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

export function polylineLength(points: Array<[number, number]>): number {
  let s = 0
  for (let i = 0; i + 1 < points.length; i++) s += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
  return s
}

function lengths(lines: ProjectedLine[]): { visibleLengthMm: number; hiddenLengthMm: number } {
  let visibleLengthMm = 0, hiddenLengthMm = 0
  for (const l of lines) {
    const len = polylineLength(l.points)
    if (l.visibility === 'visible') visibleLengthMm += len
    else hiddenLengthMm += len
  }
  return { visibleLengthMm, hiddenLengthMm }
}

// ---------------------------------------------------------------------------
// Paper
// ---------------------------------------------------------------------------

/**
 * Place a scene on a sheet: sheet mm = view mm x numerator / denominator,
 * translated so view (0, 0) sits at `originMm`, Y flipped to point down.
 */
export function toSheet(scene: ProjectionScene, scale: RationalScale, originMm: [number, number]): SheetLine[] {
  if (!(scale.numerator > 0) || !(scale.denominator > 0)) throw new Error('drawing view scale must be a positive ratio')
  const k = scale.numerator / scale.denominator
  return scene.lines.map(l => ({
    visibility: l.visibility,
    category: l.category,
    points: l.points.map(([u, v]) => [originMm[0] + u * k, originMm[1] - v * k] as [number, number]),
  }))
}
