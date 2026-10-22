// WO-3017 MD-50: the two candidate definitions of "removed", read back as the
// one question the air and link-safety consumers ask: how deep does a swept
// cutter run into the material still standing? Today's read is
// src/cam3d/stock/traverseClearance.ts maxTraverseIntrusion (centre rule, no
// pad, ramps judged at their lowest tip z); each consumer then adds its own
// compensation (policy.ts). Here each definition carries its own:
// - `centre` with one declared pad: a column counts when its centre lies within
//   radius + pad of the path, judged as if the cutter were pad wider. The pad
//   that covers everything a centre sample can miss is half a cell diagonal.
// - `whole-cell`: a column counts when any part of its cell lies under the
//   cutter, judged at the cell's closest point; fields swept whole-cell never
//   claim material the tool did not remove, so no pad is needed.
// Read-only and deterministic (j outer, i inner).
import type { LinearMove, RemovedDefinition, SweepShape } from './contracts'
import type { DexelField } from './dexel'
import { heightFn, idxRange, segDist2 } from './sweep'

/** The declared pad of the centre rule: half a cell diagonal. */
export function declaredPad(field: DexelField): number {
  return field.cell * Math.SQRT1_2
}

function pointRectDist2(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0
  return dx * dx + dy * dy
}

function segmentHitsRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  // Liang-Barsky clip of the segment against the rectangle.
  let t0 = 0, t1 = 1
  const dx = bx - ax, dy = by - ay
  const edges: [number, number][] = [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue }
    const r = q / p
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r }
    else { if (r < t0) return false; if (r < t1) t1 = r }
  }
  return true
}

/** Squared distance from a segment to an axis-aligned rectangle (0 when they meet). */
export function segRectDist2(ax: number, ay: number, bx: number, by: number,
  x0: number, y0: number, x1: number, y1: number): number {
  if (segmentHitsRect(ax, ay, bx, by, x0, y0, x1, y1)) return 0
  const abx = bx - ax, aby = by - ay, ab2 = abx * abx + aby * aby
  const inv = ab2 > 0 ? 1 / ab2 : 0
  const toSeg = (px: number, py: number) => ab2 > 0
    ? segDist2(px, py, ax, ay, abx, aby, inv) : (px - ax) ** 2 + (py - ay) ** 2
  return Math.min(pointRectDist2(ax, ay, x0, y0, x1, y1), pointRectDist2(bx, by, x0, y0, x1, y1),
    toSeg(x0, y0), toSeg(x1, y0), toSeg(x0, y1), toSeg(x1, y1))
}

export interface Intrusion {
  /** Deepest material rise into the swept cutter, mm; -Infinity when it met no material. */
  readonly intrusionMm: number
  readonly columnsTested: number
}

/**
 * Worst intrusion of the swept cutter into standing material along a linear
 * tip move, under one removed definition. Ramps and plunges are judged at the
 * lowest tip z (over-reports, never misses). `padMm` applies to `centre` only.
 */
export function moveIntrusion(field: DexelField, move: LinearMove, shape: SweepShape,
  removed: RemovedDefinition, padMm = 0): Intrusion {
  const height = heightFn(shape)
  const R = shape.radius
  const pad = removed === 'centre' ? padMm : 0
  const reach = R + pad
  const r2 = R * R
  const { nx, ny, cell, originX, originY, top, bottom } = field
  const tipZ = Math.min(move.z0, move.z1)
  const abx = move.x1 - move.x0, aby = move.y1 - move.y0, ab2 = abx * abx + aby * aby
  // whole-cell can meet a column whose centre is up to half a diagonal outside the reach.
  const grow = removed === 'whole-cell' ? cell * Math.SQRT1_2 : 0
  const [i0, i1] = idxRange(Math.min(move.x0, move.x1) - reach - grow, Math.max(move.x0, move.x1) + reach + grow, originX, cell, nx)
  const [j0, j1] = idxRange(Math.min(move.y0, move.y1) - reach - grow, Math.max(move.y0, move.y1) + reach + grow, originY, cell, ny)
  let worst = Number.NEGATIVE_INFINITY
  let tested = 0
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      let d2: number
      if (removed === 'centre') {
        // traverseClearance's arithmetic, so pad 0 reads exactly what today's read does.
        const wx = originX + (i + 0.5) * cell - move.x0, wy = originY + (j + 0.5) * cell - move.y0
        let dc2: number
        if (ab2 > 0) {
          let t = (wx * abx + wy * aby) / ab2
          t = t < 0 ? 0 : t > 1 ? 1 : t
          const ex = wx - t * abx, ey = wy - t * aby
          dc2 = ex * ex + ey * ey
        } else dc2 = wx * wx + wy * wy
        if (pad === 0) {
          if (dc2 > r2) continue
          d2 = dc2
        } else {
          if (dc2 > reach * reach) continue
          const d = Math.max(0, Math.sqrt(dc2) - pad)
          d2 = Math.min(d * d, r2)
        }
      } else {
        const x0 = originX + i * cell, y0 = originY + j * cell
        d2 = segRectDist2(move.x0, move.y0, move.x1, move.y1, x0, y0, x0 + cell, y0 + cell)
        if (d2 > r2) continue
      }
      tested++
      const c = j * nx + i
      if (top[c] === bottom[c]) continue
      const hit = top[c] - (tipZ + height(d2))
      if (hit > worst) worst = hit
    }
  }
  return { intrusionMm: worst, columnsTested: tested }
}
