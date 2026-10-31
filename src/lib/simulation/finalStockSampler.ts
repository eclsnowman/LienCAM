// WO-3096: the final stock as the stored toolpaths leave it, sampled at points.
// The shared stock authority is an upper envelope with no vertical bound, so a
// comparison against it can only ever say "possible excess" or "unknown" - the
// panel showed no colours at all. A point sample is exact where it is taken:
// the stock top at (x, y) is the stock block's top lowered by every cutting
// move whose cutter covers (x, y). Within tolerance, excess and gouge are then
// real classes at each sample, like a CAM simulator's comparison colouring.
import type { FrameRef } from '../geometry/coordinateFrames'
import { effectiveMoveRole, isStockCuttingRole } from '../cam/stockCuttingRoles'
import type { ToolpathMove, Vec3 } from '../../types'
import type { ComparisonSurface } from './deviationComparison'

/** One enabled operation's stored moves and the cutter that cuts them (world mm, Z up). */
export interface SampledOperation {
  readonly moves: readonly ToolpathMove[]
  readonly cutter: { readonly kind: 'flat' | 'ball'; readonly diameter: number }
  /** How far the cutter's flat sits above the moves' tip Z (drill points). */
  readonly liftMm: number
}
export interface StockBlock { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
export interface FinalStockSampleOptions {
  readonly frame: FrameRef<'world'>
  readonly bounds: StockBlock
  /** Requested sample spacing; widened only to stay inside maxSamples. */
  readonly cellMm: number
  readonly maxSamples?: number
  readonly signal?: AbortSignal
  /** Fraction of moves carved, 0..1. */
  onProgress?(fraction: number): void
}

/** Largest distance a chord strays from its arc. It is also the stated vertical
 * error of every sample: a chord cuts at most this much less than the arc. */
export const SAMPLE_ARC_SAGITTA_MM = 0.005
const MAX_CHORDS_PER_ARC = 4096
const YIELD_EVERY_MOVES = 2000

/** Sample spacing for a block: the request, widened until nx*ny fits. */
export function sampleSpacing(bounds: StockBlock, cellMm: number, maxSamples = 65_536): number {
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY
  let cell = Math.max(cellMm, Math.sqrt(w * h / maxSamples))
  while (Math.ceil(w / cell) * Math.ceil(h / cell) > maxSamples) cell *= 1.01
  return cell
}

/** Stock top at every sample point after all operations, in order. Samples sit
 * where compareDeviation reads the intended surface: each cell's centre. */
export async function sampleFinalStock(operations: readonly SampledOperation[], options: FinalStockSampleOptions): Promise<ComparisonSurface> {
  const { bounds, signal } = options
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY
  if (!(w > 0) || !(h > 0) || !(bounds.maxZ > bounds.minZ)) throw new Error('Invalid stock surface.')
  if (!(options.cellMm > 0) || !Number.isFinite(options.cellMm)) throw new Error('Invalid comparison resolution or tolerance.')
  const cell = sampleSpacing(bounds, options.cellMm, options.maxSamples)
  const nx = Math.ceil(w / cell), ny = Math.ceil(h / cell)
  const xs = new Float64Array(nx), ys = new Float64Array(ny)
  for (let i = 0; i < nx; i++) { const x = bounds.minX + i * cell; xs[i] = x + Math.min(cell, bounds.maxX - x) / 2 }
  for (let j = 0; j < ny; j++) { const y = bounds.minY + j * cell; ys[j] = y + Math.min(cell, bounds.maxY - y) / 2 }
  const top = new Float64Array(nx * ny).fill(bounds.maxZ)
  const total = operations.reduce((sum, op) => sum + op.moves.length, 0)
  let done = 0

  const carve = (a: Vec3, b: Vec3, op: SampledOperation) => {
    const r = op.cutter.diameter / 2, ball = op.cutter.kind === 'ball'
    const i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x) - r - bounds.minX) / cell - 0.5))
    const i1 = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x) + r - bounds.minX) / cell - 0.5) + 1)
    const j0 = Math.max(0, Math.ceil((Math.min(a.y, b.y) - r - bounds.minY) / cell - 0.5))
    const j1 = Math.min(ny - 1, Math.floor((Math.max(a.y, b.y) + r - bounds.minY) / cell - 0.5) + 1)
    if (i0 > i1 || j0 > j1 || Math.min(a.z, b.z) + op.liftMm >= bounds.maxZ) return
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l2 = dx * dx + dy * dy, r2 = r * r
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const wx = xs[i] - a.x, wy = ys[j] - a.y
      const ww = wx * wx + wy * wy
      let t0 = 0, t1 = 1
      if (l2 > 1e-18) {
        const wd = wx * dx + wy * dy
        const disc = wd * wd - l2 * (ww - r2)
        if (disc < 0) continue
        const s = Math.sqrt(disc)
        t0 = Math.max(0, (wd - s) / l2); t1 = Math.min(1, (wd + s) / l2)
        if (t0 > t1) continue
      } else if (ww > r2) continue
      let z: number
      if (!ball) {
        z = Math.min(a.z + t0 * dz, a.z + t1 * dz)
      } else {
        // Ball bottom over the point: tip z + r - sqrt(r^2 - d^2). Tip z is
        // linear and the lift term convex in t, so the minimum is found by
        // ternary search on the covering interval.
        const f = (t: number) => {
          const ex = wx - t * dx, ey = wy - t * dy
          return a.z + t * dz + r - Math.sqrt(Math.max(0, r2 - ex * ex - ey * ey))
        }
        if (Math.abs(dz) < 1e-12 && l2 > 1e-18) {
          z = f(Math.min(t1, Math.max(t0, (wx * dx + wy * dy) / l2)))
        } else {
          let lo = t0, hi = t1
          for (let k = 0; k < 40 && hi - lo > 1e-6; k++) {
            const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3
            if (f(m1) <= f(m2)) hi = m2; else lo = m1
          }
          z = Math.min(f((lo + hi) / 2), f(t0), f(t1))
        }
      }
      z += op.liftMm
      const k = j * nx + i
      if (z < top[k]) top[k] = z
    }
  }

  for (const op of operations) {
    let tip: Vec3 | undefined
    for (const move of op.moves) {
      if (++done % YIELD_EVERY_MOVES === 0) {
        signal?.throwIfAborted()
        options.onProgress?.(done / Math.max(1, total))
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (move.a !== undefined || move.b !== undefined || move.c !== undefined) throw new Error('Material removal of a rotary endpoint is not supported.')
      if (tip && isStockCuttingRole(effectiveMoveRole(move))) {
        if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
          const points = arcPoints(tip, move)
          for (let k = 1; k < points.length; k++) carve(points[k - 1], points[k], op)
        } else carve(tip, move, op)
      }
      tip = { x: move.x, y: move.y, z: move.z }
    }
  }
  signal?.throwIfAborted()
  options.onProgress?.(1)
  // Cut through the block: nothing is left above its bottom there.
  const topZ = Array.from(top, z => Math.max(bounds.minZ, z))
  return Object.freeze({
    frame: options.frame,
    bounds: Object.freeze({ ...bounds }),
    cellMm: cell, nx, ny, topZ: Object.freeze(topZ),
    quality: Object.freeze({ capability: 'point-sample-v1' as const, cellMm: cell,
      roundingAllowanceMm: 0, maxVerticalOverRetentionMm: SAMPLE_ARC_SAGITTA_MM, warnings: Object.freeze([]) }),
  })
}

