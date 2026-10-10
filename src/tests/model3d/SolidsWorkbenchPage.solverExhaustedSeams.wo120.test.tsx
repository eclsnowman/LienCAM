// @vitest-environment jsdom
//
// WO-120: A SOLVER THAT HAS FAILED MUST NEVER REPORT ITSELF AS STILL LOADING.
//
// WO-108 stopped gating Ready on the constraint solver and gave the status
// strip an honest third state ('sketch solver unavailable'). It left the two
// ACTION seams behind, and its own audit named the gap precisely:
//
//   bootConstraintSolverWithRecovery() leaves gcsWrapperRef.current null and
//   sets only local React state to 'unavailable'. The two action seams cannot
//   see that state: workbenchSketchDocumentPort.solved() says "The sketch
//   solver is still loading", and workbenchOverlaysPort.applyWithVerdict()
//   says "Try again in a moment", whenever the wrapper is null. Those messages
//   remain forever after exhaustion.
//
// A null wrapper meant two different things -- "not ready YET" and "never will
// be" -- and the seams could not tell them apart, so they guessed the
// optimistic one. That is Operator's original defect one layer down: the screen
// says a thing is coming that is never coming.
//
// THIS TEST DRIVES REAL EXHAUSTION. Nothing here fakes the solver state: the
// page is rendered with a solve service that rejects the way a dead wasm asset
// does, the REAL bounded recovery loop runs all three attempts, and the test
// waits for the strip's own 'unavailable' disclosure before it touches
// anything. Then it exercises both action seams through the UI a user actually
// clicks -- the line tool (document port -> solved()) and a constraint button
// (overlays port -> applyWithVerdict()) -- and reads what the user actually
// sees: the BottomConsole strip.
//
// The assertions are deliberately about WORDS, not about internal state. The
// defect was never a wrong variable; it was a sentence that was not true.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import type { Sketch3dSolveService } from '../../sketch3d/solveService'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import { stubCanvas2d } from './stubCanvas2d'
import { workbenchSketchDocumentPort } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

/** Structurally identical to production -- a real deadline, a real backoff, a
 *  real elapsed tick -- only fast enough for a unit test. Same shape
 *  SolidsWorkbenchPage.solverIndependence.wo108.test.tsx uses. */
const FAST_POLICY = {
  timeoutMs: 200,
  maxAttempts: 3,
  backoffMs: [1, 1],
  statusTickAfterMs: 20,
  statusTickEveryMs: 5,
} as const

const SKETCH_NODE = 'sketch3d:SK1'
const CENTRE = { x: 400, y: 300 }

/** A solver boot that rejects the way a dead asset does: in milliseconds, every
 *  time. Three of these exhausts the budget. */
function alwaysFailingSolveService(): () => Promise<Sketch3dSolveService> {
  return async (): Promise<Sketch3dSolveService> => {
    throw new Error('planegcs wasm module load failed (test)')
  }
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function pointer(type: string, at: { x: number; y: number }): void {
  canvas().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0 }))
}

/** Wrapped in act() because these are RAW canvas events, not fireEvent -- React
 *  batches the notice's state update otherwise and the console strip below
 *  would still be showing the PREVIOUS event when the assertion reads it. */
function click(at: { x: number; y: number }): void {
  act(() => {
    pointer('pointerdown', at)
    pointer('pointerup', at)
  })
}

function tool(id: 'select' | 'line'): void {
  fireEvent.click(screen.getByTestId(`workbench-package-tool-${id}`))
}

/** What the user actually reads: the BottomConsole's latest-event strip. */
function consoleStripText(): string {
  return screen.getByTestId('console-strip').textContent ?? ''
}

function payloadSketch(nodeId = SKETCH_NODE): CamSketch {
  const node = hooks().dag.getNode(nodeId)
  if (node === undefined) throw new Error(`test: node '${nodeId}' not found`)
  const sketch = node.payload.sketch as CamSketch | undefined
  if (sketch === undefined) throw new Error(`test: node '${nodeId}' has no CAM sketch payload`)
  return sketch
}

function sessionOpen(): boolean {
  return screen.queryByTestId('workbench-package-sketch-toolbar') !== null
}

function solverStripText(): string | null {
  return screen.queryByTestId('solids-workbench-solver-state')?.textContent ?? null
}

