// Form - insert edge loop, crease / uncrease.
//
// Insert edge loop: from a picked edge, walk the EDGE RING - through each quad
// to the opposite edge, into the next quad - both ways, until the ring closes
// or meets an open edge or a face that is not a quad. Every ring edge gets a
// new point (at `t` along it) and every ring quad is split in two, so a new
// loop of edges runs across the ring. `t` is measured from one side of the
// ring: from the start edge's `from` point, carried through each quad along
// its sides, so a loop off the middle stays on one side all the way round. A face the ring stops at (an n-gon)
// just gains the new point on its edge. Orientation and creases are kept: a
// creased ring edge stays creased on both halves.

import type { Cage, Vec3 } from './cage'
import { cloneCage, edgeKey, parseEdgeKey, remapWeights } from './cage'

export interface EdgeLoopResult {
  cage: Cage
  /** the new loop's edges (edge keys), for selecting it */
  loopEdges: string[]
  /** the new points, one per ring edge */
  newPoints: number[]
}

export interface RingStep { face: number; entry: string; exit: string | null }

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

/** The edge of quad `face` opposite `key`, or null when the face is not a quad. */
function oppositeEdge(cage: Cage, face: number, key: string): string | null {
  const loop = cage.faces[face]
  if (loop.length !== 4) return null
  for (let i = 0; i < 4; i++) {
    if (edgeKey(loop[i], loop[(i + 1) % 4]) === key) return edgeKey(loop[(i + 2) % 4], loop[(i + 3) % 4])
  }
  return null
}

/** The ordered ring of (face, entry edge, exit edge) through `start`, and whether it closed. */
export function edgeRing(cage: Cage, start: string): { edges: string[]; steps: RingStep[]; closed: boolean } {
  const byEdge = facesOfEdges(cage)
  const walk = (firstFace: number): { edges: string[]; steps: RingStep[]; closed: boolean } => {
    const edges: string[] = []
    const steps: RingStep[] = []
    let key = start
    let face = firstFace
    const seen = new Set<number>()
    for (;;) {
      if (seen.has(face)) return { edges, steps, closed: true }
      seen.add(face)
      const exit = oppositeEdge(cage, face, key)
      steps.push({ face, entry: key, exit })
      if (exit === null) return { edges, steps, closed: false }
      if (exit === start) return { edges, steps, closed: true }
      edges.push(exit)
      const next = (byEdge.get(exit) ?? []).find((f) => f !== face)
      if (next === undefined) return { edges, steps, closed: false }
      key = exit
      face = next
    }
  }
  const faces = byEdge.get(start) ?? []
  if (faces.length === 0) return { edges: [], steps: [], closed: false }
  const forward = walk(faces[0])
  if (forward.closed || faces.length < 2) return { edges: [start, ...forward.edges], steps: forward.steps, closed: forward.closed }
  const backward = walk(faces[1])
  return { edges: [...backward.edges.reverse(), start, ...forward.edges], steps: [...backward.steps, ...forward.steps], closed: false }
}

/**
 * For every ring edge, the end on the same side of the ring as `from` (an end
 * of `start`): across each quad, entry p-q and exit s-r, p pairs with s and q
 * with r (the quad's sides).
 */
export function ringSides(cage: Cage, start: string, steps: readonly RingStep[], from: number): Map<string, number> {
  const link = new Map<string, Array<[string, number, number]>>()
  const add = (k: string, via: [string, number, number]) => { const l = link.get(k); if (l) l.push(via); else link.set(k, [via]) }
  for (const step of steps) {
    if (step.exit === null) continue
    const loop = cage.faces[step.face]
    let i = 0
    while (edgeKey(loop[i], loop[(i + 1) % 4]) !== step.entry) i++
    const [p, q, r, s] = [loop[i], loop[(i + 1) % 4], loop[(i + 2) % 4], loop[(i + 3) % 4]]
    // entry end -> exit end on the same side, both ways
    add(step.entry, [step.exit, p, s]); add(step.entry, [step.exit, q, r])
    add(step.exit, [step.entry, s, p]); add(step.exit, [step.entry, r, q])
  }
  const side = new Map<string, number>([[start, from]])
  const queue = [start]
  while (queue.length > 0) {
    const k = queue.shift()!
    const end = side.get(k)!
    for (const [other, mine, theirs] of link.get(k) ?? []) if (mine === end && !side.has(other)) { side.set(other, theirs); queue.push(other) }
  }
  return side
}

