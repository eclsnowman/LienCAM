// @vitest-environment jsdom
//
// WO SKC-15C-R1 (S3 gate BLOCKER, B2): a WORKBENCH undo resyncs the LIVE package document, and the
// keyboard route belongs to the workbench, not to CAM's global Ctrl+Z.
//
// THE DEFECT THIS PROVES CLOSED (from coordination/reports/SKC-15C.audit.json, blocker):
//   "package creation and package gestures enter CommandHistory without entering the page's parallel
//    touched-id history, so one workbench Undo mutates the DAG but does not resync the live package
//    document; Ctrl+Z still routes to CAM history instead of workbench history."
//
// So this file drives the REAL page (real FeatureDag, real CommandHistory, the real workbench
// Sketcher mount) and asserts, after ONE undo, that ALL of these agree:
//   * DAG payload            -- the node's `payload.sketch` reverted by exactly one gesture
//   * sketchSessionStore     -- the live document the overlays + interaction layer read
//   * the NEXT gesture       -- a draw after the undo builds on the reverted document, not a stale one
//   * rendered geometry      -- the finished outline reflects the resynced document
// and that CAM's global Ctrl+Z handler PROVABLY does not also fire (charter bar 4: constructed).
//
// It is non-vacuous: the fix is the `onHistoryStep` parallel-stack push + the always-resync in
// handleUndo/handleRedo + the capture-phase Ctrl+Z owner. Remove any one and a named assertion here
// goes red (the mutation runs are recorded in coordination/evidence/SKC-15C/).

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  WORKBENCH_ORIGIN_ENTITY_ID,
  WORKBENCH_INJECTED_ENTITY_IDS,
} from '../../components/model3d/workbench/workbenchOriginAnchor'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

const SKETCH_NODE = 'sketch3d:SK1'
const CENTRE = { x: 400, y: 300 }

function hooks() {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}
function canvas(): HTMLElement { return screen.getByTestId('solids-workbench-canvas') }

/** jsdom has no PointerEvent; the package reads only MouseEvent fields, on native canvas listeners. */
function pointer(type: string, at: { x: number; y: number }): void {
  canvas().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0 }))
}
function click(at: { x: number; y: number }): void { pointer('pointerdown', at); pointer('pointerup', at) }
function tool(id: 'select' | 'line'): void { fireEvent.click(screen.getByTestId(`workbench-package-tool-${id}`)) }
function sessionOpen(): boolean { return screen.queryByTestId('workbench-package-sketch-toolbar') !== null }

function payloadEntityCount(nodeId = SKETCH_NODE): number {
  const node = hooks().dag.getNode(nodeId)
  if (node === undefined) throw new Error(`test: node '${nodeId}' not found`)
  const sketch = node.payload.sketch as CamSketch | undefined
  return sketch?.entities.length ?? 0
}
function storeUserEntityCount(): number {
  const entities = sketchSessionStore.getState().sketch?.entities ?? []
  // SKC-22 / WO SKC-49: the live session owns exactly THREE synthetic anchor entities (origin
  // point + both axis lines) while the DAG intentionally persists none. Keep this older undo gate
  // focused on user geometry, but fail if the new session invariant drifts either way.
  expect(entities.filter((entity) => WORKBENCH_INJECTED_ENTITY_IDS.has(entity.id))).toHaveLength(3)
  expect(entities.filter((entity) => entity.id === WORKBENCH_ORIGIN_ENTITY_ID)).toHaveLength(1)
  return entities.filter((entity) => !WORKBENCH_INJECTED_ENTITY_IDS.has(entity.id)).length
}
function outlineVertexCount(runtime: FakeSceneRuntime): number {
  const segs = runtime.addedObjects.filter((o): o is THREE.LineSegments => (o as THREE.LineSegments).isLineSegments === true)
  const last = segs.at(-1)
  const pos = last?.geometry.getAttribute('position')
  return pos === undefined ? 0 : pos.count
}

async function bootSketch(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => { const rt = createFakeSceneRuntime(); captured = rt; return rt }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
  runtime.camera = cam
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(sessionOpen()).toBe(true))
  return runtime
}

/** Draw ONE line (2 clicks) at a fresh location. One gesture => one CommandHistory step. */
function drawLine(from: { x: number; y: number }, to: { x: number; y: number }): void {
  tool('line'); click(from); click(to)
}

