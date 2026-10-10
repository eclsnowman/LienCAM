// @vitest-environment jsdom
//
// WO-1867: ordinate (baseline) dimensions measured from ONE chosen origin.
//
// A hole pattern on a plate is dimensioned from one datum, not chained. The
// proofs here are behavioural and run against the REAL planegcs solver, never
// against a hand-inspected primitive list:
//   - the tool gesture (pick a datum, Tab, then click each hole) produces the
//     stack, with values equal to the true offsets from that corner
//   - typing into one ordinate moves ITS hole and leaves the others
//   - each driving ordinate is worth exactly one degree of freedom
//   - moving the DATUM carries every driven hole with it in ONE solve, values
//     unchanged, while reference ordinates re-measure in that same solve
//   - the labels land on the stack's ONE common witness line
//
// FIXTURE (the acceptance's "plate with a left edge and four holes"): a
// vertical left edge from (0,0) to (0,60) whose START is the lower-left corner,
// and four holes of r3 at (20,15), (40,15), (20,45), (40,45). The corner is
// FIXED (it is the datum a drawing measures from) and the edge is vertical; the
// holes are otherwise free, which is what leaves each of them two freedoms for
// a pair of ordinates to take away.

import { describe, it, expect, vi } from 'vitest'
import {
  dimToolClick, cycleDimForceMode, dimForceFamily, measureDimension,
  formatDimensionValue, dimModeLabel, remeasureReferenceDimensions,
  ordinatePointRef, ordinateForceAxis, dimPreview, type DimChainState,
} from '../../lib/sketch/tools/dimTool'
import {
  ordinateStackAnchor, ORDINATE_STACK_OFFSET_MM, dimGuides, resolveDimPlacement,
} from '../../lib/sketch/tools/dimPlacement'
import { cycleDimForce } from '../../lib/sketch/tools/toolMachine'
import { dimensionRefIds } from '../../lib/sketch/refIds'
import { flattenBlockToWorld } from '../../lib/sketch/blocks'
import { dimensionDisplay } from '../../lib/sketch/sketcher/sketchLayer'
import {
  sketchToGcsPrimitives, solveSketchOnWrapper,
} from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import type {
  Sketch, SketchBlockEntity, SketchCircleEntity, SketchConstraint, SketchDimension,
  SketchEntity,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'

const EDGE = 'edge'
const HOLES = ['h1', 'h2', 'h3', 'h4'] as const
/** Hole centers as drawn, in the order the operator clicks them. */
const HOLE_AT: Record<string, { x: number; y: number }> = {
  h1: { x: 20, y: 15 },
  h2: { x: 40, y: 15 },
  h3: { x: 20, y: 45 },
  h4: { x: 40, y: 45 },
}
/** The lower-left corner: the left edge's own start point. */
const CORNER = { entityId: EDGE, site: 'start' } as const

let n = 0
const newId = () => `wo1867-${n++}`

function plate(cornerAt = { x: 0, y: 0 }): Sketch {
  const entities: SketchEntity[] = [
    { id: EDGE, kind: 'line', construction: false,
      start: { ...cornerAt }, end: { x: cornerAt.x, y: cornerAt.y + 60 } },
    ...HOLES.map((id): SketchCircleEntity => ({
      id, kind: 'circle', construction: false, center: { ...HOLE_AT[id] }, radius: 3,
    })),
  ]
  const constraints: SketchConstraint[] = [
    { id: 'fix-corner', kind: 'fix', point: { ...CORNER } },
    { id: 'edge-vertical', kind: 'vertical', line: EDGE },
  ]
  return {
    id: 'wo1867-plate', layerId: 'layer',
    entities, constraints, dimensions: [], solveStatus: null,
  }
}

/** Drive the REAL tool machine: pick the datum, Tab into an ordinate mode,
 *  then click each hole center. Returns the dimensions the clicks committed,
 *  in click order -- this is the gesture, not a hand-built payload. */
function placeStack(
  sketch: Sketch, axis: 'x' | 'y', holes: readonly string[] = HOLES,
): SketchDimension[] {
  // Click 1: the datum. An explicit snap on the corner records it as a POINT.
  const first = dimToolClick(
    null, { x: sketch.entities[0].kind === 'line' ? sketch.entities[0].start.x : 0, y: 0 },
    1, sketch.entities, newId,
    { point: cornerOf(sketch), ref: { ...CORNER } },
  )
  expect(first.notice, 'picking the datum is accepted').toBeNull()
  expect(first.dimension, 'picking the datum commits nothing yet').toBeNull()
  let chain = first.chain
  expect(chain, 'the datum is armed').not.toBeNull()

  // Tab: one picked point has no two-operand orientation to cycle, so this is
  // the gesture slot the ordinate stack uses.
  const family = dimForceFamily(sketch.entities, chain!.operandIds)
  expect(family).toBe('ordinate')
  if (family === null) throw new Error('the ordinate gesture is not offered')
  let mode = cycleDimForceMode(chain!.forceMode, family)
  if (axis === 'y') mode = cycleDimForceMode(mode, family)
  expect(ordinateForceAxis(mode)).toBe(axis)
  chain = { ...chain!, forceMode: mode }

  const placed: SketchDimension[] = []
  for (const hole of holes) {
    const out = dimToolClick(
      chain, { ...HOLE_AT[hole] }, 1, sketch.entities, newId,
      { point: { ...HOLE_AT[hole] }, ref: { entityId: hole, site: 'center' } },
    )
    expect(out.notice, `clicking ${hole} is accepted`).toBeNull()
    expect(out.dimension, `clicking ${hole} drops one ordinate`).not.toBeNull()
    expect(out.chain, 'the datum stays armed for the next hole').not.toBeNull()
    // The drop lands on the stack's common witness line, not at the cursor.
    expect(out.dimension!.labelAnchor).toEqual(
      ordinateStackAnchor(cornerOf(sketch), HOLE_AT[hole], axis))
    placed.push(out.dimension!)
    chain = out.chain as DimChainState
  }
  return placed
}

function cornerOf(sketch: Sketch): { x: number; y: number } {
  const e = sketch.entities.find((x) => x.id === EDGE)
  if (!e || e.kind !== 'line') throw new Error('no left edge')
  return e.start
}

function holeCenter(entities: readonly SketchEntity[], id: string): { x: number; y: number } {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'circle') throw new Error(`expected circle '${id}'`)
  return e.center
}

