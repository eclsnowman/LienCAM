// pattern2d - scripted decorative pattern toolpaths (WO-2982, WO-2962 PLAN Phase A).
//
// Pure library: no UI, no operation registry (Phase B wires it). The pattern
// spec is data (types.ts), parsed with the existing params grammar (spec.ts),
// sampled to a chord tolerance (sample.ts), measured against the cut footprint
// (envelope.ts) and emitted as ordinary ToolpathMove[]:
//
//   rapid to clearance above the first pass, rapid down to retract, plunge at
//   the plunge rate, cut every sample at the cutting feed; between passes
//   rapid up to retract, across, plunge; after the last pass rapid to
//   clearance. Nothing rapids below the retract height (C5).
//
// Rule 11: it refuses only what it cannot do (a spec it cannot read, a point
// that does not exist, a depth the flute cannot reach). Anything it can do it
// does and says so in one line with the measured value: the footprint crossing
// the region (C1), neighbouring passes merging (C2), a feed or rpm beyond the
// machine (C6, C7; the controller caps them).

import { resolveHeights } from '../heights'
import { resolveFeedrates } from '../feedrates'
import { assertToolFluteReach } from '../toolFluteReach'
import type { ToolpathMove } from '../../../types'
import { PatternSpecError, parsePatternSpec } from './spec'
import type { ResolvedPatternSpec, ResolvedTransform } from './spec'
import { evalAt, sampleCurve } from './sample'
import type { CurveSample } from './sample'
import { clipRun, footprintHalfWidth, regionCentroid, regionEdges, containmentMargin as measureContainment, turnGap } from './envelope'
import type { CutPoint, Pt } from './envelope'
import type { PatternMetrics, PatternToolpathResult, PatternWorkerPayload } from './types'

export * from './types'
export { PatternSpecError, parsePatternSpec, compileExpr, DEFAULT_CHORD_TOL_MM } from './spec'
export type { PatternDiag, PatternDiagCode, ResolvedPatternSpec, ResolvedCurve } from './spec'
export { sampleCurve, chordDeviation, curvePoint } from './sample'
export { footprintHalfWidth, insideDistance, regionCentroid, regionEdges, safeIntervals, containmentMargin, turnGap } from './envelope'

const RAD_PER_DEG = Math.PI / 180

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number }
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

/** m2 after m1. */
function compose(m2: Affine, m1: Affine): Affine {
  return {
    a: m2.a * m1.a + m2.b * m1.c, b: m2.a * m1.b + m2.b * m1.d,
    c: m2.c * m1.a + m2.d * m1.c, d: m2.c * m1.b + m2.d * m1.d,
    tx: m2.a * m1.tx + m2.b * m1.ty + m2.tx, ty: m2.c * m1.tx + m2.d * m1.ty + m2.ty,
  }
}

function rotation(deg: number): Affine {
  const c = Math.cos(deg * RAD_PER_DEG)
  const s = Math.sin(deg * RAD_PER_DEG)
  return { a: c, b: -s, c: s, d: c, tx: 0, ty: 0 }
}

function toAffine(tr: Exclude<ResolvedTransform, { kind: 'polar-array' }>): Affine {
  switch (tr.kind) {
    case 'translate': return { ...IDENTITY, tx: tr.dx, ty: tr.dy }
    case 'rotate': return rotation(tr.deg)
    case 'scale': return { a: tr.s, b: 0, c: 0, d: tr.s, tx: 0, ty: 0 }
    case 'mirror': return tr.axis === 'x' ? { ...IDENTITY, d: -1 } : { ...IDENTITY, a: -1 }
  }
}

/** Every copy's transform, in listed order (a polar array multiplies the copies). */
function copyTransforms(transforms: ResolvedTransform[]): Affine[] {
  let copies: Affine[] = [IDENTITY]
  for (const tr of transforms) {
    if (tr.kind === 'polar-array') {
      copies = copies.flatMap(m => Array.from({ length: tr.count }, (_, k) => compose(rotation(k * tr.deg), m)))
    } else {
      const m2 = toAffine(tr)
      copies = copies.map(m => compose(m2, m))
    }
  }
  return copies
}

/** Largest stretch any copy applies, so sampling in the curve frame still meets
 *  the tolerance after scaling. */
