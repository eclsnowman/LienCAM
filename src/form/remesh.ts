// Form - From body with its curved faces remeshed into quads.
//
// The body's display tessellation is split back into its faces (triFace) and
// the edges between them (chains of boundary segments, split where the face on
// the other side changes; a loop with one neighbour all round is a closed
// chain). Every chain is resampled evenly by length, once, so the two faces
// beside it share the same points. Then each face is rebuilt:
//   - flat, every edge sharp: ONE cage face through its chains' points (as
//     before). A flat face that runs smoothly into a neighbour (a box face
//     beside a fillet) is gridded like a curved one below, when it can be: one
//     big n-gon with an uncreased edge drags that edge toward its centre (2.5
//     mm on a filleted box before the Pull, and the Pull's correction leaves
//     waves of 0.4 mm between the points);
//   - curved, bounded by exactly four chains (a fillet strip, most B-spline
//     patches): a grid of quads, Coons-interpolated from the four sides;
//   - curved, bounded by one closed chain (a dome): the same, with the loop cut
//     into four equal arcs;
//   - curved, an annulus (a cylinder or cone side between two rims): rings of
//     quads from one loop to the other; ONE ring when the face is ruled (the
//     straight line between each pair of matched rim points lies on it, as on
//     every cylinder and cone), since a smooth skin between two rows of points
//     runs straight; a ring per 30 degrees the face turns across, ruled or not
//     (a foot fillet round a boss);
//   - curved, bounded by three chains (a fillet corner blend) or five or more:
//     split at a centre point into one Coons grid per corner, each side cut at
//     its middle and joined to the centre by a spoke (all sides the same even
//     count);
//   - flat with holes (a plate top round a boss or a pocket): triangles between
//     its loops' points, so its edges take the counts their neighbours settle
//     on (never fewer than its own triangles had);
//   - anything else keeps its triangles, and its chains keep their original
//     points (so a neighbour's grid meets them).
// A chain between two flat faces (or a flat face and an opening) keeps its
// original points too: nothing on either side needs it divided, and a box stays
// eight points.
// A quad face ruled between two opposite sides whose other two sides are
// straight AND creased (the side of an extruded curve between sharp seams)
// asks only one segment of those; a neighbour that wants more still gets it.
// (Beside a smooth neighbour - a fillet strip against a flat face, on any of its
// four sides - it keeps its segments: one would let the skin sag off the body.)
// A grid's opposite sides need the same number of points, and chains are
// shared, so the counts are settled together (union-find; a group takes the
// largest count any member wants, a multiple of four where a dome needs it or
// of two where a centre-split face does, or the original count of a chain a
// triangle face or two flat faces keep). A face whose counts
// cannot be met falls back to its triangles. Interior grid points are put on
// the face (the closest point of its own triangles) and relaxed a few times so
// they spread evenly. Last, the whole cage is Pulled onto the body
// (shapeTools pullOntoTargets), so the smooth skin sits on the body rather than
// inside it: each point's surface point onto what it belongs to - a point on a
// chain onto that edge of the body, a body vertex onto itself, any other point
// onto its own face. (Onto the nearest of the whole body instead, a rim point
// of a cylinder finds the flat end it touches and never moves out to the
// round side: the rim stays 0.16 mm inside.)

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import { closestPointIndex } from './closestPoint'
import { pullOntoTargets } from './shapeTools'
import * as THREE from 'three'

export interface RemeshMesh { position: ArrayLike<number>; index: ArrayLike<number>; triFace: ArrayLike<number> }

export interface RemeshOptions {
  /** target spacing of the cage points, mm (default: a twelfth of the body's diagonal) */
  spacing?: number
  /** most turning one segment of a curved edge may take, degrees */
  maxTurnDeg?: number
  /** faces of the body meeting at more than this are a creased edge */
  sharpDeg?: number
  /** Pull the finished cage onto the body (default true) */
  pull?: boolean
}

export interface RemeshResult {
  cage: Cage
  flatFaces: number
  /** curved faces rebuilt as quad grids */
  gridFaces: number
  /** curved faces left as their triangles */
  triangleFaces: number
  triangles: number
  /** the worst distance from a cage point's surface point to the body, before and after the Pull (mm) */
  offBefore: number
  offAfter: number
}

interface Chain {
  /** original (merged) vertex ids along it, first to last (a closed chain repeats its first at the end) */
  verts: number[]
  closed: boolean
  faces: number[]
}

