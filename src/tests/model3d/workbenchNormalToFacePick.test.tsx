// @vitest-environment jsdom
//
// WO UI-23 (C3) + UI-23-R1 (audit finding 3, "non-production tests"): "N" ->
// one-shot normal-to-face pick, driven against the REAL SolidsWorkbenchPage +
// REAL in-process kernel (createLocalGeomService) -- same real-kernel
// sketch+extrude prelude SolidsWorkbenchPage.pushPull.test.tsx uses to get
// one real, raycastable body mesh into the scene, with THREE/WebGL faked at
// the scene-runtime boundary (createFakeSceneRuntime, real THREE.Scene
// underneath -- a real THREE.Raycaster against it hits real geometry, AND
// (R1 fix) orientNormalToPoint now also runs the REAL production camera math
// (applyOrientNormalToPoint) against the fake's own real THREE.Camera -- see
// fakeSceneRuntime.ts -- so the assertions below read the FINAL camera pose,
// not just the recorded call arguments).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

function hooks(): SolidsWorkbenchHooks {
  return (window as unknown as { __solidsWorkbenchHooks: SolidsWorkbenchHooks }).__solidsWorkbenchHooks
}

function commitField(testId: string, value: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function harness() {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    runtime = rt
    return rt
  }
  return { createSceneRuntime, runtime: () => runtime as unknown as FakeSceneRuntime }
}

/** Renders the page against the REAL kernel and builds a 40x20 rectangle
 *  extruded 12mm (top face at z=12, footprint x in [-20,20], y in [10,30]
 *  per the 'sketch-offset' -- mirrors SolidsWorkbenchPage.pushPull.test.tsx's
 *  own renderBoxArmPick prelude exactly, since it's already proven to land a
 *  real raycastable body mesh in meshesRef). */
async function renderWithBox(h: ReturnType<typeof harness>): Promise<void> {
  render(<SolidsWorkbenchPage createClient={() => createLocalGeomService()} createSceneRuntime={h.createSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '12')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(hooks().getBodyGeometryHash('F1')).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })
}

