// @vitest-environment jsdom
//
// WO-1585: the WO-1435 audit found that a NEW-nest session (no editingId) has
// "the same extra-entry pattern" WO-1435 fixed for edit sessions -- Calculate
// -> any number of Re-calculates -> Accept still pushed one history entry per
// Calculate, so one Undo after Accept left a provisional nest visible instead
// of returning to the state before the dialog was used. This renders the REAL
// NestModal against the REAL store (createNest/removeNest/undo/redo through
// the modal's own handlers, never a mocked createNest), mirroring WO-1435's
// and WO-1520's evidence tier.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags;
// the store's persist() middleware needs a working backend. Same shim as the
// existing NestModal tests.
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

const { NestModal } = await import('../../components/modals/NestModal')
const { useCamStore } = await import('../../store')

function nestablePart(id: string, name = 'Bracket'): ImportedGeometry {
  return {
    id,
    name,
    type: 'curves_2d',
    format: 'svg',
    loaded: true,
    loops: [{
      id: `${id}-outer`,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }],
      closed: true,
      type: 'contour',
      layerId: `${id}-layer`,
      area: 100,
    }],
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 0 },
    },
  } as ImportedGeometry
}

function qtyInputFor(id: string): HTMLInputElement {
  const row = screen.getByTestId(`nest-part-check-${id}`).closest('.nest-part-row') as HTMLElement
  return row.querySelector('.nest-part-qty') as HTMLInputElement
}

function setQty(id: string, value: number) {
  const input = qtyInputFor(id)
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(value) } })
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
}

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().closeModal()
    useCamStore.getState().setNestEditTarget(null)
  })
})

