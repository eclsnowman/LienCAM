// @vitest-environment jsdom
//
// WO-1591 (mating S1): a fixed stock is seated on the workholding.
//
// Driven through the product's own code end to end:
//   - the FACE PICKS come out of the real CNCViewport seat-face-pick mode,
//     clustered off the real stock box `buildStockBox` draws (the only harness
//     lines are the camera and the `fixedStockBoxes` registration `rebuildStock`
//     itself does - the box, its triangles and its `movable` tag are product);
//   - the SEAT runs in the live `SeatInViseStrip`, fed those picks through the
//     same `enterSeatFacePickMode` callback the viewport hands it;
//   - the WRITE is the real store's `updateFixedStock`.
//
// What it proves, in the order's own words: the stock's bottom lands on the
// vise floor within 0.001 mm, its size is untouched, the part does not ride,
// a `stock_corner` work origin does not move the program relative to the
// part, undo is ONE step, and locking the stock makes the same pick pair move
// the vise instead.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set() - same shim the sibling strip tests use.
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
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { FixedStockItem, ImportedGeometry, Setup, Vec3, WCS } from '../../types'

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

const TOL = 0.001  // mm, the order's own tolerance

// ── The scene ──────────────────────────────────────────────────────────────
//
//        z
//        ^        +-------------------------+  145
//        |        |   STOCK 100 x 50 x 25   |        bottom at z = 120
//        |        +-------------------------+  120
//        |
//        |   +-----------------------------------+  50   <- the VISE FLOOR
//        |   |        Kurt vise 100 x 80 x 50    |
//        +---+-----------------------------------+--> x  0
//
// Seat the stock bottom on the vise floor: the stock drops 70 mm, nothing else
// moves at all.
const VISE_ID = 'vise'
const STOCK_ID = 'stock-1'
const PART_ID = 'part'

const VISE_W = 100, VISE_H = 80, VISE_D = 50
const STOCK_W = 100, STOCK_H = 50, STOCK_D = 25
const STOCK_POS_0: Vec3 = { x: 0, y: 0, z: 120 }
const PART_POS: Vec3 = { x: 10, y: 10, z: 125 }
const FLOOR_Z = VISE_D            // 50 - the vise's top face
const SEATED_Z = FLOOR_Z          // where the stock's bottom (and so its stored min corner) lands

function geo(
  id: string, name: string, min: Vec3, max: Vec3, position: Vec3,
): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { ...min }, max: { ...max },
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position: { ...position }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as ImportedGeometry
}

const VISE = geo(VISE_ID, 'Kurt vise', { x: 0, y: 0, z: 0 }, { x: VISE_W, y: VISE_H, z: VISE_D }, { x: 0, y: 0, z: 0 })
const PART = geo(PART_ID, 'Bracket', { x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 20 }, PART_POS)

function stockItem(): FixedStockItem {
  return { id: STOCK_ID, name: 'Stock 1', width: STOCK_W, height: STOCK_H, depth: STOCK_D, position: { ...STOCK_POS_0 } }
}

// A G55 zero pinned to the stock's front-left TOP corner (row 2, col 0), the
// case review 4.3 says the slice must prove: it must not walk off the part
// because a fixture was seated.
const CORNER_ORIGIN_0: Vec3 = { x: STOCK_POS_0.x, y: STOCK_POS_0.y, z: STOCK_POS_0.z + STOCK_D }
function cornerSetup(): Setup {
  const wcs = {
    id: 'wcs-corner', label: 'G55', fixtureOffset: 55,
    origin: { ...CORNER_ORIGIN_0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
    originBinding: { kind: 'stock_corner', stockId: STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
  } as unknown as WCS
  return {
    id: 'corner-setup', name: 'Setup 1', wcs,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: [], notes: '',
  }
}

function installScene(): void {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().addGeometry(PART)
    useCamStore.getState().addGeometry(VISE)
    useCamStore.getState().setGeometryWorkholding(VISE_ID, true)
    useCamStore.getState().addFixedStock(stockItem())
  })
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, setups: [cornerSetup()], activeSetupId: 'corner-setup' } }))
  })
}

const stockOf = () => useCamStore.getState().project.sceneStock.fixedStocks!.find((fs) => fs.id === STOCK_ID)!
const viseOf = () => useCamStore.getState().project.geometry.find((g) => g.id === VISE_ID)!
const partOf = () => useCamStore.getState().project.geometry.find((g) => g.id === PART_ID)!
const originOf = () => useCamStore.getState().project.setups.find((s) => s.id === 'corner-setup')!.wcs.origin

