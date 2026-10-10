// @vitest-environment jsdom
//
// WO UI-13A (INT-5 gate-premise catch): drives the REAL SolidsWorkbenchPage
// against the REAL in-process kernel (createLocalGeomService, same seam
// SolidsWorkbenchPage.wiring.test.tsx already uses) through the actual
// Fillet/Chamfer/Shell/Draft toolbar toggles -- arm the pick mode, click the
// canvas (via the fake scene runtime's rayOverride, same seam
// SolidsWorkbenchPage.pushPull.test.tsx uses for its own face pick), Done,
// fill the dialog, Apply -- proving each op inserts a real feature node, the
// body updates against the real occt-wasm kernel, and undo removes it in one
// step (acceptance #1). Also proves a refused op (an infeasible fillet
// radius) surfaces its diagnostic reason on the feature row rather than a
// silent no-op (acceptance #2).
//
// Body under test: sketch (xy plane, width=40, height=20, offset=10) then
// extrude distance=20 -> a box spanning x:[10,50], y:[0,20], z:[0,20]
// (volume 16000, same fixture shape SolidsWorkbenchPage.wiring.test.tsx's own
// extrude case already proves). Edge/face rays are aimed at exact analytic
// midpoints of that box so PickEngine's edge-proximity/face-raycast tests
// resolve deterministically.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
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

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

