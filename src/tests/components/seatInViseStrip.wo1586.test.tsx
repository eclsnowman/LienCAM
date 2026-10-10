// @vitest-environment jsdom
//
// WO-1586: WO-1574 built the seating engine and a `SeatInViseCommand` modal
// mounted nowhere. This verifies the re-host: reachable from the Properties
// panel's Workholding row, seated through the app's own components + store
// (not a hand-built payload) with a result matching WO-1574's own acceptance
// geometry, carrying no modal-backdrop anywhere, and leaving the viewport
// element mounted throughout.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Same
// shim as workholdingTreeAndProperties.wo1573.test.tsx.
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import type { ImportedGeometry, Vec3 } from '../../types'
import { worldBoxFace, type FacePick } from '../../lib/cam/workholdingSeat'
import { stubCanvas2d } from '../model3d/stubCanvas2d'

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { SeatInViseStrip, useSeatInViseUi } = await import('../../components/viewport/SeatInViseStrip')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

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

// The same 50x30x20 part and Kurt-vise-with-a-5deg-error scenario
// workholdingSeat.wo1574.test.ts proves the engine against - driven here
// through the UI instead of calling seatFirstFace/seatSecondFace directly.
const PART_BB = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 30, z: 20 } }
const PART_POSE = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
const PART = box('part', 'Bracket', PART_BB.min, PART_BB.max, PART_POSE.position, PART_POSE.rotation)

const VISE_BB = { min: { x: -30, y: -20, z: 0 }, max: { x: 0, y: 20, z: 60 } }
const VISE_START_POSE = { position: { x: 90, y: -2, z: 5 }, rotation: { x: 0, y: 0, z: 5 } }
const VISE = box('vise', 'Kurt vise', VISE_BB.min, VISE_BB.max, VISE_START_POSE.position, VISE_START_POSE.rotation)

const TOL = 0.001 // mm, the order's own gap tolerance

function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }

function expectSeated(
  bb: { min: Vec3; max: Vec3 }, pose: { position: Vec3; rotation: Vec3 },
  face: 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz', target: FacePick,
) {
  const worldFace = worldBoxFace(bb, pose, face)
  expect(dot(worldFace.normal, target.normal)).toBeCloseTo(-1, 6)
  expect(Math.abs(dot(sub(worldFace.point, target.point), target.normal))).toBeLessThan(TOL)
}

function viseOf(): ImportedGeometry {
  return useCamStore.getState().project.geometry.find((g) => g.id === 'vise')!
}
function partOf(): ImportedGeometry {
  return useCamStore.getState().project.geometry.find((g) => g.id === 'part')!
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().addGeometry(PART)
    useCamStore.getState().addGeometry(VISE)
    useCamStore.getState().setGeometryWorkholding('vise', true)
  })
  act(() => { useSeatInViseUi.getState().closeSeatInVise() })
})

describe('WO-1586: Seat in vise is reachable from the Properties Workholding row', () => {
  it('offers a Seat in vise button only when the body is marked workholding, and clicking it opens the strip preselected to that body', () => {
    act(() => { useCamStore.getState().setSelectedGeometry('vise') })
    render(<PropertiesPanel />)
    const row = screen.getByTestId('geo-workholding-toggle-row')
    expect(within(row).getByTestId('geo-seat-in-vise-btn')).toBeTruthy()

    fireEvent.click(within(row).getByTestId('geo-seat-in-vise-btn'))
    expect(useSeatInViseUi.getState().open).toBe(true)
    expect(useSeatInViseUi.getState().workholdingId).toBe('vise')
  })

  it('no Seat in vise button when the body is not marked workholding', () => {
    act(() => {
      useCamStore.getState().setGeometryWorkholding('vise', false)
      useCamStore.getState().setSelectedGeometry('vise')
    })
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('geo-seat-in-vise-btn')).toBeNull()
  })
})

