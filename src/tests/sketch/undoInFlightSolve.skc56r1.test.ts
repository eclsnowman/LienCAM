// WO SKC-56-R1 major 3 -- CAM label-drag undo is not safe while a
// newly-dispatched sketch solve is in flight. undo() restores the prior
// project/sketch snapshot but (pre-fix) did not invalidate
// latestSketchRequestId, so a DELAYED worker response for the solve the
// undone gesture dispatched was still accepted and merged into the just-
// restored sketch -- overwriting its geometry while the dimension VALUE
// stayed at the restored figure (the exact split the auditor reproduced).
//
// A CONSTRUCTED interleave test (standing law: async/timing claims are
// settled by building the race, never by event-loop prose) against the
// REAL store + REAL planegcs solver, with a controllable "delayed Worker"
// that lets the test hold a computed response and release it AFTER undo()
// has already run.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchTextEntity, SketchConstraint, SketchDimension,
  PointRef,
} from '../../lib/sketch/types'
// The R4 cells assert against the census TABLES (to prove the throwaway channel
// is in none of them) -- imported, never restated, so the claim cannot rot.
import {
  ASYNC_WRITE_CHANNEL_CENSUS, CHANNEL_NAMED_EXCLUSIONS, DEFERRED_SKETCH_WRITE_SITES, DERIVED_FILES,
} from './asyncWriteChannelCensus'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'

// ---- Holdable loopback worker: real planegcs solve, in-process, but a
// response can be QUEUED instead of delivered immediately -- the test
// controls exactly when it lands relative to other store actions. ----------

let wrapperPromise: Promise<GcsWrapper> | null = null
function ensureWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}

class HoldableLoopbackWorker {
  static instances: HoldableLoopbackWorker[] = []
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  /** true = hold every posted message instead of resolving it immediately. */
  hold = false
  private held: Array<() => Promise<void>> = []
  constructor() { HoldableLoopbackWorker.instances.push(this) }
  postMessage(msg: SketchWorkerRequestMsg): void {
    const run = async () => {
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
    }
    if (this.hold) this.held.push(run)
    else void run()
  }
  /** Compute + deliver the oldest held response NOW (the "delayed Worker
   *  finally answers" moment). */
  async releaseOne(): Promise<void> {
    const run = this.held.shift()
    if (!run) throw new Error('releaseOne: no held response queued')
    await run()
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', HoldableLoopbackWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
// The R4 epoch gate's surface (WO SKC-56-R4). Imported from the SAME module the
// production code calls: the unknown-channel cell's throwaway writer commits
// through this exact function, per the construction rule stated at its describe.
let commitSketchGeometry: typeof import('../../store').commitSketchGeometry
let currentSketchGeometryEpoch: typeof import('../../store').currentSketchGeometryEpoch
let getSketchEpochRefusals: typeof import('../../store').getSketchEpochRefusals
let clearSketchEpochRefusals: typeof import('../../store').clearSketchEpochRefusals
// WO SKC-56-R5 cell C: append() is a SINK method, not a store action -- the
// sketcher package's commit path (store/index.ts:9858 exports the port), and the
// only way to reach append's placement solve, one of WO 1c's four named
// MUST-NOT-BUMP dispatches.
let camSketchDocumentPort: typeof import('../../store').camSketchDocumentPort

beforeAll(async () => {
  ;({
    useCamStore, commitSketchGeometry, currentSketchGeometryEpoch,
    getSketchEpochRefusals, clearSketchEpochRefusals, camSketchDocumentPort,
  } = await import('../../store'))
})

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchHistory: [],
    projectHistory: [],
    sketchFuture: [],
    projectFuture: [],
    canUndo: false,
    canRedo: false,
  })
})

// WO SKC-56-R5 MINOR: the drag gestures live in MODULE state (sketchDragPlan,
// sketchTextPathDrag, dragDebounceTimer/pendingDrag -- store/index.ts:2125,
// :2160, :1757-1758), OUTSIDE Zustand. beforeEach's setState cannot reach any
// of them, so a cell that ends without its own mouse-up leaves a plan ARMED and
// the NEXT cell's gesture is intercepted: moveSketchDrag reads
// sketchTextPathDrag FIRST (store/index.ts:7733) and takes the on-path-text
// branch, so a later SOLVER drag never reaches its own code path and passes
// vacuously. That is not hypothetical -- it is the R4 audit's MINOR, and the
// R5 cells below (which do solver drags) are the "later tests" it masks.
//
// endSketchDrag is the PRODUCTION teardown; it is called twice because the
// text-path branch returns early (store/index.ts:7811-7816) and so cannot clear
// a solver plan in the same call. activeSketch is nulled FIRST so the solver
// branch's settle solve (store/index.ts:7827) cannot dispatch a stray request
// that would land -- and be refused, polluting the refusal log -- inside the
// next cell.
afterEach(() => {
  useCamStore.setState({ activeSketch: null })
  useCamStore.getState().endSketchDrag() // clears sketchTextPathDrag, then returns
  useCamStore.getState().endSketchDrag() // clears sketchDragPlan + debounce timer + pendingDrag
  clearSketchEpochRefusals()
})

