// Fresh-lift solve status: the anti-stale-{dof:0} pin, updated for SKC-BLOCKS
// Stage 3 (imported layer ARRIVES as a LOCKED block).
//
// A document created by the lift path used to inherit createBlankSketch's
// { dof: 0 } solveStatus and NO solve ran on open, so it read "Fully defined"
// off a STALE default before any real solve. That anti-stale-status pin still
// stands: opening leaves solveStatus null (UNKNOWN until the real solve returns)
// and POSTS a real SOLVE_SKETCH.
//
// Stage 3 changes what that first real solve REPORTS: the import now arrives as
// ONE locked block (origin fix-pinned), so the whole import is fully-defined BY
// CONSTRUCTION -- dof 0, movable as a unit, Explode to edit -- instead of the
// old under-defined blue sea of loose lines. Pins:
//   (a) store: opening a lifted layer leaves solveStatus null (UNKNOWN, never a
//       stale "fully defined") and POSTS a real SOLVE_SKETCH to the worker,
//   (b) store: the lifted document is ONE block whose origin is fix-pinned,
//   (c) solver (real planegcs, headless): the born-locked block's first solve
//       reports dof 0 (fully-defined by construction).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { ImportedGeometry, Loop2D } from '../../types'
import { liftLoops } from '../../lib/sketch/lift'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchBlockEntity, SketchLineEntity } from '../../lib/sketch/types'

// Worker stub that RECORDS posted messages so the open-solve is assertable.
const postedMessages: unknown[] = []
class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: unknown): void { postedMessages.push(msg) }
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

const GEO_ID = 'dxf-geo'
const LAYER_ID = 'dxf-layer'

/** 10x10 rectangle as a bare polyline (no segments[]) — the common DXF
 *  import shape. Unconstrained beyond the lift's coincident joints. */
function rectLoop(): Loop2D {
  return {
    id: 'loop-rect', layerId: LAYER_ID, closed: true, type: 'contour',
    area: 100,
    points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ],
  }
}

function makeImportedGeo(): ImportedGeometry {
  return {
    id: GEO_ID,
    name: 'part.dxf',
    filename: 'part.dxf',
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [rectLoop()],
    layers2d: [{ id: LAYER_ID, name: '0', color: '#00ff00', visible: true }],
  }
}

beforeEach(() => {
  postedMessages.length = 0
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select' as const,
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [makeImportedGeo()] },
    projectHistory: [],
    sketchHistory: [],
  }))
})

describe('fresh lift: solve status is UNKNOWN until a real solve runs', () => {
  it('opens with solveStatus null (not the stale blank { dof: 0 }) and posts a solve', () => {
    const ok = useCamStore.getState().openSketchForLayer(LAYER_ID)
    expect(ok).toBe(true)
    const st = useCamStore.getState()
    // UNKNOWN, never a stale "fully defined": both the document and the live
    // slot stay null until the real solve returns (the born-locked block is
    // fully-defined only AFTER the solve confirms it, never presumptively).
    expect(st.activeSketch!.solveStatus).toBeNull()
    expect(st.sketchSolveStatus).toBeNull()
    // Opening DISPATCHED a real solve for the lifted document.
    const solves = postedMessages.filter(
      (m) => (m as { type?: string }).type === 'SOLVE_SKETCH'
    )
    expect(solves.length).toBeGreaterThanOrEqual(1)
    const last = solves[solves.length - 1] as {
      payload: { sketch: Sketch }
    }
    // SKC-BLOCKS Stage 3: the import is ONE locked block (not 4 loose lines).
    const blocks = last.payload.sketch.entities.filter((e) => e.kind === 'block')
    expect(blocks).toHaveLength(1)
  })

  it('the lifted document is ONE locked block whose origin is fix-pinned', () => {
    useCamStore.getState().openSketchForLayer(LAYER_ID)
    const st = useCamStore.getState()
    const block = st.activeSketch!.entities.find(
      (e): e is SketchBlockEntity => e.kind === 'block')
    expect(block).toBeDefined()
    // The 4 rectangle lines are the block's members, not loose top-level lines.
    expect(block!.members.entities).toHaveLength(4)
    // Born locked: a fix pins its origin (this is what makes the import
    // fully-defined by construction rather than the blue under-defined sea).
    const originFix = st.activeSketch!.constraints.find(
      (c) => c.kind === 'fix' && c.point?.entityId === block!.id && c.point?.site === 'origin')
    expect(originFix).toBeDefined()
  })

  it('first REAL solve of the born-locked block reports dof 0 (fully-defined by construction)', async () => {
    useCamStore.getState().openSketchForLayer(LAYER_ID)
    const sketch = useCamStore.getState().activeSketch!
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sketch)
    expect(out.ok).toBe(true)
    // The whole import is ONE fix-pinned origin point -> dof 0. (The old loose
    // lift reported dof 8 here; Stage 3 kills that under-defined sea.)
    expect(out.status.dof).toBe(0)
    expect(out.status.conflicting).toEqual([])
    gcs.destroy_gcs_module()
  })

  it('lift output itself carries no fix constraints (the block wrap adds the fix, not liftLoops)', () => {
    const lifted = liftLoops([rectLoop()])
    expect(lifted.entities).toHaveLength(4)
    expect(lifted.constraints.every((c) => c.kind === 'coincident')).toBe(true)
  })
})

describe('large lifted import: partitioned solve under the fixed WASM heap', () => {
  // The planegcs WASM heap is FIXED at 16 MB: one solve of a system past
  // ~210 entities aborts the module with OOM. The stage 5 gate's BMG.dxf
  // lift is 340 entities (6 independent loop components, largest 202) —
  // before partitioning, the open-solve AND every drag solve aborted, so
  // the lifted layer was uneditable with a console full of Aborted(OOM).
  it('solves the real 340-entity BMG.dxf lift (gate scene) without OOM', async () => {
    const { readFileSync } = await import('fs')
    const { importDXF } = await import('../../lib/import/dxfImporter')
    const res = importDXF(readFileSync('Sample Parts/BMG.dxf', 'utf-8'))
    const layerWithLoops = res.layers.find((ly) =>
      res.loops.some((lp) => lp.layerId === ly.id))!
    const loops = res.loops.filter((lp) => lp.layerId === layerWithLoops.id)
    const lifted = liftLoops(loops)
    expect(lifted.entities.length).toBeGreaterThan(300) // the OOM regime

    const sketch: Sketch = {
      id: 'sk', layerId: layerWithLoops.id,
      entities: lifted.entities, constraints: lifted.constraints,
      dimensions: [], solveStatus: null,
    }
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.dof).toBeGreaterThan(0)
    expect(out.entities).toHaveLength(lifted.entities.length)

    // And the drag-solve path (the gate's mouse edit) works on it too:
    // pin the longest line's start 5 mm away and expect real movement.
    const lines = sketch.entities.filter(
      (e): e is SketchLineEntity => e.kind === 'line')
    const longest = lines.reduce((a, b) =>
      Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y) >=
      Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) ? a : b)
    const dragged = solveSketchOnWrapper(gcs, sketch, {
      targets: [{
        point: { entityId: longest.id, site: 'start' },
        to: { x: longest.start.x + 5, y: longest.start.y - 4 },
      }],
    })
    expect(dragged.ok).toBe(true)
    if (!dragged.ok) return
    const after = dragged.entities.find((e) => e.id === longest.id)
    if (!after || after.kind !== 'line') throw new Error('dragged line missing')
    const moved = Math.hypot(
      after.start.x - longest.start.x, after.start.y - longest.start.y)
    expect(moved).toBeGreaterThan(1)
  }, 60000)
})
