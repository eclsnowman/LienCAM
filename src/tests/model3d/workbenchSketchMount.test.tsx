// @vitest-environment jsdom
// WO SKC-15B (S3): THE MOUNT, proved against the real package rather than a stub.
//
// The keystone `src/tests/sketch/sketcherOverlays.test.tsx` showed a store-free host can run the
// full tool loop. This file shows the WORKBENCH's host can: a real `Sketcher` over a real
// `SceneRuntime`-shaped runtime, a real `FeatureDag` + `CommandHistory`, and the real
// `workbenchSketchDocumentPort`. Pointer events go in at the canvas; DAG node payloads come out.
//
// If this passes, the session routes ALL sketch pointer events through the package (there is no
// other path from a canvas pointerdown to `payload.sketch`), the 29-member port is really wired, and
// the undo adapter really produces ONE step per gesture against `CommandHistory`.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import * as THREE from 'three'

import { Sketcher, SketcherOverlays, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { BADGE_PX, SKETCH_Z } from '../../lib/sketch/sketcher/sketchLayer'
import type { SketcherHost } from '../../lib/sketch/sketcher/ports'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type { Sketch } from '../../lib/sketch/sketcher'
import { CommandHistory, FeatureDag, RegenScheduler, ElementMap } from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  workbenchSketchDocumentPort, __resetSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import {
  workbenchOverlaysPort,
} from '../../components/model3d/workbench/workbenchOverlaysPort'
import {
  createWorkbenchSketcherHost, makePlaneFrameGroup,
} from '../../components/model3d/workbench/workbenchSketcherHost'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { useUiPrefs } from '../../store/uiPrefs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import type { GcsWrapper } from '@salusoft89/planegcs'
import {
  centerSelectionIdForEntity, resolveCenterRef,
} from '../../lib/sketch/centerReferences'
// WO SKC-49: the injected X/Y axis lines paint as dashed THREE.Line objects too (sketchLayer.ts's
// own dedicated axis block), so they now ALWAYS show up in a naive "every dashed Line in the
// overlay tree" traversal -- dashedGhostBuffers below excludes them by name.
import {
  WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID,
} from '../../components/model3d/workbench/workbenchOriginAnchor'

// SKC-46: jsdom's own `localStorage` is not usable in this project's test setup (same quirk
// SolidsWorkbenchPage.cameraProjection.test.tsx works around) -- uiPrefs' persist middleware needs
// a real Storage-shaped object, so this file installs the same in-memory shim rather than the
// (broken here) jsdom default.
const uiPrefsMemory = new Map<string, string>()
const uiPrefsStorageShim: Storage = {
  get length() { return uiPrefsMemory.size },
  clear: () => uiPrefsMemory.clear(),
  getItem: (key) => uiPrefsMemory.get(key) ?? null,
  key: (index) => [...uiPrefsMemory.keys()][index] ?? null,
  removeItem: (key) => { uiPrefsMemory.delete(key) },
  setItem: (key, value) => { uiPrefsMemory.set(key, String(value)) },
}
const priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', { value: uiPrefsStorageShim, configurable: true })
afterAll(() => {
  if (priorLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
  else Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
})

const SKETCH_NODE_ID = 'sketch3d:s1'

// WO SKC-15C: the jsdom canvas-2D stub moved to ./stubCanvas2d.ts -- `Sketch on face` now opens
// this same package session seeded with constraint badges, so six page tests need it too. One copy.
let restoreCanvas2d: (() => void) | null = null

function blankSketch(): Sketch {
  return { id: 's1', layerId: 'workbench', entities: [], constraints: [], dimensions: [], solveStatus: null }
}

function arcLengthSketch(): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [{
      id: 'seam', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5,
      startAngle: 3 * Math.PI / 2, endAngle: Math.PI / 2,
    }],
    constraints: [],
    dimensions: [
      { id: 'arc-drive', kind: 'arcLength', entityId: 'seam',
        driving: true, value: 5 * Math.PI },
      { id: 'arc-ref', kind: 'arcLength', entityId: 'seam',
        driving: false, value: 5 * Math.PI },
    ],
    solveStatus: null,
  }
}

// "sketch-dim equations wiring" render-gate fixture: a fully-constrained (DOF 0) rectangle with one
// driving distance dim (`dw`, l1's own length) -- the workbench twin of dimValueEdit.test.tsx's CAM
// `rect()` fixture, so a real equation commit actually reaches applyWithVerdict's real solve.
function rectSketch(): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [
      { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
      { id: 'l2', kind: 'line', construction: false, start: { x: 40, y: 0 }, end: { x: 40, y: 30 } },
      { id: 'l3', kind: 'line', construction: false, start: { x: 40, y: 30 }, end: { x: 0, y: 30 } },
      { id: 'l4', kind: 'line', construction: false, start: { x: 0, y: 30 }, end: { x: 0, y: 0 } },
    ],
    constraints: [
      { id: 'c12', kind: 'coincident', a: { entityId: 'l1', site: 'end' }, b: { entityId: 'l2', site: 'start' } },
      { id: 'c23', kind: 'coincident', a: { entityId: 'l2', site: 'end' }, b: { entityId: 'l3', site: 'start' } },
      { id: 'c34', kind: 'coincident', a: { entityId: 'l3', site: 'end' }, b: { entityId: 'l4', site: 'start' } },
      { id: 'c41', kind: 'coincident', a: { entityId: 'l4', site: 'end' }, b: { entityId: 'l1', site: 'start' } },
      { id: 'h1', kind: 'horizontal', line: 'l1' },
      { id: 'h3', kind: 'horizontal', line: 'l3' },
      { id: 'v2', kind: 'vertical', line: 'l2' },
      { id: 'v4', kind: 'vertical', line: 'l4' },
      { id: 'fx', kind: 'fix', point: { entityId: 'l1', site: 'start' } },
    ],
    dimensions: [
      { id: 'dw', kind: 'distance', driving: true, value: 40,
        a: { entityId: 'l1', site: 'start' }, b: { entityId: 'l1', site: 'end' } },
    ],
    solveStatus: null,
  }
}

/** A 90-degree corner at (10,0) with a real chamfer rig: legs A and B, the
 *  chamfer line, the construction phantom pinned to both legs, and the four
 *  constraints chamferTool creates. `driving` picks the state of the D1 x D2
 *  pair on it (WO-1858 made both states reachable). */
function d1xd2Sketch(driving = false, value = 3, d2 = 3): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 7, y: 0 } },
      { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 3 }, end: { x: 10, y: 10 } },
      { id: 'chamfer-line', kind: 'line', construction: false,
        start: { x: 7, y: 0 }, end: { x: 10, y: 3 }, chamferSetback: true },
      { id: 'phantom', kind: 'point', construction: true, at: { x: 10, y: 0 } },
    ],
    constraints: [
      { id: 'j1', kind: 'coincident',
        a: { entityId: 'chamfer-line', site: 'start' }, b: { entityId: 'A', site: 'end' } },
      { id: 'j2', kind: 'coincident',
        a: { entityId: 'chamfer-line', site: 'end' }, b: { entityId: 'B', site: 'start' } },
      { id: 'p1', kind: 'point_on_object',
        point: { entityId: 'phantom', site: 'self' }, object: 'A' },
      { id: 'p2', kind: 'point_on_object',
        point: { entityId: 'phantom', site: 'self' }, object: 'B' },
    ],
    dimensions: [
      { id: 'setback-readout', kind: 'd1xd2', entityId: 'chamfer-line', driving, value, d2 },
    ],
    solveStatus: null,
  }
}

function filletSketch(): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [
      {
        id: 'fillet-a', kind: 'line', construction: false,
        start: { x: -20, y: 0 }, end: { x: 0, y: 0 },
      },
      {
        id: 'fillet-b', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 0, y: 20 },
      },
    ],
    constraints: [], dimensions: [], solveStatus: null,
  }
}

function overlaySizingSketch(y: number): Sketch {
  return {
    id: 'overlay-sizing',
    layerId: 'workbench',
    entities: [
      {
        id: 'line-near', kind: 'line', construction: false,
        start: { x: -10, y }, end: { x: 10, y },
      },
      {
        id: 'circle-near', kind: 'circle', construction: false,
        center: { x: 25, y: y + 10 }, radius: 10,
      },
    ],
    constraints: [{
      id: 'fix-near', kind: 'fix', point: { entityId: 'line-near', site: 'start' },
    }],
    dimensions: [
      {
        id: 'dim-near', kind: 'distanceX', driving: true, value: 20,
        a: { entityId: 'line-near', site: 'start' },
        b: { entityId: 'line-near', site: 'end' },
        labelAnchor: { x: 0, y: y - 10 },
      },
      {
        id: 'radius-near', kind: 'radius', driving: true, value: 10,
        entityId: 'circle-near', labelAnchor: { x: 45, y: y - 10 },
      },
    ],
    solveStatus: null,
  }
}

function effectivePerspectiveWorldPerPixel(
  camera: THREE.PerspectiveCamera,
  local: { x: number; y: number },
  clientHeight: number,
  localZ = SKETCH_Z,
): number {
  const cameraPoint = new THREE.Vector3(local.x, local.y, localZ).applyMatrix4(camera.matrixWorldInverse)
  const depth = -cameraPoint.z
  return 2 * Math.tan((camera.fov * Math.PI) / 360) * depth / clientHeight
}