/** Real wall-clock wait. The suite deliberately does NOT use fake timers: the
 *  25 ms drag debounce these cells race against is the REAL production timer,
 *  and a faked clock would let the test choose an interleave the browser never
 *  produces (charter law: async claims are settled by CONSTRUCTING the race). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function currentWorker(): HoldableLoopbackWorker {
  const w = HoldableLoopbackWorker.instances.at(-1)
  if (!w) throw new Error('no worker instance yet -- dispatch a solve first')
  return w
}

// ---- fixtures ---------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }
function makeSketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): Sketch {
  return { id: 'sk', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
}
function deg(rad: number): number { return (rad * 180) / Math.PI }
function anchorAtDeg(d: number, r: number): { x: number; y: number } {
  const rad = (d * Math.PI) / 180
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) }
}
function measuredAngle(l1: SketchLineEntity, l2: SketchLineEntity): number {
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

describe('SKC-56-R1 major 3: undo invalidates an in-flight sketch solve request (real store + real solver)', () => {
  it('undo BEFORE a delayed sector-crossing response restores value, labelAnchor, AND geometry TOGETHER', async () => {
    const THETA_DEG = 47
    const rad = (THETA_DEG * Math.PI) / 180
    // Long (1000 mm) legs -- the same realistic scale as major 1's fixture,
    // and matching the auditor's own repro magnitude.
    const l1 = line('l1', 0, 0, 1000, 0)
    const l2 = line('l2', 0, 0, 1000 * Math.cos(rad), 1000 * Math.sin(rad))
    const startAnchor = anchorAtDeg(23, 500) // I1 (near sector, matches THETA_DEG)
    const sk = makeSketch(
      [l1, l2],
      [
        { id: 'f1s', kind: 'fix', point: ref('l1', 'start') },
        { id: 'f1e', kind: 'fix', point: ref('l1', 'end') },
        { id: 'f2s', kind: 'fix', point: ref('l2', 'start') },
      ],
      [
        { id: 'len2', kind: 'distance', driving: true, value: 1000,
          a: ref('l2', 'start'), b: ref('l2', 'end') },
        { id: 'ang', kind: 'angle', driving: true, value: rad, a: 'l1', b: 'l2',
          labelAnchor: startAnchor },
      ],
    )
    useCamStore.getState().setActiveSketch(sk) // dispatches + auto-delivers the open solve
    await waitUntil(() => useCamStore.getState().sketchSolveStatus?.dof === 0, 'open solve settle')

    const worker = currentWorker()

    // ONE undo step for the whole label-drag gesture -- mirrors the real
    // UI's beginGesture() -> pushHistory() wiring (Viewport.tsx) at drag start.
    useCamStore.getState().pushHistory()

    // Hold responses from here: the drag's solve dispatch must NOT resolve
    // until explicitly released below (models a slow/busy real worker).
    worker.hold = true
    // Drag the label into I2 (far sector, 133deg) -- a real sector crossing,
    // so updateDimensionLabel both rewrites the dimension's value/labelAnchor
    // AND dispatches a fresh solve targeting the new (133deg) constraint.
    const farAnchor = anchorAtDeg(113, 500)
    useCamStore.getState().updateDimensionLabel('ang', farAnchor)
    const staged = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ang')!
    // SKC-58B: the far sector stages the SIGNED reversed-operand value (-133deg,
    // |value| = 133 label) with reverseB=true -- a no-motion constraint.
    expect(deg(staged.value)).toBeCloseTo(-(180 - THETA_DEG), 3)
    expect((staged as { reverseB?: boolean }).reverseB).toBe(true)

    // The real undo, called BEFORE the delayed response arrives (the exact
    // interleave the auditor built and this fix must survive).
    useCamStore.getState().undo()
    const afterUndo = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ang')!
    expect(deg(afterUndo.value)).toBeCloseTo(THETA_DEG, 6)
    expect(afterUndo.labelAnchor).toEqual(startAnchor)

    // NOW the delayed response lands: the solved geometry for the 133deg
    // target the drag posted BEFORE undo ran. SKC-56-R2: undo() ALSO
    // redispatches its own re-solve (seam invariant half (b)) against the
    // just-restored 47deg snapshot -- a SECOND held response queued behind
    // the drag's -- so both must be drained here (idempotent no-op for the
    // second, restored geometry already matches its own target) or it leaks
    // into the next test's queue.
    worker.hold = false
    await worker.releaseOne() // the drag's own (133deg-targeted) response: stale, dropped
    await worker.releaseOne() // the seam's re-solve (47deg-targeted): applies, idempotent no-op

    const finalSketch = useCamStore.getState().activeSketch!
    const finalDim = finalSketch.dimensions.find((d) => d.id === 'ang')!
    const fl1 = finalSketch.entities.find((e) => e.id === 'l1') as SketchLineEntity
    const fl2 = finalSketch.entities.find((e) => e.id === 'l2') as SketchLineEntity
    const measuredDeg = Math.abs(deg(measuredAngle(fl1, fl2)))

    // VALUE, LABEL ANCHOR, and GEOMETRY restore TOGETHER -- none of them is
    // silently overwritten by the stale 133deg response. Pre-fix, this is
    // exactly the reproduced bug: value stayed 47deg (this assertion alone
    // passed even before the fix) while measured geometry became 133deg
    // (the next assertion is the one the fix makes pass).
    expect(deg(finalDim.value)).toBeCloseTo(THETA_DEG, 6)
    expect(finalDim.labelAnchor).toEqual(startAnchor)
    expect(measuredDeg).toBeCloseTo(THETA_DEG, 3)
    expect(measuredDeg).not.toBeCloseTo(180 - THETA_DEG, 3)
  })

  it('SHARED-SEAM regression: undo BEFORE a delayed commitDimensionValue response also drops the stale write (a second, non-angle in-flight write path through the same delayed-response shape)', async () => {
    const l1 = line('l1', 0, 0, 10, 0)
    const sk = makeSketch(
      [l1],
      [{ id: 'f1s', kind: 'fix', point: ref('l1', 'start') }],
      [{ id: 'len', kind: 'distance', driving: true, value: 10,
          a: ref('l1', 'start'), b: ref('l1', 'end') }],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    const worker = currentWorker()
    worker.hold = true
    // commitDimensionValue pushes its OWN history step internally, then
    // dispatches a verdict solve tracked via pendingDimensionApply.
    useCamStore.getState().commitDimensionValue('len', 25)
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!.value).toBe(25)

    useCamStore.getState().undo()
    const afterUndo = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!
    expect(afterUndo.value).toBe(10)

    // SKC-56-R2: same two-response drain as the angle case above -- the
    // commit's own verdict solve (stale) plus the seam's re-solve after
    // undo (applies, idempotent no-op against the already-settled 10mm
    // snapshot).
    worker.hold = false
    await worker.releaseOne() // the commit's own (25mm-targeted) verdict response: stale, dropped
    await worker.releaseOne() // the seam's re-solve (10mm-targeted): applies, idempotent no-op

    const finalSketch = useCamStore.getState().activeSketch!
    const finalDim = finalSketch.dimensions.find((d) => d.id === 'len')!
    const finalL1 = finalSketch.entities.find((e) => e.id === 'l1') as SketchLineEntity
    // The delayed 25 mm-targeted response must never land on the restored
    // 10 mm sketch -- same generic invalidation as the angle case above,
    // proving the fix is NOT sector-specific.
    expect(finalDim.value).toBe(10)
    expect(Math.hypot(finalL1.end.x - finalL1.start.x, finalL1.end.y - finalL1.start.y))
      .toBeCloseTo(10, 6)
  })
})

// ---- WO SKC-56-R2 -----------------------------------------------------------
//
// The DECISIONS 2026-07-16 "SKC-56 async-coherence" ruling requires the FULL
// constructed-interleave MATRIX: {undo, redo} x {response arrives before
// restore, after restore} x {snapshot was staged mid-solve, snapshot was
// settled}.
//
// UNREACHABILITY PROOF for the "staged x response-before-restore" cell, BOTH
// directions (undo and redo): a snapshot is "staged" precisely because its
// OWN solve response has not yet landed (that is what "mid-solve" means --
// see updateDimensionLabel's sector-crossing write, which stages value +
// labelAnchor synchronously and dispatches its solve separately). "response
// arrives before restore" for THAT SAME dispatch would mean the response
// landed BEFORE undo()/redo() ran -- but a landed response is exactly what
// the onmessage handler's remeasure branch (`cam-solve-complete-remeasure`)
// uses to make a sketch settled (it rewrites `entities`/`dimensions` to the
// solved figure). So "response landed before restore" and "snapshot is still
// staged at restore time" are mutually exclusive by construction: if the
// response for that dispatch already landed, the snapshot is no longer
// staged; if it has not landed, "before restore" cannot hold. This is
// structural (a property of the store's own onmessage/staging code, not a
// timing accident), so no test can occupy this cell for either undo or redo
// -- there is nothing to construct.
//
// The "settled" row has no outstanding response to order relative to the
// restore (there IS no solve in flight when a snapshot is captured already-
// settled), so "before"/"after" collapse to one cell per direction. The 4
// LIVE cells are: {undo, staged, after} (R1's own test above, extended
// nowhere further -- it already covers this), {redo, staged, after} (the R2
// defect -- new test below), {undo, settled} and {redo, settled} (round-trip
// regression cells -- new tests below).

describe('SKC-56-R2: {redo, staged, after} -- the exact re-audit defect', () => {
  it('undo (mid-drag) stages the drag-in-progress sketch into sketchFuture; a LATER redo restores that staged snapshot and the seam re-dispatches its OWN solve rather than leaving it forever unsolved', async () => {
    const THETA_DEG = 47
    const rad = (THETA_DEG * Math.PI) / 180
    const l1 = line('l1', 0, 0, 1000, 0)
    const l2 = line('l2', 0, 0, 1000 * Math.cos(rad), 1000 * Math.sin(rad))
    const startAnchor = anchorAtDeg(23, 500)
    const sk = makeSketch(
      [l1, l2],
      [
        { id: 'f1s', kind: 'fix', point: ref('l1', 'start') },
        { id: 'f1e', kind: 'fix', point: ref('l1', 'end') },
        { id: 'f2s', kind: 'fix', point: ref('l2', 'start') },
      ],
      [
        { id: 'len2', kind: 'distance', driving: true, value: 1000,
          a: ref('l2', 'start'), b: ref('l2', 'end') },
        { id: 'ang', kind: 'angle', driving: true, value: rad, a: 'l1', b: 'l2',
          labelAnchor: startAnchor },
      ],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus?.dof === 0, 'open solve settle')

    const worker = currentWorker()

    // Gesture begin: the settled (47deg) sketch is what pushHistory() saves
    // into sketchHistory -- this is the snapshot undo() will restore below.
    useCamStore.getState().pushHistory()

    // Hold every response from here -- undo's OWN re-solve dispatch (half
    // (b) of the seam) must be held too, so the test controls exactly when
    // each of the three solves this scenario produces lands.
    worker.hold = true

    // Drag the label into the far (133deg) sector: stages value + labelAnchor
    // synchronously, dispatches requestA (133deg-targeted, held).
    const farAnchor = anchorAtDeg(113, 500)
    useCamStore.getState().updateDimensionLabel('ang', farAnchor)
    const staged = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ang')!
    // SKC-58B: signed reversed-operand far value (-133deg, |value|=133 label).
    expect(deg(staged.value)).toBeCloseTo(-(180 - THETA_DEG), 3)

    // undo(): restores the settled 47deg snapshot from sketchHistory AND
    // pushes the CURRENTLY-staged (133deg, unsolved) sketch into
    // sketchFuture -- this is the R1-re-audit's exact "stale snapshot"
    // shape. The seam's re-solve half also dispatches requestB (47deg-
    // targeted, held) against the just-restored settled snapshot.
    useCamStore.getState().undo()
    const afterUndo = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ang')!
    expect(deg(afterUndo.value)).toBeCloseTo(THETA_DEG, 6)
    expect(afterUndo.labelAnchor).toEqual(startAnchor)

    // redo(): pops the STAGED 133deg snapshot back out of sketchFuture and
    // restores it as activeSketch -- value/labelAnchor flip to the staged
    // 133deg figure immediately, but the ENTITIES are still whatever they
    // were the instant updateDimensionLabel wrote them (unsolved for this
    // target) -- exactly the auditor's reproduced split, as an intermediate
    // assertion here. Un-fixed, this split would never resolve (the R2
    // defect); the seam's re-solve half dispatches requestC (133deg-
    // targeted, held) to fix it below.
    useCamStore.getState().redo()
    const afterRedo = useCamStore.getState().activeSketch!
    const afterRedoDim = afterRedo.dimensions.find((d) => d.id === 'ang')!
    expect(deg(afterRedoDim.value)).toBeCloseTo(-(180 - THETA_DEG), 3) // SKC-58B signed far value
    expect(afterRedoDim.labelAnchor).toEqual(farAnchor)
    const midL1 = afterRedo.entities.find((e) => e.id === 'l1') as SketchLineEntity
    const midL2 = afterRedo.entities.find((e) => e.id === 'l2') as SketchLineEntity
    const midMeasuredDeg = Math.abs(deg(measuredAngle(midL1, midL2)))
    expect(midMeasuredDeg, 'the auditor\'s exact split: value/labelAnchor already flipped, geometry not yet')
      .toBeCloseTo(THETA_DEG, 3)

    // Release requestA, requestB, requestC in that order (FIFO). A and B are
    // both stale (latestSketchRequestId has moved on twice since either was
    // dispatched) and must be dropped; only C -- the seam's re-solve against
    // the restored STAGED snapshot -- may land.
    worker.hold = false
    await worker.releaseOne() // requestA: stale, dropped
    await worker.releaseOne() // requestB: stale, dropped
    await worker.releaseOne() // requestC: matches, applies

    const finalSketch = useCamStore.getState().activeSketch!
    const finalDim = finalSketch.dimensions.find((d) => d.id === 'ang')!
    const fl1 = finalSketch.entities.find((e) => e.id === 'l1') as SketchLineEntity
    const fl2 = finalSketch.entities.find((e) => e.id === 'l2') as SketchLineEntity
    const measuredDeg = Math.abs(deg(measuredAngle(fl1, fl2)))

    // VALUE, LABEL ANCHOR, and GEOMETRY converge TOGETHER -- the R2 fix:
    // redo's restored (staged) snapshot got its OWN solve (requestC actually
    // landed, not left forever unsolved). SKC-58B: that solve is a NO-MOTION
    // far/obtuse constraint, so the geometry stays at the drawn 47deg while the
    // dimension reads the obtuse 133 (value -133) -- the seam invariant (the
    // snapshot IS re-solved) holds; the geometry outcome is Operator's no-motion bar.
    expect(deg(finalDim.value)).toBeCloseTo(-(180 - THETA_DEG), 3)
    expect(finalDim.labelAnchor).toEqual(farAnchor)
    expect(measuredDeg).toBeCloseTo(THETA_DEG, 3) // no motion: geometry stays acute 47
    expect(measuredDeg).not.toBeCloseTo(180 - THETA_DEG, 3)
  })
})

describe('SKC-56-R2: {undo, settled} and {redo, settled} -- round-trip regression (no staged-solve race involved)', () => {
  // SKC-56-R3 (R2 audit major 2): these two cells asserted only value +
  // measured geometry, so a labelAnchor corrupted by a restore would have gone
  // unnoticed here -- the other cells' THREE-WAY oracle (value + labelAnchor +
  // geometry) was the one the ruling requires everywhere. The dimension now
  // carries a labelAnchor and every step asserts all three.
  const SETTLED_ANCHOR = { x: 5, y: 2 }

  it('undo then redo across an ALREADY-SETTLED edit converge value + labelAnchor + measured geometry at each step (the seam\'s re-solve half is a no-op here, not a regression)', async () => {
    const l1 = line('l1', 0, 0, 10, 0)
    const sk = makeSketch(
      [l1],
      [{ id: 'f1s', kind: 'fix', point: ref('l1', 'start') }],
      [{ id: 'len', kind: 'distance', driving: true, value: 10,
          a: ref('l1', 'start'), b: ref('l1', 'end'), labelAnchor: SETTLED_ANCHOR }],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    // commitDimensionValue pushes ITS OWN history step (the settled 10mm
    // sketch) and dispatches a verdict solve for the 25mm edit -- worker is
    // NOT held here, so the response lands on its own; wait for it so the
    // 25mm sketch is fully SETTLED (not staged) before undo() runs below --
    // this is what makes this cell {settled}, not {staged}.
    useCamStore.getState().commitDimensionValue('len', 25)
    await waitUntil(() => {
      const e = useCamStore.getState().activeSketch!.entities.find((x) => x.id === 'l1') as SketchLineEntity
      return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) > 24.999
    }, '25mm solve settle')

    // {undo, settled}: restores the already-settled 10mm snapshot; the
    // seam's re-solve half re-dispatches against it (idempotent no-op) --
    // wait for that response too before asserting.
    useCamStore.getState().undo()
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!.value).toBe(10)
    await waitUntil(() => {
      const e = useCamStore.getState().activeSketch!.entities.find((x) => x.id === 'l1') as SketchLineEntity
      return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) < 10.001
    }, 'undo re-solve settle (10mm)')
    const afterUndoDim = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!
    const afterUndoL1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1') as SketchLineEntity
    // THREE-WAY oracle, all three at the SAME instant (post-re-solve).
    expect(afterUndoDim.value).toBe(10)
    expect(afterUndoDim.labelAnchor).toEqual(SETTLED_ANCHOR)
    expect(Math.hypot(afterUndoL1.end.x - afterUndoL1.start.x, afterUndoL1.end.y - afterUndoL1.start.y))
      .toBeCloseTo(10, 6)

    // {redo, settled}: restores the already-settled 25mm snapshot pushed by
    // the undo() step above (settled BEFORE undo() ran, per the wait above);
    // same idempotent-no-op re-solve, then converges.
    useCamStore.getState().redo()
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!.value).toBe(25)
    await waitUntil(() => {
      const e = useCamStore.getState().activeSketch!.entities.find((x) => x.id === 'l1') as SketchLineEntity
      return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) > 24.999
    }, 'redo re-solve settle (25mm)')
    const afterRedoDim = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!
    const afterRedoL1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1') as SketchLineEntity
    expect(afterRedoDim.value).toBe(25)
    // The anchor rides the redone snapshot untouched: commitDimensionValue
    // rewrites `value` only, and a driving dim is never remeasured.
    expect(afterRedoDim.labelAnchor).toEqual(SETTLED_ANCHOR)
    expect(Math.hypot(afterRedoL1.end.x - afterRedoL1.start.x, afterRedoL1.end.y - afterRedoL1.start.y))
      .toBeCloseTo(25, 6)
  })
})

// ---- WO SKC-56-R3 -----------------------------------------------------------
//
// The DECISIONS 2026-07-17 "SKC-56 async-coherence THIRD strike" ruling widens
// the matrix from {undo,redo} x {before,after} x {staged,settled} to ONE CELL
// PER CENSUSED CHANNEL (src/tests/sketch/asyncWriteChannelCensus.ts derives the
// six channels and fails when a seventh appears undispositioned). The cells
// below are the three the R2 seam had no cell for: the two drag channels -- the
// audit's BLOCKER, in both of its failure modes -- and the constraint verdict.
//
// WHICH CELL COVERS WHICH CHANNEL (the ruling's "one interleave cell per
// channel", discharged; the census test is what proves the channel LIST itself
// is complete):
//   latestSketchRequestId  -> 'undo BEFORE a delayed sector-crossing response'
//                             and '{redo, staged, after}'             (above)
//   pendingDimensionApply  -> 'SHARED-SEAM regression: ... commitDimensionValue'
//                                                                     (above)
//   pendingConstraintApply -> '{pendingConstraintApply}'              (below)
//   dragDebounceTimer      -> '{dragDebounceTimer + pendingDrag}'     (below)
//   pendingDrag            -> '{dragDebounceTimer + pendingDrag}'     (below)
//   sketchDragPlan         -> '{sketchDragPlan, live-rearm}'          (below)

/** The R3 drag fixture: a line anchored at its start to a FIXED point entity
 *  and held at a driving length, leaving the sketch ONE degree of freedom
 *  (rotation about that anchor). Every part of that shape is load-bearing, and
 *  two of beginSketchDrag's own refusals are why:
 *   - dof MUST stay > 0: `if (status.dof === 0) return false` -- fully-defined
 *     geometry must not budge, so a rigid fixture makes the cell vacuous.
 *   - the anchor MUST be a separate `point` entity carrying the `fix`, NOT a
 *     fix on l1's own start: beginSketchDrag treats an entity named by ANY fix
 *     constraint as GROUNDED and refuses the drag outright ("immovable by
 *     definition"). Grounding through a coincident-to-a-fixed-point is how the
 *     real sketcher pins geometry that is still meant to be draggable.
 *  The retained length then means a drag can only ROTATE the line, so
 *  restored-vs-dragged geometry is unambiguous while the dimension's own value
 *  stays invariant under the drag. */
