// @vitest-environment jsdom
//
// Dimension value editing (Stage 4): create-with-value drives geometry,
// conflicting values auto-revert via the chunk-1 reject-and-name path,
// reference dims track the measured value after every solve.
//
// Store integration against the REAL solver (the Worker global is a
// loopback running gcsMapping in-process — same harness as
// constraintApply.test.ts).
//
// WO UI-26-R1 finding 2 renamed this file .ts -> .tsx: every test above the
// CAM-mounted describe block at the bottom drives the store directly (no
// DOM); that block renders the REAL <SketcherOverlays port={camOverlaysPort}>
// against this same real-solver store, so the audit's "no CAM-mounted DOM
// blur test" gap closes against the actual production port, not a fake one.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, SketchLineEntity, PointRef,
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
// jsdom's localStorage is broken under vitest's node launch flags and the store persists on every
// set(). Install an in-memory Storage shim BEFORE importing the store (same scaffolding as the
// *.smoke.test.tsx files, e.g. SketchDimensionOverlay.smoke.test.tsx). No app change.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

let useCamStore: typeof import('../../store').useCamStore
let camSketchDocumentPort: typeof import('../../store').camSketchDocumentPort
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore
let SketcherOverlays: typeof import('../../lib/sketch/sketcher').SketcherOverlays
let camOverlaysPort: typeof import('../../components/viewport/camOverlaysPort').camOverlaysPort
let setCamOverlaySurface:
  typeof import('../../components/viewport/camOverlaysPort').setCamOverlaySurface

beforeAll(async () => {
  // The store import binds the CAM document sink into the package (module-load
  // side effect), so it MUST come before anything drives sketcherTools. It also must come after
  // the localStorage shim above: camOverlaysPort statically imports '../../store', and a STATIC
  // import anywhere in this file would hoist the store's persist-middleware setup (which captures
  // `window.localStorage` once, eagerly) above the shim -- exactly the bug a first cut of this
  // block hit ("storage.setItem is not a function"). Kept dynamic for that reason.
  ;({ useCamStore, camSketchDocumentPort } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore, SketcherOverlays } = await import('../../lib/sketch/sketcher'))
  ;({ camOverlaysPort, setCamOverlaySurface } =
    await import('../../components/viewport/camOverlaysPort'))
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
  setCamOverlaySurface(null)
})

