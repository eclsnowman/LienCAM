// @vitest-environment jsdom
//
// React-render SMOKE test for the on-path text ANCHOR PILL
// (SketchTextAnchorPill, spec T3). This is the HARD UI render gate required
// by docs/CONVENTIONS.md for UI changes -- tsc + pure-logic vitest miss
// hooks-order and JSX-wiring bugs.
//
// WHY THIS EXISTS: the pill is the UI placement gate's poster child --
// NOTHING new at rest. It must render ONLY while an ON-PATH text entity is
// the single selected entity or the open edit target, with the entity's
// pathAlign (absent = F) highlighted, and its buttons must drive the
// id-scoped store actions without moving the glyphs on an F switch.

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

// Sketch solver worker stub: entity patches schedule a solve; echo entities
// straight back (SketchDrawValueInput.smoke pattern).
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

// Deterministic rAF: the pill's positioning tick self-schedules with
// requestAnimationFrame and runs its body once synchronously on mount.
const rafQueue: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  rafQueue.push(cb)
  return rafQueue.length
})
vi.stubGlobal('cancelAnimationFrame', () => {})

const { SketchTextAnchorPill } = await import('../../lib/sketch/sketcher/overlays/SketchTextAnchorPill')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
import type { SketchTextEntity } from '../../lib/sketch/types'

// Viewport bridge mock: world mm -> screen px is a plain x10 scale so the
// expected transform is computable by hand.
const mockViewport = {
  worldToScreen: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
} as unknown as CNCViewport
const viewportRef = { current: mockViewport }

/** Sketch doc: a 100mm horizontal line + a text bound to it (center) + a
 *  FREE text. Injected directly (SketchTextInput.smoke pattern). */
function seedSketch(): void {
  useCamStore.setState({
    viewer: { ...useCamStore.getState().viewer, mode: 'sketch' },
    activeSketch: {
      id: 'sk', layerId: 'L',
      entities: [
        {
          id: 'ln', kind: 'line', construction: false,
          start: { x: 0, y: 0 }, end: { x: 100, y: 0 },
        },
        {
          id: 'tx', kind: 'text', construction: false,
          at: { x: 0, y: 0 }, text: 'HI', height: 6, rotation: 0,
          fontStyle: 'single-line',
          pathId: 'ln', pathOffsetMm: 0, pathFlip: false, pathAlign: 'center',
        },
        {
          id: 'free', kind: 'text', construction: false,
          at: { x: 30, y: 30 }, text: 'FREE', height: 6, rotation: 0,
          fontStyle: 'single-line',
        },
      ],
      constraints: [], dimensions: [], solveStatus: null,
    },
    sketchHistory: [], projectHistory: [], canUndo: false,
    sketchSelectedIds: [], sketchTextEditId: null,
  } as never)
}

const entity = (id: string) =>
  useCamStore.getState().activeSketch!.entities
    .find((e) => e.id === id) as SketchTextEntity

const pillOf = (container: HTMLElement) =>
  container.querySelector('.sketch-text-anchor-pill') as HTMLElement | null

const buttonsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.sketch-text-anchor-pill button'))

beforeEach(() => {
  rafQueue.length = 0
  act(() => seedSketch())
})

