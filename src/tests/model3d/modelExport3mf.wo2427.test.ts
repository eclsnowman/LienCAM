// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { strFromU8, unzipSync } from 'fflate'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { ExportModal } from '../../components/modals/ExportModal'
import { openExportWindow } from '../../lib/exportCenter'
import { useCamStore } from '../../store'
import { createLocalGeomService } from '../../geom'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  if (!window.__solidsWorkbenchHooks) throw new Error('workbench not ready')
  return window.__solidsWorkbenchHooks
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
}

function field(id: string, value: string): void {
  const input = screen.getByTestId(id).querySelector('input')!
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

async function box(sketch: string, body: string, offset: number): Promise<void> {
  await mintRectangleSketch({ id: sketch, width: 40, height: 20, offset })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${sketch}`)).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  await waitFor(() => expect(screen.getByTestId('extrude-profile-select')).toBeTruthy())
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sketch } })
  field('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle(body)).toBeDefined(), { timeout: 20_000 })
}

// Independent reader: no product import3mf, merge helper, or writer involved.
function read3mf(bytes: ArrayBuffer): { positions: number[]; indices: number[] } {
  const archive = unzipSync(new Uint8Array(bytes))
  const parse = (path: string) => new DOMParser().parseFromString(strFromU8(archive[path]), 'application/xml')
  const rels = parse('_rels/.rels')
  expect(rels.querySelector('Relationship')?.getAttribute('Target')).toBe('/3D/3dmodel.model')
  expect(parse('[Content_Types].xml').querySelector('Default[Extension="model"]')?.getAttribute('ContentType'))
    .toBe('application/vnd.ms-package.3dmanufacturing-3dmodel+xml')
  const model = parse('3D/3dmodel.model')
  expect(model.querySelector('parsererror')).toBeNull()
  expect(model.documentElement.getAttribute('unit')).toBe('millimeter')
  expect(model.querySelector('build > item')?.getAttribute('objectid')).toBe(model.querySelector('object')?.getAttribute('id'))
  const numbers = (selector: string, attrs: string[]) => Array.from(model.querySelectorAll(selector))
    .flatMap(el => attrs.map(attr => Number(el.getAttribute(attr))))
  const positions = numbers('vertices > vertex', ['x', 'y', 'z'])
  const indices = numbers('triangles > triangle', ['v1', 'v2', 'v3'])
  expect(positions.every(Number.isFinite)).toBe(true)
  expect(indices.every(i => Number.isInteger(i) && i >= 0 && i < positions.length / 3)).toBe(true)
  return { positions, indices }
}

function bounds(positions: number[]): number[] {
  return [0, 1, 2].flatMap(axis => {
    const values = positions.filter((_, i) => i % 3 === axis)
    return [Math.min(...values), Math.max(...values)]
  })
}

async function download(): Promise<{ bytes: ArrayBuffer; filename: string; mime: string }> {
  const savedCreate = URL.createObjectURL
  const savedRevoke = URL.revokeObjectURL
  let blob: Blob | undefined
  let filename = ''
  URL.createObjectURL = (value: Blob | MediaSource) => { blob = value as Blob; return 'blob:wo2427' }
  URL.revokeObjectURL = () => {}
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
  try {
    act(() => { openExportWindow('model') })
    fireEvent.click(screen.getByTestId('export-format-model'))
    fireEvent.click(screen.getByTestId('export-format-model-option-3mf'))
    fireEvent.click(screen.getByTestId('export-save-model'))
    await waitFor(() => expect(blob).toBeDefined())
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob!)
    })
    return { bytes, filename, mime: blob!.type }
  } finally {
    act(() => { useCamStore.getState().closeModal() })
    URL.createObjectURL = savedCreate
    URL.revokeObjectURL = savedRevoke
    click.mockRestore()
  }
}

async function expectExportOf(ids: string[]): Promise<void> {
  const sourcePositions: number[] = []
  const sourceIndices: number[] = []
  for (const id of ids) {
    const source = await hooks().client.tessellate(hooks().getBodyHandle(id)!, DISPLAY_TESS_QUALITY)
    const base = sourcePositions.length / 3
    sourcePositions.push(...source.position)
    sourceIndices.push(...Array.from(source.index, i => i + base))
  }
  const result = await download()
  expect(result.filename).toBe('workbench-export.3mf')
  expect(result.mime).toBe('model/3mf')
  const parsed = read3mf(result.bytes)
  expect(parsed.indices.length / 3).toBe(sourceIndices.length / 3)
  expect(bounds(parsed.positions)).toEqual(bounds(sourcePositions))
  expect(parsed.positions).toEqual(sourcePositions)
  expect(parsed.indices).toEqual(sourceIndices)
}

describe('WO-2427 Model workspace 3MF export', () => {
  it('adds the control beside unchanged STEP/STL and exports a real body through its click action', async () => {
    render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: fakeCreateSceneRuntime }))
    render(createElement(ExportModal))
    await ready()
    act(() => { openExportWindow('model') })
    expect(screen.queryByTestId('export-row-model')).toBeNull()
    act(() => { useCamStore.getState().closeModal() })
    await box('SK1', 'F1', 10)
    act(() => { openExportWindow('model') })
    const button = screen.getByTestId('export-save-model') as HTMLButtonElement
    fireEvent.click(screen.getByTestId('export-format-model'))
    expect(screen.getByTestId('export-format-model-option-3mf').textContent).toBe('3MF')
    expect(screen.getByTestId('export-format-model').getAttribute('aria-label')).toBe('Model format')
    expect(button.disabled).toBe(false)
    expect(screen.getByTestId('export-format-model-option-step').textContent).toBe('STEP')
    expect(screen.getByTestId('export-format-model-option-stl').textContent).toBe('STL')
    expect(screen.getByRole('listbox').querySelectorAll('[role="option"]')).toHaveLength(3)
    expect(Array.from(screen.getByRole('listbox').querySelectorAll('[role="option"]'), option => option.textContent)).toEqual(['STEP', 'STL', '3MF'])
    fireEvent.click(screen.getByTestId('export-format-model-option-3mf'))
    act(() => { useCamStore.getState().closeModal() })
    await expectExportOf(['F1'])
  }, 60_000)

  it('rebases independent bodies and honors persisted hidden and superseded bodies at click time', async () => {
    const runtime = createFakeSceneRuntime()
    render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: () => runtime }))
    render(createElement(ExportModal))
    await ready()
    await box('SK1', 'F1', 10)
    await box('SK2', 'F2', 100)
    await expectExportOf(['F1', 'F2'])
    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.hidden).toBe(true))
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    runtime.rayOverride = { origin: { x: 120, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
    field('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).toBeDefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')?.hidden).toBe(false)
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    await expectExportOf(['F3'])
  }, 60_000)

  it('uses the existing missing-handle and empty-body behavior', async () => {
    render(createElement(SolidsWorkbenchPage, { createClient: createFakeGeomClient, createSceneRuntime: fakeCreateSceneRuntime }))
    await ready()
    await expect(hooks().export3mf(['F99'])).rejects.toThrow(/missing body handle.*F99/)
    await expect(hooks().export3mf([])).rejects.toThrow(/no body to export/)
  })

  it('removes the 3MF control when all bodies are hidden, with no error or download', async () => {
    render(createElement(SolidsWorkbenchPage, { createClient: createFakeGeomClient, createSceneRuntime: fakeCreateSceneRuntime }))
    render(createElement(ExportModal))
    await ready()
    await box('SK1', 'F1', 10)
    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.hidden).toBe(true))
    const saved = URL.createObjectURL
    const create = vi.fn(() => 'blob:unexpected')
    URL.createObjectURL = create
    try {
      act(() => { openExportWindow('model') })
      await waitFor(() => expect(screen.queryByTestId('export-row-model')).toBeNull())
      expect(useCamStore.getState().consoleEvents.filter(event => event.source === 'export')).toEqual([])
      expect(create).not.toHaveBeenCalled()
    } finally {
      URL.createObjectURL = saved
    }
  })
})
