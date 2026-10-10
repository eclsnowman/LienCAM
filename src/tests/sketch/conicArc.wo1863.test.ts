// WO-1863: a conic arc from two endpoints, an apex and a rho.
//
// The conic is the EXISTING `spline` entity with `form: 'conic'`: one rational
// quadratic bezier over start / apex / end with apex weight rho / (1 - rho),
// stored as start, apex, SHOULDER, end (spline.ts). Every claim below runs
// through the production entry points: the armed tool in the real store
// (sketcherTools), the sketch layer's own tessellation, the toolbox rho
// actions, the solver mapping's drag, bakeSketch, the contour toolpath
// builder, clipboard, mirror and pattern. The reference curve is INDEPENDENT
// of the evaluator under test: the pencil of conics tangent to the two apex
// legs at the endpoints, L0 x L2 = k x C^2 (C the chord), with k fixed by the
// shoulder the acceptance names -- rho of the way from the chord midpoint to
// the apex. Its quadratic part's discriminant says which conic it is.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { Sketch, SketchEntity, SketchSplineEntity, Vec2 } from '../../lib/sketch/types'
import {
  splinePointAt, splineDerivativeAt, tessellateSpline, splineControlPointDragTarget,
  splineHandleLegs, conicRho, conicPoints, CONIC_RHO_MAX, SPLINE_TESS_STEP_MM,
} from '../../lib/sketch/spline'
import { toolClick, toolPreview, ARMABLE_TOOLS, type ToolState } from '../../lib/sketch/tools/toolMachine'
import { toolOverlay } from '../../lib/sketch/tools/toolOverlay'
import { toolStepStatus } from '../../lib/sketch/tools/toolSteps'
import { bakeSketch } from '../../lib/sketch/bake'
import { solveSketchOnWrapper, type DragRequest } from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { captureSketchClipboard, instantiateSketchClipboard } from '../../lib/sketch/clipboard'
import { mirrorEntities } from '../../lib/sketch/tools/mirrorTool'
import { linearPattern } from '../../lib/sketch/tools/patternTools'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// ---- store stubs (same pattern as controlPointSpline.wo1861.test.ts) ----
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
afterEach(() => { vi.restoreAllMocks() })

let n = 0
const newId = () => `wo1863-${n++}`

type Pt = Vec2
const d = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const mid = (a: Pt, b: Pt): Pt => lerp(a, b, 0.5)

// The three points every acceptance check uses: an asymmetric apex, so no
// symmetry can hide an error.
const P0: Pt = { x: 0, y: 0 }
const P2: Pt = { x: 60, y: 10 }
const APEX: Pt = { x: 22, y: 40 }

// ---- the independent reference conic ---------------------------------------------

/** Signed line through `a` along `u`: cross(u, X - a), with its gradient. */
function lineFn(a: Pt, u: Pt) {
  return {
    at: (x: Pt) => u.x * (x.y - a.y) - u.y * (x.x - a.x),
    grad: { x: -u.y, y: u.x },
  }
}

/**
 * The exact conic through P0 and P2, tangent there to the legs P0-A and A-P2,
 * through the shoulder M + rho (A - M): F = L0 L2 - k C^2 = 0. Returns the
 * distance (first order, |F| / |grad F|) of a point from it, and the
 * normalised discriminant of its quadratic part (0 parabola, < 0 ellipse,
 * > 0 hyperbola).
 */
