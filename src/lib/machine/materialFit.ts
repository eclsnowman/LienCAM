// materialFit - the MATERIAL-FIT TRACE (Operator's UCCNC M20002 pattern): before
// cutting, physically trace the loaded program's XY bounding outline at the
// machine's safe Z, with a short dwell at each corner, so the operator can
// verify the stock and clamps actually fit the job.
//
// Pure module: bounds math + command-sequence construction + plan validation.
// Execution lives in machineSession.runMaterialFitTrace; UI in ProgramPanel.
//
// Safety contract (mirrors park moves): the FIRST motion raises to the
// machine-coordinate safe Z (G53), which is REQUIRED and never guessed, and
// the whole trace is only meaningful homed - the runner enforces that.

import type { PreviewModel } from './previewGeometry'

export interface FitBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * The XY bounding box of the program's CUTTING moves (feed + arc). Rapids are
 * deliberately excluded: they include parks/tool-change travel that says
 * nothing about where material must sit. Refuses when the program has no
 * cutting moves at all - tracing a rapid-only file would be a lie (ADR-0003).
 */
export function computeCutBounds(
  model: PreviewModel,
): { ok: true; bounds: FitBounds } | { ok: false; reason: string } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const line of model.polylines) {
    if (line.kind === 'rapid') continue
    for (const p of line.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { ok: false, reason: 'The program has no cutting moves to outline.' }
  }
  return { ok: true, bounds: { minX, minY, maxX, maxY } }
}

/** Job-properties readout for the loaded program (UCCNC-hitlist tier 1). */
export interface JobStats {
  moves: { rapid: number; feed: number; arc: number }
  /** Bounds of the cutting moves, with their Z range; null when no cuts. */
  cut: (FitBounds & { zMin: number; zMax: number }) | null
  /** Bounds of ALL moves including rapids; null when the program is empty. */
  all: FitBounds | null
}

export function computeJobStats(model: PreviewModel): JobStats {
  const moves = { rapid: 0, feed: 0, arc: 0 }
  let cMinX = Infinity
  let cMinY = Infinity
  let cMaxX = -Infinity
  let cMaxY = -Infinity
  let zMin = Infinity
  let zMax = -Infinity
  for (const line of model.polylines) {
    moves[line.kind]++
    if (line.kind === 'rapid') continue
    for (const p of line.points) {
      if (p.x < cMinX) cMinX = p.x
      if (p.y < cMinY) cMinY = p.y
      if (p.x > cMaxX) cMaxX = p.x
      if (p.y > cMaxY) cMaxY = p.y
    }
    if (line.z < zMin) zMin = line.z
    if (line.z > zMax) zMax = line.z
  }
  return {
    moves,
    cut: Number.isFinite(cMinX)
      ? { minX: cMinX, minY: cMinY, maxX: cMaxX, maxY: cMaxY, zMin, zMax }
      : null,
    all:
      model.polylines.length > 0
        ? { minX: model.minX, minY: model.minY, maxX: model.maxX, maxY: model.maxY }
        : null,
  }
}

/** Seconds the machine pauses at each corner so the operator can look. */
export const FIT_TRACE_DWELL_S = 0.5

/**
 * The trace feed derived from the machine's rapid rate: half speed, clamped
 * to a watchable band. A fit check is for LOOKING, not for making time.
 */
export function defaultTraceFeed(rapidRateMmMin: number | null | undefined): number {
  const rapid = Number.isFinite(rapidRateMmMin ?? NaN) ? (rapidRateMmMin as number) : 3000
  return Math.min(2000, Math.max(300, Math.round(rapid * 0.5)))
}

/**
 * Command sequence for the trace: absolute mm, raise to machine safe Z, then
 * feed around the four corners (counter-clockwise from min/min) with a dwell
 * at each, closing the loop back at the first corner. All XY are WORK
 * coordinates in the ACTIVE work offset - the same frame the program runs in.
 */
export function buildFitTraceSequence(
  bounds: FitBounds,
  safeZMachine: number | null | undefined,
  feedMmMin: number,
): { ok: true; lines: string[] } | { ok: false; reason: string } {
  if (safeZMachine === null || safeZMachine === undefined || !Number.isFinite(safeZMachine)) {
    return {
      ok: false,
      reason: "Set this machine's Safe Z on the Machine tab of its definition first - the trace runs there.",
    }
  }
  const vals = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]
  if (vals.some((v) => !Number.isFinite(v)) || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) {
    return { ok: false, reason: 'The program bounds are not a usable rectangle.' }
  }
  if (!Number.isFinite(feedMmMin) || feedMmMin <= 0) {
    return { ok: false, reason: 'The trace feed must be a positive number.' }
  }
  const n = (v: number) => Number(v.toFixed(3))
  const corners: Array<[number, number]> = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ]
  const lines: string[] = ['G21 G90', `G53 G0 Z${n(safeZMachine)}`]
  corners.forEach(([x, y], i) => {
    lines.push(`G1 X${n(x)} Y${n(y)}${i === 0 ? ` F${n(feedMmMin)}` : ''}`)
    lines.push(`G4 P${FIT_TRACE_DWELL_S}`)
  })
  // Close the loop back to the first corner; no dwell needed on arrival.
  lines.push(`G1 X${n(corners[0][0])} Y${n(corners[0][1])}`)
  return { ok: true, lines }
}
