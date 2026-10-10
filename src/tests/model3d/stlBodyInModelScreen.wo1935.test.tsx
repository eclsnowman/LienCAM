// @vitest-environment jsdom
// WO-1935: an STL part opens in the Model screen as a solid with pickable
// features.
//
// Driven through the product's own entry point - the store's "Edit as model"
// action (`wrapImportedGeometryAsModelItem`, the DesignTree menu entry and the
// Model tab both call it) - and the REAL SolidsWorkbenchPage, with the scene
// runtime faked (jsdom has no WebGL) and the STL cache serving the real
// WO-1846 acceptance plate bytes (6 mm through hole, counterbore, countersink,
// 12 mm boss). Recognition runs for real on those bytes.
//
//   1. The curved plate is ACCEPTED (main refuses it: mesh-refused-curved),
//      shows in the Bodies list, and its row is still format 'stl' with the
//      same meshEdits journal - no item minted for it, nothing adopted.
//   2. A click into the 6 mm through hole selects the WHOLE hole (all 128 of
//      its facets), a click on the boss selects the boss (192).
//   3. The default display shows no triangle edges; the display switch's
//      Unshaded (wireframe) mode shows them.
//   4. A prismatic STL (the unit cube) still converts exactly as before.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import * as THREE from 'three'
import { typedMock } from '../support/typedMock'
import { binaryStlFixture, unitCube } from '../mesh/fixtures'

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
type ImportedGeometry = import('../../types').ImportedGeometry
type FakeSceneRuntime = ReturnType<typeof createFakeSceneRuntime>

function plateBytes(): ArrayBuffer {
  const plate = readFileSync(resolve(__dirname, '../evidence/WO-1846/acceptance-plate.stl'))
  return plate.buffer.slice(plate.byteOffset, plate.byteOffset + plate.byteLength) as ArrayBuffer
}

function stlRow(id: string, name: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 }, size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
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

/** The STL body's scene root, found where the page put it: in the runtime. */
function stlRoot(runtime: FakeSceneRuntime): THREE.Group {
  const live = runtime.addedObjects.filter((o) =>
    o.userData.stlModelBodyGeoId !== undefined && !runtime.removedObjects.includes(o))
  expect(live).toHaveLength(1)
  return live[0] as THREE.Group
}
function edgesOf(root: THREE.Object3D, which: 'outline' | 'triangles'): THREE.LineSegments {
  const found = root.children.find((c) => c.userData.stlModelBodyEdges === which)
  if (found === undefined) throw new Error(`no ${which} edges`)
  return found as THREE.LineSegments
}
function bodyMesh(root: THREE.Object3D): THREE.Mesh {
  return root.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh
}
function overlay(root: THREE.Object3D, variant: 'selected' | 'hovered'): THREE.Object3D | undefined {
  return bodyMesh(root).children.find((c) => c.userData.interactionVariant === variant)
}
function aim(runtime: FakeSceneRuntime, origin: [number, number, number], toward: [number, number, number]): void {
  const d = toward.map((v, i) => v - origin[i])
  const len = Math.hypot(d[0], d[1], d[2])
  runtime.rayOverride = {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: d[0] / len, y: d[1] / len, z: d[2] / len },
  }
}

async function openPlateInModelScreen(): Promise<{ journal: ImportedGeometry['meshEdits'] }> {
  cache.set('plate', plateBytes())
  const journal: NonNullable<ImportedGeometry['meshEdits']> = []
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow('plate', 'acceptance plate', { meshEdits: journal })] } }))
  })
  let result: Awaited<ReturnType<ReturnType<typeof state>['wrapImportedGeometryAsModelItem']>> | undefined
  await act(async () => { result = await state().wrapImportedGeometryAsModelItem('plate') })
  expect(result?.ok).toBe(true)
  return { journal }
}

async function mountModelScreen(): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await waitFor(() => expect(screen.getByTestId('body-row-stl-body:plate')).toBeTruthy(), { timeout: 20_000 })
  return runtime
}