/** Points along an arc/helix, chords within SAMPLE_ARC_SAGITTA_MM. An arc with
 * no centre is cut as its chord. */
function arcPoints(start: Vec3, move: ToolpathMove): Vec3[] {
  const end = { x: move.x, y: move.y, z: move.z }
  const { cx, cy } = move
  if (cx === undefined || cy === undefined || !Number.isFinite(cx) || !Number.isFinite(cy)) return [start, end]
  const r0 = Math.hypot(start.x - cx, start.y - cy), r1 = Math.hypot(end.x - cx, end.y - cy)
  if (!(r0 > 0) || !(r1 > 0)) return [start, end]
  const a0 = Math.atan2(start.y - cy, start.x - cx)
  let span = Math.atan2(end.y - cy, end.x - cx) - a0
  if (move.type === 'arc_ccw') { while (span <= 0) span += 2 * Math.PI } else { while (span >= 0) span -= 2 * Math.PI }
  const rMax = Math.max(r0, r1)
  const halfStep = SAMPLE_ARC_SAGITTA_MM < rMax ? Math.acos(1 - SAMPLE_ARC_SAGITTA_MM / rMax) : Math.PI / 2
  const count = Math.min(MAX_CHORDS_PER_ARC, Math.max(1, Math.ceil(Math.abs(span) / (2 * halfStep))))
  const points: Vec3[] = [start]
  for (let k = 1; k < count; k++) {
    const t = k / count, angle = a0 + span * t, r = r0 + (r1 - r0) * t
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), z: start.z + (end.z - start.z) * t })
  }
  points.push(end)
  return points
}
