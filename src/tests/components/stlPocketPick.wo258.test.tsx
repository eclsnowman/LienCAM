// @vitest-environment jsdom

// WO-258: an STL part offers its edge chains to 2D Pocket, on the ONE shared
// admission rule WO-251 introduced for Contour - not a copy of it. A pocket is
// bounded by definition, so Pocket sees CLOSED chains only; Contour still sees
// open ones in its open-path mode. These tests pin both halves of that rule at
// the shared seam AND through the real mounted dialog, plus the by-name refusal
// of a chain that no longer exists.

import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Loop2D, Operation, Project, Setup } from '../../types'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'

const stlCache = vi.hoisted(() => ({ load: vi.fn<() => Promise<ArrayBuffer | null>>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: stlCache.load,
  cacheSTL: vi.fn(async () => {}),
  removeCachedSTL: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { resolveOpGeometrySources, useCamStore } = await import('../../store')

const GEO_ID = 'wo258-operator-plate'
const SETUP_ID = 'wo258-setup'
const TOOL_ID = 'wo258-tool'
const OPEN_CHAIN_ID = 'mec:wo258-open-chain'
const OPEN_CHAIN_NAME = 'WO-258 open chain'

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// Commit 2e5678b7 (Smart Height V2 cutover): Smart Height's stock proof reads
// only project.stocks + a proven wcs.stockId (setupProvenStockId /
// smartHeightStockBounds) - the legacy inline setup.stock spec is not
// consulted. A real (unstubbed) Pocket preflight needs a PhysicalStock the
// geometry itself names too.
const STOCK_ID = 'wo258-stock'
const stock = {
  id: STOCK_ID,
  name: 'WO-258 Stock',
  mode: 'explicit',
  bounds: {
    min: { x: -30, y: -30, z: 0 }, max: { x: 30, y: 30, z: 6 },
    size: { x: 60, y: 60, z: 6 }, center: { x: 0, y: 0, z: 3 },
  },
  position: { x: 0, y: 0, z: 0 },
}

function seedProject(): void {
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID,
    name: 'Operator plate STL',
    filename: 'obj_1_Platte C.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    stockId: STOCK_ID,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -27, y: -27, z: 0 },
      max: { x: 27, y: 27, z: 4 },
      size: { x: 54, y: 54, z: 4 },
      center: { x: 0, y: 0, z: 2 },
    },
  }]
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: {
      type: 'rectangular',
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [],
    notes: '',
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [{
      id: TOOL_ID, name: 'WO-258 6mm Flat', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
    project: {
      ...current.project,
      geometry,
      setups: [setup],
      stocks: [stock],
      activeSetupId: SETUP_ID,
    },
  } as never)
}

async function reloadProject(project: Project): Promise<void> {
  const projectText = JSON.stringify(project)
  act(() => { useCamStore.getState().newProject() })
  await act(async () => {
    const store = useCamStore.getState()
    const requestId = store.beginProjectOpen()
    await store.loadProjectFromFile(projectText, requestId)
  })
}

/** The two shipped STL fixtures produce closed chains only (22 and 6), so the
 * open-chain half of the rule has to be staged deliberately. meshContourLoops
 * really does emit `closed: false` / `type: 'open'` chains, so this is the same
 * shape a horizontal open feature yields - added to the SAME derived layer, so
 * it is a genuine mesh edge chain and not a stray projected loop. */
function addOpenChain(): void {
  const geometry = useCamStore.getState().project.geometry.find((geo) => geo.id === GEO_ID)
  const chainLayer = geometry?.layers2d?.find((layer) => layer.name === 'STL edge chains')
  expect(chainLayer).toBeDefined()
  if (!chainLayer) throw new Error('fixture produced no STL edge-chain layer')
  const openChain: Loop2D = {
    id: OPEN_CHAIN_ID,
    name: OPEN_CHAIN_NAME,
    points: [{ x: -10, y: -10 }, { x: 0, y: -10 }, { x: 10, y: -10 }],
    closed: false,
    type: 'open',
    layerId: chainLayer.id,
    area: 0,
  }
  act(() => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        geometry: state.project.geometry.map((geo) => geo.id === GEO_ID
          ? { ...geo, loops: [...(geo.loops ?? []), openChain] }
          : geo),
      },
    }))
  })
}

