// Form - selection helpers and the opening / closing topology tools.
//
//   edgeLoop     the edges continuing straight on through ordinary points
//                (valence 4) from a picked edge, both ways, until the loop
//                closes or reaches another kind of point
//   deleteFaces  remove faces (an opening); points no face uses go too
//   fillHole     cap the open loop through a boundary edge with one face
//   bridge       join two faces of equal side count with a tube of quads (the
//                two faces are removed): a handle, a hole through the part
//   thicken      an open form becomes a closed one: an inner skin offset by a
//                thickness along the point normals, joined to the outer skin
//                at every open loop
//   splitEdges   insert a point in the middle of edges (Insert point)
//   subdivideFaces  faces become quads round a centre point (Subdivide)
//   weldPoints   merge points into one at their centroid (Weld); weldByDistance
//                merges every cluster of points closer than a distance
//   dissolveEdges  delete edges: the faces either side become one; a point left
//                with two edges (not on an open border) goes too, so deleting
//                an edge loop removes the whole loop
//   unweldEdges  cut the cage open along edges (Unweld): each point on the cut
//                gets one copy per side; regionBorder gives a face set's border
//   growSelection / shrinkSelection / selectAll  the selection one ring
//                wider or narrower (faces by shared corners, points and edges
//                by their neighbours), or every element of its kind
// Every result keeps the cage's orientation (faces wound the same way round).

import type { Cage, Vec3 } from './cage'
import { cloneCage, edgeKey, parseEdgeKey, remapWeights } from './cage'

function facesOfEdges(cage: Cage): Map<string, number[]> {
  const map = new Map<string, number[]>()
  cage.faces.forEach((loop, f) => {
    for (let i = 0; i < loop.length; i++) {
      const key = edgeKey(loop[i], loop[(i + 1) % loop.length])
      const list = map.get(key)
      if (list) list.push(f)
      else map.set(key, [f])
    }
  })
  return map
}

function neighboursOf(cage: Cage): number[][] {
  const out: number[][] = cage.positions.map(() => [])
  for (const loop of cage.faces) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      if (!out[a].includes(b)) out[a].push(b)
      if (!out[b].includes(a)) out[b].push(a)
    }
  }
  return out
}

/**
 * The edge loop through `start`: straight on through every valence-4 point, both ways. `rims`: where
 * there is no straight on, an edge on the rim of one face that is not a quad (a cylinder's round cap)
 * follows that face's rim on round.
 */
export function edgeLoop(cage: Cage, start: string, opts: { rims?: boolean } = {}): string[] {
  const byEdge = facesOfEdges(cage)
  const nbrs = neighboursOf(cage)
  // at point v arriving from u: the one neighbour sharing no face with edge (u, v) - at a point
  // that is not ordinary there is none (valence 3) or more than one (valence 5+), and the loop stops
  const straightOn = (u: number, v: number): number | null => {
    const beside = new Set<number>()
    const faces = byEdge.get(edgeKey(u, v)) ?? []
    for (const f of faces) for (const p of cage.faces[f]) beside.add(p)
    const across = nbrs[v].filter((w) => w !== u && !beside.has(w))
    if (across.length === 1) return across[0]
    if (!opts.rims) return null
    const rims = faces.filter((f) => cage.faces[f].length !== 4)
    if (rims.length !== 1) return null
    const loop = cage.faces[rims[0]]
    const i = loop.indexOf(v)
    const next = loop[(i + 1) % loop.length] === u ? loop[(i - 1 + loop.length) % loop.length] : loop[(i + 1) % loop.length]
    return next === u ? null : next
  }
  const [a, b] = parseEdgeKey(start)
  const edges = [start]
  const seen = new Set(edges)
  const walk = (u: number, v: number): boolean => {
    for (;;) {
      const w = straightOn(u, v)
      if (w === null) return false
      const key = edgeKey(v, w)
      if (seen.has(key)) return true
      seen.add(key)
      edges.push(key)
      u = v
      v = w
    }
  }
  if (!walk(a, b)) walk(b, a)
  return edges
}

/**
 * The ring of points through `points` (Loop with points selected): of the edge loops (rims included)
 * through the first point's edges, the ones holding every selected point; a closed ring wins over an
 * open run. Null when there is no one answer - no loop holds them all, or two rings do (a box's face
 * centre has two; a second neighbouring point picks one).
 */
