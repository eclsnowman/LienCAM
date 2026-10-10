// @vitest-environment jsdom
//
// React-render SMOKE test for the DisplayModeControl (P8: relocated out of the
// top-center ViewportToolbar to sit by the ViewCube in the bottom-left corner).
// The repo's vitest env is 'node' by default (see vite.config.ts); the directive
// above flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS EXISTS: the display-mode + section-view controls used to live in the
// ViewportToolbar smoke test; they MOVED to this standalone component. This is the
// HARD UI render gate required by docs/CONVENTIONS.md for UI changes — tsc +
// pure-logic vitest miss hooks-order and JSX wiring bugs. The control is
// store-only (the GL effect lives in Viewport.tsx), so no viewport ref is needed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { getByTooltip } from '../support/tooltipQuery'

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

const { DisplayModeControl } = await import('../../components/viewport/DisplayModeControl')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

// The store is a process singleton; reset the display/section state to defaults
// before each test so the tests are order-independent.
beforeEach(() => {
  act(() => {
    const s = useCamStore.getState()
    s.setShadingMode('shaded-edges')
    s.setSectionView({
      sectionEnabled: false,
      sectionAxis: 'x',
      sectionPosition: 0,
      sectionFlip: false,
      sectionDragEnabled: false,
    })
    // P11 relocated prefs: force back to defaults (seed outline ON, planes OFF).
    if (!s.viewer.showSeedOutline) s.toggleViewerFlag('showSeedOutline')
    if (s.viewer.showHeightPlanes) s.toggleViewerFlag('showHeightPlanes')
    s.setGridSpacing(10)
  })
})

describe('DisplayModeControl Display Mode flyout', () => {
  // The shading radios write the Zustand store (setShadingMode); the GL effect
  // lives in Viewport.tsx, so the radios do NOT need a live viewport.
  it('opens the flyout and radios drive store.viewer.shadingMode', () => {
    render(<DisplayModeControl />)
    // Flyout is closed initially.
    expect(screen.queryByTestId('display-mode-flyout')).toBeNull()

    // Open it via the button (queried by its title attribute).
    act(() => { fireEvent.click(getByTooltip('Display mode')) })
    expect(screen.getByTestId('display-mode-flyout')).not.toBeNull()

    // Default mode radio is checked.
    expect((screen.getByTestId('shading-shaded-edges') as HTMLInputElement).checked).toBe(true)

    // Pick 'unshaded' -> store updates.
    act(() => { fireEvent.click(screen.getByTestId('shading-unshaded')) })
    expect(useCamStore.getState().viewer.shadingMode).toBe('unshaded')

    // Pick 'translucent' -> store updates.
    act(() => { fireEvent.click(screen.getByTestId('shading-translucent')) })
    expect(useCamStore.getState().viewer.shadingMode).toBe('translucent')
  })
})

