// @vitest-environment jsdom
//
// WO-2198 (workholding assemblies, slice 6): reuse a vise through the RENDERED
// screens - Place another and Export in the vise's Properties, the tree rows
// of both vises, and the tree's Import taking the exported file into another
// project. The store behind them is proven in reuse.wo2198.test.ts; this file
// proves the controls reach it.
//
// jsdom's localStorage is broken under vitest's node flags and the store
// persists on every set(): install an in-memory Storage first (same shim as
// viseScreens.wo2172.test.tsx).
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
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Vec3 } from '../../types'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, bytes: ArrayBuffer) => { cache.stl.set(id, bytes) }),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
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
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useClampUi } = await import('../../components/workholding/ClampEditor')

afterEach(cleanup)

const ZERO = { x: 0, y: 0, z: 0 }

/** A binary STL of an axis-aligned box with its corner at `corner`. */
function boxStl(size: Vec3, corner: Vec3): ArrayBuffer {
  const c = (i: number): Vec3 => ({
    x: corner.x + (i & 1 ? size.x : 0), y: corner.y + (i & 2 ? size.y : 0), z: corner.z + (i & 4 ? size.z : 0),
  })
  const tris = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  const buffer = new ArrayBuffer(84 + 50 * (tris.length / 3))
  const view = new DataView(buffer)
  view.setUint32(80, tris.length / 3, true)
  for (let t = 0; t < tris.length / 3; t++) {
    for (let v = 0; v < 3; v++) {
      const p = c(tris[t * 3 + v])
      view.setFloat32(84 + 50 * t + 12 + v * 12, p.x, true)
      view.setFloat32(84 + 50 * t + 16 + v * 12, p.y, true)
      view.setFloat32(84 + 50 * t + 20 + v * 12, p.z, true)
    }
  }
  return buffer
}

function body(id: string, name: string, position: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -50, y: -10, z: 0 }, max: { x: 50, y: 10, z: 40 },
      size: { x: 100, y: 20, z: 40 }, center: { x: 0, y: 0, z: 20 },
    },
    position, rotation: ZERO, loaded: true, workholding: true,
  } as ImportedGeometry
}

function state() { return useCamStore.getState() }
function instances() { return state().project.workholding?.instances ?? [] }
const inch = () => state().appSettings.displayUnits === 'inch'
const shown = (mm: number) => (inch() ? String(parseFloat((mm / 25.4).toFixed(4))) : String(mm))

