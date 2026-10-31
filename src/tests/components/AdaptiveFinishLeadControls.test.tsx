// @vitest-environment jsdom
//
// Component test: Adaptive Clearing wall-finish lead-in / lead-out radius
// controls are reachable in the normal New/Edit Operation UI, changed values
// flow into the existing create payload, and editing an existing Adaptive
// operation displays its saved values with an update that preserves them.
//
// WHY THIS EXISTS: the engine, schema, store, edit-reload, create, and update
// plumbing for leadInRadius / leadOutRadius on Adaptive wall finishing already
// exist and are accepted (commit 5088606cc made nonzero leads safe). The
// remaining defect was UI reachability only -- the radii were not exposed in
// the Adaptive Linking section. This test pins the UI surface and the
// end-to-end value flow through the existing linking state + payload plumbing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { Operation, Setup, Tool, HeightParams } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing the
// store (mirrors the other *.smoke.test.tsx files).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const SETUP_ID = 'setup-1'
const TOOL_ID = 'tool-flat-1'
const OP_ID = 'op-adaptive-1'

const flatTool = {
  id: TOOL_ID, name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as unknown as Tool

const WCS = {
  id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  // Smart Height V2 stamp (commit 2e5678b7): stock-boundary smart height needs
  // one proven Setup stock (setupProvenStockId reads wcs.stockId directly, no
  // PhysicalStock record required by the build step itself).
  stockId: 'stock-1',
}

const RESOLVED_SNAPSHOT = {
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
  dependencyIds: ['stock-1'],
}

// Stamped for Smart Height V2 (commit 2e5678b7): computing a REAL resolved
// height plan needs a full evidence chain (stock bounds, sceneStock, etc.)
// this fixture never sets up - unrelated to what this file actually tests
// (wall-finish lead-radius reachability). Stub the store's preview action the
// same way PlanarRoughSmartHeightOperationUI.phase5.test.tsx does, so the
// modal's live-preview effect resolves instantly and canCreate/Save can flip
// true without a real geometry/stock evidence graph.
function stubSmartHeightPreview(): void {
  act(() => {
    useCamStore.setState({
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, RESOLVED_SNAPSHOT)),
    } as never)
  })
}

const HEIGHTS = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
  feedHeight: 0.5, topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}

const PASSES = { stepdown: 2, stepover: 1, finishPasses: 1, stockToLeave: 0 }

// A complete LinkingParams with nonzero lead radii, used to seed the edit op.
const LINKING_WITH_LEADS = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 10,
  leadInRadius: 2, leadOutRadius: 3,
  retractType: 'full', transitionType: 'safe_height',
}

// Seed an empty setup + flat tool so a fresh Adaptive op can be created with
// just a tool pick. Smart Height V2 (commit 2e5678b7) requires the modal's
// live preview to resolve before Save enables; stubSmartHeightPreview (called
// by the tests that create/save) removes the need for real stock/geometry
// evidence, and openAdaptiveLinkingWithWallFinish opts into the stock-
// boundary path via the Geometry tab so no geometry pick is needed either.
function seedToolAndSetup(): void {
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs: WCS, stock: null, operations: [], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [flatTool],
      project: { ...s.project, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// Seed an existing Adaptive Clearing op with wall finishing ON and nonzero lead
// radii so the edit-prefill has real saved values to display. Stock-boundary
// (not geometry) so the edit-mode preview needs only the proven Setup stock,
// not a selected geometry/loop pick.
function seedAdaptiveOpWithLeads(): void {
  const params = { boundarySource: 'stock', geometryId: '', loopIds: [], wallFinish: true, wallFinishMode: 'final' }
  const op = {
    id: OP_ID, name: 'Adaptive Clearing 1', type: 'adaptive_clearing_2d', toolId: TOOL_ID,
    enabled: true, status: 'ready', geometrySelections: [],
    heights: HEIGHTS, passes: PASSES, linking: LINKING_WITH_LEADS,
    params,
    smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', {
      setupId: SETUP_ID, heights: HEIGHTS as HeightParams, params, stockId: 'stock-1',
    }),
  } as unknown as Operation
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs: WCS, stock: null, operations: [op], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [flatTool],
      project: { ...s.project, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
  stubSmartHeightPreview()
}

// Open the modal on a fresh Adaptive Clearing op, pick the tool, opt into the
// stock-boundary Smart Height path (Geometry tab), wait for the live preview
// to resolve, then land on the Linking tab and enable "Final wall cleanup" so
// the lead-radius controls mount.
async function openAdaptiveLinkingWithWallFinish(): Promise<void> {
  stubSmartHeightPreview()
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('2D Adaptive Clearing'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('Flat 6mm'))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.click(screen.getByTestId('adaptive-stock-smart-height'))
  await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('Linking'))
  const wallFinishBox = screen.getByText('Final wall cleanup')
    .closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
  fireEvent.click(wallFinishBox)
}

