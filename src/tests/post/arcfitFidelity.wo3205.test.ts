// WO-3205: the posted program is the toolpath. Every collapsed primitive must
// stay within arcTolerance of the SOURCE PATH it replaces, in traversal order:
// a vertex sitting radially off the fitted circle and the sagitta of its chord
// must not stack past the budget (F2), and a reversal along one line must not
// measure 0 against the infinite line and vanish (F3).
import { describe, it, expect } from 'vitest'
import { collapsePolyline, type CollapseParams } from '../../lib/post/arcfit'
import { douglasPeucker, douglasPeuckerIndexed } from '../../lib/post/arcfit/simplify'
import type { ToolpathMove, Vec2 } from '../../types'

const PARAMS: CollapseParams = { arcTolerance: 0.05, minArcRadius: 0.5, maxArcRadius: 1e4, minSweepDeg: 2 }

function run(points: Vec2[], z = -1): ToolpathMove[] {
  return [
    { type: 'rapid', x: points[0].x, y: points[0].y, z },
    ...points.slice(1).map((p) => ({ type: 'feed' as const, x: p.x, y: p.y, z, feed: 500, role: 'cut' as const })),
  ]
}

/** Dense samples of a move list (arcs walked at <= 0.5 deg, lines every 0.01 mm). */
function sample(moves: readonly ToolpathMove[]): Vec2[] {
  const out: Vec2[] = [{ x: moves[0].x, y: moves[0].y }]
  for (let k = 1; k < moves.length; k++) {
    const a = moves[k - 1]
    const m = moves[k]
    if ((m.type === 'arc_cw' || m.type === 'arc_ccw') && m.cx !== undefined && m.cy !== undefined) {
      const r = Math.hypot(a.x - m.cx, a.y - m.cy)
      const a0 = Math.atan2(a.y - m.cy, a.x - m.cx)
      let d = Math.atan2(m.y - m.cy, m.x - m.cx) - a0
      if (m.type === 'arc_ccw') while (d <= 0) d += 2 * Math.PI
      else while (d >= 0) d -= 2 * Math.PI
      const n = Math.max(1, Math.ceil(Math.abs(d) / (Math.PI / 360)))
      for (let s = 1; s <= n; s++) {
        const t = a0 + (d * s) / n
        out.push({ x: m.cx + r * Math.cos(t), y: m.cy + r * Math.sin(t) })
      }
    } else {
      const n = Math.max(1, Math.ceil(Math.hypot(m.x - a.x, m.y - a.y) / 0.01))
      for (let s = 1; s <= n; s++) out.push({ x: a.x + ((m.x - a.x) * s) / n, y: a.y + ((m.y - a.y) * s) / n })
    }
  }
  return out
}

/**
 * Ordered containment, the WO-3197 post-equivalence rule: walk `points` along
 * `path`, each matched to the FIRST place, no earlier than the previous match,
 * within `tol`. Returns the worst matched distance, or, for the first point that
 * has no such place, its distance from where the walk stood (> tol).
 */
