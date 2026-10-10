// @vitest-environment jsdom
//
// UI-77 acceptance A1 (can-fail render-level test): on a PLAIN-URL mount the
// mode-tab strip ships exactly five tabs in Operator's ruled order — Setup / Sketch
// / Model / Toolpath / Simulate — with the "Model" label present, and the Model
// workspace tab default-ON (no ?partWorkspace=1 needed). The opt-out escape
// hatch ?partWorkspace=0 hides it (UI-77 D3).
//
// CAN-FAIL: a reorder (move the Model tab off the after-Sketch slot) or a rename
// ("Model" -> anything) turns the order/label assertions RED. Mutation proof is
// banked under coordination/evidence/UI-77/ (see the report).
//
// Same mock harness as workspaceBar.int13a.test.tsx: Viewport constructs a real
// THREE.WebGLRenderer (no WebGL in jsdom) and SolidsWorkbenchPage is a thin
// mount-counting stub — this file asserts the strip WIRING (default-on, order,
// label), not the real kernel. The full StrictMode/real-Ready path lives in
// partWorkbenchMount.int13a.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
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

let workbenchMountCount = 0
vi.mock('../../components/model3d/SolidsWorkbenchPage', async () => {
  const React = await import('react')
  return typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
    SolidsWorkbenchPage: () => {
      React.useEffect(() => { workbenchMountCount++ }, [])
      return <div data-testid="solids-workbench-status">Ready</div>
    },
  })
})

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')

// UI-77 D2 + WO-047: the exact shipped order and labels the strip must render
// on the plain URL. WO-047 (approved WO-036 header design) added the two
// modal-opener tabs: Tool Library LEFTMOST and Post Process between Simulate
// and Control. The UI-77 core (Model immediately after Sketch) is unchanged.
const EXPECTED = [
  { testid: 'mode-tab-toollibrary', label: 'Tool Library' },
  { testid: 'mode-tab-setup', label: 'Setup' },
  { testid: 'mode-tab-sketch', label: 'Sketch' },
  { testid: 'mode-tab-part', label: 'Model' },
  { testid: 'mode-tab-toolpath', label: 'Toolpath' },
  { testid: 'mode-tab-simulation', label: 'Simulate' },
  { testid: 'mode-tab-postprocess', label: 'Post Process' },
  // MACHINE-CONTROL: the Control tab (GRBL sender workspace) ships LAST in
  // the strip - a deliberate pin update for the Operator-directed Control tab.
  { testid: 'mode-tab-control', label: 'Control' },
]

beforeEach(() => {
  workbenchMountCount = 0
  window.history.pushState(null, '', '/')
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('UI-77 A1: plain-URL Model tab, default-on, after Sketch', () => {
  it('renders exactly eight tabs in the WO-047 ruled order', () => {
    render(<App />)
    const strip = screen.getByTestId('mode-tab-part').parentElement!
    const children = Array.from(strip.children)
    // Exactly eight, in the ruled order.
    expect(children.map((c) => c.getAttribute('data-testid'))).toEqual(EXPECTED.map((e) => e.testid))
    // Each tab carries its exact label text (the D1 rename: "Model", never "Part Studio").
    expect(children.map((c) => c.querySelector('span')?.textContent)).toEqual(EXPECTED.map((e) => e.label))
  })

  it('the Model tab reads exactly "Model" (never a commercial-CAD name)', () => {
    render(<App />)
    const modelTab = screen.getByTestId('mode-tab-part')
    expect(modelTab.querySelector('span')?.textContent).toBe('Model')
    expect(strippedText(modelTab)).not.toMatch(/part studio/i)
    // Model sits immediately after Sketch (D2): the Sketch tab is its previous sibling.
    expect(modelTab.previousElementSibling?.getAttribute('data-testid')).toBe('mode-tab-sketch')
  })

  it('is default-ON but lazy: the workbench does not mount until the Model tab is entered', async () => {
    render(<App />)
    // Present on the plain URL (D3) yet not mounted at rest.
    expect(screen.getByTestId('mode-tab-part')).toBeTruthy()
    expect(screen.queryByTestId('part-workspace-host')).toBeNull()
    expect(workbenchMountCount).toBe(0)
    // Entering it mounts SolidsWorkbenchPage. WO-2707 (WO-2700 154b13a79, owner
    // 10-09 'Keep it'): the plain Model tab opens the New Model dialog; the
    // operator's Create Model is what enters the workspace.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(workbenchMountCount).toBe(0)
    fireEvent.click(screen.getByTestId('model-entry-new'))
    expect(useCamStore.getState().workspace).toBe('part')
    await waitFor(() => expect(workbenchMountCount).toBe(1))
  })
})

describe('UI-77 D3: ?partWorkspace=0 is the opt-out escape hatch', () => {
  beforeEach(() => window.history.pushState(null, '', '/?partWorkspace=0'))

  it('hides the Model tab and never mounts the workbench', () => {
    render(<App />)
    expect(screen.queryByTestId('mode-tab-part')).toBeNull()
    expect(screen.queryByTestId('part-workspace-host')).toBeNull()
    expect(workbenchMountCount).toBe(0)
    // The remaining tabs still render in their ruled order (the flag opts out
    // of MODEL only - every other tab stays, WO-047 additions included).
    const strip = screen.getByTestId('mode-tab-setup').parentElement!
    expect(Array.from(strip.children).map((c) => c.getAttribute('data-testid')))
      .toEqual(['mode-tab-toollibrary', 'mode-tab-setup', 'mode-tab-sketch', 'mode-tab-toolpath', 'mode-tab-simulation', 'mode-tab-postprocess', 'mode-tab-control'])
  })
})

function strippedText(el: Element): string {
  return (el.textContent ?? '').trim()
}