export function remeshFromBody(mesh: RemeshMesh, opts: RemeshOptions = {}): RemeshResult {
  // --- merge points at the same place, and the triangles of each face
  let extent = 0
  for (let i = 0; i < mesh.position.length; i++) extent = Math.max(extent, Math.abs(mesh.position[i]))
  const q = 1e-6 * Math.max(1, extent)
  const byKey = new Map<string, number>()
  const P: Vec3[] = []
  const remap = new Int32Array(mesh.position.length / 3)
  for (let v = 0; v < remap.length; v++) {
    const p: Vec3 = [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]]
    const key = p.map((c) => Math.round(c / q)).join(',')
    let id = byKey.get(key)
    if (id === undefined) { id = P.length; P.push(p); byKey.set(key, id) }
    remap[v] = id
  }
  const tris: number[][] = [], triFace: number[] = []
  for (let t = 0; t < mesh.index.length / 3; t++) {
    const tri = [remap[mesh.index[t * 3]], remap[mesh.index[t * 3 + 1]], remap[mesh.index[t * 3 + 2]]]
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue
    tris.push(tri); triFace.push(mesh.triFace[t])
  }
  const faceIds = [...new Set(triFace)]
  const trisOf = new Map<number, number[]>(faceIds.map((f) => [f, []]))
  tris.forEach((_, t) => trisOf.get(triFace[t])!.push(t))
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const p of P) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]) }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  const h = opts.spacing ?? diag / 12
  const maxTurn = ((opts.maxTurnDeg ?? 30) * Math.PI) / 180
  const cosSharp = Math.cos(((opts.sharpDeg ?? 30) * Math.PI) / 180)

  // --- the face (and triangle) on the other side of every directed triangle edge
  const faceAcross = new Map<string, number>()
  const triOfEdge = new Map<string, number>()
  tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { faceAcross.set(`${t[k]}>${t[(k + 1) % 3]}`, triFace[i]); triOfEdge.set(`${t[k]}>${t[(k + 1) % 3]}`, i) } })

  // --- each face's boundary loops, split into chains where the neighbour changes
  const chains: Chain[] = []
  const chainOfEdge = new Map<string, number>()
  const loopsOf = new Map<number, Array<Array<{ chain: number; forward: boolean }>>>()
  for (const f of faceIds) {
    const next = new Map<number, number>()
    let simple = true
    for (const t of trisOf.get(f)!) for (let k = 0; k < 3; k++) {
      const a = tris[t][k], b = tris[t][(k + 1) % 3]
      if (faceAcross.get(`${b}>${a}`) === f) continue // interior edge
      if (next.has(a)) simple = false
      next.set(a, b)
    }
    const loops: Array<Array<{ chain: number; forward: boolean }>> = []
    const used = new Set<number>()
    for (const start of next.keys()) {
      if (used.has(start) || !simple) continue
      const loop: number[] = []
      for (let v = start; !used.has(v); v = next.get(v)!) { used.add(v); loop.push(v); if (!next.has(v)) { simple = false; break } }
      if (!simple) break
      // neighbour of each boundary segment; cut where it changes
      const nb = loop.map((v, i) => faceAcross.get(`${loop[(i + 1) % loop.length]}>${v}`) ?? -1)
      const cuts = loop.map((_, i) => i).filter((i) => nb[i] !== nb[(i - 1 + loop.length) % loop.length])
      const pieces: Array<{ chain: number; forward: boolean }> = []
      const addPiece = (vs: number[], closed: boolean, other: number) => {
        // the same key from either face: a closed chain by its point set, an open one by its two end segments
        const key = closed ? `c:${[...new Set(vs)].sort((x, y) => x - y).join(',')}` : [edgeKey(vs[0], vs[1]), edgeKey(vs[vs.length - 2], vs[vs.length - 1])].sort().join('|')
        let c = chainOfEdge.get(key)
        let forward = true
        if (c === undefined) {
          c = chains.length
          chains.push({ verts: vs, closed, faces: [f, other] })
          chainOfEdge.set(key, c)
        } else {
          const cv = chains[c].verts
          if (closed) {
            // the loops start at different points: which way round, from where the chain starts
            const at = vs.indexOf(cv[0])
            forward = vs[(at + 1) % (vs.length - 1)] === cv[1]
          } else forward = cv[0] === vs[0]
        }
        pieces.push({ chain: c, forward })
      }
      if (cuts.length === 0) {
        addPiece([...loop, loop[0]], true, nb[0])
      } else {
        for (let j = 0; j < cuts.length; j++) {
          const s = cuts[j], e = cuts[(j + 1) % cuts.length]
          const vs: number[] = []
          for (let i = s; ; i = (i + 1) % loop.length) { vs.push(loop[i]); if (i === (e - 1 + loop.length) % loop.length) break }
          vs.push(loop[e])
          addPiece(vs, false, nb[s])
        }
      }
      loops.push(pieces)
    }
    loopsOf.set(f, simple ? loops : [])
  }

  // --- faces: flat, or which grid (a curved face with a shape the grids do not take keeps its triangles)
  const normalOf = (t: number[]): Vec3 => { const [a, b, c] = t.map((i) => P[i]); return unit(cross(sub(b, a), sub(c, a))) }
  type Kind = { kind: 'flat' } | { kind: 'quad'; sides: Array<{ chain: number; forward: boolean }> } | { kind: 'dome'; loop: { chain: number; forward: boolean } } | { kind: 'annulus'; loops: Array<{ chain: number; forward: boolean }> } | { kind: 'star'; sides: Array<{ chain: number; forward: boolean }> } | { kind: 'plate' } | { kind: 'triangles' }
  // a chain is sharp where the two faces beside it meet at a real angle (an opening counts as sharp)
  const sharp = chains.map((c) => {
    const k = Math.floor((c.verts.length - 1) / 2)
    const t0 = triOfEdge.get(`${c.verts[k]}>${c.verts[k + 1]}`), t1 = triOfEdge.get(`${c.verts[k + 1]}>${c.verts[k]}`)
    return t0 === undefined || t1 === undefined || dot(normalOf(tris[t0]), normalOf(tris[t1])) < cosSharp
  })
  const kind = new Map<number, Kind>()
  const flatFaceIds = new Set<number>()
  const planeFaceIds = new Set<number>()
  for (const f of faceIds) {
    const list = trisOf.get(f)!
    const loops = loopsOf.get(f)!
    const n0 = normalOf(tris[list[0]]), o = P[tris[list[0]][0]]
    const flat = list.every((t) => { const n = normalOf(tris[t]); return dot(n, n0) > 1 - 1e-9 && tris[t].every((i) => Math.abs(dot(sub(P[i], o), n0)) <= 1e-6 * Math.max(1, extent)) })
    if (flat) planeFaceIds.add(f)
    if (flat && loops.length === 1) flatFaceIds.add(f)
    const allSharp = loops.every((l) => l.every((s) => sharp[s.chain]))
    if (flat && loops.length === 1 && allSharp) kind.set(f, { kind: 'flat' })
    else if (loops.length === 1 && loops[0].length === 4) kind.set(f, { kind: 'quad', sides: loops[0] })
    else if (loops.length === 1 && loops[0].length === 1 && chains[loops[0][0].chain].closed) kind.set(f, { kind: 'dome', loop: loops[0][0] })
    else if (loops.length === 2 && loops.every((l) => l.length === 1 && chains[l[0].chain].closed)) kind.set(f, { kind: 'annulus', loops: [loops[0][0], loops[1][0]] })
    else if (loops.length === 1 && (loops[0].length === 3 || loops[0].length >= 5) && loops[0].every((s) => !chains[s.chain].closed)) kind.set(f, { kind: 'star', sides: loops[0] })
    else if (flat && loops.length === 1) kind.set(f, { kind: 'flat' })
    else if (flat && loops.length > 1) kind.set(f, { kind: 'plate' })
    else kind.set(f, { kind: 'triangles' })
  }

  // --- chain point counts, settled together
  const chainLength = (c: Chain) => { let l = 0; for (let i = 1; i < c.verts.length; i++) l += dist(P[c.verts[i - 1]], P[c.verts[i]]); return l }
  const chainTurn = (c: Chain) => {
    let turn = 0
    for (let i = 1; i + 1 < c.verts.length; i++) {
      const u = sub(P[c.verts[i]], P[c.verts[i - 1]]), w = sub(P[c.verts[i + 1]], P[c.verts[i]])
      turn += Math.acos(Math.max(-1, Math.min(1, dot(unit(u), unit(w)))))
    }
    // a polyline turns only at its inner points, short of the curve's own turn by half a segment's at
    // each end: a quarter circle in four chords turns 67.5 degrees
    const segs = c.verts.length - 1
    return segs > 1 ? (turn * segs) / (segs - 1) : turn
  }
  const want = chains.map((c) => Math.max(c.closed ? 3 : 1, Math.round(chainLength(c) / h), Math.ceil(chainTurn(c) / maxTurn)))
  // a quad face ruled between two opposite sides wants one segment of the other two (straight) sides
  // tight: on a tessellated body the lines between matched points of a ruled face lie in its flat strips
  // (the samples sit at the same place on congruent chord polygons), so only a real bend exceeds it
  const ruledTol = 1e-3 * Math.max(1, diag)
  const straightChain = (c: Chain) => {
    const a = P[c.verts[0]], b = P[c.verts[c.verts.length - 1]]
    return !c.closed && c.verts.every((v) => dist(closestOnPolyline([a, b], P[v]), P[v]) <= ruledTol)
  }
  const chainAt = (s: { chain: number; forward: boolean }, t: number): Vec3 => {
    const vs = chains[s.chain].verts.map((v) => P[v])
    return pointAtLength(s.forward ? vs : [...vs].reverse(), t)
  }
  for (const f of faceIds) {
    const k = kind.get(f)!
    if (k.kind !== 'quad') continue
    const onFace = closestPointIndex({ position: trisOf.get(f)!.flatMap((t) => tris[t].flatMap((v) => P[v])), index: trisOf.get(f)!.flatMap((_, j) => [j * 3, j * 3 + 1, j * 3 + 2]) })
    for (const [a, b] of [[0, 2], [1, 3]] as const) {
      // sides a and b straight, and the lines across between the other two sides (u, w) on the face
      // (creased sides only: between two crease rows a smooth skin runs straight; beside a smooth neighbour - a
      // fillet strip against a flat face - one segment would let the skin sag off the body, 2 mm on a filleted box)
      if (!sharp[k.sides[a].chain] || !sharp[k.sides[b].chain]) continue
      if (!straightChain(chains[k.sides[a].chain]) || !straightChain(chains[k.sides[b].chain])) continue
      const u = k.sides[(a + 1) % 4], w = k.sides[(a + 3) % 4]
      // ...and the two sides the lines run between creased too: a flat side face between two r6 corner fillets
      // took one segment of its 48 mm bottom, the bottom crease ran from 3 mm arc spans into one 48 mm span, and
      // the Pull threw that corner point 16 mm out to make the skin meet it - 2.5 mm off at every corner (WO-2822)
      if (!sharp[u.chain] || !sharp[w.chain]) continue
      const ruled = [0.25, 0.5, 0.75].every((t) => {
        const p = chainAt(u, t), q = chainAt(w, 1 - t)
        return [0.25, 0.5, 0.75].every((g) => onFace.closest([p[0] + (q[0] - p[0]) * g, p[1] + (q[1] - p[1]) * g, p[2] + (q[2] - p[2]) * g]).distance <= ruledTol)
      })
      if (ruled) { want[k.sides[a].chain] = 1; want[k.sides[b].chain] = 1 }
    }
  }
  const original = chains.map((c) => c.verts.length - 1)
  // a plate's edges keep at least the points its own triangles had (it took exactly those before it was
  // triangulated from its loops): a boss's rim from the plate top's 32 to the twelve its length asks
  // let the foot fillet sag 0.27 mm off the body, a dome's rim 1.1 mm
  chains.forEach((c, i) => { if (c.faces.some((f) => kind.get(f)?.kind === 'plate')) want[i] = Math.max(want[i], original[i]) })
  let counts: number[] = []
  for (let pass = 0; pass < chains.length + 2; pass++) {
    const parent = chains.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const join = (a: number, b: number) => { parent[find(a)] = find(b) }
    for (const f of faceIds) {
      const k = kind.get(f)!
      if (k.kind === 'quad') { join(k.sides[0].chain, k.sides[2].chain); join(k.sides[1].chain, k.sides[3].chain) }
      if (k.kind === 'annulus') join(k.loops[0].chain, k.loops[1].chain)
      if (k.kind === 'star') for (const s of k.sides) join(s.chain, k.sides[0].chain)
    }
    const fixed = new Map<number, number>(), multiple = new Map<number, number>(), best = new Map<number, number>()
    let conflict = -1
    chains.forEach((c, i) => {
      const g = find(i)
      best.set(g, Math.max(best.get(g) ?? 0, want[i]))
      const kindOf = (f: number) => kind.get(f)?.kind
      if (c.faces.some((f) => kindOf(f) === 'triangles' || (f >= 0 && !kind.has(f))) || c.faces.every((f) => f < 0 || kindOf(f) === 'flat' || kindOf(f) === 'plate')) {
        if (fixed.has(g) && fixed.get(g) !== original[i]) conflict = g
        fixed.set(g, original[i])
      }
    })
    const needs = (g: number, m: number) => { const was = multiple.get(g) ?? 1; multiple.set(g, was % m === 0 ? was : m % was === 0 ? m : was * m) }
    for (const f of faceIds) { const k = kind.get(f)!; if (k.kind === 'dome') needs(find(k.loop.chain), 4); if (k.kind === 'star') needs(find(k.sides[0].chain), 2) }
    for (const [g, m] of multiple) if (fixed.has(g) && fixed.get(g)! % m !== 0) conflict = g
    if (conflict < 0) {
      counts = chains.map((_, i) => { const g = find(i); if (fixed.has(g)) return fixed.get(g)!; const m = multiple.get(g) ?? 1; return Math.ceil(best.get(g)! / m) * m })
      break
    }
    // the faces tying that group together keep their triangles (a flat one its single face), and the counts are settled again
    for (const f of faceIds) {
      const k = kind.get(f)!
      const ties = k.kind === 'quad' || k.kind === 'star' ? k.sides.map((s) => s.chain) : k.kind === 'annulus' ? k.loops.map((s) => s.chain) : k.kind === 'dome' ? [k.loop.chain] : []
      if (ties.some((c) => find(c) === conflict)) kind.set(f, { kind: flatFaceIds.has(f) ? 'flat' : 'triangles' })
    }
  }

  // --- the new cage's points: original points where kept, chain samples, grid interiors
  const out: Vec3[] = []
  const newOfOriginal = new Map<number, number>()
  const keep = (v: number) => { let id = newOfOriginal.get(v); if (id === undefined) { id = out.length; out.push(P[v]); newOfOriginal.set(v, id) } return id }
  // a closed rim across an annulus from another starts its samples where the other's first sample is nearest,
  // so the samples pair off along the face (straight up a cylinder, along a cone) rather than a fraction of a
  // spacing round: with one ring on a ruled face that fraction would twist it into a waisted hyperboloid
  const startAt = new Map<number, Vec3>()
  for (const f of faceIds) {
    const k = kind.get(f)!
    if (k.kind !== 'annulus') continue
    const [a, b] = [k.loops[0].chain, k.loops[1].chain]
    if (!chains[a].closed || !chains[b].closed || counts[a] !== counts[b] || counts[a] === original[a] || startAt.has(b)) continue
    const first = startAt.get(a) ?? P[chains[a].verts[0]]
    startAt.set(b, closestOnPolyline(chains[b].verts.map((v) => P[v]), first))
  }
  const samples = chains.map((c, i) => {
    const n = counts[i]
    if (n === original[i]) return c.verts.map((v, j) => (c.closed && j === c.verts.length - 1 ? keep(c.verts[0]) : keep(v)))
    const from = startAt.get(i)
    if (from !== undefined) {
      // the closed loop from `from` round to itself
      const vs = c.verts.map((v) => P[v])
      let seg = 0, best = Infinity
      for (let j = 1; j < vs.length; j++) { const d = dist(closestOnPolyline([vs[j - 1], vs[j]], from), from); if (d < best) { best = d; seg = j } }
      const loop = [from, ...vs.slice(seg, vs.length - 1), ...vs.slice(0, seg), from]
      const pts = resample(loop, n)
      out.push(from)
      const start = out.length - 1
      return pts.map((p, j) => (j === 0 || j === n ? start : (out.push(p), out.length - 1)))
    }
    // evenly by length along the chain; its ends (body vertices) stay the original points
    const pts = resample(c.verts.map((v) => P[v]), n)
    return pts.map((p, j) => (j === 0 ? keep(c.verts[0]) : j === n ? keep(c.verts[c.verts.length - 1]) : (out.push(p), out.length - 1)))
  })
  /** a chain's points in the face's direction, first to last */
  const along = (s: { chain: number; forward: boolean }) => (s.forward ? samples[s.chain] : [...samples[s.chain]].reverse())

  const faces: number[][] = []
  const bodyFaceOf: number[] = []
  const onFaceOf = new Map<number, ReturnType<typeof closestPointIndex>>()
  let flatFaces = 0, gridFaces = 0, triangleFaces = 0, triangles = 0
  for (const f of faceIds) {
    const k = kind.get(f)!
    const onFace = closestPointIndex({ position: trisOf.get(f)!.flatMap((t) => tris[t].flatMap((v) => P[v])), index: trisOf.get(f)!.flatMap((_, j) => [j * 3, j * 3 + 1, j * 3 + 2]) })
    onFaceOf.set(f, onFace)
    const refN = normalOf(tris[trisOf.get(f)![0]])
    const addFaces = (list: number[][]) => {
      // wound like the body's triangles: a face's normal against the triangle nearest it
      for (const loop of list) {
        const c = centroid(loop.map((i) => out[i]))
        const n = newellN(loop.map((i) => out[i]))
        const t = nearestTriangle(trisOf.get(f)!, c)
        faces.push(dot(n, t === -1 ? refN : normalOf(tris[t])) < 0 ? [...loop].reverse() : loop)
        bodyFaceOf.push(f)
      }
    }
    const nearestTriangle = (list: number[], c: Vec3) => {
      let best = -1, bestD = Infinity
      for (const t of list) { const d = dist(centroid(tris[t].map((v) => P[v])), c); if (d < bestD) { bestD = d; best = t } }
      return best
    }
    if (k.kind === 'flat') {
      const loop = loopsOf.get(f)![0].flatMap((s) => along(s).slice(0, -1))
      addFaces([loop]); flatFaces++
    } else if (k.kind === 'plate' && loopsOf.get(f)!.some((l) => l.some((s) => counts[s.chain] !== original[s.chain]))) {
      addFaces(plateTriangles(loopsOf.get(f)!.map((l) => l.flatMap((s) => along(s).slice(0, -1))), out, refN)); flatFaces++
    } else if (k.kind === 'plate') {
      // its edges kept their points: its own triangles, as the kernel laid them out (earcut's long slivers
      // round a rib's corners left a point of the finished body 0.93 mm off the plate)
      addFaces(trisOf.get(f)!.map((t) => tris[t].map(keep))); flatFaces++
    } else if (k.kind === 'quad' || k.kind === 'dome') {
      let sides: number[][]
      if (k.kind === 'quad') sides = k.sides.map(along)
      else {
        const ring = along(k.loop).slice(0, -1)
        const n4 = ring.length / 4
        sides = [0, 1, 2, 3].map((j) => [...ring, ring[0]].slice(j * n4, (j + 1) * n4 + 1))
      }
      // a dome's grid starts flat across its rim: each interior point goes up onto the dome along the rim's
      // normal, not to the dome's nearest point - over a hemisphere (a ball cap taller than its radius) that
      // is the rim itself for every point, and the dome came back as a flat lid (WO-2822)
      const lift = k.kind === 'dome' ? liftOnto(sides.flatMap((sd) => sd.slice(0, -1).map((i) => out[i])), trisOf.get(f)!.map((t) => tris[t].map((v) => P[v]))) : undefined
      addFaces(coonsGrid(sides, out, onFace, lift)); gridFaces++
    } else if (k.kind === 'star') {
      addFaces(starGrid(k.sides.map(along), out, onFace)); gridFaces++
    } else if (k.kind === 'annulus') {
      addFaces(ringGrid(along(k.loops[0]).slice(0, -1), along(k.loops[1]).slice(0, -1), out, onFace, h, ruledTol, maxTurn)); gridFaces++
    } else {
      const list = trisOf.get(f)!
      addFaces(list.map((t) => tris[t].map(keep)))
      triangleFaces++; triangles += list.length
    }
  }

  // --- creases: edges between faces of different body faces meeting at a real angle
  const cageNormal = faces.map((loop) => newellN(loop.map((i) => out[i])))
  const sides = new Map<string, number[]>()
  faces.forEach((loop, c) => { for (let i = 0; i < loop.length; i++) { const key = edgeKey(loop[i], loop[(i + 1) % loop.length]); const l = sides.get(key); if (l) l.push(c); else sides.set(key, [c]) } })
  const creases: string[] = []
  for (const [key, list] of sides) {
    if (list.length !== 2 || bodyFaceOf[list[0]] === bodyFaceOf[list[1]]) continue
    // also where a flat face kept as its triangles (a plate top with a hole) runs smoothly into a curved grid
    // (the foot fillet round a boss): the fan's long triangles cannot carry the blend, and Pulled onto the body
    // the skin waved 0.68 mm into a groove at the fillet's foot; creased, the grid ends on the flat face (WO-2822)
    const [fa, fb] = [bodyFaceOf[list[0]], bodyFaceOf[list[1]]]
    const fanBesideGrid = (x: number, y: number) => (kind.get(x)!.kind === 'triangles' || kind.get(x)!.kind === 'plate') && planeFaceIds.has(x) && kind.get(y)!.kind !== 'triangles' && !planeFaceIds.has(y)
    if (dot(cageNormal[list[0]], cageNormal[list[1]]) < cosSharp || fanBesideGrid(fa, fb) || fanBesideGrid(fb, fa)) creases.push(key)
  }
  let cage: Cage = { positions: out, faces, creases }
  let offBefore = 0, offAfter = 0
  if (opts.pull !== false) {
    // what each point belongs to: its face, then (overriding) the chain it lies on, then a body vertex
    const home: Array<(q: Vec3) => Vec3> = new Array(out.length)
    faces.forEach((loop, c) => { const idx = onFaceOf.get(bodyFaceOf[c])!; for (const i of loop) home[i] ??= (q) => idx.closest(q).point })
    samples.forEach((ids, c) => {
      const line = chains[c].verts.map((v) => P[v])
      ids.forEach((i, j) => {
        const end = !chains[c].closed && (j === 0 || j === ids.length - 1)
        const at = out[i]
        home[i] = end ? () => at : (q) => closestOnPolyline(line, q)
      })
    })
    const r = pullOntoTargets(cage, out.map((_, i) => i), (i, q) => home[i](q))
    if (r !== null) { cage = r.cage; offBefore = r.before; offAfter = r.after }
  }
  return { cage, flatFaces, gridFaces, triangleFaces, triangles, offBefore, offAfter }
}