export function pointLoop(cage: Cage, points: readonly number[]): number[] | null {
  if (points.length === 0) return null
  const first = points[0]
  const found = new Map<string, { points: number[]; closed: boolean }>()
  for (const w of neighboursOf(cage)[first] ?? []) {
    const edges = edgeLoop(cage, edgeKey(first, w), { rims: true })
    const on = new Set<number>()
    for (const k of edges) for (const p of parseEdgeKey(k)) on.add(p)
    if (!points.every((p) => on.has(p))) continue
    const list = [...on].sort((x, y) => x - y)
    // a closed ring has as many points as edges; an open run one more
    found.set(list.join(','), { points: list, closed: list.length === edges.length })
  }
  const loops = [...found.values()]
  const closed = loops.filter((l) => l.closed)
  if (closed.length > 0) return closed.length === 1 ? closed[0].points : null
  return loops.length === 1 ? loops[0].points : null
}

/** Remove faces; drop the points no remaining face uses (indices renumbered, creases kept where both ends stay). */
export function deleteFaces(cage: Cage, faces: readonly number[]): Cage {
  const drop = new Set(faces)
  const kept = cage.faces.filter((_, f) => !drop.has(f))
  return compact({ ...cage, faces: kept })
}

function compact(cage: Cage): Cage {
  return compactWithMap(cage).cage
}

export function compactWithMap(cage: Cage): { cage: Cage; map: Map<number, number> } {
  const used = new Set<number>()
  for (const loop of cage.faces) for (const p of loop) used.add(p)
  const map = new Map<number, number>()
  const positions: Vec3[] = []
  cage.positions.forEach((p, i) => { if (used.has(i)) { map.set(i, positions.length); positions.push([p[0], p[1], p[2]]) } })
  const edges = new Set<string>()
  const faces = cage.faces.map((loop) => loop.map((p) => map.get(p)!))
  for (const loop of faces) for (let i = 0; i < loop.length; i++) edges.add(edgeKey(loop[i], loop[(i + 1) % loop.length]))
  const creases = cage.creases.map((k) => {
    const [a, b] = parseEdgeKey(k)
    const ma = map.get(a), mb = map.get(b)
    return ma === undefined || mb === undefined ? null : edgeKey(ma, mb)
  }).filter((k): k is string => k !== null && edges.has(k))
  const weights = remapWeights(cage.weights, (k) => {
    const [a, b] = parseEdgeKey(k)
    const ma = map.get(a), mb = map.get(b)
    return ma === undefined || mb === undefined || !edges.has(edgeKey(ma, mb)) ? null : edgeKey(ma, mb)
  })
  return { cage: { positions, faces, creases, ...(weights !== undefined ? { weights } : {}) }, map }
}

/** The open loop through a boundary edge, in the order that closes it the cage's way round; null if the edge is not open. */
export function openLoopThrough(cage: Cage, edge: string): number[] | null {
  const byEdge = facesOfEdges(cage)
  if ((byEdge.get(edge)?.length ?? 0) !== 1) return null
  // each open edge's owning face runs a -> b; the cap must run b -> a, so follow b -> a steps
  const next = new Map<number, number>()
  for (const [key, list] of byEdge) {
    if (list.length !== 1) continue
    const loop = cage.faces[list[0]]
    const [x, y] = parseEdgeKey(key)
    const i = loop.indexOf(x)
    const forward = loop[(i + 1) % loop.length] === y
    const [a, b] = forward ? [x, y] : [y, x]
    next.set(b, a)
  }
  const [s] = parseEdgeKey(edge)
  const out = [s]
  for (let p = next.get(s); p !== undefined && p !== s; p = next.get(p)) {
    if (out.length > next.size) return null
    out.push(p)
  }
  return out.length >= 3 ? out : null
}

/** Cap the open loop through `edge` with one face; null when the edge is not on an open loop. */
export function fillHole(cage: Cage, edge: string): Cage | null {
  const loop = openLoopThrough(cage, edge)
  if (loop === null) return null
  const out = cloneCage(cage)
  out.faces.push(loop)
  return out
}

/**
 * Join faces `fa` and `fb` (same side count) with a tube of quads and remove
 * them. The pairing of their corners is the rotation with the shortest total
 * rung length; `fb` is walked backwards so the tube keeps the orientation.
 */
