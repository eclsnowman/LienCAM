// @vitest-environment jsdom
//
// WO SKC-14B render gate. SketchPromptBar and SketchContextMenu were the two sketch overlays with
// only headless model coverage (src/tests/sketch/promptBar.test.ts, contextMenu.test.ts) and no
// React render smoke. This WO repointed BOTH of them from `useCamStore(s => s.sketchTool)` onto the
// package's `useSketcherTool` (a `useSyncExternalStore` hook) and swapped their dispatch onto
// `sketcherTools`. tsc and the headless model tests cannot see a hooks-order fault -- only a real
// render can -- so per the project's render-gate rule this file mounts both components for real.
//
// What is pinned:
//   * Each component mounts, re-renders on a package tool-state change, and unmounts without a
//     hooks-order crash (React throws "Rendered fewer hooks than expected" if a selector moves
//     below an early return).
//   * The prompt bar NARRATES the armed tool from package state, and its Confirm/Cancel buttons
//     dispatch through the package (the chain actually changes).
//   * The context menu renders its items from package tool state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

// jsdom's localStorage is broken under vitest's node flags and the store uses persist(); install an
// in-memory shim BEFORE importing the store.
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

const { SketchPromptBar } = await import('../../lib/sketch/sketcher/overlays/SketchPromptBar')
const { SketchContextMenu } = await import('../../lib/sketch/sketcher/overlays/SketchContextMenu')
// The store must be imported before anything drives `sketcherTools`: importing it binds CAM's
// document sink into the package.
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
const { sketcherToolStore, sketcherTools } = await import('../../lib/sketch/sketcher')

function enterSketchMode() {
  act(() => {
    useCamStore.setState({
      viewer: { ...useCamStore.getState().viewer, mode: 'sketch' },
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [], constraints: [], dimensions: [], solveStatus: null,
      },
      sketchSelectedIds: [],
    } as never)
  })
}

beforeEach(() => {
  sketcherToolStore.__reset()
  enterSketchMode()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => null)

describe('SketchPromptBar renders against package tool state', () => {
  it('mounts with no tool armed without a hooks-order crash', () => {
    const { container } = render(<SketchPromptBar port={port} />)
    expect(container).toBeTruthy()
  })

  it('narrates the armed tool, and re-renders when the PACKAGE state changes', () => {
    render(<SketchPromptBar port={port} />)
    // FAILS-IF the bar still subscribes to the CAM store: arming through the package would not
    // repaint it, and the user would see a stale prompt.
    act(() => { sketcherTools.armTool('line') })
    expect(screen.getByText(/line/i)).toBeTruthy()
  })

  it('Confirm dispatches through the package: the in-progress chain ends', () => {
    render(<SketchPromptBar port={port} />)
    act(() => { sketcherToolStore.setState({ tool: 'line', chain: { kind: 'line', prev: { x: 0, y: 0 } } as never }) })
    const confirm = screen.getByRole('button', { name: /confirm/i })
    act(() => { confirm.click() })
    // `end()` on a bare line chain discards it (endChain) -- proving the click reached the package.
    expect(sketcherToolStore.getState().chain).toBeNull()
  })

  it('Cancel dispatches through the package: Escape semantics clear the chain', () => {
    render(<SketchPromptBar port={port} />)
    act(() => { sketcherToolStore.setState({ tool: 'line', chain: { kind: 'line', prev: { x: 0, y: 0 } } as never }) })
    const cancel = screen.getByRole('button', { name: /cancel|back/i })
    act(() => { cancel.click() })
    expect(sketcherToolStore.getState().chain).toBeNull()
  })

  it('unmounts cleanly after a tool-state change (no stale subscription)', () => {
    const { unmount } = render(<SketchPromptBar port={port} />)
    act(() => { sketcherTools.armTool('circle-center') })
    expect(() => unmount()).not.toThrow()
    // A write after unmount must not throw through a dangling listener.
    expect(() => act(() => { sketcherTools.armTool('select') })).not.toThrow()
  })
})

describe('SketchContextMenu renders against package tool state', () => {
  it('mounts and renders menu items without a hooks-order crash', () => {
    const { container } = render(<SketchContextMenu port={port} at={{ x: 10, y: 20 }} onClose={() => {}} />)
    expect(container.querySelector('.sketch-context-menu')).not.toBeNull()
  })

  it('re-renders when the package tool state changes underneath it', () => {
    const { container } = render(<SketchContextMenu port={port} at={{ x: 10, y: 20 }} onClose={() => {}} />)
    act(() => { sketcherTools.armTool('line') })
    // The menu is chain/tool-aware; arming must not crash it and it must still present a menu.
    expect(container.querySelector('.sketch-context-menu')).not.toBeNull()
  })

  it('the click-away backdrop closes it', () => {
    let closed = 0
    const { container } = render(
      <SketchContextMenu port={port} at={{ x: 10, y: 20 }} onClose={() => { closed++ }} />)
    const backdrop = container.querySelector('.sketch-context-overlay') as HTMLElement
    act(() => { backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(closed).toBe(1)
  })
})
