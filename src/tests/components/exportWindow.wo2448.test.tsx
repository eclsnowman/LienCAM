// @vitest-environment jsdom
//
// WO-2448: ONE Export window reaches every existing writer. Opened from the
// toolbar entry (which replaced "Bundle (.zip)") and from the body right-click
// in the Model workspace. Every row is driven through the window's own controls
// and the saved file is read back here, independently of the writer.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { strFromU8, unzipSync } from 'fflate'

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

const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { ExportModal } = await import('../../components/modals/ExportModal')
const { useCamStore } = await import('../../store')
const { useFormStore } = await import('../../form/formStore')
const { publishSimulationStock } = await import('../../lib/exportCenter')
const { HeightmapSimulator } = await import('../../lib/simulation/HeightmapSimulator')
const { parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { writeRegisteredLocalData } = await import('../../store/persistedKeys')
const { BUILT_IN_DIALECTS, serializeUserPostConfig } = await import('../../lib/post')
const { bytesToDataUrl } = await import('../../referenceImage/imageData')
const { installFakeIndexedDB } = await import('../helpers/fakeIndexedDB')
const { makeTool } = await import('../post/helpers')
import type { ImportedGeometry, Loop2D, NestRecord, Operation, Setup } from '../../types'
import type { Sketch } from '../../lib/sketch/types'

type Written = { name: string; bytes: Uint8Array }
let written: Written[]
let failNext = false
const text = (w: Written) => new TextDecoder().decode(w.bytes)

beforeEach(() => {
  installFakeIndexedDB()
  written = []
  failNext = false
  vi.stubGlobal('liencamHost', { saveFile: async (name: string, data: string | Uint8Array) => {
    if (failNext) { failNext = false; throw new Error('disk full') }
    written.push({ name, bytes: typeof data === 'string' ? new TextEncoder().encode(data) : data })
    return 'test-download'
  } })
})

afterEach(() => {
  act(() => { useCamStore.getState().closeModal() })
  cleanup()
  vi.unstubAllGlobals()
  publishSimulationStock(null)
  useFormStore.getState().closeSession()
})

// ---- independent readers (no product writer or parser) ----
function dxfPairs(source: string): Array<[number, string]> {
  const lines = source.trimEnd().split(/\r?\n/)
  expect(lines.length % 2).toBe(0)
  const pairs: Array<[number, string]> = []
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i]), lines[i + 1].trim()])
  expect(pairs.at(-1)).toEqual([0, 'EOF'])
  return pairs
}
const dxfEntities = (source: string) => dxfPairs(source).filter(([c, v], i, all) => c === 0 && i > 0 &&
  all.slice(0, i).some(([cc, vv]) => cc === 2 && vv === 'ENTITIES') && !['SECTION', 'ENDSEC', 'EOF'].includes(v)).map(([, v]) => v)
function svgRoot(source: string): Element {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  expect(doc.querySelector('parsererror')).toBeNull()
  expect(doc.documentElement.nodeName).toBe('svg')
  return doc.documentElement
}
function stlTriangles(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(80, true)
  expect(bytes.byteLength).toBe(84 + 50 * count)
  return count
}
const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

// ---- the project: a sketch, an operation, a nest sheet, a simulation, a form, libraries ----
const stlBytes = new Uint8Array(84 + 50)
new DataView(stlBytes.buffer).setUint32(80, 1, true)

