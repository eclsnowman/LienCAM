// @vitest-environment jsdom
//
// WO UI-79 F-A (Operator verdict T-UI57-PUSHPULL, finding F-A): push/pull release
// semantics must match the SKC-44 fillet-drag standard EXACTLY. Drives the REAL
// SolidsWorkbenchPage against the REAL in-process kernel through its actual
// affordances -- the Push/Pull toolbar toggle, a canvas pick, the gizmo's
// pointer seam (via createPushPullTestDriver, the same jsdom-safe seam
// SolidsWorkbenchPage.pushPull.test.tsx uses), and the REAL shared
// AnchoredValueEntry (its typed input + two-stage Enter). Asserts, on that real
// path, each of the four F-A steps plus Escape-cancel, plus the can-fail
// regression that RELEASE does not commit:
//
//   1. Drag a face; RELEASE stops the drag -- the tool stays ARMED with the
//      live value shown. No commit on release.
//   2. Typing edits the value live.
//   3. First Enter APPLIES the typed value (geometry previews; tool still armed).
//   4. Second Enter COMPLETES the tool (mints the UI-80 first-class pushPull node).
//
// The release-vs-complete behaviour of the gizmo itself is also proven at the
// unit level in PushPullGizmo.test.tsx; this file proves the END-TO-END wiring
// through the page's own listeners and the shared entry.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** CommandHistory exposes only canUndo()/canRedo(); measure depth by fully
 *  unwinding then replaying (undo/redo are exact inverses), leaving history as
 *  found -- the same technique SolidsWorkbenchPage.pushPull.test.tsx uses. */
function historyDepth(h: SolidsWorkbenchHooks): number {
  let depth = 0
  while (h.history.canUndo()) { h.history.undo(); depth++ }
  for (let i = 0; i < depth; i++) h.history.redo()
  return depth
}

interface ArmedPushPull {
  runtime: () => FakeSceneRuntime
  driver: () => PushPullGizmoTestDriver
  entryInput: () => HTMLInputElement
}

/** Build a 40x20x12 box, arm Push/Pull, pick the top face (normal +Z, z=12),
 *  and leave the gizmo mounted with its anchored entry rendered. Mirrors
 *  pushPull.test.tsx's renderBoxArmPick, but keeps the RAW driver (this file
 *  drives the real Apply/Enter itself instead of a commit-on-release shim). */
async function renderBoxArmPick(): Promise<ArmedPushPull> {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    runtime = rt
    return rt
  }
  let driver: PushPullGizmoTestDriver | null = null
  let driverFactoryCalls = 0
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => {
    driverFactoryCalls++
    const obj = {} as PushPullGizmoTestDriver
    driver = obj
    return obj
  }

  render(
    <SolidsWorkbenchPage
      createClient={createLocalGeomService}
      createSceneRuntime={createSceneRuntime}
      createPushPullTestDriver={createPushPullTestDriver}
    />,
  )
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '12')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

  // The anchored value entry needs a non-null projection to render.
  runtime!.projectToCanvasResult = { x: 200, y: 200 }
  runtime!.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(driverFactoryCalls).toBeGreaterThan(0), { timeout: 20_000 })
  await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })

  return {
    runtime: () => runtime as unknown as FakeSceneRuntime,
    driver: () => driver as unknown as PushPullGizmoTestDriver,
    entryInput: () => screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement,
  }
}

describe('SolidsWorkbenchPage push/pull RELEASE semantics (WO UI-79 F-A, real occt-wasm kernel)', () => {
  it('STEP 1 + regression: dragging a face and RELEASING stops the drag but leaves the tool ARMED with the live value -- it does NOT commit (can-fail: a commit-on-release would mint F2 here)', async () => {
    const a = await renderBoxArmPick()
    const baseDepth = historyDepth(hooks())

    a.driver().simulateDragStart()
    a.driver().simulateDrag(3) // +3mm pull along the top-face normal
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })

    a.driver().simulateDragEnd() // RELEASE

    // Settle every async queue a release-triggered commit would ride (the
    // commit is async: it lands the node only AFTER an editFeature await, so a
    // synchronous check right after release would pass VACUOUSLY even if release
    // did complete the tool). Give it ample time to (not) land, then assert.
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0))

    // The tool stays armed: the gizmo (cancel affordance) and the anchored
    // entry are BOTH still present, and the entry shows the live value (+3).
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy()
    expect(screen.queryByTestId('pushpull-delta-entry')).toBeTruthy()
    expect(parseFloat(a.entryInput().value)).toBeCloseTo(3, 1)
    // Orbit is handed back on release (dragging-false), so the viewport is neutral.
    expect(a.runtime().setOrbitEnabledCalls.at(-1)).toBe(true)
    // ...and NOTHING was committed: no first-class node, history depth unchanged.
    // Can-fail (proven RED by the mutation that wires release to complete the
    // tool -- coordination/evidence/UI-79/red-FA-nocommit-mutation.log): F2
    // would exist and the gizmo would have unmounted here.
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(historyDepth(hooks())).toBe(baseDepth)
  }, 60_000)

  it('STEPS 2-4: typing edits the value live; the FIRST Enter applies it (armed, no commit); the SECOND Enter COMPLETES the tool (mints the UI-80 pushPull node)', async () => {
    const a = await renderBoxArmPick()
    const baseDepth = historyDepth(hooks())

    // A drag to +3 arms the tool at that value, then release (stays armed).
    a.driver().simulateDragStart()
    a.driver().simulateDrag(3)
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    a.driver().simulateDragEnd()

    // STEP 2: typing edits the value live -- the field (and its delta readout)
    // reflect the typed value immediately.
    fireEvent.change(a.entryInput(), { target: { value: '5' } })
    expect(a.entryInput().value).toBe('5')
    expect(screen.getByTestId('pushpull-delta-entry-delta').textContent).toMatch(/\+?5/)

    // STEP 3: the FIRST Enter applies the typed value -- geometry previews to
    // +5 (top z=17), the tool STAYS armed, and NOTHING is committed yet.
    fireEvent.keyDown(a.entryInput(), { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy() // still armed
    expect(screen.queryByTestId('pushpull-delta-entry')).toBeTruthy()
    expect(hooks().dag.getNode('F2')).toBeUndefined() // not committed by the first Enter
    expect(historyDepth(hooks())).toBe(baseDepth)

    // STEP 4: the SECOND Enter (no edit since) COMPLETES the tool -- the commit
    // that mints the UI-80 first-class pushPull node (opType 'pushPull', delta 5).
    fireEvent.keyDown(a.entryInput(), { key: 'Enter' })
    await waitFor(() => expect(hooks().dag.getNode('F2')).toBeTruthy(), { timeout: 20_000 })
    const node = hooks().dag.getNode('F2')
    expect((node?.payload as { opType?: string } | undefined)?.opType).toBe('pushPull')
    expect((node?.payload as { delta?: number } | undefined)?.delta).toBeCloseTo(5, 1)
    expect(historyDepth(hooks())).toBe(baseDepth + 1) // exactly ONE undoable edit
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
    expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull() // tool completed -> entry gone
  }, 60_000)

  it('ESCAPE cancels the armed tool after a release: base restored, nothing committed', async () => {
    const a = await renderBoxArmPick()
    const baseDepth = historyDepth(hooks())

    a.driver().simulateDragStart()
    a.driver().simulateDrag(3)
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    a.driver().simulateDragEnd() // armed at +3 (preview on screen)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
    // Base restored to z=12, nothing committed.
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(historyDepth(hooks())).toBe(baseDepth)
  }, 60_000)
})