function orderedDeviation(points: readonly Vec2[], path: readonly Vec2[], tol: number): number {
  let worst = 0
  let seg = 1
  let progress = 0
  for (const p of points) {
    let matched = false
    let standing = Infinity
    for (let s = seg; s < path.length; s++) {
      const a = path[s - 1]
      const b = path[s]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      const floor = s === seg ? progress : 0
      const t = l2 === 0 ? floor : Math.max(floor, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
      if (s === seg) standing = d
      if (d <= tol) {
        worst = Math.max(worst, d)
        seg = s
        progress = t
        matched = true
        break
      }
    }
    if (!matched) return standing
  }
  return worst
}

function fidelity(source: ToolpathMove[], out: ToolpathMove[]): number {
  const src = sample(source)
  const post = sample(out)
  const tol = PARAMS.arcTolerance + 1e-9
  return Math.max(orderedDeviation(src, post, tol), orderedDeviation(post, src, tol))
}

describe('WO-3205 F3: a collinear reversal is kept', () => {
  it('keeps a reversal that overshoots the run end (Feature Tour / Adaptive Clearing shape)', () => {
    // Out along X, then back 0.219 mm on the same line: the infinite-line
    // measure put the overshoot at 0 and posted one line to X9.781.
    const source = run([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 9.781, y: 0 }])
    const out = collapsePolyline(source, PARAMS)
    expect(out.some((m) => Math.abs(m.x - 10) < 1e-9 && Math.abs(m.y) < 1e-9)).toBe(true)
    expect(fidelity(source, out)).toBeLessThanOrEqual(PARAMS.arcTolerance + 1e-9)
  })

  it('keeps a reversal inside the span of the chord', () => {
    const source = run([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1.915, y: 0 }, { x: 4, y: 0 }])
    const out = collapsePolyline(source, PARAMS)
    expect(fidelity(source, out)).toBeLessThanOrEqual(PARAMS.arcTolerance + 1e-9)
    expect(out.map((m) => m.x)).toEqual([0, 2, 1.915, 4])
  })

  it('a backtrack inside the budget still collapses', () => {
    const source = run([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1.98, y: 0 }, { x: 4, y: 0 }])
    const out = collapsePolyline(source, PARAMS)
    expect(out).toHaveLength(2)
    expect(fidelity(source, out)).toBeLessThanOrEqual(PARAMS.arcTolerance + 1e-9)
  })

  it('Douglas-Peucker keeps the reversal vertex in both forms', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 9.915, y: 0 }]
    expect(douglasPeuckerIndexed(pts, 0.025)).toEqual([0, 1, 2])
    expect(douglasPeucker(pts, 0.025)).toHaveLength(3)
    const inSpan = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1.9, y: 0 }, { x: 4, y: 0 }]
    expect(douglasPeuckerIndexed(inSpan, 0.025)).toEqual([0, 1, 2, 3])
  })
})

describe('WO-3205 F2: arc fidelity is measured against the source path', () => {
  it('vertex radial deviation and chord sagitta do not stack past the tolerance', () => {
    // Long chords (sagitta ~0.05 mm on R10) with the middle vertex 0.045 mm
    // inside the circle: each vertex passes the radial check and each chord
    // passes the on-circle sagitta check, but together they leave the path by
    // ~0.063 mm (the old measure; Tee measured 0.062).
    const r = 10
    const n = 9
    const pts: Vec2[] = []
    for (let k = 0; k < n; k++) {
      const t = (Math.PI / 2) * (k / (n - 1))
      const rr = k === (n - 1) / 2 ? r - 0.045 : r
      pts.push({ x: rr * Math.cos(t), y: rr * Math.sin(t) })
    }
    const source = run(pts)
    const out = collapsePolyline(source, PARAMS)
    expect(fidelity(source, out)).toBeLessThanOrEqual(PARAMS.arcTolerance + 1e-9)
  })

  it('a clean dense arc still collapses to one arc', () => {
    const pts: Vec2[] = []
    for (let k = 0; k <= 90; k++) {
      const t = (Math.PI / 2) * (k / 90)
      pts.push({ x: 10 * Math.cos(t), y: 10 * Math.sin(t) })
    }
    const source = run(pts)
    const out = collapsePolyline(source, PARAMS)
    expect(out).toHaveLength(2)
    expect(out[1].type).toBe('arc_ccw')
    expect(fidelity(source, out)).toBeLessThanOrEqual(PARAMS.arcTolerance + 1e-9)
  })

  it('an arc run that reverses along the circle is not posted as one arc', () => {
    // Forward to 60 deg, back to 50 deg, on to 90 deg: every vertex is on the
    // circle and inside the sweep, but the posted arc would skip the back-step.
    const pts: Vec2[] = []
    const deg = [0, 10, 20, 30, 40, 50, 60, 55, 50, 60, 70, 80, 90]
    for (const d of deg) pts.push({ x: 10 * Math.cos((d * Math.PI) / 180), y: 10 * Math.sin((d * Math.PI) / 180) })
    const source = run(pts)
    const out = collapsePolyline(source, PARAMS)
    expect(fidelity(source, out)).toBeLessThanOrEqual(PARAMS.arcTolerance + 1e-9)
  })
})
