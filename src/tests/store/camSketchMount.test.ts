// @vitest-environment jsdom
// SKC-46-R2 requirement 3 (concrete-host matrix) + requirement 2 (real preselection refusal
// gates): the CAM concrete host, run WITHOUT any synthetic-port substitution.
//
// R1 audit MAJOR finding: the four-corner-class x two-tool x two-host acceptance matrix was
// ARGUED (one synthetic SketchDocumentPort, tool-kind as the only parameter), never RUN through
// two concrete hosts. workbenchSketchMount.test.ts closes the workbench half; this file closes the
// CAM half, per the preflight's feasibility ruling: CNCViewport cannot construct in vitest (it
// hard-requires a real THREE.WebGLRenderer, CNCViewport.ts:437 -- no test anywhere in this repo
// constructs one). The concrete CAM host for this gate is instead:
//   - the REAL `camSketchDocumentPort` (src/store/index.ts) bound to a real Sketcher,
//   - the REAL `useCamStore` + `useUiPrefs` (the SAME shared staged-size memory surface the
//     workbench port reads/writes -- sketcher parity),
//   - a real `THREE.OrthographicCamera` implementing CAM's PRODUCTION ortho worldPerPixel formula
//     `(camera.top - camera.bottom) / (camera.zoom * clientHeight)` (CNCViewport.ts:2306-2309) and
//     the same NDC-unproject `clientToPlaneWorld` CNCViewport implements (CNCViewport.ts:2195-2204).
// The ONLY stubbed element is the WebGL renderer surface itself -- a plain <canvas> element
// supplies `domElement`/`getBoundingClientRect`, which is all the Sketcher ever asks of it.
//
// SKC-46-R3 (MAJOR 2 close-out): jsdom has no `Worker` at all, so a transport substitution is
// unavoidable to keep this host runnable -- but the R2 audit correctly found the prior
// `FakeSketchSolverWorker` was a SECOND, FORBIDDEN stub: it never answered `postMessage`, so no
// solve ever ran. `RealSolverAdapterWorker` below keeps the substitution to the transport ONLY
// (jsdom cannot host a real OS worker thread) and runs the REAL solve on every post: the exact
// same `createGcsWrapper`/`solveSketchOnWrapper` pair `sketchSolverWorker.ts` calls, wired through
// the identical `SketchWorkerRequestMsg`/`SketchWorkerResponseMsg` envelope (protocol.ts) that
// real worker uses -- same precedent as `workbenchSketchOrigin.test.tsx` / `mirrorTool.test.ts`
// running the real planegcs WASM loopback under `@vitest-environment jsdom`, and the same
// echo-via-postMessage/onmessage shape as `mirrorStoreFlow.test.ts`'s `EchoWorker`, except this
// adapter computes a REAL solve instead of echoing the input back.
//
// Host-independence mutation target (WO requirement 3): breaking `camSketchDocumentPort`'s wiring
// in src/store/index.ts (:8783-8790 staged-size members, or the `replace`/`append` commit path)
// reddens ONLY this file; breaking `workbenchSketchDocumentPort`'s equivalent members reddens ONLY
// workbenchSketchMount.test.ts -- that is what makes this a genuinely SECOND host.

const uiPrefsMemory = new Map<string, string>()
const localStorageShim: Storage = {
  get length() { return uiPrefsMemory.size },
  clear: () => uiPrefsMemory.clear(),
  getItem: (key) => uiPrefsMemory.get(key) ?? null,
  key: (index) => [...uiPrefsMemory.keys()][index] ?? null,
  removeItem: (key) => { uiPrefsMemory.delete(key) },
  setItem: (key, value) => { uiPrefsMemory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageShim, configurable: true })

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import type { SketcherHost } from '../../lib/sketch/sketcher/ports'
import type { Sketch } from '../../lib/sketch/types'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { SketchWorkerRequestMsg, SketchWorkerResponseMsg } from '../../lib/sketch/solver/protocol'