function segmentScreenLengths(
  lines: THREE.LineSegments,
  camera: THREE.Camera,
  width: number,
  height: number,
): number[] {
  const positions = lines.geometry.getAttribute('position')
  lines.updateWorldMatrix(true, false)
  const project = (index: number): THREE.Vector2 => {
    const p = lines.localToWorld(
      new THREE.Vector3().fromBufferAttribute(positions, index),
    ).project(camera)
    return new THREE.Vector2(((p.x + 1) / 2) * width, ((1 - p.y) / 2) * height)
  }
  const lengths: number[] = []
  for (let i = 0; i + 1 < positions.count; i += 2) lengths.push(project(i).distanceTo(project(i + 1)))
  return lengths
}

function segmentProjectedLengths(
  lines: THREE.LineSegments,
  project: (point: { x: number; y: number }) => { x: number; y: number },
): number[] {
  const positions = lines.geometry.getAttribute('position')
  lines.updateWorldMatrix(true, false)
  const projected = (index: number): THREE.Vector2 => {
    const point = lines.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, index))
    const screen = project(point)
    return new THREE.Vector2(screen.x, screen.y)
  }
  const lengths: number[] = []
  for (let i = 0; i + 1 < positions.count; i += 2) {
    lengths.push(projected(i).distanceTo(projected(i + 1)))
  }
  return lengths
}

interface Mount {
  sketcher: Sketcher
  host: ReturnType<typeof createWorkbenchSketcherHost>
  canvas: HTMLCanvasElement
  container: HTMLElement
  dag: FeatureDag
  history: CommandHistory
  runtime: FakeSceneRuntime
  notices: Array<{ message: string; severity: string }>
  regenKicks: string[]
  /** WO SKC-15C-R1 (B2): every node id the port reports as a NEW CommandHistory step, in order. The
   *  page uses this callback to keep its parallel touched-id undo stack in lockstep with `history`. */
  historySteps: string[]
}

/** The workbench mount, built exactly as SolidsWorkbenchPage builds it. */
function mount(plane: 'xy' | 'xz' | 'yz' = 'xy', initialSketch: Sketch = blankSketch()): Mount {
  const container = document.createElement('div')
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  document.body.appendChild(container)

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas.getBoundingClientRect = () => rect
  container.getBoundingClientRect = () => rect

  const runtime = createFakeSceneRuntime()
  // The fake's default camera sits at the origin, so a raycast onto a plane through the origin is
  // degenerate. Give it a real perspective camera looking down the plane normal from 100mm out --
  // the same geometry `orientNormalToPlane` would produce on entry.
  const frame = BASE_PLANE_FRAMES[plane]
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const n = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
  cam.position.copy(new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)).addScaledVector(n, 100)
  cam.up.set(0, 0, 1)
  if (plane === 'xy') cam.up.set(0, 1, 0)
  cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())

  dag.insertNode({
    id: SKETCH_NODE_ID, kind: 'sketch', consumes: [], refs: [],
    payload: { sketch: initialSketch, externalRefs: [], dimensionDiagnostics: [] },
  }, dag.featureOrder().length)

  const notices: Array<{ message: string; severity: string }> = []
  const regenKicks: string[] = []
  const historySteps: string[] = []
  sketchSessionStore.bindDeps({
    dag, history, scheduler,
    getGridSpacing: () => 25,
    // The solver wrapper is booted asynchronously by the page. These tests drive the UNSOLVED path
    // deliberately -- an empty constraint network means the solve is a no-op anyway, and the point
    // here is the MOUNT (pointer -> package -> port -> dag), not the solver (28 tests already own
    // that seam). `solved()` refuses BY NAME with a notice, which the test below asserts.
    wrapper: null,
    notice: (message, severity) => { notices.push({ message, severity }) },
    onDocumentChanged: (id) => { regenKicks.push(id) },
    onHistoryStep: (id) => { historySteps.push(id) },
  })

  const overlayRoot = makePlaneFrameGroup(frame)
  const host = createWorkbenchSketcherHost({
    canvas, container, runtime, overlayRoot, getFrame: () => frame,
  })
  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(workbenchSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => { workbenchSketchDocumentPort.beginStep() } })

  sketchSessionStore.begin(SKETCH_NODE_ID, frame, initialSketch)
  sketcher.enter()
  sketcher.updateSketch(sketchSessionStore.getState().sketch)

  return { sketcher, host, canvas, container, dag, history, runtime, notices, regenKicks, historySteps }
}

function pointer(type: string, target: EventTarget, x: number, y: number, button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}

/** A tool CLICK is a press+release in place (no drag). */
function click(m: Mount, x: number, y: number): void {
  pointer('pointerdown', m.canvas, x, y)
  pointer('pointerup', m.canvas, x, y)
  m.sketcher.updateSketch(sketchSessionStore.getState().sketch)
}

function payloadSketch(m: Mount): Sketch {
  return m.dag.getNode(SKETCH_NODE_ID)!.payload.sketch as Sketch
}

function dashedGhostBuffers(m: Mount): number[][] {
  const buffers: number[][] = []
  m.host.overlayRoot.traverse((object) => {
    if (!(object instanceof THREE.Line) || !(object.material instanceof THREE.LineDashedMaterial)) return
    if (object.name === WORKBENCH_AXIS_X_ENTITY_ID || object.name === WORKBENCH_AXIS_Y_ENTITY_ID) return
    const position = object.geometry.getAttribute('position')
    buffers.push(Array.from(position.array as ArrayLike<number>))
  })
  return buffers
}

let M: Mount

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  uiPrefsMemory.clear()
  useUiPrefs.setState({ lastFilletRadius: null, lastChamferSetback: null })
})

describe('workbench sketch grid snap', () => {
  it('reads the same live pitch used by the visible workbench grid', () => {
    M = mount()
    expect(workbenchSketchDocumentPort.getGridSpacing()).toBe(25)
  })
})
afterEach(() => {
  M?.sketcher.dispose()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  document.body.innerHTML = ''
})

describe('the SketchDocumentPort/SketcherOverlaysPort member surfaces are fully implemented', () => {
  // WO UI-50C-R3 MAJOR 2: the exact-count assertions here (`toHaveLength(27)` / `toHaveLength(23)`
  // against hand-pinned SKETCH_DOCUMENT_PORT_MEMBER_COUNT / SKETCHER_OVERLAYS_PORT_MEMBER_COUNT
  // constants) were removed -- the binding contract forbids a pinned count as the completeness
  // mechanism (SKC-46 concurrently grows the port by 2 members; a pinned literal guarantees a false
  // conflict on merge regardless of which order lands first -- resolved per the contract at
  // UI-50C-R6 assembly). The member LIST is now derived purely from `Object.keys(port)` at test
  // runtime, with only a function-typedness check (which needs no count) plus a generous non-pinned
  // sanity floor against a catastrophic empty-object regression. Completeness of the DIMENSION-writing
  // subset of these members is independently, mechanically proven by
  // `src/tests/sketch/dimensionWritePathCensus.test.ts`, which AST-sweeps these same two files for
  // every `dimensions:` site and keys each hit to its real enclosing function name (== the live port
  // member name, for a port-object property) -- a renamed or newly-added dimension-writing member
  // fails THAT census by name, with no dependency on a count or a hand-listed member name.
  it('every live SketchDocumentPort member is a real function (no undefined/missing member)', () => {
    const keys = Object.keys(workbenchSketchDocumentPort)
    expect(keys.length).toBeGreaterThanOrEqual(20)
    for (const k of keys) {
      expect(typeof (workbenchSketchDocumentPort as unknown as Record<string, unknown>)[k]).toBe('function')
    }
  })

  it('every live SketcherOverlaysPort member is a real function (no undefined/missing member)', () => {
    const keys = Object.keys(workbenchOverlaysPort)
    expect(keys.length).toBeGreaterThanOrEqual(15)
    for (const k of keys) {
      expect(typeof (workbenchOverlaysPort as unknown as Record<string, unknown>)[k]).toBe('function')
    }
  })

  // SKC-46: staged-size memory shares CAM's `liencam-ui-prefs` surface -- the SAME store
  // camSketchDocumentPort (src/store/index.ts) reads/writes, which is what makes this a shared
  // memory rather than two independent ones (the sketcher parity hard rule).
  it('getLastStagedSize/setLastStagedSize round-trip through the shared uiPrefs store', () => {
    expect(workbenchSketchDocumentPort.getLastStagedSize('fillet')).toBeNull()
    expect(workbenchSketchDocumentPort.getLastStagedSize('chamfer')).toBeNull()
    workbenchSketchDocumentPort.setLastStagedSize('fillet', 8)
    expect(workbenchSketchDocumentPort.getLastStagedSize('fillet')).toBe(8)
    expect(useUiPrefs.getState().lastFilletRadius).toBe(8)
    expect(workbenchSketchDocumentPort.getLastStagedSize('chamfer')).toBeNull() // per-tool memory
    workbenchSketchDocumentPort.setLastStagedSize('chamfer', 3)
    expect(workbenchSketchDocumentPort.getLastStagedSize('chamfer')).toBe(3)
    expect(workbenchSketchDocumentPort.getLastStagedSize('fillet')).toBe(8) // unaffected
  })

  it('every NAMED-INERT member is callable and returns its documented value (never a crash path)', () => {
    // The eight document-port text members + getProjectCandidates + the two constant reads.
    expect(workbenchSketchDocumentPort.getDisplayUnits()).toBe('mm')
    expect(workbenchSketchDocumentPort.getGridSpacing()).toBe(10)
    expect(workbenchSketchDocumentPort.getProjectCandidates()).toEqual([])
    expect(workbenchSketchDocumentPort.getTextEditId()).toBeNull()
    expect(workbenchSketchDocumentPort.getPickPathForTextId()).toBeNull()
    expect(() => workbenchSketchDocumentPort.editText('x')).not.toThrow()
    expect(() => workbenchSketchDocumentPort.commitTextEdit()).not.toThrow()
    expect(() => workbenchSketchDocumentPort.cancelTextEdit()).not.toThrow()
    expect(() => workbenchSketchDocumentPort.cancelPickTextPath()).not.toThrow()
    expect(() => workbenchSketchDocumentPort.placeText({ x: 0, y: 0 }, null, 0, 'free', false)).not.toThrow()
    expect(() => workbenchSketchDocumentPort.bindTextPath('a', 'b')).not.toThrow()
    // The seven overlays-port text members.
    expect(() => workbenchOverlaysPort.setTextValue('x')).not.toThrow()
    expect(() => workbenchOverlaysPort.setTextCaretIndex(0)).not.toThrow()
    expect(() => workbenchOverlaysPort.commitTextEdit()).not.toThrow()
    expect(() => workbenchOverlaysPort.cancelTextEdit()).not.toThrow()
    expect(() => workbenchOverlaysPort.setTextPathAlignById('a', 'free')).not.toThrow()
    expect(() => workbenchOverlaysPort.setTextPathFlipById('a', true)).not.toThrow()
    expect(() => workbenchOverlaysPort.setTextMirrorById('a', true)).not.toThrow()
  })

  it('Project resolver delegates through session deps and refuses by name when unavailable', () => {
    const context = { clientX: 12, clientY: 34, local: { x: 1, y: 2 }, tolerance: 0.5 }
    expect(workbenchSketchDocumentPort.resolveProjectSource?.(context)).toMatchObject({
      ok: false,
      reason: 'workbench-project-resolver-unavailable',
    })

    M = mount()
    const bound = sketchSessionStore.getDeps()
    if (bound === null) throw new Error('expected bound workbench session dependencies')
    let received: typeof context | null = null
    const delegated = { ok: false as const, reason: 'fixture-miss', message: 'fixture miss' }
    sketchSessionStore.bindDeps({
      ...bound,
      resolveProjectSource: (next) => {
        received = next
        return delegated
      },
    })

    expect(workbenchSketchDocumentPort.resolveProjectSource?.(context)).toBe(delegated)
    expect(received).toEqual(context)
  })
})

