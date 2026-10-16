// WO-1568: Move / Rotate / Scale (+ Keep original) for selected sketch
// geometry.
//
// Part 1 pins the constraint and dimension rules on a constrained 40 x 20
// rectangle (transformSelection) and proves each result solves in the real
// planegcs build. Part 2 drives the SAME controller the viewport routes
// pointer clicks to (sketcherTools.armTool / click / end, CAM document port,
// echo solve worker as in mirrorStoreFlow.test.ts): each gesture on a real
// sketch document, the confirm overlay model it shows, the Keep original
// copy, and one Undo step per gesture.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { isInjectedSketchAnchorId } from '../../lib/sketch/sketchAnchors'
import { confirmOverlayModel } from '../../lib/sketch/confirmOverlay'
import { toolStepStatus } from '../../lib/sketch/tools/toolSteps'
import {
  armToolWithSelection, toolClick, confirmToolStep, escapeTool, IDLE_TOOL_STATE,
} from '../../lib/sketch/tools/toolMachine'
import {
  transformSelection, moveSpec, rotateSpec, scaleSpec, transformNotice,
  transformPreviewEntities, type TransformChainState,
} from '../../lib/sketch/tools/transformTools'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchDimension, PointRef,
} from '../../lib/sketch/types'

class EchoWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    const { requestId, sketch } = msg.payload
    const data: SketchWorkerResponseMsg = {
      type: 'SKETCH_SOLVE_COMPLETE',
      requestId,
      entities: sketch.entities,
      status: {
        dof: sketch.entities.length > 0 ? 4 : 0,
        conflicting: [], redundant: [],
        fullyDefinedEntities: [],
      },
      computeTimeMs: 0,
    }
    setTimeout(() => this.onmessage?.({ data }), 0)
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', EchoWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

// ---- Part 1: the rules on a constrained rectangle -------------------------------------

const W = 40, H = 20

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
const ref = (entityId: string, site: PointRef['site']): PointRef => ({ entityId, site })

/** 40 x 20 rectangle l1..l4 (corner at 0,0) with 4 coincidents, H/V, width
 *  and height dimensions, tied to an outside point p0 by a coincident. */
function rectDoc(): { entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[] } {
  return {
    entities: [
      line('l1', 0, 0, W, 0),
      line('l2', W, 0, W, H),
      line('l3', W, H, 0, H),
      line('l4', 0, H, 0, 0),
      { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } },
    ],
    constraints: [
      { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
      { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
      { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
      { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
      { id: 'h1', kind: 'horizontal', line: 'l1' },
      { id: 'h3', kind: 'horizontal', line: 'l3' },
      { id: 'v2', kind: 'vertical', line: 'l2' },
      { id: 'v4', kind: 'vertical', line: 'l4' },
      { id: 'tie', kind: 'coincident', a: ref('l1', 'start'), b: ref('p0', 'self') },
      { id: 'fixp', kind: 'fix', entityId: 'p0' },
    ],
    dimensions: [
      { id: 'dw', kind: 'distance', driving: true, value: W, a: ref('l1', 'start'), b: ref('l1', 'end') },
      { id: 'dh', kind: 'distance', driving: true, value: H, a: ref('l2', 'start'), b: ref('l2', 'end') },
    ],
  }
}
const RECT = ['l1', 'l2', 'l3', 'l4']

function sketchOf(d: ReturnType<typeof rectDoc>): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities: d.entities, constraints: d.constraints,
    dimensions: d.dimensions, solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function lineOf(entities: readonly SketchEntity[], id: string): SketchLineEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`no line ${id}`)
  return e
}
const len = (l: SketchLineEntity) => Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)

async function solvesInPlace(sk: Sketch): Promise<SketchEntity[]> {
  const gcs = await createGcsWrapper()
  try {
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('solve failed')
    return out.entities
  } finally {
    gcs.destroy_gcs_module()
  }
}

let n = 0
const newId = () => `x-${n++}`