async function withWrapper<T>(
  fn: (w: Awaited<ReturnType<typeof createGcsWrapper>>) => T | Promise<T>,
): Promise<T> {
  const wrapper = await createGcsWrapper()
  try {
    return await fn(wrapper)
  } finally {
    wrapper.destroy_gcs_module()
  }
}

describe('WO-1867: the gesture places one stack from one chosen origin', () => {
  it('picking the lower-left corner then the four holes gives four X and four Y ordinates at the true offsets', () => {
    const sketch = plate()
    const xs = placeStack(sketch, 'x')
    const ys = placeStack(sketch, 'y')

    expect(xs).toHaveLength(4)
    expect(ys).toHaveLength(4)
    for (const d of [...xs, ...ys]) {
      expect(d.kind).toBe('ordinate')
      if (d.kind !== 'ordinate') continue
      // Every ordinate of the stack names the SAME datum -- that shared origin
      // is the whole point of the kind.
      expect(d.origin).toEqual({ ...CORNER })
      expect(d.driving).toBe(true)
    }
    expect(xs.map((d) => d.value)).toEqual(HOLES.map((h) => HOLE_AT[h].x))
    expect(ys.map((d) => d.value)).toEqual(HOLES.map((h) => HOLE_AT[h].y))
    // The measured value and the stored value are the same quantity.
    for (const d of [...xs, ...ys]) {
      expect(measureDimension(sketch.entities, d)).toBeCloseTo(d.value, 9)
    }
    expect(dimModeLabel('ordinate')).toBe('Ordinate')
    expect(formatDimensionValue('ordinate', 20, true)).toBe('20.00')
    expect(formatDimensionValue('ordinate', 20, false)).toBe('(20.00)')
  })

  it('an ordinate names BOTH its datum and its point as referenced entities', () => {
    const d = placeStack(plate(), 'x', ['h1'])[0]
    expect(dimensionRefIds(d).sort()).toEqual([EDGE, 'h1'].sort())
  })

  it('the datum itself, and a pick with no single point, are refused by name and never mis-committed', () => {
    const sketch = plate()
    const chain: DimChainState = {
      kind: 'dim', operandIds: [{ entityId: EDGE, site: 'start' }], forceMode: 'ordinateX',
    }
    const self = dimToolClick(chain, { x: 0, y: 0 }, 1, sketch.entities, newId,
      { point: { x: 0, y: 0 }, ref: { ...CORNER } })
    expect(self.dimension).toBeNull()
    expect(self.notice).toContain('datum itself')

    // A bare LINE BODY has no unambiguous point, so it is not a datum operand
    // and not a measurable point either.
    expect(ordinatePointRef(sketch.entities, EDGE)).toBeNull()
    expect(dimForceFamily(sketch.entities, [EDGE])).toBe('linear')
  })
})

