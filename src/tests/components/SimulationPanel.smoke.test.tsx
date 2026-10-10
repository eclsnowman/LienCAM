// @vitest-environment jsdom
//
// React-render SMOKE test for the SimulationPanel's stock-sim view controls
// (Feature A: "Show toolpath" toggle; Feature B: "Stock opacity" slider). The
// repo's vitest env is 'node' by default (see vite.config.ts); the directive
// above flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS EXISTS: these are view-only controls added to the simulation timeline
// bar. They write the Zustand viewer slice (simHideToolpath / stockSimOpacity);
// the GL effects live in Viewport.tsx + CNCViewport (toolpath visibility and
// stock-mesh opacity), so state-only assertions are sufficient here. This is the
// HARD UI render gate required by docs/CONVENTIONS.md — tsc + pure-logic vitest
// miss hooks-order and JSX wiring bugs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a minimal
// in-memory Storage shim BEFORE importing the store. Pure test scaffolding.
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

const { SimulationPanel, SPEED_OPTIONS, INITIAL_SPEED_IDX } =
  await import('../../components/simulation/SimulationPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

// The store is a process singleton; force the viewer into the simulation view
// with the stock sim enabled (so the new controls render) and reset the two new
// fields to their defaults before each test so the tests are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.setState(s => ({
      viewer: {
        ...s.viewer,
        mode: 'simulation',
        stockSimEnabled: true,
        simHideToolpath: false,
        stockSimDisplayMode: 'compare',
        stockSimOpacity: 1.0,
      },
    }))
  })
})

describe('SimulationPanel stock-sim view controls', () => {
  it('renders the Hide Toolpath toggle and Stock opacity slider', () => {
    render(<SimulationPanel />)
    expect(screen.getByTestId('sim-hide-toolpath')).not.toBeNull()
    expect(screen.getByTestId('sim-stock-opacity')).not.toBeNull()
  })

  it('Hide Toolpath checkbox drives store.viewer.simHideToolpath (default unchecked = visible)', () => {
    render(<SimulationPanel />)
    const cb = screen.getByTestId('sim-hide-toolpath') as HTMLInputElement
    expect(cb.checked).toBe(false)

    act(() => { fireEvent.click(cb) })
    expect(useCamStore.getState().viewer.simHideToolpath).toBe(true)
  })

  it('P9: speed chip renders with the flyout CLOSED, showing the current speed', () => {
    render(<SimulationPanel />)
    const chip = screen.getByTestId('sim-speed-chip')
    expect(chip.textContent).toContain(`${SPEED_OPTIONS[INITIAL_SPEED_IDX]}x`)
    expect(screen.queryByTestId('sim-speed-flyout')).toBeNull()
  })

  it('P9: clicking the chip opens the preset flyout; picking a preset sets it and closes', () => {
    render(<SimulationPanel />)
    const chip = screen.getByTestId('sim-speed-chip')

    // Open: all 7 presets render (closed -> open is the hooks-order transition).
    act(() => { fireEvent.click(chip) })
    const flyout = screen.getByTestId('sim-speed-flyout')
    const presets = flyout.querySelectorAll('button')
    expect(presets.length).toBe(SPEED_OPTIONS.length)

    // Pick 100x (last preset): chip label updates, flyout closes.
    act(() => { fireEvent.click(presets[presets.length - 1]) })
    expect(screen.queryByTestId('sim-speed-flyout')).toBeNull()
    expect(screen.getByTestId('sim-speed-chip').textContent).toContain('100x')

    // Re-open shows the picked preset as the active one.
    act(() => { fireEvent.click(screen.getByTestId('sim-speed-chip')) })
    const active = screen.getByTestId('sim-speed-flyout').querySelector('.sim-speed-active')
    expect(active?.textContent).toBe('100x')
  })

  it('Stock opacity slider drives store.viewer.stockSimOpacity without crashing', () => {
    render(<SimulationPanel />)
    const slider = screen.getByTestId('sim-stock-opacity') as HTMLInputElement
    expect(parseFloat(slider.value)).toBe(1)

    act(() => { fireEvent.change(slider, { target: { value: '0.5' } }) })
    expect(useCamStore.getState().viewer.stockSimOpacity).toBeCloseTo(0.5)

    // Re-render stays clean after the store change (no hooks-order / crash).
    expect(screen.getByTestId('sim-stock-opacity')).not.toBeNull()
  })

  // ADAPTIVE-VIEW-CRASH blast-radius gate: a move the frame builder legitimately
  // refuses (here a genuinely feedless CUT move - the SIM-4 contract still throws)
  // must fail loud IN THIS PANEL and keep the app alive, NOT propagate to the
  // app-level ErrorBoundary and nuke the whole app to the "Reset Project Data" screen.
  it('a refused move surfaces a named in-panel error and does NOT crash the app', () => {
    const originalProject = useCamStore.getState().project
    act(() => {
      useCamStore.setState((s) => {
        const brokenOp = {
          id: 'broken-op',
          name: 'Broken Rough',
          type: 'pocket_2d',
          enabled: true,
          status: 'ready',
          toolId: s.toolLibrary[0]?.id ?? 't-broken',
          params: {},
          // Valid finite coords, but a CUT move with NO feed = genuinely bad data.
          toolpathMoves: [
            { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
            { type: 'feed', x: 10, y: 0, z: 5, role: 'cut' },
          ],
        }
        const setup = {
          id: 'setup-broken',
          name: 'Setup 1',
          wcs: { origin: { x: 0, y: 0, z: 0 }, rotationDeg: 0, stockId: undefined },
          operations: [brokenOp],
          notes: '',
        }
        return {
          project: {
            ...s.project,
            machine: { ...s.project.machine, rapidRate: 5000 },
            geometry: s.project.geometry ?? [],
            nests: s.project.nests ?? [],
            setups: [setup],
            activeSetupId: 'setup-broken',
            activeOperationId: 'broken-op',
          },
        } as unknown as Partial<ReturnType<typeof useCamStore.getState>>
      })
    })

    // Render must NOT throw (a throw would reach the app-level ErrorBoundary).
    expect(() => render(<SimulationPanel />)).not.toThrow()

    // The panel shows the named refusal, scoped to this view.
    const banner = screen.getByTestId('sim-frame-error')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toMatch(/finite positive feed/i)
    expect(banner.textContent?.toLowerCase()).toContain('cut')

    // Restore the singleton store so this seed does not leak into sibling tests.
    act(() => { useCamStore.setState({ project: originalProject }) })
  })

  it('UI-44 switches between Cut Stock, Compare, and Target display modes', () => {
    render(<SimulationPanel />)
    expect(screen.getByTestId('sim-display-compare').getAttribute('aria-pressed')).toBe('true')

    act(() => { fireEvent.click(screen.getByTestId('sim-display-stock')) })
    expect(useCamStore.getState().viewer.stockSimDisplayMode).toBe('stock')
    expect(screen.queryByTestId('sim-stock-opacity')).toBeNull()

    act(() => { fireEvent.click(screen.getByTestId('sim-display-target')) })
    expect(useCamStore.getState().viewer.stockSimDisplayMode).toBe('target')

    act(() => { fireEvent.click(screen.getByTestId('sim-display-compare')) })
    expect(useCamStore.getState().viewer.stockSimDisplayMode).toBe('compare')
    expect(screen.getByTestId('sim-stock-opacity')).not.toBeNull()
  })
})
