// @vitest-environment jsdom
//
// WO-2854 (the operator, 2026-10-15, Full Suite): "what the heck is going on when I go
// to enter and edit existing sketches. It moves part of that sketch to the
// right, not where it currently lives."
//
// Full Suite's Leadscrew_Stepper_Mount is placed at x = -79.9. Opening its
// Layer 2 for sketch editing drew the lifted entities at the workspace origin
// (the 2026-07-22 nest-only display pose), i.e. 79.9 mm right of the part's
// other layers, which stay drawn where the part lives.
//
// Measured through the production path: the REAL <Viewport/> mounted over the
// REAL store (CNCViewport mocked - jsdom has no WebGL), the REAL
// openSketchForLayer action. The CAM view's own pose for the part is what
// Viewport hands add2DGeometry; the sketch editor's pose is what it hands
// updateSketch. Every opened entity, mapped through the sketch pose, must land
// on its source loop mapped through the CAM pose (1e-6 mm) - on open, and
// again after Finish + re-open.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ImportedGeometry, Loop2D, Vec2 } from '../../types'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
// The open solve is not under test (the lift's coordinates are): a silent
// worker leaves the document exactly as openSketchForLayer built it.
class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)

type Pose = { x: number; y: number; rotationDeg: number }
type Add2DCall = [string, Loop2D[], unknown, { x: number; y: number; z: number }?, { x: number; y: number; z: number }?]
type UpdateSketchCall = [Sketch | null, unknown, Pose | undefined]
let add2DCalls: Add2DCall[] = []
let updateSketchCalls: UpdateSketchCall[] = []

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>((() => {
  const METHODS = [
    'addModelBody', 'addSTL', 'applyNavPreset', 'clearCarvedStock',
    'clearPartLoopsOnFacePlane', 'clearScene', 'dispose', 'enterSketchView',
    'exitSketchView', 'markCameraUserPositioned',
    'partPointToScreen', 'rebuildStock', 'renderToolpath', 'restoreCameraState',
    'restoreSelectedPartAfterSceneRestore', 'resumeRender', 'saveCameraState',
    'setAxesVisible', 'setBrepPickMode', 'setMoveSelectCallback',
    'setCameraChangeHandler', 'setGridSpacing', 'setGridVisible',
    'setHiddenToolpathRoles', 'setMachineTravel', 'setMachineVisible',
    'setPartProjectedLoops', 'setPartTransform', 'setSectionView',
    'setSeedOutlineVisible', 'setSelectedPart', 'setSetupSupportPlane', 'setShadingMode', 'setSketchDocumentPort',
    'setSketchEditingLayer', 'setSketchMenuPort', 'setSketchOverlayHost',
    'setSketchUndoSink', 'setStockVisible', 'setToolpathVisible', 'setWCSOrigin',
    'setWorkpieceVisible', 'showCarvedStock', 'suspendRender', 'removeSTL',
    'updateHeightPlanes', 'setSTLVisible', 'remove2DGeometry',
  ]
  class CNCViewport {
    constructor() {
      for (const method of METHODS) (this as Record<string, unknown>)[method] = vi.fn()
    }
    add2DGeometry(...args: Add2DCall) { add2DCalls.push(args) }
    updateSketch(...args: UpdateSketchCall) { updateSketchCalls.push(args) }
  }
  return { CNCViewport: CNCViewport as never }
})()))
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({ ViewCube: () => createElement('div') }))

const { Viewport } = await import('../../components/viewport/Viewport')
const { useCamStore } = await import('../../store')
const { blockMemberWorldEntities } = await import('../../lib/sketch/blocks')
const { isInjectedSketchAnchorId } = await import('../../lib/sketch/sketchAnchors')

const root = resolve(import.meta.dirname, '../../..')
const fullSuite = JSON.parse(readFileSync(join(root, 'Example Projects/Full Suite.camproject'), 'utf8'))
const leadscrew: ImportedGeometry = fullSuite.geometry.find((g: ImportedGeometry) => g.name === 'Leadscrew_Stepper_Mount')
const LAYER_2 = 'color-1'

