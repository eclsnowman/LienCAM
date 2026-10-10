// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, Setup, Tool } from '../../types'
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
  buildChamferSmartHeightIntent,
  buildFaceSmartHeightIntent,
  chamferSmartHeightDraftFromIntent,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const tool = {
  id: 'chamfer-tool', name: '90 degree chamfer mill', type: 'chamfer_mill',
  diameter: 10, tipDiameter: 0, angleFromAxisDeg: 45, fluteLength: 12,
  numberOfFlutes: 3,
} as unknown as Tool

const feature = {
  loopId: 'edge-1',
  feature: {
    modelItemId: 'model-1', bodyId: 'body-1', featureKind: 'chamfer_edge',
    stableId: 'edge-1', sourceVersion: 1, sourceFingerprint: 'edge-topology-r1',
  },
  fingerprint: 'edge-evidence-r1',
}

const snapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 21, top: 10, bottom: 7 },
  machine: { clearance: 120, retract: 115, feed: 111, top: 100, bottom: 97 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 21, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 10, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: 7, provenance: 'inferred' as const },
  },
  dependencyIds: ['edge-1'],
}

function operation(authority: 'smart' | 'frozen' | 'mismatched' = 'smart'): Operation {
  const heightIntent = defaultHeightIntent()
  const smartHeight = authority === 'smart'
    ? {
        kind: 'smart_v2' as const,
        intent: buildChamferSmartHeightIntent({
          setupId: 'setup-1', safetyIntent: heightIntent,
          datumReference: 'geometry_plane', datumOffsetMm: 0.5,
          chamferWidthMm: 1, tipOffsetMm: 2, features: [feature],
        }),
      }
    : authority === 'mismatched'
      ? {
          kind: 'smart_v2' as const,
          intent: buildFaceSmartHeightIntent({
            setupId: 'setup-1', safetyIntent: heightIntent, mode: 'explicit_depth',
            stockId: 'stock-1', explicitTargetWcsMm: 0,
          }),
        }
      : { kind: 'frozen_v1' as const, resolverVersion: 1 as const }
  return {
    id: 'chamfer-op', name: 'Chamfer 1', type: 'chamfer', enabled: true,
    status: 'ready', toolId: tool.id,
    geometrySelections: ['edge-1'],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25,
      feedHeight: 21, topHeight: 10, topHeightMode: 'absolute', bottomHeight: 7,
      bottomHeightMode: 'absolute', heightIntent,
    },
    smartHeight,
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: 'part-1', loopIds: ['edge-1'], chamferWidth: 1, tipOffset: 2,
      heightReference: 'geometry_face', planeOffset: 0.5, overlapMm: 0,
    },
  } as Operation
}

function seed(activeOperation: Operation, preview = vi.fn(() => snapshot)) {
  const planPreview = vi.fn(async (_setupId: string, candidate: Operation) => {
    const plan = smartHeightPlanFixture(candidate, snapshot)
    if (plan.policy.operationType !== candidate.type) {
      throw new Error(`Operation carries a ${plan.policy.operationType} Smart Height policy.`)
    }
    return plan
  })
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
    previewChamferSmartHeights: preview,
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
  return { preview, planPreview }
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('Chamfer Smart Height Properties panel', () => {
  it('shows stable authority, editable formula controls, and the shared live V2 plan', async () => {
    const activeOperation = operation()
    const { planPreview } = seed(activeOperation)
    render(<PropertiesPanel />)

    // WO-2007 fix round (CS 21): scope and the read-only width/tip copies are gone; the editable fields carry the values once.
    expect(screen.queryByTestId('props-chamfer-height-scope')).toBeNull()
    expect(screen.queryByTestId('props-chamfer-width-authority')).toBeNull()
    expect(screen.queryByTestId('props-chamfer-tip-authority')).toBeNull()
    expect(Number((screen.getByTestId('props-chamfer-width').querySelector('input') as HTMLInputElement).value)).toBe(1)
    expect(Number((screen.getByTestId('props-chamfer-tip-offset').querySelector('input') as HTMLInputElement).value)).toBe(2)
    // WO-2007 (CS 21): the resolved endpoint is the Bottom row value, not a diagnostics copy.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^7(\.0+)? mm WCS/))
    expect(planPreview).toHaveBeenCalledWith('setup-1', activeOperation)
  })

  it('updates the persisted formula when width and tip values are edited', () => {
    seed(operation())
    render(<PropertiesPanel />)

    for (const [testId, value] of [['props-chamfer-width', '2.5'], ['props-chamfer-tip-offset', '1.25']] as const) {
      const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    }

    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') throw new Error('Expected valid Chamfer V2 authority.')
    expect(chamferSmartHeightDraftFromIntent(validated.state.intent)).toEqual({
      datumReference: 'geometry_plane', datumOffsetMm: 0.5,
      chamferWidthMm: 2.5, tipOffsetMm: 1.25,
    })
    expect(validated.state.intent.machining.scope.value).toEqual({
      kind: 'selected_features', features: [feature.feature],
    })
    expect(updated.params).toMatchObject({ chamferWidth: 2.5, tipOffset: 1.25 })
  })

  it('preserves the formula and stable edge scope on safety edit', () => {
    seed(operation())
    render(<PropertiesPanel />)
    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '42' } })
    fireEvent.blur(clearance)
    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') throw new Error('Expected valid Chamfer V2 authority after edit.')
    expect(chamferSmartHeightDraftFromIntent(validated.state.intent)).toMatchObject({
      chamferWidthMm: 1, tipOffsetMm: 2,
    })
    expect(validated.state.intent.machining.scope.value).toEqual({
      kind: 'selected_features', features: [feature.feature],
    })
  })

  it('requires an old frozen project to be repaired in the operation editor', async () => {
    seed(operation('frozen'))
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-chamfer-invalid-height-note').textContent)
      .toContain('no valid Smart Height V2 setup')
    // WO-2007 (CS 21): one plain refusal row replaces the diagnostics refusal; the repair row stays.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(screen.getByTestId('op-height-repair-required').textContent).toContain('Smart Height V2')
    fireEvent.click(screen.getByTestId('props-chamfer-repair-height'))
    expect(useCamStore.getState().activeModal).toBe('edit-operation')
  })

  it('fails loud for mismatched V2 authority and never runs Chamfer preview', async () => {
    const { preview, planPreview } = seed(operation('mismatched'))
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-chamfer-invalid-height-note').textContent)
      .toContain('carries a face Smart Height policy')
    expect(preview).not.toHaveBeenCalled()
    // WO-2007 (CS 21): the refusal is one plain row in the Heights group.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(planPreview).toHaveBeenCalledOnce()
  })
})
