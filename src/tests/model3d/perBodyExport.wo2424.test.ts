// @vitest-environment jsdom
// Production button -> geometry writer -> saveFile. STEPControl_Reader and
// Three's STLLoader independently read the saved bytes, rather than inspecting
// writer internals. The scene runtime alone is fake; both boxes are real OCCT.
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { Mesh, Vector3 } from 'three'
import { ExportModal } from '../../components/modals/ExportModal'
import { collectExportGroups, openExportWindow, type ExportRow } from '../../lib/exportCenter'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { useCamStore } from '../../store'
import { modelExportFilename, saveFile } from '../../lib/saveFile'
import { createFakeSceneRuntime, fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { ImportedGeometry } from '../../types'

const stlCache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', async () => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/stlCache')>({
    cacheSTL: async (id, bytes) => { stlCache.set(id, bytes) },
    loadCachedSTL: async (id) => stlCache.get(id) ?? null,
    removeCachedSTL: async (id) => { stlCache.delete(id) },
  })
})

vi.mock('../../lib/saveFile', async (importOriginal) => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/saveFile')>({
    ...await importOriginal<typeof import('../../lib/saveFile')>(),
    saveFile: vi.fn(async () => 'download'),
  })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })
const hooks = () => window.__solidsWorkbenchHooks!

async function box(sketchId: string, bodyId: string, width: string, offset: string) {
  await mintRectangleSketch({ id: sketchId, width, height: '20', offset })
  // Fixture construction uses the same document command/resync as the UI;
  // the behavior under test below always enters through the export buttons.
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id: bodyId, kind: 'feature', consumes: [sketchId],
    payload: { opType: 'extrude', sketchId, distance: 10, direction: 'up', boolMode: 'newBody', name: `Body ${bodyId}` },
  }))
  await hooks().fullResync([bodyId])
  await waitFor(() => expect(hooks().getBodyHandle(bodyId)).toBeDefined(), { timeout: 20_000 })
}

function renderWorkbench(props: Parameters<typeof SolidsWorkbenchPage>[0]) {
  return render(createElement('div', null, createElement(SolidsWorkbenchPage, props), createElement(ExportModal)))
}

const bodyRow = (id: string) => collectExportGroups().flatMap((group) => group.rows).find((row) => row.id === `model-body:${id}`)!

async function saved(rowId: string, format: string, capturedRow?: ExportRow) {
  vi.mocked(saveFile).mockClear()
  if (capturedRow) {
    // The same window-row action captured before hiding; explicit writers keep
    // their hidden-body capability while the window lists visible bodies only.
    await capturedRow.save(format)
  } else {
    act(() => openExportWindow())
    const select = screen.queryByTestId(`export-format-${rowId}`)
    if (select) {
      fireEvent.click(select)
      fireEvent.click(await screen.findByTestId(`export-format-${rowId}-option-${format}`))
    }
    fireEvent.click(screen.getByTestId(`export-save-${rowId}`))
  }
  await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1), { timeout: 20_000 })
  const [filename, blob, mime] = vi.mocked(saveFile).mock.calls[0]
  expect(blob).toBeInstanceOf(Blob)
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob as Blob)
  })
  act(() => useCamStore.getState().closeModal())
  return { filename, bytes, mime }
}

function readStl(bytes: ArrayBuffer) {
  const geometry = new STLLoader().parse(bytes)
  geometry.computeBoundingBox()
  const positions = geometry.getAttribute('position')
  let volume = 0
  const a = new Vector3(), b = new Vector3(), c = new Vector3()
  for (let i = 0; i < positions.count; i += 3) {
    a.fromBufferAttribute(positions, i)
    b.fromBufferAttribute(positions, i + 1)
    c.fromBufferAttribute(positions, i + 2)
    volume += a.dot(b.cross(c)) / 6
  }
  const bounds = geometry.boundingBox!.clone()
  geometry.dispose()
  return { volume: Math.abs(volume), bounds }
}

