// @vitest-environment jsdom
//
// WO-1580: the Properties panel's HEIGHTS rows read like a single-line
// Passes row (label left, value input + a single-line unit on the right,
// a truncated single-line source underneath, a compact disclosure) instead
// of stacking a wrapped unit, a wrapped formula and a full disclosure block
// across 4-5 lines each. This file asserts the row structure survives the
// layout change and that editing still reaches the operation.
//
// The WO's acceptance text asks for "typing a Bottom Height override" to
// still reach the operation. The Properties panel's conventional height
// rows never gave Top/Bottom Height an editable control (confirmed by
// WO-1544's own result notes: "The Properties panel height rows were not
// changed... they have no control to edit them" - that edit path lives in
// the New/Edit Operation modal, out of this WO's owned paths). Clearance
// Height is the analogous row that IS editable here, through the same
// commitHeights -> heightIntentAfterNumericEdit path WO-1544 relies on for
// every safety plane, so it is what this file exercises for the override
// regression leg.

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
    heights: { ...defaultHeights, bottomHeight: -7.25, heightIntent: safetyIntent },
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

describe('Properties panel Heights rows fit the panel (WO-1580)', () => {
  it('renders every conventional height row with its value input/unit and its source line inside the row', async () => {
    seed(smartContour())
    render(<PropertiesPanel />)
    await waitFor(() => {
      // WO-2007 (CS 21): the live plan is read from the height rows, not a diagnostics copy.
      expect(screen.queryByTestId('props-live-height-plan-loading')).toBeNull()
      expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/ mm WCS/)
    })

    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      const row = screen.getByTestId(`props-height-row-${plane}`)
      const valueLine = row.querySelector('.props-height-value-line')
      expect(valueLine, `${plane} row is missing its value line`).not.toBeNull()
      // A single-line unit is present either beside a live input (clearance/
      // retract/feed) or as the read-only resolved text (top/bottom).
      expect(valueLine!.querySelector('.props-height-unit')).not.toBeNull()

      // WO-2007 (CS 21): the formula is no longer a visible line or a disclosure;
      // it is the value's hover tooltip and its hidden accessible description.
      const source = screen.getByTestId(`props-height-formula-${plane}`)
      expect(source.hidden).toBe(true)
      expect(row.contains(source)).toBe(true)
      expect(screen.getByTestId(`props-height-value-${plane}`).getAttribute('data-tooltip'))
        .toContain(source.textContent!)
      expect(screen.queryByTestId(`props-height-explanation-${plane}`)).toBeNull()
    }

    // Clearance/Retract/Feed are the rows this panel can edit; Top/Bottom
    // have no input here (see the file banner above).
    for (const plane of ['clearance', 'retract', 'feed']) {
      expect(screen.getByTestId(`props-height-row-${plane}`).querySelector('input')).not.toBeNull()
    }
    for (const plane of ['top', 'bottom']) {
      expect(screen.getByTestId(`props-height-row-${plane}`).querySelector('input')).toBeNull()
    }
  })

  it('typing a Clearance Height override still reaches the operation (the WO-1544 commitHeights path)', () => {
    seed(smartContour())
    render(<PropertiesPanel />)

    const input = screen.getByTestId('props-height-row-clearance').querySelector('input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.blur(input)

    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') {
      throw new Error('Expected valid Contour V2 authority after the Clearance Height edit.')
    }
    expect(validated.state.intent.safety.clearance.owner.kind).toBe('user_override')
    expect(screen.getByTestId('props-height-authority-clearance').textContent).toBe('User Override')
  })
})
