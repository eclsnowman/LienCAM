// WO-1862: a bezier curve in a sketch.
//
// A bezier is the EXISTING `spline` entity with `form: 'bezier'`: `points` is a
// chain anchor, out-handle, in-handle, anchor, ... and every segment is a
// single-span cubic B-spline over its four points, evaluated by WO-1861's
// evalNurbs (no second curve engine). Every claim below runs through the
// production entry points: the armed tool in the real store (sketcherTools --
// bezierPress is what the viewport calls at pointerdown, click at pointerup),
// the sketch layer's own tessellation and pick, bakeSketch, the contour
// toolpath builder, the store's drag begin + the solver mapping, the shared
// Smooth / Corner action, clipboard, mirror and pattern. The reference curve
// is the INDEPENDENT closed-form cubic Bernstein polynomial.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Sketch, SketchEntity, SketchSplineEntity, Vec2 } from '../../lib/sketch/types'
import {
  splinePointAt, splineDerivativeAt, tessellateSpline, splineControlPointDragTarget,
  splineDragEdit, bezierSetJointSmooth, bezierJoints, bezierJointSummary, splineHandleLegs,
  splineAsThroughPoints, SPLINE_TESS_STEP_MM,
} from '../../lib/sketch/spline'
import { toolClick, toolPreview, ARMABLE_TOOLS, type ToolState } from '../../lib/sketch/tools/toolMachine'
import { toolOverlay } from '../../lib/sketch/tools/toolOverlay'
import { bezierPress, bezierFinish } from '../../lib/sketch/tools/splineTools'
import { toolStepStatus } from '../../lib/sketch/tools/toolSteps'
import { bakeSketch } from '../../lib/sketch/bake'
import { findSnap } from '../../lib/sketch/snap'
import { solveSketchOnWrapper, type DragRequest } from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { captureSketchClipboard, instantiateSketchClipboard } from '../../lib/sketch/clipboard'
import { mirrorEntities } from '../../lib/sketch/tools/mirrorTool'
import { linearPattern } from '../../lib/sketch/tools/patternTools'
import { filletLines } from '../../lib/sketch/tools/filletTool'
import { TOOL_ICONS } from '../../lib/sketch/sketcher/overlays/SketchPromptBar'
import { SECTIONS as CAM_SECTIONS } from '../../components/panels/sketch/SketchToolbox'
import { SKETCH_SECTIONS as WORKBENCH_SECTIONS } from '../../components/model3d/workbench/WorkbenchToolRail'
import { SKETCH_TOOL_LABELS } from '../../lib/sketch/promptBar'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// ---- store stubs (same pattern as controlPointSpline.wo1861.test.ts) ----------
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
const newId = () => `wo1862-${n++}`

// ---- independent reference ---------------------------------------------------

type Pt = Vec2
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const d = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const unit = (a: Pt): Pt => { const l = Math.hypot(a.x, a.y); return { x: a.x / l, y: a.y / l } }
/** |sin| of the angle between two vectors: 0 = parallel (or anti-parallel). */
const sinBetween = (a: Pt, b: Pt): number => Math.abs(cross(unit(a), unit(b)))

/** The standard cubic Bernstein evaluation of four control points, t in [0, 1]. */
function bernstein(P: readonly Pt[], t: number): Pt {
  const s = 1 - t
  const b = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]
  return {
    x: b[0] * P[0].x + b[1] * P[1].x + b[2] * P[2].x + b[3] * P[3].x,
    y: b[0] * P[0].y + b[1] * P[1].y + b[2] * P[2].y + b[3] * P[3].y,
  }
}

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

/** Dense exact samples of a bezier chain from the Bernstein reference. */
function denseChain(points: readonly Pt[], closed: boolean, perSeg = 4000): Pt[] {
  const run = closed ? [...points, points[0]] : [...points]
  const out: Pt[] = []
  for (let s = 0; s + 3 < run.length; s += 3) {
    for (let i = 0; i <= perSeg; i++) out.push(bernstein(run.slice(s, s + 4), i / perSeg))
  }
  return out
}

function sketchOf(entities: SketchEntity[]): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints: [], dimensions: [], solveStatus: null }
}
function bez(id: string, points: Pt[], closed = false, smooth?: boolean[]): SketchSplineEntity {
  return {
    id, kind: 'spline', construction: false, points: points.map((p) => ({ ...p })), closed, form: 'bezier',
    ...(smooth ? { smooth: [...smooth] } : {}),
  }
}

