// @vitest-environment jsdom
// WO-2117: on an STL, Hole depth changes the depth - not the diameter.
//
// Driven through the product's own route, on the STL the app exports from
// Step Test With Holes (src/tests/fixtures/WO-2080, the re-check's S8 part):
// the store's "Edit as model" opens it (WO-1935), the REAL SolidsWorkbenchPage
// draws it, and the edit goes through the Model screen's own Resize hole rail
// button, the pick bar's Depth field (WO-2091), the viewport click and the
// anchored depth card - its preview and Apply - then the Model screen's Undo.
// The scene runtime is faked (jsdom has no WebGL; the test aims its ray); the
// STL cache serves the real fixture bytes; recognition, planning, the mesh
// edit and the store's addMeshEdit/removeMeshEdit all run for real.
//
// On main the click opens "Resize hole / Current diameter 5 mm" and a typed
// 4 became the DIAMETER (the negative control: the card's title and current
// value assertions fail there).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))

const { useCamStore } = await import('../../store')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
const edit = await import('../../mesh/edit')
const recognition = await import('../../mesh/recognition')
const { computeBoundingBox } = await import('../../mesh/analysis')
type ImportedGeometry = import('../../types').ImportedGeometry
type MeshEditRecord = import('../../mesh/edit').MeshEditRecord
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>
type RecognizedFeature = import('../../mesh/recognition').RecognizedFeature

const STEP_TEST_STL = '../fixtures/WO-2080/export-step-test-with-holes.stl'
const NAME = 'export-step-test-with-holes'
/** The 8 mm deep 5 mm hole the re-check picked (S8), top at Z 0. */
const HOLE = { x: 11.3634, y: 32.9217 }

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
function stlRow(id: string, bytes: ArrayBuffer): ImportedGeometry {
  const box = computeBoundingBox(edit.resolveEditedStlMesh(bytes, undefined).mesh)
  const v = (p: readonly number[]) => ({ x: p[0], y: p[1], z: p[2] })
  const size = [0, 1, 2].map((k) => box.max[k] - box.min[k])
  const center = [0, 1, 2].map((k) => (box.max[k] + box.min[k]) / 2)
  return {
    id, name: NAME, filename: `${NAME}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: v(box.min), max: v(box.max), size: v(size), center: v(center) },
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
  const bytes = fixtureBytes(STEP_TEST_STL)
  cache.set(id, bytes)
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow(id, bytes)] } }))
  })
  let result: Awaited<ReturnType<ReturnType<typeof state>['wrapImportedGeometryAsModelItem']>> | undefined
  await act(async () => { result = await state().wrapImportedGeometryAsModelItem(id) })
  expect(result?.ok).toBe(true)
}

async function mountModelScreen(id: string): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  // The value entries render only while their anchor projects on screen.
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${id}`)).toBeTruthy(), { timeout: 20_000 })
  return runtime
}

/** Down through the hole's mouth onto its wall, 1.5 mm below the top face. */
function aimIntoHole(runtime: FakeSceneRuntime): void {
  const from = [HOLE.x, HOLE.y, 50]
  const to = [HOLE.x + 2.5, HOLE.y, -1.5]
  const d = to.map((v, i) => v - from[i])
  const len = Math.hypot(d[0], d[1], d[2])
  runtime.rayOverride = { origin: { x: from[0], y: from[1], z: from[2] }, direction: { x: d[0] / len, y: d[1] / len, z: d[2] / len } }
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')

/** The part as the row's journal resolves it, recognised again - what every
 *  later tool (and CAM) sees. */
async function recognisedNow(id: string): Promise<RecognizedFeature[]> {
  await edit.primeBoringKernel()
  const resolved = edit.resolveEditedStlMesh(cache.get(id)!, journal(id))
  return recognition.recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds).features
}
const atHole = (features: RecognizedFeature[]) =>
  features.filter((f) => Math.hypot(f.axis.origin[0] - HOLE.x, f.axis.origin[1] - HOLE.y) < 0.1)

