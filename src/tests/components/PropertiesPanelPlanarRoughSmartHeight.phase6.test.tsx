// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, PhysicalStock, Setup, Tool } from '../../types'
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
  buildPlanarRoughSmartHeightIntent,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { defaultACParams, defaultPocketParams } = await import(
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
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

const resolvedSnapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 20.5, top: 20, bottom: 8 },
  machine: { clearance: 30, retract: 25, feed: 20.5, top: 20, bottom: 8 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 20.5, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 20, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: 8, provenance: 'inferred' as const },
  },
  dependencyIds: [stock.id, 'target-step'],
}

function operation(
  type: 'pocket_2d' | 'adaptive_clearing_2d',
  authority: 'smart' | 'frozen' = 'smart',
): Operation {
  const safetyIntent = defaultHeightIntent()
  return {
    id: `${authority}-${type}`,
    name: `${authority} ${type}`,
    type,
    enabled: true,
    status: 'ready',
    toolId: tool.id,
    geometrySelections: [],
    heights: {
      clearanceHeight: 30,
      clearanceHeightMode: 'absolute',
      retractHeight: 25,
      feedHeight: 20,
      topHeight: 20,
      topHeightMode: 'stock_top',
      bottomHeight: 7.25,
      bottomHeightMode: 'absolute',
      heightIntent: safetyIntent,
    },
    smartHeight: authority === 'smart'
      ? {
          kind: 'smart_v2',
          intent: buildPlanarRoughSmartHeightIntent({
            setupId: 'setup-1',
            operationType: type,
            safetyIntent,
            mode: 'stock_rough',
            stockId: stock.id,
          }),
        }
      : { kind: 'frozen_v1', resolverVersion: 1 },
    passes: {
      stepdown: 2, stepover: 2, stockToLeave: 0, floorStockToLeave: 0,
      finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: type === 'pocket_2d'
      ? { ...defaultPocketParams, boundarySource: 'stock', geometryId: '', loopIds: [] }
      : { ...defaultACParams, boundarySource: 'stock', geometryId: '', loopIds: [] },
  } as Operation
}

function geometryFloorOperation(type: 'pocket_2d' | 'adaptive_clearing_2d'): Operation {
  const op = operation(type)
  const safetyIntent = defaultHeightIntent()
  op.geometrySelections = ['floor-loop']
  op.smartHeight = {
    kind: 'smart_v2',
    intent: buildPlanarRoughSmartHeightIntent({
      setupId: 'setup-1',
      operationType: type,
      safetyIntent,
      mode: 'geometry_floor',
      geometryIds: ['target-step'],
    }),
  }
  op.params = {
    ...(op.params as Record<string, unknown>),
    boundarySource: 'geometry',
    geometryId: 'target-step',
    loopIds: ['floor-loop'],
    heightReference: 'geometry_face',
    planeOffset: 0,
  } as Operation['params']
  return op
}

function boundedGeometryOperation(
  type: 'pocket_2d' | 'adaptive_clearing_2d',
  mode: 'through_stock' | 'explicit_depth',
): Operation {
  const op = geometryFloorOperation(type)
  op.smartHeight = {
    kind: 'smart_v2',
    intent: buildPlanarRoughSmartHeightIntent({
      setupId: 'setup-1',
      operationType: type,
      safetyIntent: defaultHeightIntent(),
      mode,
      geometryIds: ['target-step'],
      throughAllowanceMm: mode === 'through_stock' ? 0.75 : undefined,
      explicitTargetWcsMm: mode === 'explicit_depth' ? 8 : undefined,
    }),
  }
  return op
}

function seed(
  activeOperation: Operation,
  preview = vi.fn(async () => resolvedSnapshot),
  planPreview = vi.fn(async (_setupId: string, candidate: Operation) => {
    const plan = smartHeightPlanFixture(candidate, resolvedSnapshot)
    if (plan.policy.operationType !== candidate.type) {
      throw new Error(`Operation carries a ${plan.policy.operationType} Smart Height policy.`)
    }
    return plan
  }),
) {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [activeOperation],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
      originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 0 },
    },
    stock: null,
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewPlanarRoughSmartHeights: preview,
    previewOperationSmartHeightPlan: planPreview,
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id, activeOperationId: activeOperation.id,
      stocks: [stock],
      geometry: [{
        id: 'target-step', name: 'Target.step', type: 'brep', format: 'step', loaded: true,
        assignedStockId: stock.id,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min: { x: 10, y: 10, z: 0 }, max: { x: 90, y: 70, z: 12 } },
      }],
    },
    viewer: {
      ...state.viewer,
      selectedGeometryId: null,
      selectedStockId: null,
      selectedNestId: null,
    },
  } as never)
  return { preview, planPreview }
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('Planar rough Smart Height Properties panel', () => {
  it.each([
    'pocket_2d',
    'adaptive_clearing_2d',
  ] as const)('shows %s V2 authority and exact live height truth', async type => {
    const activeOperation = operation(type)
    const { planPreview } = seed(activeOperation)
    render(<PropertiesPanel />)

    // WO-2007 fix round (CS 21): End policy (no Edit button of its own) and Owning stock are read-outs - gone.
    expect(screen.queryByTestId('props-planar-rough-height-policy')).toBeNull()
    expect(screen.queryByTestId('props-planar-rough-owning-stock')).toBeNull()
    expect(screen.queryByTestId('op-ref-plane-select')).toBeNull()
    expect(screen.getByTestId('props-height-row-clearance').querySelector('input')).not.toBeNull()

    // WO-2007 (CS 21): the live plan reads as the Bottom row's value, not a diagnostics copy.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^8(\.0+)? mm WCS/))
    // WO-2007 (CS 21): each derivation is the value's tooltip and accessible description.
    expect(screen.getByTestId('props-height-value-clearance').getAttribute('data-tooltip')).toContain('Retract + 10.000 mm')
    expect(screen.getByTestId('props-height-formula-clearance').textContent).toContain('Retract + 10.000 mm')
    expect(screen.getByTestId('props-height-formula-retract').textContent).toContain('Stock top + 5.000 mm')
    expect(screen.getByTestId('props-height-formula-feed').textContent).toContain('Top + 5.000 mm')
    expect(screen.getByTestId('props-height-formula-top').textContent).toContain('Current material')
    expect(screen.getByTestId('props-height-formula-bottom').textContent).toContain('Target surface')
    expect(screen.getByTestId('props-height-row-top').querySelector('input')).toBeNull()
    expect(screen.getByTestId('props-height-row-bottom').querySelector('input')).toBeNull()
    // WO-2007 (CS 21): no 'How was this calculated?' disclosure and no nested diagnostics scroll.
    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      expect(screen.queryByTestId(`props-height-explanation-${plane}`)).toBeNull()
      expect(screen.getByTestId(`props-height-formula-${plane}`).hidden).toBe(true)
    }
    expect(screen.queryByTestId('props-height-diagnostics')).toBeNull()
    expect(planPreview).toHaveBeenCalledWith('setup-1', activeOperation)
  })

  it.each([
    ['pocket_2d', 'through_stock', 'Through stock + 0.75 mm'],
    ['pocket_2d', 'explicit_depth', 'Explicit WCS target 8 mm'],
    ['adaptive_clearing_2d', 'through_stock', 'Through stock + 0.75 mm'],
    ['adaptive_clearing_2d', 'explicit_depth', 'Explicit WCS target 8 mm'],
  ] as const)('shows and preserves %s %s authority', async (type, mode, label) => {
    seed(boundedGeometryOperation(type, mode))
    render(<PropertiesPanel />)

    // WO-2007 fix round (CS 21): End policy and Target geometry read-outs are gone; the authority is proved in the store below.
    expect(screen.queryByTestId('props-planar-rough-height-policy')).toBeNull()
    expect(screen.queryByText(label)).toBeNull()
    expect(screen.queryByTestId('props-planar-rough-target-geometry')).toBeNull()
    // WO-2007 (CS 21): live plan truth is the Bottom row value; the diagnostics copy is gone.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^8(\.0+)? mm WCS/))

    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '22' } })
    fireEvent.blur(clearance)

    expect(useCamStore.getState().project.setups[0].operations[0].smartHeight)
      .toMatchObject({ kind: 'smart_v2', intent: { policy: { operationType: type, variant: mode } } })
  })

  it.each([
    'pocket_2d',
    'adaptive_clearing_2d',
  ] as const)('shows and preserves %s selected geometry-floor authority', async type => {
    const activeOperation = geometryFloorOperation(type)
    seed(activeOperation)
    render(<PropertiesPanel />)

    // WO-2007 fix round (CS 21): End policy and Target geometry read-outs are gone; the authority is proved in the store below.
    expect(screen.queryByTestId('props-planar-rough-height-policy')).toBeNull()
    expect(screen.queryByTestId('props-planar-rough-target-geometry')).toBeNull()
    // WO-2007 (CS 21): live plan truth is the Bottom row value; the diagnostics copy is gone.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^8(\.0+)? mm WCS/))

    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '22' } })
    fireEvent.blur(clearance)

    expect(useCamStore.getState().project.setups[0].operations[0].smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: type, variant: 'geometry_floor' },
        machining: {
          end: { value: { kind: 'selected_plane' } },
          scope: { value: { kind: 'selected_geometry', geometryIds: ['target-step'] } },
        },
      },
    })
  })

  it('preserves stock-rough authority when safety is edited', async () => {
    seed(operation('pocket_2d'))
    render(<PropertiesPanel />)
    // WO-2007 (CS 21): live plan truth is the Bottom row value; the diagnostics copy is gone.
    await waitFor(() => expect(screen.getByTestId('props-height-value-bottom').textContent)
      .toMatch(/^8(\.0+)? mm WCS/))

    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '22' } })
    fireEvent.blur(clearance)

    let updated = useCamStore.getState().project.setups[0].operations[0]
    expect(updated.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'pocket_2d', variant: 'stock_rough' },
        machining: {
          start: { value: { kind: 'current_material' } },
          end: { value: { kind: 'target_surface' } },
          scope: { value: { kind: 'stock_footprint', stockId: stock.id } },
        },
      },
    })
    const validated = validatePersistedSmartHeightState(updated.smartHeight)
    if (!validated.ok || validated.state.kind !== 'smart_v2') {
      throw new Error('Expected valid V2 authority after edit.')
    }
    expect(validated.state.intent.safety.clearance).toMatchObject({
      reference: updated.heights.heightIntent?.clearance.reference,
      offsetMm: updated.heights.heightIntent?.clearance.offset,
    })

  })

  it('requires an old frozen project to be repaired in the operation editor', async () => {
    seed(operation('pocket_2d', 'frozen'))
    render(<PropertiesPanel />)

    expect(screen.getByTestId('props-planar-rough-invalid-height-note').textContent)
      .toContain('no valid Smart Height V2 setup')
    expect(screen.queryByTestId('op-ref-plane-select')).toBeNull()
    // WO-2007 (CS 21): one plain refusal row replaces the diagnostics refusal; the repair row stays.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(screen.getByTestId('op-height-repair-required').textContent).toContain('Smart Height V2')
    fireEvent.click(screen.getByTestId('props-planar-rough-repair-height'))
    expect(useCamStore.getState().activeModal).toBe('edit-operation')
  })

  it('fails loud for mismatched authority and does not expose target controls', async () => {
    const invalid = operation('pocket_2d')
    invalid.smartHeight = {
      kind: 'smart_v2',
      intent: buildFaceSmartHeightIntent({
        setupId: 'setup-1',
        safetyIntent: defaultHeightIntent(),
        mode: 'explicit_depth',
        stockId: stock.id,
        explicitTargetWcsMm: 8,
      }),
    }
    const { preview, planPreview } = seed(invalid)
    render(<PropertiesPanel />)

    expect(screen.getByTestId('props-planar-rough-invalid-height-note').textContent)
      .toContain('carries a face Smart Height policy')
    expect(screen.queryByTestId('op-ref-plane-select')).toBeNull()
    expect(preview).not.toHaveBeenCalled()
    // WO-2007 (CS 21): the refusal is one plain row in the Heights group.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal')).not.toBeNull())
    expect(planPreview).toHaveBeenCalledOnce()
  })

  it('surfaces exact preflight refusal and a changed stock binding', async () => {
    const refusal = vi.fn(async () => {
      throw new Error("Planar rough Smart Height cannot prove that stock 'stock-1' is the active Setup stock.")
    })
    seed(operation('adaptive_clearing_2d'), refusal, refusal)
    const otherStock = { ...stock, id: 'stock-2', name: 'Stock 2' }
    act(() => useCamStore.setState(state => ({
      project: {
        ...state.project,
        stocks: [stock, otherStock],
        setups: state.project.setups.map(setup => ({
          ...setup,
          wcs: {
            ...setup.wcs,
            stockId: 'stock-2',
            originBinding: undefined,
          },
        })),
      },
    })))
    render(<PropertiesPanel />)

    // WO-2007 fix round (CS 21): no Owning stock read-out; the refusal row below says why it cannot compute.
    expect(screen.queryByTestId('props-planar-rough-owning-stock')).toBeNull()
    // WO-2007 (CS 21): the exact refusal is one plain row in the Heights group.
    await waitFor(() => expect(screen.getByTestId('props-height-refusal').textContent)
      .toContain('cannot prove'))
  })
})