/** Press at each anchor, release at its handle (null = a stationary click), then Enter. */
function drawWithArmedTool(
  gestures: Array<{ anchor: Pt; handle: Pt | null }>, closeLoop = false,
): SketchSplineEntity {
  const store = useCamStore.getState()
  store.setViewerMode('sketch') // auto-creates a blank active sketch
  const before = new Set((useCamStore.getState().activeSketch?.entities ?? []).map((e) => e.id))
  sketcherTools.setSplineClosed(closeLoop)
  sketcherTools.armTool('bezier')
  for (const g of gestures) {
    sketcherTools.bezierPress(g.anchor, null)
    sketcherTools.click(g.handle ?? g.anchor, 0.05, null, false)
  }
  sketcherTools.end()
  sketcherTools.setSplineClosed(false)
  const added = (useCamStore.getState().activeSketch?.entities ?? []).filter((e) => !before.has(e.id))
  expect(added).toHaveLength(1)
  expect(added[0].kind).toBe('spline')
  return added[0] as SketchSplineEntity
}

// A0 dragged out to H0; A1 dragged out to H1 (its in-handle is H1's mirror).
const A0: Pt = { x: 0, y: 0 }
const H0: Pt = { x: 10, y: 25 }
const A1: Pt = { x: 50, y: 0 }
const H1: Pt = { x: 62, y: -18 }
const H1in: Pt = { x: 2 * A1.x - H1.x, y: 2 * A1.y - H1.y } // (38, 18)
const SEG: Pt[] = [A0, H0, H1in, A1]

// ---- 1. Click-drag-click-drag ------------------------------------------------------