/**
 * Boot the real page with a solver that cannot load, run the REAL recovery loop
 * to exhaustion, then open a sketch session on XY.
 *
 * Every wait below is on a thing the page publishes for itself -- Ready, then
 * the strip's terminal 'unavailable' disclosure. Nothing is stubbed into
 * `solverState`; if the recovery loop stopped exhausting, this harness would
 * time out rather than silently prove nothing.
 */
async function bootWithExhaustedSolver(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(
    <SolidsWorkbenchPage
      createClient={createFakeGeomClient}
      createSceneRuntime={captureSceneRuntime}
      createSolveService={alwaysFailingSolveService()}
      geometryBootPolicy={FAST_POLICY}
    />,
  )
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    { timeout: 20_000 },
  )
  // TERMINAL, not transient: the strip only says this once all three attempts
  // are spent (WO-108's own disclosure). Everything after this line is about a
  // solver that is never coming back.
  await waitFor(
    () => expect(solverStripText()).toMatch(/unavailable/i),
    { timeout: 20_000 },
  )

  const runtime = captured as unknown as FakeSceneRuntime
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100)
  cam.up.set(0, 1, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(sessionOpen()).toBe(true))
  return runtime
}

/** The two forbidden claims, as the user would read them. Both are TRUE
 *  sentences while the solver is still booting and FALSE ones forever after it
 *  has failed -- which is the whole of this WO. */
function expectNoFalseHope(where: string, said: string): void {
  expect(said, `${where}: must not claim the solver is still loading`).not.toMatch(/still loading/i)
  expect(said, `${where}: must not claim loading at all`).not.toMatch(/loading/i)
  expect(said, `${where}: must not invite a retry that cannot work`).not.toMatch(/try again/i)
  expect(said, `${where}: must not invite a retry that cannot work`).not.toMatch(/in a moment/i)
}

describe('WO-120: after the solver is exhausted, every seam says UNAVAILABLE', () => {
  it('the DOCUMENT seam (drawing geometry) names terminal unavailability, not loading', async () => {
    await bootWithExhaustedSolver()

    // Draw a line through the real tool. This lands on
    // workbenchSketchDocumentPort.append -> solved(), the first action seam.
    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })

    // The geometry is kept exactly as drawn -- refusing a verdict must never
    // become a second, quieter kind of damage.
    expect(payloadSketch().entities.filter((e) => e.kind === 'line')).toHaveLength(1)

    const said = consoleStripText()
    expectNoFalseHope('document seam', said)
    expect(said, 'document seam: must name the solver as unavailable').toMatch(/solver is unavailable/i)
  }, 60_000)

  it('the CONSTRAINT seam (applying a constraint) names terminal unavailability, not "try again in a moment"', async () => {
    await bootWithExhaustedSolver()

    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })
    const lineId = payloadSketch().entities.find((e) => e.kind === 'line')?.id
    if (lineId === undefined) throw new Error('test: expected a drawn line entity')

    act(() => { workbenchSketchDocumentPort.setSelection([lineId]) })
    // The real button a user clicks; its onClick is
    // workbenchOverlaysPort.applyConstraint -> applyWithVerdict(), the second
    // action seam.
    fireEvent.click(screen.getByTestId('workbench-package-constraint-fix'))

    const said = consoleStripText()
    expectNoFalseHope('constraint seam', said)
    expect(said, 'constraint seam: must name the solver as unavailable').toMatch(/solver is unavailable/i)
    // Refused, not committed unverified: an unverified constraint can silently
    // over-constrain a document with nothing on screen to show it.
    expect(payloadSketch().constraints.filter((c) => c.kind === 'fix')).toHaveLength(0)
  }, 60_000)

  it('the STRIP and the SEAMS agree -- one solver state, said the same way in both places', async () => {
    await bootWithExhaustedSolver()

    // WO-108 already got the strip right; the bug was that the strip and the
    // seams read DIFFERENT sources for the same fact (React state vs a null
    // wrapper). This pins them together: if a future change fixes one and not
    // the other, the two halves of this assertion diverge.
    expect(solverStripText()).toMatch(/unavailable/i)

    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })

    expect(consoleStripText()).toMatch(/unavailable/i)
  }, 60_000)
})
