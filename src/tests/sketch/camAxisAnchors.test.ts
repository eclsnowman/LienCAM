// WO SKC-49 (Operator Q-35): CAM-host half of "origin and X/Y axes are first-class dimension pick
// targets". workbenchSketchOrigin.test.tsx's new A7 block covers the workbench host; this file
// covers the SAME acceptance list through CAM's real store (src/store/index.ts): setActiveSketch,
// camSketchDocumentPort.ensureSketch, bakeActiveSketch's strip + empty-after-strip semantics, the
// delete guard, and angle/distancePL dimensioning against an axis through the UNCHANGED
// planDimension branches -- proving CAM parity, not a re-implementation.

// WO SKC-49-R2 (audit MAJOR @ camAxisAnchors.test.ts:237): the solver-seam observation. Every
// SOLVE_SKETCH dispatch this worker sees, and every response it delivers, is recorded here so
// tests can assert a REAL dispatch was issued for the reopened sketch and a REAL response landed
// -- never inferred from a store-state reference change alone (setActiveSketch's synchronous
// restore of the JSON-round-tripped persisted solveStatus can flip that reference with zero
// worker traffic).
type RecordedDispatch = { type: 'SOLVE_SKETCH' | 'DRAG_SOLVE'; requestId: string; sketch: Sketch }
type RecordedResponse = { requestId: string; ok: boolean }
const solveDispatches: RecordedDispatch[] = []
const solveResponses: RecordedResponse[] = []

class LoopbackWorker {
  onmessage: ((e: { data: import('../../lib/sketch/solver/protocol').SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: import('../../lib/sketch/solver/protocol').SketchWorkerRequestMsg): void {
    solveDispatches.push({ type: msg.type, requestId: msg.payload.requestId, sketch: msg.payload.sketch })
    void (async () => {
      const { createGcsWrapper } = await import('../../lib/planegcs/planegcsLoader')
      const { solveSketchOnWrapper } = await import('../../lib/sketch/solver/gcsMapping')
      const wrapper = await ensureWrapper(createGcsWrapper)
      const { requestId, sketch } = msg.payload
      const out = msg.type === 'DRAG_SOLVE'
        ? solveSketchOnWrapper(wrapper, sketch, msg.payload.drag)
        : solveSketchOnWrapper(wrapper, sketch)
      const data = out.ok
        ? { type: 'SKETCH_SOLVE_COMPLETE' as const, requestId,
            entities: out.entities, status: out.status, computeTimeMs: 0 }
        : { type: 'SKETCH_SOLVE_FAILED' as const, requestId,
            reason: out.reason, message: out.message, status: out.status }
      solveResponses.push({ requestId, ok: out.ok })
      this.onmessage?.({ data })
    })()
  }
  terminate(): void {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapperPromise: Promise<any> | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureWrapper(createGcsWrapper: () => Promise<any>): Promise<any> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

vi.stubGlobal('Worker', LoopbackWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let camSketchDocumentPort: typeof import('../../store').camSketchDocumentPort
let SKETCH_ORIGIN_ENTITY_ID: string
let SKETCH_ORIGIN_FIX_ID: string
let SKETCH_AXIS_X_ENTITY_ID: string
let SKETCH_AXIS_X_FIX_ID: string
let SKETCH_AXIS_Y_ENTITY_ID: string
let SKETCH_AXIS_Y_FIX_ID: string
let SKETCH_INJECTED_ENTITY_IDS: ReadonlySet<string>
let planDimension: typeof import('../../lib/sketch/tools/dimTool').planDimension

beforeAll(async () => {
  ;({ useCamStore, camSketchDocumentPort } = await import('../../store'))
  ;({
    SKETCH_ORIGIN_ENTITY_ID, SKETCH_ORIGIN_FIX_ID,
    SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_X_FIX_ID,
    SKETCH_AXIS_Y_ENTITY_ID, SKETCH_AXIS_Y_FIX_ID,
    SKETCH_INJECTED_ENTITY_IDS,
  } = await import('../../lib/sketch/sketchAnchors'))
  ;({ planDimension } = await import('../../lib/sketch/tools/dimTool'))
})

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: { ...s.project, geometry: [] },
  }))
  solveDispatches.length = 0
  solveResponses.length = 0
})

function anchorIds(sketch: Sketch): string[] {
  return sketch.entities.filter((e) => SKETCH_INJECTED_ENTITY_IDS.has(e.id)).map((e) => e.id)
}
function userEntities(sketch: Sketch): SketchEntity[] {
  return sketch.entities.filter((e) => !SKETCH_INJECTED_ENTITY_IDS.has(e.id))
}

