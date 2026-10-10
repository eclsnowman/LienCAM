// WO-1861: a spline drawn by its control points.
//
// The control-point form is the EXISTING `spline` entity with `form: 'control'`
// (the same `points` read as a uniform cubic B-spline control polygon; clamped
// when open, periodic when closed). Every claim below runs through the
// production entry points: the armed tool in the real store (sketcherTools),
// the sketch layer's own tessellation and pick, bakeSketch, the contour
// toolpath builder, the store's drag begin + the solver mapping, clipboard,
// mirror, pattern and split. The reference curves are INDEPENDENT closed forms
// (cubic Bernstein, the uniform periodic B-spline matrix, Cox-de Boor
// recursion) -- never the evaluator under test.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Sketch, SketchEntity, SketchSplineEntity, Vec2 } from '../../lib/sketch/types'
import {
  splinePointAt, splineDerivativeAt, tessellateSpline, nearestParamOnSpline,
  splineControlPointDragTarget, splineAsThroughPoints, SPLINE_TESS_STEP_MM,
} from '../../lib/sketch/spline'
import { evalNurbs as dxfEvalNurbs } from '../../lib/import/dxfCurves'
import { toolClick, toolPreview, ARMABLE_TOOLS, type ToolState } from '../../lib/sketch/tools/toolMachine'
import { toolOverlay } from '../../lib/sketch/tools/toolOverlay'
import { splineFinish } from '../../lib/sketch/tools/splineTools'
import { bakeSketch } from '../../lib/sketch/bake'
import { solveSketchOnWrapper, type DragRequest } from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { captureSketchClipboard, instantiateSketchClipboard } from '../../lib/sketch/clipboard'
import { mirrorEntities } from '../../lib/sketch/tools/mirrorTool'
import { linearPattern } from '../../lib/sketch/tools/patternTools'
import { splitClick } from '../../lib/sketch/tools/splitTool'
import { filletLines } from '../../lib/sketch/tools/filletTool'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// ---- store stubs (same pattern as inertBodyDrag.test.ts / promptBar.test.ts) ----
const postedMessages: Array<{ type?: string; payload?: { drag?: DragRequest } }> = []
class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: unknown): void { postedMessages.push(msg as never) }
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
let layer: typeof import('../../lib/sketch/sketcher/sketchLayer')

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
  layer = await import('../../lib/sketch/sketcher/sketchLayer')
  await ensureClipperReady()
})
beforeEach(() => { postedMessages.length = 0 })

let n = 0
const newId = () => `wo1861-${n++}`

// ---- independent reference curves -------------------------------------------

type Pt = Vec2
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const d = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** The standard cubic B-spline of four control points with clamped knots IS
 *  the cubic Bezier: Bernstein form, t in [0, 1]. */
function bernstein(P: readonly Pt[], t: number): Pt {
  const s = 1 - t
  const b = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]
  return {
    x: b[0] * P[0].x + b[1] * P[1].x + b[2] * P[2].x + b[3] * P[3].x,
    y: b[0] * P[0].y + b[1] * P[1].y + b[2] * P[2].y + b[3] * P[3].y,
  }
}