describe('WO-1568 rules: move', () => {
  it('moves the set by (10, 5): internal constraints and dimensions intact, the outside tie released', async () => {
    const r = transformSelection(rectDoc(), RECT, 'move', moveSpec(10, 5), false, newId)
    if (typeof r === 'string') throw new Error(r)
    const { entities, constraints, dimensions } = r.transform
    expect(lineOf(entities, 'l1').start).toEqual({ x: 10, y: 5 })
    expect(lineOf(entities, 'l2').end).toEqual({ x: 50, y: 25 })
    // p0 is outside the set: untouched, its fix stays, the tie to it goes.
    expect(entities.find((e) => e.id === 'p0')).toEqual(rectDoc().entities[4])
    expect(constraints.map((c) => c.id)).toEqual(['c12', 'c23', 'c34', 'c41', 'h1', 'h3', 'v2', 'v4', 'fixp'])
    expect(dimensions).toEqual(rectDoc().dimensions)
    expect(r.released).toBe(1)
    expect(transformNotice('move', r)).toBe('Moved 4 entities - released 1 tie to geometry outside the selection')
    const solved = await solvesInPlace(sketchOf(r.transform))
    expect(lineOf(solved, 'l1').start.x).toBeCloseTo(10, 6)
    expect(lineOf(solved, 'l1').start.y).toBeCloseTo(5, 6)
  })

  it('a fix on a set member is released; parallel to an outside line survives a move', () => {
    const d = rectDoc()
    d.entities.push(line('out', 0, -30, 50, -30))
    d.constraints.push(
      { id: 'fix1', kind: 'fix', entityId: 'l1' },
      { id: 'par', kind: 'parallel', a: 'l1', b: 'out' },
    )
    const r = transformSelection(d, RECT, 'move', moveSpec(3, 3), false, newId)
    if (typeof r === 'string') throw new Error(r)
    const ids = r.transform.constraints.map((c) => c.id)
    expect(ids).not.toContain('fix1')
    expect(ids).toContain('par')
    expect(r.released).toBe(2) // the tie to p0 + the fix
  })

  it('a driving dimension to outside geometry is released, a reference one kept', () => {
    const d = rectDoc()
    d.dimensions.push(
      { id: 'dOut', kind: 'distance', driving: true, value: 5, a: ref('p0', 'self'), b: ref('l2', 'end') },
      { id: 'dRef', kind: 'distance', driving: false, value: 5, a: ref('p0', 'self'), b: ref('l3', 'end') },
    )
    const r = transformSelection(d, RECT, 'move', moveSpec(1, 0), false, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.transform.dimensions.map((x) => x.id)).toEqual(['dw', 'dh', 'dRef'])
  })

  it('never moves the injected origin/axes even when their ids are in the set', () => {
    const r = transformSelection(rectDoc(), ['__sketch_origin__'], 'move', moveSpec(1, 1), false, newId)
    expect(typeof r).toBe('string')
  })
})

describe('WO-1568 rules: rotate', () => {
  it('90 deg about the corner: H/V swap so they agree with the geometry, and the sketch solves unchanged', async () => {
    const r = transformSelection(rectDoc(), RECT, 'rotate', rotateSpec({ x: 0, y: 0 }, Math.PI / 2), false, newId)
    if (typeof r === 'string') throw new Error(r)
    const { entities, constraints } = r.transform
    expect(lineOf(entities, 'l1').end).toEqual({ x: 0, y: W })
    expect(lineOf(entities, 'l2').end).toEqual({ x: -H, y: W })
    const kind = (id: string) => constraints.find((c) => c.id === id)?.kind
    expect([kind('h1'), kind('h3'), kind('v2'), kind('v4')])
      .toEqual(['vertical', 'vertical', 'horizontal', 'horizontal'])
    // The corner sat on p0, and the rotation centre is that corner, but the
    // tie is still an outside positional tie: released, not kept on trust.
    expect(r.released).toBe(1)
    const solved = await solvesInPlace(sketchOf(r.transform))
    for (const id of RECT) {
      const a = lineOf(entities, id), b = lineOf(solved, id)
      expect(b.start.x).toBeCloseTo(a.start.x, 6)
      expect(b.start.y).toBeCloseTo(a.start.y, 6)
      expect(b.end.x).toBeCloseTo(a.end.x, 6)
      expect(b.end.y).toBeCloseTo(a.end.y, 6)
    }
  })

  it('30 deg: removes the H/V it breaks, keeps the rigid shape, and solves', async () => {
    const r = transformSelection(rectDoc(), RECT, 'rotate', rotateSpec({ x: 0, y: 0 }, Math.PI / 6), false, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.axisDropped).toBe(4)
    expect(r.transform.constraints.some((c) => c.kind === 'horizontal' || c.kind === 'vertical')).toBe(false)
    const solved = await solvesInPlace(sketchOf(r.transform))
    expect(len(lineOf(solved, 'l1'))).toBeCloseTo(W, 6)
    expect(len(lineOf(solved, 'l2'))).toBeCloseTo(H, 6)
    expect(transformNotice('rotate', r)).toContain('removed 4 horizontal/vertical constraints')
  })

  it('X/Y dimensions turn with a quarter turn and become reference at other angles', () => {
    const d = rectDoc()
    d.dimensions = [
      { id: 'dx', kind: 'distanceX', driving: true, value: W, a: ref('l1', 'start'), b: ref('l1', 'end') },
      { id: 'dy', kind: 'distanceY', driving: true, value: H, a: ref('l2', 'start'), b: ref('l2', 'end') },
    ]
    const q = transformSelection(d, RECT, 'rotate', rotateSpec({ x: 0, y: 0 }, Math.PI / 2), false, newId)
    if (typeof q === 'string') throw new Error(q)
    // l1 now runs (0,0)->(0,40): its +40 X span is a +40 Y span. l2 runs
    // (0,40)->(-20,40): its +20 Y span is a -20 X span.
    expect(q.transform.dimensions).toMatchObject([
      { id: 'dx', kind: 'distanceY', value: W, driving: true },
      { id: 'dy', kind: 'distanceX', value: -H, driving: true },
    ])
    const o = transformSelection(d, RECT, 'rotate', rotateSpec({ x: 0, y: 0 }, 0.3), false, newId)
    if (typeof o === 'string') throw new Error(o)
    expect(o.transform.dimensions.map((x) => x.driving)).toEqual([false, false])
    expect(o.toReference).toBe(2)
  })
})

