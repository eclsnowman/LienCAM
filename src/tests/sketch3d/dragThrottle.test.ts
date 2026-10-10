import { afterEach, describe, expect, it } from 'vitest'
import { Sketch3dDragSession, createSketch3dSolveService } from '../../sketch3d'
import type { Sketch3dSolveService, Sketch3dSolveOptions } from '../../sketch3d'
import type { Sketch3dDocument } from '../../sketch3d'
import { chainDragFixture } from './dragFixtures'

const openServices: Sketch3dSolveService[] = []

afterEach(() => {
  while (openServices.length > 0) openServices.pop()?.dispose()
})

async function solver(): Promise<Sketch3dSolveService> {
  const service = await createSketch3dSolveService()
  openServices.push(service)
  return service
}

// Deterministic clock + a "slow solve" stub: rather than really sleeping (which would make
// this test slow and machine-dependent), the mock solve runs the REAL solve for correctness
// then charges a fixed cost onto a shared mutable clock, so the session's frame-budget
// measurement (`now() - start`) sees a realistic elapsed duration without any real delay.
function installSlowSolve(service: Sketch3dSolveService, costMs: number): { now: () => number } {
  let clock = 0
  const realSolve = service.solve.bind(service)
  service.solve = (document: Sketch3dDocument, options?: Sketch3dSolveOptions) => {
    const result = realSolve(document, options)
    clock += costMs
    return result
  }
  return { now: () => clock }
}

describe('sketch3d drag scheduler throttle/coalesce policy (criterion 4)', () => {
  it('coalesces a 1000-move burst behind a single slow solve into bounded pending depth, and consumes only the newest cursor on flush', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(10)
    const { now } = installSlowSolve(service, 30) // 30ms > 16ms frame budget

    const session = new Sketch3dDragSession(service, document, { now, frameBudgetMs: 16 })
    const begun = session.begin(dragPoint, { x: 1, y: 1 })
    expect(begun.coalesced).toBe(false)
    expect(begun.solveMs).toBe(30)
    expect(session.solveCount).toBe(1)

    const BURST = 1000
    let maxPendingDepth = 0
    for (let i = 0; i < BURST; i++) {
      const result = session.move({ x: i, y: i * 0.1 })
      expect(result.coalesced).toBe(true)
      expect(result.solveMs).toBeNull()
      maxPendingDepth = Math.max(maxPendingDepth, session.pendingDepth)
    }

    // the whole burst was coalesced into a single pending slot - never a growing queue
    expect(maxPendingDepth).toBe(1)
    expect(session.pendingDepth).toBe(1)
    expect(session.coalescedCount).toBe(BURST)
    expect(session.solveCount).toBe(1) // still just the one solve from begin()

    const flushed = session.tick()
    expect(flushed).not.toBeNull()
    expect(flushed?.coalesced).toBe(false)
    expect(session.solveCount).toBe(2)
    expect(session.pendingDepth).toBe(0)

    // the flush consumed the newest cursor (x: 999, y: 99.9), not any intermediate one
    const draggedLine = flushed?.entities.find((entity) => entity.id === `cl${9}`)
    expect(draggedLine?.kind).toBe('line')
    if (draggedLine?.kind === 'line') {
      expect(draggedLine.end.x).toBeCloseTo(999, 6)
      expect(draggedLine.end.y).toBeCloseTo(99.9, 6)
    }

    // a second tick with nothing pending is a no-op, not another solve
    expect(session.tick()).toBeNull()
    expect(session.solveCount).toBe(2)

    session.end()
  })

  it('solves every move directly (no coalescing) once solves are back within budget', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(10)
    const { now } = installSlowSolve(service, 2) // well under the 16ms budget

    const session = new Sketch3dDragSession(service, document, { now, frameBudgetMs: 16 })
    session.begin(dragPoint, { x: 1, y: 1 })
    for (let i = 0; i < 50; i++) {
      const result = session.move({ x: i, y: i })
      expect(result.coalesced).toBe(false)
    }
    expect(session.solveCount).toBe(51)
    expect(session.coalescedCount).toBe(0)
    session.end()
  })

  it('recovers from throttled to direct-solve once a slow patch of solves passes', async () => {
    const service = await solver()
    const { document, dragPoint } = chainDragFixture(10)
    let costMs = 30
    let clock = 0
    const realSolve = service.solve.bind(service)
    service.solve = (doc: Sketch3dDocument, opts?: Sketch3dSolveOptions) => {
      const result = realSolve(doc, opts)
      clock += costMs
      return result
    }
    const now = () => clock

    const session = new Sketch3dDragSession(service, document, { now, frameBudgetMs: 16 })
    session.begin(dragPoint, { x: 1, y: 1 }) // slow -> throttled
    expect(session.move({ x: 2, y: 2 }).coalesced).toBe(true) // coalesced while throttled

    costMs = 2 // simulate the load spike passing
    const flushed = session.tick() // flush the pending cursor; this solve is fast -> recovers
    expect(flushed?.coalesced).toBe(false)

    const direct = session.move({ x: 3, y: 3 })
    expect(direct.coalesced).toBe(false) // no longer throttled

    session.end()
  })
})
