// @vitest-environment jsdom
//
// INT-13A workspace-axis coverage re-pinned by UI-73 to the restored floating
// five-tab presentation: A2, A5, A6, A7, A8, plus the "return to CAM" half of
// A1. Viewport is mocked (constructs a real THREE.WebGLRenderer on
// mount; jsdom has no WebGL context, out of this WO's ownership manifest —
// identical precedent to AppBottomConsole.smoke.test.tsx). SolidsWorkbenchPage
// is mocked to a thin, mount-counting stub: these criteria are about the
// WIRING (does the right thing (dis)appear when `workspace` flips, does the
// strip stay uniform/undivided across both workspaces), not about the real
// kernel reaching Ready — that is SolidsWorkbenchPage's own, unowned and
// unchanged, smoke test. A1's real 'Ready' assertion and A3's StrictMode
// double-invoke are proven separately, against the REAL component, in
// partWorkbenchMount.int13a.test.tsx (same directory tree, sibling gate).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { typedMock } from '../support/typedMock'

const THEME_CSS = readFileSync(resolve(process.cwd(), 'src/theme/tokens.css'), 'utf8')
const APP_CSS = [
  readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'src/app.css'), 'utf8'),
].join('\n')
// jsdom does not resolve custom properties inside border shorthands. Resolve the
// repository's legacy border alias to its real token value without changing
// which selector owns the border declaration this regression is exercising.
const APP_CSS_FOR_JSDOM = APP_CSS.replaceAll('var(--border)', '#4b5b77')

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

// Mount count tracked in a mount-only effect (empty deps) — NOT in the render
// body, which React calls on every re-render regardless of remount identity.
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

const CAM_TAB_IDS = ['mode-tab-setup', 'mode-tab-sketch', 'mode-tab-toolpath', 'mode-tab-simulation']
// UI-77 (D2) + WO-047: rendered order is Tool Library / Setup / Sketch /
// Model / Toolpath / Simulate / Post Process / Control — the Model tab
// (testid mode-tab-part, internal id kept per D1) sits immediately after
// Sketch; WO-047 added the two modal-opener tabs (Tool Library leftmost,
// Post Process before Control); MACHINE-CONTROL's Control tab ships LAST.
const RENDERED_TAB_IDS = ['mode-tab-toollibrary', 'mode-tab-setup', 'mode-tab-sketch', 'mode-tab-part', 'mode-tab-toolpath', 'mode-tab-simulation', 'mode-tab-postprocess', 'mode-tab-control']

function hooksOrderErrors(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(([msg]) => typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg))
}

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