afterEach(() => {
  cleanup()
  setCamOverlaySurface(null)
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

/** Fully defined 40x30 rectangle, l1 = bottom, l3 = top — l3's length is
 *  already determined through the constraint network. */
function rect(extraDims: SketchDimension[] = []): Sketch {
  return makeSketch(
    [
      line('l1', 0, 0, 40, 0), line('l2', 40, 0, 40, 30),
      line('l3', 40, 30, 0, 30), line('l4', 0, 30, 0, 0),
    ],
    [
      { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
      { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
      { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
      { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
      { id: 'h1', kind: 'horizontal', line: 'l1' },
      { id: 'h3', kind: 'horizontal', line: 'l3' },
      { id: 'v2', kind: 'vertical', line: 'l2' },
      { id: 'v4', kind: 'vertical', line: 'l4' },
      { id: 'fx', kind: 'fix', point: ref('l1', 'start') },
    ],
    [
      { id: 'dw', kind: 'distance', driving: true, value: 40,
        a: ref('l1', 'start'), b: ref('l1', 'end') },
      { id: 'dh', kind: 'distance', driving: true, value: 30,
        a: ref('l2', 'start'), b: ref('l2', 'end') },
      ...extraDims,
    ],
  )
}

// ---- create with value (real solver loopback) ---------------------------------

describe('smart-dim placement + value editing (store + real solver)', () => {
  it('placement opens the editor; Enter value drives geometry and lowers dof', async () => {
    // Horizontal line, start pinned: exactly ONE freedom left (length).
    const sk = makeSketch(
      [line('l1', 0, 0, 10, 0)],
      [
        { id: 'h', kind: 'horizontal', line: 'l1' },
        { id: 'f', kind: 'fix', point: ref('l1', 'start') },
      ],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    expect(useCamStore.getState().sketchSolveStatus!.dof).toBe(1)

    // Real tool path: arm, click the line, place in empty space.
    sketcherTools.armTool('smart-dimension')
    sketcherTools.click({ x: 5, y: 0 }, 0.5, null, false)
    expect(sketcherToolStore.getState().chain)
      .toEqual({ kind: 'dim', operandIds: ['l1'] })
    sketcherTools.click({ x: 5, y: 8 }, 0.5, null, false)

    // The editor opened IMMEDIATELY on the new dim, pre-fill = measured.
    const editor = useCamStore.getState().sketchDimEditor
    expect(editor).not.toBeNull()
    expect(editor!.isNew).toBe(true)
    const dim0 = useCamStore.getState().activeSketch!.dimensions[0]
    expect(dim0.id).toBe(editor!.dimId)
    expect(dim0.driving).toBe(true)
    expect(dim0.value).toBeCloseTo(10, 9)
    // SKC-72 clamps an initial drop to the geometry-relative sane band:
    // 0.35 x the selected line's 10 mm span, measured from its midpoint.
    expect(dim0.labelAnchor).toEqual({ x: 5, y: 3.5 })

    // Measured driving dim consumes the last freedom.
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'placement solve (dof 1 -> 0)',
    )

    // Type 25 + Enter: geometry moves to the typed value.
    useCamStore.getState().commitDimensionValue(dim0.id, 25)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => {
      const l = useCamStore.getState().activeSketch!.entities[0]
      return l.kind === 'line' && Math.abs(l.end.x - 25) < 1e-6
    }, 'value solve (length 10 -> 25)')
    const after = useCamStore.getState()
    expect(after.activeSketch!.dimensions[0].value).toBe(25)
    expect(after.sketchSolveStatus!.dof).toBe(0)
    expect(after.sketchSolveStatus!.conflicting).toEqual([])
  })

  it('Esc on the create editor keeps the measured value, still driving', async () => {
    const sk = makeSketch([line('l1', 0, 0, 10, 0)])
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    sketcherTools.armTool('smart-dimension')
    sketcherTools.click({ x: 5, y: 0 }, 0.5, null, false)
    sketcherTools.click({ x: 5, y: 8 }, 0.5, null, false)
    await waitUntil(() => useCamStore.getState().sketchDimEditor !== null, 'editor open')

    // Esc path = closeDimensionEditor (the input routes Escape there).
    useCamStore.getState().closeDimensionEditor()
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    const d = useCamStore.getState().activeSketch!.dimensions[0]
    expect(d.driving).toBe(true)
    expect(d.value).toBeCloseTo(10, 9)
  })

  it('a conflicting edited value auto-reverts and names the conflict set', async () => {
    // Redundant-but-consistent second width dim on l3 (top side = 40
    // through the network). Editing it to 50 contradicts dw=40.
    const dl3: SketchDimension = { id: 'dl3', kind: 'distance', driving: true,
      value: 40, a: ref('l3', 'start'), b: ref('l3', 'end') }
    useCamStore.getState().setActiveSketch(rect([dl3]))
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0 &&
            useCamStore.getState().sketchSolveStatus?.conflicting.length === 0,
      'open solve (fully defined, consistent)',
    )

    useCamStore.getState().commitDimensionValue('dl3', 50)
    await waitUntil(
      () => useCamStore.getState().sketchNotice !== null,
      'rejection notice',
    )
    const notice = useCamStore.getState().sketchNotice!
    expect(notice).toContain('Distance dimension rejected: conflicts with')
    expect(notice).not.toContain('existing constraints') // real names, not the fallback

    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.conflicting.length === 0 &&
            useCamStore.getState().sketchSolveStatus?.dof === 0,
      're-solve after revert',
    )
    const after = useCamStore.getState().activeSketch!
    expect(after.dimensions.find((d) => d.id === 'dl3')!.value).toBe(40) // restored
    // Geometry still the consistent rectangle.
    const l1 = after.entities.find((e) => e.id === 'l1')
    if (!l1 || l1.kind !== 'line') throw new Error('l1 missing')
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(40, 6)
  })

  it('a placement onto a conflicted sketch is auto-removed with a named set', async () => {
    // equal(l1, l2) contradicts the 40x30 driving dims (the chunk-1
    // conflict fixture); the placement's verdict solve fails -> the new
    // dim is removed (chunk-1 path) and the editor has nothing to edit.
    const conflicted = rect()
    conflicted.constraints.push({ id: 'eq', kind: 'equal', a: 'l1', b: 'l2' })
    useCamStore.getState().setActiveSketch(conflicted)
    await waitUntil(
      () => (useCamStore.getState().sketchSolveStatus?.conflicting.length ?? 0) > 0,
      'open solve (conflicted)',
    )
    const dimsBefore = useCamStore.getState().activeSketch!.dimensions.length

    sketcherTools.armTool('smart-dimension')
    sketcherTools.click({ x: 20, y: 0 }, 0.6, null, false)   // pick l1
    sketcherTools.click({ x: 20, y: -10 }, 0.6, null, false) // place
    await waitUntil(
      () => useCamStore.getState().sketchNotice !== null &&
            useCamStore.getState().activeSketch!.dimensions.length === dimsBefore,
      'placement rejected + removed',
    )
    expect(useCamStore.getState().sketchNotice).toContain('rejected: conflicts with')
    expect(useCamStore.getState().sketchDimEditor).toBeNull() // nothing left to edit
  })

  it('reference dims track the measured value after every solve, never constrain', async () => {
    const refDim: SketchDimension = { id: 'dr', kind: 'distance', driving: false,
      value: 0, a: ref('l1', 'start'), b: ref('l1', 'end') }
    const sk = makeSketch([line('l1', 0, 0, 10, 0)], [], [refDim])
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(
      () => useCamStore.getState().activeSketch!.dimensions[0].value !== 0,
      'open solve tracks the reference value',
    )
    const st = useCamStore.getState()
    expect(st.activeSketch!.dimensions[0].value).toBeCloseTo(10, 6)
    // No equation pushed: a free line keeps all 4 freedoms.
    expect(st.sketchSolveStatus!.dof).toBe(4)

    // Move the geometry; the reference value follows the next solve.
    useCamStore.getState().updateEntity('l1', {
      start: { x: 0, y: 0 }, end: { x: 22, y: 0 },
    } as Partial<SketchEntity>)
    useCamStore.getState().solveSketch()
    await waitUntil(
      () => Math.abs(useCamStore.getState().activeSketch!.dimensions[0].value - 22) < 1e-6,
      'reference value tracks 10 -> 22',
    )
    expect(useCamStore.getState().sketchSolveStatus!.dof).toBe(4) // still free
  })

  it('double-click edit path (headless): open targets the dim, close clears', async () => {
    useCamStore.getState().setActiveSketch(rect())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().openDimensionEditor('dw')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'dw', isNew: false })
    useCamStore.getState().closeDimensionEditor()
    expect(useCamStore.getState().sketchDimEditor).toBeNull()

    // Editing through the same action geometry-drives the rectangle.
    useCamStore.getState().openDimensionEditor('dw')
    useCamStore.getState().commitDimensionValue('dw', 60)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => {
      const l1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1')
      return !!l1 && l1.kind === 'line' && Math.abs((l1.end.x - l1.start.x) - 60) < 1e-6
    }, 'edit solve (width 40 -> 60)')
    expect(useCamStore.getState().sketchSolveStatus!.dof).toBe(0)
  })

  it('a non-numeric value is rejected with a reason and the editor stays open', async () => {
    useCamStore.getState().setActiveSketch(rect())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.getState().openDimensionEditor('dw')
    useCamStore.getState().commitDimensionValue('dw', NaN)
    expect(useCamStore.getState().sketchNotice).toContain('not a number')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'dw', isNew: false })
    expect(useCamStore.getState().activeSketch!.dimensions
      .find((d) => d.id === 'dw')!.value).toBe(40) // untouched
  })

  // Focus-to-focus (2c) direct-edit through the store + real solver: a valid 2c
  // resizes the ellipse's foci-bearing axis; a degenerate (<=0) value is
  // rejected LOUDLY and reverts (trap 2), the editor stays open.
  function ellipseSketch(): Sketch {
    const el: SketchEntity = {
      id: 'el', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 5, minorRadius: 3, rotation: 0,
    }
    return makeSketch([el], [], [
      { id: 'dF', kind: 'focusDistance', driving: true, value: 8, entityId: 'el' },
    ])
  }

  it('editing 2c resizes the ellipse; a non-positive 2c reverts with a notice', async () => {
    useCamStore.getState().setActiveSketch(ellipseSketch())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    // Valid edit: 2c = 10 -> c = 5, b = 3 -> major = sqrt(34).
    useCamStore.getState().openDimensionEditor('dF')
    useCamStore.getState().commitDimensionValue('dF', 10)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => {
      const e = useCamStore.getState().activeSketch!.entities[0]
      return e.kind === 'ellipse' && Math.abs(e.majorRadius - Math.sqrt(34)) < 1e-6
    }, 'ellipse resized to sqrt(34)')
    {
      const e = useCamStore.getState().activeSketch!.entities[0]
      expect(e.kind === 'ellipse' && e.minorRadius).toBe(3) // shorter axis fixed
    }
    expect(useCamStore.getState().activeSketch!.dimensions[0].value).toBe(10)

    // Degenerate edit: 2c = 0 is rejected LOUDLY; value + ellipse unchanged,
    // editor stays open for correction.
    useCamStore.getState().openDimensionEditor('dF')
    useCamStore.getState().commitDimensionValue('dF', 0)
    expect(useCamStore.getState().sketchNotice).toContain('greater than zero')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'dF', isNew: false })
    expect(useCamStore.getState().activeSketch!.dimensions[0].value).toBe(10) // reverted
    const e2 = useCamStore.getState().activeSketch!.entities[0]
    expect(e2.kind === 'ellipse' && Math.abs(e2.majorRadius - Math.sqrt(34)) < 1e-6).toBe(true)
  })

  it('CAM rejects non-positive arcLength input and never accepts typed values on a reference', async () => {
    const seam: SketchEntity = {
      id: 'seam', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5,
      startAngle: 3 * Math.PI / 2, endAngle: Math.PI / 2,
    }
    const dims: SketchDimension[] = [
      { id: 'arc-drive', kind: 'arcLength', entityId: seam.id,
        driving: true, value: 5 * Math.PI },
      { id: 'arc-ref', kind: 'arcLength', entityId: seam.id,
        driving: false, value: 1 },
    ]
    useCamStore.getState().setActiveSketch(makeSketch([seam], [], dims))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'arcLength open solve')

    useCamStore.getState().openDimensionEditor('arc-drive')
    useCamStore.getState().commitDimensionValue('arc-drive', 0)
    expect(useCamStore.getState().sketchNotice).toContain('arc length must be greater than zero')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'arc-drive', isNew: false })
    expect(useCamStore.getState().activeSketch!.dimensions[0].value).toBeCloseTo(5 * Math.PI, 12)

    useCamStore.getState().openDimensionEditor('arc-ref')
    const measured = useCamStore.getState().activeSketch!.dimensions[1].value
    useCamStore.getState().commitDimensionValue('arc-ref', 100)
    expect(useCamStore.getState().sketchNotice).toContain('is a reference')
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    expect(useCamStore.getState().activeSketch!.dimensions[1].value).toBe(measured)
    expect(measured).toBeCloseTo(5 * Math.PI, 12)
  })

  // ---- WO-1858: a chamfer setback pair DRIVES, in both halves ----------------
  //
  // Every test in this block used to assert the opposite (a BK-140 refusal on
  // typing, on the raw setter, on the forward toggle, and a forced
  // driving:false on three write paths). Those pins are retired with the rule
  // they pinned, not migrated around (ADR-0040).

  /** A real 90-degree chamfer rig the store can measure and drive: legs A and
   *  B, the chamfer line between them, the construction phantom pinned to
   *  both legs, and the four constraints chamferTool creates. The legs' own
   *  infinite lines are held (A's start fixed + horizontal, B's end fixed +
   *  vertical) so the only freedom left is where along each leg the cut
   *  lands. */
  function chamferRig(): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
    const chamfer: SketchLineEntity = {
      id: 'chamfer', kind: 'line', construction: false,
      start: { x: 7, y: 0 }, end: { x: 10, y: 3 }, chamferSetback: true,
    }
    return {
      entities: [
        line('A', 0, 0, 7, 0),
        line('B', 10, 3, 10, 10),
        chamfer,
        { id: 'phantom', kind: 'point', construction: true, at: { x: 10, y: 0 } },
      ],
      constraints: [
        { id: 'j1', kind: 'coincident', a: ref('chamfer', 'start'), b: ref('A', 'end') },
        { id: 'j2', kind: 'coincident', a: ref('chamfer', 'end'), b: ref('B', 'start') },
        { id: 'p1', kind: 'point_on_object', point: ref('phantom', 'self'), object: 'A' },
        { id: 'p2', kind: 'point_on_object', point: ref('phantom', 'self'), object: 'B' },
        { id: 'fa', kind: 'fix', point: ref('A', 'start') },
        { id: 'ha', kind: 'horizontal', line: 'A' },
        { id: 'fb', kind: 'fix', point: ref('B', 'end') },
        { id: 'vb', kind: 'vertical', line: 'B' },
      ],
    }
  }

  function setback(driving: boolean, value = 3, d2 = 3): SketchDimension {
    return { id: 'setback-pair', kind: 'd1xd2', entityId: 'chamfer', driving, value, d2 }
  }

  it('CAM accepts a typed value in EITHER half of a driving d1xd2', async () => {
    const rig = chamferRig()
    useCamStore.getState().setActiveSketch(makeSketch(rig.entities, rig.constraints, [setback(true)]))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'd1xd2 open solve')

    useCamStore.getState().openDimensionEditor('setback-pair')
    useCamStore.getState().commitDimensionValue('setback-pair', 4)
    expect(useCamStore.getState().activeSketch!.dimensions[0])
      .toMatchObject({ driving: true, value: 4, d2: 3 })
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'd1 solve')
    expect(useCamStore.getState().sketchNotice ?? '').not.toContain('rejected')

    // The geometry followed: the cut on leg A is now 4 from the corner at (10,0).
    const movedA = useCamStore.getState().activeSketch!.entities
      .find((e) => e.id === 'chamfer') as SketchLineEntity
    expect(movedA.start.x).toBeCloseTo(6, 6)

    useCamStore.getState().openDimensionEditor('setback-pair')
    useCamStore.getState().commitDimensionValue('setback-pair', 7, undefined, 'd2')
    expect(useCamStore.getState().activeSketch!.dimensions[0])
      .toMatchObject({ driving: true, value: 4, d2: 7 })
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'd2 solve')
    const movedB = useCamStore.getState().activeSketch!.entities
      .find((e) => e.id === 'chamfer') as SketchLineEntity
    expect(movedB.end.y).toBeCloseTo(7, 6)
  })

  it('CAM refuses a non-positive setback BY NAME and keeps the editor open (the one thing it cannot do)', async () => {
    const rig = chamferRig()
    useCamStore.getState().setActiveSketch(makeSketch(rig.entities, rig.constraints, [setback(true)]))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'd1xd2 open solve')

    useCamStore.getState().openDimensionEditor('setback-pair')
    useCamStore.getState().commitDimensionValue('setback-pair', 0)
    expect(useCamStore.getState().sketchNotice).toContain('setback D1 must be greater than zero')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'setback-pair', isNew: false })

    useCamStore.getState().commitDimensionValue('setback-pair', -1, undefined, 'd2')
    expect(useCamStore.getState().sketchNotice).toContain('setback D2 must be greater than zero')
    expect(useCamStore.getState().activeSketch!.dimensions[0])
      .toMatchObject({ value: 3, d2: 3 })
  })

  it('CAM setDimensionValue (the raw setter) writes a d1xd2 base value like any other kind', async () => {
    const rig = chamferRig()
    useCamStore.getState().setActiveSketch(makeSketch(rig.entities, rig.constraints, [setback(true)]))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'd1xd2 open solve')

    useCamStore.getState().setDimensionValue('setback-pair', 5)
    expect(useCamStore.getState().activeSketch!.dimensions[0])
      .toMatchObject({ value: 5, d2: 3, driving: true })
  })

  it('CAM camSketchDocumentPort.replace() keeps a DRIVING d1xd2 driving', async () => {
    const rig = chamferRig()
    useCamStore.getState().setActiveSketch(makeSketch(rig.entities, rig.constraints, []))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    const sk = useCamStore.getState().activeSketch!
    camSketchDocumentPort.replace({
      entities: sk.entities, constraints: sk.constraints,
      dimensions: [...sk.dimensions, setback(true, 4, 5)],
    })
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'setback-pair'))
      .toMatchObject({ driving: true, value: 4, d2: 5 })
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'replace solve settle')
  })

  it('CAM addDimension keeps a DRIVING d1xd2 driving (the direct-store INSERT path)', async () => {
    const rig = chamferRig()
    useCamStore.getState().setActiveSketch(makeSketch(rig.entities, rig.constraints, []))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().addDimension(setback(true, 4, 5))
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'setback-pair'))
      .toMatchObject({ driving: true, value: 4, d2: 5 })
  })

  it('CAM camSketchDocumentPort.append keeps a DRIVING d1xd2 driving', async () => {
    const rig = chamferRig()
    useCamStore.getState().setActiveSketch(makeSketch(rig.entities, rig.constraints, []))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    camSketchDocumentPort.append(
      { entities: [], constraints: [], dimensions: [setback(true, 4, 5)] }, [])
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'setback-pair'))
      .toMatchObject({ driving: true, value: 4, d2: 5 })
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'append solve settle')
  })

  it('CAM toggleDimensionDriving runs BOTH directions on a d1xd2', async () => {
    const rig = chamferRig()
    // Driving at stale values: toggling to reference must snap BOTH halves to
    // the measured pair, not leave the stale numbers on the label.
    useCamStore.getState().setActiveSketch(
      makeSketch(rig.entities, rig.constraints, [setback(true, 111, 222)]))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().toggleDimensionDriving('setback-pair')
    const asReference = useCamStore.getState().activeSketch!.dimensions[0]
    expect(asReference.driving).toBe(false)
    expect(asReference.value).toBeCloseTo(3, 6)
    expect((asReference as SketchDimension & { d2: number }).d2).toBeCloseTo(3, 6)

    // The FORWARD direction is ACCEPTED now -- no BK-140 refusal anywhere.
    useCamStore.getState().toggleDimensionDriving('setback-pair')
    expect(useCamStore.getState().activeSketch!.dimensions[0].driving).toBe(true)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'toggle verdict')
    expect(useCamStore.getState().activeSketch!.dimensions[0].driving).toBe(true)
    expect(useCamStore.getState().sketchNotice ?? '').not.toContain('BK-140')
  })
})