// ── The real face picks ────────────────────────────────────────────────────
//
// One prototype-built CNCViewport per pick, because the two faces face
// opposite ways: the vise floor (+Z) is only visible from above and the stock
// bottom (-Z) only from below. Hovering the exact centre of an orthographic
// view aimed at the face's own centre is NDC (0, 0), so no screen-space
// arithmetic enters the test - and the front-facing filter in
// `updateFaceOverlayHover` is what rejects the far side of the same box.

interface PickHarness {
  updateFaceOverlayHover: (mx: number, my: number) => void
  commitSeatFacePickAtHover: () => void
  canPickFacesFor: (id: string) => boolean
  enterSeatFacePickMode: (
    ids: readonly string[], onPick: (p: SeatFacePick) => void,
    onHover?: ((p: SeatFacePick | null) => void) | null,
  ) => void
  buildStockBox: (
    stock: { width: number; height: number; depth: number },
    origin: THREE.Vector3, stockId: string, movable: boolean,
  ) => THREE.Group
  fixedStockBoxes: Map<string, THREE.Group>
  faceOverlays: Array<{ geoId?: string; isStock?: boolean; normal: THREE.Vector3 }>
}

function harness(lookFrom: Vec3, lookAt: Vec3): { vp: CNCViewportInstance; priv: PickHarness } {
  const vp = Object.create(CNCViewport.prototype) as CNCViewportInstance
  const camera = new THREE.OrthographicCamera(-200, 200, 200, -200, 0.1, 5000)
  camera.position.set(lookFrom.x, lookFrom.y, lookFrom.z)
  camera.up.set(0, 1, 0)
  camera.lookAt(lookAt.x, lookAt.y, lookAt.z)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)

  // The vise body: one box mesh, occupying its bounding box in world space.
  const viseMesh = new THREE.Mesh(new THREE.BoxGeometry(VISE_W, VISE_H, VISE_D), new THREE.MeshBasicMaterial())
  viseMesh.geometry.translate(VISE_W / 2, VISE_H / 2, VISE_D / 2)
  const viseGroup = new THREE.Group()
  viseGroup.add(viseMesh)

  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>([[VISE_ID, viseGroup]]),
    fixedStockBoxes: new Map<string, THREE.Group>(),
    stockGroup: new THREE.Group(),
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
    renderer: { domElement: { style: {}, addEventListener: () => undefined, removeEventListener: () => undefined } },
  })
  const priv = vp as unknown as PickHarness
  // The two lines `rebuildStock` runs for a fixed stock: the PRODUCT builds the
  // box (geometry, materials and the `kind:'stock' / movable` tag), and the
  // id -> box map is what every stock lookup in the viewport resolves through.
  const box = priv.buildStockBox(
    { width: STOCK_W, height: STOCK_H, depth: STOCK_D },
    new THREE.Vector3(STOCK_POS_0.x, STOCK_POS_0.y, STOCK_POS_0.z), STOCK_ID, true,
  )
  priv.fixedStockBoxes.set(STOCK_ID, box)
  return { vp, priv }
}

/** The vise's top face - "the vise floor" - picked from above. */
function viseFloorPick(): SeatFacePick {
  const { priv } = harness({ x: VISE_W / 2, y: VISE_H / 2, z: 900 }, { x: VISE_W / 2, y: VISE_H / 2, z: 0 })
  const picks: SeatFacePick[] = []
  priv.enterSeatFacePickMode([VISE_ID], (p) => picks.push(p))
  priv.updateFaceOverlayHover(0, 0)
  priv.commitSeatFacePickAtHover()
  return picks[0]
}

/** The stock's bottom face, picked from below. */
function stockBottomPick(): { pick: SeatFacePick; priv: PickHarness } {
  const { priv } = harness({ x: STOCK_W / 2, y: STOCK_H / 2, z: -900 }, { x: STOCK_W / 2, y: STOCK_H / 2, z: 0 })
  const picks: SeatFacePick[] = []
  priv.enterSeatFacePickMode([STOCK_ID], (p) => picks.push(p))
  priv.updateFaceOverlayHover(0, 0)
  priv.commitSeatFacePickAtHover()
  return { pick: picks[0], priv }
}

// ── The strip, fed the real picks ──────────────────────────────────────────

/** Mounts the live strip with a viewport stub that only relays picks - the
 *  pick PAYLOADS are the product's, computed above. Returns the callback the
 *  strip registered, which is the same one the real viewport would call. */
