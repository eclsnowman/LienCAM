// @vitest-environment jsdom
// WO-1868: an angle dimension from three points, or an arc's included angle.
//
// Every claim runs through the application's own entry points: the smart-
// dimension click machine (dimToolClick) picks the operands, the placement
// resolver chooses the sector, the real planegcs solver drives the value, and
// the store (addDimension / undo / save / load) carries it. Hand-built dims are
// used only as the negative control.

import { describe, it, expect, vi } from 'vitest'
import {
  dimToolClick, measureDimension, formatDimensionValue, signedAngleEditValue,
  planDimension, type DimChainState,
} from '../../lib/sketch/tools/dimTool'
import { dimensionRefIds } from '../../lib/sketch/refIds'
import { flattenBlockToWorld } from '../../lib/sketch/blocks'
import { dimensionDisplay } from '../../lib/sketch/sketcher/sketchLayer'
import { mapDimensionRefs } from '../../lib/sketch/tools/trimTool'
import {
  sketchToGcsPrimitives, solveSketchOnWrapper,
} from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import type {
  Sketch, SketchBlockEntity, SketchConstraint, SketchDimension, SketchEntity,
  SketchLineEntity, SketchArcEntity, PointRef, Vec2, Angle3Dimension,
} from '../../lib/sketch/types'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

let n = 0
const newId = () => `wo1868-${n++}`

const L1_LEN = 10
const L2_LEN = 10

/** Two lines meeting at the origin, the second 35 degrees above the first.
 *  L1 is fully pinned; L2 is pinned at the vertex with a driven length, so its
 *  ONLY freedom is rotation about the vertex -- what the angle governs. */
function twoLines(): Sketch {
  const entities: SketchEntity[] = [
    { id: 'L1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: L1_LEN, y: 0 } },
    { id: 'L2', kind: 'line', construction: false, start: { x: 0, y: 0 },
      end: { x: L2_LEN * Math.cos(rad(35)), y: L2_LEN * Math.sin(rad(35)) } },
  ]
  const constraints: SketchConstraint[] = [
    { id: 'f1s', kind: 'fix', point: { entityId: 'L1', site: 'start' } },
    { id: 'f1e', kind: 'fix', point: { entityId: 'L1', site: 'end' } },
    { id: 'f2s', kind: 'fix', point: { entityId: 'L2', site: 'start' } },
  ]
  const dimensions: SketchDimension[] = [
    { id: 'len2', kind: 'distance', driving: true, value: L2_LEN,
      a: { entityId: 'L2', site: 'start' }, b: { entityId: 'L2', site: 'end' } },
  ]
  return { id: 'wo1868-lines', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
}

function pointAt(sk: Sketch, ref: PointRef): Vec2 {
  const e = sk.entities.find((x) => x.id === ref.entityId)!
  if (e.kind === 'line') return ref.site === 'start' ? e.start : e.end
  if (e.kind === 'arc') {
    if (ref.site === 'center') return e.center
    const a = ref.site === 'start' ? e.startAngle : e.endAngle
    return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) }
  }
  throw new Error('unexpected entity')
}

/** Drive the REAL click machine: three explicit point picks, then a placement
 *  click in open space at `place`. */
function pickThree(sk: Sketch, refs: [PointRef, PointRef, PointRef], place: Vec2): SketchDimension {
  let chain: DimChainState | null = null
  for (const ref of refs) {
    const at = pointAt(sk, ref)
    const out = dimToolClick(chain, at, 0.5, sk.entities, newId, { point: at, ref })
    expect(out.notice, `picking ${ref.entityId}:${ref.site} is accepted`).toBeNull()
    expect(out.dimension).toBeNull()
    chain = out.chain
  }
  const done = dimToolClick(chain, place, 0.5, sk.entities, newId, null)
  expect(done.notice).toBeNull()
  expect(done.dimension, 'the placement click commits the angle').not.toBeNull()
  return done.dimension!
}

const V1 = { entityId: 'L1', site: 'start' } as const
const A1 = { entityId: 'L1', site: 'end' } as const
const B2 = { entityId: 'L2', site: 'end' } as const

async function withWrapper<T>(fn: (w: GcsWrapper) => T | Promise<T>): Promise<T> {
  const wrapper = await createGcsWrapper()
  try { return await fn(wrapper) } finally { wrapper.destroy_gcs_module() }
}

