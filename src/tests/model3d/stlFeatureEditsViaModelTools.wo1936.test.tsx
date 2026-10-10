// @vitest-environment jsdom
// WO-1936: the Model tools edit an STL part's features.
//
// Driven through the product's own route: the store's "Edit as model" action
// opens the part (WO-1935), the REAL SolidsWorkbenchPage draws it, and each
// edit goes through the Model screen's own tool buttons, the viewport pick and
// the tool's own dialog - Defeature, Resize Hole, Push/Pull, Fillet - then the
// Model screen's Undo. The scene runtime is faked (jsdom has no WebGL); the
// STL cache serves the real fixture bytes; recognition, planning and the
// store's addMeshEdit/removeMeshEdit all run for real.
//
// "Identical to what Setup's old button wrote" is checked against the entry
// Setup's code path builds: the same recogniser on the same resolved mesh, the
// facets whose source-facet ids the feature names (PropertiesPanel's
// `snapshot.sourceFacetIds.forEach(...)`), the same parameter object, minted by
// the same `createMeshEditRecord` - every field of the record but its random id.
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

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(resolve(__dirname, path))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
const PLATE = '../evidence/WO-1846/acceptance-plate.stl'
const BLOCK = '../evidence/WO-1848/blended-block.stl'

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
const journal = (id: string): MeshEditRecord[] | undefined => state().project.geometry.find((g) => g.id === id)?.meshEdits

async function openInModelScreen(id: string, name: string, path: string): Promise<void> {
  cache.set(id, fixtureBytes(path))
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow(id, name)] } }))
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
function aim(runtime: FakeSceneRuntime, origin: [number, number, number], toward: [number, number, number]): void {
  const d = toward.map((v, i) => v - origin[i])
  const len = Math.hypot(d[0], d[1], d[2])
  runtime.rayOverride = {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: d[0] / len, y: d[1] / len, z: d[2] / len },
  }
}
const canvas = () => screen.getByTestId('solids-workbench-canvas')

// Rays onto the plate (80 x 80 x 12, boss 12 mm on top at (20, 20)) and the
// blended block (60 x 40 x 20, a 3 mm fillet on the top X-max edge, a 2 mm
// chamfer on the top X-min edge).
const INTO_THROUGH_HOLE = (r: FakeSceneRuntime) => aim(r, [-20, -20, 50], [-17, -20, 6])
const ONTO_BOSS = (r: FakeSceneRuntime) => aim(r, [60, 20, 14], [20, 20, 14])
const ONTO_SIDE_FACE = (r: FakeSceneRuntime) => aim(r, [100, 0, 6], [0, 0, 6])
const ONTO_FILLET = (r: FakeSceneRuntime) => aim(r, [80, 20, 40], [59.1, 20, 19.1])
const ONTO_CHAMFER = (r: FakeSceneRuntime) => aim(r, [-20, 20, 40], [0.7, 20, 19.3])

/** The entry Setup's button for this feature would have written, minted on
 *  the row's mesh as it stands - everything but the random id. */
async function setupEntry(
  id: string,
  pick: (resolved: ReturnType<typeof edit.resolveEditedStlMesh>) => { sourceFacetIds: number[]; kind: string; parameters: Record<string, unknown> },
): Promise<Omit<MeshEditRecord, 'id'>> {
  await edit.primeBoringKernel()
  const resolved = edit.resolveEditedStlMesh(cache.get(id)!, journal(id))
  const chosen = pick(resolved)
  const wanted = new Set(chosen.sourceFacetIds)
  const facets: number[] = []
  resolved.sourceFacetIds.forEach((sid, facet) => { if (wanted.has(sid)) facets.push(facet) })
  const { id: _ignored, ...rest } = edit.createMeshEditRecord(resolved.mesh, {
    kind: chosen.kind, facets, parameters: chosen.parameters, sourceFacetIds: resolved.sourceFacetIds,
  })
  return rest
}
function withoutId(record: MeshEditRecord): Omit<MeshEditRecord, 'id'> {
  const { id: _ignored, ...rest } = record
  return rest
}
const roundFeature = (resolved: ReturnType<typeof edit.resolveEditedStlMesh>, featureId: string) =>
  recognition.recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds).features.find((f) => f.id === featureId)!
const edgeBlend = (resolved: ReturnType<typeof edit.resolveEditedStlMesh>, blendId: string) =>
  recognition.recognizeEdgeBlends(resolved.mesh, resolved.sourceFacetIds).blends.find((b) => b.id === blendId)!
