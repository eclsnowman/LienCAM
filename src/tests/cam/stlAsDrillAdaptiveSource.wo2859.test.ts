// @vitest-environment jsdom

// WO-2859: the sweep (F4) imported Sample Parts/plate.stl - a plate with holes -
// and found it offered to Contour ("STL - select to load edge chains") but not
// to Drill, while the Model workspace recognised its holes. WO-1851 already
// proves an STL's holes and lands them as drill targets (Detect holes answers
// for an STL), and `meshFeatureTargetAdmission` already says a drill and a bore
// aim at those holes. The dialog's source list was the only door still shut: it
// admitted a fresh STL only through the edge-chain rule, which Drill is not on.
// These tests drive the real New Operation dialog with the shipped plate.

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Setup } from '../../types'
import { typedMock } from '../support/typedMock'

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

// The PRODUCTION toolpath worker, run in this thread (same harness as
// WO-1851), so the drill that Create saves is computed end to end.
const workerScope: {
  onmessage: ((event: MessageEvent) => unknown) | null
  postMessage: (data: unknown) => void
  location: Location
} = { onmessage: null, postMessage: () => {}, location: window.location }
vi.stubGlobal('self', workerScope)
await import('../../lib/cam/toolpathWorker')
let activeWorker: { onmessage: ((event: MessageEvent) => void) | null } | null = null
workerScope.postMessage = (data) => activeWorker?.onmessage?.({ data } as MessageEvent)
class InProcessToolpathWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: unknown): void {
    activeWorker = this
    void workerScope.onmessage?.({ data } as MessageEvent)
  }
  terminate(): void { /* in-process */ }
}

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const GEO_ID = 'wo2859-plate'
const SETUP_ID = 'wo2859-setup'
const TOOL_ID = 'wo2859-drill'
const MILL_ID = 'wo2859-mill'
const STOCK_ID = 'wo2859-stock'

function plateBytes(): ArrayBuffer {
  const bytes = readFileSync('Sample Parts/plate.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** The plate exactly as Example Projects/Full Suite.camproject carries it:
 *  60 x 60 x 4 mm, centred on the origin, no loops derived yet. */
function seedProject(): void {
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID,
    name: 'Plate',
    filename: 'plate.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    stockId: STOCK_ID,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 4 },
      size: { x: 60, y: 60, z: 4 }, center: { x: 0, y: 0, z: 2 },
    },
  }]
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [],
    notes: '',
  } as unknown as Setup
  const stock = {
    id: STOCK_ID,
    name: 'WO-2859 Stock',
    mode: 'explicit',
    bounds: {
      min: { x: -35, y: -35, z: 0 }, max: { x: 35, y: 35, z: 4 },
      size: { x: 70, y: 70, z: 4 }, center: { x: 0, y: 0, z: 2 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [
      {
        id: TOOL_ID, name: 'WO-2859 3mm Drill', type: 'drill', diameter: 3,
        fluteLength: 20, shankDiameter: 3, overallLength: 50, numberOfFlutes: 2, tipAngle: 118,
      },
      {
        id: MILL_ID, name: 'WO-2859 3mm Flat', type: 'flat_end_mill', diameter: 3,
        fluteLength: 20, shankDiameter: 3, overallLength: 50, numberOfFlutes: 2,
      },
    ] as never,
    project: { ...current.project, geometry, setups: [setup], stocks: [stock], activeSetupId: SETUP_ID },
  } as never)
}

function openGeometryTab(operationLabel: string, toolName: string): void {
  render(createElement(NewOperationModal))
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(operationLabel))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(toolName))
  fireEvent.click(screen.getByText('Geometry'))
}

function sourceOption(): HTMLOptionElement | undefined {
  const select = screen.queryByTestId('op-geometry-select') as HTMLSelectElement | null
  return select ? Array.from(select.options).find((option) => option.value === GEO_ID) : undefined
}