export function bridge(cage: Cage, fa: number, fb: number): Cage | null {
  const A = cage.faces[fa], B = cage.faces[fb]
  if (!A || !B || fa === fb || A.length !== B.length) return null
  if (A.some((p) => B.includes(p))) return null
  const n = A.length
  const rev = [...B].reverse()
  const P = cage.positions
  let best = 0, bestLen = Infinity
  for (let k = 0; k < n; k++) {
    let len = 0
    for (let i = 0; i < n; i++) {
      const p = P[A[i]], q = P[rev[(i + k) % n]]
      len += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    }
    if (len < bestLen) { bestLen = len; best = k }
  }
  const out = cloneCage(cage)
  out.faces = out.faces.filter((_, f) => f !== fa && f !== fb)
  for (let i = 0; i < n; i++) {
    const a0 = A[i], a1 = A[(i + 1) % n]
    const b0 = rev[(i + best) % n], b1 = rev[(i + 1 + best) % n]
    // the tube quad takes the removed faces' place on their edges, so it runs each edge the
    // way its face did: a0 -> a1 on A's side, b1 -> b0 (B's own direction) on B's
    out.faces.push([a0, a1, b1, b0])
  }
  return out
}

/** Point normals of a cage: the average of its faces' (Newell) normals. */
function pointNormals(cage: Cage): Vec3[] {
  const n: Vec3[] = cage.positions.map(() => [0, 0, 0])
  for (const loop of cage.faces) {
    let nx = 0, ny = 0, nz = 0
    for (let i = 0; i < loop.length; i++) {
      const p = cage.positions[loop[i]], q = cage.positions[loop[(i + 1) % loop.length]]
      nx += (p[1] - q[1]) * (p[2] + q[2])
      ny += (p[2] - q[2]) * (p[0] + q[0])
      nz += (p[0] - q[0]) * (p[1] + q[1])
    }
    for (const p of loop) { n[p][0] += nx; n[p][1] += ny; n[p][2] += nz }
  }
  return n.map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] as Vec3 : [0, 0, 1] as Vec3 })
}

/**
 * An open cage made closed: an inner skin `thickness` inside (against the
 * point normals), wound the other way, joined to the outer skin by a quad per
 * open edge. The rim edges are creased so the rim stays crisp. Null when the
 * cage has no open edge.
 */
export function thicken(cage: Cage, thickness: number): Cage | null {
  const byEdge = facesOfEdges(cage)
  const open: Array<[number, number]> = []
  for (const [key, list] of byEdge) {
    if (list.length !== 1) continue
    const loop = cage.faces[list[0]]
    const [x, y] = parseEdgeKey(key)
    const i = loop.indexOf(x)
    open.push(loop[(i + 1) % loop.length] === y ? [x, y] : [y, x])
  }
  if (open.length === 0 || !(thickness > 0)) return null
  const normals = pointNormals(cage)
  const n = cage.positions.length
  const positions: Vec3[] = [
    ...cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3),
    ...cage.positions.map((p, i) => [p[0] - normals[i][0] * thickness, p[1] - normals[i][1] * thickness, p[2] - normals[i][2] * thickness] as Vec3),
  ]
  const faces = [
    ...cage.faces.map((loop) => loop.slice()),
    ...cage.faces.map((loop) => [...loop].reverse().map((p) => p + n)),
  ]
  const creases = new Set(cage.creases)
  for (const k of cage.creases) { const [a, b] = parseEdgeKey(k); creases.add(edgeKey(a + n, b + n)) }
  for (const [a, b] of open) {
    // outer face runs a -> b; the rim quad runs b -> a on the outside, down to the inner skin
    faces.push([b, a, a + n, b + n])
    creases.add(edgeKey(a, b))
    creases.add(edgeKey(a + n, b + n))
  }
  const weights = remapWeights(cage.weights, (k) => { const [a, b] = parseEdgeKey(k); return [k, edgeKey(a + n, b + n)] })
  return { positions, faces, creases: [...creases], ...(weights !== undefined ? { weights } : {}) }
}

/**
 * Insert a point in the middle of each of `edges`: every face using the edge
 * gains it; a creased (or weighted) edge leaves two creased halves. `mid` maps
 * each split edge to its new point.
 */
