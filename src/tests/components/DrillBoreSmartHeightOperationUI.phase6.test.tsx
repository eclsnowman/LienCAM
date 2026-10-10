// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
// The production Drill height resolvers, before any test replaces them with a fixture.
const realResolvers = (({ previewOperationSmartHeightPlan, previewDrillBoreSmartHeights }) =>
  ({ previewOperationSmartHeightPlan, previewDrillBoreSmartHeights }))(useCamStore.getState())
const {
  buildDrillBoreAuthoringIntent,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { defaultDrillParams, defaultHeights, defaultLinking, defaultPasses } = await import(
  '../../components/modals/newOperationModalDefaults'
)

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const tool = {
  id: 'drill-1', name: '6 mm Drill', type: 'drill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  angleFromAxisDeg: 59, tipDiameter: 0,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 3.2 },
  machine: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 3.2 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 20, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 3.2, provenance: 'inferred' },
  },
  dependencyIds: [stock.id, 'part-1'],
}

function geometry(withPhysicalFloor: boolean): ImportedGeometry {
  return {
    id: 'part-1', name: withPhysicalFloor ? 'Hole.step' : 'Circles.dxf',
    filename: withPhysicalFloor ? 'Hole.step' : 'Circles.dxf',
    type: withPhysicalFloor ? 'brep' : 'curves_2d', format: withPhysicalFloor ? 'step' : 'dxf',
    loaded: true, stockId: stock.id,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    loops: [{
      id: 'hole-1', layerId: 'holes', closed: true, type: 'contour', area: 28,
      points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
    }],
    layers2d: [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
      ...(withPhysicalFloor ? {
        holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 4, through: false, loopId: 'hole-1' }],
      } : {}),
    }],
  } as ImportedGeometry
}

function setup(operations: Operation[] = []): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', notes: '', operations,
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: null,
  } as unknown as Setup
}

function baseDrill(): Operation {
  return {
    id: 'base-drill', name: 'Base Drill', type: 'drill', enabled: true, status: 'ready',
    toolId: tool.id, geometrySelections: ['hole-1'],
    heights: { ...defaultHeights, bottomHeight: -7 },
    passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: { ...defaultDrillParams, geometryId: 'part-1', loopIds: ['hole-1'] },
} as unknown as Operation
}

function smartDrill(): Operation {
  const source = geometry(true)
  const safetyIntent = defaultHeightIntent()
  return {
    ...baseDrill(),
    id: 'smart-drill', name: 'Smart Drill', heightSource: 'override',
    heights: { ...defaultHeights, heightIntent: safetyIntent },
    params: { ...defaultDrillParams, geometryId: source.id, loopIds: ['hole-1'], breakthroughMm: 0.5 },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreAuthoringIntent({
        operationType: 'drill', setupId: 'setup-1', safetyIntent,
        geometries: [source], selectedLoopIds: ['hole-1'],
        draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
      }),
    },
    resolvedHeights: snapshot,
} as unknown as Operation
}

function seed(withPhysicalFloor: boolean, operations: Operation[] = []) {
  const activeSetup = setup(operations)
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    expect(operation.smartHeight?.kind).toBe('smart_v2')
    return smartHeightPlanFixture(operation, snapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewDrillBoreSmartHeights: vi.fn(() => snapshot),
    project: {
      ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
      activeOperationId: operations[0]?.id, stocks: [stock], geometry: [geometry(withPhysicalFloor)],
    },
  } as never)
  return preview
}