beforeEach(() => {
  vi.stubGlobal('Worker', InProcessToolpathWorker)
  act(() => { useCamStore.getState().newProject() })
  stlCache.load.mockReset()
  stlCache.load.mockResolvedValue(plateBytes())
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-2859: Sample Parts/plate.stl is a Drill source', () => {
  it('offers the fresh STL to Drill, detects its holes on selection, and drills every one', async () => {
    openGeometryTab('Drill', 'WO-2859 3mm Drill')

    // Offered BEFORE anything is derived - choosing it is what finds the holes.
    expect(sourceOption()).toBeDefined()
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })

    await waitFor(() => {
      const holes = useCamStore.getState().project.geometry[0].loops
        ?.filter((loop) => loop.id.startsWith('mfh:')) ?? []
      expect(holes.length).toBeGreaterThan(0)
    })
    const row = useCamStore.getState().project.geometry[0]
    const holeLoops = (row.loops ?? []).filter((loop) => loop.id.startsWith('mfh:'))
    const holeLayer = (row.layers2d ?? []).find((layer) => (layer.holes?.length ?? 0) > 0)
    expect(holeLayer?.holes?.length).toBe(holeLoops.length)
    // The shipped plate: four 6 mm corner holes and the 18 mm centre bore.
    expect(holeLoops).toHaveLength(5)

    // The list names the holes it found, not "0 closed loops", and offers no
    // edge chain: a drill cannot cut a chain (WO-1851).
    await waitFor(() => expect(sourceOption()?.text).toBe(`Plate (${holeLoops.length} closed loops)`))
    expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBe(holeLoops.length)
    expect((row.loops ?? []).some((loop) => loop.id.startsWith('mec:'))).toBe(false)

    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('drill')
    const pickedIds = (created.params as { loopIds: string[] }).loopIds
    expect([...pickedIds].sort()).toEqual(holeLoops.map((loop) => loop.id).sort())

    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, created.id) })
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    const plunges = (computed.toolpathMoves ?? []).filter((move) => move.type === 'feed' && move.role === 'plunge')
    // Every recognised hole is drilled at its own measured centre.
    for (const hole of holeLayer?.holes ?? []) {
      expect(plunges.some((move) =>
        Math.hypot((move.x ?? NaN) - hole.center[0], (move.y ?? NaN) - hole.center[1]) < 1e-3)).toBe(true)
    }
  })

  it('offers the same STL to Bore through the one hole-target rule', () => {
    openGeometryTab('Bore', 'WO-2859 3mm Flat')
    expect(sourceOption()).toBeDefined()
  })

  it('keeps Engrave out: recognised holes and edge chains have no meaning for it', () => {
    openGeometryTab('Engrave / Trace', 'WO-2859 3mm Flat')
    expect(sourceOption()).toBeUndefined()
  })
})

describe('WO-2859: Sample Parts/plate.stl is an Adaptive source', () => {
  // `meshEdgeChainAdmission` now answers 'closed-only' for adaptive clearing,
  // beside Pocket: an adaptive clear is bounded by a closed region exactly as a
  // pocket is. The dialog and the compute seam both read that one rule.
  it('offers the fresh STL to Adaptive, loads its closed chains, and produces a toolpath', async () => {
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')

    expect(sourceOption()?.text).toBe('Plate (STL - select to load edge chains)')
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
    })
    const row = useCamStore.getState().project.geometry[0]
    const chains = (row.loops ?? []).filter((loop) => loop.id.startsWith('mec:'))
    expect(chains.length).toBeGreaterThan(0)
    // Closed only: an open chain bounds no region to clear.
    const listed = document.querySelectorAll('.op-loop-list input[type="checkbox"]').length
    expect(listed).toBe(chains.filter((loop) => loop.closed).length)

    // Clear the 18 mm centre bore: the closed chain whose centre sits at (0, 3).
    const centre = (loop: { points: Array<{ x: number; y: number }> }) => {
      const xs = loop.points.map((p) => p.x)
      const ys = loop.points.map((p) => p.y)
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2,
        w: Math.max(...xs) - Math.min(...xs) }
    }
    const bore = chains.find((loop) => {
      const c = centre(loop)
      return loop.closed && Math.hypot(c.x, c.y - 3) < 0.5 && Math.abs(c.w - 18) < 0.5
    })
    expect(bore, JSON.stringify(chains.map((loop) => ({ id: loop.id, closed: loop.closed, ...centre(loop) })))).toBeDefined()
    const boreIndex = chains.filter((loop) => loop.closed).indexOf(bore!)
    fireEvent.click(document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]')[boreIndex])

    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('adaptive_clearing_2d')
    expect((created.params as { loopIds: string[] }).loopIds).toEqual([bore!.id])

    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, created.id) })
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    const cuts = (computed.toolpathMoves ?? []).filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
    expect(cuts.length).toBeGreaterThan(0)
    // Every cut stays inside the bore it was asked to clear (radius 9 - tool radius 1.5).
    for (const move of cuts) {
      if (move.x === undefined || move.y === undefined) continue
      expect(Math.hypot(move.x, move.y - 3)).toBeLessThanOrEqual(7.5 + 1e-3)
    }
  })
})

