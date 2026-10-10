// Stable, content-derived loop ids (B19c recurrence prevention).
//
// PROBLEM (proven): loop ids were crypto.randomUUID() minted fresh on every loop
// derivation. Re-deriving a geometry's loops in place orphaned an operation's
// stored params.loopIds -> the builder filtered to an empty selection (the B19c
// silent-0-moves bug, now fail-loud). See docs/planning/STABLE-LOOP-ID-PLAN.md.
//
// FIX: derive the id from the loop's GEOMETRY so the same loop yields the same id
// across re-derives. An id matches ONLY if the loop is geometrically the same; a
// genuinely changed loop gets a new id, orphans, and the existing fail-loud net
// fires (re-select) -- never a silent mis-bind. Fails SAFE by construction.
//
// Two layers:
//   A. computeLoopContentId(layerId, points) -- pure content hash of one loop.
//   B. assignStableLoopIds(loops, namespace?) -- stamps a whole set, namespaced
//      by the owning geometry id (layerId == layer NAME is NOT globally unique;
//      '__all__' ops flat-map loops across geometries, so ids must be unique
//      across all loaded 2D geometries -> the geoId namespace supplies that).

export interface Vec2Like {
  x: number
  y: number
}

// Quantization quanta (Q1, Operator-approved): below DXF arc-fit tolerance, above
// float noise. Sub-quantum geometric wobble -> identical id (idempotent across a
// tolerance-stable re-derive). A genuine change crosses a quantum -> new id.
const AREA_QUANTUM = 0.01 // mm^2
const COORD_QUANTUM = 0.01 // mm

// Quantize to a quantum, snapping -0 to 0 so the key is canonical.
function quantize(value: number, quantum: number): number {
  const q = Math.round(value / quantum)
  return q === 0 ? 0 : q
}

// SIGNED area (shoelace) and centroid of a polygon from its points. For a
// degenerate (near-zero-area) polygon the centroid falls back to the vertex
// average so coincident degenerate loops still get a stable, content-derived key.
function signedAreaAndCentroid(points: Vec2Like[]): { area: number; cx: number; cy: number } {
  const n = points.length
  if (n === 0) return { area: 0, cx: 0, cy: 0 }
  if (n < 3) {
    // A line/point has no enclosed area; key off the vertex average.
    let sx = 0
    let sy = 0
    for (const p of points) {
      sx += p.x
      sy += p.y
    }
    return { area: 0, cx: sx / n, cy: sy / n }
  }

  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const cross = a.x * b.y - b.x * a.y
    twiceArea += cross
    cx += (a.x + b.x) * cross
    cy += (a.y + b.y) * cross
  }

  const area = twiceArea / 2
  if (Math.abs(twiceArea) < 1e-9) {
    // Degenerate / self-cancelling: fall back to the vertex average centroid.
    let sx = 0
    let sy = 0
    for (const p of points) {
      sx += p.x
      sy += p.y
    }
    return { area: 0, cx: sx / n, cy: sy / n }
  }

  const f = 1 / (3 * twiceArea)
  return { area, cx: cx * f, cy: cy * f }
}

// FNV-1a (32-bit) over the UTF-16 code units of the key, emitted as base36. No
// randomness, no Date, no global counter -- a pure function of its input string.
function fnv1aBase36(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // hash *= 16777619, kept in 32-bit unsigned range without overflow.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Deterministic CONTENT id for a single loop. Same layerId + same geometry (to
 * within the quantum) -> identical id. No randomness.
 */
export function computeLoopContentId(layerId: string, points: Vec2Like[]): string {
  const { area, cx, cy } = signedAreaAndCentroid(points)
  const qArea = quantize(area, AREA_QUANTUM)
  const qCx = quantize(cx, COORD_QUANTUM)
  const qCy = quantize(cy, COORD_QUANTUM)
  const key = `${layerId}|${qArea}|${qCx}|${qCy}`
  return fnv1aBase36(key)
}

/**
 * Stamp a set of loops with stable content-derived ids. Returns NEW loop objects
 * (does not mutate the input); RECOMPUTES from points (idempotent -- the incoming
 * id is ignored). An optional `namespace` (the owning geometry id) is prefixed so
 * ids are unique across all loaded geometries even when layerId (== layer name)
 * collides.
 *
 * Collisions within the set (two loops producing the same id -- e.g. coincident
 * or overlapping degenerate loops) are DETERMINISTICALLY disambiguated by
 * appending `#1`, `#2`, ... in stable input order (ADR 0003: made deterministic,
 * never silently hidden).
 */
export function assignStableLoopIds<T extends { id: string; layerId: string; points: Vec2Like[] }>(
  loops: T[],
  namespace?: string,
): T[] {
  const prefix = namespace ? `${namespace}~` : ''
  const seen = new Map<string, number>()
  return loops.map(loop => {
    const content = computeLoopContentId(loop.layerId, loop.points)
    const base = `${prefix}${content}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const id = count === 0 ? base : `${base}#${count}`
    return { ...loop, id }
  })
}
