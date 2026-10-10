// @vitest-environment jsdom
//
// WO-1587: "Seat in vise" picks faces IN THE VIEWPORT.
//
// Two halves, both driven through the product's own code:
//
//   1. The pick itself - CNCViewport's seat-face-pick mode over a STEPPED JAW,
//      a vise whose jaw face is nowhere near a bounding-box face. The hover
//      and click paths under test are the exact methods `handleMouseMove` and
//      `handleClick` call; only the two DOM-event wrappers (instance arrow
//      properties, unreachable from a prototype harness) are stepped over, the
//      same seam CNCViewportModelEdgePick.wo113.test.ts uses.
//
//   2. The seat - SeatInViseStrip fed by those picks, asserting the order's
//      acceptance: the step face ends up flush against the part side
//      (coplanar, opposed normals, gap under 0.001 mm), the part never moves,
//      and two seats are two undo steps.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Same shim
// as seatInViseStrip.wo1586.test.tsx.
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

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry, Vec3 } from '../../types'
import { rotationMatrixXYZ } from '../../lib/geometry/rotationMatrixXYZ'
import { localFaceFromWorld, type FacePick, type RigidPose } from '../../lib/cam/workholdingSeat'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { CNCViewport } = await import('../../lib/viewport/CNCViewport')
const { SeatInViseStrip, useSeatInViseUi } = await import('../../components/viewport/SeatInViseStrip')
const { useCamStore } = await import('../../store')
type SeatFacePick = import('../../lib/viewport/CNCViewport').SeatFacePick
type CNCViewportInstance = import('../../lib/viewport/CNCViewport').CNCViewport

afterEach(cleanup)

const TOL = 0.001 // mm, the order's own gap tolerance

function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }

/** A local-frame face pick carried out into world space through a pose - the
 *  forward trip `localFaceFromWorld` undoes. */
function worldFace(pose: RigidPose, local: FacePick): FacePick {
  const R = rotationMatrixXYZ(pose.rotation)
  const apply = (v: Vec3): Vec3 => ({
    x: R.col1.x * v.x + R.col2.x * v.y + R.col3.x * v.z,
    y: R.col1.y * v.x + R.col2.y * v.y + R.col3.y * v.z,
    z: R.col1.z * v.x + R.col2.z * v.y + R.col3.z * v.z,
  })
  const p = apply(local.point)
  return {
    point: { x: p.x + pose.position.x, y: p.y + pose.position.y, z: p.z + pose.position.z },
    normal: apply(local.normal),
  }
}

// ── The stepped jaw ────────────────────────────────────────────────────────
//
// A vise body 30 x 40 x 50 whose JAW is a step: the clamping face sits at
// local x = -10, 10 mm INBOARD of the body's +X bounding-box face at x = 0.
// No BoxFaceKey can ever name it; WO-1574's dropdowns could not pick it.
//
//        z                 +--------+  60  top face (+Z)
//        ^                 |        |
//        |                 |        |      front face (+X) at x = 0
//        |         +-------+        |  30  shelf (+Z) at z = 30
//        |         |                |
//        |         |                |  10  STEP JAW FACE (+X) at x = -10
//        +-------->x   -30       -10  0
//
const JAW_FACE_LOCAL: FacePick = { point: { x: -10, y: 0, z: 20 }, normal: { x: 1, y: 0, z: 0 } }
const SHELF_FACE_LOCAL: FacePick = { point: { x: -5, y: 0, z: 30 }, normal: { x: 0, y: 0, z: 1 } }

/** Two triangles for a planar quad, wound so cross(b-a, c-a) is the outward normal. */
function quad(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d]
}

function steppedJawMesh(): THREE.Mesh {
  const verts = [
    // step jaw face, x = -10, z 10..30, normal +X
    ...quad([-10, -20, 10], [-10, 20, 10], [-10, 20, 30], [-10, -20, 30]),
    // front face, x = 0, z 30..60, normal +X - same direction as the jaw but
    // not edge-adjacent to it, so the clustering must keep them apart
    ...quad([0, -20, 30], [0, 20, 30], [0, 20, 60], [0, -20, 60]),
    // shelf, z = 30, normal +Z
    ...quad([-10, -20, 30], [0, -20, 30], [0, 20, 30], [-10, 20, 30]),
    // top, z = 60, normal +Z
    ...quad([-30, -20, 60], [0, -20, 60], [0, 20, 60], [-30, 20, 60]),
  ]
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
}