// One wrapper per test process (WASM instantiation is the expensive part), matching the real
// worker's own `ensureWrapper` cache in sketchSolverWorker.ts.
let wrapperPromise: Promise<GcsWrapper> | null = null
function ensureWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) wrapperPromise = createGcsWrapper()
  return wrapperPromise
}
class RealSolverAdapterWorker {
  onmessage: ((ev: MessageEvent<SketchWorkerResponseMsg>) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    const { requestId } = msg.payload
    void (async () => {
      try {
        const wrapper = await ensureWrapper()
        const outcome = msg.type === 'SOLVE_SKETCH'
          ? solveSketchOnWrapper(wrapper, msg.payload.sketch)
          : solveSketchOnWrapper(wrapper, msg.payload.sketch, msg.payload.drag)
        const response: SketchWorkerResponseMsg = outcome.ok
          ? {
              type: 'SKETCH_SOLVE_COMPLETE', requestId,
              entities: outcome.entities, status: outcome.status, computeTimeMs: 0,
            }
          : {
              type: 'SKETCH_SOLVE_FAILED', requestId,
              reason: outcome.reason, message: outcome.message, status: outcome.status,
            }
        this.onmessage?.({ data: response } as MessageEvent<SketchWorkerResponseMsg>)
      } catch (err) {
        this.onmessage?.({
          data: {
            type: 'SKETCH_SOLVE_ERROR', requestId,
            message: err instanceof Error ? err.message : String(err),
          },
        } as MessageEvent<SketchWorkerResponseMsg>)
      }
    })()
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.defineProperty(globalThis, 'Worker', { value: RealSolverAdapterWorker, configurable: true })

// `../../store` (and transitively `../../store/uiPrefs`) must load AFTER the localStorage/Worker
// shims above are installed -- both persist middlewares resolve their storage getter, and the
// solve path resolves `Worker`, at the moment the store module's top-level `persist(...)`/
// `create(...)` calls run, which ES module import HOISTING would otherwise run before this file's
// own top-level shim code if imported statically. A dynamic import inside `beforeAll` defers module
// evaluation until after the shims are live.
let camSketchDocumentPort: typeof import('../../store')['camSketchDocumentPort']
let useCamStore: typeof import('../../store')['useCamStore']
let useUiPrefs: typeof import('../../store/uiPrefs')['useUiPrefs']

beforeAll(async () => {
  const storeMod = await import('../../store')
  camSketchDocumentPort = storeMod.camSketchDocumentPort
  useCamStore = storeMod.useCamStore
  const uiPrefsMod = await import('../../store/uiPrefs')
  useUiPrefs = uiPrefsMod.useUiPrefs
})

// ---- the CAM concrete host ----------------------------------------------------------------------

interface Mount {
  sketcher: Sketcher
  host: SketcherHost
  canvas: HTMLCanvasElement
  camera: THREE.OrthographicCamera
}

/** A right-angle corner at the origin, legs along -x/+y -- the SAME shape
 *  workbenchSketchMount.test.ts's `filletSketchArm` uses, so `onPathLocalPoint`'s analytic
 *  grab-point derivation is shared verbatim between both concrete-host files. */
function filletSketchArm(armLength: number): Sketch {
  return {
    id: 'cam-s1', layerId: 'l',
    entities: [
      { id: 'fillet-a', kind: 'line', construction: false, start: { x: -armLength, y: 0 }, end: { x: 0, y: 0 } },
      { id: 'fillet-b', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: armLength } },
    ],
    constraints: [], dimensions: [], solveStatus: null,
  }
}

function onPathLocalPoint(kind: 'fillet' | 'chamfer', size: number): { x: number; y: number } {
  if (kind === 'chamfer') return { x: -size / 2, y: size / 2 }
  const k = 1 - Math.SQRT1_2
  return { x: -size * k, y: size * k }
}

const RECT = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect

/** CAM's production ortho worldPerPixel formula (CNCViewport.ts:2306-2309), EXPLICIT: camera.top/
 *  bottom/zoom are hard-set below, so this host's `worldPerPixel()` is asserted against a literal
 *  expected constant, not merely "positive finite" (the workbench perspective host cannot hard-set
 *  it and must derive-and-assert instead -- the R2 contract's own distinction). */
function makeCamHost(canvas: HTMLCanvasElement, camera: THREE.OrthographicCamera): SketcherHost {
  return {
    domElement: canvas,
    container: canvas,
    overlayHost: canvas,
    overlayRoot: new THREE.Group(),
    camera,
    controls: { enableRotate: false },
    // The exact NDC-unproject CNCViewport.ts's real createSketcherHost().clientToPlaneWorld
    // implements (CNCViewport.ts:2195-2204).
    clientToPlaneWorld: (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const v = new THREE.Vector3(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
        0,
      )
      v.unproject(camera)
      return { x: v.x, y: v.y }
    },
    worldPerPixel: () => (camera.top - camera.bottom) / (camera.zoom * (canvas.getBoundingClientRect().height || 1)),
    projectToScreen: (at) => {
      const p = new THREE.Vector3(at.x, at.y, 0).project(camera)
      const rect = canvas.getBoundingClientRect()
      return { x: (p.x + 1) / 2 * rect.width + rect.left, y: (-p.y + 1) / 2 * rect.height + rect.top }
    },
    saveCameraPose: () => ({}),
    restoreCameraPose: () => {},
    frameNormalToPlane: () => {},
  }
}

function mount(sketch: Sketch): Mount {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  canvas.getBoundingClientRect = () => RECT

  // Explicit ortho frustum (CAM ortho: hard-set, per the R2 contract's host-feasibility ruling) --
  // top/bottom span 150mm over 600px of clientHeight at zoom=1: worldPerPixel = 150/600 = 0.25.
  const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000)
  camera.position.set(0, 0, 100)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)

  const host = makeCamHost(canvas, camera)
  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(camSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => camSketchDocumentPort.beginStep() })

  useCamStore.setState({ activeSketch: sketch, sketchSelectedIds: [] })
  sketcher.enter()
  sketcher.updateSketch(sketch)

  return { sketcher, host, canvas, camera }
}

