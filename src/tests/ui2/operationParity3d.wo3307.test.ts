// @vitest-environment jsdom
//
// WO-3307 (UI M2 W2-2b): the 3D operation schemas store what today's editors store. For each 3D
// type, one parity case drives the real New Operation dialog (create with the same tool and
// defaults) and one drives the real Properties panel (one edit), and compares what they stored
// with what the schema gives for the same inputs: defaultsFor + storedParamsOf for a new
// operation, applyEdit for an edit.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const smartHeights = await import('../../lib/cam/smartHeights')
const { applyEdit, defaultsFor } = await import('../../lib/opschema')
const { schema3dFor, storedParamsOf } = await import('../../lib/opschema/schemas/3d')

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'
const TOOL_ID = 'tool-ball-6'
const TOOL_DIAMETER = 6
const LIBRARY_STEPOVER = 0.4

// a ball end mill with a library stepover, so the dialog's tool seeds run
const ballTool = {
  id: TOOL_ID, name: 'Ball 6mm', type: 'ball_end_mill', diameter: TOOL_DIAMETER,
  fluteLength: 20, numberOfFlutes: 2,
  feedsAndSpeeds: { default: { stepover: LIBRARY_STEPOVER } },
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  intent: defaultHeightIntent(),
  dependencyIds: [GEO_ID],
}

const solid = {
  id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
} as unknown as ImportedGeometry

type Op3d = 'parallel_3d' | 'waterline_3d' | 'adaptive_3d' | 'scallop_3d' | 'steep_shallow_3d' | 'pencil_3d'

/** The dialog's type card and the Properties panel's block for each 3D type. */
const CARD: Record<Op3d, string> = {
  parallel_3d: 'Parallel Finish (3D)',
  waterline_3d: 'Waterline Finish (3D)',
  adaptive_3d: 'Adaptive Rough (3D)',
  scallop_3d: 'Scallop Finish (3D)',
  steep_shallow_3d: 'Steep and Shallow (3D)',
  pencil_3d: 'Pencil Cleanup (3D)',
}
const BLOCK: Record<Op3d, string> = {
  parallel_3d: 'props-parallel3d-edit',
  waterline_3d: 'props-waterline3d-edit',
  adaptive_3d: 'props-adaptive3d-edit',
  scallop_3d: 'props-scallop3d-edit',
  steep_shallow_3d: 'props-steep-shallow3d-edit',
  pencil_3d: 'props-pencil3d-edit',
}

/** A saved operation of each type: non-default values, a Smart Height authority and a height
 *  intent, as a project saved by today's dialog holds it. */
function savedParams(type: Op3d): Record<string, unknown> {
  switch (type) {
    case 'parallel_3d': return { stepover: 0.7, angleDeg: 45, tolerance: 0.02, surfaceStockToLeave: 0.1, finishDepth: 5, useStockBoundary: true }
    case 'waterline_3d': return { stepdown: 0.8, tolerance: 0.02, stockToLeave: 0.2, minSlopeDeg: 30, flatAreaDetection: false, order: 'region', direction: 'conventional', useStockBoundary: false }
    case 'adaptive_3d': return { maxStepdown: 2, stepover: 0.3, millingDirection: 'climb', intermediateStepdown: true, wallLeadInRadius: 1, wallLeadOutRadius: 1, loopbackFilletPct: 30, integralWallFollow: true, integralWallFollowLengthFactor: 2, tolerance: 0.05, helixDiameter: 4, helixAngleDeg: 5, radialStockToLeave: 0.3, axialStockToLeave: 0.2, cellSize: 0, useStockBoundary: false }
    case 'scallop_3d': return { scallopHeight: 0.02, tolerance: 0.05, stockToLeave: 0, useStockBoundary: false, direction: 'climb' }
    case 'steep_shallow_3d': return { thresholdDeg: 30, stepdown: 1, stepover: 1, angleDeg: 0, tolerance: 0.05, stockToLeave: 0, useStockBoundary: false }
    case 'pencil_3d': return { tolerance: 0.05, stockToLeave: 0, useStockBoundary: false, direction: 'climb' }
  }
}

