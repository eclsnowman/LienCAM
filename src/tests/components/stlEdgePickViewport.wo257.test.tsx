// @vitest-environment jsdom

// WO-257: an STL edge can be picked in the viewport, like a STEP edge.
//
// WO-251 landed the click path (materialised chains enter `closedLoops`, so the
// existing loop renderer picks them up). This file covers the three things the
// architect's 2026-08-12T05:41Z ruling narrowed this order to:
//
//   1. hover HIGHLIGHT of the chain under the cursor - proven against the REAL
//      CNCViewport, not a mock, because a mock cannot show that an STL chain
//      line is reachable by the hover raycast at all;
//   2. the two selection surfaces agreeing in BOTH directions;
//   3. click-again-to-deselect behaving the same from either surface.

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ImportedGeometry, Loop2D, Project, Setup } from '../../types'

const stlCache = vi.hoisted(() => ({ load: vi.fn<() => Promise<ArrayBuffer | null>>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: stlCache.load,
  cacheSTL: vi.fn(async () => {}),
  removeCachedSTL: vi.fn(async () => {}),
}))

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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { resolveOpGeometrySources, useCamStore } = await import('../../store')

const GEO_ID = 'wo257-operator-plate'
const SETUP_ID = 'wo257-setup'
const TOOL_ID = 'wo257-tool'

// ── Part 1 harness: the real CNCViewport, no WebGL ──────────────────────────
// Same shape as CNCViewportModelEdgePick.wo113.test.ts: build the instance off
// the prototype and supply exactly the fields the loop-pick path touches, so
// the code under test is production's, not a re-implementation.

interface HoverHarness {
  raycaster: THREE.Raycaster
  loopPickHoverId: string | null
  pickedLoopIds: Set<string>
  updateLoopPickHover: (event: MouseEvent) => void
}

function priv(viewport: CNCViewport): HoverHarness {
  return viewport as unknown as HoverHarness
}

const CANVAS_W = 800
const CANVAS_H = 600
const FRUSTUM = 100   // camera spans -50..50 in x and y

/** Turn a world XY point into the client coords that aim the ray at it. */
function clientAt(x: number, y: number): { clientX: number; clientY: number } {
  return {
    clientX: ((x / (FRUSTUM / 2)) + 1) / 2 * CANVAS_W,
    clientY: (1 - (y / (FRUSTUM / 2))) / 2 * CANVAS_H,
  }
}

function hoverEvent(x: number, y: number): MouseEvent {
  return clientAt(x, y) as unknown as MouseEvent
}

function square(cx: number, cy: number, half: number): Array<{ x: number; y: number }> {
  return [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ]
}

interface HoverFixture {
  viewport: CNCViewport
  listeners: Array<{ type: string; fn: unknown }>
  domStyle: { cursor: string }
  lineFor: (loopId: string) => THREE.Line
  origColorOf: (loopId: string) => number
}

function makeHoverFixture(): HoverFixture {
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  camera.position.set(0, 0, 100)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()

  const listeners: Array<{ type: string; fn: unknown }> = []
  const domStyle = { cursor: '' }
  const scene = new THREE.Group()

  Object.assign(viewport, {
    scene,
    partGroups: new Map<string, THREE.Group>(),
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    nestGroups: new Map<string, THREE.Group>(),
    fixedStockBoxes: new Map<string, THREE.Group>(),
    selectableObjects: [] as THREE.Object3D[],
    camera,
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    viewportThemeId: 'classic',
    selectionGlow: 'current' as const,
    loopPickCallback: null,
    loopPickAllowedGeoId: null,
    pickedLoopIds: new Set<string>(),
    loopPickHoverId: null,
    // Class fields are instance properties, so a prototype-built instance has
    // no bound hover handler. setLoopPickMode only registers/unregisters it;
    // the behaviour under test is updateLoopPickHover, driven directly below.
    handleLoopPickHoverMove: () => undefined,
    renderer: {
      domElement: {
        style: domStyle,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H }),
        addEventListener: (type: string, fn: unknown) => { listeners.push({ type, fn }) },
        removeEventListener: (type: string, fn: unknown) => {
          const at = listeners.findIndex((l) => l.type === type && l.fn === fn)
          if (at >= 0) listeners.splice(at, 1)
        },
      },
    },
  })

  // A part group named by its geoId, exactly as addSTLModel names it - the
  // loop-pick geo gate resolves a `__proj__` line through its grandparent name.
  const partGroup = new THREE.Group()
  partGroup.name = GEO_ID
  scene.add(partGroup)
  ;(viewport as unknown as { partGroups: Map<string, THREE.Group> }).partGroups.set(GEO_ID, partGroup)

  const lineFor = (loopId: string): THREE.Line => {
    let found: THREE.Line | null = null
    partGroup.traverse((child) => {
      if (child instanceof THREE.Line && child.name === loopId) found = child
    })
    if (!found) throw new Error(`no rendered loop line named "${loopId}"`)
    return found
  }

  return {
    viewport,
    listeners,
    domStyle,
    lineFor,
    origColorOf: (loopId) =>
      ((lineFor(loopId).material as THREE.LineBasicMaterial).userData.origColor as number),
  }
}

