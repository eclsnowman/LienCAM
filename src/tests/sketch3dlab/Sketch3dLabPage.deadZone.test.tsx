// @vitest-environment jsdom
//
// SKC-H3 (SKC-H1 audit F1, MAJOR): the lab's interactive <canvas> used to carry FIXED
// width=760/height=620 attributes regardless of its wrapper's real size, leaving ~50% of the
// visually-identical dark sketch region at a 1400x900 viewport silently non-interactive (bare
// root background outside the fixed backing store). The fix wires a ResizeObserver on the
// wrapper (Sketch3dLabPage.tsx) that sets canvas.width/height to the wrapper's observed content
// box, with CSS width/height 100% so a real browser's rendered box tracks that same size.
//
// jsdom (this repo's test environment, v29) implements no ResizeObserver global at all and has
// no layout engine (getBoundingClientRect always returns a zero rect, and it doesn't even
// implement document.elementFromPoint - see Sketch3dLabPage.overlayHitTarget.test.tsx's header
// comment for the prior precedent). So this file cannot literally reproduce a browser's native
// "which element is under this pixel" hit-test; instead, exactly like the overlay fix, it proves
// the STRUCTURAL declaration that makes the real-browser behavior correct:
//   1. the canvas's backing store (width/height attributes) tracks an observed container size
//      instead of staying pinned at the old 760x620 constant - a FakeResizeObserver below stands
//      in for the real one jsdom lacks. This assertion FAILS against the pre-WO code (which
//      never looked at any observer - a bare `width={760} height={620}` JSX attribute) and
//      PASSES post-WO.
//   2. the canvas's CSS size is 100%/100% of its wrapper, not a fixed pixel box.
//   3. clicking/drawing at SCREEN coordinates outside the old fixed 760x620 box - including the
//      SKC-H1 audit's own example ~(900,700) at a 1400x900 viewport - still creates entities at
//      all four corners of a larger simulated region, and after a mid-sketch resize.
// Full native pixel-level proof (a real Chromium hit-test landing on the canvas, not the root
// background, at a screen coordinate beyond the old box) is tools/diag/skc-h1-measure.mjs's job -
// same division of labor the SKC-H2 overlay fix used (see that file's header comment).
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Sketch3dLabPage } from '../../components/sketch3dlab/Sketch3dLabPage'
import { worldToScreen } from '../../components/sketch3dlab/geometry2d'

// Stands in for the real (browser-only) ResizeObserver jsdom doesn't implement, so the
// production sizing effect (`typeof ResizeObserver === 'undefined'` guard in
// Sketch3dLabPage.tsx) actually runs under test instead of silently no-opping. Delivers a
// same-tick initial callback on observe() (matching a real ResizeObserver's own behavior) using
// whatever rect is queued via `FakeResizeObserver.queue(...)` before render, and exposes
// `resizeAll(...)` to simulate a later window resize mid-sketch.
class FakeResizeObserver {
  private static queuedRect: { width: number; height: number } | null = null
  private static instances: FakeResizeObserver[] = []
  private target: Element | null = null
  private callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  static queue(width: number, height: number): void {
    FakeResizeObserver.queuedRect = { width, height }
  }

  static reset(): void {
    FakeResizeObserver.queuedRect = null
    FakeResizeObserver.instances = []
  }

  static resizeAll(width: number, height: number): void {
    for (const instance of FakeResizeObserver.instances) instance.deliver(width, height)
  }

  observe(target: Element): void {
    this.target = target
    if (FakeResizeObserver.queuedRect) {
      this.deliver(FakeResizeObserver.queuedRect.width, FakeResizeObserver.queuedRect.height)
    }
  }

  unobserve(): void {}

  disconnect(): void {
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter((i) => i !== this)
  }