function pointer(type: string, target: EventTarget, x: number, y: number, button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}

/** A tool CLICK is a press+release in place (no drag). Matches both other concrete-host files. */
function click(m: Mount, x: number, y: number): void {
  pointer('pointerdown', m.canvas, x, y)
  pointer('pointerup', m.canvas, x, y)
}

function dashedGhostBuffers(m: Mount): number[][] {
  const buffers: number[][] = []
  m.host.overlayRoot.traverse((object) => {
    if (!(object instanceof THREE.Line) || !(object.material instanceof THREE.LineDashedMaterial)) return
    const position = object.geometry.getAttribute('position')
    buffers.push(Array.from(position.array as ArrayLike<number>))
  })
  return buffers
}

function activeSketch(): Sketch {
  const s = useCamStore.getState().activeSketch
  if (!s) throw new Error('expected an active sketch')
  return s
}

let M: Mount
let restoreCanvas2d: (() => void) | null = null

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  uiPrefsMemory.clear()
  useUiPrefs.setState({ lastFilletRadius: null, lastChamferSetback: null })
  useCamStore.setState({ activeSketch: null, sketchSelectedIds: [], consoleEvents: [] })
})
afterEach(() => {
  M?.sketcher.dispose()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  document.body.innerHTML = ''
})

describe('SKC-46-R2: the CAM concrete host is real, not a substitution', () => {
  it('worldPerPixel is the EXPLICIT production ortho constant (CNCViewport.ts:2306), not merely finite', () => {
    M = mount(filletSketchArm(20))
    expect(M.host.worldPerPixel()).toBeCloseTo(0.25, 12)
  })

  it('clientToPlaneWorld maps the canvas centre to the plane origin', () => {
    M = mount(filletSketchArm(20))
    const p = M.host.clientToPlaneWorld(400, 300)
    expect(p.x).toBeCloseTo(0, 6)
    expect(p.y).toBeCloseTo(0, 6)
  })
})

