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
  buildFaceSmartHeightIntent,
  buildThreadMillSmartHeightIntent,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const tool = {
  id: 'thread-tool', name: 'Thread mill', type: 'thread_mill', diameter: 6,
  fluteLength: 12, numberOfFlutes: 3,
} as unknown as Tool

const feature = {
  loopId: 'boss-loop',
  featureKind: 'boss' as const,
  feature: {
    modelItemId: 'model-1', bodyId: 'body-1', featureKind: 'detected_boss',
    stableId: 'boss-1', sourceVersion: 1, sourceFingerprint: 'boss-topology-r1',
  },
  topMachineMm: 100,
  floorMachineMm: 80,
  fingerprint: 'boss-evidence-r1',
}

const snapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 21, top: 5, bottom: -10 },
  machine: { clearance: 120, retract: 115, feed: 111, top: 95, bottom: 80 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 21, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 5, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: -10, provenance: 'inferred' as const },
  },
  dependencyIds: ['boss-1'],
}

function operation(authority: 'smart' | 'frozen' | 'mismatched' = 'smart'): Operation {
  const heightIntent = defaultHeightIntent()
  const smartHeight = authority === 'smart'
    ? {
        kind: 'smart_v2' as const,
        intent: buildThreadMillSmartHeightIntent({
          setupId: 'setup-1', safetyIntent: heightIntent, source: 'detected_feature',
          threadKind: 'external', externalReference: 'base', threadDepthMm: 15,
          planeOffsetMm: 0.5, features: [feature],
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
    id: 'thread-op', name: 'Thread Mill 1', type: 'thread_mill', enabled: true,
    status: 'ready', toolId: tool.id,
    geometrySelections: ['boss-loop'],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25,
      feedHeight: 21, topHeight: 5, topHeightMode: 'absolute', bottomHeight: -10,
      bottomHeightMode: 'absolute', heightIntent,
    },
    smartHeight,
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: 'part-1', loopIds: ['boss-loop'], threadKind: 'external',
      externalReference: 'base', majorDiameter: 12, pitch: 1.5, handedness: 'right',
      cutDirection: 'climb', roughingPasses: 1, springPasses: 0,
      leadInOut: 'arc', compensation: 'computer', threadDepth: 15,
      geometrySource: 'cylinder',
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
    previewThreadMillSmartHeights: preview,
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

describe('Thread Mill Smart Height Properties panel', () => {
  it('shows stable authority and the shared live V2 plan', async () => {
    const activeOperation = operation()
    const { planPreview } = seed(activeOperation)
    render(<PropertiesPanel />)

    expect(screen.getByTestId('props-thread-mill-height-policy').textContent)
      .toContain('External, up from boss base')
    // WO-2007 fix round (CS 21): Datum source, Authority scope, Thread length and Datum offset read-outs are gone;
    // Thread band stays because it carries Edit thread band.
    for (const gone of ['props-thread-mill-height-source', 'props-thread-mill-height-scope', 'props-thread-mill-depth', 'props-thread-mill-datum-offset']) {
      expect(screen.queryByTestId(gone)).toBeNull()
    }
    // WO-2007 (CS 21): the resolved endpoint is the Bottom row value, not a diagnostics copy.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^-10(\.0+)? mm WCS/))
    expect(planPreview).toHaveBeenCalledWith('setup-1', activeOperation)
  })

  it('preserves the exact thread formula and stable feature scope on safety edit', () => {
    seed(operation())
    render(<PropertiesPanel />)
    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '42' } })
    fireEvent.blur(clearance)

    let updated = useCamStore.getState().project.setups[0].operations[0]
    let validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') throw new Error('Expected valid Thread Mill V2 authority.')
    expect(validated.state.intent.policy).toEqual({ operationType: 'thread_mill', variant: 'external_base' })
    expect(validated.state.intent.machining.scope.value).toEqual({
      kind: 'selected_features', features: [feature.feature],
    })
    expect(validated.state.intent.machining.end.value).toMatchObject({
      formula: { kind: 'thread_band', datum: 'feature_base', direction: 'up', depthMm: 15, datumOffsetMm: 0.5 },
    })

  })

  it('requires an old frozen project to be repaired in the operation editor', async () => {
    seed(operation('frozen'))
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-thread-mill-invalid-height-note').textContent)
      .toContain('no valid Smart Height V2 setup')
    // WO-2007 (CS 21): one plain refusal row replaces the diagnostics refusal; the repair row stays.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(screen.getByTestId('op-height-repair-required').textContent).toContain('Smart Height V2')
    fireEvent.click(screen.getByTestId('props-thread-mill-repair-height'))
    expect(useCamStore.getState().activeModal).toBe('edit-operation')
  })

  it('fails loud for mismatched V2 authority and never runs Thread Mill preview', async () => {
    const { preview, planPreview } = seed(operation('mismatched'))
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-thread-mill-invalid-height-note').textContent)
      .toContain('carries a face Smart Height policy')
    expect(preview).not.toHaveBeenCalled()
    // WO-2007 (CS 21): the refusal is one plain row in the Heights group.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(planPreview).toHaveBeenCalledOnce()
  })
})
