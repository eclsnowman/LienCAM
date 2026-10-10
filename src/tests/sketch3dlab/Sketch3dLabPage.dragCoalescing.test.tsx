// @vitest-environment jsdom
//
// SKC-H2 criterion 2: rAF-coalesced drag. Sketch3dLabPage.tsx's flushDragFrame is the ONLY
// place that calls Sketch3dDragSession.move() during a drag; handlePointerMove just overwrites
// a single pending-cursor slot. This proves: N pointermoves landing inside ONE (not-yet-fired)
// animation frame collapse to exactly one solve+redraw, and the redraw reflects the LAST queued
// cursor (latest-cursor-wins), not an intermediate one.
//
// Deterministic rAF queue instead of a real timer-driven frame (this repo's own convention -
// see src/tests/components/SketchDrawValueInput.smoke.test.tsx) so "N moves inside one frame"
// is exact, never a timing race against jsdom's real requestAnimationFrame.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { Sketch3dLabPage } from '../../components/sketch3dlab/Sketch3dLabPage'
import { worldToScreen } from '../../components/sketch3dlab/geometry2d'
import { createSketch3dSolveService } from '../../sketch3d'
import type { Sketch3dLineEntity, Sketch3dSolveService, Sketch3dVec2 } from '../../sketch3d'

afterEach(cleanup)

const rafQueue: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  rafQueue.push(cb)
  return rafQueue.length
})
vi.stubGlobal('cancelAnimationFrame', () => {
  rafQueue.length = 0
})
function stepFrame(): void {
  const cb = rafQueue.shift()
  if (cb) act(() => { cb(performance.now()) })
}

// Wraps the REAL planegcs solve service (same convention every other sketch3dlab test uses -
// no fakes) so this test can count actual solve() calls without touching production code.
function countingSolveService(counter: { count: number }): () => Promise<Sketch3dSolveService> {
  return async () => {
    const real = await createSketch3dSolveService()
    return {
      solve: (...args: Parameters<Sketch3dSolveService['solve']>) => {
        counter.count++
        return real.solve(...args)
      },
      dispose: () => real.dispose(),
    } as unknown as Sketch3dSolveService
  }
}

// Wraps the REAL planegcs solve service exactly like countingSolveService above, but also
// busy-waits costMs of REAL wall-clock time after every solve() call. Sketch3dLabPage never
// passes a `now` option to `new Sketch3dDragSession(...)`, so the session measures solveMs
// against the real, unmocked performance.now() - this is the "clock seam" the fix must survive:
// a genuinely slow solve, not a simulated one, so session.throttled flips true for real and
// move() takes its real coalesced-return path (src/sketch3d/dragSession.ts:154-160).
function slowSolveService(costMs: number): () => Promise<Sketch3dSolveService> {
  return async () => {
    const real = await createSketch3dSolveService()
    return {
      solve: (...args: Parameters<Sketch3dSolveService['solve']>) => {
        const result = real.solve(...args)
        const until = performance.now() + costMs
        while (performance.now() < until) {
          // deliberate busy-wait: forces this solve's measured wall-clock duration past
          // SKETCH3D_DRAG_FRAME_BUDGET_MS (16ms), deterministically (not a timing race).
        }
        return result
      },
      dispose: () => real.dispose(),
    } as unknown as Sketch3dSolveService
  }
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('sketch3dlab-status').textContent).toBe('ready'), { timeout: 15_000 })
}

function click(world: Sketch3dVec2): void {
  const canvas = screen.getByTestId('sketch3dlab-canvas')
  const { x, y } = worldToScreen(world)
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y })
}

function move(world: Sketch3dVec2): void {
  const canvas = screen.getByTestId('sketch3dlab-canvas')
  const { x, y } = worldToScreen(world)
  fireEvent.pointerMove(canvas, { clientX: x, clientY: y })
}

function useTool(tool: 'select' | 'line' | 'circle' | 'arc' | 'drag'): void {
  fireEvent.click(screen.getByTestId(`sketch3dlab-tool-${tool}`))
}

function currentLineEnd(): Sketch3dVec2 {
  const doc = window.__sketch3dlabTestHooks!.getDocument()
  const line = doc.entities.find((e) => e.id === 'line1') as Sketch3dLineEntity | undefined
  if (!line) throw new Error('expected line1 to exist')
  return line.end
}

