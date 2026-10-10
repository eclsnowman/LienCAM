// ON-PATH TEXT drag (spec T2 free-slide + T5a flip-side by crossing).
//
// Dragging text bound to a curve is a pure LAYOUT gesture: every update
// projects the cursor onto the bound path and writes pathOffsetMm, forcing
// pathAlign 'free' at drag START (grabbing aligned text frees it at its
// CURRENT resolved offset -- no jump), with a grab delta so the grip point
// stays under the cursor instead of the text snapping its start there.
// Crossing the curve beyond a hysteresis threshold toggles pathFlip. Text is
// solver-inert, so NONE of this touches the sketch solver -- the worker
// stub below records every posted message to prove it. FREE text (no
// pathId) takes the SOLVER drag path instead: its anchor -- the one gcs
// point a text has (site 'start') -- is pinned to the cursor like a point
// entity (this was a silent empty-pin no-op before the 'text' drag-plan
// case existed); the line regression proves the rest of the solver drag
// path is byte-identical.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sketch, SketchTextEntity } from '../../lib/sketch/types'
import {
  pathLUT, effectiveStartOffsetMm, textEntityAdvanceMm,
} from '../../lib/sketch/textOnPath'

// WO-1052: the `../../lib/geometry/worker` vi.mock this file used to carry
// mocked a module specifier that resolves to nothing in src/ and an export
// (`getGeometryWorker`) referenced nowhere else in the repo - dead code left
// over from an earlier architecture. Removed rather than typed (there is no
// real module to type against) and rather than left untyped (nothing in this
// file or in src/ ever imports it, so the mock was a no-op); the Worker global
// stub immediately below is what the sketch worker path actually exercises.
// Recording stub: the on-path slide must post NOTHING; the solver-drag
// regressions assert their DRAG_SOLVE / SOLVE_SKETCH stream is unchanged.
const postedMessages: Array<{ type?: string; payload?: { drag?: { targets: unknown[] } } }> = []
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

/** Await past the store's 25ms drag-solve debounce. */
const settleDebounce = () => new Promise((r) => setTimeout(r, 40))

// Line path: (0,0) -> (100,0). Arc length s == x; +normal side is +Y.
const LINE = {
  id: 'ln', kind: 'line' as const, construction: false,
  start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
}
// Closed path: circle r=20 at the origin (seam s=0 at (20,0), CCW).
const CIRCLE = {
  id: 'ci', kind: 'circle' as const, construction: false,
  center: { x: 0, y: 0 }, radius: 20,
}

function textOn(pathId: string | undefined, over: Partial<SketchTextEntity> = {}): SketchTextEntity {
  return {
    id: 'tx', kind: 'text', construction: false,
    at: { x: 5, y: 5 }, text: 'HI', height: 5, rotation: 0,
    fontStyle: 'single-line',
    ...(pathId ? { pathId, pathOffsetMm: 0, pathFlip: false } : {}),
    ...over,
  }
}

