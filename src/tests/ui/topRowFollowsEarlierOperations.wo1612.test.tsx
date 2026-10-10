// @vitest-environment jsdom
//
// WO-1612 - the Top Height row of a later 2D operation follows the material
// earlier operations left (WO-1609's resolution), live: computing, editing,
// disabling or deleting an earlier operation refreshes the row without the
// later operation being touched, and the row's words name the earlier
// operation the material came from.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, PhysicalStock, Setup, Tool } from '../../types'
import type { ResolvedHeightPlanV2 } from '../../lib/cam/smartHeights'
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
const { buildPlanarRoughSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { defaultPocketParams } = await import('../../components/modals/newOperationModalDefaults')

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
  dependencyIds: [stock.id],
}

/** The pocket: the operation under test, a plain stock-rough Smart Height V2. */
function pocketOperation(): Operation {
  const safetyIntent = defaultHeightIntent()
  return {
    id: 'op-pocket', name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: [],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 20,
      topHeight: 20, topHeightMode: 'stock_top', bottomHeight: 7.25, bottomHeightMode: 'absolute',
      heightIntent: safetyIntent,
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: 'setup-1', operationType: 'pocket_2d', safetyIntent, mode: 'stock_rough', stockId: stock.id,
      }),
    },
    passes: { stepdown: 2, stepover: 2, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: { ...defaultPocketParams, boundarySource: 'stock', geometryId: '', loopIds: [] },
  } as Operation
}

/** Face: an earlier, already-computed operation. Only its enabled/status/
 * generationFingerprint/toolpathMoves matter here - naming and staleness are
 * both read straight off these fields, never off Face's own Smart Height. */
function faceOperation(overrides: Partial<Operation> = {}): Operation {
  const safetyIntent = defaultHeightIntent()
  return {
    id: 'op-face', name: 'Face', type: 'face_2d', enabled: true, status: 'ready',
    toolId: tool.id, geometrySelections: [],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 20,
      topHeight: 20, topHeightMode: 'stock_top', bottomHeight: 18, bottomHeightMode: 'absolute',
      heightIntent: safetyIntent,
    },
    smartHeight: { kind: 'frozen_v1', resolverVersion: 1 },
    generationFingerprint: 'face-2mm',
    toolpathMoves: [{ type: 'feed', x: 0, y: 0, z: 18 }],
    passes: { stepdown: 2, stepover: 2, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {},
    ...overrides,
  } as Operation
}

/** Stands in for the store's real earlier-material resolution (WO-1609):
 * reads the CURRENT Face operation off the store at call time, exactly as the
 * live preview effect would, so a stale effect (one that never re-calls this)
 * is the only way this test can see the wrong number or the wrong words. */
function materialArtifact(fingerprint: string): ResolvedHeightPlanV2['machining']['materialArtifact'] {
  return {
    artifactId: 'remaining-material:earlier-operations:setup-1:op-pocket',
    schemaVersion: 1,
    representation: 'material-left-by-earlier-operations',
    frame: 'machine',
    boundsMm: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 80, maxZ: 20 },
    fingerprint,
  }
}

function seed(pocket: Operation, face: Operation) {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [face, pocket],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
      originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 0 },
    },
    stock: null,
  } as unknown as Setup
  const planPreview = vi.fn(async (_setupId: string, candidate: Operation) => {
    const plan = smartHeightPlanFixture(candidate, resolvedSnapshot)
    const currentFace = useCamStore.getState().project.setups[0].operations.find(o => o.id === 'op-face')
    const leftByFace = !!currentFace && currentFace.enabled && currentFace.status === 'ready'
      && (currentFace.toolpathMoves?.length ?? 0) > 0
    return {
      ...plan,
      machining: {
        ...plan.machining,
        materialStart: {
          ...plan.machining.materialStart,
          wcsMm: leftByFace ? -Number((currentFace!.generationFingerprint ?? '').replace(/\D/g, '')) : 0,
        },
        materialArtifact: leftByFace ? materialArtifact(currentFace!.generationFingerprint ?? '') : undefined,
      },
    }
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: planPreview,
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id, activeOperationId: pocket.id,
      stocks: [stock], geometry: [],
    },
    viewer: { ...state.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
  } as never)
  return { planPreview }
}

/** Rewrites only op-face, preserving op-pocket's object reference exactly -
 * the same shape a real edit/recompute/disable of an EARLIER operation takes.
 * If the panel's live-plan key ignored earlier operations (the WO-1609 bug),
 * neither `op` nor the key would change here, and the effect would not refire. */
function updateFace(patch: Partial<Operation>) {
  act(() => useCamStore.setState(state => ({
    project: {
      ...state.project,
      setups: state.project.setups.map(setup => setup.id !== 'setup-1' ? setup : {
        ...setup,
        operations: setup.operations.map(o => o.id === 'op-face' ? { ...o, ...patch } : o),
      }),
    },
  })))
}

const topRowText = () => screen.getByTestId('props-height-row-top').textContent ?? ''
const topFormula = () => screen.getByTestId('props-height-formula-top').textContent ?? ''
function topNumber(): number {
  const match = topRowText().match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('WO-1612: the Top row follows the operations before it', () => {
  it('Face 2mm then Pocket: reads -2 naming Face; Face recomputed to 3mm reads -3 untouched; Face disabled reads 0', async () => {
    const pocket = pocketOperation()
    const face = faceOperation()
    const { planPreview } = seed(pocket, face)
    render(<PropertiesPanel />)

    await waitFor(() => expect(topNumber()).toBeCloseTo(-2, 3))
    expect(topFormula()).toContain('Material left by earlier operations')
    const callsAfterFirstRender = planPreview.mock.calls.length

    // Face recomputed to 3mm - the Pocket is never touched, only Face's record changes.
    updateFace({ generationFingerprint: 'face-3mm' })
    await waitFor(() => expect(topNumber()).toBeCloseTo(-3, 3))
    expect(topFormula()).toContain('Material left by earlier operations')
    expect(planPreview.mock.calls.length).toBeGreaterThan(callsAfterFirstRender)

    // Face disabled - the Pocket reads as it would with no earlier cut.
    updateFace({ enabled: false })
    await waitFor(() => expect(topNumber()).toBeCloseTo(0, 3))
    expect(topFormula()).toBe('Current material')
  })

  it('with no earlier operation the row reads as today', async () => {
    const pocket = pocketOperation()
    seed(pocket, faceOperation({ enabled: false }))
    render(<PropertiesPanel />)

    await waitFor(() => expect(topNumber()).toBeCloseTo(0, 3))
    expect(topFormula()).toBe('Current material')
  })
})
