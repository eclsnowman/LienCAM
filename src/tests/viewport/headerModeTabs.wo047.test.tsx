// @vitest-environment jsdom
//
// WO-047 acceptance (Operator APPROVED the WO-036 design, card
// Q-CONTROL-LAYOUT-RULES): the mode tabs live NATIVELY in the top header on
// every tab, and the strip gained two former right-side utilities as tabs.
// Rendered order, left to right:
//   Tool Library / Setup / Sketch / Model / Toolpath / Simulate /
//   Post Process / Control
// with Tool Library LEFTMOST (endmill icon, never a wrench) opening the same
// tool-library modal the old header Tools button opened, and Post Process
// sitting between Simulate and Control (workflow order). The old floating
// strip and its portal mechanism are gone from the DOM entirely.
//
// Same mock harness as workspaceBar.int13a.test.tsx: Viewport constructs a
// real THREE.WebGLRenderer (no WebGL in jsdom) and SolidsWorkbenchPage is a
// thin stub - this file asserts header WIRING, not kernels.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

vi.mock('../../components/model3d/SolidsWorkbenchPage', () => typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
  SolidsWorkbenchPage: () => <div data-testid="solids-workbench-status">Ready</div>,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')

// WO-047: the exact shipped order and labels, Tool Library first and Post
// Process between Simulate and Control.
const EXPECTED = [
  { testid: 'mode-tab-toollibrary', label: 'Tool Library' },
  { testid: 'mode-tab-setup', label: 'Setup' },
  { testid: 'mode-tab-sketch', label: 'Sketch' },
  { testid: 'mode-tab-part', label: 'Model' },
  { testid: 'mode-tab-toolpath', label: 'Toolpath' },
  { testid: 'mode-tab-simulation', label: 'Simulate' },
  { testid: 'mode-tab-postprocess', label: 'Post Process' },
  { testid: 'mode-tab-control', label: 'Control' },
]

beforeEach(() => {
  window.history.pushState(null, '', '/')
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('WO-047: mode tabs in the header, full set, ruled order', () => {
  it('renders all eight tabs in order inside the top header', () => {
    render(<App />)
    const strip = screen.getByTestId('mode-tab-setup').parentElement!
    expect(strip.className).toContain('mode-tab-strip')
    const children = Array.from(strip.children)
    expect(children.map((c) => c.getAttribute('data-testid'))).toEqual(EXPECTED.map((e) => e.testid))
    expect(children.map((c) => c.querySelector('span')?.textContent)).toEqual(EXPECTED.map((e) => e.label))
    // Native header hosting: the strip's ancestry is the top toolbar's
    // centered .header-mode-tabs cell, not floating chrome.
    expect(strip.closest('.header-mode-tabs')).not.toBeNull()
    expect(strip.closest('header.top-toolbar')).not.toBeNull()
    expect(strip.closest('.viewport-toolbar')).toBeNull()
  })

  it('Tool Library is leftmost and Post Process sits between Simulate and Control', () => {
    render(<App />)
    const toolLib = screen.getByTestId('mode-tab-toollibrary')
    expect(toolLib.previousElementSibling).toBeNull()
    const post = screen.getByTestId('mode-tab-postprocess')
    expect(post.previousElementSibling?.getAttribute('data-testid')).toBe('mode-tab-simulation')
    expect(post.nextElementSibling?.getAttribute('data-testid')).toBe('mode-tab-control')
  })

  it('the Tool Library tab wears the endmill icon, not the wrench', () => {
    render(<App />)
    const svg = screen.getByTestId('mode-tab-toollibrary').querySelector('svg')
    expect(svg).not.toBeNull()
    // Lucide stamps its icon name as a class; the endmill is a hand-rolled
    // Lucide-style silhouette, so no lucide-wrench (Setup keeps the wrench).
    expect(svg!.getAttribute('class') ?? '').not.toContain('lucide-wrench')
    expect(screen.getByTestId('mode-tab-setup').querySelector('svg')!.getAttribute('class')).toContain('lucide-wrench')
  })

  it('exactly one tab is active-marked and the marker follows the mode', () => {
    render(<App />)
    const tabs = () => EXPECTED.map((e) => screen.getByTestId(e.testid))
    let active = tabs().filter((n) => n.className.includes('mode-tab-active'))
    expect(active.length).toBe(1)
    expect(active[0].getAttribute('data-testid')).toBe('mode-tab-setup')

    fireEvent.click(screen.getByTestId('mode-tab-toolpath'))
    active = tabs().filter((n) => n.className.includes('mode-tab-active'))
    expect(active.length).toBe(1)
    expect(active[0].getAttribute('data-testid')).toBe('mode-tab-toolpath')
  })

  it('Tool Library opens the tool-library modal (the old Tools button behavior)', () => {
    render(<App />)
    expect(useCamStore.getState().activeModal).toBeNull()
    fireEvent.click(screen.getByTestId('mode-tab-toollibrary'))
    expect(useCamStore.getState().activeModal).toBe('tool-library')
    // The modal actually mounts (ToolLibraryModal's own Tools view header).
    expect(screen.getByTestId('tool-view-tools')).toBeTruthy()
    // A modal opener is never active-marked - the mode did not change.
    expect(screen.getByTestId('mode-tab-toollibrary').className).not.toContain('mode-tab-active')
    expect(useCamStore.getState().viewer.mode).toBe('setup')
  })

  it('Post Process opens the post-process modal and is never active-marked', () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-postprocess'))
    expect(useCamStore.getState().activeModal).toBe('post-process')
    expect(screen.getByTestId('mode-tab-postprocess').className).not.toContain('mode-tab-active')
    expect(useCamStore.getState().viewer.mode).toBe('setup')
  })

  it('the old floating strip and portal mechanism are absent from the DOM', () => {
    const { container } = render(<App />)
    expect(document.querySelector('[data-mode-tab-portal]')).toBeNull()
    expect(document.querySelector('.app-mode-tabs-floating')).toBeNull()
    expect(screen.queryByTestId('floating-mode-tabs-part')).toBeNull()
    expect(screen.queryByTestId('floating-mode-tabs-control')).toBeNull()
    expect(screen.queryByTestId('floating-mode-tabs-fallback')).toBeNull()
    // Exactly ONE strip app-wide - the header's.
    expect(container.querySelectorAll('.mode-tab-strip').length).toBe(1)
  })

  it('the header keeps the strip on every workspace (Model and Control included)', async () => {
    render(<App />)
    // WO-2707 (WO-2700 154b13a79): Model tab -> New Model dialog -> Create Model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    expect(useCamStore.getState().workspace).toBe('part')
    expect(screen.getByTestId('mode-tab-setup').closest('header.top-toolbar')).not.toBeNull()

    fireEvent.click(screen.getByTestId('mode-tab-control'))
    expect(useCamStore.getState().workspace).toBe('control')
    expect(screen.getByTestId('mode-tab-setup').closest('header.top-toolbar')).not.toBeNull()
  })
})
