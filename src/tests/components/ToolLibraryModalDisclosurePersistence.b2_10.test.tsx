// @vitest-environment jsdom
//
// STATE-PRESERVING regression test for UI-BRAND B2-10 (disclosure/collapsible
// porting, per coordination/reports/UI-BRAND-PB-PLAN.md B2-10 + the B1-4
// census in src/components/ui/DisclosureSection.tsx). ToolLibraryModal's
// tool-type group headers now render <DisclosureSection> per contiguous
// type-run instead of an inline header row interleaved with flat list items.
// The spec's hard requirement is EXACT CURRENT BEHAVIOR preservation:
// per-type collapse (`collapsedTypes` local Set), the "focus a type via the
// dropdown" collapse-all-but-one behavior, and the "search force-expands
// without discarding the underlying collapse state" behavior all round-trip
// through the SAME state as before the port - verified here with real DOM
// interactions, not visual similarity alone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { getByTooltip } from '../support/tooltipQuery'

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

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

function mkTool(name: string, type: 'flat_end_mill' | 'ball_end_mill', n: number) {
  return {
    id: crypto.randomUUID(),
    name,
    type,
    diameter: 6,
    shankDiameter: 6,
    overallLength: 50,
    fluteLength: 18,
    shoulderLength: 0,
    numberOfFlutes: 2,
    cornerRadius: 0,
    angleFromAxisDeg: 59,
    material: 'carbide' as const,
    coating: 'none' as const,
    toolNumber: n,
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5,
        stepover: 3, coolant: 'none' as const,
      },
    },
  }
}

beforeEach(() => {
  act(() => {
    const s = useCamStore.getState()
    s.closeModal()
    // The tool library is a store singleton across tests - clear it first so
    // each test starts from exactly these 3 tools (no cross-test name dupes).
    useCamStore.setState({ toolLibrary: [] })
    s.addTool(mkTool('Flat A', 'flat_end_mill', 101))
    s.addTool(mkTool('Flat B', 'flat_end_mill', 102))
    s.addTool(mkTool('Ball A', 'ball_end_mill', 201))
  })
})

describe('UI-BRAND B2-10: ToolLibraryModal tool-type groups ported onto DisclosureSection', () => {
  it('renders one DisclosureSection per type, expanded by default (default sort = type)', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })

    const flatHeader = screen.getByTestId('tool-group-flat_end_mill')
    const ballHeader = screen.getByTestId('tool-group-ball_end_mill')
    expect(flatHeader.getAttribute('aria-expanded')).toBe('true')
    expect(ballHeader.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Flat A')).not.toBeNull()
    expect(screen.getByText('Ball A')).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('clicking a group header collapses ONLY that group (per-type collapsedTypes, unchanged by the port)', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })

    fireEvent.click(screen.getByTestId('tool-group-flat_end_mill'))
    expect(screen.getByTestId('tool-group-flat_end_mill').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Flat A')).toBeNull()
    // Ball group untouched.
    expect(screen.getByTestId('tool-group-ball_end_mill').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Ball A')).not.toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('searching FORCE-EXPANDS a collapsed group without discarding its collapse state, which resumes once the search clears', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })

    fireEvent.click(screen.getByTestId('tool-group-flat_end_mill'))
    expect(screen.queryByText('Flat A')).toBeNull()

    const search = screen.getByPlaceholderText('Search name, type, T#...')
    fireEvent.change(search, { target: { value: 'Flat' } })
    // While searching, the group reads expanded even though collapsedTypes
    // still marks it collapsed underneath (same "search overrides display,
    // doesn't erase state" contract as before the port).
    expect(screen.getByText('Flat A')).not.toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    // Clearing the search must restore the PRIOR collapsed state.
    expect(screen.queryByText('Flat A')).toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })

  it('the type-focus dropdown collapses every OTHER group (focusType, unchanged by the port)', () => {
    render(<ToolLibraryModal />)
    act(() => { useCamStore.getState().openModal('tool-library') })

    const typeSelect = getByTooltip('Jump to a tool type (expands it, collapses the rest)')
    fireEvent.change(typeSelect, { target: { value: 'ball_end_mill' } })

    expect(screen.getByTestId('tool-group-ball_end_mill').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('tool-group-flat_end_mill').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Ball A')).not.toBeNull()
    expect(screen.queryByText('Flat A')).toBeNull()

    act(() => { useCamStore.getState().closeModal() })
  })
})