describe('CAM parity (WO SKC-49): setActiveSketch injects origin + both axes', () => {
  it('a fresh sketch-mode entry owns exactly the three anchors, fixed construction, at local (0,0)', () => {
    useCamStore.getState().setViewerMode('sketch')
    const sk = useCamStore.getState().activeSketch!
    expect(anchorIds(sk).sort()).toEqual(
      [SKETCH_ORIGIN_ENTITY_ID, SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_Y_ENTITY_ID].sort(),
    )
    expect(userEntities(sk)).toHaveLength(0)
    const origin = sk.entities.find((e) => e.id === SKETCH_ORIGIN_ENTITY_ID)!
    expect(origin.kind).toBe('point')
    expect(origin.construction).toBe(true)
    if (origin.kind === 'point') expect(origin.at).toEqual({ x: 0, y: 0 })
    const axisX = sk.entities.find((e) => e.id === SKETCH_AXIS_X_ENTITY_ID)!
    expect(axisX.kind).toBe('line')
    expect(axisX.construction).toBe(true)
    if (axisX.kind === 'line') {
      expect(axisX.start.y).toBe(0)
      expect(axisX.end.y).toBe(0)
    }
    expect(sk.constraints.map((c) => c.id).sort()).toEqual(
      [SKETCH_ORIGIN_FIX_ID, SKETCH_AXIS_X_FIX_ID, SKETCH_AXIS_Y_FIX_ID].sort(),
    )
  })

  it('camSketchDocumentPort.ensureSketch (the store-API bypass path) injects too', () => {
    // This deliberately does NOT go through setViewerMode/setActiveSketch -- it is the SECOND
    // real sketch-creation path the WO's preflight named (raw setState bypass), and per the WO's
    // own repro concern a session created here without injection fails Operator's ask silently.
    expect(useCamStore.getState().activeSketch).toBeNull()
    const sk = camSketchDocumentPort.ensureSketch()
    expect(sk).not.toBeNull()
    expect(anchorIds(sk!)).toHaveLength(3)
    expect(useCamStore.getState().activeSketch).not.toBeNull()
  })

  it('re-entry (setActiveSketch on an already-anchored sketch) is idempotent -- still exactly three', () => {
    useCamStore.getState().setViewerMode('sketch')
    const once = useCamStore.getState().activeSketch!
    useCamStore.getState().setActiveSketch(once)
    const twice = useCamStore.getState().activeSketch!
    expect(anchorIds(twice)).toHaveLength(3)
  })
})

describe('CAM parity: strip on persist, empty-after-strip semantics (acceptance 4b)', () => {
  it('an aborted EMPTY entry (draw nothing, exit) leaves zero junk -- no leftover layer', () => {
    useCamStore.getState().setViewerMode('sketch')
    expect(useCamStore.getState().project.geometry.length).toBeGreaterThan(0)
    // Three anchors are present but the user drew nothing -- entities.length is never 0 anymore,
    // so this proves the empty guard is EMPTY-AFTER-STRIP, not raw entities.length.
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(3)
    useCamStore.getState().setViewerMode('setup')
    expect(useCamStore.getState().activeSketch).toBeNull()
    expect(useCamStore.getState().project.geometry).toHaveLength(0) // container removed, no junk
  })

  it('a NON-empty bake strips all three anchors from the persisted document at both write branches', () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'u1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    })
    useCamStore.getState().addEntity({
      id: 'u2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 },
    })
    useCamStore.getState().addEntity({
      id: 'u3', kind: 'line', construction: false, start: { x: 10, y: 10 }, end: { x: 0, y: 10 },
    })
    useCamStore.getState().addEntity({
      id: 'u4', kind: 'line', construction: false, start: { x: 0, y: 10 }, end: { x: 0, y: 0 },
    })
    const layerId = useCamStore.getState().activeSketch!.layerId
    useCamStore.getState().finishSketch() // bakedEntities > 0 branch (the :6714-equivalent write)
    const geo = useCamStore.getState().project.geometry.find(
      (g) => g.layers2d?.some((l) => l.id === layerId),
    )!
    const stored = geo.sketches!.find((sk) => sk.layerId === layerId)!
    expect(anchorIds(stored)).toHaveLength(0)
    expect(userEntities(stored)).toHaveLength(4)
  })

  it('a bake with ONLY construction/point geometry (bakedEntities === 0) still strips the anchors', () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({ id: 'p1', kind: 'point', construction: false, at: { x: 5, y: 5 } })
    const layerId = useCamStore.getState().activeSketch!.layerId
    useCamStore.getState().finishSketch() // bakedEntities === 0 branch (the :6678-equivalent write)
    const geo = useCamStore.getState().project.geometry.find(
      (g) => g.layers2d?.some((l) => l.id === layerId),
    )!
    const stored = geo.sketches!.find((sk) => sk.layerId === layerId)!
    expect(anchorIds(stored)).toHaveLength(0)
    expect(userEntities(stored)).toHaveLength(1)
  })
})

describe('CAM parity: delete guard protects both axes alongside the origin', () => {
  it('refuses an anchor-only selection by name and excludes anchors from a mixed delete', () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'u1', kind: 'point', construction: false, at: { x: 3, y: 3 },
    })
    useCamStore.getState().setSketchSelection([SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_Y_ENTITY_ID])
    useCamStore.getState().deleteSketchSelection()
    expect(useCamStore.getState().activeSketch!.entities).toHaveLength(4) // 3 anchors + u1, untouched
    expect(useCamStore.getState().sketchNotice).toBe('Origin/axis anchors cannot be deleted.')

    useCamStore.getState().setSketchSelection([SKETCH_AXIS_X_ENTITY_ID, 'u1'])
    useCamStore.getState().deleteSketchSelection()
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.id === 'u1')).toBe(false)
    expect(useCamStore.getState().activeSketch!.entities.some((e) => e.id === SKETCH_AXIS_X_ENTITY_ID)).toBe(true)
    expect(useCamStore.getState().sketchNotice).toBe('Origin/axis anchors were excluded from Delete.')
  })
})

