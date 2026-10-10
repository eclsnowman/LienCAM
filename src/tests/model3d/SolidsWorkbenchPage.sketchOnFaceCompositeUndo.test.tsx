// @vitest-environment jsdom
//
// WO UI-16 (Q-14, Operator-answered 2026-07-10, choice=composite): sketch-on-face
// creation used to insert its face-plane datum AND its sketch as TWO
// separate steps -- the datum uncommanded (bypassing CommandHistory
// entirely), the sketch as its own undoable InsertNodeCommand. One Ctrl+Z
// after Finish removed only the sketch, leaving an ORPHAN datum row visible
// in the tree with nothing consuming it (SKC-15C's own comment named this
// gap and deferred fixing it to a WO that could put the user-facing change
// in front of Operator -- this is that WO).
//
// This drives the REAL SolidsWorkbenchPage (real occt-wasm kernel) through
// its actual face-based New Sketch UI affordance and asserts:
//   1. ONE undo after Finish removes BOTH the sketch and its datum -- the
//      tree shows neither.
//   2. Redo restores BOTH.
//   3. The plain (non-face) "New sketch" entry's undo granularity is
//      UNCHANGED (one sketch node, no datum involved) -- pinned separately
//      so a future change to the composite bundling cannot silently widen
//      to the base-plane path too.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

describe('SolidsWorkbenchPage: sketch-on-face composite undo (WO UI-16 Q-14, real occt-wasm kernel)', () => {
  it('ONE undo after Finish removes BOTH the sketch and its datum; redo restores both', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }

    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    const undoDepthBeforeFaceSketch = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy())

    // ONE new undo step for the whole face-sketch entry (datum + sketch bundled), not two.
    expect(hooks().history.size()).toBe(undoDepthBeforeFaceSketch + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-sketch3d:SK2')).toBeNull(), { timeout: 20_000 })
    // FAILS-IF: reverting to the pre-Q-14 two-step insert leaves this row behind (the orphan datum
    // defect Q-14 fixes) -- the sketch would disappear but the datum would not.
    expect(screen.queryByTestId('feature-row-datum:SK2')).toBeNull()
    expect(hooks().dag.has('datum:SK2')).toBe(false)
    expect(hooks().dag.has('sketch3d:SK2')).toBe(false)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy()
    expect(hooks().dag.getNode('datum:SK2')?.consumes).toEqual(['F1'])
  }, 60_000)

  it('the plain (non-face) sketch path undo granularity is UNCHANGED: one undo removes only the sketch, no datum involved', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    const runtime = capturedRuntime as unknown as FakeSceneRuntime

    const undoDepthBefore = hooks().history.size()

    // 'New sketch' arms the in-workspace plane pick; clicking the XY plane glyph enters an EMPTY
    // package session directly, undoable, no datum (base planes are genesis nodes, never inserted).
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK1')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK1')).toBeTruthy())

    // ONE new undo step, same as before Q-14 -- unchanged.
    expect(hooks().history.size()).toBe(undoDepthBefore + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-sketch3d:SK1')).toBeNull(), { timeout: 20_000 })
    expect(hooks().dag.has('sketch3d:SK1')).toBe(false)
  }, 30_000)
})
