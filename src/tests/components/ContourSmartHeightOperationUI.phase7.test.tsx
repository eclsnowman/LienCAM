// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const {
  buildContourSmartHeightIntent,
  buildFaceSmartHeightIntent,
  deriveContourFeatureBindings,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { defaultContourParams, defaultHeights, defaultLinking, defaultPasses } = await import(
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
  id: 'tool-1', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as unknown as Tool

const resolvedSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 4.5 },
  machine: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 4.5 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 20, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 4.5, provenance: 'inferred' },
  },
  dependencyIds: [stock.id, 'part-1'],
}

function geometry(withFeature = true): ImportedGeometry {
  return {
    id: 'part-1', name: withFeature ? 'Feature.step' : 'Flat.dxf',
    filename: withFeature ? 'Feature.step' : 'Flat.dxf',
    type: withFeature ? 'brep' : 'curves_2d', format: withFeature ? 'step' : 'dxf',
    loaded: true, stockId: stock.id, loopsVersion: 2,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    loops: [{
      id: 'loop-1', layerId: 'layer-1', closed: true, type: 'contour', area: 78.5,
      points: [{ x: 5, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 }],
    }],
    layers2d: [{
      id: 'layer-1', name: 'Profile', color: '#fff', visible: true, frame: 'geometry_local',
      ...(withFeature ? {
        cylinders: [{
          center: [0, 0], diameter: 10, topZ: 10, bottomZ: 4,
          through: false, kind: 'boss', loopId: 'loop-1',
        }],
      } : {}),
    }],
  } as ImportedGeometry
}

function baseContour(): Operation {
  return {
    id: 'base-contour', name: 'Base Contour', type: 'contour_2d',
    enabled: true, status: 'ready', toolId: tool.id, geometrySelections: ['loop-1'],
    heights: { ...defaultHeights, bottomHeight: -7.25 },
    passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: { ...defaultContourParams, geometryId: 'part-1', loopIds: ['loop-1'] },
} as unknown as Operation
}

function smartContour(): Operation {
  const source = geometry(true)
  const derived = deriveContourFeatureBindings([source], ['loop-1'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  const safetyIntent = defaultHeightIntent()
  return {
    ...baseContour(),
    id: 'smart-contour',
    name: 'Smart Contour',
    heights: { ...defaultHeights, heightIntent: safetyIntent },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildContourSmartHeightIntent({
        setupId: 'setup-1',
        safetyIntent,
        mode: 'selected_feature',
        features: derived.bindings.map(binding => binding.feature),
      }),
    },
} as unknown as Operation
}

function seed(options: { withFeature?: boolean; operations?: Operation[] } = {}) {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: options.operations ?? [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: null,
  } as unknown as Setup
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    expect(operation.smartHeight?.kind).toBe('smart_v2')
    return smartHeightPlanFixture(operation, resolvedSnapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewContourSmartHeights: vi.fn(() => resolvedSnapshot),
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id,
      activeOperationId: setup.operations[0]?.id,
      stocks: [stock], geometry: [geometry(options.withFeature ?? true)],
    },
  } as never)
  return preview
}

async function selectToolAndLoop(): Promise<void> {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
    target: { value: 'part-1' },
  })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('contour-height-policy')).not.toBeNull())
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('Contour Smart Height authoring UI', () => {
  it('authors detected feature floors as V2 and gates Create on the resolved preflight', async () => {
    const preview = seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await selectToolAndLoop()

    expect((screen.getByTestId('contour-height-mode') as HTMLSelectElement).value)
      .toBe('selected_feature')
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(preview).toHaveBeenCalled()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'contour_2d', variant: 'selected_feature' },
        machining: { end: { value: { kind: 'detected_feature_floors' } } },
      },
    })
  })

  it('starts a flat curve on Stock bottom (WO-1610) and resolves after an explicit endpoint is chosen', async () => {
    seed({ withFeature: false })
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await selectToolAndLoop()

    await waitFor(() => expect((screen.getByTestId('contour-height-mode') as HTMLSelectElement).value)
      .toBe('stock_bottom'))
    expect(screen.queryByText(/flat curve with no physical floor/)).toBeNull()

    fireEvent.change(screen.getByTestId('contour-height-mode'), { target: { value: 'explicit_depth' } })
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('op-create'))

    expect(useCamStore.getState().project.setups[0].operations.at(-1)?.smartHeight)
      .toMatchObject({ kind: 'smart_v2', intent: { policy: { variant: 'explicit_depth' } } })
  })

})

describe('Contour Smart Height Properties panel', () => {
  it('shows V2 authority, stable scope, and live resolved height truth', async () => {
    const activeOperation = smartContour()
    const preview = seed({ operations: [activeOperation] })
    render(<PropertiesPanel />)

    await waitFor(() => {
      // WO-2007 (CS 21): the live plan is read from the height rows, not a diagnostics copy.
      expect(screen.queryByTestId('props-live-height-plan-loading')).toBeNull()
      expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/ mm WCS/)
    })
    expect(screen.getByTestId('props-contour-height-policy').textContent)
      .toContain('Detected feature floor')
    // WO-2007 fix round (CS 21): the Physical scope read-out is gone; End policy stays because it carries Edit Target End.
    expect(screen.queryByTestId('props-contour-height-scope')).toBeNull()
    // f589407e: the five conventional height rows are shared across families.
    expect(screen.getByTestId('props-height-row-top').textContent).toContain('20.000')
    expect(screen.getByTestId('props-height-row-bottom').textContent).toContain('4.500')
    expect(screen.queryByTestId('op-ref-plane-select')).toBeNull()
    expect(preview).toHaveBeenCalledWith('setup-1', activeOperation)
  })

  it('preserves exact feature authority when safety is edited', () => {
    seed({ operations: [smartContour()] })
    render(<PropertiesPanel />)
    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '35' } })
    fireEvent.blur(clearance)

    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') {
      throw new Error('Expected valid Contour V2 authority after safety edit.')
    }
    expect(validated.state.intent.policy).toEqual({
      operationType: 'contour_2d', variant: 'selected_feature',
    })
    expect(validated.state.intent.machining.scope.value).toMatchObject({
      kind: 'selected_features',
      features: [{ stableId: 'loop-1', sourceVersion: 2 }],
    })

  })


  it('fails loud for mismatched policy and hides stale scalar controls', () => {
    const invalid = smartContour()
    invalid.smartHeight = {
      kind: 'smart_v2',
      intent: buildFaceSmartHeightIntent({
        setupId: 'setup-1',
        safetyIntent: defaultHeightIntent(),
        mode: 'explicit_depth',
        stockId: stock.id,
        explicitTargetWcsMm: 4.5,
      }),
    }
    const preview = seed({ operations: [invalid] })
    render(<PropertiesPanel />)

    expect(screen.getByTestId('props-contour-invalid-height-note').textContent)
      .toContain('carries a face Smart Height policy')
    expect(screen.queryByTestId('op-ref-plane-select')).toBeNull()
    // Another family's envelope is not this operation's authority: the shared
    // height rows offer no edit and say so, exactly as compute would refuse.
    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      expect(screen.getByTestId(`props-height-formula-${plane}`).textContent).toBe('Repair required')
      expect(screen.getByTestId(`props-height-row-${plane}`).querySelector('input')).toBeNull()
    }
    expect(preview).toHaveBeenCalledOnce()
  })
})
