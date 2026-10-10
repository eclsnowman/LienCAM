// @vitest-environment jsdom

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
const {
  buildEngraveSmartHeightIntent,
  buildFaceSmartHeightIntent,
  engraveSmartHeightDraftFromIntent,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const tool = {
  id: 'engrave-tool', name: '90 degree engraving bit', type: 'chamfer_mill',
  diameter: 6, tipDiameter: 0.5, angleFromAxisDeg: 45, fluteLength: 10,
  numberOfFlutes: 2,
} as unknown as Tool

const snapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 21, top: 10.25, bottom: 9.5 },
  machine: { clearance: 120, retract: 115, feed: 111, top: 100.25, bottom: 99.5 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 21, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 10.25, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: 9.5, provenance: 'inferred' as const },
  },
  dependencyIds: ['art-1', tool.id],
}

function operation(authority: 'smart' | 'frozen' | 'mismatched' = 'smart'): Operation {
  const heightIntent = defaultHeightIntent()
  const smartHeight = authority === 'smart'
    ? {
        kind: 'smart_v2' as const,
        intent: buildEngraveSmartHeightIntent({
          setupId: 'setup-1', safetyIntent: heightIntent,
          datumReference: 'geometry_plane', datumOffsetMm: 0, axialOffsetMm: 0.25,
          depth: { kind: 'line_width', targetLineWidthMm: 2 },
          scope: {
            geometryIds: ['art-1'], loopIds: ['open-path', 'closed-path'],
            includeOpen: true, includeClosed: true,
          },
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
    id: 'engrave-op', name: 'Engrave 1', type: 'engrave', enabled: true,
    status: 'ready', toolId: tool.id,
    geometrySelections: ['open-path', 'closed-path'],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25,
      feedHeight: 21, topHeight: 10.25, topHeightMode: 'absolute', bottomHeight: 9.5,
      bottomHeightMode: 'absolute', heightIntent,
    },
    smartHeight,
    resolvedHeights: authority === 'smart' ? snapshot : undefined,
    passes: { stepdown: 1, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: 'art-1', loopIds: ['open-path', 'closed-path'],
      includeOpen: true, includeClosed: true, mode: 'engrave', depthModel: 'constant',
      side: 'center', sideOffset: 0, axialOffset: 0.25,
      targetLineWidth: 2, useWidthForDepth: true, direction: 'as_drawn',
      heightReference: 'geometry_face', planeOffset: 0, tolerance: 0.01,
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
    previewEngraveSmartHeights: preview,
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

describe('Engrave Smart Height Properties panel', () => {
  it('shows formula authority, stable path scope, editor control, and the shared live V2 plan', async () => {
    const activeOperation = operation()
    const { planPreview } = seed(activeOperation)
    render(<PropertiesPanel />)

    expect(screen.getByTestId('props-engrave-height-policy').textContent)
      .toContain('Width derived from tool geometry')
    // WO-2007 fix round (CS 21): depth, datum, offset and path-scope read-outs are gone; the Edit button changes them.
    expect(screen.queryByTestId('props-engrave-depth-intent')).toBeNull()
    expect(screen.queryByText(/selected paths/)).toBeNull()
    expect(screen.getByTestId('props-engrave-edit-height')).not.toBeNull()
    // WO-2007 (CS 21): the resolved endpoint is the Bottom row value, not a diagnostics copy.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^9\.50* mm WCS/))
    expect(planPreview).toHaveBeenCalledWith('setup-1', activeOperation)
  })

  it('preserves the formula and selected path scope on safety edit', () => {
    seed(operation())
    render(<PropertiesPanel />)
    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '42' } })
    fireEvent.blur(clearance)
    const updated = useCamStore.getState().project.setups[0].operations[0]
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') throw new Error('Expected valid Engrave V2 authority after edit.')
    expect(engraveSmartHeightDraftFromIntent(validated.state.intent)).toEqual({
      datumReference: 'geometry_plane', datumOffsetMm: 0, axialOffsetMm: 0.25,
      depth: { kind: 'line_width', targetLineWidthMm: 2 },
    })
    expect(validated.state.intent.machining.scope.value).toEqual({
      kind: 'selected_paths', geometryIds: ['art-1'], loopIds: ['open-path', 'closed-path'],
      includeOpen: true, includeClosed: true,
    })
  })

  it('WO-1969: says a surface-following op follows the part surface, not a datum plane', () => {
    const base = operation()
    const followOp = {
      ...base,
      smartHeight: {
        kind: 'smart_v2' as const,
        intent: buildEngraveSmartHeightIntent({
          setupId: 'setup-1', safetyIntent: defaultHeightIntent(),
          datumReference: 'wcs_plane', datumOffsetMm: 20, axialOffsetMm: 0,
          depth: { kind: 'explicit', depthMm: 0.3 }, followSurface: true,
          scope: {
            geometryIds: ['art-1'], loopIds: ['open-path', 'closed-path'],
            includeOpen: true, includeClosed: true,
          },
        }),
      },
    } as Operation
    seed(followOp)
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-engrave-height-policy').textContent)
      .toContain('Follows the part surface')
    expect(screen.getByTestId('props-engrave-height-policy').textContent)
      .not.toContain('Explicit physical depth')
    // WO-2007 fix round (CS 21): the Datum read-out row is gone; the policy row alone says it follows the surface.
    expect(screen.queryByTestId('props-engrave-datum')).toBeNull()
    expect(document.body.textContent).not.toContain('wcs_plane')
    fireEvent.click(screen.getByTestId('props-engrave-edit-height'))
    expect(useCamStore.getState().activeModal).toBe('edit-operation')
  })

  it('requires an old frozen project to be repaired in the operation editor', async () => {
    seed(operation('frozen'))
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-engrave-invalid-height-note').textContent)
      .toContain('no valid Smart Height V2 setup')
    // WO-2007 (CS 21): one plain refusal row replaces the diagnostics refusal; the repair row stays.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(screen.getByTestId('op-height-repair-required').textContent).toContain('Smart Height V2')
    fireEvent.click(screen.getByTestId('props-engrave-repair-height'))
    expect(useCamStore.getState().activeModal).toBe('edit-operation')
  })

  it('fails loud for mismatched V2 authority and never runs Engrave preview', async () => {
    const { preview, planPreview } = seed(operation('mismatched'))
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-engrave-invalid-height-note').textContent)
      .toContain('carries a face Smart Height policy')
    expect(preview).not.toHaveBeenCalled()
    // WO-2007 (CS 21): the refusal is one plain row in the Heights group.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(planPreview).toHaveBeenCalledOnce()
  })
})