// WO SKC-57: the two-pass GENEROUS pick is a shared-package change (P6) with no host-specific
// logic, so its ambiguity-tier behavior is proved once, host-independent, by
// src/tests/model3d/sketchLayerGenerousPick.test.ts and its call-site routing by
// src/tests/model3d/workbenchSketchOffNormalPick.test.ts -- CAM has no tolerance-width test today,
// so this is kept to a single small parity probe rather than a second full copy of either suite.
describe('WO SKC-57: two-pass GENEROUS pick (opt-in per call site) -- CAM host parity', () => {
  it('a lone line 3mm outside the tight radius still selects on a plain click (generous pointerup fallback)', () => {
    M = mount({
      id: 'cam-s2', layerId: 'l',
      entities: [{ id: 'ln1', kind: 'line', construction: false, start: { x: -15, y: 20 }, end: { x: 15, y: 20 } }],
      constraints: [], dimensions: [], solveStatus: null,
    })
    // worldPerPixel is 0.25 here (asserted above): 8px tight tol = 2mm, 16px generous tol = 4mm.
    // x=8 keeps the probe clear of local x=0 in case a future host-parity change injects an axis
    // there (workbench already does, SKC-49); y=23 is 3mm perpendicular from the line -- outside
    // tight, inside generous.
    click(M, 400 + 8 / 0.25, 300 - 23 / 0.25)
    expect(useCamStore.getState().sketchSelectedIds).toEqual(['ln1'])
  })
})

// ---- SKC-46-R4/R5 (MAJOR 2 close-out): the real solve response must actually reach the store ----
//
// R3 audit finding: this file's RealSolverAdapterWorker runs a genuine PlaneGCS solve on every
// post (closing R2's "never answers postMessage" stub), but nothing in the committed suite ever
// AWAITED that response or asserted the store consumed it -- every other test in this file reads
// state SYNCHRONOUSLY, right after overlayApply()/click() return, which only ever observes the
// document-commit half (`replace`/`append`'s synchronous setState). The async SOLVE_SKETCH
// round-trip (`solveSketch()` -> `ensureSketchWorker().postMessage` -> the worker's `onmessage` ->
// `useCamStore.setState({ sketchSolveStatus, ... })`, store/index.ts:8591-8620) could regress all
// the way back to the OLD non-answering fake and every test here would stay green. The R4 test
// closed that gap by awaiting the real response and comparing the store's dof/fullyDefinedEntities
// to an independent re-solve of the identical posted geometry.
//
// R4 audit MAJOR (2026-07-15): that comparison was still satisfiable by a HANDWRITTEN LITERAL. The
// R4 fixture (`filletSketchArm`, no constraints/dimensions of its own) never needs the solver to
// MOVE anything -- the fillet's own tangent/coincident joints and driving radius dimension are
// already exactly satisfied by the geometry `filletLines` constructs, so the real ground-truth
// solve lands on the SAME stable `{dof:8, fullyDefinedEntities:[]}` an adapter that never calls
// `ensureWrapper`/`solveSketchOnWrapper` and just echoes the posted entities back would also
// produce. This test closes that: `filletSketchArmWithOffSolutionProbe` adds a THIRD entity
// (`probe-a`) untouched by the fillet corner but authored 20mm off its own constrained solution
// (`fix` + `vertical` + a driving 10mm `distance` dimension, posted at end.y=30). Fillet's own
// `buildTheoreticalCorner` passes every entity/constraint/dimension that doesn't touch the filleted
// corner through the `replace()` transform VERBATIM (theoreticalCorner.ts:193-194 -- `entities =
// [...doc.entities.map(applyMoves), phantomPoint]`, `applyMoves` is a no-op for `probe-a` since
// none of its point sites are in the corner's `moved` map), so `probe-a` rides into the posted
// SOLVE_SKETCH payload UNMOVED. A real PlaneGCS solve MUST reposition probe-a's end to satisfy the
// distance dimension (fullyDefinedEntities picks it up as a zero-free-parameter entity); an
// adapter that echoes the posted entities leaves it at the wrong, still-30mm position and reports
// it as undefined -- both now observably wrong against the independent ground-truth re-solve, on
// dof, on fullyDefinedEntities (no longer the stable `[]`), AND on the entity's own coordinates.
//
// Host-independence note (unchanged from R2/R4): `filletSketchArmWithOffSolutionProbe`'s corner is
// the SAME `filletSketchArm` shape; only a disjoint probe entity is added, so the small/large/
// remembered/sub-floor matrix below and workbenchSketchMount.test.ts's parity coverage are
// unaffected.
function filletSketchArmWithOffSolutionProbe(armLength: number): Sketch {
  const arm = filletSketchArm(armLength)
  return {
    ...arm,
    entities: [
      ...arm.entities,
      { id: 'probe-a', kind: 'line', construction: false, start: { x: 50, y: 0 }, end: { x: 50, y: 30 } },
    ],
    constraints: [
      { id: 'probe-fix', kind: 'fix', point: { entityId: 'probe-a', site: 'start' } },
      { id: 'probe-vert', kind: 'vertical', line: 'probe-a' },
    ],
    dimensions: [
      {
        id: 'probe-dist', kind: 'distance', driving: true, value: 10,
        a: { entityId: 'probe-a', site: 'start' }, b: { entityId: 'probe-a', site: 'end' },
      },
    ],
  }
}

