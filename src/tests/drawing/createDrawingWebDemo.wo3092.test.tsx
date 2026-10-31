// @vitest-environment jsdom
// WO-3092: "Create drawing" did nothing on the alpha.3.1 web demo.
//
// owner 2026-10-23: "on web demo version from github alpha3.1 create drawing
// button does nothing" - on the Model page of the fixture plate example, which
// opens as an STL kept as an STL. The Drawings entry was handed the kernel
// bodies only, so the STL body the Bodies panel lists (and has selected) was
// not one it could draw: the button sat disabled, saying "Select a body".
//
// Driven through the REAL SolidsWorkbenchPage with the real store, the real
// recogniser and edit journal, and the example's own STL bytes
// (examples/01-fixture-plate/fixture-plate.stl). The scene runtime is faked
// (jsdom has no WebGL); the drawing is read from the store's records and the
// editor's DOM.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import { stubCanvas2d } from '../model3d/stubCanvas2d'

const stlBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { stlBytes.set(id, buf) },
  loadCachedSTL: async (id: string) => stlBytes.get(id) ?? null,
  removeCachedSTL: async (id: string) => { stlBytes.delete(id) },
}))

const { useCamStore } = await import('../../store')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeSceneRuntime } = await import('../model3d/fakeSceneRuntime')
const { createFakeGeomClient } = await import('../model3d/fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('../model3d/loadTolerantWaitFor')
const { resetDocumentHolder, getDrawingRecords } = await import('../../doc/documentHolder')
const { resetDrawingSession } = await import('../../components/model3d/drawing/DrawingEntry')
const { resetDrawnViews } = await import('../../components/model3d/drawing/DrawingEditor')
const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
const { findStlSharpEdge, planStlShapeEdit, stlChamferShape } = await import('../../components/model3d/workbench/stlFeatureEdits')
const { primeBoringKernel } = await import('../../mesh/edit')
type ImportedGeometry = import('../../types').ImportedGeometry

const GEO = 'fixture-plate'
const NAME = 'fixture-plate'
const bytes = (() => {
  const b = readFileSync(resolve(__dirname, '../../../examples/01-fixture-plate/fixture-plate.stl'))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
})()

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  stlBytes.clear()
  resetDocumentHolder()
  resetDrawingSession()
  resetDrawnViews()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  resetDrawingSession()
  resetDrawnViews()
})

const state = () => useCamStore.getState()

