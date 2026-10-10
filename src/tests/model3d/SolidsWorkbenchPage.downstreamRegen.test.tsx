// @vitest-environment jsdom
//
// WO SKC-5-R1 Finding 3 (MAJOR, audit verbatim): "AC #2 is tested weaker than
// the criterion states... does not prove downstream regen of an extrude from
// that sketch lands on the moved face." REQUIRED (audit's suggestedFix): an
// integration test that creates a face-bound sketch, creates a downstream
// extrude from its profile, edits/regenerates the parent so the source face
// moves, and asserts the downstream extrude uses the MOVED ProfileRegion
// plane rather than the stale one.
//
// Drives the REAL SolidsWorkbenchPage against the REAL local geom kernel
// (createLocalGeomService, same seam sketchOnFace's own real-kernel UI test
// uses) end to end: SK1 (2D rect) -> F1 (extrude, real body) -> Sketch on
// face (F1's top) -> datum:SK2 + sketch3d:SK2 -> F2 (extrude FROM the face
// sketch's profile, the "downstream extrude"). Then F1's OWN distance is
// edited (grows the box taller, moving its top face) and F2's real
// tessellated Z range is compared before/after: if F2 stayed at the stale
// pre-edit Z range, the downstream extrude used a stale plane (a real
// staleness bug); if it shifted by the SAME delta F1's top face moved, the
// datum -> sketch3d -> F2 consumes-chain propagated correctly end to end.

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

/** min/max world-Z across a tessellated body's real vertex positions
 *  (Float32Array of xyz triplets) -- the honest way to read back "where did
 *  this body actually land" without trusting anything cached client-side. */
async function zRange(featureId: string): Promise<{ min: number; max: number }> {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`downstreamRegen test: no body handle for '${featureId}'`)
  const tess = await hooks().client.tessellate(handle, { deflection: 0.1 })
  let min = Infinity
  let max = -Infinity
  for (let i = 2; i < tess.position.length; i += 3) {
    const z = tess.position[i]
    if (z < min) min = z
    if (z > max) max = z
  }
  return { min, max }
}

describe('SolidsWorkbenchPage: downstream regen follows a moved parent face (WO SKC-5-R1 Finding 3, AC #3)', () => {
  it('editing the parent extrude moves its top face; the downstream extrude built on the face sketch follows it, not a stale plane', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    const runtime = () => capturedRuntime as unknown as FakeSceneRuntime
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // --- 1. SK1 (2D rect) -> F1 (real extrude body, top face at z=20) ------
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // --- 2. Sketch on F1's top face -> datum:SK2 + sketch3d:SK2 ------------
    runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy(), { timeout: 20_000 })
    const canvas = screen.getByTestId('solids-workbench-canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.click(screen.getByTestId('workbench-package-tool-project'))
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 300, button: 0 })
    await waitFor(() => {
      const payload = hooks().dag.getNode('sketch3d:SK2')!.payload as { sketch?: { entities: unknown[] } }
      expect(payload.sketch?.entities.length).toBeGreaterThan(0)
    })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull()

    // --- 3. The DOWNSTREAM extrude, built FROM the face sketch's profile ---
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'sketch3d:SK2' } })
    commitField('extrude-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const before = await zRange('F2')
    // F1's top face sits at z=20 (offset-free box height) -- F2 is a 5mm
    // slab off of it, so its real tessellated Z range should read near
    // [20, 25], never negative/zero (sanity: this IS the face sketch's body,
    // not some leftover default-origin extrude).
    expect(before.min).toBeGreaterThan(15)
    expect(before.max).toBeLessThan(30)

    // --- 4. Edit F1 (the PARENT): grow its extrude distance 20 -> 35 -------
    // its top face -- the datum's referenced face -- moves from z=20 to z=35.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    commitField('extrude-distance', '35')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(async () => expect((await zRange('F1')).max).toBeCloseTo(35, 0), { timeout: 20_000 })

    // --- 5. AC #3: the downstream extrude (F2) must land on the MOVED plane,
    // not the stale pre-edit one -- shifted by the SAME +15 delta F1's top
    // face moved, never still sitting at the old [20, 25] range.
    let after: { min: number; max: number } = { min: NaN, max: NaN }
    await waitFor(
      async () => {
        after = await zRange('F2')
        expect(after.min).toBeCloseTo(before.min + 15, 0)
        expect(after.max).toBeCloseTo(before.max + 15, 0)
      },
      { timeout: 20_000 },
    )
    // Explicit stale-plane guard (would catch the exact regression the audit
    // flagged: F2 quietly still occupying its OLD z range post-edit).
    expect(Math.abs(after.min - before.min)).toBeGreaterThan(5)
  }, 40_000)
})