/**
 * A flat face with holes (a plate top round a boss, a block top round a pocket) as triangles between its
 * loops' points (point id lists, the outer one the largest), so its edges take whatever counts the faces
 * beside them settle on: kept as the body's own triangles they kept their own counts, and a pocket whose
 * rim had eight points on each corner arc and one on each straight wall could not be gridded at all.
 */
function plateTriangles(loops: number[][], out: Vec3[], n: Vec3): number[][] {
  const u = unit(cross(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], n)), w = cross(n, u)
  const flat = loops.map((l) => l.map((i) => new THREE.Vector2(dot(out[i], u), dot(out[i], w))))
  const area = flat.map((l) => Math.abs(THREE.ShapeUtils.area(l)))
  const outer = area.indexOf(Math.max(...area))
  const order = [outer, ...loops.map((_, j) => j).filter((j) => j !== outer)]
  const ids = order.flatMap((j) => loops[j])
  const tris = THREE.ShapeUtils.triangulateShape(flat[outer], order.slice(1).map((j) => flat[j])).map((t) => t.map((i) => ids[i]))
  // earcut leaves out a loop point exactly in line with its neighbours (the samples along a straight edge) and
  // bridges holes along such lines (two ribs' ends in line: one edge through both), and the face would be open
  // there: a triangle edge with loop points on it becomes a fan through them
  const xy = new Map<number, THREE.Vector2>()
  order.forEach((j) => loops[j].forEach((id, k) => xy.set(id, flat[j][k])))
  const all = [...xy.keys()]
  const onEdge = (u: number, v: number): number[] => {
    const a = xy.get(u)!, d = xy.get(v)!.clone().sub(a), l2 = d.lengthSq()
    const eps = 1e-9 * Math.max(1, l2)
    return all
      .map((id) => { const q = xy.get(id)!.clone().sub(a); return { id, t: q.dot(d) / l2, off: Math.abs(q.cross(d)) } })
      .filter((h) => h.id !== u && h.id !== v && h.off <= eps && h.t > 1e-9 && h.t < 1 - 1e-9)
      .sort((x, y) => x.t - y.t).map((h) => h.id)
  }
  const split = (t: number[], depth: number): number[][] => {
    for (let e = 0; e < 3 && depth < 8; e++) {
      const u = t[e], v = t[(e + 1) % 3], c = t[(e + 2) % 3]
      const run = onEdge(u, v)
      if (run.length === 0) continue
      const pts = [u, ...run, v]
      return pts.slice(0, -1).flatMap((q, k) => split([q, pts[k + 1], c], depth + 1))
    }
    return [t]
  }
  return tris.flatMap((t) => split(t, 0))
}