/** Uniform periodic cubic B-spline, segment i at local t (the textbook 1/6 matrix). */
function periodicCubic(P: readonly Pt[], i: number, t: number): Pt {
  const n = P.length
  const p = (k: number) => P[((k % n) + n) % n]
  const t2 = t * t, t3 = t2 * t
  const b = [(1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6]
  const q = [p(i), p(i + 1), p(i + 2), p(i + 3)]
  return {
    x: b[0] * q[0].x + b[1] * q[1].x + b[2] * q[2].x + b[3] * q[3].x,
    y: b[0] * q[0].y + b[1] * q[1].y + b[2] * q[2].y + b[3] * q[3].y,
  }
}

/** Cox-de Boor recursion basis N_{i,p}(u) (right-closed at the domain end). */
function basis(i: number, p: number, u: number, U: readonly number[]): number {
  if (p === 0) {
    const last = U[U.length - 1]
    if (u === last) return U[i] < last && U[i + 1] === last ? 1 : 0
    return U[i] <= u && u < U[i + 1] ? 1 : 0
  }
  const a = U[i + p] - U[i] === 0 ? 0 : ((u - U[i]) / (U[i + p] - U[i])) * basis(i, p - 1, u, U)
  const b = U[i + p + 1] - U[i + 1] === 0 ? 0
    : ((U[i + p + 1] - u) / (U[i + p + 1] - U[i + 1])) * basis(i + 1, p - 1, u, U)
  return a + b
}
/** Clamped uniform cubic (integer knots) by Cox-de Boor, u in [0, n-3]. */
function coxDeBoorClamped(P: readonly Pt[], u: number): Pt {
  const n = P.length, p = 3, spans = n - p
  const U = [0, 0, 0, 0, ...Array.from({ length: spans - 1 }, (_, i) => i + 1), spans, spans, spans, spans]
  let x = 0, y = 0
  for (let i = 0; i < n; i++) {
    const N = basis(i, p, u, U)
    x += N * P[i].x
    y += N * P[i].y
  }
  return { x, y }
}

/** Minimum distance from `p` to a polyline. */
function distToPolyline(p: Pt, poly: readonly Pt[]): number {
  let best = Infinity
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1]
    const dx = b.x - a.x, dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y))
  }
  return best
}

/** Dense true-curve samples (0.005 mm scale) from an exact evaluator. */
function denseCurve(at: (q: number) => Pt, qMax: number, count = 20000): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= count; i++) out.push(at((qMax * i) / count))
  return out
}

/** The acceptance's "does NOT pass through the middle two" check, applied to
 *  any curve given as dense samples. */
function missesInteriorPoints(curve: readonly Pt[], interior: readonly Pt[], clearMm = 0.5): boolean {
  return interior.every((p) => distToPolyline(p, curve) > clearMm)
}

const FOUR: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 40, y: 30 }, { x: 50, y: 0 }]

function sketchOf(entities: SketchEntity[]): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints: [], dimensions: [], solveStatus: null }
}
function cpSpline(id: string, points: Pt[], closed = false): SketchSplineEntity {
  return { id, kind: 'spline', construction: false, points: points.map((p) => ({ ...p })), closed, form: 'control' }
}

// ---- 1. Drawing four control points -----------------------------------------