function openStripOnStock(): {
  fire: (p: SeatFacePick) => void
  rebuildStock: ReturnType<typeof vi.fn>
} {
  let onPick: ((p: SeatFacePick) => void) | null = null
  const rebuildStock = vi.fn()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartTransform: vi.fn(),
    rebuildStock,
    canPickFacesFor: (id: string) => id === VISE_ID || id === STOCK_ID,
    enterSeatFacePickMode: (_ids: readonly string[], cb: (p: SeatFacePick) => void) => { onPick = cb },
    exitSeatFacePickMode: vi.fn(),
  }
  act(() => { useSeatInViseUi.getState().openSeatInVise(VISE_ID) })
  render(createElement(SeatInViseStrip))
  act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: STOCK_ID } }) })
  return { fire: (p) => act(() => { onPick?.(p) }), rebuildStock }
}

beforeEach(() => {
  installScene()
  act(() => { useSeatInViseUi.getState().closeSeatInVise() })
})

afterEach(() => { delete (window as unknown as Record<string, unknown>).__cncViewport })

describe('WO-1591: a fixed stock box is pickable in the viewport', () => {
  it('its six faces cluster and report the stock id, and the bottom face picks from below', () => {
    const { pick, priv } = stockBottomPick()
    expect(priv.canPickFacesFor(STOCK_ID)).toBe(true)

    // Six faces, every one tagged with the stock, none of them the fat
    // wireframe's template quad masquerading as a surface.
    const faces = priv.faceOverlays
    expect(faces.length).toBe(6)
    expect(new Set(faces.map((f) => f.geoId))).toEqual(new Set([STOCK_ID]))
    expect(faces.every((f) => f.isStock === true)).toBe(true)

    expect(pick.geoId).toBe(STOCK_ID)
    expect(pick.normal.z).toBeCloseTo(-1, 6)
    expect(pick.point.z).toBeCloseTo(STOCK_POS_0.z, 6)
    expect(pick.point.x).toBeCloseTo(STOCK_W / 2, 6)
    expect(pick.point.y).toBeCloseTo(STOCK_H / 2, 6)
  })

  it('a body face still picks exactly as it did - the vise floor is its top face', () => {
    const floor = viseFloorPick()
    expect(floor.geoId).toBe(VISE_ID)
    expect(floor.normal.z).toBeCloseTo(1, 6)
    expect(floor.point.z).toBeCloseTo(FLOOR_Z, 6)
  })
})

describe('WO-1591: the vise floor then the stock bottom seats the STOCK', () => {
  it('lands the stock bottom on the floor, moves nothing else, and undoes in one step', () => {
    const floor = viseFloorPick()
    const bottom = stockBottomPick().pick
    const { fire, rebuildStock } = openStripOnStock()

    // The strip says which body is about to move BEFORE anything commits.
    expect(screen.getByTestId('seat-in-vise-mover').textContent).toBe('Stock 1 moves to Kurt vise.')

    fire(floor)
    expect(screen.getByTestId('seat-in-vise-pending').textContent).toMatch(/Kurt vise face picked/)
    fire(bottom)

    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()

    // 1. The stock's bottom IS the vise floor.
    expect(Math.abs(stockOf().position.z - SEATED_Z)).toBeLessThan(TOL)
    // ...and only that: a plane contact spends no lateral position.
    expect(stockOf().position.x).toBeCloseTo(STOCK_POS_0.x, 6)
    expect(stockOf().position.y).toBeCloseTo(STOCK_POS_0.y, 6)

    // 2. A mate answers where, never how big.
    expect(stockOf().width).toBe(STOCK_W)
    expect(stockOf().height).toBe(STOCK_H)
    expect(stockOf().depth).toBe(STOCK_D)

    // 3. The part did not ride the stock, and neither did the vise.
    expect(partOf().position).toEqual(PART_POS)
    expect(partOf().rotation).toEqual({ x: 0, y: 0, z: 0 })
    expect(viseOf().position).toEqual({ x: 0, y: 0, z: 0 })
    expect(viseOf().rotation).toEqual({ x: 0, y: 0, z: 0 })

    // 4. The stock_corner zero did not move, so the program did not move
    //    relative to the part that did not move either.
    expect(originOf()).toEqual(CORNER_ORIGIN_0)

    // 5. The console names what moved and what deliberately did not.
    const line = useCamStore.getState().consoleEvents.map((e) => e.message).find((m) => m.includes('Stock 1'))
    expect(line).toBeTruthy()
    expect(line).toMatch(/Bracket/)
    expect(line).toMatch(/G55 origin/)
    expect(line).toMatch(/did not move/)

    // The box on screen followed the write.
    expect(rebuildStock).toHaveBeenCalled()

    // 6. ONE undo step puts it back.
    act(() => { useCamStore.getState().undo() })
    expect(stockOf().position).toEqual(STOCK_POS_0)
  })
})

