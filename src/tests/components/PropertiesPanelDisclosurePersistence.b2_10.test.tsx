// @vitest-environment jsdom
//
// STATE-PRESERVING regression test for UI-BRAND B2-10 (disclosure/collapsible
// porting, per coordination/reports/UI-BRAND-PB-PLAN.md B2-10 + the B1-4
// census in src/components/ui/DisclosureSection.tsx). PropertiesPanel's
// `CollapsibleGroup` now renders <DisclosureSection> in CONTROLLED mode
// instead of its own local chevron/button markup. The spec's hard
// requirement is that this port PRESERVE EXACT CURRENT BEHAVIOR, in
// particular the uiPrefs-backed per-GROUP-TYPE collapse persistence (e.g.
// "Heights" stays collapsed across operations and across a panel remount) -
// verified here with a real store round-trip, not visual similarity alone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { FixedStockItem } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and BOTH the cam store and the uiPrefs store persist() on every set().
// In-memory shim BEFORE either import (mirrors PropertiesPanelStock.smoke).
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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    // Reset the persisted collapse map so tests are order-independent.
    useUiPrefs.setState({ collapsedPropsGroups: {} })
  })
})

function seedFixedStock(): FixedStockItem {
  const stock: FixedStockItem = {
    id: 'fs-pp-b2-10',
    name: 'B2-10 Block',
    width: 120,
    height: 80,
    depth: 19,
    position: { x: 5, y: 10, z: 0 },
  }
  act(() => {
    useCamStore.getState().addFixedStock(stock)
    useCamStore.getState().setSelectedStock(stock.id)
  })
  return stock
}

describe('UI-BRAND B2-10: PropertiesPanel CollapsibleGroup ported onto DisclosureSection', () => {
  it('renders the "Size" group EXPANDED by default (uiPrefs collapsedPropsGroups starts empty)', () => {
    seedFixedStock()
    render(<PropertiesPanel />)
    const header = screen.getByTestId('props-group-stock-size')
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Width (X)')).not.toBeNull()
  })

  it('clicking the ported header collapses the body AND writes collapsedPropsGroups[groupId] in uiPrefs (the SAME store slice as before the port)', () => {
    seedFixedStock()
    render(<PropertiesPanel />)
    const header = screen.getByTestId('props-group-stock-size')

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Width (X)')).toBeNull()
    expect(useUiPrefs.getState().collapsedPropsGroups['stock-size']).toBe(true)

    // Toggle back open; hooks-order-stable expand/collapse round trip.
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Width (X)')).not.toBeNull()
    expect(useUiPrefs.getState().collapsedPropsGroups['stock-size']).toBe(false)
  })

  it('collapse state SURVIVES a PropertiesPanel remount (uiPrefs persistence, unchanged by the port)', () => {
    seedFixedStock()
    const { unmount } = render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-group-stock-size'))
    expect(useUiPrefs.getState().collapsedPropsGroups['stock-size']).toBe(true)
    unmount()

    // A fresh mount of the SAME component reads the persisted uiPrefs slice,
    // not local component state - the group must come back collapsed.
    render(<PropertiesPanel />)
    const header = screen.getByTestId('props-group-stock-size')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Width (X)')).toBeNull()
  })

  it('a DIFFERENT group id ("stock-position") keeps its OWN independent collapse state (per-group-type persistence)', () => {
    seedFixedStock()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-group-stock-size'))
    expect(useUiPrefs.getState().collapsedPropsGroups['stock-size']).toBe(true)
    // Position group untouched - still expanded.
    const posHeader = screen.getByTestId('props-group-stock-position')
    expect(posHeader.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Pos X')).not.toBeNull()
  })

  it('keeps the clicked chevron at the same viewport position when disclosure content changes height', () => {
    seedFixedStock()
    render(<PropertiesPanel />)
    const header = screen.getByTestId('props-group-stock-size')
    const scroller = header.closest('.panel-body') as HTMLElement
    scroller.scrollTop = 300
    let rectRead = 0
    Object.defineProperty(header, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: rectRead++ === 0 ? 80 : 30,
        bottom: 110, left: 0, right: 200, width: 200, height: 30, x: 0, y: 0,
        toJSON: () => ({}),
      }),
    })

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(rectRead).toBeGreaterThanOrEqual(2)
    expect(scroller.scrollTop).toBe(250)
  })
})