function exactConic(p0: Pt, apex: Pt, p2: Pt, rho: number) {
  const L0 = lineFn(p0, { x: apex.x - p0.x, y: apex.y - p0.y })
  const L2 = lineFn(apex, { x: p2.x - apex.x, y: p2.y - apex.y })
  const C = lineFn(p0, { x: p2.x - p0.x, y: p2.y - p0.y })
  const shoulder = lerp(mid(p0, p2), apex, rho)
  const k = (L0.at(shoulder) * L2.at(shoulder)) / C.at(shoulder) ** 2
  const F = (x: Pt) => L0.at(x) * L2.at(x) - k * C.at(x) ** 2
  const gradF = (x: Pt): Pt => ({
    x: L2.at(x) * L0.grad.x + L0.at(x) * L2.grad.x - 2 * k * C.at(x) * C.grad.x,
    y: L2.at(x) * L0.grad.y + L0.at(x) * L2.grad.y - 2 * k * C.at(x) * C.grad.y,
  })
  const A = L0.grad.x * L2.grad.x - k * C.grad.x ** 2
  const B = L0.grad.x * L2.grad.y + L0.grad.y * L2.grad.x - 2 * k * C.grad.x * C.grad.y
  const Cc = L0.grad.y * L2.grad.y - k * C.grad.y ** 2
  return {
    shoulder,
    dist: (x: Pt) => Math.abs(F(x)) / Math.hypot(gradF(x).x, gradF(x).y),
    discriminant: (B * B - 4 * A * Cc) / (B * B + 4 * Math.abs(A * Cc)),
  }
}

/** Dense samples of the exact conic arc from its closed form -- the rational
 *  quadratic Bernstein form, written out here, never the product evaluator.
 *  The first describe block checks these samples against the pencil too. */
function exactArcSamples(p0: Pt, apex: Pt, p2: Pt, rho: number, count = 20000): Pt[] {
  const w = rho / (1 - rho)
  const out: Pt[] = []
  for (let i = 0; i <= count; i++) {
    const t = i / count, s = 1 - t
    const b0 = s * s, b1 = 2 * s * t * w, b2 = t * t
    const den = b0 + b1 + b2
    out.push({
      x: (b0 * p0.x + b1 * apex.x + b2 * p2.x) / den,
      y: (b0 * p0.y + b1 * apex.y + b2 * p2.y) / den,
    })
  }
  return out
}

/** Largest distance of any point from the exact conic. */
function worstOff(pts: readonly Pt[], p0: Pt, apex: Pt, p2: Pt, rho: number): number {
  const ref = exactConic(p0, apex, p2, rho)
  return pts.reduce((w, p) => Math.max(w, ref.dist(p)), 0)
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

const sinBetween = (a: Pt, b: Pt): number =>
  Math.abs(a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))

function sketchOf(entities: SketchEntity[]): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints: [], dimensions: [], solveStatus: null }
}
function conic(id: string, rho: number, p0 = P0, apex = APEX, p2 = P2): SketchSplineEntity {
  return { id, kind: 'spline', construction: false, closed: false, form: 'conic', points: conicPoints(p0, apex, p2, rho) }
}
const entityById = (id: string) =>
  useCamStore.getState().activeSketch!.entities.find((x) => x.id === id) as SketchSplineEntity

/** Draw one conic with the armed tool in the real store: rho from the tool's
 *  rho row, then start, end, apex. */
function drawWithArmedTool(rho: number, p0 = P0, apex = APEX, p2 = P2): SketchSplineEntity {
  const store = useCamStore.getState()
  store.setViewerMode('sketch') // auto-creates a blank active sketch
  const before = new Set((useCamStore.getState().activeSketch?.entities ?? []).map((e) => e.id))
  sketcherTools.armTool('conic')
  sketcherTools.setConicDrawRho(rho)
  // The CAM host's gesture hook (Viewport's SketchUndoSink): one undo step per click gesture.
  const gesture = () => useCamStore.getState().pushHistory()
  for (const p of [p0, p2, apex]) sketcherTools.click(p, 0.05, null, false, gesture)
  const added = (useCamStore.getState().activeSketch?.entities ?? []).filter((e) => !before.has(e.id))
  expect(added).toHaveLength(1)
  expect(added[0].kind).toBe('spline')
  return added[0] as SketchSplineEntity
}

// ---- 1. The drawn arc is the exact conic ---------------------------------------------

