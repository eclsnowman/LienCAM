// @vitest-environment jsdom
//
// WO SKC-78: reopening a saved sketch in the Model workspace must show the FRESHLY SOLVED
// definedness status, never the persisted `solveStatus` verbatim.
//
// FOUND BY the SKC-77 after-capture lane: Operator's saved SK1 read a stale "8 DoF" chip on mere open
// (coordination/evidence/SKC-77-FILLET-UNDEFINED/after-1a-model-sk1-as-opened-stale-status.png) even
// though the SKC-77 fix (gcsMapping.ts) makes a FRESH solve of the exact same geometry correctly
// report "Fully defined" -- only a trivial nudge (editing a dimension) forced that fresh solve. Root
// cause: `sketchSessionStore.begin()` (sketchSessionStore.ts) seeds the session with
// `node.payload.sketch.solveStatus` exactly as persisted, and the Model-workspace host
// (`beginPackageSketch`, SolidsWorkbenchPage.tsx) had no open-triggers-a-fresh-solve step. CAM's own
// `setActiveSketch` (src/store/index.ts:8907, "Every document OPEN gets a real solve") already had
// this guarantee -- this WO ports it to the Model workspace host, closing the parity gap.
//
// This test reproduces the exact shape of the bug WITHOUT depending on SKC-77's fillet mechanism: a
// fully-defined line (Fix constraint pins both endpoints, dof genuinely 0) is FINISHED, then its
// persisted `solveStatus` is corrupted directly in the dag payload to a wrong "8 DoF" -- simulating a
// document saved mid-bug, or by any other path that can leave a stale/wrong solveStatus on disk. A
// correct host must show "Fully defined" the instant the sketch reopens, with no further edit.
//
// Boot/interaction harness deliberately mirrors SolidsWorkbenchPage.sketchEditSession.test.tsx
// (bootSketch/tool/click/finish/editSelected) -- same real page, real DAG, real planegcs solver
// (booted by the page's own mount effect; `createFakeGeomClient` only fakes the OCCT kernel, never
// the sketch solver).
//
// SCOPE, PINNED BY THIS TEST'S LAST TWO LINES: the fix is DISPLAY-ONLY. It corrects the live
// session (the chip, the painted geometry) on open, but never silently rewrites the dag payload for
// a session that closes untouched -- that would collide with the byte-for-byte legacy-reopen
// guarantee `SolidsWorkbenchPage.sketchOnFaceDegrade.test.tsx` pins for a different reason (WO
// SKC-5, "reopening is not a migration/reprojection trigger"). A first draft of this fix wrote the
// correction straight to the dag on open and broke that test; this file's last assertions exist so a
// regression on EITHER side goes red here first.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { workbenchSketchDocumentPort } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

const SKETCH_NODE = 'sketch3d:SK1'
const CENTRE = { x: 400, y: 300 }

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

function click(at: { x: number; y: number }): void {
  pointer('pointerdown', at)
  pointer('pointerup', at)
}

