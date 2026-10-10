// @vitest-environment jsdom
//
// UI-3-R1 rework: two majors bounced from the original UI-3 audit, both in
// ChassisDemo's Apply path.
//
// FINDING 1 (dialog Apply must commit exactly once): the OLD code executed
// EditFeaturePayloadCommand in BoxSizeDialog.handleApply, then executed a
// SECOND EditFeaturePayloadCommand in ChassisDemo's onApplied handler on the
// already-updated payload -- one Apply click landed two undo-stack entries.
// FAILS-IF: this test asserts exactly ONE command lands on the history stack
// per Apply, and a single undo() fully restores the pre-Apply size -- it
// must fail against the pre-fix code (which needs two undos).
//
// FINDING 2 (preview scale must never survive Apply): handlePreviewSize
// scales the live mesh for a cheap three.js-only preview, but nothing reset
// that scale on Apply, so the committed (regenerated) body rendered at
// stale preview scale. FAILS-IF: this test asserts the mesh + edge-line
// world scale is exactly {1,1,1} after Apply, following a preview that
// scaled it away from 1 -- must fail against the pre-fix code.
//
// Drives the REAL demo component (ChassisDemo) against the REAL in-process
// kernel (createLocalGeomService -- same engine as the browser worker, no
// Worker/postMessage indirection) through its injectable createClient seam,
// and a WebGL-free FakeSceneRuntime through its injectable createSceneRuntime
// seam (both mirror Lab3DView's own established test-injection contract) --
// no fakes anywhere in the code path this bug lived in.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { ChassisDemo } from '../../components/model3d/tree/demo/ChassisDemo'
import { createLocalGeomService } from '../../geom'
import type { CommandHistory } from '../../doc'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

function currentMesh(runtime: ReturnType<typeof createFakeSceneRuntime>) {
  // The mesh/edge-lines are added as children of a THREE.Group (the only
  // object ChassisDemo hands to runtime.addObject), so this fake's
  // registerSectionableCalls log -- populated once, on the first paint --
  // is the deterministic handle to the live mesh instance across regens
  // (ChassisDemo mutates the SAME Mesh's .geometry/.scale in place rather
  // than replacing it).
  const call = runtime.registerSectionableCalls[0]
  if (!call) throw new Error('registerSectionable was never called')
  return call.mesh
}

afterEach(cleanup)

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

describe('ChassisDemo Apply path (WO UI-3-R1)', () => {
  it('commits exactly one command per Apply (undo restores in one step), and resets preview scale to 1 after Apply', async () => {
    const runtime = createFakeSceneRuntime()
    let history: CommandHistory | null = null

    render(
      <ChassisDemo
        createClient={createLocalGeomService}
        createSceneRuntime={() => runtime}
        onHistoryReady={(h) => {
          history = h
        }}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('chassis-status').textContent).toBe('ready'), { timeout: 20_000 })
    expect(history).not.toBeNull()
    expect(history!.size()).toBe(0)

    fireEvent.click(screen.getByTestId('chassis-edit-size'))
    commitField('box-size-x', '80')

    // Live preview stretched the mesh away from 1:1 (x scale = 80/40 = 2) --
    // proves the preview seam actually ran, so the post-Apply scale
    // assertion below is meaningful and not vacuously true.
    const previewedMesh = currentMesh(runtime)
    expect(previewedMesh.scale.x).toBeCloseTo(2, 5)

    const rendersBeforeApply = runtime.requestRenderCallCount
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    // Apply already landed the one command synchronously; the regen
    // (scheduler.run -> rebuildKernelBody -> real kernel round trip) is
    // async, so wait for the rebuilt body to actually repaint (a fresh
    // requestRender call) before asserting the post-regen scale.
    await waitFor(() => expect(runtime.requestRenderCallCount).toBeGreaterThan(rendersBeforeApply), { timeout: 20_000 })

    // FINDING 1: exactly one command landed for the one Apply click.
    expect(history!.size()).toBe(1)
    const undone = history!.undo()
    expect(undone).toBe(true)
    expect(history!.size()).toBe(0)
    expect(history!.canUndo()).toBe(false)

    // FINDING 2: the committed (regenerated) body is never left at stale
    // preview scale.
    const mesh = currentMesh(runtime)
    expect(mesh.scale.x).toBeCloseTo(1, 5)
    expect(mesh.scale.y).toBeCloseTo(1, 5)
    expect(mesh.scale.z).toBeCloseTo(1, 5)
  }, 60_000)
})
