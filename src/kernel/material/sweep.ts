// WO-3017: subtract a linear tool-tip move from the kernel z-dexel field, for
// every sweep shape the one tool-shape source generates (flat, ball, bull-nose,
// V-bit cone, and the inscribed shape of anything else).
//
// The rasterisation is today's src/cam3d/stock/removeSweep.ts: the
// centre-conservative column range of the move's box grown by the radius; a
// closed-form envelope z + height(point-to-segment distance) for horizontal
// moves; one imprint at the lowest tip z for a vertical plunge; ramps stamped
// at nSteps = max(1, ceil(len / (cell / 2))) imprints (under-removes, never
// over-removes); per column top = max(bottom, envelope) applied only when lower,
// stored f32 and the stored delta charged. Flat and ball keep today's
// expressions verbatim, so their column heights are byte-equal to removeSweep.
//
// `removed` picks the MD-50 candidate. `centre` (today) lowers a column to the
// envelope at its centre. `whole-cell` lowers it only when the whole cell lies
// under the cutter, to the highest envelope over the cell: distance to a segment
// or a point is convex, so its maximum over a square sits on a corner.
//
// Deterministic: fixed loop order, no RNG; identical inputs give identical arrays.
import type { LinearMove, RemovedDefinition, SweepResult, SweepShape } from './contracts'
import type { DexelField } from './dexel'
import { sweepHeight } from './shape'

/** Height above the tip at squared distance d2 (d2 <= r2). Flat and ball are traverseClearance's expressions. */
export function heightFn(shape: SweepShape): (d2: number) => number {
  const R = shape.radius
  const r2 = R * R
  switch (shape.kind) {
    case 'flat': return () => 0
    case 'ball': return d2 => R - Math.sqrt(r2 - d2)
    default: return d2 => sweepHeight(shape, Math.sqrt(d2))
  }
}

/** Envelope z + height at squared distance d2 (d2 <= r2). Flat and ball are removeSweep's expressions. */
export function envelopeFn(shape: SweepShape): (z: number, d2: number) => number {
  const R = shape.radius
  const r2 = R * R
  switch (shape.kind) {
    case 'flat': return z => z
    case 'ball': return (z, d2) => z + R - Math.sqrt(r2 - d2)
    default: return (z, d2) => z + sweepHeight(shape, Math.sqrt(d2))
  }
}

function assertMoveFinite(move: LinearMove): void {
  for (const [label, v] of Object.entries(move)) {
    if (!Number.isFinite(v)) throw new Error(`sweepMove: move.${label} must be finite, got ${v}.`)
  }
}

/** Inclusive column-index range whose CENTERS can lie within [lo, hi] (today's idxRange). */
export function idxRange(lo: number, hi: number, origin: number, cell: number, n: number): [number, number] {
  const a = Math.max(0, Math.floor((lo - origin) / cell - 0.5))
  const b = Math.min(n - 1, Math.ceil((hi - origin) / cell - 0.5))
  return [a, b]
}

/** Squared distance from (px, py) to segment a + t * ab, t in [0, 1]. */
export function segDist2(px: number, py: number, ax: number, ay: number, abx: number, aby: number, invAb2: number): number {
  const wx = px - ax
  const wy = py - ay
  let t = (wx * abx + wy * aby) * invAb2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = wx - t * abx
  const ey = wy - t * aby
  return ex * ex + ey * ey
}

/**
 * Subtract the swept volume of `shape` moving linearly along `move` (tool tip)
 * from `field`, in place. Re-running the identical sweep is a no-op.
 */
export function sweepMove(field: DexelField, move: LinearMove, shape: SweepShape,
  removed: RemovedDefinition = 'centre'): SweepResult {
  assertMoveFinite(move)
  const acc: SweepResult = { removedVolumeMm3: 0, columnsChanged: 0 }
  const env = envelopeFn(shape)
  const dx = move.x1 - move.x0
  const dy = move.y1 - move.y0
  const dz = move.z1 - move.z0
  if (dx === 0 && dy === 0) {
    stamp(field, move.x0, move.y0, Math.min(move.z0, move.z1), shape.radius, env, removed, acc)
  } else if (dz === 0) {
    horizontal(field, move, shape.radius, env, removed, acc)
  } else {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const nSteps = Math.max(1, Math.ceil(len / (field.cell / 2)))
    for (let k = 0; k <= nSteps; k++) {
      const t = k / nSteps
      stamp(field, move.x0 + t * dx, move.y0 + t * dy, move.z0 + t * dz, shape.radius, env, removed, acc)
    }
  }
  acc.removedVolumeMm3 *= field.cell * field.cell
  return acc
}

