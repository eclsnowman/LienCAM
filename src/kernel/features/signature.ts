// WO-3002 (A3-09 step 2): canonical, order-independent geometric signatures.
// Pure data in, string out: no kernel handle, no randomness, no input index.

export type P3 = readonly [number, number, number]

/** Same quanta as today's 2D loop ids (src/lib/geometry/loopId.ts): below CAD
 *  export noise, above float noise. Directions get their own quantum. */
export const COORD_QUANTUM_MM = 0.01
export const AREA_QUANTUM_MM2 = 0.01
export const DIRECTION_QUANTUM = 1e-3

export function quantize(value: number, quantum: number): number {
  if (!Number.isFinite(value)) throw new RangeError('Geometry identity needs finite values')
  const q = Math.round(value / quantum)
  return q === 0 ? 0 : q
}
export const qPoint = (p: P3, quantum = COORD_QUANTUM_MM) => p.map(v => quantize(v, quantum)).join(',')

export const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export function unit(a: P3): P3 {
  const length = Math.hypot(a[0], a[1], a[2])
  if (!(length > 1e-12) || !Number.isFinite(length)) throw new RangeError('Geometry identity needs a non-degenerate direction')
  return [a[0] / length, a[1] / length, a[2] / length]
}

/** A line's direction has no sign of its own: the first component that is not
 *  zero at the direction quantum is made positive. Input order and which end a
 *  recogniser seeded from therefore cannot flip it. */
export function canonicalAxis(direction: P3): P3 {
  const d = unit(direction)
  const lead = d.find(v => quantize(v, DIRECTION_QUANTUM) !== 0) ?? 0
  return lead < 0 ? scale(d, -1) : d
}

/** The point of an infinite line closest to the frame origin: the same for
 *  every point a recogniser happened to report on that line. */
export const axisFoot = (point: P3, axis: P3): P3 => sub(point, scale(axis, dot(point, axis)))

/** Two points with no order of their own, ordered by their quantized text. */
export function unorderedPair(a: P3, b: P3): [P3, P3] {
  return qPoint(a) <= qPoint(b) ? [a, b] : [b, a]
}

/** A closed outline's points with no start or winding of their own: the ring
 *  starts at its smallest point (by quantized text) and runs towards the
 *  smaller of that point's two neighbours. Two points are an unordered pair. */
export function canonicalRing(points: readonly P3[]): P3[] {
  if (points.length < 3) return points.length === 2 ? unorderedPair(points[0], points[1]) : points.slice()
  const text = points.map(p => qPoint(p))
  let start = 0
  for (let i = 1; i < points.length; i++) if (text[i] < text[start]) start = i
  const n = points.length
  const forward = text[(start + 1) % n] <= text[(start - 1 + n) % n]
  return points.map((_, k) => points[forward ? (start + k) % n : (start - k + n) % n])
}

/** FNV-1a 32-bit with two offset bases, base36: 64 bits of content hash. The
 *  collision rule below never relies on it being collision-free. */
function fnv1a(input: string, basis: number): string {
  let hash = basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}
export const contentHash = (signature: string) => fnv1a(signature, 0x811c9dc5) + fnv1a(signature, 0x050c5d1f)

/** Full-precision tie-break text: the exact numbers, not their buckets. */
export const exactText = (values: readonly number[]) => values.map(v => (Object.is(v, -0) ? 0 : v).toString()).join(',')

export interface Signed<T> { readonly item: T; readonly signature: string; readonly exact: string }

/**
 * Stamp `${prefix}:${hash}` ids. COLLISION RULE (order-independent): entities
 * whose ids would collide (same hash, whatever their signatures) are ordered
 * by signature, then by exact geometry text, and numbered `#1, #2, ...` in that
 * order; the first keeps the bare id. Two entities that tie on both are the
 * same geometry, so which of them takes which number cannot be observed from
 * geometry. Output order is by id, never by input order.
 */
export function assignIds<T>(prefix: string, signed: readonly Signed<T>[]): Array<{ id: string; signature: string; item: T }> {
  const groups = new Map<string, Signed<T>[]>()
  for (const entry of signed) {
    const base = `${prefix}:${contentHash(entry.signature)}`
    const group = groups.get(base)
    if (group) group.push(entry)
    else groups.set(base, [entry])
  }
  const out: Array<{ id: string; signature: string; item: T }> = []
  for (const [base, group] of groups) {
    group.sort((a, b) => compareText(a.signature, b.signature) || compareText(a.exact, b.exact))
    group.forEach((entry, index) => out.push({ id: index === 0 ? base : `${base}#${index}`, signature: entry.signature, item: entry.item }))
  }
  return out.sort((a, b) => compareText(a.id, b.id))
}

export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
