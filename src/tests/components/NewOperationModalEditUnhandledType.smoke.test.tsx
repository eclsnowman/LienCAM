// @vitest-environment jsdom
//
// React-render SMOKE test pinning the ADR-0003 "no silent fallbacks" behavior in
// NewOperationModal's edit-prefill path.
//
// WHY THIS EXISTS: OperationType has members with no edit-prefill branch in the
// modal (pencil_3d joined the handled set in WO-1193, scallop_3d in WO-1192,
// after vcarve in WO-1174, waterline_3d in WO-1176, and steep_shallow_3d in WO-1190).
// Before the fix, the edit-prefill chain ended in a bare `else` that silently
// rendered Contour-shaped UI for ANY unrecognized type -- a silent strategy
// fallback ADR-0003 explicitly forbids. The fix splits that `else` into an
// explicit `contour_2d` branch plus a typed `else` that surfaces a user-visible
// error state (and a structured console.error) instead. tsc + pure-logic suites
// cannot catch render behavior, so this mounts the real modal on an unhandled
// op type opened in edit mode and asserts the failure is LOUD, not silent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Install an in-memory shim BEFORE the
// store import. Pure test scaffolding; no app change. (Same pattern as the loops
// + picked-plane smoke tests alongside this one.)
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

const GEO_ID = 'geo-test'
const SETUP_ID = 'setup-test'
const OP_ID = 'op-unhandled'
const NEVER_WIRED_3D = '__never_wired_3d'

// Seed a setup holding ONE operation of the given (unhandled or handled) type.
// Cast loosely -- render scaffolding; the modal's edit-prefill only reads
// id/name/type/toolId/heights/passes/linking/params before hitting the type
// chain. Mirrors the drill-op seed in the loops smoke test.
function seedProjectWithOp(opType: string) {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
  ]
  const geometry = [{
    id: GEO_ID, name: 'part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const op = {
    id: OP_ID, name: 'Op', type: opType, toolId: '',
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
      feedHeight: 0.5, topHeight: 0, topHeightMode: 'absolute',
      bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, finishPasses: 1, stockToLeave: 0 },
    linking: {},
    params: {},
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [op], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('NewOperationModal edit-mode fail-loud for unhandled operation types (ADR-0003)', () => {
  it.each([NEVER_WIRED_3D] as const)(
    'surfaces an explicit error state (not Contour UI) for unhandled type "%s"',
    (opType) => {
      seedProjectWithOp(opType)
      render(<NewOperationModal />)
      // Spy AFTER render, BEFORE the edit-prefill effect runs, so the structured
      // console.error (ADR-0003 Pattern 2) is captured without polluting output.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      act(() => { useCamStore.getState().openEditOperation(SETUP_ID, OP_ID) })

      // The explicit error state renders (data-testid="op-edit-load-error") ...
      const err = screen.getByTestId('op-edit-load-error')
      expect(err).not.toBeNull()
      // ... and it NAMES the unhandled type -- no silent degradation to Contour.
      expect(err.textContent).toContain(opType)
      // Save & Recompute is disabled (the handleCreate guard blocks submission).
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
      // The normal form's tab bar is absent -- the Contour-shaped UI did NOT render.
      expect(screen.queryByText('Passes')).toBeNull()
      // ADR-0003 Pattern 2: a structured console.error fires naming the type + ADR.
      expect(
        errSpy.mock.calls.some(
          c => String(c[0]).includes(opType) && String(c[0]).includes('ADR-0003'),
        ),
      ).toBe(true)
      errSpy.mockRestore()
    },
  )

  it('Cancel dismisses the error state and clears the failure', () => {
    seedProjectWithOp(NEVER_WIRED_3D)
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, OP_ID) })
    expect(screen.getByTestId('op-edit-load-error')).not.toBeNull()

    // Cancel -> handleClose -> closeModal + resetState (clears editLoadError).
    fireEvent.click(screen.getByText('Cancel'))
    // The error state is gone: editLoadError is cleared so the guard no longer fires.
    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()
  })

  it('does not trip for a handled type opened in edit mode (scoped guard)', () => {
    // A handled type must still render the normal editor -- the fail-loud branch
    // is scoped to the five unhandled OperationType members only.
    seedProjectWithOp('drill')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, OP_ID) })

    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()
    // The normal form renders (tab bar is present).
    expect(screen.getByText('Passes')).not.toBeNull()
  })
})
