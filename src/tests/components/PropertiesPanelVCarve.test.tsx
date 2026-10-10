// @vitest-environment jsdom
//
// WO-1174: the Properties panel shows a V-carve operation's authority (datum,
// start depth, flat depth, floors, outline scope) and re-authors the V2
// formula when a depth field is edited in place.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { buildVCarveSmartHeightIntent, validatePersistedSmartHeightState } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const tool = {
  id: 'vbit-1', name: '90 deg V-bit', type: 'v_bit',
  diameter: 12, tipDiameter: 0, angleFromAxisDeg: 45, fluteLength: 10, numberOfFlutes: 2,
} as unknown as Tool

const snapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 21, top: 10, bottom: 8 },
  machine: { clearance: 120, retract: 115, feed: 111, top: 100, bottom: 98 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 21, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 10, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: 8, provenance: 'inferred' as const },
  },
  dependencyIds: ['art-1', tool.id],
}

function operation(flatDepthMm: number | undefined = 2): Operation {
  const heightIntent = defaultHeightIntent()
  return {
    id: 'vcarve-op', name: 'V-carve 1', type: 'vcarve', enabled: true,
    status: 'ready', toolId: tool.id,
    geometrySelections: ['letter'],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25,
      feedHeight: 21, topHeight: 10, topHeightMode: 'absolute', bottomHeight: 8,
      bottomHeightMode: 'absolute', heightIntent,
    },
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildVCarveSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: heightIntent,
        datumReference: 'geometry_plane', datumOffsetMm: 0,
        startDepthMm: 0.5,
        flatDepth: flatDepthMm === undefined ? { kind: 'tool_limit' } : { kind: 'explicit', depthMm: flatDepthMm },
        scope: { geometryIds: ['art-1'], loopIds: ['letter'] },
      }),
    },
    resolvedHeights: snapshot,
    passes: { stepdown: 0, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: 'art-1', loopIds: ['letter'], role: 'carve',
      flatDepthMm, startDepthMm: 0.5, allowanceMm: 0,
      flatClearing: { mode: 'tool', clearingToolDiameter: 4, stepoverMm: 0.5 },
      tolerance: 0.01, heightReference: 'geometry_face', planeOffset: 0,
    },
  } as Operation
}

function seed(activeOperation: Operation) {
  const planPreview = vi.fn(async (_setupId: string, candidate: Operation) => smartHeightPlanFixture(candidate, snapshot))
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [activeOperation],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 90 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    previewOperationSmartHeightPlan: planPreview,
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id, activeOperationId: activeOperation.id,
      geometry: [], stocks: [],
    },
    viewer: {
      ...state.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null,
    },
  } as never)
  return { planPreview }
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('V-carve Properties panel', () => {
  it('shows the carve authority: datum, start depth, flat depth, floors, outline scope, and the live plan', async () => {
    const active = operation(2)
    const { planPreview } = seed(active)
    render(<PropertiesPanel />)

    // WO-2007 fix round (CS 21): Role, Datum, Flat floors and Outlines read-outs are gone; Edit carve settings changes them.
    for (const gone of ['props-vcarve-role', 'props-vcarve-datum', 'props-vcarve-flat-clearing', 'props-vcarve-scope']) {
      expect(screen.queryByTestId(gone)).toBeNull()
    }
    expect(screen.getByTestId('props-vcarve-edit-height')).not.toBeNull()
    // WO-2007 (CS 21): the live plan is read from the height rows, not a diagnostics copy.
    await waitFor(() => {
      expect(screen.queryByTestId('props-live-height-plan-loading')).toBeNull()
      expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/ mm WCS/)
    })
    expect(planPreview).toHaveBeenCalledWith('setup-1', active)
  })

  it('editing the flat depth in place re-authors the V2 formula', () => {
    seed(operation(2))
    render(<PropertiesPanel />)
    const input = screen.getByTestId('props-vcarve-flat-depth').querySelector('input') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.blur(input)

    const saved = useCamStore.getState().project.setups[0].operations[0]
    expect(saved.params).toMatchObject({ flatDepthMm: 3, startDepthMm: 0.5 })
    const validated = validatePersistedSmartHeightState(saved.smartHeight)
    expect(validated.ok && validated.state.kind === 'smart_v2').toBe(true)
    if (validated.ok && validated.state.kind === 'smart_v2') {
      expect(validated.state.intent.policy).toEqual({ operationType: 'vcarve', variant: 'flat_depth' })
      const end = validated.state.intent.machining.end.value
      expect(end).toMatchObject({ kind: 'geometry_tool_formula', formula: { kind: 'vcarve_region', startDepthMm: 0.5, flatDepth: { kind: 'explicit', depthMm: 3 } } })
    }
  })

  it('switching to the bit\'s own limit changes the policy variant', () => {
    seed(operation(2))
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-vcarve-clear-flat-depth'))
    const saved = useCamStore.getState().project.setups[0].operations[0]
    expect((saved.params as { flatDepthMm?: number }).flatDepthMm).toBeUndefined()
    const validated = validatePersistedSmartHeightState(saved.smartHeight)
    if (validated.ok && validated.state.kind === 'smart_v2') {
      expect(validated.state.intent.policy).toEqual({ operationType: 'vcarve', variant: 'tool_limit' })
    } else {
      throw new Error('authority lost')
    }
  })
})