function loop(id: string, pts: [number, number][], type: Loop2D['type']): Loop2D {
  return { id, points: pts.map(([x, y]) => ({ x, y })), closed: true, type, layerId: 'L', area: 1 } as Loop2D
}
const base = {
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 1 } },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
}
const plate = {
  ...base, id: 'g-plate', name: 'Plate', filename: 'Plate.stl', type: '3d', format: 'stl',
  originalFile: { fileName: 'Plate.stl', dataUrl: bytesToDataUrl(stlBytes, 'model/stl') },
  loops: [loop('o', [[0, 0], [40, 0], [40, 20], [0, 20]], 'contour')],
} as unknown as ImportedGeometry
const sketch: Sketch = {
  id: 'sk-1', layerId: 'layer-1', ownerGeometryId: 'g-sketches', constraints: [], dimensions: [], solveStatus: null,
  entities: [{ id: 'e1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 25, y: 10 } }],
} as unknown as Sketch
const sketches = {
  ...base, id: 'g-sketches', name: 'Sketches', filename: '', type: '2d', format: 'sketch',
  layers2d: [{ id: 'layer-1', name: 'Bracket outline', visible: true, sourceType: 'sketch' }], sketches: [sketch], loops: [],
} as unknown as ImportedGeometry
const op = (id: string, name: string): Operation => ({
  id, name, type: '2d-contour', status: 'done',
  toolpathMoves: [
    { type: 'rapid', x: 0, y: 0, z: 5 }, { type: 'feed', x: 0, y: 0, z: -1 },
    { type: 'feed', x: 20, y: 0, z: -1 }, { type: 'feed', x: 20, y: 10, z: -1 }, { type: 'rapid', x: 20, y: 10, z: 5 },
  ],
} as unknown as Operation)
const setup = {
  id: 'setup-1', name: 'Setup 1', notes: '', stock: { type: 'auto' }, operations: [op('op-1', 'Outline'), op('op-2', 'Pocket')],
  wcs: { id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
} as unknown as Setup
const nest: NestRecord = {
  id: 'nest-1', name: 'Sheet A', sheet: { width: 200, height: 120 }, style: 'ninety',
  spacing: { partGap: 2, sheetMargin: 3, windowGap: 0 }, seed: 1,
  sources: [{ geometryId: 'g-plate', quantity: 1 }],
  placements: [{ partId: 'g-plate', instanceId: 'i1', x: 10, y: 10, rotationDeg: 0, depth: 0 }],
  unplaced: [], utilization: 0.1,
} as NestRecord
const macro = { id: 'm-1', name: 'Coolant on', mCode: 101, body: "lines('M8')\n", color: 'green' } as const
const userPost = {
  ...structuredClone(BUILT_IN_DIALECTS.find((d) => d.id === 'grbl')!), id: 'user-shop', label: 'Shop post', builtin: false,
  originalVendorPost: { filename: 'shop.cps', bytesBase64: btoa('// vendor post source\n') },
}

function seedProject(): void {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({
      activeSketch: null,
      toolLibrary: [makeTool({ id: 't1', name: '6 mm flat' })],
      project: {
        ...s.project, name: 'Export proof', geometry: [plate, sketches], setups: [setup], nests: [nest],
        modelItems: [], fonts: {}, referenceImages2d: [],
        machine: { ...s.project.machine, controller: 'grbl' },
      },
    }))
    const machine = parkCarrierMachine(useCamStore.getState())
    saveParkMachineRecord({ ...machine, macros: [macro] })
    if (useCamStore.getState().machineLibrary.length === 0) {
      useCamStore.setState((s) => ({ machineLibrary: [s.project.machine] }))
    }
  })
  writeRegisteredLocalData('userPosts', JSON.stringify([JSON.parse(serializeUserPostConfig(userPost))]))
  const sim = new HeightmapSimulator(-6, -6, 12, 12, 0, -4, 1)
  publishSimulationStock(sim)
  useFormStore.getState().openSession({ featureId: null, name: 'Form 1' })
}

/** Pick a format through the window's ThemedListbox, press Save, return the file it wrote. */
async function saveVia(rowId: string, format?: string): Promise<Written> {
  if (format !== undefined) {
    fireEvent.click(screen.getByTestId(`export-format-${rowId}`))
    fireEvent.click(await screen.findByTestId(`export-format-${rowId}-option-${format}`))
  }
  const before = written.length
  fireEvent.click(screen.getByTestId(`export-save-${rowId}`))
  await waitFor(() => expect(written.length).toBe(before + 1), { timeout: 15_000 })
  return written.at(-1)!
}

const groupIds = () => Array.from(document.querySelectorAll('[data-testid^="export-group-"]'))
  .map((el) => el.getAttribute('data-testid')!.replace('export-group-', ''))