describe('WO-1935: an STL part opens in the Model screen as a solid with pickable features', () => {
  it('1. Edit as model accepts the curved plate; the row stays an STL with the same journal', async () => {
    const before = state().project.geometry[0]
    expect(before).toBeUndefined()
    const { journal } = await openPlateInModelScreen()

    expect(state().brepImportError).toBeNull()
    expect(state().modelStlGeoId).toBe('plate')
    expect(state().workspace).toBe('part')
    const row = state().project.geometry.find((g) => g.id === 'plate')!
    expect(row.format).toBe('stl')
    expect(row.meshEdits).toBe(journal)
    expect(row.pendingModelItemId).toBeUndefined()
    expect(row.modelItemId).toBeUndefined()
    expect(state().project.geometry).toHaveLength(1)
    // No item carries this part: the Model screen opened the way the Model tab
    // does (the project's one plain model), and nothing was seeded from the STL.
    expect((state().project.modelItems ?? []).every((m) => m.documentState !== 'authored')).toBe(true)

    await mountModelScreen()
    expect(screen.getByTestId('body-row-stl-body:plate').textContent).toContain('acceptance plate')
    expect(messages.some((m) => m.startsWith('"acceptance plate" is open as a mesh (kept as an STL)'))).toBe(true)
    // Showing it wrote nothing back to the row.
    expect(state().project.geometry.find((g) => g.id === 'plate')).toBe(row)
  })

  it('2. a click into the through hole selects the whole hole; a click on the boss selects the boss', async () => {
    await openPlateInModelScreen()
    const runtime = await mountModelScreen()
    const root = stlRoot(runtime)
    const canvas = screen.getByTestId('solids-workbench-canvas')

    // Down into the 6 mm hole at (-20, -20): enters the opening, meets the wall.
    aim(runtime, [-20, -20, 50], [-17, -20, 6])
    fireEvent.pointerMove(canvas)
    expect(overlay(root, 'hovered')?.userData.stlModelFeatureId).toBe('through-hole-256')
    fireEvent.click(canvas)
    await waitFor(() => expect(overlay(root, 'selected')?.userData.stlModelFeatureId).toBe('through-hole-256'))
    expect(overlay(root, 'selected')?.userData.stlModelFacetCount).toBe(128)
    // The overlay paints every one of those facets - one feature, not one triangle.
    const painted = (overlay(root, 'selected') as THREE.Mesh).geometry.getAttribute('position').count / 3
    expect(painted).toBe(128)
    expect(messages).toContain('Selected through hole 6.00 mm, 12.00 mm deep on "acceptance plate" (128 facets).')
    expect(screen.getByTestId('body-row-stl-body:plate').getAttribute('aria-selected')).toBe('true')

    // Side-on into the boss wall at (20, 20), 12 mm diameter, 12..17 high.
    aim(runtime, [60, 20, 14], [20, 20, 14])
    fireEvent.click(canvas)
    await waitFor(() => expect(overlay(root, 'selected')?.userData.stlModelFeatureId).toBe('boss-1728'))
    expect(overlay(root, 'selected')?.userData.stlModelFacetCount).toBe(192)

    // A click that misses the part clears the pick.
    aim(runtime, [200, 200, 50], [200, 200, 0])
    fireEvent.click(canvas)
    await waitFor(() => expect(overlay(root, 'selected')).toBeUndefined())
  })

  it('3. the default display shows no triangle edges; Unshaded (wireframe) shows the mesh', async () => {
    await openPlateInModelScreen()
    const runtime = await mountModelScreen()
    const root = stlRoot(runtime)
    const triangles = edgesOf(root, 'triangles')
    const outline = edgesOf(root, 'outline')
    // The mesh wire lists every triangle edge once; the outline is far sparser.
    expect(triangles.geometry.getAttribute('position').count / 2).toBe(3264)
    expect(outline.geometry.getAttribute('position').count / 2).toBeLessThan(1000)

    expect(triangles.visible).toBe(false)
    expect(outline.visible).toBe(true)
    expect((bodyMesh(root).material as THREE.MeshStandardMaterial).opacity).toBe(1)

    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    fireEvent.click(screen.getByTestId('workbench-shading-unshaded'))
    await waitFor(() => expect(triangles.visible).toBe(true))

    // (the flyout stays open after a pick)
    fireEvent.click(screen.getByTestId('workbench-shading-shaded-no-edges'))
    await waitFor(() => expect(triangles.visible).toBe(false))
    expect(outline.visible).toBe(false)
  })

  it('the Bodies row hides the part and selects it whole', async () => {
    await openPlateInModelScreen()
    const runtime = await mountModelScreen()
    const root = stlRoot(runtime)
    const material = bodyMesh(root).material as THREE.MeshStandardMaterial
    const resting = material.color.getHex()

    fireEvent.click(screen.getByTestId('body-row-stl-body:plate'))
    await waitFor(() => expect(material.color.getHex()).not.toBe(resting))

    fireEvent.click(screen.getByTestId('body-visible-stl-body:plate'))
    await waitFor(() => expect(bodyMesh(root).visible).toBe(false))
    expect(state().project.geometry.find((g) => g.id === 'plate')?.hidden).toBeUndefined()
  })

  it('4. a prismatic STL still converts exactly as before', async () => {
    cache.set('cube', binaryStlFixture(unitCube(10)))
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow('cube', 'cube')] } }))
    })
    let result: { ok: boolean; itemId?: string; reason?: string } | undefined
    await act(async () => { result = await state().wrapImportedGeometryAsModelItem('cube') })
    expect(result?.ok).toBe(true)
    expect(result?.itemId).toBeTruthy()
    expect(state().modelStlGeoId).toBeNull()
    expect(state().activeModelItemId).toBe(result?.itemId)
    expect(state().project.geometry[0].pendingModelItemId).toBe(result?.itemId)
    expect(state().project.modelItems?.find((m) => m.id === result?.itemId)?.name).toBe('cube')
  })
})
