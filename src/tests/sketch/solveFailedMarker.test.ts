// FAIL-LOUD marker for FAILED solves (ADR 0003 regression gate).
//
// Bug being locked out: a solve whose MAPPING failed (SketchMappingError —
// e.g. a constraint referencing an unknown entity id) used to return
// { ok: false, status: { dof: 0, ... } }. The store wrote that status
// wholesale and the definition chip renders dof === 0 as "Fully defined" —
// so ANY sketch edit that failed to map lit a GREEN "Fully defined" chip:
// a false-positive safety signal.
//
// Fix under test: every ok:false SketchSolveOutcome carries an explicit
// status.solveFailed === true (+ failureMessage), the store re-marks it on
// SKETCH_SOLVE_FAILED, and no consumer may treat the placeholder dof as a
// definition verdict.
//
// Harness pattern follows ellipseTrimDefinedness.repro.test.ts: real
// planegcs wrapper for the solver-layer cases, loopback in-process worker
// for the full store path.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, PointRef,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'

// ---- Loopback worker (store-path test): real planegcs solve, in-process ----
let loopbackWrapperPromise: Promise<GcsWrapper> | null = null
function ensureLoopbackWrapper(): Promise<GcsWrapper> {
  if (!loopbackWrapperPromise) loopbackWrapperPromise = createGcsWrapper()
  return loopbackWrapperPromise
}
// When set, the loopback worker reports SKETCH_SOLVE_ERROR instead of
// solving — the real worker's catch-all for an unexpected crash (WASM load
// failure, solver bug; sketchSolverWorker.ts onmessage try/catch).
let simulateWorkerCrash: string | null = null
// The store keeps its Worker private; capture the instance it constructs so
// the onerror (script-failure) test can fire that handler directly.
let lastLoopbackWorker: LoopbackWorker | null = null
class LoopbackWorker {
  constructor() { lastLoopbackWorker = this }
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    void (async () => {
      const { requestId, sketch } = msg.payload
      if (simulateWorkerCrash !== null) {
        this.onmessage?.({ data: {
          type: 'SKETCH_SOLVE_ERROR', requestId, message: simulateWorkerCrash,
        } })
        return
      }
      const w = await ensureLoopbackWrapper()
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

let wrapper: GcsWrapper
beforeAll(async () => {
  wrapper = await createGcsWrapper()
  ;({ useCamStore } = await import('../../store'))
})
afterAll(() => { wrapper.destroy_gcs_module() })

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

/** One fully-definable line: start fixed + vertical + driving length. */
function rigidLine(id = 'L'): {
  entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[]
} {
  return {
    entities: [{ id, kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 0, y: 40 } }],
    constraints: [
      { id: `fx${id}`, kind: 'fix', point: ref(id, 'start') },
      { id: `v${id}`, kind: 'vertical', line: id },
    ],
    dimensions: [{ id: `d${id}`, kind: 'distanceY', driving: true, value: 40,
      a: ref(id, 'start'), b: ref(id, 'end') }],
  }
}

describe('solveFailed marker on FAILED solve statuses (ADR 0003)', () => {
  it('mapping failure (invalid_sketch): status is marked, dof 0 is not a verdict, previous definition states carried', () => {
    const base = rigidLine()
    // Previous GOOD solve: fully defined, exact per-entity list present.
    const goodSketch: Sketch = {
      id: 'sk-good', layerId: 'layer', ...base, solveStatus: null,
    }
    const good = solveSketchOnWrapper(wrapper, goodSketch)
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.status.dof).toBe(0)
    expect(good.status.solveFailed).toBeUndefined() // marker NEVER on a success
    expect(good.status.failureMessage).toBeUndefined()

    // Now an edit that fails to MAP: a fix constraint referencing an
    // entity id that does not exist (the sketchToGcsPrimitives validation
    // throws SketchMappingError before the solver ever runs).
    const broken: Sketch = {
      ...goodSketch,
      constraints: [...base.constraints,
        { id: 'dangling', kind: 'fix', point: ref('NO_SUCH_ENTITY', 'self') }],
      solveStatus: good.status, // store carries the last status on the doc
    }
    const out = solveSketchOnWrapper(wrapper, broken)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('invalid_sketch')
    // THE marker: explicit, never a silent dof:0-as-fully-defined.
    expect(out.status.solveFailed).toBe(true)
    expect(out.status.failureMessage).toBeTruthy()
    expect(out.status.failureMessage).toContain('NO_SUCH_ENTITY')
    // The previous solve's per-entity definition states are carried so the
    // viewport keeps the previous coloring instead of flashing.
    expect(out.status.fullyDefinedEntities).toEqual(good.status.fullyDefinedEntities)
  })

  it('conflicting solve: status is marked solveFailed too', () => {
    const base = rigidLine('C')
    // Over-constrain the proven way (solver.test.ts pattern): the line is
    // already fully defined at length 40; a SECOND driving dimension
    // demands a contradicting 10.
    const sketch: Sketch = {
      id: 'sk-conflict', layerId: 'layer',
      entities: base.entities,
      constraints: base.constraints,
      dimensions: [...base.dimensions,
        { id: 'dConflict', kind: 'distanceY', driving: true, value: 10,
          a: ref('C', 'start'), b: ref('C', 'end') }],
      solveStatus: null,
    }
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.conflicting.length).toBeGreaterThan(0)
    expect(out.status.solveFailed).toBe(true)
    expect(out.status.failureMessage).toBeTruthy()
  })

  it('FULL STORE PATH: failed solve writes a marked status (chip can never read "fully defined")', async () => {
    const base = rigidLine('S')
    useCamStore.setState({
      activeSketch: {
        id: 'sk-store-fail', layerId: 'layer', ...base, solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchSelectedIds: [],
      sketchNotice: null,
    })

    // Open solve: clean, fully defined, NO marker.
    useCamStore.getState().solveSketch()
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    const pre = useCamStore.getState().sketchSolveStatus!
    expect(pre.dof).toBe(0)
    expect(pre.solveFailed).toBeUndefined()

    // Corrupt the document (dangling constraint) and re-solve — the exact
    // shape of the reported bug: the mapping fails, SKETCH_SOLVE_FAILED
    // lands, and the written status used to read dof 0 = "Fully defined".
    const s = useCamStore.getState()
    useCamStore.setState({
      activeSketch: {
        ...s.activeSketch!,
        constraints: [...s.activeSketch!.constraints,
          { id: 'dangling-s', kind: 'fix', point: ref('GHOST', 'self') }],
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useCamStore.getState().solveSketch()
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus !== pre,
      'failed solve status',
    )
    const post = useCamStore.getState().sketchSolveStatus!
    // Marked end to end: live status AND the document's persisted status.
    expect(post.solveFailed).toBe(true)
    expect(post.failureMessage).toBeTruthy()
    expect(useCamStore.getState().activeSketch!.solveStatus?.solveFailed).toBe(true)
    // The console warn (fail-loud breadcrumb) is kept.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid_sketch'))
    warn.mockRestore()

    // A failed status also refuses to hand out a drag (geometry is not a
    // trusted solve result) — explicit solveFailed gate in beginSketchDrag.
    expect(useCamStore.getState().beginSketchDrag('S', { x: 0, y: 0 }, 1)).toBe(false)
  })

  it('FULL STORE PATH: worker crash (SKETCH_SOLVE_ERROR) writes a marked status — never silent', async () => {
    const base = rigidLine('W')
    useCamStore.setState({
      activeSketch: {
        id: 'sk-worker-crash', layerId: 'layer', ...base, solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchSelectedIds: [],
      sketchNotice: null,
    })

    // Open solve: clean, fully defined, NO marker.
    useCamStore.getState().solveSketch()
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    const pre = useCamStore.getState().sketchSolveStatus!
    expect(pre.dof).toBe(0)
    expect(pre.solveFailed).toBeUndefined()
    const preEntities = useCamStore.getState().activeSketch!.entities

    // Crash the worker on the next solve — the real worker posts
    // SKETCH_SOLVE_ERROR from its catch-all (WASM load failure / bug).
    // Before the fix this branch only console.error'd: the store kept the
    // stale GREEN "fully defined" status — a silent failure (ADR 0003).
    simulateWorkerCrash = 'WASM module exploded (simulated)'
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      useCamStore.getState().solveSketch()
      await waitUntil(
        () => useCamStore.getState().sketchSolveStatus?.solveFailed === true,
        'worker-crash failed status',
      )
    } finally {
      simulateWorkerCrash = null
    }
    const post = useCamStore.getState().sketchSolveStatus!
    // Marked end to end: live status AND the document's persisted status,
    // with the crash message carried for the chip tooltip.
    expect(post.solveFailed).toBe(true)
    expect(post.failureMessage).toContain('WASM module exploded')
    expect(useCamStore.getState().activeSketch!.solveStatus?.solveFailed).toBe(true)
    // The previous solve's per-entity definition states are carried so the
    // viewport keeps its coloring; geometry itself is untouched.
    expect(post.fullyDefinedEntities).toEqual(pre.fullyDefinedEntities)
    expect(useCamStore.getState().activeSketch!.entities).toEqual(preEntities)
    // The console error (fail-loud breadcrumb) is kept.
    expect(err).toHaveBeenCalledWith('[sketchSolver] error:',
      expect.stringContaining('WASM module exploded'))
    err.mockRestore()

    // Crashed status refuses drags too (same gate as SKETCH_SOLVE_FAILED).
    expect(useCamStore.getState().beginSketchDrag('W', { x: 0, y: 0 }, 1)).toBe(false)
  })

  it('FULL STORE PATH: worker SCRIPT failure (onerror) writes a marked status — never silent', async () => {
    const base = rigidLine('X')
    useCamStore.setState({
      activeSketch: {
        id: 'sk-onerror', layerId: 'layer', ...base, solveStatus: null,
      },
      sketchSolveStatus: null,
      sketchSelectedIds: [],
      sketchNotice: null,
    })

    // Open solve: clean, fully defined, NO marker — and ensures the store
    // has constructed its worker (captured in lastLoopbackWorker).
    useCamStore.getState().solveSketch()
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    const pre = useCamStore.getState().sketchSolveStatus!
    expect(pre.solveFailed).toBeUndefined()
    expect(lastLoopbackWorker?.onerror).toBeTruthy()

    // Fire the script-failure path: the worker file itself failed to
    // load/parse, so no message (and no requestId) ever arrives. Before
    // the fix this handler only console.error'd — the stale green status
    // stayed on screen (ADR 0003 violation).
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    lastLoopbackWorker!.onerror?.(
      { message: 'worker script failed to parse (simulated)', filename: 'w.ts', lineno: 1 })
    const post = useCamStore.getState().sketchSolveStatus!
    expect(post.solveFailed).toBe(true)
    expect(post.failureMessage).toContain('worker script failed to parse')
    expect(useCamStore.getState().activeSketch!.solveStatus?.solveFailed).toBe(true)
    // Previous per-entity definition states carried for coloring.
    expect(post.fullyDefinedEntities).toEqual(pre.fullyDefinedEntities)
    // The console error (fail-loud breadcrumb) is kept.
    expect(err).toHaveBeenCalled()

    // An ErrorEvent with an EMPTY message still gets a readable reason.
    lastLoopbackWorker!.onerror?.({ message: '', filename: '', lineno: 0 })
    expect(useCamStore.getState().sketchSolveStatus!.failureMessage)
      .toBe('sketch solver worker failed to load')
    err.mockRestore()

    // Crashed status refuses drags too (same gate as SKETCH_SOLVE_FAILED).
    expect(useCamStore.getState().beginSketchDrag('X', { x: 0, y: 0 }, 1)).toBe(false)
  })
})
