// Form (SubD organic modeling) - the control cage.
//
// A cage is plain data so it can be snapshotted for undo, stored on the
// finished geometry row (so Finish Form stays re-editable) and compared in
// tests without any class machinery:
//   - positions: one [x, y, z] per cage point (millimetres, Z up)
//   - faces: each face is a loop of point indices, counter-clockwise seen from
//     outside (quads mostly, triangles and n-gons allowed)
//   - creases: undirected edges flagged sharp, stored as "lo:hi" keys
//   - weights (optional): semi-sharp edges, "lo:hi" -> sharpness s > 0 (the
//     edge is sharp for the first s subdivision steps, then smooth; an edge in
//     `creases` is infinitely sharp and carries no weight)
//   - symmetryReference (optional): the points where they were before the
//     latest edits, on these same faces (WO-2955). Symmetry pairs points by
//     where they were there, so an edit made with symmetry off does not lose
//     a point its mirror partner. Absent: the points as they are now.
//
// Topology questions (who neighbours whom, is it manifold) are answered by
// the half-edge structure in halfEdge.ts, built from this data on demand.

export type Vec3 = [number, number, number]

export interface Cage {
  positions: Vec3[]
  faces: number[][]
  /** undirected sharp edges, each as edgeKey(a, b) */
  creases: string[]
  /** semi-sharp edges: edgeKey -> finite sharpness > 0 (absent: none) */
  weights?: Record<string, number>
  /** the earlier positions symmetry pairs by; only valid while `faces` is unchanged (symmetryReferenceOf) */
  symmetryReference?: SymmetryReference
}

export interface SymmetryReference {
  positions: Vec3[]
  /** the faces the reference was taken on: any other topology retires it */
  faces: number[][]
}

/** The one spelling of an undirected edge: smaller index first. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export function parseEdgeKey(key: string): [number, number] {
  const [a, b] = key.split(':').map(Number)
  return [a, b]
}

/** A deep copy (undo snapshots must never share arrays with the live cage). */
export function cloneCage(cage: Cage): Cage {
  return {
    positions: cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3),
    faces: cage.faces.map((f) => f.slice()),
    creases: cage.creases.slice(),
    ...(cage.weights !== undefined ? { weights: { ...cage.weights } } : {}),
    // a reference that no longer fits (other faces, malformed in a file) is not carried
    ...(symmetryReferenceOf(cage) !== null ? { symmetryReference: cloneReference(cage.symmetryReference!) } : {}),
  }
}

export function cloneReference(r: SymmetryReference): SymmetryReference {
  return { positions: r.positions.map((p) => [p[0], p[1], p[2]] as Vec3), faces: r.faces.map((f) => f.slice()) }
}

/** Two face lists that are the same loops in the same order. */
export function sameFaces(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): boolean {
  return a.length === b.length && a.every((f, i) => f.length === b[i].length && f.every((p, k) => p === b[i][k]))
}

/** The cage's symmetry reference when it still describes these points on these faces, else null. */
export function symmetryReferenceOf(cage: Cage): SymmetryReference | null {
  const r = cage.symmetryReference
  if (r === undefined || r === null || typeof r !== 'object' || !Array.isArray(r.positions) || !Array.isArray(r.faces)) return null
  if (r.positions.length !== cage.positions.length) return null
  if (!r.positions.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) return null
  if (!r.faces.every(Array.isArray) || !sameFaces(r.faces, cage.faces)) return null
  return r
}

/** A cage's weights with every key passed through `remap` (dropped where it returns null). */
export function remapWeights(weights: Record<string, number> | undefined, remap: (key: string) => string | string[] | null): Record<string, number> | undefined {
  if (weights === undefined) return undefined
  const out: Record<string, number> = {}
  for (const [key, s] of Object.entries(weights)) {
    const to = remap(key)
    if (to === null) continue
    for (const k of Array.isArray(to) ? to : [to]) out[k] = s
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Every undirected edge of the cage, in first-seen order. */
export function cageEdges(cage: Cage): Array<[number, number]> {
  const seen = new Set<string>()
  const out: Array<[number, number]> = []
  for (const face of cage.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i]
      const b = face[(i + 1) % face.length]
      const key = edgeKey(a, b)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(a < b ? [a, b] : [b, a])
    }
  }
  return out
}

/** Face uses of each undirected edge; exactly one use is an open border. */
export function cageEdgeFaceCounts(cage: Pick<Cage, 'faces'>): Map<string, number> {
  const uses = new Map<string, number>()
  for (const face of cage.faces) for (let i = 0; i < face.length; i++) {
    const key = edgeKey(face[i], face[(i + 1) % face.length])
    uses.set(key, (uses.get(key) ?? 0) + 1)
  }
  return uses
}

/** The axis-aligned bounds of the cage points. */
export function cageBounds(cage: Cage): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of cage.positions) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k]
      if (p[k] > max[k]) max[k] = p[k]
    }
  }
  return { min, max }
}