const DRAG_ANCHOR = { x: 5, y: 2 }
function dragFixture(lengthMm: number): Sketch {
  return makeSketch(
    [
      { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } },
      line('l1', 0, 0, lengthMm, 0),
    ],
    [
      { id: 'f0', kind: 'fix', point: ref('p0', 'self') },
      { id: 'c0', kind: 'coincident', a: ref('l1', 'start'), b: ref('p0', 'self') },
    ],
    [{ id: 'len', kind: 'distance', driving: true, value: lengthMm,
        a: ref('l1', 'start'), b: ref('l1', 'end'), labelAnchor: DRAG_ANCHOR }],
  )
}
function l1Of(): SketchLineEntity {
  return useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1') as SketchLineEntity
}
function lenDimOf(): SketchDimension {
  return useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'len')!
}

describe('SKC-56-R3: {dragDebounceTimer + pendingDrag, queued-timer} -- the R2 audit BLOCKER, verbatim', () => {
  it('a debounced drag QUEUED before undo must not fire into the restored sketch: value + labelAnchor + MEASURED geometry all stay restored', async () => {
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    // The gate this fixture is shaped for: beginSketchDrag refuses a dof-0
    // sketch, so a rotation-free fixture would make this whole cell vacuous.
    expect(
      useCamStore.getState().sketchSolveStatus!.dof,
      'the fixture must retain a rotational dof or beginSketchDrag refuses and the cell is vacuous',
    ).toBeGreaterThan(0)
    expect(l1Of().end.x).toBeCloseTo(10, 6)
    expect(l1Of().end.y).toBeCloseTo(0, 6)

    // Gesture begin: ONE undo step for the whole drag (the real UI's
    // beforeMutate -> pushHistory wiring), capturing the settled (10, 0) line.
    useCamStore.getState().pushHistory()
    expect(useCamStore.getState().beginSketchDrag('l1', { x: 10, y: 0 }, 1)).toBe(true)

    // ONE pointer move: dragSolveSketch ARMS the 25ms trailing debounce and
    // parks the targets in pendingDrag. Nothing is posted to the worker yet --
    // the write is QUEUED, not in flight, which is exactly why the R1/R2
    // request-id invalidation cannot reach it.
    useCamStore.getState().moveSketchDrag({ x: 10, y: 10 })

    // The keyboard undo lands INSIDE the debounce window (synchronously -- no
    // await between the move and here, so 25ms of real time has not passed).
    // The R2 audit's finding verbatim: "A drag queued before undo therefore
    // survives the restore and can overwrite restored geometry."
    useCamStore.getState().undo()

    // Well past both the 25ms debounce and a worker round-trip. Had the timer
    // survived, it has now fired -- minting a requestId NEWER than the seam's
    // own re-solve, so the stale-response guard cannot save the restored
    // geometry and the drag's (10,10)-targeted solve wins.
    await sleep(250)

    const dim = lenDimOf()
    const l1 = l1Of()
    expect(dim.value, 'a DRAG_SOLVE never writes the dimension value -- this assertion passes even unfixed').toBe(10)
    expect(dim.labelAnchor, 'a DRAG_SOLVE never writes labelAnchor either -- also passes unfixed').toEqual(DRAG_ANCHOR)
    // THIS is the assertion the fix makes pass: unfixed, the queued drag pins
    // the end toward (10,10) under the retained 10mm length, landing it at
    // ~(7.07, 7.07) -- restored geometry silently overwritten.
    expect(l1.end.x, 'restored geometry: the queued drag must never have fired').toBeCloseTo(10, 3)
    expect(l1.end.y).toBeCloseTo(0, 3)
    expect(l1.end.y).not.toBeCloseTo(7.07, 1)
    // The LENGTH is invariant under the drag (the driving dim holds it), so it
    // can never be the assertion that catches this -- said out loud so nobody
    // later "simplifies" the cell down to a length check.
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(10, 3)
  })

  it('CONTROL (non-vacuity): the SAME queued drag with NO undo DOES fire and DOES move the geometry -- proving the cell above refuses a real, reachable write rather than an inert one', async () => {
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    useCamStore.getState().pushHistory()
    expect(useCamStore.getState().beginSketchDrag('l1', { x: 10, y: 0 }, 1)).toBe(true)
    useCamStore.getState().moveSketchDrag({ x: 10, y: 10 })
    // No undo: the debounce fires, the DRAG_SOLVE lands, the line rotates.
    await waitUntil(() => l1Of().end.y > 1, 'the queued drag fires and rotates the line', 5000)

    const l1 = l1Of()
    expect(l1.end.y).toBeCloseTo(7.07, 1)
    expect(l1.end.x).toBeCloseTo(7.07, 1)
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(10, 3)
  })
})