export function splitEdges(cage: Cage, edges: readonly string[]): { cage: Cage; mid: Map<string, number> } {
  const existing = new Set<string>()
  for (const loop of cage.faces) for (let i = 0; i < loop.length; i++) existing.add(edgeKey(loop[i], loop[(i + 1) % loop.length]))
  const out = cloneCage(cage)
  const mid = new Map<string, number>()
  for (const key of edges) {
    if (mid.has(key) || !existing.has(key)) continue
    const [a, b] = parseEdgeKey(key)
    const p = cage.positions[a], q = cage.positions[b]
    mid.set(key, out.positions.length)
    out.positions.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2])
  }
  out.faces = cage.faces.map((loop) => loop.flatMap((p, i) => {
    const m = mid.get(edgeKey(p, loop[(i + 1) % loop.length]))
    return m === undefined ? [p] : [p, m]
  }))
  const halves = (k: string): string[] => { const m = mid.get(k); if (m === undefined) return [k]; const [a, b] = parseEdgeKey(k); return [edgeKey(a, m), edgeKey(m, b)] }
  out.creases = cage.creases.flatMap(halves)
  const weights = remapWeights(cage.weights, halves)
  if (weights !== undefined) out.weights = weights
  else delete out.weights
  return { cage: out, mid }
}

/**
 * Each of `faces` becomes quads round a new point at its centre, one quad per
 * corner; its edges are split at their middles, in the faces beside it too
 * (they gain a side, so no face is left with a point hanging on its edge).
 * `faces` in the result lists every new quad.
 */
export function subdivideFaces(cage: Cage, faces: readonly number[]): { cage: Cage; faces: number[] } {
  const chosen = [...new Set(faces)].filter((f) => cage.faces[f] !== undefined)
  const edges = chosen.flatMap((f) => cage.faces[f].map((p, i, loop) => edgeKey(p, loop[(i + 1) % loop.length])))
  const { cage: split, mid } = splitEdges(cage, edges)
  const out = split
  const made: number[] = []
  for (const f of chosen) {
    const corners = cage.faces[f]
    const n = corners.length
    const c = [0, 1, 2].map((k) => corners.reduce((sum, p) => sum + cage.positions[p][k], 0) / n) as Vec3
    const centre = out.positions.length
    out.positions.push(c)
    const m = (i: number) => mid.get(edgeKey(corners[i], corners[(i + 1) % n]))!
    for (let i = 0; i < n; i++) {
      // corner i, the middle of its next edge, the centre, the middle of its previous edge: the face's own winding
      const quad = [corners[i], m(i), centre, m((i - 1 + n) % n)]
      if (i === 0) { out.faces[f] = quad; made.push(f) } else { made.push(out.faces.length); out.faces.push(quad) }
    }
  }
  return { cage: out, faces: made }
}

/**
 * Merge `points` into one point at their centroid. Faces drop the corners that
 * became repeats; a face left with fewer than three goes; creases and weights
 * follow the merged point. Null for fewer than two points.
 */
export function weldPoints(cage: Cage, points: readonly number[]): { cage: Cage; point: number } | null {
  const r = weldGroups(cage, [points])
  return r === null ? null : { cage: r.cage, point: r.points[0] }
}

/** Weld each group (as weldPoints does one); `points` gives each group's merged point (-1 if no face kept it). */
export function weldGroups(cage: Cage, groups: ReadonlyArray<readonly number[]>): { cage: Cage; points: number[] } | null {
  const clean = groups
    .map((g) => [...new Set(g)].filter((p) => cage.positions[p] !== undefined).sort((a, b) => a - b))
    .filter((g) => g.length >= 2)
  if (clean.length === 0) return null
  const target = new Map<number, number>()
  const positions = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  for (const group of clean) {
    const keep = group[0]
    for (const p of group) target.set(p, keep)
    positions[keep] = [0, 1, 2].map((k) => group.reduce((sum, p) => sum + cage.positions[p][k], 0) / group.length) as Vec3
  }
  const into = (p: number) => target.get(p) ?? p
  const faces = cage.faces
    .map((loop) => loop.map(into).filter((p, i, l) => p !== l[(i + 1) % l.length]))
    .filter((loop) => new Set(loop).size >= 3)
  const remap = (k: string): string | null => { const [a, b] = parseEdgeKey(k); const x = into(a), y = into(b); return x === y ? null : edgeKey(x, y) }
  const creases = [...new Set(cage.creases.map(remap).filter((k): k is string => k !== null))]
  const weights = remapWeights(cage.weights, remap)
  const { cage: out, map } = compactWithMap({ positions, faces, creases, ...(weights !== undefined ? { weights } : {}) })
  return { cage: out, points: clean.map((g) => map.get(g[0]) ?? -1) }
}