describe('WO-1862: click-drag-click-drag makes a cubic bezier', () => {
  it('the armed tool commits ONE bezier holding anchor, handle, mirrored handle, anchor', () => {
    expect(ARMABLE_TOOLS.has('bezier')).toBe(true)
    const e = drawWithArmedTool([{ anchor: A0, handle: H0 }, { anchor: A1, handle: H1 }])
    expect(e.form).toBe('bezier')
    expect(e.closed).toBe(false)
    expect(e.points).toEqual(SEG)
    expect(sketcherToolStore.getState().tool).toBe('bezier') // armed for the next one
    expect(sketcherToolStore.getState().chain).toBeNull()
  })

  it('what the sketch layer draws is the standard Bernstein curve of the four points to 1e-9 mm', () => {
    const e = drawWithArmedTool([{ anchor: A0, handle: H0 }, { anchor: A1, handle: H1 }])
    const drawn = layer.tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
    expect(d(drawn[0], A0)).toBe(0)
    expect(d(drawn[drawn.length - 1], A1)).toBe(0)
    const subdiv = drawn.length - 1
    let worst = 0
    for (let j = 0; j <= subdiv; j++) worst = Math.max(worst, d(drawn[j], bernstein(SEG, j / subdiv)))
    expect(worst).toBeLessThan(1e-9)
    // the evaluator over the shared domain [0, n-1] = [0, 3]
    for (let i = 0; i <= 300; i++) {
      const q = (3 * i) / 300
      expect(d(splinePointAt(e.points, false, q, 'bezier'), bernstein(SEG, q / 3))).toBeLessThan(1e-9)
    }
  })

  it('the curve tangent at each end is parallel to that end\'s handle', () => {
    const e = drawWithArmedTool([{ anchor: A0, handle: H0 }, { anchor: A1, handle: H1 }])
    const t0 = splineDerivativeAt(e.points, false, 0, 'bezier')
    const t1 = splineDerivativeAt(e.points, false, 3, 'bezier')
    // start: along A0 -> H0; end: arriving along H1in -> A1 (the in-handle's line)
    expect(sinBetween(t0, sub(H0, A0))).toBeLessThan(1e-9)
    expect(dot(t0, sub(H0, A0))).toBeGreaterThan(0)
    expect(sinBetween(t1, sub(A1, H1in))).toBeLessThan(1e-9)
    expect(dot(t1, sub(A1, H1in))).toBeGreaterThan(0)
    // ... and the drawn polyline leaves along the handle too
    const drawn = layer.tessellateSpline(e).map((v) => ({ x: v.x, y: v.y }))
    expect(sinBetween(sub(drawn[1], drawn[0]), sub(H0, A0))).toBeLessThan(0.02)
  })

  it('NEGATIVE CONTROL: with the handles dropped (collapsed onto their anchors) the tangent is NOT parallel to the handle', () => {
    const dropped = [A0, A0, A1, A1]
    const t0 = splineDerivativeAt(dropped, false, 0, 'bezier')
    expect(sinBetween(t0, sub(H0, A0))).toBeGreaterThan(0.5)
    // and the Bernstein reference of the real points is not that curve
    expect(d(splinePointAt(dropped, false, 1.5, 'bezier'), bernstein(SEG, 0.5))).toBeGreaterThan(5)
  })

  it('rule 11: stationary clicks (zero-length handles) commit a straight line, no refusal', () => {
    const e = drawWithArmedTool([{ anchor: { x: 0, y: 0 }, handle: null }, { anchor: { x: 40, y: 20 }, handle: null }])
    expect(e.form).toBe('bezier')
    expect(e.points).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 40, y: 20 }, { x: 40, y: 20 }])
    for (const p of tessellateSpline(e.points, false, SPLINE_TESS_STEP_MM, 'bezier')) {
      expect(Math.abs(p.y - p.x / 2)).toBeLessThan(1e-9)
    }
    // a zero-length handle still has a direction: the curve's own
    const t = splineDerivativeAt(e.points, false, 0, 'bezier')
    expect(sinBetween(t, { x: 40, y: 20 })).toBeLessThan(1e-6)
    // and baking it gives a real open loop
    const baked = bakeSketch(sketchOf([e]))
    expect(baked.loops).toHaveLength(1)
  })

  it('while dragging, the rubber band is the curve the release will leave and the overlay shows the handle legs', () => {
    let st: ToolState = { tool: 'bezier', chain: bezierPress(null, A0) }
    st = toolClick(st, H0, 0.05, newId).state // release: A0's handle
    st = { ...st, chain: bezierPress(st.chain as never, A1) } // press at A1, held
    const preview = toolPreview(st, H1)! // dragging to H1
    expect(d(preview[0], A0)).toBe(0)
    expect(d(preview[preview.length - 1], A1)).toBe(0)
    for (let j = 0; j < preview.length; j++) {
      expect(distToPolyline(preview[j], denseChain(SEG, false))).toBeLessThan(1e-3)
    }
    const ov = toolOverlay(st, H1, 0.05, { entities: [] })!
    // A0's out-handle leg, and A1's in-handle -> anchor -> out-handle leg
    expect(ov.ghosts).toEqual([[A0, H0], [H1in, A1, H1]])
    // prompt bar: one anchor down, not yet finishable
    const status = toolStepStatus({ tool: 'bezier', chain: st.chain })
    expect(status?.operandCount).toBe(1)
    expect(status?.confirmable).toBe(false)
  })

  it('close-on-start (press on the first anchor again) closes the chain', () => {
    let st: ToolState = { tool: 'bezier', chain: null }
    let commit = null
    const anchors: Array<[Pt, Pt]> = [
      [{ x: 0, y: 0 }, { x: 10, y: -10 }], [{ x: 40, y: 0 }, { x: 50, y: 10 }],
      [{ x: 20, y: 30 }, { x: 10, y: 30 }], [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    ]
    for (const [a, h] of anchors) {
      st = { ...st, chain: bezierPress(st.chain as never, a) }
      const r = toolClick(st, h, 0.05, newId)
      st = r.state
      commit = r.commit ?? commit
    }
    const e = commit!.entities[0] as SketchSplineEntity
    expect(e.form).toBe('bezier')
    expect(e.closed).toBe(true)
    expect(e.points).toHaveLength(9) // 3 segments, the start anchor not repeated
    // A0 was dragged, so it closes smooth: its in-handle mirrors its out-handle
    expect(e.points[8]).toEqual({ x: -10, y: 10 })
    const drawn = tessellateSpline(e.points, true, SPLINE_TESS_STEP_MM, 'bezier')
    expect(d(drawn[0], drawn[drawn.length - 1])).toBe(0)
  })
})

// ---- 2. Handles and anchors are draggable ------------------------------------------

const CHAIN: Pt[] = [
  { x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 },
  { x: 50, y: -20 }, { x: 70, y: -20 }, { x: 80, y: 0 },
]