/** Lower one column; each stamp or capsule sums locally and folds into the total after its loop (today's order). */
function lower(field: DexelField, c: number, envZ: number, acc: SweepResult): void {
  const bot = field.bottom[c]
  const nt = envZ < bot ? bot : envZ
  const cur = field.top[c]
  if (nt < cur) {
    field.top[c] = nt
    acc.removedVolumeMm3 += cur - field.top[c]
    acc.columnsChanged++
  }
}

function horizontal(field: DexelField, move: LinearMove, R: number, env: (z: number, d2: number) => number,
  removed: RemovedDefinition, acc: SweepResult): void {
  const { nx, ny, cell, originX, originY } = field
  const z = move.z0
  const ax = move.x0
  const ay = move.y0
  const abx = move.x1 - move.x0
  const aby = move.y1 - move.y0
  const invAb2 = 1 / (abx * abx + aby * aby)
  const r2 = R * R
  const [i0, i1] = idxRange(Math.min(move.x0, move.x1) - R, Math.max(move.x0, move.x1) + R, originX, cell, nx)
  const [j0, j1] = idxRange(Math.min(move.y0, move.y1) - R, Math.max(move.y0, move.y1) + R, originY, cell, ny)
  const local: SweepResult = { removedVolumeMm3: 0, columnsChanged: 0 }
  for (let j = j0; j <= j1; j++) {
    const cy = originY + (j + 0.5) * cell
    for (let i = i0; i <= i1; i++) {
      const cx = originX + (i + 0.5) * cell
      let d2: number
      if (removed === 'centre') {
        d2 = segDist2(cx, cy, ax, ay, abx, aby, invAb2)
      } else {
        const x0 = originX + i * cell, y0 = originY + j * cell
        d2 = Math.max(
          segDist2(x0, y0, ax, ay, abx, aby, invAb2), segDist2(x0 + cell, y0, ax, ay, abx, aby, invAb2),
          segDist2(x0, y0 + cell, ax, ay, abx, aby, invAb2), segDist2(x0 + cell, y0 + cell, ax, ay, abx, aby, invAb2))
      }
      if (d2 <= r2) lower(field, j * nx + i, env(z, d2), local)
    }
  }
  acc.removedVolumeMm3 += local.removedVolumeMm3
  acc.columnsChanged += local.columnsChanged
}

function stamp(field: DexelField, x: number, y: number, z: number, R: number, env: (z: number, d2: number) => number,
  removed: RemovedDefinition, acc: SweepResult): void {
  const { nx, ny, cell, originX, originY } = field
  const r2 = R * R
  const [i0, i1] = idxRange(x - R, x + R, originX, cell, nx)
  const [j0, j1] = idxRange(y - R, y + R, originY, cell, ny)
  const local: SweepResult = { removedVolumeMm3: 0, columnsChanged: 0 }
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      let d2: number
      if (removed === 'centre') {
        const ex = originX + (i + 0.5) * cell - x
        const ey = originY + (j + 0.5) * cell - y
        d2 = ex * ex + ey * ey
      } else {
        const ex = Math.max(Math.abs(originX + i * cell - x), Math.abs(originX + (i + 1) * cell - x))
        const ey = Math.max(Math.abs(originY + j * cell - y), Math.abs(originY + (j + 1) * cell - y))
        d2 = ex * ex + ey * ey
      }
      if (d2 <= r2) lower(field, j * nx + i, env(z, d2), local)
    }
  }
  acc.removedVolumeMm3 += local.removedVolumeMm3
  acc.columnsChanged += local.columnsChanged
}