function smartHeightOf(type: Op3d, finishDepthMm?: number) {
  const input = { setupId: SETUP_ID, geometryIds: [GEO_ID], safetyIntent: defaultHeightIntent(), finishDepthMm }
  switch (type) {
    case 'parallel_3d': return { kind: 'smart_v2' as const, intent: smartHeights.buildParallel3dSmartIntent(input) }
    case 'waterline_3d': return { kind: 'smart_v2' as const, intent: smartHeights.buildWaterline3dSmartIntent(input) }
    case 'scallop_3d': return { kind: 'smart_v2' as const, intent: smartHeights.buildScallop3dSmartIntent(input) }
    case 'steep_shallow_3d': return { kind: 'smart_v2' as const, intent: smartHeights.buildSteepShallow3dSmartIntent(input) }
    case 'pencil_3d': return { kind: 'smart_v2' as const, intent: smartHeights.buildPencil3dSmartIntent(input) }
    case 'adaptive_3d': return undefined
  }
}

function setupOf(operations: Operation[]): Setup {
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  return { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations, notes: '' } as unknown as Setup
}

function seed(operations: Operation[], activeOperationId?: string): void {
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [ballTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) => smartHeightPlanFixture(operation, snapshot)),
      project: { ...s.project, geometry: [solid], setups: [setupOf(operations)], activeSetupId: SETUP_ID, ...(activeOperationId ? { activeOperationId } : {}) },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    } as never))
  })
}

function savedOperation(type: Op3d, overrides: Record<string, unknown> = {}): Operation {
  const params = { ...savedParams(type), ...overrides }
  return {
    id: `op-${type}`, name: type, type, toolId: TOOL_ID, enabled: true, status: 'ready',
    geometrySelections: [GEO_ID],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2, feedHeight: 0.5,
      topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
      heightIntent: defaultHeightIntent(),
    },
    params,
    smartHeight: smartHeightOf(type, params.finishDepth as number | undefined),
  } as unknown as Operation
}

const storedOp = () => useCamStore.getState().project.setups[0].operations[0]

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-3307 a new 3D operation from the schema stores what the New Operation dialog stores', () => {
  const TYPES: readonly Op3d[] = ['parallel_3d', 'waterline_3d', 'adaptive_3d', 'scallop_3d', 'steep_shallow_3d', 'pencil_3d']
  for (const type of TYPES) {
    it(`${type}: the same params for the same tool`, async () => {
      seed([])
      render(createElement(NewOperationModal))
      act(() => { useCamStore.getState().openModal('new-operation') })
      fireEvent.click(screen.getByText(CARD[type]))
      fireEvent.click(screen.getByText('Tool'))
      fireEvent.click(screen.getByText('Ball 6mm'))
      await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByTestId('op-create'))
      const created = storedOp()
      expect(created.type).toBe(type)

      const schema = schema3dFor(type)
      expect(schema, `no schema for ${type}`).toBeDefined()
      const values = defaultsFor(schema!, { toolDiameter: TOOL_DIAMETER, libraryStepoverMm: LIBRARY_STEPOVER } as Parameters<typeof defaultsFor>[1])
      expect(storedParamsOf(schema!, values)).toEqual(created.params)
    })
  }
})

/** The Properties panel's input or select on the row labelled `label`, inside the type's block. */
function panelField(type: Op3d, label: string): HTMLInputElement | HTMLSelectElement {
  const block = screen.getByTestId(BLOCK[type])
  const row = within(block).getByText(label, { selector: '.props-label' }).closest('.props-group') as HTMLElement
  return row.querySelector('input, select') as HTMLInputElement | HTMLSelectElement
}