/**
 * A grid of quads inside four sides (point id lists, each running round the
 * face: side 0 c0->c1, side 1 c1->c2, side 2 c2->c3, side 3 c3->c0; opposite
 * sides the same length). Interior points: the Coons patch of the sides, put
 * on the face and relaxed.
 */
function coonsGrid(sides: number[][], out: Vec3[], onFace: { closest(q: Vec3): { point: Vec3 } }, place: (p: Vec3) => Vec3 = (p) => onFace.closest(p).point): number[][] {
  const a = sides[0].length - 1, b = sides[1].length - 1
  const grid: number[][] = Array.from({ length: a + 1 }, () => new Array<number>(b + 1))
  for (let i = 0; i <= a; i++) { grid[i][0] = sides[0][i]; grid[a - i][b] = sides[2][i] }
  for (let j = 0; j <= b; j++) { grid[a][j] = sides[1][j]; grid[0][b - j] = sides[3][j] }
  const X = (i: number, j: number) => out[grid[i][j]]
  const inner: Array<[number, number]> = []
  for (let i = 1; i < a; i++) for (let j = 1; j < b; j++) {
    const u = i / a, v = j / b
    const p = [0, 1, 2].map((c) =>
      (1 - v) * X(i, 0)[c] + v * X(i, b)[c] + (1 - u) * X(0, j)[c] + u * X(a, j)[c]
      - ((1 - u) * (1 - v) * X(0, 0)[c] + u * (1 - v) * X(a, 0)[c] + (1 - u) * v * X(0, b)[c] + u * v * X(a, b)[c])) as Vec3
    out.push(place(p))
    grid[i][j] = out.length - 1
    inner.push([i, j])
  }
  relax(inner.map(([i, j]) => grid[i][j]), inner.map(([i, j]) => [grid[i - 1][j], grid[i + 1][j], grid[i][j - 1], grid[i][j + 1]]), out, onFace)
  const quads: number[][] = []
  for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) quads.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]])
  return quads
}

