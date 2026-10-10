// BODY drag of the solver-INERT entities (ellipse, elliptical-arc, spline).
//
// These entities carry ONE addressable gcs point each: ellipse /
// elliptical-arc -> 'center'; spline -> 'start' (points[0]). Grabbing the
// body must pin that anchor to the cursor via the solver DRAG_SOLVE stream,
// exactly like a circle/arc center drag -- the inert body then translates
// rigidly (gcsMapping applies the anchor delta to the through-points). Before
// the drag-plan switch grew these cases the gesture streamed DRAG_SOLVE with
// EMPTY pins: a silent no-op that still burned an undo step (same class as
// the free-text anchor gap fixed earlier). This file is that regression.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sketch } from '../../lib/sketch/types'

// WO-1052: the `../../lib/geometry/worker` vi.mock this file used to carry
// mocked a module specifier that resolves to nothing in src/ and an export
// (`getGeometryWorker`) referenced nowhere else in the repo - dead code left
// over from an earlier architecture. Removed rather than typed (there is no
// real module to type against) and rather than left untyped (nothing in this
// file or in src/ ever imports it, so the mock was a no-op); the Worker global
// stub immediately below is what the sketch worker path actually exercises.
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

const ELLIPSE = {
  id: 'el', kind: 'ellipse' as const, construction: false,
  center: { x: 10, y: 20 }, majorRadius: 30, minorRadius: 15, rotation: 0,
}
const ELLIPTICAL_ARC = {
  id: 'ea', kind: 'elliptical-arc' as const, construction: false,
  center: { x: -5, y: 8 }, majorRadius: 20, minorRadius: 10, rotation: 0,
  startParam: 0, endParam: Math.PI,
}
const SPLINE = {
  id: 'sp', kind: 'spline' as const, construction: false,
  points: [{ x: 0, y: 0 }, { x: 10, y: 6 }, { x: 22, y: 2 }], closed: false,
}

type DragTarget = { point: { entityId: string; site: string }; to: { x: number; y: number } }