describe('DisplayModeControl Section view controls', () => {
  // The section sub-block lives in the SAME Display Mode flyout, below the shading
  // radios. The controls write viewer.section* state; the GL clip effect lives in
  // Viewport.tsx, so state-only assertions are sufficient here.
  it('section controls drive store.viewer.section* state', () => {
    render(<DisplayModeControl />)

    // Open the Display Mode flyout (queried by its button title).
    act(() => { fireEvent.click(getByTooltip('Display mode')) })
    expect(screen.getByTestId('display-mode-flyout')).not.toBeNull()

    // Section starts disabled.
    expect(useCamStore.getState().viewer.sectionEnabled).toBe(false)

    // Toggle section on.
    act(() => { fireEvent.click(screen.getByTestId('section-toggle')) })
    expect(useCamStore.getState().viewer.sectionEnabled).toBe(true)

    // Change axis to 'z'.
    act(() => {
      fireEvent.change(screen.getByTestId('section-axis'), { target: { value: 'z' } })
    })
    expect(useCamStore.getState().viewer.sectionAxis).toBe('z')

    // Set position to 10.
    act(() => {
      fireEvent.change(screen.getByTestId('section-position'), { target: { value: '10' } })
    })
    expect(useCamStore.getState().viewer.sectionPosition).toBe(10)

    // Flip side.
    act(() => { fireEvent.click(screen.getByTestId('section-flip')) })
    expect(useCamStore.getState().viewer.sectionFlip).toBe(true)

    // Arm the same direct viewport drag interaction used by Model.
    act(() => { fireEvent.click(screen.getByTestId('section-drag-mode')) })
    expect(useCamStore.getState().viewer.sectionDragEnabled).toBe(true)
    expect(screen.getByTestId('section-drag-mode').getAttribute('aria-pressed')).toBe('true')

    // Clear resets the complete section session, not only the clip checkbox.
    act(() => { fireEvent.click(screen.getByTestId('section-clear')) })
    expect(useCamStore.getState().viewer).toMatchObject({
      sectionEnabled: false,
      sectionAxis: 'x',
      sectionPosition: 0,
      sectionFlip: false,
      sectionDragEnabled: false,
    })
  })

  it('arming Drag plane enters section view and disabling section disarms drag', () => {
    render(<DisplayModeControl />)
    act(() => { fireEvent.click(getByTooltip('Display mode')) })

    act(() => { fireEvent.click(screen.getByTestId('section-drag-mode')) })
    expect(useCamStore.getState().viewer.sectionEnabled).toBe(true)
    expect(useCamStore.getState().viewer.sectionDragEnabled).toBe(true)

    act(() => { fireEvent.click(screen.getByTestId('section-toggle')) })
    expect(useCamStore.getState().viewer.sectionEnabled).toBe(false)
    expect(useCamStore.getState().viewer.sectionDragEnabled).toBe(false)
  })
})

describe('P11 relocated viewport prefs (grid spacing, seed outline, height planes)', () => {
  // P11 moved these set-and-forget controls OUT of the always-on
  // ViewportToolbar and INTO this flyout. Same store state as before (the GL
  // sync effects live in Viewport.tsx), so state-only assertions suffice.
  it('renders all three relocated controls inside the flyout', () => {
    render(<DisplayModeControl />)
    act(() => { fireEvent.click(getByTooltip('Display mode')) })
    expect(screen.getByTestId('display-mode-flyout')).not.toBeNull()

    expect(getByTooltip(/Grid spacing/)).not.toBeNull()
    expect(screen.getByTestId('toggle-seed-outline')).not.toBeNull()
    expect(screen.getByTestId('toggle-height-planes')).not.toBeNull()
  })

  it('seed-outline checkbox flips store.viewer.showSeedOutline (default ON -> OFF)', () => {
    render(<DisplayModeControl />)
    act(() => { fireEvent.click(getByTooltip('Display mode')) })

    expect(useCamStore.getState().viewer.showSeedOutline).toBe(true)
    act(() => { fireEvent.click(screen.getByTestId('toggle-seed-outline')) })
    expect(useCamStore.getState().viewer.showSeedOutline).toBe(false)
  })

  it('grid-spacing input commits to store.viewer.gridSpacing on blur', () => {
    render(<DisplayModeControl />)
    act(() => { fireEvent.click(getByTooltip('Display mode')) })

    const input = getByTooltip(/Grid spacing/) as HTMLInputElement
    expect(useCamStore.getState().viewer.gridSpacing).toBe(10)
    act(() => {
      fireEvent.change(input, { target: { value: '25' } })
      fireEvent.blur(input)
    })
    expect(useCamStore.getState().viewer.gridSpacing).toBe(25)
  })

  it('height-planes checkbox flips store.viewer.showHeightPlanes and gates the per-plane list', () => {
    render(<DisplayModeControl />)
    act(() => { fireEvent.click(getByTooltip('Display mode')) })

    expect(useCamStore.getState().viewer.showHeightPlanes).toBe(false)
    act(() => { fireEvent.click(screen.getByTestId('toggle-height-planes')) })
    expect(useCamStore.getState().viewer.showHeightPlanes).toBe(true)

    // Per-plane checkbox drives hiddenHeightPlanes via toggleHeightPlane.
    const clearance = screen.getByLabelText(/Clearance/) as HTMLInputElement
    expect(clearance.disabled).toBe(false)
    act(() => { fireEvent.click(clearance) })
    expect(useCamStore.getState().viewer.hiddenHeightPlanes).toContain('clearance')
    // Restore so other tests see the default hidden-planes list.
    act(() => { useCamStore.getState().toggleHeightPlane('clearance') })
  })
})
