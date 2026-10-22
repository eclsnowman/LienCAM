// WO-3034 (alpha.3 A3-21): re-hosted copy of src/lib/cam/toolpathArcSampling.ts for the kernel estimators
// (draft WO-A3-21: today's time model is re-hosted as copies; the current engine's
// file is not touched). Kept verbatim below this header so post-plan time equals
// the store's estimatedCutTimeMs; estimators.wo3034.test.ts pins that parity.
import type { ToolpathMove } from '../../../types'

type XY = { x: number; y: number }

export interface ArcSamplingOptions {
  /** Maximum XY chord length for sampled arc display/simulation segments, in mm. */
  maxChordMm?: number
  /** Maximum angular span for each sampled segment, in degrees. */
  maxAngleDeg?: number
  /** Safety cap so a malformed giant arc cannot explode frame counts. */
  maxSegmentsPerArc?: number
}

const EPS = 1e-9
const DEFAULT_MAX_CHORD_MM = 0.35
const DEFAULT_MAX_ANGLE_DEG = 7.5
const DEFAULT_MAX_SEGMENTS_PER_ARC = 720

function isArcMove(move: ToolpathMove): boolean {
  return move.type === 'arc_cw' || move.type === 'arc_ccw'
}

function normalizeSweep(raw: number): number {
  let sweep = raw
  while (sweep < 0) sweep += Math.PI * 2
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2
  return sweep
}

function arcSweepRadians(start: XY, end: XY, center: XY, ccw: boolean): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  let sweep = normalizeSweep(ccw ? a1 - a0 : a0 - a1)

  // In this move model, an arc endpoint equal to the start point and a valid
  // center normally means a full circle, not a zero-length linear segment.
  if (sweep < EPS) {
    const endpointGap = Math.hypot(end.x - start.x, end.y - start.y)
    if (endpointGap < 1e-6) sweep = Math.PI * 2
  }
  return sweep
}

function segmentCountForArc(
  radius: number,
  sweep: number,
  opts: Required<ArcSamplingOptions>,
): number {
  if (!(radius > EPS) || !(sweep > EPS)) return 1
  const maxAngle = Math.max(0.25, opts.maxAngleDeg) * Math.PI / 180
  const byAngle = Math.ceil(sweep / maxAngle)
  const byChord = Math.ceil((radius * sweep) / Math.max(0.01, opts.maxChordMm))
  return Math.max(1, Math.min(opts.maxSegmentsPerArc, Math.max(byAngle, byChord)))
}

function resolvedOptions(options: ArcSamplingOptions = {}): Required<ArcSamplingOptions> {
  return {
    maxChordMm: options.maxChordMm ?? DEFAULT_MAX_CHORD_MM,
    maxAngleDeg: options.maxAngleDeg ?? DEFAULT_MAX_ANGLE_DEG,
    maxSegmentsPerArc: options.maxSegmentsPerArc ?? DEFAULT_MAX_SEGMENTS_PER_ARC,
  }
}

/**
 * Linearize G2/G3-style ToolpathMove arcs for consumers that only understand
 * point-to-point segments, such as the WebGL toolpath overlay and stock
 * simulation sweep engines.
 *
 * This deliberately does not replace the operation's stored moves. Posting and
 * runtime estimation still consume the original arc moves so controller output
 * remains compact and accurate. The sampled stream is only for rendering,
 * playback, and material-removal preview.
 */
export function sampleArcMovesForLinearConsumers(
  moves: readonly ToolpathMove[],
  options: ArcSamplingOptions = {},
  // PP-MOVE-PICK: optional out-array. When provided, it is filled with ONE entry
  // per OUTPUT move = the index into the ORIGINAL `moves` array that produced it.
  // An arc that expands into K linear points writes its own source index K times,
  // so a consumer that raycasts a sampled segment can recover which original move
  // owns it (viewport move-pick attribution). Omitted callers are byte-identical.
  originIndices?: number[],
): ToolpathMove[] {
  if (originIndices) originIndices.length = 0
  if (moves.length < 2) {
    const out = moves.slice()
    if (originIndices) for (let i = 0; i < out.length; i++) originIndices.push(i)
    return out
  }

  const opts = resolvedOptions(options)
  const out: ToolpathMove[] = [moves[0]]
  if (originIndices) originIndices.push(0)

  for (let i = 1; i < moves.length; i++) {
    const move = moves[i]
    const prev = out[out.length - 1]
    if (
      isArcMove(move) &&
      Number.isFinite(move.cx) &&
      Number.isFinite(move.cy) &&
      Number.isFinite(prev.x) &&
      Number.isFinite(prev.y) &&
      Number.isFinite(prev.z) &&
      Number.isFinite(move.x) &&
      Number.isFinite(move.y) &&
      Number.isFinite(move.z)
    ) {
      const center = { x: move.cx as number, y: move.cy as number }
      const r0 = Math.hypot(prev.x - center.x, prev.y - center.y)
      const r1 = Math.hypot(move.x - center.x, move.y - center.y)
      if (r0 > EPS && r1 > EPS) {
        const ccw = move.type === 'arc_ccw'
        const sweep = arcSweepRadians(prev, move, center, ccw)
        const segments = segmentCountForArc((r0 + r1) / 2, sweep, opts)
        const a0 = Math.atan2(prev.y - center.y, prev.x - center.x)
        const sign = ccw ? 1 : -1

        for (let s = 1; s <= segments; s++) {
          const t = s / segments
          if (s === segments) {
            out.push({ ...move, type: 'feed' })
          } else {
            const angle = a0 + sign * sweep * t
            const radius = r0 + (r1 - r0) * t
            out.push({
              type: 'feed',
              x: center.x + radius * Math.cos(angle),
              y: center.y + radius * Math.sin(angle),
              z: prev.z + (move.z - prev.z) * t,
              feed: move.feed,
              role: move.role,
              engagement: move.engagement,
            })
          }
          if (originIndices) originIndices.push(i)
        }
        continue
      }
    }

    out.push(move)
    if (originIndices) originIndices.push(i)
  }

  return out
}