function findLine(entities: Sketch['entities'], id: string): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const e = entities.find((candidate) => candidate.id === id)
  if (!e || e.kind !== 'line') throw new Error(`expected a line entity ${id}, test construction is wrong`)
  return e
}

describe('SKC-46-R5 (MAJOR close-out): the real solve MOVES an off-solution entity, not merely echoes a stable literal', () => {
  it('overlayApply (fillet) triggers a real SOLVE_SKETCH round-trip that repositions a deliberately off-solution probe entity, matching an independently-computed solve of the identical posted geometry', async () => {
    M = mount(filletSketchArmWithOffSolutionProbe(20))
    sketcherTools.armTool('fillet')
    click(M, 400, 300)
    sketcherTools.overlayApply()
    // The exact sketch `solveSketch()` reads (store/index.ts:6710) and posts, captured
    // synchronously right after overlayApply()/replace() returns -- before any async response.
    const postedSketch = activeSketch()
    const postedProbe = findLine(postedSketch.entities, 'probe-a')
    // Test-construction sanity: the posted (pre-solve) probe must still sit at its deliberately
    // wrong authored position (30mm), not the 10mm its own distance dimension demands -- otherwise
    // this gate would be vacuous before the solve even runs.
    expect(postedProbe.end.y, 'test construction invariant: probe-a must be posted OFF its constrained solution').toBeCloseTo(30, 6)

    await vi.waitFor(() => {
      expect(useCamStore.getState().sketchSolveStatus).not.toBeNull()
    })

    const status = useCamStore.getState().sketchSolveStatus!
    expect(status.solveFailed, 'the real solve must actually complete, not fail-closed').not.toBe(true)

    const wrapper = await ensureWrapper()
    const expected = solveSketchOnWrapper(wrapper, postedSketch)
    if (!expected.ok) throw new Error('ground-truth solve unexpectedly failed -- test construction is wrong')
    const expectedProbe = findLine(expected.entities, 'probe-a')
    // Test-construction sanity: the ground truth must have actually MOVED probe-a -- a real
    // solver that happened to leave it alone would be indistinguishable from a fake.
    expect(expectedProbe.end.y, 'test construction invariant: the real solver must MOVE probe-a to satisfy its distance dimension').toBeCloseTo(10, 6)
    expect(
      Math.abs(expectedProbe.end.y - postedProbe.end.y),
      'test construction invariant: the ground-truth solved position must differ from the posted pre-solve position',
    ).toBeGreaterThan(1)

    // The MOVE itself, end to end, asserted FIRST (R5 audit proof-order fix): the store's
    // post-solve probe-a coordinates must match the independent ground truth's MOVED
    // coordinates -- not the posted pre-solve coordinates. An adapter that echoes the posted
    // entities (the audit's literal-response fake) fails HERE, by name, before any status
    // assertion can mask which invariant caught it.
    const storedProbe = findLine(activeSketch().entities, 'probe-a')
    expect(storedProbe.start, 'store probe-a start must match the ground-truth solved start').toEqual(expectedProbe.start)
    expect(storedProbe.end, 'store probe-a end must match the ground-truth solved end (MOVED from the posted position)').toEqual(expectedProbe.end)
    expect(storedProbe.end, 'store probe-a end must NOT equal the posted pre-solve position').not.toEqual(postedProbe.end)

    expect(status.dof, 'the store must carry the REAL solved dof, not a placeholder').toBe(expected.status.dof)
    expect(
      status.fullyDefinedEntities,
      'the store must carry the REAL fix-probe per-entity diagnosis',
    ).toEqual(expected.status.fullyDefinedEntities)
    // The literal-response fake this gate closes (audit-adopted repro: SKETCH_SOLVE_COMPLETE with
    // the fixed status {dof:8, fullyDefinedEntities:[]}, entities echoed) is a stable-at-rest
    // literal that reports NO entity as fully defined; the real ground truth must diagnose
    // probe-a as fully defined (fix + vertical + distance leaves it zero free parameters), so the
    // literal can never coincide with it.
    expect(expected.status.fullyDefinedEntities, 'ground truth must diagnose probe-a as fully defined').toContain('probe-a')
  })
})

