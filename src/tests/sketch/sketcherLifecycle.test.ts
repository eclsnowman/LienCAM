// @vitest-environment jsdom
//
// WO SKC-14-R1, finding 4: the Sketcher's enter/exit policy and its one-undo-step-per-gesture
// semantics were "browser-evidence-only" -- provable only by driving the real app. This file
// instantiates the component directly against a FAKE host and pins both, so a regression fails in
// the unit suite rather than in a Playwright run nobody re-executed.
//
// The fake host is a real DOM (jsdom) + a real THREE camera/scene: the component's own code paths
// run unmodified. Everything CAM-specific -- the document, the tool machine, the undo sink, the
// context menu -- arrives through the ports, which is the whole point of the extraction: if this
// test can mount the Sketcher without CAM, so can the S3 workbench.
//
// What is pinned here:
//   * Session lifecycle: pose save/restore round-trip, orbit suppression + restoration,
//     onSessionEnter/Exit, idempotent enter, no-op exit, listener detach.
//   * Undo granularity (finding 3): a gesture whose commit mutates the document opens EXACTLY ONE
//     step; a gesture that mutates nothing (a chain-advancing click) opens NONE.
//   * The two gestures SKC-14-R1 moved in: the DOM dimension-label drag (threshold, one step,
//     label move, trailing click-select) and the right-button context menu (pan-vs-menu).
//
// WO SKC-14B, the ACCEPTANCE KEYSTONE (bottom of this file). The fake host below implements ONLY
// `SketchDocumentPort` -- a document, a commit, an undo sink, a notice. It contains no tool state,
// no snap, no overlay resolver, no tool machine, and it imports NOTHING from src/store. The
// keystone suite arms a tool and DRAWS a line and a 3-point arc through that host, which is only
// possible because the tool machine now lives in the package. That is the executable form of the
// S3 precondition: a store-free mount can run the full tool loop.
//
// Note what this test can no longer do, and why that is the point: the old harness's `click` port
// let the fake host decide what a click MEANT (it counted "mutations" the host announced). No such
// port exists now -- the package decides -- so undo granularity is pinned by observing the REAL
// tool machine commit, which is a strictly stronger assertion than the stub it replaced.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import type { SketcherHost, SketchDocumentPort, SketchMenuPort } from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchDimension, SketchEntity, Vec2 } from '../../lib/sketch/types'
import type { Loop2D } from '../../types'
import type { ProjectCandidate, ProjectResolveResult } from '../../lib/sketch/projectUse'
import { __filletPreviewComputeCount, __resetFilletChainPreviewMemo } from '../../lib/sketch/tools/filletTool'
import { __chamferPreviewComputeCount, __resetChamferChainPreviewMemo } from '../../lib/sketch/tools/chamferTool'

// ---- the document under edit -----------------------------------------------------------------

const P0: SketchEntity = { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const P1: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 10, y: 0 } }
const DIM: SketchDimension = {
  id: 'd1', kind: 'distance', driving: true, value: 10,
  a: { entityId: 'p0', site: 'self' }, b: { entityId: 'p1', site: 'self' },
  labelAnchor: { x: 5, y: -5 },
}
function freshSketch(): Sketch {
  return {
    id: 's', layerId: 'l', entities: [P0, P1], constraints: [], dimensions: [DIM],
    solveStatus: null,
  }
}

function filletSketch(armLength = 20): Sketch {
  return {
    id: 'fillet-sketch', layerId: 'l',
    entities: [
      {
        id: 'fillet-a', kind: 'line', construction: false,
        start: { x: 20 - armLength, y: 0 }, end: { x: 20, y: 0 },
      },
      {
        id: 'fillet-b', kind: 'line', construction: false,
        start: { x: 20, y: 0 }, end: { x: 20, y: armLength },
      },
    ],
    constraints: [], dimensions: [], solveStatus: null,
  }
}

// ---- the fake host ----------------------------------------------------------------------------

interface Harness {
  sketcher: Sketcher
  host: SketcherHost
  canvas: HTMLElement
  overlayHost: HTMLElement
  label: HTMLElement
  controls: { enableRotate: boolean }
  poses: { saved: number; restored: unknown[] }
  sessionEnters: number
  sessionExits: number
  framed: number
  beginGestureCalls: number
  menu: SketchMenuPort & { opened: Array<[number, number]>; closes: number }
  selection: string[]
  doc: SketchDocumentPort
  /** The LIVE document. `append`/`replace` mutate this; the package reads it back through
   *  `getSketch()`. A real mount's store sits exactly here. */
  sketch: Sketch
  /** Undo steps opened by non-gesture commits (`beginStep`), kept apart from the gesture latch. */
  beginStepCalls: number
  notices: string[]
  appendCalls: number
  dragAccepts: boolean
  /** How many times the fake host ANNOUNCES a write inside one `dragBegin`. The mount contract
   *  (ports.ts / SketchUndoSink) lets a host call `beforeMutate` at the instant it is about to
   *  touch the document -- possibly more than once -- and the component's latch must collapse them
   *  into exactly ONE undo step. Default 1; the latch test raises it. */
  dragMutations: number
  dragBeginCalls: number
  dragMoveCalls: number
  dragEndCalls: number
  capture: {
    pointerId: number | null
    setCalls: number[]
    releaseCalls: number[]
  }
  labelMoves: Array<[string, Vec2]>
  dimEditorOpens: string[]
  /** SKC-46: the host's staged-size persist surface (the fake stands in for `liencam-ui-prefs`).
   *  Starts at the WO's default of "never committed" (null) for both tools. */
  lastSizes: { fillet: number | null; chamfer: number | null }
}

function makeHarness(): Harness {
  const overlayHost = document.createElement('div')
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  overlayHost.appendChild(container)

  // The DOM dimension value label the host renders. The component finds it by its data tag.
  const label = document.createElement('div')
  label.dataset.dimId = 'd1'
  overlayHost.appendChild(label)
  document.body.appendChild(overlayHost)

  // A real bounding rect: jsdom reports zeros, and the component reads one for picking.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect

  const controls = { enableRotate: true }
  const poses = { saved: 0, restored: [] as unknown[] }
  const capture = {
    pointerId: null as number | null,
    setCalls: [] as number[],
    releaseCalls: [] as number[],
  }
  canvas.setPointerCapture = (pointerId) => {
    capture.pointerId = pointerId
    capture.setCalls.push(pointerId)
  }
  canvas.hasPointerCapture = (pointerId) => capture.pointerId === pointerId
  canvas.releasePointerCapture = (pointerId) => {
    capture.releaseCalls.push(pointerId)
    if (capture.pointerId === pointerId) capture.pointerId = null
  }

  const h: Partial<Harness> = {
    canvas, overlayHost, label, controls, poses, capture,
    sessionEnters: 0, sessionExits: 0, framed: 0, beginGestureCalls: 0, beginStepCalls: 0,
    selection: [], dragAccepts: true, dragMutations: 1, dragBeginCalls: 0, appendCalls: 0,
    dragMoveCalls: 0, dragEndCalls: 0,
    labelMoves: [], dimEditorOpens: [], notices: [], sketch: freshSketch(),
    lastSizes: { fillet: null, chamfer: null },
  }

  // Pulled back off the sketch plane and matrix-updated so `SketchLayer.pick()` can actually
  // resolve an entity under a client point: world (0,0) lands at client (400,300), and one world mm
  // spans 4 client px horizontally. The entity-drag test below depends on a REAL pick.
  const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld(true)

  const host: SketcherHost = {
    domElement: canvas,
    container,
    overlayHost,
    overlayRoot: new THREE.Group(),
    camera,
    controls,
    // Identity plane map: client px ARE world mm. Keeps the arithmetic in the assertions honest.
    // SKC-54: SketchLayer.pick() now converges through THIS SAME callback (composed package-side
    // in index.ts) instead of its own raw NDC-unprojection, so the entity-drag tests below click
    // P1's LITERAL world coordinate as client px (see their own P1_CLIENT), not the camera-ortho
    // -mapped screen point the pre-fix pick() needed -- the camera above still matters for
    // anything that goes through it directly (none of these tests do).
    clientToPlaneWorld: (x, y) => ({ x, y }),
    worldPerPixel: () => 1,
    saveCameraPose: () => { poses.saved++; return { token: poses.saved } },
    restoreCameraPose: (pose) => { poses.restored.push(pose) },
    frameNormalToPlane: () => { h.framed = (h.framed ?? 0) + 1 },
    onSessionEnter: () => { h.sessionEnters = (h.sessionEnters ?? 0) + 1 },
    onSessionExit: () => { h.sessionExits = (h.sessionExits ?? 0) + 1 },
  }

  const menu = {
    opened: [] as Array<[number, number]>,
    closes: 0,
    open: (x: number, y: number) => { menu.opened.push([x, y]) },
    close: () => { menu.closes++ },
  }

  // THE MOUNT. Reads, commits, an undo sink and a notice -- nothing else. No tool state, no snap,
  // no overlay resolution, no inference, no `src/store`. If the tool loop runs against this, it
  // runs against the S3 workbench.
  const doc: SketchDocumentPort = {
    getSketch: () => h.sketch!,
    // This host always has a document; a real mount creates one lazily here.
    ensureSketch: () => h.sketch!,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10,
    getProjectCandidates: () => [],
    getSelection: () => h.selection!,
    setSelection: (ids) => { h.selection = ids },
    getLastStagedSize: (kind) => h.lastSizes![kind],
    setLastStagedSize: (kind, value) => { h.lastSizes![kind] = value },
    notice: (message) => { h.notices!.push(message) },
    beginStep: () => { h.beginStepCalls = (h.beginStepCalls ?? 0) + 1 },
    append: (commit, inferred) => {
      h.appendCalls = (h.appendCalls ?? 0) + 1
      h.sketch = {
        ...h.sketch!,
        entities: [...h.sketch!.entities, ...commit.entities],
        constraints: [...h.sketch!.constraints, ...commit.constraints, ...inferred],
        dimensions: [...h.sketch!.dimensions, ...(commit.dimensions ?? [])],
      }
    },
    replace: (next) => {
      h.sketch = { ...h.sketch!, ...next }
    },
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: (_id, _grab, _tol, beforeMutate) => {
      h.dragBeginCalls = (h.dragBeginCalls ?? 0) + 1
      if (!h.dragAccepts) return false
      // The host announces each write it is about to make. The component must collapse them.
      for (let i = 0; i < (h.dragMutations ?? 1); i++) beforeMutate()
      return true
    },
    dragMove: () => { h.dragMoveCalls = (h.dragMoveCalls ?? 0) + 1 },
    dragEnd: () => { h.dragEndCalls = (h.dragEndCalls ?? 0) + 1 },
    moveDimLabel: (id, anchor) => { h.labelMoves!.push([id, anchor]) },
    openDimEditor: (id) => { h.dimEditorOpens!.push(id) },
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }

  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(doc)
  sketcher.setUndoSink({ beginGesture: () => { h.beginGestureCalls = (h.beginGestureCalls ?? 0) + 1 } })
  sketcher.setMenuPort(menu)

  return Object.assign(h, { sketcher, host, menu, doc }) as Harness
}