async function selectDrillToolAndLoop(): Promise<void> {
  fireEvent.click(screen.getByText('Drill'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('drill-bore-height-policy')).not.toBeNull())
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('Drill/Bore Smart Height authoring UI', () => {
  it('authors detected physical Drill floors as V2 and persists concrete loop scope', async () => {
    const preview = seed(true)
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await selectDrillToolAndLoop()

    expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('detected_features')
    expect(screen.getByTestId('standard-height-top-source').textContent)
      .toContain('Current material')
    expect(screen.getByTestId('standard-height-bottom-source').textContent)
      .toContain('Detected floors + drill point / breakthrough')
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(screen.getByTestId('standard-height-bottom-resolved').textContent).toContain('WCS')
    expect(preview).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(created.params).toMatchObject({ loopIds: ['hole-1'], perHoleDepth: true })
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2', intent: { policy: { operationType: 'drill', variant: 'detected_features' } },
    })
  })

  it('selects explicit Material Start and Target End for a flat circle', async () => {
    seed(false)
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await selectDrillToolAndLoop()

    await waitFor(() => expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('explicit_depth'))
    expect(screen.getByTestId('standard-height-top-source').textContent)
      .toContain('WCS Z (absolute)')
    expect(screen.getByTestId('standard-height-bottom-source').textContent)
      .toContain('WCS Z (absolute)')
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    fireEvent.click(screen.getByTestId('op-create'))
    expect(useCamStore.getState().project.setups[0].operations.at(-1)?.smartHeight)
      .toMatchObject({ kind: 'smart_v2', intent: { policy: { variant: 'explicit_depth' } } })
  })

  // WO-2514: an explicit-depth Drill offers the detected mode's Break through and says where the tip goes.
  it('offers Break through for an explicit-depth Drill and saves it on the operation', async () => {
    seed(false)
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await selectDrillToolAndLoop()

    await waitFor(() => expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('explicit_depth'))
    const explicit = screen.getByTestId('drill-bore-explicit-depth')
    expect(explicit.textContent).toContain('Breakthrough past floor')
    const inputs = explicit.querySelectorAll('input')
    const breakthrough = inputs[inputs.length - 1] as HTMLInputElement
    // WO-2516: Target End -5 is below this stock's bottom (WCS 0), so Break through
    // starts on; the operator turning it off is kept.
    await waitFor(() => expect(breakthrough.value).toBe('0.5'))
    fireEvent.change(breakthrough, { target: { value: '0' } })
    fireEvent.blur(breakthrough)
    await waitFor(() => expect(screen.queryByTestId('drill-explicit-breakthrough-note')).toBeNull())
    expect(breakthrough.value).toBe('0')
    fireEvent.change(breakthrough, { target: { value: '0.5' } })
    fireEvent.blur(breakthrough)
    // The fixture plan resolves the tip to 3.20 mm WCS.
    await waitFor(() => expect(screen.getByTestId('drill-explicit-breakthrough-note').textContent)
      .toBe('Tip to 3.20 mm: full diameter 0.50 mm below the bottom (drill point length added).'))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(created.params).toMatchObject({ breakthroughMm: 0.5, perHoleDepth: false })
    expect(created.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { policy: { variant: 'explicit_depth' } } })
  })

  // WO-2514 audit: changing the Bottom reference, or taking the depth back from
  // the row, keeps the tip where it is - the point and breakthrough are added once.
  it('keeps a breaking-through tip in place across a Bottom reference change and back to explicit', async () => {
    const { previewOperationSmartHeightPlan: realPreview, previewDrillBoreSmartHeights } = realResolvers
    seed(false)
    useCamStore.setState({ previewOperationSmartHeightPlan: realPreview, previewDrillBoreSmartHeights } as never)
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await selectDrillToolAndLoop()
    await waitFor(() => expect((screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement).value)
      .toBe('explicit_depth'))

    const inputs = () => screen.getByTestId('drill-bore-explicit-depth').querySelectorAll('input')
    const type = (input: HTMLInputElement, value: string) => {
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    }
    type(inputs()[0] as HTMLInputElement, '20')
    type(inputs()[1] as HTMLInputElement, '12')
    type(inputs()[inputs().length - 1] as HTMLInputElement, '0.5')
    // 6 mm drill, 118 deg: point length 3 / tan 59 deg = 1.80 mm.
    const tip = 12 - 0.5 - 3 / Math.tan(59 * Math.PI / 180)
    const tipText = `Tip to ${tip.toFixed(2)} mm`
    await waitFor(() => expect(screen.getByTestId('drill-explicit-breakthrough-note').textContent).toContain(tipText))

    fireEvent.click(screen.getByRole('button', { name: /Expand Bottom Height/ }))
    fireEvent.change(screen.getByTestId('standard-height-bottom-source-control'), { target: { value: 'stock_bottom' } })
    await waitFor(() => expect(screen.getByTestId('drill-bore-height-mode') as HTMLSelectElement)
      .not.toHaveProperty('value', 'explicit_depth'))
    // Stock bottom is WCS 0, so the row names the plane the operator set: Stock bottom + 12.
    expect((screen.getByTestId('standard-height-bottom-offset-control').querySelector('input') as HTMLInputElement)
      .value).toBe('12')
    const savedTip = async () => {
      const draft = { ...useCamStore.getState().project.setups[0].operations.at(-1)! }
      return (await realPreview('setup-1', draft)).machining.cutterCenterEnd!.wcsMm
    }
    await waitFor(() => expect(screen.getByTestId('standard-height-bottom-resolved').textContent)
      .toContain(tip.toFixed(3)))

    fireEvent.change(screen.getByTestId('drill-bore-height-mode'), { target: { value: 'explicit_depth' } })
    await waitFor(() => expect(screen.getByTestId('drill-explicit-breakthrough-note').textContent).toContain(tipText))
    expect((inputs()[1] as HTMLInputElement).value).toBe('12')

    fireEvent.click(screen.getByTestId('op-create'))
    expect(await savedTip()).toBeCloseTo(tip, 6)
  })

})