describe('inert-body drag pins the entity anchor (ellipse / elliptical-arc / spline)', () => {
  let useCamStore: typeof import('../../store').useCamStore
  beforeAll(async () => {
    ;({ useCamStore } = await import('../../store'))
  })

  function seed(entities: Sketch['entities']): void {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L', entities, constraints: [],
        dimensions: [], solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTool: 'select', sketchToolChain: null,
      sketchTextEditId: null, sketchPickPathForTextId: null,
    } as never)
  }
  beforeEach(() => { postedMessages.length = 0 })
  const st = () => useCamStore.getState()

  async function dragOnce(id: string, grab: { x: number; y: number }, to: { x: number; y: number }) {
    expect(st().beginSketchDrag(id, grab, 0.5)).toBe(true)
    st().moveSketchDrag(to)
    await settleDebounce()
    const drags = postedMessages.filter((m) => m.type === 'DRAG_SOLVE')
    st().endSketchDrag()
    return drags
  }

  it('ellipse body: DRAG_SOLVE pins the center at orig + cursor delta', async () => {
    seed([ELLIPSE])
    // Grab on the body, move by (+5, -3).
    const drags = await dragOnce('el', { x: 40, y: 20 }, { x: 45, y: 17 })
    expect(drags).toHaveLength(1)
    const targets = drags[0].payload!.drag!.targets as DragTarget[]
    expect(targets).toHaveLength(1) // NOT empty (the bug was empty pins)
    expect(targets[0].point).toEqual({ entityId: 'el', site: 'center' })
    expect(targets[0].to).toEqual({ x: 15, y: 17 }) // center (10,20) + (5,-3)
  })

  it('elliptical-arc body: DRAG_SOLVE pins the center at orig + cursor delta', async () => {
    seed([ELLIPTICAL_ARC])
    const drags = await dragOnce('ea', { x: 15, y: 8 }, { x: 25, y: 12 })
    expect(drags).toHaveLength(1)
    const targets = drags[0].payload!.drag!.targets as DragTarget[]
    expect(targets).toHaveLength(1)
    expect(targets[0].point).toEqual({ entityId: 'ea', site: 'center' })
    expect(targets[0].to).toEqual({ x: 5, y: 12 }) // center (-5,8) + (10,4)
  })

  it('spline body: DRAG_SOLVE pins the anchor (points[0], site start)', async () => {
    seed([SPLINE])
    const drags = await dragOnce('sp', { x: 10, y: 6 }, { x: 13, y: 6 })
    expect(drags).toHaveLength(1)
    const targets = drags[0].payload!.drag!.targets as DragTarget[]
    expect(targets).toHaveLength(1)
    expect(targets[0].point).toEqual({ entityId: 'sp', site: 'start' })
    // grab (10,6) -> to (13,6) = delta (+3,0); anchor (0,0) + delta.
    expect(targets[0].to).toEqual({ x: 3, y: 0 })
  })

  // SEAM EDIT (WO SKC-14-R1 finding 3): `beginSketchDrag` is a component-owned gesture's commit
  // sink and no longer pushes history itself -- the sketcher component opens exactly one undo step
  // through the `beforeMutate` hook, before the first write. The property under test is unchanged
  // (one step per gesture); the test drives the action the way the component does, and now pins
  // BOTH halves of the contract: the hook fires exactly once, and the store pushes nothing itself.
  it('the whole body drag is ONE undo step, opened by the caller before the first write', () => {
    seed([ELLIPSE])
    expect(st().sketchHistory).toHaveLength(0)
    let hookCalls = 0
    const beforeMutate = () => { hookCalls++; st().pushHistory() }
    expect(st().beginSketchDrag('el', { x: 40, y: 20 }, 0.5, beforeMutate)).toBe(true)
    st().moveSketchDrag({ x: 42, y: 20 })
    st().moveSketchDrag({ x: 45, y: 22 })
    st().endSketchDrag()
    expect(hookCalls).toBe(1)
    expect(st().sketchHistory).toHaveLength(1)
  })

  it('beginSketchDrag itself is history-free (the host commit operation opens no step)', () => {
    seed([ELLIPSE])
    expect(st().beginSketchDrag('el', { x: 40, y: 20 }, 0.5)).toBe(true)
    st().moveSketchDrag({ x: 42, y: 20 })
    st().endSketchDrag()
    // FAILS-IF: a pushHistory() call creeps back into the store action. Undo granularity belongs
    // to the component; a second owner of it is exactly the SKC-14 audit's finding 3.
    expect(st().sketchHistory).toHaveLength(0)
  })

  it('a refused drag never opens an undo step (the hook rides the accepted path only)', () => {
    seed([ELLIPSE])
    useCamStore.setState({
      sketchSolveStatus: { dof: 0, conflicting: [], redundant: [] },
    } as never)
    let hookCalls = 0
    expect(st().beginSketchDrag('el', { x: 40, y: 20 }, 0.5, () => { hookCalls++ })).toBe(false)
    expect(hookCalls).toBe(0)
  })

  it('a fully-defined sketch refuses the inert-body drag (solver gate holds)', () => {
    seed([ELLIPSE])
    useCamStore.setState({
      sketchSolveStatus: { dof: 0, conflicting: [], redundant: [] },
    } as never)
    expect(st().beginSketchDrag('el', { x: 40, y: 20 }, 0.5)).toBe(false)
  })

  it('a grounded (fix) inert entity refuses the drag', () => {
    useCamStore.setState({
      activeSketch: {
        id: 'sk', layerId: 'L', entities: [SPLINE], constraints: [
          { id: 'f1', kind: 'fix', entityId: 'sp' },
        ],
        dimensions: [], solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTool: 'select', sketchToolChain: null,
      sketchTextEditId: null, sketchPickPathForTextId: null,
    } as never)
    expect(st().beginSketchDrag('sp', { x: 10, y: 6 }, 0.5)).toBe(false)
  })
})
