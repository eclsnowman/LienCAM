// WO-1461 (BUG-486, Codex audit family K7): append()'s auto-inferred snap
// constraints used to bake even when the solve rejected them. Store-level
// test against the REAL solver (the Worker global is a loopback that runs
// gcsMapping in-process, same technique as constraintApply.test.ts): a
// solve-failing inferred combination is refused and removed, never baked;
// an ordinary genuinely-solving inferred snap still commits exactly as
// before.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, PointRef,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { constraintRefIds } from '../../lib/sketch/refIds'
import type { SnapResult } from '../../lib/sketch/snap'

// ---- Loopback worker: real planegcs solve, in-process ----------------------

let wrapperPromise: Promise<GcsWrapper> | null = null
function ensureWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}

class LoopbackWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    void (async () => {
      const wrapper = await ensureWrapper()
      const { requestId, sketch } = msg.payload
      const out = msg.type === 'DRAG_SOLVE'
        ? solveSketchOnWrapper(wrapper, sketch, msg.payload.drag)
        : solveSketchOnWrapper(wrapper, sketch)
      const data: SketchWorkerResponseMsg = out.ok
        ? { type: 'SKETCH_SOLVE_COMPLETE', requestId,
            entities: out.entities, status: out.status, computeTimeMs: 0 }
        : { type: 'SKETCH_SOLVE_FAILED', requestId,
            reason: out.reason, message: out.message, status: out.status }
      this.onmessage?.({ data })
    })()
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', LoopbackWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let camSketchDocumentPort: typeof import('../../store').camSketchDocumentPort
let armTool: typeof import('../../lib/sketch/sketcher/toolController').armTool
let sketchClick: typeof import('../../lib/sketch/sketcher/toolController').click
let resetToolForDocumentSwitch: typeof import(
  '../../lib/sketch/sketcher/toolController'
).resetForDocumentSwitch

beforeAll(async () => {
  ;({ useCamStore, camSketchDocumentPort } = await import('../../store'))
  ;({ armTool, click: sketchClick, resetForDocumentSwitch: resetToolForDocumentSwitch } =
    await import('../../lib/sketch/sketcher/toolController'))
})

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  resetToolForDocumentSwitch()
})

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---- fixtures ---------------------------------------------------------------