/**
 * Weld by distance: among `candidates` (every point when empty), points closer
 * than `distance` to one another - directly or through a chain - become one,
 * at their centroid. Null when no two are that close.
 */
export function weldByDistance(cage: Cage, candidates: readonly number[], distance: number): { cage: Cage; points: number[]; groups: number } | null {
  const pts = candidates.length > 0 ? [...new Set(candidates)].filter((p) => cage.positions[p] !== undefined) : cage.positions.map((_, i) => i)
  const parent = new Map<number, number>(pts.map((p) => [p, p]))
  const find = (p: number): number => { let r = p; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(p, r); return r }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = cage.positions[pts[i]], b = cage.positions[pts[j]]
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= distance) parent.set(find(pts[i]), find(pts[j]))
    }
  }
  const byRoot = new Map<number, number[]>()
  for (const p of pts) { const r = find(p); byRoot.set(r, [...(byRoot.get(r) ?? []), p]) }
  const groups = [...byRoot.values()].filter((g) => g.length >= 2)
  const r = weldGroups(cage, groups)
  return r === null ? null : { ...r, groups: groups.length }
}

/**
 * Delete edges: the two faces beside each
 * edge merge into one. Edges with one face (an open border) are left. A face
 * group whose outline would not be one simple loop is left as it was
 * (`skipped`). Points of deleted edges left with two edges and not on an open
 * border are removed from their faces; the two edges through such a point
 * become one, creased or weighted when both were. Null when nothing changed.
 */
export function dissolveEdges(cage: Cage, edges: readonly string[]): { cage: Cage; removed: number; points: number; skipped: number } | null {
  const byEdge = facesOfEdges(cage)
  const del = new Set([...new Set(edges)].filter((k) => { const f = byEdge.get(k); return f !== undefined && f.length === 2 && f[0] !== f[1] }))
  if (del.size === 0) return null
  const parent = cage.faces.map((_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  for (const k of del) { const [f, g] = byEdge.get(k)!; parent[find(f)] = find(g) }
  const groups = new Map<number, number[]>()
  cage.faces.forEach((_, f) => { const r = find(f); const l = groups.get(r); if (l) l.push(f); else groups.set(r, [f]) })
  const faces: number[][] = []
  let removed = 0, skipped = 0
  const kept = new Set<string>()
  for (const group of groups.values()) {
    if (group.length === 1) { faces.push(cage.faces[group[0]].slice()); continue }
    // the group's outline: its faces' directed edges that are not deleted
    const next = new Map<number, number>()
    let ok = true
    let inner = 0
    for (const f of group) {
      const loop = cage.faces[f]
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length]
        if (del.has(edgeKey(a, b))) { inner++; continue }
        if (next.has(a)) ok = false
        next.set(a, b)
      }
    }
    const loop: number[] = []
    if (ok && next.size >= 3) {
      const first = next.keys().next().value as number
      let cur = first
      do { loop.push(cur); cur = next.get(cur)!; } while (cur !== undefined && cur !== first && loop.length <= next.size)
      ok = cur === first && loop.length === next.size
    } else ok = false
    if (!ok) { skipped++; for (const f of group) faces.push(cage.faces[f].slice()); for (const f of group) { const l = cage.faces[f]; for (let i = 0; i < l.length; i++) { const k = edgeKey(l[i], l[(i + 1) % l.length]); if (del.has(k)) kept.add(k) } } continue }
    removed += inner / 2
    faces.push(loop)
  }
  if (removed === 0) return null
  // points of deleted edges left with two edges, not on an open border, go
  const uses = new Map<string, number>()
  for (const l of faces) for (let i = 0; i < l.length; i++) { const k = edgeKey(l[i], l[(i + 1) % l.length]); uses.set(k, (uses.get(k) ?? 0) + 1) }
  const nbrs = new Map<number, Set<number>>()
  for (const k of uses.keys()) { const [a, b] = parseEdgeKey(k); (nbrs.get(a) ?? nbrs.set(a, new Set()).get(a)!).add(b); (nbrs.get(b) ?? nbrs.set(b, new Set()).get(b)!).add(a) }
  const ends = new Set<number>()
  for (const k of del) if (!kept.has(k)) for (const p of parseEdgeKey(k)) ends.add(p)
  const creased = new Set(cage.creases)
  const weights: Record<string, number> = { ...(cage.weights ?? {}) }
  const drop = new Set<number>()
  for (const p of ends) {
    const n = nbrs.get(p)
    if (n === undefined || n.size !== 2) continue
    const [a, b] = [...n]
    if (uses.get(edgeKey(a, p)) !== 2 || uses.get(edgeKey(p, b)) !== 2 || nbrs.get(a)?.has(b)) continue
    drop.add(p)
    const ka = edgeKey(a, p), kb = edgeKey(p, b), kab = edgeKey(a, b)
    if (creased.has(ka) && creased.has(kb)) creased.add(kab)
    if (weights[ka] !== undefined && weights[kb] !== undefined) weights[kab] = Math.min(weights[ka], weights[kb])
    // update neighbours so a chain of dropped points joins end to end
    nbrs.get(a)!.delete(p); nbrs.get(a)!.add(b); nbrs.get(b)!.delete(p); nbrs.get(b)!.add(a)
    uses.set(kab, 2)
  }
  const out = faces.map((l) => l.filter((p) => !drop.has(p)))
  if (out.some((l) => l.length < 3)) return null
  const creases = [...creased].filter((k) => !del.has(k) || kept.has(k))
  const w = Object.fromEntries(Object.entries(weights).filter(([k]) => !del.has(k) || kept.has(k)))
  const { cage: compacted } = compactWithMap({ positions: cage.positions, faces: out, creases, ...(Object.keys(w).length > 0 ? { weights: w } : {}) })
  return { cage: compacted, removed, points: drop.size, skipped }
}