describe('WO-2448 the one Export window', () => {
  it('toolbar: Export replaces Bundle (.zip) and opens the window', () => {
    seedProject()
    render(<><TopToolbar /><ExportModal /></>)
    expect(screen.queryByText('Bundle (.zip)')).toBeNull()
    expect(screen.queryByTestId('export-modal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(screen.getByTestId('export-modal')).toBeTruthy()
    // Only what this project has; no Model workspace was opened, so no Model group.
    expect(groupIds()).toEqual(['project', 'sketches', 'toolpaths', 'nesting', 'simulation', 'form', 'setups', 'libraries', 'settings'])
  })

  it('clean: no helper text, no disabled control, no native select, labels of one or two words', () => {
    seedProject()
    render(<ExportModal />)
    act(() => { useCamStore.getState().openModal('export') })
    const modal = screen.getByTestId('export-modal')
    // The WO-1182 census selectors, applied to this window.
    const HINTS = ['.op-hint', '.mform-help', '.mform-hint', '.op-type-desc', '.nest-hint', '.scope-empty-note', '[role="note"]'].join(',')
    expect(modal.querySelectorAll(HINTS).length).toBe(0)
    expect(modal.querySelectorAll('[disabled]').length).toBe(0)
    expect(modal.querySelectorAll('select').length).toBe(0)
    for (const header of modal.querySelectorAll('.mform-section-header')) {
      expect(header.textContent!.trim().split(/\s+/).length).toBeLessThanOrEqual(2)
    }
    for (const button of modal.querySelectorAll('button.modal-btn')) expect(button.textContent).toBe('Save')
    // A single-format row shows no format choice.
    expect(screen.queryByTestId('export-format-setups')).toBeNull()
    expect(screen.getByTestId('export-format-project')).toBeTruthy()
  })

  it('every kind saves through its existing writer, from the window', async () => {
    seedProject()
    render(<ExportModal />)
    act(() => { useCamStore.getState().openModal('export') })

    // Project: .camproject, bundle .zip, imported original
    let f = await saveVia('project', 'camproject')
    expect(f.name).toBe('Export_proof.camproject')
    expect((JSON.parse(text(f)) as { name?: string; project?: { name: string } }).project?.name ?? JSON.parse(text(f)).name).toBe('Export proof')
    f = await saveVia('project', 'zip')
    expect(f.name).toBe('Export_proof.zip')
    expect(Object.keys(unzipSync(f.bytes))).toContain('Export_proof.camproject')
    f = await saveVia('original:geo:g-plate')
    expect(f.name).toBe('Plate.stl')
    expect(Array.from(f.bytes)).toEqual(Array.from(stlBytes))

    // Sketch DXF
    f = await saveVia('sketch:g-sketches:layer-1')
    expect(f.name).toBe('Bracket outline.dxf')
    expect(dxfEntities(text(f))).toEqual(['LINE'])

    // Toolpaths DXF / SVG
    f = await saveVia('toolpath:setup-1:op-1', 'dxf')
    expect(f.name).toBe('Outline.dxf')
    expect(dxfEntities(text(f)).length).toBeGreaterThan(0)
    f = await saveVia('toolpath:setup-1:op-2', 'svg')
    expect(f.name).toBe('Pocket.svg')
    expect(svgRoot(text(f)).querySelectorAll('path, polyline').length).toBeGreaterThan(0)

    // Nest sheet DXF / SVG
    f = await saveVia('nest:nest-1', 'dxf')
    expect(f.name).toMatch(/^Sheet_A.*\.dxf$|^Sheet A.*\.dxf$/)
    expect(dxfEntities(text(f))).toContain('LWPOLYLINE')
    f = await saveVia('nest:nest-1', 'svg')
    expect(f.name).toMatch(/\.svg$/)
    expect(svgRoot(text(f)).querySelectorAll('path').length).toBe(2)

    // Simulation cut stock STL
    f = await saveVia('simulation')
    expect(f.name).toBe('simulation-stock.stl')
    expect(stlTriangles(f.bytes)).toBeGreaterThan(0)

    // Form cage OBJ
    f = await saveVia('form')
    expect(f.name).toBe('Form 1.obj')
    expect(text(f).split('\n').filter((l) => l.startsWith('v ')).length).toBeGreaterThan(0)
    expect(text(f).split('\n').filter((l) => l.startsWith('f ')).length).toBeGreaterThan(0)

    // Setups JSON
    f = await saveVia('setups')
    expect(f.name).toBe('LienCAM-setups.json')
    expect(JSON.parse(text(f))).toMatchObject({ schema: 'liencam-setups', setups: [{ id: 'setup-1', operationCount: 2 }] })

    // Libraries: tools CSV + JSON, machine, machine library, posts, macros
    f = await saveVia('tools', 'csv')
    expect(f.name).toBe('tool_library.csv')
    expect(text(f).trim().split(/\r?\n/)).toHaveLength(2)
    f = await saveVia('tools', 'json')
    expect(f.name).toBe('tool_library.json')
    expect((JSON.parse(text(f)) as { name: string }[]).map((t) => t.name)).toEqual(['6 mm flat'])
    const machine = useCamStore.getState().project.machine
    f = await saveVia('machine')
    expect(f.name).toBe(`${machine.name.replace(/\s+/g, '_')}.machine.json`)
    expect(JSON.parse(text(f))).toBeTruthy()
    f = await saveVia('machine-library')
    expect(f.name).toBe('machine_library.json')
    expect(JSON.parse(text(f))).toBeTruthy()
    f = await saveVia('post:grbl')
    expect(f.name).toMatch(/\.json$/)
    expect(JSON.parse(text(f))).toMatchObject({ id: 'grbl' })
    f = await saveVia('post:user-shop', 'json')
    expect(JSON.parse(text(f))).toMatchObject({ id: 'user-shop', label: 'Shop post' })
    f = await saveVia('post:user-shop', 'original')
    expect(f.name).toBe('shop.cps')
    expect(text(f)).toBe('// vendor post source\n')
    f = await saveVia('macro:m-1', 'json')
    expect(f.name).toBe('macro-Coolant on.json')
    expect(JSON.parse(text(f))).toMatchObject({ format: 'liencam-macro', macro: { id: 'm-1' } })
    f = await saveVia('macro:m-1', 'txt')
    expect(f.name).toBe('macro-Coolant on.txt')
    expect(text(f)).toBe(macro.body)

    // Settings profile
    f = await saveVia('settings')
    expect(f.name).toBe('LienCAM-settings-profile.json')
    expect(JSON.parse(text(f))).toMatchObject({ schema: 'liencam-user-profile' })
  }, 60_000)

  it('a Model reference image saves its original from the window (WO-2449: no button on its panel)', async () => {
    seedProject()
    const image = { fileName: 'plan.png', dataUrl: bytesToDataUrl(new Uint8Array([137, 80, 78, 71]), 'image/png') }
    const node = { payload: { datumType: 'reference-image', image } }
    ;(window as unknown as { __solidsWorkbenchHooks: unknown }).__solidsWorkbenchHooks = {
      dag: { nodeIds: () => ['img-1'], getNode: () => node, isEffectivelySuppressed: () => false, isRolledBack: () => false },
    }
    try {
      render(<ExportModal />)
      act(() => { useCamStore.getState().openModal('export') })
      expect(groupIds()).toContain('model')
      const f = await saveVia('original:model-image:img-1')
      expect(f.name).toBe('plan.png')
    } finally {
      delete (window as unknown as { __solidsWorkbenchHooks?: unknown }).__solidsWorkbenchHooks
    }
  })

  it('a failed save is one console warning and nothing in the window', async () => {
    seedProject()
    render(<ExportModal />)
    act(() => { useCamStore.getState().openModal('export') })
    const before = useCamStore.getState().consoleEvents.length
    const modalText = screen.getByTestId('export-modal').textContent
    failNext = true
    fireEvent.click(screen.getByTestId('export-save-setups'))
    await waitFor(() => expect(useCamStore.getState().consoleEvents.length).toBe(before + 1))
    const event = useCamStore.getState().consoleEvents.at(-1)!
    expect(event.severity).toBe('warning')
    expect(event.message).toMatch(/disk full/)
    expect(screen.getByTestId('export-modal').textContent).toBe(modalText)
  })

  it('one library of several is exported on its own, as the Tool Library did', async () => {
    seedProject()
    act(() => {
      useCamStore.setState({
        toolLibraries: [{ id: 'lib-a', name: 'Wood bits' }, { id: 'lib-b', name: 'Empty' }],
        toolLibrary: [makeTool({ id: 't1', name: '6 mm flat', libraryId: 'lib-a' }), makeTool({ id: 't2', name: '3 mm ball', libraryId: 'lib-b' })],
      })
    })
    render(<ExportModal />)
    act(() => { useCamStore.getState().openModal('export') })
    const f = await saveVia('tools:lib-a', 'json')
    expect(f.name).toBe('Wood_bits.json')
    expect((JSON.parse(text(f)) as { name: string }[]).map((t) => t.name)).toEqual(['6 mm flat'])
    const c = await saveVia('tools:lib-a', 'csv')
    expect(c.name).toBe('Wood_bits.csv')
    expect(text(c).trim().split(/\r?\n/)).toHaveLength(2)
  })

  it('groups with nothing in them are not shown', () => {
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.setState((s) => ({ toolLibrary: [], machineLibrary: [], project: { ...s.project, geometry: [], setups: [], nests: [] } }))
      saveParkMachineRecord({ ...parkCarrierMachine(useCamStore.getState()), macros: [] })
    })
    mem.clear()
    render(<ExportModal />)
    act(() => { useCamStore.getState().openModal('export') })
    expect(groupIds()).toEqual(['project', 'libraries', 'settings'])
    expect(screen.queryByTestId('export-row-tools')).toBeNull()
  })

  it('a new sketch is in the window before Finish, and keeps one row after it', async () => {
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.getState().startNewSketch()
    })
    const draft = useCamStore.getState().activeSketch!
    render(<ExportModal />)
    // A blank draft has nothing to export.
    act(() => { useCamStore.getState().openModal('export') })
    expect(groupIds()).not.toContain('sketches')
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.setState({ activeSketch: { ...draft, entities: [...draft.entities,
        { id: 'live-line', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 25, y: 10 } }] } })
    })
    expect(useCamStore.getState().project.geometry.flatMap((geo) => geo.sketches ?? [])).toEqual([])

    act(() => { useCamStore.getState().openModal('export') })
    const rows = () => Array.from(document.querySelectorAll('[data-testid="export-group-sketches"] [data-testid^="export-row-"]'))
    expect(rows()).toHaveLength(1)
    const rowId = rows()[0].getAttribute('data-testid')!.replace('export-row-', '')
    let f = await saveVia(rowId)
    expect(f.name).toMatch(/\.dxf$/)
    expect(dxfEntities(text(f))).toContain('LINE')

    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.getState().bakeActiveSketch()
      useCamStore.getState().openModal('export')
    })
    expect(rows()).toHaveLength(1)
    f = await saveVia(rows()[0].getAttribute('data-testid')!.replace('export-row-', ''))
    expect(dxfEntities(text(f))).toContain('LINE')
  })
})