function maxStretch(copies: Affine[]): number {
  return copies.reduce((s, m) => Math.max(s, Math.hypot(m.a, m.c), Math.hypot(m.b, m.d)), 0)
}

function resolveAnchor(spec: ResolvedPatternSpec, payload: PatternWorkerPayload): Pt {
  const o = payload.wcsOrigin
  switch (spec.anchor.kind) {
    case 'wcs-origin': return { x: o.x, y: o.y }
    case 'point': return { x: o.x + spec.anchor.x, y: o.y + spec.anchor.y }
    case 'region-centroid':
      if (payload.region.length === 0) {
        throw new PatternSpecError({ code: 'PATTERN_NO_REGION', path: 'anchor' },
          "'region-centroid' needs a region, and this operation has none")
      }
      return regionCentroid(payload.region)
  }
}

function depthFn(spec: ResolvedPatternSpec, payload: PatternWorkerPayload): (x: number, y: number, t: number) => number {
  if (spec.depth.kind === 'const') {
    const mm = spec.depth.mm
    return () => mm
  }
  const expr = spec.depth.expr
  const o = payload.wcsOrigin
  return (x, y, t) => {
    const vars: Record<string, number> = { x: x - o.x, y: y - o.y, t }
    return evalAt(expr, name => vars[name], t)
  }
}

function placeCurve(samples: CurveSample[], copies: Affine[], anchor: Pt,
  depthAt: (x: number, y: number, t: number) => number, hwAt: (d: number) => number): CutPoint[][] {
  return copies.map(m => samples.map(s => {
    const x = anchor.x + m.a * s.x + m.b * s.y + m.tx
    const y = anchor.y + m.c * s.x + m.d * s.y + m.ty
    const depth = depthAt(x, y, s.t)
    return { x, y, t: s.t, depth, hw: hwAt(depth) }
  }))
}

function pathLength(runs: CutPoint[][]): number {
  let len = 0
  for (const run of runs) for (let i = 1; i < run.length; i++) len += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y)
  return len
}

function mm(v: number): string {
  return v.toFixed(3)
}

/**
 * Build the toolpath for one pattern operation. Throws PatternSpecError (or the
 * existing flute-reach refusal) only when the pattern cannot be made.
 */
