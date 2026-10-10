// @vitest-environment jsdom
//
// WO-1463 (BUG-442, family K7): editing a circle's/arc's diameter or radius
// to zero or a negative value must be REFUSED with a notice naming the reason
// -- the prior geometry is kept and the dimension editor stays open for
// correction -- instead of collapsing the entity onto its center.
//
// The shared cause was an incomplete guard list in commitDimensionValue:
// focusDistance and arcLength each already had a `!(value > 0)` floor; radius
// and diameter flowed straight to gcsMapping's mapDimension as raw
// circle_radius / arc_radius / circle_diameter / arc_diameter primitives.
//
// Store integration against the REAL solver: the Worker global is a loopback
// running gcsMapping in-process (same harness as dimValueEdit.test.tsx).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchEntity, SketchDimension } from '../../lib/sketch/types'
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
vi.stubGlobal('Worker', LoopbackWorker)

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(); install an in-memory Storage shim BEFORE importing
// the store (same scaffolding as dimValueEdit.test.tsx).
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

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
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
})

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function circle(id: string, radius: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius }
}
function arc(id: string, radius: number): SketchEntity {
  return {
    id, kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius,
    startAngle: 0, endAngle: Math.PI,
  }
}
function makeSketch(entities: SketchEntity[], dimensions: SketchDimension[] = []): Sketch {
  return { id: 'sk', layerId: 'layer', entities, constraints: [], dimensions, solveStatus: null }
}
function radiusOf(id: string): number {
  const e = useCamStore.getState().activeSketch!.entities.find((x) => x.id === id)
  if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) throw new Error(`${id} not a curve`)
  return e.radius
}
function dimValue(id: string): number {
  return useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === id)!.value
}

describe('WO-1463: non-positive radius/diameter edits are refused, geometry kept', () => {
  it('a circle diameter edited to 0 is refused, the 100mm circle stays intact, editor stays open', async () => {
    // The exact BUG-442 repro: a valid 100mm-diameter circle (radius 50).
    useCamStore.getState().setActiveSketch(makeSketch(
      [circle('c', 50)],
      [{ id: 'dia', kind: 'diameter', entityId: 'c', driving: true, value: 100 }],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    expect(radiusOf('c')).toBeCloseTo(50, 6)

    useCamStore.getState().openDimensionEditor('dia')
    useCamStore.getState().commitDimensionValue('dia', 0)

    expect(useCamStore.getState().sketchNotice).toContain('greater than zero')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'dia', isNew: false })
    expect(dimValue('dia')).toBe(100)
    expect(radiusOf('c')).toBeCloseTo(50, 6)
  })

  it('a negative circle diameter is refused too', async () => {
    useCamStore.getState().setActiveSketch(makeSketch(
      [circle('c', 50)],
      [{ id: 'dia', kind: 'diameter', entityId: 'c', driving: true, value: 100 }],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().openDimensionEditor('dia')
    useCamStore.getState().commitDimensionValue('dia', -10)

    expect(useCamStore.getState().sketchNotice).toContain('greater than zero')
    expect(radiusOf('c')).toBeCloseTo(50, 6)
  })

  it('a circle radius edited to 0 is refused; a positive edit still applies exactly', async () => {
    useCamStore.getState().setActiveSketch(makeSketch(
      [circle('c', 50)],
      [{ id: 'rad', kind: 'radius', entityId: 'c', driving: true, value: 50 }],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().openDimensionEditor('rad')
    useCamStore.getState().commitDimensionValue('rad', 0)
    expect(useCamStore.getState().sketchNotice).toContain(
      'Radius dimension: radius must be greater than zero')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'rad', isNew: false })
    expect(radiusOf('c')).toBeCloseTo(50, 6)

    // Acceptance 3: a legitimate positive edit applies exactly as today.
    useCamStore.getState().commitDimensionValue('rad', 30)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => Math.abs(radiusOf('c') - 30) < 1e-6, 'radius 50 -> 30')
    expect(dimValue('rad')).toBe(30)
  })

  it('an arc radius and an arc diameter both refuse a non-positive edit', async () => {
    useCamStore.getState().setActiveSketch(makeSketch(
      [arc('a', 20)],
      [
        { id: 'ar-rad', kind: 'radius', entityId: 'a', driving: true, value: 20 },
        { id: 'ar-dia', kind: 'diameter', entityId: 'a', driving: true, value: 40 },
      ],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().openDimensionEditor('ar-rad')
    useCamStore.getState().commitDimensionValue('ar-rad', 0)
    expect(useCamStore.getState().sketchNotice).toContain(
      'Radius dimension: radius must be greater than zero')
    expect(radiusOf('a')).toBeCloseTo(20, 6)

    useCamStore.getState().openDimensionEditor('ar-dia')
    useCamStore.getState().commitDimensionValue('ar-dia', -5)
    expect(useCamStore.getState().sketchNotice).toContain(
      'Diameter dimension: diameter must be greater than zero')
    expect(radiusOf('a')).toBeCloseTo(20, 6)
  })

  it('a legitimate positive diameter edit applies exactly (circle 100mm -> 60mm)', async () => {
    useCamStore.getState().setActiveSketch(makeSketch(
      [circle('c', 50)],
      [{ id: 'dia', kind: 'diameter', entityId: 'c', driving: true, value: 100 }],
    ))
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')

    useCamStore.getState().openDimensionEditor('dia')
    useCamStore.getState().commitDimensionValue('dia', 60)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await waitUntil(() => Math.abs(radiusOf('c') - 30) < 1e-6, 'diameter 100 -> 60 (radius 50 -> 30)')
    expect(dimValue('dia')).toBe(60)
  })
})
