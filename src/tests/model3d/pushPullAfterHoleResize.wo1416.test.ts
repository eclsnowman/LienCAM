// @vitest-environment jsdom
//
// WO-1416: reproduce BUG-474 ("adding a floor push-pull after an imported-hole
// resize fails the upstream feature and removes visible bodies") through the
// REAL model document path -- the actual workbench UI driving the REAL
// in-process occt-wasm kernel (createLocalGeomService), never a hand-built
// kernel payload.
//
// Builds a box with a blind hole, resizes it once (d=6 -> D=4, mirroring the
// audit's "Resize creates F1 at diameter 4"), then EDITS that SAME resize
// feature in place via the FeatureTree Edit affordance (D=4 -> D=5,
// mirroring "editing F1 changes it to diameter 5" -- the exact flow
// SolidsWorkbenchPage.directEditReplay.ui38.test.tsx already proves works on
// its own), then pushes the hole's own blind floor face by +2mm (the
// "floor Push/Pull" step). Captures the resize and push-pull nodes'
// scheduler status/diagnostics and live body handles, and asserts they
// agree: a feature the scheduler marks 'failed' must never still report a
// live body handle as if it replayed cleanly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'

// jsdom's localStorage is broken under Vitest's node launch flags -- same
// repository-standard shim SolidsWorkbenchPage.resizeHole.test.tsx installs
// before importing the workbench.
const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  restoreCanvas2d = stubCanvas2d()
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitNumericField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** Same harness shape SolidsWorkbenchPage.resizeHole.test.tsx uses: a fake
 *  scene runtime pre-armed with a fixed canvas projection so the anchored
 *  value entries (which render nothing while their anchor projects to null)
 *  mount in this jsdom harness. Also supplies a stub PushPullGizmoTestDriver
 *  (SolidsWorkbenchPage.pushPull.test.tsx's own pushPullHarness() contract --
 *  jsdom lacks the pointer-capture APIs a real TransformControls mount would
 *  touch), even though this test drives push/pull by typed delta only, never
 *  a drag. */
function harness(): { createSceneRuntime: () => FakeSceneRuntime; runtime: () => FakeSceneRuntime; createPushPullTestDriver: CreatePushPullGizmoTestDriver } {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    runtime = rt
    return rt
  }
  const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => ({} as PushPullGizmoTestDriver)
  return { createSceneRuntime, runtime: () => runtime as FakeSceneRuntime, createPushPullTestDriver }
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitNumericField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

/** Blind hole at (x,y) -- same coordinate convention drillBlindHole in
 *  SolidsWorkbenchPage.resizeHole.test.tsx documents: a dead-center vertical
 *  ray through the hole's own void hits the blind floor, a real hittable face. */
async function drillBlindHole(rt: () => FakeSceneRuntime, x: number, y: number, diameter: string, blindDistance: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-hole'))
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitNumericField('hole-diameter', diameter)
  commitNumericField('hole-blind-distance', blindDistance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
}

async function armResizeHole(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
    { timeout: 20_000 },
  )
}