describe('WO-1862: dragging handles and anchors', () => {
  it('the sketch layer picks the bezier at an off-curve handle tip, and snap never offers a handle tip', () => {
    const e = bez('b', CHAIN)
    expect(distToPolyline(CHAIN[1], tessellateSpline(CHAIN, false, 0.05, 'bezier'))).toBeGreaterThan(5)
    expect(layer.pickNearestEntity([e], CHAIN[1].x, CHAIN[1].y, 0.5)).toBe('b')
    const at = (p: Pt) => findSnap({ cursor: p, entities: [e], gridSpacing: 0, worldPerPixel: 0.05 })
    expect(at(CHAIN[1])?.point ?? null).not.toEqual(CHAIN[1]) // handle tip: no snap there
    expect(at(CHAIN[3])?.point).toEqual(CHAIN[3]) // interior anchor: snaps
  })

  it('the store drag begun on a handle pins that handle as its own solver site', async () => {
    const e = bez('b1', CHAIN)
    useCamStore.setState({
      activeSketch: sketchOf([e]),
      sketchSolveStatus: null,
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTool: 'select', sketchToolChain: null,
      sketchTextEditId: null, sketchPickPathForTextId: null,
    } as never)
    const st = useCamStore.getState()
    expect(st.beginSketchDrag('b1', { x: 50.1, y: -20 }, 0.5)).toBe(true)
    st.moveSketchDrag({ x: 55, y: -30 })
    await new Promise((r) => setTimeout(r, 40)) // past the store's 25 ms drag-solve debounce
    const drags = postedMessages.filter((m) => m.type === 'DRAG_SOLVE')
    expect(drags.length).toBeGreaterThan(0)
    const targets = drags[drags.length - 1].payload!.drag!.targets
    expect(targets).toHaveLength(1)
    expect(targets[0].point).toEqual({ entityId: 'b1', site: 'cp4' })
    st.endSketchDrag(undefined)
  })

  it('dragging a handle changes the curve and moves nothing else', async () => {
    const e = bez('b', CHAIN) // corner joint (no smooth flags)
    const target = splineControlPointDragTarget(e, CHAIN[1], 0.5)!
    expect(target.point.site).toBe('cp1')
    const to = { x: 5, y: 40 }
    const out = solveSketchOnWrapper(await createGcsWrapper(), sketchOf([e]), { targets: [{ point: target.point, to }] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const moved = out.entities[0] as SketchSplineEntity
    for (let i = 0; i < CHAIN.length; i++) {
      if (i === 1) expect(d(moved.points[i], to)).toBeLessThan(1e-6)
      else expect(moved.points[i]).toEqual(CHAIN[i])
    }
    // the first segment changed; the second is bit-identical
    expect(d(splinePointAt(moved.points, false, 1.5, 'bezier'), splinePointAt(CHAIN, false, 1.5, 'bezier')))
      .toBeGreaterThan(1)
    for (let i = 0; i <= 50; i++) {
      const q = 3 + (3 * i) / 50
      expect(splinePointAt(moved.points, false, q, 'bezier')).toEqual(splinePointAt(CHAIN, false, q, 'bezier'))
    }
  })

  it('dragging an endpoint carries its handle with it', async () => {
    const e = bez('b', CHAIN)
    const target = splineControlPointDragTarget(e, CHAIN[6], 0.5)!
    expect(target.point.site).toBe('cp6')
    const to = { x: 90, y: 7 }
    const out = solveSketchOnWrapper(await createGcsWrapper(), sketchOf([e]), { targets: [{ point: target.point, to }] })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const moved = out.entities[0] as SketchSplineEntity
    expect(d(moved.points[6], to)).toBeLessThan(1e-6)
    expect(d(moved.points[5], { x: 70 + 10, y: -20 + 7 })).toBeLessThan(1e-6) // carried by the same delta
    expect(moved.points.slice(0, 5)).toEqual(CHAIN.slice(0, 5))
  })

  it('a zero-length handle sitting on its anchor grabs the anchor', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 30, y: 10 }, { x: 40, y: 0 }]
    expect(splineControlPointDragTarget(bez('z', pts), { x: 0, y: 0 }, 0.5)!.point.site).toBe('cp0')
  })

  it('a plain solve (no drag) leaves a bezier exactly as stored', async () => {
    const out = solveSketchOnWrapper(await createGcsWrapper(), sketchOf([bez('b', CHAIN, false, [false, true, false])]))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((out.entities[0] as SketchSplineEntity).points).toEqual(CHAIN)
  })
})