function typeInto(input: HTMLElement, text: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

let blobs: Blob[] = []
let downloads: string[] = []

beforeEach(() => {
  cache.stl.clear()
  cache.stl.set('geo-fixed', boxStl({ x: 100, y: 20, z: 40 }, { x: 3, y: 4, z: 5 }))
  cache.stl.set('geo-jaw', boxStl({ x: 100, y: 20, z: 40 }, ZERO))
  blobs = []
  downloads = []
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return 'blob:wo2198' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
  act(() => {
    state().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
    useClampUi.getState().selectClamp(null)
    state().addGeometry(body('geo-fixed', 'Fixed body', ZERO))
    state().addGeometry(body('geo-jaw', 'Moving jaw', { x: 0, y: 50, z: 0 }))
    const id = state().makeVise({
      name: 'Bench vise', fixedGeometryId: 'geo-fixed', jawGeometryId: 'geo-jaw',
      slide: { kind: 'jaw-axis', axis: 'y' }, minMm: 0, maxMm: 100, setupId: state().project.activeSetupId,
    })!
    state().setWorkholdingJointValue(id, 'moving', 20)
    state().setSelectedGeometry('geo-fixed')
  })
  delete (window as unknown as { __cncViewport?: unknown }).__cncViewport
})

/** The text of a Blob in jsdom (FileReader: jsdom's Blob has no text()). */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function fileOf(text: string, name: string): File {
  const file = new File([text], name, { type: 'application/json' })
  if (typeof (file as { text?: unknown }).text !== 'function') Object.assign(file, { text: async () => text })
  return file
}

describe('WO-2198: reuse a vise through the screens', () => {
  it('Place another -> the new vise is selected; its own opening; the tree lists both and selects each', async () => {
    const [first] = instances()
    render(<><PropertiesPanel /><DesignTree /></>)
    expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe(shown(20))

    const d0 = state().projectHistory.length
    fireEvent.click(screen.getByTestId('vise-place-another'))
    expect(state().projectHistory.length).toBe(d0 + 1)
    const second = instances()[1]
    expect(second.definitionId).toBe(first.definitionId)
    expect(state().project.workholding!.definitions).toHaveLength(1)
    // The new vise is the one Properties now shows.
    expect(useClampUi.getState().selectedClampId).toBe(second.id)
    expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe(shown(20))

    typeInto(screen.getByTestId('vise-opening-input'), shown(50))
    expect(instances().map((i) => i.jointValuesMm.moving)).toEqual([20, 50])

    // Its own place: X and Turn typed in its panel move it alone, one undo step each.
    const firstPose = structuredClone(instances()[0].worldPose)
    const d1 = state().projectHistory.length
    typeInto(screen.getByTestId('vise-position-x'), shown(300))
    typeInto(screen.getByTestId('vise-turn-input'), '90')
    expect(state().projectHistory.length).toBe(d1 + 2)
    expect(instances()[1].worldPose.position.x).toBeCloseTo(300, 3)
    expect(instances()[1].worldPose.rotation.z).toBe(90)
    expect(instances()[0].worldPose).toEqual(firstPose)

    // The tree: two vise rows; the first selects its fixed body, the second itself.
    const rows = screen.getAllByTestId('tree-vise-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByTestId(`tree-vise-${first.id}`).querySelector('[data-testid="tree-vise-bodies"]')).not.toBeNull()
    expect(screen.getByTestId(`tree-vise-${second.id}`).querySelector('[data-testid="tree-vise-bodies"]')).toBeNull()
    fireEvent.click(rows[0])
    expect(state().viewer.selectedGeometryId).toBe('geo-fixed')
    expect(useClampUi.getState().selectedClampId).toBeNull()
    expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe(shown(20))
    fireEvent.click(rows[1])
    expect(useClampUi.getState().selectedClampId).toBe(second.id)
    expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe(shown(50))
  })

  it('Export -> a file; Import on Geometry in a new project adds it as that project\'s own vise, selected', async () => {
    const [source] = instances()
    const sourceDefinition = state().project.workholding!.definitions[0]
    const { unmount } = render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('vise-export'))
    await waitFor(() => expect(downloads).toEqual(['Bench vise.workholding.json']))
    const text = await blobText(blobs[0])
    unmount()

    act(() => { state().newProject() })
    render(<><DesignTree /><PropertiesPanel /></>)
    const input = screen.getByTestId('geo-file-input') as HTMLInputElement
    expect(input.accept).toContain('.json')
    await act(async () => {
      fireEvent.change(input, { target: { files: [fileOf(text, 'Bench vise.workholding.json')] } })
    })
    await waitFor(() => expect(instances()).toHaveLength(1))
    const model = state().project.workholding!
    expect(model.definitions[0].name).toBe('Bench vise')
    expect(model.definitions[0].id).not.toBe(sourceDefinition.id)
    expect(instances()[0].id).not.toBe(source.id)
    expect(instances()[0].jointValuesMm).toEqual({ moving: 20 })
    // Selected, and shown in the tree and Properties.
    await waitFor(() => expect(screen.getByTestId('vise-props')).toBeTruthy())
    expect((screen.getByTestId('vise-opening-input') as HTMLInputElement).value).toBe(shown(20))
    expect(screen.getAllByTestId('tree-vise-row')).toHaveLength(1)
    expect(state().consoleEvents.some((e) => e.message.includes('Imported the vise "Bench vise"'))).toBe(true)
  })

  it('a file that is not a vise or clamp file only says it could not be read', async () => {
    render(<DesignTree />)
    const before = structuredClone(state().project.workholding)
    const d0 = state().projectHistory.length
    await act(async () => {
      fireEvent.change(screen.getByTestId('geo-file-input'), { target: { files: [fileOf('{"hello":1}', 'notes.json')] } })
    })
    await waitFor(() => expect(state().consoleEvents.some((e) => e.message.includes('"notes.json" could not be read as a vise or clamp.'))).toBe(true))
    expect(state().project.workholding).toEqual(before)
    expect(state().projectHistory.length).toBe(d0)
  })
})