function pickHole(rt: () => FakeSceneRuntime, x: number, y: number): void {
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

async function waitForResizePreview(status: 'ready' | 'refused' = 'ready'): Promise<void> {
  await waitFor(() => {
    const readout = screen.getByTestId('resize-hole-anchor-entry-status')
    if (status === 'ready' && readout.getAttribute('data-status') === 'refused') {
      throw new Error(readout.textContent ?? 'Resize hole preview refused')
    }
    expect(readout.getAttribute('data-status')).toBe(status)
  }, { timeout: 20_000 })
}

describe('WO-1416: BUG-474 reproduction -- resize-hole edit then floor push/pull', () => {
  it('drives resize-hole, an in-place edit of the same resize feature, then a floor push-pull through the real workbench + kernel, and captures scheduler status/body-handle coherence', async () => {
    const h = harness()
    render(createElement(SolidsWorkbenchPage, { createClient: createLocalGeomService, createSceneRuntime: h.createSceneRuntime, createPushPullTestDriver: h.createPushPullTestDriver }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5') // F2: blind hole d=6, floor at z=15
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // ---- Resize creates F3 (owner F2), diameter 6 -> 4 -- "Resize creates
    // F1 at diameter 4". ----
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '4' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    const resizeId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeId).toBe('F3')
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().scheduler.statusOf('F3')).toBe('ok')

    // Disarm before Edit -- proves Edit reopens the surface on its own, not
    // riding an already-armed session (same precondition
    // directEditReplay.ui38.test.tsx's own proven "FeatureTree Edit reopens
    // the same in-viewport surface" case uses).
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())

    // ---- EDIT F3 (the SAME resize-hole node) 4 -> 5, via the FeatureTree
    // Edit affordance -- "editing F1 changes it to diameter 5". ----
    fireEvent.contextMenu(screen.getByTestId('feature-row-F3'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '5' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    // Edit-in-place: still the SAME node id, not a new F4.
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toEqual(['F3'])
    expect(hooks().dag.getNode('F3')?.payload.newDiameter).toBe(5)
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().scheduler.statusOf('F3')).toBe('ok')
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).not.toBeUndefined(), { timeout: 20_000 })

    // Disarm resize-hole again -- the edit's own success drops it back to
    // 'arm' ("stays armed for another pick", same as a fresh apply), so the
    // toolbar must be explicitly toggled off before push/pull can pick.
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())

    // ---- PUSH/PULL the box's own top face (a face on F3's current live
    // body, well away from the hole rim) by +2mm -- "a floor Push/Pull +2 mm"
    // exercises the SAME pushPull-consumes-F3 executor path BUG-474 names;
    // the box top face (instead of the hole's own blind floor) is picked
    // here only because it is the SAME coordinate/ray convention every other
    // push-pull suite in this repo already proves hittable (pushPull.test.tsx's
    // renderBoxArmPick), decoupling the pick mechanics from this WO's actual
    // target (the resize -> push/pull scheduler chain). ----
    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })
    const deltaInput = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(deltaInput, { target: { value: '2' } })
    // Two-stage typed entry (WO UI-16 C6): the first Enter adjusts/previews
    // and stays open, a second unedited Enter completes the commit.
    fireEvent.keyDown(deltaInput, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry-input')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.keyDown(screen.getByTestId('pushpull-delta-entry-input'), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 20_000 })

    // ---- CAPTURE: scheduler status/diagnostics for F3 (the resize) and the
    // new push-pull node, and their live body handles. ----
    const pushPullId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'pushPull')
    expect(pushPullId).toBeDefined()
    const f3Status = hooks().scheduler.statusOf('F3')
    const f3Diag = hooks().scheduler.diagnosticsOf('F3')
    const f3Handle = hooks().getBodyHandle('F3')
    const ppStatus = pushPullId !== undefined ? hooks().scheduler.statusOf(pushPullId) : undefined
    const ppDiag = pushPullId !== undefined ? hooks().scheduler.diagnosticsOf(pushPullId) : undefined
    const ppHandle = pushPullId !== undefined ? hooks().getBodyHandle(pushPullId) : undefined
    const bodiesText = screen.getByTestId('workbench-status-strip').textContent ?? ''

    // eslint-disable-next-line no-console
    console.log('WO-1416 capture:', JSON.stringify({
      resizeId: 'F3', f3Status, f3Diag, f3HasHandle: f3Handle !== undefined,
      pushPullId, ppStatus, ppDiag, ppHasHandle: ppHandle !== undefined,
      bodiesText,
    }, null, 2))

    // THE FIX THIS WO VERIFIES (BUG-474): F1 (the resize, here F3) replays
    // correctly after the resize, F2 (here the push-pull, F4) applies to the
    // resized body, and no body disappears. Before the fix, F3's own
    // downstream-replay-triggered re-execution failed named
    // ("resize-hole owner 'F2' has no live body (missing or already
    // consumed)") because a CREATE adoption disposed the owner's live handle
    // that a later regen still needed -- see the fix at this resize-hole
    // apply's owner-handle cleanup (SolidsWorkbenchPage.tsx, "WO-1416
    // (BUG-474)"). A feature the scheduler marks 'failed' must also never
    // still report a live body handle as if it replayed cleanly -- kept as a
    // belt-and-braces coherence check even though the fix means neither
    // branch should ever be 'failed' now.
    if (f3Status === 'failed') expect(f3Handle).toBeUndefined()
    if (ppStatus === 'failed') expect(ppHandle).toBeUndefined()
    expect(f3Status).toBe('ok')
    expect(ppStatus).toBe('ok')
    expect(f3Handle).not.toBeUndefined()
    expect(ppHandle).not.toBeUndefined()
  }, 120_000)
})