describe("WO-1586: the workspace strip seats through the app's own components + store", () => {
  const partSideFace = worldBoxFace(PART_BB, PART_POSE, 'px')
  const partBottomFace = worldBoxFace(PART_BB, PART_POSE, 'nz')

  it('carries no modal-backdrop, seats jaw-then-floor matching WO-1574\'s own acceptance geometry, and the part never moves', () => {
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    render(<SeatInViseStrip />)

    const strip = screen.getByTestId('seat-in-vise-strip')
    expect(strip.getAttribute('role')).toBe('toolbar')
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()

    // Workholding is preselected by the opener; pick the part. Defaults
    // (jaw = -X, part face = +X) already match this scenario's first seat.
    fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))

    expectSeated(VISE_BB, { position: viseOf().position, rotation: viseOf().rotation }, 'nx', partSideFace)
    expect(viseOf().rotation.x).toBeCloseTo(0, 6)
    expect(viseOf().rotation.y).toBeCloseTo(0, 6)
    expect(viseOf().rotation.z).toBeCloseTo(0, 6)
    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()

    // Second seat: floor (+Z) against the part's bottom (-Z). The strip's own
    // instruction text confirms it moved to stage two before the picks are changed.
    expect(screen.getByTestId('seat-in-vise-instruction').textContent).toMatch(/first contact holds/)
    const afterFirstSeat = { position: { ...viseOf().position }, rotation: { ...viseOf().rotation } }

    fireEvent.change(screen.getByTestId('seat-in-vise-hold-face'), { target: { value: 'pz' } })
    fireEvent.change(screen.getByTestId('seat-in-vise-part-face'), { target: { value: 'nz' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))

    expectSeated(VISE_BB, { position: viseOf().position, rotation: viseOf().rotation }, 'pz', partBottomFace)
    expectSeated(VISE_BB, { position: viseOf().position, rotation: viseOf().rotation }, 'nx', partSideFace) // jaw contact still holds
    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()
    expect(viseOf().position).not.toEqual(afterFirstSeat.position)

    // The part never moved.
    expect(partOf().position).toEqual(PART_POSE.position)
    expect(partOf().rotation).toEqual(PART_POSE.rotation)

    // Two commits are two undo steps (WO-1574's own contract, re-proven here
    // through the UI): undo twice restores the vise's original transform.
    act(() => { useCamStore.getState().undo() })
    expect(viseOf().position).toEqual(afterFirstSeat.position)
    expect(viseOf().rotation).toEqual(afterFirstSeat.rotation)
    act(() => { useCamStore.getState().undo() })
    expect(viseOf().position).toEqual(VISE_START_POSE.position)
    expect(viseOf().rotation).toEqual(VISE_START_POSE.rotation)
  })

  it('Done closes the strip after both seats; Escape closes it at any stage', () => {
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    const { rerender } = render(<SeatInViseStrip />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useSeatInViseUi.getState().open).toBe(false)
    rerender(<SeatInViseStrip />)
    expect(screen.queryByTestId('seat-in-vise-strip')).toBeNull()

    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    rerender(<SeatInViseStrip />)
    fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))
    fireEvent.change(screen.getByTestId('seat-in-vise-hold-face'), { target: { value: 'pz' } })
    fireEvent.change(screen.getByTestId('seat-in-vise-part-face'), { target: { value: 'nz' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))
    expect(screen.getByTestId('seat-in-vise-close').textContent).toMatch(/Close/)
    fireEvent.click(screen.getByTestId('seat-in-vise-close'))
    expect(useSeatInViseUi.getState().open).toBe(false)
  })

  it('an impossible second pick (parallel to the first contact) shows the refused-state border and text, and does not move the vise further', () => {
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })
    render(<SeatInViseStrip />)
    fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: 'part' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))
    const seatedAfterFirst = { ...viseOf().position }

    // Second pick reuses an X-normal face on both sides - parallel to the
    // jaw contact, so no slide can close it (workholdingSeat.ts's own refusal).
    fireEvent.change(screen.getByTestId('seat-in-vise-hold-face'), { target: { value: 'px' } })
    fireEvent.change(screen.getByTestId('seat-in-vise-part-face'), { target: { value: 'px' } })
    fireEvent.click(screen.getByTestId('seat-in-vise-run'))

    expect(screen.getByTestId('seat-in-vise-error').textContent).toMatch(/parallel/)
    expect(screen.getByTestId('seat-in-vise-strip').className).toMatch(/seat-in-vise-strip--refusal/)
    expect(viseOf().position).toEqual(seatedAfterFirst)
  })
})

