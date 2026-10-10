// Constraint buttons apply to selection (Stage 4 chunk 1, commit 2).
//
// Part A: table-driven validity map — planConstraintForSelection is the
// single rule set behind button enablement AND the click action.
// Part B: store integration against the REAL solver (the Worker global is
// a loopback that runs gcsMapping in-process): a successful apply lowers
// dof; a conflicting apply is auto-rejected — the just-added constraint is
// removed, a re-solve restores the status, and the notice NAMES the
// conflicting set. No silent failures.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchConstraintKind,
  SketchDimension, PointRef,
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

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
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

// ---- fixtures ---------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function circle(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}
function arc(id: string): SketchEntity {
  return { id, kind: 'arc', construction: false, center: { x: 0, y: 50 },
    radius: 5, startAngle: 0.2, endAngle: 2.0 }
}
function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
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

/** The validity-table playground: 2 lines, 2 circles, an arc, 2 points,
 *  one whole-entity-fixed line. */
function playground(): Sketch {
  return makeSketch(
    [
      line('la', 0, 0, 10, 1), line('lb', 0, 5, 10, 7),
      circle('ca', 20, 0, 3), circle('cb', 30, 0, 4),
      arc('ar'),
      point('pa', -5, 0), point('pb', -5, 5),
      line('lfix', 0, -10, 10, -10),
    ],
    [{ id: 'fx-lfix', kind: 'fix', entityId: 'lfix' }],
  )
}

// ---- Part A: validity map ----------------------------------------------------