// The two chains sit far apart so a hover is never ambiguous: the ray is cast
// at each one's centre and the interior fallback resolves the pierced loop.
const CHAIN_A = 'mec:wo257-chain-a'
const CHAIN_B = 'mec:wo257-chain-b'
// A real plate's hole contributes a chain at the top face AND one at the
// bottom - identical in XY. setPartProjectedLoops draws every chain at Z2D, so
// that pair lands exactly on top of itself.
const CHAIN_A_TWIN = 'mec:wo257-chain-a-twin'
const CHAIN_LAYER = 'stl-edge-chains'

function renderTwoChains(fixture: HoverFixture, withTwin = false): void {
  fixture.viewport.setPartProjectedLoops(
    GEO_ID,
    [
      { id: CHAIN_A, points: square(-20, 0, 5), closed: true, layerId: CHAIN_LAYER },
      ...(withTwin
        ? [{ id: CHAIN_A_TWIN, points: square(-20, 0, 5), closed: true, layerId: CHAIN_LAYER }]
        : []),
      { id: CHAIN_B, points: square(20, 0, 5), closed: true, layerId: CHAIN_LAYER },
    ],
    [{ id: CHAIN_LAYER, color: '#58a6ff', visible: true }],
  )
}

// ── Part 2 harness: a faithful stand-in for the viewport's click semantics ──
// Mirrors CNCViewport.handleClick's loop-pick branch (CNCViewport.ts:5351-5359)
// and setLoopPickMode/setPickedLoops, so a "click" in these tests toggles
// against the same picked set the real viewport keeps.

class FakeLoopPickViewport {
  pickedLoopIds = new Set<string>()
  callback: ((loopId: string, nowSelected: boolean) => void) | null = null
  allowedGeoId: string | null = null

  setLoopPickMode = (
    callback: ((loopId: string, nowSelected: boolean) => void) | null,
    allowedGeoId: string | null = null,
  ) => {
    this.callback = callback
    this.allowedGeoId = allowedGeoId
    if (!callback) this.pickedLoopIds.clear()
  }

  setPickedLoops = (loopIds: string[]) => { this.pickedLoopIds = new Set(loopIds) }

  /** One click in the 3D view on the loop line named `loopId`. */
  clickLoop(loopId: string): void {
    if (!this.callback) throw new Error('viewport is not in loop-pick mode')
    const nowSelected = !this.pickedLoopIds.has(loopId)
    if (nowSelected) this.pickedLoopIds.add(loopId)
    else this.pickedLoopIds.delete(loopId)
    this.callback(loopId, nowSelected)
  }

  selected(): string[] { return [...this.pickedLoopIds] }
}

function installFakeViewport(): FakeLoopPickViewport {
  const vp = new FakeLoopPickViewport()
  ;(window as unknown as Record<string, unknown>).__cncViewport = vp
  return vp
}

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// Commit 2e5678b7 (Smart Height V2 cutover): Smart Height's stock proof reads
// only project.stocks + a proven wcs.stockId (setupProvenStockId /
// smartHeightStockBounds) - the legacy inline setup.stock spec is not
// consulted. A real (unstubbed) Contour preflight needs a PhysicalStock the
// geometry itself names too.
const STOCK_ID = 'wo257-stock'
const stock = {
  id: STOCK_ID,
  name: 'WO-257 Stock',
  mode: 'explicit',
  bounds: {
    min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 6 },
    size: { x: 60, y: 60, z: 6 }, center: { x: 0, y: 0, z: 3 },
  },
  position: { x: 0, y: 0, z: 0 },
}

