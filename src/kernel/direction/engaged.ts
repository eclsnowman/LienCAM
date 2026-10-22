import { engagedForMaterialSide, type MaterialSide, type MillingDirection, type SpindleRotation } from './rules'

export interface PassPoint { x: number; y: number }

export interface EngagedSideReading {
  /** Majority side of travel holding standing stock, or undefined when neither side does. */
  materialSide?: MaterialSide
  engaged: MillingDirection | 'unknown'
  /** Segments whose probes found stock on the left / right / both / neither. */
  counts: { left: number; right: number; both: number; neither: number }
}

/**
 * Engaged-side assertion helper (draft WO-A3-14 step 6), for tests: probe each
 * cutting segment's midpoint `probeMm` to its left and right, ask the material
 * query which side holds standing stock, and name the engaged side by majority.
 * It reads the geometry only, never the operation's label.
 */
export function readEngagedSide(
  points: readonly PassPoint[],
  standingStock: (x: number, y: number) => boolean,
  spindle: SpindleRotation,
  probeMm: number,
): EngagedSideReading {
  if (!(probeMm > 0)) throw new Error('readEngagedSide needs a positive probe distance.')
  const counts = { left: 0, right: 0, both: 0, neither: 0 }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length < 1e-9) continue
    // Left normal of travel in Y-up.
    const nx = -dy / length * probeMm, ny = dx / length * probeMm
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const left = standingStock(mx + nx, my + ny), right = standingStock(mx - nx, my - ny)
    if (left && right) counts.both++
    else if (left) counts.left++
    else if (right) counts.right++
    else counts.neither++
  }
  const materialSide: MaterialSide | undefined = counts.left > counts.right ? 'left'
    : counts.right > counts.left ? 'right' : undefined
  return { materialSide, engaged: materialSide ? engagedForMaterialSide(materialSide, spindle) : 'unknown', counts }
}
