// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, Project, Setup } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
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
const realComputeOperationToolpath = useCamStore.getState().computeOperationToolpath

const GEO_ID = 'wo251-operator-plate'
const SETUP_ID = 'wo251-setup'
const STOCK_ID = 'wo251-stock'
const TOOL_ID = 'wo251-tool'

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function seedProject(): void {
  const stock = {
    id: STOCK_ID,
    name: 'WO-251 stock',
    mode: 'explicit',
    bounds: {
      min: { x: -30, y: -30, z: 0 },
      max: { x: 30, y: 30, z: 6 },
      size: { x: 60, y: 60, z: 6 },
      center: { x: 0, y: 0, z: 3 },
    },
    position: { x: 0, y: 0, z: 0 },
  } as PhysicalStock
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
    computeOperationToolpath: vi.fn(),
    toolLibrary: [{
      id: TOOL_ID, name: 'WO-251 6mm Flat', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
    project: {
      ...current.project,
      geometry,
      stocks: [stock],
      setups: [setup],
      activeSetupId: SETUP_ID,
    },
  })
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

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  stlCache.load.mockReset()
  stlCache.load.mockResolvedValue(fixtureBuffer())
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

async function confirmExplicitContourDepth(): Promise<void> {
  fireEvent.click(screen.getByText('Heights'))
  fireEvent.change(screen.getByTestId('contour-height-mode'), {
    target: { value: 'explicit_depth' },
  })
  // f589407e: the preflight renders through the shared ResolvedHeightPlan
  // inspector (resolved-height-plan / resolved-height-refusal testids).
  await waitFor(() => {
    const refusal = screen.queryByTestId('resolved-height-refusal')
    if (refusal) throw new Error(refusal.textContent ?? 'Contour height preflight refused')
    expect(screen.getByTestId('resolved-height-plan')).toBeTruthy()
  })
}

describe('WO-251: STL edge chains in the Contour geometry dialog', () => {
  it('offers a viewport source picker that can materialize a fresh STL source', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))

    expect(screen.getByTestId('op-pick-source-part')).toBeTruthy()
    const sourceSelect = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    expect(Array.from(sourceSelect.options).find((option) => option.value === GEO_ID)?.text)
      .toBe('Operator plate STL (STL - select to load edge chains)')
  })

  it('keeps the real closed-loop count for an STL populated by the projection feature', () => {
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: state.project.geometry.map((geometry) => geometry.id === GEO_ID
            ? {
                ...geometry,
                loops: Array.from({ length: 3 }, (_, index) => ({
                  id: `${GEO_ID}~projected-${index}`,
                  name: `Projected loop ${index + 1}`,
                  points: [
                    { x: index, y: 0 }, { x: index + 1, y: 0 },
                    { x: index + 1, y: 1 }, { x: index, y: 1 },
                  ],
                  closed: true,
                  type: 'contour' as const,
                  layerId: 'stl-projection-layer',
                  area: 1,
                })),
              }
            : geometry),
        },
      }))
    })

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))

    const sourceSelect = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    expect(Array.from(sourceSelect.options).find((option) => option.value === GEO_ID)?.text)
      .toBe('Operator plate STL (3 closed loops)')
  })

  it('does not discard a ready operation toolpath when browsing the STL and records chain materialization in undo history', async () => {
    const readyMoves = [{ type: 'rapid', x: 1, y: 2, z: 3 }]
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          setups: state.project.setups.map((setup) => setup.id === SETUP_ID
            ? {
                ...setup,
                operations: [{
                  id: 'wo251-ready-3d', name: 'Ready parallel', type: 'parallel_3d', enabled: true,
                  status: 'ready', toolId: TOOL_ID, geometrySelections: [],
                  heights: {}, passes: {}, linking: {}, toolpathMoves: readyMoves,
                  params: { geometryId: GEO_ID },
                } as unknown as Operation],
              }
            : setup),
        },
      }))
    })

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })

    await waitFor(() => {
      expect(useCamStore.getState().project.geometry[0].loops?.length).toBeGreaterThan(0)
    })
    const readyAfterBrowse = useCamStore.getState().project.setups[0].operations[0]
    expect(readyAfterBrowse.status).toBe('ready')
    expect(readyAfterBrowse.toolpathMoves).toEqual(readyMoves)

    act(() => { useCamStore.getState().undo() })
    expect(useCamStore.getState().project.geometry[0].loops ?? []).toHaveLength(0)
  })

  it('recognizes a duplicated STL chain layer after its id and loop ids are remapped', async () => {
    const original = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    const originalGeometry = useCamStore.getState().project.geometry[0]
    const originalLayer = originalGeometry.layers2d?.find((layer) => layer.name === 'STL edge chains')
    expect(originalLayer).toBeDefined()
    if (!originalLayer) throw new Error('fixture produced no STL edge-chain layer')

    const duplicateLayerId = 'duplicate-remapped-chain-layer'
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: state.project.geometry.map((geometry) => geometry.id === GEO_ID
            ? {
                ...geometry,
                layers2d: geometry.layers2d?.map((layer) => layer.id === originalLayer.id
                  ? { ...layer, id: duplicateLayerId }
                  : layer),
                loops: geometry.loops?.map((loop, index) => loop.layerId === originalLayer.id
                  ? { ...loop, id: `${GEO_ID}~duplicate-${index}`, layerId: duplicateLayerId }
                  : loop),
              }
            : geometry),
        },
      }))
    })
    stlCache.load.mockClear()

    const reused = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    expect(reused).toHaveLength(original.length)
    expect(useCamStore.getState().project.geometry[0].loops).toHaveLength(original.length)
    expect(stlCache.load).not.toHaveBeenCalled()
  })

  // WO-258 (architect ruling 2026-08-12T07:52Z): the exclusivity this asserted
  // was WO-251's scaffold, not a product rule - Pocket now consumes closed
  // chains through the same shared predicate. Narrowed, not deleted: chains
  // still have no meaning for Drill or Engrave and must stay out of both.
  it('keeps materialized STL feature chains out of the operations that cannot cut them', async () => {
    const chains = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    expect(chains.length).toBeGreaterThan(0)
    const geometry = useCamStore.getState().project.geometry

    const contourSources = resolveOpGeometrySources(geometry, '__all__', 'contour_2d')
    expect(contourSources).toHaveLength(1)
    expect(contourSources[0].loops?.some((loop) => loop.id.startsWith('mec:'))).toBe(true)

    for (const operationType of ['drill', 'engrave'] as const) {
      expect(resolveOpGeometrySources(geometry, '__all__', operationType)).toEqual([])
      const [directSource] = resolveOpGeometrySources(geometry, GEO_ID, operationType)
      expect(directSource.loops).toEqual([])
      expect(directSource.layers2d?.some((layer) => layer.name === 'STL edge chains')).toBe(false)
    }

    const selectedChainId = chains[0].id
    act(() => { useCamStore.getState().undo() })
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          setups: state.project.setups.map((setup) => setup.id === SETUP_ID
            ? {
                ...setup,
                operations: [{
                  id: 'wo251-ready-pocket', name: 'Ready pocket', type: 'pocket_2d', enabled: true,
                  status: 'ready', toolId: TOOL_ID, geometrySelections: [selectedChainId],
                  heights: {}, passes: {}, linking: {}, toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
                  params: { geometryId: GEO_ID, loopIds: [selectedChainId] },
                } as unknown as Operation],
              }
            : setup),
        },
      }))
    })
    await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready')
  })

  // Architect ruling 2026-08-12T05:40Z: a materialized chain MAY be picked in
  // the viewport - that is Operator's "just like STEP". Capability that arrives by
  // accident leaves by accident, so assert it deliberately: the chain reaches
  // loop-pick mode, and a hit on it resolves to that exact chain id.
  it('registers a materialized STL chain for viewport loop picking under its own chain id', async () => {
    const setLoopPickMode = vi.fn<(
      handler: ((loopId: string, nowSelected: boolean) => void) | null,
      allowedGeoId: string | null,
    ) => void>()
    const setPickedLoops = vi.fn<(loopIds: string[]) => void>()
    ;(window as unknown as Record<string, unknown>).__cncViewport = { setLoopPickMode, setPickedLoops }

    const chains = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    const chain = chains.find((candidate) => candidate.closed)
    expect(chain).toBeDefined()
    if (!chain) throw new Error('fixture produced no closed STL edge chain')
    expect(chain.id).toMatch(/^mec:/)

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('WO-251 6mm Flat'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: GEO_ID } })

    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
    })

    // Both of these are what the src/tests/evidence/WO-251/ capture shows, and
    // they are the positive half of the UI-60 contract: the part that was not
    // viewport-pickable while fresh becomes pickable once its chains exist.
    expect(screen.getByTestId('op-pick-source-part')).toBeTruthy()
    expect(Array.from((screen.getByTestId('op-geometry-select') as HTMLSelectElement).options)
      .find((option) => option.value === GEO_ID)?.text)
      .toMatch(/^Operator plate STL \(\d+ STL edge chains\)$/)

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    const registration = [...setLoopPickMode.mock.calls]
      .reverse()
      .find(([handler]) => typeof handler === 'function')
    expect(registration).toBeDefined()
    const [onViewportPick, allowedGeoId] = registration!
    expect(allowedGeoId).toBe(GEO_ID)
    expect(typeof onViewportPick).toBe('function')

    act(() => { onViewportPick?.(chain.id, true) })
    // An id that is not one of this part's chains must be refused, not coerced
    // onto a neighbouring chain: the viewport highlight snaps back to the pick.
    act(() => { onViewportPick?.('mec:not-a-chain-on-this-part', true) })
    expect(setPickedLoops).toHaveBeenLastCalledWith([chain.id])

    await confirmExplicitContourDepth()
    await waitFor(() => {
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect((created.params as { loopIds: string[] }).loopIds).toEqual([chain.id])
    expect(created.geometrySelections).toEqual([chain.id])
  })

  it('mounts the real dialog, offers the STL, picks a stable chain, and preserves it through reload', async () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('WO-251 6mm Flat'))
    fireEvent.click(screen.getByText('Geometry'))

    expect(screen.queryByText('No geometry loaded')).toBeNull()
    const sourceSelect = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    expect(Array.from(sourceSelect.options).map((option) => option.value)).toContain(GEO_ID)
    fireEvent.change(sourceSelect, { target: { value: GEO_ID } })

    await waitFor(() => {
      expect(useCamStore.getState().project.geometry[0].loops?.length).toBeGreaterThan(0)
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
    })

    const loops = useCamStore.getState().project.geometry[0].loops ?? []
    const top = loops.filter((loop) => loop.closed && loop.name?.includes('(Z 4)'))
    expect(top).toHaveLength(6)
    expect(top.every((loop) => loop.id.startsWith('mec:'))).toBe(true)

    const [firstLoopCheckbox] = Array.from(
      document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]'),
    )
    expect(firstLoopCheckbox).toBeDefined()
    fireEvent.click(firstLoopCheckbox)
    await confirmExplicitContourDepth()
    await waitFor(() => {
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    const selectedChainId = (created.params as { loopIds: string[] }).loopIds[0]
    expect(selectedChainId).toMatch(/^mec:/)
    expect(created.geometrySelections).toEqual([selectedChainId])

    const savedProject = structuredClone(useCamStore.getState().project)
    await reloadProject(savedProject)
    const reloaded = useCamStore.getState().project
    expect(reloaded.geometry[0].loops?.find((loop) => loop.id === selectedChainId)?.id)
      .toBe(selectedChainId)
    expect((reloaded.setups[0].operations[0].params as { loopIds: string[] }).loopIds)
      .toEqual([selectedChainId])
  })

  it('refuses a persisted chain by stable name when that exact chain is gone', async () => {
    const loops = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    const selected = loops.find((loop) => loop.closed)
    expect(selected).toBeDefined()
    if (!selected) throw new Error('fixture produced no closed STL edge chain')

    const operation = {
      id: 'wo251-op', name: 'STL contour', type: 'contour_2d', enabled: true,
      status: 'pending', toolId: TOOL_ID, geometrySelections: [selected.id],
      heights: {}, passes: {}, linking: {},
      // frozen_v1 died with 2e5678b7; a valid V2 envelope is the only way past
      // addOperation, so the chain-gone refusal below is really the one tested.
      smartHeight: smartHeightAuthorityFixture('contour_2d', {
        setupId: SETUP_ID, geometryIds: [GEO_ID], stockId: STOCK_ID,
      }),
      params: {
        geometryId: GEO_ID, loopIds: [selected.id], side: 'outer', direction: 'climb', tabs: false,
      },
    } as unknown as Operation
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
    useCamStore.setState({ computeOperationToolpath: realComputeOperationToolpath })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, operation.id)
    const refused = useCamStore.getState().project.setups[0].operations[0]
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toContain(selected.id)
    expect(refused.errorMessage).toContain('Operator plate STL')
    expect(refused.errorMessage).toMatch(/no longer exists/i)
  })

  it('refuses an All Parts chain missing from its named STL even when another STL has the same id', async () => {
    const loops = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    const selected = loops.find((loop) => loop.closed)
    expect(selected).toBeDefined()
    if (!selected) throw new Error('fixture produced no closed STL edge chain')

    const duplicateGeoId = 'wo251-duplicate-plate'
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
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('WO-251 6mm Flat'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: '__all__' } })
    const [selectedLoopCheckbox] = Array.from(
      document.querySelectorAll<HTMLInputElement>('.op-loop-list input[type="checkbox"]'),
    )
    expect(selectedLoopCheckbox).toBeDefined()
    fireEvent.click(selectedLoopCheckbox)
    await confirmExplicitContourDepth()
    await waitFor(() => {
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('op-create'))

    const operation = useCamStore.getState().project.setups[0].operations[0]
    const params = operation.params as {
      geometryId: string
      loopIds: string[]
      meshChainSources: Record<string, Array<{ geometryId: string; geometryName: string }>>
    }
    expect(params.geometryId).toBe('__all__')
    expect(params.loopIds).toEqual([selected.id])
    expect(params.meshChainSources[selected.id]).toEqual([
      { geometryId: GEO_ID, geometryName: 'Operator plate STL' },
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
    useCamStore.setState({ computeOperationToolpath: realComputeOperationToolpath })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, operation.id)
    const refused = useCamStore.getState().project.setups[0].operations[0]
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toContain(selected.id)
    expect(refused.errorMessage).toContain('Operator plate STL')
    expect(refused.errorMessage).toMatch(/no longer exists/i)
    expect(refused.errorMessage).not.toContain('Duplicate plate STL')
  })
})
