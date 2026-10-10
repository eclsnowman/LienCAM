// Resolve a nest's source-part loops for the instanced renderer (P3.2).
//
// A NestRecord references source parts by geometryId (NO geometry duplication,
// ADR 0024). To RENDER each placement the viewport needs the source part's
// closed loops in the part-LOCAL 2D frame. This mirrors createNest's resolution
// convention (store/index.ts): outer = the largest-area closed loop, holes =
// the remaining closed loops. The renderer draws outer + holes the same way, so
// here we return ALL closed loops of each referenced source, keyed by partId.
//
// Kept as a pure function (no store, no viewport) so it is node-testable and
// shared by every restore/create path.

import type { ImportedGeometry, NestRecord } from '../../types'

/** One source part's renderable loops (part-LOCAL frame). */
export interface NestSourceLoops {
  points: Array<{ x: number; y: number }>
}

/** Resolve `nest.sources` -> Map(partId -> loops) from the project geometry.
 *  Only closed loops with >= 3 points are kept (open/degenerate loops are not
 *  renderable outlines). Missing sources are skipped (and reported by the
 *  caller); the map simply omits them. */
export function resolveNestSourceLoops(
  nest: NestRecord,
  geometry: ImportedGeometry[],
): Map<string, NestSourceLoops[]> {
  const out = new Map<string, NestSourceLoops[]>()
  for (const src of nest.sources) {
    const geo = geometry.find(g => g.id === src.geometryId)
    if (!geo) continue
    const closed = (geo.loops ?? []).filter(l => l.closed && l.points.length >= 3)
    if (closed.length === 0) continue
    // Sort by descending area so outer (largest) is first; the renderer colours
    // them uniformly per placement, so order is cosmetic, but it keeps the same
    // outer/holes convention createNest used to build the NestPart.
    const sorted = [...closed].sort((a, b) => b.area - a.area)
    out.set(
      src.geometryId,
      sorted.map(l => ({ points: l.points.map(p => ({ x: p.x, y: p.y })) })),
    )
  }
  return out
}