describe('SKC-56-R3: {sketchDragPlan, live-rearm} -- the pointer is still DOWN through a keyboard undo', () => {
  it('after undo, the next pointer move must not re-arm a fresh drag against PRE-restore targets: the PLAN is invalidated, not merely the timer', async () => {
    // No timer is ever armed before the undo in this cell -- that is the point.
    // Clearing dragDebounceTimer/pendingDrag cannot help here; only dropping
    // the PLAN can, which is why this mode needs its own cell (and why
    // endSketchDrag's mouse-up-only clear is unreachable from Ctrl+Z).
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    // A settled edit to 25mm, so there is a genuinely DIFFERENT snapshot to
    // undo back to (commitDimensionValue pushes the 10mm snapshot itself).
    useCamStore.getState().commitDimensionValue('len', 25)
    await waitUntil(() => l1Of().end.x > 24.999, '25mm solve settle')

    // Pointer DOWN on the end of the 25mm line: the plan captures orig=(25,0),
    // a position that exists only in the PRE-restore geometry.
    expect(useCamStore.getState().beginSketchDrag('l1', { x: 25, y: 0 }, 1)).toBe(true)

    // Ctrl+Z with the button still held: back to the settled 10mm snapshot.
    useCamStore.getState().undo()
    expect(lenDimOf().value).toBe(10)
    await waitUntil(() => l1Of().end.x < 10.001, 'undo re-solve settle (10mm)')

    // The mouse moves again -- the browser has no idea a restore happened.
    // Unfixed, this re-arms a FRESH 25ms debounce whose targets are computed
    // from the stale orig=(25,0), pinning the end toward (25,30) and rotating
    // the RESTORED 10mm line to ~(6.4, 7.68).
    useCamStore.getState().moveSketchDrag({ x: 25, y: 30 })
    await sleep(250)

    const dim = lenDimOf()
    const l1 = l1Of()
    expect(dim.value).toBe(10)
    expect(dim.labelAnchor).toEqual(DRAG_ANCHOR)
    expect(l1.end.x, 'restored geometry: the stale plan must not have re-armed').toBeCloseTo(10, 3)
    expect(l1.end.y).toBeCloseTo(0, 3)
    expect(l1.end.y).not.toBeCloseTo(7.68, 1)
  })

  it('the invalidated gesture stays inert through its own mouse-up: endSketchDrag after a restore neither settles stale targets nor throws (the cleanup tail)', async () => {
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    useCamStore.getState().commitDimensionValue('len', 25)
    await waitUntil(() => l1Of().end.x > 24.999, '25mm solve settle')

    expect(useCamStore.getState().beginSketchDrag('l1', { x: 25, y: 0 }, 1)).toBe(true)
    useCamStore.getState().undo()
    await waitUntil(() => l1Of().end.x < 10.001, 'undo re-solve settle (10mm)')

    // The gesture the restore invalidated still receives its pointermove AND
    // its pointerup: neither may resurrect anything.
    useCamStore.getState().moveSketchDrag({ x: 25, y: 30 })
    useCamStore.getState().endSketchDrag()
    await sleep(250)

    const l1 = l1Of()
    expect(l1.end.x).toBeCloseTo(10, 3)
    expect(l1.end.y).toBeCloseTo(0, 3)
    expect(lenDimOf().value).toBe(10)
    expect(lenDimOf().labelAnchor).toEqual(DRAG_ANCHOR)
  })
})

