// @vitest-environment jsdom
//
// WO SKC-15C-R1 (S3 gate MAJOR 1, M3): the shared profile accept point refuses a STALE result.
//
// THE DEFECT THIS PROVES CLOSED (coordination/reports/SKC-15C.audit.json, major #1):
//   "the asynchronous finish continuation can still publish a stale profile after a new session edits
//    the same sketch node. ... finish S0 -> delayed geom2d initialization -> reopen the same node and
//    commit S1 -> old continuation writes profile(S0) alongside sketch S1."
//
// `recomputeSketchProfile` is THE single writer of `payload.regions`, called by BOTH Finish and the
// regen executor's 'sketch' branch (SolidsWorkbenchPage.tsx). So a guard placed inside it protects
// both accept points at once -- exactly what the fix asks ("apply the same stale-result guard to
// regen-triggered profile recomputation").
//
// This is a CONSTRUCTED, COMMITTED interleave (charter bar 4), not event-loop prose. There was no
// injectable seam into this async accept point, so this WO built two: `__setProfileRecomputeGate`
// (pause a recompute mid-extract) and the `recomputeSketchProfile` test hook (run the exact function
// Finish/regen call). Pass A is the "old continuation" (paused during geom2d init); a concurrent
// same-node commit lands S1; Pass B is the fresh recompute; then Pass A is released and must refuse.
//
// Non-vacuity: delete the guard (the `if (inputChanged) return CANCELLED` block in recomputeSketchProfile)
// and the final assertion goes red -- Pass A publishes regions(S0) onto the replaced sketch. The
// mutation run is recorded in coordination/evidence/SKC-15C/.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, __setProfileRecomputeGate } from '../../components/model3d/SolidsWorkbenchPage'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

afterEach(cleanup)
afterEach(() => __setProfileRecomputeGate(null)) // never leak the module-level gate between tests

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

const SKETCH_NODE = 'sketch3d:SK1'

function hooks() {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}
function canvas(): HTMLElement { return screen.getByTestId('solids-workbench-canvas') }
function sessionOpen(): boolean { return screen.queryByTestId('workbench-package-sketch-toolbar') !== null }

function line(id: string, ax: number, ay: number, bx: number, by: number): CamSketch['entities'][number] {
  return { id, construction: false, kind: 'line', start: { x: ax, y: ay }, end: { x: bx, y: by } }
}
/** A REAL closed profile (a triangle) -- extractSketchProfile succeeds, so a MISSING guard would have
 *  a genuine profile(S0) to (wrongly) publish. */
function closedTriangle(): CamSketch {
  return {
    id: 'S0', layerId: 'plane:xy',
    entities: [line('l1', 0, 0, 20, 0), line('l2', 20, 0, 10, 15), line('l3', 10, 15, 0, 0)],
    constraints: [], dimensions: [], solveStatus: null,
  }
}
/** The replaced sketch: empty -> no profile. A fresh recompute drops the profile; the stale one must
 *  NOT resurrect it. */
function emptySketch(): CamSketch {
  return { id: 'S1', layerId: 'plane:xy', entities: [], constraints: [], dimensions: [], solveStatus: { dof: 0, conflicting: [], redundant: [] } }
}

async function bootAndClose(): Promise<void> {
  let captured: FakeSceneRuntime | null = null
  const capture: CreateSceneRuntime = () => { const rt = createFakeSceneRuntime(); captured = rt; return rt }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={capture} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
  runtime.camera = cam
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

  // Open a base-plane session so the node SK1 exists on the XY datum, then close it: this test drives
  // the recompute accept point directly, not the live drawing UI.
  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(sessionOpen()).toBe(true))
  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  await waitFor(() => expect(sessionOpen()).toBe(false))
}

/** Arm a ONE-SHOT gate: only the first recompute (pass A) pauses; it clears the gate on entry so pass
 *  B runs free. Returns { entered, release }. */
function oneShotGate(): { entered: () => boolean; release: () => void } {
  let didEnter = false
  let doRelease!: () => void
  const gate = new Promise<void>((r) => { doRelease = r })
  __setProfileRecomputeGate(async () => {
    __setProfileRecomputeGate(null)
    didEnter = true
    await gate
  })
  return { entered: () => didEnter, release: () => doRelease() }
}

