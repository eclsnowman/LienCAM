// @vitest-environment jsdom
//
// WO UI-51A-R1 (audit MAJOR 3): the original UI-51A contract required BOTH
// "a midplane extrude from an on-face sketch" and "the empty-profile sketch
// refusal", each exercised through the PAGE executor (not just the kernel
// directly, and not just a payload assertion). The audit found neither
// existed: the only on-face downstream test was a pre-existing up-direction
// case, and the only midplane test changed a payload without running page
// regen; no test drove an empty-profile sketch through the executor at all.
//
// Both scenarios here drive the REAL SolidsWorkbenchPage against the REAL
// occt-wasm kernel (createLocalGeomService, the same seam sketchOnFace.test.tsx
// and downstreamRegen.test.tsx already use for on-face work).

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
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'

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

/** min/max world-Z across a tessellated body's real vertex positions --
 *  the honest way to read back "where did this body actually land" (same
 *  helper SolidsWorkbenchPage.downstreamRegen.test.tsx uses). */
async function zRange(featureId: string): Promise<{ min: number; max: number }> {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`no body handle for '${featureId}'`)
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

describe('SolidsWorkbenchPage: extrude direction=midplane from an on-face sketch (WO UI-51A-R1 MAJOR 3)', () => {
  it('a midplane extrude built on a face-bound sketch is centered on the face plane, not degenerate, through the real page executor + kernel', async () => {
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

    // --- 2. Sketch on F1's top face -> project the face boundary ----------
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

    // --- 3. Extrude FROM the face sketch's profile with Direction=midplane -
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'sketch3d:SK2' } })
    // WO-216 (b5b5c712): 'midplane' is now implied by the 'symmetric' end
    // condition, not a directly selectable direction option (the direction
    // select is disabled once endCondition==='symmetric').
    fireEvent.change(screen.getByTestId('extrude-end-condition-select'), { target: { value: 'symmetric' } })
    commitField('extrude-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    expect(hooks().dag.getNode('F2')?.payload.direction).toBe('midplane')

    // F1's top face sits at z=20; a midplane extrude of magnitude 5 is
    // NON-DEGENERATE on an on-face sketch (preflight ruling: the engine
    // translates the profile back d/2 and sweeps d, geom-engine.ts:1267-1272)
    // -- the real body must be CENTERED on the face plane (z~[17.5, 22.5]),
    // never a one-sided [20, 25] (that would be direction=up silently
    // winning) nor collapsed to a zero-thickness slab at z=20.
    const range = await zRange('F2')
    expect(range.min).toBeCloseTo(17.5, 0)
    expect(range.max).toBeCloseTo(22.5, 0)
    expect(range.max - range.min).toBeCloseTo(5, 0)
  }, 40_000)
})

describe('SolidsWorkbenchPage: empty-profile extrude refuses BY NAME through the page executor (WO UI-51A-R1 MAJOR 3)', () => {
  it('an extrude built on a sketch with no closed profile refuses with a named diagnostic, never a silent no-op', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    const runtime = capturedRuntime as unknown as FakeSceneRuntime

    // A face-based New Sketch package left blank (no Project, no
    // drawn geometry) has NO closed profile -- exactly SKC-26B's blank-by-
    // default contract (see sketchOnFace.test.tsx step 3). Use the on-plane
    // "New sketch" -> package-sketch path and finish immediately, without
    // drawing anything, so payload.regions is never written at all.
    // "New sketch" arms the in-workspace plane pick; clicking the XY plane glyph
    // enters an EMPTY package sketch session directly on the XY base plane, with
    // no rectangle/geometry ever drawn (SKC-15B A1 entry point).
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK1')).toBeTruthy())

    const sketchPayload = hooks().dag.getNode('sketch3d:SK1')?.payload as { profile?: unknown } | undefined
    expect(sketchPayload?.profile).toBeUndefined()

    // Force an extrude feature straight onto this profile-less sketch (this
    // proves the EXECUTOR itself refuses, not merely that the dialog steers
    // around it). WO-035: the dialog can no longer be the forcing vehicle --
    // its shared preview session refuses this sketch BEFORE any commit (the
    // UI-107 contract working as designed), so the payload is forced through
    // history + regen directly, the same seam extrudeBoolean.test.tsx's
    // forced-payload case uses.
    hooks().history.execute(
      createFeatureCommand(hooks().dag, {
        id: 'F1',
        kind: 'feature',
        consumes: ['sketch3d:SK1'],
        payload: { opType: 'extrude', sketchId: 'sketch3d:SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude F1' },
      }),
    )
    await hooks().fullResync(['F1'])

    await waitFor(() => expect(hooks().scheduler.statusOf('F1')).toBe('failed'), { timeout: 20_000 })
    expect(hooks().getBodyHandle('F1')).toBeUndefined()
    const diagText = JSON.stringify(hooks().scheduler.diagnosticsOf('F1'))
    // Stable-region selection now names both the selector failure and the
    // geometric cause instead of collapsing every refusal to "missing profile".
    expect(diagText).toMatch(/profile selector regions-unavailable/)
    expect(diagText).toMatch(/no longer has a closed profile/i)

    // The named refusal surfaces on the feature row -- never a silent no-op.
    const badge = screen.getByTestId('feature-row-F1').querySelector('[data-testid="feature-status-badge"]')
    expect(badge?.getAttribute('data-status')).toBe('failed')
  }, 40_000)
})