describe('CAM parity: angle/distancePL against an axis flow through the UNCHANGED planDimension branches', () => {
  it('angle dimension against the X axis and the Y axis, order-independent', () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'user-line', kind: 'line', construction: false,
      start: { x: 2, y: 2 }, end: { x: 9, y: 5 },
    })
    const entities = useCamStore.getState().activeSketch!.entities
    const angleX = planDimension(entities, ['user-line', SKETCH_AXIS_X_ENTITY_ID])
    const angleXReordered = planDimension(entities, [SKETCH_AXIS_X_ENTITY_ID, 'user-line'])
    const angleY = planDimension(entities, ['user-line', SKETCH_AXIS_Y_ENTITY_ID])
    expect(angleX.ok && angleX.plan.kind).toBe('angle')
    expect(angleXReordered.ok && angleXReordered.plan.kind).toBe('angle')
    expect(angleY.ok && angleY.plan.kind).toBe('angle')
  })

  it('distancePL from a point to an axis, order-independent', () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'user-pt', kind: 'point', construction: false, at: { x: 4, y: 11 },
    })
    const entities = useCamStore.getState().activeSketch!.entities
    const plan = planDimension(entities, ['user-pt', SKETCH_AXIS_X_ENTITY_ID])
    expect(plan.ok).toBe(true)
    if (plan.ok && plan.plan.kind === 'distancePL') {
      expect(plan.plan.line).toBe(SKETCH_AXIS_X_ENTITY_ID)
      expect(plan.plan.value).toBeCloseTo(11, 9)
    } else {
      throw new Error('expected a distancePL plan')
    }
  })
})

