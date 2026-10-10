// @vitest-environment jsdom
//
// React-render SMOKE test for SketchDrawValueInput (NestModal.smoke pattern:
// the repo's vitest env is node; the directive flips THIS file to jsdom).
//
// WHY THIS EXISTS: Operator's verdict on the fillet radius box (0f4d9a0 follow-up)
// was that it must ANCHOR to the geometry being edited -- and his verdict on
// 3dac35e sharpened it: the FIRST staged corner, so the box stays put while
// more corners are staged (no hopping); unselecting the first corner
// re-anchors to the next. Else the pending first-line click, else the cursor
// for discoverability before anything is picked. Line/circle rubber-band
// placement is unchanged (there the cursor IS the geometry). These tests
// mount the real component with a mocked viewport bridge and a deterministic
// rAF queue, then read the positioning transform the per-frame tick writes.

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { CNCViewport } from '../../lib/viewport/CNCViewport'
import type {
  SketchWorkerRequestMsg, SketchWorkerResponseMsg,
} from '../../lib/sketch/solver/protocol'

// ---- Harness scaffolding (all BEFORE the store import) ----------------------

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the Zustand store persists on every set() -- in-memory shim (NestModal.smoke).
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

// Sketch solver worker stub (filletRadiusPopup.test.ts EchoWorker): the store
// may spin a solver up on sketch activity; echo entities straight back.
class EchoWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    const { requestId, sketch } = msg.payload
    const data: SketchWorkerResponseMsg = {
      type: 'SKETCH_SOLVE_COMPLETE',
      requestId,
      entities: sketch.entities,
      status: { dof: 0, conflicting: [], redundant: [], fullyDefinedEntities: [] },
      computeTimeMs: 0,
    }
    setTimeout(() => this.onmessage?.({ data }), 0)
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', EchoWorker)

// Deterministic rAF: the component's positioning tick self-schedules with
// requestAnimationFrame and runs its body once synchronously on mount. Queue
// the re-schedules so a test can step exactly one frame after a state change.
const rafQueue: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  rafQueue.push(cb)
  return rafQueue.length
})
vi.stubGlobal('cancelAnimationFrame', () => {})
function stepFrame(): void {
  const cb = rafQueue.shift()
  if (cb) act(() => { cb(performance.now()) })
}

const { SketchDrawValueInput } = await import('../../lib/sketch/sketcher/overlays/SketchDrawValueInput')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

// Viewport bridge mock: world mm -> screen px is a plain x10 scale so the
// expected transforms are trivial to compute by hand. Cursor parks at (5,5).
const mockCursor = { x: 5, y: 5 }
const mockViewport = {
  getLastSketchCursor: () => ({ ...mockCursor }),
  worldToScreen: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
} as unknown as CNCViewport
const viewportRef = { current: mockViewport }

const state = () => useCamStore.getState()

function transformOf(container: HTMLElement): string {
  const root = container.querySelector('.sketch-draw-value') as HTMLElement | null
  expect(root).not.toBeNull()
  return root!.style.transform
}

/** One staged corner at `at` (shape mirrors FilletCornerPick). */
function corner(at: { x: number; y: number }) {
  return { aId: 'a', bId: 'b', hintA: { x: at.x - 1, y: at.y }, hintB: { x: at.x, y: at.y + 1 }, at }
}

beforeEach(() => {
  rafQueue.length = 0
  act(() => {
    // Real store path into sketch mode (creates layer + blank doc, sets
    // viewer.mode = 'sketch') then arm the fillet tool (package-owned state).
    state().startNewSketch()
    sketcherToolStore.setState({ tool: 'fillet' })
  })
  act(() => {
    sketcherToolStore.setState({ chain: null, filletRadius: 2 })
  })
})