describe('WO-1568 rules: scale', () => {
  it('x2 about the corner: the 40 mm width dimension reads 80, and the sketch solves at the new size', async () => {
    const r = transformSelection(rectDoc(), RECT, 'scale', scaleSpec({ x: 0, y: 0 }, 2), false, newId)
    if (typeof r === 'string') throw new Error(r)
    const { entities, dimensions } = r.transform
    expect(lineOf(entities, 'l2').end).toEqual({ x: 80, y: 40 })
    expect(dimensions.find((x) => x.id === 'dw')!.value).toBe(80)
    expect(dimensions.find((x) => x.id === 'dh')!.value).toBe(40)
    const solved = await solvesInPlace(sketchOf(r.transform))
    expect(len(lineOf(solved, 'l1'))).toBeCloseTo(80, 6)
    expect(len(lineOf(solved, 'l2'))).toBeCloseTo(40, 6)
  })

  it('circle radius, arc radius and a radius dimension scale with the factor', () => {
    const doc = {
      entities: [
        { id: 'c', kind: 'circle', construction: false, center: { x: 10, y: 0 }, radius: 3 },
        { id: 'a', kind: 'arc', construction: false, center: { x: 0, y: 10 }, radius: 4, startAngle: 0, endAngle: 1 },
      ] as SketchEntity[],
      constraints: [],
      dimensions: [{ id: 'dr', kind: 'radius', driving: true, value: 3, entityId: 'c' }] as SketchDimension[],
    }
    const r = transformSelection(doc, ['c', 'a'], 'scale', scaleSpec({ x: 0, y: 0 }, 1.5), false, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.transform.entities).toMatchObject([
      { center: { x: 15, y: 0 }, radius: 4.5 },
      { center: { x: 0, y: 15 }, radius: 6, startAngle: 0, endAngle: 1 },
    ])
    expect(r.transform.dimensions[0].value).toBe(4.5)
  })
})