describe('constraint validity map (table-driven)', () => {
  const cases: Array<{
    kind: SketchConstraintKind
    selection: string[]
    ok: boolean
    note: string
  }> = [
    // horizontal / vertical: 1+ lines, or exactly 2 points
    { kind: 'horizontal', selection: ['la'], ok: true,  note: 'one line' },
    { kind: 'horizontal', selection: ['la', 'lb'], ok: true, note: 'two lines -> one per line' },
    { kind: 'horizontal', selection: ['pa', 'pb'], ok: true, note: 'two points variant' },
    { kind: 'horizontal', selection: ['ca'], ok: false, note: 'circle alone' },
    { kind: 'horizontal', selection: [], ok: false, note: 'empty' },
    { kind: 'vertical',   selection: ['lb'], ok: true,  note: 'one line' },
    { kind: 'vertical',   selection: ['pa', 'pb'], ok: true, note: 'two points variant' },
    { kind: 'vertical',   selection: ['la', 'ca'], ok: false, note: 'line + circle mix' },
    // parallel / perpendicular: 2+ lines only
    { kind: 'parallel',      selection: ['la', 'lb'], ok: true,  note: 'two lines' },
    { kind: 'parallel',      selection: ['la'], ok: false, note: 'one line' },
    { kind: 'parallel',      selection: ['la', 'ca'], ok: false, note: 'line + circle' },
    { kind: 'perpendicular', selection: ['la', 'lb'], ok: true,  note: 'two lines' },
    { kind: 'perpendicular', selection: ['pa', 'pb'], ok: false, note: 'points' },
    // coincident: two unambiguous points, or a point on a curve
    { kind: 'coincident', selection: ['pa', 'pb'], ok: true,  note: 'two points' },
    { kind: 'coincident', selection: ['pa', 'ca'], ok: true,  note: 'point + circle center' },
    { kind: 'coincident', selection: ['pa', 'la'], ok: true, note: 'point on line' },
    { kind: 'coincident', selection: ['pa'], ok: false, note: 'one point' },
    // concentric: two circles/arcs
    { kind: 'concentric', selection: ['ca', 'ar'], ok: true,  note: 'circle + arc' },
    { kind: 'concentric', selection: ['ca', 'la'], ok: false, note: 'circle + line' },
    // tangent: line+curve or curve+curve, never line+line / points
    { kind: 'tangent', selection: ['la', 'ca'], ok: true,  note: 'line + circle' },
    { kind: 'tangent', selection: ['ca', 'ar'], ok: true,  note: 'circle + arc' },
    { kind: 'tangent', selection: ['la', 'lb'], ok: false, note: 'line + line' },
    { kind: 'tangent', selection: ['pa', 'ca'], ok: false, note: 'point + circle' },
    // equal: all-lines or all-curves, 2+
    { kind: 'equal', selection: ['la', 'lb'], ok: true,  note: 'two lines' },
    { kind: 'equal', selection: ['ca', 'cb', 'ar'], ok: true, note: 'circles + arc' },
    { kind: 'equal', selection: ['la', 'ca'], ok: false, note: 'line + circle mix' },
    // midpoint: point + line
    { kind: 'midpoint', selection: ['pa', 'la'], ok: true,  note: 'point + line' },
    { kind: 'midpoint', selection: ['ca', 'la'], ok: true,  note: 'circle center + line' },
    { kind: 'midpoint', selection: ['pa', 'ca'], ok: false, note: 'no line' },
    { kind: 'midpoint', selection: ['la', 'lb'], ok: false, note: 'no point' },
    // symmetric: two points + axis line
    { kind: 'symmetric', selection: ['pa', 'pb', 'la'], ok: true,  note: 'two points + axis' },
    { kind: 'symmetric', selection: ['pa', 'la'], ok: false, note: 'one point + line' },
    { kind: 'symmetric', selection: ['pa', 'pb'], ok: false, note: 'no axis' },
    // fix: any 1+ entities, unless already whole-fixed
    { kind: 'fix', selection: ['la'], ok: true,  note: 'one entity' },
    { kind: 'fix', selection: ['la', 'ca', 'pa'], ok: true, note: 'mixed entities' },
    { kind: 'fix', selection: ['lfix'], ok: false, note: 'already fixed' },
    { kind: 'fix', selection: [], ok: false, note: 'empty' },
    // point on object: unambiguous point + curve
    { kind: 'point_on_object', selection: ['pa', 'la'], ok: true,  note: 'point + line' },
    { kind: 'point_on_object', selection: ['pa', 'ar'], ok: true,  note: 'point + arc' },
    { kind: 'point_on_object', selection: ['ca', 'la'], ok: true,  note: 'circle center + line' },
    { kind: 'point_on_object', selection: ['ca', 'cb'], ok: false, note: 'two circles ambiguous' },
    { kind: 'point_on_object', selection: ['la', 'lb'], ok: false, note: 'no point' },
  ]

  const sk = playground()
  for (const c of cases) {
    it(`${c.kind} [${c.selection.join(', ')}] -> ${c.ok ? 'valid' : 'invalid'} (${c.note})`, () => {
      const plan = planConstraintForSelection(sk, c.selection, c.kind)
      expect(plan.ok).toBe(c.ok)
      if (!plan.ok) expect(plan.reason.length).toBeGreaterThan(0)
    })
  }

  it('builds the right constraint objects', () => {
    // horizontal on two lines -> one constraint per line
    const h = planConstraintForSelection(sk, ['la', 'lb'], 'horizontal')
    expect(h.ok).toBe(true)
    if (h.ok) {
      expect(h.constraints).toHaveLength(2)
      expect(h.constraints.map((c) => c.kind === 'horizontal' && c.line))
        .toEqual(['la', 'lb'])
    }
    // coincident point + circle -> circle operand is its CENTER site
    const co = planConstraintForSelection(sk, ['pa', 'ca'], 'coincident')
    expect(co.ok).toBe(true)
    if (co.ok && co.constraints[0].kind === 'coincident') {
      expect(co.constraints[0].a).toEqual(ref('pa', 'self'))
      expect(co.constraints[0].b).toEqual(ref('ca', 'center'))
    }
    // symmetric -> the line is the axis, points in selection order
    const sy = planConstraintForSelection(sk, ['pa', 'pb', 'la'], 'symmetric')
    expect(sy.ok).toBe(true)
    if (sy.ok && sy.constraints[0].kind === 'symmetric') {
      expect(sy.constraints[0].axis).toBe('la')
      expect(sy.constraints[0].a).toEqual(ref('pa', 'self'))
    }
    // selected constraint/dimension ids are ignored as operands
    const withNoise = planConstraintForSelection(sk, ['fx-lfix', 'la', 'lb'], 'parallel')
    expect(withNoise.ok).toBe(true)
  })
})