// WO SKC-49-R2 (audit MAJOR): the solver-seam observation, replacing the old status-reference-only
// `waitForNewSolve`. That proxy captured `staleStatus` before the reopen and resolved as soon as
// `sketchSolveStatus !== staleStatus` -- but setActiveSketch synchronously restores the
// JSON-round-tripped persisted solveStatus into state BEFORE any worker response, so the reference
// changes on reopen alone, with zero solver traffic. Two axis-only tests stayed GREEN when the
// dimension-only open-solve dispatch (store/index.ts:6621) was reverted to entities-only -- an
// UNSATISFIABLE-by-restore proof requires observing the LoopbackWorker directly:
//   1. a SOLVE_SKETCH dispatch, issued AFTER `dispatchesBefore`, whose payload sketch is the
//      REOPENED one (matched by layerId AND the presence of the axis dimension under test --
//      never a bare dispatch-count increment, which a coincidental unrelated dispatch satisfies);
//   2. that dispatch's requestId has actually received a solved (non-throw) response.
// Only then does the caller read `sketchSolveStatus` for the clean-solve assertions.
async function waitForCorrelatedSolve(
  dispatchesBefore: number,
  matchSketch: (sketch: Sketch) => boolean,
): Promise<void> {
  const t0 = Date.now()
  const correlated = await new Promise<RecordedDispatch>((resolve, reject) => {
    const poll = () => {
      const match = solveDispatches
        .slice(dispatchesBefore)
        .find((d) => d.type === 'SOLVE_SKETCH' && matchSketch(d.sketch))
      if (match) return resolve(match)
      if (Date.now() - t0 > 10000) {
        return reject(new Error('timeout: no correlated SOLVE_SKETCH dispatch was issued for the reopened sketch'))
      }
      setTimeout(poll, 10)
    }
    poll()
  })
  await new Promise<void>((resolve, reject) => {
    const poll = () => {
      const response = solveResponses.find((r) => r.requestId === correlated.requestId)
      if (response) {
        if (!response.ok) return reject(new Error('correlated SOLVE_SKETCH dispatch resolved as a failed solve'))
        return resolve()
      }
      if (Date.now() - t0 > 10000) {
        return reject(new Error('timeout waiting for the correlated dispatch\'s solve response'))
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('CAM parity: save -> reload -> reopen -> solve round trip against an axis-referencing dimension', () => {
  it('R1: committed BOTH an angle dim (vs X axis) AND a distancePL dim (vs Y axis) survive strip + JSON round trip and re-solve clean', async () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'user-line', kind: 'line', construction: false,
      start: { x: 1, y: 1 }, end: { x: 6, y: 1 },
    })
    useCamStore.getState().addEntity({
      id: 'user-pt', kind: 'point', construction: false, at: { x: 4, y: 11 },
    })
    useCamStore.getState().addDimension({
      id: 'angle-vs-x-axis', kind: 'angle', driving: true, value: 0,
      a: 'user-line', b: SKETCH_AXIS_X_ENTITY_ID,
    })
    useCamStore.getState().addDimension({
      id: 'distancePL-vs-y-axis', kind: 'distancePL', driving: true, value: 4,
      point: { entityId: 'user-pt', site: 'self' }, line: SKETCH_AXIS_Y_ENTITY_ID,
    })
    const layerId = useCamStore.getState().activeSketch!.layerId
    useCamStore.getState().finishSketch()

    const geoBefore = useCamStore.getState().project.geometry.find(
      (g) => g.layers2d?.some((l) => l.id === layerId),
    )!
    const storedBefore = geoBefore.sketches!.find((sk) => sk.layerId === layerId)!
    expect(anchorIds(storedBefore)).toHaveLength(0) // strip proven again, defense in depth
    expect(storedBefore.dimensions).toContainEqual(expect.objectContaining({
      id: 'angle-vs-x-axis', a: 'user-line', b: SKETCH_AXIS_X_ENTITY_ID,
    }))
    expect(storedBefore.dimensions).toContainEqual(expect.objectContaining({
      id: 'distancePL-vs-y-axis', line: SKETCH_AXIS_Y_ENTITY_ID,
    }))

    // Serialize to JSON and back -- proves the round trip survives a REAL save/load boundary,
    // not just an in-memory reference.
    const roundTripped: Sketch = JSON.parse(JSON.stringify(storedBefore))

    // Reopen: re-inject anchors on this entry path too (openSketchForLayer -> setActiveSketch).
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) =>
          g.id === geoBefore.id
            ? { ...g, sketches: [{ ...roundTripped }] }
            : g),
      },
    }))
    const dispatchesBefore = solveDispatches.length
    const ok = useCamStore.getState().openSketchForLayer(layerId)
    expect(ok).toBe(true)
    const reopened = useCamStore.getState().activeSketch!
    expect(anchorIds(reopened)).toHaveLength(3) // re-injected before the open-solve saw it
    expect(reopened.dimensions.find((d) => d.id === 'angle-vs-x-axis'))
      .toMatchObject({ a: 'user-line', b: SKETCH_AXIS_X_ENTITY_ID })
    expect(reopened.dimensions.find((d) => d.id === 'distancePL-vs-y-axis'))
      .toMatchObject({ line: SKETCH_AXIS_Y_ENTITY_ID })

    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && sketch.dimensions.some((d) => d.id === 'angle-vs-x-axis')
      && sketch.dimensions.some((d) => d.id === 'distancePL-vs-y-axis'))
    const finalStatus = useCamStore.getState().sketchSolveStatus!
    expect(finalStatus.solveFailed).toBeUndefined()
    expect(finalStatus.conflicting).toEqual([])
  })

  it('R1: ensureSketch (the store-API bypass path) as its OWN round-trip leg -- commit, strip, JSON round trip, reopen, re-solve clean', async () => {
    // Deliberately does NOT go through setViewerMode/setActiveSketch -- this is the SECOND real
    // sketch-creation path the WO's preflight named, and finding [1] named it as an untested bypass
    // leg for the round-trip proof specifically (not just anchor injection).
    expect(useCamStore.getState().activeSketch).toBeNull()
    const created = camSketchDocumentPort.ensureSketch()!
    expect(anchorIds(created)).toHaveLength(3)

    useCamStore.getState().addEntity({
      id: 'user-line-2', kind: 'line', construction: false,
      start: { x: 2, y: 2 }, end: { x: 9, y: 2 },
    })
    useCamStore.getState().addDimension({
      id: 'angle-vs-y-axis-2', kind: 'angle', driving: true, value: 0,
      a: 'user-line-2', b: SKETCH_AXIS_Y_ENTITY_ID,
    })
    const layerId = useCamStore.getState().activeSketch!.layerId
    useCamStore.getState().finishSketch()

    const geoBefore = useCamStore.getState().project.geometry.find(
      (g) => g.layers2d?.some((l) => l.id === layerId),
    )!
    const storedBefore = geoBefore.sketches!.find((sk) => sk.layerId === layerId)!
    expect(anchorIds(storedBefore)).toHaveLength(0)
    const roundTripped: Sketch = JSON.parse(JSON.stringify(storedBefore))
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) =>
          g.id === geoBefore.id ? { ...g, sketches: [{ ...roundTripped }] } : g),
      },
    }))
    const dispatchesBefore = solveDispatches.length
    expect(useCamStore.getState().openSketchForLayer(layerId)).toBe(true)
    const reopened = useCamStore.getState().activeSketch!
    expect(anchorIds(reopened)).toHaveLength(3)
    expect(reopened.dimensions.find((d) => d.id === 'angle-vs-y-axis-2'))
      .toMatchObject({ a: 'user-line-2', b: SKETCH_AXIS_Y_ENTITY_ID })

    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && sketch.dimensions.some((d) => d.id === 'angle-vs-y-axis-2'))
    const finalStatus = useCamStore.getState().sketchSolveStatus!
    expect(finalStatus.solveFailed).toBeUndefined()
    expect(finalStatus.conflicting).toEqual([])
  })
})