function stlRow(): ImportedGeometry {
  const m = buildStlModelBodyModel({ geoId: GEO, name: NAME, bytes, meshEdits: [] })
  const p = m.mesh.positions
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i < p.length; i += 3) {
    min.x = Math.min(min.x, p[i]); min.y = Math.min(min.y, p[i + 1]); min.z = Math.min(min.z, p[i + 2])
    max.x = Math.max(max.x, p[i]); max.y = Math.max(max.y, p[i + 1]); max.z = Math.max(max.z, p[i + 2])
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }
  return {
    id: GEO, name: NAME, filename: `${NAME}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min, max, size, center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

/** The example's STL opened in the REAL Model screen, as the web demo opens it. */
async function fixturePlateInModel(): Promise<void> {
  stlBytes.set(GEO, bytes)
  act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow()] } })) })
  let result: Awaited<ReturnType<ReturnType<typeof state>['wrapImportedGeometryAsModelItem']>> | undefined
  await act(async () => { result = await state().wrapImportedGeometryAsModelItem(GEO) })
  expect(result?.ok).toBe(true)
  const runtime = createFakeSceneRuntime()
  runtime.projectToCanvasResult = { x: 300, y: 200 }
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
  await waitFor(() => expect(screen.getByTestId(`body-row-stl-body:${GEO}`)).toBeTruthy(), { timeout: 30_000 })
}

/** The Model item the page drew into (the editor names it). */
const modelItemId = (): string => screen.getByTestId('drawing-editor').getAttribute('data-model-item') as string

const frontLines = (): number => Number(screen.getByTestId('drawing-view-front').getAttribute('data-lines'))

describe('WO-3092: Create drawing on the fixture plate example (an STL kept as an STL)', () => {
  it('makes a mesh drawing whose views follow appended and same-ID replaced edits while closed', async () => {
    await fixturePlateInModel()
    const create = screen.getByTestId('drawing-create') as HTMLButtonElement
    // The Bodies panel lists one body - the STL - so the button draws it.
    await waitFor(() => expect(create.disabled).toBe(false))
    expect(create.title).not.toMatch(/Select a body/)

    fireEvent.click(create)
    await waitFor(() => expect(screen.getByTestId('drawing-editor')).toBeTruthy())
    expect(screen.queryByTestId('drawing-create-notice')).toBeNull()
    const [drawing] = getDrawingRecords(modelItemId()).documents
    expect(drawing.source).toMatchObject({ kind: 'mesh', lineageId: `stl-body:${GEO}` })
    expect(drawing.source.observedRevision.geometryFingerprint).not.toBe('')
    expect(drawing.name).toBe(`Drawing of ${NAME}`)
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
    expect(frontLines()).toBeGreaterThan(0)
    expect(screen.getByTestId('drawing-breadcrumb').textContent).toContain(NAME)
    const before = getDrawingRecords(modelItemId()).documents[0].lastGoodRevision?.geometryFingerprint
    expect(before).toBeTruthy()

    // A chamfer on the plate's top outer edge, through the journal the Model
    // screen's Chamfer writes: the drawing redraws from the edited mesh.
    await primeBoringKernel()
    const part = buildStlModelBodyModel({ geoId: GEO, name: NAME, bytes, meshEdits: [] })
    const box = stlRow().boundingBox
    const edge = findStlSharpEdge(part.mesh, { x: (box.min.x + box.max.x) / 2, y: box.min.y, z: box.max.z }, 0.5)
    expect(edge).not.toBeNull()
    const plan = planStlShapeEdit(part.mesh, stlChamferShape([edge!], 1))
    if (!plan.ok) throw new Error(plan.reason)
    await act(async () => { await state().addMeshEdit(GEO, plan.edits[0].edit) })
    await waitFor(() => {
      const after = getDrawingRecords(modelItemId()).documents[0].lastGoodRevision?.geometryFingerprint
      expect(after).toBeTruthy()
      expect(after).not.toBe(before)
    }, { timeout: 30_000 })
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'), { timeout: 30_000 })
    const itemId = modelItemId()
    const revision = () => getDrawingRecords(itemId).documents[0].lastGoodRevision?.geometryFingerprint
    const chamferRevision = revision()
    const original = state().project.geometry.find((g) => g.id === GEO)!.meshEdits![0]
    fireEvent.click(screen.getByTestId('drawing-switch-model'))
    expect(screen.queryByTestId('drawing-editor')).toBeNull()

    // The existing-feature editor rewrites the journal tail, preserving IDs.
    // Keep the drawing CLOSED throughout so no intermediate removal can
    // accidentally invalidate its module-level cache.
    const replacement = planStlShapeEdit(part.mesh, stlChamferShape([edge!], 2))
    if (!replacement.ok) throw new Error(replacement.reason)
    await act(async () => {
      await state().removeMeshEdit(GEO, original.id)
      await state().addMeshEdit(GEO, { ...replacement.edits[0].edit, id: original.id })
    })
    expect(state().project.geometry.find((g) => g.id === GEO)!.meshEdits!.map((e) => e.id)).toEqual([original.id])
    fireEvent.click(screen.getByTestId(`drawing-open-${drawing.id}`))
    await waitFor(() => expect(revision(), 'reopened drawing must read the same-ID replacement').not.toBe(chamferRevision), { timeout: 30_000 })
    await waitFor(() => expect(screen.getByTestId('drawing-status').getAttribute('data-state')).toBe('current'))
    expect(frontLines()).toBeGreaterThan(0)

    // The same replacement protocol is used by history undo/redo.
    fireEvent.click(screen.getByTestId('drawing-switch-model'))
    await act(async () => {
      await state().removeMeshEdit(GEO, original.id)
      await state().addMeshEdit(GEO, original)
    })
    fireEvent.click(screen.getByTestId(`drawing-open-${drawing.id}`))
    await waitFor(() => expect(revision()).toBe(chamferRevision), { timeout: 30_000 })
  }, 300_000)
})