// ---- 3. Smooth and corner joints -----------------------------------------------------

describe('WO-1862: a joint can be tangent-smooth and returned to a corner', () => {
  async function dragHandle(e: SketchSplineEntity, index: number, to: Pt): Promise<SketchSplineEntity> {
    const out = solveSketchOnWrapper(await createGcsWrapper(), sketchOf([e]), {
      targets: [{ point: { entityId: e.id, site: `cp${index}` }, to }],
    })
    expect(out.ok).toBe(true)
    return (out.ok ? out.entities[0] : e) as SketchSplineEntity
  }
  const collinearAt = (e: SketchSplineEntity, a: number): number =>
    sinBetween(sub(e.points[a - 1], e.points[a]), sub(e.points[a], e.points[a + 1]))

  it('a chain drawn with drags is smooth at its joint, and a handle drag keeps the joined handles collinear', async () => {
    const e = drawWithArmedTool([
      { anchor: { x: 0, y: 0 }, handle: { x: 10, y: 20 } },
      { anchor: { x: 40, y: 0 }, handle: { x: 50, y: -20 } },
      { anchor: { x: 80, y: 0 }, handle: { x: 90, y: 20 } },
    ])
    expect(e.points).toHaveLength(7)
    expect(e.smooth).toEqual([true, true, true])
    expect(collinearAt(e, 3)).toBeLessThan(1e-12)
    const inLen = d(e.points[2], e.points[3])
    const moved = await dragHandle(e, 4, { x: 45, y: -35 })
    // the other handle turned to stay in line, its length kept; nothing else moved
    expect(collinearAt(moved, 3)).toBeLessThan(1e-9)
    expect(dot(sub(moved.points[2], moved.points[3]), sub(moved.points[4], moved.points[3]))).toBeLessThan(0)
    expect(Math.abs(d(moved.points[2], moved.points[3]) - inLen)).toBeLessThan(1e-9)
    for (const i of [0, 1, 3, 5, 6]) expect(moved.points[i]).toEqual(e.points[i])
    // tangent-continuous across the joint
    const before = splineDerivativeAt(moved.points, false, 3 - 1e-9, 'bezier')
    const after = splineDerivativeAt(moved.points, false, 3, 'bezier')
    expect(sinBetween(before, after)).toBeLessThan(1e-6)
    // and it stays so through a second edit, on the other side
    const again = await dragHandle(moved, 2, { x: 20, y: 25 })
    expect(collinearAt(again, 3)).toBeLessThan(1e-9)
  })

  it('the shared Corner action lets the handles move independently; Smooth makes the joint tangent again', async () => {
    const drawn = drawWithArmedTool([
      { anchor: { x: 0, y: 100 }, handle: { x: 10, y: 120 } },
      { anchor: { x: 40, y: 100 }, handle: { x: 50, y: 80 } },
      { anchor: { x: 80, y: 100 }, handle: { x: 90, y: 120 } },
    ])
    useCamStore.setState({ sketchSelectedIds: [drawn.id] } as never)
    expect(sketcherTools.bezierJointsInSelection()).toEqual({ entityIds: [drawn.id], joints: 1, allSmooth: true })
    sketcherTools.setBezierJointsSmooth(false)
    const corner = (useCamStore.getState().activeSketch!.entities.find((x) => x.id === drawn.id)) as SketchSplineEntity
    expect(corner.smooth![1]).toBe(false)
    expect(corner.points).toEqual(drawn.points) // geometry unchanged
    const bent = await dragHandle(corner, 4, { x: 60, y: 110 })
    expect(bent.points[2]).toEqual(corner.points[2]) // the other handle stayed put
    expect(collinearAt(bent, 3)).toBeGreaterThan(0.1) // a deliberate corner
    // back to smooth: the in-handle turns opposite the out-handle
    useCamStore.setState({
      activeSketch: { ...useCamStore.getState().activeSketch!, entities: useCamStore.getState().activeSketch!
        .entities.map((x) => (x.id === bent.id ? bent : x)) },
      sketchSelectedIds: [bent.id],
    } as never)
    expect(sketcherTools.bezierJointsInSelection()!.allSmooth).toBe(false)
    sketcherTools.setBezierJointsSmooth(true)
    const smooth = (useCamStore.getState().activeSketch!.entities.find((x) => x.id === bent.id)) as SketchSplineEntity
    expect(smooth.smooth![1]).toBe(true)
    expect(collinearAt(smooth, 3)).toBeLessThan(1e-9)
    expect(Math.abs(d(smooth.points[2], smooth.points[3]) - d(bent.points[2], bent.points[3]))).toBeLessThan(1e-9)
    // undo restores the corner geometry in one step
    useCamStore.getState().undo()
    const undone = (useCamStore.getState().activeSketch!.entities.find((x) => x.id === bent.id)) as SketchSplineEntity
    expect(undone.smooth![1]).toBe(false)
  })

  it('the joint row only appears for a selection holding a bezier with a joint', () => {
    const one = bez('one', CHAIN.slice(0, 4))
    const two = bez('two', CHAIN)
    expect(bezierJointSummary([one], ['one'])).toBeNull() // one segment: no joint
    expect(bezierJointSummary([two], [])).toBeNull()
    expect(bezierJointSummary([one, two], ['one', 'two'])).toEqual({ entityIds: ['two'], joints: 1, allSmooth: false })
    expect(bezierJoints(9, true)).toEqual([0, 1, 2]) // a closed chain's start is a joint too
  })

  it('pure rule: an anchor drag carries both handles; a smooth handle drag keeps length and turns the partner', () => {
    const e = bez('b', CHAIN, false, [false, true, false])
    const a = splineDragEdit(e, new Map([[3, { x: 42, y: 5 }]]))
    expect(a[2]).toEqual({ x: 32, y: 25 })
    expect(a[4]).toEqual({ x: 52, y: -15 })
    const h = splineDragEdit(e, new Map([[2, { x: 40, y: 30 }]]))
    expect(h[4].x).toBeCloseTo(40, 12)
    expect(h[4].y).toBeCloseTo(-Math.hypot(10, 20), 12)
    // a corner joint leaves the partner exactly where it was
    expect(splineDragEdit({ ...e, smooth: undefined }, new Map([[2, { x: 40, y: 30 }]]))[4]).toEqual(CHAIN[4])
    // Smooth with a zero-length out-handle: the in-handle leads
    const zero = bez('z', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 30, y: 10 }, { x: 40, y: 0 }, { x: 40, y: 0 },
      { x: 70, y: -5 }, { x: 80, y: 0 }])
    expect(bezierSetJointSmooth(zero, 1, true).points).toEqual(zero.points)
  })
})