describe('WO-1861: four placed control points make a cubic B-spline', () => {
  function drawWithArmedTool(points: Pt[], closeLoop = false): SketchSplineEntity {
    const store = useCamStore.getState()
    store.setViewerMode('sketch') // auto-creates a blank active sketch
    const before = new Set((useCamStore.getState().activeSketch?.entities ?? []).map((e) => e.id))
    sketcherTools.setSplineClosed(closeLoop)
    sketcherTools.armTool('spline-control')
    for (const p of points) sketcherTools.click(p, 0.05, null, false)
    sketcherTools.end()
    sketcherTools.setSplineClosed(false)
    const added = (useCamStore.getState().activeSketch?.entities ?? []).filter((e) => !before.has(e.id))
    expect(added).toHaveLength(1)
    expect(added[0].kind).toBe('spline')
    return added[0] as SketchSplineEntity
  }

  it('the armed tool commits ONE control-form spline holding the clicked points', () => {
    expect(ARMABLE_TOOLS.has('spline-control')).toBe(true)
    const e = drawWithArmedTool(FOUR)
    expect(e.form).toBe('control')
    expect(e.closed).toBe(false)
    expect(e.points).toEqual(FOUR)
    expect(sketcherToolStore.getState().tool).toBe('spline-control') // armed for the next one
  })

  it('what the sketch layer draws starts on P0, ends on P3, misses P1/P2, and is the cubic Bernstein curve to 1e-9 mm', () => {
    const e = drawWithArmedTool(FOUR)
    const drawn = layer.tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
    expect(d(drawn[0], FOUR[0])).toBe(0)
    expect(d(drawn[drawn.length - 1], FOUR[3])).toBe(0)
    // Every drawn vertex is ON the standard cubic B-spline: the single clamped
    // span is sampled uniformly in its parameter, so vertex j sits at t=j/sub.
    const sub = drawn.length - 1
    let worst = 0
    for (let j = 0; j <= sub; j++) worst = Math.max(worst, d(drawn[j], bernstein(FOUR, j / sub)))
    expect(worst).toBeLessThan(1e-9)
    // The evaluator itself over the whole shared domain [0, n-1].
    for (let i = 0; i <= 300; i++) {
      const q = (3 * i) / 300
      expect(d(splinePointAt(e.points, false, q, 'control'), bernstein(FOUR, q / 3))).toBeLessThan(1e-9)
    }
    // Pulled toward, not through, the interior control points.
    const exact = denseCurve((q) => bernstein(FOUR, q / 3), 3)
    expect(missesInteriorPoints(exact, [FOUR[1], FOUR[2]])).toBe(true)
    expect(missesInteriorPoints(drawn, [FOUR[1], FOUR[2]])).toBe(true)
  })

  it('NEGATIVE CONTROL: evaluated as a through-points spline the same points DO hit P1/P2, so the "misses" check fails', () => {
    const fit = tessellateSpline(FOUR, false, SPLINE_TESS_STEP_MM, 'fit')
    expect(missesInteriorPoints(fit, [FOUR[1], FOUR[2]])).toBe(false)
    // and the control-form sample list differs from the through-point one
    const ctl = tessellateSpline(FOUR, false, SPLINE_TESS_STEP_MM, 'control')
    expect(missesInteriorPoints(ctl, [FOUR[1], FOUR[2]])).toBe(true)
  })

  it('a longer open control polygon matches Cox-de Boor on the clamped uniform knots to 1e-9 mm', () => {
    const P: Pt[] = [
      { x: 0, y: 0 }, { x: 5, y: 12 }, { x: 14, y: -3 }, { x: 22, y: 9 },
      { x: 30, y: 15 }, { x: 37, y: -6 }, { x: 45, y: 4 },
    ]
    const spans = P.length - 3
    for (let i = 0; i <= 400; i++) {
      const q = ((P.length - 1) * i) / 400
      const u = (q * spans) / (P.length - 1)
      expect(d(splinePointAt(P, false, q, 'control'), coxDeBoorClamped(P, u))).toBeLessThan(1e-9)
    }
  })

  it('the importer and the sketch share ONE de Boor evaluator (dxfCurves re-exports it)', () => {
    const knots = [0, 0, 0, 0, 1, 1, 1, 1]
    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
      expect(d(dxfEvalNurbs(FOUR, 3, knots, undefined, t), bernstein(FOUR, t))).toBeLessThan(1e-12)
    }
  })

  it('rule 11: two and three control points still commit -- a line and a quadratic, no refusal', () => {
    const two = drawWithArmedTool([{ x: 0, y: 0 }, { x: 20, y: 10 }])
    const line = tessellateSpline(two.points, false, SPLINE_TESS_STEP_MM, 'control')
    for (const p of line) expect(Math.abs(p.y - p.x / 2)).toBeLessThan(1e-9)
    const Q: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }]
    const three = drawWithArmedTool(Q)
    expect(three.form).toBe('control')
    for (let i = 0; i <= 20; i++) {
      const t = i / 20
      const quad = lerp(lerp(Q[0], Q[1], t), lerp(Q[1], Q[2], t), t)
      expect(d(splinePointAt(three.points, false, 2 * t, 'control'), quad)).toBeLessThan(1e-9)
    }
  })

  it('while placing points the rubber band is the control-form curve and the overlay ghosts the control polygon', () => {
    let st: ToolState = { tool: 'spline-control', chain: null }
    for (const p of FOUR.slice(0, 3)) st = toolClick(st, p, 0.05, newId).state
    const preview = toolPreview(st, FOUR[3])!
    expect(d(preview[0], FOUR[0])).toBe(0)
    expect(d(preview[preview.length - 1], FOUR[3])).toBe(0)
    expect(missesInteriorPoints(preview, [FOUR[1], FOUR[2]])).toBe(true)
    const ov = toolOverlay(st, FOUR[3], 0.05, { entities: [] })!
    expect(ov.ghosts).toEqual([[...FOUR]])
    expect(ov.markers).toEqual(FOUR.slice(0, 3))
    // finish (Enter) = the same splineFinish the controller calls
    const commit = splineFinish(
      { ...(st.chain as { kind: 'spline'; points: Pt[]; form?: 'control' }), points: FOUR }, false, newId)!
    expect((commit.entities[0] as SketchSplineEntity).form).toBe('control')
  })
})