/**
 * A face of three (or five or more) sides, each the same even count, running
 * round it: a centre point on the face, a spoke from the middle of every side to
 * it, and one Coons grid in each corner (half of the side before the corner,
 * half of the side after, and the two spokes).
 */
function starGrid(sides: number[][], out: Vec3[], onFace: { closest(q: Vec3): { point: Vec3 } }): number[][] {
  const m = (sides[0].length - 1) / 2
  const centre = centroid(sides.flatMap((s) => s.slice(0, -1).map((i) => out[i])))
  out.push(onFace.closest(centre).point)
  const c = out.length - 1
  // spoke i: the middle of side i to the centre, m segments
  const spokes = sides.map((s) => {
    const a = out[s[m]], b = out[c]
    const ids = [s[m]]
    for (let k = 1; k < m; k++) { const f = k / m; out.push(onFace.closest([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]).point); ids.push(out.length - 1) }
    ids.push(c)
    return ids
  })
  const quads: number[][] = []
  for (let i = 0; i < sides.length; i++) {
    const j = (i + 1) % sides.length
    // the corner where side i ends and side j starts
    const patch = [sides[i].slice(m), sides[j].slice(0, m + 1), spokes[j], [...spokes[i]].reverse()]
    quads.push(...coonsGrid(patch, out, onFace))
  }
  return quads
}

