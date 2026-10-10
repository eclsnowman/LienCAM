// @vitest-environment jsdom
// WO-1961: "Add or cut a shape" lives in the Model screen.
//
// Driven through the product's own route: the store's "Edit as model" action
// opens the WO-1846 plate (WO-1935), the REAL SolidsWorkbenchPage draws it, and
// the edit goes through the Model screen's own Boolean - its rail button, its
// dialog (the STL as target, a box or cylinder as tool, Union adds, Subtract
// cuts), its preview and Apply - then the Model screen's Undo/Redo. The scene
// runtime is faked (jsdom has no WebGL); the STL cache serves the real fixture
// bytes; the boolean kernel, planning and the store's addMeshEdit/removeMeshEdit
// all run for real.
//
// "Identical to what Setup's control wrote" is checked against the entry
// Setup's "Add or cut a shape" (WO-1910, PropertiesPanel `StlShapeEdit`, removed
// here) built: its parameter object, the facets `booleanBodySelection` chose
// on the resolved mesh, minted by `createMeshEditRecord` - every field of the
// record but its random id.
//
// Setup's side: the panel's test ids for the same plate are diffed against the
// ones main rendered (src/tests/evidence/WO-1961/setup-panel-testids-main.txt,
// dumped by this file with WO1961_DUMP_TESTIDS=main against main's panel):
// exactly the shape control's ids are gone, nothing else changed.
import { readFileSync, writeFileSync } from 'node:fs'
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
const { GeometryProperties } = await import('../../components/panels/PropertiesPanel')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
const edit = await import('../../mesh/edit')
type ImportedGeometry = import('../../types').ImportedGeometry
type MeshEditRecord = import('../../mesh/edit').MeshEditRecord
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
// 80 x 80 x 12 plate centred on the origin, top face at Z 12; a through hole
// at (-20, -20), a counterbore at (20, -20), a countersink at (-20, 20) and a
// 12 mm boss (to Z 17) at (20, 20). (0, 0) and (0, -20) are plain plate.
const PLATE = '../evidence/WO-1846/acceptance-plate.stl'
const EVIDENCE = resolve(__dirname, '../evidence/WO-1961')

function stlRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 }, size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
let messages: string[] = []

beforeEach(() => {
  cache.clear()
  act(() => { useCamStore.getState().newProject() })
  messages = []
  useCamStore.getState().addConsoleEvent = (event) => { messages.push(event.message) }
})

afterEach(() => {
  cleanup()
  useCamStore.getState().addConsoleEvent = realAddConsoleEvent
})

const state = () => useCamStore.getState()
const journal = (id: string): MeshEditRecord[] | undefined => state().project.geometry.find((g) => g.id === id)?.meshEdits

async function openInModelScreen(id: string, name: string): Promise<void> {
  cache.set(id, fixtureBytes(PLATE))
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow(id, name)] } }))
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

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}
function fieldValue(testId: string): string {
  return (screen.getByTestId(testId).querySelector('input') as HTMLInputElement).value
}
const previewState = () => screen.getByTestId('boolean-preview-status').getAttribute('data-state')

/** The entry Setup's "Add or cut a shape" wrote for these parameters, minted on
 *  the row's mesh as it stands - everything but the random id. Setup's apply:
 *  `addMeshEdit(geo.id, { kind: BOOLEAN_BODY_KIND, facets:
 *  booleanBodySelection(mesh, wanted), parameters: wanted })` over
 *  `resolveEditedStlMesh(bytes, geo.meshEdits).mesh`. */
async function setupEntry(id: string, wanted: Record<string, unknown>): Promise<Omit<MeshEditRecord, 'id'>> {
  await edit.primeBoringKernel()
  const resolved = edit.resolveEditedStlMesh(cache.get(id)!, journal(id))
  const { id: _ignored, ...rest } = edit.createMeshEditRecord(resolved.mesh, {
    kind: edit.BOOLEAN_BODY_KIND,
    facets: edit.booleanBodySelection(resolved.mesh, wanted),
    parameters: wanted,
    sourceFacetIds: resolved.sourceFacetIds,
  })
  return rest
}
function withoutId(record: MeshEditRecord): Omit<MeshEditRecord, 'id'> {
  const { id: _ignored, ...rest } = record
  return rest
}

async function openBooleanOnPlate(): Promise<void> {
  const button = screen.getByTestId('workbench-boolean') as HTMLButtonElement
  // No kernel body in this model: the open STL alone makes Boolean available.
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByTestId('boolean-tool-shape')).toBeTruthy())
  expect((screen.getByTestId('boolean-target-select') as HTMLSelectElement).value).toBe('stl-body:plate')
  expect(screen.getByTestId('boolean-pick-status').textContent).toMatch(/Target: acceptance plate/)
  // An STL's journal records an added or a cut shape: Intersect is not offered.
  expect((screen.getByTestId('boolean-op-option-intersect') as HTMLOptionElement).disabled).toBe(true)
}

async function undoAndRedoRoundTrip(id: string, expected: Omit<MeshEditRecord, 'id'>): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-undo'))
  // removeMeshEdit writes an emptied journal as ABSENT (ADR-0051 s1.1).
  await waitFor(() => expect(journal(id)).toBeUndefined(), { timeout: 20_000 })
  fireEvent.click(screen.getByTestId('workbench-redo'))
  await waitFor(() => expect(journal(id)).toHaveLength(1), { timeout: 20_000 })
  expect(withoutId(journal(id)![0])).toEqual(expected)
  fireEvent.click(screen.getByTestId('workbench-undo'))
  await waitFor(() => expect(journal(id)).toBeUndefined(), { timeout: 20_000 })
}