describe('SKC-56-R3: {pendingConstraintApply} -- an apply VERDICT computed for the pre-restore sketch', () => {
  it('undo BEFORE a held REJECT verdict lands: the verdict must not strip constraints from the restored sketch, nor announce a rejection of a constraint the restore already removed', async () => {
    // l1 is pinned horizontal at a driving 10mm from a fixed start, so adding
    // `vertical` on top genuinely CONFLICTS and the verdict comes back
    // SKETCH_SOLVE_FAILED -- the reject path, which is the branch with teeth
    // (it filters the applied constraints back out and fires a notice).
    const sk = makeSketch(
      [line('l1', 0, 0, 10, 0)],
      [
        { id: 'f1s', kind: 'fix', point: ref('l1', 'start') },
        { id: 'h1', kind: 'horizontal', line: 'l1' },
      ],
      [{ id: 'len', kind: 'distance', driving: true, value: 10,
          a: ref('l1', 'start'), b: ref('l1', 'end'), labelAnchor: DRAG_ANCHOR }],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    const constraintIdsBefore = useCamStore.getState().activeSketch!.constraints.map((c) => c.id).sort()

    const worker = currentWorker()
    worker.hold = true

    // applySketchConstraint pushes its OWN history step, stages the constraint,
    // and posts a verdict solve tracked via pendingConstraintApply (held here).
    useCamStore.getState().setSketchSelection(['l1'])
    useCamStore.getState().applySketchConstraint('vertical')
    expect(
      useCamStore.getState().activeSketch!.constraints.some((c) => c.kind === 'vertical'),
      'the constraint is staged synchronously, ahead of its verdict',
    ).toBe(true)

    // Undo before the verdict lands: the restore drops the vertical along with
    // the snapshot AND neutralizes the verdict channel it was posted on.
    useCamStore.getState().undo()
    expect(useCamStore.getState().activeSketch!.constraints.some((c) => c.kind === 'vertical')).toBe(false)

    worker.hold = false
    await worker.releaseOne() // the apply's own verdict (FAILED/conflicting): stale, dropped
    await worker.releaseOne() // the seam's re-solve against the restored snapshot: applies

    const s = useCamStore.getState()
    expect(
      s.activeSketch!.constraints.map((c) => c.id).sort(),
      'the restored constraint set is untouched by the stale verdict',
    ).toEqual(constraintIdsBefore)
    expect(
      s.sketchNotice ?? '',
      'no rejection may be announced for a constraint the restore already removed',
    ).not.toMatch(/rejected/i)
    // Three-way oracle on the restored document.
    const dim = lenDimOf()
    const l1 = l1Of()
    expect(dim.value).toBe(10)
    expect(dim.labelAnchor).toEqual(DRAG_ANCHOR)
    expect(l1.end.x).toBeCloseTo(10, 3)
    expect(l1.end.y).toBeCloseTo(0, 3)
  })
})

// ---- WO SKC-56-R4 -----------------------------------------------------------
//
// DECISIONS 2026-07-17 "SKC-56 FOURTH strike": the invariant is INVERTED. The
// cells above each prove ONE enumerated channel is neutralized at the seam;
// four rounds of that pattern shipped four incomplete enumerations. The two
// cells below prove the replacement invariant instead -- that the store REFUSES
// a stale write regardless of which channel carried it:
//
//   R4 cell 1 (item 2) -- sketchTextPathDrag: the R3 audit's BLOCKER. Its
//     cached path+LUT SURVIVE the restore by design (the seam does not clear
//     it); the WRITE is refused at the gateway.
//   R4 cell 2 (item 3) -- the UNKNOWN channel: a throwaway async writer
//     authored HERE, in the test, appearing in no census at all. This is the
//     cell that ends the saga, because it proves correctness is
//     ENUMERATION-INDEPENDENT: the gate never learns the channel's name.
//
// THE CONSTRUCTION RULE for the unknown-channel cell (WO item 3a, stated here
// because a test that gets this wrong passes vacuously and proves nothing):
// the throwaway writer MUST commit through commitSketchGeometry -- the SAME
// gateway function every real deferred site calls -- and NEVER through a raw
// useCamStore.setState({ activeSketch }). Raw setState was never gated by
// anything, so a throwaway writer that bypassed the gateway would "pass" while
// demonstrating nothing. Committing through the gateway is what makes the claim
// "the check is channel-agnostic" the thing actually under test.

/** A text bound to a straight path, at a known offset. Arc length s == x on
 *  this path, so every projection in the cell below is arithmetic a reader can
 *  check by hand. */
function textPathFixture(pathLengthMm: number, pathOffsetMm: number): Sketch {
  return makeSketch([
    { id: 'ln', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: pathLengthMm, y: 0 } },
    { id: 'tx', kind: 'text', construction: false,
      at: { x: 5, y: 5 }, text: 'HI', height: 5, rotation: 0,
      fontStyle: 'single-line', pathId: 'ln', pathAlign: 'free',
      pathOffsetMm, pathFlip: false },
  ])
}
function txOf(): SketchTextEntity {
  return useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'tx') as SketchTextEntity
}
function lnOf(): SketchLineEntity {
  return useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'ln') as SketchLineEntity
}
function refusalsOn(channel: string): readonly { channel: string; mintedEpoch: number; currentEpoch: number }[] {
  return getSketchEpochRefusals().filter((r) => r.channel === channel)
}