function solved(w: GcsWrapper, sk: Sketch) {
  const out = solveSketchOnWrapper(w, sk)
  expect(out.ok, 'the sketch solves').toBe(true)
  if (!out.ok) throw new Error(out.message)
  return out
}

function line(entities: readonly SketchEntity[], id: string): SketchLineEntity {
  return entities.find((e) => e.id === id) as SketchLineEntity
}
function arcOf(entities: readonly SketchEntity[], id: string): SketchArcEntity {
  return entities.find((e) => e.id === id) as SketchArcEntity
}

describe('WO-1868: vertex + a point on each leg', () => {
  it('reads 35 degrees from three picks, and no leg has to be a whole line entity pick', () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 })
    expect(dim.kind).toBe('angle3')
    expect(dim.driving).toBe(true)
    expect(deg(dim.value)).toBeCloseTo(35, 6)
    expect(formatDimensionValue(dim.kind, dim.value, true)).toBe('35.0 deg')
    expect(measureDimension(sk.entities, dim)).toBeCloseTo(dim.value, 9)
    expect(dimensionRefIds(dim).sort()).toEqual(['L1', 'L1', 'L2'])
  })

  it('typing 50 rotates exactly one leg about the vertex and removes one degree of freedom', async () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 })
    const typed: SketchDimension = { ...dim, value: signedAngleEditValue(dim, rad(50)) }
    await withWrapper((w) => {
      const before = solved(w, sk)
      const after = solved(w, { ...sk, dimensions: [...sk.dimensions, typed] })
      const l2 = line(after.entities, 'L2')
      expect(deg(Math.atan2(l2.end.y, l2.end.x))).toBeCloseTo(50, 4)
      expect(Math.hypot(l2.end.x, l2.end.y)).toBeCloseTo(L2_LEN, 6)
      // Nothing else moves.
      expect(line(after.entities, 'L1')).toEqual(line(sk.entities, 'L1'))
      expect(l2.start).toEqual({ x: 0, y: 0 })
      expect(before.status.dof - after.status.dof).toBe(1)
      expect(after.status.dof).toBe(0)
      // Driving holds through a re-solve.
      const again = solved(w, { ...sk, entities: after.entities, dimensions: [...sk.dimensions, typed] })
      const l2b = line(again.entities, 'L2')
      expect(deg(Math.atan2(l2b.end.y, l2b.end.x))).toBeCloseTo(50, 4)
    })
  })

  it('NEGATIVE CONTROL: with the vertex operand pointed elsewhere, typing 50 no longer gives 50', async () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 }) as Angle3Dimension
    // Emulates dropping the vertex from the solver mapping: the pivot becomes
    // the far end of L1 instead of the shared vertex.
    const broken: Angle3Dimension = { ...dim, value: rad(50), vertex: A1 }
    const good: Angle3Dimension = { ...dim, value: rad(50) }
    await withWrapper((w) => {
      const okOut = solved(w, { ...sk, dimensions: [...sk.dimensions, good] })
      const l2 = line(okOut.entities, 'L2')
      expect(deg(Math.atan2(l2.end.y, l2.end.x))).toBeCloseTo(50, 4)
      const bad = solveSketchOnWrapper(w, { ...sk, dimensions: [...sk.dimensions, broken] })
      if (bad.ok) {
        const b2 = line(bad.entities, 'L2')
        expect(Math.abs(deg(Math.atan2(b2.end.y, b2.end.x)) - 50)).toBeGreaterThan(1)
      } else {
        expect(bad.ok).toBe(false)
      }
    })
  })

  it('maps to l2l_angle_pppp from vertex->a to vertex->b (vertex is an operand)', () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 })
    const prims = sketchToGcsPrimitives({ ...sk, dimensions: [...sk.dimensions, dim] })
    const p = prims.find((x) => x.id === dim.id) as unknown as Record<string, string | number>
    expect(p.type).toBe('l2l_angle_pppp')
    expect(p.l1p1_id).toBe('L1:start')
    expect(p.l1p2_id).toBe('L1:end')
    expect(p.l2p1_id).toBe('L1:start')
    expect(p.l2p2_id).toBe('L2:end')
  })
})

