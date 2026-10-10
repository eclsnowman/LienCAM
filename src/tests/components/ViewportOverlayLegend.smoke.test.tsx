// @vitest-environment jsdom
//
// React-render SMOKE test for the toolpath-legend chip (clutter-audit P10).
// The 11-toggle legend collapses to a single "Legend" chip with a visible-role
// count badge; clicking expands the full list as a flyout. Operator's verdict
// requires the expanded/collapsed state to PERSIST, so it lives in the
// persisted uiPrefs store (key "liencam-ui-prefs") - the same mechanism the
// design-tree expand state and panel widths use. Mirrors the
// NestModal.smoke.test.tsx render-gate pattern (tsc + pure-logic vitest miss
// hooks-order / JSX wiring bugs).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// both Zustand stores use persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the stores.
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

const { ViewportOverlay } = await import('../../components/viewport/ViewportOverlay')
const { useCamStore } = await import('../../store')
const { useUiPrefs, UI_PREFS_STORAGE_KEY } = await import('../../store/uiPrefs')

afterEach(cleanup)

const legendRoles = [
  'cut', 'rapid', 'helix', 'ramp', 'plunge', 'stepover',
  'fast_traverse', 'wall_follow', 'finish', 'lead_in', 'lead_out',
] as const

// Both stores are process singletons; force a toolpath-mode viewer with no
// hidden roles, one move of every legend role, and a COLLAPSED legend before
// each test (order-independence).
beforeEach(() => {
  act(() => {
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        activeSetupId: 'legend-setup',
        activeOperationId: 'legend-op',
        setups: [{
          id: 'legend-setup',
          name: 'Legend fixture',
          operations: [{
            id: 'legend-op',
            enabled: true,
            // e3927c6cd ("fix(cam): gate stale paths and restore boundary pick
            // presentation") made collectToolpathSections skip any operation
            // whose status is not ready/outdated/degraded, so a fixture with no
            // status renders ZERO sections and the legend counts zero roles.
            // The legend is about roles present in a DRAWN toolpath, so the
            // fixture must be a drawable one.
            status: 'ready',
            params: {},
            toolpathMoves: legendRoles.map((role, index) => ({
              type: role === 'rapid' ? 'rapid' : 'feed',
              x: index,
              y: 0,
              z: 0,
              role,
            })),
          }],
        }] as any,
      },
      viewer: {
        ...s.viewer,
        mode: 'toolpath',
        hiddenToolpathRoles: [],
        showRoughingPreview: false,
      },
    }))
    useUiPrefs.setState({ tpLegendExpanded: false })
  })
})

describe('ViewportOverlay toolpath-legend chip (P10)', () => {
  it('renders collapsed by default: chip with an 11 badge, no list', () => {
    render(<ViewportOverlay interactionMode="normal" />)
    expect(screen.getByTestId('tp-legend-chip')).not.toBeNull()
    expect(screen.getByTestId('tp-legend-chip-badge').textContent).toBe('11')
    expect(screen.queryByTestId('tp-legend-list')).toBeNull()
  })

  it('clicking the chip expands the full 11-toggle list (collapsed -> expanded render)', () => {
    render(<ViewportOverlay interactionMode="normal" />)
    act(() => { fireEvent.click(screen.getByTestId('tp-legend-chip')) })

    const list = screen.getByTestId('tp-legend-list')
    expect(list.querySelectorAll('.tp-legend-toggle').length).toBe(11)

    // Collapse again: the list unmounts, the chip stays.
    act(() => { fireEvent.click(screen.getByTestId('tp-legend-chip')) })
    expect(screen.queryByTestId('tp-legend-list')).toBeNull()
  })

  it('expanded state PERSISTS through the uiPrefs store (liencam-ui-prefs)', () => {
    render(<ViewportOverlay interactionMode="normal" />)
    act(() => { fireEvent.click(screen.getByTestId('tp-legend-chip')) })

    // The store flag flipped AND the persist middleware wrote it to storage -
    // that is what survives a page reload (Operator: "if you have it expanded it
    // stays expanded").
    expect(useUiPrefs.getState().tpLegendExpanded).toBe(true)
    const persisted = JSON.parse(mem.get(UI_PREFS_STORAGE_KEY) ?? '{}')
    expect(persisted?.state?.tpLegendExpanded).toBe(true)
  })

  it('badge counts VISIBLE roles: hiding one via its eye toggle drops it to 10', () => {
    act(() => { useUiPrefs.setState({ tpLegendExpanded: true }) })
    render(<ViewportOverlay interactionMode="normal" />)

    const firstToggle = screen.getByTestId('tp-legend-list').querySelector('.tp-legend-toggle')
    act(() => { fireEvent.click(firstToggle!) })

    expect(useCamStore.getState().viewer.hiddenToolpathRoles.length).toBe(1)
    expect(screen.getByTestId('tp-legend-chip-badge').textContent).toBe('10')
  })

  it('hides move roles absent from the rendered toolpath and counts only active visible roles', () => {
    act(() => {
      useCamStore.setState(s => ({
        project: {
          ...s.project,
          setups: s.project.setups.map(setup => setup.id === 'legend-setup'
            ? {
                ...setup,
                operations: setup.operations.map(op => op.id === 'legend-op'
                  ? {
                      ...op,
                      toolpathMoves: [
                        { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
                        { type: 'feed', x: 1, y: 0, z: 0, role: 'cut' },
                        { type: 'feed', x: 2, y: 0, z: 0, role: 'finish' },
                      ],
                    }
                  : op),
              }
            : setup),
        },
        viewer: { ...s.viewer, hiddenToolpathRoles: ['finish'] },
      }))
      useUiPrefs.setState({ tpLegendExpanded: true })
    })

    render(<ViewportOverlay interactionMode="normal" />)
    const list = screen.getByTestId('tp-legend-list')
    expect(list.querySelectorAll('.tp-legend-toggle').length).toBe(3)
    expect(list.textContent).toContain('Cut')
    expect(list.textContent).toContain('Rapid')
    expect(list.textContent).toContain('Finish')
    expect(list.textContent).not.toContain('Helix')
    expect(screen.getByTestId('tp-legend-chip-badge').textContent).toBe('2')
  })

  it('Toolpath mode exposes the roughing-preview toggle without changing the move-role count', () => {
    act(() => { useUiPrefs.setState({ tpLegendExpanded: true }) })
    render(<ViewportOverlay interactionMode="normal" />)

    const toggle = screen.getByTestId('toggle-roughing-preview') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByTestId('tp-legend-list').querySelectorAll('.tp-legend-toggle').length).toBe(11)

    act(() => { fireEvent.click(toggle) })
    expect(useCamStore.getState().viewer.showRoughingPreview).toBe(true)
    expect((screen.getByTestId('toggle-roughing-preview') as HTMLInputElement).checked).toBe(true)

    act(() => {
      useCamStore.setState(s => ({ viewer: { ...s.viewer, mode: 'simulation' } }))
    })
    expect(screen.queryByTestId('toggle-roughing-preview')).toBeNull()
  })
})
