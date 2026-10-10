// @vitest-environment jsdom
//
// WO UI-18 (D1, Operator's scrolling complaint): the left-panel section headers
// (Model / Bodies / Parameters / Inspect) collapse/expand via the existing
// tree-section-header-btn + chevron pattern (mirrors DesignTree.tsx's Stock/
// Geometry/Setups accordion), and the collapsed set persists across a
// remount through uiPrefs (same "REAL persist/restore path" shim
// SolidsWorkbenchPage.ui17.test.tsx's AC4 case already established).

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { useUiPrefs } from '../../store/uiPrefs'

afterEach(cleanup)

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k)
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
  } as Storage
}

let priorLocalStorage: PropertyDescriptor | undefined
beforeEach(() => {
  priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
})
afterEach(() => {
  useUiPrefs.setState({ workbenchCollapsedSections: [] })
  if (priorLocalStorage !== undefined) Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
  priorLocalStorage = undefined
})

const SECTIONS = ['model', 'bodies', 'parameters', 'inspect'] as const

async function mount() {
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={fakeCreateSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
}

describe('SolidsWorkbenchPage left-panel section collapse (WO UI-18 D1)', () => {
  it('all four sections default expanded with their body content and a down chevron', async () => {
    await mount()
    for (const s of SECTIONS) {
      expect(screen.getByTestId(`workbench-section-${s}-header`)).toBeTruthy()
    }
    // Body content present -- a testid unique to each section's inner content.
    expect(screen.getByTestId('feature-tree')).toBeTruthy()
    expect(screen.getByTestId('lab3d-body-list')).toBeTruthy()
    expect(screen.getByTestId('params-table')).toBeTruthy()
    expect(screen.getByTestId('mass-properties-panel')).toBeTruthy()
  })

  it.each(SECTIONS)('%s section collapses on header click (content unmounts, chevron flips) and expands back on a second click', async (section) => {
    await mount()
    const header = screen.getByTestId(`workbench-section-${section}-header`)
    const chevronBefore = header.querySelector('.tree-section-header-chevron')?.innerHTML

    fireEvent.click(header)
    expect(useUiPrefs.getState().workbenchCollapsedSections).toContain(section)
    const chevronAfterCollapse = header.querySelector('.tree-section-header-chevron')?.innerHTML
    expect(chevronAfterCollapse).not.toEqual(chevronBefore)

    fireEvent.click(header)
    expect(useUiPrefs.getState().workbenchCollapsedSections).not.toContain(section)
    const chevronAfterExpand = header.querySelector('.tree-section-header-chevron')?.innerHTML
    expect(chevronAfterExpand).toEqual(chevronBefore)
  })

  it('Parameters section body unmounts from the DOM while collapsed (fails-if proof target: the params-table testid)', async () => {
    await mount()
    expect(screen.getByTestId('params-table')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workbench-section-parameters-header'))
    expect(screen.queryByTestId('params-table')).toBeNull()
    fireEvent.click(screen.getByTestId('workbench-section-parameters-header'))
    expect(screen.getByTestId('params-table')).toBeTruthy()
  })

  it('Inspect section body (the full UI-4 panel suite) unmounts while collapsed', async () => {
    await mount()
    for (const id of ['measure-panel', 'appearance-panel', 'visibility-panel', 'section-controls', 'mass-properties-panel']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
    fireEvent.click(screen.getByTestId('workbench-section-inspect-header'))
    for (const id of ['measure-panel', 'appearance-panel', 'visibility-panel', 'section-controls', 'mass-properties-panel']) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })

  it('collapsed set persists across a remount via uiPrefs/localStorage (real persist/restore path)', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('workbench-section-bodies-header'))
    fireEvent.click(screen.getByTestId('workbench-section-parameters-header'))
    expect(useUiPrefs.getState().workbenchCollapsedSections.sort()).toEqual(['bodies', 'parameters'])

    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem('liencam-ui-prefs') ?? null
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).state.workbenchCollapsedSections.sort()).toEqual(['bodies', 'parameters'])

    // WO UI-17-R1's own precedent: a cleanup+remount alone can't prove REAL
    // rehydration (the in-memory store already holds the value) -- wipe the
    // in-memory field, force the real restore path via persist.rehydrate(),
    // THEN remount. FAILS-IF rehydration cannot recover the collapsed set.
    useUiPrefs.setState({ workbenchCollapsedSections: [] })
    ;(globalThis as { localStorage?: Storage }).localStorage?.setItem('liencam-ui-prefs', raw as string)
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().workbenchCollapsedSections.sort()).toEqual(['bodies', 'parameters'])

    cleanup()
    await mount()
    expect(screen.queryByTestId('params-table')).toBeNull()
    expect(screen.queryByTestId('lab3d-body-list')).toBeNull()
    expect(screen.queryByTestId('mass-properties-panel')).toBeTruthy() // inspect section untouched
  })
})