describe('WO-1867: the labels line up on one common witness line', () => {
  it('every X ordinate of a stack drops on the same horizontal line, abreast of its own hole', () => {
    const sketch = plate()
    const xs = placeStack(sketch, 'x')
    const anchors = xs.map((d) => d.labelAnchor!)
    const ys = new Set(anchors.map((a) => a.y))
    expect(ys.size, 'one stack, one witness line').toBe(1)
    expect([...ys][0]).toBeCloseTo(cornerOf(sketch).y - ORDINATE_STACK_OFFSET_MM, 9)
    expect(anchors.map((a) => a.x)).toEqual(HOLES.map((h) => HOLE_AT[h].x))

    // Y ordinates get their own single vertical line.
    const yAnchors = placeStack(sketch, 'y').map((d) => d.labelAnchor!)
    expect(new Set(yAnchors.map((a) => a.x)).size).toBe(1)
    expect(yAnchors[0].x).toBeCloseTo(cornerOf(sketch).x - ORDINATE_STACK_OFFSET_MM, 9)
  })

  it('a stack reloaded WITHOUT stored label anchors still reads as a stack', () => {
    const sketch = plate()
    const xs = placeStack(sketch, 'x').map((d) => {
      const { labelAnchor: _drop, ...rest } = d
      return rest as SketchDimension
    })
    const doc: Sketch = { ...sketch, dimensions: xs }
    const anchors = xs.map((d) => dimensionDisplay(doc, d)!.anchor)
    expect(new Set(anchors.map((a) => a.y)).size).toBe(1)
    expect(anchors[0].y).toBeCloseTo(-ORDINATE_STACK_OFFSET_MM, 9)
  })

  it('the drawn witness/leader geometry spans datum -> hole along the stack line', () => {
    const sketch = plate()
    const d = placeStack(sketch, 'x', ['h2'])[0]
    if (d.kind !== 'ordinate') throw new Error('expected an ordinate')
    const guides = dimGuides(sketch.entities, d, d.labelAnchor!, 0.5)
    // Index 2 is the dimension BAR, the same slot every linear guide uses.
    const bar = guides[2]
    expect(bar[0].x).toBeCloseTo(0, 9)
    expect(bar[1].x).toBeCloseTo(40, 9)
    expect(bar[0].y).toBeCloseTo(bar[1].y, 9)
    expect(bar[0].y).toBeCloseTo(-ORDINATE_STACK_OFFSET_MM, 9)
  })
})

