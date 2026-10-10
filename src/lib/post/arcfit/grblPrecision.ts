import type { ToolpathMove, Vec2 } from '../../../types'
import { fmtNum, unitScale, type PostUnits } from '../format'
import { sweepAngle } from './circleFit'

/** Check the geometry GRBL reads, not the unrounded CAM circle. GRBL 1.1h
 * gcode.c rejects a radius mismatch >0.005 mm AND (>0.5 mm OR >0.1% radius).
 * Leave 0.001 mm headroom for its float arithmetic and decimal parser. */
export function grblArcNeedsLines(start: Vec2, end: Vec2, i: number, j: number, decimals: number, units: PostUnits): boolean {
  const scale = unitScale(units)
  const rounded = (v: number) => Number(fmtNum(v / scale, decimals)) * scale
  const dx = rounded(end.x) - rounded(start.x)
  const dy = rounded(end.y) - rounded(start.y)
  const ri = rounded(i)
  const rj = rounded(j)
  const radius = Math.hypot(ri, rj)
  // A vanishing offset is unusable. An open arc rounded to a closed endpoint
  // would become a whole revolution in GRBL, even if the radius check passes.
  if (radius === 0 || (dx === 0 && dy === 0 && Math.hypot(end.x - start.x, end.y - start.y) > 1e-9)) return true
  const mismatch = Math.abs(Math.hypot(dx - ri, dy - rj) - radius)
  return mismatch > 0.004 && (mismatch > 0.499 || mismatch > 0.001 * radius - 0.001)
}

/** Keep the native arc's winding, helix Z and exact endpoint. Half the existing
 * post tolerance bounds chord sagitta, reserving the other half for written
 * coordinate rounding. The emitter writes these directly, without re-fitting. */
export function arcAsLines(start: { x: number; y: number; z: number }, arc: ToolpathMove, tolerance: number): ToolpathMove[] {
  const cx = arc.cx!
  const cy = arc.cy!
  const radius = Math.hypot(start.x - cx, start.y - cy)
  const direction = arc.type === 'arc_cw' ? 'cw' : 'ccw'
  const closed = Math.hypot(arc.x - start.x, arc.y - start.y) <= 1e-9
  const sweep = closed ? 2 * Math.PI : sweepAngle(start, arc, cx, cy, direction)
  const maxStep = radius > 0 ? 2 * Math.acos(Math.max(-1, 1 - tolerance / (2 * radius))) : Math.PI
  const count = Math.max(1, Math.ceil(sweep / Math.min(Math.PI, maxStep)))
  const angle = Math.atan2(start.y - cy, start.x - cx)
  return Array.from({ length: count }, (_, k) => {
    const t = (k + 1) / count
    const theta = angle + (direction === 'cw' ? -1 : 1) * sweep * t
    return {
      ...arc, type: 'feed', cx: undefined, cy: undefined,
      x: k + 1 === count ? arc.x : cx + radius * Math.cos(theta),
      y: k + 1 === count ? arc.y : cy + radius * Math.sin(theta),
      z: k + 1 === count ? arc.z : start.z + (arc.z - start.z) * t,
      dwellMs: undefined,
    }
  })
}