describe('WO-1568 rules: keep original (copy)', () => {
  for (const [op, spec] of [
    ['move', moveSpec(60, 0)],
    ['rotate', rotateSpec({ x: 0, y: 0 }, Math.PI / 2)],
    ['scale', scaleSpec({ x: 0, y: 0 }, 2)],
  ] as const) {
    it(`${op}: the original is untouched; the copy carries internal constraints and dimensions, no outside ties`, async () => {
      const before = rectDoc()
      const r = transformSelection(before, RECT, op, spec, true, newId)
      if (typeof r === 'string') throw new Error(r)
      const { entities, constraints, dimensions } = r.transform
      expect(entities.slice(0, 5)).toEqual(before.entities)
      expect(constraints.slice(0, before.constraints.length)).toEqual(before.constraints)
      expect(dimensions.slice(0, 2)).toEqual(before.dimensions)
      const copies = entities.slice(5)
      expect(copies).toHaveLength(4)
      const copyIds = new Set(copies.map((e) => e.id))
      const added = constraints.slice(before.constraints.length)
      // 4 corner coincidents + 4 H/V; never the tie to p0 or p0's fix.
      expect(added).toHaveLength(8)
      expect(added.filter((c) => c.kind === 'coincident')).toHaveLength(4)
      for (const c of added) {
        if (c.kind === 'coincident') {
          expect(copyIds.has(c.a.entityId) && copyIds.has(c.b.entityId)).toBe(true)
        }
      }
      const addedDims = dimensions.slice(2)
      expect(addedDims).toHaveLength(2)
      expect(addedDims[0].value).toBe(op === 'scale' ? 80 : W)
      expect(r.copied).toBe(true)
      await solvesInPlace(sketchOf(r.transform))
    })
  }
})

describe('WO-1568 click machine', () => {
  const doc = rectDoc()
  const ctx = { entities: doc.entities, constraints: doc.constraints, dimensions: doc.dimensions }

  it('pre-selection seeds an open set; Confirm closes it; base + destination place the move; Esc steps back', () => {
    let s = armToolWithSelection(IDLE_TOOL_STATE, 'move', RECT, doc.entities)
    expect(s.chain).toMatchObject({ kind: 'transform', op: 'move', ids: RECT, seeded: true, confirmed: false })
    s = confirmToolStep(s)!
    expect(toolStepStatus(s)!.step.id).toBe('base')
    s = toolClick(s, { x: 0, y: 0 }, 0.5, newId, ctx).state
    expect(toolStepStatus(s)!.step.id).toBe('destination')
    // Ghost follows the cursor before the destination click.
    const ghost = transformPreviewEntities(s.chain as TransformChainState, doc.entities, { x: 7, y: 0 })!
    expect((ghost[0] as SketchLineEntity).start).toEqual({ x: 7, y: 0 })
    s = toolClick(s, { x: 10, y: 5 }, 0.5, newId, ctx).state
    expect(s.chain).toMatchObject({ dx: 10, dy: 5 })
    const status = toolStepStatus(s)!
    expect(status.step.id).toBe('confirm')
    expect(status.confirmable).toBe(true)
    const model = confirmOverlayModel(s, ctx)!
    expect(model.title).toBe('Move')
    expect(model.fields.map((f) => [f.id, f.value])).toEqual([['move-dx', 10], ['move-dy', 5]])
    expect(model.toggles).toEqual([{ id: 'keep-original', label: 'Keep original', checked: false }])
    expect(model.info).toBe('4 entities - releases 1 tie to outside geometry')
    s = escapeTool(s).state
    expect(s.chain).toMatchObject({ ref: null })
    expect(confirmOverlayModel(s, ctx)).toBeNull()
  })

  it('rotate reads the angle from the reference and target directions', () => {
    let s = armToolWithSelection(IDLE_TOOL_STATE, 'rotate', RECT, doc.entities)
    s = confirmToolStep(s)!
    for (const p of [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]) {
      s = toolClick(s, p, 0.5, newId, ctx).state
    }
    expect(s.chain).toMatchObject({ angleDeg: 90 })
    expect(confirmOverlayModel(s, ctx)!.fields).toMatchObject([{ id: 'rotate-angle', value: 90, unit: 'deg' }])
  })

  it('scale opens the overlay after the base point; two clicks set the factor', () => {
    let s = armToolWithSelection(IDLE_TOOL_STATE, 'scale', RECT, doc.entities)
    s = confirmToolStep(s)!
    s = toolClick(s, { x: 0, y: 0 }, 0.5, newId, ctx).state
    expect(confirmOverlayModel(s, ctx)!.fields).toMatchObject([{ id: 'scale-factor', value: 1 }])
    s = toolClick(s, { x: 10, y: 0 }, 0.5, newId, ctx).state
    s = toolClick(s, { x: 25, y: 0 }, 0.5, newId, ctx).state
    expect(s.chain).toMatchObject({ factor: 2.5 })
  })

  it('set-phase clicks toggle members and never pick the injected origin axes', () => {
    let s = toolClick({ tool: 'move', chain: null }, { x: 20, y: 0 }, 0.5, newId, ctx).state
    expect(s.chain).toMatchObject({ ids: ['l1'] })
    s = toolClick(s, { x: 20, y: 0 }, 0.5, newId, ctx).state
    expect(s.chain).toMatchObject({ ids: [] })
  })
})

