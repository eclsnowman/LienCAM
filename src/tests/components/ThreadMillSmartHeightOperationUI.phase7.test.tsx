// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  buildThreadMillSmartHeightIntent,
  deriveThreadMillFeatureBindings,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const {
  defaultHeights, defaultLinking, defaultPasses, defaultThreadMillParams,
} = await import('../../components/modals/newOperationModalDefaults')

const tool = {
  id: 'thread-tool-1', name: 'Thread Mill 6 mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 3,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 2 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
  },
  dependencyIds: ['part-1', tool.id],
}

function geometry(withBore: boolean): ImportedGeometry {
  return {
    id: 'part-1', name: withBore ? 'Bore.step' : 'Circle.dxf',
    filename: withBore ? 'Bore.step' : 'Circle.dxf',
    type: withBore ? 'brep' : 'curves_2d', format: withBore ? 'step' : 'dxf',
    loaded: true, loopsVersion: 3,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    loops: [{
      id: 'thread-loop', layerId: 'thread-layer', closed: true, type: 'hole', area: 28,
      points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
    }],
    layers2d: [{
      id: 'thread-layer', name: 'Thread', color: '#fff', visible: true,
      frame: 'geometry_local',
      ...(withBore ? {
        cylinders: [{
          center: [10, 10], diameter: 6, topZ: 10, bottomZ: 2,
          through: false, kind: 'bore', loopId: 'thread-loop',
        }],
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
    },
    stock: null,
  } as unknown as Setup
}

function baseThread(): Operation {
  return {
    id: 'base-thread', name: 'Base Thread', type: 'thread_mill',
    enabled: true, status: 'ready', toolId: tool.id, geometrySelections: ['thread-loop'],
    heights: { ...defaultHeights }, passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: {
      ...defaultThreadMillParams, geometryId: 'part-1', loopIds: ['thread-loop'],
      geometrySource: 'loop', threadDepth: 8,
    },
} as unknown as Operation
}

function smartDetectedThread(): Operation {
  const source = geometry(true)
  const derived = deriveThreadMillFeatureBindings([source], ['thread-loop'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  return {
    ...baseThread(), id: 'smart-thread', name: 'Smart Thread',
    params: {
      ...defaultThreadMillParams, geometryId: source.id, loopIds: ['thread-loop'],
      geometrySource: 'cylinder', threadKind: 'internal', threadDepth: 8,
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildThreadMillSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: defaultHeightIntent(),
        source: 'detected_feature', threadKind: 'internal', threadDepthMm: 8,
        features: derived.bindings.map(binding => ({
          loopId: binding.loopId, featureKind: binding.featureKind,
          feature: binding.feature, topMachineMm: binding.topMm,
          floorMachineMm: binding.floorMm, fingerprint: binding.evidenceFingerprint,
        })),
      }),
    },
    resolvedHeights: snapshot,
} as unknown as Operation
}

function seed(options: { withBore?: boolean; operations?: Operation[] } = {}) {
  const activeSetup = setup(options.operations ?? [])
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    const validated = validatePersistedSmartHeightState(operation.smartHeight)
    expect(validated.ok && validated.state.kind === 'smart_v2').toBe(true)
    return smartHeightPlanFixture(operation, snapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewThreadMillSmartHeights: vi.fn(() => snapshot),
    project: {
      ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
      activeOperationId: activeSetup.operations[0]?.id,
      geometry: [geometry(options.withBore ?? false)],
    },
  } as never)
  return preview
}

async function authorNewThread(): Promise<void> {
  fireEvent.click(screen.getByText('Thread Mill'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('thread-mill-height-policy')).not.toBeNull())
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('Thread Mill Smart Height authoring UI', () => {
  it('authors a flat circle as an explicit V2 thread band and gates Create on preflight', async () => {
    const preview = seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewThread()

    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(preview).toHaveBeenCalled()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(created.params).toMatchObject({
      geometrySource: 'loop', loopIds: ['thread-loop'], threadDepth: 9,
    })
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'thread_mill', variant: 'internal_explicit' },
        machining: {
          scope: { value: { kind: 'selected_geometry', geometryIds: ['part-1'] } },
          end: { value: { formula: { kind: 'thread_band', depthMm: 9 } } },
        },
      },
    })
  })

  it('re-authors a detected bore from stable feature evidence and previews that exact V2 authority', async () => {
    const active = smartDetectedThread()
    const preview = seed({ withBore: true, operations: [active] })
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openEditOperation('setup-1', active.id))
    fireEvent.click(screen.getByText('Heights'))

    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(preview).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('op-create'))

    const saved = useCamStore.getState().project.setups[0].operations[0]
    expect(saved.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'thread_mill', variant: 'internal_top' },
        machining: { scope: { value: { kind: 'selected_features', features: [{ stableId: 'thread-loop' }] } } },
      },
    })
  })

  it('requires reselection when persisted Thread Mill V2 authority is malformed', async () => {
    const invalid = baseThread()
    invalid.smartHeight = { kind: 'smart_v2', intent: {} } as Operation['smartHeight']
    seed({ operations: [invalid] })
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openEditOperation('setup-1', invalid.id))
    await waitFor(() => expect(screen.getByText('Heights')).not.toBeNull())
    fireEvent.click(screen.getByText('Heights'))
    expect(screen.getByTestId('thread-mill-repair-height-note').textContent)
      .toContain('reselect or re-enter its required inputs')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  })
})
