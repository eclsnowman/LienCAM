// @vitest-environment jsdom

// A 2D Pocket on an STL's bore picked ALONE. An STL's bores load as edge chains
// typed 'hole' (nested inside the plate outline), and Pocket read a selection of
// holes only as islands with no boundary: "Pocket: the selected loops contain no
// usable closed boundary to pocket." - while 2D Adaptive clears the same pick
// (WO-2859). Found by the alpha.3 usage sweep on Sample Parts/plate.stl's 18 mm
// bore; the owner's NEMA17 plate (src/tests/evidence/WO-2935/attempt3) has the
// same shape in its 22.4 mm boss relief and 8 mm shaft bore.
//
// Driven through the real New Operation dialog and the store's compute seam
// with the production toolpath worker in-process (the WO-2859 harness).

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

const GEO_ID = 'pocket-bore-plate'
const SETUP_ID = 'pocket-bore-setup'
const STOCK_ID = 'pocket-bore-stock'
const TOOLS = [
  { id: 'pb-3', name: 'PB 3mm Flat', diameter: 3 },
  { id: 'pb-6', name: 'PB 6mm Flat', diameter: 6 },
]

// WO-3063: Sample Parts/plate.stl is now the NEMA17 plate; the earlier plate's exact bytes are a fixture.
const OLD_PLATE = 'src/tests/fixtures/plate-old-18mm-bore.stl'
const NEMA17 = 'src/tests/evidence/WO-2935/attempt3/Plate-NEMA17.stl'

function bytesOf(file: string): ArrayBuffer {
  const bytes = readFileSync(file)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** One 60 x 60 x 4 mm STL plate centred on the origin, no loops derived yet. */
function seedProject(file: string): void {
  stlCache.load.mockResolvedValue(bytesOf(file))
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID, name: 'Plate', filename: file.split('/').pop()!, type: 'mesh', format: 'stl',
    loaded: true, stockId: STOCK_ID,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 4 },
      size: { x: 60, y: 60, z: 4 }, center: { x: 0, y: 0, z: 2 },
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
    id: STOCK_ID, name: 'Pocket Bore Stock', mode: 'explicit',
    bounds: {
      min: { x: -35, y: -35, z: 0 }, max: { x: 35, y: 35, z: 4 },
      size: { x: 70, y: 70, z: 4 }, center: { x: 0, y: 0, z: 2 },
    },
    position: { x: 0, y: 0, z: 0 },
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

/** 2D Pocket -> tool -> Geometry -> the plate -> tick the topmost closed chain
 *  of `width` mm centred at `centre` -> Create -> compute. */
async function pocketChain(toolName: string, centre: { x: number; y: number }, width: number) {
  render(createElement(NewOperationModal))
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('2D Pocket'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(toolName))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
  await waitFor(() => {
    expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
  })
  const closed = ((useCamStore.getState().project.geometry[0].loops ?? []) as Chain[])
    .filter((loop) => loop.id.startsWith('mec:') && loop.closed)
  const zOf = (loop: Chain) => Number(/\(Z ([-\d.]+)\)/.exec(loop.name ?? '')?.[1] ?? 0)
  const chain = closed
    .filter((loop) => { const b = box(loop); return Math.hypot(b.x - centre.x, b.y - centre.y) < 0.5 && Math.abs(b.w - width) < 0.5 })
    .sort((a, b) => zOf(b) - zOf(a))[0]
  expect(chain, JSON.stringify(closed.map((loop) => ({ name: loop.name, type: loop.type, ...box(loop) })))).toBeDefined()
  fireEvent.click(document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]')[closed.indexOf(chain)])
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('op-create'))
  const created = useCamStore.getState().project.setups[0].operations[0]
  expect(created.type).toBe('pocket_2d')
  expect((created.params as { loopIds: string[] }).loopIds).toEqual([chain.id])
  await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_ID, created.id) })
  const computed = useCamStore.getState().project.setups[0].operations[0]
  const moves = computed.toolpathMoves ?? []
  const cuts = moves.filter((move) => move.type === 'feed' || move.type === 'arc_cw' || move.type === 'arc_ccw')
    .filter((move) => move.x !== undefined && move.y !== undefined)
  const radii = cuts.map((move) => Math.hypot(move.x! - centre.x, move.y! - centre.y))
  const zs = cuts.map((move) => move.z).filter((z): z is number => z !== undefined)
  console.log(`[pocket-bore] ${toolName} on ${chain.name} (${chain.type}, ${width} mm): status=${computed.status}` +
    ` error=${computed.errorMessage ?? '-'} moves=${moves.length} cuts=${cuts.length}` +
    ` rMax=${radii.length ? Math.max(...radii).toFixed(3) : '-'} zMin=${zs.length ? Math.min(...zs).toFixed(3) : '-'}`)
  return { computed, cuts, chain }
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

describe('2D Pocket clears an STL bore picked alone', () => {
  it.each([
    { label: 'earlier plate (fixture) 18 mm bore, 6 mm flat', file: OLD_PLATE, tool: 'PB 6mm Flat', centre: { x: 0, y: 3 }, width: 18 },
    { label: 'NEMA17 plate 22.4 mm boss relief, 6 mm flat', file: NEMA17, tool: 'PB 6mm Flat', centre: { x: 0, y: 0 }, width: 22.4 },
    { label: 'NEMA17 plate 22.4 mm boss relief, 3 mm flat', file: NEMA17, tool: 'PB 3mm Flat', centre: { x: 0, y: 0 }, width: 22.4 },
    { label: 'NEMA17 plate 8 mm shaft bore, 3 mm flat', file: NEMA17, tool: 'PB 3mm Flat', centre: { x: 0, y: 0 }, width: 8 },
  ])('$label', async ({ file, tool, centre, width }) => {
    seedProject(file)
    const { computed, cuts } = await pocketChain(tool, centre, width)
    expect(computed.errorMessage).toBeUndefined()
    expect(computed.status).toBe('ready')
    expect(cuts.length).toBeGreaterThan(0)
    // Every cut stays inside the picked loop, a tool radius in from its wall.
    const toolRadius = TOOLS.find((t) => t.name === tool)!.diameter / 2
    for (const move of cuts) {
      expect(Math.hypot(move.x! - centre.x, move.y! - centre.y)).toBeLessThanOrEqual(width / 2 - toolRadius + 0.02)
    }
  })
})