describe('WO-1863: start, end and apex with a rho draw the exact conic', () => {
  it('the armed tool commits ONE conic-form spline after the apex click', () => {
    expect(ARMABLE_TOOLS.has('conic')).toBe(true)
    const e = drawWithArmedTool(0.5)
    expect(e.form).toBe('conic')
    expect(e.closed).toBe(false)
    expect(e.points[0]).toEqual(P0)
    expect(e.points[1]).toEqual(APEX)
    expect(e.points[3]).toEqual(P2)
    expect(sketcherToolStore.getState().tool).toBe('conic') // armed for the next one
    expect(sketcherToolStore.getState().chain).toBeNull()
  })

  it('rho = 0.5: what the sketch layer draws is the parabola tangent to both apex legs, to 1e-9 mm', () => {
    const e = drawWithArmedTool(0.5)
    const drawn = layer.tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
    expect(drawn.length).toBeGreaterThan(50)
    expect(drawn[0]).toEqual(P0)
    expect(drawn[drawn.length - 1]).toEqual(P2)
    expect(worstOff(drawn, P0, APEX, P2, 0.5)).toBeLessThan(1e-9)
    expect(Math.abs(exactConic(P0, APEX, P2, 0.5).discriminant)).toBeLessThan(1e-12) // a parabola
  })

  for (const [rho, kind] of [[0.3, 'ellipse'], [0.7, 'hyperbola']] as const) {
    it(`rho = ${rho}: the drawn arc is the exact ${kind} for the same three points, to 1e-9 mm`, () => {
      const e = drawWithArmedTool(rho)
      const drawn = layer.tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
      expect(worstOff(drawn, P0, APEX, P2, rho)).toBeLessThan(1e-9)
      // and every point of the native curve, not only the drawn vertices
      const dense = Array.from({ length: 301 }, (_, i) => splinePointAt(e.points, false, (3 * i) / 300, 'conic'))
      expect(worstOff(dense, P0, APEX, P2, rho)).toBeLessThan(1e-9)
      // the test's own closed-form samples are that conic too (they are the
      // reference the bake and contour checks below measure against)
      expect(worstOff(exactArcSamples(P0, APEX, P2, rho, 2000), P0, APEX, P2, rho)).toBeLessThan(1e-9)
      const disc = exactConic(P0, APEX, P2, rho).discriminant
      if (kind === 'ellipse') expect(disc).toBeLessThan(-1e-3)
      else expect(disc).toBeGreaterThan(1e-3)
    })
  }

  it('for every rho the parameter-0.5 point is the shoulder: rho of the way from the chord midpoint to the apex', () => {
    for (const rho of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
      const e = drawWithArmedTool(rho)
      // the shared domain is [0, 3], so bezier t = 0.5 is q = 1.5
      const half = splinePointAt(e.points, false, 1.5, 'conic')
      expect(d(half, lerp(mid(P0, P2), APEX, rho))).toBeLessThan(1e-9)
      expect(Math.abs(conicRho(e.points) - rho)).toBeLessThan(1e-12)
    }
  })

  it('the arc is tangent to the apex legs at both ends', () => {
    for (const rho of [0.3, 0.5, 0.7]) {
      const e = conic('t', rho)
      const t0 = splineDerivativeAt(e.points, false, 0, 'conic')
      const t1 = splineDerivativeAt(e.points, false, 3, 'conic')
      expect(sinBetween(t0, { x: APEX.x - P0.x, y: APEX.y - P0.y })).toBeLessThan(1e-4)
      expect(sinBetween(t1, { x: P2.x - APEX.x, y: P2.y - APEX.y })).toBeLessThan(1e-4)
    }
  })

  it('the tool steps read start, end, apex and the prompt bar names the tool', () => {
    let st: ToolState = { tool: 'conic', chain: null }
    expect(toolStepStatus(st)!.step.id).toBe('start')
    st = toolClick(st, P0, 0.05, newId, { entities: [], conicRho: 0.3 }).state
    expect(toolStepStatus(st)!.step.id).toBe('end')
    st = toolClick(st, P2, 0.05, newId, { entities: [], conicRho: 0.9 }).state
    expect(toolStepStatus(st)!.step.id).toBe('apex')
    // a started chain keeps the rho it started at
    expect(st.chain).toMatchObject({ kind: 'conic', rho: 0.3 })
  })

  it('while placing the apex the rubber band IS the arc the click commits, and the overlay ghosts the legs', () => {
    let st: ToolState = { tool: 'conic', chain: null }
    st = toolClick(st, P0, 0.05, newId, { entities: [], conicRho: 0.7 }).state
    const band = toolPreview(st, P2)!
    expect(band).toEqual([P0, P2]) // a straight line while the end is placed
    st = toolClick(st, P2, 0.05, newId, { entities: [] }).state
    const preview = toolPreview(st, APEX)!
    const r = toolClick(st, APEX, 0.05, newId, { entities: [] })
    const committed = r.commit!.entities[0] as SketchSplineEntity
    expect(preview).toEqual(tessellateSpline(committed.points, false, SPLINE_TESS_STEP_MM, 'conic'))
    expect(worstOff(preview, P0, APEX, P2, 0.7)).toBeLessThan(1e-9)
    const ov = toolOverlay(st, APEX, 0.05, { entities: [] })!
    expect(ov.ghosts).toEqual(splineHandleLegs(committed.points, false, 'conic'))
    expect(ov.ghosts![0]).toEqual([P0, APEX, P2])
    expect(ov.markers).toEqual([P0, committed.points[2], P2])
  })
})

