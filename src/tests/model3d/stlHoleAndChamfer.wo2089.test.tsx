// @vitest-environment jsdom
// WO-2089: the Model screen's Hole and Chamfer work on an STL body.
//
// Driven through the product's own route, on Operator's part (Sample Parts/
// obj_1_Platte C.stl, the fixture copy): the store's "Edit as model" action
// opens it (WO-1935), the REAL SolidsWorkbenchPage draws it, and each edit goes
// through the Model screen's own rail button, the viewport click and the
// tool's own dialog (HoleDialog, ChamferDialog) - its preview and Apply - then
// the Model screen's Undo/Redo. The scene runtime is faked (jsdom has no
// WebGL; a test aims its ray); the STL cache serves the real fixture bytes;
// the boolean kernel, planning and the store's addMeshEdit/removeMeshEdit all
// run for real.
//
// On main these tools are disabled with only an STL open (the negative
// control: the first `disabled` assertion of each test fails there).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import * as THREE from 'three'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async () => {}, loadCachedStep: async () => null, removeCachedStep: async () => {},
}))

const { useCamStore } = await import('../../store')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
const edit = await import('../../mesh/edit')
const recognition = await import('../../mesh/recognition')
type ImportedGeometry = import('../../types').ImportedGeometry
type MeshEditRecord = import('../../mesh/edit').MeshEditRecord
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>

const PLATTE = '../mesh/fixtures/obj_1_Platte C.stl'
const NAME = 'obj_1_Platte C'

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function stlRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 98, y: 98, z: 0 }, max: { x: 158, y: 158, z: 4 }, size: { x: 60, y: 60, z: 4 }, center: { x: 128, y: 128, z: 2 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let messages: Array<{ severity?: string; message: string }> = []

beforeEach(() => {
  cache.clear()
  act(() => { useCamStore.getState().newProject() })
  messages = []
  useCamStore.getState().addConsoleEvent = (event) => { messages.push(event) }
})

afterEach(() => {
  cleanup()
  useCamStore.getState().addConsoleEvent = realAddConsoleEvent
})

const state = () => useCamStore.getState()
const journal = (id: string): MeshEditRecord[] | undefined => state().project.geometry.find((g) => g.id === id)?.meshEdits

async function openInModelScreen(id: string): Promise<void> {
  cache.set(id, fixtureBytes(PLATTE))
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow(id, NAME)] } }))
  })
  let result: Awaited<ReturnType<ReturnType<typeof state>['wrapImportedGeometryAsModelItem']>> | undefined
  await act(async () => { result = await state().wrapImportedGeometryAsModelItem(id) })
  expect(result?.ok).toBe(true)
}

async function mountModelScreen(id: string): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 20_000 })
  return runtime
}

/** The live STL scene root (the page rebuilds it after every edit). */
function stlRoot(runtime: FakeSceneRuntime): THREE.Group | undefined {
  const live = runtime.addedObjects.filter((o) =>
    o.userData.stlModelBodyGeoId !== undefined && !runtime.removedObjects.includes(o))
  return live[live.length - 1] as THREE.Group | undefined
}
function previewFacets(runtime: FakeSceneRuntime): number {
  const preview = stlRoot(runtime)?.children.find((c) => c.userData.stlModelBodyPreview === true) as THREE.Mesh | undefined
  return preview === undefined ? 0 : preview.geometry.getAttribute('position').count / 3
}
function shownFacets(runtime: FakeSceneRuntime): number {
  const body = stlRoot(runtime)?.children.find((c) => c.userData.isBodyPresentationMesh === true) as THREE.Mesh | undefined
  return body === undefined ? 0 : body.geometry.getAttribute('position').count / 3
}
/** Straight down onto the part at (x, y). */
function aimDown(runtime: FakeSceneRuntime, x: number, y: number): void {
  runtime.rayOverride = { origin: { x, y, z: 50 }, direction: { x: 0, y: 0, z: -1 } }
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')
function commitNumber(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}
function withoutId(record: MeshEditRecord): Omit<MeshEditRecord, 'id'> {
  const { id: _ignored, ...rest } = record
  return rest
}

async function undoAndRedoRoundTrip(id: string, expected: Omit<MeshEditRecord, 'id'>, runtime: FakeSceneRuntime, facetsBefore: number): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-undo'))
  // removeMeshEdit writes an emptied journal as ABSENT (ADR-0051 s1.1), and
  // the part redraws as imported.
  await waitFor(() => expect(journal(id)).toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(shownFacets(runtime)).toBe(facetsBefore), { timeout: 20_000 })
  fireEvent.click(screen.getByTestId('workbench-redo'))
  await waitFor(() => expect(journal(id)).toHaveLength(1), { timeout: 20_000 })
  expect(withoutId(journal(id)![0])).toEqual(expected)
  fireEvent.click(screen.getByTestId('workbench-undo'))
  await waitFor(() => expect(journal(id)).toBeUndefined(), { timeout: 20_000 })
}