function partMesh(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(50, 30, 20)
  geo.translate(25, 55, 10)
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
}

// ───────────────────────────────────────────────────────────────────────────
// 1. The pick: CNCViewport's seat-face-pick mode
// ───────────────────────────────────────────────────────────────────────────

interface PickHarness {
  partGroups: Map<string, THREE.Group>
  faceOverlays: Array<{ geoId?: string; normal: THREE.Vector3 }>
  updateFaceOverlayHover: (mx: number, my: number) => void
  commitSeatFacePickAtHover: () => void
  canPickFacesFor: (geoId: string) => boolean
  enterSeatFacePickMode: (
    geoIds: readonly string[],
    onPick: (pick: SeatFacePick) => void,
    onHover?: ((pick: SeatFacePick | null) => void) | null,
  ) => void
  exitSeatFacePickMode: () => void
}

function priv(viewport: CNCViewportInstance): PickHarness {
  return viewport as unknown as PickHarness
}

/** Orthographic camera at +X looking down -X, world +Z up. NDC x maps to
 *  world Y / 100, NDC y maps to (world Z - 35) / 100. */
function makePickHarness(): CNCViewportInstance {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewportInstance
  const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1000)
  camera.position.set(200, 0, 35)
  camera.up.set(0, 0, 1)
  camera.lookAt(0, 0, 35)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)

  const viseGroup = new THREE.Group()
  viseGroup.add(steppedJawMesh())
  const partGroup = new THREE.Group()
  partGroup.add(partMesh())

  Object.assign(viewport, {
    partGroups: new Map<string, THREE.Group>([['vise', viseGroup], ['part', partGroup]]),
    faceHighlightGroup: new THREE.Group(),
    faceOverlays: [],
    hoveredOverlayMesh: null,
    interactionMode: 'normal',
    seatFacePickCallback: null,
    seatFacePickHoverCallback: null,
    selectedPartId: null,
    geometry2dGroups: new Map<string, THREE.Group>(),
    camera,
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    renderer: {
      domElement: {
        style: {},
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    },
  })
  return viewport
}

const NDC_JAW: [number, number] = [0, -0.15]       // world (y 0, z 20) -> the step face
const NDC_FRONT: [number, number] = [0, 0.10]      // world (y 0, z 45) -> the front face
const NDC_PART: [number, number] = [0.55, -0.25]   // world (y 55, z 10) -> the part's +X face