// ---- the Model workspace: right-click a body -> Export... -> the window opens on the model ----
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { fakeCreateSceneRuntime } = await import('../model3d/fakeSceneRuntime')
const { mintRectangleSketch } = await import('../model3d/mintRectangleSketch')
const { waitForLoadedModel3d } = await import('../model3d/loadTolerantWaitFor')

function field(id: string, value: string): void {
  const input = screen.getByTestId(id).querySelector('input')!
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('WO-2448 Export... on a Model body', () => {
  it('feature tree and body list right-click open the window on the model; STEP/STL/3MF save', async () => {
    render(createElement('div', null,
      createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: fakeCreateSceneRuntime }),
      createElement(ExportModal)))
    await waitForLoadedModel3d(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await mintRectangleSketch({ id: 'SK1', width: 40, height: 20, offset: 10 })
    await waitForLoadedModel3d(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitForLoadedModel3d(() => expect(screen.getByTestId('extrude-profile-select')).toBeTruthy())
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'SK1' } })
    field('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitForLoadedModel3d(() => expect(window.__solidsWorkbenchHooks!.getBodyHandle('F1')).toBeDefined(), { timeout: 20_000 })

    // A sketch row is not a body: no Export... on its menu.
    fireEvent.contextMenu(screen.getByTestId('feature-row-SK1'), { clientX: 30, clientY: 30 })
    expect(screen.queryByTestId('tree-context-menu-export')).toBeNull()
    fireEvent.click(screen.getByTestId('tree-context-menu-backdrop'))

    // Feature tree body row.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'), { clientX: 30, clientY: 30 })
    fireEvent.click(screen.getByTestId('tree-context-menu-export'))
    expect(screen.getByTestId('export-modal')).toBeTruthy()
    expect(screen.getByTestId('export-row-model').getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('export-save-model'))

    let f = await saveVia('model', 'step')
    expect(f.name).toBe('Untitled Project.step')
    expect(text(f).startsWith('ISO-10303-21;')).toBe(true)
    f = await saveVia('model', 'stl')
    expect(f.name).toBe('Untitled Project.stl')
    expect(stlTriangles(f.bytes)).toBeGreaterThanOrEqual(12)
    f = await saveVia('model', '3mf')
    expect(f.name).toBe('workbench-export.3mf')
    const model = new DOMParser().parseFromString(strFromU8(unzipSync(f.bytes)['3D/3dmodel.model']), 'application/xml')
    expect(model.querySelectorAll('triangles > triangle').length).toBeGreaterThanOrEqual(12)
    expect(isZip(f.bytes)).toBe(true)

    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByTestId('export-modal')).toBeNull()

    // Body list row.
    const bodyRow = document.querySelector('[data-testid^="body-row-"]') as HTMLElement
    fireEvent.contextMenu(bodyRow, { clientX: 40, clientY: 60 })
    fireEvent.click(screen.getByTestId('tree-context-menu-export'))
    expect(screen.getByTestId('export-row-model').getAttribute('aria-current')).toBe('true')
  }, 90_000)
})