function circle(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}
function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function makeSketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): Sketch {
  return { id: 'sk', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
}

describe('append() inferred-constraint reject-on-failure (WO-1461, BUG-486)', () => {
  it('a solve-failing inferred combo (point-on-circle + H + V onto two remote fixed points) is refused, not baked', async () => {
    // circle at the origin, radius 5 -- far from the H/V intersection below.
    // Two FIXED remote points: horizontal partner at y=10, vertical partner
    // at x=10. A new point constrained point-on-object(circle) + horizontal
    // (to pA) + vertical (to pB) is forced to (10, 10), whose distance from
    // the origin (~14.14) can never equal the circle's radius (5) -- the
    // three inferred constraints are jointly unsatisfiable by construction,
    // not by solver happenstance.
    const sk = makeSketch(
      [circle('c1', 0, 0, 5), point('pA', 0, 10), point('pB', 10, 0)],
      [
        // The circle must be PINNED too, not just the two alignment points --
        // otherwise the solver can satisfy point-on-object by moving/resizing
        // the free circle to pass through wherever H/V puts the new point,
        // which is not the conflict this fixture exists to force.
        { id: 'fxC', kind: 'fix', entityId: 'c1' },
        { id: 'fxA', kind: 'fix', point: ref('pA', 'self') },
        { id: 'fxB', kind: 'fix', point: ref('pB', 'self') },
      ],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    expect(useCamStore.getState().sketchSolveStatus?.solveFailed).toBeFalsy()

    const entitiesBefore = useCamStore.getState().activeSketch!.entities
    const constraintsBefore = useCamStore.getState().activeSketch!.constraints.length

    const commit = { entities: [point('pnew', 10, 10)], constraints: [] as SketchConstraint[] }
    const inferred: SketchConstraint[] = [
      { id: 'poo1', kind: 'point_on_object', point: ref('pnew', 'self'), object: 'c1' },
      { id: 'h1', kind: 'horizontal', points: [ref('pnew', 'self'), ref('pA', 'self')] },
      { id: 'v1', kind: 'vertical', points: [ref('pnew', 'self'), ref('pB', 'self')] },
    ]
    camSketchDocumentPort.append(commit, inferred)

    // Rejection lands as: entity+constraints removed + notice naming the
    // inference + a clean re-solve of the pre-commit sketch.
    await waitUntil(() => useCamStore.getState().sketchNotice !== null, 'rejection notice')
    const notice = useCamStore.getState().sketchNotice!
    expect(notice).toContain('Point on object')
    expect(notice).toContain('Horizontal')
    expect(notice).toContain('Vertical')
    expect(notice).toContain('rejected')

    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus !== null,
      're-solve after revert',
    )
    expect(useCamStore.getState().sketchSolveStatus?.solveFailed).toBeFalsy()
    const after = useCamStore.getState().activeSketch!
    // The click is refused: no new point, no inferred constraints baked.
    expect(after.entities.some((e) => e.id === 'pnew')).toBe(false)
    expect(after.entities).toHaveLength(entitiesBefore.length)
    expect(after.constraints).toHaveLength(constraintsBefore)
    expect(after.constraints.some((c) => c.id === 'poo1')).toBe(false)
    expect(after.constraints.some((c) => c.id === 'h1')).toBe(false)
    expect(after.constraints.some((c) => c.id === 'v1')).toBe(false)
    // The pre-existing circle and two fixed points are unchanged.
    const c1 = after.entities.find((e) => e.id === 'c1')
    if (!c1 || c1.kind !== 'circle') throw new Error('c1 missing')
    expect(c1.center).toEqual({ x: 0, y: 0 })
    expect(c1.radius).toBe(5)
  })

  it('an ordinary inferred snap that genuinely solves still commits and solves', async () => {
    const sk = makeSketch(
      [point('pA', 0, 10)],
      [{ id: 'fxA', kind: 'fix', point: ref('pA', 'self') }],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    const commit = { entities: [point('pnew2', 5, 5)], constraints: [] as SketchConstraint[] }
    const inferred: SketchConstraint[] = [
      { id: 'h2', kind: 'horizontal', points: [ref('pnew2', 'self'), ref('pA', 'self')] },
    ]
    camSketchDocumentPort.append(commit, inferred)

    await waitUntil(
      () => useCamStore.getState().activeSketch?.entities.some((e) => e.id === 'pnew2') === true,
      'append commit lands',
    )
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus !== null,
      'genuine solve completes',
    )
    const after = useCamStore.getState()
    expect(after.sketchSolveStatus?.solveFailed).toBeFalsy()
    expect(after.sketchNotice).toBeNull()
    expect(after.activeSketch!.constraints.some((c) => c.id === 'h2')).toBe(true)
    const pnew2 = after.activeSketch!.entities.find((e) => e.id === 'pnew2')
    if (!pnew2 || pnew2.kind !== 'point') throw new Error('pnew2 missing')
    expect(pnew2.at.y).toBeCloseTo(10, 6)
  })

  // AUDIT (2026-09-15, opus): the two tests above call append() directly,
  // never through the real line-tool chain -- that is why the regression
  // below went unseen. This test drives the REAL toolController.click()/
  // toolMachine chain (same fixture opus's scratch repro used): a rejected
  // segment leaves `chain.prevLineId` pointing at an entity append() just
  // removed, and the operator's NEXT click auto-joins onto it with a
  // coincident naming the dead id.
  it('a rejected chained line segment does not leave a dangling reference for the next click (audit 2026-09-15)', async () => {
    const sk = makeSketch(
      [circle('c1', 0, 0, 5), point('pA', 0, 10), point('pB', 10, 0)],
      [
        { id: 'fxC', kind: 'fix', entityId: 'c1' },
        { id: 'fxA', kind: 'fix', point: ref('pA', 'self') },
        { id: 'fxB', kind: 'fix', point: ref('pB', 'self') },
      ],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    // setActiveSketch injects origin/axis anchors, so the true baseline is
    // whatever landed, not the 3 fixture entities passed in.
    const baselineEntityCount = useCamStore.getState().activeSketch!.entities.length

    armTool('line')
    // Click 1: anchor only, no commit.
    sketchClick({ x: 20, y: 20 }, 0.01, null, false)

    // Click 2: lands on (10, 10) with the SAME unsatisfiable inferred combo
    // as BUG-486 (point-on-object(c1) + horizontal(pA) + vertical(pB)) --
    // on L1's 'end' site instead of a bare point, matching the audit's
    // reproduction. This commit is rejected.
    const rejectingSnap: SnapResult = {
      point: { x: 10, y: 10 },
      kind: 'curve',
      sourceEntityIds: ['c1'],
      inferences: [
        { kind: 'point_on_object', object: 'c1' },
        { kind: 'horizontal', to: ref('pA', 'self') },
        { kind: 'vertical', to: ref('pB', 'self') },
      ],
    }
    sketchClick({ x: 10, y: 10 }, 0.01, rejectingSnap, false)
    await waitUntil(() => useCamStore.getState().sketchNotice !== null, 'segment 2 rejection notice')
    expect(useCamStore.getState().sketchNotice).toContain('rejected')
    // The reject branch cascades entities back to the pre-commit baseline,
    // then triggers its own re-solve of the (now clean) sketch.
    await waitUntil(
      () =>
        useCamStore.getState().activeSketch!.entities.length === baselineEntityCount &&
        useCamStore.getState().sketchSolveStatus !== null &&
        !useCamStore.getState().sketchSolveStatus?.solveFailed,
      're-solve after segment 2 reject',
    )
    useCamStore.setState({ sketchNotice: null })

    // Click 3: a plain, unsnapped click. The line tool's chain still
    // believes segment 2 landed (chain.prevLineId = L1's id), so it tries
    // to auto-join a coincident onto an entity that no longer exists.
    const entitiesBeforeSeg3 = useCamStore.getState().activeSketch!.entities.length
    sketchClick({ x: 30, y: 0 }, 0.01, null, false)
    await waitUntil(
      () => useCamStore.getState().activeSketch!.entities.length === entitiesBeforeSeg3 + 1,
      'segment 3 lands',
    )
    await waitUntil(
      () =>
        useCamStore.getState().sketchSolveStatus !== null &&
        !useCamStore.getState().sketchSolveStatus?.solveFailed,
      'segment 3 solve',
    )

    const after = useCamStore.getState()
    // No failed solve, and specifically not the "unknown entity id" crash
    // the audit named.
    expect(after.sketchSolveStatus?.solveFailed).toBeFalsy()
    expect(after.sketchSolveStatus?.failureMessage ?? '').not.toContain('unknown entity id')

    const finalSketch = after.activeSketch!
    const liveIds = new Set(finalSketch.entities.map((e) => e.id))
    // No constraint may reference an entity that isn't actually in the
    // document -- the dangling-coincident regression the audit found.
    for (const c of finalSketch.constraints) {
      for (const refId of constraintRefIds(c)) {
        expect(liveIds.has(refId)).toBe(true)
      }
    }
    // Segment 3 landed as a free-floating line (its auto-join was dropped,
    // not baked as a dangling reference).
    const seg3 = finalSketch.entities.find(
      (e) => e.kind === 'line' && e.end.x === 30 && e.end.y === 0,
    )
    expect(seg3).toBeTruthy()
  })
})