describe('WO-2859: two bores ticked on one plate are both cleared', () => {
  // An STL's bores carry 'hole' winding. With nothing but holes picked, the
  // engine kept the largest as the region and dropped every disjoint other.
  it('clears every ticked bore, not only the largest', async () => {
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
    })
    const closed = (useCamStore.getState().project.geometry[0].loops ?? [])
      .filter((loop) => loop.id.startsWith('mec:') && loop.closed)
    const box = (loop: { points: Array<{ x: number; y: number }> }) => {
      const xs = loop.points.map((p) => p.x)
      const ys = loop.points.map((p) => p.y)
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2,
        w: Math.max(...xs) - Math.min(...xs) }
    }
    // The 18 mm centre bore and the largest other hole the 3 mm tool fits,
    // clear of the bore.
    const bore = closed.find((loop) => { const b = box(loop); return Math.hypot(b.x, b.y - 3) < 0.5 && Math.abs(b.w - 18) < 0.5 })!
    const other = closed
      .filter((loop) => loop.type === 'hole' && loop !== bore)
      .filter((loop) => { const b = box(loop); return b.w > 4 && b.w < 40 && Math.hypot(b.x, b.y - 3) > 12 })
      .sort((a, b) => box(b).w - box(a).w)[0]
    expect(bore).toBeDefined()
    expect(other, JSON.stringify(closed.map((loop) => ({ type: loop.type, ...box(loop) })))).toBeDefined()
    const boxes = document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]')
    fireEvent.click(boxes[closed.indexOf(bore)])
    fireEvent.click(boxes[closed.indexOf(other)])
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect((created.params as { loopIds: string[] }).loopIds).toEqual([bore.id, other.id])
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, created.id) })
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    const cuts = (computed.toolpathMoves ?? []).filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
      .filter((move) => move.x !== undefined && move.y !== undefined)
    const inside = (move: { x?: number; y?: number }, loop: typeof bore) => {
      const b = box(loop)
      return Math.hypot(move.x! - b.x, move.y! - b.y) <= b.w / 2 - 1.5 + 1e-3
    }
    expect(cuts.some((move) => inside(move, bore))).toBe(true)
    expect(cuts.some((move) => inside(move, other))).toBe(true)
    for (const move of cuts) expect(inside(move, bore) || inside(move, other)).toBe(true)
  })
})