function tool(id: 'select' | 'line'): void {
  fireEvent.click(screen.getByTestId(`workbench-package-tool-${id}`))
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

/** Same boot sequence as SolidsWorkbenchPage.sketchEditSession.test.tsx's own `bootSketch`: real page,
 *  real DAG, real planegcs solver (the page's mount effect awaits `createGcsWrapper()` before it ever
 *  reports 'ready' -- see SolidsWorkbenchPage.tsx around the `setStatus('Ready')` call), fake OCCT
 *  kernel only. */
async function bootSketch(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  // WO-108: Ready now means "the GEOMETRY KERNEL is live" and nothing more --
  // it stopped being gated on the constraint solver, because a hung planegcs
  // fetch used to freeze this page for 30s behind an untrue status string.
  // This file is about the SOLVER's verdict on a reopened sketch, so it has to
  // wait for the thing it is actually testing. The workbench publishes exactly
  // that: the solver-state element disappears when the solver is up.
  await waitFor(
    () => expect(screen.queryByTestId('solids-workbench-solver-state')).toBeNull(),
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

async function finish(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  await waitFor(() => expect(sessionOpen()).toBe(false))
}

/** Re-enter via the toolbar's Edit button -- what a user presses. Mirrors
 *  SolidsWorkbenchPage.sketchEditSession.test.tsx's own `editSelected`: the sketch node stays
 *  selected across Finish, which is what makes this reachable without a fresh tree click. */
async function editSelected(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-edit-feature'))
  await waitFor(() => expect(sessionOpen()).toBe(true))
}

describe('SolidsWorkbenchPage: SKC-78 -- reopening a sketch re-solves definedness, never trusts the persisted status', () => {
  it('a saved sketch whose persisted solveStatus is stale/wrong shows the FRESH solve on open, no edit needed', async () => {
    await bootSketch()

    // Draw one line, then FIX it (pins both endpoints) -- a real, non-fillet-dependent way to reach a
    // genuinely fully-defined (dof: 0) sketch, so this test does not depend on SKC-77's mechanism.
    tool('line')
    click(CENTRE)
    click({ x: CENTRE.x + 100, y: CENTRE.y })
    const lineId = payloadSketch().entities.find((e) => e.kind === 'line')?.id
    if (lineId === undefined) throw new Error('test: expected a drawn line entity')
    act(() => { workbenchSketchDocumentPort.setSelection([lineId]) })
    fireEvent.click(screen.getByTestId('workbench-package-constraint-fix'))

    const solvedStatus = payloadSketch().solveStatus
    expect(solvedStatus).not.toBeNull()
    // FAILS-IF this harness stops reaching a genuinely fully-defined sketch: the rest of the test
    // would then be proving nothing (a real-world stale-status file is fully defined when correctly
    // solved -- SKC-77's own repro, and this one).
    expect((solvedStatus as { dof: number }).dof).toBe(0)

    await finish()

    // Corrupt the PERSISTED document directly in the dag, bypassing every host write path -- this is
    // the honest shape of the real-world bug: a file whose solveStatus went stale/wrong by some prior
    // path (SKC-77's own mid-bug save is one instance; this test does not assume THAT specific one).
    const node = hooks().dag.getNode(SKETCH_NODE)
    if (node === undefined) throw new Error('test: sketch node missing after Finish')
    const staleSketch = payloadSketch()
    hooks().dag.setPayload(SKETCH_NODE, {
      ...node.payload,
      sketch: { ...staleSketch, solveStatus: { dof: 8, conflicting: [], redundant: [] } },
    })
    expect(payloadSketch().solveStatus).toEqual({ dof: 8, conflicting: [], redundant: [] })

    // Reopen. FAILS-IF the host seeds the session from the persisted (corrupted) status verbatim: the
    // chip would read "8 DoF" here, exactly Operator's SKC-77 after-capture screenshot, and the assertions
    // below would catch it immediately -- no nudge, no edit, this is the FIRST read after open.
    await editSelected()

    const chip = screen.getByTestId('workbench-sketch-dof-chip')
    expect(chip.textContent).toContain('Fully defined')
    expect(chip.textContent).not.toMatch(/8/)

    // DISPLAY-ONLY, on purpose (see beginPackageSketch's own comment): the corrected status is never
    // silently written back to the dag by the mere act of opening. Closing this session WITHOUT any
    // edit must leave the persisted payload byte-for-byte identical to what was corrupted above --
    // the same guarantee `SolidsWorkbenchPage.sketchOnFaceDegrade.test.tsx`'s "archive-loaded CAM
    // legacy refs reopen byte-for-byte" case pins for a different reason (WO SKC-5: reopening is not
    // a migration/reprojection trigger). FAILS-IF a future change reintroduces a quiet payload
    // rewrite on open: it would break that other test the same way this fix's first draft did.
    await finish()
    expect(payloadSketch().solveStatus).toEqual({ dof: 8, conflicting: [], redundant: [] })
    expect(payloadSketch().entities.filter((e) => e.kind === 'line')).toHaveLength(1)
  }, 60_000)
})