describe('Drill/Bore Smart Height Properties', () => {
  it('shows V2 policy, stable feature scope, allowances, and live resolved truth', async () => {
    const activeOperation = smartDrill()
    const preview = seed(true, [activeOperation])
    render(<PropertiesPanel />)

    // WO-2007 (CS 21): the live plan is read from the height rows, not a diagnostics copy.
    await waitFor(() => expect(screen.getByTestId('props-height-value-top').textContent).toMatch(/^20(\.0+)? mm WCS/))
    expect(screen.getByTestId('props-drill-bore-height-policy').textContent)
      .toContain('Detected physical floors')
    // WO-2007 fix round (CS 21): Operator crossed out 'Authority scope' and 'Drill point' - both read-outs are gone.
    expect(screen.queryByTestId('props-drill-bore-height-scope')).toBeNull()
    expect((screen.getByTestId('props-drill-bore-breakthrough').querySelector('input') as HTMLInputElement).value)
      .toBe('0.5')
    expect(screen.queryByTestId('props-drill-point-allowance')).toBeNull()
    expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/^3\.20* mm WCS/)
    expect(screen.queryByTestId('op-ref-plane-select')).toBeNull()
    expect(preview).toHaveBeenCalledWith('setup-1', activeOperation)
  })

  it('shows Break through for an explicit-depth Drill with the tip in plain words (WO-2514)', async () => {
    const source = geometry(false)
    const safetyIntent = defaultHeightIntent()
    const activeOperation = {
      ...smartDrill(),
      params: { ...defaultDrillParams, geometryId: source.id, loopIds: ['hole-1'], breakthroughMm: 0.5 },
      smartHeight: {
        kind: 'smart_v2',
        intent: buildDrillBoreAuthoringIntent({
          operationType: 'drill', setupId: 'setup-1', safetyIntent,
          geometries: [source], selectedLoopIds: ['hole-1'],
          draft: { mode: 'explicit_depth', explicitStartWcsMm: 0, explicitEndWcsMm: -8 },
        }),
      },
    } as unknown as Operation
    seed(false, [activeOperation])
    render(<PropertiesPanel />)

    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/^3\.20* mm WCS/))
    expect(screen.getByTestId('props-drill-bore-height-policy').textContent).toContain('Explicit WCS planes')
    expect((screen.getByTestId('props-drill-bore-breakthrough').querySelector('input') as HTMLInputElement).value)
      .toBe('0.5')
    expect(screen.getByTestId('props-drill-breakthrough-note').textContent)
      .toBe('Tip to 3.20 mm: full diameter 0.50 mm below the bottom (drill point length added).')
  })

  it('preserves exact detected-feature authority in Properties', () => {
    seed(true, [smartDrill()])
    render(<PropertiesPanel />)
    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') {
      throw new Error('Expected valid Drill V2 authority after safety reset.')
    }
    expect(validated.state.intent.policy).toEqual({
      operationType: 'drill', variant: 'detected_features',
    })
    expect(validated.state.intent.machining.scope.value).toMatchObject({
      kind: 'selected_features', features: [{ stableId: 'hole-1' }],
    })
  })
})
