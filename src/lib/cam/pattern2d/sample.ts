// pattern2d sample - adaptive chordal sampling of one curve (WO-2982).
//
// The sampler walks t from start to end, halving each span until the chord
// stays within the tolerance of the true curve (measured at PROBE points along
// the span), then grows the next step by 1.5x. It aims at 90 % of chordTol:
// a 16-point probe can miss a span's true peak by a little, and the
// independent finer check (C3, asserted in tests) cannot (PLAN sec. 6, the
// oracle's first draft measured 5.013 um at 100 %).
//
// Finite by construction: a fixed t range, a step that never drops below
// MIN_STEP_FRACTION of the range, no size caps (Rule 11).

import { evaluate } from '../../../doc/params'
import { PatternSpecError } from './spec'
import type { CompiledExpr, ResolvedCurve } from './spec'

export interface CurveSample {
  t: number
  x: number
  y: number
}

const RAD_PER_DEG = Math.PI / 180
const PROBE = 16
const AIM = 0.9
const FIRST_STEP_T = 360 / 64
const MIN_STEP_FRACTION = 1e-9

/** Evaluate one compiled expression; a value it cannot produce is a refusal
 *  naming the expression and the t where it fails. */
export function evalAt(expr: CompiledExpr, lookup: (name: string) => number | undefined, t: number): number {
  const result = evaluate(expr.ast, name => {
    const v = lookup(name)
    return v === undefined ? { ok: false } : { ok: true, value: v }
  })
  if (result.ok) return result.value
  const d = result.diag
  const why = d.code === 'PARAM_DIVISION_BY_ZERO' ? 'division by zero' : d.params.detail ?? d.code
  throw new PatternSpecError({ code: 'PATTERN_NON_FINITE', path: expr.path },
    `${why} at t = ${t}; the curve has no point there`)
}

/** The curve as a function of t, in the pattern frame (mm, before transforms). */
export function curvePoint(curve: ResolvedCurve): (t: number) => { x: number; y: number } {
  let tNow = 0
  const lookup = (name: string) => (name === 't' ? tNow : curve.params.get(name))
  if (curve.kind === 'polar') {
    const [r] = curve.exprs
    return t => {
      tNow = t
      const rad = evalAt(r, lookup, t)
      return { x: rad * Math.cos(t * RAD_PER_DEG), y: rad * Math.sin(t * RAD_PER_DEG) }
    }
  }
  const [ex, ey] = curve.exprs
  return t => {
    tNow = t
    return { x: evalAt(ex, lookup, t), y: evalAt(ey, lookup, t) }
  }
}

/** Max distance of the true curve between t0 and t1 from the chord - the FINITE
 *  segment the machine cuts, so a curve that runs past an end and comes back
 *  along the same line counts as far off - measured at `probe` evenly spaced
 *  points (ends included). Exported so tests can re-measure with a finer probe
 *  than the sampler's. */
export function chordDeviation(at: (t: number) => { x: number; y: number }, t0: number, t1: number, probe = PROBE): number {
  const a = at(t0)
  const b = at(t1)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let worst = 0
  for (let i = 1; i < probe - 1; i++) {
    const p = at(t0 + ((t1 - t0) * i) / (probe - 1))
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const d = Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y)
    if (d > worst) worst = d
  }
  return worst
}

/** Sample a curve so the polyline stays within `tol` (mm, in the pattern frame)
 *  of the true curve. Returns the samples in t order from t[0] to t[1]. */
export function sampleCurve(curve: ResolvedCurve, tol: number): CurveSample[] {
  const at = curvePoint(curve)
  const [t0, t1] = curve.t
  const span = t1 - t0
  const first = at(t0)
  const out: CurveSample[] = [{ t: t0, ...first }]
  if (span === 0) return out
  const dir = Math.sign(span)
  const total = Math.abs(span)
  const minStep = total * MIN_STEP_FRACTION
  const aim = AIM * tol
  let step = Math.min(FIRST_STEP_T, total)
  let done = 0
  while (done < total) {
    let h = Math.min(step, total - done)
    const ta = t0 + dir * done
    while (h > minStep && chordDeviation(at, ta, ta + dir * h) > aim) h /= 2
    done = total - done - h <= minStep ? total : done + h
    const t = done === total ? t1 : t0 + dir * done
    out.push({ t, ...at(t) })
    step = h * 1.5
  }
  return out
}