describe('on-path text drag (T2 free slide + T5a flip-side)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })

  function seed(entities: Sketch['entities'], constraints: Sketch['constraints'] = []): void {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L', entities, constraints,
        dimensions: [], solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTool: 'select', sketchToolChain: null,
      sketchTextEditId: null, sketchPickPathForTextId: null,
    } as never)
  }
  beforeEach(() => {
    postedMessages.length = 0
    seed([LINE, textOn('ln')])
  })
  const st = () => useCamStore.getState()
  const txt = (id = 'tx') =>
    st().activeSketch!.entities.find((e) => e.id === id) as SketchTextEntity

  it('drag updates write the cursor-projected pathOffsetMm (grip stays under the cursor)', async () => {
    seed([LINE, textOn('ln', { pathAlign: 'free', pathOffsetMm: 20 })])
    // Grab 5mm INTO the text (cursor at s=25, text starts at 20).
    expect(st().beginSketchDrag('tx', { x: 25, y: 1 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 40, y: 1 })
    expect(txt().pathOffsetMm).toBeCloseTo(35, 9) // 40 + (20 - 25)
    st().moveSketchDrag({ x: 10, y: 1 })
    expect(txt().pathOffsetMm).toBeCloseTo(5, 9)
    expect(txt().pathFlip).toBe(false)
    expect(txt().pathAlign).toBe('free')
    st().endSketchDrag()
    // Solver-inert: the whole gesture posted NOTHING to the solver worker.
    await settleDebounce()
    expect(postedMessages).toHaveLength(0)
  })

  it('grabbing aligned (center) text frees it at its CURRENT resolved offset -- no jump', () => {
    // Stored pathOffsetMm is stale junk (3): the resolver must win.
    seed([LINE, textOn('ln', { pathAlign: 'center', pathOffsetMm: 3 })])
    const ent = txt()
    const lut = pathLUT(LINE)!
    const advance = textEntityAdvanceMm(ent)
    const resolved = effectiveStartOffsetMm(ent, lut, advance)
    expect(resolved).toBeCloseTo(50 - advance / 2, 9)
    // Grab the text MIDDLE (= curve middle for center align).
    const mid = resolved + advance / 2
    expect(st().beginSketchDrag('tx', { x: mid, y: 1 }, 0.5)).toBe(true)
    // Freed AT the resolved offset, not the stale stored value.
    expect(txt().pathAlign).toBe('free')
    expect(txt().pathOffsetMm).toBeCloseTo(resolved, 9)
    // First update with the cursor still at the grab point: the START does
    // NOT snap to the cursor (grab delta), the offset holds the resolved
    // position within epsilon.
    st().moveSketchDrag({ x: mid, y: 1 })
    expect(txt().pathOffsetMm).toBeCloseTo(resolved, 9)
    expect(Math.abs(resolved - mid)).toBeGreaterThan(1) // proves non-snap
    st().endSketchDrag()
  })

  it('crossing the curve beyond the threshold toggles pathFlip; within it never (hysteresis both ways)', () => {
    seed([LINE, textOn('ln', { pathAlign: 'free', pathOffsetMm: 20 })])
    // height 5 -> threshold max(0.6*5, 3) = 3mm.
    expect(st().beginSketchDrag('tx', { x: 25, y: 0.5 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 30, y: -2 }) // far side, INSIDE threshold
    expect(txt().pathFlip).toBe(false)
    expect(txt().pathOffsetMm).toBeCloseTo(25, 9)
    st().moveSketchDrag({ x: 30, y: -4 }) // far side, BEYOND threshold
    expect(txt().pathFlip).toBe(true)
    // Flip negates the grab delta (s walks backward): 30 + 5, not 30 - 5.
    expect(txt().pathOffsetMm).toBeCloseTo(35, 9)
    st().moveSketchDrag({ x: 30, y: 2 }) // back over, INSIDE threshold
    expect(txt().pathFlip).toBe(true) // hysteresis holds -- no flap
    st().moveSketchDrag({ x: 30, y: 4 }) // back over, BEYOND threshold
    expect(txt().pathFlip).toBe(false)
    expect(txt().pathOffsetMm).toBeCloseTo(25, 9)
    st().endSketchDrag()
  })

  it('flip threshold scales with text height (0.6 x height above the 3mm floor)', () => {
    seed([LINE, textOn('ln', { pathAlign: 'free', pathOffsetMm: 20, height: 10 })])
    // height 10 -> threshold 6mm.
    expect(st().beginSketchDrag('tx', { x: 25, y: 1 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 30, y: -5 }) // beyond the 3mm floor, inside 6mm
    expect(txt().pathFlip).toBe(false)
    st().moveSketchDrag({ x: 30, y: -7 })
    expect(txt().pathFlip).toBe(true)
    st().endSketchDrag()
  })

  it('closed path: dragging across the s=0 seam wraps the offset seamlessly', () => {
    seed([CIRCLE, textOn('ci', { pathAlign: 'free', pathOffsetMm: 1 })])
    const lut = pathLUT(CIRCLE)!
    const total = lut.totalLength
    // Grab 1mm into the text (grip at s=2, text starts at 1).
    expect(st().beginSketchDrag('tx', lut.pointAt(2), 0.5)).toBe(true)
    // Slide BACKWARD across the seam to s = total - 3.
    st().moveSketchDrag(lut.pointAt(total - 3))
    expect(txt().pathOffsetMm).toBeCloseTo(total - 4, 5) // wrapped, no clamp
    // Always inside [0, total).
    expect(txt().pathOffsetMm!).toBeGreaterThanOrEqual(0)
    expect(txt().pathOffsetMm!).toBeLessThan(total)
    // And forward across the seam again.
    st().moveSketchDrag(lut.pointAt(4))
    expect(txt().pathOffsetMm).toBeCloseTo(3, 5)
    st().endSketchDrag()
  })

  it('closed path: a grab across the seam from the text start wraps the grab delta too', () => {
    seed([CIRCLE, textOn('ci', { pathAlign: 'free', pathOffsetMm: 1 })])
    const lut = pathLUT(CIRCLE)!
    const total = lut.totalLength
    // Text starts at s=1; grab just BEHIND the seam at s = total - 2
    // (3mm before the start the short way around).
    expect(st().beginSketchDrag('tx', lut.pointAt(total - 2), 0.5)).toBe(true)
    st().moveSketchDrag(lut.pointAt(5))
    expect(txt().pathOffsetMm).toBeCloseTo(8, 5) // 5 + wrapped delta (+3)
    st().endSketchDrag()
  })

  // SEAM EDIT (WO SKC-14-R1 finding 3): the on-path slide is a component-owned gesture, so its
  // undo step is opened by the caller's `beforeMutate` hook immediately before the first write --
  // the store action holds no history of its own. Same property, driven the way the component
  // drives it, and now also pinning that the hook fires exactly once.
  it('the whole slide gesture is ONE undo step, opened by the caller', () => {
    seed([LINE, textOn('ln', { pathAlign: 'center', pathOffsetMm: 0 })])
    expect(st().sketchHistory).toHaveLength(0)
    let hookCalls = 0
    const beforeMutate = () => { hookCalls++; st().pushHistory() }
    expect(st().beginSketchDrag('tx', { x: 50, y: 1 }, 0.5, beforeMutate)).toBe(true)
    st().moveSketchDrag({ x: 60, y: 1 })
    st().moveSketchDrag({ x: 70, y: 1 })
    st().moveSketchDrag({ x: 80, y: -9 })
    st().endSketchDrag()
    expect(hookCalls).toBe(1)
    expect(st().sketchHistory).toHaveLength(1)
  })

  it('the on-path slide action is history-free without the hook', () => {
    seed([LINE, textOn('ln', { pathAlign: 'center', pathOffsetMm: 0 })])
    expect(st().beginSketchDrag('tx', { x: 50, y: 1 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 60, y: 1 })
    st().endSketchDrag()
    // FAILS-IF: the text-path drag branch regrows its own pushHistory().
    expect(st().sketchHistory).toHaveLength(0)
  })

  it('slides even in a fully-defined sketch (solver gates do not apply to a layout edit)', () => {
    seed([LINE, textOn('ln', { pathAlign: 'free', pathOffsetMm: 20 })])
    useCamStore.setState({
      sketchSolveStatus: { dof: 0, conflicting: [], redundant: [] },
    } as never)
    // Control: the same status still refuses a SOLVER drag (line body).
    expect(st().beginSketchDrag('ln', { x: 50, y: 0 }, 0.5)).toBe(false)
    // The on-path slide never enters the solver, so it is accepted.
    expect(st().beginSketchDrag('tx', { x: 25, y: 1 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 40, y: 1 })
    expect(txt().pathOffsetMm).toBeCloseTo(35, 9)
    st().endSketchDrag()
  })

  it('a fix constraint on the text refuses the slide (grounded = immovable)', () => {
    seed(
      [LINE, textOn('ln', { pathAlign: 'free', pathOffsetMm: 20 })],
      [{ id: 'f1', kind: 'fix', entityId: 'tx' }],
    )
    expect(st().beginSketchDrag('tx', { x: 25, y: 1 }, 0.5)).toBe(false)
    expect(txt().pathOffsetMm).toBe(20)
  })

  // ---- M1c drag-while-typing: the slide runs WHILE the edit is open -------

  it('sliding on-path text WHILE its edit is open keeps the edit open (M1c)', () => {
    seed([LINE, textOn('ln', { pathAlign: 'center', pathOffsetMm: 3 })])
    useCamStore.setState({ sketchTextEditId: 'tx', sketchTextCaretIndex: 1 } as never)
    const lut = pathLUT(LINE)!
    const resolved = effectiveStartOffsetMm(txt(), lut, textEntityAdvanceMm(txt()))
    expect(st().beginSketchDrag('tx', { x: resolved + 1, y: 1 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: resolved + 11, y: 1 })
    st().endSketchDrag()
    const s = st()
    expect(s.sketchTextEditId).toBe('tx') // edit survived the whole gesture
    expect(s.sketchTextCaretIndex).toBe(1) // caret index untouched by the slide
    expect(txt().pathAlign).toBe('free') // grabbing aligned text frees it
    expect(txt().pathOffsetMm).toBeCloseTo(resolved + 10, 6)
    // The open edit's toolbox mirror fields tracked the slide live.
    expect(s.sketchTextPathAlign).toBe('free')
    expect(s.sketchTextPathOffsetMm).toBeCloseTo(resolved + 10, 6)
  })

  it('dragging FREE text while its edit is open keeps the edit open too (M1c)', async () => {
    seed([LINE, textOn(undefined)])
    useCamStore.setState({ sketchTextEditId: 'tx' } as never)
    expect(st().beginSketchDrag('tx', { x: 5, y: 5 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 20, y: 9 })
    await settleDebounce()
    st().endSketchDrag()
    expect(st().sketchTextEditId).toBe('tx') // anchor drag never closes the edit
    // The anchor pin went down the solver path exactly as without an edit.
    expect(postedMessages.filter((m) => m.type === 'DRAG_SOLVE')).toHaveLength(1)
  })

  // ---- Regressions: everything WITHOUT a bound path is untouched ---------

  it('FREE text (no pathId) drags via the solver: DRAG_SOLVE pins the anchor to the cursor', async () => {
    // Fixed contract: this used to be a SILENT NO-OP (the drag plan's switch
    // had no 'text' case, so the gesture streamed DRAG_SOLVE with EMPTY
    // pins). Now the anchor -- the text's only gcs point (site 'start') --
    // is pinned at orig+delta, exactly like a point-entity drag.
    seed([LINE, textOn(undefined)])
    expect(st().beginSketchDrag('tx', { x: 5, y: 5 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 20, y: 9 })
    await settleDebounce()
    // The store never mutates the entity directly (solver-owned motion):
    // anchor untouched until the solver responds, and NO on-path fields
    // were invented.
    const ent = txt()
    expect(ent.at).toEqual({ x: 5, y: 5 })
    expect(ent.pathId).toBeUndefined()
    expect(ent.pathOffsetMm).toBeUndefined()
    expect(ent.pathAlign).toBeUndefined()
    // The gesture went down the SOLVER path with the anchor pin.
    const drags = postedMessages.filter((m) => m.type === 'DRAG_SOLVE')
    expect(drags).toHaveLength(1)
    const targets = drags[0].payload!.drag!.targets as Array<{
      point: { entityId: string; site: string }
      to: { x: number; y: number }
    }>
    expect(targets).toHaveLength(1)
    expect(targets[0].point).toEqual({ entityId: 'tx', site: 'start' })
    // Cursor moved by (+15, +4) from the grab; the pin = orig + delta.
    expect(targets[0].to).toEqual({ x: 20, y: 9 })
    st().endSketchDrag()
    expect(postedMessages.some((m) => m.type === 'SOLVE_SKETCH')).toBe(true)
  })

  it('grounded (fix) FREE text still refuses the drag', () => {
    seed(
      [LINE, textOn(undefined)],
      [{ id: 'f1', kind: 'fix', entityId: 'tx' }],
    )
    expect(st().beginSketchDrag('tx', { x: 5, y: 5 }, 0.5)).toBe(false)
  })

  it('REGRESSION: a line drag still streams DRAG_SOLVE with both endpoint pins', async () => {
    seed([LINE, textOn(undefined)])
    expect(st().beginSketchDrag('ln', { x: 50, y: 0 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 50, y: 5 })
    await settleDebounce()
    const drags = postedMessages.filter((m) => m.type === 'DRAG_SOLVE')
    expect(drags).toHaveLength(1)
    const targets = drags[0].payload!.drag!.targets as Array<{
      point: { entityId: string; site: string }
      to: { x: number; y: number }
    }>
    expect(targets).toHaveLength(2) // body grab: both endpoints, rigid
    expect(targets[0].to).toEqual({ x: 0, y: 5 })
    expect(targets[1].to).toEqual({ x: 100, y: 5 })
    st().endSketchDrag()
  })
})