describe('SKC-46-R2: concrete-host matrix (CAM) -- small/large/remembered-oversize/sub-floor', () => {
  function establishRememberedSize(kind: 'fillet' | 'chamfer', value: number): void {
    M = mount(filletSketchArm(20))
    sketcherTools.armTool(kind)
    click(M, 400, 300)
    sketcherTools.commitDrawValueAt(value, { x: 0, y: 0 })
    sketcherTools.overlayApply()
  }

  function assertStagesPreviewsAndApplies(kind: 'fillet' | 'chamfer', armLength: number): number {
    M = mount(filletSketchArm(armLength))
    sketcherTools.armTool(kind)
    click(M, 400, 300)

    const chain = sketcherToolStore.getState().chain
    expect(chain, `${kind} @ ${armLength}mm must stage`).toMatchObject({ kind, corners: [{ at: { x: 0, y: 0 } }] })

    const stagedSize = kind === 'fillet'
      ? sketcherToolStore.getState().filletRadius : sketcherToolStore.getState().chamferSetback
    expect(Number.isFinite(stagedSize), `${kind} @ ${armLength}mm staged size must be finite`).toBe(true)
    expect(stagedSize, 'BLOCKER 1: staged size sits strictly under the geometric ceiling').toBeLessThan(armLength)

    const ghosts = dashedGhostBuffers(M)
    expect(ghosts.length, `${kind} @ ${armLength}mm must preview (>=1 fit)`).toBeGreaterThanOrEqual(1)

    const grab = M.host.projectToScreen?.(onPathLocalPoint(kind, stagedSize))
    expect(grab, `${kind} @ ${armLength}mm host must project the staged preview point`).not.toBeNull()
    if (!grab) throw new Error('unreachable (asserted above)')
    pointer('pointermove', M.canvas, grab.x, grab.y)
    expect(M.canvas.style.cursor, `${kind} @ ${armLength}mm: a real preview point must be grabbable`).toBe('grab')

    const entitiesBefore = activeSketch().entities.length
    sketcherTools.overlayApply()
    const after = activeSketch()
    expect(after.entities.length, `${kind} @ ${armLength}mm Apply must commit a non-null transform`)
      .toBeGreaterThan(entitiesBefore)
    return stagedSize
  }

  function assertRefusesNamed(kind: 'fillet' | 'chamfer', armLength: number): void {
    M = mount(filletSketchArm(armLength))
    const memoryBefore = kind === 'fillet'
      ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
    sketcherTools.armTool(kind)
    const eventsBefore = useCamStore.getState().consoleEvents.length

    click(M, 400, 300)

    const newEvents = useCamStore.getState().consoleEvents.slice(eventsBefore)
    const named = newEvents.filter((e) => /too small/i.test(e.message) && new RegExp(kind, 'i').test(e.message))
    expect(named, `expected a NAMED refusal, got: ${JSON.stringify(newEvents.map((e) => e.message))}`)
      .toHaveLength(1)
    expect(sketcherToolStore.getState().chain, 'refused corner must not stage a chain').toBeNull()
    expect(dashedGhostBuffers(M), 'refused corner must stage ZERO preview').toEqual([])
    const memoryAfter = kind === 'fillet'
      ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
    expect(memoryAfter, 'memory must be untouched').toBe(memoryBefore)
  }

  describe.each(['fillet', 'chamfer'] as const)('%s', (kind) => {
    it('SMALL corner: derived default stages, previews, acquires the grab cursor, and applies', () => {
      assertStagesPreviewsAndApplies(kind, 4)
    })

    it('LARGE corner: derived default stages, previews, acquires the grab cursor, and applies', () => {
      assertStagesPreviewsAndApplies(kind, 100)
    })

    it('REMEMBERED-OVERSIZE: a remembered 10mm on a 4mm corner clamps, previews, and applies', () => {
      establishRememberedSize(kind, 10)
      expect(
        kind === 'fillet' ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback,
      ).toBe(10)
      // The remembered 10mm must actually have WON and clamped down to the corner's own ceiling --
      // not merely happened to sit under it, which a from-scratch derived default (~0.35*4=1.4mm)
      // would also do. Proves this test exercises the remembered-size path, not the no-memory one.
      const staged = assertStagesPreviewsAndApplies(kind, 4)
      expect(staged, 'remembered 10mm must clamp near the 4mm ceiling, not the derived default').toBeGreaterThan(3.9)
    })

    it('SUB-FLOOR corner (0.001mm legs): refuses by name, zero preview, memory untouched', () => {
      assertRefusesNamed(kind, 0.001)
    })
  })
})