function seedProject(): void {
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID,
    name: 'Operator plate STL',
    filename: 'obj_1_Platte C.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    stockId: STOCK_ID,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -27, y: -27, z: 0 },
      max: { x: 27, y: 27, z: 4 },
      size: { x: 54, y: 54, z: 4 },
      center: { x: 0, y: 0, z: 2 },
    },
  }]
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: {
      type: 'rectangular',
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [],
    notes: '',
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [{
      id: TOOL_ID, name: 'WO-257 6mm Flat', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
    project: {
      ...current.project,
      geometry,
      setups: [setup],
      stocks: [stock],
      activeSetupId: SETUP_ID,
    },
  } as never)
}

async function reloadProject(project: Project): Promise<void> {
  const projectText = JSON.stringify(project)
  act(() => { useCamStore.getState().newProject() })
  await act(async () => {
    const store = useCamStore.getState()
    const requestId = store.beginProjectOpen()
    await store.loadProjectFromFile(projectText, requestId)
  })
}

/** A flat STL edge chain has no physical floor, so the default contour end
 * condition refuses at the Smart Height V2 preflight; pick an explicit one.
 * Mirrors stlContourPick.wo251.test.tsx's helper of the same purpose. */
async function confirmExplicitContourDepth(): Promise<void> {
  fireEvent.click(screen.getByText('Heights'))
  fireEvent.change(screen.getByTestId('contour-height-mode'), {
    target: { value: 'explicit_depth' },
  })
  await waitFor(() => {
    const refusal = screen.queryByTestId('resolved-height-refusal')
    if (refusal) throw new Error(refusal.textContent ?? 'Contour height preflight refused')
    expect(screen.getByTestId('resolved-height-plan')).toBeTruthy()
  })
  fireEvent.click(screen.getByText('Geometry'))
}

/** The chain list the Contour dialog renders, in the order it renders it. */
function contourChains(): Loop2D[] {
  const [source] = resolveOpGeometrySources(useCamStore.getState().project.geometry, GEO_ID, 'contour_2d')
  return (source.loops ?? []).filter((loop) => loop.closed)
}

/** Open the dialog on the STL with its chains materialised and listed. */
async function openContourOnStl(): Promise<void> {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('WO-257 6mm Flat'))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
  await waitFor(() => {
    expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
  })
}

/** The list row for a chain, located by the name the row actually renders. */
function listRowFor(chain: Loop2D): { checkbox: HTMLInputElement; checked: boolean } {
  const rows = Array.from(document.querySelectorAll('.op-loop-check'))
  const chains = contourChains()
  const index = chains.findIndex((candidate) => candidate.id === chain.id)
  if (index < 0) throw new Error(`chain ${chain.id} is not offered in the Contour list`)
  const row = rows[index]
  if (!row) throw new Error(`no list row rendered at index ${index} for chain ${chain.id}`)
  // Guard the index mapping: the row must actually name this chain, so a future
  // reordering fails here loudly instead of silently asserting the wrong row.
  expect(row.textContent ?? '').toContain(chain.name ?? '')
  const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement
  return { checkbox, checked: checkbox.checked }
}

function selectedInModal(): string[] {
  const operation = useCamStore.getState().project.setups[0].operations[0]
  return (operation.params as { loopIds: string[] }).loopIds
}