// ---- Part 2: through the sketcher's own click path --------------------------------------

let useCamStore: typeof import('../../store').useCamStore
let sketcherTools: typeof import('../../lib/sketch/sketcher').sketcherTools
let sketcherToolStore: typeof import('../../lib/sketch/sketcher').sketcherToolStore

beforeAll(async () => {
  // The store import binds the CAM document sink into the package (module-load side effect).
  ;({ useCamStore } = await import('../../store'))
  ;({ sketcherTools, sketcherToolStore } = await import('../../lib/sketch/sketcher'))
})

beforeEach(() => {
  useCamStore?.setState({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchHistory: [],
    projectHistory: [],
    canUndo: false,
  })
  sketcherToolStore?.__reset()
})

const idle = (ms = 80) => new Promise((r) => setTimeout(r, ms))
const state = () => useCamStore.getState()
const sketch = () => state().activeSketch!
const click = (x: number, y: number) => sketcherTools.click({ x, y }, 0.5, null, false)
// The rectangle tool also draws a construction diagonal and centre point;
// the four edges are the non-construction lines.
const userLines = () =>
  sketch().entities.filter((e): e is SketchLineEntity =>
    e.kind === 'line' && !e.construction && !isInjectedSketchAnchorId(e.id))

/** A 40 x 20 rectangle drawn with the rectangle tool, plus width/height dimensions. */
async function drawDimensionedRect(): Promise<{ bottom: SketchLineEntity; right: SketchLineEntity }> {
  state().startNewSketch()
  sketcherTools.armTool('rect-corner')
  click(0, 0)
  click(W, H)
  sketcherTools.armTool('select')
  await idle()
  const lines = userLines()
  expect(lines).toHaveLength(4)
  const bottom = lines.find((l) => l.start.y === 0 && l.end.y === 0)!
  const right = lines.find((l) => l.start.x === W && l.end.x === W)!
  useCamStore.setState((st) => ({
    activeSketch: {
      ...st.activeSketch!,
      dimensions: [
        { id: 'dim-w', kind: 'distance', driving: true, value: W, a: ref(bottom.id, 'start'), b: ref(bottom.id, 'end') },
        { id: 'dim-h', kind: 'distance', driving: true, value: H, a: ref(right.id, 'start'), b: ref(right.id, 'end') },
      ],
    },
  }))
  return { bottom, right }
}

const internalKinds = () =>
  sketch().constraints
    .filter((c) => c.kind !== 'fix')
    .map((c) => c.kind)
    .sort()

/** Box-select the whole rectangle (edges, diagonal, centre point), arm, Confirm the set. */
function selectRectAndArm(tool: 'move' | 'rotate' | 'scale'): void {
  state().setSketchSelection(
    sketch().entities.filter((e) => !isInjectedSketchAnchorId(e.id)).map((e) => e.id))
  sketcherTools.armTool(tool)
  sketcherTools.end() // Confirm closes the seeded set
}