describe('WO-2424 per-body exports and project filenames', () => {
  it.each([
    ['Fixture plate', 'Fixture plate.step'],
    ['Plate: left/right?', 'Plate- left-right-.step'],
    ['  Part.  ', 'Part.step'],
    ['', 'Untitled project.step'],
    ['CON', '_CON.step'],
  ])('makes a usable default filename for %j', (name, expected) => {
    expect(modelExportFilename(name, 'step')).toBe(expected)
    expect(modelExportFilename(name, 'stl', 'Body/A')).toBe(expected.replace('.step', '-Body-A.stl'))
  })

  it('replaces every control character in project and body names and preserves higher code points', () => {
    const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('')
    const suffix = ' !\u007f\u00e9\u{1f680}'
    const name = `Part${controls}${suffix}`
    const clean = `Part${'-'.repeat(32)}${suffix}`
    expect(modelExportFilename(name, 'step')).toBe(`${clean}.step`)
    expect(modelExportFilename(name, 'stl', name)).toBe(`${clean}-${clean}.stl`)
  })

  it('names a modified body after its Bodies row while exporting the live fillet geometry', async () => {
    const originalProject = useCamStore.getState().project
    useCamStore.setState({ project: { ...originalProject, name: 'Modified plate' } })
    try {
      const runtime = createFakeSceneRuntime()
      renderWorkbench({ createClient: createLocalGeomService, createSceneRuntime: () => runtime })
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
      await box('SK1', 'F1', '40', '10')
      fireEvent.click(screen.getByTestId('workbench-fillet'))
      runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
      fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
      const radius = screen.getByTestId('fillet-radius').querySelector('input')!
      fireEvent.change(radius, { target: { value: '1' } })
      fireEvent.blur(radius)
      await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
      fireEvent.click(screen.getByTestId('dialog-shell-apply'))
      await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeDefined(), { timeout: 20_000 })
      const row = await screen.findByTestId('body-row-F2')
      expect(row.getAttribute('data-lineage-id')).toBe('F1')
      expect(row.textContent).toContain('Body F1')
      expect(row.textContent).not.toContain('Fillet F2')
      fireEvent.click(row)
      const source = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
      expect(source.value).toBeLessThan(8000)
      for (const format of ['step', 'stl'] as const) {
        const output = await saved('model-body:F2', format)
        expect(output.filename).toBe(`Modified plate-Body F1.${format}`)
        expect(bodyRow('F2').name).toBe('Body F1')
        expect(bodyRow('F1')).toBeUndefined()
        if (format === 'step') {
          const parsed = await hooks().client.importStep(output.bytes, 'READ-FILLET')
          expect(parsed.bodies).toHaveLength(1)
          expect((await hooks().client.measure(parsed.bodies[0].handle, 'volume')).value).toBeCloseTo(source.value, 5)
          await hooks().client.dispose(parsed.bodies[0].handle)
        } else {
          expect(readStl(output.bytes).volume).toBeCloseTo(source.value, 0)
        }
      }
    } finally {
      cleanup()
      useCamStore.setState({ project: originalProject })
    }
  }, 120_000)

  it('exports the selected mesh-backed body as STL, including current edits and hidden state', async () => {
    const originalState = useCamStore.getState()
    try {
      const fixture = readFileSync(resolve(__dirname, '../evidence/WO-1846/acceptance-plate.stl'))
      stlCache.set('plate', fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength) as ArrayBuffer)
      const geometry: ImportedGeometry = {
        id: 'plate', name: 'acceptance plate', filename: 'acceptance plate.stl', type: 'mesh', format: 'stl',
        boundingBox: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 }, size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 } },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      }
      act(() => useCamStore.setState({ project: { ...originalState.project, name: 'Mesh project', geometry: [geometry] } }))
      await act(async () => expect((await useCamStore.getState().wrapImportedGeometryAsModelItem('plate')).ok).toBe(true))
      const runtime = createFakeSceneRuntime()
      runtime.projectToCanvasResult = { x: 300, y: 200 }
      renderWorkbench({ createClient: createLocalGeomService, createSceneRuntime: () => runtime })
      await waitFor(() => expect(screen.getByTestId('body-row-stl-body:plate')).toBeTruthy(), { timeout: 30_000 })
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
      // A second, OCCT-backed body must never be included in explicit mesh export.
      await box('SK1', 'F1', '40', '100')
      fireEvent.click(screen.getByTestId('body-row-stl-body:plate'))
      expect(screen.getByTestId('body-row-stl-body:plate').getAttribute('aria-selected')).toBe('true')
      expect(bodyRow('stl-body:plate').formats.map((format) => format.id)).toEqual(['stl'])
      expect(screen.queryByTestId('workbench-export-body-stl')).toBeNull()
      expect(screen.queryByTestId('workbench-export-body-step')).toBeNull()

      const checkMeshExport = async (capturedRow?: ExportRow) => {
        const output = await saved('model-body:stl-body:plate', 'stl', capturedRow)
        expect(output.filename).toBe('Mesh project-acceptance plate.stl')
        expect(output.mime).toBe('model/stl')
        const parsed = new STLLoader().parse(output.bytes)
        const root = runtime.addedObjects.findLast((object) => object.userData.stlModelBodyGeoId === 'plate' && !runtime.removedObjects.includes(object))!
        const rendered = root.children.find((object) => object instanceof Mesh) as Mesh
        // Independent STL reader must recover every actual rendered triangle;
        // this also excludes the separate OCCT body and stale cached STL bytes.
        expect(Array.from(parsed.getAttribute('position').array)).toEqual(Array.from(rendered.geometry.getAttribute('position').array))
        parsed.dispose()
        return readStl(output.bytes)
      }
      const before = await checkMeshExport()
      fireEvent.click(screen.getByTestId('workbench-push-pull'))
      runtime.rayOverride = { origin: { x: 90, y: 0, z: 6 }, direction: { x: -1, y: 0, z: 0 } }
      fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry-input')).toBeTruthy())
      const input = screen.getByTestId('pushpull-delta-entry-input')
      fireEvent.change(input, { target: { value: '2' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry-status').textContent).toMatch(/Preview/), { timeout: 20_000 })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(useCamStore.getState().project.geometry.find((row) => row.id === 'plate')?.meshEdits).toHaveLength(1), { timeout: 20_000 })
      await waitFor(() => expect(hooks().getStlBody?.()?.previewFacetCount).toBe(0))
      fireEvent.click(screen.getByTestId('body-row-stl-body:plate'))
      const after = await checkMeshExport()
      expect(after.bounds.max.x).toBeCloseTo(before.bounds.max.x + 2, 5)
      expect(after.volume).toBeGreaterThan(before.volume)
      const meshRow = bodyRow('stl-body:plate')
      fireEvent.click(screen.getByTestId('body-visible-stl-body:plate'))
      expect((screen.getByTestId('body-visible-stl-body:plate') as HTMLInputElement).checked).toBe(false)
      expect(bodyRow('stl-body:plate')).toBeUndefined()
      expect((await checkMeshExport(meshRow)).volume).toBeCloseTo(after.volume, 5)
      // Feature-tree selection must replace the previous mesh selection for
      // both export formats, just as selection through the Bodies row does.
      fireEvent.click(screen.getByTestId('feature-row-F1'))
      expect(screen.getByTestId('feature-row-F1').getAttribute('aria-selected')).toBe('true')
      const treeStl = await saved('model-body:F1', 'stl')
      expect(treeStl.filename).toBe('Mesh project-Body F1.stl')
      expect(treeStl.mime).toBe('model/stl')
      const treeMesh = readStl(treeStl.bytes)
      expect(treeMesh.volume).toBeCloseTo(8000, 4)
      expect(treeMesh.bounds.min.x).toBeCloseTo(100, 5)
      expect(treeMesh.bounds.max.x).toBeCloseTo(140, 5)
      expect(screen.getByTestId('body-row-F1').getAttribute('aria-selected')).toBe('true')
      expect(screen.getByTestId('body-row-stl-body:plate').getAttribute('aria-selected')).toBe('false')
      const treeStep = await saved('model-body:F1', 'step')
      expect(treeStep.filename).toBe('Mesh project-Body F1.step')
      expect(treeStep.mime).toBe('application/step')
      const treeParsed = await hooks().client.importStep(treeStep.bytes, 'READ-TREE-F1')
      expect(treeParsed.bodies).toHaveLength(1)
      expect((await hooks().client.measure(treeParsed.bodies[0].handle, 'volume')).value).toBeCloseTo(8000, 5)
      await hooks().client.dispose(treeParsed.bodies[0].handle)
      fireEvent.click(screen.getByTestId('body-row-F1'))
      expect(bodyRow('F1').formats.map((format) => format.id)).toEqual(['step', 'stl'])
      expect((await saved('model-body:F1', 'stl')).filename).toBe('Mesh project-Body F1.stl')
    } finally {
      cleanup()
      stlCache.clear()
      useCamStore.setState(originalState)
    }
  }, 120_000)

  it('exports either selected body only, including a hidden body; keeps all-body exports and uses the current project name', async () => {
    const originalProject = useCamStore.getState().project
    useCamStore.setState({ project: { ...originalProject, name: 'Fixture plate' } })
    try {
      renderWorkbench({ createClient: createLocalGeomService, createSceneRuntime: fakeCreateSceneRuntime })
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 30_000 })
      expect(screen.queryByTestId('workbench-export-body-step')).toBeNull()
      await box('SK1', 'F1', '40', '10')
      await box('SK2', 'F2', '15', '100')

      for (const [id, volume, minX, maxX] of [['F1', 8000, 10, 50], ['F2', 3000, 100, 115]] as const) {
        fireEvent.click(screen.getByTestId(`body-row-${id}`))
        const name = hooks().dag.getNode(id)!.payload.name as string
        const source = await hooks().client.measure(hooks().getBodyHandle(id)!, 'volume')
        expect(source.value).toBeCloseTo(volume, 5)
        // Row ownership must win even when the other body is selected.
        fireEvent.click(screen.getByTestId(`body-row-${id === 'F1' ? 'F2' : 'F1'}`))
        const step = await saved(`model-body:${id}`, 'step')
        expect(step.filename).toBe(`Fixture plate-${name}.step`)
        expect(step.mime).toBe('application/step')
        const parsed = await hooks().client.importStep(step.bytes, `READ-${id}`)
        expect(parsed.bodies).toHaveLength(1)
        expect((await hooks().client.measure(parsed.bodies[0].handle, 'volume')).value).toBeCloseTo(source.value, 5)
        const tess = await hooks().client.tessellate(parsed.bodies[0].handle, DISPLAY_TESS_QUALITY)
        const xs = Array.from(tess.position).filter((_, i) => i % 3 === 0)
        expect(Math.min(...xs)).toBeCloseTo(minX, 5)
        expect(Math.max(...xs)).toBeCloseTo(maxX, 5)
        await hooks().client.dispose(parsed.bodies[0].handle)

        const stl = await saved(`model-body:${id}`, 'stl')
        expect(stl.filename).toBe(`Fixture plate-${name}.stl`)
        expect(stl.mime).toBe('model/stl')
        const mesh = readStl(stl.bytes)
        expect(mesh.volume).toBeCloseTo(source.value, 4)
        expect(mesh.bounds.min.x).toBeCloseTo(minX, 5)
        expect(mesh.bounds.max.x).toBeCloseTo(maxX, 5)
      }

      // Explicit export is independent of visibility; all-body export still
      // reads persisted hidden state at click time (UI-56 incident contract).
      const secondRow = bodyRow('F2')
      fireEvent.click(screen.getByTestId('body-visible-F2'))
      await waitFor(() => expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(false))
      useCamStore.setState({ project: { ...useCamStore.getState().project, name: 'Renamed plate' } })
      expect(bodyRow('F2')).toBeUndefined()
      const hidden = await saved('model-body:F2', 'stl', secondRow)
      expect(hidden.filename).toMatch(/^Renamed plate-.+\.stl$/)
      expect(readStl(hidden.bytes).volume).toBeCloseTo(3000, 4)
      const hiddenStep = await saved('model-body:F2', 'step', secondRow)
      const hiddenParsed = await hooks().client.importStep(hiddenStep.bytes, 'READ-HIDDEN')
      expect(hiddenParsed.bodies).toHaveLength(1)
      expect((await hooks().client.measure(hiddenParsed.bodies[0].handle, 'volume')).value).toBeCloseTo(3000, 5)
      await hooks().client.dispose(hiddenParsed.bodies[0].handle)
      const visibleOnly = await saved('model', 'stl')
      expect(visibleOnly.filename).toBe('Renamed plate.stl')
      expect(readStl(visibleOnly.bytes).volume).toBeCloseTo(8000, 4)
      fireEvent.click(screen.getByTestId('body-visible-F2'))
      await waitFor(() => expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(true))
      const allStep = await saved('model', 'step')
      expect(allStep.filename).toBe('Renamed plate.step')
      const allParsed = await hooks().client.importStep(allStep.bytes, 'READ-ALL')
      expect(allParsed.bodies).toHaveLength(2)
      const volumes = await Promise.all(allParsed.bodies.map(async (body) => (await hooks().client.measure(body.handle, 'volume')).value))
      volumes.sort((a, b) => a - b)
      expect(volumes[0]).toBeCloseTo(3000, 5)
      expect(volumes[1]).toBeCloseTo(8000, 5)
      for (const body of allParsed.bodies) await hooks().client.dispose(body.handle)
      const allStl = await saved('model', 'stl')
      expect(allStl.filename).toBe('Renamed plate.stl')
      expect(readStl(allStl.bytes).volume).toBeCloseTo(11000, 4)
      fireEvent.click(screen.getByTestId('feature-row-SK1'))
      expect(screen.queryByTestId('workbench-export-body-step')).toBeNull()
    } finally {
      cleanup()
      useCamStore.setState({ project: originalProject })
    }
  }, 120_000)
})
