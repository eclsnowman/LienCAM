// Form - the exact CAD solid of a form, written as a STEP solid for the kernel.
//
// The Bezier patches of exact.ts are joined into ONE B-spline surface per
// first-level quad (each cage quad is four of them, an n-gon n): the patches
// of a quad sit on a regular grid, so they are the spans of a bicubic B-spline.
// Every span join inside a first-level quad runs through ordinary points
// (valence 4, or a regular crease point), where the patch rules put the shared
// corner point exactly midway between the edge points beside it - the C1
// condition - so the join's corner poles drop out and the interior knots have
// multiplicity 2: the surface is C1 in its representation, as the kernel's
// offsets (Shell) and fillets need, and exactly the patches. A quad whose
// control points all lie on one plane is a PLANE instead, and neighbouring
// flat quads on the same plane are one planar face - a creased flat bottom is
// one face a Hole, a sketch or a fillet can use.
//
// Then the curved quads are PACKED (pack.ts): neighbours whose join is C1 the
// same way are one B-spline face, so a sphere cage is six faces, not 96; only
// joins at extraordinary points and creases stay face boundaries. Edges pack
// too: a chain of quad sides through points where only two of them meet is one
// edge curve. Last, every face and edge loses the knots its shape does not need
// (knots.ts): the refinement's knots inside a regular cage face go, a regular
// cage edge's drops to multiplicity 1 (C2), so a smooth region is written with
// about one pole per cage point instead of 64.
//
// The faces are bounded by B-spline edge curves taken from the same shared
// boundary control points on both sides, so neighbours meet exactly. The
// result is an AP214 file holding one MANIFOLD_SOLID_BREP; the Model screen's
// STEP import turns it into a kernel solid with exact surfaces (and a STEP
// export then carries them as they are).

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import { exactSurface } from './exact'
import { g1AtExtraordinary, impliedGrid } from './g1'
import { exactG1Corners, exactG1Points, raiseChain, raiseRootGrid, type CornerPatch } from './g1Exact'
import { packRim, packRoots, placeGrid } from './pack'
import { knotRuns, reduceCurve, reduceSurface } from './knots'

export interface FormStep {
  text: string
  /** faces of the solid: B-spline and planar */
  bsplineFaces: number
  planarFaces: number
  /** Bezier patches, and how many of them are exactly the limit surface */
  patches: number
  exactPatches: number
  /** the largest angle between faces along the boundaries leaving an extraordinary point, before and after the G1 pass (degrees) */
  g1BeforeDeg: number
  g1AfterDeg: number
  /** the most any pole moved in the G1 pass, mm */
  g1MoveMm: number
  /** the most the written surface moved in the G1 pass, mm */
  g1SurfaceMoveMm: number
  /** the most the angle across a crease leaving an extraordinary point changed in the G1 pass (0: creases keep their angle) */
  g1CreaseChangeDeg: number
  /** extraordinary points made G1 exactly (g1Exact.ts: degree-5 corner patches); the rest had the G1 pass */
  exactG1Points: number
  /** the largest angle between faces along the boundaries leaving those points (degrees; rounding, 1e-11) */
  exactG1SeamDeg: number
  /** B-spline faces written at degree 5 (holding a corner patch); the rest are bicubic */
  degree5Faces: number
  /** edges of the solid */
  edges: number
  /** the farthest a pole dropped at a packed join sat from the midpoint of its neighbours, mm: the most packing moved the surface */
  packJoinMm: number
  /** B-spline surface poles written (after knot removal) */
  poles: number
  /** a bound on how far knot removal moved any face or edge, mm */
  knotMoveMm: number
}

export interface RootGrid {
  poles: Vec3[]
  /** first-level corner points of the quad, corner k at (u, v) = (0,0), (1,0), (1,1), (0,1) */
  corners: number[]
}

const FLAT_TOLERANCE = 1e-9
/** a join pole this far from the midpoint (times the model's size) still counts as C1: the patch rules' rounding, far under the STEP file's 1e-7 mm */
const JOIN_TOLERANCE = 1e-11
/** knot removal leaves a packed face at least this many spans each way (the kernel measures volume by them) */
const MIN_SPANS = 4

/** The STEP text of a closed form's exact solid. `levels` refinement steps (>= 1) before the patches are built. */
/**
 * The first-level quads' Bezier pole grids (n = 3 m + 1 poles a side, m patches), before the G1 pass, and the
 * root sides that are creases (edgeKey of their two corners, from the cage's flags).
 */
