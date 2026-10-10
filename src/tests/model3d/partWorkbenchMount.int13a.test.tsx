// @vitest-environment jsdom
//
// WO INT-13A acceptance tests A1 (real 'Ready' status through a real tab
// click) and A3 (mounts under StrictMode double-invoke without error) for
// the App-owned Part Studio child mount (docs/planning/
// INT-13-WORKBENCH-INTEGRATION-SPEC.md section 1.2, D1). Viewport is mocked
// (real WebGL, out of ownership manifest — same precedent as
// AppBottomConsole.smoke.test.tsx). SolidsWorkbenchPage is the REAL
// component, not a stub: the worker is faked at the createClient facade
// boundary and THREE/WebGL at createSceneRuntime, the same injection-seam
// precedent SolidsWorkbenchPage.smoke.test.tsx itself uses for its own
// render-smoke test. App exposes no pass-through test props for these seams
// (production has none), so the fakes are injected by wrapping the real
// component at the module boundary — functionally identical to passing the
// props directly, and it still exercises the real component's mount effects,
// state machine and StrictMode double-invoke, not a hand-wave stub.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement, StrictMode } from 'react'
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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

vi.mock('../../components/model3d/SolidsWorkbenchPage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/model3d/SolidsWorkbenchPage')>()
  const { createFakeGeomClient } = await import('./fakeGeomClient')
  const { fakeCreateSceneRuntime } = await import('./fakeSceneRuntime')
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

beforeEach(() => {
  window.history.pushState(null, '', '/?partWorkspace=1')
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('INT-13A A1: clicking the Part Studio tab reaches a real Ready status', () => {
  it('mounts the real SolidsWorkbenchPage and reaches Ready after a real tab click', async () => {
    render(<App />)
    // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    // Generous timeout: this crosses a REAL dynamic import() (React.lazy, D1's genuine
    // code-split) plus the real component's own kernel-init effect chain — measured
    // ~2s in this environment, well past testing-library's 1s default.
    await waitFor(() =>
      expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    { timeout: 10000 })
    expect(useCamStore.getState().workspace).toBe('part')
  })
})

describe('INT-13A A3: the workbench mounts under StrictMode double-invoke without error', () => {
  it('renders App under StrictMode, enters Part Studio, and reaches Ready with no hooks-order violation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(createElement(StrictMode, null, createElement(App)))).not.toThrow()
      // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
      fireEvent.click(screen.getByTestId('mode-tab-part'))
      fireEvent.click(screen.getByTestId('model-entry-new'))
      await waitFor(() =>
        expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      )
      const hooksOrderCalls = errorSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg),
      )
      expect(hooksOrderCalls).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})