// ---- 2. Control points are individually pickable, draggable sites -------------

const TEN: Pt[] = Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: i % 2 === 0 ? 0 : 12 }))

describe('WO-1861: each control point is a pickable, draggable site', () => {
  it('the sketch layer picks the spline at an OFF-curve control point', () => {
    const e = cpSpline('cp', FOUR)
    // P1 sits well off the curve ...
    expect(distToPolyline(FOUR[1], tessellateSpline(FOUR, false, 0.05, 'control'))).toBeGreaterThan(5)
    // ... and is still a hit
    expect(layer.pickNearestEntity([e], FOUR[1].x, FOUR[1].y, 0.5)).toBe('cp')
    // a point near neither the curve nor a control point is not a hit
    const offCurve = { x: 25, y: 60 }
    expect(layer.pickNearestEntity([e], offCurve.x, offCurve.y, 0.5)).toBeNull()
  })

  it('the store drag begun ON a control point pins that point as its own solver site', async () => {
    const e = cpSpline('cp10', TEN)
    useCamStore.setState({
      activeSketch: sketchOf([e]),
      sketchSolveStatus: null,
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTool: 'select', sketchToolChain: null,
      sketchTextEditId: null, sketchPickPathForTextId: null,
    } as never)
    const st = useCamStore.getState()
    expect(st.beginSketchDrag('cp10', { x: 50.1, y: 12 }, 0.5)).toBe(true)
    st.moveSketchDrag({ x: 55, y: 30 })
    await new Promise((r) => setTimeout(r, 40)) // past the store's 25 ms drag-solve debounce
    const drags = postedMessages.filter((m) => m.type === 'DRAG_SOLVE')
    expect(drags.length).toBeGreaterThan(0)
    const targets = drags[drags.length - 1].payload!.drag!.targets
    expect(targets).toHaveLength(1)
    expect(targets[0].point).toEqual({ entityId: 'cp10', site: 'cp5' })
    expect(targets[0].to.x).toBeCloseTo(54.9, 9)
    expect(targets[0].to.y).toBeCloseTo(30, 9)
    st.endSketchDrag(undefined)
  })

  it('a grab on the curve away from any control point keeps the whole-spline anchor drag', () => {
    const e = cpSpline('cpb', FOUR)
    const onCurve = splinePointAt(FOUR, false, 1.5, 'control')
    expect(splineControlPointDragTarget(e, onCurve, 0.5)).toBeNull()
    // a through-point spline never yields a control-point target
    expect(splineControlPointDragTarget({ ...e, form: undefined }, FOUR[1], 0.5)).toBeNull()
  })

  it('dragging interior control point 5 moves only the curve near it; the ends and every other control point stay put', async () => {
    const e = cpSpline('cp10', TEN)
    const sk = sketchOf([e])
    const grab = TEN[5]
    const target = splineControlPointDragTarget(e, grab, 0.5)!
    const to = { x: 52, y: 40 }
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sk, { targets: [{ point: target.point, to }] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const moved = out.entities[0] as SketchSplineEntity
    expect(moved.form).toBe('control')
    for (let i = 0; i < TEN.length; i++) {
      if (i === 5) expect(d(moved.points[i], to)).toBeLessThan(1e-6)
      else expect(d(moved.points[i], TEN[i])).toBe(0)
    }
    // Local support: a cubic control point shapes 4 knot spans. With 10
    // points the clamped knots are 0..7 and N_5 lives on u in [2, 6], i.e.
    // q = u * 9/7 in [2.571, 7.714]. Outside it the curve is bit-identical.
    for (let i = 0; i <= 100; i++) {
      const qa = (2.5 * i) / 100
      const qb = 7.8 + (1.2 * i) / 100
      expect(d(splinePointAt(moved.points, false, qa, 'control'), splinePointAt(TEN, false, qa, 'control'))).toBe(0)
      expect(d(splinePointAt(moved.points, false, qb, 'control'), splinePointAt(TEN, false, qb, 'control'))).toBe(0)
    }
    expect(d(splinePointAt(moved.points, false, 4.5, 'control'), splinePointAt(TEN, false, 4.5, 'control')))
      .toBeGreaterThan(1)
    // the two curve end points are the end control points, unmoved
    expect(splinePointAt(moved.points, false, 0, 'control')).toEqual(TEN[0])
    expect(splinePointAt(moved.points, false, 9, 'control')).toEqual(TEN[9])
  })

  it('an end control point drags alone too (the anchor is a control point like the rest)', async () => {
    const e = cpSpline('cpe', FOUR)
    const target = splineControlPointDragTarget(e, FOUR[0], 0.5)!
    expect(target.point.site).toBe('cp0')
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketchOf([e]), { targets: [{ point: target.point, to: { x: -5, y: 3 } }] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const moved = out.entities[0] as SketchSplineEntity
    expect(d(moved.points[0], { x: -5, y: 3 })).toBeLessThan(1e-6)
    expect(moved.points.slice(1)).toEqual(FOUR.slice(1))
  })

  it('a plain solve (no drag) leaves a control-point spline exactly as stored', async () => {
    const e = cpSpline('cps', TEN)
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketchOf([e]))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((out.entities[0] as SketchSplineEntity).points).toEqual(TEN)
  })
})

// ---- 3. Closed control-point spline ----------------------------------------------

const HEX: Pt[] = Array.from({ length: 6 }, (_, i) => ({
  x: 30 * Math.cos((i * Math.PI) / 3), y: 20 * Math.sin((i * Math.PI) / 3),
}))

describe('WO-1861: a closed control-point spline closes smoothly', () => {
  it('matches the uniform periodic cubic B-spline to 1e-9 mm over the whole lap', () => {
    for (let i = 0; i <= 600; i++) {
      const q = (6 * i) / 600
      const seg = Math.min(5, Math.floor(q))
      expect(d(splinePointAt(HEX, true, q, 'control'), periodicCubic(HEX, seg, q - seg))).toBeLessThan(1e-9)
    }
  })

  it('has no corner at the seam: position, tangent and curvature agree from both sides', () => {
    const h = 1e-4
    const a = splinePointAt(HEX, true, 6, 'control'), b = splinePointAt(HEX, true, 0, 'control')
    expect(d(a, b)).toBeLessThan(1e-12)
    const tBefore = splineDerivativeAt(HEX, true, 6 - h, 'control')
    const tAfter = splineDerivativeAt(HEX, true, h, 'control')
    expect(d(tBefore, tAfter) / Math.hypot(tAfter.x, tAfter.y)).toBeLessThan(1e-3)
    // second difference across the seam equals the second difference just inside
    const p = (q: number) => splinePointAt(HEX, true, q, 'control')
    const s = 1e-3
    const acrossSeam = { x: p(s).x - 2 * p(0).x + p(-s).x, y: p(s).y - 2 * p(0).y + p(-s).y }
    const inside = { x: p(1 + s).x - 2 * p(1).x + p(1 - s).x, y: p(1 + s).y - 2 * p(1).y + p(1 - s).y }
    expect(Math.hypot(acrossSeam.x, acrossSeam.y)).toBeGreaterThan(0)
    // C2: the seam second difference matches the analytic one from the matrix form
    const q0 = periodicCubic(HEX, 5, 1 - s), q1 = periodicCubic(HEX, 0, 0), q2 = periodicCubic(HEX, 0, s)
    const analytic = { x: q2.x - 2 * q1.x + q0.x, y: q2.y - 2 * q1.y + q0.y }
    expect(d(acrossSeam, analytic)).toBeLessThan(1e-9)
    expect(Math.hypot(inside.x, inside.y)).toBeGreaterThan(0)
  })

  it('the Close loop toggle on the armed tool commits a closed control-form spline whose tessellation returns to its start', () => {
    const store = useCamStore.getState()
    store.setViewerMode('sketch')
    const before = new Set((useCamStore.getState().activeSketch?.entities ?? []).map((e) => e.id))
    sketcherTools.setSplineClosed(true)
    sketcherTools.armTool('spline-control')
    for (const p of HEX) sketcherTools.click(p, 0.05, null, false)
    sketcherTools.end()
    sketcherTools.setSplineClosed(false)
    const e = (useCamStore.getState().activeSketch?.entities ?? []).find((x) => !before.has(x.id)) as SketchSplineEntity
    expect(e.form).toBe('control')
    expect(e.closed).toBe(true)
    const drawn = layer.tessellateSpline(e)
    expect(drawn[0].equals(drawn[drawn.length - 1])).toBe(true)
  })

  it('close-on-start (click the first control point again) also closes it', () => {
    let st: ToolState = { tool: 'spline-control', chain: null }
    let commit = null
    for (const p of [...HEX.slice(0, 4), HEX[0]]) {
      const r = toolClick(st, p, 0.05, newId)
      st = r.state
      commit = r.commit ?? commit
    }
    const e = commit!.entities[0] as SketchSplineEntity
    expect(e.form).toBe('control')
    expect(e.closed).toBe(true)
    expect(e.points).toEqual(HEX.slice(0, 4))
  })
})

// ---- 4. Bake and contour toolpath ---------------------------------------------------

function makeTool(diameterMm: number): Tool {
  return {
    id: 't1', name: `O${diameterMm} flat`, type: 'flat_end_mill',
    diameter: diameterMm, fluteLength: 20, shankDiameter: Math.min(diameterMm, 6), overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
  } as Tool
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

describe('WO-1861: it bakes to a loop and a contour follows the curve', () => {
  const exact = denseCurve((q) => splinePointAt(HEX, true, q, 'control'), 6, 60000)

  it('the baked closed loop lies on the true curve and its chord deviation is inside the tessellation tolerance', () => {
    const baked = bakeSketch(sketchOf([cpSpline('blob', HEX, true)]))
    expect(baked.loops).toHaveLength(1)
    const loop = baked.loops[0]
    expect(loop.closed).toBe(true)
    // every vertex is an exact curve sample
    for (const p of loop.points) expect(distToPolyline(p, exact)).toBeLessThan(1e-4)
    // chord deviation: every chord midpoint within the sagitta a 0.3 mm chord
    // step allows on this curve (well under 0.01 mm) of the exact curve
    let worst = 0
    const pts = [...loop.points, loop.points[0]]
    for (let i = 0; i + 1 < pts.length; i++) {
      expect(d(pts[i], pts[i + 1])).toBeLessThanOrEqual(SPLINE_TESS_STEP_MM + 1e-9)
      worst = Math.max(worst, distToPolyline(lerp(pts[i], pts[i + 1], 0.5), exact))
    }
    expect(worst).toBeLessThan(0.01)
    // and the loop is NOT the control polygon: it stays well inside the hexagon corners
    for (const c of HEX) expect(distToPolyline(c, pts)).toBeGreaterThan(3)
  })

  it('an outside contour over the baked loop runs one tool radius off the CURVE, not off the control polygon', () => {
    const loops = bakeSketch(sketchOf([cpSpline('blob', HEX, true)])).loops as unknown as LoopData[]
    const payload: ContourWorkerPayload = {
      opId: 'op', setupId: 's',
      params: { geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs: false } as ContourParams,
      heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: makeTool(6), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    const cuts = buildContourToolpath(payload).filter((m) => m.role === 'cut').map((m) => ({ x: m.x, y: m.y }))
    expect(cuts.length).toBeGreaterThan(20)
    const polygon = [...HEX, HEX[0]]
    let worstCurve = 0, worstPolygon = 0
    for (const p of cuts) {
      worstCurve = Math.max(worstCurve, Math.abs(distToPolyline(p, exact) - 3))
      worstPolygon = Math.max(worstPolygon, Math.abs(distToPolyline(p, polygon) - 3))
    }
    expect(worstCurve).toBeLessThan(0.02)
    expect(worstPolygon).toBeGreaterThan(2)
  })
})

// ---- 5. The census the existing spline passes ----------------------------------------

describe('WO-1861: save/reload, copy/paste, undo/redo, mirror, pattern, split', () => {
  it('survives a JSON round trip (the project persist path) with its form and shape', () => {
    const sk = sketchOf([cpSpline('s', TEN)])
    const reloaded = JSON.parse(JSON.stringify(sk)) as Sketch
    const e = reloaded.entities[0] as SketchSplineEntity
    expect(e.form).toBe('control')
    expect(tessellateSpline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form))
      .toEqual(tessellateSpline(TEN, false, SPLINE_TESS_STEP_MM, 'control'))
  })

  it('copy/paste re-IDs it and the copy is still a control-point spline with draggable control points', () => {
    const sk = sketchOf([cpSpline('s', FOUR)])
    const payload = captureSketchClipboard(sk, ['s'])!
    const paste = instantiateSketchClipboard(payload, { x: 100, y: 100 }, newId, ['s'])
    expect(paste.entities).toHaveLength(1)
    const e = paste.entities[0] as SketchSplineEntity
    expect(e.id).not.toBe('s')
    expect(e.form).toBe('control')
    const delta = { x: e.points[0].x - FOUR[0].x, y: e.points[0].y - FOUR[0].y }
    e.points.forEach((p, i) => expect(d(p, { x: FOUR[i].x + delta.x, y: FOUR[i].y + delta.y })).toBeLessThan(1e-9))
    expect(splineControlPointDragTarget(e, e.points[2], 0.5)?.point).toEqual({ entityId: e.id, site: 'cp2' })
  })

  it('undo removes the drawn spline in one step and redo brings it back as a control-point spline', () => {
    const store = useCamStore.getState()
    store.setViewerMode('sketch')
    const count = () => (useCamStore.getState().activeSketch?.entities ?? []).filter((e) => e.kind === 'spline').length
    const before = count()
    sketcherTools.armTool('spline-control')
    for (const p of FOUR) sketcherTools.click({ x: p.x + 200, y: p.y }, 0.05, null, false)
    sketcherTools.end()
    expect(count()).toBe(before + 1)
    useCamStore.getState().undo()
    expect(count()).toBe(before)
    useCamStore.getState().redo()
    expect(count()).toBe(before + 1)
    const back = (useCamStore.getState().activeSketch?.entities ?? [])
      .filter((e): e is SketchSplineEntity => e.kind === 'spline')
      .find((e) => e.points[0].x === 200)!
    expect(back.form).toBe('control')
  })

  it('mirror makes the reflected control-point spline (its curve is the mirror of the original to 1e-9 mm)', () => {
    const axis: SketchEntity = { id: 'ax', kind: 'line', construction: true, start: { x: -10, y: -5 }, end: { x: 60, y: 45 } }
    const r = mirrorEntities([cpSpline('s', FOUR), axis], ['s'], 'ax', newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const m = r.entities[0] as SketchSplineEntity
    expect(m.form).toBe('control')
    const u = { x: 70 / Math.hypot(70, 50), y: 50 / Math.hypot(70, 50) }
    const reflect = (p: Pt): Pt => {
      const v = { x: p.x + 10, y: p.y + 5 }
      const k = v.x * u.x + v.y * u.y
      return { x: 2 * k * u.x - v.x - 10, y: 2 * k * u.y - v.y - 5 }
    }
    for (let i = 0; i <= 60; i++) {
      const q = (3 * i) / 60
      expect(d(splinePointAt(m.points, false, q, 'control'), reflect(splinePointAt(FOUR, false, q, 'control'))))
        .toBeLessThan(1e-9)
    }
    expect(r.constraints.some((c) => c.kind === 'symmetric')).toBe(true)
  })

  it('a linear pattern copy keeps the control-point form and is the translated curve', () => {
    const r = linearPattern([cpSpline('s', FOUR)], [], ['s'], 3, { x: 0, y: 50 }, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const copies = r.entities.filter((e): e is SketchSplineEntity => e.kind === 'spline')
    expect(copies.length).toBe(2)
    for (const c of copies) {
      expect(c.form).toBe('control')
      const dy = c.points[0].y
      expect(d(splinePointAt(c.points, false, 1.3, 'control'),
        { x: splinePointAt(FOUR, false, 1.3, 'control').x, y: splinePointAt(FOUR, false, 1.3, 'control').y + dy }))
        .toBeLessThan(1e-9)
    }
  })

  it('split cuts it at the clicked point into two pieces that trace the original curve', () => {
    const e = cpSpline('s', TEN)
    const click = splinePointAt(TEN, false, 4.2, 'control')
    const r = splitClick(null, { entities: [e], constraints: [], dimensions: [] }, click, 0.5, newId)
    expect(r.transform).not.toBeNull()
    const pieces = r.transform!.entities.filter((x): x is SketchSplineEntity => x.kind === 'spline')
    expect(pieces).toHaveLength(2)
    const exact = denseCurve((q) => splinePointAt(TEN, false, q, 'control'), 9, 40000)
    for (const piece of pieces) {
      expect(piece.form).toBeUndefined() // dense through-points (decide-and-log)
      for (const p of tessellateSpline(piece.points, false, SPLINE_TESS_STEP_MM, piece.form)) {
        expect(distToPolyline(p, exact)).toBeLessThan(2e-3)
      }
    }
    expect(d(pieces[0].points[0], TEN[0])).toBeLessThan(1e-9)
    expect(d(pieces[1].points[pieces[1].points.length - 1], TEN[9])).toBeLessThan(1e-9)
    expect(d(pieces[0].points[pieces[0].points.length - 1], click)).toBeLessThan(1e-3)
  })

  it('fillet against a line resolves (the host is rebuilt as the through-point spline tracing the same curve)', () => {
    const e = cpSpline('s', FOUR)
    // the vertical line x=25 crosses the curve at its apex
    const apex = splinePointAt(FOUR, false, nearestParamOnSpline(FOUR, false, { x: 25, y: 30 }, 'control'), 'control')
    expect(Math.abs(apex.x - 25)).toBeLessThan(1e-3)
    const line: SketchEntity = { id: 'L', kind: 'line', construction: false, start: { x: 25, y: -10 }, end: { x: 25, y: 40 } }
    const r = filletLines(
      { entities: [e, line], constraints: [], dimensions: [] },
      'L', 's', { x: 25, y: -5 }, { x: 5, y: 10 }, 2, newId,
    )
    expect(typeof r, typeof r === 'string' ? r : '').not.toBe('string')
    if (typeof r === 'string') return
    const host = r.transform.entities.find((x) => x.id === 's') as SketchSplineEntity
    expect(host.form).toBeUndefined()
    const exact = denseCurve((q) => splinePointAt(FOUR, false, q, 'control'), 3)
    for (const p of host.filletSourcePoints ?? host.points) expect(distToPolyline(p, exact)).toBeLessThan(1e-3)
  })

  it('splineAsThroughPoints leaves a through-point spline untouched', () => {
    const fit: SketchSplineEntity = { id: 'f', kind: 'spline', construction: false, points: FOUR, closed: false }
    expect(splineAsThroughPoints(fit)).toBe(fit)
  })
})
