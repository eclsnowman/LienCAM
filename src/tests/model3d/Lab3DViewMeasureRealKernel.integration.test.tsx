// @vitest-environment jsdom
//
// WO INT-1-R1.2 (rework of a MAJOR audit finding): "Face area is
// mesh-derived, not kernel-exact... ACCEPTANCE: test on the analytic
// fixture... asserts the displayed value equals the kernel measure within
// 1e-6 relative -- a mesh-approximation regression must fail it."
//
// Lab3DViewMeasure.test.tsx proves the WIRING (instant preview -> kernel
// swap) against a fake client. This file proves the same end-to-end path
// against the REAL occt-wasm kernel (createLocalGeomService -- same engine
// as the browser worker, no Worker/postMessage indirection, so it stays a
// fast in-process jsdom test): render the real Lab3DView, click its demo
// body's top face, and assert the measure panel settles on EXACTLY what an
// independently-built copy of that same body reports for the ID-SCOPED
// session.measure('area', [faceId]) (BK-20 landed via GEO-3, 2026-07-08 --
// the pre-GEO-3 revision of this file used the whole-body oracle and the
// 'Body surface' stopgap label). The independent copy is a legitimate
// oracle, not a tautology: it is built via a SEPARATE GeomBridgeSession/client instance,
// through the same createCutBox() op with the same featureId/sizes --
// deterministic kernel, same inputs -> same output (geom-service.ts
// contract rule 5).

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { DEMO_BOX_SIZE, DEMO_TOOL_SIZE, Lab3DView } from '../../components/model3d/Lab3DView'
import { createLocalGeomService } from '../../geom'
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('Lab3DView face-area measure against the REAL kernel (WO INT-1-R1.2)', () => {
  it('settles on the kernel measure("area",[faceId]) value, not the mesh-derived approximation', async () => {
    const truthClient = createLocalGeomService()
    const truthSession = new GeomBridgeSession(truthClient)
    await truthSession.init()
    await truthSession.createCutBox('ground-truth', {
      featureId: 'DEMO',
      size: DEMO_BOX_SIZE,
      toolFeatureId: 'DEMO_TOOL',
      toolSize: DEMO_TOOL_SIZE,
    })
    // BK-20 landed (GEO-3): the oracle is now the ID-SCOPED face area. Pick
    // the same face the UI's overridden ray will hit (x=30, y=15, straight
    // down onto the remaining top-face material) and measure THAT face.
    await truthSession.tessellateProgressive('ground-truth')
    const truthHit = truthSession.pick(
      ['ground-truth'],
      { origin: { x: 30, y: 15, z: 100 }, direction: { x: 0, y: 0, z: -1 } },
      'face',
    )
    expect(truthHit?.kind).toBe('face')
    if (truthHit === null || truthHit.kind !== 'face') throw new Error('unreachable')
    const truth = await truthSession.measure('ground-truth', 'area', [truthHit.id])
    await truthSession.disposeAllBodies()
    await truthClient.terminate()

    expect(truth.value).toBeGreaterThan(0)
    // The picked top face is L-shaped (the demo cut removes the x[0,10]/
    // y[0,10] quadrant), so its id-scoped area must NOT equal the naive
    // full-rectangle mesh preview would-be value... but more importantly it
    // must differ from the WHOLE-BODY surface, or this test couldn't tell
    // an id-scoping regression (BK-20 backslide) from the real fix.
    const wholeBody = await (async () => {
      const c = createLocalGeomService()
      const s = new GeomBridgeSession(c)
      await s.init()
      await s.createCutBox('wb', { featureId: 'DEMO', size: DEMO_BOX_SIZE, toolFeatureId: 'DEMO_TOOL', toolSize: DEMO_TOOL_SIZE })
      const r = await s.measure('wb', 'area')
      await s.disposeAllBodies(); await c.terminate()
      return r.value
    })()
    expect(truth.value).not.toBeCloseTo(wholeBody, 3)

    // FIXED_RAY (fakeSceneRuntime.ts, aimed at (0,0,*) straight down) lands
    // exactly on the CUT CORNER against the REAL kernel: makeBox() places a
    // box from (0,0,0) to size (corner-based, not centered -- confirmed by
    // tessellating this same ground-truth body and reading its bounding box
    // during this test's own development), and the demo's tool box
    // (DEMO_TOOL_SIZE, corner-based too) removes a through-hole across
    // x[0,10]/y[0,10] -- (0,0) is that hole's own corner. Override the ray to
    // land well inside the REMAINING top-face material instead (x=30, y=15
    // is outside the x[0,10]/y[0,10] hole and inside the target's x[0,40]/
    // y[0,20] footprint).
    const runtime = createFakeSceneRuntime()
    runtime.rayOverride = { origin: { x: 30, y: 15, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    render(<Lab3DView createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await screen.findByTestId('body-visible-demoBody')

    fireEvent.click(screen.getByTestId('lab3d-filter-face'))
    fireEvent.pointerDown(screen.getByTestId('lab3d-canvas'))

    // Instant preview first (mesh-derived, labeled approximate) --
    // proves the two-phase behavior stayed intact against the real kernel
    // too, not just the fake.
    await waitFor(() => {
      const text = screen.getByTestId('lab3d-measure-panel').textContent ?? ''
      expect(text).toMatch(/^Face area: [\d.]+ mm\^2 \(mesh-derived/)
    })

    // FAILS-IF: a mesh-approximation regression never issues the kernel
    // call, so the panel would stay on the preview (labeled "mesh-derived")
    // forever and this waitFor would time out.
    await waitFor(
      () => {
        const text = screen.getByTestId('lab3d-measure-panel').textContent ?? ''
        expect(text).not.toMatch(/mesh-derived/)
        const match = text.match(/^Face area: ([\d.]+) mm\^2$/)
        expect(match).not.toBeNull()
        const shown = Number(match?.[1])
        // The panel must show EXACTLY the kernel value at display precision
        // (toFixed(3)): immune to magnitude, stricter than any relative
        // tolerance (satisfies the WO's 1e-6 with orders of magnitude to
        // spare at this area scale), and a mesh-approximation regression
        // (percent-scale off) can never match it.
        // (Architect-applied per R2 circuit-breaker, 2026-07-08 — audit
        // minor: prior 1e-4 relative was looser than the criterion's 1e-6.)
        expect(shown).toBe(Number(truth.value.toFixed(3)))
      },
      { timeout: 20_000 },
    )
  }, 90_000)
})
