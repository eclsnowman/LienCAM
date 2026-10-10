// @vitest-environment jsdom
//
// WO SKC-11 (Operator T-SKC-PARITY finding 3): "moving the objects also moves the camera. Fail." A left
// press inside a workbench sketch must never rotate the camera, while leaving rotation available
// BETWEEN gestures (Operator: "rotatable by the user if desired, but both should not happen at the same
// time").
//
// ---------------------------------------------------------------------------------------------
// WO SKC-15C -- WHY THIS FILE WAS REWRITTEN, AND WHAT IT STILL PROVES.
//
// The original drove the page's INLINE sketch draw machine: it clicked `workbench-sketch-tool-line`,
// dispatched React pointer events at the canvas, and read the fake runtime's `setDragOrbitSuppressed`
// call log. All three of those are gone. The severing deleted the inline machine; THE Sketcher package
// owns every sketch pointer event, and it writes `controls.enableRotate` through
// `SceneRuntime.sketchOrbitHandle()` -- never `setDragOrbitSuppressed`, which remains the push/pull
// gizmo's own separate suppression stack.
//
// The ZERO-CAMERA-MOTION proof now lives one layer down, in src/tests/sketch/sketcherOrbitPolicy.test.ts,
// where a `FakeOrbitControls` reproduces three.js's real pointerdown-latch / pointermove-recheck shape
// and the probe measures THE CAMERA rather than the `enableRotate` proxy. That is a strictly stronger
// gate than this file ever had (this one asserted a boolean call log; a proxy assertion passes even
// after the camera has already moved -- feedback_gates_mask_defects).
//
// What CANNOT be proved down there, and is therefore what this file keeps: that the REAL PAGE wires it
// up. That the workbench host asks for `orbitPolicy: 'drag'`, that the page hands the package the
// runtime's live `enableRotate` view, and that a real user gesture on the real canvas -- reached
// through the real `Sketch on face` / `New sketch` entry points -- moves that flag and puts it back.
// A package that behaves perfectly in isolation and is mounted with the wrong policy would be green in
// sketcherOrbitPolicy.test.ts and red here.
//
// ORIGINAL-MUTATION RE-RUN (charter: "re-run any test you rewrote against its original mutation").
// The mutation this file was written for is SKC-11's: suppress at the drag threshold instead of at the
// press. Under it, `beginSketchPress()` never runs at pointerdown, so `sketchOrbitEnableRotate` stays
// `true` through the press and the first assertion below fails by name. Recorded in
// coordination/evidence/SKC-15C/mutation-a-*.
//
// SKC-15C also CLOSES SKC-15B's open finding here: an EMPTY-SPACE press (which becomes a marquee)
// suppresses orbit too. The old file asserted the opposite -- "a click on empty canvas never
// SUPPRESSES orbit" -- which was the defect, stated as a test.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

const SKETCH_NODE = 'sketch3d:SK1'

/** Canvas centre == the XY plane origin; ~100px is ~13.8mm at this camera distance. */
const CENTRE = { x: 400, y: 300 }
/** Far from anything drawn at the centre: an empty-space press. */
const EMPTY = { x: 700, y: 520 }

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

/** jsdom has no PointerEvent; the package reads only MouseEvent fields (same helper the package's
 *  own tests use). React is NOT in this path -- the package listens natively on the canvas. */
function pointer(type: string, at: { x: number; y: number }, button = 0): void {
  canvas().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button }))
}

function click(at: { x: number; y: number }): void {
  pointer('pointerdown', at)
  pointer('pointerup', at)
}

/** Press, travel well past the package's 5px drag threshold, release. */
function dragFrom(at: { x: number; y: number }, onMove?: () => void): void {
  pointer('pointerdown', at)
  for (const dx of [2, 6, 14, 30]) {
    pointer('pointermove', { x: at.x + dx, y: at.y })
    onMove?.()
  }
  pointer('pointerup', { x: at.x + 30, y: at.y })
}

function payloadSketch(): CamSketch {
  const node = hooks().dag.getNode(SKETCH_NODE)
  if (node === undefined) throw new Error(`test: node '${SKETCH_NODE}' not found`)
  return node.payload.sketch as CamSketch
}

/**
 * Boot the page and open a package sketch session on the XY base plane. Deliberately the FREE-SKETCH
 * entry with a FAKE geom client: this file is about pointer/camera wiring, and a real occt-wasm boot
 * plus an extrude would add ~20s per test for geometry nothing here reads.
 *
 * The fake runtime's default camera sits at the world origin, so a raycast onto a plane through the
 * origin is degenerate. It is replaced BEFORE the session opens (the host captures `runtime.camera`
 * for picking at construction) with the same 100mm-back perspective camera `orientNormalToPlane`
 * would produce on entry.
 */
async function bootPackageSketch(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100)
  cam.up.set(0, 1, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  const container = canvas().parentElement as HTMLElement
  container.getBoundingClientRect = () => rect

  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
  expect(runtime.orientNormalToPlaneCalls.at(-1)?.frame).toEqual(BASE_PLANE_FRAMES.xy)
  return runtime
}

/** Draw one horizontal line through the plane origin with the package's LINE tool, then arm SELECT
 *  so the next press is a grab rather than another draw click. */