describe('SKC-56-R4 cell 1: {sketchTextPathDrag} -- the R3 audit BLOCKER: a cached plan that SURVIVES the restore, whose write is refused', () => {
  it('a mid-gesture restore leaves the plan alive with its stale 100mm path cached, and the next pointer move is REFUSED BY NAME instead of writing pathOffsetMm=70 onto the restored 40mm path', async () => {
    clearSketchEpochRefusals()
    // The audit's own repro, verbatim in shape: "seed a 40 mm path, push
    // history, move to a 100 mm path, begin the text drag with the real
    // beforeMutate pushHistory hook, invoke undo twice while the pointer
    // remains down, then move at x=80."
    useCamStore.getState().setActiveSketch(textPathFixture(40, 10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    expect(lnOf().end.x, 'the 40mm path is the state the restore must return to').toBeCloseTo(40, 9)

    // Grow the path to 100mm. updateEntity pushes its own history step, so the
    // 40mm document is now a real snapshot to come back to.
    useCamStore.getState().updateEntity('ln', { end: { x: 100, y: 0 } } as Partial<SketchEntity>)
    expect(lnOf().end.x).toBeCloseTo(100, 9)

    // Pointer DOWN at s=20 on the 100mm path, with the REAL beforeMutate ->
    // pushHistory hook the component supplies. beginSketchDrag caches the
    // 100mm path entity + its arc-length LUT in the plan -- the cache whose
    // survival IS the blocker -- and mints the plan's epoch.
    expect(
      useCamStore.getState().beginSketchDrag('tx', { x: 20, y: 0 }, 1,
        () => useCamStore.getState().pushHistory()),
      'the on-path text branch must accept the grab or the cell is vacuous',
    ).toBe(true)
    // grabDelta = resolved(10) - projected(20) = -10: the grip point stays
    // under the cursor. This is the value that makes x=80 land at 70.
    expect(txOf().pathOffsetMm, 'freed at its resolved offset, no jump').toBeCloseTo(10, 9)

    // Two keyboard undos with the button still held: back past the drag's own
    // step (the 100mm document) to the 40mm one. The seam does NOT clear
    // sketchTextPathDrag -- by design, per the ruling -- so the plan below is
    // still alive and still holding the 100mm path.
    useCamStore.getState().undo()
    useCamStore.getState().undo()
    await waitUntil(() => Math.abs(lnOf().end.x - 40) < 1e-6, 'undo restores the 40mm path')
    expect(txOf().pathOffsetMm, 'the restored document holds the pre-drag offset').toBeCloseTo(10, 9)

    // The mouse moves again -- the browser has no idea a restore happened.
    // UNFIXED, this projects x=80 against the CACHED 100mm path and writes
    // pathOffsetMm = 80 + (-10) = 70 onto the restored 40mm path: an offset
    // 30mm BEYOND the end of the path the document actually has. That is the
    // audit's finding, reproduced.
    useCamStore.getState().moveSketchDrag({ x: 80, y: 0 })

    expect(txOf().pathOffsetMm, 'the stale write must be refused, not applied').toBeCloseTo(10, 9)
    expect(txOf().pathOffsetMm, 'the audit\'s exact defect value').not.toBeCloseTo(70, 1)
    expect(txOf().pathOffsetMm).toBeLessThanOrEqual(lnOf().end.x)
    expect(txOf().pathFlip).toBe(false)

    // (3c) the refusal is OBSERVABLE and NAMED -- a silent drop must not be
    // able to masquerade as correctness.
    const refusals = refusalsOn('moveSketchDrag.onPathText')
    expect(refusals, 'the refusal is logged by channel name').toHaveLength(1)
    expect(refusals[0]!.mintedEpoch, 'the plan carried its MINT, not the epoch at fire time')
      .toBeLessThan(refusals[0]!.currentEpoch)
    // Two undos, two bumps: the mint is stale by exactly the two restores.
    expect(refusals[0]!.currentEpoch - refusals[0]!.mintedEpoch).toBe(2)
    expect(refusals[0]!.currentEpoch).toBe(currentSketchGeometryEpoch())
  })

  it('the refused plan leaves NO half-armed gesture behind: the cache is dropped, further moves are inert (not a refusal per mouse-move), the toolbox mirror is untouched, and mouse-up neither settles nor throws', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(textPathFixture(40, 10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    useCamStore.getState().updateEntity('ln', { end: { x: 100, y: 0 } } as Partial<SketchEntity>)
    // The toolbox mirror is what an OPEN text edit would be watching: if the
    // refused write leaked into it, the panel would show an offset the
    // document does not have (the "half-armed UI state" the ruling names).
    useCamStore.setState({ sketchTextEditId: 'tx', sketchTextPathOffsetMm: 10 })
    expect(useCamStore.getState().beginSketchDrag('tx', { x: 20, y: 0 }, 1,
      () => useCamStore.getState().pushHistory())).toBe(true)
    useCamStore.getState().undo()
    useCamStore.getState().undo()
    await waitUntil(() => Math.abs(lnOf().end.x - 40) < 1e-6, 'undo restores the 40mm path')

    useCamStore.getState().moveSketchDrag({ x: 80, y: 0 })
    expect(refusalsOn('moveSketchDrag.onPathText')).toHaveLength(1)
    expect(useCamStore.getState().sketchTextPathOffsetMm,
      'the mirror must not show an offset the document was refused').toBe(10)

    // The gesture keeps receiving events, as the real pointer stream would.
    // The plan was dropped at the refusal, so these are inert: ONE refusal per
    // gesture, not one per mouse-move (a log that floods is a log nobody reads).
    useCamStore.getState().moveSketchDrag({ x: 90, y: 0 })
    useCamStore.getState().moveSketchDrag({ x: 30, y: 0 })
    expect(refusalsOn('moveSketchDrag.onPathText'),
      'the plan is dropped at the refusal: later moves find no gesture at all').toHaveLength(1)
    expect(txOf().pathOffsetMm).toBeCloseTo(10, 9)

    // Mouse-up on the invalidated gesture: inert, and does not throw.
    expect(() => useCamStore.getState().endSketchDrag()).not.toThrow()
    await sleep(120)
    expect(txOf().pathOffsetMm).toBeCloseTo(10, 9)
    expect(lnOf().end.x).toBeCloseTo(40, 6)
    expect(useCamStore.getState().sketchTextPathOffsetMm).toBe(10)
  })

  it('CONTROL (non-vacuity): the SAME gesture with NO undo DOES write pathOffsetMm=70 -- proving the cell above refuses a real, reachable write rather than an inert one', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(textPathFixture(40, 10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    useCamStore.getState().updateEntity('ln', { end: { x: 100, y: 0 } } as Partial<SketchEntity>)
    expect(useCamStore.getState().beginSketchDrag('tx', { x: 20, y: 0 }, 1,
      () => useCamStore.getState().pushHistory())).toBe(true)

    // No undo: the epoch the plan minted is still live, so the identical
    // pointer move is ACCEPTED and lands the exact value the refused write
    // above was carrying.
    useCamStore.getState().moveSketchDrag({ x: 80, y: 0 })
    expect(txOf().pathOffsetMm, '80 + (10 - 20) = 70').toBeCloseTo(70, 9)
    expect(refusalsOn('moveSketchDrag.onPathText'),
      'a fresh write is not refused').toHaveLength(0)

    // WO SKC-56-R5 MINOR: the mouse-up this control was missing. Unlike the two
    // cells above, this gesture is ACCEPTED, so the refusal path never drops the
    // plan (store/index.ts:7792 clears it only when the commit is refused) and
    // sketchTextPathDrag stayed alive past the test -- intercepting every later
    // solver drag in the file. The afterEach teardown is the belt; this is the
    // braces, and it is what the real UI does at pointerup.
    useCamStore.getState().endSketchDrag()
  })
})

describe('SKC-56-R4 cell 2: the UNKNOWN channel -- a throwaway async writer in NO census, refused anyway', () => {
  it('a brand-new deferred writer nobody enumerated, minted BEFORE undo and fired AFTER it, is refused by the gate: correctness does not depend on the completeness of any census', async () => {
    clearSketchEpochRefusals()
    // This channel exists ONLY in this test file. The census derives its domain
    // from src/store/index.ts alone, so no tier of it can see this writer --
    // asserted here rather than asserted about, so the claim cannot rot.
    expect(DERIVED_FILES, 'the census sweeps the store only: this writer is invisible to it by construction')
      .toEqual(['src/store/index.ts'])
    const UNKNOWN_CHANNEL = 'test.throwawayUnenumeratedWriter'
    expect(
      [...ASYNC_WRITE_CHANNEL_CENSUS, ...CHANNEL_NAMED_EXCLUSIONS].some((e) => e.name.includes('throwaway')),
      'tier 1 does not list this channel',
    ).toBe(false)
    expect(
      DEFERRED_SKETCH_WRITE_SITES.some((s) => s.siteFunction.includes('throwaway')),
      'tier 2 does not list this channel',
    ).toBe(false)

    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    useCamStore.getState().commitDimensionValue('len', 25)
    await waitUntil(() => l1Of().end.x > 24.999, '25mm solve settle')

    // MINT: the epoch is captured now, together with a payload derived from the
    // CURRENT (pre-restore) geometry -- exactly what any real deferred channel
    // does at capture time.
    const mintedEpoch = currentSketchGeometryEpoch()
    const stalePayload: SketchLineEntity = { ...l1Of(), end: { x: 999, y: 999 } }

    // The throwaway channel: a bare real timer, armed here, whose callback
    // writes sketch geometry through THE GATEWAY (WO 3a -- never a raw
    // setState, which was never gated and would pass vacuously).
    let accepted: boolean | null = null
    let fired = false
    setTimeout(() => {
      accepted = commitSketchGeometry(mintedEpoch, UNKNOWN_CHANNEL, (sk) => ({
        activeSketch: {
          ...sk,
          entities: sk.entities.map((e) => (e.id === 'l1' ? stalePayload : e)),
        },
      }))
      fired = true
    }, 30)

    // The restore lands INSIDE the throwaway timer's window.
    useCamStore.getState().undo()
    await waitUntil(() => fired, 'the unenumerated writer fires', 5000)
    await sleep(120)

    expect(accepted, 'the gate refused a channel it has never heard of').toBe(false)
    const l1 = l1Of()
    expect(l1.end.x, 'restored geometry survives an unenumerated stale write').not.toBeCloseTo(999, 1)
    expect(l1.end.y).not.toBeCloseTo(999, 1)
    expect(l1.end.x).toBeCloseTo(10, 3)
    expect(l1.end.y).toBeCloseTo(0, 3)
    expect(lenDimOf().value).toBe(10)

    // (3c) named + observable, same as every real channel.
    const refusals = refusalsOn(UNKNOWN_CHANNEL)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.mintedEpoch).toBe(mintedEpoch)
    expect(refusals[0]!.currentEpoch).toBe(currentSketchGeometryEpoch())
    expect(refusals[0]!.currentEpoch).toBeGreaterThan(refusals[0]!.mintedEpoch)
  })

  it('CONTROL (non-vacuity): the SAME unenumerated writer with NO undo IS accepted and DOES write (999, 999) -- the gate refuses staleness, not this test\'s writer', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    const mintedEpoch = currentSketchGeometryEpoch()
    const payload: SketchLineEntity = { ...l1Of(), end: { x: 999, y: 999 } }
    let accepted: boolean | null = null
    let fired = false
    setTimeout(() => {
      accepted = commitSketchGeometry(mintedEpoch, 'test.throwawayUnenumeratedWriter', (sk) => ({
        activeSketch: { ...sk, entities: sk.entities.map((e) => (e.id === 'l1' ? payload : e)) },
      }))
      fired = true
    }, 30)
    // No undo, no document switch: nothing bumps, so the mint stays live.
    await waitUntil(() => fired, 'the unenumerated writer fires', 5000)

    expect(accepted).toBe(true)
    expect(l1Of().end.x, 'the identical write lands when it is not stale').toBeCloseTo(999, 6)
    expect(refusalsOn('test.throwawayUnenumeratedWriter')).toHaveLength(0)
  })
})

// ============================================================================
// WO SKC-56-R5 -- evidence completion on the HELD epoch gate. The R4 audit
// could not construct a surviving stale write; its three majors are gaps in
// what the COMMITTED coverage proves. Nothing below changes the gate.
// ============================================================================

describe('SKC-56-R5 cell A: {dragSolveSketch.debounce} -- a queued debounced drag that actually FIRES after an invalidating seam, refused BY NAME', () => {
  // WHY THIS CELL EXISTS (R4 audit MAJOR 1, verbatim): "The committed R2
  // queued-debounced-drag restore interleave does not prove an epoch-gateway
  // refusal or assert the required named dragSolveSketch.debounce structured
  // event... The restore seam cancels the queued timer, so this cell proves
  // unchanged geometry through the older cancellation defense."
  //
  // That is exactly right, and it is by design: restoreSketchFromHistorySeam
  // clears dragDebounceTimer + pendingDrag (store/index.ts:2055-2059) BEFORE it
  // bumps (store/index.ts:2081), so across undo/redo the debounce callback never
  // runs and no dragSolveSketch.debounce refusal is mintable AT ALL. The cell at
  // :533 therefore keeps proving the geometry through the cancellation defense,
  // and it STAYS as defense-in-depth (the audit asks for exactly that).
  //
  // To prove the GATE on this channel the interleave needs an invalidating seam
  // that bumps the epoch WITHOUT cancelling the timer. setActiveSketch is that
  // seam, and not by accident: it replaces activeSketch wholesale and
  // deliberately does NOT reset the module-scope drag channels, which is
  // precisely why it bumps (store/index.ts:6927-6941). So the queued drag
  // survives the switch, fires on its own REAL 25ms timer into the NEW document,
  // reaches commitSketchGeometry -- and is refused by name.
  it('a drag debounce armed before a document switch fires into the NEW document afterwards: geometry unchanged AND exactly the named dragSolveSketch.debounce refusal', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'doc A open solve settle')
    // Same vacuity gate as the R3 cells: beginSketchDrag refuses a dof-0 sketch.
    expect(
      useCamStore.getState().sketchSolveStatus!.dof,
      'the fixture must retain a rotational dof or beginSketchDrag refuses and the cell is vacuous',
    ).toBeGreaterThan(0)
    expect(l1Of().end.x).toBeCloseTo(10, 6)

    useCamStore.getState().pushHistory()
    expect(useCamStore.getState().beginSketchDrag('l1', { x: 10, y: 0 }, 1)).toBe(true)
    // ONE pointer move: dragSolveSketch parks the targets in pendingDrag and arms
    // the REAL 25ms trailing debounce, stamped with the plan's MINTED epoch (WO
    // 1b -- store/index.ts:7556 reads the plan's stored epoch, never the live one).
    useCamStore.getState().moveSketchDrag({ x: 10, y: 10 })
    const mintedEpoch = currentSketchGeometryEpoch()

    // THE SEAM -- synchronously, inside the 25ms window (no await since the move).
    const docB: Sketch = { ...dragFixture(30), id: 'sk2' }
    useCamStore.getState().setActiveSketch(docB)
    expect(currentSketchGeometryEpoch(),
      'the document switch bumped exactly once').toBe(mintedEpoch + 1)
    await waitUntil(() => Math.abs(l1Of().end.x - 30) < 1e-3, 'doc B open solve settle')

    // Well past both the 25ms debounce and a worker round-trip: the timer the
    // switch did NOT cancel has now fired.
    await sleep(250)

    // UNFIXED, the callback posts a DRAG_SOLVE carrying doc B's sketch with doc
    // A's drag targets -- pinning doc B's end toward (10,10) under its own 30mm
    // driving length and landing it at ~(21.2, 21.2). The NEW document, moved by
    // the OLD document's gesture.
    const l1 = l1Of()
    expect(l1.end.x, 'the new document must not be moved by the old document\'s queued drag').toBeCloseTo(30, 3)
    expect(l1.end.y).toBeCloseTo(0, 3)
    expect(l1.end.y).not.toBeCloseTo(21.21, 1)
    expect(lenDimOf().value, 'a DRAG_SOLVE never writes the value -- passes even unfixed').toBe(30)
    // The length is invariant under the drag (the driving dim holds it), so it can
    // never be the assertion that catches this. Said out loud so nobody later
    // "simplifies" the cell down to a length check.
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(30, 3)

    // THE HALF THE AUDIT FOUND MISSING: the named structured refusal event.
    const refusals = refusalsOn('dragSolveSketch.debounce')
    expect(refusals, 'the queued drag reached the gateway and was refused BY NAME').toHaveLength(1)
    expect(refusals[0]!.mintedEpoch, 'the drag carried its MINT, not the epoch at fire time')
      .toBe(mintedEpoch)
    expect(refusals[0]!.currentEpoch).toBe(currentSketchGeometryEpoch())
    expect(refusals[0]!.currentEpoch - refusals[0]!.mintedEpoch,
      'one seam, one bump: stale by exactly the switch').toBe(1)
    // EXACTLY the named refusal: nothing else refused, so the cell cannot pass on
    // some other channel's event while this one silently drops.
    expect(getSketchEpochRefusals().map((r) => r.channel)).toEqual(['dragSolveSketch.debounce'])
  })

  it('CONTROL (non-vacuity): the SAME queued drag with NO seam fires, is ACCEPTED, and rotates the line -- the gate refuses staleness, not this channel', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    useCamStore.getState().pushHistory()
    expect(useCamStore.getState().beginSketchDrag('l1', { x: 10, y: 0 }, 1)).toBe(true)
    useCamStore.getState().moveSketchDrag({ x: 10, y: 10 })
    // No switch, no undo: the mint stays live, the debounce fires, the DRAG_SOLVE
    // lands, the line rotates.
    await waitUntil(() => l1Of().end.y > 1, 'the queued drag fires and rotates the line', 5000)

    expect(l1Of().end.y).toBeCloseTo(7.07, 1)
    expect(l1Of().end.x).toBeCloseTo(7.07, 1)
    expect(refusalsOn('dragSolveSketch.debounce'),
      'a fresh queued drag is not refused').toHaveLength(0)
    useCamStore.getState().endSketchDrag()
  })
})