export function insertEdgeLoop(cage: Cage, start: string, t = 0.5, from?: number): EdgeLoopResult | null {
  const ring = edgeRing(cage, start)
  if (ring.steps.length === 0) return null
  const next = cloneCage(cage)
  const [s0, s1] = parseEdgeKey(start)
  const side = ringSides(cage, start, ring.steps, from === s1 ? s1 : s0)
  // one new point per ring edge, at t from its end on the start's side
  const pointOn = new Map<string, number>()
  const newPoints: number[] = []
  for (const key of ring.edges) {
    const [e0, e1] = parseEdgeKey(key)
    const a = side.get(key) ?? e0
    const b = a === e0 ? e1 : e0
    const pa = cage.positions[a], pb = cage.positions[b]
    const p: Vec3 = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]
    pointOn.set(key, next.positions.length)
    newPoints.push(next.positions.length)
    next.positions.push(p)
  }
  const replaced = new Set<number>()
  const loopEdges: string[] = []
  const added: number[][] = []
  for (const step of ring.steps) {
    const loop = cage.faces[step.face]
    if (step.exit !== null && loop.length === 4) {
      // rotate the quad so its entry edge is loop[0] -> loop[1]
      let i = 0
      while (edgeKey(loop[i], loop[(i + 1) % 4]) !== step.entry) i++
      const [p, q, r, s] = [loop[i], loop[(i + 1) % 4], loop[(i + 2) % 4], loop[(i + 3) % 4]]
      const m1 = pointOn.get(step.entry)!
      const m2 = pointOn.get(step.exit)!
      next.faces[step.face] = [p, m1, m2, s]
      added.push([m1, q, r, m2])
      replaced.add(step.face)
      loopEdges.push(edgeKey(m1, m2))
    }
  }
  // any other face that uses a ring edge (an n-gon the ring stopped at, or the
  // far side of an open end) gains the new point on that edge
  next.faces = next.faces.map((loop, f) => {
    if (replaced.has(f)) return loop
    const out: number[] = []
    for (let i = 0; i < loop.length; i++) {
      out.push(loop[i])
      const m = pointOn.get(edgeKey(loop[i], loop[(i + 1) % loop.length]))
      if (m !== undefined) out.push(m)
    }
    return out
  })
  next.faces.push(...added)
  // creases: a creased ring edge is creased on both halves
  const creases = new Set(next.creases)
  for (const key of ring.edges) {
    if (!creases.has(key)) continue
    const [a, b] = parseEdgeKey(key)
    const m = pointOn.get(key)!
    creases.delete(key)
    creases.add(edgeKey(a, m))
    creases.add(edgeKey(m, b))
  }
  next.creases = [...creases]
  // a weighted ring edge keeps its weight on both halves
  const weights = remapWeights(cage.weights, (key) => {
    const m = pointOn.get(key)
    if (m === undefined) return key
    const [a, b] = parseEdgeKey(key)
    return [edgeKey(a, m), edgeKey(m, b)]
  })
  if (weights !== undefined) next.weights = weights
  else delete next.weights
  return { cage: next, loopEdges, newPoints }
}

/**
 * Crease (or uncrease) the given edges; edges not in the cage are ignored.
 * `weight` (creasing only): 0 or Infinity = fully sharp; a finite weight > 0
 * makes the edge semi-sharp (sharp for that many subdivision steps). Uncrease
 * clears both.
 */
export function setCreased(cage: Cage, edges: readonly string[], creased: boolean, weight = 0): Cage {
  const valid = new Set<string>()
  for (const loop of cage.faces) for (let i = 0; i < loop.length; i++) valid.add(edgeKey(loop[i], loop[(i + 1) % loop.length]))
  const set = new Set(cage.creases)
  const weights: Record<string, number> = { ...(cage.weights ?? {}) }
  const semi = creased && weight > 0 && Number.isFinite(weight)
  for (const key of edges) {
    if (!valid.has(key)) continue
    set.delete(key)
    delete weights[key]
    if (!creased) continue
    if (semi) weights[key] = weight
    else set.add(key)
  }
  const out: Cage = { ...cloneCage(cage), creases: [...set] }
  if (Object.keys(weights).length > 0) out.weights = weights
  else delete out.weights
  return out
}

/** The edges a crease command acts on: the selected edges, plus every edge of the selected faces. */
export function creaseTargets(cage: Cage, selection: { edges: readonly string[]; faces: readonly number[] }): string[] {
  const out = new Set(selection.edges)
  for (const f of selection.faces) {
    const loop = cage.faces[f]
    if (!loop) continue
    for (let i = 0; i < loop.length; i++) out.add(edgeKey(loop[i], loop[(i + 1) % loop.length]))
  }
  return [...out]
}
