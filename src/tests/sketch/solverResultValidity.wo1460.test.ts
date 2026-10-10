// WO-1460: a solver "success" verdict must not commit geometry that does not
// actually satisfy its closed-form constraints.
//
// BUG-384: Horizontal + whole-line Fix + Vertical converged untouched (every
// parameter grounded, so Vertical dropped out of the Jacobian) and committed
// a horizontal line as "Fully defined".
// BUG-498: Parallel then Perpendicular on a free line against a fixed
// reference collapsed the free line to ~1e-15mm and committed it.
//
// Part A drives solveSketchOnWrapper directly (every caller's boundary);
// Part B drives the store's apply path through a loopback worker running the
// same real solver, asserting the reject/restore machinery does its job.

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
let w: GcsWrapper

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  w = await ensureWrapper()
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

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function mk(
  entities: SketchEntity[], constraints: SketchConstraint[], dimensions: SketchDimension[] = [],
): Sketch {
  return { id: 'sk', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
}
function lineOf(entities: SketchEntity[], id: string) {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`${id} missing`)
  return e
}
const len = (l: { start: { x: number; y: number }; end: { x: number; y: number } }) =>
  Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)

/** Solve, then fold the solved geometry back in (what a commit does). */
function solveOk(sk: Sketch): Sketch {
  const out = solveSketchOnWrapper(w, sk)
  if (!out.ok) throw new Error(`expected ok solve, got ${out.message}`)
  return { ...sk, entities: out.entities, solveStatus: out.status }
}

// ---- Part A: the solver boundary ---------------------------------------------