// ---- the viewport stays mounted and visible while the strip is open -------
//
// Same scene/WebGL seam Viewport.tsx's own recipes fake in
// src/tests/ui/overlayRuntimeCensus.test.tsx: only CNCViewport (it constructs
// a real WebGLRenderer) and THREE.WebGLRenderer itself are stubbed. Every
// other component in the tree, including SeatInViseStrip, mounts real.
vi.mock('../../lib/viewport/CNCViewport', async () => {
  class CNCViewport {
    referenceImageHost = vi.fn(() => ({ runtime: createFakeSceneRuntime(), canvas: document.createElement('canvas') }))
    setSketchOverlayHost = vi.fn(); setSketchMenuPort = vi.fn(); setSketchUndoSink = vi.fn()
    setSketchDocumentPort = vi.fn(); applyNavPreset = vi.fn(); setCameraChangeHandler = vi.fn()
    restoreCameraState = vi.fn(); markCameraUserPositioned = vi.fn(); rebuildStock = vi.fn()
    dispose = vi.fn(); updateSketch = vi.fn(); setSketchEditingLayer = vi.fn()
    enterSketchView = vi.fn(); exitSketchView = vi.fn(); setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn(); setToolpathVisible = vi.fn(); setGridVisible = vi.fn()
    setAxesVisible = vi.fn(); setSeedOutlineVisible = vi.fn(); setMachineVisible = vi.fn()
    setShadingMode = vi.fn(); setSectionView = vi.fn(); renderToolpath = vi.fn()
    setHiddenToolpathRoles = vi.fn(); updateHeightPlanes = vi.fn(); setWCSOrigin = vi.fn()
    setBrepPickMode = vi.fn(); partPointToScreen = vi.fn(); setPartTransform = vi.fn()
    setMoveSelectCallback = vi.fn()
    clearPartLoopsOnFacePlane = vi.fn(); setPartProjectedLoops = vi.fn(); saveCameraState = vi.fn()
    clearScene = vi.fn(); setGridSpacing = vi.fn(); setMachineTravel = vi.fn()
    showCarvedStock = vi.fn(); clearCarvedStock = vi.fn()
    initStockSim = vi.fn(() => ({ x0: 0, y0: 0, nx: 8, ny: 8, cellSize: 1, stockTop: 8, stockBot: 0 }))
    disposeStockSim = vi.fn()
    suspendRender = vi.fn(); resumeRender = vi.fn()
    showToolMarker = vi.fn(); setToolMarkerPosition = vi.fn()
    setActiveToolpathSegment = vi.fn(); fitAll = vi.fn()
    setSetupSupportPlane = vi.fn(); setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    setContourTabMarkers = vi.fn()
  }
  return typedMock<typeof import('../../lib/viewport/CNCViewport')>({
    CNCViewport: CNCViewport as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
  })
})
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class WebGLRenderer {
    setSize(): void {}
    setPixelRatio(): void {}
    render(): void {}
    dispose(): void {}
  }
  return typedMock<typeof import('three')>({ ...actual, WebGLRenderer: WebGLRenderer as unknown as typeof actual.WebGLRenderer })
})

describe('WO-1586: the viewport element stays mounted while the strip is open', () => {
  it('the strip renders alongside the live viewport canvas, no modal-backdrop anywhere', async () => {
    const restoreCanvas2d = stubCanvas2d()
    const { Viewport } = await import('../../components/viewport/Viewport')
    render(<Viewport />)
    // beforeEach already seeded PART + VISE (marked workholding) into the store.
    act(() => { useSeatInViseUi.getState().openSeatInVise('vise') })

    expect(document.querySelector('.viewport-canvas')).not.toBeNull()
    expect(screen.getByTestId('seat-in-vise-strip')).toBeTruthy()
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    restoreCanvas2d()
  })
})