describe('WO-1868: the picks are any addressable point sites', () => {
  // A line and an arc meeting at the vertex (0,0). The arc's center sits 5 mm
  // above the vertex, so the legs are: line far end (+X) and the arc's center
  // (+Y) -- 90 degrees, and neither leg is a whole line.
  function lineAndArc(): Sketch {
    const entities: SketchEntity[] = [
      { id: 'L', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'A', kind: 'arc', construction: false, center: { x: 0, y: 5 }, radius: 5,
        startAngle: -Math.PI / 2, endAngle: 0 },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'fLs', kind: 'fix', point: { entityId: 'L', site: 'start' } },
      { id: 'fLe', kind: 'fix', point: { entityId: 'L', site: 'end' } },
      { id: 'co', kind: 'coincident', a: { entityId: 'A', site: 'start' }, b: { entityId: 'L', site: 'start' } },
    ]
    const dimensions: SketchDimension[] = [
      { id: 'r', kind: 'radius', driving: true, value: 5, entityId: 'A' },
    ]
    return { id: 'wo1868-la', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
  }

  it('vertex at the shared endpoint, legs at the line far end and the arc center: 90, drives to 60, holds on re-solve', async () => {
    const sk = lineAndArc()
    const dim = pickThree(sk,
      [{ entityId: 'L', site: 'start' }, { entityId: 'L', site: 'end' }, { entityId: 'A', site: 'center' }],
      { x: 3, y: 3 })
    expect(dim.kind).toBe('angle3')
    expect(deg(dim.value)).toBeCloseTo(90, 6)
    const typed: SketchDimension = { ...dim, value: signedAngleEditValue(dim, rad(60)) }
    await withWrapper((w) => {
      const first = solved(w, { ...sk, dimensions: [...sk.dimensions, typed] })
      const a = arcOf(first.entities, 'A')
      expect(deg(Math.atan2(a.center.y, a.center.x))).toBeCloseTo(60, 3)
      expect(a.radius).toBeCloseTo(5, 6)
      const second = solved(w, { ...sk, entities: first.entities, dimensions: [...sk.dimensions, typed] })
      const a2 = arcOf(second.entities, 'A')
      expect(a2.center.x).toBeCloseTo(a.center.x, 6)
      expect(a2.center.y).toBeCloseTo(a.center.y, 6)
    })
  })

  it('the arc far endpoint works as a leg too', () => {
    const sk = lineAndArc()
    const dim = pickThree(sk,
      [{ entityId: 'L', site: 'start' }, { entityId: 'L', site: 'end' }, { entityId: 'A', site: 'end' }],
      { x: 3, y: 2 })
    // The arc end is (5,5): 45 degrees from +X about the vertex.
    expect(deg(dim.value)).toBeCloseTo(45, 6)
  })

  it('refuses degenerate picks by name: a repeated point, a zero-length leg, two legs on one line', () => {
    const sk = lineAndArc()
    const same = planDimension(sk.entities, [
      { entityId: 'L', site: 'start' }, { entityId: 'L', site: 'end' }, { entityId: 'L', site: 'end' }])
    expect(same.ok).toBe(false)
    const zero = planDimension(sk.entities, [
      { entityId: 'L', site: 'start' }, { entityId: 'L', site: 'end' }, { entityId: 'A', site: 'start' }])
    expect(zero.ok).toBe(false)
    const collinear = planDimension(twoLines().entities, [
      { entityId: 'L1', site: 'start' }, { entityId: 'L1', site: 'end' },
      { entityId: 'L1', site: 'center' as never }])
    expect(collinear.ok).toBe(false)
  })
})