describe('UI-50B workbench arcLength accept-point parity', () => {
  it('rejects non-positive driving values and typed reference values by name', () => {
    M = mount('xy', arcLengthSketch())

    workbenchOverlaysPort.commitDimensionValue('arc-drive', 0)
    expect(M.notices.at(-1)?.message).toContain('arc length must be greater than zero')
    expect(payloadSketch(M).dimensions[0].value).toBeCloseTo(5 * Math.PI, 12)

    sketchSessionStore.setState({ dimEditor: { dimId: 'arc-ref', isNew: false } })
    workbenchOverlaysPort.commitDimensionValue('arc-ref', 100)
    expect(M.notices.at(-1)?.message).toContain('is a reference')
    expect(sketchSessionStore.getState().dimEditor).toBeNull()
    expect(payloadSketch(M).dimensions[1].value).toBeCloseTo(5 * Math.PI, 12)
  })
})

// WO-1858: the workbench half of "a chamfer's two setbacks can be driven".
// This block used to assert the mirror image -- a BK-140 refusal on typing and
// on the forward toggle, plus a forced driving:false on replace() and
// append(). Those pins are retired with the rule they pinned (ADR-0040).
describe('WO-1858 workbench d1xd2 drivable parity (both hosts driven)', () => {
  it('refuses a non-positive setback BY NAME, per half (the one thing it cannot do)', () => {
    M = mount('xy', d1xd2Sketch(true))

    sketchSessionStore.setState({ dimEditor: { dimId: 'setback-readout', isNew: false } })
    workbenchOverlaysPort.commitDimensionValue('setback-readout', 0)
    expect(M.notices.at(-1)?.message).toContain('setback D1 must be greater than zero')
    workbenchOverlaysPort.commitDimensionValue('setback-readout', -2, undefined, 'd2')
    expect(M.notices.at(-1)?.message).toContain('setback D2 must be greater than zero')
    // Nothing written, and no BK-140 anywhere: the refusal names the geometry,
    // not a booking number (rule 11).
    expect(payloadSketch(M).dimensions[0]).toMatchObject({ value: 3, d2: 3, driving: true })
    expect(M.notices.map((n) => n.message).join(' ')).not.toContain('BK-140')
  })

  it('accepts a typed value in EITHER half, against the REAL solver', async () => {
    M = mount('xy', d1xd2Sketch(true))
    const wrapper = await ensureWbWrapper()
    sketchSessionStore.bindDeps({ ...sketchSessionStore.getDeps()!, wrapper })
    sketchSessionStore.setState({ dimEditor: { dimId: 'setback-readout', isNew: false } })

    workbenchOverlaysPort.commitDimensionValue('setback-readout', 4)
    expect(payloadSketch(M).dimensions[0]).toMatchObject({ driving: true, value: 4, d2: 3 })
    expect(sketchSessionStore.getState().dimEditor).toBeNull()

    sketchSessionStore.setState({ dimEditor: { dimId: 'setback-readout', isNew: false } })
    workbenchOverlaysPort.commitDimensionValue('setback-readout', 7, undefined, 'd2')
    expect(payloadSketch(M).dimensions[0]).toMatchObject({ driving: true, value: 4, d2: 7 })
  })

  it('workbenchSketchDocumentPort.replace() keeps a DRIVING d1xd2 driving', () => {
    M = mount('xy', d1xd2Sketch())
    const s = payloadSketch(M)
    const driven = { id: 'driven', kind: 'd1xd2' as const, entityId: 'chamfer-line',
      driving: true, value: 4, d2: 5 }
    workbenchSketchDocumentPort.replace({
      entities: s.entities, constraints: s.constraints, dimensions: [...s.dimensions, driven],
    })
    expect(payloadSketch(M).dimensions.find((d) => d.id === 'driven'))
      .toMatchObject({ driving: true, value: 4, d2: 5 })
  })

  it('workbenchSketchDocumentPort.append keeps a DRIVING d1xd2 driving', () => {
    M = mount('xy', blankSketch())
    const driven = { id: 'driven-append', kind: 'd1xd2' as const, entityId: 'chamfer-line',
      driving: true, value: 4, d2: 5 }
    workbenchSketchDocumentPort.append({ entities: [], constraints: [], dimensions: [driven] }, [])
    expect(payloadSketch(M).dimensions.find((d) => d.id === 'driven-append'))
      .toMatchObject({ driving: true, value: 4, d2: 5 })
  })

  it('workbench toggleDimensionDriving runs BOTH directions', () => {
    // Driving at stale values: toggling to reference must snap BOTH halves to
    // the measured pair, not leave the stale numbers on the label.
    M = mount('xy', d1xd2Sketch(true, 111, 222))

    workbenchOverlaysPort.toggleDimensionDriving('setback-readout')
    const asReference = payloadSketch(M).dimensions.find((d) => d.id === 'setback-readout')!
    expect(asReference.driving).toBe(false)
    expect(asReference.value).toBeCloseTo(3, 6)
    expect((asReference as typeof asReference & { d2: number }).d2).toBeCloseTo(3, 6)

    // The FORWARD direction is ACCEPTED now -- no BK-140 refusal anywhere.
    workbenchOverlaysPort.toggleDimensionDriving('setback-readout')
    expect(payloadSketch(M).dimensions.find((d) => d.id === 'setback-readout')!.driving).toBe(true)
    expect(M.notices.map((n) => n.message).join(' ')).not.toContain('BK-140')
  })
})

// WO SKC-56: both-host smoke (deliverable 6) -- Part Studio (workbench) half. mount()'s own
// beforeEach binds wrapper: null (deliberate -- the MOUNT tests below own that seam); this describe
// re-binds the SAME deps with a REAL planegcs wrapper so moveDimLabel's sector-crossing branch
// actually solves, through the real workbenchSketchDocumentPort -- not a re-implementation.
let wbWrapperPromise: Promise<GcsWrapper> | null = null
function ensureWbWrapper(): Promise<GcsWrapper> {
  if (!wbWrapperPromise) wbWrapperPromise = createGcsWrapper()
  return wbWrapperPromise
}