describe('SKC-56-R5 cell B: the BUMP / NO-BUMP matrix -- WO 1c\'s contract as committed, can-fail cells', () => {
  // WHY THIS BLOCK EXISTS (R4 audit MAJOR 2, verbatim): "The committed
  // acceptance coverage does not test the required bump/no-bump map for
  // setActiveSketch, loadProjectFromFile, or ordinary live-drag settle
  // behavior... this is a missing regression contract rather than a
  // demonstrated production failure."
  //
  // The gate has TWO failure directions and only one of them had cells. A gate
  // that never bumps refuses nothing (the R1-R4 saga); a gate that bumps too
  // eagerly refuses the user's OWN in-flight work -- a mid-drag user silently
  // losing their drag, which no cell above could catch. WO 1c fixes both ends,
  // and this block is that map, committed.
  //
  // The epoch is module-global and monotonic across this file, so every cell
  // asserts DELTAS against a reading taken inside the cell, never an absolute.

  it('(a) setActiveSketch bumps EXACTLY once per document switch -- open, switch, and close', async () => {
    clearSketchEpochRefusals()
    const e0 = currentSketchGeometryEpoch()

    // OPEN.
    useCamStore.getState().setActiveSketch(dragFixture(10))
    expect(currentSketchGeometryEpoch(), 'opening a document: exactly one bump').toBe(e0 + 1)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    // The open solve is a DISPATCH, not a seam: its response must be accepted,
    // and it must not have bumped on its own way through.
    expect(currentSketchGeometryEpoch(), 'the open solve dispatch does not bump').toBe(e0 + 1)
    expect(l1Of().end.x, 'the open solve\'s own response was ACCEPTED').toBeCloseTo(10, 3)

    // SWITCH.
    useCamStore.getState().setActiveSketch({ ...dragFixture(30), id: 'sk2' })
    expect(currentSketchGeometryEpoch(), 'switching documents: exactly one more bump').toBe(e0 + 2)
    await waitUntil(() => Math.abs(l1Of().end.x - 30) < 1e-3, 'doc B open solve settle')
    expect(currentSketchGeometryEpoch()).toBe(e0 + 2)

    // CLOSE. A null switch is still a wholesale replacement of live geometry --
    // the branch loadProjectFromFile and newProject reach (store/index.ts:6941).
    useCamStore.getState().setActiveSketch(null)
    expect(currentSketchGeometryEpoch(), 'closing the session: exactly one more bump').toBe(e0 + 3)
    expect(useCamStore.getState().activeSketch).toBeNull()

    expect(getSketchEpochRefusals(), 'nothing was refused: no writer was in flight').toHaveLength(0)
  })

  it('(a) a writer minted BEFORE the switch is refused BY NAME after it -- the bump is load-bearing, not bookkeeping', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    // MINT against doc A, together with a payload derived from doc A's geometry.
    const mintedEpoch = currentSketchGeometryEpoch()
    const stalePayload: SketchLineEntity = { ...l1Of(), end: { x: 999, y: 999 } }

    useCamStore.getState().setActiveSketch({ ...dragFixture(30), id: 'sk2' })
    await waitUntil(() => Math.abs(l1Of().end.x - 30) < 1e-3, 'doc B open solve settle')

    // The pre-switch writer finally fires -- into a document it never saw.
    const accepted = commitSketchGeometry(mintedEpoch, 'test.preSwitchWriter', (sk) => ({
      activeSketch: { ...sk, entities: sk.entities.map((e) => (e.id === 'l1' ? stalePayload : e)) },
    }))

    expect(accepted, 'a write minted against the OUTGOING document is refused').toBe(false)
    expect(l1Of().end.x, 'doc B survives the pre-switch write').toBeCloseTo(30, 3)
    expect(l1Of().end.y).not.toBeCloseTo(999, 1)
    const refusals = refusalsOn('test.preSwitchWriter')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.mintedEpoch).toBe(mintedEpoch)
    expect(refusals[0]!.currentEpoch).toBe(mintedEpoch + 1)
  })

  it('(b) loadProjectFromFile inherits EXACTLY one bump -- through its own setActiveSketch(null) close, not a bump of its own', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')

    const mintedEpoch = currentSketchGeometryEpoch()
    // WO 1c asked the implementation to DECIDE and state whether
    // loadProjectFromFile bumps. It chose: no bump of its own -- it closes the
    // sketch session through get().setActiveSketch(null) (store/index.ts:3949,
    // the B3-sibling fix), and that close is the bump. This cell pins the
    // decision the implementation actually made, per the work order.
    const file = JSON.stringify({
      id: 'opened-project', name: 'Opened', version: '1',
      machine: { id: 'm1', name: 'M' },
      geometry: [], setups: [],
    })
    useCamStore.getState().loadProjectFromFile(file)

    expect(useCamStore.getState().activeSketch, 'the load closed the session (B3 sibling)').toBeNull()
    expect(useCamStore.getState().project.id).toBe('opened-project')
    expect(currentSketchGeometryEpoch(),
      'EXACTLY one bump, inherited from the close -- not two, and not zero').toBe(mintedEpoch + 1)

    // And it is load-bearing: a writer minted against the PREVIOUS project's
    // document is refused rather than landing in the freshly opened one.
    const accepted = commitSketchGeometry(mintedEpoch, 'test.preLoadWriter', (sk) => ({
      activeSketch: { ...sk },
    }))
    expect(accepted, 'a write minted against the previous project is refused').toBe(false)
    expect(refusalsOn('test.preLoadWriter')).toHaveLength(1)
  })

  it('(c) THE FALSE-REFUSAL CELL: an ordinary live drag settles with ZERO refusals and ZERO bumps -- a user mid-drag KEEPS their drag', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    expect(useCamStore.getState().sketchSolveStatus!.dof).toBeGreaterThan(0)

    // Everything from here is the epoch-stability window: a whole gesture, with
    // no seam anywhere in it.
    const e0 = currentSketchGeometryEpoch()

    useCamStore.getState().pushHistory()
    expect(useCamStore.getState().beginSketchDrag('l1', { x: 10, y: 0 }, 1)).toBe(true)
    useCamStore.getState().moveSketchDrag({ x: 10, y: 10 })
    await waitUntil(() => l1Of().end.y > 1, 'the drag debounce fires and the DRAG_SOLVE lands', 5000)

    // The mouse-up: endSketchDrag's settle solve (WO 1c's MUST-NOT-BUMP list).
    // If it bumped, it would refuse its OWN in-flight response and the drag
    // would silently snap back -- the exact regression this cell exists for.
    useCamStore.getState().endSketchDrag()
    await sleep(300)

    expect(currentSketchGeometryEpoch(),
      'not one bump anywhere in an ordinary gesture: pushHistory, begin, move, debounce, settle')
      .toBe(e0)
    expect(getSketchEpochRefusals(),
      'the user KEEPS their drag: nothing in a live gesture is refused').toHaveLength(0)
    // The drag actually HAPPENED -- otherwise "zero refusals" would be vacuous.
    const l1 = l1Of()
    expect(l1.end.y, 'the settled drag is still there').toBeCloseTo(7.07, 1)
    expect(l1.end.x).toBeCloseTo(7.07, 1)
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(10, 3)
  })
})