/** Entities the document gained since `freshSketch()` (which seeds two points). */
function drawn(h: Harness): SketchEntity[] {
  return h.sketch.entities.filter((e) => e.id !== 'p0' && e.id !== 'p1')
}

/** jsdom has no PointerEvent constructor; the component only reads MouseEvent fields
 *  (button / clientX / clientY / shiftKey), so a bubbling MouseEvent of the right type is an
 *  exact stand-in. */
function pointer(
  type: string, target: EventTarget,
  opts: { x?: number; y?: number; button?: number; shiftKey?: boolean; pointerId?: number } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX: opts.x ?? 0, clientY: opts.y ?? 0,
    button: opts.button ?? 0, shiftKey: opts.shiftKey ?? false,
  })
  Object.defineProperty(event, 'pointerId', { value: opts.pointerId ?? 1 })
  target.dispatchEvent(event)
}

/** Model the browser's capture retargeting: an outside release is delivered to the capture owner. */
function releaseOutside(h: Harness, at: { x: number; y: number }, pointerId = 1): void {
  pointer('pointerup', h.capture.pointerId === pointerId ? h.canvas : window, { ...at, pointerId })
}

let H: Harness

beforeEach(() => {
  // The tool store is a module singleton (it is THE armed tool, a global UI mode), so a test that
  // arms a tool must not leak it into the next one.
  sketcherToolStore.__reset()
  H = makeHarness()
})
afterEach(() => {
  H.sketcher.dispose()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** A stationary press+release on the canvas: the component's tool-click gesture. */
function clickAt(x: number, y: number): void {
  pointer('pointerdown', H.canvas, { x, y })
  pointer('pointerup', H.canvas, { x, y })
}

const previewLines = (): THREE.Line[] =>
  H.host.overlayRoot.children.filter((child): child is THREE.Line => child instanceof THREE.Line)

function dashedGhostBuffers(root = H.host.overlayRoot): number[][] {
  const buffers: number[][] = []
  root.traverse((object) => {
    if (!(object instanceof THREE.Line) || !(object.material instanceof THREE.LineDashedMaterial)) return
    const position = object.geometry.getAttribute('position')
    buffers.push(Array.from(position.array as ArrayLike<number>))
  })
  return buffers
}

function warningTriangleCount(root = H.host.overlayRoot): number {
  let count = 0
  root.traverse((object) => {
    if (object instanceof THREE.LineLoop && object.geometry.getAttribute('position')?.count === 3) count++
  })
  return count
}

function stageFilletCorner(): void {
  H.sketch = filletSketch()
  H.sketcher.updateSketch(H.sketch)
  sketcherTools.armTool('fillet')
  H.sketcher.enter()
  clickAt(20, 0)
  expect(sketcherToolStore.getState().chain).toMatchObject({ kind: 'fillet' })
}

function stageChamferCorner(): void {
  H.sketch = filletSketch()
  H.sketcher.updateSketch(H.sketch)
  sketcherTools.armTool('chamfer')
  H.sketcher.enter()
  clickAt(20, 0)
  expect(sketcherToolStore.getState().chain).toMatchObject({ kind: 'chamfer' })
}

/** SKC-46 seeds the staged radius/setback from the remembered/derived default on the first
 *  staged corner (its own tests cover that derivation); the pre-existing SKC-44/45 drag-mechanics
 *  fixtures below (R2_MID / D2_MID, radialScale) are built around a fixed R2/D2 starting point.
 *
 *  SKC-46-R1 (MAJOR 3 close-out, Architect ruling): a direct store-scalar poke is NOT a legal way
 *  to reach that starting point -- it bypasses the production seed entirely (the auditor proved
 *  the four SKC-44/45 tests below only passed BECAUSE of the bypass: their original R2/D2
 *  assertions failed once the exact seeded value governed). The only sanctioned route is the
 *  PRODUCTION memory path: commit a real fillet/chamfer at the target value through the same
 *  typed-entry + Apply API a user gesture drives (`commitDrawValueAt` + `overlayApply`), so a
 *  FRESH staging session legitimately SEEDS at that value because it is now the remembered size.
 *  `establishRememberedFilletSize`/`ChamferSize` below do exactly that, then reset the document
 *  back to a pristine `filletSketch()` so the caller's next `stageFilletCorner()`/
 *  `stageChamferCorner()` call re-stages against a clean sketch. The real commit this performs
 *  necessarily opens one undo step on the fake host (`H.beginStepCalls`) -- SETUP, not part of the
 *  gesture under test, so it is zeroed back out before returning; every existing assertion that
 *  reads `H.beginStepCalls`/`H.dragBeginCalls` as "0 so far" during the gesture stays correct. */
function establishRememberedFilletSize(value: number): void {
  H.sketch = filletSketch()
  H.sketcher.updateSketch(H.sketch)
  sketcherTools.armTool('fillet')
  H.sketcher.enter()
  clickAt(20, 0)
  sketcherTools.commitDrawValueAt(value, { x: 20, y: 0 })
  sketcherTools.overlayApply()
  H.beginStepCalls = 0
}
function establishRememberedChamferSize(value: number): void {
  H.sketch = filletSketch()
  H.sketcher.updateSketch(H.sketch)
  sketcherTools.armTool('chamfer')
  H.sketcher.enter()
  clickAt(20, 0)
  sketcherTools.commitDrawValueAt(value, { x: 20, y: 0 })
  sketcherTools.overlayApply()
  H.beginStepCalls = 0
}

function projectPath(id: string, points: Vec2[], closed: boolean): Loop2D {
  return {
    id,
    points,
    closed,
    type: closed ? 'contour' : 'open',
    layerId: 'model',
    area: 0,
  }
}

function modelCandidate(
  kind: 'model-face' | 'model-edge',
  paths: readonly Loop2D[],
  cacheVersion = 1,
): ProjectCandidate {
  return {
    paths,
    sourceKind: kind,
    sourceLabel: kind === 'model-face' ? 'Face fixture' : 'Edge fixture',
    stablePickKey: `${kind}:body-1:stable-1:${cacheVersion}`,
    sourceIdentity: { bodyId: 'body-1', cacheVersion, stableId: 'stable-1' },
  }
}

// ---- session lifecycle (camera POLICY lives in the component) ---------------------------------

describe('Sketcher session lifecycle against a fake host', () => {
  it('enter saves a pose, frames normal-to-plane, suppresses orbit and enters the host scene', () => {
    expect(H.sketcher.isActive()).toBe(false)
    H.sketcher.enter()
    expect(H.sketcher.isActive()).toBe(true)
    expect(H.poses.saved).toBe(1)
    expect(H.framed).toBe(1)
    expect(H.sessionEnters).toBe(1)
    // The component owns orbit suppression -- the host never decides.
    expect(H.controls.enableRotate).toBe(false)
  })

  it('enter is idempotent: a second call never overwrites the saved pose', () => {
    H.sketcher.enter()
    H.sketcher.enter()
    expect(H.poses.saved).toBe(1)
    expect(H.framed).toBe(1)
    expect(H.sessionEnters).toBe(1)
  })

  it('exit restores the EXACT pose token it was handed, the orbit flag, and the host scene', () => {
    H.controls.enableRotate = true
    H.sketcher.enter()
    const savedToken = { token: 1 }
    H.sketcher.exit()
    expect(H.sketcher.isActive()).toBe(false)
    expect(H.poses.restored).toEqual([savedToken])
    expect(H.controls.enableRotate).toBe(true) // restored to its PRE-enter value
    expect(H.sessionExits).toBe(1)
    // The component opened any context menu, so the component closes it.
    expect(H.menu.closes).toBeGreaterThanOrEqual(1)
  })

  it('exit restores the pre-enter orbit flag even when it was already false', () => {
    H.controls.enableRotate = false
    H.sketcher.enter()
    H.sketcher.exit()
    expect(H.controls.enableRotate).toBe(false)
  })

  it('exit without enter is a no-op (no pose is restored that was never saved)', () => {
    H.sketcher.exit()
    expect(H.poses.restored).toEqual([])
    expect(H.sessionExits).toBe(0)
  })

  it('exit detaches: canvas gestures stop reaching the component', () => {
    sketcherTools.armTool('line')
    H.sketcher.enter()
    H.sketcher.exit()
    clickAt(100, 100)
    clickAt(140, 100)
    // FAILS-IF: the listeners survive exit -- a click outside a session would draw geometry.
    expect(drawn(H)).toHaveLength(0)
    expect(H.appendCalls).toBe(0)
  })
})

describe('SKC-30 shared live tool-overlay invalidation', () => {
  it('SKC-30 radius buffer: repaints the rendered R2 ghost to R5 without pointer movement', () => {
    const documentBefore = JSON.stringify(filletSketch())
    stageFilletCorner()
    sketcherTools.commitDrawValueAt(2, { x: 20, y: 0 }) // typed entry: a live, unapplied edit

    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    const cursorBeforeRadiusChange = H.sketcher.getLastCursor()
    const r2 = dashedGhostBuffers()
    expect(r2).toHaveLength(1)
    expect(r2[0].length).toBeGreaterThan(0)
    expect(r2[0].every(Number.isFinite)).toBe(true)

    sketcherTools.setFilletRadius(5)

    const r5 = dashedGhostBuffers()
    expect(H.sketcher.getLastCursor()).toEqual(cursorBeforeRadiusChange)
    expect(r5).toHaveLength(1)
    expect(r5[0].every(Number.isFinite)).toBe(true)
    expect(r5[0]).not.toEqual(r2[0])
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)

    sketcherTools.overlayApply()

    expect(H.beginStepCalls).toBe(1)
    expect(H.sketch.entities.filter((entity) => entity.kind === 'arc')).toHaveLength(1)
    expect(H.sketch.entities.find((entity) => entity.kind === 'arc')).toMatchObject({ radius: 5 })
    expect(dashedGhostBuffers()).toEqual([])
  })

  it('SKC-30 document invalidation: updateSketch replaces a stale ghost with the misfit warning', () => {
    stageFilletCorner()
    // Set explicitly AFTER staging: SKC-46's seed/clamp would otherwise re-derive this to the
    // (fitting) default on the corner-click, defeating the misfit this test constructs.
    sketcherTools.setFilletRadius(5)
    expect(dashedGhostBuffers()).toHaveLength(1)
    expect(warningTriangleCount()).toBe(0)
    const cursorBeforeDocumentChange = H.sketcher.getLastCursor()

    H.sketch = filletSketch(3)
    H.sketcher.updateSketch(H.sketch)

    expect(H.sketcher.getLastCursor()).toEqual(cursorBeforeDocumentChange)
    expect(dashedGhostBuffers()).toEqual([])
    expect(warningTriangleCount()).toBe(1)
  })

  it('Cancel clears the staged ghost without changing the document or opening history', () => {
    const documentBefore = JSON.stringify(filletSketch())
    stageFilletCorner()
    expect(dashedGhostBuffers()).toHaveLength(1)

    expect(sketcherTools.escape()).toBe(true)

    expect(sketcherToolStore.getState().chain).toBeNull()
    expect(dashedGhostBuffers()).toEqual([])
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    expect(H.beginStepCalls).toBe(0)
  })

  it('filters unchanged, wake, snap, and construction traffic and installs once on re-entry', () => {
    const refresh = vi.spyOn(H.sketcher, 'refreshToolOverlay')
    sketcherTools.setFilletRadius(3)
    expect(refresh).not.toHaveBeenCalled()

    H.sketcher.enter()
    H.sketcher.enter()
    sketcherTools.setFilletRadius(4)
    expect(refresh).toHaveBeenCalledTimes(1)

    sketcherTools.setFilletRadius(4)
    sketcherToolStore.setState({ wakeRefs: [{ point: { x: 1, y: 2 }, ref: null }] })
    sketcherTools.toggleSnapFlag('grid')
    sketcherToolStore.setState({ constructionMode: true })
    expect(refresh).toHaveBeenCalledTimes(1)

    H.sketcher.exit()
    sketcherTools.setFilletRadius(5)
    expect(refresh).toHaveBeenCalledTimes(1)

    H.sketcher.enter()
    sketcherTools.setFilletRadius(6)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('SKC-30 active dispose cleanup: a disposed active instance never wakes again', () => {
    const active = makeHarness()
    const refresh = vi.spyOn(active.sketcher, 'refreshToolOverlay')
    active.sketcher.enter()
    sketcherTools.setFilletRadius(3)
    expect(refresh).toHaveBeenCalledTimes(1)

    active.sketcher.dispose()
    expect(active.sketcher.isActive()).toBe(false)
    sketcherTools.setFilletRadius(4)

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('SKC-44 staged fillet radius pointer gesture', () => {
  const CORNER = { x: 20, y: 0 }
  // A right-angle R2 fillet's arc midpoint. The shared preview tessellator
  // includes the midpoint (8-segment floor), so this is a real dashed-arc hit,
  // not a broad corner-marker proxy.
  const R2_MID = {
    x: CORNER.x - 2 + Math.SQRT2,
    y: 2 - Math.SQRT2,
  }
  const radialScale = (scale: number): Vec2 => ({
    x: CORNER.x + (R2_MID.x - CORNER.x) * scale,
    y: CORNER.y + (R2_MID.y - CORNER.y) * scale,
  })

  it('SKC-44 drag handler updates radius and preview per move, then Apply matches exactly', () => {
    const documentBefore = JSON.stringify(filletSketch())
    establishRememberedFilletSize(2) // SKC-46-R1: production memory path replaces the store pin
    stageFilletCorner()
    // Use a realistic zoom for the hover sample: the R2 arc remains an exact
    // preview hit, while the theoretical sharp endpoint is no longer inside
    // the independent 6px snap radius (which would render a canvas badge).
    H.host.worldPerPixel = () => 0.05
    const r2 = dashedGhostBuffers()
    expect(r2).toHaveLength(1)

    pointer('pointermove', H.canvas, R2_MID)
    expect(H.canvas.style.cursor).toBe('grab')

    pointer('pointerdown', H.canvas, R2_MID)
    expect(H.canvas.style.cursor).toBe('grabbing')
    expect(H.capture.pointerId).toBe(1)

    const r3Point = radialScale(1.5)
    pointer('pointermove', H.canvas, r3Point)
    expect(sketcherToolStore.getState().filletRadius).toBeCloseTo(3, 8)
    const r3 = dashedGhostBuffers()
    expect(r3).toHaveLength(1)
    expect(r3[0]).not.toEqual(r2[0])

    const r4Point = radialScale(2)
    pointer('pointermove', H.canvas, r4Point)
    expect(sketcherToolStore.getState().filletRadius).toBeCloseTo(4, 8)
    const r4 = dashedGhostBuffers()
    expect(r4).toHaveLength(1)
    expect(r4[0]).not.toEqual(r3[0])
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    expect(H.beginStepCalls).toBe(0)
    expect(H.dragBeginCalls).toBe(0)

    pointer('pointerup', H.canvas, r4Point)
    expect(H.canvas.style.cursor).toBe('grab')
    expect(H.capture.pointerId).toBeNull()
    expect(sketcherToolStore.getState().filletRadius).toBeCloseTo(4, 8)
    const previewRadius = sketcherToolStore.getState().filletRadius

    sketcherTools.overlayApply()

    expect(H.beginStepCalls).toBe(1)
    const committed = H.sketch.entities.find((entity) => entity.kind === 'arc')
    expect(committed).toMatchObject({ kind: 'arc' })
    expect(committed?.kind === 'arc' ? committed.radius : null).toBe(previewRadius)
    expect(committed?.kind === 'arc' ? committed.radius : null).toBeCloseTo(4, 8)
    expect(dashedGhostBuffers()).toEqual([])
  })

  it('SKC-44 Escape mid-drag restores radius, ghost, capture, and staged corner', () => {
    const documentBefore = JSON.stringify(filletSketch())
    establishRememberedFilletSize(2) // SKC-46-R1: production memory path replaces the store pin
    stageFilletCorner()
    const r2 = dashedGhostBuffers()
    const releasesBeforeDrag = H.capture.releaseCalls.length

    pointer('pointerdown', H.canvas, R2_MID)
    pointer('pointermove', H.canvas, radialScale(2))
    expect(sketcherToolStore.getState().filletRadius).toBeCloseTo(4, 8)
    expect(dashedGhostBuffers()[0]).not.toEqual(r2[0])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(sketcherToolStore.getState().filletRadius).toBe(2)
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'fillet',
      corners: [{ at: CORNER }],
    })
    expect(dashedGhostBuffers()).toEqual(r2)
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    expect(H.beginStepCalls).toBe(0)
    expect(H.capture.pointerId).toBeNull()
    expect(H.capture.releaseCalls).toHaveLength(releasesBeforeDrag + 1)
    expect(H.capture.releaseCalls.at(-1)).toBe(1)
    expect(H.canvas.style.cursor).toBe('')

    // The browser can still deliver the physical button's trailing release;
    // cancellation already cleared ownership, so it must be inert.
    pointer('pointerup', H.canvas, radialScale(2))
    expect(sketcherToolStore.getState().filletRadius).toBe(2)
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)

    sketcherTools.overlayApply()
    expect(H.sketch.entities.find((entity) => entity.kind === 'arc'))
      .toMatchObject({ radius: 2 })
  })
})

describe('SKC-45 staged chamfer setback parity', () => {
  const CORNER = { x: 20, y: 0 }
  // A right-angle 2 mm chamfer runs from (18,0) to (20,2); its midpoint
  // is an exact point on the dashed preview and scales radially with setback.
  const D2_MID = { x: 19, y: 1 }
  const radialScale = (scale: number): Vec2 => ({
    x: CORNER.x + (D2_MID.x - CORNER.x) * scale,
    y: CORNER.y + (D2_MID.y - CORNER.y) * scale,
  })

  it('SKC-45 typed setback repaints the live chamfer preview without a document commit', () => {
    const documentBefore = JSON.stringify(filletSketch())
    stageChamferCorner()
    const d2 = dashedGhostBuffers()
    expect(d2).toHaveLength(1)

    sketcherTools.commitDrawValueAt(4, CORNER)

    expect(sketcherToolStore.getState().chamferSetback).toBe(4)
    const d4 = dashedGhostBuffers()
    expect(d4).toHaveLength(1)
    expect(d4[0]).not.toEqual(d2[0])
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    expect(H.beginStepCalls).toBe(0)
  })

  it('SKC-45 constructed drag uses grab cursor, updates preview, and Apply matches exactly', () => {
    const documentBefore = JSON.stringify(filletSketch())
    establishRememberedChamferSize(2) // SKC-46-R1: production memory path replaces the store pin
    stageChamferCorner()
    H.host.worldPerPixel = () => 0.05
    const d2 = dashedGhostBuffers()

    pointer('pointermove', H.canvas, D2_MID)
    expect(H.canvas.style.cursor).toBe('grab')

    pointer('pointerdown', H.canvas, D2_MID)
    expect(H.canvas.style.cursor).toBe('grabbing')
    expect(H.capture.pointerId).toBe(1)

    pointer('pointermove', H.canvas, radialScale(1.5))
    expect(sketcherToolStore.getState().chamferSetback).toBeCloseTo(3, 8)
    const d3 = dashedGhostBuffers()
    expect(d3[0]).not.toEqual(d2[0])

    const d4Point = radialScale(2)
    pointer('pointermove', H.canvas, d4Point)
    expect(sketcherToolStore.getState().chamferSetback).toBeCloseTo(4, 8)
    const d4 = dashedGhostBuffers()
    expect(d4[0]).not.toEqual(d3[0])
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    expect(H.beginStepCalls).toBe(0)
    expect(H.dragBeginCalls).toBe(0)

    pointer('pointerup', H.canvas, d4Point)
    expect(H.canvas.style.cursor).toBe('grab')
    expect(H.capture.pointerId).toBeNull()
    const previewSetback = sketcherToolStore.getState().chamferSetback

    sketcherTools.overlayApply()

    expect(H.beginStepCalls).toBe(1)
    const setbackDimensions = H.sketch.dimensions.filter((dimension) =>
      dimension.kind === 'distance' && dimension.driving && dimension.value === previewSetback)
    expect(setbackDimensions).toHaveLength(2)
    expect(previewSetback).toBeCloseTo(4, 8)
    expect(dashedGhostBuffers()).toEqual([])
  })

  it('SKC-45 Escape restores chamfer setback, ghost, capture, and staged corner', () => {
    const documentBefore = JSON.stringify(filletSketch())
    establishRememberedChamferSize(2) // SKC-46-R1: production memory path replaces the store pin
    stageChamferCorner()
    const d2 = dashedGhostBuffers()
    const releasesBeforeDrag = H.capture.releaseCalls.length

    pointer('pointerdown', H.canvas, D2_MID)
    pointer('pointermove', H.canvas, radialScale(2))
    expect(sketcherToolStore.getState().chamferSetback).toBeCloseTo(4, 8)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(sketcherToolStore.getState().chamferSetback).toBe(2)
    expect(sketcherToolStore.getState().chain).toMatchObject({
      kind: 'chamfer',
      corners: [{ at: CORNER }],
    })
    expect(dashedGhostBuffers()).toEqual(d2)
    expect(JSON.stringify(H.sketch)).toBe(documentBefore)
    expect(H.beginStepCalls).toBe(0)
    expect(H.capture.pointerId).toBeNull()
    expect(H.capture.releaseCalls).toHaveLength(releasesBeforeDrag + 1)
    expect(H.canvas.style.cursor).toBe('')
  })
})

describe('SKC-46 staged-size memory: commit-only, cancel never overwrites', () => {
  it('commits a fillet at size X; the NEXT staging session on a similar corner stages at X', () => {
    stageFilletCorner()
    sketcherTools.commitDrawValueAt(9, { x: 20, y: 0 }) // typed entry (production path)
    sketcherTools.overlayApply()
    expect(H.lastSizes.fillet).toBe(9) // WRITTEN only because this was a real, applied commit

    // A fresh corner -- the "browser refresh / new file" case the WO describes: the remembered
    // size is a HOST-level preference, not document state.
    H.sketch = filletSketch()
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('fillet')
    clickAt(20, 0)
    expect(sketcherToolStore.getState().filletRadius).toBe(9)
  })

  it('a canceled DRAG (Escape mid-drag) never overwrites the remembered size', () => {
    stageFilletCorner()
    sketcherTools.commitDrawValueAt(9, { x: 20, y: 0 }) // typed entry (production path)
    sketcherTools.overlayApply()
    expect(H.lastSizes.fillet).toBe(9)

    H.sketch = filletSketch()
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('fillet')
    clickAt(20, 0)
    const CORNER = { x: 20, y: 0 }
    const seeded = sketcherToolStore.getState().filletRadius
    expect(seeded).toBe(9) // seeded from memory
    const arc = dashedGhostBuffers()[0]
    const mid = { x: arc[3], y: arc[4] } // an on-preview point (see R2_MID convention above)
    pointer('pointerdown', H.canvas, mid)
    pointer('pointermove', H.canvas, { x: CORNER.x + (mid.x - CORNER.x) * 2, y: CORNER.y + (mid.y - CORNER.y) * 2 })
    expect(sketcherToolStore.getState().filletRadius).not.toBeCloseTo(seeded, 6) // the drag DID move it
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(sketcherToolStore.getState().filletRadius).toBeCloseTo(seeded, 8) // restored, never applied
    expect(H.lastSizes.fillet).toBe(9) // memory untouched by the whole cancelled gesture
  })

  it('a canceled CHAIN (Escape with no drag) never overwrites the remembered size', () => {
    stageFilletCorner()
    sketcherTools.commitDrawValueAt(9, { x: 20, y: 0 }) // typed entry (production path)
    sketcherTools.overlayApply()
    expect(H.lastSizes.fillet).toBe(9)

    H.sketch = filletSketch()
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('fillet')
    clickAt(20, 0)
    sketcherTools.commitDrawValueAt(3, { x: 20, y: 0 }) // a live typed edit that is never applied
    expect(sketcherTools.escape()).toBe(true)
    expect(H.lastSizes.fillet).toBe(9)
  })

  it('fillet and chamfer memory are independent (per-tool memory)', () => {
    stageFilletCorner()
    sketcherTools.commitDrawValueAt(6, { x: 20, y: 0 }) // typed entry (production path)
    sketcherTools.overlayApply()
    expect(H.lastSizes.fillet).toBe(6)
    expect(H.lastSizes.chamfer).toBeNull()

    H.sketch = filletSketch()
    H.sketcher.updateSketch(H.sketch)
    stageChamferCorner()
    sketcherTools.commitDrawValueAt(3, { x: 20, y: 0 }) // typed entry (production path)
    sketcherTools.overlayApply()
    expect(H.lastSizes.chamfer).toBe(3)
    expect(H.lastSizes.fillet).toBe(6) // unaffected by the chamfer commit
  })
})

describe('SKC-46 grabbable default derivation (no more fixed 2mm)', () => {
  it('a small corner stages a default that never exceeds what the corner can take', () => {
    H.sketch = filletSketch(4)
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('fillet')
    H.sketcher.enter()
    clickAt(20, 0)
    const r = sketcherToolStore.getState().filletRadius
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThanOrEqual(4) // maxUsable = tan(45deg) * 4
  })

  it('a large corner stages a comfortably-grabbable default, not a runaway huge one', () => {
    H.sketch = filletSketch(100)
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('fillet')
    H.sketcher.enter()
    clickAt(20, 0)
    const r = sketcherToolStore.getState().filletRadius
    expect(r).toBeGreaterThan(2) // clears the old fixed default with real margin
    expect(r).toBeLessThanOrEqual(25) // sane absolute ceiling regardless of corner size
  })

  it('never regresses to the fixed 2mm default Operator reported as ungrabbable', () => {
    H.sketch = filletSketch(30)
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('fillet')
    H.sketcher.enter()
    clickAt(20, 0)
    expect(sketcherToolStore.getState().filletRadius).not.toBe(2)
  })

  it('chamfer gets the same treatment (parity within the shared stagedSizeDrag surface)', () => {
    H.sketch = filletSketch(4)
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool('chamfer')
    H.sketcher.enter()
    clickAt(20, 0)
    const v = sketcherToolStore.getState().chamferSetback
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThanOrEqual(4) // maxUsable = min(leg, leg) = 4
  })
})

// ---- SKC-46-R1: BLOCKER 1 + MAJOR 2 close-out --------------------------------------------------
//
// Production-path gates driving seed -> preview -> pointer ACQUISITION -> apply at explicit
// worldPerPixel values, across all four corner classes the WO names (small, large,
// remembered-oversize, sub-floor) x both tools. `filletSketch(armLength)` is always a RIGHT-ANGLE
// corner, so the geometric ceiling for BOTH tools equals `armLength` exactly (fillet:
// tan(45deg)*armLength = armLength; chamfer: min(armLength, armLength) = armLength) -- one shared
// helper covers both.
//
// "BOTH sketcher hosts" (the WO's parity rule): this harness IS the generic `SketchDocumentPort`
// both real hosts (workbenchSketchDocumentPort.ts for Part-studio, Viewport.tsx/store/index.ts for
// CAM) implement to reach this exact STORE-FREE `toolController.ts` -- proven structurally by
// oneSketchPointerOwner.test.ts's capability scan (one sketch-pointer owner, package is
// store-free). There is no host-specific branch anywhere in the seed/clamp/refuse path under
// test, so one pass through this generic port proves both mounts; duplicating it against two
// concrete DOM component trees would re-prove that same structural guarantee, not add coverage.
describe('SKC-46-R1: remembered/derived size ALWAYS previews and applies, or refuses BY NAME (BLOCKER 1)', () => {
  const CORNER = { x: 20, y: 0 }

  /** A real point ON the first staged preview's rendered path -- read back from the actual
   *  tessellated buffer (not hand-derived geometry), so pointer acquisition is proven against
   *  whatever the real preview draws, for either tool. */
  function pointOnFirstGhost(): Vec2 {
    const buf = dashedGhostBuffers()[0]
    expect(buf, 'expected a staged preview to acquire a pointer point from').toBeDefined()
    const vertexCount = buf.length / 3
    if (vertexCount <= 2) {
      // A straight (chamfer) segment: the true midpoint lies exactly ON the line (matching the
      // hand-computed D2_MID convention above).
      return { x: (buf[0] + buf[3]) / 2, y: (buf[1] + buf[4]) / 2 }
    }
    // A tessellated (fillet) arc: the exact MIDDLE vertex is an on-path point, and -- unlike the
    // start/end vertices -- stays clear of the tangent points, which sit close to the corner's
    // OWN line endpoints on a near-maximal radius (the oversize corner class) and can otherwise
    // register as a separate snap point, routing hover through the jsdom-unsupported canvas-badge
    // paint path.
    const mid = Math.floor(vertexCount / 2)
    return { x: buf[mid * 3], y: buf[mid * 3 + 1] }
  }

  /**
   * Drives seed -> preview -> pointer ACQUISITION -> Apply for one corner class, and asserts the
   * WO's can-fail shape: the batch stages, previews (>=1 fit), the final staged size sits
   * STRICTLY under the corner's own geometric ceiling (BLOCKER 1's core claim), a real point on
   * the rendered preview acquires the grab cursor, and Apply commits a non-null transform
   * (`H.beginStepCalls` only increments inside `overlayApply` when `r.transform` is non-null --
   * see toolController.ts's fillet/chamfer branches).
   */
  function assertStagesPreviewsAndApplies(kind: 'fillet' | 'chamfer', armLength: number): void {
    H.sketch = filletSketch(armLength)
    H.sketcher.updateSketch(H.sketch)
    sketcherTools.armTool(kind)
    H.sketcher.enter()
    clickAt(20, 0)
    expect(sketcherToolStore.getState().chain, `${kind} @ ${armLength}mm leg should stage`)
      .toMatchObject({ kind, corners: [{ at: CORNER }] })

    const stagedSize = kind === 'fillet'
      ? sketcherToolStore.getState().filletRadius : sketcherToolStore.getState().chamferSetback
    expect(Number.isFinite(stagedSize), `${kind} @ ${armLength}mm staged size must be finite`).toBe(true)
    // BLOCKER 1: the right-angle geometric ceiling here is exactly `armLength` (see header) --
    // the staged size must sit STRICTLY under it, never AT or past it.
    expect(stagedSize, 'BLOCKER 1: staged size must sit strictly under the geometric ceiling')
      .toBeLessThan(armLength)

    H.host.worldPerPixel = () => 0.05
    const ghosts = dashedGhostBuffers()
    expect(ghosts.length, `${kind} @ ${armLength}mm must preview (>=1 fit)`).toBeGreaterThanOrEqual(1)

    const grabPoint = pointOnFirstGhost()
    pointer('pointermove', H.canvas, grabPoint)
    expect(H.canvas.style.cursor, `${kind} @ ${armLength}mm: a real preview point must be grabbable`)
      .toBe('grab')

    const beginStepsBefore = H.beginStepCalls
    sketcherTools.overlayApply()
    expect(H.beginStepCalls, `${kind} @ ${armLength}mm Apply must commit a non-null transform`)
      .toBe(beginStepsBefore + 1)
  }

  /** Sub-floor refusal: no legal size exists above the shared 0.01mm floor for this corner.
   *  Asserts the WO's can-fail shape: a NAMED notice, ZERO staged preview, and memory untouched. */
  function assertRefusesNamed(kind: 'fillet' | 'chamfer', armLength: number): void {
    H.sketch = filletSketch(armLength)
    H.sketcher.updateSketch(H.sketch)
    const memoryBefore = kind === 'fillet' ? H.lastSizes.fillet : H.lastSizes.chamfer
    sketcherTools.armTool(kind)
    H.sketcher.enter()
    H.notices.length = 0

    clickAt(20, 0)

    const named = H.notices.filter((n) => /too small/i.test(n) && new RegExp(kind, 'i').test(n))
    expect(named, `expected a NAMED refusal notice, got: ${JSON.stringify(H.notices)}`).toHaveLength(1)
    expect(sketcherToolStore.getState().chain, 'refused corner must not stage a chain').toBeNull()
    expect(dashedGhostBuffers(), 'refused corner must stage ZERO preview').toEqual([])
    expect(kind === 'fillet' ? H.lastSizes.fillet : H.lastSizes.chamfer, 'memory must be untouched')
      .toBe(memoryBefore)
  }

  describe.each(['fillet', 'chamfer'] as const)('%s', (kind) => {
    it('SMALL corner (no remembered size): derived default stages, previews, and applies', () => {
      assertStagesPreviewsAndApplies(kind, 4)
    })

    it('LARGE corner (no remembered size): derived default stages, previews, and applies', () => {
      assertStagesPreviewsAndApplies(kind, 100)
    })

    it('REMEMBERED-OVERSIZE (Operator\'s exact scenario): a remembered 10mm on a 4mm corner clamps, previews, and applies', () => {
      // Commit a real 10mm size on a corner that legally takes it (armLength=20, the
      // establish-helpers' own default), THEN stage a FRESH 4mm corner -- the remembered size
      // wins over the derived default but must clamp to what THIS corner can take.
      if (kind === 'fillet') establishRememberedFilletSize(10)
      else establishRememberedChamferSize(10)
      const remembered = kind === 'fillet' ? H.lastSizes.fillet : H.lastSizes.chamfer
      expect(remembered).toBe(10)

      assertStagesPreviewsAndApplies(kind, 4)
    })

    it('SUB-FLOOR corner (0.001mm legs): refuses by name, zero preview, memory untouched', () => {
      assertRefusesNamed(kind, 0.001)
    })

    it('SUB-FLOOR does not clear an EXISTING remembered size (refusal never overwrites memory)', () => {
      if (kind === 'fillet') establishRememberedFilletSize(6)
      else establishRememberedChamferSize(6)
      expect(kind === 'fillet' ? H.lastSizes.fillet : H.lastSizes.chamfer).toBe(6)

      assertRefusesNamed(kind, 0.001)
    })
  })
})

// ---- SKC-46-R2 requirement 2b: MIXED-CHAIN RULING ----------------------------------------------
//
// Architect ruling (preflight's "largest unnamed state"): resolvability is judged per ADDITION,
// not only per aggregate. Neither R0 nor R1 named this: a preselection spanning an L-corner plus a
// collinear extension staged the dead corner as an INVISIBLE warning marker forever (Apply-skip,
// but no notice at STAGE time); a click addition of a dead corner onto an existing resolvable batch
// silently no-opped (the aggregate stayed finite, so `shouldSeed` never fired at all).
describe('SKC-46-R2: mixed-chain ruling (resolvability judged per ADDITION, not only per aggregate)', () => {
  /** filletSketch()'s A (0,0)-(20,0) / B (20,0)-(20,20) right-angle corner, PLUS a THIRD line C
   *  that extends A collinearly past the shared corner: (20,0)-(40,0). Selecting all three seeds
   *  THREE corners at (20,0) -- (A,B) legal, (A,C) collinear/unresolvable, (B,C) legal -- the exact
   *  "L-corner plus collinear extension" scenario the preflight traced end-to-end. */
  function mixedPreselectionSketch(): Sketch {
    const base = filletSketch()
    const C: SketchEntity = {
      id: 'fillet-c', kind: 'line', construction: false,
      start: { x: 20, y: 0 }, end: { x: 40, y: 0 },
    }
    return { ...base, entities: [...base.entities, C] }
  }

  /** A SECOND, independent corner elsewhere in the doc that is PURELY collinear (D continues C in
   *  a straight line) -- clicking it adds a corner whose OWN per-corner max is unresolvable, while
   *  the FIRST corner (A,B) may already be staged from an earlier click. */
  function withDeadSecondCorner(sketch: Sketch): Sketch {
    return {
      ...sketch,
      entities: [
        ...sketch.entities,
        { id: 'dead-c', kind: 'line', construction: false, start: { x: 100, y: 0 }, end: { x: 120, y: 0 } },
        { id: 'dead-d', kind: 'line', construction: false, start: { x: 120, y: 0 }, end: { x: 140, y: 0 } },
      ],
    }
  }

  /** A THIRD line N sharing the SAME corner point as A/B, but with a NaN endpoint -- both (A,N)
   *  and (B,N) resolve to a NaN per-corner ceiling (every existing numeric guard in
   *  filletTool.ts/chamferTool.ts lets a poisoned coordinate through silently), proving the dead
   *  corner is dropped as `non-finite`, not silently absorbed behind the (A,B) finite sibling. */
  function nanSiblingPreselectionSketch(): Sketch {
    const base = filletSketch()
    const N: SketchEntity = {
      id: 'fillet-n', kind: 'line', construction: false,
      start: { x: 20, y: 0 }, end: { x: NaN, y: 5 },
    }
    return { ...base, entities: [...base.entities, N] }
  }

  describe.each(['fillet', 'chamfer'] as const)('%s', (kind) => {
    it('PRESELECTION: a mixed set (L-corner + collinear extension) stages only the resolvable corners and counts the drop', () => {
      H.sketch = mixedPreselectionSketch()
      H.sketcher.updateSketch(H.sketch)
      H.selection = ['fillet-a', 'fillet-b', 'fillet-c']
      H.notices.length = 0

      sketcherTools.armTool(kind)
      H.sketcher.enter()

      const chain = sketcherToolStore.getState().chain
      expect(chain?.kind, 'the surviving corners must still be this tool\'s chain').toBe(kind)
      // 2 of the 3 seeded pairs resolve ((A,B) and (B,C)); (A,C) is collinear.
      expect((chain as { corners: unknown[] } | null)?.corners).toHaveLength(2)
      const named = H.notices.filter((n) => /1 corner/i.test(n) && new RegExp(kind, 'i').test(n))
      expect(named, `expected ONE named drop-count notice, got: ${JSON.stringify(H.notices)}`).toHaveLength(1)
    })

    it('PRESELECTION: when NO corner in the selection resolves, the existing full refusal applies (empty chain, zero preview)', () => {
      H.sketch = withDeadSecondCorner(filletSketch())
      H.sketcher.updateSketch(H.sketch)
      H.selection = ['dead-c', 'dead-d']
      H.notices.length = 0

      sketcherTools.armTool(kind)
      H.sketcher.enter()

      const chain = sketcherToolStore.getState().chain
      expect((chain as { corners: unknown[] } | null)?.corners ?? [], 'no corner should stage').toHaveLength(0)
      expect(dashedGhostBuffers(), 'zero staged preview').toEqual([])
      expect(H.notices.some((n) => new RegExp(kind, 'i').test(n)), 'a named notice must still fire').toBe(true)
    })

    it('PRESELECTION: a NaN-poisoned sibling is dropped as non-finite, never silently absorbed behind a finite corner', () => {
      H.sketch = nanSiblingPreselectionSketch()
      H.sketcher.updateSketch(H.sketch)
      H.selection = ['fillet-a', 'fillet-b', 'fillet-n']
      H.notices.length = 0

      sketcherTools.armTool(kind)
      H.sketcher.enter()

      const chain = sketcherToolStore.getState().chain
      // Only (A,B) is finite; (A,N) and (B,N) both resolve to a NaN ceiling and must be dropped.
      expect((chain as { corners: Array<{ aId: string; bId: string }> } | null)?.corners).toEqual([
        expect.objectContaining({ aId: 'fillet-a', bId: 'fillet-b' }),
      ])
      expect(H.notices.some((n) => /2 corners/i.test(n) && new RegExp(kind, 'i').test(n)), 'names 2 drops')
        .toBe(true)
    })

    it('CLICK addition: a corner whose own max is unresolvable is refused outright, prior batch intact, memory untouched', () => {
      H.sketch = withDeadSecondCorner(filletSketch())
      H.sketcher.updateSketch(H.sketch)
      const memoryBefore = kind === 'fillet' ? H.lastSizes.fillet : H.lastSizes.chamfer
      sketcherTools.armTool(kind)
      H.sketcher.enter()

      clickAt(20, 0) // stage the legitimate (A,B) corner first
      expect(sketcherToolStore.getState().chain).toMatchObject({ kind, corners: [{ at: { x: 20, y: 0 } }] })
      H.notices.length = 0

      clickAt(120, 0) // attempt to add the dead (dead-c, dead-d) corner

      const named = H.notices.filter((n) => new RegExp(kind, 'i').test(n))
      expect(named, `expected a named refusal, got: ${JSON.stringify(H.notices)}`).toHaveLength(1)
      // The batch reverts to EXACTLY what it was before this click -- the (A,B) corner survives.
      expect(sketcherToolStore.getState().chain).toMatchObject({ kind, corners: [{ at: { x: 20, y: 0 } }] })
      expect((kind === 'fillet' ? H.lastSizes.fillet : H.lastSizes.chamfer)).toBe(memoryBefore)
    })
  })
})

describe('BK-136: one armed hover pointermove computes ONE preview (SKC-46 rider)', () => {
  // The exact R2 arc midpoint fixture from the SKC-44 suite above: a real dashed-arc hit for the
  // hover-hit-test path (stagedSizeDragAt), landing on the SAME preview the overlay paints.
  const CORNER = { x: 20, y: 0 }
  const R2_MID = { x: CORNER.x - 2 + Math.SQRT2, y: 2 - Math.SQRT2 }

  it('fillet: the hover cursor decision and the overlay paint share ONE filletChainPreview computation', () => {
    establishRememberedFilletSize(2) // SKC-46-R1: production memory path replaces the store pin
    stageFilletCorner()
    // Keeps the theoretical sharp-corner point outside the (canvas-2D-drawn) snap-badge radius,
    // same as the SKC-44 fixture above -- this test targets the preview PATH, not badge painting.
    H.host.worldPerPixel = () => 0.05
    __resetFilletChainPreviewMemo()

    pointer('pointermove', H.canvas, R2_MID)

    expect(H.canvas.style.cursor).toBe('grab') // proves the hover-hit-test path actually ran
    expect(__filletPreviewComputeCount()).toBe(1)
  })

  it('chamfer: the hover cursor decision and the overlay paint share ONE chamferChainPreview computation', () => {
    establishRememberedChamferSize(2) // SKC-46-R1: production memory path replaces the store pin
    stageChamferCorner()
    H.host.worldPerPixel = () => 0.05
    __resetChamferChainPreviewMemo()

    const D2_MID = { x: 19, y: 1 }
    pointer('pointermove', H.canvas, D2_MID)

    expect(H.canvas.style.cursor).toBe('grab')
    expect(__chamferPreviewComputeCount()).toBe(1)
  })
})

describe('Project source resolution stays package-owned and fail-closed', () => {
  const edge = () => modelCandidate('model-edge', [projectPath(
    'edge-1',
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }],
    false,
  )])

  it('one external resolution drives each event and pointerup passes it to commit without re-resolve', () => {
    const contexts: Parameters<NonNullable<SketchDocumentPort['resolveProjectSource']>>[0][] = []
    H.doc.resolveProjectSource = vi.fn((context): ProjectResolveResult => {
      contexts.push(context)
      return { ok: true, candidate: edge() }
    })
    sketcherTools.armTool('project')
    H.sketcher.enter()

    pointer('pointermove', H.canvas, { x: 25, y: 35 })
    expect(H.doc.resolveProjectSource).toHaveBeenCalledTimes(1)
    expect(contexts[0]).toMatchObject({ clientX: 25, clientY: 35, local: { x: 25, y: 35 } })
    expect(H.canvas.style.cursor).toBe('pointer')
    expect(previewLines()).toHaveLength(1)

    clickAt(25, 35)
    // FAILS-IF toolController re-resolves through the empty CAM fallback: no append occurs. It also
    // fails if pointerup calls the external resolver more than once.
    expect(H.doc.resolveProjectSource).toHaveBeenCalledTimes(2)
    expect(contexts[1].expectedSource).toEqual({
      stablePickKey: edge().stablePickKey,
      sourceIdentity: edge().sourceIdentity,
    })
    expect(H.appendCalls).toBe(1)
    expect(H.beginGestureCalls).toBe(1)
    expect(drawn(H)).toHaveLength(2)
    expect(drawn(H).every((entity) => !entity.construction)).toBe(true)
  })

  it('commits a model vertex through the real pointer path as one fixed projected point', () => {
    const vertex: ProjectCandidate = {
      paths: [],
      points: [{ x: 25, y: 35 }],
      sourceKind: 'model-vertex',
      sourceLabel: 'Model vertex',
      stablePickKey: 'model-vertex:body-1:fixture',
      sourceIdentity: { bodyId: 'body-1', cacheVersion: 1, stableId: 'vertex-fixture' },
    }
    H.doc.resolveProjectSource = () => ({ ok: true, candidate: vertex })
    sketcherTools.armTool('project')
    H.sketcher.enter()

    pointer('pointermove', H.canvas, { x: 25, y: 35 })
    expect(previewLines()).toHaveLength(2) // the point hover cross
    clickAt(25, 35)

    expect(H.appendCalls).toBe(1)
    expect(H.beginGestureCalls).toBe(1)
    expect(drawn(H)).toEqual([{
      id: expect.any(String),
      kind: 'point',
      construction: false,
      provenance: 'projected',
      at: { x: 25, y: 35 },
      // WO-1864: a model-vertex point commits LINKED, so it follows the model.
      projectionLink: expect.objectContaining({ sourceKind: 'model-vertex', bodyId: 'body-1', stableId: 'vertex-fixture' }),
    }])
    expect(H.sketch.constraints).toContainEqual({
      id: expect.any(String),
      kind: 'fix',
      entityId: drawn(H)[0].id,
      projectionGrounding: true,
    })
  })

  it('commits a grouped face outer+hole candidate in one append and one undo step', () => {
    const outer = projectPath(
      'outer',
      [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
      true,
    )
    const hole = projectPath(
      'hole',
      [{ x: 5, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 7 }, { x: 5, y: 7 }],
      true,
    )
    const grouped = modelCandidate('model-face', [outer, hole])
    H.doc.resolveProjectSource = () => ({ ok: true, candidate: grouped })
    sketcherTools.armTool('project')
    H.sketcher.enter()

    clickAt(10, 5)

    expect(H.appendCalls).toBe(1)
    expect(H.beginGestureCalls).toBe(1)
    expect(drawn(H)).toHaveLength(8)
    expect(H.sketch.constraints.filter((constraint) => constraint.kind === 'fix')).toHaveLength(8)
  })

  it('refuses a cache-version change by name and mutates nothing', () => {
    const contexts: Parameters<NonNullable<SketchDocumentPort['resolveProjectSource']>>[0][] = []
    let call = 0
    H.doc.resolveProjectSource = (context): ProjectResolveResult => {
      contexts.push(context)
      return { ok: true, candidate: modelCandidate('model-edge', edge().paths, ++call) }
    }
    sketcherTools.armTool('project')
    H.sketcher.enter()

    pointer('pointermove', H.canvas, { x: 30, y: 40 }) // preview version 1
    clickAt(30, 40) // pointerup resolves version 2 against expected version 1

    expect(contexts).toHaveLength(2)
    expect(contexts[1].expectedSource?.sourceIdentity.cacheVersion).toBe(1)
    expect(H.appendCalls).toBe(0)
    expect(H.beginGestureCalls).toBe(0)
    expect(H.notices.join('\n')).toMatch(/source geometry changed after preview/)
    expect(previewLines()).toHaveLength(0)
  })

  it('miss and every package lifecycle tail clear external preview state while Project stays armed', () => {
    const contexts: Parameters<NonNullable<SketchDocumentPort['resolveProjectSource']>>[0][] = []
    let missNext = false
    H.doc.resolveProjectSource = (context) => {
      contexts.push(context)
      if (missNext) {
        missNext = false
        return { ok: false, reason: 'miss', message: 'Project: no model source here' }
      }
      return { ok: true, candidate: edge() }
    }
    sketcherTools.armTool('project')
    H.sketcher.enter()

    pointer('pointermove', H.canvas, { x: 25, y: 35 })
    expect(previewLines()).toHaveLength(1)
    missNext = true
    pointer('pointermove', H.canvas, { x: 26, y: 36 })
    expect(previewLines()).toHaveLength(0)
    expect(H.canvas.style.cursor).toBe('crosshair')
    expect(sketcherToolStore.getState().tool).toBe('project')

    missNext = true
    clickAt(26, 36)
    expect(H.appendCalls).toBe(0)
    expect(H.beginGestureCalls).toBe(0)
    expect(sketcherToolStore.getState().tool).toBe('project')
    expect(previewLines()).toHaveLength(0)

    clickAt(26, 36)
    expect(contexts.at(-1)?.expectedSource).toBeUndefined()
    expect(previewLines()).toHaveLength(1)

    sketcherTools.armTool('select')
    H.sketcher.onFrame(1, 800, 600)
    expect(previewLines()).toHaveLength(0)

    sketcherTools.armTool('project')
    pointer('pointermove', H.canvas, { x: 27, y: 37 })
    expect(previewLines()).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(previewLines()).toHaveLength(0)

    sketcherTools.armTool('project')
    pointer('pointermove', H.canvas, { x: 28, y: 38 })
    H.sketcher.setDocumentPort(H.doc)
    expect(previewLines()).toHaveLength(0)

    pointer('pointermove', H.canvas, { x: 29, y: 39 })
    expect(previewLines()).toHaveLength(1)
    H.sketcher.exit()
    expect(previewLines()).toHaveLength(0)
  })
})

// ---- undo granularity: ONE step per gesture, opened inside the component -----------------------
//
// WO SKC-14B: these now drive the REAL tool machine (the package owns it), so "a click that
// mutates" and "a click that only advances the chain" are decided by the same code the user's
// clicks reach -- not by a harness flag. The line tool's FIRST click opens a chain and writes
// nothing; its SECOND click commits a segment.

describe('one undoable step per gesture (the component latches it)', () => {
  it('a chain-advancing click opens NO step (it costs no Ctrl+Z)', () => {
    sketcherTools.armTool('line')
    H.sketcher.enter()
    clickAt(100, 100) // line click 1: starts the chain, writes nothing
    // FAILS-IF: the component opens a step before every click. Each no-op step is a Ctrl+Z press
    // that appears to do nothing -- the regression the `beforeMutate` latch exists to prevent.
    expect(H.beginGestureCalls).toBe(0)
    expect(H.appendCalls).toBe(0)
  })

  it('a committing click opens EXACTLY ONE step', () => {
    sketcherTools.armTool('line')
    H.sketcher.enter()
    clickAt(100, 100)
    clickAt(140, 100) // commits one segment
    expect(H.appendCalls).toBe(1)
    // FAILS-IF: the latch is dropped and the commit's writes each open a step -- the user would
    // need several Ctrl+Z presses to undo one click.
    expect(H.beginGestureCalls).toBe(1)
  })

  it('two successive committing clicks are two separate steps (a fresh latch per gesture)', () => {
    sketcherTools.armTool('line')
    H.sketcher.enter()
    // The line chain CONTINUES from each commit, so clicks 2 and 3 each commit a segment.
    clickAt(100, 100)
    clickAt(140, 100)
    clickAt(180, 100)
    expect(H.appendCalls).toBe(2)
    expect(H.beginGestureCalls).toBe(2)
  })
})

// ---- the DOM dimension-label drag (moved out of SketchDimensionOverlay) ------------------------

describe('the dimension VALUE-LABEL gesture belongs to the component', () => {
  it('a drag past the threshold opens ONE step and moves the label by the screen delta', () => {
    H.sketcher.enter()
    pointer('pointerdown', H.label, { x: 50, y: 50 })
    // Sub-threshold: still a click, nothing committed, no step.
    pointer('pointermove', window, { x: 51, y: 51 })
    expect(H.beginGestureCalls).toBe(0)
    expect(H.labelMoves).toEqual([])

    // Past the 3px threshold: one step, then a label move per pointermove.
    pointer('pointermove', window, { x: 60, y: 40 })
    pointer('pointermove', window, { x: 70, y: 30 })
    pointer('pointerup', window, { x: 70, y: 30 })

    expect(H.beginGestureCalls).toBe(1)
    // worldPerPixel = 1, anchor = (5,-5). Screen y grows DOWN, world y grows UP.
    //   dx = +20, dy = -20  ->  ( 5 + 20, -5 - (-20) ) = (25, 15)
    expect(H.labelMoves).toEqual([
      ['d1', { x: 15, y: 5 }],   // dx=+10, dy=-10
      ['d1', { x: 25, y: 15 }],  // dx=+20, dy=-20
    ])
    // A completed drag is not a click: the selection is untouched.
    expect(H.selection).toEqual([])
  })

  it('a sub-threshold press selects the dimension (and Shift toggles it)', () => {
    H.sketcher.enter()
    pointer('pointerdown', H.label, { x: 50, y: 50 })
    pointer('pointerup', window, { x: 51, y: 50 })
    expect(H.selection).toEqual(['d1'])
    expect(H.beginGestureCalls).toBe(0)
    expect(H.labelMoves).toEqual([])

    // Shift-click toggles it back out, same rule as entity picking.
    pointer('pointerdown', H.label, { x: 50, y: 50 })
    pointer('pointerup', window, { x: 50, y: 50, shiftKey: true })
    expect(H.selection).toEqual([])
  })

  it('a double-click on the label opens the value editor', () => {
    H.sketcher.enter()
    pointer('dblclick', H.label, { x: 50, y: 50 })
    expect(H.dimEditorOpens).toEqual(['d1'])
  })

  it('after exit the label is inert (the gesture is session-scoped)', () => {
    H.sketcher.enter()
    H.sketcher.exit()
    pointer('pointerdown', H.label, { x: 50, y: 50 })
    pointer('pointermove', window, { x: 70, y: 30 })
    pointer('pointerup', window, { x: 70, y: 30 })
    expect(H.labelMoves).toEqual([])
    expect(H.beginGestureCalls).toBe(0)
  })
})

// ---- the right-button context menu (moved out of Viewport) -------------------------------------

describe('the context-menu gesture belongs to the component', () => {
  it('a right press released in place requests a menu at the release point', () => {
    H.sketcher.enter()
    pointer('pointerdown', H.canvas, { x: 200, y: 150, button: 2 })
    pointer('contextmenu', H.canvas, { x: 202, y: 151 })
    expect(H.menu.opened).toEqual([[202, 151]])
  })

  it('a right DRAG is an orbit-controls pan, not a menu request', () => {
    H.sketcher.enter()
    pointer('pointerdown', H.canvas, { x: 200, y: 150, button: 2 })
    pointer('contextmenu', H.canvas, { x: 260, y: 150 }) // 60px > the 5px pan threshold
    expect(H.menu.opened).toEqual([])
  })

  it('the browser default menu is suppressed inside the sketch surface', () => {
    H.sketcher.enter()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    H.canvas.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('after exit the surface gives the browser its menu back', () => {
    H.sketcher.enter()
    H.sketcher.exit()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    H.canvas.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(H.menu.opened).toEqual([])
  })
})

// ---- the explicit blur bridge (WO UI-26-R1 finding 2) ------------------------------------------
//
// SketchDimensionOverlay / SketchDrawValueInput commit on blur (WO UI-26 A1), but a real canvas
// press never NATURALLY blurs a focused DOM input the way a click on another focusable element
// would -- handlePointerDown's own `event.preventDefault()` (line ~519) suppresses that default
// browser focus-shift. Without the explicit `focused.blur()` this file's canvas gestures never
// exercise, a typed correction left in an open `.sketch-dim-input` would be UNREACHABLE by a real
// click-away: the audit found no unit test drove this path.

describe('a canvas pointerdown explicitly blurs a focused sketch value editor (finding 2)', () => {
  it('blurs a focused .sketch-dim-input exactly once', () => {
    H.sketcher.enter()
    const input = document.createElement('input')
    input.className = 'sketch-dim-input'
    document.body.appendChild(input)
    input.focus()
    expect(document.activeElement, 'the input must be really focused for this to mean anything')
      .toBe(input)

    let blurs = 0
    input.addEventListener('blur', () => { blurs++ })

    pointer('pointerdown', H.canvas, { x: 100, y: 100 })

    expect(document.activeElement).not.toBe(input)
    // FAILS-IF the explicit blur() is dropped: the input stays focused and this stays 0, which is
    // exactly the "corrected value unreachable by a real click" hole the audit found.
    expect(blurs).toBe(1)
  })

  it('leaves an unrelated focused element alone (the bridge is class-scoped, not blur-everything)', () => {
    H.sketcher.enter()
    const other = document.createElement('input')
    other.className = 'sketch-text-input' // the WYSIWYG text editor -- a different class, untouched
    document.body.appendChild(other)
    other.focus()

    pointer('pointerdown', H.canvas, { x: 100, y: 100 })

    // A vacuous "blur whatever is focused" implementation would also pass the test above; this one
    // would not pass THIS one.
    expect(document.activeElement).toBe(other)
  })
})

// ---- WO SKC-14B ACCEPTANCE KEYSTONE ------------------------------------------------------------
//
// The S3 precondition, executable. The host above (`makeHarness().doc`) is a `SketchDocumentPort`
// and nothing more: a document, a commit, an undo sink, a notice. It has NO armed tool, NO chain,
// NO snap engine, NO overlay resolver, NO inference accumulator, and this file imports NOTHING
// from `src/store` (the capability scan in oneSketchPointerOwner.test.ts proves the package does
// not either).
//
// If a tool can be armed and geometry can be DRAWN through that host, then every piece of felt
// behavior the workbench needs already lives in the package, and S3 cannot be tempted to rebuild a
// CAM-store window or a second tool machine -- there would be nothing left to rebuild.
//
// This is the fork-vector kill shot. FAILS-IF any part of the tool loop drifts back out to a mount.

describe('ACCEPTANCE KEYSTONE: a store-free mount runs the full tool loop', () => {
  it('arms the LINE tool and draws a segment between the two clicked points', () => {
    sketcherTools.armTool('line')
    expect(sketcherToolStore.getState().tool).toBe('line')
    H.sketcher.enter()

    clickAt(100, 100)
    // Click 1 armed a chain inside the PACKAGE -- the mount holds no chain to inspect.
    expect(sketcherToolStore.getState().chain?.kind).toBe('line')
    expect(drawn(H)).toHaveLength(0)

    clickAt(140, 100)

    const lines = drawn(H).filter((e) => e.kind === 'line')
    expect(lines).toHaveLength(1)
    const line = lines[0] as Extract<SketchEntity, { kind: 'line' }>
    // The identity plane map makes client px == sketch mm, so the committed geometry is exactly
    // what was clicked. FAILS-IF the click point stops being the previewed point.
    expect(line.start).toEqual({ x: 100, y: 100 })
    expect(line.end).toEqual({ x: 140, y: 100 })
    // One committing gesture, one undo step.
    expect(H.beginGestureCalls).toBe(1)
    // The line chain CONTINUES from the endpoint -- the tool stays live, as in the real app.
    expect(sketcherToolStore.getState().chain?.kind).toBe('line')
  })

  it('arms the 3-POINT ARC tool and draws an arc through three clicked points', () => {
    sketcherTools.armTool('arc-3pt')
    H.sketcher.enter()

    clickAt(200, 100) // start
    expect(drawn(H)).toHaveLength(0)
    clickAt(240, 100) // end
    expect(drawn(H)).toHaveLength(0) // still no commit: an arc needs its third point
    expect(H.beginGestureCalls).toBe(0)

    clickAt(220, 80) // a point ON the arc (non-collinear, or there is no arc)

    const arcs = drawn(H).filter((e) => e.kind === 'arc')
    expect(arcs).toHaveLength(1)
    // ONE step for the committing click; the two chain-advancing clicks opened none.
    expect(H.beginGestureCalls).toBe(1)
    // The 3-pt arc chain closes on commit (unlike the line, it does not continue).
    expect(sketcherToolStore.getState().chain).toBeNull()
  })

  it('Escape cancels the in-progress chain through the package, not through the mount', () => {
    sketcherTools.armTool('line')
    H.sketcher.enter()
    clickAt(100, 100)
    expect(sketcherToolStore.getState().chain).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(sketcherToolStore.getState().chain).toBeNull()
    expect(drawn(H)).toHaveLength(0)
    expect(H.beginGestureCalls).toBe(0) // a cancelled draw costs no undo step
  })

  it('the mount is never asked for tool state: the package answers snap/overlay/lockCursor itself', () => {
    // These are the five ports WO SKC-14B deleted (getToolState / getSnap / getOverlay /
    // getSwipeOverlay / getWakeRefs) plus lockCursor. They must not exist on the document port --
    // if one grows back, a mount can answer it differently and the fork is open again.
    const forbidden = [
      'getToolState', 'getSnap', 'getOverlay', 'getSwipeOverlay', 'getWakeRefs', 'lockCursor',
      'click', 'escape', 'end', 'armTool', 'trimSwipe', 'toggleConstruction',
      'cycleDimForce', 'toggleRectRotated',
    ]
    for (const name of forbidden) {
      expect(H.doc, `SketchDocumentPort must not expose "${name}"`).not.toHaveProperty(name)
    }
  })
})

// ---- the undo LATCH: a host may announce many writes; the component opens ONE step -------------
//
// WO SKC-14B. Before this WO the latch's swallow path was exercised by the `click` port, whose
// fake-host stub announced N writes per click. That port is gone (the package owns the tool
// machine and calls `beforeMutate` exactly once itself), so the ONLY hook a HOST still drives is
// `SketchDocumentPort.dragBegin` -- and the mount contract (ports.ts / SketchUndoSink) explicitly
// allows a host to call it "at the instant it is about to touch the document", more than once.
//
// Without the test below, deleting `if (opened) return` from `newGestureStep()` passes the whole
// suite: a real, silent loss of the one-Ctrl+Z-per-gesture guarantee for any host that announces
// twice (S3's CommandHistory adapter is free to). This test is that mutation's tripwire.

describe('the undo latch collapses a host that announces several writes', () => {
  /** Client point over entity `p1` (world 10,0): the host's identity plane map (client px ARE
   *  world mm, see clientToPlaneWorld above) means the click point IS p1's own coordinate. */
  const P1_CLIENT = { x: 10, y: 0 }

  function pickIsWorking(): boolean {
    // Guard against a silently vacuous test: if the pick misses, dragBegin never runs and the
    // assertions below would pass for the wrong reason.
    H.sketcher.updateSketch(H.sketch)
    pointer('pointerdown', H.canvas, P1_CLIENT)
    pointer('pointermove', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })
    pointer('pointerup', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })
    return (H.dragBeginCalls ?? 0) > 0
  }

  it('the fake host can actually pick and drag an entity (non-vacuity guard)', () => {
    H.sketcher.enter()
    expect(pickIsWorking()).toBe(true)
  })

  it('THREE announced writes inside one dragBegin still open exactly ONE undo step', () => {
    H.dragMutations = 3
    H.sketcher.enter()
    H.sketcher.updateSketch(H.sketch)

    pointer('pointerdown', H.canvas, P1_CLIENT)
    pointer('pointermove', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })
    pointer('pointerup', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })

    expect(H.dragBeginCalls).toBe(1)
    // FAILS-IF the latch stops swallowing repeats: the user would need three Ctrl+Z presses to
    // undo one drag.
    expect(H.beginGestureCalls).toBe(1)
  })

  it('a REFUSED drag opens no step at all (the hook rides the accepted path only)', () => {
    H.dragAccepts = false
    H.dragMutations = 3
    H.sketcher.enter()
    H.sketcher.updateSketch(H.sketch)

    pointer('pointerdown', H.canvas, P1_CLIENT)
    pointer('pointermove', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })
    pointer('pointerup', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })

    expect(H.dragBeginCalls).toBe(1)
    expect(H.beginGestureCalls).toBe(0)
  })
})