describe('WO-1568 through the sketcher click path', () => {
  it('Move: a constrained rectangle moved by (10, 5) keeps its coincidents and dimensions; one Undo restores it', async () => {
    const { bottom } = await drawDimensionedRect()
    const before = sketch()
    const kindsBefore = internalKinds()
    selectRectAndArm('move')
    click(0, 0)
    click(10, 5)
    const s = sketcherToolStore.getState()
    const model = confirmOverlayModel({ tool: s.tool, chain: s.chain }, sketch())!
    expect(model.fields.map((f) => f.value)).toEqual([10, 5])
    sketcherTools.end() // Enter = OK
    await idle()
    const moved = lineOf(sketch().entities, bottom.id)
    expect(moved.start).toEqual({ x: 10, y: 5 })
    expect(moved.end).toEqual({ x: 50, y: 5 })
    expect(kindsBefore.filter((k) => k === 'coincident').length).toBeGreaterThanOrEqual(4)
    expect(internalKinds()).toEqual(kindsBefore)
    expect(sketch().dimensions).toEqual(before.dimensions)
    expect(sketcherToolStore.getState().chain).toBeNull()
    state().undo()
    await idle()
    expect(lineOf(sketch().entities, bottom.id).start).toEqual({ x: 0, y: 0 })
    expect(sketch().entities).toEqual(before.entities)
  })

  it('Rotate: 90 deg about its corner, H/V agree with the geometry and the sketch solves; one Undo restores it', async () => {
    const { bottom } = await drawDimensionedRect()
    const before = sketch()
    selectRectAndArm('rotate')
    click(0, 0)   // centre
    click(10, 0)  // reference direction
    click(0, 10)  // target direction
    sketcherTools.end()
    await idle()
    const rotated = lineOf(sketch().entities, bottom.id)
    expect(rotated.end).toEqual({ x: 0, y: W })
    const hv = sketch().constraints.filter((c) => c.kind === 'horizontal' || c.kind === 'vertical')
    expect(hv).toHaveLength(4)
    for (const c of hv) {
      if (!('line' in c) || !c.line) continue
      const l = lineOf(sketch().entities, c.line)
      if (c.kind === 'horizontal') expect(l.start.y).toBeCloseTo(l.end.y, 9)
      else expect(l.start.x).toBeCloseTo(l.end.x, 9)
    }
    const solved = await solvesInPlace(sketch())
    expect(lineOf(solved, bottom.id).end.y).toBeCloseTo(W, 6)
    expect(len(lineOf(solved, bottom.id))).toBeCloseTo(W, 6)
    state().undo()
    await idle()
    expect(sketch().entities).toEqual(before.entities)
    expect(sketch().constraints).toEqual(before.constraints)
  })

  it('Scale: x2 about its corner, the 40 mm width dimension reads 80; one Undo restores 40', async () => {
    await drawDimensionedRect()
    selectRectAndArm('scale')
    click(0, 0)
    sketcherTools.setTransformValue('factor', 2) // typed in the overlay
    sketcherTools.end()
    await idle()
    expect(sketch().dimensions.find((d) => d.id === 'dim-w')!.value).toBe(80)
    expect(sketch().dimensions.find((d) => d.id === 'dim-h')!.value).toBe(40)
    state().undo()
    await idle()
    expect(sketch().dimensions.find((d) => d.id === 'dim-w')!.value).toBe(40)
  })

  for (const tool of ['move', 'rotate', 'scale'] as const) {
    it(`${tool} with Keep original: the original stays and a copy is added; one Undo removes the copy`, async () => {
      await drawDimensionedRect()
      const before = sketch()
      selectRectAndArm(tool)
      click(0, 0)
      if (tool === 'move') click(60, 0)
      if (tool === 'rotate') { click(10, 0); click(0, 10) }
      if (tool === 'scale') sketcherTools.setTransformValue('factor', 2)
      sketcherTools.setTransformKeepOriginal(true)
      const s = sketcherToolStore.getState()
      expect(confirmOverlayModel({ tool: s.tool, chain: s.chain }, sketch())!.toggles![0].checked).toBe(true)
      sketcherTools.end()
      await idle()
      expect(sketch().entities.slice(0, before.entities.length)).toEqual(before.entities)
      expect(userLines()).toHaveLength(8)
      // WO-2784 RE-PIN: WO-2616 (4d60c51a8a, landed 5211ea829b, owner 10-06: "we should maintain
      // the math that defined them") made a Keep original copy a DEPENDENT member of a 'transform'
      // pattern: transformApply keeps doc.dimensions/doc.constraints and records the copy in
      // Sketch.patterns, and the copy's size/shape follows the source through that definition
      // (dependentDimensionRouting.ts). Duplicating the source's dimensions onto the copy (the
      // old 4) would now constrain the copy twice. So: the original dimensions are kept exactly,
      // and every copy is pinned to its source by one transform pattern.
      expect(sketch().dimensions).toEqual(before.dimensions)
      const beforeIds = new Set(before.entities.map((e) => e.id))
      const copyIds = sketch().entities.filter((e) => !beforeIds.has(e.id)).map((e) => e.id).sort()
      const added = (sketch().patterns ?? []).slice((before.patterns ?? []).length)
      expect(added).toHaveLength(1)
      expect(added[0].values.kind).toBe('transform')
      expect(added[0].members.map((m) => m.id).sort()).toEqual(copyIds)
      for (const m of added[0].members) expect(beforeIds.has(m.sourceId)).toBe(true)
      state().undo()
      await idle()
      expect(sketch().entities).toEqual(before.entities)
      expect(sketch().dimensions).toEqual(before.dimensions)
      expect(sketch().patterns ?? []).toEqual(before.patterns ?? [])
    })
  }
})
