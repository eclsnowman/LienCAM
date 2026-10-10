// Over-defined conflict resolution flow (Stage 4 commit: resolution).
//
// Store integration against the REAL solver (loopback Worker running
// gcsMapping in-process — same harness as constraintApply.test.ts):
//   - the existing Seed-conflict fixture (demo sketch + a 70mm distance
//     contradicting the 60mm width on the same two points) produces a
//     solver-NAMED conflicting set, and the resolution list model
//     (rowsForIds) renders exactly that set
//   - removing ONE member through deleteSketchItems (the resolve flow's
//     Remove action) clears the conflict and restores dof/status
//   - REDUNDANT constraints are reported in their own set, listed
//     separately from conflicts (advisory amber, not an error)

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { rowsForIds } from '../../lib/sketch/browserModel'
import type {
  Sketch, SketchEntity, SketchConstraint, DistanceDimension,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'

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
let buildDemoSketch: typeof import('../../lib/sketch/demoSeed').buildDemoSketch

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ buildDemoSketch } = await import('../../lib/sketch/demoSeed'))
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
})

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// The Seed-conflict fixture's dimension (demoSeed.seedConflict): a 70mm
// driving distance on the SAME two points the 60mm width already drives.
function conflictDim(): DistanceDimension {
  return {
    id: 'demo-dim-conflict', kind: 'distance', driving: true, value: 70,
    a: { entityId: 'demo-rect-bottom', site: 'start' },
    b: { entityId: 'demo-rect-bottom', site: 'end' },
    labelAnchor: { x: 30, y: 14 },
  }
}

describe('over-defined conflict resolution (real solver)', () => {
  it('seeded conflict: the resolution list is the solver-named set, and removing one member clears it', async () => {
    // Seed-conflict fixture, headless: demo sketch + conflicting dim.
    // The seed document carries a placeholder status (dof -1) that
    // setActiveSketch mirrors immediately; wait for the REAL open-solve
    // verdict (dof >= 0), not just any non-null status.
    useCamStore.getState().setActiveSketch(buildDemoSketch())
    await waitUntil(
      () => (useCamStore.getState().sketchSolveStatus?.dof ?? -1) >= 0,
      'open solve',
    )
    const preDof = useCamStore.getState().sketchSolveStatus!.dof
    expect(preDof).toBeGreaterThan(0) // demo sketch is under-defined
    expect(useCamStore.getState().sketchSolveStatus!.conflicting).toEqual([])

    useCamStore.getState().addDimension(conflictDim())
    useCamStore.getState().solveSketch()
    await waitUntil(
      () => (useCamStore.getState().sketchSolveStatus?.conflicting.length ?? 0) > 0,
      'conflict diagnosis',
    )

    const status = useCamStore.getState().sketchSolveStatus!
    const sketch = useCamStore.getState().activeSketch!

    // The solver NAMES the set; the resolution list renders EXACTLY it
    // (same ids, solver order), with operand labels — not raw ids.
    const rows = rowsForIds(sketch, status.conflicting)
    expect(rows.map((r) => r.id)).toEqual(status.conflicting)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.operands.length).toBeGreaterThan(0)
      expect(r.operands).not.toContain('demo-') // labels, never ids
    }
    // The named set must include the contradicting dimension pair (the
    // 70mm conflict dim at minimum — the solver may name the 60mm width
    // and supporting constraints too).
    expect(status.conflicting).toContain('demo-dim-conflict')

    // Resolve: remove ONE member of the named set (the flow's Remove
    // action) -> pushHistory + re-solve -> conflict cleared, dof back.
    useCamStore.getState().deleteSketchItems(['demo-dim-conflict'])
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.conflicting.length === 0,
      'conflict cleared after removal',
    )
    const after = useCamStore.getState()
    expect(after.activeSketch!.dimensions.some((d) => d.id === 'demo-dim-conflict'))
      .toBe(false)
    expect(after.sketchSolveStatus!.dof).toBe(preDof)
    // One undo step: the removal can be undone.
    expect(after.canUndo).toBe(true)
  })

  it('redundant constraints are named in their own set, separate from conflicts', async () => {
    // A horizontal line driven by TWO equivalent constraints: horizontal
    // + a second horizontal on the same line. The duplicate adds no
    // information -> the solver reports it REDUNDANT, not conflicting.
    const l1: SketchEntity = {
      id: 'l1', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    }
    const constraints: SketchConstraint[] = [
      { id: 'h-a', kind: 'horizontal', line: 'l1' },
      { id: 'h-b', kind: 'horizontal', line: 'l1' },
    ]
    const sk: Sketch = {
      id: 'sk', layerId: 'layer', entities: [l1],
      constraints, dimensions: [], solveStatus: null,
    }
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus !== null,
      'solve with duplicate horizontal',
    )
    const status = useCamStore.getState().sketchSolveStatus!
    expect(status.conflicting).toEqual([]) // advisory, NOT an error
    expect(status.redundant.length).toBeGreaterThan(0)
    // Every named id is one of the two horizontals.
    for (const id of status.redundant) {
      expect(['h-a', 'h-b']).toContain(id)
    }
    // The amber list renders the named set with labels.
    const rows = rowsForIds(useCamStore.getState().activeSketch!, status.redundant)
    expect(rows.map((r) => r.id)).toEqual(status.redundant)
    expect(rows[0].label).toBe('Horizontal')
    expect(rows[0].operands).toBe('Line 1')

    // Optional removal: deleting the named duplicate leaves a clean,
    // redundancy-free sketch.
    useCamStore.getState().deleteSketchItems([status.redundant[0]])
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.redundant.length === 0,
      'redundancy cleared after removal',
    )
    // WO SKC-49: setActiveSketch always injects 3 fixed anchor constraints (origin + both axes)
    // alongside the 2 user horizontals -- 1 user horizontal survives the removal + 3 injected = 4.
    expect(useCamStore.getState().activeSketch!.constraints).toHaveLength(4)
    expect(useCamStore.getState().sketchSolveStatus!.conflicting).toEqual([])
  })
})
