// @vitest-environment jsdom
// WO-2090: the Model screen's Shell and Draft work on an STL body.
//
// Driven through the product's own route, on the app's own STL export of
// test_fixtures/brep/fix_plate_holes.step (a 100 x 60 x 10 mm plate with six
// through holes; the copy kept with this order's evidence): the store's "Edit
// as model" action opens it (WO-1935), the REAL SolidsWorkbenchPage draws it,
// and each edit goes through the Model screen's own rail button, the viewport
// clicks and the tool's own dialog (ShellDialog, DraftDialog) - its preview
// and Apply - then the Model screen's Undo/Redo. The scene runtime is faked
// (jsdom has no WebGL; a test aims its ray); the STL cache serves the real
// fixture bytes; the boolean kernel, planning and the store's
// addMeshEdit/removeMeshEdit all run for real.
//
// On main Shell and Draft are disabled with only an STL open (the negative
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
const analysis = await import('../../mesh/analysis')
const topology = await import('../../mesh/recognition/topology')
type ImportedGeometry = import('../../types').ImportedGeometry
type MeshEditRecord = import('../../mesh/edit').MeshEditRecord
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>

const PLATE = '../evidence/WO-2090/export-fix-plate-holes.stl'
const NAME = 'export-fix-plate-holes'

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function stlRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 60, z: 10 }, size: { x: 100, y: 60, z: 10 }, center: { x: 50, y: 30, z: 5 } },
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
  cache.set(id, fixtureBytes(PLATE))
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
function shownBody(runtime: FakeSceneRuntime): THREE.Mesh | undefined {
  return stlRoot(runtime)?.children.find((c) => c.userData.isBodyPresentationMesh === true) as THREE.Mesh | undefined
}
function shownFacets(runtime: FakeSceneRuntime): number {
  const body = shownBody(runtime)
  return body === undefined ? 0 : body.geometry.getAttribute('position').count / 3
}
/** The largest X of the part as the Model screen draws it. */
function shownMaxX(runtime: FakeSceneRuntime): number {
  const position = shownBody(runtime)?.geometry.getAttribute('position')
  let max = -Infinity
  for (let i = 0; position !== undefined && i < position.count; i++) max = Math.max(max, position.getX(i))
  return max
}
/** Straight down onto the part at (x, y). */
function aimDown(runtime: FakeSceneRuntime, x: number, y: number): void {
  runtime.rayOverride = { origin: { x, y, z: 50 }, direction: { x: 0, y: 0, z: -1 } }
}
/** Straight up onto the part's underside at (x, y). */
function aimUp(runtime: FakeSceneRuntime, x: number, y: number): void {
  runtime.rayOverride = { origin: { x, y, z: -50 }, direction: { x: 0, y: 0, z: 1 } }
}
/** Along -X onto the part's +X side at (y, z). */
function aimAtPlusXSide(runtime: FakeSceneRuntime, y: number, z: number): void {
  runtime.rayOverride = { origin: { x: 200, y, z }, direction: { x: -1, y: 0, z: 0 } }
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

/** The part resolved from its bytes and journal, welded: one closed solid.
 *  Returns its volume. */
function closedSolidVolume(bytes: ArrayBuffer, records: MeshEditRecord[]): number {
  const resolved = edit.resolveEditedStlMesh(bytes, records)
  const w = topology.weldMesh(resolved.mesh)
  const mesh = { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
  const health = analysis.analyzeMesh(mesh, { checkSelfIntersections: true })
  expect(health.watertight).toBe(true)
  expect(health.nonManifoldEdgeCount).toBe(0)
  expect(health.selfIntersections).toBe(false)
  const measured = analysis.measureMesh(mesh)
  expect(measured.componentCount).toBe(1)
  return measured.signedVolume
}

describe('WO-2090: Shell and Draft on an STL body in the Model screen', () => {
  it('Shell hollows the plate to a 2 mm wall opening the clicked top face: one journal entry, a closed solid, Undo restores', async () => {
    await openInModelScreen('plate')
    const runtime = await mountModelScreen('plate')
    const facetsBefore = shownFacets(runtime)
    expect(facetsBefore).toBe(900)

    // No kernel body in this model: the open STL alone makes Shell available.
    const button = screen.getByTestId('workbench-shell') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    // A click on the top face, clear of the six holes, picks it to open.
    aimDown(runtime, 60, 50)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toBe('1 face to open'))

    const thickness = screen.getByLabelText('Shell thickness') as HTMLInputElement
    expect(thickness.value).toBe('2')
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(facetsBefore)
    expect(journal('plate')).toBeUndefined() // a preview records nothing

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    await waitFor(() => expect(screen.queryByTestId('shell-face-count')).toBeNull())
    const entry = journal('plate')![0]
    expect(entry.kind).toBe(edit.BOOLEAN_BODY_KIND)
    expect(entry.parameters).toMatchObject({ operation: 'subtract', shape: 'shell', thicknessMm: 2 })
    const faces = (entry.parameters as { faces: Array<{ point: number[]; normal: number[] }> }).faces
    expect(faces).toHaveLength(1)
    expect(faces[0].normal).toEqual([0, 0, 1])
    expect(faces[0].point[2]).toBeCloseTo(10, 5)
    expect(edit.describeMeshEdit(entry)).toMatch(/^Shelled to a 2\.00 mm wall, 1 face open at /)

    // The part redraws from the journal, hollowed: one closed solid, far
    // lighter than the plate.
    await waitFor(() => expect(shownFacets(runtime)).toBeGreaterThan(facetsBefore), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBe(0)
    const plateVolume = closedSolidVolume(cache.get('plate')!, [])
    const shellVolume = closedSolidVolume(cache.get('plate')!, journal('plate')!)
    expect(shellVolume).toBeLessThan(plateVolume * 0.5)
    expect(messages.filter((m) => m.severity === 'error')).toEqual([])

    await undoAndRedoRoundTrip('plate', withoutId(entry), runtime, facetsBefore)
  }, 90_000)

  it('Draft turns the clicked +X side 3 deg about the neutral bottom face: one journal entry, a closed solid, Undo restores', async () => {
    await openInModelScreen('plate')
    const runtime = await mountModelScreen('plate')
    const facetsBefore = shownFacets(runtime)
    expect(shownMaxX(runtime)).toBe(100)

    const button = screen.getByTestId('workbench-draft') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    // The neutral face: the underside, clicked from below. Then confirm it.
    aimUp(runtime, 60, 50)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('draft-face-count').textContent).toBe('1 neutral face, 0 draft faces'))
    fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
    // The face to draft: the +X side.
    aimAtPlusXSide(runtime, 30, 5)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('draft-face-count').textContent).toBe('1 neutral face, 1 draft face'))

    commitNumber('draft-angle', '3')
    await waitFor(() => expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBe(facetsBefore) // a draft only moves corners
    expect(journal('plate')).toBeUndefined()

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    await waitFor(() => expect(screen.queryByTestId('draft-face-count')).toBeNull())
    const entry = journal('plate')![0]
    expect(entry.kind).toBe(edit.BOOLEAN_BODY_KIND)
    expect(entry.parameters).toMatchObject({ operation: 'subtract', shape: 'draft', angleDeg: 3, pullDirection: [0, 0, -1] })
    expect((entry.parameters as { neutralPoint: number[] }).neutralPoint[2]).toBeCloseTo(0, 6)
    expect(edit.describeMeshEdit(entry)).toMatch(/^Drafted 1 face 3\.00 deg at /)

    // The part redraws with the side leaning out 10 tan 3 deg at the top (the
    // part grows away from the neutral face, the kernel's convention).
    const lean = 10 * Math.tan((3 * Math.PI) / 180)
    await waitFor(() => expect(shownMaxX(runtime)).toBeCloseTo(100 + lean, 4), { timeout: 20_000 })
    const plateVolume = closedSolidVolume(cache.get('plate')!, [])
    const draftedVolume = closedSolidVolume(cache.get('plate')!, journal('plate')!)
    expect(draftedVolume - plateVolume).toBeCloseTo((60 * 10 * lean) / 2, 2)
    expect(messages.filter((m) => m.severity === 'error')).toEqual([])

    await undoAndRedoRoundTrip('plate', withoutId(entry), runtime, facetsBefore)
    await waitFor(() => expect(shownMaxX(runtime)).toBe(100), { timeout: 20_000 })
  }, 90_000)
})