describe('WO-1585: a new-nest session is one undo step', () => {
  it('Calculate -> Re-calculate -> Re-calculate -> Accept -> one Undo/Redo covers the whole session', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestablePart('part-1')] },
        projectHistory: [],
        projectFuture: [],
        canUndo: false,
        canRedo: false,
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })
    expect(screen.getByText('New Nest')).not.toBeNull()
    expect(useCamStore.getState().projectHistory).toHaveLength(0)

    fireEvent.click(screen.getByTestId('nest-part-check-part-1'))
    act(() => { setQty('part-1', 3) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })

    let nests = useCamStore.getState().project.nests ?? []
    expect(nests).toHaveLength(1)
    const firstId = nests[0].id
    // The first Calculate's snapshot becomes the session's sole undo step.
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    // No Worker in this test env -- resolve the pack via the same
    // worker-completion writer real dispatch uses, so Re-calculate is live.
    act(() => {
      useCamStore.getState().applyNestResult(firstId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })

    // Re-calculate #1: must not push a history entry of its own.
    act(() => { setQty('part-1', 4) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-calculate' }))
    })
    nests = useCamStore.getState().project.nests ?? []
    expect(nests).toHaveLength(1)
    const secondId = nests[0].id
    expect(secondId).not.toBe(firstId)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    act(() => {
      useCamStore.getState().applyNestResult(secondId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })

    // Re-calculate #2: same -- still exactly one entry total.
    act(() => { setQty('part-1', 5) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-calculate' }))
    })
    nests = useCamStore.getState().project.nests ?? []
    expect(nests).toHaveLength(1)
    const thirdId = nests[0].id
    expect(thirdId).not.toBe(secondId)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    act(() => {
      useCamStore.getState().applyNestResult(thirdId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    })

    let st = useCamStore.getState()
    expect(st.activeModal).toBeNull()
    expect(st.project.nests!.map((n) => n.id)).toEqual([thirdId])
    // Accept adds nothing further -- the whole session is the one entry.
    expect(st.projectHistory).toHaveLength(1)

    // ONE Undo returns to the pre-session state: no nest from this session,
    // no provisional left visible.
    act(() => { useCamStore.getState().undo() })
    st = useCamStore.getState()
    expect(st.project.nests ?? []).toHaveLength(0)
    expect(st.project.geometry.some((g) => g.ownerNestId === thirdId)).toBe(false)
    expect(st.project.geometry.some((g) => g.id === 'part-1')).toBe(true)
    expect(st.canUndo).toBe(false)

    // Redo restores the accepted nest in one step.
    act(() => { useCamStore.getState().redo() })
    st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([thirdId])
  })

  it('Calculate -> Dismiss leaves history unchanged and no provisional', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestablePart('part-1')] },
        projectHistory: [],
        projectFuture: [],
        canUndo: false,
        canRedo: false,
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    fireEvent.click(screen.getByTestId('nest-part-check-part-1'))
    act(() => { setQty('part-1', 3) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(1)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    const st = useCamStore.getState()
    expect(st.activeModal).toBeNull()
    expect(st.project.nests ?? []).toHaveLength(0)
    expect(st.project.geometry.some((g) => g.id === 'part-1')).toBe(true)
    expect(st.projectHistory).toHaveLength(0)
    expect(st.canUndo).toBe(false)
  })

  // WO-1585 audit (attempt 1 FAIL): TopToolbar's window Ctrl+Z handler has no
  // modal guard, so app-level undo() can fire while a new-nest session is
  // still open. That consumes the session's own first-Calculate entry; the
  // modal's cached provisionalId still points at the now-store-absent nest.
  // Cancel must then leave the (unrelated, pre-session) top-of-stack entry
  // alone -- not silently discard it as if it were this session's own.
  it('mid-session Ctrl+Z then Cancel leaves the unrelated pre-session undo step intact', () => {
    act(() => {
      useCamStore.getState().addGeometry(nestablePart('pre-1', 'Pre 1'))
      useCamStore.getState().addGeometry(nestablePart('part-1', 'Bracket'))
    })
    expect(useCamStore.getState().projectHistory).toHaveLength(2)

    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })
    fireEvent.click(screen.getByTestId('nest-part-check-part-1'))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })
    expect(useCamStore.getState().projectHistory).toHaveLength(3)
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(1)

    // The window-level Ctrl+Z handler's own action, fired mid-session.
    act(() => { useCamStore.getState().undo() })
    expect(useCamStore.getState().projectHistory).toHaveLength(2)
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(0)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    const st = useCamStore.getState()
    expect(st.activeModal).toBeNull()
    // The pre-session entry (from seeding 'part-1') must survive untouched.
    expect(st.projectHistory).toHaveLength(2)
    expect(st.canUndo).toBe(true)
  })

  // Same root cause, the second edge the audit named: after a mid-session
  // undo, provisionalId (React state) is stale but still non-null. A
  // subsequent Re-calculate must NOT take the Re-calculate skip-history
  // branch against that stale id -- it must push its own entry, exactly as a
  // first Calculate would, so Accept still leaves one real undo step.
  it('Re-calculate after a mid-session undo pushes its own entry, not zero', () => {
    act(() => {
      useCamStore.getState().addGeometry(nestablePart('pre-1', 'Pre 1'))
      useCamStore.getState().addGeometry(nestablePart('part-1', 'Bracket'))
    })
    expect(useCamStore.getState().projectHistory).toHaveLength(2)

    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })
    fireEvent.click(screen.getByTestId('nest-part-check-part-1'))
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })
    expect(useCamStore.getState().projectHistory).toHaveLength(3)
    const firstId = (useCamStore.getState().project.nests ?? [])[0].id

    act(() => { useCamStore.getState().undo() })
    expect(useCamStore.getState().projectHistory).toHaveLength(2)
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(0)

    // provisionalId (React state) still names the now-gone `firstId` nest;
    // the button label still reads 'Re-calculate' from that stale state.
    expect(screen.getByRole('button', { name: 'Re-calculate' })).not.toBeNull()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-calculate' }))
    })

    let st = useCamStore.getState()
    expect(st.project.nests ?? []).toHaveLength(1)
    const secondId = st.project.nests![0].id
    expect(secondId).not.toBe(firstId)
    // Must push its own entry (like a first Calculate), not skip history.
    expect(st.projectHistory).toHaveLength(3)

    act(() => {
      useCamStore.getState().applyNestResult(secondId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    })

    st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([secondId])
    // Accept adds nothing further.
    expect(st.projectHistory).toHaveLength(3)

    // One real Undo removes the recovered session's nest -- not zero steps.
    act(() => { useCamStore.getState().undo() })
    st = useCamStore.getState()
    expect(st.project.nests ?? []).toHaveLength(0)
    expect(st.projectHistory).toHaveLength(2)
  })
})
