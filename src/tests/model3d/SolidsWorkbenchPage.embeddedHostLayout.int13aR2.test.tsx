// @vitest-environment jsdom
//
// WO INT-13A-R2's CAN-FAIL layout-mode mechanism proof, re-pinned by UI-73
// after the 34px workspace row was rejected. A regression that reintroduces
// `position:fixed; inset:0` on the App-embedded root (or drops it from the
// standalone route) still fails. jsdom performs no real layout, so it cannot
// assert pixel bounding boxes (charter: "jsdom rect stubs are NOT acceptable
// for the final proof") -- UI-73's real-browser capture proves the floating
// overlay and first rail controls in pixels. This file asserts the CSS/DOM
// mechanism honestly available in jsdom: embedded flex root, absolute floating
// tabs, and no full-width workspace row.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement } from 'react'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { typedMock } from '../support/typedMock'

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

afterEach(cleanup)

describe('INT-13A-R2: legacy standalone route (?lab3d=1&workbench=1) stays full-viewport', () => {
  it('mounts exactly as mountLab3DPage.ts does (no embedded prop) and keeps position:fixed; inset:0', async () => {
    render(
      createElement(SolidsWorkbenchPage, {
        createClient: createFakeGeomClient,
        createSceneRuntime: fakeCreateSceneRuntime,
      }),
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    const root = screen.getByTestId('solids-workbench-root')
    expect(root.style.position).toBe('fixed')
    expect(root.style.inset).toBe('0px')
  })
})

describe('UI-73/INT-13A-R2: App-embedded Part Studio host fills below TopToolbar', () => {
  it('the embedded root is not position:fixed and is a flex child, not a full-viewport overlay', async () => {
    render(
      createElement(SolidsWorkbenchPage, {
        embedded: true,
        createClient: createFakeGeomClient,
        createSceneRuntime: fakeCreateSceneRuntime,
      }),
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    const root = screen.getByTestId('solids-workbench-root')
    // The audit's exact defect: fixed/inset:0 pulls the root out of flow to viewport y=0,
    // ignoring the App host's flex position entirely.
    expect(root.style.position).not.toBe('fixed')
    expect(root.style.inset).toBe('')
    // Fills the remaining app-shell column height instead of a hardcoded size.
    expect(root.style.flex).toBe('1 1 auto')
  })

  it('App mounts the real embedded root with header-native tabs and no workspace row', async () => {
    vi.resetModules()
    vi.doMock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
      Viewport: () => createElement('div', { 'data-testid': 'viewport-stub' }),
    }))
    vi.doMock('../../components/model3d/SolidsWorkbenchPage', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../components/model3d/SolidsWorkbenchPage')>()
      return typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
        ...actual,
        SolidsWorkbenchPage: (props: any) =>
          createElement(actual.SolidsWorkbenchPage, {
            ...props,
            createClient: createFakeGeomClient,
            createSceneRuntime: fakeCreateSceneRuntime,
          }),
      })
    })

    const { default: App } = await import('../../App')
    const { useCamStore } = await import('../../store')

    window.history.pushState(null, '', '/?partWorkspace=1')
    useCamStore.getState().newProject()
    useCamStore.setState({ workspace: 'cam' })

    try {
      render(createElement(App))
      // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
      fireEvent.click(screen.getByTestId('mode-tab-part'))
      fireEvent.click(screen.getByTestId('model-entry-new'))
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

      const root = screen.getByTestId('solids-workbench-root')

      // Mechanism proof: the App-mounted root took the embedded (non-fixed, flex) path.
      expect(root.style.position).not.toBe('fixed')
      expect(root.style.flex).toBe('1 1 auto')

      // WO-047 presentation mechanism: the navigation surface is the top
      // header's centered strip — no floating chrome, no portal, and the
      // rejected full-width workspace row is still absent.
      expect(screen.queryByTestId('workspace-bar')).toBeNull()
      expect(screen.queryByTestId('floating-mode-tabs-part')).toBeNull()
      expect(document.querySelector('[data-mode-tab-portal]')).toBeNull()
      expect(screen.getByTestId('mode-tab-part').closest('header.top-toolbar')).not.toBeNull()
    } finally {
      cleanup()
      window.history.pushState(null, '', '/')
      vi.doUnmock('../../components/viewport/Viewport')
      vi.doUnmock('../../components/model3d/SolidsWorkbenchPage')
      vi.resetModules()
    }
  })
})
