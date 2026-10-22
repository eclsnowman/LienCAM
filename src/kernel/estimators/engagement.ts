// WO-3034 (alpha.3 A3-21): radial engagement along the planned moves.
//
// Post-plan (draft step 5, REQ-EST-4): replay the moves through the kernel
// material sweep (WO-3017 part a, sweepMove) on a declared coarse cell and read
// each lateral cutting move's fresh volume over what a full-width slot with this
// cutter at that axial depth removes (1 = slot). The figure is the sustained
// window the stick's engagement collector reports (2 mm sliding window over
// contiguous cutting runs; slab depth = gap to the next cutting level above, or
// the stock top), so the two read the same quantity; only the cell differs, and
// the cell is reported with the value (engagementCellFor).
//
// Without a stock box there is nothing to replay: the estimate degrades to the
// programmed stepover / D, labelled "programmed, not measured" (draft table).
import type { ToolpathMove } from '../../types'
import { effectiveMoveRole } from '../../lib/cam/stockCuttingRoles'
import { DexelField, sweepHeight, sweepMove, type Box3, type SweepShape } from '../material'
import { available, degraded, unavailable, type EngagementValue, type Estimate } from './contracts'
import { forEachSegment } from './segments'

/** Roles that travel laterally at cutting depth (the stick's 'cut' / 'finish' / 'stepover'; wall_follow is a finish). */
const LATERAL_ROLES = new Set(['cut', 'finish', 'wall_follow', 'stepover'])
const WINDOW_MM = 2
/**
 * The replay cell. Today's engagement measure (cam3d/rough/pathEngagement.ts
 * replayCellFor, WO-1253) resolves the cutter in at least 8 columns but never
 * refines more than 3x below the stock's own cell; the estimate uses the same
 * rule. Decided on the A.5 capture (src/tests/evidence/WO-3034/stick-comparison.json):
 * a coarser cell is not worth it. D / 4 and D / 6 miss the 0.05 band on the
 * sustained peak (a narrow window, quantised to whole columns), while this rule
 * reads every A.5 row identically at about 0.2% of the row's plan time.
 */
export function engagementCellFor(diameter: number, stockCellMm?: number): number {
  const resolves = diameter / 8
  if (stockCellMm === undefined || !(stockCellMm > 0)) return resolves
  return Math.max(Math.min(stockCellMm, resolves), stockCellMm / 3)
}

/** Full-width slot cross-section (mm^2) at `depth` for this cutter: flat and ball closed form, any other shape integrated. */
export function slotCrossSectionMm2(shape: SweepShape, depth: number): number {
  const R = shape.radius
  if (shape.kind === 'flat') return 2 * R * depth
  if (shape.kind === 'ball') {
    if (depth >= R) return Math.PI * R * R / 2 + (depth - R) * 2 * R
    return R * R * Math.acos((R - depth) / R) - (R - depth) * Math.sqrt(2 * R * depth - depth * depth)
  }
  const steps = 400
  let area = 0
  for (let k = 0; k < steps; k++) {
    const r = (k + 0.5) / steps * R
    area += Math.max(0, depth - sweepHeight(shape, r))
  }
  return 2 * area * R / steps
}

export interface EngagementInput {
  readonly moves: readonly ToolpathMove[]
  readonly shape: SweepShape
  /** The uncut stock box the moves run on. Absent: degrade to the programmed stepover. */
  readonly stockBox?: Box3
  /** The stock state's own cell, mm (the replay cell follows it, engagementCellFor). */
  readonly stockCellMm?: number
  /** Replay cell, mm, overriding engagementCellFor. */
  readonly cellMm?: number
  /** Programmed stepover, mm, for the degraded answer. */
  readonly programmedStepoverMm?: number
}

export function estimateEngagement(input: EngagementInput): Estimate<EngagementValue> {
  const { shape, moves } = input
  const diameter = 2 * shape.radius
  if (!input.stockBox) {
    const stepover = input.programmedStepoverMm
    if (stepover === undefined || !(stepover > 0)) return unavailable('no stock state and no programmed stepover to fall back on')
    const fraction = stepover / diameter
    return degraded({ peakFraction: fraction, p95Fraction: fraction, cuttingLengthMm: 0, maxAxialDepthMm: 0, cellMm: 0 },
      'programmed, not measured: no stock state, so stepover / D')
  }
  const box = input.stockBox
  const cellMm = input.cellMm ?? engagementCellFor(diameter, input.stockCellMm)
  const field = DexelField.fromBox(box, cellMm)
  const measured = moves.map(m => LATERAL_ROLES.has(effectiveMoveRole(m)))
  // Slab depth per distinct cutting Z, from the moves themselves.
  const zs = [...new Set(moves.filter((_, i) => i > 0 && measured[i]).map(m => m.z))].sort((a, b) => b - a)
  const slab = new Map<number, number>()
  let above = box.maxZ
  for (const z of zs) { slab.set(z, Math.max(above - z, 0)); above = z }

  let peak = 0, cuttingLengthMm = 0, maxAxialDepthMm = 0
  const entries: { fraction: number; length: number }[] = []
  let runLength: number[] = [], runSlot: number[] = []
  const flush = () => {
    let j = 0, lengthSum = 0, slotSum = 0
    for (let i = 0; i < runLength.length; i++) {
      while (j < runLength.length && lengthSum < WINDOW_MM) { lengthSum += runLength[j]; slotSum += runSlot[j]; j++ }
      const fraction = slotSum / Math.max(lengthSum, WINDOW_MM)
      if (fraction > peak) peak = fraction
      entries.push({ fraction, length: runLength[i] })
      cuttingLengthMm += runLength[i]
      lengthSum -= runLength[i]; slotSum -= runSlot[i]
    }
    runLength = []; runSlot = []
  }
  let lastIndex = 0
  forEachSegment(moves, field.cell / 4, (segment, index) => {
    if (index !== lastIndex) { if (!measured[index]) flush(); lastIndex = index }
    const removed = sweepMove(field, segment, shape).removedVolumeMm3
    if (!measured[index]) return
    const depth = slab.get(moves[index].z) ?? 0
    const length = Math.hypot(segment.x1 - segment.x0, segment.y1 - segment.y0)
    if (depth > 0 && length > 1e-9) {
      runLength.push(length)
      runSlot.push(removed / slotCrossSectionMm2(shape, depth))
      if (depth > maxAxialDepthMm) maxAxialDepthMm = depth
    }
  })
  flush()
  if (!(cuttingLengthMm > 0)) return unavailable('the moves contain no lateral cutting at depth to measure')
  const sorted = [...entries].sort((a, b) => a.fraction - b.fraction)
  const target = 0.95 * cuttingLengthMm
  let cumulative = 0, p95 = sorted.at(-1)!.fraction
  for (const entry of sorted) {
    cumulative += entry.length
    if (cumulative >= target) { p95 = entry.fraction; break }
  }
  return available({ peakFraction: peak, p95Fraction: p95, cuttingLengthMm, maxAxialDepthMm, cellMm: field.cell },
    ['replayed from the uncut stock box: right for the first operation on that stock (as the stick)'])
}