describe('WO SKC-15C-R1 (M3): a stale recompute continuation refuses to publish onto a replaced sketch', () => {
  it('finish S0 (paused) -> commit S1 -> the released S0 continuation does NOT write profile(S0)', async () => {
    await bootAndClose()
    const { dag } = hooks()
    const base = dag.getNode(SKETCH_NODE)!.payload
    // Install S0, the state Finish's recompute reads. No regions yet.
    dag.setPayload(SKETCH_NODE, { ...base, sketch: closedTriangle() })
    expect(dag.getNode(SKETCH_NODE)!.payload.regions).toBeUndefined()

    const g = oneShotGate()
    // Pass A: the old finish continuation. Snapshots S0 + its plane, then pauses mid-extract.
    const passA = hooks().recomputeSketchProfile(SKETCH_NODE)
    await waitFor(() => expect(g.entered()).toBe(true))

    // The concurrent re-entry commit: the same DAG write a real reopen+commit performs (commitSketch
    // -> dag.setPayload with a fresh `sketch`). S1 is empty.
    const afterA = dag.getNode(SKETCH_NODE)!.payload
    dag.setPayload(SKETCH_NODE, { ...afterA, sketch: emptySketch() })

    // Pass B: the fresh recompute the new session runs. S1 empty -> no regions.
    await hooks().recomputeSketchProfile(SKETCH_NODE)
    expect(dag.getNode(SKETCH_NODE)!.payload.regions).toBeUndefined()

    // Release pass A: its extract completes on the STALE S0 and tries to publish regions(S0).
    g.release()
    const diagsA = await passA

    // THE GUARD: pass A refused BY NAME, so the triangle regions never landed on the now-empty sketch.
    // WITHOUT the guard this is a defined region tuple (regions(S0) alongside sketch S1) -- the M3 bug.
    expect(dag.getNode(SKETCH_NODE)!.payload.regions).toBeUndefined()
    expect(diagsA.some((d) => d.code === 'CANCELLED')).toBe(true)
  }, 60_000)

  it('the same guard fires when the PLANE moves under the extract (the regen-recompute staleness)', async () => {
    await bootAndClose()
    const { dag } = hooks()
    const base = dag.getNode(SKETCH_NODE)!.payload
    const planeNodeId = (base as { planeNodeId?: string }).planeNodeId
    if (planeNodeId === undefined) throw new Error('test: SK1 has no planeNodeId')
    dag.setPayload(SKETCH_NODE, { ...base, sketch: closedTriangle() })

    // Capture the plane's frame so we can move it mid-extract.
    const planeBase = dag.getNode(planeNodeId)!.payload as { lastGoodFrame?: { origin: { x: number; y: number; z: number } } }
    const f0 = planeBase.lastGoodFrame
    if (f0 === undefined) throw new Error('test: base plane has no lastGoodFrame')

    const g = oneShotGate()
    // Pass A snapshots the triangle at plane z=0, then pauses.
    const passA = hooks().recomputeSketchProfile(SKETCH_NODE)
    await waitFor(() => expect(g.entered()).toBe(true))

    // MOVE the plane +30mm in Z (a parent-face edit's regen would do this), sketch unchanged, then run
    // pass B fresh -> regions at the MOVED plane.
    const movedFrame = { ...f0, origin: { ...f0.origin, z: f0.origin.z + 30 } }
    dag.setPayload(planeNodeId, { ...planeBase, lastGoodFrame: movedFrame })
    await hooks().recomputeSketchProfile(SKETCH_NODE)
    const freshRegions = dag.getNode(SKETCH_NODE)!.payload.regions as Array<{ plane: { origin: { z: number } } }> | undefined
    expect(freshRegions?.[0]?.plane.origin.z).toBe(30)

    // Release pass A: it extracts the triangle at the OLD z=0 plane and tries to publish it.
    g.release()
    const diagsA = await passA

    // THE GUARD: the regions still reflect the CURRENT (moved) plane, not pass A's stale z=0 one.
    const finalRegions = dag.getNode(SKETCH_NODE)!.payload.regions as Array<{ plane: { origin: { z: number } } }> | undefined
    expect(finalRegions?.[0]?.plane.origin.z).toBe(30)
    expect(diagsA.some((d) => d.code === 'CANCELLED')).toBe(true)
  }, 60_000)
})