afterEach(() => {
  cleanup()
  act(() => {
    useCamStore.setState({
      activeSketch: null, sketchSelectedIds: [], sketchTextEditId: null,
    } as never)
  })
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('SketchTextAnchorPill render smoke (on-path anchor pill)', () => {
  it('on-path text single-selected: pill renders with L C R F + Flip + Mirror, CENTER active', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    const pill = pillOf(container)
    expect(pill).not.toBeNull()
    const btns = buttonsOf(container)
    expect(btns.map((b) => b.textContent)).toEqual(['L', 'C', 'R', 'F', 'Flip', 'Mirror'])
    // Active mode = the ENTITY's pathAlign ('center').
    const active = btns.filter((b) => b.className.includes('sketch-header-toggle-on'))
    expect(active.map((b) => b.textContent)).toEqual(['C'])
  })

  it('ABSENT pathAlign highlights F (legacy pathOffsetMm = free semantics)', () => {
    act(() => {
      const sk = useCamStore.getState().activeSketch!
      useCamStore.setState({
        activeSketch: {
          ...sk,
          entities: sk.entities.map((e) =>
            e.id === 'tx' ? { ...e, pathAlign: undefined } : e),
        },
        sketchSelectedIds: ['tx'],
      } as never)
    })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    const active = buttonsOf(container)
      .filter((b) => b.className.includes('sketch-header-toggle-on'))
    expect(active.map((b) => b.textContent)).toEqual(['F'])
  })

  it('positions at the text\'s resolved on-path midpoint (constant screen gap)', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    // CENTER on a (0,0)-(100,0) line: text midpoint = arc midpoint (50,0)
    // regardless of string advance -> screen (500,0) -> +18px gap below
    // (jsdom offsetWidth = 0, so no half-width shift).
    expect(pillOf(container)!.style.transform).toBe('translate(500.0px, 18.0px)')
  })

  it('FREE text selected: pill absent (nothing new at rest)', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['free'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    expect(pillOf(container)).toBeNull()
  })

  it('multi-select: pill absent even when an on-path text is in the set', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx', 'ln'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    expect(pillOf(container)).toBeNull()
  })

  it('no selection, no edit: pill absent', () => {
    const { container } = render(<SketchTextAnchorPill port={port} />)
    expect(pillOf(container)).toBeNull()
  })

  it('open EDIT target (no selection): pill renders', () => {
    act(() => { useCamStore.setState({ sketchTextEditId: 'tx' } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    expect(pillOf(container)).not.toBeNull()
  })

  it('non-sketch mode: pill absent even with the selection in place', () => {
    act(() => {
      useCamStore.setState({
        viewer: { ...useCamStore.getState().viewer, mode: 'model' },
        sketchSelectedIds: ['tx'],
      } as never)
    })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    expect(pillOf(container)).toBeNull()
  })

  it('clicking L drives setSketchTextPathAlignById (entity.pathAlign -> left)', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    const l = buttonsOf(container).find((b) => b.textContent === 'L')!
    act(() => { fireEvent.click(l) })
    expect(entity('tx').pathAlign).toBe('left')
    // The pill re-renders with the new active mode.
    const active = buttonsOf(container)
      .filter((b) => b.className.includes('sketch-header-toggle-on'))
    expect(active.map((b) => b.textContent)).toEqual(['L'])
  })

  it('clicking F keeps the resolved position (F-keeps-position semantics)', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    const f = buttonsOf(container).find((b) => b.textContent === 'F')!
    act(() => { fireEvent.click(f) })
    const e = entity('tx')
    expect(e.pathAlign).toBe('free')
    // CENTER on a 100mm path resolved to 50 - advance/2; the stored free
    // offset must be that same value (glyphs did not move), i.e. < mid and
    // finite -- the exact advance is font data, not this test's business.
    expect(Number.isFinite(e.pathOffsetMm)).toBe(true)
    expect(e.pathOffsetMm!).toBeGreaterThan(0)
    expect(e.pathOffsetMm!).toBeLessThan(50)
  })

  it('clicking Flip drives setSketchTextPathFlipById (entity.pathFlip toggles)', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    const flip = buttonsOf(container).find((b) => b.textContent === 'Flip')!
    expect(flip.getAttribute('aria-pressed')).toBe('false')
    act(() => { fireEvent.click(flip) })
    expect(entity('tx').pathFlip).toBe(true)
    expect(
      buttonsOf(container).find((b) => b.textContent === 'Flip')!
        .getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('clicking Mirror drives setSketchTextMirrorById (entity.mirrored toggles; flip-side untouched)', () => {
    act(() => { useCamStore.setState({ sketchSelectedIds: ['tx'] } as never) })
    const { container } = render(<SketchTextAnchorPill port={port} />)
    const mirror = buttonsOf(container).find((b) => b.textContent === 'Mirror')!
    // ABSENT mirrored = false = legacy.
    expect(mirror.getAttribute('aria-pressed')).toBe('false')
    act(() => { fireEvent.click(mirror) })
    expect(entity('tx').mirrored).toBe(true)
    // Independent controls (spec T5): mirroring never touches flip-side.
    expect(entity('tx').pathFlip).toBe(false)
    expect(
      buttonsOf(container).find((b) => b.textContent === 'Mirror')!
        .getAttribute('aria-pressed'),
    ).toBe('true')
    // And back off.
    act(() => { fireEvent.click(buttonsOf(container).find((b) => b.textContent === 'Mirror')!) })
    expect(entity('tx').mirrored).toBe(false)
  })
})
