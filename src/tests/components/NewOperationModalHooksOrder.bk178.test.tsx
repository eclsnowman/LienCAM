// @vitest-environment jsdom
//
// BK-178 RENDER-GATE regression test: NewOperationModal.tsx hooks-order
// fragility.
//
// BACKGROUND: during CAM-BINDING Stage 5, adding a new useEffect at one
// specific point in this ~5666-line component's hook sequence crashed
// several PRE-EXISTING, unrelated tests on first mount ("Rendered more/fewer
// hooks than during the previous render"). Stage 5 worked around it (kept
// the new state as plain useState, no new useEffect) without root-causing.
// This is the dedicated root-cause pass (docs/planning/POST-MERGE-WORKPLAN.md
// BK-178).
//
// ROOT CAUSE (reproduced 2026-07-23): the component has ONE early return -
// `if (!isOpen || !setup) return null` - after all its hooks. Any hook
// placed textually AFTER that line is only reached on renders where
// isOpen && setup are truthy, making the hook call conditional on modal
// open/closed state. React then throws the instant the SAME mounted
// instance transitions between a closed render (fewer hooks) and an open
// render (one more hook) - exactly what happens when a test does
// `render(<NewOperationModal />)` while closed, then calls
// `openModal('new-operation')`. Confirmed via a temporary repro: inserting
// a bare `useEffect(() => {}, [])` immediately after the early return
// crashed 3 of 6 tests in
// NewOperationModalMachiningBoundary.camBindingStage5.test.tsx with exactly
// "Rendered more hooks than during the previous render." /
// "Rendered fewer hooks than expected." pointing at the inserted line.
// Also flagged statically by `npm run lint` (react-hooks/rules-of-hooks,
// error severity): "Did you accidentally call a React Hook after an early
// return?" - that rule is already wired into eslint.config.mjs, but this
// repo has no CI/pre-commit gate that runs it automatically.
//
// tsc and the pure-logic vitest suites cannot catch this class of bug - it
// only manifests when the SAME component instance actually re-renders
// across the open/closed (or op-type/edit-mode) boundary, which requires a
// real React render tree. This test drives exactly that transition
// sequence so any FUTURE hook landing below the "HOOK BOUNDARY" comment in
// NewOperationModal.tsx fails here immediately, in seconds, instead of
// being discovered mid-feature the way BK-178 was.
//
// MUTATION-PROOF: verified RED by temporarily re-inserting the historical
// `useEffect(() => {}, [])` repro right after the early return in
// NewOperationModal.tsx and re-running this file (all closed->open
// transition tests failed with the hooks-order error); verified GREEN with
// the repro removed (current committed state).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Same in-memory shim every other
// NewOperationModal render test in this suite uses.
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

const SETUP_ID = 'setup-bk178'

function seedProject() {
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry: [], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  seedProject()
})
afterEach(() => { cleanup() })

describe('BK-178: NewOperationModal hooks-order stability across the isOpen boundary', () => {
  it('mounts CLOSED (returns null) with no render error', () => {
    const { container } = render(<NewOperationModal />)
    expect(container.firstChild).toBeNull()
  })

  it('survives the CLOSED -> OPEN transition on the same mounted instance (the exact transition that crashes if a hook lands after the early return)', () => {
    const { container } = render(<NewOperationModal />)
    expect(container.firstChild).toBeNull()

    act(() => { useCamStore.getState().openModal('new-operation') })

    expect(screen.getByText('New Operation', { exact: false })).toBeTruthy()
    expect(screen.getByTestId('op-create')).toBeTruthy()
  })

  it('survives OPEN -> CLOSED -> OPEN again on the same mounted instance', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    expect(screen.getByTestId('op-create')).toBeTruthy()

    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByTestId('op-create')).toBeNull()

    act(() => { useCamStore.getState().openModal('new-operation') })
    expect(screen.getByTestId('op-create')).toBeTruthy()
  })

  it('survives switching across every op-type render branch without unmounting (each op type gates a different set of conditional JSX blocks)', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Type & Name'))

    for (const label of [
      'Drill', 'Bore', '2D Chamfer', '2D Face', 'Engrave / Trace',
      '2D Adaptive Clearing', 'Thread Mill', '2D Pocket', '2D Contour',
    ]) {
      fireEvent.click(screen.getByText(label))
    }

    expect(screen.getByTestId('op-create')).toBeTruthy()
  })

  it('survives EDIT mode (a second isOpen-truthy shape) opened directly on a fresh mount', () => {
    const op = {
      id: 'op-1', name: 'Op 1', type: 'contour_2d', geometryId: null, toolId: '',
      heights: { topOfPartZ: 0, safeZ: 25, retractZ: 5, targetZ: -1, plungeType: 'ramp' },
      passes: { finishPasses: 1, springPasses: 0, stockToLeave: 0, overlapMm: 0 },
      linking: { entryType: 'ramp', exitType: 'lift', stayDown: false },
      params: {}, status: 'pending', toolpathMoves: undefined, computeTimeMs: undefined,
    }
    act(() => {
      const s = useCamStore.getState() as unknown as { project: { setups: Array<{ id: string; operations: unknown[] }> } }
      useCamStore.setState({
        project: { ...s.project, setups: [{ ...s.project.setups[0], operations: [op] }] },
      } as never)
    })

    render(<NewOperationModal />)
    act(() => {
      useCamStore.setState({ editingOpPayload: { setupId: SETUP_ID, operationId: 'op-1' } } as never)
      useCamStore.getState().openModal('edit-operation')
    })

    expect(screen.getByText('Edit Operation', { exact: false })).toBeTruthy()
  })
})
