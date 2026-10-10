// @vitest-environment jsdom
//
// WO-2192 (workholding assemblies, slice 5): clamps through the RENDERED
// screens - Make clamp in the Properties panel, the placer (its controls in
// Properties; the viewport's edge-marker mode fires its clicks, drags and
// double-clicks, recorded here), the clamp's
// Properties (Duplicate, Delete, Move to setup, "edge reference lost"), the
// tree - and the viewport draw step (applyClampDrawings) Viewport runs,
// against a recording viewport. The drawn clamp must sit where the one
// resolver puts it.
//
// SCENE: a fixed stock 100 x 60 x 20 at the origin; a clamp body 30 x 10 x 8;
// a part block 40 x 20 x 10 at (200, 0, 0).
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
import type { ImportedGeometry, Vec3 } from '../../types'
import { makeWcs } from '../post/helpers'

const STL_BYTES = new ArrayBuffer(84)
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async (id: string) => (id === 'clamp-body' ? STL_BYTES : null)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { ClampPlacer, useClampUi, selectClamp } = await import('../../components/workholding/ClampEditor')
const { applyClampDrawings, clampDrawId } = await import('../../components/workholding/clampViewport')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useGlobalShortcuts } = await import('../../hooks/useGlobalShortcuts')
const { resolveInstancePlacements } = await import('../../lib/workholding/resolveWorkholding')
const { mat4ToPose } = await import('../../lib/workholding/pose')

afterEach(cleanup)

const ZERO = { x: 0, y: 0, z: 0 }

function block(id: string, name: string, size: Vec3, position: Vec3, workholding: boolean): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -size.x / 2, y: -size.y / 2, z: 0 }, max: { x: size.x / 2, y: size.y / 2, z: size.z },
      size: { ...size }, center: { x: 0, y: 0, z: size.z / 2 },
    },
    position, rotation: { ...ZERO }, loaded: true, ...(workholding ? { workholding: true } : {}),
  } as ImportedGeometry
}

function state() { return useCamStore.getState() }
function instances() { return state().project.workholding?.instances ?? [] }
const toClient = (p: { x: number; y: number }) => ({ x: 100 + p.x, y: 400 - p.y })

/** A recording stand-in for CNCViewport. */
function recordingViewport() {
  const bodies = new Map<string, { position: Vec3; rotation: Vec3; workholding: boolean }>()
  const vp = {
    bodies,
    selected: null as string | null,
    worldPointToScreen: (p: Vec3) => toClient(p),
    setSelectedPart: (id: string | null) => { vp.selected = id },
    addSTL: vi.fn(async (_b: ArrayBuffer, id: string, _n: string, position?: Vec3, rotation?: Vec3) => {
      bodies.set(id, { position: { ...position! }, rotation: { ...rotation! }, workholding: false })
      return { min: ZERO, max: ZERO }
    }),
    addBrepModel: vi.fn(),
    addModelBody: vi.fn(),
    removeSTL: vi.fn((id: string) => { bodies.delete(id) }),
    setPartTransform: vi.fn((id: string, position: Vec3, rotation: Vec3) => {
      const b = bodies.get(id)
      if (b) { b.position = { ...position }; b.rotation = { ...rotation } }
    }),
    setPartWorkholding: vi.fn((id: string, on: boolean) => { const b = bodies.get(id); if (b) b.workholding = on }),
    partPointToScreen: (id: string) => (bodies.has(id) ? { x: 0, y: 0 } : null),
  }
  ;(window as unknown as { __cncViewport?: unknown }).__cncViewport = vp
  return vp
}

beforeEach(() => {
  delete (window as unknown as { __cncViewport?: unknown }).__cncViewport
  act(() => {
    state().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
    state().addFixedStock({ id: 'stock-a', name: 'Plate', width: 100, height: 60, depth: 20, position: { ...ZERO } })
    type NewSetup = Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0]
    const stock = { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' }
    state().addSetup({ id: 'setup-a', name: 'Setup A', wcs: makeWcs(), stock, operations: [], notes: '' } as unknown as NewSetup)
    state().addSetup({ id: 'setup-b', name: 'Setup B', wcs: makeWcs(), stock, operations: [], notes: '' } as unknown as NewSetup)
    state().setActiveSetup('setup-a')
    state().addGeometry(block('clamp-body', 'Strap clamp', { x: 30, y: 10, z: 8 }, { x: -80, y: -80, z: 0 }, true))
    state().addGeometry(block('part-1', 'Block', { x: 40, y: 20, z: 10 }, { x: 200, y: 0, z: 0 }, false))
    state().setSelectedGeometry('clamp-body')
    useClampUi.setState({ placing: null, selectedClampId: null })
  })
})

