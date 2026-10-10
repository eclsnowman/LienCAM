// @vitest-environment jsdom
//
// WO SKC-5 acceptance criterion 6: "Camera: sketch entry goes normal-to-
// plane, finish restores unless user moved it, NOTHING persisted to the
// document (test), nav presets respected (no-regress test)." Drives the
// REAL SolidsWorkbenchPage against the fake scene runtime's call logs (jsdom
// has no real WebGL camera to assert pixel state against -- see
// fakeSceneRuntime.ts's own header) -- the SAME seam every other camera/
// section test in this suite already uses.

// WO SKC-15C (THE SEVERING) -- why `workbench-finish-package-sketch` and not `workbench-finish-sketch`:
// this file used to drive the INLINE sketch session, whose Finish button carried the latter testid.
// Sketch-on-face now enters THE Sketcher package session, whose Finish carries the former. The old id
// no longer exists in the page AT ALL, deliberately: a stale caller reaching for it goes red rather
// than silently driving a different sketcher. Nothing else in this file's assertions changed.
// WO SKC-15C: sketch-on-face now opens THE Sketcher package session, whose constraint badges need a
// 2D canvas context jsdom does not have. See stubCanvas2d.ts -- environment gap, nothing asserted on.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { unzipSync, strFromU8 } from 'fflate'
import { createDocumentArchive } from '../../doc/persist'
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

async function buildSketchOnFace(runtime: FakeSceneRuntime): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

  runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('workbench-new-sketch'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
}

describe('SolidsWorkbenchPage: sketch camera behavior (WO SKC-5 AC #6, Q6)', () => {
  it('sketch entry orients normal-to-plane; Finish restores the prior pose when the user never orbited', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    const runtime = () => capturedRuntime as unknown as FakeSceneRuntime
    await buildSketchOnFace(runtime())

    expect(runtime().orientNormalToPlaneCalls.length).toBe(1)
    const orientedFrame = runtime().orientNormalToPlaneCalls[0].frame
    expect(orientedFrame.normal.z).toBeCloseTo(1, 6) // the top face's real normal

    expect(runtime().setCameraPoseCalls.length).toBe(0)
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    // User never orbited -- Finish restores the SAVED (pre-entry) pose.
    expect(runtime().setCameraPoseCalls.length).toBe(1)
  }, 40_000)

  it('Finish does NOT restore the camera once the user has actually orbited (Q6: "unless the user moved it")', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    const runtime = () => capturedRuntime as unknown as FakeSceneRuntime
    await buildSketchOnFace(runtime())

    runtime().simulateUserOrbit() // the real runtime sets this from OrbitControls' own 'start' event
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    expect(runtime().setCameraPoseCalls.length).toBe(0)
  }, 40_000)

  it('nothing about the sketch camera session is persisted to the document archive', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await buildSketchOnFace(capturedRuntime as unknown as FakeSceneRuntime)
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))

    const dag = hooks().dag
    const bytes = createDocumentArchive({ dag, elementMapDeltas: [] })
    const archive = unzipSync(bytes)
    const text = Object.keys(archive)
      .map((path) => strFromU8(archive[path]))
      .join('\n')
    // No camera/pose/orbit vocabulary anywhere in the saved archive's own
    // JSON entries --
    // the transient camera session lives ENTIRELY in sceneRuntime + this
    // page's own refs, never touching dag/persist (Operator rejected
    // camera-persist 2026-07-02; this is a structural, not incidental,
    // guarantee -- see sceneRuntime.ts's own SceneRuntime doc comment).
    expect(text.toLowerCase()).not.toMatch(/camera|orbit|cameraPose/i)
  }, 40_000)
})