describe('WO-2859: an Adaptive picked under All Parts keeps its STL source binding', () => {
  // Audit FAIL (astra, 2026-10-16): admitting Adaptive to STL chains also opens
  // All Parts, where a chain id is content-derived and can sit on two imported
  // copies of the same STL. Compute then needs the authoring-time binding
  // (WO-258) - without it, a valid pick on two STL sources was refused as
  // "no saved source binding" and selecting again could not repair it.
  const COPY_ID = 'wo2859-plate-copy'
  const STEP_ID = 'wo2859-step'
  type Bindings = Record<string, Array<{ geometryId: string; geometryName: string }>>

  function addGeometry(row: ImportedGeometry): void {
    act(() => {
      useCamStore.setState((state) => ({
        project: { ...state.project, geometry: [...state.project.geometry, row] },
      }))
    })
  }

  /** A STEP part as All Parts sees it once its outline is derived: one closed
   *  20 mm square, clear of the plate's centre bore. */
  function stepRow(): ImportedGeometry {
    const square = [{ x: 40, y: -10 }, { x: 60, y: -10 }, { x: 60, y: 10 }, { x: 40, y: 10 }]
    return {
      id: STEP_ID,
      name: 'Block',
      filename: 'block.step',
      type: 'brep',
      format: 'step',
      loaded: true,
      stockId: STOCK_ID,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 40, y: -10, z: 0 }, max: { x: 60, y: 10, z: 4 },
        size: { x: 20, y: 20, z: 4 }, center: { x: 50, y: 0, z: 2 },
      },
      layers2d: [{ id: 'wo2859-step-layer', name: 'Outline', visible: true, color: '#888888' }],
      loops: [{
        id: 'wo2859-step-square', points: square, closed: true, type: 'contour',
        layerId: 'wo2859-step-layer', area: 400,
      }],
    } as unknown as ImportedGeometry
  }

  async function reloadProject(): Promise<void> {
    // An explicit stock assignment is durable only when locked (AutoStockItem);
    // the seed sets stockId alone, which a reopen re-derives.
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: state.project.geometry.map((geometry) => ({ ...geometry, stockIdLocked: true })),
        },
      }))
    })
    const projectText = JSON.stringify(useCamStore.getState().project)
    act(() => { useCamStore.getState().newProject() })
    await act(async () => {
      const store = useCamStore.getState()
      const requestId = store.beginProjectOpen()
      await store.loadProjectFromFile(projectText, requestId)
    })
  }

  /** Compute through production and check that every bore centre given is
   *  cleared, and nothing outside those bores (radius 9 - tool radius 1.5). */
  async function computeReady(boreCentres: Array<{ x: number; y: number }>): Promise<void> {
    const opId = useCamStore.getState().project.setups[0].operations[0].id
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId) })
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    const cuts = (computed.toolpathMoves ?? []).filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
      .filter((move) => move.x !== undefined && move.y !== undefined)
    const near = (move: { x?: number; y?: number }, c: { x: number; y: number }) =>
      Math.hypot(move.x! - c.x, move.y! - c.y) <= 7.5 + 1e-3
    for (const centre of boreCentres) expect(cuts.some((move) => near(move, centre))).toBe(true)
    for (const move of cuts) expect(boreCentres.some((centre) => near(move, centre))).toBe(true)
  }

  type Chain = { id: string; index: number }
  /** The plate's closed chain centred at (x, y) and `width` wide. */
  function plateChain(x: number, y: number, width: number): Chain {
    const chains = (useCamStore.getState().project.geometry[0].loops ?? [])
      .filter((loop) => loop.id.startsWith('mec:') && loop.closed)
    const found = chains.find((loop) => {
      const xs = loop.points.map((p) => p.x)
      const ys = loop.points.map((p) => p.y)
      return Math.hypot((Math.min(...xs) + Math.max(...xs)) / 2 - x, (Math.min(...ys) + Math.max(...ys)) / 2 - y) < 0.5
        && Math.abs(Math.max(...xs) - Math.min(...xs) - width) < 0.5
    })
    expect(found).toBeDefined()
    return { id: found!.id, index: chains.indexOf(found!) }
  }
  /** The 18 mm centre bore, and the 60 mm plate outline. */
  const boreChain = (): Chain => plateChain(0, 3, 18)
  const outlineChain = (): Chain => plateChain(0, 0, 60)

  /** The "Loops to machine" row of part `instance`'s `chain` under All Parts.
   *  The list runs part by part (Plate, then Plate copy), and the copy
   *  carries the same closed chains in the same order. */
  function boreRow(instance: number, chain: Chain = boreChain()): HTMLInputElement {
    const perPart = (useCamStore.getState().project.geometry[0].loops ?? [])
      .filter((loop) => loop.id.startsWith('mec:') && loop.closed).length
    const boxes = document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]')
    return boxes[instance * perPart + chain.index]
  }

  /** Adaptive (or `operationLabel`) -> Geometry -> All Parts, tick `chain`
   *  (the centre bore) on each listed part instance (0 = Plate, 1 = Plate
   *  copy), Create. */
  async function pickBoreUnderAllParts(
    instances: number[] = [0],
    operationLabel = '2D Adaptive Clearing',
    chain: Chain = boreChain(),
  ): Promise<string> {
    const { id } = chain
    openGeometryTab(operationLabel, 'WO-2859 3mm Flat')
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: '__all__' } })
    for (const instance of instances) fireEvent.click(boreRow(instance, chain))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    return id
  }

  /** Re-open the saved operation in the edit dialog and Save it unchanged. */
  async function editAndSave(): Promise<void> {
    cleanup()
    const opId = useCamStore.getState().project.setups[0].operations[0].id
    render(createElement(NewOperationModal))
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, opId) })
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
  }

  function savedParams(): { geometryId: string; loopIds: string[]; meshChainSources?: Bindings } {
    return useCamStore.getState().project.setups[0].operations[0].params as never
  }

  /** A second plate placed 80 mm to the right on a stock wide enough for
   *  both, chains loaded on each (choosing each part once is what loads its
   *  chains; All Parts lists only parts that have loops). An explicit stock's
   *  world box is its position (the MIN corner) plus its size
   *  (stockWorldBounds), so the position is the -35/-35 corner: at the origin
   *  the box would run 0..150 x 0..70 and Smart Height V2 would rightly find
   *  both plates outside it. */
  async function twoPlates(): Promise<void> {
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          stocks: (state.project.stocks ?? []).map((stock) => ({
            ...stock,
            bounds: {
              min: { x: -35, y: -35, z: 0 }, max: { x: 115, y: 35, z: 4 },
              size: { x: 150, y: 70, z: 4 }, center: { x: 40, y: 0, z: 2 },
            },
            position: { x: -35, y: -35, z: 0 },
          })),
        },
      }) as never)
    })
    addGeometry({
      ...structuredClone(useCamStore.getState().project.geometry[0]),
      id: COPY_ID, name: 'Plate copy', position: { x: 80, y: 0, z: 0 },
    })
    await act(async () => { await useCamStore.getState().loadMeshEdgeChains(GEO_ID) })
    await act(async () => { await useCamStore.getState().loadMeshEdgeChains(COPY_ID) })
  }

  /** Create, edit Save and reopen each keep exactly `bound` and cut exactly
   *  the bores at `centres`. */
  async function holdsThroughSaveAndReopen(
    boreId: string,
    bound: Array<{ geometryId: string; geometryName: string }>,
    centres: Array<{ x: number; y: number }>,
  ): Promise<void> {
    expect(savedParams().geometryId).toBe('__all__')
    expect(savedParams().loopIds).toEqual([boreId])
    expect(savedParams().meshChainSources).toEqual({ [boreId]: bound })
    await computeReady(centres)

    await editAndSave()
    expect(savedParams().meshChainSources).toEqual({ [boreId]: bound })
    await computeReady(centres)

    await reloadProject()
    expect(savedParams().meshChainSources).toEqual({ [boreId]: bound })
    await computeReady(centres)
  }

  const PLATE = { geometryId: GEO_ID, geometryName: 'Plate' }
  const PLATE_COPY = { geometryId: COPY_ID, geometryName: 'Plate copy' }

  // Audit FAIL 2 (astra, 2026-10-16): the chain id is content-derived, so the
  // centre bore of Plate and of an identical Plate copy share ONE id. The
  // saved pick names the part instance whose row was ticked - only that part
  // is cut, never "the first part carrying that id".
  it('cuts only the FIRST plate when its bore row is ticked, through Create, edit Save and reopen', async () => {
    await twoPlates()
    const boreId = await pickBoreUnderAllParts([0])
    expect(useCamStore.getState().project.setups[0].operations[0].type).toBe('adaptive_clearing_2d')
    await holdsThroughSaveAndReopen(boreId, [PLATE], [{ x: 0, y: 3 }])
  })

  it('cuts only the SECOND plate when the copy\'s bore row is ticked, through Create, edit Save and reopen', async () => {
    await twoPlates()
    const boreId = await pickBoreUnderAllParts([1])
    await holdsThroughSaveAndReopen(boreId, [PLATE_COPY], [{ x: 80, y: 3 }])
  })

  it('cuts both plates when both bore rows are ticked, through Create, edit Save and reopen', async () => {
    await twoPlates()
    const boreId = await pickBoreUnderAllParts([0, 1])
    await holdsThroughSaveAndReopen(boreId, [PLATE, PLATE_COPY], [{ x: 0, y: 3 }, { x: 80, y: 3 }])
  })

  it('shows the ticked instance alone as checked when the dialog reopens', async () => {
    await twoPlates()
    await pickBoreUnderAllParts([1])
    cleanup()
    const opId = useCamStore.getState().project.setups[0].operations[0].id
    render(createElement(NewOperationModal))
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, opId) })
    fireEvent.click(screen.getByText('Geometry'))
    await waitFor(() => expect(boreRow(1)).toBeDefined())
    expect(boreRow(0).checked).toBe(false)
    expect(boreRow(1).checked).toBe(true)
  })

  it('still cuts the ticked copy after the unticked plate is removed', async () => {
    await twoPlates()
    await pickBoreUnderAllParts([1])
    act(() => {
      useCamStore.setState((state) => ({
        project: { ...state.project, geometry: state.project.geometry.filter((geometry) => geometry.id !== GEO_ID) },
      }))
    })
    await computeReady([{ x: 80, y: 3 }])
  })

  // Pocket shares the binder and the compute seam. Its pick here is the plate
  // OUTLINE: Pocket reads an STL bore chain alone as an island with no
  // boundary and refuses it on either copy (WO-258 behaviour, not this order).
  it('cuts only the SECOND plate for a Pocket too - the one shared chain binder', async () => {
    await twoPlates()
    const outlineId = await pickBoreUnderAllParts([1], '2D Pocket', outlineChain())
    expect(useCamStore.getState().project.setups[0].operations[0].type).toBe('pocket_2d')
    expect(savedParams().meshChainSources).toEqual({ [outlineId]: [PLATE_COPY] })
    const opId = useCamStore.getState().project.setups[0].operations[0].id
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId) })
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    const cuts = (computed.toolpathMoves ?? []).filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
      .filter((move) => move.x !== undefined && move.y !== undefined)
    expect(cuts.length).toBeGreaterThan(0)
    // Every cut inside the copy's 60 mm footprint at X 50..110; none on Plate.
    for (const move of cuts) {
      expect(move.x!).toBeGreaterThanOrEqual(50 - 1e-3)
      expect(move.x!).toBeLessThanOrEqual(110 + 1e-3)
    }
  })

  it('binds only the STL in an All Parts STL + STEP pair and computes the picked bore', async () => {
    addGeometry(stepRow())
    await act(async () => { await useCamStore.getState().loadMeshEdgeChains(GEO_ID) })

    const boreId = await pickBoreUnderAllParts()
    await computeReady([{ x: 0, y: 3 }])
    expect(savedParams().meshChainSources).toEqual({ [boreId]: [{ geometryId: GEO_ID, geometryName: 'Plate' }] })

    await editAndSave()
    expect(savedParams().meshChainSources).toEqual({ [boreId]: [{ geometryId: GEO_ID, geometryName: 'Plate' }] })
    await computeReady([{ x: 0, y: 3 }])
  })

  it('saves no chain binding for an Adaptive on one directly chosen STL', async () => {
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
    })
    fireEvent.click(document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]')[0])
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedParams().geometryId).toBe(GEO_ID)
    expect(savedParams().meshChainSources).toBeUndefined()
  })

  // Audit FAIL 3 (astra, 2026-10-16): the selection lived in two parallel
  // fields (loopIds and meshChainSources) and a Source change cleared only one,
  // so a discarded instance pick came back on the next tick. Every route that
  // changes the selection must leave no binding outside it.
  function selectSource(value: string): void {
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value } })
  }
  function rowCount(): number {
    return document.querySelectorAll('.op-loop-list input[type="checkbox"]').length
  }
  async function createAndExpectOnlyCopy(boreId: string): Promise<void> {
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    await holdsThroughSaveAndReopen(boreId, [PLATE_COPY], [{ x: 80, y: 3 }])
  }

  it.each([
    ['Plate', GEO_ID],
    ['Plate copy', COPY_ID],
  ])('cuts only the SECOND plate after tick first -> Source %s -> All Parts -> tick second', async (_name, single) => {
    await twoPlates()
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')
    selectSource('__all__')
    fireEvent.click(boreRow(0))
    expect(boreRow(0).checked).toBe(true)
    selectSource(single)
    await waitFor(() => expect(rowCount()).toBeGreaterThan(0))
    selectSource('__all__')
    await waitFor(() => expect(rowCount()).toBeGreaterThan(boreChain().index))
    expect(boreRow(0).checked).toBe(false)
    expect(boreRow(1).checked).toBe(false)
    fireEvent.click(boreRow(1))
    expect(boreRow(0).checked).toBe(false)
    expect(boreRow(1).checked).toBe(true)
    await createAndExpectOnlyCopy(boreChain().id)
  })

  // Stock -> Selected geometry: Stock clears the selection, Selected geometry
  // opts the operation into Smart Height V2, whose All Parts scope reads the
  // instance binding. A row reads the binding too (isMeshChainInstancePicked):
  // with the chain still picked, an unchecked row means no binding names it.
  it.each([
    ['2D Adaptive Clearing', 'adaptive', boreChain],
    ['2D Pocket', 'pocket', outlineChain],
  ] as const)('%s: cuts only the SECOND plate after tick first -> Stock -> Selected geometry -> All Parts -> tick second', async (label, family, chainOf) => {
    await twoPlates()
    const chain = chainOf()
    openGeometryTab(label, 'WO-2859 3mm Flat')
    selectSource('__all__')
    fireEvent.click(boreRow(0, chain))
    expect(boreRow(0, chain).checked).toBe(true)
    fireEvent.click(screen.getByTestId(`${family}-stock-smart-height`))
    fireEvent.click(screen.getByTestId(`${family}-geometry-smart-height`))
    selectSource('__all__')
    await waitFor(() => expect(rowCount()).toBeGreaterThan(chain.index))
    expect(boreRow(0, chain).checked).toBe(false)
    expect(boreRow(1, chain).checked).toBe(false)
    fireEvent.click(boreRow(1, chain))
    expect(boreRow(0, chain).checked).toBe(false)
    expect(boreRow(1, chain).checked).toBe(true)

    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedParams().geometryId).toBe('__all__')
    expect(savedParams().loopIds).toEqual([chain.id])
    expect(savedParams().meshChainSources).toEqual({ [chain.id]: [PLATE_COPY] })

    const opId = useCamStore.getState().project.setups[0].operations[0].id
    await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId) })
    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    const cuts = (computed.toolpathMoves ?? []).filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
      .filter((move) => move.x !== undefined && move.y !== undefined)
    expect(cuts.length).toBeGreaterThan(0)
    // Every cut on the copy: inside its bore at (80, 3) for Adaptive (radius
    // 9 - tool radius 1.5), inside its 60 mm footprint at X 50..110 for Pocket.
    for (const move of cuts) {
      if (family === 'adaptive') {
        expect(Math.hypot(move.x! - 80, move.y! - 3)).toBeLessThanOrEqual(7.5 + 1e-3)
      } else {
        expect(move.x!).toBeGreaterThanOrEqual(50 - 1e-3)
        expect(move.x!).toBeLessThanOrEqual(110 + 1e-3)
      }
    }
  })

  it('binds only the SECOND plate after tick first -> Open contour -> Closed profile -> tick second (Contour)', async () => {
    await twoPlates()
    openGeometryTab('2D Contour', 'WO-2859 3mm Flat')
    selectSource('__all__')
    fireEvent.click(boreRow(0))
    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(screen.getByTestId('contour-path-closed'))
    await waitFor(() => expect(rowCount()).toBeGreaterThan(boreChain().index))
    expect(boreRow(0).checked).toBe(false)
    fireEvent.click(boreRow(1))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedParams().loopIds).toEqual([boreChain().id])
    expect(savedParams().meshChainSources).toEqual({ [boreChain().id]: [PLATE_COPY] })
  })

  it('cuts only the SECOND plate after tick first -> Clear selection -> tick second', async () => {
    await twoPlates()
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')
    selectSource('__all__')
    fireEvent.click(boreRow(0))
    fireEvent.click(screen.getByTestId('op-loops-clear'))
    expect(boreRow(0).checked).toBe(false)
    fireEvent.click(boreRow(1))
    await createAndExpectOnlyCopy(boreChain().id)
  })

  it('cuts only the SECOND plate after a cancelled dialog ticked the first', async () => {
    await twoPlates()
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')
    selectSource('__all__')
    fireEvent.click(boreRow(0))
    act(() => { useCamStore.getState().closeModal() })
    cleanup()
    await pickBoreUnderAllParts([1])
    await holdsThroughSaveAndReopen(boreChain().id, [PLATE_COPY], [{ x: 80, y: 3 }])
  })

  it('cuts both copies after a viewport click on the bore, which names no copy', async () => {
    await twoPlates()
    const picked = new Set<string>()
    let onLoop: ((loopId: string, nowSelected: boolean) => void) | null = null
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode: (callback: typeof onLoop) => { onLoop = callback },
      setPickedLoops: (ids: string[]) => { picked.clear(); for (const id of ids) picked.add(id) },
    }
    openGeometryTab('2D Adaptive Clearing', 'WO-2859 3mm Flat')
    selectSource('__all__')
    const boreId = boreChain().id
    fireEvent.click(boreRow(0))
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    act(() => { onLoop!(boreId, false) })
    act(() => { onLoop!(boreId, true) })
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    expect(boreRow(0).checked).toBe(true)
    expect(boreRow(1).checked).toBe(true)
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedParams().loopIds).toEqual([boreId])
    expect(savedParams().meshChainSources).toEqual({ [boreId]: [PLATE, PLATE_COPY] })
    await computeReady([{ x: 0, y: 3 }, { x: 80, y: 3 }])
  })

  it('drops a saved binding outside the saved selection when the operation is opened for edit', async () => {
    await twoPlates()
    await pickBoreUnderAllParts([0])
    const boreId = boreChain().id
    // An operation whose saved binding names a chain it no longer selects.
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          setups: state.project.setups.map((setup) => ({
            ...setup,
            operations: setup.operations.map((op) => ({
              ...op, params: { ...op.params, loopIds: [] },
            })),
          })),
        },
      }) as never)
    })
    cleanup()
    const opId = useCamStore.getState().project.setups[0].operations[0].id
    render(createElement(NewOperationModal))
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, opId) })
    fireEvent.click(screen.getByText('Geometry'))
    await waitFor(() => expect(rowCount()).toBeGreaterThan(boreChain().index))
    // Empty loopIds on an edited op is the legacy "all" sentinel; clear it first.
    fireEvent.click(screen.getByTestId('op-loops-clear'))
    fireEvent.click(boreRow(1))
    expect(boreRow(0).checked).toBe(false)
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(savedParams().loopIds).toEqual([boreId])
    expect(savedParams().meshChainSources).toEqual({ [boreId]: [PLATE_COPY] })
    await computeReady([{ x: 80, y: 3 }])
  })
})