// ---- 2. The refusal bar (rule 11) ---------------------------------------------

describe('WO-1863: rho 0 draws the chord; out-of-range rho is drawn clamped with one console line', () => {
  it('rho = 0 is drawn, not clamped: the arc is the straight chord', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const e = drawWithArmedTool(0)
    expect(info).not.toHaveBeenCalled()
    expect(conicRho(e.points)).toBe(0)
    const C = lineFn(P0, { x: P2.x - P0.x, y: P2.y - P0.y })
    for (const p of tessellateSpline(e.points, false, SPLINE_TESS_STEP_MM, 'conic')) {
      expect(Math.abs(C.at(p)) / d(P0, P2)).toBeLessThan(1e-9)
    }
  })

  for (const [asked, drawnRho] of [[1.4, CONIC_RHO_MAX], [1, CONIC_RHO_MAX], [-0.25, 0]] as const) {
    it(`rho = ${asked} has no single arc: it is drawn at rho ${drawnRho} and says so once on the console`, () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const e = drawWithArmedTool(asked)
      expect(e.form).toBe('conic') // the operator's picks are kept
      expect(e.points[0]).toEqual(P0)
      expect(e.points[3]).toEqual(P2)
      expect(Math.abs(conicRho(e.points) - drawnRho)).toBeLessThan(1e-12)
      expect(info).toHaveBeenCalledTimes(1)
      expect(String(info.mock.calls[0][0])).toContain(`drawn at rho ${drawnRho}`)
      const drawn = layer.tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
      if (drawnRho === 0) {
        // rho 0 is the degenerate conic: the chord itself
        const C = lineFn(P0, { x: P2.x - P0.x, y: P2.y - P0.y })
        for (const p of drawn) expect(Math.abs(C.at(p)) / d(P0, P2)).toBeLessThan(1e-9)
      } else {
        expect(worstOff(drawn, P0, APEX, P2, drawnRho)).toBeLessThan(1e-9)
      }
    })
  }
})

// ---- 3. Editing rho and dragging ---------------------------------------------------