describe('WO-1961: Add or cut a shape through the Model screen\'s Boolean', () => {
  it('Union adds a 10 mm box: one journal entry identical to Setup\'s; Model undo removes it', async () => {
    await openInModelScreen('plate', 'acceptance plate')
    const runtime = await mountModelScreen('plate')
    await openBooleanOnPlate()

    // Seeded where Setup's control seeded it: the middle of the part's top.
    expect([fieldValue('boolean-tool-center-x'), fieldValue('boolean-tool-center-y'), fieldValue('boolean-tool-center-z')])
      .toEqual(['0', '0', '17'])
    expect([fieldValue('boolean-tool-size-x'), fieldValue('boolean-tool-size-y'), fieldValue('boolean-tool-size-z')])
      .toEqual(['10', '10', '10'])

    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
    commitField('boolean-tool-center-z', '12') // half in, half out of the top face
    await waitFor(() => expect(previewState()).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    expect(journal('plate')).toBeUndefined() // a preview records nothing

    const wanted = { operation: 'add', shape: 'box', center: [0, 0, 12], size: [10, 10, 10] }
    const expected = await setupEntry('plate', wanted)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('plate')![0])).toEqual(expected)
    expect(journal('plate')![0].parameters).toEqual(wanted)
    await waitFor(() => expect(screen.queryByTestId('boolean-tool-shape')).toBeNull())
    // Setup's edit list names it exactly as it named Setup's own entry.
    expect(edit.describeMeshEdit(journal('plate')![0])).toBe('Added a 10.00 x 10.00 x 10.00 mm box at 0.00, 0.00, 12.00')

    await undoAndRedoRoundTrip('plate', expected)
  }, 60_000)

  it('Subtract cuts a 6 mm cylinder: one journal entry identical to Setup\'s; Model undo removes it', async () => {
    await openInModelScreen('plate', 'acceptance plate')
    const runtime = await mountModelScreen('plate')
    await openBooleanOnPlate()

    fireEvent.change(screen.getByTestId('boolean-tool-shape-select'), { target: { value: 'cylinder' } })
    expect((screen.getByTestId('boolean-op-select') as HTMLSelectElement).value).toBe('cut')
    // A cylinder long enough to pass right through the part, as Setup seeded it.
    expect(fieldValue('boolean-tool-length')).toBe('19')
    expect((screen.getByTestId('boolean-tool-axis') as HTMLSelectElement).value).toBe('z')
    commitField('boolean-tool-diameter', '6')
    commitField('boolean-tool-center-y', '-20')
    commitField('boolean-tool-center-z', '6')
    await waitFor(() => expect(previewState()).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    expect(journal('plate')).toBeUndefined()

    const wanted = {
      operation: 'subtract', shape: 'cylinder', center: [0, -20, 6],
      diameterMm: 6, lengthMm: 19, axisDirection: [0, 0, 1],
    }
    const expected = await setupEntry('plate', wanted)
    const before = stlRoot(runtime)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('plate')![0])).toEqual(expected)
    expect(journal('plate')![0].parameters).toEqual(wanted)
    // The part redraws from the journal (a new body, no preview left on it).
    await waitFor(() => expect(stlRoot(runtime)).not.toBe(before), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBe(0)

    await undoAndRedoRoundTrip('plate', expected)
  }, 60_000)

  it('a box that does not reach the part is refused in the operation\'s own words, and nothing is recorded', async () => {
    await openInModelScreen('plate', 'acceptance plate')
    await mountModelScreen('plate')
    await openBooleanOnPlate()

    fireEvent.change(screen.getByTestId('boolean-op-select'), { target: { value: 'fuse' } })
    commitField('boolean-tool-center-z', '100')
    await waitFor(() => expect(previewState()).toBe('failed'), { timeout: 20_000 })
    expect(screen.getByTestId('boolean-preview-status').textContent).toMatch(/does not touch the part/)
    expect(messages.some((m) => m.startsWith('"acceptance plate": The box does not touch the part'))).toBe(true)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('boolean-apply-error').textContent).toMatch(/does not touch the part/), { timeout: 20_000 })
    expect(journal('plate')).toBeUndefined()
    // Cancel ends it; the part is as it was.
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('boolean-tool-shape')).toBeNull())
    expect(journal('plate')).toBeUndefined()
  }, 60_000)
})

describe('WO-1961: Setup\'s Properties panel for an STL', () => {
  it('has no "Add or cut a shape" rows, and every other test id is as main rendered it', async () => {
    const geo: ImportedGeometry = { ...stlRow('plate', 'acceptance plate'), filename: 'acceptance-plate.stl' }
    cache.set('plate', fixtureBytes(PLATE))
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [geo] } })) })
    const { container } = render(<GeometryProperties geo={geo} />)
    await waitFor(() => expect(screen.getByTestId('geo-bbox-size')).toBeTruthy())
    // Let the panel's cached-STL read settle - on main that read is what put
    // the shape control up.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })

    const ids = [...new Set([...container.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')!))].sort()
    const dump = process.env.WO1961_DUMP_TESTIDS
    if (dump) writeFileSync(resolve(EVIDENCE, `setup-panel-testids-${dump}.txt`), ids.join('\n') + '\n')

    expect(screen.queryByText('Add or cut a shape')).toBeNull()
    expect(ids.filter((id) => id.startsWith('pp-shape-edit'))).toEqual([])
    const main = readFileSync(resolve(EVIDENCE, 'setup-panel-testids-main.txt'), 'utf-8').split(/\r?\n/).filter(Boolean)
    // Main rendered the shape control here (the negative control's witness).
    expect(main).toContain('pp-shape-edit-apply')
    expect(ids).toEqual(main.filter((id) => !id.startsWith('pp-shape-edit')))
  }, 30_000)
})