/** An off-origin, ROTATED DXF part on a stock: the "any stock/position" case. */
function rotatedDxf(): ImportedGeometry {
  const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 25 }, { x: 0, y: 25 }]
  return {
    id: 'wo2854-dxf', name: 'Bracket', filename: 'bracket.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 25, z: 0 }, size: { x: 40, y: 25, z: 0 }, center: { x: 20, y: 12.5, z: 0 } },
    position: { x: 212.5, y: -63.25, z: 0 }, rotation: { x: 0, y: 0, z: 30 }, loaded: true,
    stockId: leadscrew.stockId,
    loops: [{ id: 'wo2854-outer', layerId: 'CUT', closed: true, type: 'contour', area: 1000, points }],
    layers2d: [{ id: 'CUT', name: 'CUT', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

const posed = (p: Vec2, pose: Pose): Vec2 => {
  const a = pose.rotationDeg * Math.PI / 180
  return { x: pose.x + p.x * Math.cos(a) - p.y * Math.sin(a), y: pose.y + p.x * Math.sin(a) + p.y * Math.cos(a) }
}

/** Key points of the opened document in sketch-local mm (block members
 *  resolved; the injected origin anchor and axis lines are the sketch's own
 *  frame, not lifted content). */
function entityPoints(sketch: Sketch): Vec2[] {
  const flat = (e: SketchEntity): SketchEntity[] => e.kind === 'block' ? blockMemberWorldEntities(e, sketch.blockDefs) : [e]
  return sketch.entities.filter((e) => !isInjectedSketchAnchorId(e.id)).flatMap(flat).flatMap((e) => {
    if (e.kind === 'line') return [e.start, e.end]
    if (e.kind === 'circle' || e.kind === 'arc') return [e.center]
    return []
  })
}

function camPoseOf(geoId: string): Pose {
  const call = [...add2DCalls].reverse().find(([id]) => id === geoId)
  expect(call, `add2DGeometry(${geoId})`).toBeDefined()
  return { x: call![3]!.x, y: call![3]!.y, rotationDeg: call![4]!.z }
}

function sketchPose(): { sketch: Sketch; pose: Pose } {
  const call = [...updateSketchCalls].reverse().find(([sk]) => sk !== null)
  expect(call, 'updateSketch(document)').toBeDefined()
  return { sketch: call![0]!, pose: call![2] ?? { x: 0, y: 0, rotationDeg: 0 } }
}

/** Every opened entity point, drawn by the sketch editor, lands on a point of
 *  the source loops as the CAM view draws them. Returns the worst miss in mm. */
function worstMiss(geo: ImportedGeometry, layerId: string): number {
  const camPose = camPoseOf(geo.id)
  const source = (useCamStore.getState().project.geometry.find((g) => g.id === geo.id)!.loops ?? [])
    .filter((l) => l.layerId === layerId)
    .flatMap((l) => [...l.points, ...(l.segments ?? []).flatMap((s) => s.type === 'arc' ? [s.to, s.center] : [s.to])])
    .map((p) => posed(p, camPose))
  const { sketch, pose } = sketchPose()
  const drawn = entityPoints(sketch).map((p) => posed(p, pose))
  expect(drawn.length).toBeGreaterThan(0)
  let worst = 0
  for (const d of drawn) {
    let best = Infinity
    for (const s of source) best = Math.min(best, Math.hypot(d.x - s.x, d.y - s.y))
    worst = Math.max(worst, best)
  }
  return worst
}

function open(geo: ImportedGeometry, layerId: string) {
  let opened = false
  act(() => { opened = useCamStore.getState().openSketchForLayer(layerId, geo.id) })
  expect(opened).toBe(true)
  expect(useCamStore.getState().viewer.mode).toBe('sketch')
}

beforeEach(() => {
  add2DCalls = []
  updateSketchCalls = []
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [structuredClone(leadscrew), rotatedDxf()] } }))
  })
  render(createElement(Viewport))
})

afterEach(() => {
  act(() => { if (useCamStore.getState().viewer.mode === 'sketch') useCamStore.getState().cancelActiveSketch() })
  cleanup()
  vi.clearAllMocks()
})

describe('WO-2854: an imported layer opened in Sketch stays exactly where it lives', () => {
  it('Full Suite Leadscrew_Stepper_Mount Layer 2 opens on top of its own outline, not 79.9 mm to the right', () => {
    expect(leadscrew.position.x).toBeLessThan(-79)
    open(leadscrew, LAYER_2)
    expect(worstMiss(leadscrew, LAYER_2)).toBeLessThan(1e-6)
  })

  it('an off-origin, rotated DXF part on a stock opens exactly where it lives', () => {
    const dxf = rotatedDxf()
    open(dxf, 'CUT')
    expect(worstMiss(dxf, 'CUT')).toBeLessThan(1e-6)
  })

  it('Finish bakes back to the same place and re-open lands on it again (no drift)', () => {
    open(leadscrew, LAYER_2)
    expect(worstMiss(leadscrew, LAYER_2)).toBeLessThan(1e-6)
    const before = useCamStore.getState().project.geometry.find((g) => g.id === leadscrew.id)!.position
    act(() => { useCamStore.getState().finishSketch() })
    expect(useCamStore.getState().viewer.mode).not.toBe('sketch')
    const after = useCamStore.getState().project.geometry.find((g) => g.id === leadscrew.id)!
    expect(after.position).toEqual(before)
    expect(after.sketches?.some((sk) => sk.layerId === LAYER_2)).toBe(true)
    updateSketchCalls = []
    open(leadscrew, LAYER_2)
    expect(worstMiss(leadscrew, LAYER_2)).toBeLessThan(1e-6)
  })
})
