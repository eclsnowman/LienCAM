// Driving <-> reference toggle + dimension UX polish (Stage 4):
// toggling drops/applies the constraint effect (dof assertions against
// the REAL solver), deleting a dimension restores dof, repositioning a
// label never touches the solve.

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
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import binds the CAM document sink into the package (module-load
  // side effect); keep it first so the package is fully wired.
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

beforeEach(() => {
  useCamStore.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchDimEditor: null,
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  // Armed tool + chain now live in the package.
  sketcherToolStore.__reset()
})

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---- fixtures ---------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
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

/** Fully defined: horizontal line, start pinned, length driven (dof 0). */
function pinnedLine(): Sketch {
  return makeSketch(
    [line('l1', 0, 0, 10, 0)],
    [
      { id: 'h', kind: 'horizontal', line: 'l1' },
      { id: 'f', kind: 'fix', point: ref('l1', 'start') },
    ],
    [
      { id: 'dl', kind: 'distance', driving: true, value: 10,
        a: ref('l1', 'start'), b: ref('l1', 'end') },
    ],
  )
}

const dim = (id: string) =>
  useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === id)!

// ---- driving <-> reference toggle ---------------------------------------------

describe('toggleDimensionDriving (store + real solver)', () => {
  it('driving -> reference frees the dof; reference -> driving binds it again', async () => {
    useCamStore.getState().setActiveSketch(pinnedLine())
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'open solve (fully defined)',
    )

    // driving -> reference: solver no longer bound, dof rises.
    useCamStore.getState().toggleDimensionDriving('dl')
    expect(dim('dl').driving).toBe(false)
    expect(dim('dl').value).toBeCloseTo(10, 9) // snapped to measured
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 1,
      'toggle solve (dof 0 -> 1)',
    )

    // reference -> driving: constraint applies again at the measured
    // value (consistent geometry — accepted, dof back to 0).
    useCamStore.getState().toggleDimensionDriving('dl')
    expect(dim('dl').driving).toBe(true)
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'toggle solve (dof 1 -> 0)',
    )
    expect(useCamStore.getState().sketchSolveStatus!.conflicting).toEqual([])
  })

  it('a conflicting reference -> driving toggle auto-reverts and names the set', async () => {
    // Second width dim as a REFERENCE with a stale value (50 vs the
    // driven 40): toggling it to driving is inconsistent -> rejected,
    // reverted to reference, conflict set named.
    const sk = makeSketch(
      [line('l1', 0, 0, 40, 0)],
      [
        { id: 'h', kind: 'horizontal', line: 'l1' },
        { id: 'f', kind: 'fix', point: ref('l1', 'start') },
      ],
      [
        { id: 'dw', kind: 'distance', driving: true, value: 40,
          a: ref('l1', 'start'), b: ref('l1', 'end') },
        { id: 'dr', kind: 'distance', driving: false, value: 0,
          a: ref('l1', 'start'), b: ref('l1', 'end') },
      ],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'open solve',
    )
    // The reference tracked the measured 40; force a stale 50 to make
    // the toggle inconsistent (setDimensionValue is the raw setter).
    useCamStore.getState().setDimensionValue('dr', 50)

    useCamStore.getState().toggleDimensionDriving('dr')
    await waitUntil(
      () => useCamStore.getState().sketchNotice !== null,
      'rejection notice',
    )
    expect(useCamStore.getState().sketchNotice)
      .toContain('Distance dimension rejected: conflicts with')
    // Reverted to reference; the re-solve tracks it back to measured 40.
    expect(dim('dr').driving).toBe(false)
    await waitUntil(
      () => Math.abs(dim('dr').value - 40) < 1e-6 &&
            useCamStore.getState().sketchSolveStatus?.dof === 0 &&
            useCamStore.getState().sketchSolveStatus?.conflicting.length === 0,
      're-solve after revert (reference tracks 40)',
    )
    const l1 = useCamStore.getState().activeSketch!.entities[0]
    if (l1.kind !== 'line') throw new Error('l1 missing')
    expect(l1.end.x).toBeCloseTo(40, 6) // geometry untouched
  })
})

// ---- delete + label reposition ---------------------------------------------------

describe('dimension label UX', () => {
  it('deleting a selected dimension restores dof (deleteSelection cascade)', async () => {
    useCamStore.getState().setActiveSketch(pinnedLine())
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'open solve (fully defined)',
    )

    // Labels select like entities; Delete removes the dimension alone.
    useCamStore.getState().setSketchSelection(['dl'])
    useCamStore.getState().deleteSketchSelection()
    expect(useCamStore.getState().activeSketch!.dimensions).toHaveLength(0)
    // WO SKC-49: the line + the three injected anchors setActiveSketch always carries.
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(4) // line stays
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 1,
      'delete solve (dof 0 -> 1)',
    )
  })

  // T1d: a constraint badge click selects the constraint (viewport pick
  // returns { id: constraintId } -> setSketchSelection), and Delete removes
  // it via the SAME store path a dimension/entity delete uses. The pure
  // document transform is covered in deleteSelection.test.ts; this locks the
  // store wiring (select constraint id -> deleteSketchSelection -> re-solve,
  // constraint alone removed, geometry kept, dof rises).
  it('deleting a selected constraint removes only it and raises dof', async () => {
    useCamStore.getState().setActiveSketch(pinnedLine())
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'open solve (fully defined)',
    )

    // Badge click selects the horizontal constraint by id; Delete removes it.
    useCamStore.getState().setSketchSelection(['h'])
    useCamStore.getState().deleteSketchSelection()
    const after = useCamStore.getState().activeSketch!
    expect(after.constraints.map((c) => c.id)).not.toContain('h')
    expect(after.constraints.map((c) => c.id)).toContain('f') // others stay
    expect(after.entities).toHaveLength(4)   // line untouched (+ WO SKC-49's 3 injected anchors)
    expect(after.dimensions).toHaveLength(1) // distance dim untouched
    expect(useCamStore.getState().sketchSelectedIds).not.toContain('h')
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 1,
      'delete solve (dof 0 -> 1, the horizontal freed one dof)',
    )
  })

  it('label reposition stores the offset and does not affect the solve', async () => {
    useCamStore.getState().setActiveSketch(pinnedLine())
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'open solve',
    )
    const entitiesBefore = useCamStore.getState().activeSketch!.entities
    const statusBefore = useCamStore.getState().sketchSolveStatus!

    useCamStore.getState().updateDimensionLabel('dl', { x: 33, y: -7 })
    expect(dim('dl').labelAnchor).toEqual({ x: 33, y: -7 })

    // No solve was triggered by the reposition; a manual solve afterwards
    // leaves geometry and status exactly as before.
    useCamStore.getState().solveSketch()
    await waitUntil(
      () => useCamStore.getState().activeSketch!.solveStatus !== statusBefore,
      'manual solve lands',
    )
    const after = useCamStore.getState()
    expect(after.sketchSolveStatus!.dof).toBe(0)
    expect(after.sketchSolveStatus!.conflicting).toEqual([])
    const l1b = entitiesBefore[0], l1a = after.activeSketch!.entities[0]
    if (l1b.kind !== 'line' || l1a.kind !== 'line') throw new Error('line missing')
    expect(l1a.start).toEqual(l1b.start)
    expect(l1a.end.x).toBeCloseTo(l1b.end.x, 9)
    expect(l1a.end.y).toBeCloseTo(l1b.end.y, 9)
    expect(dim('dl').labelAnchor).toEqual({ x: 33, y: -7 }) // offset persisted
  })
})
