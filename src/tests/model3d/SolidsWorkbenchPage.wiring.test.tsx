// @vitest-environment jsdom
//
// WO INT-4A acceptance #1-#4: drives the REAL SolidsWorkbenchPage against the
// REAL in-process kernel (createLocalGeomService -- same engine as the
// browser worker, no Worker/postMessage indirection, same precedent as
// ChassisDemo.applyOnce.test.tsx) through its actual UI affordances --
// button clicks and NumericInput commits, never calling makeExtrude/
// makeRevolve/applyBoolean/exportStep directly -- proving the full M4 chain
// end to end:
//   sketch -> extrude -> revolve -> boolean-combine -> STEP export/reimport
// plus undo/redo and a parametric driving-value edit with a numeric
// (not visual) assertion on the rebuilt volume.
//
// window.__solidsWorkbenchHooks (SolidsWorkbenchPage.tsx) is used ONLY to
// read back kernel state (body handles, run a measure/export/import) that a
// UI click alone doesn't expose synchronously -- every DOCUMENT mutation in
// this test goes through a real fireEvent click/commit on the real dialogs.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

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

describe('SolidsWorkbenchPage M4 chain wiring (WO INT-4A, real occt-wasm kernel)', () => {
  it('sketch -> extrude -> revolve -> boolean -> STEP export/reimport, plus undo/redo and a parametric edit proof', async () => {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // --- 1. Sketch a profile (XY plane, for the extrude) -------------------
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    // --- 2. Extrude it into a solid -----------------------------------------
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const extrudeHandle1 = hooks().getBodyHandle('F1')!
    const vol1 = await hooks().client.measure(extrudeHandle1, 'volume')
    // rectangle 40x20, blind distance 20 -> 40*20*20 exact.
    expect(Math.abs(vol1.value - 16000) / 16000).toBeLessThan(1e-6)

    // --- 3. A second sketch (XZ plane, offset clears the revolve axis) -----
    await mintRectangleSketch({ width: '40', height: '20', offset: '10', plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())

    // --- 4. Revolve it into a second solid (full 360 about world Z) --------
    fireEvent.click(screen.getByTestId('workbench-revolve'))
    fireEvent.change(screen.getByTestId('revolve-profile-select'), { target: { value: 'SK2' } })
    commitField('revolve-angle', '360')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const revolveHandle = hooks().getBodyHandle('F2')!
    const vol2 = await hooks().client.measure(revolveHandle, 'volume')
    // Pappus: full revolve of a rectangle [rIn=10, rOut=50] x height 20 about
    // the axis it's offset from -> pi*(rOut^2 - rIn^2)*height, exact.
    const expectedRevolveVol = Math.PI * (50 * 50 - 10 * 10) * 20
    expect(Math.abs(vol2.value - expectedRevolveVol) / expectedRevolveVol).toBeLessThan(1e-6)

    // --- 5. Boolean-combine the two bodies (subtract) -----------------------
    // BooleanDialog defaults to subtract; Union and Intersect use the same
    // history-producing kernel and regeneration path.
    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'F1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'F2' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    // Consumed bodies stay in history but do not appear as extra live body
    // rows (UI-6X / Operator B4); the boolean result is the sole row.
    await waitFor(() => {
      expect(screen.queryByTestId('body-row-F1')).toBeNull()
      expect(screen.queryByTestId('body-row-F2')).toBeNull()
      expect(screen.getByTestId('body-row-F3')).toBeTruthy()
    })

    const cutHandle = hooks().getBodyHandle('F3')!
    const cutVol = await hooks().client.measure(cutHandle, 'volume')
    // F1 (the target) and F2 (the tool) genuinely overlap but neither
    // contains the other, so cut removes SOME but not all of F1's material --
    // assert the honest bound (0 < result <= target) rather than a fragile
    // exact figure for a non-trivial intersection region.
    expect(cutVol.value).toBeGreaterThan(0)
    expect(cutVol.value).toBeLessThanOrEqual(vol1.value + 1e-6)

    // --- 6. STEP export -> reimport round trip (acceptance #4) --------------
    // Reimports through the SAME already-initialized kernel instance (spinning
    // up a second occt-wasm module just to prove importStep() works would
    // duplicate src/tests/geom/step-import.test.ts's own coverage of the
    // engine-level round trip for real WASM init cost with no added signal --
    // the point here is that the WORKBENCH's exported bytes are genuinely
    // re-importable, which this exercises exactly).
    const bytes = await hooks().exportStep(['F3'])
    expect(bytes.byteLength).toBeGreaterThan(0)
    const roundTrip = await hooks().client.importStep(bytes, 'ROUNDTRIP')
    expect(roundTrip.diagnostics.find((d) => d.severity === 'error')).toBeUndefined()
    expect(roundTrip.bodies).toHaveLength(1)
    const reimportedVol = await hooks().client.measure(roundTrip.bodies[0].handle, 'volume')
    expect(Math.abs(reimportedVol.value - cutVol.value) / cutVol.value).toBeLessThan(1e-3)

    // --- 7. Undo the boolean: F3 disappears, F1/F2 become visible again ----
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F3')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => {
      expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true)
      expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(true)
    })

    // --- 8. Redo restores the boolean feature -------------------------------
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(screen.getByTestId('feature-row-F3')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    // --- 9. Parametric edit: bind the extrude distance to a DRIVING
    // expression via the edit path (WO INT-4A-R1.1 -- this exercises the
    // dimensionBinding-bound path, not a raw numeric field: the workbench's
    // regen executor evaluates '5*7' through the SAME DOC-4 parser/evaluator
    // src/sketch3d/dimensionBinding.ts reuses, every regen pass, not once at
    // Apply-time).
    fireEvent.click(screen.getByTestId('workbench-undo')) // undo the boolean again so F1 is independently measurable
    await waitFor(() => expect(screen.queryByTestId('feature-row-F3')).toBeNull(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    fireEvent.change(screen.getByTestId('extrude-distance-expression'), { target: { value: '5*7' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(async () => {
      const handle = hooks().getBodyHandle('F1')
      if (handle === undefined) throw new Error('F1 not rebuilt yet')
      const v = await hooks().client.measure(handle, 'volume')
      // 40*20*35 exact -- the rebuilt solid, not the pre-edit one.
      expect(Math.abs(v.value - 28000) / 28000).toBeLessThan(1e-6)
    }, { timeout: 20_000 })
  }, 90_000)
})