type MarkerData = { z: number; loops: Array<{ loopId: string; path: Array<{ x: number; y: number }>; fractions: number[] }> } | null
type MarkerCallbacks = {
  onAdd: (loopId: string, fraction: number) => void
  onMove: (loopId: string, index: number, fraction: number) => void
  onRemove: (loopId: string, index: number) => void
  onExit: () => void
}

/** The viewport's edge-marker mode, recorded: the loops it is given and the callbacks its clicks and drags fire. */
function markerViewport() {
  const vp = recordingViewport() as ReturnType<typeof recordingViewport> & {
    markers: MarkerData
    callbacks: MarkerCallbacks | null
    setContourTabMarkers: (d: MarkerData) => void
    enterContourTabEditMode: (c: MarkerCallbacks) => void
    exitContourTabEditMode: () => void
  }
  vp.markers = null
  vp.callbacks = null
  vp.setContourTabMarkers = (d) => { vp.markers = d }
  vp.enterContourTabEditMode = (c) => { vp.callbacks = c }
  vp.exitContourTabEditMode = () => { vp.callbacks = null }
  return vp
}

const PLATE_EDGE = JSON.stringify(['stock', 'stock-a', 'outline'])
const PART_EDGE = JSON.stringify(['part', 'part-1', 'outline'])

