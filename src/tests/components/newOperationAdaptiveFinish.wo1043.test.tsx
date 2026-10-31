// @vitest-environment jsdom
//
// WO-1043 UI surface: the Adaptive Clearing "Wall finish depth" selector offers THREE
// options, each labelled with what it actually leaves on the wall, and picking the third
// one persists wallFinishMode: 'final_to_size' onto the created operation.
//
// WHY THIS EXISTS AS A UI TEST: the engine side of WO-1043 is pinned in
// src/tests/adaptive-clearing/engine/_wall-finish.test.ts, which proves the MODE produces
// the toolpath Operator asked for. It cannot prove the mode is reachable. Operator asked for this
// element by name ("for several other ops we added one final setting ... We want that
// option"), so reachability is the deliverable, not a detail: a mode nobody can select is
// the same as no mode.
//
// The honesty assertions are the second half of the WO. Before WO-1043 the checkbox hint
// said the pass "remove[s] the radial stock-to-leave", which stopped being true at WO-450 --
// both shipped modes leave it standing. The option labels now carry that fact, so the test
// asserts the two shipped options SAY they leave stock and the new one SAYS it cuts to size.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { Operation, Setup, Tool, HeightParams } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

// jsdom's localStorage is unreliable under vitest's node launch flags and the Zustand store
// uses persist(); install an in-memory shim BEFORE importing the store (mirrors the other
// *.smoke.test.tsx files and AdaptiveFinishLeadControls.test.tsx).
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

// Smart Height V2 needs a full evidence chain this fixture never sets up, and none of it is
// what this file tests. Stub the store's preview action so canCreate/Save can flip true.
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

const PASSES = { stepdown: 2, stepover: 1, finishPasses: 1, stockToLeave: 0.5 }

const LINKING = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

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

/** An existing Adaptive op already saved with the new mode, so the edit-prefill has a real
 *  'final_to_size' value to display (the round-trip half of "persists"). */
function seedAdaptiveOpInFinalToSize(): void {
  const params = {
    boundarySource: 'stock', geometryId: '', loopIds: [],
    wallFinish: true, wallFinishMode: 'final_to_size',
  }
  const op = {
    id: OP_ID, name: 'Adaptive Clearing 1', type: 'adaptive_clearing_2d', toolId: TOOL_ID,
    enabled: true, status: 'ready', geometrySelections: [],
    heights: HEIGHTS, passes: PASSES, linking: LINKING,
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

// Open the modal on a fresh Adaptive op, pick the tool, opt into the stock-boundary Smart
// Height path, land on Linking and switch "Final wall cleanup" on so the selector mounts.
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

function modeSelect(): HTMLSelectElement {
  return screen.getByTestId('op-adaptive-wall-finish-mode') as HTMLSelectElement
}

function optionLabels(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of Array.from(modeSelect().querySelectorAll('option'))) {
    out[(o as HTMLOptionElement).value] = (o.textContent ?? '').trim()
  }
  return out
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-1043: Adaptive "Finish pass at final depth (cuts to size)"', () => {
  it('offers three wall-finish modes, each labelled with what it leaves on the wall', async () => {
    seedToolAndSetup()
    render(<NewOperationModal />)
    await openAdaptiveLinkingWithWallFinish()

    const labels = optionLabels()
    expect(Object.keys(labels)).toEqual(['final', 'each_stepdown', 'final_to_size'])

    // HONESTY, option by option. The two shipped modes leave the operator's radial stock
    // standing (WO-450) and must say so; the new one removes it and must say that.
    expect(labels.final.toLowerCase()).toContain('leaves stock to leave standing')
    expect(labels.each_stepdown.toLowerCase()).toContain('leaves stock to leave standing')
    expect(labels.final_to_size).toBe('Finish pass at final depth (cuts to size)')

    // 'final' is still the default selection -- the new option is opt-in.
    expect(modeSelect().value).toBe('final')
  })

  // WO-1182: the mode hints are gone (no helper text under fields); the mode
  // is carried by the selector's own option labels, pinned below.

  it("choosing the third option persists wallFinishMode: 'final_to_size' on the created op", async () => {
    seedToolAndSetup()
    render(<NewOperationModal />)
    await openAdaptiveLinkingWithWallFinish()

    fireEvent.change(modeSelect(), { target: { value: 'final_to_size' } })
    expect(modeSelect().value).toBe('final_to_size')

    // WO-3137 (7ce28356a7) invalidates the resolved Smart Height preview whenever a
    // draft field changes, so Create is disabled until the preview re-resolves. Wait
    // for the modal's own contract; the payload assertions below are unchanged.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    await waitFor(() => {
      expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    })
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('adaptive_clearing_2d')
    const params = created.params as { wallFinish?: boolean; wallFinishMode?: string }
    expect(params.wallFinish).toBe(true)
    expect(params.wallFinishMode).toBe('final_to_size')
  })

  it('an op saved in final_to_size reloads in that mode and survives a save', async () => {
    seedAdaptiveOpInFinalToSize()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, OP_ID) })
    fireEvent.click(screen.getByText('Linking'))

    // Round trip: the saved mode is what the selector shows.
    expect(modeSelect().value).toBe('final_to_size')

    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    await waitFor(() => {
      const updated = useCamStore.getState().project.setups[0].operations[0]
      expect((updated.params as { wallFinishMode?: string }).wallFinishMode).toBe('final_to_size')
    })
  })
})