describe('WO-2089: Hole and Chamfer on an STL body in the Model screen', () => {
  it('Hole drills a 6 mm through hole where the operator clicks: one journal entry, the part redrawn with it, Undo restores', async () => {
    await openInModelScreen('platte')
    const runtime = await mountModelScreen('platte')
    const facetsBefore = shownFacets(runtime)
    expect(facetsBefore).toBe(1420)

    // No kernel body in this model: the open STL alone makes Hole available.
    const button = screen.getByTestId('workbench-hole') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    // A click on the top face, clear of the part's own five holes, places it.
    aimDown(runtime, 140, 120)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    expect((screen.getByTestId('hole-seed-x').querySelector('input') as HTMLInputElement).value).toBe('140')
    expect((screen.getByTestId('hole-seed-y').querySelector('input') as HTMLInputElement).value).toBe('120')
    expect((screen.getByTestId('hole-seed-z').querySelector('input') as HTMLInputElement).value).toBe('4')

    fireEvent.change(screen.getByTestId('hole-depth-select'), { target: { value: 'throughAll' } })
    commitNumber('hole-diameter', '6')
    await waitFor(() => expect(screen.getByTestId('hole-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(facetsBefore)
    expect(journal('platte')).toBeUndefined() // a preview records nothing

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('platte')).toHaveLength(1), { timeout: 20_000 })
    await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
    const entry = journal('platte')![0]
    expect(entry.kind).toBe(edit.BOOLEAN_BODY_KIND)
    expect(entry.parameters).toEqual({
      operation: 'subtract', shape: 'hole', center: [140, 120, 4], axisDirection: [0, 0, 1],
      points: [[140, 120, 4]], diameterMm: 6, lengthMm: 5, through: true,
    })
    expect(edit.describeMeshEdit(entry)).toBe('Drilled a 6.00 mm hole, through at 140.00, 120.00, 4.00')
    // No kernel feature was committed alongside it (the guard stops that):
    // the first Undo below takes THIS entry back, so it was the only step.
    expect(screen.queryByTestId('hole-apply-error')).toBeNull()

    // The part redraws from the journal with the hole in it, and the hole is
    // recognised as one: 6 mm, through the 4 mm plate, where it was placed.
    await waitFor(() => expect(shownFacets(runtime)).toBeGreaterThan(facetsBefore), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBe(0)
    const resolved = edit.resolveEditedStlMesh(cache.get('platte')!, journal('platte'))
    const found = recognition.recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds).features
      .filter((f) => f.kind !== 'chamfered-hole')
    expect(found.map((f) => f.kind)).toEqual(['through-hole'])
    expect(found[0].diameterMm).toBeCloseTo(6, 2)
    expect(found[0].axis.origin[0]).toBeCloseTo(140, 3)
    expect(found[0].axis.origin[1]).toBeCloseTo(120, 3)
    expect(messages.filter((m) => m.severity === 'error')).toEqual([])

    await undoAndRedoRoundTrip('platte', withoutId(entry), runtime, facetsBefore)
  }, 90_000)

  it('Chamfer cuts a 0.3 mm chamfer on the clicked sharp edge: one journal entry, Undo restores', async () => {
    await openInModelScreen('platte')
    const runtime = await mountModelScreen('platte')
    const facetsBefore = shownFacets(runtime)

    const button = screen.getByTestId('workbench-chamfer') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    // A click on the top face 0.05 mm inside its +X rim picks that sharp edge -
    // the whole straight edge between the top and the part's own edge chamfer.
    aimDown(runtime, 157.45, 148)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toBe('1 edge selected'))
    const overlay = stlRoot(runtime)?.children.find((c) => c.userData.stlChamferEdges !== undefined)
    expect(overlay?.userData.stlChamferEdges).toHaveLength(1)

    const distance = screen.getByTestId('chamfer-distance').querySelector('input') as HTMLInputElement
    fireEvent.change(distance, { target: { value: '0.3' } })
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    expect(journal('platte')).toBeUndefined()

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('platte')).toHaveLength(1), { timeout: 20_000 })
    await waitFor(() => expect(screen.queryByTestId('chamfer-edge-count')).toBeNull())
    const entry = journal('platte')![0]
    expect(entry.kind).toBe(edit.BOOLEAN_BODY_KIND)
    expect(entry.parameters).toMatchObject({ operation: 'subtract', shape: 'chamfer', distanceMm: 0.3 })
    const edges = (entry.parameters as { edges: Array<{ start: number[]; end: number[]; operation: string }> }).edges
    expect(edges).toHaveLength(1)
    expect(edges[0].operation).toBe('subtract')
    expect(edges[0].start[0]).toBeCloseTo(157.5, 5)
    expect(edges[0].start[2]).toBeCloseTo(4, 5)
    expect(edges[0].end[0]).toBeCloseTo(157.5, 5)
    expect(edit.describeMeshEdit(entry)).toMatch(/^Chamfered 1 edge 0\.30 mm at 157\.50, /)
    await waitFor(() => expect(shownFacets(runtime)).not.toBe(facetsBefore), { timeout: 20_000 })
    expect(messages.filter((m) => m.severity === 'error')).toEqual([])

    await undoAndRedoRoundTrip('platte', withoutId(entry), runtime, facetsBefore)
  }, 90_000)
})