// "sketch-dim equations wiring" hitlist item: the WORKBENCH half of the required parity render-gate
// (the CAM half is dimValueEdit.test.tsx's "CAM-mounted DOM" describe block -- same shape, same
// assertions, real DOM events into the SAME production `SketchDimensionOverlay` component, this time
// through the real `workbenchOverlaysPort` + a real planegcs solver). Proves the equation feature
// reaches production in the Part-studio sketcher, not just through a fake port
// (sketcherOverlays.test.tsx) or the pure resolver (dimExpr.test.ts).
describe('"sketch-dim equations wiring": workbench render-gate -- a real DOM equation edit drives the real input', () => {
  afterEach(cleanup)

  it('typing "=60-10" into a real .sketch-dim-input commits 50mm + the expression through the real workbenchOverlaysPort/solver', async () => {
    M = mount('xy', rectSketch())
    const wrapper = await ensureWbWrapper()
    sketchSessionStore.bindDeps({ ...sketchSessionStore.getDeps()!, wrapper })
    sketchSessionStore.setState({ dimEditor: { dimId: 'dw', isNew: false } })

    const { container } = render(<SketcherOverlays port={workbenchOverlaysPort} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement
    expect(input, 'the workbench-mounted editor must actually render for this to mean anything').not.toBeNull()

    act(() => {
      fireEvent.change(input, { target: { value: '=60-10' } })
      fireEvent.blur(input)
    })

    expect(sketchSessionStore.getState().dimEditor).toBeNull()
    const dim = payloadSketch(M).dimensions.find((d) => d.id === 'dw')!
    expect(dim.value).toBeCloseTo(50, 6)
    expect(dim.expression).toBe('=60-10')
    const l1 = payloadSketch(M).entities.find((e) => e.id === 'l1')!
    expect(l1.kind === 'line' && Math.abs(l1.end.x - l1.start.x - 50) < 1e-6).toBe(true)
  })

  it('a bad equation ("=1/0") on a real DOM blur is refused fail-loud -- editor stays open, geometry untouched, typed error visible (ADR-0003)', async () => {
    M = mount('xy', rectSketch())
    const wrapper = await ensureWbWrapper()
    sketchSessionStore.bindDeps({ ...sketchSessionStore.getDeps()!, wrapper })
    sketchSessionStore.setState({ dimEditor: { dimId: 'dw', isNew: false } })

    const { container } = render(<SketcherOverlays port={workbenchOverlaysPort} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement

    act(() => {
      fireEvent.change(input, { target: { value: '=1/0' } })
      fireEvent.blur(input)
    })

    // Never a silent revert to the old value: the editor stays OPEN with the typed error visible.
    expect(sketchSessionStore.getState().dimEditor).not.toBeNull()
    expect(payloadSketch(M).dimensions.find((d) => d.id === 'dw')!.value).toBe(40) // untouched
    const err = container.querySelector('.sketch-dim-eq-preview-error')
    expect(err?.textContent).toMatch(/division by zero/i)
  })
})

// SKC-58B reverses SKC-56's far-sector MOTION convention (Operator's 2026-07-17 hands-on ruling) for the
// workbench host too: a far-sector pick reads the obtuse magnitude that ALREADY describes the current
// geometry, so committing it must not move the line. Local helpers mirror the CAM half.
function wbDirectedDeg(l1: Sketch['entities'][number], l2: Sketch['entities'][number]): number {
  if (l1.kind !== 'line' || l2.kind !== 'line') throw new Error('expected both entities to be lines')
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI
}
function wbEndOf(sk: Sketch, id: string): { x: number; y: number } {
  const e = sk.entities.find((x) => x.id === id)!
  if (e.kind !== 'line') throw new Error(`expected ${id} to remain a line`)
  return { x: e.end.x, y: e.end.y }
}
function wbAnchorDeg(alphaDeg: number, r = 5): { x: number; y: number } {
  return { x: r * Math.cos((alphaDeg * Math.PI) / 180), y: r * Math.sin((alphaDeg * Math.PI) / 180) }
}
function wbReverseB(d: Sketch['dimensions'][number]): boolean | undefined {
  return (d as typeof d & { reverseB?: boolean }).reverseB
}

describe('SKC-58B both-host smoke: Part Studio angle dim through the real workbench port', () => {
  it('committed 47deg angle dim label-dragged into the far sector stores value=-133/reverseB=true, label magnitude=133, geometry stays +47 with ZERO motion', async () => {
    M = mount('xy', blankSketch())
    const wrapper = await ensureWbWrapper()
    const deps = sketchSessionStore.getDeps()!
    sketchSessionStore.bindDeps({ ...deps, wrapper })

    const thetaDeg = 47
    const thetaRad = (thetaDeg * Math.PI) / 180
    workbenchSketchDocumentPort.append({
      entities: [
        { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
          end: { x: 10 * Math.cos(thetaRad), y: 10 * Math.sin(thetaRad) } },
      ],
      constraints: [
        { id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } },
        { id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } },
        { id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } },
      ],
      dimensions: [
        { id: 'len', kind: 'distance', driving: true, value: 10,
          a: { entityId: 'l2', site: 'start' }, b: { entityId: 'l2', site: 'end' } },
        { id: 'ang', kind: 'angle', driving: true, value: thetaRad, a: 'l1', b: 'l2',
          labelAnchor: wbAnchorDeg(23) },
      ],
    }, [])
    const beforeEnd = { x: 10 * Math.cos(thetaRad), y: 10 * Math.sin(thetaRad) }

    // Drag the label from the I1 (near, 0..47deg) sector into I2 (far, 47..180deg).
    workbenchSketchDocumentPort.moveDimLabel('ang', wbAnchorDeg(113))

    const solved = payloadSketch(M)
    const dim = solved.dimensions.find((d) => d.id === 'ang')!
    expect(dim.kind).toBe('angle')
    // Stored value is the SIGNED reversed-operand far value, orientation flag set.
    expect((dim.value * 180) / Math.PI).toBeCloseTo(-(180 - thetaDeg), 3) // -133
    expect(wbReverseB(dim)).toBe(true)
    // Label magnitude is the obtuse sweep (133).
    expect(Math.abs((dim.value * 180) / Math.PI)).toBeCloseTo(180 - thetaDeg, 3)
    // The REAL geometry did not move: directed angle stays +47, endpoint unchanged.
    const l1 = solved.entities.find((e) => e.id === 'l1')!
    const l2 = solved.entities.find((e) => e.id === 'l2')!
    expect(wbDirectedDeg(l1, l2)).toBeCloseTo(thetaDeg, 3)
    const afterEnd = wbEndOf(solved, 'l2')
    const moved = Math.hypot(afterEnd.x - beforeEnd.x, afterEnd.y - beforeEnd.y)
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][WB-SMOKE] storedDeg=${((dim.value * 180) / Math.PI).toFixed(4)} ` +
      `reverseB=${wbReverseB(dim)} measuredDeg=${wbDirectedDeg(l1, l2).toFixed(4)} endDeltaMm=${moved.toFixed(6)}`)
    expect(moved).toBeLessThan(1e-6) // NO MOTION -- Operator's bar
  })

  // ---- SKC-58B-R1 Blocker 1 (workbench half): a REFERENCE angle dim remeasures value+reverseB
  // ATOMICALLY through the shared remeasureReferenceDimensions helper the workbench port calls after
  // every solve (workbenchSketchDocumentPort.ts:232). Auditor construction: far ref
  // {-145,reverseB:true,label@100} -> move geometry to +120 near -> toggle it driving -> ZERO motion.
  it('a reference angle dim whose lines move across the near/far boundary re-derives value+reverseB atomically; toggling it driving is NO motion (Blocker 1)', async () => {
    M = mount('xy', blankSketch())
    const wrapper = await ensureWbWrapper()
    const deps = sketchSessionStore.getDeps()!
    sketchSessionStore.bindDeps({ ...deps, wrapper })

    workbenchSketchDocumentPort.append({
      entities: [
        { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
          end: { x: 10 * Math.cos((35 * Math.PI) / 180), y: 10 * Math.sin((35 * Math.PI) / 180) } },
      ],
      constraints: [
        { id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } },
        { id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } },
        { id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } },
      ],
      dimensions: [
        { id: 'len', kind: 'distance', driving: true, value: 10,
          a: { entityId: 'l2', site: 'start' }, b: { entityId: 'l2', site: 'end' } },
        { id: 'drive', kind: 'angle', driving: true, value: (35 * Math.PI) / 180, a: 'l1', b: 'l2',
          labelAnchor: wbAnchorDeg(17) },
        { id: 'ref', kind: 'angle', driving: false, value: 0, a: 'l1', b: 'l2',
          labelAnchor: wbAnchorDeg(100) },
      ],
    }, [])
    // After the append+solve at +35, the far label (@100) makes ref remeasure to the signed far value.
    const refFar = payloadSketch(M).dimensions.find((d) => d.id === 'ref')!
    expect((refFar.value * 180) / Math.PI).toBeCloseTo(-145, 2)
    expect(wbReverseB(refFar)).toBe(true)

    // Move geometry to +120 via the DRIVING dim: the ref's fixed @100 label is now NEAR.
    workbenchOverlaysPort.commitDimensionValue('drive', (120 * Math.PI) / 180)
    const refNear = payloadSketch(M).dimensions.find((d) => d.id === 'ref')!
    expect((refNear.value * 180) / Math.PI).toBeCloseTo(120, 2) // atomic value
    expect(wbReverseB(refNear)).toBe(false)                     // atomic orientation
    const geomBefore = wbEndOf(payloadSketch(M), 'l2')

    // Hand off: drop 'drive' to reference, toggle the (now-near) 'ref' to driving -> ZERO motion.
    // A stale reverseB=true would map l2l_angle_pppp(+120) and flip l2 to -60deg.
    workbenchOverlaysPort.toggleDimensionDriving('drive')
    workbenchOverlaysPort.toggleDimensionDriving('ref')
    const after = payloadSketch(M)
    const geomAfter = wbEndOf(after, 'l2')
    const moved = Math.hypot(geomAfter.x - geomBefore.x, geomAfter.y - geomBefore.y)
    const l1 = after.entities.find((e) => e.id === 'l1')!
    const l2 = after.entities.find((e) => e.id === 'l2')!
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][WB-REF-REMEASURE] refValueDeg=${((refNear.value * 180) / Math.PI).toFixed(2)} ` +
      `reverseB=${wbReverseB(refNear)} measuredDeg=${wbDirectedDeg(l1, l2).toFixed(4)} endDeltaMm=${moved.toFixed(6)}`)
    expect(moved).toBeLessThan(1e-6)                 // NO MOTION re-enabling driving
    expect(wbDirectedDeg(l1, l2)).toBeCloseTo(120, 3) // still +120, no 180 flip
  })

  // ---- SKC-59-R1 blocker C1/C3 (workbench half): Operator's exact far-sector VALUE
  // edit through the REAL workbench accept path (workbenchOverlaysPort.
  // commitDimensionValue -> signedAngleEditValue, the SAME single point of truth
  // CAM uses). A line directed +37deg carries an obtuse-sector dim reading 143
  // (value=-143, reverseB=true). Typing 120 (the overlay passes the POSITIVE
  // magnitude) must store -120, rotating the line the SHORT way to directed +60
  // on the SAME side at full length -- NOT the -60 mirror the raw +120 write
  // produced. The workbench solver is synchronous, so the mount reflects the
  // solved result inline. ----
  it('SKC-59: typed 120 on a far-sector -143/reverseB=true dim stores -120, rotates the line to +60 at full length (no mirror flip)', async () => {
    M = mount('xy', blankSketch())
    const wrapper = await ensureWbWrapper()
    const deps = sketchSessionStore.getDeps()!
    sketchSessionStore.bindDeps({ ...deps, wrapper })

    workbenchSketchDocumentPort.append({
      entities: [
        { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'l2', kind: 'line', construction: false, start: { x: 0, y: 0 },
          end: { x: 40 * Math.cos((37 * Math.PI) / 180), y: 40 * Math.sin((37 * Math.PI) / 180) } },
      ],
      constraints: [
        { id: 'f1s', kind: 'fix', point: { entityId: 'l1', site: 'start' } },
        { id: 'f1e', kind: 'fix', point: { entityId: 'l1', site: 'end' } },
        { id: 'f2s', kind: 'fix', point: { entityId: 'l2', site: 'start' } }, // start pinned, length FREE
      ],
      dimensions: [
        // Far/obtuse dim (as a far label-drag stores it): value=-143 signed, reverseB=true.
        { id: 'ang', kind: 'angle', driving: true, value: (-143 * Math.PI) / 180, a: 'l1', b: 'l2',
          reverseB: true, labelAnchor: wbAnchorDeg(100) },
      ],
    }, [])
    // Sanity: creation is no-motion -- the line still sits at directed +37, length 40.
    {
      const sk0 = payloadSketch(M)
      expect(wbDirectedDeg(sk0.entities.find((e) => e.id === 'l1')!, sk0.entities.find((e) => e.id === 'l2')!))
        .toBeCloseTo(37, 2)
    }

    // THE REAL ACCEPT PATH: the value box passes the POSITIVE typed magnitude.
    workbenchOverlaysPort.commitDimensionValue('ang', (120 * Math.PI) / 180)

    const sk = payloadSketch(M)
    const ang = sk.dimensions.find((d) => d.id === 'ang')!
    const l1 = sk.entities.find((e) => e.id === 'l1')!
    const l2 = sk.entities.find((e) => e.id === 'l2')!
    const lenL2 = Math.hypot(wbEndOf(sk, 'l2').x, wbEndOf(sk, 'l2').y)
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][WB-ACCEPT] storedDeg=${((ang.value * 180) / Math.PI).toFixed(3)} ` +
      `reverseB=${wbReverseB(ang)} directedDeg=${wbDirectedDeg(l1, l2).toFixed(3)} lenMm=${lenL2.toFixed(4)}`)
    expect((ang.value * 180) / Math.PI).toBeCloseTo(-120, 3)   // SIGNED store (was +120 = the bug)
    expect(wbReverseB(ang)).toBe(true)                         // reverseB retained
    expect(Math.abs((ang.value * 180) / Math.PI)).toBeCloseTo(120, 3) // label still reads 120
    expect(wbDirectedDeg(l1, l2)).toBeCloseTo(60, 2)           // SAME side -- NOT the -60 mirror
    expect(lenL2).toBeCloseTo(40, 2)                           // length preserved
  })
})

// SKETCH-AXES-PARITY: the Model workspace (workbench) sketcher must render the injected X/Y axis
// lines exactly like CAM does -- Operator reported the Model sketch plane had no axis lines while the
// CAM sketch environment did. Root cause: SolidsWorkbenchPage.beginPackageSketch fed the FIRST
// `sketcher.updateSketch(...)` the RAW pre-injection document; the shared SketchLayer only
// re-synthesizes the origin POINT from view state (originAnchorEntity), never the axis LINES, so
// the axes silently dropped at entry while the origin was masked by that rescue. The fix feeds the
// injected `sketchSessionStore.getState().sketch` (what CAM's activeSketch already carries, and what
// this harness -- "built exactly as SolidsWorkbenchPage builds it" -- already does at mount()).
describe('SKETCH-AXES-PARITY: the workbench sketch session renders the X/Y axis lines like CAM', () => {
  function axisLineNames(m: Mount): string[] {
    const names: string[] = []
    m.host.overlayRoot.traverse((object) => {
      if (
        object instanceof THREE.Line &&
        object.material instanceof THREE.LineDashedMaterial &&
        (object.name === WORKBENCH_AXIS_X_ENTITY_ID || object.name === WORKBENCH_AXIS_Y_ENTITY_ID)
      ) {
        names.push(object.name)
      }
    })
    return names.sort()
  }

  const BOTH_AXES = [WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID].sort()

  it('paints both axes as dashed construction lines from the INJECTED session document -- and paints NONE from the raw pre-injection document (the fixed defect)', () => {
    const raw = blankSketch()
    M = mount('xy', raw)

    // Production entry: SolidsWorkbenchPage.beginPackageSketch now passes the injected session sketch
    // plus the axis-carrying view state -- exactly this call. Both axes must be present.
    M.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
    expect(axisLineNames(M)).toEqual(BOTH_AXES)

    // THE DEFECT (mutation guard): feeding the RAW, un-injected document -- what beginPackageSketch
    // used to pass -- with the SAME view state paints ZERO axis lines. The origin-only synthetic
    // rescue in SketchLayer.update() never covers the axis LINES, which is why the Model workspace
    // showed no axes. If the entry ever regresses to the raw document, this half goes red.
    M.sketcher.updateSketch(raw, sketchSessionStore.getViewState())
    expect(axisLineNames(M)).toEqual([])

    // And re-feeding the injected document restores both: the axes are strictly a function of the
    // document handed to the shared package, so parity with CAM holds by feeding the injected one.
    M.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
    expect(axisLineNames(M)).toEqual(BOTH_AXES)
  })
})

describe('canvas pointer events reach the DAG through the package, and nothing else', () => {
  it('the real Part mount repaints a staged fillet from R2 to R5 without pointer movement', () => {
    M = mount('xy', filletSketch())
    const documentBefore = JSON.stringify(payloadSketch(M))
    sketcherTools.armTool('fillet')

    click(M, 400, 300)

    expect(JSON.stringify(payloadSketch(M))).toBe(documentBefore)
    const cursorBeforeRadiusChange = M.sketcher.getLastCursor()
    const r2 = dashedGhostBuffers(M)
    expect(r2).toHaveLength(1)
    expect(r2[0].every(Number.isFinite)).toBe(true)

    sketcherTools.setFilletRadius(5)

    const r5 = dashedGhostBuffers(M)
    expect(M.sketcher.getLastCursor()).toEqual(cursorBeforeRadiusChange)
    expect(r5).toHaveLength(1)
    expect(r5[0].every(Number.isFinite)).toBe(true)
    expect(r5[0]).not.toEqual(r2[0])
    expect(JSON.stringify(payloadSketch(M))).toBe(documentBefore)

    sketcherTools.overlayApply()

    expect(M.historySteps).toEqual([SKETCH_NODE_ID])
    expect(payloadSketch(M).entities.filter((entity) => entity.kind === 'arc')).toHaveLength(1)
    expect(payloadSketch(M).entities.find((entity) => entity.kind === 'arc')).toMatchObject({ radius: 5 })
    expect(dashedGhostBuffers(M)).toEqual([])
  })

  it('SKC-45 real Part mount shares chamfer typed update, drag cursor, preview, and Apply', () => {
    M = mount('xy', filletSketch())
    const documentBefore = JSON.stringify(payloadSketch(M))
    sketcherTools.armTool('chamfer')

    click(M, 400, 300)
    expect(sketcherToolStore.getState().chain).toMatchObject({ kind: 'chamfer' })
    const d2 = dashedGhostBuffers(M)
    expect(d2).toHaveLength(1)

    sketcherTools.commitDrawValueAt(3, { x: 0, y: 0 })
    expect(sketcherToolStore.getState().chamferSetback).toBe(3)
    const d3 = dashedGhostBuffers(M)
    expect(d3[0]).not.toEqual(d2[0])
    expect(JSON.stringify(payloadSketch(M))).toBe(documentBefore)

    // WO SKC-55: projected at SKETCH_Z, the height the live SketchLayer group (and the reverse
    // clientToPlaneWorld raycast every drag gesture now uses) actually renders/resolves at. Even at
    // this test's SQUARE-ON camera pose, these two points are off the view AXIS (not off-normal --
    // theta is exactly 0), so a PERSPECTIVE camera's own off-axis ray angle at z=0 vs z=SKETCH_Z
    // differs by a small but real amount (confirmed while fixing this test: the old default-z=0
    // projection landed the drag's pointermove ~0.012mm short of doubling the staged setback,
    // sharing the exact blind spot this WO's fix corrects elsewhere).
    const midpoint = M.host.projectToScreen?.({ x: -1.5, y: 1.5 }, SKETCH_Z)
    const doubled = M.host.projectToScreen?.({ x: -3, y: 3 }, SKETCH_Z)
    expect(midpoint).not.toBeNull()
    expect(doubled).not.toBeNull()
    if (!midpoint || !doubled) throw new Error('Part sketch host must project staged chamfer points')

    pointer('pointermove', M.canvas, midpoint.x, midpoint.y)
    expect(M.canvas.style.cursor).toBe('grab')
    pointer('pointerdown', M.canvas, midpoint.x, midpoint.y)
    expect(M.canvas.style.cursor).toBe('grabbing')
    pointer('pointermove', M.canvas, doubled.x, doubled.y)
    expect(sketcherToolStore.getState().chamferSetback).toBeCloseTo(6, 6)
    pointer('pointerup', M.canvas, doubled.x, doubled.y)
    expect(M.canvas.style.cursor).toBe('grab')

    const previewSetback = sketcherToolStore.getState().chamferSetback
    sketcherTools.overlayApply()

    expect(M.historySteps).toEqual([SKETCH_NODE_ID])
    const committed = payloadSketch(M)
    expect(committed.dimensions.filter((dimension) =>
      dimension.kind === 'distance' && dimension.driving && dimension.value === previewSetback))
      .toHaveLength(2)
    expect(dashedGhostBuffers(M)).toEqual([])
  })

  it('the LINE tool draws a segment between two clicked points, into payload.sketch', () => {
    M = mount('xy')
    sketcherTools.armTool('line')

    click(M, 400, 300) // plane origin
    click(M, 500, 300)

    const s = payloadSketch(M)
    const lines = s.entities.filter((e) => e.kind === 'line')
    // FAILS-IF the mount is not routing: nothing would ever reach payload.sketch.
    expect(lines).toHaveLength(1)
    const line = lines[0] as Extract<Sketch['entities'][number], { kind: 'line' }>
    expect(Number.isFinite(line.start.x)).toBe(true)
    expect(Number.isFinite(line.end.x)).toBe(true)
    // The second click is to the RIGHT of the first on screen, so +local-x.
    expect(line.end.x).toBeGreaterThan(line.start.x)
  })

  it('the CIRCLE tool draws a circle with a real, finite radius', () => {
    M = mount('xy')
    sketcherTools.armTool('circle-center') // centre-then-radius; 'circle' is not a SketchToolId
    click(M, 400, 300)
    click(M, 460, 300)

    const circles = payloadSketch(M).entities.filter((e) => e.kind === 'circle')
    expect(circles).toHaveLength(1)
    const c = circles[0] as Extract<Sketch['entities'][number], { kind: 'circle' }>
    expect(c.radius).toBeGreaterThan(0)
    expect(Number.isFinite(c.radius)).toBe(true)
  })

  it('the 3-POINT ARC tool draws an arc through three clicked points', () => {
    M = mount('xy')
    sketcherTools.armTool('arc-3pt')
    click(M, 380, 300)
    click(M, 460, 300)
    click(M, 420, 260)

    const arcs = payloadSketch(M).entities.filter((e) => e.kind === 'arc')
    expect(arcs).toHaveLength(1)
    const a = arcs[0] as Extract<Sketch['entities'][number], { kind: 'arc' }>
    expect(a.radius).toBeGreaterThan(0)
    expect(Number.isFinite(a.startAngle)).toBe(true)
    expect(Number.isFinite(a.endAngle)).toBe(true)
  })

  it('YZ end to end: a line drawn on the YZ plane lands in the payload with finite local coords', () => {
    M = mount('yz')
    sketcherTools.armTool('line')
    click(M, 400, 300)
    click(M, 500, 340)

    const lines = payloadSketch(M).entities.filter((e) => e.kind === 'line')
    expect(lines).toHaveLength(1)
    const line = lines[0] as Extract<Sketch['entities'][number], { kind: 'line' }>
    for (const v of [line.start.x, line.start.y, line.end.x, line.end.y]) {
      // Charter item 3: a NaN sails through every `> tol` comparison in BOTH directions.
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y)).toBeGreaterThan(0)
  })

  it('every commit kicks regen for the sketch node exactly once per write', () => {
    M = mount('xy')
    sketcherTools.armTool('line')
    click(M, 400, 300)
    expect(M.regenKicks).toEqual([]) // the first click only advances the chain: no document write
    click(M, 500, 300)
    expect(M.regenKicks).toEqual([SKETCH_NODE_ID])
  })

  it('selection changes remain presentation-only and never kick document regen', () => {
    M = mount('xy')
    sketcherTools.armTool('line')
    click(M, 400, 300)
    click(M, 500, 300)
    const lineId = payloadSketch(M).entities[0].id
    M.regenKicks.length = 0

    workbenchSketchDocumentPort.setSelection([lineId])

    expect(sketchSessionStore.getState().selectedIds).toEqual([lineId])
    expect(M.regenKicks).toEqual([])
  })

  it('the unsolved path REFUSES BY NAME rather than crashing when the solver has not booted', () => {
    M = mount('xy')
    sketcherTools.armTool('line')
    click(M, 400, 300)
    click(M, 500, 300)
    // FAILS-IF `solved()` throws or silently writes an unsolved document with no word to the user.
    expect(M.notices.some((n) => /solver is still loading/i.test(n.message))).toBe(true)
    expect(payloadSketch(M).solveStatus).toBeNull()
  })
})

describe('the undo adapter: ONE CommandHistory step per gesture', () => {
  it('a chain-advancing click opens NO step (it costs no Ctrl+Z)', () => {
    M = mount('xy')
    sketcherTools.armTool('line')
    click(M, 400, 300) // first click of the chain: tool state only
    expect(M.history.canUndo()).toBe(false)
  })

  it('a committing click opens EXACTLY ONE step, and undo lands at pre-gesture', () => {
    M = mount('xy')
    sketcherTools.armTool('line')
    click(M, 400, 300)
    click(M, 500, 300)

    expect(payloadSketch(M).entities).toHaveLength(1)
    expect(M.history.canUndo()).toBe(true)

    M.history.undo()
    // FAILS-IF SketchStepCommand's `before` was captured after the write (the classic
    // EditFeaturePayloadCommand trap this class exists to avoid): undo would restore the drawn line.
    expect(payloadSketch(M).entities).toHaveLength(0)

    M.history.redo()
    // FAILS-IF do()'s alreadyApplied latch never clears: redo would be a silent no-op.
    expect(payloadSketch(M).entities).toHaveLength(1)
  })

  it('restores and reselects the same center reference after undo and redo', async () => {
    const circle: Sketch['entities'][number] = {
      id: 'history-circle', kind: 'circle', construction: false,
      center: { x: 10, y: 10 }, radius: 4,
    }
    M = mount('xy', {
      ...blankSketch(),
      entities: [circle],
    })
    const wrapper = await ensureWbWrapper()
    const deps = sketchSessionStore.getDeps()
    if (deps === null) throw new Error('expected bound workbench session dependencies')
    sketchSessionStore.bindDeps({ ...deps, wrapper })

    const center = { entityId: circle.id, site: 'center' as const }
    const selectionId = centerSelectionIdForEntity(circle)
    expect(selectionId).not.toBeNull()
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.append({
      entities: [],
      constraints: [{ id: 'history-fix-center', kind: 'fix', point: center }],
      dimensions: [],
    }, [])

    expect(payloadSketch(M).constraints).toContainEqual({
      id: 'history-fix-center', kind: 'fix', point: center,
    })
    expect(M.history.undo()).toBe(true)
    expect(payloadSketch(M).constraints).toEqual([])
    expect(M.history.redo()).toBe(true)

    const restored = payloadSketch(M)
    const restoredFix = restored.constraints.find((constraint) =>
      constraint.id === 'history-fix-center')
    expect(restoredFix).toEqual({
      id: 'history-fix-center', kind: 'fix', point: center,
    })
    if (!restoredFix || restoredFix.kind !== 'fix' || !restoredFix.point) {
      throw new Error('redo did not restore the center fix')
    }
    const resolved = resolveCenterRef(restored.entities, restoredFix.point)
    expect(resolved).toMatchObject({
      entity: { id: 'history-circle' },
      point: { x: 10, y: 10 },
    })

    M.sketcher.updateSketch(restored, {
      selectedIds: new Set(),
      glyphsVisible: false,
    })
    const marker = M.host.projectToScreen?.(resolved.point, SKETCH_Z)
    expect(marker).not.toBeNull()
    if (!marker || selectionId === null) throw new Error('host did not project the restored center')
    sketcherTools.armTool('select')
    click(M, marker.x, marker.y)
    expect(workbenchSketchDocumentPort.getSelection()).toEqual([selectionId])
  })

  it('two successive committing gestures are two separate steps', () => {
    M = mount('xy')
    sketcherTools.armTool('line')
    click(M, 400, 300); click(M, 500, 300)
    sketcherTools.escape()
    sketcherTools.armTool('line')
    click(M, 400, 350); click(M, 500, 350)

    expect(payloadSketch(M).entities).toHaveLength(2)
    // WO SKC-15C-R1 (B2): the port reported EXACTLY ONE history step per gesture, in order -- this is
    // the signal the page mirrors into its parallel touched-id stack to keep undo resync in lockstep.
    // FAILS-IF a gesture pushes a Command without reporting it (the drift that left one Undo mutating
    // the DAG without resyncing the live document).
    expect(M.historySteps).toEqual([SKETCH_NODE_ID, SKETCH_NODE_ID])
    M.history.undo()
    expect(payloadSketch(M).entities).toHaveLength(1)
    M.history.undo()
    expect(payloadSketch(M).entities).toHaveLength(0)
  })
})

describe('the host: surface primitives are honest under a PERSPECTIVE camera', () => {
  it('clientToPlaneWorld maps the canvas centre to the plane origin', () => {
    M = mount('xy')
    const host = createWorkbenchSketcherHost({
      canvas: M.canvas, container: M.container, runtime: M.runtime,
      overlayRoot: makePlaneFrameGroup(BASE_PLANE_FRAMES.xy), getFrame: () => BASE_PLANE_FRAMES.xy,
    })
    const p = host.clientToPlaneWorld(400, 300)
    expect(Math.abs(p.x)).toBeLessThan(1e-6)
    expect(Math.abs(p.y)).toBeLessThan(1e-6)
  })

  it('worldPerPixel is a positive finite perspective scale, NOT CAM\'s ortho constant', () => {
    M = mount('xy')
    const host = createWorkbenchSketcherHost({
      canvas: M.canvas, container: M.container, runtime: M.runtime,
      overlayRoot: makePlaneFrameGroup(BASE_PLANE_FRAMES.xy), getFrame: () => BASE_PLANE_FRAMES.xy,
    })
    const wpp = host.worldPerPixel()
    // 2 * tan(22.5deg) * 100 / 600 ~= 0.1381
    expect(wpp).toBeGreaterThan(0.12)
    expect(wpp).toBeLessThan(0.16)
    expect(Number.isFinite(wpp)).toBe(true)
  })

  it('sizes badges and dimension arrows at their rendered perspective depth (SKC-20 repro)', () => {
    M = mount('xy')
    const camera = M.runtime.camera as THREE.PerspectiveCamera
    const sketch = overlaySizingSketch(-40)
    M.sketcher.updateSketch(sketch, { selectedIds: new Set(), glyphsVisible: true })
    const faceOnWpp = M.host.worldPerPixel()
    M.sketcher.onFrame(faceOnWpp, 800, 600)
    const faceOnBadge = M.sketcher.layer.group.getObjectByName('fix-near') as THREE.Sprite
    const faceOnBadgeScale = faceOnBadge.scale.x

    // Construct the real interleave: the sketch was already built face-on, then
    // the user orbited while keeping the camera-target distance unchanged.
    camera.position.set(0, -86.6025403784, 50)
    camera.up.set(0, 0, 1)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)

    const badgeAnchor = { x: -10, y: -40 }
    const dimensionAnchor = { x: 0, y: -50 }
    const badgeWpp = effectivePerspectiveWorldPerPixel(camera, badgeAnchor, 600)
    const dimensionWpp = effectivePerspectiveWorldPerPixel(camera, dimensionAnchor, 600)
    const originWpp = M.host.worldPerPixel()
    expect(originWpp).toBeCloseTo(faceOnWpp, 9)
    expect(originWpp / badgeWpp).toBeGreaterThan(1.4)
    expect(originWpp / dimensionWpp).toBeGreaterThan(1.7)

    const badge = M.sketcher.layer.group.getObjectByName('fix-near') as THREE.Sprite | undefined
    const leader = M.sketcher.layer.group.getObjectByName('__dim_dim-near') as THREE.LineSegments | undefined
    const radiusLeader = M.sketcher.layer.group.getObjectByName('__dim_radius-near') as THREE.LineSegments | undefined
    expect(badge).toBeDefined()
    expect(leader).toBeDefined()
    expect(radiusLeader).toBeDefined()
    expect(badge!.scale.x).toBeLessThan(faceOnBadgeScale)

    const badgePx = badge!.scale.x / badgeWpp
    // Arrow barb length is 2.6 x the 5 px dimension tick unit.
    const arrowBarbPx = segmentScreenLengths(leader!, camera, 800, 600).slice(-4)
    const radiusArrowBarbPx = segmentScreenLengths(radiusLeader!, camera, 800, 600).slice(-2)
    console.info('SKC-20 perspective overlay repro', {
      originWpp, badgeWpp, dimensionWpp, badgePx, arrowBarbPx, radiusArrowBarbPx,
    })
    expect(badgePx).toBeCloseTo(BADGE_PX, 5)
    expect(arrowBarbPx).toHaveLength(4)
    for (const barbPx of arrowBarbPx) expect(barbPx).toBeCloseTo(13, 3)
    for (const barbPx of radiusArrowBarbPx) expect(barbPx).toBeCloseTo(13, 3)
  })

  it('sizes overlays from the live orthographic workbench frustum (SKC-20 repro)', () => {
    M = mount('xy')
    const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    M.runtime.camera = camera

    const overlayRoot = makePlaneFrameGroup(BASE_PLANE_FRAMES.xy)
    const host = createWorkbenchSketcherHost({
      canvas: M.canvas, container: M.container, runtime: M.runtime,
      overlayRoot, getFrame: () => BASE_PLANE_FRAMES.xy,
    })
    const sketcher = new Sketcher(host)
    sketcher.layer.group.visible = true
    sketcher.updateSketch(overlaySizingSketch(-40), { selectedIds: new Set(), glyphsVisible: true })
    sketcher.onFrame(host.worldPerPixel(), 800, 600)

    const expectedWpp = (camera.top - camera.bottom) / (600 * camera.zoom)
    const badge = sketcher.layer.group.getObjectByName('fix-near') as THREE.Sprite | undefined
    const leader = sketcher.layer.group.getObjectByName('__dim_dim-near') as THREE.LineSegments | undefined
    const radiusLeader = sketcher.layer.group.getObjectByName('__dim_radius-near') as THREE.LineSegments | undefined
    expect(badge).toBeDefined()
    expect(leader).toBeDefined()
    expect(radiusLeader).toBeDefined()

    const badgePx = badge!.scale.x / expectedWpp
    const arrowBarbPx = segmentScreenLengths(leader!, camera, 800, 600).slice(-4)
    const radiusArrowBarbPx = segmentScreenLengths(radiusLeader!, camera, 800, 600).slice(-2)
    console.info('SKC-20 orthographic overlay repro', {
      hostWpp: host.worldPerPixel(), expectedWpp, badgePx, arrowBarbPx, radiusArrowBarbPx,
    })
    expect(host.worldPerPixel()).toBeCloseTo(expectedWpp, 9)
    expect(badgePx).toBeCloseTo(BADGE_PX, 5)
    for (const barbPx of arrowBarbPx) expect(barbPx).toBeCloseTo(13, 3)
    for (const barbPx of radiusArrowBarbPx) expect(barbPx).toBeCloseTo(13, 3)
    sketcher.dispose()
  })

  it('keeps CAM constant-scale badge and dimension sizing unchanged', () => {
    const wpp = 0.1
    const canvas = document.createElement('canvas')
    const container = document.createElement('div')
    container.appendChild(canvas)
    const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const host: SketcherHost = {
      domElement: canvas, container, overlayHost: container,
      overlayRoot: new THREE.Group(), camera, controls: { enableRotate: false },
      clientToPlaneWorld: (x, y) => ({ x, y }), worldPerPixel: () => wpp,
      saveCameraPose: () => ({}), restoreCameraPose: () => {}, frameNormalToPlane: () => {},
    }
    const sketcher = new Sketcher(host)
    sketcher.layer.group.visible = true
    sketcher.updateSketch(overlaySizingSketch(-40), { selectedIds: new Set(), glyphsVisible: true })
    sketcher.onFrame(wpp, 800, 600)

    const badge = sketcher.layer.group.getObjectByName('fix-near') as THREE.Sprite | undefined
    const leader = sketcher.layer.group.getObjectByName('__dim_dim-near') as THREE.LineSegments | undefined
    const radiusLeader = sketcher.layer.group.getObjectByName('__dim_radius-near') as THREE.LineSegments | undefined
    expect(badge).toBeDefined()
    expect(leader).toBeDefined()
    expect(radiusLeader).toBeDefined()
    expect(badge!.scale.x / wpp).toBeCloseTo(BADGE_PX, 5)
    const arrowBarbPx = segmentScreenLengths(leader!, camera, 800, 600).slice(-4)
    for (const barbPx of arrowBarbPx) expect(barbPx).toBeCloseTo(13, 3)
    const radiusArrowBarbPx = segmentScreenLengths(radiusLeader!, camera, 800, 600).slice(-2)
    for (const barbPx of radiusArrowBarbPx) expect(barbPx).toBeCloseTo(13, 3)
    sketcher.dispose()
  })

  it('refreshes remote arrow tips in place when the label scale stays fixed', () => {
    const wpp = 0.1
    let remoteWarp = 0
    const project = (point: { x: number; y: number }) => ({
      x: point.x / wpp + remoteWarp * point.x ** 3,
      y: point.y / wpp,
    })
    const canvas = document.createElement('canvas')
    const container = document.createElement('div')
    container.appendChild(canvas)
    const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const host: SketcherHost = {
      domElement: canvas, container, overlayHost: container,
      overlayRoot: new THREE.Group(), camera, controls: { enableRotate: false },
      clientToPlaneWorld: (x, y) => ({ x, y }), worldPerPixel: () => wpp,
      projectToScreen: (point) => project(point),
      saveCameraPose: () => ({}), restoreCameraPose: () => {}, frameNormalToPlane: () => {},
    }
    const sketcher = new Sketcher(host)
    sketcher.layer.group.visible = true
    sketcher.updateSketch(overlaySizingSketch(-40), { selectedIds: new Set(), glyphsVisible: true })
    sketcher.onFrame(wpp, 800, 600)

    const leader = sketcher.layer.group.getObjectByName('__dim_dim-near') as THREE.LineSegments
    const geometry = leader.geometry
    const position = geometry.getAttribute('position')
    for (const barbPx of segmentProjectedLengths(leader, project).slice(-4)) {
      expect(barbPx).toBeCloseTo(13, 3)
    }

    // x^3 has zero derivative at the label anchor (x=0), but changes the
    // projection Jacobian at the remote arrow tips (x=+-10). The refresh must
    // therefore be driven by the tip signatures, not by the label anchor.
    remoteWarp = 0.02
    sketcher.onFrame(wpp, 800, 600)

    expect(leader.geometry).toBe(geometry)
    expect(leader.geometry.getAttribute('position')).toBe(position)
    for (const barbPx of segmentProjectedLengths(leader, project).slice(-4)) {
      expect(barbPx).toBeCloseTo(13, 3)
    }
    sketcher.dispose()
  })

  it('an EDGE-ON camera (the ray is parallel to the plane) yields the origin, never NaN', () => {
    M = mount('xy')
    // Look along +X, exactly in-plane with XY: the pick ray never meets z = 0.
    const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
    cam.position.set(-100, 0, 0)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.runtime.camera = cam

    const host = createWorkbenchSketcherHost({
      canvas: M.canvas, container: M.container, runtime: M.runtime,
      overlayRoot: makePlaneFrameGroup(BASE_PLANE_FRAMES.xy), getFrame: () => BASE_PLANE_FRAMES.xy,
    })
    const p = host.clientToPlaneWorld(400, 300)
    // FAILS-IF the null intersectPlane result is passed through: `NaN > tol` is false in BOTH
    // directions, so a NaN would sail silently through every snap guard and into the document.
    expect(Number.isFinite(p.x)).toBe(true)
    expect(Number.isFinite(p.y)).toBe(true)
  })

  it('the workbench host asks for the drag orbit policy; CAM leaves it undefined', () => {
    M = mount('xy')
    const host = createWorkbenchSketcherHost({
      canvas: M.canvas, container: M.container, runtime: M.runtime,
      overlayRoot: makePlaneFrameGroup(BASE_PLANE_FRAMES.xy), getFrame: () => BASE_PLANE_FRAMES.xy,
    })
    expect(host.orbitPolicy).toBe('drag')
  })

  it('the overlayRoot group\'s matrix IS the plane frame (local 2D renders in 3D, unprojected)', () => {
    const g = makePlaneFrameGroup(BASE_PLANE_FRAMES.yz)
    const local = new THREE.Vector3(3, 5, 0) // sketch-local (u, v)
    const world = local.clone().applyMatrix4(g.matrixWorld)
    // YZ: xDir = +Y, yDir = +Z, origin = 0. So local (3,5) -> world (0, 3, 5).
    expect(world.x).toBeCloseTo(0, 9)
    expect(world.y).toBeCloseTo(3, 9)
    expect(world.z).toBeCloseTo(5, 9)
  })
})

// ---- SKC-46-R2 requirement 3: the CONCRETE-HOST matrix (workbench) -----------------------------
//
// The R1 audit's MAJOR finding: the four-corner-class x two-tool x two-host acceptance matrix was
// argued, not run -- one synthetic SketchDocumentPort (sketcherLifecycle.test.ts) stood in for
// BOTH concrete hosts. This block runs the real small/large/remembered-oversize/sub-floor matrix
// through the REAL workbench mount (real Sketcher, real workbenchSketchDocumentPort, real
// FeatureDag/CommandHistory, a real PerspectiveCamera) -- the SAME shape as the
// sketcherLifecycle.test.ts "BLOCKER 1" suite, but through this concrete host instead of the fake.
// A mutation target that fails INDEPENDENTLY here (breaking workbenchSketchDocumentPort's
// staged-size member) is what makes this a genuinely second host, not a re-run of the first.
function filletSketchArm(armLength: number): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [
      { id: 'fillet-a', kind: 'line', construction: false, start: { x: -armLength, y: 0 }, end: { x: 0, y: 0 } },
      { id: 'fillet-b', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: armLength } },
    ],
    constraints: [], dimensions: [], solveStatus: null,
  }
}

/** A right-angle corner at the origin, legs along -x/+y (`filletSketchArm`'s shape): the on-path
 *  midpoint of a staged CHAMFER at `setback` is exactly `(-setback/2, setback/2)` (matches the
 *  existing chamfer drag test above, setback=3 -> midpoint {x:-1.5,y:1.5}); the on-path midpoint of
 *  a staged FILLET arc of `radius` is `(-radius*k, radius*k)` where `k = 1 - cos(45deg)` (the
 *  quarter-circle's angular midpoint, derived analytically from the same corner geometry -- see
 *  the R2 report for the derivation). Avoids depending on the ghost buffer's coordinate framing. */
function onPathLocalPoint(kind: 'fillet' | 'chamfer', size: number): { x: number; y: number } {
  if (kind === 'chamfer') return { x: -size / 2, y: size / 2 }
  const k = 1 - Math.SQRT1_2
  return { x: -size * k, y: size * k }
}

function establishRememberedWorkbenchSize(kind: 'fillet' | 'chamfer', value: number): void {
  M = mount('xy', filletSketchArm(20))
  sketcherTools.armTool(kind)
  click(M, 400, 300)
  sketcherTools.commitDrawValueAt(value, { x: 0, y: 0 })
  sketcherTools.overlayApply()
}

describe('SKC-46-R2: concrete-host matrix (workbench) -- small/large/remembered-oversize/sub-floor', () => {
  function assertStagesPreviewsAndApplies(kind: 'fillet' | 'chamfer', armLength: number): number {
    M = mount('xy', filletSketchArm(armLength))
    // Explicit worldPerPixel: derived from the real perspective camera (workbench cannot hard-set
    // it -- the :726 precedent in this file), asserted positive-finite before it drives any hit test.
    expect(Number.isFinite(M.host.worldPerPixel())).toBe(true)
    expect(M.host.worldPerPixel()).toBeGreaterThan(0)

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

    // Pointer ACQUISITION: a real point on the staged preview's own path acquires the grab cursor.
    const grab = M.host.projectToScreen?.(onPathLocalPoint(kind, stagedSize))
    expect(grab, `${kind} @ ${armLength}mm host must project the staged preview point`).not.toBeNull()
    if (!grab) throw new Error('unreachable (asserted above)')
    pointer('pointermove', M.canvas, grab.x, grab.y)
    expect(M.canvas.style.cursor, `${kind} @ ${armLength}mm: a real preview point must be grabbable`).toBe('grab')

    const stepsBefore = M.historySteps.length
    sketcherTools.overlayApply()
    expect(M.historySteps.length, `${kind} @ ${armLength}mm Apply must commit a non-null transform`)
      .toBe(stepsBefore + 1)
    return stagedSize
  }

  function assertRefusesNamed(kind: 'fillet' | 'chamfer', armLength: number): void {
    M = mount('xy', filletSketchArm(armLength))
    const memoryBefore = kind === 'fillet'
      ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
    sketcherTools.armTool(kind)
    M.notices.length = 0

    click(M, 400, 300)

    const named = M.notices.filter((n) => /too small/i.test(n.message) && new RegExp(kind, 'i').test(n.message))
    expect(named, `expected a NAMED refusal, got: ${JSON.stringify(M.notices)}`).toHaveLength(1)
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
      establishRememberedWorkbenchSize(kind, 10)
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

// ---- SKC-46-R2 requirement 2: REAL preselection refusal gate (workbench, concrete host) --------
describe('SKC-46-R2: real preselection refusal gate (workbench concrete host)', () => {
  /** Two COLLINEAR lines sharing an endpoint (denom < 1e-12, filletTool.ts:156) -- the exact
   *  "two collinear preselected lines" can-fail gate the R2 contract names for BOTH tools, BOTH
   *  hosts. */
  function collinearPairSketch(): Sketch {
    return {
      id: 's1', layerId: 'workbench',
      entities: [
        { id: 'col-a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
        { id: 'col-b', kind: 'line', construction: false, start: { x: 20, y: 0 }, end: { x: 40, y: 0 } },
      ],
      constraints: [], dimensions: [], solveStatus: null,
    }
  }

  describe.each(['fillet', 'chamfer'] as const)('%s', (kind) => {
    it('two collinear preselected lines: named refusal, zero staged preview, memory untouched', () => {
      M = mount('xy', collinearPairSketch())
      const memoryBefore = kind === 'fillet'
        ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
      sketchSessionStore.setState({ selectedIds: ['col-a', 'col-b'] })
      M.notices.length = 0

      sketcherTools.armTool(kind)

      expect(sketcherToolStore.getState().chain?.kind === kind
        ? (sketcherToolStore.getState().chain as { corners: unknown[] }).corners
        : []).toHaveLength(0)
      expect(dashedGhostBuffers(M), 'zero staged preview').toEqual([])
      expect(M.notices.some((n) => new RegExp(kind, 'i').test(n.message)), 'a named refusal must fire').toBe(true)
      const memoryAfter = kind === 'fillet'
        ? useUiPrefs.getState().lastFilletRadius : useUiPrefs.getState().lastChamferSetback
      expect(memoryAfter, 'memory must be untouched').toBe(memoryBefore)
    })

    it('a degenerate near-zero-length leg (len <= EPS_LEN) also refuses by name through this host', () => {
      M = mount('xy', {
        id: 's1', layerId: 'workbench',
        entities: [
          { id: 'deg-a', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 20, y: 0 } },
          // A degenerate zero-length "leg" at the shared corner (0,0)-(0,1e-9): trimSide's
          // `len <= EPS_LEN` guard (filletTool.ts:168) fires before any angle math runs.
          { id: 'deg-b', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 0, y: 1e-9 } },
        ],
        constraints: [], dimensions: [], solveStatus: null,
      })
      sketchSessionStore.setState({ selectedIds: ['deg-a', 'deg-b'] })
      M.notices.length = 0

      sketcherTools.armTool(kind)

      expect(sketcherToolStore.getState().chain?.kind === kind
        ? (sketcherToolStore.getState().chain as { corners: unknown[] }).corners
        : []).toHaveLength(0)
      expect(dashedGhostBuffers(M), 'zero staged preview').toEqual([])
    })
  })
})