/** Rings of quads between two closed loops of the same length (lined up by least distance), their interior on the face. */
function ringGrid(l0: number[], l1raw: number[], out: Vec3[], onFace: { closest(q: Vec3): { point: Vec3; distance: number } }, h: number, ruledTol: number, maxTurn: number): number[][] {
  const n = l0.length
  // the second loop runs the other way round the face; turn it to line up with the first
  let l1 = [...l1raw].reverse()
  let best = 0, bestLen = Infinity
  for (let s = 0; s < n; s++) { let len = 0; for (let i = 0; i < n; i++) len += dist(out[l0[i]], out[l1[(i + s) % n]]); if (len < bestLen) { bestLen = len; best = s } }
  l1 = [...l1.slice(best), ...l1.slice(0, best)]
  // ruled (every straight line between matched rim points on the face): one ring of quads is the face. Matched
  // samples can straddle the tessellation's facets, so the lines may miss the mesh by up to its own chord sag
  // between neighbouring samples; a band that is really curved misses by its much larger sagitta
  const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  const sag = Math.max(...l0.map((p, i) => onFace.closest(mid(out[p], out[l0[(i + 1) % n]])).distance))
  const tol = Math.max(ruledTol, 2 * sag)
  const ruled = l0.every((p, i) => [0.25, 0.5, 0.75].every((f) => {
    const a = out[p], b = out[l1[i]]
    return onFace.closest([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]).distance <= tol
  }))
  // ...but a band that turns across takes a ring per maxTurn of it, ruled or not: a short one passes the test
  // above (an r3 foot fillet round a d20 boss misses its lines by 0.88 mm against a 1.5 mm sag, and is one
  // twelfth of the body across), and one ring made it a straight bevel at Finish (WO-2822). How far it turns:
  // the arc whose chord is the line between matched points and whose sagitta is the line's miss at its middle
  // (8 x sagitta / chord; a facet's miss over a long straight line turns it next to nothing)
  const turn = Math.max(...l0.map((p, i) => { const a = out[p], b = out[l1[i]], L = dist(a, b); return L > 0 ? (8 * onFace.closest(mid(a, b)).distance) / L : 0 }))
  const byTurn = Math.ceil(turn / maxTurn - 1e-9)
  const m = Math.max(1, byTurn, ruled ? 1 : Math.round(bestLen / n / h))
  const rings: number[][] = [l0]
  const inner: number[] = [], nbs: number[][] = []
  for (let k = 1; k < m; k++) {
    const f = k / m
    rings.push(l0.map((p, i) => { const a = out[p], b = out[l1[i]]; out.push(onFace.closest([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]).point); return out.length - 1 }))
  }
  rings.push(l1)
  for (let k = 1; k < m; k++) for (let i = 0; i < n; i++) { inner.push(rings[k][i]); nbs.push([rings[k - 1][i], rings[k + 1][i], rings[k][(i + 1) % n], rings[k][(i - 1 + n) % n]]) }
  relax(inner, nbs, out, onFace)
  const quads: number[][] = []
  for (let k = 0; k < m; k++) for (let i = 0; i < n; i++) quads.push([rings[k][i], rings[k][(i + 1) % n], rings[k + 1][(i + 1) % n], rings[k + 1][i]])
  return quads
}

