// @vitest-environment jsdom
//
// React-render SMOKE test for the ViewportToolbar (P11 + WO-062 slimming).
// The repo's vitest env is 'node' by default (see vite.config.ts); the directive
// above flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS EXISTS: this is the HARD UI render gate required by
// docs/CONVENTIONS.md for UI changes — tsc + pure-logic vitest miss hooks-order
// and JSX wiring bugs. P11 moved the set-and-forget controls (grid spacing,
// nest seed outline, height planes) OUT of the always-on toolbar and INTO the
// DisplayModeControl flyout (see DisplayModeControl.smoke.test.tsx for their
// new home). This test mounts the toolbar, asserts it still renders its
// surviving high-frequency toggles, the selection-only manipulation lifecycle,
// and the complete removal of the camera-preset buttons now owned by ViewCube.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { createRef, type MutableRefObject } from 'react'

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

const { ViewportToolbar } = await import('../../components/viewport/ViewportToolbar')
const { useCamStore } = await import('../../store')
import type { CNCViewport } from '../../lib/viewport/CNCViewport'
import { getByTooltip, queryByTooltip } from '../support/tooltipQuery'

afterEach(() => {
  cleanup()
  useCamStore.setState((state) => ({
    viewer: { ...state.viewer, selectedGeometryId: null },
  }))
})

// The surviving toggles do not call into vp, so a null viewport ref is fine.
// The mode callbacks are no-ops; the toolbar renders without a selected part.
function renderToolbar() {
  const vpRef = createRef<CNCViewport>() as MutableRefObject<CNCViewport | null>
  const noop = () => {}
  return render(
    <ViewportToolbar
      viewport={vpRef}
      interactionMode="normal"
      onEnterLayOnFace={noop}
      onExitLayOnFace={noop}
      onEnterProjectPlane={noop}
      onExitProjectPlane={noop}
    />,
  )
}

function setSelectedGeometryId(id: string | null) {
  act(() => {
    useCamStore.setState((state) => ({
      viewer: { ...state.viewer, selectedGeometryId: id },
    }))
  })
}

describe('ViewportToolbar after WO-062 slimming', () => {
  it('keeps only the 4 high-frequency toggles when nothing is selected', () => {
    const { container } = renderToolbar()
    expect(getByTooltip('Toggle stock')).not.toBeNull()
    expect(getByTooltip('Toggle geometry')).not.toBeNull()
    expect(getByTooltip('Toggle grid')).not.toBeNull()
    expect(getByTooltip('Toggle WCS')).not.toBeNull()
    expect(screen.queryByTestId('viewport-manipulation-tools')).toBeNull()
    expect(container.querySelectorAll('.viewport-toolbar > .vp-toolbar-group')).toHaveLength(1)
  })

  it('removes every camera preset now supplied by ViewCube', () => {
    renderToolbar()
    for (const preset of ['iso view', 'top view', 'front view', 'right view']) {
      expect(queryByTooltip(preset)).toBeNull()
    }
  })

  it('adds manipulation tools in the dock on selection and removes them after deselect', () => {
    const { container } = renderToolbar()
    const toolbar = container.querySelector('.viewport-toolbar')
    expect(toolbar).not.toBeNull()

    setSelectedGeometryId('wo062-selected-part')
    const manipulation = screen.getByTestId('viewport-manipulation-tools')
    expect(manipulation.closest('.viewport-toolbar')).toBe(toolbar)
    expect(screen.getByLabelText('Move (translate)')).not.toBeNull()
    expect(screen.getByLabelText('Rotate')).not.toBeNull()
    expect(screen.getByLabelText('Drop to floor')).not.toBeNull()
    expect(screen.getByLabelText('Lay on face')).not.toBeNull()
    expect(screen.getByLabelText('Settle')).not.toBeNull()
    expect(screen.getByLabelText('Set projection plane')).not.toBeNull()

    setSelectedGeometryId(null)
    expect(screen.queryByTestId('viewport-manipulation-tools')).toBeNull()
    expect(container.querySelector('.viewport-toolbar')).toBe(toolbar)
    expect(screen.getByTestId('viewport-visibility-tools')).not.toBeNull()
  })

  it('no longer hosts the relocated set-and-forget controls (P11)', () => {
    renderToolbar()
    // Moved to the DisplayModeControl flyout — must be ABSENT here.
    expect(screen.queryByTestId('toggle-seed-outline')).toBeNull()
    expect(screen.queryByTestId('toggle-height-planes')).toBeNull()
    expect(queryByTooltip(/Grid spacing/)).toBeNull()
    expect(queryByTooltip('Height planes')).toBeNull()
  })
})