describe('WO-2448 Simulation: the live stock reaches the window', () => {
  it.each(['heightmap', 'voxel'] as const)('%s: a real simulation baseline appears under Simulation, saves from the window, and leaves with the stock', async (engine) => {
    const { SimulationPanel } = await import('../../components/simulation/SimulationPanel')
    const { makeOp } = await import('../post/helpers')
    const vp = {
      setToolMarkerPosition: vi.fn(), showToolMarker: vi.fn(), updateToolGeometry: vi.fn(),
      disposeStockSim: vi.fn(), disposeVoxelSim: vi.fn(), setStockSimVisible: vi.fn(), setStockSimOpacity: vi.fn(),
      initStockSim: vi.fn(() => ({ x0: 0, y0: 0, nx: 20, ny: 20, cellSize: 1, stockTop: 10, stockBot: 0 })),
      updateStockSimHeights: vi.fn(), initVoxelSim: vi.fn(), syncVoxelSim: vi.fn(),
      supportsVoxelSim: vi.fn(() => engine === 'voxel'), setSimulationToolpathPreview: vi.fn(),
    }
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.setState((s) => ({
        toolLibrary: [makeTool({ id: 't-sim', diameter: 6 })],
        project: {
          ...s.project, name: 'Sim proof', nests: [],
          machine: { ...s.project.machine, rapidRate: 5000 },
          setups: [{
            ...setup, id: 'setup-sim',
            stock: { type: 'rectangular', width: 20, height: 20, depth: 10, offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
            operations: [makeOp({ id: 'op-sim', toolId: 't-sim', toolpathMoves: [
              { type: 'feed', role: 'cut', x: 2, y: 10, z: 8, feed: 600 },
              { type: 'feed', role: 'cut', x: 18, y: 10, z: 8, feed: 600 },
            ] })],
          } as Setup],
          activeSetupId: 'setup-sim', activeOperationId: 'op-sim',
        },
        viewer: { ...s.viewer, mode: 'simulation', stockSimEnabled: true, stockSimResolution: 1 },
        appSettings: { ...s.appSettings, displayUnits: 'mm', simulationEngine: engine },
      }))
    })
    // Installed after newProject: the panel drives this viewport, the project reload does not.
    Object.defineProperty(window, '__cncViewport', { configurable: true, value: vp })
    try {
      render(<><TopToolbar /><SimulationPanel /><ExportModal /></>)
      // The panel carries no stock button of its own (WO-2449); the window's Simulation
      // group appears once the baseline is real.
      fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
      await waitFor(() => expect(groupIds()).toContain('simulation'))
      expect(screen.queryByRole('button', { name: 'Export stock (STL)' })).toBeNull()
      // The engine named is the one that ran.
      expect(vp.initVoxelSim.mock.calls.length > 0).toBe(engine === 'voxel')
      const fromWindow = await saveVia('simulation')
      expect(fromWindow.name).toMatch(/\.stl$/)
      expect(stlTriangles(fromWindow.bytes)).toBeGreaterThan(0)

      // Stock simulation off: no stock, so no Simulation group.
      fireEvent.click(screen.getByRole('checkbox', { name: /stock/i }))
      expect(screen.getByTestId('export-modal')).toBeTruthy()
      expect(groupIds()).not.toContain('simulation')
    } finally {
      Reflect.deleteProperty(window, '__cncViewport')
    }
  }, 60_000)
})
