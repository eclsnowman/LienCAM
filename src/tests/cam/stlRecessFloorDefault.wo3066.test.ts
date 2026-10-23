// @vitest-environment jsdom

// WO-3066 (owner 2026-10-22, Mission Control card "Pocket on a shallow STL
// recess: stop at its floor?" -> "Fix it in alpha.3.1"): a new 2D Pocket (or
// Adaptive) on the NEMA17 plate's 2.2 mm deep boss relief started with its
// bottom 5 mm below stock top and cut the disc through. It now reads the
// recess floor off the STL's edge chains and starts there; a through feature
// (the 8 mm shaft bore, the old plate's 18 mm bore) keeps today's default.
// "Geometry plane" on an STL chain resolves to that chain's own Z.
//
// Driven through the real New Operation dialog and the store's compute seam
// with the production toolpath worker in-process (pocketStlBoreAlone's harness).
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Loop2D, Setup } from '../../types'
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

const { stlRecessFloorLocalZ } = await import('../../lib/cam/stlRecessFloor')
const { resolveTopZ } = await import('../../store/dispatchGeo')

const GEO_ID = 'recess-floor-plate'
const SETUP_ID = 'recess-floor-setup'
const STOCK_ID = 'recess-floor-stock'
const TOOLS = [
  { id: 'rf-3', name: 'RF 3mm Flat', diameter: 3 },
  { id: 'rf-6', name: 'RF 6mm Flat', diameter: 6 },
]
const OLD_PLATE = 'src/tests/fixtures/plate-old-18mm-bore.stl'
const NEMA17 = 'src/tests/evidence/WO-2935/attempt3/Plate-NEMA17.stl'
/** The NEMA17 plate is 4 mm thick; its boss relief floor is 2.2 mm below the top. */
const PLATE_TOP = 4
const RELIEF_FLOOR = 1.8

function bytesOf(file: string): ArrayBuffer {
  const bytes = readFileSync(file)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** One 60 x 60 x 4 mm STL plate centred on the origin in a 70 x 70 stock
 *  whose top is the plate top (WCS on the plate bottom). */
function seedProject(file: string): void {
  stlCache.load.mockResolvedValue(bytesOf(file))
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID, name: 'Plate', filename: file.split('/').pop()!, type: 'mesh', format: 'stl',
    loaded: true, stockId: STOCK_ID,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: PLATE_TOP },
      size: { x: 60, y: 60, z: PLATE_TOP }, center: { x: 0, y: 0, z: PLATE_TOP / 2 },
    },
  }]
  const setup = {
    id: SETUP_ID, name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [],
    notes: '',
  } as unknown as Setup
  const stock = {
    id: STOCK_ID, name: 'Recess Floor Stock', mode: 'explicit',
    bounds: {
      min: { x: -35, y: -35, z: 0 }, max: { x: 35, y: 35, z: PLATE_TOP },
      size: { x: 70, y: 70, z: PLATE_TOP }, center: { x: 0, y: 0, z: PLATE_TOP / 2 },
    },
    position: { x: -35, y: -35, z: 0 },
  }
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: TOOLS.map((tool) => ({
      ...tool, type: 'flat_end_mill', fluteLength: 20, shankDiameter: tool.diameter,
      overallLength: 50, numberOfFlutes: 2,
    })) as never,
    project: { ...current.project, geometry, setups: [setup], stocks: [stock], activeSetupId: SETUP_ID },
  } as never)
}

type Chain = { id: string; name?: string; closed: boolean; type?: string; points: Array<{ x: number; y: number }> }
const box = (loop: Chain) => {
  const xs = loop.points.map((p) => p.x)
  const ys = loop.points.map((p) => p.y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2,
    w: Math.max(...xs) - Math.min(...xs) }
}
const zOfName = (loop: Chain) => Number(/\(Z ([-\d.]+)\)/.exec(loop.name ?? '')?.[1] ?? NaN)
const bottomRow = () => ({
  source: screen.getByTestId('standard-height-bottom-source').textContent,
  resolved: screen.getByTestId('standard-height-bottom-resolved').textContent,
})

type Pick = { centre: { x: number; y: number }; width: number; level: 'top' | 'bottom' }

/** `operation` -> tool -> Geometry -> the plate -> tick the closed chain of
 *  `width` mm centred at `centre` (its top or bottom Z) -> Heights tab. */
async function openWithPick(operation: string, toolName: string, pick: Pick) {
  render(createElement(NewOperationModal))
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(operation))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(toolName))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
  await waitFor(() => {
    expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
  })
  const closed = ((useCamStore.getState().project.geometry[0].loops ?? []) as Chain[])
    .filter((loop) => loop.id.startsWith('mec:') && loop.closed)
  const chain = closed
    .filter((loop) => { const b = box(loop); return Math.hypot(b.x - pick.centre.x, b.y - pick.centre.y) < 0.5 && Math.abs(b.w - pick.width) < 0.5 })
    .sort((a, b) => pick.level === 'top' ? zOfName(b) - zOfName(a) : zOfName(a) - zOfName(b))[0]
  expect(chain, JSON.stringify(closed.map((loop) => ({ name: loop.name, ...box(loop) })))).toBeDefined()
  fireEvent.click(document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]')[closed.indexOf(chain)])
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('Heights'))
  return chain
}