describe('CAM parity: Finish/reopen regression for finding [0] -- AXIS-ONLY content (zero user entities) must SURVIVE', () => {
  it('a lone-axis distance dim with NO user entities survives Finish (not silently discarded) and re-solves clean on reopen', async () => {
    useCamStore.getState().setViewerMode('sketch')
    const entities = useCamStore.getState().activeSketch!.entities
    const plan = planDimension(entities, [SKETCH_AXIS_X_ENTITY_ID])
    if (!plan.ok || plan.plan.kind !== 'distance') throw new Error('expected a lone-axis distance plan')
    useCamStore.getState().addDimension({
      id: 'lone-axis-dim', kind: 'distance', driving: true,
      value: plan.plan.value, a: plan.plan.a, b: plan.plan.b,
    })
    const layerId = useCamStore.getState().activeSketch!.layerId
    expect(userEntities(useCamStore.getState().activeSketch!)).toHaveLength(0) // genuinely zero user entities

    useCamStore.getState().finishSketch()

    // BLOCKER regression: before the R1 fix, bakeActiveSketch's stripped.entities.length===0 gate
    // returned WITHOUT storing anything, and setViewerMode's aborted-entry branch (same raw gate)
    // then deleted the auto-created layer entirely -- the dimension vanished with no trace and no
    // notice. Prove it survived: the layer/document exist and carry the dimension.
    const geo = useCamStore.getState().project.geometry.find(
      (g) => g.layers2d?.some((l) => l.id === layerId),
    )
    expect(geo).not.toBeUndefined()
    const stored = geo!.sketches?.find((sk) => sk.layerId === layerId)
    expect(stored).not.toBeUndefined()
    expect(anchorIds(stored!)).toHaveLength(0)
    expect(stored!.dimensions).toContainEqual(expect.objectContaining({ id: 'lone-axis-dim' }))

    const roundTripped: Sketch = JSON.parse(JSON.stringify(stored!))
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) =>
          g.id === geo!.id ? { ...g, sketches: [{ ...roundTripped }] } : g),
      },
    }))
    const dispatchesBefore = solveDispatches.length
    expect(useCamStore.getState().openSketchForLayer(layerId)).toBe(true)
    const reopened = useCamStore.getState().activeSketch!
    expect(anchorIds(reopened)).toHaveLength(3)
    expect(reopened.dimensions.find((d) => d.id === 'lone-axis-dim')).not.toBeUndefined()

    // WO SKC-49-R2 mutation target: this correlated match is UNSATISFIABLE if
    // store/index.ts:6621 is reverted to entities-only (stripped entities.length > 0) -- a
    // dimension-only reopen (zero stripped entities) then dispatches no SOLVE_SKETCH at all, so
    // no dispatch in `solveDispatches` will ever carry this sketch's 'lone-axis-dim'.
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && sketch.dimensions.some((d) => d.id === 'lone-axis-dim'))
    const finalStatus = useCamStore.getState().sketchSolveStatus!
    expect(finalStatus.solveFailed).toBeUndefined()
    expect(finalStatus.conflicting).toEqual([])
  })

  it('an X+Y axis-vs-axis angle dim with NO user entities survives Finish and re-solves clean on reopen', async () => {
    useCamStore.getState().setViewerMode('sketch')
    const entities = useCamStore.getState().activeSketch!.entities
    const plan = planDimension(entities, [SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_Y_ENTITY_ID])
    if (!plan.ok || plan.plan.kind !== 'angle') throw new Error('expected an axis-vs-axis angle plan')
    useCamStore.getState().addDimension({
      id: 'axis-vs-axis-angle', kind: 'angle', driving: true,
      value: plan.plan.value, a: plan.plan.a, b: plan.plan.b,
    })
    const layerId = useCamStore.getState().activeSketch!.layerId
    expect(userEntities(useCamStore.getState().activeSketch!)).toHaveLength(0)

    useCamStore.getState().finishSketch()

    const geo = useCamStore.getState().project.geometry.find(
      (g) => g.layers2d?.some((l) => l.id === layerId),
    )
    expect(geo).not.toBeUndefined()
    const stored = geo!.sketches?.find((sk) => sk.layerId === layerId)
    expect(stored).not.toBeUndefined()
    expect(anchorIds(stored!)).toHaveLength(0)
    expect(stored!.dimensions).toContainEqual(expect.objectContaining({ id: 'axis-vs-axis-angle' }))

    const roundTripped: Sketch = JSON.parse(JSON.stringify(stored!))
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) =>
          g.id === geo!.id ? { ...g, sketches: [{ ...roundTripped }] } : g),
      },
    }))
    const dispatchesBefore = solveDispatches.length
    expect(useCamStore.getState().openSketchForLayer(layerId)).toBe(true)
    const reopened = useCamStore.getState().activeSketch!
    expect(anchorIds(reopened)).toHaveLength(3)
    expect(reopened.dimensions.find((d) => d.id === 'axis-vs-axis-angle')).not.toBeUndefined()

    // WO SKC-49-R2 mutation target: same as the lone-axis-dim test above -- unsatisfiable if
    // store/index.ts:6621 is reverted to entities-only.
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && sketch.dimensions.some((d) => d.id === 'axis-vs-axis-angle'))
    const finalStatus = useCamStore.getState().sketchSolveStatus!
    expect(finalStatus.solveFailed).toBeUndefined()
    expect(finalStatus.conflicting).toEqual([])
  })

  it('an aborted entry (draw nothing, no dimension either) is STILL cleaned up as genuinely empty -- the fix does not break the true-empty path', () => {
    useCamStore.getState().setViewerMode('sketch')
    expect(useCamStore.getState().project.geometry.length).toBeGreaterThan(0)
    useCamStore.getState().setViewerMode('setup')
    expect(useCamStore.getState().activeSketch).toBeNull()
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
  })
})

