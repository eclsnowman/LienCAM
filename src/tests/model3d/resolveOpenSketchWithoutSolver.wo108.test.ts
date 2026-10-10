// WO-108: a sketch opened before the solver lands must not claim a verdict.
//
// This became reachable in normal use the moment WO-108 stopped gating Ready on
// the constraint solver. Before that, Ready implied the solver, so `wrapper`
// was only ever null for the first frames after mount and nothing real reached
// it. Now the workbench is deliberately usable while the solver is still
// loading -- which is the right trade, and only an honest one if the things
// that depend on the solver say so instead of quietly making something up.
//
// `resolveOpenSketch` is SKC-78's seam: it exists precisely because a persisted
// `solveStatus` cannot be trusted (SKC-77's after-capture -- a document saved
// mid-bug kept showing its stale DoF count until the user's first edit).
// Without a wrapper, `solved()` warns and hands the sketch straight back, so
// the untrusted number sailed through the one function written to distrust it,
// and the chip stated a confident, unverified, wrong DoF.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenSketch } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import type { SketchSessionDeps } from '../../components/model3d/workbench/sketchSessionStore'
import type { SolverAvailability } from '../../components/model3d/workbench/solverAvailability'
import type { Sketch } from '../../lib/sketch/sketcher'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'

/** A sketch carrying a persisted status that has NOT been verified this open. */
function sketchWithPersistedStatus(): Sketch {
  return {
    entities: [
      { kind: 'line', id: 'L1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    ],
    constraints: [],
    dimensions: [],
    solveStatus: { dof: 8, conflicting: [], redundant: [] },
  } as unknown as Sketch
}

function bindDepsWithWrapper(wrapper: unknown, solverStatus?: SolverAvailability): { notices: string[] } {
  const notices: string[] = []
  sketchSessionStore.bindDeps({
    dag: { getNode: () => undefined, has: () => false } as unknown as SketchSessionDeps['dag'],
    history: {} as SketchSessionDeps['history'],
    scheduler: {} as SketchSessionDeps['scheduler'],
    wrapper: wrapper as SketchSessionDeps['wrapper'],
    solverStatus,
    notice: (message: string) => { notices.push(message) },
    onDocumentChanged: () => undefined,
    onHistoryStep: () => undefined,
  } as unknown as SketchSessionDeps)
  return { notices }
}

afterEach(() => {
  sketchSessionStore.bindDeps(null)
  vi.restoreAllMocks()
})

describe('WO-108: opening a sketch without a solver states UNKNOWN, never a stale verdict', () => {
  it('drops the persisted solveStatus while the solver is still LOADING', () => {
    const { notices } = bindDepsWithWrapper(null, 'loading')

    const opened = resolveOpenSketch(sketchWithPersistedStatus(), BASE_PLANE_FRAMES.xy)

    // Null is the UNKNOWN every downstream gate already handles, and the chip
    // renders it as "Solving..." rather than a number nothing verified.
    expect(opened.solveStatus).toBeNull()
    // ...and the user was told, once, by name.
    expect(notices).toContainEqual(expect.stringMatching(/solver is still loading/i))
  })

  // WO-120: AN ASSERTION CORRECTED, AND WHY.
  //
  // This case did not exist, and the one above did not say `'loading'` -- it
  // was written as "the solver has not booted" and asserted the LOADING notice
  // for EVERY null wrapper. That is the defect encoded as an expectation: after
  // the page's bounded recovery is exhausted the wrapper is null FOREVER, so
  // the old assertion demanded that the app go on promising a solver that is
  // never coming. Changing a test to make a verdict go green is normally the
  // exact move that fails a work order here; this is the legitimate case,
  // because the assertion was pinning the bug in place. Nothing was weakened:
  // the loading case still asserts the same string, it just says out loud which
  // state it is describing, and the terminal state now has its own case.
  it('says UNAVAILABLE, not loading, once the solver boot is exhausted', () => {
    const { notices } = bindDepsWithWrapper(null, 'unavailable')

    const opened = resolveOpenSketch(sketchWithPersistedStatus(), BASE_PLANE_FRAMES.xy)

    // Same refusal to publish an unverified verdict...
    expect(opened.solveStatus).toBeNull()
    // ...but the reason given must not promise a later success.
    expect(notices).toContainEqual(expect.stringMatching(/solver is unavailable/i))
    expect(notices.join(' | ')).not.toMatch(/loading/i)
    expect(notices.join(' | ')).not.toMatch(/try again|in a moment/i)
  })

  it('distinguishes NOT STARTED from loading, so a null wrapper never means two things', () => {
    const { notices } = bindDepsWithWrapper(null, 'not-started')

    resolveOpenSketch(sketchWithPersistedStatus(), BASE_PLANE_FRAMES.xy)

    expect(notices).toContainEqual(expect.stringMatching(/has not started/i))
  })

  it('leaves the geometry exactly as drawn while doing it', () => {
    // Refusing a verdict must not become a second, quieter kind of damage.
    bindDepsWithWrapper(null)
    const before = sketchWithPersistedStatus()

    const opened = resolveOpenSketch(before, BASE_PLANE_FRAMES.xy)

    expect(opened.entities).toEqual(before.entities)
    expect(opened.constraints).toEqual(before.constraints)
  })

  it('does not touch a sketch that had no persisted status either way', () => {
    bindDepsWithWrapper(null)
    const blank = { ...sketchWithPersistedStatus(), solveStatus: null } as unknown as Sketch

    expect(resolveOpenSketch(blank, BASE_PLANE_FRAMES.xy).solveStatus).toBeNull()
  })
})