describe('SKC-56-R5 cell C: the REST of WO 1c\'s MUST-NOT-BUMP list -- every named ordinary-edit dispatch, direct epoch-stability assertions', () => {
  // The R4 audit's suggested fix, verbatim: "cover the remaining named
  // ordinary-edit dispatches with direct epoch-stability assertions."
  //
  // WO 1c names four dispatches that MUST NOT bump, "or ordinary edits would
  // refuse their own in-flight response": endSketchDrag's settle solve (cell B
  // (c) above), append's placement solve, delete-selection's re-solve, and
  // updateDimensionLabel's sector solve. Each cell here asserts the same three
  // things: the epoch did not move, nothing was refused, and -- so that "zero
  // refusals" cannot pass vacuously -- the dispatch's OWN response was
  // ACCEPTED and visibly changed the document.

  it('append\'s placement solve neither bumps nor refuses its own verdict response', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    const e0 = currentSketchGeometryEpoch()

    // The chunk-1 path: a tool commit carrying a newly PLACED driving dimension,
    // which takes append's verdict-solve branch (store/index.ts:9765-9780) --
    // its own requestId + latestSketchRequestEpoch stamp, not solveSketch's.
    camSketchDocumentPort.append(
      {
        entities: [line('l2', 0, 20, 40, 20)],
        constraints: [],
        dimensions: [{ id: 'len2', kind: 'distance', driving: true, value: 40,
          a: ref('l2', 'start'), b: ref('l2', 'end'), labelAnchor: { x: 20, y: 24 } }],
      },
      [],
      { openDimensionEditor: true },
    )
    await waitUntil(
      () => useCamStore.getState().activeSketch!.entities.some((e) => e.id === 'l2'),
      'the appended entity is in the document',
    )
    await sleep(250)

    expect(currentSketchGeometryEpoch(), 'append\'s placement solve does not bump').toBe(e0)
    expect(getSketchEpochRefusals(),
      'append does not refuse its own verdict response').toHaveLength(0)
    // Non-vacuity: the placement actually completed -- the verdict response
    // landed and opened the editor on the dimension it placed.
    expect(useCamStore.getState().sketchDimEditor,
      'the verdict response was ACCEPTED: it opened the value editor').toEqual({ dimId: 'len2', isNew: true })
    expect(useCamStore.getState().activeSketch!.dimensions.some((d) => d.id === 'len2')).toBe(true)
  })

  it('delete-selection\'s re-solve neither bumps nor refuses its own response', async () => {
    clearSketchEpochRefusals()
    useCamStore.getState().setActiveSketch(dragFixture(10))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve settle')
    // A second, free line to delete: deleting the dimensioned l1 would take the
    // cascade path and leave nothing for the re-solve to report on.
    camSketchDocumentPort.append(
      { entities: [line('l2', 0, 20, 40, 20)], constraints: [], dimensions: [] }, [],
    )
    await waitUntil(
      () => useCamStore.getState().activeSketch!.entities.some((e) => e.id === 'l2'),
      'the second line is in the document',
    )
    await sleep(200)
    const e0 = currentSketchGeometryEpoch()
    const dofBefore = useCamStore.getState().sketchSolveStatus!.dof

    useCamStore.getState().deleteSketchItems(['l2'])
    await waitUntil(
      () => (useCamStore.getState().sketchSolveStatus?.dof ?? dofBefore) !== dofBefore,
      'the delete re-solve response lands and re-reports the DoF',
    )

    expect(currentSketchGeometryEpoch(), 'delete-selection\'s re-solve does not bump').toBe(e0)
    expect(getSketchEpochRefusals(),
      'the delete re-solve does not refuse its own response').toHaveLength(0)
    // Non-vacuity: the response was ACCEPTED -- the freed line is gone AND the
    // solve status it provoked reflects the smaller network.
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.id === 'l2')).toBe(false)
    expect(useCamStore.getState().sketchSolveStatus!.dof).toBeLessThan(dofBefore)
  })

  it('updateDimensionLabel\'s sector solve neither bumps nor refuses its own response', async () => {
    clearSketchEpochRefusals()
    const THETA_DEG = 47
    const rad = (THETA_DEG * Math.PI) / 180
    useCamStore.getState().setActiveSketch(makeSketch(
      [line('l1', 0, 0, 1000, 0),
       line('l2', 0, 0, 1000 * Math.cos(rad), 1000 * Math.sin(rad))],
      [
        { id: 'f1s', kind: 'fix', point: ref('l1', 'start') },
        { id: 'f1e', kind: 'fix', point: ref('l1', 'end') },
        { id: 'f2s', kind: 'fix', point: ref('l2', 'start') },
      ],
      [
        { id: 'len2', kind: 'distance', driving: true, value: 1000,
          a: ref('l2', 'start'), b: ref('l2', 'end') },
        { id: 'ang', kind: 'angle', driving: true, value: rad, a: 'l1', b: 'l2',
          labelAnchor: anchorAtDeg(23, 500) },
      ],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus?.dof === 0, 'open solve settle')
    const worker = currentWorker()
    const e0 = currentSketchGeometryEpoch()

    // Drag the label across into the FAR sector (133deg): updateDimensionLabel
    // re-derives the driven value (SKC-58B: the signed reversed-operand -133deg
    // with reverseB=true) AND dispatches the sector solve (store/index.ts). Hold
    // the response so its delivery is a deterministic, observable event rather
    // than a geometry-motion poll -- the SKC-58B far solve is NO-MOTION, so the
    // old "wait for the geometry to reach 133deg" anchor never fires.
    worker.hold = true
    useCamStore.getState().updateDimensionLabel('ang', anchorAtDeg(113, 500))
    const stagedC = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ang')!
    expect(deg(stagedC.value)).toBeCloseTo(-(180 - THETA_DEG), 3)
    expect((stagedC as { reverseB?: boolean }).reverseB).toBe(true)
    worker.hold = false
    await worker.releaseOne() // the sector solve response: dispatched, delivered, ACCEPTED

    expect(currentSketchGeometryEpoch(), 'the sector solve does not bump').toBe(e0)
    expect(getSketchEpochRefusals(),
      'the sector solve does not refuse its own response').toHaveLength(0)
    // Non-vacuity: releaseOne() only resolves because the sector solve genuinely
    // dispatched a response, and it was ACCEPTED (zero refusals). Per SKC-58B it
    // is a no-motion far constraint -- the geometry stays acute 47deg while the
    // dimension reads the obtuse 133 (value -133).
    const cl1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1') as SketchLineEntity
    const cl2 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l2') as SketchLineEntity
    expect(Math.abs(deg(measuredAngle(cl1, cl2)))).toBeCloseTo(THETA_DEG, 3)
    expect(deg(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ang')!.value))
      .toBeCloseTo(-(180 - THETA_DEG), 3)
  })
})