describe('WO-2192: clamps through the screens', () => {
  it('Make clamp -> placer: an edge click adds a clamp, a marker drag slides it across the start, a double-click deletes it', () => {
    const vp = markerViewport()
    render(<div><ClampPlacer /><PropertiesPanel /></div>)
    const depth = state().projectHistory.length
    fireEvent.click(screen.getByTestId('make-clamp-btn'))
    expect(state().projectHistory.length).toBe(depth + 1)
    const placer = screen.getByTestId('clamp-placer')
    expect(within(placer).getByTestId('clamp-placer-stock').getAttribute('aria-pressed')).toBe('true')
    // The viewport's marker mode is on, with every stock edge as a loop (the plate, and the auto stock around the part).
    expect(vp.callbacks).not.toBeNull()
    expect(vp.markers!.loops.map((l) => l.loopId)).toContain(PLATE_EDGE)
    expect(vp.markers!.loops).toHaveLength(state().project.stocks!.length)
    expect(vp.markers!.loops.find((l) => l.loopId === PLATE_EDGE)!.path).toEqual([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 },
    ])

    act(() => { vp.callbacks!.onAdd(PLATE_EDGE, 0.125) }) // a click on the front edge at X 40
    expect(instances()).toHaveLength(1)
    expect(state().projectHistory.length).toBe(depth + 2)
    expect(instances()[0].worldPose.position).toEqual({ x: 40, y: 0, z: 20 })
    // The clamp is now a marker on its edge.
    expect(vp.markers!.loops.find((l) => l.loopId === PLATE_EDGE)!.fractions).toEqual([0.125])

    act(() => { vp.callbacks!.onMove(PLATE_EDGE, 0, 0.95) }) // dragged back across the start onto the left side
    expect(state().projectHistory.length).toBe(depth + 3)
    expect(instances()[0].worldPose.position).toEqual({ x: 0, y: 16, z: 20 })
    expect(vp.markers!.loops.find((l) => l.loopId === PLATE_EDGE)!.fractions).toEqual([0.95])

    // Part edge: the part outline is offered instead, at its top; a click on its right side adds one turned 90.
    fireEvent.click(within(placer).getByTestId('clamp-placer-part'))
    expect(vp.markers!.loops.map((l) => l.loopId)).toEqual([PART_EDGE])
    expect(vp.markers!.z).toBe(10)
    act(() => { vp.callbacks!.onAdd(PART_EDGE, 50 / 120) })
    expect(instances()).toHaveLength(2)
    expect(instances()[1].worldPose.position).toEqual({ x: 220, y: 0, z: 10 })
    expect(instances()[1].worldPose.rotation.z).toBe(90)

    act(() => { vp.callbacks!.onRemove(PART_EDGE, 0) }) // a double-click on its marker
    expect(instances()).toHaveLength(1)
    expect(state().projectHistory.length).toBe(depth + 5)

    fireEvent.click(within(placer).getByTestId('clamp-placer-done'))
    expect(screen.queryByTestId('clamp-placer')).toBeNull()
    expect(vp.callbacks).toBeNull()
    expect(vp.markers).toBeNull()
  })

  it('the drawn clamp sits where the resolver puts it, follows a slide, and is not drawn in another setup', async () => {
    const vp = recordingViewport()
    const def = state().makeClamp('clamp-body')!
    const id = state().placeClamp({ definitionId: def, target: { kind: 'stock', id: 'stock-a', loopId: 'outline' }, fraction: 0.125 })!
    const drawId = clampDrawId(id, 'body')
    const resolved = () => mat4ToPose(resolveInstancePlacements(state().project, 'setup-a').placements
      .find((p) => p.instanceId === id)!.worldFromComponent)

    await applyClampDrawings(vp)
    expect(vp.bodies.get(drawId)?.position).toEqual(resolved().position)
    expect(vp.bodies.get(drawId)?.workholding).toBe(true)

    act(() => { state().moveClampOnEdge(id, { fraction: 0.4 }) })
    await applyClampDrawings(vp)
    expect(vp.bodies.get(drawId)?.position).toEqual(resolved().position)
    expect(vp.bodies.get(drawId)?.rotation.z).toBeCloseTo(90, 9)

    act(() => { state().setActiveSetup('setup-b') })
    await applyClampDrawings(vp)
    expect(vp.bodies.has(drawId)).toBe(false)
  })

  it('clamp Properties and tree: Duplicate, Move to setup, Delete - one undo step each; lost edge only on that clamp', () => {
    recordingViewport()
    const def = state().makeClamp('clamp-body')!
    const onStock = state().placeClamp({ definitionId: def, target: { kind: 'stock', id: 'stock-a', loopId: 'outline' }, fraction: 0.125 })!
    const onPart = state().placeClamp({ definitionId: def, target: { kind: 'part', id: 'part-1', loopId: 'outline' }, fraction: 0.25 })!
    render(<div><PropertiesPanel /><DesignTree /></div>)
    act(() => { selectClamp(onStock) })
    const props = screen.getByTestId('clamp-props')
    expect(within(props).getByTestId('clamp-edge').textContent).toBe('Stock edge: Plate')
    expect(within(props).getByTestId('clamp-setups').textContent).toBe('Setup A')

    let depth = state().projectHistory.length
    fireEvent.click(within(props).getByTestId('clamp-duplicate'))
    expect(state().projectHistory.length).toBe(depth + 1)
    expect(instances()).toHaveLength(3)
    const copy = useClampUi.getState().selectedClampId!
    expect(copy).not.toBe(onStock)

    depth = state().projectHistory.length
    fireEvent.change(screen.getByTestId('clamp-move-to-setup'), { target: { value: 'setup-b' } })
    expect(state().projectHistory.length).toBe(depth + 1)
    expect(instances().find((i) => i.id === copy)!.setupScope).toEqual({ kind: 'setups', setupIds: ['setup-b'] })

    act(() => { selectClamp(onStock) })
    depth = state().projectHistory.length
    fireEvent.click(screen.getByTestId('clamp-delete'))
    expect(state().projectHistory.length).toBe(depth + 1)
    expect(instances().map((i) => i.id).sort()).toEqual([copy, onPart].sort())

    // The part goes: its clamp keeps its place and says so - in its row and its Properties only.
    act(() => { state().removeGeometry('part-1') })
    expect(screen.getByTestId(`tree-clamp-${onPart}`).textContent).toContain('edge reference lost')
    expect(screen.getAllByTestId('tree-clamp-lost')).toHaveLength(1)
    act(() => { selectClamp(onPart) })
    expect(screen.getByTestId('clamp-edge-lost').textContent).toBe('edge reference lost')
  })

  it('Delete / Backspace on a selected clamp removes that clamp only - the global Delete (op / setup, with confirm) does not also run', () => {
    recordingViewport()
    const def = state().makeClamp('clamp-body')!
    const a = state().placeClamp({ definitionId: def, target: { kind: 'stock', id: 'stock-a', loopId: 'outline' }, fraction: 0.125 })!
    const b = state().placeClamp({ definitionId: def, target: { kind: 'stock', id: 'stock-a', loopId: 'outline' }, fraction: 0.625 })!
    function Shell() { useGlobalShortcuts(); return <ClampPlacer /> }
    render(<Shell />)
    expect(state().workspace).toBe('cam')
    expect(state().project.activeSetupId).toBe('setup-a')

    for (const [key, gone, left] of [['Delete', a, [b]], ['Backspace', b, []]] as const) {
      act(() => { selectClamp(gone) })
      expect(state().viewer.selectedGeometryId).toBeNull()
      const depth = state().projectHistory.length
      act(() => { fireEvent.keyDown(window, { key }) })
      expect(instances().map((i) => i.id)).toEqual(left)
      expect(state().projectHistory.length).toBe(depth + 1)
      expect(state().confirmDialog).toBeNull()
      expect(state().project.setups.map((s) => s.id)).toEqual(['setup-a', 'setup-b'])
      expect(useClampUi.getState().selectedClampId).toBeNull()
    }

    // With no clamp selected the global Delete is the app's own again (its setup confirm).
    act(() => { fireEvent.keyDown(window, { key: 'Delete' }) })
    expect(state().confirmDialog?.title).toBe('Delete this setup and its operations?')
  })
})