/** The edges between a face set and the rest of the cage (each edge with exactly one of its two faces in the set). */
export function regionBorder(cage: Cage, faces: readonly number[]): string[] {
  const inSet = new Set(faces)
  const out: string[] = []
  for (const [key, fs] of facesOfEdges(cage)) if (fs.length === 2 && inSet.has(fs[0]) !== inSet.has(fs[1])) out.push(key)
  return out
}

/**
 * Unweld: cut the cage open along `edges` (edges with two faces; others are
 * ignored). Round every point on the cut, its faces fall into sides separated
 * by cut edges and open borders; each side past the first gets its own copy of
 * the point, at the same place. A closed chain of cut edges separates the form;
 * an open chain becomes a slit (its end points stay joined); a lone edge inside
 * the form has nothing to open. Creases and weights follow onto both sides.
 * Null when nothing opens.
 */
export function unweldEdges(cage: Cage, edges: readonly string[]): { cage: Cage; opened: string[]; split: number } | null {
  const byEdge = facesOfEdges(cage)
  const cut = new Set(edges.filter((k) => (byEdge.get(k)?.length ?? 0) === 2))
  if (cut.size === 0) return null
  const corners = new Map<number, Array<[number, number]>>()
  cage.faces.forEach((loop, f) => loop.forEach((p, i) => { const list = corners.get(p); if (list) list.push([f, i]); else corners.set(p, [[f, i]]) }))
  const faces = cage.faces.map((loop) => loop.slice())
  const positions = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  const origin = positions.map((_, i) => i)
  let split = 0
  const touched = new Set<number>()
  for (const k of cut) for (const p of parseEdgeKey(k)) touched.add(p)
  for (const p of [...touched].sort((a, b) => a - b)) {
    const list = corners.get(p) ?? []
    const parent = list.map((_, i) => i)
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
    // corners of p sharing an uncut edge through p are on the same side
    const byKey = new Map<string, number[]>()
    list.forEach(([f, i], c) => {
      const loop = cage.faces[f]
      for (const q of [loop[(i - 1 + loop.length) % loop.length], loop[(i + 1) % loop.length]]) {
        const k = edgeKey(p, q)
        const l = byKey.get(k)
        if (l) l.push(c); else byKey.set(k, [c])
      }
    })
    for (const [k, cs] of byKey) if (!cut.has(k) && cs.length === 2) parent[find(cs[0])] = find(cs[1])
    const sides = new Map<number, number[]>()
    list.forEach((_, c) => { const r = find(c); const l = sides.get(r); if (l) l.push(c); else sides.set(r, [c]) })
    if (sides.size < 2) continue
    ;[...sides.values()].slice(1).forEach((side) => {
      const copy = positions.length
      positions.push([cage.positions[p][0], cage.positions[p][1], cage.positions[p][2]])
      origin.push(p)
      for (const c of side) { const [f, i] = list[c]; faces[f][i] = copy }
      split++
    })
  }
  if (split === 0) return null
  const creased = new Set(cage.creases)
  const creases = new Set<string>()
  const weights: Record<string, number> = {}
  const uses = new Map<string, number>()
  for (const loop of faces) {
    for (let i = 0; i < loop.length; i++) {
      const u = loop[i], v = loop[(i + 1) % loop.length]
      const k = edgeKey(u, v), k0 = edgeKey(origin[u], origin[v])
      uses.set(k, (uses.get(k) ?? 0) + 1)
      if (creased.has(k0)) creases.add(k)
      const w = cage.weights?.[k0]
      if (w !== undefined) weights[k] = w
    }
  }
  const opened = [...uses].filter(([k, n]) => { const [a, b] = parseEdgeKey(k); return n === 1 && cut.has(edgeKey(origin[a], origin[b])) }).map(([k]) => k)
  const out: Cage = { positions, faces, creases: [...creases], ...(Object.keys(weights).length > 0 ? { weights } : {}) }
  return { cage: out, opened, split }
}