beforeEach(() => {
  // These specs drive NewOperationModalBody's create path, which reaches
  // computeOperationToolpath -> new Worker(...). jsdom has no Worker, so the
  // rejection surfaced as an unhandled error and made vitest exit 1 even with
  // every test green - which is enough to make a full-suite sweep unusable as a
  // gate. Same stub the other NewOperationModal specs use.
  vi.stubGlobal('Worker', class {
    onmessage: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    postMessage(): void { /* no-op */ }
    terminate(): void { /* no-op */ }
  })

  act(() => { useCamStore.getState().newProject() })
  stlCache.load.mockReset()
  stlCache.load.mockResolvedValue(fixtureBuffer())
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-257: hovering an STL edge chain highlights it in the 3D view', () => {
  it('renders STL chains into the real viewport raycast set under their chain ids', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture)

    // The chain lines carry their WO-244 stable ids as the THREE object names -
    // that is what makes a viewport hit resolvable back to a chain.
    expect(fixture.lineFor(CHAIN_A).name).toBe(CHAIN_A)
    expect(fixture.lineFor(CHAIN_B).name).toBe(CHAIN_B)

    const selectable = (fixture.viewport as unknown as { selectableObjects: THREE.Object3D[] })
      .selectableObjects
    expect(selectable.map((object) => object.name)).toEqual(
      expect.arrayContaining([CHAIN_A, CHAIN_B]),
    )
  })

  it('highlights the chain under the cursor and restores it when the cursor leaves', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture)
    const origA = fixture.origColorOf(CHAIN_A)
    const origB = fixture.origColorOf(CHAIN_B)

    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    // Entering pick mode must arm hover tracking, or nothing below could fire
    // from a real mouse.
    expect(fixture.listeners.filter((l) => l.type === 'mousemove')).toHaveLength(1)
    expect(fixture.domStyle.cursor).toBe('crosshair')

    act(() => { priv(fixture.viewport).updateLoopPickHover(hoverEvent(-20, 0)) })
    expect(priv(fixture.viewport).loopPickHoverId).toBe(CHAIN_A)
    const hoverColor = (fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex()
    expect(hoverColor).not.toBe(origA)
    // Only the chain under the cursor changes. Nothing else in the scene moves.
    expect((fixture.lineFor(CHAIN_B).material as THREE.LineBasicMaterial).color.getHex()).toBe(origB)
    // The cursor tells the machinist the chain is clickable before he clicks.
    expect(fixture.domStyle.cursor).toBe('pointer')

    // Moving to the other chain hands the highlight over, it does not accumulate.
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(20, 0))
    expect(priv(fixture.viewport).loopPickHoverId).toBe(CHAIN_B)
    expect((fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex()).toBe(origA)
    expect((fixture.lineFor(CHAIN_B).material as THREE.LineBasicMaterial).color.getHex()).toBe(hoverColor)

    // Off both chains: highlight gone, colours back to the layer's own.
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(0, 40))
    expect(priv(fixture.viewport).loopPickHoverId).toBeNull()
    expect((fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex()).toBe(origA)
    expect((fixture.lineFor(CHAIN_B).material as THREE.LineBasicMaterial).color.getHex()).toBe(origB)
    expect(fixture.domStyle.cursor).toBe('crosshair')
  })

  it('keeps a selected chain reading as selected while the cursor is over it', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture)
    const origA = fixture.origColorOf(CHAIN_A)

    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(-20, 0))
    const hoverColor = (fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex()

    fixture.viewport.setPickedLoops([CHAIN_A])
    const selectedColor = (fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex()
    expect(selectedColor).not.toBe(hoverColor)
    expect(selectedColor).not.toBe(origA)
  })

  it('does not highlight a chain that belongs to a different part', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture)

    fixture.viewport.setLoopPickMode(() => {}, 'some-other-part')
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(-20, 0))

    expect(priv(fixture.viewport).loopPickHoverId).toBeNull()
    expect((fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex())
      .toBe(fixture.origColorOf(CHAIN_A))
  })

  it('draws the highlighted chain over the chain it is coincident with', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture, true)
    const lineA = fixture.lineFor(CHAIN_A)
    const twin = fixture.lineFor(CHAIN_A_TWIN)
    const restingOrder = lineA.renderOrder
    expect(twin.renderOrder).toBe(restingOrder)

    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(-20, 0))
    const hoverId = priv(fixture.viewport).loopPickHoverId
    expect([CHAIN_A, CHAIN_A_TWIN]).toContain(hoverId)

    // At equal depth the LAST line drawn wins, so recolouring alone leaves the
    // highlight hidden under its twin. The highlighted line must draw later.
    const hovered = fixture.lineFor(hoverId as string)
    const covered = fixture.lineFor(hoverId === CHAIN_A ? CHAIN_A_TWIN : CHAIN_A)
    expect(hovered.renderOrder).toBeGreaterThan(covered.renderOrder)
    // The chain nobody is pointing at keeps its resting order.
    expect(covered.renderOrder).toBe(restingOrder)
    expect(fixture.lineFor(CHAIN_B).renderOrder).toBe(restingOrder)

    // Moving off restores it - the lift is not cumulative.
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(0, 40))
    expect(fixture.lineFor(CHAIN_A).renderOrder).toBe(restingOrder)
    expect(fixture.lineFor(CHAIN_A_TWIN).renderOrder).toBe(restingOrder)
  })

  it('draws a selected chain over the chain it is coincident with', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture, true)
    const restingOrder = fixture.lineFor(CHAIN_A).renderOrder

    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    fixture.viewport.setPickedLoops([CHAIN_A])
    expect(fixture.lineFor(CHAIN_A).renderOrder).toBeGreaterThan(restingOrder)
    expect(fixture.lineFor(CHAIN_A_TWIN).renderOrder).toBe(restingOrder)

    fixture.viewport.setPickedLoops([])
    expect(fixture.lineFor(CHAIN_A).renderOrder).toBe(restingOrder)
  })

  it('stops tracking hover when pick mode ends', () => {
    const fixture = makeHoverFixture()
    renderTwoChains(fixture)

    fixture.viewport.setLoopPickMode(() => {}, GEO_ID)
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(-20, 0))
    expect(priv(fixture.viewport).loopPickHoverId).toBe(CHAIN_A)

    fixture.viewport.setLoopPickMode(null)
    expect(fixture.listeners.filter((l) => l.type === 'mousemove')).toHaveLength(0)
    expect(priv(fixture.viewport).loopPickHoverId).toBeNull()
    expect((fixture.lineFor(CHAIN_A).material as THREE.LineBasicMaterial).color.getHex())
      .toBe(fixture.origColorOf(CHAIN_A))
    // A hover event that arrives after the mode ended changes nothing.
    priv(fixture.viewport).updateLoopPickHover(hoverEvent(-20, 0))
    expect(priv(fixture.viewport).loopPickHoverId).toBeNull()
  })
})