describe('WO-1867: a driving ordinate holds its own hole and nothing else', () => {
  it('typing 32 into the third hole X ordinate moves that hole and leaves the other three', async () => {
    const sketch = plate()
    const xs = placeStack(sketch, 'x')
    const ys = placeStack(sketch, 'y')
    const edited = xs.map((d) =>
      d.id === xs[2].id ? { ...d, value: 32 } : d)
    const doc: Sketch = { ...sketch, dimensions: [...edited, ...ys] }

    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, doc)
      expect(out.ok).toBe(true)
      if (!out.ok) return
      expect(holeCenter(out.entities, 'h3').x).toBeCloseTo(32, 6)
      expect(holeCenter(out.entities, 'h3').y).toBeCloseTo(45, 6)
      for (const other of ['h1', 'h2', 'h4']) {
        expect(holeCenter(out.entities, other).x).toBeCloseTo(HOLE_AT[other].x, 6)
        expect(holeCenter(out.entities, other).y).toBeCloseTo(HOLE_AT[other].y, 6)
      }
    })
  })

  it('each DRIVING ordinate is worth exactly one degree of freedom', async () => {
    const sketch = plate()
    const all = [...placeStack(sketch, 'x'), ...placeStack(sketch, 'y')]
    await withWrapper((w) => {
      const dofAt = (dimensions: SketchDimension[]): number => {
        const out = solveSketchOnWrapper(w, { ...sketch, dimensions })
        expect(out.ok).toBe(true)
        if (!out.ok) throw new Error('solve failed')
        return out.status.dof
      }
      const base = dofAt([])
      for (let i = 1; i <= all.length; i++) {
        expect(dofAt(all.slice(0, i)), `${i} driving ordinates`).toBe(base - i)
      }
      // A REFERENCE ordinate constrains nothing, so it costs no freedom.
      expect(dofAt(all.map((d) => ({ ...d, driving: false })))).toBe(base)
      expect(sketchToGcsPrimitives({ ...sketch, dimensions: all.map((d) => ({ ...d, driving: false })) })
        .some((p) => all.some((d) => d.id === p.id))).toBe(false)
    })
  })
})

describe('WO-1867: moving the datum carries the whole stack in one solve', () => {
  it('driving ordinates keep their values and their holes follow; reference ordinates re-measure', async () => {
    const sketch = plate()
    const driving = [...placeStack(sketch, 'x'), ...placeStack(sketch, 'y')]
    // Two REFERENCE ordinates on the same datum, seeded at the as-drawn numbers.
    const reference: SketchDimension[] = [
      { id: 'ref-x', kind: 'ordinate', driving: false, value: 20, axis: 'x',
        origin: { ...CORNER }, point: { entityId: 'h1', site: 'center' } },
      { id: 'ref-y', kind: 'ordinate', driving: false, value: 15, axis: 'y',
        origin: { ...CORNER }, point: { entityId: 'h1', site: 'center' } },
    ]

    // The datum moves: the corner is dragged to (10, 5). Its fix holds it
    // there, and nothing else in the document ties the holes to the world.
    const moved = plate({ x: 10, y: 5 })
    const doc: Sketch = { ...moved, dimensions: [...driving, ...reference] }

    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, doc)
      expect(out.ok).toBe(true)
      if (!out.ok) return

      // THE NEGATIVE CONTROL for the origin operand: drop `d.origin` from
      // mapDimension's 'ordinate' case (leaving the point against anything
      // else) and these four assertions fail -- the holes stay where they were
      // drawn instead of following the datum.
      for (const hole of HOLES) {
        expect(holeCenter(out.entities, hole).x).toBeCloseTo(HOLE_AT[hole].x + 10, 6)
        expect(holeCenter(out.entities, hole).y).toBeCloseTo(HOLE_AT[hole].y + 5, 6)
      }
      // Driving means the VALUE holds: the offsets from the datum are unchanged.
      for (const d of driving) {
        expect(measureDimension(out.entities, d)).toBeCloseTo(d.value, 6)
      }

      // ... and in that SAME solve the reference readouts are re-measured, so
      // none is left reading its old number against the new geometry.
      const after = remeasureReferenceDimensions(out.entities, [...driving, ...reference])
      const refAfter = after.filter((d) => d.id.startsWith('ref-'))
      expect(refAfter.map((d) => d.value)).toEqual([20, 15])
      const h1 = holeCenter(out.entities, 'h1')
      expect(refAfter[0].value).toBeCloseTo(h1.x - 10, 6)
      expect(refAfter[1].value).toBeCloseTo(h1.y - 5, 6)
      // The driving ones were NOT overwritten by the measurement pass.
      for (const d of after.filter((x) => x.driving)) {
        expect(d.value).toBe(driving.find((x) => x.id === d.id)!.value)
      }
    })
  })

  it('a datum move shows up in a reference ordinate that was left reading a stale number', async () => {
    // Guard for the "no reference dimension left reading its old number" half:
    // seed a reference ordinate with a deliberately wrong value and prove the
    // re-measure corrects it rather than leaving it.
    const moved = plate({ x: 10, y: 5 })
    const stale: SketchDimension = {
      id: 'ref-stale', kind: 'ordinate', driving: false, value: 999, axis: 'x',
      origin: { ...CORNER }, point: { entityId: 'h1', site: 'center' },
    }
    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, { ...moved, dimensions: [stale] })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const [fixed] = remeasureReferenceDimensions(out.entities, [stale])
      expect(fixed.value).not.toBe(999)
      expect(fixed.value).toBeCloseTo(holeCenter(out.entities, 'h1').x - 10, 6)
    })
  })
})