describe('Sketch3dLabPage drag tool: rAF-coalesced pointermoves (criterion 2)', () => {
  it('N pointermoves inside one animation frame collapse to exactly one solve, and the FINAL cursor wins', async () => {
    rafQueue.length = 0
    const counter = { count: 0 }
    render(<Sketch3dLabPage createSolveService={countingSolveService(counter)} />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))

    useTool('drag')
    click({ x: 10, y: 0 }) // pointerDown -> begin(): one immediate solve
    const solvesAfterBegin = counter.count
    expect(solvesAfterBegin).toBeGreaterThan(0)

    // 3 pointermoves land inside the SAME (not-yet-fired) animation frame.
    move({ x: 10, y: 2 })
    move({ x: 10, y: 4 })
    move({ x: 10, y: 6 }) // final cursor
    expect(counter.count).toBe(solvesAfterBegin) // none of these 3 moves solved inline
    expect(rafQueue.length).toBe(1) // coalesced to a single scheduled frame, not 3

    stepFrame()
    expect(counter.count).toBe(solvesAfterBegin + 1) // exactly one solve flushed all 3 moves
    expect(currentLineEnd().y).toBeCloseTo(6, 3) // latest-cursor-wins, not 2 or 4

    fireEvent.pointerUp(screen.getByTestId('sketch3dlab-canvas'))
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-dof-chip').textContent).not.toBe('solving...'))
  })

  it('a slow solve (spanning multiple frames) still collapses every move queued in between to the latest cursor on the next flush', async () => {
    rafQueue.length = 0
    const counter = { count: 0 }
    render(<Sketch3dLabPage createSolveService={countingSolveService(counter)} />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))

    useTool('drag')
    click({ x: 10, y: 0 })
    const solvesAfterBegin = counter.count

    move({ x: 10, y: 1 })
    stepFrame() // frame 1: flushes {10,1} - one solve
    expect(counter.count).toBe(solvesAfterBegin + 1)

    // Before frame 2 fires, several moves arrive - as would happen if frame 1's solve had
    // blocked the main thread past its budget. Only the LAST one should ever reach the solver.
    move({ x: 10, y: 3 })
    move({ x: 10, y: 5 })
    move({ x: 10, y: 7 })
    expect(counter.count).toBe(solvesAfterBegin + 1) // still just the frame-1 solve
    stepFrame() // frame 2: flushes {10,7} only
    expect(counter.count).toBe(solvesAfterBegin + 2) // exactly one more solve, not three
    expect(currentLineEnd().y).toBeCloseTo(7, 3)

    fireEvent.pointerUp(screen.getByTestId('sketch3dlab-canvas'))
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-dof-chip').textContent).not.toBe('solving...'))
  })

  it('existing drag behavior is unchanged: pointerUp immediately after one move (no frame stepped) still commits the final position', async () => {
    rafQueue.length = 0
    render(<Sketch3dLabPage />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))

    useTool('drag')
    click({ x: 10, y: 0 })
    move({ x: 10, y: 6 })
    // No stepFrame() here - matches Sketch3dLabPage.test.tsx's pre-existing drag test, which
    // releases the pointer before any animation frame would naturally fire.
    fireEvent.pointerUp(screen.getByTestId('sketch3dlab-canvas'))

    await waitFor(() => expect(screen.getByTestId('sketch3dlab-dof-chip').textContent).not.toBe('solving...'))
    expect(currentLineEnd().y).toBeCloseTo(6, 3)
  })

  it('SKC-H2-R1 (audit fix): pointerUp must not drop the released cursor when the session is throttled by a prior slow solve', async () => {
    rafQueue.length = 0
    // 25ms > SKETCH3D_DRAG_FRAME_BUDGET_MS (16ms) - every solve() call in this test genuinely
    // takes longer than the frame budget, so begin()'s own solve throttles the session.
    render(<Sketch3dLabPage createSolveService={slowSolveService(25)} />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))

    useTool('drag')
    click({ x: 10, y: 0 }) // pointerDown -> begin(): its slow solve leaves session.throttled = true

    // pointerUp lands before this move's animation frame ever fires - matching the audit's
    // repro exactly (a still-queued pendingDragCursorRef flushed synchronously by pointerUp).
    move({ x: 10, y: 9 })
    expect(rafQueue.length).toBe(1)

    fireEvent.pointerUp(screen.getByTestId('sketch3dlab-canvas'))
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-dof-chip').textContent).not.toBe('solving...'))

    // The released cursor (y: 9) must be committed - not the pre-drag position (y: 0) that a
    // throttled session.move()'s coalesced (unsolved) result would otherwise leave behind.
    expect(currentLineEnd().y).toBeCloseTo(9, 3)
  })

  it('SKC-H2-R2 (audit fix): frame-before-pointerUp - a coalesced flushDragFrame must not drop the released cursor', async () => {
    rafQueue.length = 0
    // 25ms > SKETCH3D_DRAG_FRAME_BUDGET_MS (16ms) - every solve() call genuinely takes longer
    // than the frame budget, so begin()'s own solve throttles the session for the move below.
    render(<Sketch3dLabPage createSolveService={slowSolveService(25)} />)
    await ready()

    useTool('line')
    click({ x: 0, y: 0 })
    click({ x: 10, y: 0 })
    await waitFor(() => expect(Number(screen.getByTestId('sketch3dlab-entity-count').textContent)).toBe(1))

    useTool('drag')
    click({ x: 10, y: 0 }) // pointerDown -> begin(): its slow solve leaves session.throttled = true

    move({ x: 10, y: 9 }) // queued in pendingDragCursorRef, one frame scheduled
    expect(rafQueue.length).toBe(1)

    // The animation frame fires BEFORE pointerUp - flushDragFrame's session.move(9) comes back
    // coalesced (session still throttled from begin()'s slow solve) and clears
    // pendingDragCursorRef to null as part of the same call, exactly the ordering the round-2
    // audit exhibited: "a later pointerUp sees pendingDragCursorRef already null and goes
    // straight to session.end()".
    stepFrame()

    // pointerUp now finds nothing queued in pendingDragCursorRef (already cleared by the frame
    // above) - this must NOT mean the y:9 cursor was silently dropped.
    fireEvent.pointerUp(screen.getByTestId('sketch3dlab-canvas'))
    await waitFor(() => expect(screen.getByTestId('sketch3dlab-dof-chip').textContent).not.toBe('solving...'))

    expect(currentLineEnd().y).toBeCloseTo(9, 3)
  })
})
