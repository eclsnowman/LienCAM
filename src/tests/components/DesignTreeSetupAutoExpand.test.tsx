// @vitest-environment jsdom
//
// CVU-1 (CRASH-VERIFY-UAT 2026-07-26, coordination/reports/CRASH-VERIFY-UAT.
// report.md): on loading a project the design tree's Setup node started
// COLLAPSED, hiding every operation until the user manually expanded it -- a
// user following "load a project -> click a toolpath" had nothing to click
// (coordination/evidence/CRASH-VERIFY-UAT/probe-setup-view.png). This is a
// React-render SMOKE/pin test (render-gate rule): the fix lives in a mount
// effect in DesignTree.tsx, invisible to tsc/pure-logic tests.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the uiPrefs Zustand store uses persist() which writes on every set().
// Install a minimal in-memory Storage shim BEFORE importing the store (same
// scaffolding as DesignTreeAutoStock.smoke.test.tsx).
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

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    // Fresh uiPrefs each test so persisted expand state doesn't leak across runs.
    useUiPrefs.setState({ expandedSetupIds: [] })
  })
})

function addSetupWithOneOp(setupId: string, opId: string) {
  useCamStore.getState().addSetup({
    id: setupId,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: { type: 'auto' },
    operations: [{
      id: opId,
      name: 'Contour',
      type: 'contour_2d',
      enabled: true,
      status: 'unconfigured',
      toolId: '',
      geometrySelections: [],
      heights: {},
      passes: {},
      linking: {},
      params: {},
    }],
    notes: '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

describe('DesignTree CVU-1: active setup auto-expands on project load', () => {
  it('shows the active setup\'s operation rows on first mount, with NO manual expand click', () => {
    act(() => { addSetupWithOneOp('setup-1', 'op-1') })
    // addSetup makes it the active setup (project.activeSetupId === 'setup-1').
    expect(useCamStore.getState().project.activeSetupId).toBe('setup-1')
    // Sanity: uiPrefs starts with NO persisted expansion for this setup.
    expect(useUiPrefs.getState().expandedSetupIds).not.toContain('setup-1')

    render(<DesignTree />)

    // A user following "load -> click a toolpath" must see the op row already --
    // no click on the setup header required.
    expect(screen.getByText('Contour')).not.toBeNull()
    expect(document.querySelector('.tree-op')).not.toBeNull()
  })

  it('is additive: does not clear a DIFFERENT setup id the user already had expanded', () => {
    act(() => {
      addSetupWithOneOp('setup-1', 'op-1')
      useUiPrefs.getState().setExpandedSetupIds(['some-other-setup-id'])
    })
    render(<DesignTree />)
    expect(screen.getByText('Contour')).not.toBeNull()
    const ids = useUiPrefs.getState().expandedSetupIds
    expect(ids).toContain('setup-1')
    expect(ids).toContain('some-other-setup-id')
  })

  it('does not re-add an id already present (idempotent, no needless persist churn)', () => {
    act(() => {
      addSetupWithOneOp('setup-1', 'op-1')
      useUiPrefs.getState().setExpandedSetupIds(['setup-1'])
    })
    render(<DesignTree />)
    const ids = useUiPrefs.getState().expandedSetupIds
    expect(ids.filter((id) => id === 'setup-1').length).toBe(1)
  })
})
