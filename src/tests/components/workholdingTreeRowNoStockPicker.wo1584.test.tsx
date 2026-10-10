// @vitest-environment jsdom
//
// WO-1584: a body marked workholding (WO-1572's setGeometryWorkholding /
// isWorkholdingGeometry, grouped by WO-1573) is never a stock member, so its
// design-tree row must not offer the stock-membership picker. Every other
// control on the row stays; unmarking brings the picker back, showing the
// stock the store assigns.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (same scaffolding
// as workholdingTreeAndProperties.wo1573.test.tsx).
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

function meshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-part-1', name: 'Bracket', filename: 'bracket.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

/** The .tree-geo-block whose text contains the given row name. */
function rowFor(container: HTMLElement, name: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll<HTMLElement>('.tree-geo-block'))
  const row = rows.find((r) => r.textContent?.includes(name))
  if (!row) throw new Error(`no tree row found for "${name}"`)
  return row
}

describe('WO-1584: a workholding tree row shows no stock picker', () => {
  it('hides the picker on the workholding row and keeps it on the part row', () => {
    const part = meshGeo({ id: 'part-1', name: 'Bracket' })
    const vise = meshGeo({ id: 'vise-1', name: 'Kurt Vise', workholding: true })
    act(() => {
      useCamStore.getState().addGeometry(part)
      useCamStore.getState().addGeometry(vise)
    })
    // Not a vacuous pass: a fresh project carries the default auto stock, so the
    // picker WOULD render here if the row were eligible.
    expect((useCamStore.getState().project.stocks ?? []).length).toBeGreaterThan(0)

    const { container } = render(<DesignTree />)

    const viseRow = rowFor(container, 'Kurt Vise')
    expect(viseRow.querySelector('.tree-geo-stock-select')).toBeNull()
    expect(viseRow.querySelector('.tree-geo-stock')).toBeNull()

    const partRow = rowFor(container, 'Bracket')
    expect(partRow.querySelector('.tree-geo-stock-select')).not.toBeNull()

    // Every other control on the workholding row is unchanged: name, duplicate
    // and remove buttons are all still there.
    expect(viseRow.querySelector('.tree-item-label')?.textContent).toBe('Kurt Vise')
    expect(viseRow.querySelector('[aria-label="Duplicate geometry"]')).not.toBeNull()
    expect(viseRow.querySelector('[aria-label="Remove geometry"]')).not.toBeNull()
    expect(container.querySelectorAll('.tree-geo-stock-select').length).toBe(1)
  })

  it('unmarking the body brings the picker back, showing the stock the store assigns', () => {
    const part = meshGeo({ id: 'part-1', name: 'Bracket' })
    const vise = meshGeo({ id: 'vise-1', name: 'Kurt Vise', workholding: true })
    act(() => {
      useCamStore.getState().addGeometry(part)
      useCamStore.getState().addGeometry(vise)
    })

    const { container } = render(<DesignTree />)
    expect(rowFor(container, 'Kurt Vise').querySelector('.tree-geo-stock-select')).toBeNull()

    act(() => { useCamStore.getState().setGeometryWorkholding(vise.id, false) })

    const viseRow = rowFor(container, 'Kurt Vise')
    const select = viseRow.querySelector('.tree-geo-stock-select') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    // The store's resolved membership for an unmarked part with no explicit
    // stockId is the default auto stock ("Auto Stock 1").
    expect(select!.value).toBe(DERIVED_STOCK_ID)

    // The part row is untouched.
    expect(rowFor(container, 'Bracket').querySelector('.tree-geo-stock-select')).not.toBeNull()
    expect(container.querySelectorAll('.tree-geo-stock-select').length).toBe(2)
  })

  it('marking a plain part as workholding removes its picker too', () => {
    const part = meshGeo({ id: 'part-1', name: 'Bracket' })
    act(() => { useCamStore.getState().addGeometry(part) })

    const { container } = render(<DesignTree />)
    expect(rowFor(container, 'Bracket').querySelector('.tree-geo-stock-select')).not.toBeNull()

    act(() => { useCamStore.getState().setGeometryWorkholding(part.id, true) })

    expect(rowFor(container, 'Bracket').querySelector('.tree-geo-stock-select')).toBeNull()
    expect(container.querySelectorAll('.tree-geo-stock-select').length).toBe(0)
  })
})