describe('WO UI-23 (C3): "N" one-shot normal-to-face pick', () => {
  it('N arms the mode (hint bar shows); clicking the top face orients the camera normal to it and disarms', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    h.runtime().rayOverride = { origin: { x: 10, y: 20, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    expect(h.runtime().orientNormalToPointCalls).toHaveLength(1)
    const call = h.runtime().orientNormalToPointCalls[0]
    expect(call.point.z).toBeCloseTo(12, 1) // the top face
    expect(call.normal.x).toBeCloseTo(0, 6)
    expect(call.normal.y).toBeCloseTo(0, 6)
    expect(call.normal.z).toBeCloseTo(1, 6) // top face normal = +Z

    // WO UI-23-R1 (audit finding 3): the REQUIRED final camera pose, produced
    // by the REAL applyOrientNormalToPoint production function (not a
    // recorded-args stand-in) -- dot(viewDir, normal) ~ -1 (camera looks
    // straight down the face normal) and the orbit target lands ON the face.
    const pose = h.runtime().getCameraPose()
    expect(pose.target.z).toBeCloseTo(12, 1)
    const viewDir = new THREE.Vector3(pose.target.x - pose.position.x, pose.target.y - pose.position.y, pose.target.z - pose.position.z).normalize()
    const normal = new THREE.Vector3(call.normal.x, call.normal.y, call.normal.z)
    expect(viewDir.dot(normal)).toBeCloseTo(-1, 6)

    // One-shot: disarmed after the successful pick.
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  it('a MISS (ray past the body and any plane glyph) is a silent no-op -- stays armed', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'N' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    // Aimed far outside both the body's footprint and the plane glyphs' extent.
    h.runtime().rayOverride = { origin: { x: 5000, y: 5000, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    expect(h.runtime().orientNormalToPointCalls).toHaveLength(0)
    // Still armed: the user can just try again.
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()
  })

  it('Escape cancels cleanly -- hint bar disappears, no orphaned pick mode, no camera move', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()

    // A click after Escape must NOT still be interpreted as an armed pick
    // (the mode is fully retired, not just visually hidden).
    h.runtime().rayOverride = { origin: { x: 10, y: 20, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    expect(h.runtime().orientNormalToPointCalls).toHaveLength(0)
  })

  it('the Cancel button in the hint bar disarms exactly like Escape', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    fireEvent.click(screen.getByTestId('workbench-cancel-npick'))
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  it('clicking a base-plane GLYPH (outside the body\'s footprint) orients normal to that plane -- works on plane glyphs too', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    // x=35,y=35 is outside the 40x20 rectangle's footprint (so the body mesh
    // cannot occlude it) but inside the XY plane glyph's +-40mm fill quad
    // (genesisGlyphs.ts's PLANE_HALF_MM) -- the ONLY raycastable object left
    // under this ray is the plane glyph.
    h.runtime().rayOverride = { origin: { x: 35, y: 35, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    expect(h.runtime().orientNormalToPointCalls).toHaveLength(1)
    const call = h.runtime().orientNormalToPointCalls[0]
    expect(call.point.z).toBeCloseTo(0, 6) // the XY plane sits at z=0
    expect(call.normal.z).toBeCloseTo(1, 6) // XY plane normal = +Z
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull() // one-shot disarm
  })

  it('"N" does not arm while Push/Pull is already armed (mutual exclusion)', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  // WO UI-23-R1 (audit finding 2, "N-mode orphan arming"): the audit's own
  // named gap -- "N-to-face can remain armed across a tool switch" -- was
  // specifically about activeUi4Tool (Measure/Appearance) and dialogs, which
  // the mutual-exclusion guards above never checked. Four tests below cover
  // both directions for each.

  it('"N" does not arm while Measure is already active (tool switch, direction 1)', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    expect(screen.getByTestId('workbench-ui4-tool-measure').getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  it('Measure/Appearance are genuinely DISABLED while "N" is armed (tool switch, direction 2) -- prevented at the source, not just gated at dispatch', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    // anyPickModeArmed now includes nPickArmed (audit finding 2's own named
    // gap: "Measure/Appearance remain enabled while N is armed") -- a
    // disabled button's click is a DOM no-op, so this proves the two tools
    // can never BOTH read as "active" at once, the failure mode the audit
    // described. (The reverse direction -- activeUi4Tool becoming active
    // while N is armed -- is therefore unreachable via the UI at all, which
    // is the stronger guarantee; the mutual-exclusion effect's own
    // activeUi4Tool clause is defense in depth for any future path that
    // sets activeUi4Tool directly.)
    const measureButton = screen.getByTestId('workbench-ui4-tool-measure') as HTMLButtonElement
    const appearanceButton = screen.getByTestId('workbench-ui4-tool-appearance') as HTMLButtonElement
    expect(measureButton.disabled).toBe(true)
    expect(appearanceButton.disabled).toBe(true)
    fireEvent.click(measureButton)
    expect(measureButton.getAttribute('aria-pressed')).toBe('false')
    // N stays armed (the click never landed).
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()
  })

  it('"N" does not arm while a dialog (Sweep) is open (dialog-open, direction 1)', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    expect(screen.getByTestId('dialog-shell-apply')).toBeTruthy() // dialog open
    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  it('opening a dialog (Sweep) while "N" is already armed disarms "N" (dialog-open, direction 2)', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workbench-sweep'))
    expect(screen.getByTestId('dialog-shell-apply')).toBeTruthy() // dialog opened
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull() // N disarmed
  })

  // WO UI-25 (N-mode fold, MANDATORY per the UI-23-R1 audit's own major
  // finding: "the R1 suite does not commit a test for every enumerated
  // N-mode arm/disarm path ... no committed test drives the opposite
  // N-armed -> Push/Pull/dress-up transition or package-sketch begin/end").
  // The enumeration (UI-23-R1.report.json finding 2 + this audit) has FIVE
  // mutually-exclusive-with-N buckets, each with two directions: arm-guard
  // (N refuses while X active) and mutual-exclusion (X arming disarms N).
  // Tool-switch (Measure/Appearance) and dialog-open are committed above.
  // Push/Pull direction 1 (arm-guard) is committed above too. This block
  // closes every path that audit named as missing, PLUS the fillet/dress-up
  // bucket the enumeration lists but no round had tested at all.

  it('"N" does not arm while a dress-up pick (Fillet) is already armed (fillet/dress-up, direction 1)', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  it('Fillet/dress-up arming is genuinely DISABLED while "N" is armed (fillet/dress-up, direction 2) -- prevented at the source, same class as Measure/Appearance', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    const filletButton = screen.getByTestId('workbench-fillet') as HTMLButtonElement
    expect(filletButton.disabled).toBe(true)
    fireEvent.click(filletButton)
    // The click never landed: no dress-up session started, N stays armed.
    expect(screen.queryByTestId('fillet-workspace-palette')).toBeNull()
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()
  })

  it('"N" does not arm while a package-sketch session is active (sketch session, direction 1)', async () => {
    const h = harness()
    await renderWithBox(h)

    // WO SKETCH-PLANE-INWORKSPACE: enter the sketch via the in-workspace XY plane pick (no modal).
    // Aim at (5,5) on XY -- clear of the box footprint (x[-20,20], y[10,30]) so the body does not
    // occlude the plane -- rather than the shared helper's (20,20) target, which sits on the box.
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    h.runtime().rayOverride = { origin: { x: 5, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    // A live package sketch session is now mounted (WorkbenchToolRail's
    // primary "Finish sketch" action only renders while sketchMode.kind ===
    // 'package' -- this IS the "package-sketch session begin" the audit's
    // own committed-coverage gap named, not just sketchMode:'pick-face').
    expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull()
  })

  it('unified New-sketch is genuinely DISABLED while "N" is armed (sketch session, direction 2) -- prevented at the source', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    const newSketchButton = screen.getByTestId('workbench-new-sketch') as HTMLButtonElement
    expect(newSketchButton.disabled).toBe(true)
    expect(screen.queryByTestId('workbench-sketch-on-face')).toBeNull()
    fireEvent.click(newSketchButton)
    // The click never landed: the in-workspace plane pick never armed, N stays armed.
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()
  })

  it('arming Push/Pull while "N" is already armed disarms "N" (Push/Pull, direction 2) -- the ONE toolbar toggle NOT gated on nPickArmed, so this is genuinely reachable through the UI (not just a disabled-button no-op)', async () => {
    const h = harness()
    await renderWithBox(h)

    fireEvent.keyDown(window, { key: 'n' })
    expect(screen.getByTestId('solids-workbench-npick-hint')).toBeTruthy()

    // workbench-push-pull's own `disabled` expression checks sketchMode/
    // dressUpPickMode/availableBodies only -- NOT nPickArmed -- so this click
    // genuinely lands (contrast the disabled-button proofs above).
    const pushPullButton = screen.getByTestId('workbench-push-pull') as HTMLButtonElement
    expect(pushPullButton.disabled).toBe(false)
    fireEvent.click(pushPullButton)

    expect(screen.getByTestId('solids-workbench-pushpull-hint')).toBeTruthy() // Push/Pull really armed
    expect(screen.queryByTestId('solids-workbench-npick-hint')).toBeNull() // N disarmed by the mutual-exclusion effect
  })
})