describe('WO-1863: rho is editable after the fact; dragging keeps it', () => {
  it('editing rho on a placed conic reshapes it in place with both endpoints and the apex unmoved (one undo step)', () => {
    const e = drawWithArmedTool(0.3)
    useCamStore.setState({ sketchSelectedIds: [e.id] } as never)
    expect(sketcherTools.conicsInSelection()).toEqual({ entityIds: [e.id], rho: 0.3, mixed: false })
    sketcherTools.setSelectedConicsRho(0.7)
    const edited = entityById(e.id)
    expect(edited.form).toBe('conic')
    expect(edited.points[0]).toEqual(P0)
    expect(edited.points[1]).toEqual(APEX)
    expect(edited.points[3]).toEqual(P2)
    expect(Math.abs(conicRho(edited.points) - 0.7)).toBeLessThan(1e-12)
    const drawn = layer.tessellateSpline(edited).map((v) => ({ x: v.x, y: v.y }))
    expect(worstOff(drawn, P0, APEX, P2, 0.7)).toBeLessThan(1e-9)
    useCamStore.getState().undo()
    expect(Math.abs(conicRho(entityById(e.id).points) - 0.3)).toBeLessThan(1e-12)
  })

  it('the store drag begun ON the apex pins the apex as its own solver site', async () => {
    const e = conic('cq', 0.3)
    useCamStore.setState({
      activeSketch: sketchOf([e]),
      sketchSolveStatus: null,
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTool: 'select', sketchToolChain: null,
      sketchTextEditId: null, sketchPickPathForTextId: null,
    } as never)
    const st = useCamStore.getState()
    expect(st.beginSketchDrag('cq', { x: APEX.x + 0.1, y: APEX.y }, 0.5)).toBe(true)
    st.moveSketchDrag({ x: 30, y: 50 })
    await new Promise((r) => setTimeout(r, 40)) // past the store's 25 ms drag-solve debounce
    const drags = postedMessages.filter((m) => m.type === 'DRAG_SOLVE')
    expect(drags.length).toBeGreaterThan(0)
    const targets = drags[drags.length - 1].payload!.drag!.targets
    expect(targets).toHaveLength(1)
    expect(targets[0].point).toEqual({ entityId: 'cq', site: 'cp1' })
    st.endSketchDrag(undefined)
  })

  async function dragPoint(e: SketchSplineEntity, index: number, to: Pt): Promise<SketchSplineEntity> {
    const target = splineControlPointDragTarget(e, e.points[index], 1e-6)!
    expect(target.point.site).toBe(`cp${index}`)
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketchOf([e]), { targets: [{ point: target.point, to }] })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('drag solve failed')
    return out.entities[0] as SketchSplineEntity
  }

  it('dragging an endpoint or the apex reshapes the conic and preserves rho', async () => {
    for (const rho of [0.3, 0.7]) {
      const e = conic('dr', rho)
      const cases: Array<[number, Pt]> = [[0, { x: -8, y: 6 }], [1, { x: 35, y: 55 }], [3, { x: 70, y: -5 }]]
      for (const [index, to] of cases) {
        const moved = await dragPoint(e, index, to)
        expect(moved.form).toBe('conic')
        expect(d(moved.points[index], to)).toBeLessThan(1e-6)
        const [s, a, , en] = moved.points
        for (const i of [0, 1, 3].filter((i) => i !== index)) expect(moved.points[i]).toEqual(e.points[i])
        expect(Math.abs(conicRho(moved.points) - rho)).toBeLessThan(1e-9)
        // the reshaped arc is the exact conic of the NEW three points at the same rho
        const dense = Array.from({ length: 201 }, (_, i) => splinePointAt(moved.points, false, (3 * i) / 200, 'conic'))
        expect(worstOff(dense, s, a, en, rho)).toBeLessThan(1e-9)
      }
    }
  })

  it('dragging the shoulder sets rho: it slides along the median, the other three points stay put', async () => {
    const e = conic('sh', 0.5)
    const target = lerp(mid(P0, P2), APEX, 0.8)
    const moved = await dragPoint(e, 2, { x: target.x + 3, y: target.y - 1 }) // off the median on purpose
    for (const i of [0, 1, 3]) expect(moved.points[i]).toEqual(e.points[i])
    const r = conicRho(moved.points)
    expect(r).toBeGreaterThan(0.6)
    expect(worstOff([moved.points[2]], P0, APEX, P2, r)).toBeLessThan(1e-9) // back on the curve
    expect(d(splinePointAt(moved.points, false, 1.5, 'conic'), lerp(mid(P0, P2), APEX, r))).toBeLessThan(1e-9)
  })

  it('a plain solve (no drag) leaves a conic exactly as stored', async () => {
    const e = conic('ps', 0.7)
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketchOf([e]))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((out.entities[0] as SketchSplineEntity).points).toEqual(e.points)
  })
})