/**
 * Where a point of a dome's flat rim disk goes onto the dome: along the rim's normal (turned toward the dome)
 * to the dome's triangles, the nearest hit; its nearest point on them when the line misses.
 */
function liftOnto(rim: Vec3[], faceTris: Vec3[][]): (p: Vec3) => Vec3 {
  let n = newellN(rim)
  const c = centroid(rim)
  const mid = centroid(faceTris.map((t) => centroid(t)))
  if (dot(n, sub(mid, c)) < 0) n = [-n[0], -n[1], -n[2]]
  const onFace = closestPointIndex({ position: faceTris.flat(2), index: faceTris.flatMap((_, j) => [j * 3, j * 3 + 1, j * 3 + 2]) })
  return (p) => {
    let best = Infinity
    for (const [a, b, q] of faceTris) {
      // Moller-Trumbore, both ways along the line (a rim that is not quite flat starts some points above the dome)
      const e1 = sub(b, a), e2 = sub(q, a), pv = cross(n, e2), det = dot(e1, pv)
      if (Math.abs(det) < 1e-12) continue
      const tv = sub(p, a), u = dot(tv, pv) / det
      if (u < -1e-9 || u > 1 + 1e-9) continue
      const qv = cross(tv, e1), v = dot(n, qv) / det
      if (v < -1e-9 || u + v > 1 + 1e-9) continue
      const t = dot(e2, qv) / det
      if (Math.abs(t) < Math.abs(best)) best = t
    }
    return best === Infinity ? onFace.closest(p).point : [p[0] + n[0] * best, p[1] + n[1] * best, p[2] + n[2] * best]
  }
}