export function rootGrids(cage: Cage, levels = 3): { roots: RootGrid[]; n: number; m: number; creaseSides: Set<string>; surface: ReturnType<typeof exactSurface> } {
  const s = exactSurface(cage, levels)
  const m = 2 ** (s.levels - 1) // patches along a first-level quad's side
  const n = 3 * m + 1 // Bezier poles along it
  const rootCount = s.root.reduce((a, r) => Math.max(a, r + 1), 0)
  const roots: RootGrid[] = Array.from({ length: rootCount }, () => ({ poles: new Array(n * n), corners: [-1, -1, -1, -1] }))
  const ROOT_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const creasedRootSides: Array<{ root: number; side: number }> = []
  s.patches.forEach((patch, f) => {
    const g = roots[s.root[f]]
    const uv = (k: number) => [s.uv[f * 8 + k * 2], s.uv[f * 8 + k * 2 + 1]]
    const [u0, v0] = uv(0)
    const [u1, v1] = uv(1)
    const [u3, v3] = uv(3)
    const d1 = [Math.round((u1 - u0) * m), Math.round((v1 - v0) * m)]
    const d3 = [Math.round((u3 - u0) * m), Math.round((v3 - v0) * m)]
    const pu = Math.round(u0 * 3 * m), pv = Math.round(v0 * 3 * m)
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const gu = pu + i * d1[0] + j * d3[0], gv = pv + i * d1[1] + j * d3[1]
      g.poles[gu * n + gv] = patch.points[i * 4 + j]
    }
    for (let q = 0; q < 4; q++) {
      const [cu, cv] = uv(q)
      ROOT_CORNERS.forEach(([ru, rv], k) => { if (cu === ru && cv === rv) g.corners[k] = s.corners[f][q] })
      // a patch side on a root side that is a crease (from the cage's flags) makes that root side a crease
      const [nu, nv] = uv((q + 1) % 4)
      if (!s.sharpEdges.has(edgeKey(s.corners[f][q], s.corners[f][(q + 1) % 4]))) continue
      const onRootSide = cv === 0 && nv === 0 ? 0 : cu === 1 && nu === 1 ? 1 : cv === 1 && nv === 1 ? 2 : cu === 0 && nu === 0 ? 3 : -1
      if (onRootSide >= 0) creasedRootSides.push({ root: s.root[f], side: onRootSide })
    }
  })
  const creaseSides = new Set(creasedRootSides.map(({ root, side }) => edgeKey(roots[root].corners[side], roots[root].corners[(side + 1) % 4])))

  return { roots, n, m, creaseSides, surface: s }
}