describe('SolidsWorkbenchPage dress-up wiring (WO UI-13A, real occt-wasm kernel)', () => {
  it('Fillet: pick a top edge, apply, body updates, one undo removes it', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    const vol0 = await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')
    expect(Math.abs(vol0.value - 16000) / 16000).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/0 edges/)
    expect(screen.getByTestId('fillet-radius')).toBeTruthy()
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    // top edge y=0, x:[10,50] -- midpoint (30,0,20).
    runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    commitField('fillet-radius', '2')
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const committedFillet = hooks().dag.getNode('F2')
    const committedEdges = committedFillet?.payload.edges
    expect(Array.isArray(committedEdges)).toBe(true)
    expect(committedEdges).toHaveLength(1)
    // UI-107: edge IDs remain persisted in the replay payload, but are not
    // duplicated into DAG refs until ElementMap supports edge lineage. A
    // face-only map would resolve those edge refs as lost and falsely mark a
    // successful Fillet degraded.
    expect(committedFillet?.refs).toEqual([])
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    // Analytic fillet removal on a full-length edge: (r^2 - pi*r^2/4)*L, r=2, L=40.
    const expected = 16000 - (4 - (Math.PI * 4) / 4) * 40
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-3)

    await waitFor(() => expect(screen.queryByTestId('body-row-F1')).toBeNull())
    expect(screen.getByTestId('body-row-F2')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true))
  }, 60_000)

  it('Chamfer: pick a top edge, apply, body updates, one undo removes it', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-chamfer'))
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/0 edges/))
    expect((screen.getByTestId('chamfer-distance').querySelector('input') as HTMLInputElement).value).toMatch(/^2(\.0*)?$/)
    expect(screen.queryByTestId('solids-workbench-dressup-hint')).toBeNull()
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    // top edge x=50, y:[0,20] -- midpoint (50,10,20).
    runtime.rayOverride = { origin: { x: 50, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/1 edge/))
    commitField('chamfer-distance', '2')
    await waitFor(() => expect(screen.getByTestId('chamfer-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    // Analytic chamfer removal (exact prism): (d^2/2)*L -- this edge (x=50,
    // y:[0,20]) has length 20, d=2.
    const expected = 16000 - (4 / 2) * 20
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
  }, 60_000)

  it('Shell: pick the top face, apply, body updates, one undo removes it', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-shell'))
    expect(screen.getByTestId('shell-workspace-palette')).toBeTruthy()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect(screen.getByTestId('shell-face-count').textContent).toMatch(/0 faces to open/i)
    expect((screen.getByTestId('shell-thickness').querySelector('input') as HTMLInputElement).value).toMatch(/^2(\.0*)?$/)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('workbench-dressup-done')).toBeNull()
    // top face z=20 center (30,10,20).
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/i))
    await waitFor(() => expect(screen.getByTestId('shell-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect(hooks().getBodyPresentationVisible('__shell-preview__')).toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    // Outer(16000) - inner((40-2*2)*(20-2*2)*(20-2)) = 16000 - 36*16*18.
    const expected = 16000 - 36 * 16 * 18
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-3)
    const shellNode = hooks().dag.getNode('F2')
    expect(shellNode?.payload.removeFaces).toHaveLength(1)
    expect(shellNode?.refs).toEqual((shellNode?.payload.removeFaces as string[]).map((id) => ({ id, kind: 'face-set' })))

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
  }, 60_000)

  it('Draft: confirm a neutral face, pick a draft face, apply, and undo in one step', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-draft'))
    expect(screen.getByTestId('draft-command-card')).toBeTruthy()
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    // Bottom face z=0 supplies the neutral face and -Z pull direction.
    runtime.rayOverride = { origin: { x: 30, y: 10, z: -100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('draft-neutral-face-role').textContent).toMatch(/confirm this role/i))
    fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
    expect(screen.getByTestId('draft-face-role').textContent).toMatch(/0 draft faces selected/i)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    // front face y=0, center (30,0,10) -- pick via a horizontal ray.
    runtime.rayOverride = { origin: { x: 30, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('draft-face-role').textContent).toMatch(/1 draft face selected/i))
    await waitFor(() => expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false)
    commitField('draft-angle', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const vol1 = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    // Drafting ONE face about a neutral plane at its own base (pullDir -Z,
    // origin z=0): added volume = 0.5*H^2*tan(angleRad)*W (GEO-4-R1's own
    // measured formula), H=20 (z-extent), W=40 (x-extent of the front face).
    const angleRad = (5 * Math.PI) / 180
    const expected = 16000 + 0.5 * 20 * 20 * Math.tan(angleRad) * 40
    expect(Math.abs(vol1.value - expected) / expected).toBeLessThan(1e-3)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
  }, 60_000)

  // WO UI-16 (C2 acceptance #4, first case): drives the new pull-direction/flip/offset controls
  // with NON-DEFAULT values and asserts the built DraftFeaturePayload -- proving the dialog's
  // choices reach the feature node's payload verbatim (the executor then derives the real
  // DraftRequest.pullDir/neutralPlane from these at regen time, dressUpGeometry.ts's own
  // draftPullDir/draftNeutralPlane, backend-accept-proven separately in draft.test.ts).
  it('Draft: a non-Z neutral face remains the real face-normal source through Apply', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-draft'))
    // Front face has a real world-space Y normal, proving the workflow does
    // not silently fall back to a Z/world-axis neutral plane.
    runtime.rayOverride = { origin: { x: 30, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('draft-confirm-neutral')).toBeTruthy())
    fireEvent.click(screen.getByTestId('draft-confirm-neutral'))
    // Top face is the distinct face to draft.
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('draft-face-role').textContent).toMatch(/1 draft face selected/i))

    expect(screen.getByTestId('draft-pull-axis').textContent).toMatch(/neutral face normal/i)
    expect(screen.queryByTestId('draft-pull-axis-option-x')).toBeNull()
    fireEvent.click(screen.getByTestId('draft-pull-flip'))
    expect(screen.getByTestId('draft-pull-summary').textContent).toMatch(/selected face \(flipped\) normal/)
    commitField('draft-offset', '5')
    commitField('draft-angle', '5')

    await waitFor(() => expect(screen.getByTestId('draft-preview-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('feature-row-F2')).toBeTruthy())

    const payload = hooks().dag.getNode('F2')?.payload as {
      pullMode?: string
      pullFlip?: boolean
      offset?: number
      angleDeg?: number
      faceFrameSourceId?: string
      faceFrame?: { normal: { x: number; y: number; z: number } }
      faces?: string[]
    } | undefined
    expect(payload?.pullMode).toBe('face-normal')
    expect(payload?.pullFlip).toBe(true)
    expect(payload?.offset).toBe(5)
    expect(payload?.angleDeg).toBe(5)
    expect(payload?.faceFrameSourceId).toBeTruthy()
    expect(payload?.faces).toHaveLength(1)
    expect(payload?.faces?.[0]).not.toBe(payload?.faceFrameSourceId)
    expect(Math.abs(payload?.faceFrame?.normal.y ?? 0)).toBeGreaterThan(0.99)
    expect(Math.abs(payload?.faceFrame?.normal.z ?? 1)).toBeLessThan(0.01)
  }, 60_000)

  it('Fillet refusal: an infeasible radius surfaces its diagnostic reason on the feature row, never a silent no-op', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    // Radius far beyond the ~20mm adjacent-face extent -- guaranteed refusal
    // (same margin GEO-4's own diagnostics test uses, r=25 on a ~20mm limit).
    commitField('fillet-radius', '50')
    await waitFor(() => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('refused'), { timeout: 20_000 })
    expect(screen.getByTestId('fillet-preview-status').textContent).toMatch(/largest radius that fits/i)
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)

    // A refused preview never authors a failed feature or replaces the owner.
    expect(screen.queryByTestId('feature-row-F2')).toBeNull()
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true)
  }, 60_000)

  // WO UI-15 (B1): hover feedback on the dress-up edge/face pick paths -- one case for an EDGE
  // (fillet) and one for a FACE (shell), since B1's own enumeration calls out both entity kinds.
  it('hover (edge): pointermove while fillet is armed paints the hovered edge + shows a detail readout; leaving the mode clears both (WO UI-15 B1)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()

    // top edge y=0, x:[10,50] -- midpoint (30,0,20).
    runtime.rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const readoutText = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
    expect(readoutText).toMatch(/^Edge \S+ on /)
    const hoveredEdgeId = readoutText.match(/^Edge (\S+) on/)?.[1]
    expect(hoveredEdgeId).not.toBeUndefined()
    // FAILS-IF: removing the hover-paint call (setHover inside handlePickHover) leaves this 'none'.
    expect(hooks().getPickHighlightState(hoveredEdgeId!)).toBe('hovered')

    // Leaving the mode (Cancel) clears both the readout and the paint state.
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull())
    expect(hooks().getPickHighlightState(hoveredEdgeId!)).toBe('none')
  }, 60_000)

  it('hover (face): pointermove while shell is armed paints the hovered face + shows a detail readout (WO UI-15 B1)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-shell'))
    // top face z=20 center (30,10,20).
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const readoutText = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
    expect(readoutText).toMatch(/^Face \S+ on /)
    const hoveredFaceId = readoutText.match(/^Face (\S+) on/)?.[1]
    expect(hoveredFaceId).not.toBeUndefined()
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('hovered')
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('shell-workspace-palette')).toBeNull())
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('none')
  }, 60_000)

  // WO UI-15 (B3): accumulated dress-up picks stay visibly selected, hovering an already-picked id
  // does not overwrite its picked color (the CNCViewport refreshBrepHoverOverlay:3488 rule, ported
  // via SelectionState's own selected-beats-hovered precedence -- see pickHighlightSelectionRef's
  // doc comment in SolidsWorkbenchPage.tsx), and unpicking clears exactly the unpicked id.
  it('B3: two picked edges stay selected, a third hovered edge shows hover only, unpick clears one, hovering the still-picked one keeps its selected color (WO UI-15 B3)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-fillet'))

    // Edge A: top edge y=0, x:[10,50] -- midpoint (30,0,20).
    const rayA = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    // Edge B: top edge x=50, y:[0,20] -- midpoint (50,10,20).
    const rayB = { origin: { x: 50, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    // Edge C: top edge x=10, y:[0,20] -- midpoint (10,10,20). Never picked -- hover only.
    const rayC = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }

    function hoveredEdgeId(): string {
      const text = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
      const id = text.match(/^Edge (\S+) on/)?.[1]
      if (id === undefined) throw new Error(`hover readout did not match an edge id: "${text}"`)
      return id
    }

    // --- Pick A ---
    runtime.rayOverride = rayA
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const edgeA = hoveredEdgeId()
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    expect(hooks().getPickHighlightState(edgeA)).toBe('selected')

    // --- Pick B ---
    runtime.rayOverride = rayB
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(hoveredEdgeId()).not.toBe(edgeA))
    const edgeB = hoveredEdgeId()
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/2 edge/))
    // B3.1: BOTH picked ids carry the persistent selected highlight.
    expect(hooks().getPickHighlightState(edgeA)).toBe('selected')
    expect(hooks().getPickHighlightState(edgeB)).toBe('selected')

    // --- Hover C (never clicked) ---
    runtime.rayOverride = rayC
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(hoveredEdgeId()).not.toBe(edgeB))
    const edgeC = hoveredEdgeId()
    expect(edgeC).not.toBe(edgeA)
    expect(hooks().getPickHighlightState(edgeC)).toBe('hovered')
    // A and B are unaffected by hovering a third, unrelated edge.
    expect(hooks().getPickHighlightState(edgeA)).toBe('selected')
    expect(hooks().getPickHighlightState(edgeB)).toBe('selected')

    // --- Unpick A (click again on A; cursor/rayOverride never revisits A via pointermove first, so
    // this proves the CLICK toggle alone clears it, not a stale hover carrying it) ---
    runtime.rayOverride = rayA
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    expect(hooks().getPickHighlightState(edgeA)).toBe('none')
    expect(hooks().getPickHighlightState(edgeB)).toBe('selected')

    // --- Hover the still-picked one (B): its selected color survives the hover (the :3488 rule,
    // via SelectionState's own selected-beats-hovered precedence) ---
    runtime.rayOverride = rayB
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(hoveredEdgeId()).toBe(edgeB))
    expect(hooks().getPickHighlightState(edgeB)).toBe('selected')

    // --- Cancel closes the one-stage palette and clears the persistent selection. ---
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('fillet-edge-count')).toBeNull())
    expect(hooks().getPickHighlightState(edgeB)).toBe('none')
  }, 60_000)

  // WO SEL3D-FEEDBACK (2026-07-23, Operator urgent: "I cannot see my hovers or selections in 3d"):
  // root cause was that the DEFAULT viewport theme ('brand-blue', fat-line edge overlay --
  // viewportThemes.ts DEFAULT_VIEWPORT_THEME) renders edges through a LineSegments2 whose geometry
  // is a SEPARATE object from cachedBody.edgeGeometry (buildBodyEdgeOverlay's own header comment) --
  // applyEdgeHighlights correctly painted cachedBody.edgeGeometry's color attribute every repaint
  // (proven by every getPickHighlightState assertion in this file, including the two tests above),
  // but nothing ever copied that paint onto the geometry actually drawn on screen, and the material
  // had no vertexColors at all (a flat theme-hex color instead). getPickHighlightState alone can
  // never catch this class of bug -- it reads the SAME SelectionState instance the paint functions
  // read from, not a pixel. This test reads the RENDERED edge geometry via the new
  // getBodyEdgeColorSample seam (mirrors getBodyFaceColorSample's pre-existing contract, which
  // already exists for exactly this reason -- see its own doc comment).
  it('RENDERED edge overlay repaints on hover/select, not just the logical SelectionState (WO SEL3D-FEEDBACK)', async () => {
    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-fillet'))

    // Edge A: top edge y=0, x:[10,50] -- midpoint (30,0,20).
    const rayA = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    // Control edge (never hovered or picked): top edge x=10, y:[0,20] -- midpoint (10,10,20). Its
    // rendered color is the "rest state" baseline the hovered/selected samples must diverge from.
    const rayControl = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }

    function hoveredEdgeId(): string {
      const text = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
      const id = text.match(/^Edge (\S+) on/)?.[1]
      if (id === undefined) throw new Error(`hover readout did not match an edge id: "${text}"`)
      return id
    }

    // First learn the control edge's id (its own momentary hover state does not matter -- its REST
    // color is sampled below, AFTER the pointer has moved away onto edge A).
    runtime.rayOverride = rayControl
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const controlEdgeId = hoveredEdgeId()

    // --- Hover A (this also returns the control edge to its true rest state) ---
    runtime.rayOverride = rayA
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(hoveredEdgeId()).not.toBe(controlEdgeId))
    const edgeA = hoveredEdgeId()
    expect(hooks().getPickHighlightState(edgeA)).toBe('hovered')
    expect(hooks().getPickHighlightState(controlEdgeId)).toBe('none')

    const restColor = hooks().getBodyEdgeColorSample('F1', controlEdgeId)
    expect(restColor).not.toBeUndefined()
    // Interaction no longer mutates the resting topology color. The live
    // rendered feedback is an independent wider depth-aware stroke.
    const hoveredColor = hooks().getBodyEdgeColorSample('F1', edgeA)
    expect(hoveredColor).not.toBeUndefined()
    expect(hoveredColor).toEqual(restColor)
    expect(hooks().getBodyInteractionSnapshot('F1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'edge-stroke', depthTest: true, linewidth: 4 }),
    ]))

    // --- Select A (click) ---
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
    expect(hooks().getPickHighlightState(edgeA)).toBe('selected')
    const selectedColor = hooks().getBodyEdgeColorSample('F1', edgeA)
    expect(selectedColor).not.toBeUndefined()
    expect(selectedColor).toEqual(restColor)
    expect(hooks().getBodyInteractionSnapshot('F1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'edge-stroke', depthTest: true, linewidth: 5 }),
    ]))
    // The untouched control edge never moved off its rest color throughout.
    expect(hooks().getBodyEdgeColorSample('F1', controlEdgeId)).toEqual(restColor)

    // --- Cancel clears the render back to rest, not just the logical state ---
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(hooks().getPickHighlightState(edgeA)).toBe('none'))
    expect(hooks().getBodyEdgeColorSample('F1', edgeA)).toEqual(restColor)
    expect(hooks().getBodyInteractionSnapshot('F1')).toEqual([])
  }, 60_000)
})