// ---- 4. Bake and contour ---------------------------------------------------------------

const CLOSED: Pt[] = [
  { x: 0, y: 0 }, { x: 20, y: -15 }, { x: 40, y: -15 },
  { x: 60, y: 0 }, { x: 80, y: 15 }, { x: 60, y: 40 },
  { x: 30, y: 40 }, { x: 0, y: 40 }, { x: -20, y: 15 },
]

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

describe('WO-1862: it bakes to a loop and a contour follows the curve', () => {
  const exact = denseChain(CLOSED, true)

  it('a closed bezier bakes to a closed loop on the true curve inside the tessellation tolerance', () => {
    const baked = bakeSketch(sketchOf([bez('c', CLOSED, true, [true, true, true])]))
    expect(baked.loops).toHaveLength(1)
    const loop = baked.loops[0]
    expect(loop.closed).toBe(true)
    for (const p of loop.points) expect(distToPolyline(p, exact)).toBeLessThan(1e-4)
    let worst = 0
    const pts = [...loop.points, loop.points[0]]
    for (let i = 0; i + 1 < pts.length; i++) {
      expect(d(pts[i], pts[i + 1])).toBeLessThanOrEqual(SPLINE_TESS_STEP_MM + 1e-9)
      worst = Math.max(worst, distToPolyline(lerp(pts[i], pts[i + 1], 0.5), exact))
    }
    expect(worst).toBeLessThan(0.01)
    // every anchor is ON the loop, every handle tip well off it
    for (const a of [0, 3, 6]) expect(distToPolyline(CLOSED[a], pts)).toBeLessThan(1e-9)
    for (const h of [1, 2, 4, 5, 7, 8]) expect(distToPolyline(CLOSED[h], pts)).toBeGreaterThan(3)
  })

  it('an open bezier bakes to an open loop from its first to its last anchor', () => {
    const baked = bakeSketch(sketchOf([bez('o', CHAIN)]))
    expect(baked.loops).toHaveLength(1)
    const loop = baked.loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.points[0]).toEqual(CHAIN[0])
    expect(loop.points[loop.points.length - 1]).toEqual(CHAIN[6])
  })

  it('an outside contour over the baked loop runs one tool radius off the CURVE, not off the handle polygon', () => {
    const loops = bakeSketch(sketchOf([bez('c', CLOSED, true)])).loops as unknown as LoopData[]
    const payload: ContourWorkerPayload = {
      opId: 'op', setupId: 's',
      params: { geometryId: 'g', loopIds: [], side: 'outer', direction: 'climb', tabs: false } as ContourParams,
      heights: HEIGHTS, passes: PASSES, linking: LINKING, tool: makeTool(6), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    const cuts = buildContourToolpath(payload).filter((m) => m.role === 'cut').map((m) => ({ x: m.x, y: m.y }))
    expect(cuts.length).toBeGreaterThan(20)
    const polygon = [...CLOSED, CLOSED[0]]
    let worstCurve = 0, worstPolygon = 0
    for (const p of cuts) {
      worstCurve = Math.max(worstCurve, Math.abs(distToPolyline(p, exact) - 3))
      worstPolygon = Math.max(worstPolygon, Math.abs(distToPolyline(p, polygon) - 3))
    }
    expect(worstCurve).toBeLessThan(0.02)
    expect(worstPolygon).toBeGreaterThan(2)
  })
})