describe('WO-1867: the solver mapping an ordinate pushes', () => {
  it('is one signed difference equation, datum -> point, on the named axis', () => {
    const sketch = plate()
    const [dx] = placeStack(sketch, 'x', ['h2'])
    const [dy] = placeStack(sketch, 'y', ['h2'])
    const prims = sketchToGcsPrimitives({ ...sketch, dimensions: [dx, dy] })
    const mine = prims.filter((p) => p.id === dx.id || p.id === dy.id)
    expect(mine).toHaveLength(2)
    expect(mine).toMatchObject([
      { type: 'difference', driving: true, difference: 40,
        param1: { o_id: `${EDGE}:start`, prop: 'x' },
        param2: { o_id: 'h2:center', prop: 'x' } },
      { type: 'difference', driving: true, difference: 15,
        param1: { o_id: `${EDGE}:start`, prop: 'y' },
        param2: { o_id: 'h2:center', prop: 'y' } },
    ])
  })
})

// ---- Store integration: save/reload, undo, re-ID ---------------------------
//
// The persistence and undo halves of the acceptance are APPLICATION claims, so
// they run through the application's real entry points (addDimension,
// saveProjectToFile, loadProjectFromFile, openSketchForLayer, undo) against a
// loopback Worker that runs the real planegcs solve in-process -- the same
// scaffolding dimValueEdit.test.tsx and circleDimensionPositiveGuard use.

class LoopbackWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    void (async () => {
      const wrapper = await sharedWrapper()
      const { requestId, sketch } = msg.payload
      const out = solveSketchOnWrapper(wrapper, sketch)
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
let wrapperPromise: Promise<GcsWrapper> | null = null
function sharedWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}
vi.stubGlobal('Worker', LoopbackWorker)

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } as Storage,
})

type Store = typeof import('../../store').useCamStore