describe('INT-13A A5 / UI-77 D3: partWorkspace opt-out (?partWorkspace=0)', () => {
  // UI-77 D3 flipped the default ON, so "flag off" is now the explicit opt-out
  // escape hatch `?partWorkspace=0` (the plain URL shows the Model tab; that is
  // covered by tabStripModelDefault.ui77.test.tsx).
  beforeEach(() => window.history.pushState(null, '', '/?partWorkspace=0'))

  it('renders no Model tab and the workbench never mounts', () => {
    render(<App />)
    expect(screen.queryByTestId('mode-tab-part')).toBeNull()
    expect(screen.queryByTestId('part-workspace-host')).toBeNull()
    expect(workbenchMountCount).toBe(0)
  })

  it('clicking every CAM tab leaves workspace at cam and never mounts the workbench', () => {
    render(<App />)
    for (const id of CAM_TAB_IDS) fireEvent.click(screen.getByTestId(id))
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(workbenchMountCount).toBe(0)
  })

  it('mounts without a hooks-order violation (flag off)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<App />)).not.toThrow()
      expect(hooksOrderErrors(errorSpy)).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('UI-73 floating tabs + INT-13A A1/A6/A7/A8 behavior with the flag on', () => {
  beforeEach(() => window.history.pushState(null, '', '/?partWorkspace=1'))

  it('mounts without a hooks-order violation (flag on)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<App />)).not.toThrow()
      expect(hooksOrderErrors(errorSpy)).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('A6 (in CAM): eight identical tabs render, same order, none disabled, exactly one active', () => {
    render(<App />)
    expect(screen.queryByTestId('workspace-bar')).toBeNull()
    // WO-047: the strip is header chrome now — no floating host anywhere.
    expect(screen.queryByTestId('floating-mode-tabs-fallback')).toBeNull()
    expect(screen.getByTestId('mode-tab-setup').closest('header.top-toolbar')).not.toBeNull()
    const nodes = RENDERED_TAB_IDS.map((id) => screen.getByTestId(id))
    for (const n of nodes) {
      expect(n.hasAttribute('disabled')).toBe(false)
      expect(n.hidden).toBe(false)
      expect(n.style.display).not.toBe('none')
    }
    const active = nodes.filter((n) => n.className.includes('mode-tab-active'))
    expect(active.length).toBe(1)
    expect(active[0].getAttribute('data-testid')).toBe('mode-tab-setup')
    // Order: Tool Library / Setup / Sketch / Model / Toolpath / Simulate /
    // Post Process / Control (UI-77 D2 + WO-047).
    const strip = screen.getByTestId('mode-tab-part').parentElement!
    expect(Array.from(strip.children).map((c) => c.getAttribute('data-testid'))).toEqual(RENDERED_TAB_IDS)
  })

  it('A1 + A6 (in Part) + A7: clicking Model mounts the workbench, moves the active marker, keeps class parity', async () => {
    render(<App />)
    // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    expect(useCamStore.getState().workspace).toBe('part')
    // SolidsWorkbenchPage is a genuine code-split React.lazy import (D1, "must not become a
    // universal tax") — even mocked, a dynamic import() resolves on a microtask, so the
    // Suspense fallback renders for a tick before the (mocked) component appears.
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    expect(screen.queryByTestId('workspace-bar')).toBeNull()
    // WO-047: the strip stays in the header — same host in every workspace.
    expect(screen.getByTestId('mode-tab-part').closest('header.top-toolbar')).not.toBeNull()

    const nodes = RENDERED_TAB_IDS.map((id) => screen.getByTestId(id))
    for (const n of nodes) expect(n.hasAttribute('disabled')).toBe(false) // A6 mutation target
    const active = nodes.filter((n) => n.className.includes('mode-tab-active'))
    expect(active.length).toBe(1)
    expect(active[0].getAttribute('data-testid')).toBe('mode-tab-part')

    // A7 repin: WO-1153 (fe83d61ab) added the machine-end boundary class to
    // Control. The other seven retain class parity and Control differs by that
    // one intentional class only; there is still no separator DOM element.
    const baseClasses = nodes.map((n) => n.className.replace('mode-tab-active', '').trim())
    const controlIndex = RENDERED_TAB_IDS.indexOf('mode-tab-control')
    const controlClasses = baseClasses[controlIndex].split(/\s+/)
    expect(controlClasses).toContain('mode-tab-machine-end')
    expect(controlClasses.filter((name) => name !== 'mode-tab-machine-end').join(' ')).toBe(baseClasses[0])
    expect(new Set(baseClasses.filter((_classes, index) => index !== controlIndex)).size).toBe(1)
    const strip = screen.getByTestId('mode-tab-part').parentElement!
    expect(Array.from(strip.children).every((c) => c.tagName === 'BUTTON')).toBe(true)
    expect(strip.children.length).toBe(8)

    // A1, both directions, no reload: Setup returns to CAM; workbench stays mounted (retained).
    fireEvent.click(screen.getByTestId('mode-tab-setup'))
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(useCamStore.getState().viewer.mode).toBe('setup')
    expect(screen.queryByTestId('part-workspace-host')).toBeTruthy()
    expect(workbenchMountCount).toBe(1) // retained mount, not torn down and rebuilt
    expect(screen.getByTestId('mode-tab-setup').closest('header.top-toolbar')).not.toBeNull()
  })

  it('A8: re-clicking the active Model tab is a no-op — no remount', async () => {
    render(<App />)
    // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    await waitFor(() => expect(workbenchMountCount).toBe(1))
    // WO-2700: re-clicking offers another New Model; the open workspace stays put.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(useCamStore.getState().activeModal).toBe('new-model')
    expect(useCamStore.getState().workspace).toBe('part')
    expect(workbenchMountCount).toBe(1)
  })

  it('keeps the strip in header chrome (not floating) while the Model workspace is active', async () => {
    const appStyles = document.createElement('style')
    appStyles.textContent = `${THEME_CSS}\n${APP_CSS_FOR_JSDOM}`
    document.head.appendChild(appStyles)

    try {
      render(<App />)
      // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
      fireEvent.click(screen.getByTestId('mode-tab-part'))
      fireEvent.click(screen.getByTestId('model-entry-new'))
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))

      // WO-047: the one strip lives in the header's centered cell — full tab
      // set present, stretched to the header's height, no absolute chrome.
      const headerCell = document.querySelector('.header-mode-tabs')!
      expect(headerCell).not.toBeNull()
      expect(Array.from(headerCell.querySelectorAll(':scope > .mode-tab-strip > button'))).toHaveLength(8)
      expect(headerCell.closest('header.top-toolbar')).not.toBeNull()

      const styles = getComputedStyle(headerCell)
      expect(styles.display).toBe('flex')
      expect(styles.alignSelf).toBe('stretch')
      expect(styles.position).not.toBe('absolute')
    } finally {
      appStyles.remove()
    }
  })
})

describe('INT-13A A2: entering Part from CAM sketch mode leaves the active sketch and its layer intact', () => {
  beforeEach(() => window.history.pushState(null, '', '/?partWorkspace=1'))

  it('round trip cam(sketch) -> part -> cam preserves the active sketch and its layer', () => {
    render(<App />)
    useCamStore.getState().setViewerMode('sketch')
    const sketchBefore = useCamStore.getState().activeSketch
    expect(sketchBefore).not.toBeNull()
    const layerIdBefore = sketchBefore!.layerId
    const geoBefore = useCamStore.getState().project.geometry.find((g) =>
      g.layers2d?.some((l) => l.id === layerIdBefore),
    )
    expect(geoBefore).toBeTruthy()

    // WO-2707 (WO-2700 154b13a79, owner 10-09 'Keep it'): Model tab -> New Model dialog -> Create Model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    expect(useCamStore.getState().workspace).toBe('part')
    // Entering Part must not touch viewer.mode, activeSketch, or geometry — the
    // finding-1 regression: this is what fails if the Part tab dispatches
    // setViewerMode instead of setWorkspace.
    expect(useCamStore.getState().viewer.mode).toBe('sketch')
    expect(useCamStore.getState().activeSketch).toBe(sketchBefore)

    fireEvent.click(screen.getByTestId('mode-tab-sketch'))
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(useCamStore.getState().viewer.mode).toBe('sketch')
    expect(useCamStore.getState().activeSketch).toBe(sketchBefore)
    const geoAfter = useCamStore.getState().project.geometry.find((g) =>
      g.layers2d?.some((l) => l.id === layerIdBefore),
    )
    expect(geoAfter).toBeTruthy()
  })
})