describe('WO-1587: the viewport picks a real mesh face for Seat in vise', () => {
  it('hovering the stepped jaw reports that step face - a face no bounding box names - and clicking picks it', () => {
    const vp = makePickHarness()
    const picks: SeatFacePick[] = []
    const hovers: Array<SeatFacePick | null> = []
    priv(vp).enterSeatFacePickMode(['vise', 'part'], (p) => picks.push(p), (h) => hovers.push(h))

    // Both bodies are overlaid at once, and every face knows which body it is on.
    const tagged = priv(vp).faceOverlays
    expect(tagged.length).toBeGreaterThan(1)
    expect(new Set(tagged.map((f) => f.geoId))).toEqual(new Set(['vise', 'part']))

    priv(vp).updateFaceOverlayHover(...NDC_JAW)
    expect(hovers.length).toBe(1)
    const hovered = hovers[0]!
    expect(hovered.geoId).toBe('vise')
    expect(hovered.normal.x).toBeCloseTo(1, 6)
    expect(hovered.normal.y).toBeCloseTo(0, 6)
    expect(hovered.normal.z).toBeCloseTo(0, 6)
    // The step face, NOT the +X bounding-box face: the body's bbox reaches
    // x = 0, this face sits 10 mm inboard of it.
    expect(hovered.point.x).toBeCloseTo(-10, 6)
    expect(hovered.point.y).toBeCloseTo(0, 6)
    expect(hovered.point.z).toBeCloseTo(20, 6)

    priv(vp).commitSeatFacePickAtHover()
    expect(picks).toEqual([hovered])
  })

  it('the +X front face, the same normal as the jaw but a separate region, picks separately', () => {
    const vp = makePickHarness()
    const picks: SeatFacePick[] = []
    priv(vp).enterSeatFacePickMode(['vise', 'part'], (p) => picks.push(p))

    priv(vp).updateFaceOverlayHover(...NDC_FRONT)
    priv(vp).commitSeatFacePickAtHover()
    expect(picks.length).toBe(1)
    expect(picks[0].geoId).toBe('vise')
    expect(picks[0].normal.x).toBeCloseTo(1, 6)
    expect(picks[0].point.x).toBeCloseTo(0, 6)
    expect(picks[0].point.z).toBeCloseTo(45, 6)

    // ... and the part's own face reports the part, not the vise.
    priv(vp).updateFaceOverlayHover(...NDC_PART)
    priv(vp).commitSeatFacePickAtHover()
    expect(picks.length).toBe(2)
    expect(picks[1].geoId).toBe('part')
    expect(picks[1].normal.x).toBeCloseTo(1, 6)
    expect(picks[1].point.x).toBeCloseTo(50, 6)
  })

  it('clicking empty space picks nothing, and leaving the mode drops every overlay', () => {
    const vp = makePickHarness()
    const picks: SeatFacePick[] = []
    priv(vp).enterSeatFacePickMode(['vise', 'part'], (p) => picks.push(p))

    priv(vp).updateFaceOverlayHover(-0.9, 0.9)   // off both bodies
    priv(vp).commitSeatFacePickAtHover()
    expect(picks).toEqual([])

    priv(vp).exitSeatFacePickMode()
    expect(priv(vp).faceOverlays).toEqual([])
  })

  it('a body with no rendered triangles cannot be face-picked', () => {
    const vp = makePickHarness()
    expect(priv(vp).canPickFacesFor('vise')).toBe(true)
    expect(priv(vp).canPickFacesFor('part')).toBe(true)
    expect(priv(vp).canPickFacesFor('not-loaded')).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. The seat: SeatInViseStrip driven by those picks
// ───────────────────────────────────────────────────────────────────────────

function box(id: string, name: string, min: Vec3, max: Vec3, position: Vec3, rotation: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { ...min }, max: { ...max },
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position, rotation, loaded: true,
  } as ImportedGeometry
}

const PART_POSE: RigidPose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
const PART = box('part', 'Bracket', { x: 0, y: 40, z: 0 }, { x: 50, y: 70, z: 20 }, PART_POSE.position, PART_POSE.rotation)
// Same deliberately-crooked starting pose WO-1574/WO-1586 seat from.
const VISE_START_POSE: RigidPose = { position: { x: 90, y: -2, z: 5 }, rotation: { x: 0, y: 0, z: 5 } }
const VISE = box('vise', 'Stepped-jaw vise', { x: -30, y: -20, z: 0 }, { x: 0, y: 20, z: 60 }, VISE_START_POSE.position, VISE_START_POSE.rotation)

// The part faces the seats target, in world space (the part never moves).
const PART_SIDE_FACE: FacePick = { point: { x: 50, y: 55, z: 10 }, normal: { x: 1, y: 0, z: 0 } }
const PART_BOTTOM_FACE: FacePick = { point: { x: 25, y: 55, z: 0 }, normal: { x: 0, y: 0, z: -1 } }

function viseOf(): ImportedGeometry {
  return useCamStore.getState().project.geometry.find((g) => g.id === 'vise')!
}
function partOf(): ImportedGeometry {
  return useCamStore.getState().project.geometry.find((g) => g.id === 'part')!
}
function visePose(): RigidPose {
  return { position: { ...viseOf().position }, rotation: { ...viseOf().rotation } }
}

/** The order's acceptance, measured: `local` on the vise's CURRENT pose is
 *  flush against `target` - coplanar, opposed normals, gap under 0.001 mm. */
function expectFlush(local: FacePick, target: FacePick) {
  const seated = worldFace(visePose(), local)
  expect(dot(seated.normal, target.normal)).toBeCloseTo(-1, 6)
  expect(Math.abs(dot(sub(seated.point, target.point), target.normal))).toBeLessThan(TOL)
}

interface FakeVp {
  armings: string[][]
  exits: number
  transforms: Array<{ id: string; pos: Vec3; rot: Vec3 }>
  pick: ((p: SeatFacePick) => void) | null
  hover: ((p: SeatFacePick | null) => void) | null
}

let fake: FakeVp

function installFakeViewport(pickable: readonly string[]) {
  fake = { armings: [], exits: 0, transforms: [], pick: null, hover: null }
  const handle = {
    setPartTransform: (id: string, pos: Vec3, rot: Vec3) => { fake.transforms.push({ id, pos, rot }) },
    canPickFacesFor: (geoId: string) => pickable.includes(geoId),
    enterSeatFacePickMode: (
      ids: readonly string[],
      onPick: (p: SeatFacePick) => void,
      onHover?: ((p: SeatFacePick | null) => void) | null,
    ) => { fake.armings.push([...ids]); fake.pick = onPick; fake.hover = onHover ?? null },
    exitSeatFacePickMode: () => { fake.exits += 1 },
  }
  ;(window as unknown as Record<string, unknown>).__cncViewport = handle
}

/** A viewport pick of a LOCAL vise face, reported in world space the way the
 *  real face picker reports it: through the vise's pose as it stands now. */
function viewportPickOfViseFace(local: FacePick): SeatFacePick {
  const w = worldFace(visePose(), local)
  return { geoId: 'vise', point: w.point, normal: w.normal }
}
function viewportPickOfPartFace(face: FacePick): SeatFacePick {
  return { geoId: 'part', point: face.point, normal: face.normal }
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().addGeometry(PART)
    useCamStore.getState().addGeometry(VISE)
    useCamStore.getState().setGeometryWorkholding('vise', true)
  })
  act(() => { useSeatInViseUi.getState().closeSeatInVise() })
  installFakeViewport(['vise', 'part'])
})