// ---- 4. Bake and contour toolpath -----------------------------------------------------

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

describe('WO-1863: it bakes and a contour follows the true conic', () => {
  const RHO = 0.7
  const exactArc = exactArcSamples(P0, APEX, P2, RHO)

  it('the baked arc lies on the exact conic and every chord is inside the tessellation tolerance', () => {
    const baked = bakeSketch(sketchOf([conic('c', RHO)]))
    expect(baked.loops).toHaveLength(1)
    const loop = baked.loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.points[0]).toEqual(P0)
    expect(loop.points[loop.points.length - 1]).toEqual(P2)
    expect(worstOff(loop.points, P0, APEX, P2, RHO)).toBeLessThan(1e-9)
    let worstSag = 0
    for (let i = 0; i + 1 < loop.points.length; i++) {
      expect(d(loop.points[i], loop.points[i + 1])).toBeLessThanOrEqual(SPLINE_TESS_STEP_MM + 1e-9)
      worstSag = Math.max(worstSag, distToPolyline(lerp(loop.points[i], loop.points[i + 1], 0.5), exactArc))
    }
    expect(worstSag).toBeLessThan(0.01)
  })

  it('an open contour one tool radius to the side runs 3 mm off the CONIC, not off the apex legs', () => {
    // A spline bakes to its own open loop (it never chains with lines -- the
    // existing spline behaviour), so the contour is the open-chain planner.
    const loops = bakeSketch(sketchOf([conic('c', RHO)])).loops as unknown as LoopData[]
    expect(loops).toHaveLength(1)
    const payload: ContourWorkerPayload = {
      opId: 'op', setupId: 's',
      params: {
        geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs: false,
        pathType: 'open', openSide: 'right',
      } as ContourParams,
      heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: makeTool(6), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
      stockBounds: { min: { x: -20, y: -20 }, max: { x: 80, y: 60 } },
    } as ContourWorkerPayload
    const cuts = buildContourToolpath(payload).filter((m) => m.role === 'cut').map((m) => ({ x: m.x, y: m.y }))
    // the cut points beside the arc body (away from the stock-edge entry and exit runs)
    const beside = cuts.filter((p) => distToPolyline(p, exactArc) < 5 && d(p, P0) > 6 && d(p, P2) > 6)
    expect(beside.length).toBeGreaterThan(20)
    const legs = [P0, APEX, P2]
    let worstCurve = 0, worstLegs = 0
    for (const p of beside) {
      worstCurve = Math.max(worstCurve, Math.abs(distToPolyline(p, exactArc) - 3))
      worstLegs = Math.max(worstLegs, Math.abs(distToPolyline(p, legs) - 3))
    }
    expect(worstCurve).toBeLessThan(0.02)
    expect(worstLegs).toBeGreaterThan(1)
  })
})

// ---- 5. The census the existing spline passes -------------------------------------------