// WO SKC-56/SKC-58B: both-host smoke (deliverable 6) -- CAM half. Real store, real LoopbackWorker
// (real planegcs solve), the solver-seam observation per P7's ruling.
//
// SKC-58B reverses SKC-56's far-sector MOTION convention (Operator's 2026-07-17 hands-on ruling): a
// dimension whose ENTERED value equals the MEASURED value is a NO-MOTION constraint. Dragging a
// committed 47deg angle dim's label into the far sector reads the obtuse 133deg magnitude, which
// ALREADY describes the current geometry, so the commit must not move the line. The stored value is
// the SIGNED reversed-operand far value (-133deg, reverseB=true); the label magnitude stays 133; the
// real geometry stays at the drawn +47.
//
// Directed angle l1->l2 (planegcs l2l_angle convention, atan2(cross,dot)): the quantity that must
// NOT change for a no-motion commit.
function directedDeg(l1: SketchEntity, l2: SketchEntity): number {
  if (l1.kind !== 'line' || l2.kind !== 'line') throw new Error('expected both entities to be lines')
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI
}
function lineEndOf(sketch: Sketch, id: string): { x: number; y: number } {
  const e = sketch.entities.find((x) => x.id === id)!
  if (e.kind !== 'line') throw new Error(`expected ${id} to remain a line`)
  return { x: e.end.x, y: e.end.y }
}
function anchorDeg(alphaDeg: number, r = 5): { x: number; y: number } {
  return { x: r * Math.cos((alphaDeg * Math.PI) / 180), y: r * Math.sin((alphaDeg * Math.PI) / 180) }
}