describe("WO-1868: an arc's included angle", () => {
  function arcSketch(sweepDeg: number): Sketch {
    const entities: SketchEntity[] = [
      { id: 'A', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: 10,
        startAngle: 0, endAngle: rad(sweepDeg) },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'fc', kind: 'fix', point: { entityId: 'A', site: 'center' } },
      { id: 'fs', kind: 'fix', point: { entityId: 'A', site: 'start' } },
    ]
    return { id: 'wo1868-arc', layerId: 'layer', entities, constraints, dimensions: [], solveStatus: null }
  }

  /** Pick the arc alone (its whole body, twice), then place. */
  function pickArc(sk: Sketch): SketchDimension {
    const onArc: Vec2 = { x: 10, y: 0.01 }
    const first = dimToolClick(null, onArc, 0.5, sk.entities, newId, null)
    expect(first.chain).not.toBeNull()
    const second = dimToolClick(first.chain, onArc, 0.5, sk.entities, newId, null)
    expect(second.notice, 'the second pick of the same arc is accepted').toBeNull()
    const done = dimToolClick(second.chain, { x: 12, y: 12 }, 0.5, sk.entities, newId, null)
    expect(done.dimension).not.toBeNull()
    return done.dimension!
  }

  it('a 90-degree arc reads 90 and typing 120 resweeps it about its own center, start and radius unchanged', async () => {
    const sk = arcSketch(90)
    const dim = pickArc(sk)
    expect(dim.kind).toBe('angle3')
    expect(deg(dim.value)).toBeCloseTo(90, 6)
    expect(formatDimensionValue(dim.kind, dim.value, true)).toBe('90.0 deg')
    const typed: SketchDimension = { ...dim, value: signedAngleEditValue(dim, rad(120)) }
    await withWrapper((w) => {
      const out = solved(w, { ...sk, dimensions: [typed] })
      const a = arcOf(out.entities, 'A')
      expect(a.center.x).toBeCloseTo(0, 6)
      expect(a.center.y).toBeCloseTo(0, 6)
      expect(a.radius).toBeCloseTo(10, 6)
      expect(deg(a.startAngle)).toBeCloseTo(0, 4)
      let sweep = a.endAngle - a.startAngle
      while (sweep <= 0) sweep += 2 * Math.PI
      expect(deg(sweep)).toBeCloseTo(120, 3)
    })
  })

  it('a 270-degree arc reads 270 (not the near-sector 90) and commits with no motion', async () => {
    const sk = arcSketch(270)
    const dim = pickArc(sk)
    expect(deg(dim.value)).toBeCloseTo(270, 6)
    expect(formatDimensionValue(dim.kind, dim.value, true)).toBe('270.0 deg')
    await withWrapper((w) => {
      const out = solved(w, { ...sk, dimensions: [dim] })
      const a = arcOf(out.entities, 'A')
      expect(deg(a.endAngle - a.startAngle)).toBeCloseTo(270, 3)
      // and the reference re-measure agrees
      expect(deg(measureDimension(out.entities, dim)!)).toBeCloseTo(270, 3)
    })
  })
})

describe('WO-1868: the far sector commits the obtuse reading without moving anything', () => {
  it('a click in the far sector stores the reversed-leg value, the label reads the positive sweep, nothing moves', async () => {
    const sk = twoLines()
    // Anchor at 100 degrees about the vertex: the obtuse (35..180) sector.
    const far = pickThree(sk, [V1, A1, B2], { x: 5 * Math.cos(rad(100)), y: 5 * Math.sin(rad(100)) }) as Angle3Dimension
    expect(far.reverseB).toBe(true)
    expect(deg(far.value)).toBeCloseTo(-145, 6)
    expect(formatDimensionValue(far.kind, far.value, true)).toBe('145.0 deg')
    await withWrapper((w) => {
      const out = solved(w, { ...sk, dimensions: [...sk.dimensions, far] })
      const l2 = line(out.entities, 'L2')
      expect(l2.end.x).toBeCloseTo(line(sk.entities, 'L2').end.x, 6)
      expect(l2.end.y).toBeCloseTo(line(sk.entities, 'L2').end.y, 6)
      // Typing 120 keeps the sector: the leg lands at 60 degrees, never the mirror.
      const typed: Angle3Dimension = { ...far, value: signedAngleEditValue(far, rad(120)) }
      const edited = solved(w, { ...sk, dimensions: [...sk.dimensions, typed] })
      const e2 = line(edited.entities, 'L2')
      expect(deg(Math.atan2(e2.end.y, e2.end.x))).toBeCloseTo(60, 3)
      // The reference remeasure keeps the far reading.
      expect(deg(measureDimension(edited.entities, typed)!)).toBeCloseTo(-120, 3)
    })
  })

  it('the near sector click stays near (35, reverseB off)', () => {
    const sk = twoLines()
    const near = pickThree(sk, [V1, A1, B2], { x: 5 * Math.cos(rad(17)), y: 5 * Math.sin(rad(17)) }) as Angle3Dimension
    expect(near.reverseB ?? false).toBe(false)
    expect(deg(near.value)).toBeCloseTo(35, 6)
  })
})