/** A few rounds of each interior point to the average of its neighbours, put back on the face. */
function relax(ids: number[], nbs: number[][], out: Vec3[], onFace: { closest(q: Vec3): { point: Vec3 } }, rounds = 8): void {
  for (let r = 0; r < rounds; r++) {
    const next = ids.map((_, k) => centroid(nbs[k].map((i) => out[i])))
    ids.forEach((id, k) => { out[id] = onFace.closest(next[k]).point })
  }
}

function closestOnPolyline(pts: Vec3[], q: Vec3): Vec3 {
  let best: Vec3 = pts[0], bestD = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], d = sub(pts[i], a)
    const l2 = dot(d, d)
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / l2)) : 0
    const p: Vec3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]
    const dd = dist(p, q)
    if (dd < bestD) { bestD = dd; best = p }
  }
  return best
}

/** n + 1 points evenly by length along a polyline, its ends included. */
/** The point at fraction t of a polyline's length. */
function pointAtLength(pts: Vec3[], t: number): Vec3 {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  const w = t * cum[cum.length - 1]
  let i = 1
  while (i < cum.length - 1 && cum[i] < w) i++
  const f = cum[i] > cum[i - 1] ? (w - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f, pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * f]
}

function resample(pts: Vec3[], n: number): Vec3[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  const total = cum[cum.length - 1]
  const res: Vec3[] = []
  for (let j = 0; j <= n; j++) {
    const s = (total * j) / n
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const f = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0
    res.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f, pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * f])
  }
  return res
}

function newellN(pts: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return unit(n)
}
const centroid = (pts: Vec3[]): Vec3 => [0, 1, 2].map((c) => pts.reduce((s, p) => s + p[c], 0) / pts.length) as Vec3
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0] }