afterEach(() => {
  cleanup()
  act(() => {
    // Leave no half-open sketch behind for the next test (singleton stores).
    sketcherToolStore.__reset()
    useCamStore.setState({ activeSketch: null })
  })
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('SketchDrawValueInput render smoke (fillet anchoring)', () => {
  it('fillet armed, NO picks yet: mounts clean and follows the cursor', () => {
    const { container } = render(<SketchDrawValueInput port={port} />)
    // Cursor (5,5) -> screen (50,50) -> +14 cursor offset.
    expect(transformOf(container)).toBe('translate(64.0px, 64.0px)')
    // Value = persistent sketchFilletRadius, not a cursor measurement.
    const input = container.querySelector('.sketch-dim-input') as HTMLInputElement
    expect(input.value).toBe('2')
  })

  it('fillet with ONE staged corner: anchors to the corner, not the mouse', () => {
    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', corners: [corner({ x: 10, y: 0 })],
          pendingLineId: null, pendingClick: null,
        },
      })
    })
    const { container } = render(<SketchDrawValueInput port={port} />)
    // Corner (10,0) -> screen (100,0) -> +16 anchored offset. Were it still
    // cursor-pinned this would read translate(64.0px, 64.0px).
    expect(transformOf(container)).toBe('translate(116.0px, 16.0px)')
  })

  it('fillet with only a PENDING first-line click: anchors to that click', () => {
    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', corners: [],
          pendingLineId: 'l1', pendingClick: { x: 3, y: 4 },
        },
      })
    })
    const { container } = render(<SketchDrawValueInput port={port} />)
    // Pending click (3,4) -> screen (30,40) -> +16.
    expect(transformOf(container)).toBe('translate(46.0px, 56.0px)')
  })

  it('staging a SECOND corner does NOT move the anchor: it stays at the FIRST', () => {
    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', corners: [corner({ x: 10, y: 0 })],
          pendingLineId: null, pendingClick: null,
        },
      })
    })
    const { container } = render(<SketchDrawValueInput port={port} />)
    expect(transformOf(container)).toBe('translate(116.0px, 16.0px)')
    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', corners: [corner({ x: 10, y: 0 }), corner({ x: 0, y: 10 })],
          pendingLineId: null, pendingClick: null,
        },
      })
    })
    stepFrame() // tick reads the store per frame -- no remount needed
    // Still the FIRST corner (10,0): were it hopping to the newest staged
    // corner this would read translate(16.0px, 116.0px).
    expect(transformOf(container)).toBe('translate(116.0px, 16.0px)')
  })

  it('unselecting the FIRST corner re-anchors to the next staged corner', () => {
    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', corners: [corner({ x: 10, y: 0 }), corner({ x: 0, y: 10 })],
          pendingLineId: null, pendingClick: null,
        },
      })
    })
    const { container } = render(<SketchDrawValueInput port={port} />)
    expect(transformOf(container)).toBe('translate(116.0px, 16.0px)')
    act(() => {
      // Re-click removed corners[0] (toggle): only the second remains.
      sketcherToolStore.setState({
        chain: {
          kind: 'fillet', corners: [corner({ x: 0, y: 10 })],
          pendingLineId: null, pendingClick: null,
        },
      })
    })
    stepFrame()
    // Anchor moved to the NEW first corner (0,10) -> screen (0,100) -> +16.
    expect(transformOf(container)).toBe('translate(16.0px, 116.0px)')
  })

  it('LINE tool placement is unchanged: still follows the cursor', () => {
    act(() => {
      sketcherToolStore.setState({
        tool: 'line',
        chain: {
          kind: 'line', start: { x: 0, y: 0 },
          firstLineId: null, prev: { x: 0, y: 0 }, prevLineId: null,
        },
      })
    })
    const { container } = render(<SketchDrawValueInput port={port} />)
    // Cursor (5,5) -> screen (50,50) -> +14 (byte-identical to before).
    expect(transformOf(container)).toBe('translate(64.0px, 64.0px)')
    // Live scalar = rubber-band LENGTH from prev (0,0) to cursor (5,5).
    const input = container.querySelector('.sketch-dim-input') as HTMLInputElement
    expect(input.value).toBe('7.071')
  })

  it('keeps a click-focused typed value across the next animation frame', () => {
    const { container } = render(<SketchDrawValueInput port={port} />)
    const input = container.querySelector('.sketch-dim-input') as HTMLInputElement

    fireEvent.pointerDown(input)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12.5' } })
    stepFrame()

    expect(input.value).toBe('12.5')
  })

  it('releases click editing on blur so the live value resumes', () => {
    const { container } = render(<SketchDrawValueInput port={port} />)
    const input = container.querySelector('.sketch-dim-input') as HTMLInputElement

    fireEvent.pointerDown(input)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '12.5' } })
    fireEvent.blur(input)
    act(() => { sketcherToolStore.setState({ filletRadius: 9 }) })
    stepFrame()

    expect(input.value).toBe('9')
  })

  it('keeps type-while-selecting entry protected across animation frames', () => {
    const { container } = render(<SketchDrawValueInput port={port} />)
    const input = container.querySelector('.sketch-dim-input') as HTMLInputElement

    fireEvent.keyDown(window, { key: '7' })
    expect(document.activeElement).toBe(input)
    stepFrame()

    expect(input.value).toBe('7')
  })
})

describe('SKC-45 SketchDrawValueInput chamfer parity', () => {
  it('SKC-45 follow-selection binding: chamfer anchors to the first staged corner and reanchors', () => {
    act(() => {
      sketcherToolStore.setState({
        tool: 'chamfer',
        chamferSetback: 2,
        chain: {
          kind: 'chamfer',
          corners: [corner({ x: 10, y: 0 }), corner({ x: 0, y: 10 })],
          pendingLineId: null,
          pendingClick: null,
        },
      })
    })
    const { container } = render(<SketchDrawValueInput port={port} />)
    expect(transformOf(container)).toBe('translate(116.0px, 16.0px)')

    act(() => {
      sketcherToolStore.setState({
        chain: {
          kind: 'chamfer',
          corners: [corner({ x: 0, y: 10 })],
          pendingLineId: null,
          pendingClick: null,
        },
      })
    })
    stepFrame()
    expect(transformOf(container)).toBe('translate(16.0px, 116.0px)')
  })

  it('SKC-45 typed live update: Enter changes setback without committing geometry', () => {
    act(() => {
      sketcherToolStore.setState({
        tool: 'chamfer',
        chamferSetback: 2,
        chain: {
          kind: 'chamfer',
          corners: [corner({ x: 10, y: 0 })],
          pendingLineId: null,
          pendingClick: null,
        },
      })
    })
    const documentBefore = JSON.stringify(state().activeSketch)
    const { container } = render(<SketchDrawValueInput port={port} />)
    const input = container.querySelector('.sketch-dim-input') as HTMLInputElement
    expect(input.value).toBe('2')

    act(() => {
      fireEvent.change(input, { target: { value: '6' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(sketcherToolStore.getState().chamferSetback).toBe(6)
    expect(sketcherToolStore.getState().chain).toMatchObject({ kind: 'chamfer' })
    expect(JSON.stringify(state().activeSketch)).toBe(documentBefore)
  })
})
