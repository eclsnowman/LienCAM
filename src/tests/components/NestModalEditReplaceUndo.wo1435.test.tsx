// @vitest-environment jsdom
//
// WO-1435 / BUG-424: NestModal.handleAccept implemented "replace the edited
// nest with its recalculated result" as TWO independently-historied store
// mutations -- the provisional nest's own pushHistory() (fired inside
// createNest during Calculate) plus Accept's own removeNest(editingId) push.
// One user action ("Accept this edit") therefore left two entries on the undo
// stack: a single Undo only reversed the most recent one (the removeNest),
// un-deleting the original while the provisional stayed visible -- a
// two-nest intermediate the operator never asked for.
//
// This renders the REAL NestModal against the REAL store (createNest /
// removeNest / undo / redo through the modal's own handlers, exactly like the
// WO-1520 Calculate-selection test), never a mocked createNest, so the real
// owned-seed geometry + history bookkeeping is what's exercised.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import type { ImportedGeometry, NestRecord } from '../../types'

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

function ownedSeed(id: string, ownerNestId: string): ImportedGeometry {
  return {
    id,
    name: 'Bracket',
    type: 'curves_2d',
    format: 'svg',
    loaded: true,
    ownerNestId,
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

function existingNest(id: string, seedId: string): NestRecord {
  return {
    id,
    name: 'Nest 1',
    sheet: { width: 600, height: 400 },
    style: 'ninety',
    spacing: { partGap: 2, sheetMargin: 5, windowGap: 2 },
    seed: 1,
    sources: [{ geometryId: seedId, quantity: 2 }],
    placements: [],
    unplaced: [],
    utilization: 0,
    visible: true,
  }
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

describe('WO-1435: Accepting a nest edit is one undo step', () => {
  it('one Undo after Accept restores the single pre-edit nest, not a two-nest state', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [ownedSeed('seed-1', 'nest-a')],
          nests: [existingNest('nest-a', 'seed-1')],
        },
        projectHistory: [],
        projectFuture: [],
        canUndo: false,
        canRedo: false,
      }))
      useCamStore.getState().setNestEditTarget('nest-a')
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })
    expect(screen.getByText('Edit Nest')).not.toBeNull()

    // Entering edit hides the original (untracked -- must not create an undo
    // step by itself) so the sheet-origin preview doesn't show two nests.
    expect(useCamStore.getState().project.nests!.find((n) => n.id === 'nest-a')!.visible).toBe(false)
    expect(useCamStore.getState().projectHistory).toHaveLength(0)

    // Change a parameter, then Calculate (the recalculated result).
    act(() => { setQty('seed-1', 4) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })

    const nestsAfterCalc = useCamStore.getState().project.nests ?? []
    expect(nestsAfterCalc).toHaveLength(2)
    const provisionalId = nestsAfterCalc.find((n) => n.id !== 'nest-a')!.id

    // Calculate alone must be exactly ONE history entry (the transaction's
    // sole undo step, reused by Accept below).
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    // No Worker in this test env -- resolve the pack via the same
    // worker-completion writer real dispatch uses, so Accept is enabled.
    act(() => {
      useCamStore.getState().applyNestResult(provisionalId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    })

    // Accept: exactly the provisional survives; the original + its owned seed
    // are gone; no second history entry was pushed for this removal.
    let st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([provisionalId])
    expect(st.project.geometry.some((g) => g.id === 'seed-1')).toBe(false)
    expect(st.projectHistory).toHaveLength(1)
    expect(useCamStore.getState().activeModal).toBeNull()

    // ONE Undo must restore the exact pre-edit state: the original nest back
    // (visible, with its own seed), the provisional and its seed gone --
    // never a two-nest intermediate.
    act(() => { useCamStore.getState().undo() })
    st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual(['nest-a'])
    expect(st.project.nests![0].visible).toBe(true)
    expect(st.project.geometry.some((g) => g.id === 'seed-1')).toBe(true)
    expect(st.project.geometry.some((g) => g.ownerNestId === provisionalId)).toBe(false)
    expect(st.canUndo).toBe(false)

    // Redo re-applies the full accepted replacement in one step.
    act(() => { useCamStore.getState().redo() })
    st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([provisionalId])
    expect(st.project.geometry.some((g) => g.id === 'seed-1')).toBe(false)
  })

  it('Calculate -> Re-calculate -> Accept -> one Undo restores the single pre-edit nest (audit fix round)', () => {
    // Reproduces the attempt-1 audit finding: Re-calculating before Accept is
    // the normal way to tune a nest, and it must fold into the SAME one
    // history entry as the first Calculate -- not add entries of its own.
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [ownedSeed('seed-1', 'nest-a')],
          nests: [existingNest('nest-a', 'seed-1')],
        },
        projectHistory: [],
        projectFuture: [],
        canUndo: false,
        canRedo: false,
      }))
      useCamStore.getState().setNestEditTarget('nest-a')
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    act(() => { setQty('seed-1', 4) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })

    let nests = useCamStore.getState().project.nests ?? []
    expect(nests).toHaveLength(2)
    const firstProvisionalId = nests.find((n) => n.id !== 'nest-a')!.id
    act(() => {
      useCamStore.getState().applyNestResult(firstProvisionalId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    // Re-calculate: tune the qty again before Accept. Must NOT push any
    // history entry of its own -- the first Calculate's snapshot stays the
    // whole session's only entry.
    act(() => { setQty('seed-1', 3) })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-calculate' }))
    })

    nests = useCamStore.getState().project.nests ?? []
    expect(nests).toHaveLength(2)
    const secondProvisionalId = nests.find((n) => n.id !== 'nest-a')!.id
    expect(secondProvisionalId).not.toBe(firstProvisionalId)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)

    act(() => {
      useCamStore.getState().applyNestResult(secondProvisionalId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    })

    let st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([secondProvisionalId])
    expect(st.projectHistory).toHaveLength(1)

    // ONE Undo must restore the exact pre-edit state -- the original visible
    // with its own seed, BOTH provisionals and their seeds gone -- never the
    // two-visible-provisionals intermediate the audit reproduced.
    act(() => { useCamStore.getState().undo() })
    st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual(['nest-a'])
    expect(st.project.nests![0].visible).toBe(true)
    expect(st.project.geometry.some((g) => g.id === 'seed-1')).toBe(true)
    expect(st.project.geometry.some((g) => g.ownerNestId === firstProvisionalId)).toBe(false)
    expect(st.project.geometry.some((g) => g.ownerNestId === secondProvisionalId)).toBe(false)
    expect(st.canUndo).toBe(false)

    // Redo re-applies the full accepted replacement (the second provisional,
    // from the Re-calculate) in one step.
    act(() => { useCamStore.getState().redo() })
    st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual([secondProvisionalId])
    expect(st.project.geometry.some((g) => g.id === 'seed-1')).toBe(false)
  })

  it('Cancel is unaffected: the pre-edit original survives exactly as it was', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [ownedSeed('seed-1', 'nest-a')],
          nests: [existingNest('nest-a', 'seed-1')],
        },
        projectHistory: [],
        projectFuture: [],
        canUndo: false,
        canRedo: false,
      }))
      useCamStore.getState().setNestEditTarget('nest-a')
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })
    expect(useCamStore.getState().project.nests ?? []).toHaveLength(2)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    const st = useCamStore.getState()
    expect(st.project.nests!.map((n) => n.id)).toEqual(['nest-a'])
    expect(st.project.nests![0].visible).toBe(true)
    expect(st.project.geometry.some((g) => g.id === 'seed-1')).toBe(true)
    expect(useCamStore.getState().activeModal).toBeNull()
  })
})
