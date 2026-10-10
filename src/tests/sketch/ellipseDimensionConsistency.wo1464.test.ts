// WO-1464 (BUG-492, family K7): an ellipse's majorRadius, minorRadius and
// focusDistance dimensions are ONE system. An ellipse has two shape numbers:
//
//   driving shape dims after the edit | what happens
//   0, 1 or 2                         | apply; geometry follows, never refused
//   a 3rd is ADDED                    | added as a REFERENCE showing the
//                                     | geometry's value, console line names it
//   a 3rd is toggled to driving       | stays a reference, console line
//   radius <= 0, or a long-axis radius| refused by name -- no ellipse has it
//   not longer than half the 2c       |
//
// Invariant: every ellipse dimension, driving or reference, displays exactly
// the value its entity has (1e-9 relative) after any commit, undo and reload.
//
// Store integration against the REAL solver: the Worker global is a loopback
// running gcsMapping in-process (same harness as dimValueEdit.test.tsx).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { applyInertEllipseDims, solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { measureDimension } from '../../lib/sketch/tools/dimTool'
import type { Sketch, SketchEntity, SketchDimension, SketchEllipseEntity } from '../../lib/sketch/types'
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
let camSketchDocumentPort: typeof import('../../store').camSketchDocumentPort

beforeAll(async () => {
  ;({ useCamStore, camSketchDocumentPort } = await import('../../store'))
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
const solved = () => waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'solve')

function ellipse(id: string, major: number, minor: number): SketchEntity {
  return {
    id, kind: 'ellipse', construction: false,
    center: { x: 0, y: 0 }, majorRadius: major, minorRadius: minor, rotation: 0,
  }
}
function makeSketch(entities: SketchEntity[], dimensions: SketchDimension[] = []): Sketch {
  return { id: 'sk', layerId: 'layer', entities, constraints: [], dimensions, solveStatus: null }
}
const maj = (value: number, driving = true): SketchDimension =>
  ({ id: 'maj', kind: 'majorRadius', entityId: 'el', driving, value })
const min = (value: number, driving = true): SketchDimension =>
  ({ id: 'min', kind: 'minorRadius', entityId: 'el', driving, value })
const foc = (value: number, driving = true): SketchDimension =>
  ({ id: 'foc', kind: 'focusDistance', entityId: 'el', driving, value })

function ellipseOf(id: string): { majorRadius: number; minorRadius: number } {
  const e = useCamStore.getState().activeSketch!.entities.find((x) => x.id === id)
  if (!e || e.kind !== 'ellipse') throw new Error(`${id} not an ellipse`)
  return { majorRadius: e.majorRadius, minorRadius: e.minorRadius }
}
function dimOf(id: string): SketchDimension | undefined {
  return useCamStore.getState().activeSketch!.dimensions.find((d) => d.id === id)
}

/** THE invariant: every ellipse shape dim shows exactly its entity's value. */
function expectEveryEllipseDimAgrees(): void {
  const sk = useCamStore.getState().activeSketch!
  const shapeDims = sk.dimensions.filter((d) =>
    d.kind === 'majorRadius' || d.kind === 'minorRadius' || d.kind === 'focusDistance')
  expect(shapeDims.length).toBeGreaterThan(0)
  for (const d of shapeDims) {
    const measured = measureDimension(sk.entities, d)!
    expect(Math.abs(d.value - measured) / Math.max(1, Math.abs(measured)),
      `${d.id} (${d.kind}, ${d.driving ? 'driving' : 'reference'}) shows ${d.value}, geometry has ${measured}`,
    ).toBeLessThanOrEqual(1e-9)
  }
}

async function open(sketch: Sketch): Promise<void> {
  useCamStore.getState().setActiveSketch(sketch)
  await solved()
}

async function reload(): Promise<void> {
  const saved = JSON.parse(JSON.stringify(useCamStore.getState().activeSketch)) as Sketch
  useCamStore.getState().setActiveSketch(null)
  await open({ ...saved, solveStatus: null })
}

describe('WO-1464: majorRadius/minorRadius/focusDistance are one system', () => {
  // ---- a non-positive radius is refused ----------------------------------

  it('a majorRadius edited to 0 is refused, the ellipse and label stay intact, editor stays open', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [maj(100)]))

    useCamStore.getState().openDimensionEditor('maj')
    useCamStore.getState().commitDimensionValue('maj', 0)

    expect(useCamStore.getState().sketchNotice).toContain(
      'Major radius dimension: major radius must be greater than zero')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'maj', isNew: false })
    expect(dimOf('maj')!.value).toBe(100)
    expect(ellipseOf('el').majorRadius).toBe(100)
    expectEveryEllipseDimAgrees()
  })

  it('a negative minorRadius is refused; a positive edit of a single driving dim still applies', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [min(60)]))

    useCamStore.getState().openDimensionEditor('min')
    useCamStore.getState().commitDimensionValue('min', -5)
    expect(useCamStore.getState().sketchNotice).toContain(
      'Minor radius dimension: minor radius must be greater than zero')
    expect(dimOf('min')!.value).toBe(60)
    expect(ellipseOf('el').minorRadius).toBe(60)

    useCamStore.getState().commitDimensionValue('min', 40)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await solved()
    expect(ellipseOf('el')).toEqual({ majorRadius: 100, minorRadius: 40 })
    expectEveryEllipseDimAgrees()
  })

  // ---- a 3rd driving shape dim is ADDED as a reference --------------------

  it('BUG-492 repro, production placement: a driving focusDistance placed next to driving major+minor lands as a reference', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [maj(100), min(60)]))

    // The dim tool's commit: its own undo step, then a driving focusDistance,
    // pre-filled, editor requested.
    camSketchDocumentPort.beginStep()
    camSketchDocumentPort.append(
      { entities: [], constraints: [], dimensions: [foc(120)] }, [], { openDimensionEditor: true })

    expect(useCamStore.getState().sketchNotice).toBe(
      'Ellipse already has two driving shape dimensions - focus distance added as a reference (160)')
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await solved()
    expect(dimOf('foc')).toMatchObject({ driving: false, value: 160 })
    expect(ellipseOf('el')).toEqual({ majorRadius: 100, minorRadius: 60 })
    expectEveryEllipseDimAgrees()

    // Typing into it is the ordinary reference answer, never a resize.
    useCamStore.getState().commitDimensionValue('foc', 120)
    expect(ellipseOf('el')).toEqual({ majorRadius: 100, minorRadius: 60 })

    // Undo removes the placement; every remaining label still agrees.
    useCamStore.getState().undo()
    await solved()
    expect(dimOf('foc')).toBeUndefined()
    expectEveryEllipseDimAgrees()
  })

  it('addDimension follows the same rule, and the reference tracks the geometry as the driving pair changes', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [maj(100), min(60)]))

    useCamStore.getState().addDimension(foc(120))
    expect(useCamStore.getState().sketchNotice).toContain('focus distance added as a reference (160)')
    expect(dimOf('foc')!.driving).toBe(false)

    useCamStore.getState().commitDimensionValue('min', 80)
    await solved()
    expect(ellipseOf('el')).toEqual({ majorRadius: 100, minorRadius: 80 })
    expect(dimOf('foc')!.value).toBeCloseTo(120, 9) // 2*sqrt(100^2 - 80^2)
    expectEveryEllipseDimAgrees()

    await reload()
    expect(ellipseOf('el')).toEqual({ majorRadius: 100, minorRadius: 80 })
    expectEveryEllipseDimAgrees()
  })

  it('toggling a 3rd shape dim to driving keeps it a reference with a console line', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [maj(100), min(60), foc(160, false)]))

    useCamStore.getState().toggleDimensionDriving('foc')
    expect(useCamStore.getState().sketchNotice).toBe(
      'Ellipse already has two driving shape dimensions - focus distance stays a reference (160)')
    expect(dimOf('foc')!.driving).toBe(false)
    expect(useCamStore.getState().canUndo).toBe(false) // a no-op consumes no undo step
    expectEveryEllipseDimAgrees()
  })

  // ---- two driving shape dims: always applied, labels always agree --------

  it('driving majorRadius + focusDistance: editing 2c keeps the major radius and computes the minor', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [maj(100), foc(160)]))

    useCamStore.getState().commitDimensionValue('foc', 120)
    expect(useCamStore.getState().sketchNotice).toBeNull()
    await solved()
    // main rewrote major to sqrt(60^2+60^2)=84.85 while Rmaj still read 100.
    expect(ellipseOf('el').majorRadius).toBe(100)
    expect(ellipseOf('el').minorRadius).toBeCloseTo(80, 9)
    expectEveryEllipseDimAgrees()

    await reload()
    expect(ellipseOf('el').majorRadius).toBe(100)
    expectEveryEllipseDimAgrees()

    useCamStore.getState().commitDimensionValue('maj', 120)
    await solved()
    expect(ellipseOf('el').minorRadius).toBeCloseTo(Math.sqrt(120 * 120 - 60 * 60), 9)
    expectEveryEllipseDimAgrees()

    useCamStore.getState().undo()
    await solved()
    expect(ellipseOf('el').majorRadius).toBe(100)
    expectEveryEllipseDimAgrees()
  })

  it('driving majorRadius + focusDistance: a major radius not longer than half the 2c is refused by name', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [maj(100), foc(160)]))

    useCamStore.getState().openDimensionEditor('maj')
    useCamStore.getState().commitDimensionValue('maj', 70)
    expect(useCamStore.getState().sketchNotice).toBe(
      'Major radius dimension: major radius 70 is not longer than half the focus distance (80) - ' +
      'no ellipse has that shape')
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'maj', isNew: false })
    expect(dimOf('maj')!.value).toBe(100)
    expect(ellipseOf('el')).toEqual({ majorRadius: 100, minorRadius: 60 })
    expectEveryEllipseDimAgrees()
  })

  it('driving minorRadius + a new driving focusDistance applies (major computed)', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [min(60)]))

    camSketchDocumentPort.append(
      { entities: [], constraints: [], dimensions: [foc(160)] }, [], { openDimensionEditor: true })
    expect(useCamStore.getState().sketchDimEditor).toEqual({ dimId: 'foc', isNew: true })
    await solved()
    useCamStore.getState().commitDimensionValue('foc', 120)
    expect(useCamStore.getState().sketchNotice).toBeNull()
    await solved()
    expect(ellipseOf('el').majorRadius).toBeCloseTo(Math.sqrt(60 * 60 + 60 * 60), 9)
    expect(ellipseOf('el').minorRadius).toBe(60)
    expectEveryEllipseDimAgrees()
  })

  it('driving focusDistance + minorRadius: editing the minor applies and the major follows', async () => {
    await open(makeSketch([ellipse('el', 100, 60)], [foc(160), min(60)]))

    useCamStore.getState().commitDimensionValue('min', 50)
    expect(useCamStore.getState().sketchNotice).toBeNull()
    await solved()
    expect(ellipseOf('el').minorRadius).toBe(50)
    expect(ellipseOf('el').majorRadius).toBeCloseTo(Math.sqrt(80 * 80 + 50 * 50), 9)
    expectEveryEllipseDimAgrees()
  })

  // ---- no regression -------------------------------------------------------

  it('zero focusDistance alone still refuses exactly as before', async () => {
    await open(makeSketch([ellipse('el', 5, 3)], [foc(8)]))

    useCamStore.getState().openDimensionEditor('foc')
    useCamStore.getState().commitDimensionValue('foc', 0)
    expect(useCamStore.getState().sketchNotice).toContain(
      'focus-to-focus distance must be greater than zero')
    expect(dimOf('foc')!.value).toBe(8)
    expect(ellipseOf('el')).toEqual({ majorRadius: 5, minorRadius: 3 })
  })

  it('a single driving majorRadius on an otherwise plain ellipse still applies exactly as today', async () => {
    await open(makeSketch([ellipse('el', 10, 6)], [maj(10)]))

    useCamStore.getState().commitDimensionValue('maj', 25)
    expect(useCamStore.getState().sketchDimEditor).toBeNull()
    await solved()
    expect(ellipseOf('el')).toEqual({ majorRadius: 25, minorRadius: 6 })
    expectEveryEllipseDimAgrees()
  })
})

describe('WO-1464: applyInertEllipseDims resolves the driving pair', () => {
  const sk = (major: number, minor: number, dims: SketchDimension[]): Sketch =>
    makeSketch([ellipse('el', major, minor)], dims)
  const out = (s: Sketch) => applyInertEllipseDims(s).entities[0] as SketchEllipseEntity

  it('axis-swap: a driving majorRadius that is the SHORT axis + 2c computes the long minor', () => {
    const e = out(sk(3, 5, [maj(4), foc(10)]))
    expect(e.majorRadius).toBe(4)
    expect(e.minorRadius).toBeCloseTo(Math.sqrt(25 + 16), 12)
  })

  it('axis-swap: a driving minorRadius that is the LONG axis + 2c computes the short major', () => {
    const e = out(sk(3, 5, [min(13), foc(24)]))
    expect(e.minorRadius).toBe(13)
    expect(e.majorRadius).toBeCloseTo(5, 12)
  })

  it('an impossible pair leaves the shape untouched (the store refuses it at commit)', () => {
    const e = out(sk(100, 60, [maj(70), foc(160)]))
    expect(e).toMatchObject({ majorRadius: 100, minorRadius: 60 })
  })
})