describe('WO-1863: save/reload, copy/paste, undo/redo, mirror, pattern', () => {
  it('survives a JSON round trip (the project persist path) with its form, rho and shape', () => {
    const sk = sketchOf([conic('s', 0.3)])
    const reloaded = JSON.parse(JSON.stringify(sk)) as Sketch
    const e = reloaded.entities[0] as SketchSplineEntity
    expect(e.form).toBe('conic')
    expect(Math.abs(conicRho(e.points) - 0.3)).toBeLessThan(1e-12)
    expect(tessellateSpline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form))
      .toEqual(tessellateSpline(conic('s', 0.3).points, false, SPLINE_TESS_STEP_MM, 'conic'))
  })

  it('copy/paste re-IDs it and the copy is the translated conic at the same rho', () => {
    const sk = sketchOf([conic('s', 0.7)])
    const payload = captureSketchClipboard(sk, ['s'])!
    const paste = instantiateSketchClipboard(payload, { x: 100, y: 100 }, newId, ['s'])
    expect(paste.entities).toHaveLength(1)
    const e = paste.entities[0] as SketchSplineEntity
    expect(e.id).not.toBe('s')
    expect(e.form).toBe('conic')
    expect(Math.abs(conicRho(e.points) - 0.7)).toBeLessThan(1e-9)
    const t = { x: e.points[0].x - P0.x, y: e.points[0].y - P0.y }
    const sh = (p: Pt): Pt => ({ x: p.x + t.x, y: p.y + t.y })
    const dense = Array.from({ length: 101 }, (_, i) => splinePointAt(e.points, false, (3 * i) / 100, 'conic'))
    expect(worstOff(dense, sh(P0), sh(APEX), sh(P2), 0.7)).toBeLessThan(1e-9)
    expect(splineControlPointDragTarget(e, e.points[1], 0.5)?.point).toEqual({ entityId: e.id, site: 'cp1' })
  })

  it('undo removes the drawn conic in one step and redo brings it back as a conic', () => {
    const count = () => (useCamStore.getState().activeSketch?.entities ?? []).filter((e) => e.kind === 'spline').length
    useCamStore.getState().setViewerMode('sketch')
    const before = count()
    const e = drawWithArmedTool(0.3, { x: 200, y: 0 }, { x: 222, y: 40 }, { x: 260, y: 10 })
    expect(count()).toBe(before + 1)
    useCamStore.getState().undo()
    expect(count()).toBe(before)
    useCamStore.getState().redo()
    expect(count()).toBe(before + 1)
    const back = entityById(e.id)
    expect(back.form).toBe('conic')
    expect(Math.abs(conicRho(back.points) - 0.3)).toBeLessThan(1e-12)
  })

  it('mirror makes the reflected conic at the same rho (the exact conic of the mirrored points)', () => {
    const axis: SketchEntity = { id: 'ax', kind: 'line', construction: true, start: { x: -10, y: -5 }, end: { x: 60, y: 45 } }
    const r = mirrorEntities([conic('s', 0.3), axis], ['s'], 'ax', newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const m = r.entities[0] as SketchSplineEntity
    expect(m.form).toBe('conic')
    const u = { x: 70 / Math.hypot(70, 50), y: 50 / Math.hypot(70, 50) }
    const reflect = (p: Pt): Pt => {
      const v = { x: p.x + 10, y: p.y + 5 }
      const k = v.x * u.x + v.y * u.y
      return { x: 2 * k * u.x - v.x - 10, y: 2 * k * u.y - v.y - 5 }
    }
    expect(Math.abs(conicRho(m.points) - 0.3)).toBeLessThan(1e-9)
    for (let i = 0; i <= 60; i++) {
      const q = (3 * i) / 60
      expect(d(splinePointAt(m.points, false, q, 'conic'), reflect(splinePointAt(conic('s', 0.3).points, false, q, 'conic'))))
        .toBeLessThan(1e-9)
    }
    expect(r.constraints.some((c) => c.kind === 'symmetric')).toBe(true)
  })

  it('a linear pattern copy keeps the conic form and rho and is the translated curve', () => {
    const r = linearPattern([conic('s', 0.7)], [], ['s'], 3, { x: 0, y: 50 }, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const copies = r.entities.filter((e): e is SketchSplineEntity => e.kind === 'spline')
    expect(copies.length).toBe(2)
    for (const c of copies) {
      expect(c.form).toBe('conic')
      expect(Math.abs(conicRho(c.points) - 0.7)).toBeLessThan(1e-9)
      const dy = c.points[0].y
      const at = splinePointAt(conic('s', 0.7).points, false, 1.3, 'conic')
      expect(d(splinePointAt(c.points, false, 1.3, 'conic'), { x: at.x, y: at.y + dy })).toBeLessThan(1e-9)
    }
  })
})