async function freshStore(): Promise<Store> {
  vi.resetModules()
  const { useCamStore } = await import('../../store')
  useCamStore.setState((s) => ({
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    lastNonSketchMode: 'setup' as const,
    project: { ...s.project, geometry: [], stocks: [] },
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
  return useCamStore
}

/** Author the plate + one X ordinate stack through the real store actions and
 *  Finish it. Returns the store, the layer id and the placed dimensions. */
async function authorStack(store: Store): Promise<{ layerId: string; placed: SketchDimension[] }> {
  store.getState().setViewerMode('sketch')
  expect(store.getState().activeSketch, 'entering sketch mode opens a document').not.toBeNull()
  const sketch = plate()
  for (const e of sketch.entities) store.getState().addEntity({ ...e })
  const placed = placeStack(sketch, 'x')
  for (const d of placed) store.getState().addDimension({ ...d })
  const layerId = store.getState().activeSketch!.layerId
  return { layerId, placed }
}

async function saveToJson(store: Store): Promise<string> {
  let captured: Blob | null = null
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = ((b: Blob) => { captured = b; return 'blob:wo1867' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  try {
    await store.getState().saveProjectToFile()
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
  }
  expect(captured, 'Save produced a file').not.toBeNull()
  return await (captured as unknown as Blob).text()
}

describe('WO-1867: the stack survives save/reload and undoes one placement at a time', () => {
  it('reloads from a saved project with the same origin, values, driving flags and label placement', async () => {
    const store = await freshStore()
    const { layerId, placed } = await authorStack(store)
    store.getState().finishSketch()
    const json = await saveToJson(store)

    const reloaded = await freshStore()
    await reloaded.getState().loadProjectFromFile(json)
    const owner = reloaded.getState().project.geometry
      .find((g) => g.sketches?.some((s) => s.layerId === layerId))
    expect(owner, 'the saved project carries the sketch').toBeTruthy()
    expect(reloaded.getState().openSketchForLayer(layerId, owner!.id)).toBe(true)

    const after = reloaded.getState().activeSketch!.dimensions
    expect(after).toHaveLength(placed.length)
    // Field by field: the datum ref, the axis, the value, driving, the label.
    expect(after.map((d) => ({ ...d }))).toEqual(placed.map((d) => ({ ...d })))
    for (const d of after) {
      expect(d.kind).toBe('ordinate')
      if (d.kind !== 'ordinate') continue
      expect(d.origin).toEqual({ ...CORNER })
      expect(d.driving).toBe(true)
      expect(d.labelAnchor!.y).toBeCloseTo(-ORDINATE_STACK_OFFSET_MM, 9)
    }
  })

  it('one undo removes one ordinate placement, the way every other dimension placement undoes', async () => {
    const store = await freshStore()
    const { placed } = await authorStack(store)
    const count = () => store.getState().activeSketch!.dimensions.length
    expect(count()).toBe(placed.length)
    store.getState().undo()
    expect(count()).toBe(placed.length - 1)
    expect(store.getState().activeSketch!.dimensions.some((d) => d.id === placed.at(-1)!.id)).toBe(false)
    store.getState().undo()
    expect(count()).toBe(placed.length - 2)
  })
})

describe('WO-1867: a copied stack re-IDs cleanly and stays solvable', () => {
  it('both refs move onto the copy ids and the copied stack solves to the same offsets', async () => {
    const sketch = plate()
    const placed = placeStack(sketch, 'x')
    // The path that actually carries dimensions with their geometry is the
    // BLOCK one -- the top-level sketch clipboard deliberately drops every
    // dimension (captureSketchClipboard's header). flattenBlockToWorld with
    // namespacing is the production re-ID: it is what a SECOND instance of one
    // definition goes through so the two copies never share an id.
    const block: SketchBlockEntity = {
      id: 'blk', kind: 'block', construction: false,
      origin: { x: 0, y: 0 }, rotation: 0, scale: 1,
      members: {
        entities: sketch.entities.map((e) => ({ ...e })),
        constraints: [
          { id: 'b-fix', kind: 'fix', point: { ...CORNER } },
          { id: 'b-vert', kind: 'vertical', line: EDGE },
        ],
        dimensions: placed.map((d) => ({ ...d })),
      },
    }
    const copy = flattenBlockToWorld(block, undefined, true)
    expect(copy.dimensions).toHaveLength(placed.length)
    for (const d of copy.dimensions) {
      expect(d.kind).toBe('ordinate')
      if (d.kind !== 'ordinate') continue
      // Fresh ids on BOTH refs -- a copy whose datum still pointed at the
      // original would silently measure across the two copies.
      expect(d.origin.entityId).not.toBe(EDGE)
      expect(d.origin.entityId).toContain(EDGE)
      expect(d.origin.site).toBe('start')
      expect(d.point.entityId).not.toBe(d.origin.entityId)
      expect(copy.entities.some((e) => e.id === d.origin.entityId)).toBe(true)
      expect(copy.entities.some((e) => e.id === d.point.entityId)).toBe(true)
    }

    const copiedSketch: Sketch = {
      ...sketch,
      entities: copy.entities,
      constraints: copy.constraints,
      dimensions: copy.dimensions,
    }
    await withWrapper((w) => {
      const out = solveSketchOnWrapper(w, copiedSketch)
      expect(out.ok, 'the re-IDed stack still solves').toBe(true)
      if (!out.ok) return
      for (const d of copy.dimensions) {
        expect(measureDimension(out.entities, d)).toBeCloseTo(d.value, 6)
      }
    })
  })
})

describe('WO-1867: the live cursor preview names the ordinate gesture', () => {
  it('shows the offset the next click would commit, not a "pick a second entity" hint', () => {
    const sketch = plate()
    const chain: DimChainState = {
      kind: 'dim', operandIds: [{ ...CORNER }], forceMode: 'ordinateX',
    }
    const live = dimPreview(sketch.entities, chain, 'mm', { x: 37, y: 12 })
    expect(live).not.toBeNull()
    expect(live!.mode).toBe('Ordinate')
    expect(live!.hint).toBe(false)
    expect(live!.text).toBe('37.00')     // the X offset from the datum at (0,0)
    expect(live!.showTabHint).toBe(true) // Tab is what switches X -> Y -> off

    // Y mode measures the other component of the same cursor.
    const yLive = dimPreview(sketch.entities, { ...chain, forceMode: 'ordinateY' },
      'mm', { x: 37, y: 12 })
    expect(yLive!.text).toBe('12.00')

    // Before the first pointermove there is no cursor: name the gesture.
    const armed = dimPreview(sketch.entities, chain, 'mm', null)
    expect(armed!.hint).toBe(true)
    expect(armed!.text).toContain('ordinate X')
  })
})

// ---------------------------------------------------------------------------
// The Tab-family census. Architect re-scope 2026-09-23: a WHOLE-ENTITY pick of
// a lone circle or a lone point keeps exactly the family it has on main (null),
// so src/tests/sketch/arcLengthDimension.ui50b.test.ts:91 stays green untouched.
// The ordinate family is offered only for an EXPLICITLY SNAPPED point -- a hole
// center snap, a point entity's own site, a vertex -- which is how the operator
// actually picks a datum.
// ---------------------------------------------------------------------------

const NON_ARCS: SketchEntity[] = [
  { id: 'circle', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 7 },
  { id: 'ellipse', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
    majorRadius: 7, minorRadius: 3, rotation: 0 },
  { id: 'elliptical-arc', kind: 'elliptical-arc', construction: false,
    center: { x: 0, y: 0 }, majorRadius: 7, minorRadius: 3, rotation: 0,
    startParam: 0, endParam: Math.PI },
  { id: 'line', kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 7, y: 0 } },
  { id: 'point', kind: 'point', construction: false, at: { x: 0, y: 0 } },
]

describe('WO-1867: which lone shapes the ordinate gesture is offered for', () => {
  it('keeps the main family for whole-entity picks and offers the datum only for a snapped point', () => {
    const family = (id: string) => dimForceFamily(NON_ARCS, [id])
    expect(family('circle'), 'a bare circle pick keeps its main family').toBeNull()
    expect(family('point'), 'a bare point pick keeps its main family').toBeNull()
    expect(dimForceFamily(NON_ARCS, [{ entityId: 'circle', site: 'center' }]),
      'a hole center snap is the datum').toBe('ordinate')
    expect(dimForceFamily(NON_ARCS, [{ entityId: 'point', site: 'self' }]),
      'a snapped point is its own datum').toBe('ordinate')
    expect(dimForceFamily(NON_ARCS, [{ entityId: 'line', site: 'start' }]),
      'a snapped line corner is a datum').toBe('ordinate')
    expect(family('ellipse'), 'an ellipse center is not offered').toBeNull()
    expect(family('elliptical-arc'), 'an elliptical arc is not offered').toBeNull()
    expect(family('line'), 'a line body keeps its linear family').toBe('linear')

    // A circular arc keeps its ESTABLISHED arc-length cycle; the ordinate
    // family is checked after it, so the arc gesture is not stolen.
    const arc: SketchEntity = { id: 'arc', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 7, startAngle: 0, endAngle: Math.PI }
    expect(dimForceFamily([arc], ['arc'])).toBe('arc')
  })

  it('still leaves arcLength unreachable through Tab for every one of them', () => {
    for (const entity of NON_ARCS) {
      const state = cycleDimForce(
        { tool: 'smart-dimension', chain: { kind: 'dim', operandIds: [entity.id] } },
        NON_ARCS,
      )
      expect(state.chain?.kind === 'dim' ? state.chain.forceMode : null, entity.kind)
        .not.toBe('arcLength')
      expect(resolveDimPlacement(
        NON_ARCS, [entity.id], { x: 10, y: 10 }, { forceOrientation: 'arcLength' },
      ), entity.kind).toBeNull()
    }
  })
})