function typeInto(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

interface EditCase {
  readonly type: Op3d
  /** The Properties panel row and what the operator does there. */
  readonly label: string
  edit(field: HTMLInputElement | HTMLSelectElement): void
  /** A control the panel draws without a label row (the roughing scope radios). */
  readonly control?: () => HTMLInputElement
  /** Stored params the case starts from, over the saved operation's. */
  readonly saved?: Record<string, unknown>
  /** The same edit through the schema. */
  readonly key: string
  readonly value: number | string | boolean | null
}

const EDITS: readonly EditCase[] = [
  { type: 'parallel_3d', label: 'Finish depth limit', edit: f => typeInto(f, '3.5'), key: 'params.finishDepth', value: 3.5 },
  { type: 'waterline_3d', label: 'Order', edit: f => typeInto(f, 'level'), key: 'params.order', value: 'level' },
  { type: 'adaptive_3d', label: 'Maximum direct wall ride', edit: f => typeInto(f, '300'), key: 'params.integralWallFollowLengthFactor', value: 3 },
  { type: 'adaptive_3d', label: 'Auto grid', edit: f => fireEvent.click(f), key: 'params.cellSize', value: 0.3 },
  { type: 'scallop_3d', label: 'Scallop height', edit: f => typeInto(f, '0.01'), key: 'params.scallopHeight', value: 0.01 },
  { type: 'steep_shallow_3d', label: 'Threshold', edit: f => typeInto(f, '45'), key: 'params.thresholdDeg', value: 45 },
  { type: 'steep_shallow_3d', label: 'Finish depth limit', edit: f => typeInto(f, '2'), key: 'params.finishDepth', value: 2 },
  { type: 'pencil_3d', label: 'Direction', edit: f => typeInto(f, 'conventional'), key: 'params.direction', value: 'conventional' },
  { type: 'pencil_3d', label: 'Finish depth limit', edit: f => typeInto(f, '1.5'), key: 'params.finishDepth', value: 1.5 },
  { type: 'waterline_3d', label: 'Finish depth limit', edit: f => typeInto(f, '4'), key: 'params.finishDepth', value: 4 },
  { type: 'scallop_3d', label: 'Finish depth limit', edit: f => typeInto(f, '2.5'), key: 'params.finishDepth', value: 2.5 },
  { type: 'parallel_3d', label: 'Finish depth limit', edit: f => typeInto(f, ''), key: 'params.finishDepth', value: null },
  // back to the automatic grid: blank, stored as 0
  { type: 'adaptive_3d', label: 'Auto grid', edit: f => fireEvent.click(f), key: 'params.cellSize', value: null, saved: { cellSize: 0.5 } },
  { type: 'adaptive_3d', label: 'Clear all stock', control: () => screen.getByTestId('props-adaptive3d-roughing-scope').querySelector('input[value="clear-all-stock"]') as HTMLInputElement, edit: f => fireEvent.click(f), key: 'params.useStockBoundary', value: true },
  // a blank overshoot is the automatic one, stored as absent
  { type: 'adaptive_3d', label: 'Edge overshoot', edit: f => typeInto(f, ''), key: 'params.stockEdgeOvershoot', value: null, saved: { useStockBoundary: true, stockEdgeOvershoot: 1.5 } },
  { type: 'waterline_3d', label: 'Clip to stock', edit: f => fireEvent.click(f), key: 'params.useStockBoundary', value: true },
]

describe('WO-3307 an edit through the schema stores what the Properties panel stores', () => {
  for (const c of EDITS) {
    it(`${c.type}: ${c.label} -> ${String(c.value)}`, () => {
      const before = savedOperation(c.type, c.saved)
      seed([before], before.id)
      render(createElement(PropertiesPanel))
      c.edit(c.control ? c.control() : panelField(c.type, c.label))
      const after = storedOp() as unknown as Record<string, unknown>

      const schema = schema3dFor(c.type)
      expect(schema, `no schema for ${c.type}`).toBeDefined()
      const setup = useCamStore.getState().project.setups[0]
      const patch = applyEdit(schema!, before as unknown as Record<string, unknown>, c.key, c.value, { setup } as Parameters<typeof applyEdit>[4])
      expect(Object.keys(patch).length, 'the schema edit changes nothing').toBeGreaterThan(0)
      for (const [field, value] of Object.entries(patch)) expect(after[field], field).toEqual(value)
      // and nothing else the panel stored differs (status and the cleared toolpath are the screen's,
      // the outdated reason the store's)
      const SCREEN_FIELDS = new Set(['status', 'toolpathMoves', 'computeTimeMs', 'estimatedCutTimeMs', 'resolvedHeights', 'generationFingerprint', 'errorMessage', 'diagnostics', 'outdatedReason'])
      for (const field of Object.keys(after)) {
        if (SCREEN_FIELDS.has(field) || field in patch) continue
        expect(after[field], `${field} changed by the panel but not by the schema`).toEqual((before as unknown as Record<string, unknown>)[field])
      }
    })
  }
})