// ---- 5. The census the existing spline passes -----------------------------------------

describe('WO-1862: save/reload, copy/paste, undo/redo, mirror, pattern, fillet', () => {
  it('survives a JSON round trip (the project persist path) with its form, joints and shape', () => {
    const sk = sketchOf([bez('s', CHAIN, false, [false, true, false])])
    const e = (JSON.parse(JSON.stringify(sk)) as Sketch).entities[0] as SketchSplineEntity
    expect(e.form).toBe('bezier')
    expect(e.smooth).toEqual([false, true, false])
    expect(tessellateSpline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form))
      .toEqual(tessellateSpline(CHAIN, false, SPLINE_TESS_STEP_MM, 'bezier'))
  })

  it('copy/paste re-IDs it and the copy is still a bezier with draggable handles and its joints', () => {
    const sk = sketchOf([bez('s', CHAIN, false, [false, true, false])])
    const payload = captureSketchClipboard(sk, ['s'])!
    const paste = instantiateSketchClipboard(payload, { x: 100, y: 100 }, newId, ['s'])
    expect(paste.entities).toHaveLength(1)
    const e = paste.entities[0] as SketchSplineEntity
    expect(e.id).not.toBe('s')
    expect(e.form).toBe('bezier')
    expect(e.smooth).toEqual([false, true, false])
    const delta = sub(e.points[0], CHAIN[0])
    e.points.forEach((p, i) => expect(d(p, { x: CHAIN[i].x + delta.x, y: CHAIN[i].y + delta.y })).toBeLessThan(1e-9))
    expect(splineControlPointDragTarget(e, e.points[2], 0.5)?.point).toEqual({ entityId: e.id, site: 'cp2' })
  })

  it('undo removes the drawn bezier in one step and redo brings it back as a bezier', () => {
    const count = () => (useCamStore.getState().activeSketch?.entities ?? []).filter((e) => e.kind === 'spline').length
    useCamStore.getState().setViewerMode('sketch')
    const before = count()
    const e = drawWithArmedTool([{ anchor: { x: 300, y: 0 }, handle: { x: 310, y: 10 } },
      { anchor: { x: 340, y: 0 }, handle: { x: 350, y: -10 } }])
    expect(count()).toBe(before + 1)
    useCamStore.getState().undo()
    expect(count()).toBe(before)
    useCamStore.getState().redo()
    expect(count()).toBe(before + 1)
    const back = (useCamStore.getState().activeSketch?.entities ?? []).find((x) => x.id === e.id) as SketchSplineEntity
    expect(back.form).toBe('bezier')
    expect(back.points).toEqual(e.points)
  })

  it('mirror makes the reflected bezier (its curve is the mirror of the original to 1e-9 mm), joints kept', () => {
    const axis: SketchEntity = { id: 'ax', kind: 'line', construction: true, start: { x: -10, y: -5 }, end: { x: 60, y: 45 } }
    const r = mirrorEntities([bez('s', CHAIN, false, [false, true, false]), axis], ['s'], 'ax', newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const m = r.entities[0] as SketchSplineEntity
    expect(m.form).toBe('bezier')
    expect(m.smooth).toEqual([false, true, false])
    const u = unit({ x: 70, y: 50 })
    const reflect = (p: Pt): Pt => {
      const v = { x: p.x + 10, y: p.y + 5 }
      const k = v.x * u.x + v.y * u.y
      return { x: 2 * k * u.x - v.x - 10, y: 2 * k * u.y - v.y - 5 }
    }
    for (let i = 0; i <= 60; i++) {
      const q = (6 * i) / 60
      expect(d(splinePointAt(m.points, false, q, 'bezier'), reflect(splinePointAt(CHAIN, false, q, 'bezier'))))
        .toBeLessThan(1e-9)
    }
    expect(r.constraints.some((c) => c.kind === 'symmetric')).toBe(true)
  })

  it('a linear pattern copy keeps the bezier form and joints and is the translated curve', () => {
    const r = linearPattern([bez('s', CHAIN, false, [false, true, false])], [], ['s'], 3, { x: 0, y: 50 }, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const copies = r.entities.filter((e): e is SketchSplineEntity => e.kind === 'spline')
    expect(copies.length).toBe(2)
    for (const c of copies) {
      expect(c.form).toBe('bezier')
      expect(c.smooth).toEqual([false, true, false])
      const dy = c.points[0].y
      const ref = splinePointAt(CHAIN, false, 4.3, 'bezier')
      expect(d(splinePointAt(c.points, false, 4.3, 'bezier'), { x: ref.x, y: ref.y + dy })).toBeLessThan(1e-9)
    }
  })

  it('fillet against a line re-expresses the bezier host as the through-point spline tracing the same curve', () => {
    const e = bez('s', CHAIN.slice(0, 4))
    const line: SketchEntity = { id: 'L', kind: 'line', construction: false, start: { x: 20, y: -10 }, end: { x: 20, y: 40 } }
    const r = filletLines(
      { entities: [e, line], constraints: [], dimensions: [] },
      'L', 's', { x: 20, y: -5 }, { x: 5, y: 8 }, 2, newId,
    )
    expect(typeof r, typeof r === 'string' ? r : '').not.toBe('string')
    if (typeof r === 'string') return
    const host = r.transform.entities.find((x) => x.id === 's') as SketchSplineEntity
    expect(host.form).toBeUndefined()
    const exact = denseChain(CHAIN.slice(0, 4), false)
    for (const p of host.filletSourcePoints ?? host.points) expect(distToPolyline(p, exact)).toBeLessThan(1e-3)
    expect(splineAsThroughPoints(e).smooth).toBeUndefined()
  })
})

// ---- 6. Tool surfaces ------------------------------------------------------------------

describe('WO-1862: the Bezier tool on both surfaces', () => {
  it('has a label, a prompt-bar icon, and the SAME icon in the CAM toolbox and the workbench rail', () => {
    expect(SKETCH_TOOL_LABELS.bezier).toBe('Bezier')
    const cam = CAM_SECTIONS.flatMap((s) => s.tools).find((t) => t.id === 'bezier')
    const wb = WORKBENCH_SECTIONS.flatMap((s) => s.tools).find((t) => t.id === 'bezier')
    expect(cam?.icon).toBe(TOOL_ICONS.bezier)
    expect(wb?.icon).toBe(TOOL_ICONS.bezier)
  })

  it('a committed bezier shows one handle leg per anchor (not the polygon between two handles)', () => {
    expect(splineHandleLegs(CHAIN, false, 'bezier')).toEqual([
      [CHAIN[0], CHAIN[1]], [CHAIN[2], CHAIN[3], CHAIN[4]], [CHAIN[5], CHAIN[6]],
    ])
    expect(splineHandleLegs(CHAIN, false, undefined)).toEqual([])
  })

  it('Enter with a single anchor placed discards the chain (nothing to draw yet)', () => {
    let st: ToolState = { tool: 'bezier', chain: bezierPress(null, A0) }
    st = toolClick(st, H0, 0.05, newId).state
    expect(bezierFinish(st.chain as never, false, newId)).toBeNull()
  })
})