export function formStep(cage: Cage, name: string, levels = 3, pack = true, reduce = true, exactG1 = true): FormStep {
  const { roots, n, m, creaseSides, surface: s } = rootGrids(cage, levels)
  const rootCount = roots.length
  // one tangent plane where faces meet at an extraordinary point: exactly where every boundary there is smooth and no
  // face there is flat (g1Exact.ts, degree-5 corner patches); elsewhere the bicubic G1 pass (g1.ts). Creases stay corners
  const solvePoints = exactG1 ? exactG1Points(roots, creaseSides, roots.map((g) => fitPlane(g.poles) !== null)) : new Set<number>()
  const g1 = g1AtExtraordinary(roots, n, creaseSides, solvePoints)
  roots.forEach((g, r) => { g.poles = g1.grids[r].poles })
  const exact = solvePoints.size > 0 ? exactG1Corners(roots.map((g) => ({ poles: impliedGrid(g.poles, n), corners: g.corners })), n, creaseSides, solvePoints) : null
  const cornersOf = new Map<number, CornerPatch[]>()
  for (const c of exact?.patches ?? []) cornersOf.set(c.root, [...(cornersOf.get(c.root) ?? []), c])
  // a root holding a corner patch, raised to degree 5 whole (5 m + 1 poles a side)
  const n5 = 5 * m + 1
  const raisedOf = new Map<number, Vec3[]>()
  const raised = (r: number): Vec3[] => {
    let g = raisedOf.get(r)
    if (g === undefined) { g = raiseRootGrid(impliedGrid(roots[r].poles, n), n, cornersOf.get(r) ?? []); raisedOf.set(r, g) }
    return g
  }

  // the poles of side k of a root grid (nn a side), from corner k to corner k+1
  const sideOf = (poles: readonly Vec3[], nn: number, k: number): Vec3[] => {
    const out: Vec3[] = []
    for (let t = 0; t < nn; t++) {
      const [gu, gv] = k === 0 ? [t, 0] : k === 1 ? [nn - 1, t] : k === 2 ? [nn - 1 - t, nn - 1] : [0, nn - 1 - t]
      out.push(poles[gu * nn + gv])
    }
    return out
  }
  const side = (g: RootGrid, k: number): Vec3[] => sideOf(g.poles, n, k)

  // flat roots, grouped by edge-adjacency on one plane
  const planeOf = roots.map((g) => fitPlane(g.poles))
  const rootOfEdge = new Map<string, number[]>()
  roots.forEach((g, r) => {
    for (let k = 0; k < 4; k++) {
      const key = edgeKey(g.corners[k], g.corners[(k + 1) % 4])
      rootOfEdge.set(key, [...(rootOfEdge.get(key) ?? []), r])
    }
  })
  const group = new Int32Array(rootCount).fill(-1)
  for (let seed = 0; seed < rootCount; seed++) {
    if (planeOf[seed] === null || group[seed] >= 0) continue
    group[seed] = seed
    const stack = [seed]
    while (stack.length) {
      const r = stack.pop()!
      const g = roots[r]
      for (let k = 0; k < 4; k++) {
        for (const o of rootOfEdge.get(edgeKey(g.corners[k], g.corners[(k + 1) % 4])) ?? []) {
          if (group[o] < 0 && planeOf[o] !== null && samePlane(planeOf[seed]!, planeOf[o]!)) { group[o] = seed; stack.push(o) }
        }
      }
    }
  }

  const w = new StepWriter()

  // the faces, each as a surface and its rim of first-level quad sides (a -> b along `poles`, of degree `deg`; `cubic`
  // the bicubic side, which decides where a chain of sides runs on as one edge)
  interface Seg { from: number; to: number; poles: Vec3[]; deg: number; cubic: Vec3[] }
  const specs: Array<{ surface: string; loop: Seg[] }> = []
  let bsplineFaces = 0, planarFaces = 0
  const doneGroups = new Set<number>()
  roots.forEach((_, r) => {
    if (group[r] < 0 || doneGroups.has(group[r])) return
    doneGroups.add(group[r])
    const members = roots.map((_, q) => q).filter((q) => group[q] === group[r])
    // the group's rim: root sides no other member shares, chained corner to corner
    const next = new Map<number, { to: number; poles: Vec3[]; deg: number; cubic: Vec3[] }>()
    let simple = true
    for (const q of members) {
      const gq = roots[q]
      for (let k = 0; k < 4; k++) {
        const a = gq.corners[k], b = gq.corners[(k + 1) % 4]
        if ((rootOfEdge.get(edgeKey(a, b)) ?? []).filter((o) => group[o] === group[r]).length !== 1) continue
        if (next.has(a)) simple = false
        next.set(a, { to: b, poles: side(gq, k), deg: 3, cubic: side(gq, k) })
      }
    }
    const loops: Seg[][] = []
    if (simple) {
      const start = next.keys().next().value as number
      const loop: Seg[] = []
      for (let a = start; ;) {
        const step = next.get(a)
        if (step === undefined || loop.length > next.size) { simple = false; break }
        loop.push({ from: a, ...step })
        a = step.to
        if (a === start) break
      }
      if (simple && loop.length === next.size) loops.push(loop)
      else simple = false
    }
    if (!simple) {
      // not one simple rim (a flat ring, a pinch): each flat quad on its own
      for (const q of members) loops.push([0, 1, 2, 3].map((k) => ({ from: roots[q].corners[k], to: roots[q].corners[(k + 1) % 4], poles: side(roots[q], k), deg: 3, cubic: side(roots[q], k) })))
    }
    const pl = planeOf[r]!
    for (const loop of loops) {
      specs.push({ surface: w.add(`PLANE('',${w.axis(pl.origin, pl.normal, pl.xDir)})`), loop })
      planarFaces++
    }
  })

  // the curved quads, packed into as few C1 B-spline faces as their joins allow (pack.ts)
  const scale = roots.reduce((a, g) => g.poles.reduce((b, p) => Math.max(b, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])), a), 1)
  const curved = roots.map((_, r) => group[r] < 0)
  const packed = pack
    ? packRoots(roots, n, curved, JOIN_TOLERANCE * scale)
    : { packs: roots.flatMap((g, r) => (curved[r] ? [{ cells: [[{ root: r, rot: 0 }]], poles: g.poles, nu: n, nv: n }] : [])), maxJoinMm: 0 }
  let poleCount = 0, knotMoveMm = 0, degree5Faces = 0
  for (const p of packed.packs) {
    // a pack holding a corner patch is written at degree 5 throughout (one B-spline has one degree)
    const five = p.cells.some((col) => col.some((c) => cornersOf.has(c.root)))
    const deg = five ? 5 : 3
    let grid = p.poles, nu = p.nu, nv = p.nv
    if (five) {
      nu = p.cells.length * (n5 - 1) + 1
      nv = p.cells[0].length * (n5 - 1) + 1
      grid = new Array(nu * nv)
      p.cells.forEach((col, i) => col.forEach((c, j) => placeGrid(raised(c.root), n5, c.rot, grid, nv, i, j)))
      degree5Faces++
    }
    // only the knots the shape needs (knots.ts); reduce false keeps the C1 form as built
    // at least MIN_SPANS spans stay each way: the kernel's volume integration wants them. A packed one-ring
    // cylinder side reduced to one span up its straight height measured 0.15% off (in the app 0.6%) a surface
    // a fine mesh shows is right
    const net = reduceSurface(grid, nu, nv, reduce ? JOIN_TOLERANCE * scale : -1, MIN_SPANS, deg)
    knotMoveMm = Math.max(knotMoveMm, net.moved)
    poleCount += net.poles.length * net.poles[0].length
    const u = knotRuns(net.uKnots), v = knotRuns(net.vKnots)
    const rows = net.poles.map((row) => `(${row.map((q) => w.point(q)).join(',')})`)
    const surface = w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${deg},${deg},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.,(${u.mults.join(',')}),(${v.mults.join(',')}),(${u.values.map(real).join(',')}),(${v.values.map(real).join(',')}),.UNSPECIFIED.)`)
    specs.push({ surface, loop: packRim(p.cells).map(({ cell, side: k }) => { const g = roots[cell.root]; return { from: g.corners[k], to: g.corners[(k + 1) % 4], poles: five ? sideOf(raised(cell.root), n5, k) : side(g, k), deg, cubic: side(g, k) } }) })
    bsplineFaces++
  }

  // edges: a chain of quad sides through points only two of them meet at, C1 there, is one edge
  const edges = new Map<string, Seg>()
  for (const { loop } of specs) for (const e of loop) if (!edges.has(edgeKey(e.from, e.to))) edges.set(edgeKey(e.from, e.to), e)
  const at = new Map<number, Seg[]>()
  for (const e of edges.values()) for (const v of [e.from, e.to]) at.set(v, [...(at.get(v) ?? []), e])
  const poleTol = JOIN_TOLERANCE * scale
  const passes = new Set<number>()
  if (pack) {
    for (const [v, es] of at) {
      if (es.length !== 2 || es[0] === es[1]) continue
      const into = es[0].to === v ? es[0].cubic[n - 2] : es[0].cubic[1]
      const out = es[1].from === v ? es[1].cubic[1] : es[1].cubic[n - 2]
      const p = es[0].to === v ? es[0].cubic[n - 1] : es[0].cubic[0]
      if (Math.hypot(p[0] - (into[0] + out[0]) / 2, p[1] - (into[1] + out[1]) / 2, p[2] - (into[2] + out[2]) / 2) <= poleTol) passes.add(v)
    }
    // a closed chain keeps two of its points, so no edge closes on one vertex
    const seen = new Set<string>()
    for (const e of edges.values()) {
      if (seen.has(edgeKey(e.from, e.to))) continue
      const chain: number[] = [e.from]
      let closed = false
      for (let v = e.to, prev = e; ;) {
        seen.add(edgeKey(prev.from, prev.to))
        if (v === e.from) { closed = true; break }
        if (!passes.has(v)) break
        chain.push(v)
        const nxt = at.get(v)!.find((x) => x !== prev)!
        v = nxt.from === v ? nxt.to : nxt.from
        prev = nxt
      }
      if (!closed) {
        // walk back from e.from too, marking the rest of this chain seen
        for (let v = e.from, prev = e; passes.has(v);) {
          const nxt = at.get(v)!.find((x) => x !== prev)!
          seen.add(edgeKey(nxt.from, nxt.to))
          v = nxt.from === v ? nxt.to : nxt.from
          prev = nxt
          if (v === e.to) break
        }
        continue
      }
      passes.delete(chain[0])
      passes.delete(chain[Math.floor(chain.length / 2)])
    }
  }

  const vertexOf = new Map<number, string>()
  const vertex = (id: number, p: Vec3) => {
    let e = vertexOf.get(id)
    if (e === undefined) { e = w.add(`VERTEX_POINT('',${w.point(p)})`); vertexOf.set(id, e) }
    return e
  }
  const edgeOf = new Map<string, { entity: string; from: number }>()
  /** oriented edge along a chain of quad sides (Bezier poles, joins included), a's end first */
  const orientedEdge = (a: number, b: number, poles: Vec3[], via: number, deg: number) => {
    const key = `${edgeKey(a, b)}:${via}`
    let e = edgeOf.get(key)
    if (e === undefined) {
      const c = reduceCurve(poles, reduce ? JOIN_TOLERANCE * scale : -1, deg)
      knotMoveMm = Math.max(knotMoveMm, c.moved)
      const k = knotRuns(c.knots)
      const curve = w.add(`B_SPLINE_CURVE_WITH_KNOTS('',${deg},(${c.poles.map((q) => w.point(q)).join(',')}),.UNSPECIFIED.,.F.,.F.,(${k.mults.join(',')}),(${k.values.map(real).join(',')}),.UNSPECIFIED.)`)
      e = { entity: w.add(`EDGE_CURVE('',${vertex(a, poles[0])},${vertex(b, poles[poles.length - 1])},${curve},.T.)`), from: a }
      edgeOf.set(key, e)
    }
    return w.add(`ORIENTED_EDGE('',*,*,${e.entity},${e.from === a ? '.T.' : '.F.'})`)
  }
  const faces = specs.map(({ surface, loop }) => {
    // start the loop at a point that stays a vertex; run each chain of sides through passing points into one edge
    const s0 = loop.findIndex((e) => !passes.has(e.from))
    const turned = s0 > 0 ? [...loop.slice(s0), ...loop.slice(0, s0)] : loop
    const oriented: string[] = []
    for (let i = 0; i < turned.length;) {
      const from = turned[i].from
      const run: Seg[] = [turned[i]]
      // the chain's identity: its smallest quad side key, the same from either face
      let id = Math.min(turned[i].from, turned[i].to) * 1e7 + Math.max(turned[i].from, turned[i].to)
      i++
      while (i < turned.length && passes.has(turned[i].from)) {
        run.push(turned[i])
        id = Math.min(id, Math.min(turned[i].from, turned[i].to) * 1e7 + Math.max(turned[i].from, turned[i].to))
        i++
      }
      // one degree along the chain: a bicubic side beside a degree-5 one is raised (the same curve)
      const deg = Math.max(...run.map((e) => e.deg))
      const poles: Vec3[] = []
      run.forEach((e, q) => { const P = e.deg === deg ? e.poles : raiseChain(e.poles); poles.push(...(q === 0 ? P : P.slice(1))) })
      oriented.push(orientedEdge(from, turned[i - 1].to, poles, id, deg))
    }
    const edgeLoop = w.add(`EDGE_LOOP('',(${oriented.join(',')}))`)
    const bound = w.add(`FACE_OUTER_BOUND('',${edgeLoop},.T.)`)
    return w.add(`ADVANCED_FACE('',(${bound}),${surface},.T.)`)
  })

  return {
    text: w.finish(name, faces),
    bsplineFaces,
    planarFaces,
    patches: s.patches.length,
    exactPatches: s.patches.filter((p) => p.exact).length,
    g1BeforeDeg: g1.beforeDeg,
    g1AfterDeg: Math.max(g1.afterDeg, exact?.seamDeg ?? 0),
    g1MoveMm: g1.maxMoveMm,
    g1SurfaceMoveMm: Math.max(g1.surfaceMoveMm, exact?.surfaceMoveMm ?? 0),
    g1CreaseChangeDeg: g1.creaseChangeDeg,
    exactG1Points: exact?.solved ?? 0,
    exactG1SeamDeg: exact?.seamDeg ?? 0,
    degree5Faces,
    edges: edgeOf.size,
    packJoinMm: packed.maxJoinMm,
    poles: poleCount,
    knotMoveMm,
  }
}

interface Plane { origin: Vec3; normal: Vec3; xDir: Vec3 }

/** The plane every pole lies on (within FLAT_TOLERANCE of the patch size), or null. */
function fitPlane(poles: Vec3[]): Plane | null {
  const o = poles[0]
  let size = 0
  for (const p of poles) size = Math.max(size, Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]))
  if (!(size > 0)) return null
  // the widest pair of directions from the first pole
  let best: Vec3 | null = null, bestLen = 0
  let x: Vec3 | null = null
  for (const p of poles) {
    const d: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
    if (x === null) { if (Math.hypot(...d) > size * 1e-3) x = d; continue }
    const c: Vec3 = [x[1] * d[2] - x[2] * d[1], x[2] * d[0] - x[0] * d[2], x[0] * d[1] - x[1] * d[0]]
    const l = Math.hypot(...c)
    if (l > bestLen) { bestLen = l; best = c }
  }
  if (best === null || x === null || !(bestLen > 0)) return null
  const nrm: Vec3 = [best[0] / bestLen, best[1] / bestLen, best[2] / bestLen]
  for (const p of poles) {
    if (Math.abs((p[0] - o[0]) * nrm[0] + (p[1] - o[1]) * nrm[1] + (p[2] - o[2]) * nrm[2]) > FLAT_TOLERANCE * Math.max(1, size)) return null
  }
  const xl = Math.hypot(...x)
  return { origin: o, normal: nrm, xDir: [x[0] / xl, x[1] / xl, x[2] / xl] }
}

function samePlane(a: Plane, b: Plane): boolean {
  const dot = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2]
  if (dot < 1 - 1e-12) return false
  const d = (b.origin[0] - a.origin[0]) * a.normal[0] + (b.origin[1] - a.origin[1]) * a.normal[1] + (b.origin[2] - a.origin[2]) * a.normal[2]
  return Math.abs(d) <= FLAT_TOLERANCE * Math.max(1, Math.hypot(...a.origin), Math.hypot(...b.origin))
}

/** A STEP real: always with a decimal point, full precision. */
function real(x: number): string {
  if (Object.is(x, -0)) x = 0
  let t = Number.isInteger(x) && Math.abs(x) < 1e15 ? x.toFixed(1) : x.toPrecision(17)
  t = t.replace('e', 'E')
  if (!t.includes('.')) t = t.replace('E', '.E')
  return t
}

class StepWriter {
  private lines: string[] = []
  private pointOf = new Map<string, string>()
  /** writes one entity; returns its reference (#n) */
  add(body: string): string {
    this.lines.push(body)
    return `#${this.lines.length}`
  }
  point(p: Vec3): string {
    const key = `${p[0]},${p[1]},${p[2]}`
    let e = this.pointOf.get(key)
    if (e === undefined) { e = this.add(`CARTESIAN_POINT('',(${real(p[0])},${real(p[1])},${real(p[2])}))`); this.pointOf.set(key, e) }
    return e
  }
  axis(origin: Vec3, normal: Vec3, xDir: Vec3): string {
    const dir = (d: Vec3) => this.add(`DIRECTION('',(${real(d[0])},${real(d[1])},${real(d[2])}))`)
    return this.add(`AXIS2_PLACEMENT_3D('',${this.point(origin)},${dir(normal)},${dir(xDir)})`)
  }
  finish(name: string, faces: string[]): string {
    const quoted = name.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')
    const shell = this.add(`CLOSED_SHELL('',(${faces.join(',')}))`)
    const solid = this.add(`MANIFOLD_SOLID_BREP('${quoted}',${shell})`)
    const ctx = this.add('APPLICATION_CONTEXT(\'automotive design\')')
    this.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${ctx})`)
    const pctx = this.add(`PRODUCT_CONTEXT('',${ctx},'mechanical')`)
    const product = this.add(`PRODUCT('${quoted}','${quoted}','',(${pctx}))`)
    const formation = this.add(`PRODUCT_DEFINITION_FORMATION('','',${product})`)
    const dctx = this.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${ctx},'design')`)
    const definition = this.add(`PRODUCT_DEFINITION('design','',${formation},${dctx})`)
    const shape = this.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)
    const mm = this.add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))')
    const rad = this.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))')
    const sr = this.add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())')
    const unc = this.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','')`)
    const gctx = this.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr}))REPRESENTATION_CONTEXT('',''))`)
    const rep = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('${quoted}',(${solid}),${gctx})`)
    this.add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${rep})`)
    const data = this.lines.map((body, n) => `#${n + 1}=${body};`)
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('LienCAM Form exact solid'),'2;1');",
      `FILE_NAME('${quoted}.stp','',(''),(''),'LienCAM','LienCAM','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
      ...data,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n')
  }
}