function leadInInput(): HTMLInputElement {
  return screen.getByTestId('op-adaptive-finish-lead-in-radius').querySelector('input') as HTMLInputElement
}
function leadOutInput(): HTMLInputElement {
  return screen.getByTestId('op-adaptive-finish-lead-out-radius').querySelector('input') as HTMLInputElement
}

// Commit a value into a NumericInput (focus -> type -> blur, matching the
// component's commit-on-blur contract).
function setNumeric(input: HTMLInputElement, value: string): void {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('Adaptive Clearing wall-finish lead radius controls (UI reachability + payload flow)', () => {
  it('exposes both lead radius controls with a zero default when wall finishing is enabled', async () => {
    seedToolAndSetup()
    render(<NewOperationModal />)
    await openAdaptiveLinkingWithWallFinish()

    expect(screen.getByTestId('op-adaptive-finish-lead-in-radius')).toBeTruthy()
    expect(screen.getByTestId('op-adaptive-finish-lead-out-radius')).toBeTruthy()

    // Radius zero is the default and means no lead arc.
    expect(leadInInput().value).toBe('0')
    expect(leadOutInput().value).toBe('0')
  })

  it('hides the lead radius controls while wall finishing is off', () => {
    seedToolAndSetup()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('2D Adaptive Clearing'))
    fireEvent.click(screen.getByText('Linking'))

    // Wall finishing is off by default -> the controls are not mounted.
    expect(screen.queryByTestId('op-adaptive-finish-lead-in-radius')).toBeNull()
    expect(screen.queryByTestId('op-adaptive-finish-lead-out-radius')).toBeNull()
  })

  it('flows changed lead radii into the existing create payload', async () => {
    seedToolAndSetup()
    render(<NewOperationModal />)
    await openAdaptiveLinkingWithWallFinish()

    setNumeric(leadInInput(), '2.5')
    setNumeric(leadOutInput(), '3.5')

    // WO-3137 (7ce28356a7) invalidates the resolved Smart Height preview whenever a
    // draft field changes, so Create is disabled from the moment a lead radius is
    // committed until the preview re-resolves. Wait for the modal's own contract
    // before pressing it; the payload assertions below are unchanged.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    return waitFor(() => {
      expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    }).then(() => {
      const created = useCamStore.getState().project.setups[0].operations[0]
      expect(created.type).toBe('adaptive_clearing_2d')
      // The values ride the existing linking state -> existing create payload.
      expect(created.linking.leadInRadius).toBe(2.5)
      expect(created.linking.leadOutRadius).toBe(3.5)
      // Wall finishing was enabled so the params carry wallFinish too.
      expect((created.params as { wallFinish?: boolean }).wallFinish).toBe(true)
    })
  })

  it('editing an existing Adaptive op shows its saved lead radii and an update preserves the changed values', async () => {
    seedAdaptiveOpWithLeads()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, OP_ID) })
    fireEvent.click(screen.getByText('Linking'))

    // The edit-prefill loaded the saved linking -> the inputs show 2 and 3.
    expect(leadInInput().value).toBe('2')
    expect(leadOutInput().value).toBe('3')

    // Change both radii.
    setNumeric(leadInInput(), '4')
    setNumeric(leadOutInput(), '5')

    // Save is gated on the live Smart Height preview resolving (stubbed).
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    // Save (the op-create button is the Save action in edit mode).
    fireEvent.click(screen.getByTestId('op-create'))

    return waitFor(() => {
      const updated = useCamStore.getState().project.setups[0].operations[0]
      expect(updated.linking.leadInRadius).toBe(4)
      expect(updated.linking.leadOutRadius).toBe(5)
    })
  })
})