// ---- CAM-mounted DOM: the REAL camOverlaysPort/store commits on blur (WO UI-26-R1 finding 2) ---
//
// Every test above drives commitDimensionValue/openDimensionEditor directly against the store --
// none of them render a DOM input or dispatch a blur event. The audit's gap was exactly that: no
// test proved a CAM-mounted `.sketch-dim-input`'s real onBlur reaches this same store + solver.
// This renders `<SketcherOverlays port={camOverlaysPort}>` -- the actual production port CAM's
// Viewport hands the package -- against the same real-solver harness the rest of this file uses.

describe('CAM-mounted DOM: the dimension value editor commits on blur through the real camOverlaysPort/store', () => {
  it('a real DOM blur on a CAM-mounted .sketch-dim-input commits through the store + solver', async () => {
    useCamStore.getState().setActiveSketch(rect())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'sketch' } }))
    useCamStore.getState().openDimensionEditor('dw')

    const { container } = render(<SketcherOverlays port={camOverlaysPort} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement
    expect(input, 'the CAM-mounted editor must actually render for this to mean anything')
      .not.toBeNull()

    act(() => {
      fireEvent.change(input, { target: { value: '60' } })
      fireEvent.blur(input)
    })

    // commitDimensionValue writes the value + closes the editor synchronously, then posts the
    // verdict solve.
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => {
      const l1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1')
      return !!l1 && l1.kind === 'line' && Math.abs((l1.end.x - l1.start.x) - 60) < 1e-6
    }, 'CAM-mounted blur-commit solve (width 40 -> 60)')
    expect(useCamStore.getState().sketchSolveStatus!.dof).toBe(0)
  })

  // WO UI-26-R1 finding 1's regression, proved through the CAM-mounted DOM path this time (the
  // sketcherOverlays.test.tsx suite proves the same shape against a fake port): an unparseable
  // Enter must leave skipBlurCommitRef unarmed so the corrected value's own click-away still
  // commits, rather than being swallowed by a leftover flag.
  it('an unparseable Enter leaves the editor open; the corrected value commits on the next real blur', async () => {
    useCamStore.getState().setActiveSketch(rect())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'sketch' } }))
    useCamStore.getState().openDimensionEditor('dw')

    const { container } = render(<SketcherOverlays port={camOverlaysPort} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: 'abc' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(useCamStore.getState().sketchDimEditor).not.toBeNull()
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'dw')!.value)
      .toBe(40) // untouched

    act(() => {
      fireEvent.change(input, { target: { value: '55' } })
      fireEvent.blur(input)
    })
    await waitUntil(() => {
      const l1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1')
      return !!l1 && l1.kind === 'line' && Math.abs((l1.end.x - l1.start.x) - 55) < 1e-6
    }, 'corrected click-away solve (width 40 -> 55)')
  })

  // "sketch-dim equations wiring" hitlist item: the CAM half of the required parity render-gate
  // (the workbench half is workbenchSketchMount.test.tsx's matching describe block, same shape,
  // same assertions, through the real workbenchOverlaysPort + a real planegcs solver instead).
  it('typing "=60-10" into a real CAM-mounted .sketch-dim-input commits 50mm + the expression through the real camOverlaysPort/store/solver', async () => {
    useCamStore.getState().setActiveSketch(rect())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'sketch' } }))
    useCamStore.getState().openDimensionEditor('dw')

    const { container } = render(<SketcherOverlays port={camOverlaysPort} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement
    expect(input, 'the CAM-mounted editor must actually render for this to mean anything').not.toBeNull()

    act(() => {
      fireEvent.change(input, { target: { value: '=60-10' } })
      fireEvent.blur(input)
    })

    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => {
      const l1 = useCamStore.getState().activeSketch!.entities.find((e) => e.id === 'l1')
      return !!l1 && l1.kind === 'line' && Math.abs((l1.end.x - l1.start.x) - 50) < 1e-6
    }, 'CAM-mounted equation-commit solve (width 40 -> 50 via "=60-10")')
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'dw')!.expression)
      .toBe('=60-10')
  })

  it('a bad equation ("=1/0") on a real CAM-mounted DOM blur is refused fail-loud -- editor stays open, geometry untouched, typed error visible (ADR-0003)', async () => {
    useCamStore.getState().setActiveSketch(rect())
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.setState((s) => ({ viewer: { ...s.viewer, mode: 'sketch' } }))
    useCamStore.getState().openDimensionEditor('dw')

    const { container } = render(<SketcherOverlays port={camOverlaysPort} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: '=1/0' } })
      fireEvent.blur(input)
    })

    // Never a silent revert to the old value: the editor stays OPEN with the typed error visible.
    expect(useCamStore.getState().sketchDimEditor).not.toBeNull()
    expect(useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'dw')!.value).toBe(40)
    const err = container.querySelector('.sketch-dim-eq-preview-error')
    expect(err?.textContent).toMatch(/division by zero/i)
  })
})