describe('SKC-58B both-host smoke: CAM angle dim through the real store', () => {
  it('committed 47deg angle dim label-dragged into the far sector stores value=-133/reverseB=true, label magnitude=133, geometry stays +47 with ZERO motion', async () => {
    useCamStore.getState().setViewerMode('sketch')
    const thetaDeg = 47
    const thetaRad = (thetaDeg * Math.PI) / 180
    useCamStore.getState().addEntity({
      id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    })
    useCamStore.getState().addEntity({
      id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
      end: { x: 10 * Math.cos(thetaRad), y: 10 * Math.sin(thetaRad) },
    })
    useCamStore.getState().addConstraint({ id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } })
    useCamStore.getState().addConstraint({ id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } })
    useCamStore.getState().addConstraint({ id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } })
    useCamStore.getState().addDimension({
      id: 'len', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'l2', site: 'start' }, b: { entityId: 'l2', site: 'end' },
    })
    useCamStore.getState().addDimension({
      id: 'ang', kind: 'angle', driving: true, value: thetaRad, a: 'l1', b: 'l2',
      labelAnchor: anchorDeg(23),
    })
    // The line as drawn (the initial +47 near dim is itself no-motion) -- the endpoint that must not
    // move when the label crosses into the far sector.
    const beforeEnd = { x: 10 * Math.cos(thetaRad), y: 10 * Math.sin(thetaRad) }

    const dispatchesBefore = solveDispatches.length
    const layerId = useCamStore.getState().activeSketch!.layerId
    // Drag the label from the I1 (near, 0..47deg) sector into I2 (far, 47..180deg).
    useCamStore.getState().updateDimensionLabel('ang', anchorDeg(113))

    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId && sketch.dimensions.some((d) => d.id === 'ang'))
    const solved = useCamStore.getState().activeSketch!
    const dim = solved.dimensions.find((d) => d.id === 'ang')!
    expect(dim.kind).toBe('angle')
    // Stored value is the SIGNED reversed-operand far value, orientation flag set.
    expect((dim.value * 180) / Math.PI).toBeCloseTo(-(180 - thetaDeg), 3) // -133
    expect((dim as typeof dim & { reverseB?: boolean }).reverseB).toBe(true)
    // Label magnitude is the obtuse sweep (133) -- what the user sees.
    expect(Math.abs((dim.value * 180) / Math.PI)).toBeCloseTo(180 - thetaDeg, 3)
    // The REAL geometry did not move: directed angle stays +47, endpoint unchanged.
    const l1 = solved.entities.find((e) => e.id === 'l1')!
    const l2 = solved.entities.find((e) => e.id === 'l2')!
    expect(directedDeg(l1, l2)).toBeCloseTo(thetaDeg, 3)
    const afterEnd = lineEndOf(solved, 'l2')
    const moved = Math.hypot(afterEnd.x - beforeEnd.x, afterEnd.y - beforeEnd.y)
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][CAM-SMOKE] storedDeg=${((dim.value * 180) / Math.PI).toFixed(4)} ` +
      `reverseB=${(dim as typeof dim & { reverseB?: boolean }).reverseB} ` +
      `measuredDeg=${directedDeg(l1, l2).toFixed(4)} endDeltaMm=${moved.toFixed(6)}`)
    expect(moved).toBeLessThan(1e-6) // NO MOTION -- Operator's bar
    expect(useCamStore.getState().sketchSolveStatus!.solveFailed).toBeUndefined()
  })

  // ---- SKC-58B-R1 Blocker 1: a REFERENCE angle dim must remeasure its signed value AND reverseB
  // ATOMICALLY. When other constraints move the lines so its fixed label crosses the far->near
  // boundary, a stale reverseB would make re-enabling driving flip the geometry 180deg. Real store,
  // real solve, the exact auditor construction (far ref {-145,reverseB:true,label@100} -> move
  // geometry to +120 near -> toggle driving -> ZERO motion). ----
  it('a reference angle dim whose lines move across the near/far boundary re-derives value+reverseB atomically; toggling it driving is NO motion (Blocker 1)', async () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    })
    useCamStore.getState().addEntity({
      id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
      end: { x: 10 * Math.cos((35 * Math.PI) / 180), y: 10 * Math.sin((35 * Math.PI) / 180) },
    })
    useCamStore.getState().addConstraint({ id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } })
    useCamStore.getState().addConstraint({ id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } })
    useCamStore.getState().addConstraint({ id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } })
    useCamStore.getState().addDimension({
      id: 'len', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'l2', site: 'start' }, b: { entityId: 'l2', site: 'end' },
    })
    // DRIVING angle dim controls l2's rotation; REFERENCE angle dim (display-only) tracks the same
    // pair through a FIXED far-sector label.
    useCamStore.getState().addDimension({
      id: 'drive', kind: 'angle', driving: true, value: (35 * Math.PI) / 180, a: 'l1', b: 'l2',
      labelAnchor: anchorDeg(17),
    })
    useCamStore.getState().addDimension({
      id: 'ref', kind: 'angle', driving: false, value: 0, a: 'l1', b: 'l2', labelAnchor: anchorDeg(100),
    })

    const layerId = useCamStore.getState().activeSketch!.layerId
    // Solve once at +35: the far label (@100) makes ref remeasure to the signed far value.
    let dispatchesBefore = solveDispatches.length
    useCamStore.getState().commitDimensionValue('drive', (35 * Math.PI) / 180)
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId && sketch.dimensions.some((d) => d.id === 'ref'))
    const refFar = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ref')!
    expect((refFar.value * 180) / Math.PI).toBeCloseTo(-145, 2) // far: 35-180
    expect((refFar as typeof refFar & { reverseB?: boolean }).reverseB).toBe(true)

    // Move the geometry to +120 via the DRIVING dim: the ref's fixed @100 label is now NEAR.
    dispatchesBefore = solveDispatches.length
    useCamStore.getState().commitDimensionValue('drive', (120 * Math.PI) / 180)
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && (sketch.dimensions.find((d) => d.id === 'drive')?.value ?? 0) > (119 * Math.PI) / 180)
    const refNear = useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === 'ref')!
    // ATOMIC remeasure: value AND reverseB both updated to the near classification.
    expect((refNear.value * 180) / Math.PI).toBeCloseTo(120, 2)
    expect((refNear as typeof refNear & { reverseB?: boolean }).reverseB).toBe(false)
    const geomBefore = lineEndOf(useCamStore.getState().activeSketch!, 'l2')

    // Hand the constraint off to the reference dim: drop 'drive' to reference (l2 is momentarily held
    // at +120 by its fixed start + pinned length), then toggle the (now-near) 'ref' dim to driving.
    // It equals the measured value, so ZERO motion. With a STALE reverseB=true 'ref' would map
    // l2l_angle_pppp(+120) and flip l2 to -60deg.
    dispatchesBefore = solveDispatches.length
    useCamStore.getState().toggleDimensionDriving('drive')
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId && !(sketch.dimensions.find((d) => d.id === 'drive')?.driving ?? true))
    dispatchesBefore = solveDispatches.length
    useCamStore.getState().toggleDimensionDriving('ref')
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId && (sketch.dimensions.find((d) => d.id === 'ref')?.driving ?? false))
    const after = useCamStore.getState().activeSketch!
    const geomAfter = lineEndOf(after, 'l2')
    const moved = Math.hypot(geomAfter.x - geomBefore.x, geomAfter.y - geomBefore.y)
    const l1 = after.entities.find((e) => e.id === 'l1')!
    const l2 = after.entities.find((e) => e.id === 'l2')!
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][CAM-REF-REMEASURE] refValueDeg=${((refNear.value * 180) / Math.PI).toFixed(2)} ` +
      `reverseB=${(refNear as typeof refNear & { reverseB?: boolean }).reverseB} ` +
      `measuredDeg=${directedDeg(l1, l2).toFixed(4)} endDeltaMm=${moved.toFixed(6)}`)
    expect(moved).toBeLessThan(1e-6) // NO MOTION when re-enabling driving
    expect(directedDeg(l1, l2)).toBeCloseTo(120, 3) // still +120, no 180 flip
    const status = useCamStore.getState().sketchSolveStatus!
    expect(status.solveFailed).toBeUndefined()
    expect(status.conflicting).toEqual([])
  })

  // ---- SKC-58B-R1 Minor (skc58AngleDimNoMotion.test.ts:223): the edit-after-commit acceptance must
  // run through the REAL host numeric-edit flow (commitDimensionValue), not a fresh-sketch solver
  // fixture. Commit the far dim, edit its value through the store (reverseB must survive), carry the
  // solved geometry forward, and re-enter the current measured signed value -> the second solve is
  // no-motion. ----
  it('real-host edit-after-commit: commitDimensionValue on the committed far dim survives reverseB, drives on a new value, and is no-motion re-entering the measured value (Minor)', async () => {
    useCamStore.getState().setViewerMode('sketch')
    useCamStore.getState().addEntity({
      id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    })
    useCamStore.getState().addEntity({
      id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
      end: { x: 10 * Math.cos((35 * Math.PI) / 180), y: 10 * Math.sin((35 * Math.PI) / 180) },
    })
    useCamStore.getState().addConstraint({ id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } })
    useCamStore.getState().addConstraint({ id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } })
    useCamStore.getState().addConstraint({ id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } })
    // Pin l2's length so the ONLY freedom is its rotation about the origin (the angle dim governs it).
    useCamStore.getState().addDimension({
      id: 'len', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'l2', site: 'start' }, b: { entityId: 'l2', site: 'end' },
    })
    // Commit the FAR dim directly (value=-145 signed, reverseB=true) -- as a far label-drag stores it.
    useCamStore.getState().addDimension({
      id: 'ang', kind: 'angle', driving: true, value: (-145 * Math.PI) / 180, a: 'l1', b: 'l2',
      reverseB: true, labelAnchor: anchorDeg(100),
    })

    const layerId = useCamStore.getState().activeSketch!.layerId
    // (a) commit the measured far value -> no motion (geometry stays at +35).
    let dispatchesBefore = solveDispatches.length
    useCamStore.getState().commitDimensionValue('ang', (-145 * Math.PI) / 180)
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId && sketch.dimensions.some((d) => d.id === 'ang'))
    let sk = useCamStore.getState().activeSketch!
    expect(directedDeg(sk.entities.find((e) => e.id === 'l1')!, sk.entities.find((e) => e.id === 'l2')!))
      .toBeCloseTo(35, 3)
    const solved0End = lineEndOf(sk, 'l2')

    // (b) REAL host numeric edit to a DIFFERENT value (-120) -> geometry drives; reverseB survives.
    dispatchesBefore = solveDispatches.length
    useCamStore.getState().commitDimensionValue('ang', (-120 * Math.PI) / 180)
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId
      && Math.abs((sketch.dimensions.find((d) => d.id === 'ang')?.value ?? 0) - (-120 * Math.PI) / 180) < 1e-9)
    sk = useCamStore.getState().activeSketch!
    const angEdited = sk.dimensions.find((d) => d.id === 'ang')!
    expect((angEdited as typeof angEdited & { reverseB?: boolean }).reverseB).toBe(true) // survived the edit
    const l1b = sk.entities.find((e) => e.id === 'l1')!
    const l2b = sk.entities.find((e) => e.id === 'l2')!
    // Reversed-operand -120 => directed(l1,l2) = -120+180 = +60 (obtuse 120, upper side).
    expect(directedDeg(l1b, l2b)).toBeCloseTo(60, 2)
    const editMoved = Math.hypot(lineEndOf(sk, 'l2').x - solved0End.x, lineEndOf(sk, 'l2').y - solved0End.y)
    expect(editMoved).toBeGreaterThan(1) // it genuinely drives

    // (c) carry the solved geometry forward and re-enter the CURRENT measured signed value (-120) ->
    // the second solve is no-motion.
    const carriedEnd = lineEndOf(sk, 'l2')
    dispatchesBefore = solveDispatches.length
    useCamStore.getState().commitDimensionValue('ang', (-120 * Math.PI) / 180)
    await waitForCorrelatedSolve(dispatchesBefore, (sketch) =>
      sketch.layerId === layerId && sketch.dimensions.some((d) => d.id === 'ang'))
    sk = useCamStore.getState().activeSketch!
    const reEnterMoved = Math.hypot(lineEndOf(sk, 'l2').x - carriedEnd.x, lineEndOf(sk, 'l2').y - carriedEnd.y)
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][CAM-EDIT-AFTER-COMMIT] editMovedMm=${editMoved.toFixed(6)} ` +
      `reEnterMovedMm=${reEnterMoved.toFixed(6)} ` +
      `reverseBSurvived=${(angEdited as typeof angEdited & { reverseB?: boolean }).reverseB}`)
    expect(reEnterMoved).toBeLessThan(1e-6) // re-entering the measured value is no-motion
    expect(useCamStore.getState().sketchSolveStatus!.solveFailed).toBeUndefined()
  })
})