describe('WO-257: the viewport and the list are one selection model', () => {
  it('ticks the list row for a chain picked in the viewport', async () => {
    const vp = installFakeViewport()
    await openContourOnStl()
    const chains = contourChains()
    const picked = chains[0]
    const other = chains[1]

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    act(() => { vp.clickLoop(picked.id) })

    expect(listRowFor(picked).checked).toBe(true)
    expect(listRowFor(other).checked).toBe(false)
    expect(vp.selected()).toEqual([picked.id])
  })

  it('selects in the viewport the chain ticked in the list, and keeps it through the next viewport pick', async () => {
    const vp = installFakeViewport()
    await openContourOnStl()
    const chains = contourChains()
    const fromList = chains[1]
    const fromViewport = chains[0]

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    // Start from an explicit empty selection so ticking one box means exactly
    // that one chain (an untouched dialog means "all loops", not "none").
    fireEvent.click(screen.getByTestId('op-loops-clear'))

    fireEvent.click(listRowFor(fromList).checkbox)
    // List -> viewport.
    expect(vp.selected()).toEqual([fromList.id])

    // Viewport -> list, without discarding what the list just picked. This is
    // the "one selection model, not two" clause: the pick session must not
    // recompute from a snapshot it took before the list was touched.
    act(() => { vp.clickLoop(fromViewport.id) })

    expect(vp.selected().sort()).toEqual([fromList.id, fromViewport.id].sort())
    expect(listRowFor(fromList).checked).toBe(true)
    expect(listRowFor(fromViewport).checked).toBe(true)

    // Commit 2e5678b7: a flat STL edge chain has no physical floor, so the
    // Smart Height V2 preflight refuses the default contour end condition
    // until an explicit one is chosen (mirrors stlContourPick.wo251.test.tsx's
    // confirmExplicitContourDepth). Create then stays disabled until that
    // preflight resolves.
    await confirmExplicitContourDepth()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(selectedInModal().sort()).toEqual([fromList.id, fromViewport.id].sort())
  })

  it('deselects on a second click, from either surface, leaving both in step', async () => {
    const vp = installFakeViewport()
    await openContourOnStl()
    const chains = contourChains()
    const viaViewport = chains[0]
    const viaList = chains[1]

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.click(screen.getByTestId('op-loops-clear'))

    act(() => { vp.clickLoop(viaViewport.id) })
    fireEvent.click(listRowFor(viaList).checkbox)
    expect(vp.selected().sort()).toEqual([viaList.id, viaViewport.id].sort())

    // Click the viewport-picked chain again: it goes away, the other stays.
    act(() => { vp.clickLoop(viaViewport.id) })
    expect(vp.selected()).toEqual([viaList.id])
    expect(listRowFor(viaViewport).checked).toBe(false)
    expect(listRowFor(viaList).checked).toBe(true)

    // Untick the list-picked chain: the viewport agrees, and a chain the
    // viewport picks afterwards does not resurrect it.
    fireEvent.click(listRowFor(viaList).checkbox)
    expect(vp.selected()).toEqual([])
    act(() => { vp.clickLoop(viaViewport.id) })
    expect(vp.selected()).toEqual([viaViewport.id])
    expect(listRowFor(viaList).checked).toBe(false)
  })

  it('refuses a viewport hit that is not one of this part\'s chains without disturbing the list', async () => {
    const vp = installFakeViewport()
    await openContourOnStl()
    const chains = contourChains()
    const picked = chains[0]

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.click(screen.getByTestId('op-loops-clear'))
    fireEvent.click(listRowFor(picked).checkbox)

    act(() => { vp.clickLoop('mec:not-a-chain-on-this-part') })

    // The refusal snaps the viewport back to what the list holds, rather than
    // silently adopting a foreign id.
    expect(vp.selected()).toEqual([picked.id])
    expect(listRowFor(picked).checked).toBe(true)
  })

  it('keeps a viewport-picked chain through save and reload, and refuses it by name when it is gone', async () => {
    const vp = installFakeViewport()
    await openContourOnStl()
    const picked = contourChains()[0]

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.click(screen.getByTestId('op-loops-clear'))
    act(() => { vp.clickLoop(picked.id) })
    // Commit 2e5678b7: a flat STL edge chain has no physical floor, so the
    // Smart Height V2 preflight refuses the default contour end condition
    // until an explicit one is chosen (mirrors stlContourPick.wo251.test.tsx's
    // confirmExplicitContourDepth). Create then stays disabled until that
    // preflight resolves.
    await confirmExplicitContourDepth()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    // Stored by the WO-244 stable chain id, exactly as a list pick is stored -
    // no second persistence shape for a viewport pick.
    expect(picked.id).toMatch(/^mec:/)
    expect(selectedInModal()).toEqual([picked.id])
    expect(useCamStore.getState().project.setups[0].operations[0].geometrySelections)
      .toEqual([picked.id])

    // Save/reload is the persistence question, not the picking one: drop the
    // stand-in viewport so the reload runs the ordinary no-viewport path.
    delete (window as unknown as Record<string, unknown>).__cncViewport

    await reloadProject(structuredClone(useCamStore.getState().project))
    const reloaded = useCamStore.getState().project
    expect(reloaded.geometry[0].loops?.find((loop) => loop.id === picked.id)?.id).toBe(picked.id)
    expect((reloaded.setups[0].operations[0].params as { loopIds: string[] }).loopIds)
      .toEqual([picked.id])

    // WO-251's rule, unchanged: a chain that is gone refuses loudly by name.
    const operationId = reloaded.setups[0].operations[0].id
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: state.project.geometry.map((geometry) => geometry.id === GEO_ID
            ? { ...geometry, loops: geometry.loops?.filter((loop) => loop.id !== picked.id) }
            : geometry),
        },
      }))
    })
    await reloadProject(structuredClone(useCamStore.getState().project))
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, operationId)
    const refused = useCamStore.getState().project.setups[0].operations[0]
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toContain(picked.id)
    expect(refused.errorMessage).toContain('Operator plate STL')
    expect(refused.errorMessage).toMatch(/no longer exists/i)
  })
})