describe('WO-2117: Hole depth on an STL changes the depth', () => {
  it('opens a depth card; Apply moves the floor to 4 mm, keeps the 5 mm diameter, the part still recognises its holes; Undo restores', async () => {
    await openInModelScreen('steptest')
    const runtime = await mountModelScreen('steptest')
    const before = await recognisedNow('steptest')
    expect(before).toHaveLength(12)
    expect(atHole(before).map((f) => [f.kind, Number(f.diameterMm.toFixed(3)), f.depthMm])).toEqual([['blind-hole', 5, 8]])

    // Resize hole -> Depth (WO-2091's field switch), then the click on the hole.
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    fireEvent.click(screen.getByTestId('workbench-resizehole-field'))
    aimIntoHole(runtime)
    fireEvent.click(canvas())

    // The depth card: current depth, new depth.
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy())
    const card = screen.getByTestId('resize-hole-anchor-entry')
    expect(card.textContent).toContain('Hole depth')
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toMatch(/Current depth\s*8 mm/)
    expect(card.textContent).toContain('New depth')

    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '4' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/Preview/), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(journal('steptest')).toHaveLength(1), { timeout: 20_000 })

    // One journal entry: the depth, the diameter untouched.
    const record = journal('steptest')![0]
    expect(record.kind).toBe(edit.ENLARGE_HOLE_KIND)
    expect(record.parameters).toMatchObject({ depthMm: 4, fromDepthMm: 8 })
    expect(record.parameters.diameterMm).toBe(record.parameters.fromDiameterMm)
    await waitFor(() => expect(messages.map((m) => m.message).join('\n'))
      .toContain(`"${NAME}": Changed the 5.00 mm blind hole from 8.00 mm deep to 4.00 mm deep.`))

    // The floor moved; the diameter stayed; every hole is still recognised.
    const after = await recognisedNow('steptest')
    expect(after).toHaveLength(12)
    expect(atHole(after).map((f) => [f.kind, Number(f.diameterMm.toFixed(3)), Number(f.depthMm.toFixed(3))])).toEqual([['blind-hole', 5, 4]])

    // Undo restores the 8 mm hole.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(journal('steptest')).toBeUndefined(), { timeout: 20_000 })
    expect(atHole(await recognisedNow('steptest')).map((f) => f.depthMm)).toEqual([8])
    expect(messages.filter((m) => m.severity === 'error')).toEqual([])
  }, 90_000)

  it('Through on the depth card bores the hole right through the part', async () => {
    await openInModelScreen('steptest')
    const runtime = await mountModelScreen('steptest')
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    fireEvent.click(screen.getByTestId('workbench-resizehole-field'))
    aimIntoHole(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('workbench-holedepth-through')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-holedepth-through'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/Preview/), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(journal('steptest')).toHaveLength(1), { timeout: 20_000 })
    expect(journal('steptest')![0].parameters).toMatchObject({ through: true, fromDepthMm: 8 })
    // Right through: a line down the axis no longer meets the part below the
    // top face.
    const resolved = edit.resolveEditedStlMesh(cache.get('steptest')!, journal('steptest'))
    const box = computeBoundingBox(resolved.mesh)
    const { positions, indices } = resolved.mesh
    let hits = 0
    for (let f = 0; f < indices.length / 3; f++) {
      const p = [0, 1, 2].map((k) => [positions[indices[f * 3 + k] * 3], positions[indices[f * 3 + k] * 3 + 1], positions[indices[f * 3 + k] * 3 + 2]])
      // Does the vertical line through the hole's centre cross this facet?
      const [a, b, c] = p
      const s = (u: number[], v: number[]) => (u[0] - HOLE.x) * (v[1] - HOLE.y) - (u[1] - HOLE.y) * (v[0] - HOLE.x)
      const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a)
      if ((d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0)) hits++
    }
    expect(box.min[2]).toBeLessThan(-8)
    expect(hits).toBe(0)
  }, 90_000)
})