/** A selection: points, edge keys, face indices (the store's CageSelection shape). */
interface Selection { points: number[]; edges: string[]; faces: number[] }

function cornerFaces(cage: Cage): number[][] {
  const out: number[][] = cage.positions.map(() => [])
  cage.faces.forEach((loop, f) => { for (const p of loop) out[p].push(f) })
  return out
}

function edgesAtPoint(cage: Cage): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const seen = new Set<string>()
  for (const loop of cage.faces) {
    for (let i = 0; i < loop.length; i++) {
      const key = edgeKey(loop[i], loop[(i + 1) % loop.length])
      if (seen.has(key)) continue
      seen.add(key)
      for (const p of parseEdgeKey(key)) out.set(p, [...(out.get(p) ?? []), key])
    }
  }
  return out
}

/** One ring wider: faces gain every face sharing a corner, points their neighbours, edges those sharing an end. */
export function growSelection(cage: Cage, s: Selection): Selection {
  const byCorner = cornerFaces(cage)
  const faces = new Set(s.faces)
  for (const f of s.faces) for (const p of cage.faces[f] ?? []) for (const g of byCorner[p]) faces.add(g)
  const nbrs = neighboursOf(cage)
  const points = new Set(s.points)
  for (const p of s.points) for (const q of nbrs[p] ?? []) points.add(q)
  const atPoint = edgesAtPoint(cage)
  const edges = new Set(s.edges)
  for (const e of s.edges) for (const p of parseEdgeKey(e)) for (const k of atPoint.get(p) ?? []) edges.add(k)
  return { points: [...points].sort((a, b) => a - b), edges: [...edges], faces: [...faces].sort((a, b) => a - b) }
}

/** One ring narrower: whatever touches the unselected rest (a shared corner, a neighbour, a shared end) leaves. */
export function shrinkSelection(cage: Cage, s: Selection): Selection {
  const byCorner = cornerFaces(cage)
  const faceSet = new Set(s.faces)
  const faces = s.faces.filter((f) => (cage.faces[f] ?? []).every((p) => byCorner[p].every((g) => faceSet.has(g))))
  const nbrs = neighboursOf(cage)
  const pointSet = new Set(s.points)
  const points = s.points.filter((p) => (nbrs[p] ?? []).every((q) => pointSet.has(q)))
  const atPoint = edgesAtPoint(cage)
  const edgeSet = new Set(s.edges)
  const edges = s.edges.filter((e) => parseEdgeKey(e).every((p) => (atPoint.get(p) ?? []).every((k) => edgeSet.has(k))))
  return { points, edges, faces }
}

/** Every element of the kind selected (every face when nothing, or several kinds, are selected). */
export function selectAll(cage: Cage, s: Selection): Selection {
  const onlyPoints = s.points.length > 0 && s.edges.length === 0 && s.faces.length === 0
  const onlyEdges = s.edges.length > 0 && s.points.length === 0 && s.faces.length === 0
  if (onlyPoints) return { points: cage.positions.map((_, i) => i), edges: [], faces: [] }
  if (onlyEdges) return { points: [], edges: [...new Set([...edgesAtPoint(cage).values()].flat())], faces: [] }
  return { points: [], edges: [], faces: cage.faces.map((_, f) => f) }
}