describe('WO-1591: the lock is read before pick order', () => {
  it('with the stock locked the same pick pair brings the VISE to the stock instead', () => {
    act(() => { useCamStore.getState().setFixedStockLocked(STOCK_ID, true) })

    const floor = viseFloorPick()
    const bottom = stockBottomPick().pick
    const { fire } = openStripOnStock()

    expect(screen.getByTestId('seat-in-vise-mover').textContent).toBe('Kurt vise moves to Stock 1.')

    fire(floor)
    fire(bottom)

    expect(screen.queryByTestId('seat-in-vise-error')).toBeNull()
    // The vise rose 70 mm so its floor meets the locked stock's bottom...
    expect(Math.abs(viseOf().position.z - (STOCK_POS_0.z - FLOOR_Z))).toBeLessThan(TOL)
    // ...and the locked stock did not move at all.
    expect(stockOf().position).toEqual(STOCK_POS_0)
    expect(partOf().position).toEqual(PART_POS)
  })

  it('with BOTH locked nothing moves and the strip names the two locks', () => {
    act(() => {
      useCamStore.getState().setFixedStockLocked(STOCK_ID, true)
      useCamStore.getState().setGeometryLocked(VISE_ID, true)
    })
    const floor = viseFloorPick()
    const bottom = stockBottomPick().pick
    const { fire } = openStripOnStock()

    expect(screen.getByTestId('seat-in-vise-mover').textContent)
      .toMatch(/Kurt vise and Stock 1 are both locked.*Unlock one/)

    fire(floor)
    fire(bottom)

    expect(stockOf().position).toEqual(STOCK_POS_0)
    expect(viseOf().position).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('WO-1591: an AUTO stock is named, never refused and never silently converted', () => {
  it('says it sizes itself to its parts and offers a fixed stock the same size', () => {
    // A project whose only stock is the default AUTO stock, sized to the part.
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.getState().addGeometry(PART)
      useCamStore.getState().addGeometry(VISE)
      useCamStore.getState().setGeometryWorkholding(VISE_ID, true)
    })
    const autoStocks = useCamStore.getState().project.sceneStock.autoStocks ?? []
    expect(autoStocks.length).toBeGreaterThan(0)
    const auto = autoStocks[0]
    const twin = (useCamStore.getState().project.stocks ?? []).find((ps) => ps.id === auto.id)!

    ;(window as unknown as Record<string, unknown>).__cncViewport = { rebuildStock: vi.fn() }
    act(() => { useSeatInViseUi.getState().openSeatInVise(VISE_ID) })
    render(createElement(SeatInViseStrip))
    act(() => { fireEvent.change(screen.getByTestId('seat-in-vise-part'), { target: { value: auto.id } }) })

    // Named, not hidden; stated, not refused.
    expect(screen.getByTestId('seat-in-vise-auto-stock').textContent)
      .toMatch(/sizes itself to the parts assigned to it/)
    expect(screen.queryByTestId('seat-in-vise-run')).toBeNull()

    act(() => { fireEvent.click(screen.getByTestId('seat-in-vise-make-fixed')) })

    const fixed = useCamStore.getState().project.sceneStock.fixedStocks ?? []
    expect(fixed.length).toBe(1)
    expect(fixed[0].width).toBeCloseTo(twin.bounds.max.x - twin.bounds.min.x, 6)
    expect(fixed[0].height).toBeCloseTo(twin.bounds.max.y - twin.bounds.min.y, 6)
    expect(fixed[0].depth).toBeCloseTo(twin.bounds.max.z - twin.bounds.min.z, 6)
    expect(fixed[0].position.z).toBeCloseTo(twin.bounds.min.z, 6)
    // Nothing was silently converted: the auto stock is still there.
    expect((useCamStore.getState().project.sceneStock.autoStocks ?? []).some((a) => a.id === auto.id)).toBe(true)
    // ...and the strip is now pointed at the fixed stock, ready to seat.
    expect((screen.getByTestId('seat-in-vise-part') as HTMLSelectElement).value).toBe(fixed[0].id)
  })
})