async function createAndCompute(operationType: string) {
  fireEvent.click(screen.getByTestId('op-create'))
  const created = useCamStore.getState().project.setups[0].operations[0]
  expect(created.type).toBe(operationType)
  await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, created.id) })
  const computed = useCamStore.getState().project.setups[0].operations[0]
  const cuts = (computed.toolpathMoves ?? [])
    .filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
  const zs = cuts.map((move) => move.z).filter((z): z is number => z !== undefined)
  const zMin = zs.length ? Math.min(...zs) : NaN
  console.log(`[recess-floor] ${operationType}: status=${computed.status} error=${computed.errorMessage ?? '-'}` +
    ` cuts=${cuts.length} zMin=${zMin.toFixed(3)} params=${JSON.stringify({
      heightReference: (computed.params as { heightReference?: string }).heightReference,
      planeOffset: (computed.params as { planeOffset?: number }).planeOffset })}`)
  expect(computed.errorMessage).toBeUndefined()
  expect(computed.status).toBe('ready')
  expect(cuts.length).toBeGreaterThan(0)
  return { computed, zMin }
}

beforeEach(() => {
  vi.stubGlobal('Worker', InProcessToolpathWorker)
  act(() => { useCamStore.getState().newProject() })
  stlCache.load.mockReset()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

const RELIEF_RIM: Pick = { centre: { x: 0, y: 0 }, width: 22.4, level: 'top' }
const RELIEF_FLOOR_EDGE: Pick = { centre: { x: 0, y: 0 }, width: 22.4, level: 'bottom' }
const SHAFT_BORE: Pick = { centre: { x: 0, y: 0 }, width: 8, level: 'top' }
const OLD_BORE: Pick = { centre: { x: 0, y: 3 }, width: 18, level: 'top' }

describe('WO-3066: a new Pocket / Adaptive on a blind STL recess starts at its floor', () => {
  it.each([
    { label: '2D Pocket on the NEMA17 relief rim', operation: '2D Pocket', type: 'pocket_2d', pick: RELIEF_RIM },
    { label: '2D Pocket on the NEMA17 relief floor edge', operation: '2D Pocket', type: 'pocket_2d', pick: RELIEF_FLOOR_EDGE },
    { label: '2D Adaptive on the NEMA17 relief rim', operation: '2D Adaptive Clearing', type: 'adaptive_clearing_2d', pick: RELIEF_RIM },
  ])('$label: Bottom starts 2.2 mm below the top, the cut stops on the floor', async ({ operation, type, pick }) => {
    seedProject(NEMA17)
    await openWithPick(operation, 'RF 3mm Flat', pick)
    expect(bottomRow()).toEqual({ source: 'Stock top - 2.200 mm', resolved: 'WCS 1.800 mm' })
    const { computed, zMin } = await createAndCompute(type)
    expect(computed.params).toMatchObject({ heightReference: 'stock_top', planeOffset: -2.2 })
    expect(zMin).toBeCloseTo(RELIEF_FLOOR, 6)
  })

  it.each([
    { label: 'NEMA17 8 mm shaft bore', file: NEMA17, pick: SHAFT_BORE },
    { label: 'earlier plate (fixture) 18 mm bore', file: OLD_PLATE, pick: OLD_BORE },
  ])('2D Pocket on the $label (through) keeps the 5 mm from stock top default', async ({ file, pick }) => {
    seedProject(file)
    await openWithPick('2D Pocket', 'RF 3mm Flat', pick)
    expect(bottomRow()).toEqual({ source: 'Stock top - 5.000 mm', resolved: 'WCS -1.000 mm' })
    const { computed, zMin } = await createAndCompute('pocket_2d')
    expect(computed.params).toMatchObject({ heightReference: 'stock_top', planeOffset: -5 })
    expect(zMin).toBeCloseTo(PLATE_TOP - 5, 6)
  })

  it('the operator\'s own depth stays his', async () => {
    seedProject(NEMA17)
    await openWithPick('2D Pocket', 'RF 3mm Flat', RELIEF_RIM)
    expect(bottomRow().source).toBe('Stock top - 2.200 mm')
    fireEvent.click(screen.getByRole('button', { name: /Expand Bottom/i }))
    const depth = within(screen.getByTestId('standard-height-bottom-offset-control')).getByRole('textbox')
    fireEvent.change(depth, { target: { value: '1' } })
    fireEvent.blur(depth)
    await waitFor(() => expect(bottomRow().source).toBe('Stock top - 1.000 mm'))
    const { computed, zMin } = await createAndCompute('pocket_2d')
    expect(computed.params).toMatchObject({ heightReference: 'stock_top', planeOffset: -1 })
    expect(zMin).toBeCloseTo(PLATE_TOP - 1, 6)
  })

  it('"Geometry plane" on an STL chain is that chain\'s Z and stays named', async () => {
    seedProject(NEMA17)
    await openWithPick('2D Pocket', 'RF 3mm Flat', RELIEF_FLOOR_EDGE)
    fireEvent.click(screen.getByRole('button', { name: /Expand Bottom/i }))
    fireEvent.change(screen.getByTestId('standard-height-bottom-source-control'), { target: { value: 'geometry_plane' } })
    // The kept height is 1.8 - 1.8 off the chain's own plane: a zero offset
    // that may print with either sign.
    await waitFor(() => expect(bottomRow().source).toMatch(/^Geometry plane [+-] 0\.000 mm$/))
    expect(bottomRow().resolved).toBe('WCS 1.800 mm')
    expect((screen.getByTestId('standard-height-bottom-source-control') as HTMLSelectElement).value).toBe('geometry_plane')
    const { computed, zMin } = await createAndCompute('pocket_2d')
    expect(computed.params).toMatchObject({ heightReference: 'geometry_face' })
    expect((computed.params as { planeOffset: number }).planeOffset).toBeCloseTo(0, 9)
    expect(zMin).toBeCloseTo(RELIEF_FLOOR, 6)
  })
})

describe('WO-3066: the recess floor reader', () => {
  const square = (id: string, half: number, z: number | undefined, cx = 0): Loop2D => ({
    id, closed: true, type: 'hole', layerId: '__mesh_edge_chains__', area: 4 * half * half, z,
    points: [{ x: cx - half, y: -half }, { x: cx + half, y: -half }, { x: cx + half, y: half }, { x: cx - half, y: half }],
  })
  const plate = [
    square('outline-top', 30, 4), square('outline-bottom', 30, 0),
    square('relief-rim', 11, 4), square('relief-floor', 11, 1.8),
    square('bore-top', 4, 1.8), square('bore-bottom', 4, 0),
    square('pocket-rim', 3, 4, 20), square('pocket-floor', 3, 3, 20),
  ]

  it('reads a blind rim, a blind floor edge, and the shallowest of several', () => {
    expect(stlRecessFloorLocalZ(plate, ['relief-rim'])).toBe(1.8)
    expect(stlRecessFloorLocalZ(plate, ['relief-floor'])).toBe(1.8)
    expect(stlRecessFloorLocalZ(plate, ['relief-rim', 'pocket-rim'])).toBe(3)
    // Rounded underside: no chain at the part bottom (Z 0), the relief floor
    // is the lowest chain and is still a floor.
    const roundedUnderside = plate.filter((loop) => loop.z !== 0)
    expect(stlRecessFloorLocalZ(roundedUnderside, ['relief-rim'])).toBe(1.8)
  })

  it('keeps the default for a through wall, a lone chain, or a loop with no Z', () => {
    expect(stlRecessFloorLocalZ(plate, ['bore-top'])).toBeUndefined()
    expect(stlRecessFloorLocalZ(plate, ['outline-top'])).toBeUndefined()
    expect(stlRecessFloorLocalZ(plate, ['relief-rim', 'bore-top'])).toBeUndefined()
    expect(stlRecessFloorLocalZ([...plate, square('lone', 2, 4, -20)], ['lone'])).toBeUndefined()
    const sketch = plate.map((loop) => ({ ...loop, z: undefined }))
    expect(stlRecessFloorLocalZ(sketch, ['relief-rim'])).toBeUndefined()
    expect(stlRecessFloorLocalZ(plate, [])).toBeUndefined()
  })

  it('leaves the Geometry plane of loops with no Z where it was', () => {
    const setup = { wcs: { origin: { x: 0, y: 0, z: 0 } } } as unknown as Setup
    const sceneStock = { fixedStocks: [] } as never
    const geometry = (loops: Loop2D[]) => [{
      id: 'g', name: 'g', filename: 'g.dxf', type: 'curves_2d', loaded: true, loops,
      position: { x: 0, y: 0, z: 7 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0, y: 0, z: 0 } },
    }] as unknown as ImportedGeometry[]
    const noZ = [{ ...square('a', 1, undefined), layerId: 'layer' }]
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, geometry(noZ), 'g', [], ['a'])).toBe(7)
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, geometry([square('a', 1, 1.8)]), 'g', [], ['a'])).toBeCloseTo(8.8, 9)
    const tipped = geometry([square('a', 1, 1.8)]).map((g) => ({ ...g, rotation: { x: Math.PI / 2, y: 0, z: 0 } }))
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, tipped, 'g', [], ['a'])).toBe(7)
  })
})
