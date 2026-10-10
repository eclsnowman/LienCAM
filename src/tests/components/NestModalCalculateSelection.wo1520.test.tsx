// @vitest-environment jsdom
//
// WO-1520 / BUG-378: Calculate rekeys the picker's `pick` state to the newly
// minted owned-seed ids, but the fresh-mode picker (`displayGeos`) never shows
// owned seeds -- only the ORIGINAL geometry rows. After a fresh Calculate the
// row the user picked reads back unincluded / quantity 1, even though the pack
// used it. This test renders the REAL NestModal against the REAL store
// (createNest/removeNest through the modal's own handlers -- Tier 2 desk
// evidence per the work order), never a mocked createNest, so the real
// owned-seed geometry + ownerNestId filtering is what's exercised.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags;
// the store's persist() middleware needs a working backend. Same shim as the
// existing NestModal smoke test.
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

describe('WO-1520: Calculate keeps picked rows selected', () => {
  it('a fresh Calculate keeps the picked row included with its requested quantity', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestablePart('part-1')] },
      }))
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    fireEvent.click(screen.getByTestId('nest-part-check-part-1'))
    act(() => { setQty('part-1', 3) })

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })

    // The row must still be the ORIGINAL geometry id (BUG-378: it used to
    // vanish because pick got rekeyed to a seed id displayGeos never shows).
    const checkbox = screen.getByTestId('nest-part-check-part-1') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(qtyInputFor('part-1').value).toBe('3')
    expect(screen.getByText('1 selected')).not.toBeNull()

    // The original workspace part is untouched (not consumed) and still
    // exists standalone; the pack created a separate owned seed.
    const geoIds = useCamStore.getState().project.geometry.map((g) => g.id)
    expect(geoIds).toContain('part-1')
  })

  it('a second Calculate (re-pack) from the same picked row still succeeds', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [nestablePart('part-1')] },
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
    const firstNestId = useCamStore.getState().project.nests![0].id

    // No Worker in this test env, so the pack never leaves 'computing' on its
    // own (dispatchNest guards on typeof Worker); resolve it via the same
    // worker-completion writer the real dispatch uses, so Re-calculate is live.
    act(() => {
      useCamStore.getState().applyNestResult(firstNestId, {
        placements: [], unplaced: [], utilization: 0, sheetUsed: { width: 600, height: 400 },
      })
    })

    // Row still reads included -> the Re-calculate button is live (not the
    // disabled "Include at least one part" state) and produces a SECOND pack
    // that replaces the first (WO-1520 acceptance #2 -- no regression).
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-calculate' }))
    })

    const nests = useCamStore.getState().project.nests ?? []
    expect(nests).toHaveLength(1)
    expect(nests[0].id).not.toBe(firstNestId)
    expect(nests[0].sources.length).toBeGreaterThan(0)

    const checkbox = screen.getByTestId('nest-part-check-part-1') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(qtyInputFor('part-1').value).toBe('3')
  })

  it('editing an existing nest keeps its owned-seed row picked after Calculate', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [{ ...nestablePart('seed-1'), ownerNestId: 'nest-a' }],
          nests: [{
            id: 'nest-a',
            name: 'Nest A',
            sheet: { width: 600, height: 400 },
            style: 'ninety' as const,
            spacing: { partGap: 2, sheetMargin: 5, windowGap: 2 },
            seed: 1,
            sources: [{ geometryId: 'seed-1', quantity: 2 }],
            placements: [],
            unplaced: [],
            utilization: 0,
            visible: true,
          }],
        },
      }))
      useCamStore.getState().setNestEditTarget('nest-a')
    })
    render(<NestModal />)
    act(() => { useCamStore.getState().openModal('new-nest') })

    expect(screen.getByText('Edit Nest')).not.toBeNull()
    const checkboxBefore = screen.getByTestId('nest-part-check-seed-1') as HTMLInputElement
    expect(checkboxBefore.checked).toBe(true)
    expect(qtyInputFor('seed-1').value).toBe('2')

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }))
    })

    // Editing an existing nest must be unaffected by the fresh-mode fix: its
    // own owned-seed row is untouched geometry and must keep reading picked.
    const checkboxAfter = screen.getByTestId('nest-part-check-seed-1') as HTMLInputElement
    expect(checkboxAfter.checked).toBe(true)
    expect(qtyInputFor('seed-1').value).toBe('2')
  })
})