describe('WO-1868: display, repair and re-ID', () => {
  it('draws a label at its default place with no stored anchor', () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 })
    const { labelAnchor: _drop, ...bare } = dim
    const disp = dimensionDisplay(sk, bare as SketchDimension)
    expect(disp?.text).toBe('35.0 deg')
  })

  it('a cut that kills any of its three point refs removes the dimension; a survivor keeps it', () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 })
    const keep = mapDimensionRefs(dim, (r: PointRef) => r)
    expect(keep).not.toBeNull()
    const drop = mapDimensionRefs(dim, (r: PointRef) => (r.entityId === 'L2' ? null : r))
    expect(drop).toBeNull()
  })

  it('a copied block re-IDs all three refs and the copy still solves to the same angle', async () => {
    const sk = twoLines()
    const dim = pickThree(sk, [V1, A1, B2], { x: 8, y: 2 })
    const block: SketchBlockEntity = {
      id: 'blk', kind: 'block', construction: false,
      origin: { x: 0, y: 0 }, rotation: 0, scale: 1,
      members: {
        entities: sk.entities.map((e) => ({ ...e })),
        constraints: sk.constraints.map((c) => ({ ...c })),
        dimensions: [...sk.dimensions, dim].map((d) => ({ ...d })),
      },
    }
    const copy = flattenBlockToWorld(block, undefined, true)
    const copied = copy.dimensions.find((d) => d.kind === 'angle3') as Angle3Dimension
    expect(copied).toBeTruthy()
    for (const r of [copied.vertex, copied.a, copied.b]) {
      expect(r.entityId).not.toBe('L1')
      expect(r.entityId).not.toBe('L2')
      expect(copy.entities.some((e) => e.id === r.entityId)).toBe(true)
    }
    await withWrapper((w) => {
      const out = solved(w, { ...sk, entities: copy.entities, constraints: copy.constraints, dimensions: copy.dimensions })
      expect(measureDimension(out.entities, copied)).toBeCloseTo(copied.value, 6)
    })
  })
})

// ---- Store integration: undo and save/reload --------------------------------

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

async function saveToJson(store: Store): Promise<string> {
  let captured: Blob | null = null
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  URL.createObjectURL = ((b: Blob) => { captured = b; return 'blob:wo1868' }) as typeof URL.createObjectURL
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

describe('WO-1868: undo and save/reload through the application store', () => {
  async function author(store: Store): Promise<{ layerId: string; placed: SketchDimension }> {
    store.getState().setViewerMode('sketch')
    const sk = twoLines()
    for (const e of sk.entities) store.getState().addEntity({ ...e })
    const placed = pickThree(sk, [V1, A1, B2], { x: 5 * Math.cos(rad(100)), y: 5 * Math.sin(rad(100)) })
    store.getState().addDimension({ ...placed })
    return { layerId: store.getState().activeSketch!.layerId, placed }
  }

  it('one undo removes the angle placement as one action', async () => {
    const store = await freshStore()
    const { placed } = await author(store)
    expect(store.getState().activeSketch!.dimensions.some((d) => d.id === placed.id)).toBe(true)
    store.getState().undo()
    expect(store.getState().activeSketch!.dimensions.some((d) => d.id === placed.id)).toBe(false)
  })

  it('reloads from a saved project with the same refs, value, sector and label placement', async () => {
    const store = await freshStore()
    const { layerId, placed } = await author(store)
    store.getState().finishSketch()
    const json = await saveToJson(store)

    const reloaded = await freshStore()
    await reloaded.getState().loadProjectFromFile(json)
    const owner = reloaded.getState().project.geometry
      .find((g) => g.sketches?.some((s) => s.layerId === layerId))
    expect(owner).toBeTruthy()
    expect(reloaded.getState().openSketchForLayer(layerId, owner!.id)).toBe(true)
    const after = reloaded.getState().activeSketch!.dimensions.find((d) => d.id === placed.id)
    expect({ ...after }).toEqual({ ...placed })
    expect((after as Angle3Dimension).reverseB).toBe(true)
  })
})