const flatFace = (resolved: ReturnType<typeof edit.resolveEditedStlMesh>, faceId: string) =>
  recognition.recognizeFlatFaces(resolved.mesh, resolved.sourceFacetIds).faces.find((f) => f.id === faceId)!

async function undoAndRedoRoundTrip(id: string, expected: Omit<MeshEditRecord, 'id'>): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-undo'))
  // removeMeshEdit writes an emptied journal as ABSENT (ADR-0051 s1.1).
  await waitFor(() => expect(journal(id)).toBeUndefined(), { timeout: 20_000 })
  fireEvent.click(screen.getByTestId('workbench-redo'))
  await waitFor(() => expect(journal(id)).toHaveLength(1), { timeout: 20_000 })
  expect(withoutId(journal(id)![0])).toEqual(expected)
}

describe('WO-1936: the Model tools edit an STL part\'s features', () => {
  it('Defeature fills the through hole: one journal entry identical to Setup\'s Fill; Model undo removes it', async () => {
    await openInModelScreen('plate', 'acceptance plate', PLATE)
    const runtime = await mountModelScreen('plate')
    const expected = await setupEntry('plate', (resolved) => {
      const hole = roundFeature(resolved, 'through-hole-256')
      return { sourceFacetIds: hole.sourceFacetIds, kind: edit.REMOVE_ROUND_FEATURE_KIND, parameters: { feature: hole.kind, diameterMm: hole.diameterMm } }
    })

    // No kernel body in this model: Defeature opens on the STL's features.
    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy())
    expect(screen.getByTestId('defeature-row-through-hole-256')).toBeTruthy()
    expect(screen.getByTestId('defeature-row-boss-1728')).toBeTruthy()
    expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('idle')
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    // A click into the hole picks the WHOLE hole and builds the preview.
    INTO_THROUGH_HOLE(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 20_000 })
    expect((screen.getByTestId('defeature-check-through-hole-256') as HTMLInputElement).checked).toBe(true)
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    expect(journal('plate')).toBeUndefined() // a preview records nothing

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('plate')![0])).toEqual(expected)
    await waitFor(() => expect(screen.queryByTestId('defeature-command-card')).toBeNull())
    // The part redraws from the journal: the hole is gone from its features.
    await waitFor(() => expect(window.__solidsWorkbenchHooks?.getStlBody?.()?.featureCount).toBe(9), { timeout: 20_000 })

    await undoAndRedoRoundTrip('plate', expected)
  }, 60_000)

  it('Resize Hole bores the through hole to 8 mm; a drill bound to it is outdated and re-reads the 8 mm hole', async () => {
    await openInModelScreen('plate', 'acceptance plate', PLATE)
    const runtime = await mountModelScreen('plate')
    // WO-1851: a drill bound to the recognised hole, computed ('ready').
    const targets = await state().loadMeshFeatureTargets('plate')
    expect(targets.holes.find((h) => h.kind === 'through-hole')?.diameterMm).toBeCloseTo(6, 4)
    const holeLoop = (state().project.geometry[0].layers2d ?? []).flatMap((l) => l.holes ?? [])
      .find((h) => Math.abs(h.diameter - 6) < 1e-3 && h.center[0] < 0 && h.center[1] < 0)!.loopId!
    const drill = {
      id: 'op-drill', name: 'Drill', type: 'drill', enabled: true, status: 'ready',
      params: { geometryId: 'plate', loopIds: [holeLoop] }, geometrySelections: [holeLoop],
    } as unknown as import('../../types').Operation
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: [{
            id: 'setup-1', name: 'Setup 1', operations: [drill], stock: null, notes: '',
            wcs: {
              id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
              xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
            },
          } as unknown as import('../../types').Setup],
        },
      }))
    })
    const expected = await setupEntry('plate', (resolved) => {
      const hole = roundFeature(resolved, 'through-hole-256')
      return {
        sourceFacetIds: hole.sourceFacetIds,
        kind: edit.ENLARGE_HOLE_KIND,
        parameters: { feature: hole.kind, fromDiameterMm: hole.diameterMm, diameterMm: 8, axisOrigin: [...hole.axis.origin], axisDirection: [...hole.axis.direction] },
      }
    })

    // The tool arms; the pick on the STL hole opens the SAME anchored entry.
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    INTO_THROUGH_HOLE(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy())
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/Preview/), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })

    // Exactly Setup's Bore; the drill that reads this row is outdated, so it
    // recomputes - and what it reads now is the 8 mm hole.
    expect(withoutId(journal('plate')![0])).toEqual(expected)
    const op = state().project.setups[0].operations.find((o) => o.id === 'op-drill')!
    expect(op.status).toBe('outdated')
    const after = await state().loadMeshFeatureTargets('plate')
    expect(after.holes.find((h) => h.kind === 'through-hole')?.diameterMm).toBeCloseTo(8, 2)

    await undoAndRedoRoundTrip('plate', expected)
  }, 60_000)

  it('Defeature removes the boss when the boss is selected first', async () => {
    await openInModelScreen('plate', 'acceptance plate', PLATE)
    const runtime = await mountModelScreen('plate')
    const expected = await setupEntry('plate', (resolved) => {
      const boss = roundFeature(resolved, 'boss-1728')
      return { sourceFacetIds: boss.sourceFacetIds, kind: edit.REMOVE_ROUND_FEATURE_KIND, parameters: { feature: boss.kind, diameterMm: boss.diameterMm } }
    })

    ONTO_BOSS(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(window.__solidsWorkbenchHooks?.getStlBody?.()?.selectedFeatureId).toBe('boss-1728'))
    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 20_000 })
    expect((screen.getByTestId('defeature-check-boss-1728') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('plate')![0])).toEqual(expected)

    await undoAndRedoRoundTrip('plate', expected)
  }, 60_000)

  it('Push/Pull moves a flat face: drag-or-type entry, Enter previews, Enter applies', async () => {
    await openInModelScreen('plate', 'acceptance plate', PLATE)
    const runtime = await mountModelScreen('plate')
    const expected = await setupEntry('plate', (resolved) => {
      const face = flatFace(resolved, 'flat-1920')
      return { sourceFacetIds: face.sourceFacetIds, kind: edit.MOVE_FLAT_FACE_KIND, parameters: { distanceMm: 2 } }
    })

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    ONTO_SIDE_FACE(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy())
    const input = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // preview
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry-status').textContent).toMatch(/Preview/), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    expect(journal('plate')).toBeUndefined()
    fireEvent.keyDown(input, { key: 'Enter' }) // apply
    await waitFor(() => expect(journal('plate')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('plate')![0])).toEqual(expected)

    await undoAndRedoRoundTrip('plate', expected)
  }, 60_000)

  it('Fillet changes a blend\'s radius: the dialog opens on the measured 3 mm; 5 mm is Setup\'s radius change', async () => {
    await openInModelScreen('block', 'blended block', BLOCK)
    const runtime = await mountModelScreen('block')
    const expected = await setupEntry('block', (resolved) => {
      const blend = edgeBlend(resolved, 'fillet-16')
      return { sourceFacetIds: blend.sourceFacetIds, kind: edit.CHANGE_BLEND_RADIUS_KIND, parameters: { radiusMm: 5, fromRadiusMm: blend.radiusMm } }
    })

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    ONTO_FILLET(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
    expect(screen.getByTestId('fillet-edge-count').textContent).toBe('1 edge selected')
    const radius = screen.getByLabelText('Fillet radius') as HTMLInputElement
    expect(radius.value).toBe('3')
    fireEvent.change(radius, { target: { value: '5' } })
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect(previewFacets(runtime)).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('block')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('block')![0])).toEqual(expected)

    await undoAndRedoRoundTrip('block', expected)
  }, 60_000)

  it('Defeature takes the chamfer back to sharp (Setup\'s blend Remove)', async () => {
    await openInModelScreen('block', 'blended block', BLOCK)
    const runtime = await mountModelScreen('block')
    const expected = await setupEntry('block', (resolved) => {
      const blend = edgeBlend(resolved, 'chamfer-88')
      return { sourceFacetIds: blend.sourceFacetIds, kind: edit.RESTORE_SHARP_EDGE_KIND, parameters: { blend: blend.kind, sizeMm: blend.setbackMm?.[0] } }
    })

    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy())
    ONTO_CHAMFER(runtime)
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(journal('block')).toHaveLength(1), { timeout: 20_000 })
    expect(withoutId(journal('block')![0])).toEqual(expected)
  }, 60_000)

  it('an edit the software cannot make records nothing and says so in the console', async () => {
    await openInModelScreen('block', 'blended block', BLOCK)
    const runtime = await mountModelScreen('block')
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    ONTO_FILLET(runtime)
    fireEvent.click(canvas())
    const radius = await screen.findByLabelText('Fillet radius') as HTMLInputElement
    // A 30 mm round cannot fit a 20 mm tall block's edge.
    fireEvent.change(radius, { target: { value: '30' } })
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('refused'), { timeout: 20_000 })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(messages.some((m) => m.startsWith('Not changed: the 3.00 mm fillet'))).toBe(true)
    expect(journal('block')).toBeUndefined()
  }, 60_000)
})