// ---- Part B: store apply path (real solver via loopback worker) -------------

describe('applySketchConstraint (store + real solver)', () => {
  it('successful apply lowers dof and keeps the constraints', async () => {
    const sk = makeSketch([line('la', 0, 0, 10, 1), line('lb', 0, 5, 10, 7)])
    useCamStore.getState().setActiveSketch(sk) // posts the open-solve
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    const before = useCamStore.getState().sketchSolveStatus!
    expect(before.dof).toBe(8) // two free lines

    useCamStore.getState().setSketchSelection(['la', 'lb'])
    useCamStore.getState().applySketchConstraint('horizontal')
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 6,
      'apply solve (dof 8 -> 6)',
    )
    const after = useCamStore.getState()
    // WO SKC-49: setActiveSketch always injects 3 fixed anchor constraints (origin + both axes)
    // alongside whatever the test applies -- 2 user 'horizontal' + 3 injected 'fix' = 5.
    expect(after.activeSketch!.constraints).toHaveLength(5)
    expect(after.activeSketch!.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(2)
    expect(after.sketchSolveStatus!.conflicting).toEqual([])
    // The geometry actually went horizontal (the solve was applied)
    const la = after.activeSketch!.entities.find((e) => e.id === 'la')
    if (!la || la.kind !== 'line') throw new Error('la missing')
    expect(la.start.y).toBeCloseTo(la.end.y, 6)
    // One undo step: undo removes the applied constraints again -- the 3 injected anchor fix
    // constraints predate this undo step (setActiveSketch injects them outside history) and survive it.
    useCamStore.getState().undo()
    expect(useCamStore.getState().activeSketch!.constraints).toHaveLength(3)
  })

  it('conflicting apply auto-reverts and names the conflict set', async () => {
    // Fully defined rectangle: fixed corner + H/V + driving 40x30 dims.
    // 'equal' on two adjacent sides contradicts the dims -> must be
    // rejected, removed, and the notice must name the conflicting set.
    const sk = makeSketch(
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
      ],
    )
    useCamStore.getState().setActiveSketch(sk)
    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.dof === 0,
      'open solve (fully defined)',
    )
    const constraintsBefore = useCamStore.getState().activeSketch!.constraints.length

    useCamStore.getState().setSketchSelection(['l1', 'l2'])
    useCamStore.getState().applySketchConstraint('equal')
    // Rejection lands as: constraint removed + notice + re-solve clean.
    await waitUntil(
      () => useCamStore.getState().sketchNotice !== null,
      'rejection notice',
    )
    const notice = useCamStore.getState().sketchNotice!
    expect(notice).toContain('Equal rejected: conflicts with')
    // The named set comes from the REAL diagnosis — at minimum it names
    // some pre-existing constraint/dimension, not the rejected Equal
    // itself and not an empty placeholder.
    expect(notice).not.toContain('existing constraints')
    expect(notice.length).toBeGreaterThan('Equal rejected: conflicts with '.length)

    await waitUntil(
      () => useCamStore.getState().sketchSolveStatus?.conflicting.length === 0 &&
            useCamStore.getState().sketchSolveStatus?.dof === 0,
      're-solve after revert',
    )
    const after = useCamStore.getState().activeSketch!
    expect(after.constraints).toHaveLength(constraintsBefore) // equal removed
    expect(after.constraints.some((c) => c.kind === 'equal')).toBe(false)
  })
})