describe('WO SKC-15C-R1 (B2): a workbench undo resyncs the live document (button path)', () => {
  it('one Undo click reverts the DAG, the session store, and the next gesture builds on the reverted doc', async () => {
    const runtime = await bootSketch()
    drawLine(CENTRE, { x: CENTRE.x + 100, y: CENTRE.y })            // line 1
    await waitFor(() => expect(payloadEntityCount()).toBe(1))
    drawLine({ x: CENTRE.x, y: CENTRE.y + 80 }, { x: CENTRE.x + 100, y: CENTRE.y + 80 }) // line 2
    await waitFor(() => expect(payloadEntityCount()).toBe(2))
    expect(storeUserEntityCount()).toBe(2)

    // ONE workbench undo, via the button.
    fireEvent.click(screen.getByTestId('workbench-undo'))

    // DAG payload reverted by exactly one gesture...
    await waitFor(() => expect(payloadEntityCount()).toBe(1))
    // ...and the LIVE document the overlays read reverted WITH it (the blocker: it used to stay at 2).
    await waitFor(() => expect(storeUserEntityCount()).toBe(1))

    // THE NEXT GESTURE builds on the reverted document: a third line lands at total 2, not 3. If the
    // session store had stayed stale at 2, appending would produce 3.
    drawLine({ x: CENTRE.x - 120, y: CENTRE.y }, { x: CENTRE.x - 20, y: CENTRE.y })
    await waitFor(() => expect(payloadEntityCount()).toBe(2))
    expect(storeUserEntityCount()).toBe(2)

    // RENDERED geometry agrees: finish, and the painted outline reflects the resynced 2-line document.
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(sessionOpen()).toBe(false))
    await waitFor(() => expect(outlineVertexCount(runtime)).toBeGreaterThan(0))
    expect(payloadEntityCount()).toBe(2)
  }, 60_000)

  it('Undo then Redo round-trips the live document back to 2 entities', async () => {
    await bootSketch()
    drawLine(CENTRE, { x: CENTRE.x + 100, y: CENTRE.y })
    drawLine({ x: CENTRE.x, y: CENTRE.y + 80 }, { x: CENTRE.x + 100, y: CENTRE.y + 80 })
    await waitFor(() => expect(payloadEntityCount()).toBe(2))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(storeUserEntityCount()).toBe(1))
    fireEvent.click(screen.getByTestId('workbench-redo'))
    // FAILS-IF redo re-runs the DAG command but never pulls the re-applied document back into the
    // session store (the redo half of the same resync contract).
    await waitFor(() => expect(payloadEntityCount()).toBe(2))
    await waitFor(() => expect(storeUserEntityCount()).toBe(2))
  }, 60_000)
})

describe('WO SKC-15C-R1 (B2): Ctrl+Z routes to the workbench, and CAM does not double-fire', () => {
  it('Ctrl+Z undoes the workbench command AND the global CAM handler provably never fires', async () => {
    // A faithful replica of CAM's ONLY global Ctrl+Z listener (src/components/toolbar/TopToolbar.tsx:
    // 18-28): a BUBBLE-phase window keydown that acts on (ctrl|meta)+z, no shift. Registered BEFORE
    // the page mounts (as TopToolbar would be, higher in the tree), so this proves the workbench's
    // capture-phase owner wins REGARDLESS of registration order -- not by luck of who mounted first.
    let camUndoFired = 0
    const camHandler = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); camUndoFired++ }
    }
    window.addEventListener('keydown', camHandler)
    try {
      await bootSketch()
      drawLine(CENTRE, { x: CENTRE.x + 100, y: CENTRE.y })
      drawLine({ x: CENTRE.x, y: CENTRE.y + 80 }, { x: CENTRE.x + 100, y: CENTRE.y + 80 })
      await waitFor(() => expect(payloadEntityCount()).toBe(2))

      // Dispatch on a REAL element (document.body), NOT window: a real Ctrl+Z targets the focused
      // element, so the capture phase visits window FIRST -- exactly where the workbench owner sits.
      // Dispatching on window would collapse capture/bubble to registration order and not model reality.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))

      // Workbench undid one gesture, in both the DAG and the live store...
      await waitFor(() => expect(payloadEntityCount()).toBe(1))
      await waitFor(() => expect(storeUserEntityCount()).toBe(1))
      // ...and CAM's global handler was stopped dead by the capture-phase stopImmediatePropagation.
      expect(camUndoFired).toBe(0)

      // The next gesture still builds on the reverted document (2, not 3).
      drawLine({ x: CENTRE.x - 120, y: CENTRE.y }, { x: CENTRE.x - 20, y: CENTRE.y })
      await waitFor(() => expect(payloadEntityCount()).toBe(2))
    } finally {
      window.removeEventListener('keydown', camHandler)
    }
  }, 60_000)
})