// ---- SKC-25: a release outside the canvas must not strand the shared gesture ------------------

describe('SKC-25 captured primary-gesture finalization', () => {
  /** Client point over entity `p1` (world 10,0): the host's identity plane map (client px ARE
   *  world mm, see clientToPlaneWorld above) means the click point IS p1's own coordinate. */
  const P1_CLIENT = { x: 10, y: 0 }
  const DRAGGED = { x: P1_CLIENT.x + 20, y: P1_CLIENT.y }

  function beginAcceptedDrag(pointerId = 1): void {
    H.sketcher.updateSketch(H.sketch)
    pointer('pointerdown', H.canvas, { ...P1_CLIENT, pointerId })
    pointer('pointermove', H.canvas, { ...DRAGGED, pointerId })
    expect(H.dragBeginCalls).toBeGreaterThan(0)
  }

  function clickPoint(pointerId = 2): void {
    pointer('pointerdown', H.canvas, { ...P1_CLIENT, pointerId })
    pointer('pointerup', H.canvas, { ...P1_CLIENT, pointerId })
  }

  it('A1: outside release leaves the next click and next drag live in the same session', () => {
    H.sketcher.enter()
    beginAcceptedDrag(11)
    releaseOutside(H, DRAGGED, 11)

    H.selection = []
    clickPoint(12)
    expect(H.selection).toHaveLength(1)
    expect(H.capture.setCalls).toEqual([11, 12])

    const movesBefore = H.dragMoveCalls
    beginAcceptedDrag(13)
    pointer('pointerup', H.canvas, { ...DRAGGED, pointerId: 13 })
    expect(H.dragMoveCalls).toBeGreaterThan(movesBefore)
    expect(H.dragEndCalls).toBe(2)
  })

  it('A2: exit mid-drag settles the document exactly once', () => {
    H.sketcher.enter()
    beginAcceptedDrag(21)

    H.sketcher.exit()
    pointer('pointerup', H.canvas, { ...DRAGGED, pointerId: 21 })
    pointer('lostpointercapture', H.canvas, { ...DRAGGED, pointerId: 21 })

    expect(H.dragEndCalls).toBe(1)
  })

  it('A2: pointerup followed by lost capture cannot double-settle an accepted drag', () => {
    H.sketcher.enter()
    beginAcceptedDrag(31)
    expect(H.capture.setCalls).toEqual([31])

    pointer('pointerup', H.canvas, { ...DRAGGED, pointerId: 31 })
    pointer('lostpointercapture', H.canvas, { ...DRAGGED, pointerId: 31 })

    expect(H.dragEndCalls).toBe(1)
  })

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'] as const)(
    'A3: %s clears capture and stale drag state',
    (releaseType) => {
      H.sketcher.enter()
      beginAcceptedDrag(41)

      pointer(releaseType, H.canvas, { ...DRAGGED, pointerId: 41 })
      expect(H.capture.pointerId).toBeNull()
      expect(H.dragEndCalls).toBe(1)

      H.selection = []
      clickPoint(42)
      expect(H.selection).toHaveLength(1)
    },
  )
})