  private deliver(width: number, height: number): void {
    const entry = {
      target: this.target,
      contentRect: { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) },
    } as ResizeObserverEntry
    this.callback([entry], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  FakeResizeObserver.reset()
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sketch3dlab-status').textContent).toBe('ready'), { timeout: 15_000 })
}

function canvasEl(): HTMLCanvasElement {
  return screen.getByTestId('sketch3dlab-canvas') as HTMLCanvasElement
}

function clickScreen(x: number, y: number): void {
  fireEvent.pointerDown(canvasEl(), { clientX: x, clientY: y })
}

function entityCount(): number {
  return Number(screen.getByTestId('sketch3dlab-entity-count').textContent)
}

describe('Sketch3dLabPage canvas sizing (SKC-H3 criterion 1: kills the fixed-760x620 dead zone)', () => {
  it('FAILING-FIRST: canvas backing store tracks an observed 1079x900 container instead of staying pinned at 760x620', async () => {
    FakeResizeObserver.queue(1079, 900)
    render(<Sketch3dLabPage />)
    await ready()

    // Pre-WO this was a hardcoded width={760} height={620} JSX attribute with no observer wired
    // at all, so it would read 760/620 here regardless of what any container reports.
    expect(canvasEl().width).toBe(1079)
    expect(canvasEl().height).toBe(900)
  })

  it('canvas CSS size is 100%/100% of its wrapper, not a fixed pixel box (what makes inset:0 actually fill it)', async () => {
    render(<Sketch3dLabPage />)
    await ready()
    expect(canvasEl().style.width).toBe('100%')
    expect(canvasEl().style.height).toBe('100%')
  })

  it('with no ResizeObserver available (simulated here only), canvasSize falls back to the pre-WO 760x620 default - no regression for every other sketch3dlab test file', async () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    render(<Sketch3dLabPage />)
    await ready()
    expect(canvasEl().width).toBe(760)
    expect(canvasEl().height).toBe(620)
  })
})

describe('Sketch3dLabPage canvas sizing (SKC-H3 criterion 2: full-region coverage at all four corners)', () => {
  it('drawing at all four corners of a simulated 1079x900 region creates 4 entities via the same world<->screen transform', async () => {
    FakeResizeObserver.queue(1079, 900)
    render(<Sketch3dLabPage />)
    await ready()
    fireEvent.click(screen.getByTestId('sketch3dlab-tool-line'))

    // Four corner-ish pairs of SCREEN coordinates (as a real browser pointer event would report
    // them), each pair drawing one line entity. Every point here falls OUTSIDE the old fixed
    // 760x620 box (900+ in x, or 700-880 in y) - the fourth pair is the SKC-H1 audit's own
    // example dead-zone point, screen ~(900,700) at a 1400x900 viewport.
    const cornerPairs: Array<[[number, number], [number, number]]> = [
      [[10, 10], [30, 30]],
      [[1060, 10], [1040, 30]],
      [[10, 880], [30, 860]],
      [[900, 700], [1060, 880]],
    ]
    for (const [a, b] of cornerPairs) {
      clickScreen(a[0], a[1])
      clickScreen(b[0], b[1])
    }
    await waitFor(() => expect(entityCount()).toBe(4))
  })
})

describe('Sketch3dLabPage canvas sizing (SKC-H3 criterion 3: resize mid-sketch)', () => {
  it('existing entities keep their world position and the newly-added region becomes interactive after a resize', async () => {
    FakeResizeObserver.queue(760, 620)
    render(<Sketch3dLabPage />)
    await ready()

    fireEvent.click(screen.getByTestId('sketch3dlab-tool-line'))
    const p1 = worldToScreen({ x: 1, y: 1 })
    const p2 = worldToScreen({ x: 8, y: 5 })
    clickScreen(p1.x, p1.y)
    clickScreen(p2.x, p2.y)
    await waitFor(() => expect(entityCount()).toBe(1))

    const beforeEntity = window.__sketch3dlabTestHooks!.getDocument().entities[0]

    act(() => {
      FakeResizeObserver.resizeAll(1079, 900)
    })
    await waitFor(() => expect(canvasEl().width).toBe(1079))
    expect(canvasEl().height).toBe(900)

    const afterEntity = window.__sketch3dlabTestHooks!.getDocument().entities[0]
    expect(afterEntity).toEqual(beforeEntity)

    // Newly-interactive region (screen (900,700), outside the old 760x620 box pre-resize) now
    // creates a second entity.
    fireEvent.click(screen.getByTestId('sketch3dlab-tool-line'))
    clickScreen(900, 700)
    clickScreen(1000, 750)
    await waitFor(() => expect(entityCount()).toBe(2))
  })
})