describe('SKC-46-R2: real preselection refusal gate (CAM concrete host)', () => {
  function collinearPairSketch(): Sketch {
    return {
      id: 'cam-s1', layerId: 'l',
      entities: [
        { id: 'col-a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
        { id: 'col-b', kind: 'line', construction: false, start: { x: 20, y: 0 }, end: { x: 40, y: 0 } },
      ],
      constraints: [], dimensions: [], solveStatus: null,
    }
  }

  describe.each(['fillet', 'chamfer'] as const)('%s', (kind) => {
    it('two collinear preselected lines: named refusal, zero staged preview, memory untouched', () => {
      M = mount(collinearPairSketch())
      const memoryBefore = kind === 'fillet'
        ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
      useCamStore.setState({ sketchSelectedIds: ['col-a', 'col-b'] })
      const eventsBefore = useCamStore.getState().consoleEvents.length

      sketcherTools.armTool(kind)

      const chain = sketcherToolStore.getState().chain
      expect(chain?.kind === kind ? (chain as { corners: unknown[] }).corners : []).toHaveLength(0)
      expect(dashedGhostBuffers(M), 'zero staged preview').toEqual([])
      const newEvents = useCamStore.getState().consoleEvents.slice(eventsBefore)
      expect(newEvents.some((e) => new RegExp(kind, 'i').test(e.message)), 'a named refusal must fire').toBe(true)
      const memoryAfter = kind === 'fillet'
        ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
      expect(memoryAfter, 'memory must be untouched').toBe(memoryBefore)
    })

    it('a degenerate near-zero-length leg (len <= EPS_LEN) also refuses by name through this host', () => {
      M = mount({
        id: 'cam-s1', layerId: 'l',
        entities: [
          { id: 'deg-a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
          // A degenerate zero-length "leg" at the shared corner (0,0)-(0,1e-9): trimSide's
          // `len <= EPS_LEN` guard (filletTool.ts:168) fires before any angle math runs.
          { id: 'deg-b', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: 1e-9 } },
        ],
        constraints: [], dimensions: [], solveStatus: null,
      })
      useCamStore.setState({ sketchSelectedIds: ['deg-a', 'deg-b'] })

      sketcherTools.armTool(kind)

      const chain = sketcherToolStore.getState().chain
      expect(chain?.kind === kind ? (chain as { corners: unknown[] }).corners : []).toHaveLength(0)
      expect(dashedGhostBuffers(M), 'zero staged preview').toEqual([])
    })
  })
})
