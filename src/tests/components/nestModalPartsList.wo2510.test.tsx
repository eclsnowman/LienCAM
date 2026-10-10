// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project, NestRecord, ImportedGeometry } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size },
  clear: () => mem.clear(), getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => [...mem.keys()][index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, value) },
} })
const { NestModal } = await import('../../components/modals/NestModal')
const { useCamStore } = await import('../../store')
const kit = JSON.parse(readFileSync('examples/09-nested-kit-sheet/nested-kit-sheet.camproject', 'utf8')) as Project
const readback = JSON.parse(readFileSync('src/tests/evidence/WO-2381/nest-readback.json', 'utf8')) as {
  nest: NestRecord; geometry: ImportedGeometry[]
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().closeModal()
    useCamStore.getState().setNestEditTarget(null)
  })
})
afterEach(cleanup)

function listedParts() {
  return [...screen.getByTestId('nest-placed-parts').querySelectorAll('.nest-part-row')].map(row => ({
    name: row.querySelector('.nest-part-name')!.textContent!,
    quantity: Number(row.lastElementChild!.textContent),
  }))
}

// jsdom has no packing Worker. Deliver the saved production completion through
// the store's worker-result writer. Browser evidence runs the actual Worker.
function finishPack() {
  const nest = useCamStore.getState().project.nests!.at(-1)!
  const geometry = useCamStore.getState().project.geometry
  const placements = nest.sources.flatMap(source => {
    const name = geometry.find(g => g.id === source.geometryId)!.name.replace(/ \d+$/, '')
    const savedId = readback.geometry.find(g => g.name === name)!.id
    const saved = readback.nest.placements.filter(p => p.partId === savedId)
    return Array.from({ length: source.quantity }, (_, index) => ({
      ...saved[index % saved.length], partId: source.geometryId,
      instanceId: `${source.geometryId}#${index}`,
    }))
  })
  act(() => useCamStore.getState().applyNestResult(nest.id, {
    placements, unplaced: [], utilization: readback.nest.utilization, sheetUsed: nest.sheet,
  }))
  return nest.id
}

describe('WO-2510 Parts lists the active nest placements', () => {
  it('lists seven entries from saved example 09 and retains workspace picks after Calculate', () => {
    act(() => useCamStore.setState({ project: structuredClone(kit) }))
    render(<NestModal />)
    act(() => useCamStore.getState().openModal('new-nest'))
    for (const geo of kit.geometry) fireEvent.click(screen.getByTestId(`nest-part-check-${geo.id}`))
    fireEvent.click(screen.getByRole('button', { name: /^Calculate$/ }))
    finishPack()
    expect(listedParts()).toHaveLength(7)
    expect(listedParts().reduce((sum, p) => sum + p.quantity, 0)).toBe(7)
    expect(screen.queryByText(/No nestable parts/)).toBeNull()
    for (const geo of kit.geometry) {
      expect((screen.getByTestId(`nest-part-check-${geo.id}`) as HTMLInputElement).checked).toBe(true)
    }
  })

  it('lists consumed inline imports with quantities after Calculate, Accept and reopen', async () => {
    render(<NestModal />)
    act(() => useCamStore.getState().openModal('new-nest'))
    for (const name of ['toe-clamp', 'soft-jaw', 'gear-16', 'gear-24', 'sign']) {
      const text = readFileSync(`examples/09-nested-kit-sheet/${name}.svg`, 'utf8')
      const file = new File([text], `${name}.svg`, { type: 'image/svg+xml' })
      Object.defineProperty(file, 'text', { value: async () => text })
      const before = useCamStore.getState().project.geometry.length
      const input = document.querySelector('input[type=file]')!
      fireEvent.change(input, { target: { files: [file] } })
      await waitFor(() => expect(useCamStore.getState().project.geometry).toHaveLength(before + 1))
      const geo = useCamStore.getState().project.geometry.at(-1)!
      await waitFor(() => expect((screen.getByTestId(`nest-part-check-${geo.id}`) as HTMLInputElement).checked).toBe(true))
      if (name === 'toe-clamp' || name === 'soft-jaw') {
        const qty = screen.getByTestId(`nest-part-check-${geo.id}`).closest('.nest-part-row')!.querySelector('input.nest-part-qty')!
        fireEvent.focus(qty)
        fireEvent.change(qty, { target: { value: '2' } })
        fireEvent.blur(qty)
      }
    }
    fireEvent.click(screen.getByRole('button', { name: /^Calculate$/ }))
    expect(screen.queryByText(/No nestable parts/)).toBeNull()
    expect(listedParts().reduce((sum, p) => sum + p.quantity, 0)).toBe(7)
    const id = finishPack()
    expect(useCamStore.getState().project.geometry.every(g => g.ownerNestId === id)).toBe(true)
    const expected = [
      { name: 'toe-clamp', quantity: 2 }, { name: 'soft-jaw', quantity: 2 },
      { name: 'gear-16', quantity: 1 }, { name: 'gear-24', quantity: 1 }, { name: 'sign', quantity: 1 },
    ]
    expect(screen.queryByText(/No nestable parts/)).toBeNull()
    expect(listedParts().sort((a, b) => a.name.localeCompare(b.name))).toEqual(expected.sort((a, b) => a.name.localeCompare(b.name)))
    const before = structuredClone(useCamStore.getState().project.nests![0])
    fireEvent.click(screen.getByRole('button', { name: /^Accept$/ }))
    act(() => {
      useCamStore.getState().setNestEditTarget(id)
      useCamStore.getState().openModal('new-nest')
    })
    expect(listedParts().reduce((sum, p) => sum + p.quantity, 0)).toBe(7)
    expect(screen.queryByText(/No nestable parts/)).toBeNull()
    expect(useCamStore.getState().project.nests![0]).toEqual({ ...before, visible: false })
  })

  it('shows the empty state for a project with nothing nestable', () => {
    render(<NestModal />)
    act(() => useCamStore.getState().openModal('new-nest'))
    expect(screen.getByText(/No nestable parts/)).not.toBeNull()
    expect(screen.queryByTestId('nest-placed-parts')).toBeNull()
  })

  it('uses actual placed quantities for a partial result rather than requested quantities', () => {
    const nest = structuredClone(readback.nest)
    nest.placements = nest.placements.slice(0, 3)
    act(() => {
      useCamStore.setState(s => ({ project: {
        ...s.project, geometry: structuredClone(readback.geometry), nests: [nest],
      } }))
      useCamStore.getState().setNestEditTarget(nest.id)
    })
    render(<NestModal />)
    act(() => useCamStore.getState().openModal('new-nest'))
    expect(listedParts().reduce((sum, p) => sum + p.quantity, 0)).toBe(3)
    expect(screen.queryByText(/No nestable parts/)).toBeNull()
    expect(useCamStore.getState().project.nests![0].placements).toEqual(nest.placements)
  })

  it('does not borrow another nest parts when opening a fresh empty picker', () => {
    act(() => useCamStore.setState(s => ({ project: {
      ...s.project, geometry: structuredClone(readback.geometry), nests: [structuredClone(readback.nest)],
    } })))
    render(<NestModal />)
    act(() => useCamStore.getState().openModal('new-nest'))
    expect(screen.getByText(/No nestable parts/)).not.toBeNull()
    expect(screen.queryByTestId('nest-placed-parts')).toBeNull()
  })
})
