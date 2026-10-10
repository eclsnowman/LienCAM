// REPRO (diagnosis only, 2026-07-02): fully define an ellipse, TRIM it
// (trim-to-construction, e5fc57c), then re-solve. User report: the sketch is
// reported FULLY DEFINED afterward even though the trim minted a NEW
// construction elliptical-arc whose center is a FREE solver point (nothing
// constrains it — trim emits no cutPoints/constraints for ellipse pieces).
//
// GROUND TRUTH asserted here (the test FAILS where the bug manifests):
//   - post-trim dof MUST be > 0 (the removed construction arc is free;
//     exact counts re-pinned 2026-08-20 against d8a22e90, see below),
//   - the removed piece MUST NOT be in fullyDefinedEntities,
//   - the topology signature MUST change across the trim (cache miss),
//   - the probe loop MUST re-run (no stale cache reuse).
// Rich console diagnostics are logged either way so the observed state is
// captured even when an assertion trips.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import {
  solveSketchOnWrapper, sketchTopologySignature,
} from '../../lib/sketch/solver/gcsMapping'
import { trimAtPoint } from '../../lib/sketch/tools/trimTool'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, PointRef,
  SketchEllipticalArcEntity,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'

// ---- Loopback worker (store-path test): real planegcs solve, in-process ----
// Same harness as dimValueEdit.test.ts — the store's worker round trip runs
// the REAL solveSketchOnWrapper so the full production loop is exercised:
// trim click -> replace transform -> solveSketch -> worker -> status handler.
let loopbackWrapperPromise: Promise<GcsWrapper> | null = null
function ensureLoopbackWrapper(): Promise<GcsWrapper> {
  if (!loopbackWrapperPromise) loopbackWrapperPromise = createGcsWrapper()
  return loopbackWrapperPromise
}
class LoopbackWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    void (async () => {
      const w = await ensureLoopbackWrapper()
      const { requestId, sketch } = msg.payload
      const out = msg.type === 'DRAG_SOLVE'
        ? solveSketchOnWrapper(w, sketch, msg.payload.drag)
        : solveSketchOnWrapper(w, sketch)
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
// The armed tool + chain and the tool click now live in the sketcher package
// (WO SKC-14B); import it dynamically alongside the store.
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

let wrapper: GcsWrapper
beforeAll(async () => {
  wrapper = await createGcsWrapper()
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})
afterAll(() => { wrapper.destroy_gcs_module() })

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

let n = 0
const newId = () => `trimpiece-${n++}`

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

/** Count internal gcs.solve() calls during one solveSketchOnWrapper — the
 *  definedness probe loop is one solve per entity, so a run that skipped the
 *  probe loop shows only the small constant of main-pass solves. */
function countSolves(sk: Sketch): { solves: number; out: ReturnType<typeof solveSketchOnWrapper> } {
  const spy = vi.spyOn(wrapper, 'solve')
  const out = solveSketchOnWrapper(wrapper, sk)
  const solves = spy.mock.calls.length
  spy.mockRestore()
  return { solves, out }
}

function logOutcome(tag: string, out: ReturnType<typeof solveSketchOnWrapper>, solves?: number) {
  const s = out.status
  console.log(`[repro] ${tag}: ok=${out.ok}` +
    (out.ok ? '' : ` reason=${(out as { reason: string }).reason}`) +
    ` dof=${s.dof} conflicting=[${s.conflicting.join(',')}]` +
    ` redundant=[${s.redundant.join(',')}]` +
    ` defined=[${(s.fullyDefinedEntities ?? []).join(',')}]` +
    (solves !== undefined ? ` internalSolves=${solves}` : ''))
}

describe('REPRO: ellipse trim-to-construction vs definedness/dof', () => {
  it('fully-defined ellipse -> trim -> sketch must report free dof and the construction piece under-defined', () => {
    // ---- 1. Fully defined sketch: ellipse E + vertical cutter line L ----
    // E: center fixed; major/minor radius carried by INERT driving dims
    //    (the app's way to "fully define an ellipse" — solver-inert doctrine:
    //    only the center is a solver point).
    // L: start fixed + vertical + driving distanceY -> rigid.
    const entities: SketchEntity[] = [
      { id: 'E', kind: 'ellipse', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0 },
      { id: 'L', kind: 'line', construction: false,
        start: { x: 6, y: -20 }, end: { x: 6, y: 20 } },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'fxE', kind: 'fix', point: ref('E', 'center') },
      { id: 'fxL', kind: 'fix', point: ref('L', 'start') },
      { id: 'vL', kind: 'vertical', line: 'L' },
    ]
    const dimensions: SketchDimension[] = [
      { id: 'dLy', kind: 'distanceY', driving: true, value: 40,
        a: ref('L', 'start'), b: ref('L', 'end') },
      { id: 'dMaj', kind: 'majorRadius', driving: true, value: 10, entityId: 'E' },
      { id: 'dMin', kind: 'minorRadius', driving: true, value: 5, entityId: 'E' },
    ]
    const before: Sketch = {
      id: 'sk-repro', layerId: 'layer', entities, constraints, dimensions,
      solveStatus: null,
    }

    const pre = countSolves(before)
    logOutcome('pre-trim ', pre.out, pre.solves)
    expect(pre.out.ok).toBe(true)
    if (!pre.out.ok) return
    // Baseline: FULLY DEFINED before the trim (dof 0 -> the fast path marks
    // every entity defined without running the probe loop).
    expect(pre.out.status.dof).toBe(0)
    expect(new Set(pre.out.status.fullyDefinedEntities)).toEqual(new Set(['E', 'L']))

    const sigBefore = sketchTopologySignature(before)

    // ---- 2. The ACTUAL trim code path (not an imitation) ----
    // Click near the +x vertex (9.5, 0): the short right span between the two
    // L crossings at (6, +/-4) is removed and re-emitted as construction.
    const t = trimAtPoint(
      { entities: [...entities], constraints: [...constraints], dimensions: [...dimensions] },
      { x: 9.5, y: 0 }, 1, newId,
    ).transform
    expect(t).not.toBeNull()
    if (!t) return

    const pieces = t.entities.filter(
      (e): e is SketchEllipticalArcEntity => e.kind === 'elliptical-arc')
    console.log('[repro] post-trim entities: ' +
      t.entities.map((e) => `${e.id}:${e.kind}${e.construction ? ':construction' : ''}`).join(' '))
    console.log('[repro] post-trim constraints: ' +
      t.constraints.map((c) => `${c.id}:${c.kind}`).join(' '))
    expect(pieces).toHaveLength(2)
    const kept = pieces.find((p) => p.id === 'E')
    const removed = pieces.find((p) => p.id !== 'E')
    expect(kept).toBeDefined()
    expect(removed).toBeDefined()
    if (!kept || !removed) return
    expect(removed.construction).toBe(true)
    // The swap emits NO constraint touching the new piece (solver-inert
    // endpoints -> no point_on_object): its center point enters the next
    // solve as a completely free point.
    const touchingRemoved = t.constraints.filter((c) =>
      JSON.stringify(c).includes(removed.id))
    expect(touchingRemoved).toHaveLength(0)

    // ---- 3. Re-solve the trimmed sketch (what the store does next) ----
    const after: Sketch = {
      ...before,
      entities: t.entities, constraints: t.constraints, dimensions: t.dimensions,
      solveStatus: pre.out.status, // store carries the last status until the new solve lands
    }
    const sigAfter = sketchTopologySignature(after)
    console.log(`[repro] sigBefore=${sigBefore}`)
    console.log(`[repro] sigAfter =${sigAfter}`)
    console.log(`[repro] signature changed: ${sigBefore !== sigAfter}`)
    // The swap changes entity kinds/ids, so the topology signature MUST differ
    // (cache invalidation is signature-keyed).
    expect(sigAfter).not.toBe(sigBefore)

    const post = countSolves(after)
    logOutcome('post-trim', post.out, post.solves)
    expect(post.out.ok).toBe(true)
    if (!post.out.ok) return

    // ---- 4. GROUND TRUTH ----
    // The removed construction elliptical-arc enters the solve with free
    // solver points and zero constraints: the sketch is NOT fully defined.
    // If dof reads 0 here, the dof===0 fast path in gcsMapping also stamps
    // EVERY entity (including the free construction arc) as fully defined —
    // the reported bug.
    //
    // Re-pinned 2026-08-20 against d8a22e90 (WO-207/WO-219 native curve
    // solver participation): an elliptical-arc now materializes center +
    // start + end as solver points (gcsMapping sketchSolverPoints), so the
    // accounting is: kept piece E (center fixed, start/end free) = 4, new
    // construction piece (center/start/end free) = 6 -> 10 dof, and E itself
    // is no longer classified defined (its endpoints are free). Only L stays
    // defined. Before d8a22e90 the same trim read 2 dof.
    expect(post.out.status.dof).toBe(10)
    expect(post.out.status.dof).toBeGreaterThan(0)
    const definedAfter = new Set(post.out.status.fullyDefinedEntities)
    expect(definedAfter.has(removed.id)).toBe(false)
    expect(definedAfter.has('E')).toBe(false)
    expect(definedAfter.has('L')).toBe(true)

    // Cache behavior: dof>0 with a CHANGED signature must MISS and re-run the
    // probe loop (>= one solve per entity beyond the constant main passes).
    expect(post.solves).toBeGreaterThan(after.entities.length)
  })

  it('fully-defined elliptical-arc -> mid-span trim -> same free-center accounting on both new pieces', () => {
    // Upper half-ellipse arc A (params 0..pi), center fixed, radii by inert
    // dims. Horizontal cutter C at y=3 (crosses at x=+/-8), rigid.
    const entities: SketchEntity[] = [
      { id: 'A', kind: 'elliptical-arc', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
        startParam: 0, endParam: Math.PI },
      { id: 'C', kind: 'line', construction: false,
        start: { x: -20, y: 3 }, end: { x: 20, y: 3 } },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'fxA', kind: 'fix', point: ref('A', 'center') },
      { id: 'fxC', kind: 'fix', point: ref('C', 'start') },
      { id: 'hC', kind: 'horizontal', line: 'C' },
    ]
    const dimensions: SketchDimension[] = [
      { id: 'dCx', kind: 'distanceX', driving: true, value: 40,
        a: ref('C', 'start'), b: ref('C', 'end') },
      { id: 'dMajA', kind: 'majorRadius', driving: true, value: 10, entityId: 'A' },
      { id: 'dMinA', kind: 'minorRadius', driving: true, value: 5, entityId: 'A' },
    ]
    const before: Sketch = {
      id: 'sk-repro-arc', layerId: 'layer', entities, constraints, dimensions,
      solveStatus: null,
    }
    const pre = countSolves(before)
    logOutcome('arc pre-trim ', pre.out, pre.solves)
    expect(pre.out.ok).toBe(true)
    if (!pre.out.ok) return
    // Re-pinned 2026-08-20 against d8a22e90 (WO-207/WO-219): the arc's
    // start/end are solver points now, so with only the center fixed the
    // baseline reads 4 dof (was 0 when only the center was a solver point)
    // and A is not classified defined; C stays rigid.
    expect(pre.out.status.dof).toBe(4)
    expect(new Set(pre.out.status.fullyDefinedEntities)).toEqual(new Set(['C']))

    // Click the top (0, 5): middle span removed -> START piece keeps id A,
    // END piece = new normal arc, REMOVED middle = new construction arc.
    // TWO new entities, each with its own free center point.
    const t = trimAtPoint(
      { entities: [...entities], constraints: [...constraints], dimensions: [...dimensions] },
      { x: 0, y: 5 }, 0.5, newId,
    ).transform
    expect(t).not.toBeNull()
    if (!t) return
    const pieces = t.entities.filter(
      (e): e is SketchEllipticalArcEntity => e.kind === 'elliptical-arc')
    console.log('[repro] arc post-trim entities: ' +
      t.entities.map((e) => `${e.id}:${e.kind}${e.construction ? ':construction' : ''}`).join(' '))
    expect(pieces).toHaveLength(3)
    const newPieces = pieces.filter((p) => p.id !== 'A')
    expect(newPieces).toHaveLength(2)

    const after: Sketch = {
      ...before,
      entities: t.entities, constraints: t.constraints, dimensions: t.dimensions,
      solveStatus: pre.out.status,
    }
    const post = countSolves(after)
    logOutcome('arc post-trim', post.out, post.solves)
    expect(post.out.ok).toBe(true)
    if (!post.out.ok) return

    // GROUND TRUTH: the two brand-new pieces are fully free; neither is
    // classified defined. Accounting under d8a22e90: A (center fixed,
    // start/end free) = 4 + two new pieces x (center/start/end free) 6 = 16.
    // Before d8a22e90 this read 4 (one free center per new piece).
    expect(post.out.status.dof).toBe(16)
    const defined = new Set(post.out.status.fullyDefinedEntities)
    for (const p of newPieces) {
      expect(defined.has(p.id), `${p.id} must NOT be classified defined`).toBe(false)
    }
    expect(defined.has('A')).toBe(false)
    expect(defined.has('C')).toBe(true)
  })

  it('FULL STORE PATH: trim click via sketchToolClick -> re-solve -> status must not read fully defined', async () => {
    // Same fully-defined ellipse+cutter document, driven through the REAL
    // production loop: armed trim tool click -> replace transform ->
    // solveSketch -> (loopback) worker running the real solver -> the
    // store's onmessage handler -> sketchSolveStatus (what the definition
    // chip reads: dof === 0 renders "fully defined").
    const entities: SketchEntity[] = [
      { id: 'SE', kind: 'ellipse', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0 },
      { id: 'SL', kind: 'line', construction: false,
        start: { x: 6, y: -20 }, end: { x: 6, y: 20 } },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'sfxE', kind: 'fix', point: ref('SE', 'center') },
      { id: 'sfxL', kind: 'fix', point: ref('SL', 'start') },
      { id: 'svL', kind: 'vertical', line: 'SL' },
    ]
    const dimensions: SketchDimension[] = [
      { id: 'sdLy', kind: 'distanceY', driving: true, value: 40,
        a: ref('SL', 'start'), b: ref('SL', 'end') },
      { id: 'sdMaj', kind: 'majorRadius', driving: true, value: 10, entityId: 'SE' },
      { id: 'sdMin', kind: 'minorRadius', driving: true, value: 5, entityId: 'SE' },
    ]
    useCamStore.setState({
      activeSketch: {
        id: 'sk-store', layerId: 'layer', entities, constraints, dimensions,
        solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchSelectedIds: [],
      sketchNotice: null,
      sketchHistory: [],
      projectHistory: [],
      canUndo: false,
    })
    // The armed tool + chain live in the package now.
    sketcherToolStore.setState({ tool: 'trim', chain: null })

    // Open solve: fully defined baseline.
    useCamStore.getState().solveSketch()
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    const preStatus = useCamStore.getState().sketchSolveStatus!
    console.log(`[repro] store pre-trim: dof=${preStatus.dof} ` +
      `defined=[${(preStatus.fullyDefinedEntities ?? []).join(',')}]`)
    expect(preStatus.dof).toBe(0)

    // The REAL trim click (armed tool, pick tolerance 1 mm at (9.5, 0)).
    sketcherTools.click({ x: 9.5, y: 0 }, 1, null, false)
    const midEntities = useCamStore.getState().activeSketch!.entities
    console.log('[repro] store post-click entities: ' +
      midEntities.map((e) => `${e.id}:${e.kind}${e.construction ? ':construction' : ''}`).join(' '))
    expect(midEntities.some((e) => e.kind === 'elliptical-arc' && e.construction)).toBe(true)

    // The click's re-solve lands asynchronously: wait for a NEW status.
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus !== preStatus,
      'post-trim solve status',
    )
    const post = useCamStore.getState().sketchSolveStatus!
    const constructionPiece = useCamStore.getState().activeSketch!.entities.find(
      (e) => e.kind === 'elliptical-arc' && e.construction)!
    console.log(`[repro] store post-trim: dof=${post.dof} ` +
      `conflicting=[${post.conflicting.join(',')}] ` +
      `defined=[${(post.fullyDefinedEntities ?? []).join(',')}]`)

    // GROUND TRUTH (chip semantics): the sketch is NOT fully defined — the
    // construction piece is free. dof must never be 0. Exact count re-pinned
    // 2026-08-20 against d8a22e90 (elliptical-arc start/end are solver
    // points): 4 (SE endpoints) + 6 (construction piece) = 10; was 2 before.
    expect(post.dof).toBe(10)
    expect(post.dof).toBeGreaterThan(0)
    expect(new Set(post.fullyDefinedEntities ?? []).has(constructionPiece.id)).toBe(false)
  })
})