export function buildPatternToolpath(payload: PatternWorkerPayload): PatternToolpathResult {
  const spec = parsePatternSpec(payload.spec)
  const { tool } = payload
  const { clearanceZ, retractZ, topZ } = resolveHeights(payload.heights, payload.wcsOrigin)
  const feeds = resolveFeedrates(tool, payload.feedrateOverride)
  const anchor = resolveAnchor(spec, payload)
  const depthAt = depthFn(spec, payload)
  const hwAt = (d: number) => footprintHalfWidth(tool, d)
  const region = payload.region
  const edges = regionEdges(region)
  if (spec.clip === 'region' && region.length === 0) {
    throw new PatternSpecError({ code: 'PATTERN_NO_REGION', path: 'clip' }, "'region' clipping needs a region, and this operation has none")
  }

  let runs: CutPoint[][] = []
  let samples = 0
  for (const curve of spec.curves) {
    const copies = copyTransforms(curve.transforms)
    const stretch = maxStretch(copies)
    const pts = sampleCurve(curve, stretch > 0 ? spec.chordTol / stretch : Infinity)
    samples += pts.length * copies.length
    runs.push(...placeCurve(pts, copies, anchor, depthAt, hwAt).filter(r => r.length >= 2))
  }

  const notes: string[] = []
  let clipped = 0
  if (spec.clip === 'region') {
    const before = pathLength(runs)
    const interp = (a: CutPoint, b: CutPoint, u: number): CutPoint => {
      const x = a.x + (b.x - a.x) * u
      const y = a.y + (b.y - a.y) * u
      const t = a.t + (b.t - a.t) * u
      const depth = a.depth + (b.depth - a.depth) * u
      return { x, y, t, depth, hw: hwAt(depth) }
    }
    runs = runs.flatMap(run => clipRun(run, edges, interp))
    clipped = before - pathLength(runs)
  }

  let maxDepth = -Infinity
  for (const run of runs) for (const p of run) if (p.depth > maxDepth) maxDepth = p.depth
  if (runs.length > 0) {
    assertToolFluteReach({ operation: 'Pattern', topZ, bottomZ: topZ - maxDepth, fluteLength: tool.fluteLength })
  }

  // ── moves ──
  const moves: ToolpathMove[] = []
  runs.forEach((run, i) => {
    const s = run[0]
    if (i === 0) moves.push({ type: 'rapid', x: s.x, y: s.y, z: clearanceZ, role: 'rapid' })
    else moves.push({ type: 'rapid', x: s.x, y: s.y, z: retractZ, role: 'rapid' })
    if (i === 0) moves.push({ type: 'rapid', x: s.x, y: s.y, z: retractZ, role: 'rapid' })
    moves.push({ type: 'feed', x: s.x, y: s.y, z: topZ - s.depth, feed: feeds.plungeRate, role: 'plunge' })
    for (let k = 1; k < run.length; k++) {
      const p = run[k]
      moves.push({ type: 'feed', x: p.x, y: p.y, z: topZ - p.depth, feed: feeds.feedRate, role: 'cut' })
    }
    const e = run[run.length - 1]
    moves.push({ type: 'rapid', x: e.x, y: e.y, z: i === runs.length - 1 ? clearanceZ : retractZ, role: 'rapid' })
  })

  // ── measures (C1, C2) ──
  let maxHw = 0
  for (const run of runs) for (const p of run) if (p.hw > maxHw) maxHw = p.hw
  let containmentMargin: number | null = null
  if (region.length > 0 && runs.length > 0) {
    containmentMargin = measureContainment(runs, edges, spec.chordTol)
  }
  const gap = maxHw > 0 ? turnGap(runs, Math.PI * 2 * maxHw, 4 * maxHw) : null
  const cutLengthMm = pathLength(runs)
  const metrics: PatternMetrics = {
    samples, runs: runs.length, cutLengthMm, grooveWidth: 2 * maxHw, containmentMargin,
    minTurnGap: gap ? gap.gap : null, minRidge: gap ? gap.ridge : null,
  }

  // ── notes (one line each) ──
  if (runs.length === 0) {
    notes.push(spec.clip === 'region'
      ? 'Pattern: nothing to cut, every pass lies where its cut would leave the region.'
      : 'Pattern: nothing to cut, every curve has zero length.')
    return { moves, notes, metrics }
  }
  notes.push(`Pattern: ${samples} points on ${runs.length} pass${runs.length === 1 ? '' : 'es'}, ` +
    `${cutLengthMm.toFixed(1)} mm of cut, ${(cutLengthMm / feeds.feedRate).toFixed(2)} min at F${feeds.feedRate}.`)
  if (clipped > 1e-9) notes.push(`Trimmed ${clipped.toFixed(1)} mm of path where the cut would leave the region.`)
  if (containmentMargin !== null && containmentMargin < 0 && spec.clip === 'none') {
    notes.push(`The cut reaches ${mm(-containmentMargin)} mm past the region edge; made as written.`)
  }
  if (metrics.minRidge !== null && metrics.minRidge < 0) {
    notes.push(`Neighbouring passes overlap: ridge ${mm(metrics.minRidge)} mm between grooves ` +
      `${mm(metrics.minTurnGap as number)} mm apart, so they merge; made as written.`)
  }
  const lim = payload.machine
  if (lim?.maxCuttingFeed !== undefined) {
    for (const [what, f] of [['Cutting feed', feeds.feedRate], ['Plunge feed', feeds.plungeRate]] as const) {
      if (f > lim.maxCuttingFeed) notes.push(`${what} F${f} is above this machine's ${lim.maxCuttingFeed} mm/min; the controller caps it.`)
    }
  }
  const rpm = payload.spindleRpm
  if (rpm !== undefined) {
    if (lim?.maxSpindleRpm !== undefined && rpm > lim.maxSpindleRpm) {
      notes.push(`Spindle ${rpm} rpm is above this machine's ${lim.maxSpindleRpm} rpm; the controller caps it.`)
    }
    if (lim?.minSpindleRpm !== undefined && rpm < lim.minSpindleRpm) {
      notes.push(`Spindle ${rpm} rpm is below this machine's ${lim.minSpindleRpm} rpm; the controller raises it.`)
    }
  }
  return { moves, notes, metrics }
}