function drawOneLine(): void {
  fireEvent.click(screen.getByTestId('workbench-package-tool-line'))
  click(CENTRE)
  click({ x: CENTRE.x + 100, y: CENTRE.y })
  // Escape ends the open chain (otherwise the next click extends the polyline).
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  fireEvent.click(screen.getByTestId('workbench-package-tool-select'))
  expect(payloadSketch().entities.filter((e) => e.kind === 'line')).toHaveLength(1)
}

describe('SolidsWorkbenchPage: the page really mounts the package under orbitPolicy "drag" (WO SKC-11 / SKC-15C)', () => {
  it('a press ON a sketch entity suppresses orbit for the WHOLE gesture, from pointer-down, and restores on pointer-up', async () => {
    const runtime = await bootPackageSketch()
    drawOneLine()
    expect(runtime.sketchOrbitEnableRotate).toBe(true) // live between gestures: that is what 'drag' buys

    // The line runs from the plane origin to +100px. Grab its midpoint.
    const mid = { x: CENTRE.x + 50, y: CENTRE.y }
    pointer('pointerdown', mid)
    // FAILS-IF suppression moves to the 5px `dragBegin` threshold (SKC-11's original mutation):
    // OrbitControls latches ROTATE at pointerdown, so the first five pixels of every drag would spin
    // the camera. The flag must already be false before ANY pointermove arrives.
    expect(runtime.sketchOrbitEnableRotate).toBe(false)

    const duringDrag: boolean[] = []
    for (const dx of [2, 6, 14, 30]) {
      pointer('pointermove', { x: mid.x + dx, y: mid.y })
      duringDrag.push(runtime.sketchOrbitEnableRotate)
    }
    expect(duringDrag).toEqual([false, false, false, false])

    pointer('pointerup', { x: mid.x + 30, y: mid.y })
    expect(runtime.sketchOrbitEnableRotate).toBe(true)
  }, 40_000)

  it('an EMPTY-SPACE press suppresses orbit too -- the marquee and the camera never move together (SKC-15B open finding, closed)', async () => {
    const runtime = await bootPackageSketch()
    drawOneLine()

    const seen: boolean[] = []
    pointer('pointerdown', EMPTY)
    seen.push(runtime.sketchOrbitEnableRotate)
    for (const dx of [2, 8, 20, 40]) {
      pointer('pointermove', { x: EMPTY.x + dx, y: EMPTY.y })
      seen.push(runtime.sketchOrbitEnableRotate)
    }
    // FAILS-IF `handlePointerDown` reverts to suppressing only on `hit?.type === 'entity'`: an
    // empty-space press starts the package's marquee AND, under `liencnc-default` (LEFT = orbit), an
    // OrbitControls rotation. Operator's finding 3: never both at once.
    expect(seen).toEqual([false, false, false, false, false])

    pointer('pointerup', { x: EMPTY.x + 40, y: EMPTY.y })
    expect(runtime.sketchOrbitEnableRotate).toBe(true)
    // The press really was empty space -- it selected nothing and drew nothing.
    expect(payloadSketch().entities.filter((e) => e.kind === 'line')).toHaveLength(1)
  }, 40_000)

  it('a press that never crosses the drag threshold still restores orbit (no stranded suppression)', async () => {
    const runtime = await bootPackageSketch()
    drawOneLine()
    pointer('pointerdown', { x: CENTRE.x + 50, y: CENTRE.y })
    expect(runtime.sketchOrbitEnableRotate).toBe(false)
    pointer('pointerup', { x: CENTRE.x + 51, y: CENTRE.y }) // 1px: a click, not a drag
    expect(runtime.sketchOrbitEnableRotate).toBe(true)
  }, 40_000)

  it('CLEANUP TAIL: finishing the sketch mid-press never strands orbit switched off', async () => {
    const runtime = await bootPackageSketch()
    drawOneLine()
    pointer('pointerdown', { x: CENTRE.x + 50, y: CENTRE.y })
    pointer('pointermove', { x: CENTRE.x + 60, y: CENTRE.y })
    expect(runtime.sketchOrbitEnableRotate).toBe(false)

    // Finish with the pointer still down: no pointerup will ever arrive for this gesture.
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())

    // FAILS-IF `exitSession()` stops discarding the live drag suppression, or `detach()` stops
    // calling `endSketchPress()` -- the user would be left unable to orbit for the rest of the app's
    // lifetime, with no gesture in flight to blame (charter item 5, the cleanup tail).
    expect(runtime.sketchOrbitEnableRotate).toBe(true)
  }, 40_000)

  it('pointer events on the canvas never reach a page-level sketch handler: the page has none', async () => {
    const runtime = await bootPackageSketch()
    // The page's canvas carries exactly one pointer prop (the UI-4 measure/appearance hover), and it
    // early-returns unless the canvas is idle. Driving a full gesture with a sketch session open must
    // therefore change nothing but what the PACKAGE changed.
    const before = runtime.dragOrbitSuppressedCalls.length
    drawOneLine()
    dragFrom({ x: CENTRE.x + 50, y: CENTRE.y })
    // FAILS-IF the page regrows an inline drag machine: the old one called
    // `runtime.setDragOrbitSuppressed(true/false)` on every grab. That stack belongs to the push/pull
    // gizmo now, and a sketch gesture must not touch it.
    expect(runtime.dragOrbitSuppressedCalls.length).toBe(before)
  }, 40_000)
})