function openPocketGeometryTab(): void {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('2D Pocket'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('WO-258 6mm Flat'))
  fireEvent.click(screen.getByText('Geometry'))
}

beforeEach(() => {
  // These specs drive NewOperationModalBody's create path, which reaches
  // computeOperationToolpath -> new Worker(...). jsdom has no Worker, so the
  // rejection surfaced as an unhandled error and made vitest exit 1 even with
  // every test green - which is enough to make a full-suite sweep unusable as a
  // gate. Same stub the other NewOperationModal specs use.
  vi.stubGlobal('Worker', class {
    onmessage: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    postMessage(): void { /* no-op */ }
    terminate(): void { /* no-op */ }
  })

  act(() => { useCamStore.getState().newProject() })
  stlCache.load.mockReset()
  stlCache.load.mockResolvedValue(fixtureBuffer())
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-258: STL edge chains in the 2D Pocket geometry dialog', () => {
  it('offers the fresh STL to Pocket, loads its chains on selection, and holds the pick through reload', async () => {
    openPocketGeometryTab()

    // Same admission Contour got in WO-251: an STL is offered BEFORE its chains
    // exist, so selecting it is what triggers the load.
    const sourceSelect = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    expect(Array.from(sourceSelect.options).find((option) => option.value === GEO_ID)?.text)
      .toBe('Operator plate STL (STL - select to load edge chains)')

    fireEvent.change(sourceSelect, { target: { value: GEO_ID } })
    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length)
        .toBeGreaterThan(0)
    })
    expect(Array.from((screen.getByTestId('op-geometry-select') as HTMLSelectElement).options)
      .find((option) => option.value === GEO_ID)?.text)
      .toMatch(/^Operator plate STL \(\d+ STL edge chains\)$/)

    const [firstLoopCheckbox] = Array.from(
      document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]'),
    )
    expect(firstLoopCheckbox).toBeDefined()
    fireEvent.click(firstLoopCheckbox)
    // Commit 2e5678b7: Create stays disabled until the async Smart Height V2
    // preflight resolves.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('pocket_2d')
    expect(created.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { policy: { operationType: 'pocket_2d' } } })
    const selectedChainId = (created.params as { loopIds: string[] }).loopIds[0]
    expect(selectedChainId).toMatch(/^mec:/)
    expect(created.geometrySelections).toEqual([selectedChainId])
    // A pocket boundary is closed by definition - the pick must be a closed chain.
    const pickedLoop = useCamStore.getState().project.geometry[0].loops
      ?.find((loop) => loop.id === selectedChainId)
    expect(pickedLoop?.closed).toBe(true)

    const savedProject = structuredClone(useCamStore.getState().project)
    await reloadProject(savedProject)
    const reloaded = useCamStore.getState().project
    expect(reloaded.geometry[0].loops?.find((loop) => loop.id === selectedChainId)?.id)
      .toBe(selectedChainId)
    expect((reloaded.setups[0].operations[0].params as { loopIds: string[] }).loopIds)
      .toEqual([selectedChainId])
  })

  it('admits closed chains to Pocket and keeps the open one out at the shared source seam', async () => {
    const chains = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    expect(chains.length).toBeGreaterThan(0)
    addOpenChain()
    const geometry = useCamStore.getState().project.geometry

    const [pocketSource] = resolveOpGeometrySources(geometry, GEO_ID, 'pocket_2d')
    const pocketLoopIds = (pocketSource.loops ?? []).map((loop) => loop.id)
    expect(pocketLoopIds).not.toContain(OPEN_CHAIN_ID)
    expect(pocketLoopIds.filter((id) => id.startsWith('mec:'))).toHaveLength(chains.length)
    expect((pocketSource.loops ?? []).every((loop) => loop.closed)).toBe(true)
    // The chains ARE offered, so the layer naming them must travel with them.
    expect(pocketSource.layers2d?.some((layer) => layer.name === 'STL edge chains')).toBe(true)
    expect(resolveOpGeometrySources(geometry, '__all__', 'pocket_2d')).toHaveLength(1)

    // Contour's behaviour is untouched: it still sees the open chain.
    const [contourSource] = resolveOpGeometrySources(geometry, GEO_ID, 'contour_2d')
    expect((contourSource.loops ?? []).map((loop) => loop.id)).toContain(OPEN_CHAIN_ID)
  })

  it('never lists an open chain in the Pocket loop picker', async () => {
    await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    addOpenChain()

    openPocketGeometryTab()
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length)
        .toBeGreaterThan(0)
    })
    expect(screen.queryByText(OPEN_CHAIN_NAME)).toBeNull()
  })

  it('still offers that same open chain to Contour in open-path mode', async () => {
    await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    addOpenChain()

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('WO-258 6mm Flat'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })
    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length)
        .toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByTestId('contour-path-open'))

    expect(screen.getByText(OPEN_CHAIN_NAME)).toBeTruthy()
  })

  it('refuses a persisted pocket chain by stable name when that exact chain is gone', async () => {
    const loops = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    const selected = loops.find((loop) => loop.closed)
    expect(selected).toBeDefined()
    if (!selected) throw new Error('fixture produced no closed STL edge chain')

    const operation = stampSmartHeightAuthority({
      id: 'wo258-op', name: 'STL pocket', type: 'pocket_2d', enabled: true,
      status: 'pending', toolId: TOOL_ID, geometrySelections: [selected.id],
      heights: {}, passes: {}, linking: {},
      params: {
        geometryId: GEO_ID, loopIds: [selected.id], boundarySource: 'geometry',
        direction: 'climb',
      },
    } as unknown as Operation, { stockId: STOCK_ID })
    act(() => { useCamStore.getState().addOperation(SETUP_ID, operation) })
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: state.project.geometry.map((geometry) => geometry.id === GEO_ID
            ? { ...geometry, loops: geometry.loops?.filter((loop) => loop.id !== selected.id) }
            : geometry),
        },
      }))
    })

    await reloadProject(structuredClone(useCamStore.getState().project))
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, operation.id)
    const refused = useCamStore.getState().project.setups[0].operations[0]
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toContain(selected.id)
    expect(refused.errorMessage).toContain('Operator plate STL')
    expect(refused.errorMessage).toMatch(/no longer exists/i)
  })

  it('binds an All Parts pocket chain to the STL it was picked from', async () => {
    const loops = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    const selected = loops.find((loop) => loop.closed)
    expect(selected).toBeDefined()
    if (!selected) throw new Error('fixture produced no closed STL edge chain')

    const duplicateGeoId = 'wo258-duplicate-plate'
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: [
            ...state.project.geometry,
            {
              ...structuredClone(state.project.geometry[0]),
              id: duplicateGeoId,
              name: 'Duplicate plate STL',
            },
          ],
        },
      }))
    })

    openPocketGeometryTab()
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: '__all__' } })
    const [selectedLoopCheckbox] = Array.from(
      document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]'),
    )
    expect(selectedLoopCheckbox).toBeDefined()
    fireEvent.click(selectedLoopCheckbox)
    // Commit 2e5678b7: Create stays disabled until the async Smart Height V2
    // preflight resolves.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const operation = useCamStore.getState().project.setups[0].operations[0]
    expect(operation.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { policy: { operationType: 'pocket_2d' } } })
    const params = operation.params as {
      geometryId: string
      loopIds: string[]
      meshChainSources: Record<string, Array<{ geometryId: string; geometryName: string }>>
    }
    expect(params.geometryId).toBe('__all__')
    expect(params.loopIds).toEqual([selected.id])
    // A WO-244 chain id is content-derived, so both imported copies carry it.
    // The authoring binding is what lets compute name the RIGHT part later.
    expect(params.meshChainSources[selected.id]).toEqual([
      { geometryId: GEO_ID, geometryName: 'Operator plate STL' },
      { geometryId: duplicateGeoId, geometryName: 'Duplicate plate STL' },
    ])

    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: state.project.geometry.map((geometry) => geometry.id === GEO_ID
            ? { ...geometry, loops: geometry.loops?.filter((loop) => loop.id !== selected.id) }
            : geometry),
        },
      }))
    })
    await reloadProject(structuredClone(useCamStore.getState().project))
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, operation.id)
    const refused = useCamStore.getState().project.setups[0].operations[0]
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toContain(selected.id)
    expect(refused.errorMessage).toContain('Operator plate STL')
    expect(refused.errorMessage).not.toContain('Duplicate plate STL')
  })
})