afterEach(() => { delete (window as unknown as Record<string, unknown>).__cncViewport })

describe('WO-1587: the strip seats from viewport face picks', () => {
  it('a stepped jaw face and a part side seat flush, the part never moves, and two seats are two undo steps', () => {
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    render(<SeatInViseStrip />)
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } }) })

    // Both bodies are pickable, so the dropdowns are gone - no face select and
    // no Seat button, because the second pick IS the commit.
    expect(screen.queryByTestId('seat-in-vise-hold-face')).toBeNull()
    expect(screen.queryByTestId('seat-in-vise-part-face')).toBeNull()
    expect(screen.queryByTestId('seat-in-vise-run')).toBeNull()
    expect(fake.armings.at(-1)).toEqual(['vise', 'part'])

    // Hover reports which body's face the click would take.
    act(() => { fake.hover!(viewportPickOfViseFace(JAW_FACE_LOCAL)) })
    expect(screen.getByTestId('seat-in-vise-hover').textContent).toMatch(/Stepped-jaw vise/)

    // Seat 1: the STEP face against the part's side.
    const jawPick = viewportPickOfViseFace(JAW_FACE_LOCAL)
    act(() => { fake.pick!(jawPick) })
    expect(screen.getByTestId('seat-in-vise-pending').textContent).toMatch(/Stepped-jaw vise face picked/)
    act(() => { fake.pick!(viewportPickOfPartFace(PART_SIDE_FACE)) })

    expectFlush(JAW_FACE_LOCAL, PART_SIDE_FACE)
    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()
    expect(screen.getByTestId('seat-in-vise-instruction').textContent).toMatch(/first contact holds/)
    // The bodies moved, so the mode re-armed and rebuilt its face overlays -
    // without that, seat 2's picks would describe the vise's OLD pose.
    expect(fake.armings.length).toBeGreaterThan(1)
    expect(fake.transforms.at(-1)?.id).toBe('vise')
    const afterFirstSeat = visePose()

    // Seat 2: the shelf against the part's bottom, sliding along the first
    // contact only. The picks are re-read at the vise's NEW pose.
    act(() => { fake.pick!(viewportPickOfViseFace(SHELF_FACE_LOCAL)) })
    act(() => { fake.pick!(viewportPickOfPartFace(PART_BOTTOM_FACE)) })

    expectFlush(SHELF_FACE_LOCAL, PART_BOTTOM_FACE)
    expectFlush(JAW_FACE_LOCAL, PART_SIDE_FACE)   // the jaw contact still holds
    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()
    expect(visePose().position).not.toEqual(afterFirstSeat.position)

    // The part never moved.
    expect(partOf().position).toEqual(PART_POSE.position)
    expect(partOf().rotation).toEqual(PART_POSE.rotation)

    // Two seats, two undo steps.
    act(() => { useCamStore.getState().undo() })
    expect(visePose()).toEqual(afterFirstSeat)
    act(() => { useCamStore.getState().undo() })
    expect(viseOf().position).toEqual(VISE_START_POSE.position)
    expect(viseOf().rotation).toEqual(VISE_START_POSE.rotation)
  })

  it('part-then-vise seats the same as vise-then-part - the strip invents no ordering rule', () => {
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    render(<SeatInViseStrip />)
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } }) })

    act(() => { fake.pick!(viewportPickOfPartFace(PART_SIDE_FACE)) })
    expect(screen.getByTestId('seat-in-vise-pending').textContent).toMatch(/Bracket face picked/)
    act(() => { fake.pick!(viewportPickOfViseFace(JAW_FACE_LOCAL)) })

    expectFlush(JAW_FACE_LOCAL, PART_SIDE_FACE)
    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()
  })

  it('opening the strip on an ALREADY-MOUNTED host preselects the workholding body, so the viewport owns its picks', () => {
    // Viewport.tsx mounts SeatInViseStrip unconditionally, so the open signal
    // arrives at a component that has been mounted since boot. If the body's
    // `useState(initialWorkholdingId)` never re-reads, the workholding side is
    // silently blank and the strip falls back to bounding-box dropdowns for a
    // body the viewport can pick perfectly well. WO-1587's own capture caught
    // exactly that; this is the guard.
    render(<SeatInViseStrip />)
    expect(screen.queryByTestId('seat-in-vise-strip')).toBeNull()

    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    expect((screen.getByTestId('seat-in-vise-workholding') as HTMLSelectElement).value).toBe('vise')
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } }) })
    expect(screen.queryByTestId('seat-in-vise-hold-face')).toBeNull()
    expect(fake.armings.at(-1)).toEqual(['vise', 'part'])
  })

  it('closing the strip leaves no pick mode armed in the viewport', () => {
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    render(<SeatInViseStrip />)
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } }) })
    expect(fake.armings.length).toBeGreaterThan(0)

    const before = fake.exits
    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-close')) })
    expect(useSeatInViseUi.getState().open).toBe(false)
    expect(fake.exits).toBeGreaterThan(before)
  })

  it('a body the viewport cannot raycast keeps its bounding-box faces rather than refusing to seat', () => {
    // The vise mesh is loaded, the part is not: the vise is picked in the
    // viewport, the part still offers its six bounding-box faces, and the seat
    // still happens. Rule 11 - the software can do this, so it does it.
    installFakeViewport(['vise'])
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    render(<SeatInViseStrip />)
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } }) })

    expect(screen.queryByTestId('seat-in-vise-hold-face')).toBeNull()
    expect(screen.getByTestId('seat-in-vise-part-face')).toBeTruthy()
    expect(fake.armings.at(-1)).toEqual(['vise'])

    act(() => { fake.pick!(viewportPickOfViseFace(JAW_FACE_LOCAL)) })
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part-face'), { target: { value: 'px' } }) })
    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-run')) })

    expectFlush(JAW_FACE_LOCAL, PART_SIDE_FACE)
    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()
  })
})

describe('WO-1587: localFaceFromWorld is the only adapter a world pick needed', () => {
  it('round-trips a stepped-jaw face through an arbitrary pose', () => {
    const pose: RigidPose = { position: { x: 12, y: -3, z: 7 }, rotation: { x: 20, y: -35, z: 110 } }
    const back = localFaceFromWorld(pose, worldFace(pose, JAW_FACE_LOCAL))
    expect(back.point.x).toBeCloseTo(JAW_FACE_LOCAL.point.x, 9)
    expect(back.point.y).toBeCloseTo(JAW_FACE_LOCAL.point.y, 9)
    expect(back.point.z).toBeCloseTo(JAW_FACE_LOCAL.point.z, 9)
    expect(back.normal.x).toBeCloseTo(JAW_FACE_LOCAL.normal.x, 9)
    expect(back.normal.y).toBeCloseTo(JAW_FACE_LOCAL.normal.y, 9)
    expect(back.normal.z).toBeCloseTo(JAW_FACE_LOCAL.normal.z, 9)
  })
})
