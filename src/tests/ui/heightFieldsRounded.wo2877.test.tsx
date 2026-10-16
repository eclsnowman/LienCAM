// @vitest-environment jsdom
//
// WO-2877: the Properties panel's Smart height fields showed float noise -
// Clearance 15.000000, Retract/Feed 5.00000005 mm - on a 2D Pocket. They must
// read 15 / 5 like every other length field, while the stored value is not
// rewritten by merely looking at (or tabbing through) the field. Asserted
// through the rendered field, on the shared conventional height rows every
// 2D operation uses.

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const {
  buildContourSmartHeightIntent,
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
  // The sweep's reading: Clearance 15.0000001 (shown truncated as 15.000000)
  // and Retract/Feed 5.00000005 out of the resolver's float arithmetic.
  wcs: { clearance: 15.0000001, retract: 5.00000005, feed: 5.00000005, top: 0, bottom: -5 },
  machine: { clearance: 15.0000001, retract: 5.00000005, feed: 5.00000005, top: 0, bottom: -5 },
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

function geometry(): ImportedGeometry {
  return {
    id: 'part-1', name: 'Feature.step', filename: 'Feature.step',
    type: 'brep', format: 'step',
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
      cylinders: [{
        center: [0, 0], diameter: 10, topZ: 10, bottomZ: 4,
        through: false, kind: 'boss', loopId: 'loop-1',
      }],
    }],
  } as ImportedGeometry
}

function smartContour(): Operation {
  const source = geometry()
  const derived = deriveContourFeatureBindings([source], ['loop-1'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  const safetyIntent = defaultHeightIntent()
  return {
    id: 'smart-contour', name: 'Smart Contour', type: 'contour_2d',
    enabled: true, status: 'ready', toolId: tool.id, geometrySelections: ['loop-1'],
    // Stored heights differ from the plan so the test can tell when the
    // resolved plan (not the stored value) is what the field shows.
    heights: { ...defaultHeights, clearanceHeight: 40, retractHeight: 30, feedHeight: 30, bottomHeight: -7.25, heightIntent: safetyIntent },
    passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: { ...defaultContourParams, geometryId: 'part-1', loopIds: ['loop-1'] },
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

function seed(operation: Operation) {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [operation],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: null,
  } as unknown as Setup
  const preview = vi.fn(async (_setupId: string, op: Operation) => smartHeightPlanFixture(op, resolvedSnapshot))
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewContourSmartHeights: vi.fn(() => resolvedSnapshot),
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id, activeOperationId: operation.id,
      stocks: [stock], geometry: [geometry()],
    },
  } as never)
  return preview
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

const heightInput = (plane: string) =>
  screen.getByTestId(`props-height-row-${plane}`).querySelector('input') as HTMLInputElement

// The first render shows the operation's stored heights (40 / 30); the
// resolved (noisy) plan lands asynchronously. Wait until every field has left
// its stored value.
async function planResolved() {
  await waitFor(() => {
    expect(heightInput('clearance').value).not.toBe('40')
    expect(heightInput('retract').value).not.toBe('30')
    expect(heightInput('feed').value).not.toBe('30')
  })
}

describe('Smart height fields show rounded numbers (WO-2877)', () => {
  it('shows Clearance 15 and Retract/Feed 5, not the resolver float noise', async () => {
    seed(smartContour())
    render(<PropertiesPanel />)
    await planResolved()
    expect(heightInput('clearance').value).toBe('15')
    expect(heightInput('retract').value).toBe('5')
    expect(heightInput('feed').value).toBe('5')
  })

  it('tabbing through a rounded field commits nothing - the stored heights are unchanged', async () => {
    const before = smartContour()
    seed(before)
    render(<PropertiesPanel />)
    await planResolved()
    const stored = useCamStore.getState().project.setups[0].operations[0]
    for (const plane of ['clearance', 'retract', 'feed']) {
      const input = heightInput(plane)
      fireEvent.focus(input)
      fireEvent.blur(input)
    }
    const after = useCamStore.getState().project.setups[0].operations[0]
    expect(after.heights).toEqual(stored.heights)
    expect(after.smartHeight).toEqual(stored.smartHeight)
    expect(screen.getByTestId('props-height-authority-retract').textContent).not.toBe('User Override')
  })

  it('a typed value still reaches the operation', async () => {
    seed(smartContour())
    render(<PropertiesPanel />)
    await planResolved()
    const input = heightInput('clearance')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '20.5' } })
    fireEvent.blur(input)
    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') throw new Error('Expected Smart Height V2 authority')
    expect(validated.state.intent.safety.clearance.owner.kind).toBe('user_override')
  })
})