describe('WO-1460 solver boundary: violated/degenerate results are refused', () => {
  it('BUG-384: Horizontal + whole-line Fix + Vertical is refused, naming the conflict', () => {
    let sk = solveOk(mk([line('l', 0, 0, 37.6, 5)], [{ id: 'h', kind: 'horizontal', line: 'l' }]))
    sk = solveOk({ ...sk, constraints: [...sk.constraints, { id: 'f', kind: 'fix', entityId: 'l' }] })
    const out = solveSketchOnWrapper(w, {
      ...sk, constraints: [...sk.constraints, { id: 'v', kind: 'vertical', line: 'l' }],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.solveFailed).toBe(true)
    expect(out.status.conflicting).toContain('v')
    expect(out.status.conflicting).toEqual(expect.arrayContaining(['h', 'f']))
  })

  it('BUG-498: Parallel then Perpendicular on a free line vs a fixed reference is refused', () => {
    const sk = solveOk(mk(
      [line('r', 0, 0, 50, 0), line('m', 10, 10, 40, 25)],
      [{ id: 'f', kind: 'fix', entityId: 'r' }, { id: 'p', kind: 'parallel', a: 'r', b: 'm' }],
    ))
    expect(len(lineOf(sk.entities, 'm'))).toBeGreaterThan(1)
    const out = solveSketchOnWrapper(w, {
      ...sk, constraints: [...sk.constraints, { id: 'q', kind: 'perpendicular', a: 'r', b: 'm' }],
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.conflicting).toContain('q')
    expect(out.status.conflicting).toContain('p')
  })

  it('drag solves are not validated (they carry the document verdict)', () => {
    const sk = solveOk(mk([line('l', 0, 0, 37.6, 0)], [{ id: 'h', kind: 'horizontal', line: 'l' }]))
    const out = solveSketchOnWrapper(w, sk, {
      targets: [{ point: ref('l', 'end'), to: { x: 40, y: 0 } }],
    })
    expect(out.ok).toBe(true)
  })
})

describe('WO-1460 no false rejections: genuine non-degenerate solves still commit', () => {
  it('horizontal + vertical rectangle (lines and a point-pair variant)', () => {
    const sk = mk(
      [
        line('l1', 0, 0, 40, 1), line('l2', 40, 1, 41, 30),
        line('l3', 41, 30, 0, 29), line('l4', 0, 29, 0, 0),
        point('pa', -5, 0), point('pb', -6, 10),
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
        { id: 'vp', kind: 'vertical', points: [ref('pa', 'self'), ref('pb', 'self')] },
        { id: 'fx', kind: 'fix', point: ref('l1', 'start') },
      ],
      [
        { id: 'dw', kind: 'distance', driving: true, value: 40, a: ref('l1', 'start'), b: ref('l1', 'end') },
        { id: 'dh', kind: 'distance', driving: true, value: 30, a: ref('l2', 'start'), b: ref('l2', 'end') },
      ],
    )
    const out = solveSketchOnWrapper(w, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const l1 = lineOf(out.entities, 'l1')
    expect(l1.start.y).toBeCloseTo(l1.end.y, 6)
    expect(len(l1)).toBeCloseTo(40, 6)
  })

  it('perpendicular L-bracket against a fixed reference', () => {
    const out = solveSketchOnWrapper(w, mk(
      [line('r', 0, 0, 50, 0), line('m', 0, 0, 5, 30)],
      [
        { id: 'f', kind: 'fix', entityId: 'r' },
        { id: 'c', kind: 'coincident', a: ref('r', 'start'), b: ref('m', 'start') },
        { id: 'q', kind: 'perpendicular', a: 'r', b: 'm' },
      ],
    ))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const m = lineOf(out.entities, 'm')
    expect(Math.abs(m.end.x - m.start.x)).toBeLessThan(1e-6)
    expect(len(m)).toBeGreaterThan(1)
  })

  it('parallel pair against a fixed reference', () => {
    const out = solveSketchOnWrapper(w, mk(
      [line('r', 0, 0, 50, 0), line('m', 10, 10, 40, 25)],
      [{ id: 'f', kind: 'fix', entityId: 'r' }, { id: 'p', kind: 'parallel', a: 'r', b: 'm' }],
    ))
    expect(out.ok).toBe(true)
  })

  it('collinear pair against a fixed reference', () => {
    const out = solveSketchOnWrapper(w, mk(
      [line('r', 0, 0, 50, 0), line('m', 60, 3, 90, 8)],
      [{ id: 'f', kind: 'fix', entityId: 'r' }, { id: 'k', kind: 'collinear', a: 'r', b: 'm' }],
    ))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const m = lineOf(out.entities, 'm')
    expect(Math.abs(m.start.y)).toBeLessThan(1e-6)
    expect(Math.abs(m.end.y)).toBeLessThan(1e-6)
  })

  it('a line that was already shorter than 0.01mm is not a collapse', () => {
    const out = solveSketchOnWrapper(w, mk(
      [line('t', 5, 5, 5.001, 5.004)], [{ id: 'h', kind: 'horizontal', line: 't' }],
    ))
    expect(out.ok).toBe(true)
  })
})

// ---- Part B: the store's apply path ------------------------------------------

describe('WO-1460 store apply path: refused application restores prior geometry', () => {
  it('BUG-384: Vertical is refused with a notice; the Horizontal+Fix line is preserved', async () => {
    useCamStore.getState().setActiveSketch(mk(
      [line('l', 0, 0, 37.6, 5)], [{ id: 'h', kind: 'horizontal', line: 'l' }],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.getState().setSketchSelection(['l'])
    useCamStore.getState().applySketchConstraint('fix')
    await waitUntil(
      () => useCamStore.getState().activeSketch!.constraints.some((c) => c.kind === 'fix' && c.entityId === 'l') &&
            useCamStore.getState().sketchSolveStatus?.solveFailed !== true,
      'fix applied',
    )
    await new Promise((r) => setTimeout(r, 50))
    const prior = lineOf(useCamStore.getState().activeSketch!.entities, 'l')
    expect(prior.start.y).toBeCloseTo(prior.end.y, 6)
    const count = useCamStore.getState().activeSketch!.constraints.length

    useCamStore.getState().setSketchSelection(['l'])
    useCamStore.getState().applySketchConstraint('vertical')
    await waitUntil(() => useCamStore.getState().sketchNotice !== null, 'rejection notice')
    const notice = useCamStore.getState().sketchNotice!
    expect(notice).toContain('Vertical rejected: conflicts with')
    expect(notice).not.toContain('existing constraints')

    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.solveFailed !== true &&
            useCamStore.getState().activeSketch!.constraints.length === count,
      're-solve after revert',
    )
    const after = useCamStore.getState().activeSketch!
    expect(after.constraints.some((c) => c.kind === 'vertical')).toBe(false)
    const l = lineOf(after.entities, 'l')
    expect(l.start).toEqual(prior.start)
    expect(l.end).toEqual(prior.end)
  })

  it('BUG-498: Perpendicular is refused; the free line keeps its post-Parallel length and direction', async () => {
    useCamStore.getState().setActiveSketch(mk(
      [line('r', 0, 0, 50, 0), line('m', 10, 10, 40, 25)],
      [{ id: 'f', kind: 'fix', entityId: 'r' }],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.getState().setSketchSelection(['r', 'm'])
    useCamStore.getState().applySketchConstraint('parallel')
    await waitUntil(
      () => useCamStore.getState().activeSketch!.constraints.some((c) => c.kind === 'parallel') &&
            (() => { const m = lineOf(useCamStore.getState().activeSketch!.entities, 'm'); return Math.abs(m.end.y - m.start.y) < 1e-6 })(),
      'parallel applied',
    )
    await new Promise((r) => setTimeout(r, 50))
    const prior = lineOf(useCamStore.getState().activeSketch!.entities, 'm')
    expect(len(prior)).toBeGreaterThan(1)
    const count = useCamStore.getState().activeSketch!.constraints.length

    useCamStore.getState().setSketchSelection(['r', 'm'])
    useCamStore.getState().applySketchConstraint('perpendicular')
    await waitUntil(() => useCamStore.getState().sketchNotice !== null, 'rejection notice')
    expect(useCamStore.getState().sketchNotice!).toContain('Perpendicular rejected')

    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.solveFailed !== true &&
            useCamStore.getState().activeSketch!.constraints.length === count,
      're-solve after revert',
    )
    const after = useCamStore.getState().activeSketch!
    expect(after.constraints.some((c) => c.kind === 'perpendicular')).toBe(false)
    const m = lineOf(after.entities, 'm')
    expect(len(m)).toBeCloseTo(len(prior), 6)
    expect(m.start.y).toBeCloseTo(m.end.y, 6)
  })
})
