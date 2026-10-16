// @vitest-environment jsdom
//
// WO SKC-5: drives the REAL SolidsWorkbenchPage (real occt-wasm kernel, real
// planegcs solve service) through the unified "New sketch" UI affordance
// -- button click, canvas click (picking via a controllable fake scene
// runtime ray, same seam SolidsWorkbenchPage.wiring.test.tsx's own fake
// picking uses), Finish Sketch -- proving the face-pick entry point end to
// end through the real component, not just the backend modules directly.

// WO SKC-15C (THE SEVERING) -- why `workbench-finish-package-sketch` and not `workbench-finish-sketch`:
// this file used to drive the INLINE sketch session, whose Finish button carried the latter testid.
// Sketch-on-face now enters THE Sketcher package session, whose Finish carries the former. The old id
// no longer exists in the page AT ALL, deliberately: a stale caller reaching for it goes red rather
// than silently driving a different sketcher. Nothing else in this file's assertions changed.
// WO SKC-15C: sketch-on-face now opens THE Sketcher package session, whose constraint badges need a
// 2D canvas context jsdom does not have. See stubCanvas2d.ts -- environment gap, nothing asserted on.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import { workbenchSketchDocumentPort } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import {
  WORKBENCH_ORIGIN_ENTITY_ID,
  WORKBENCH_INJECTED_ENTITY_IDS,
} from '../../components/model3d/workbench/workbenchOriginAnchor'
import { sketcherToolStore } from '../../lib/sketch/sketcher'
import { mintRectangleSketch } from './mintRectangleSketch'
import { useCamStore } from '../../store'
import { INTERACTION_HOVER_ORANGE } from '../../viewport3d'

function workbenchConsoleMessages(): string[] {
  return useCamStore.getState().consoleEvents.filter((e) => e.source === 'workbench').map((e) => e.message)
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  // WO-270: the selection-glow pin that used to sit here is gone with the
  // setting; the one shipped glow is what this suite now renders under.
  restoreCanvas2d = stubCanvas2d()
})
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

describe('SolidsWorkbenchPage: sketch on face (WO SKC-5, real occt-wasm kernel + real planegcs)', () => {
  it('face entry is blank until explicit Project / Use, then the real projected profile extrudes', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }

    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // --- 1. Build a real body to pick a face on -----------------------------
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // --- 2. Aim the pick ray straight down through the footprint's center --
    // Rectangle spans x:[10,50] y:[0,20] (offset 10, width 40, height 20) --
    // a downward ray through its center hits the top face first regardless
    // of which end of the extrude the kernel calls "top".
    expect(capturedRuntime).not.toBeNull()
    ;(capturedRuntime as unknown as FakeSceneRuntime).rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    // --- 3. Select the face first, then invoke unified New sketch ----------
    // SKC-63 regression: Operator's real sequence is selection -> command. The
    // owning body remains the tree selection while the stable face selection
    // is retained for the command to consume.
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    expect(hooks().bridgeSession?.selection.selection.size).toBe(1)

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))

    // WO SKC-5-R1 (Finding 2): Q1's approved default is "no datum tree row
    // in V1" -- the auto-created face-plane datum is reachable/visible, but
    // FOLDED under its consuming sketch row, never a top-level row of its
    // own. data-folded-under is FeatureTree's structural proof of that (the
    // audit originally flagged this test for asserting bare visibility with
    // no fold check at all).
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy())
    expect(screen.getByTestId('feature-row-datum:SK2').getAttribute('data-folded-under')).toBe('sketch3d:SK2')
    // Camera entered the transient normal-to-plane session (Q6).
    expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy()
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()

    // SKC-26B blank-by-default contract: the persisted CAM payload contains
    // no boundary, constraints, or association before an explicit Project.
    const freshNode = hooks().dag.getNode('sketch3d:SK2')!
    const freshPayload = freshNode.payload as {
      sketch: { entities: unknown[]; constraints: unknown[] }
      externalRefs?: unknown[]
    }
    expect(freshPayload.sketch.entities).toEqual([])
    expect(freshPayload.sketch.constraints).toEqual([])
    expect(freshPayload.externalRefs ?? []).toEqual([])
    expect(sketcherToolStore.getState().tool).toBe('line')

    // The SKC-22 origin (+ WO SKC-49's axis pair) is session-only: present in the active document
    // but deliberately absent from the persisted payload asserted above.
    const activeBeforeProject = sketchSessionStore.getState().sketch
    expect(activeBeforeProject?.entities.filter((entity) => entity.id === WORKBENCH_ORIGIN_ENTITY_ID)).toHaveLength(1)
    expect(activeBeforeProject?.entities.filter((entity) => WORKBENCH_INJECTED_ENTITY_IDS.has(entity.id))).toHaveLength(3)

    // Explicit direct-manipulation Project / Use. The same source face ray
    // used for entry now resolves through the package-owned pointer gesture.
    const canvas = screen.getByTestId('solids-workbench-canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.click(screen.getByTestId('workbench-package-tool-project'))
    expect(sketcherToolStore.getState().tool).toBe('project')

    // R2 primary command-boundary gate: observe the live port without replacing either behavior.
    // The alternate event paths below must remain inert before the one browser-faithful gesture.
    const resolverSpy = vi.spyOn(workbenchSketchDocumentPort, 'resolveProjectSource')
    const appendSpy = vi.spyOn(workbenchSketchDocumentPort, 'append')
    const historyBeforeProject = hooks().history.size()
    const persistedProjectSnapshot = (): string => {
      const payload = hooks().dag.getNode('sketch3d:SK2')!.payload as typeof freshPayload
      return JSON.stringify({ sketch: payload.sketch, externalRefs: payload.externalRefs ?? [] })
    }
    const blankProjectSnapshot = persistedProjectSnapshot()
    const expectNoProjectCommand = (): void => {
      expect(resolverSpy).not.toHaveBeenCalled()
      expect(appendSpy).not.toHaveBeenCalled()
      expect(hooks().history.size()).toBe(historyBeforeProject)
      expect(persistedProjectSnapshot()).toBe(blankProjectSnapshot)
    }
    const point = { clientX: 400, clientY: 300 }

    // A browser click without its pointer gesture is not a package command.
    fireEvent.click(canvas, { ...point, button: 0 })
    expectNoProjectCommand()

    // Dispatching on the positioned canvas ancestor cannot descend into the canvas pointer owner.
    const canvasAncestor = canvas.parentElement
    if (canvasAncestor === null) throw new Error('solids workbench canvas ancestor is missing')
    fireEvent.pointerMove(canvasAncestor, point)
    fireEvent.pointerDown(canvasAncestor, { ...point, button: 0 })
    fireEvent.pointerUp(canvasAncestor, { ...point, button: 0 })
    fireEvent.mouseMove(canvasAncestor, point)
    fireEvent.mouseDown(canvasAncestor, { ...point, button: 0 })
    fireEvent.mouseUp(canvasAncestor, { ...point, button: 0 })
    fireEvent.click(canvasAncestor, { ...point, button: 0 })
    expectNoProjectCommand()

    // Compatibility mouse events, legacy touch events, context-menu activation, and keyboard
    // activation have no Project commit authority. PointerEvents remain the one accepted path.
    fireEvent.mouseMove(canvas, point)
    fireEvent.mouseDown(canvas, { ...point, button: 0 })
    fireEvent.mouseUp(canvas, { ...point, button: 0 })
    fireEvent.click(canvas, { ...point, button: 0 })
    fireEvent.touchStart(canvas, { touches: [point], changedTouches: [point] })
    fireEvent.touchMove(canvas, { touches: [point], changedTouches: [point] })
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [point] })
    fireEvent.pointerDown(canvas, { ...point, button: 2 })
    fireEvent.pointerUp(canvas, { ...point, button: 2 })
    fireEvent.contextMenu(canvas, { ...point, button: 2 })
    fireEvent.keyDown(canvas, { key: 'Enter', code: 'Enter' })
    fireEvent.keyUp(canvas, { key: 'Enter', code: 'Enter' })
    fireEvent.keyDown(canvas, { key: ' ', code: 'Space' })
    fireEvent.keyUp(canvas, { key: ' ', code: 'Space' })
    expect(sketcherToolStore.getState().tool).toBe('project')
    expectNoProjectCommand()

    // The actual browser tail: preview, primary press/release, then the bubbled click.
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 300 })
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 300, button: 0 })
    fireEvent.click(canvas, { clientX: 400, clientY: 300, button: 0 })
    await waitFor(() => {
      const projected = (hooks().dag.getNode('sketch3d:SK2')!.payload as typeof freshPayload).sketch
      expect(projected.entities.length).toBeGreaterThan(0)
      // WO-1476: a closed profile carries one fix per entity plus one joint coincident per entity.
      expect(projected.constraints).toHaveLength(projected.entities.length * 2)
    })
    const projected = (hooks().dag.getNode('sketch3d:SK2')!.payload as typeof freshPayload).sketch as {
      entities: Array<{ id: string; construction?: boolean }>
      constraints: Array<{ id: string; kind?: string; entityId?: string }>
    }
    expect(resolverSpy).toHaveBeenCalledTimes(2)
    expect(appendSpy).toHaveBeenCalledTimes(1)
    expect(hooks().history.size()).toBe(historyBeforeProject + 1)

    const appendedCommit = appendSpy.mock.calls[0]?.[0]
    if (appendedCommit === undefined) throw new Error('Project append commit was not captured')
    const appendedEntityIds = appendedCommit.entities.map((entity) => entity.id)
    const appendedConstraintIds = appendedCommit.constraints.map((constraint) => constraint.id)
    const projectedEntityIds = projected.entities.map((entity) => entity.id)
    const projectedConstraintIds = projected.constraints.map((constraint) => constraint.id)
    expect(appendedEntityIds.length).toBeGreaterThan(0)
    expect(appendedConstraintIds).toHaveLength(appendedEntityIds.length * 2)
    expect(projectedEntityIds).toEqual(appendedEntityIds)
    expect(projectedConstraintIds).toEqual(appendedConstraintIds)
    expect(new Set(projectedEntityIds).size).toBe(projectedEntityIds.length)
    expect(new Set(projectedConstraintIds).size).toBe(projectedConstraintIds.length)
    expect(new Set([...projectedEntityIds, ...projectedConstraintIds]).size).toBe(
      projectedEntityIds.length + projectedConstraintIds.length,
    )
    expect(projected.entities.every((entity) => entity.construction === false)).toBe(true)
    const projectedFixes = projected.constraints.filter((constraint) => constraint.kind === 'fix')
    expect(projectedFixes.map((constraint) => constraint.entityId)).toEqual(projectedEntityIds)
    expect(projected.constraints.filter((constraint) => constraint.kind === 'coincident')).toHaveLength(
      projectedEntityIds.length,
    )

    // The trailing click event cannot replay the already-completed pointer gesture.
    const committedProjectSnapshot = persistedProjectSnapshot()
    fireEvent.click(canvas, { ...point, button: 0 })
    expect(resolverSpy).toHaveBeenCalledTimes(2)
    expect(appendSpy).toHaveBeenCalledTimes(1)
    expect(hooks().history.size()).toBe(historyBeforeProject + 1)
    expect(persistedProjectSnapshot()).toBe(committedProjectSnapshot)

    // --- 4. Finish sketch, then extrude the face-based sketch --------------
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull()

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'sketch3d:SK2' } })
    commitField('extrude-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const handle = hooks().getBodyHandle('F2')!
    const vol = await hooks().client.measure(handle, 'volume')
    // The projected boundary is the SAME 40x20 rectangle the top face has --
    // extruding it 5mm should read close to 40*20*5 = 4000 (within the real
    // tessellation/solve's own tolerance, not hand-rolled geometry).
    expect(Math.abs(vol.value - 4000) / 4000).toBeLessThan(0.02)

    // --- 5. A SECOND face-based New sketch must not collide with the first's id
    // (datum:SK2/sketch3d:SK2 already exist -- nextFaceSketchId must see
    // past those namespaced forms, not just the bare "SK2" nextId.ts checks).
    // Start between the YZ base plane and the body so the face is the nearest
    // target under the unified base-plane-or-face picker.
    ;(capturedRuntime as unknown as FakeSceneRuntime).rayOverride = { origin: { x: 5, y: 10, z: 10 }, direction: { x: 1, y: 0, z: 0 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK3')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('feature-row-sketch3d:SK3')).toBeTruthy()
    expect(screen.getByTestId('feature-row-datum:SK3').getAttribute('data-folded-under')).toBe('sketch3d:SK3')
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  }, 40_000)

  // MODEL-EDGE-PICK-SKETCH: the sole New Sketch pick must attach an ACTUAL
  // rendered boundary overlay, not merely update SelectionState/readout.
  it('New sketch hover overlays the rendered face boundary and cancel removes it', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }

    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    expect(capturedRuntime).not.toBeNull()
    const runtime = capturedRuntime as unknown as FakeSceneRuntime

    expect(screen.queryByTestId('workbench-sketch-on-face')).toBeNull()
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    expect(screen.queryByTestId('solids-workbench-plane-hover-readout')).toBeNull()

    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    const canvas = screen.getByTestId('solids-workbench-canvas')
    fireEvent.pointerMove(canvas)

    await waitFor(() => expect(screen.getByTestId('solids-workbench-plane-hover-readout')).toBeTruthy())
    const readoutText = screen.getByTestId('solids-workbench-plane-hover-readout').textContent ?? ''
    // WO-2858: the readout describes the face and names its body, never its key;
    // the hovered key is the one face the pick highlight paints.
    expect(readoutText).toBe('flat face facing up at Z 20.00 mm on Extrude F1 - click to sketch on it')
    const hovered = (hooks().getBodyFaceIds('F1') ?? []).filter((id) => hooks().getPickHighlightState(id) === 'hovered')
    expect(hovered).toHaveLength(1)
    const hoveredFaceId = hovered[0]
    expect(readoutText).not.toContain(hoveredFaceId)
    expect(canvas.style.cursor).toBe('crosshair')
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('hovered')

    const controlFaceId = hooks().getBodyFaceIds('F1')?.find((id) => id !== hoveredFaceId)
    expect(controlFaceId).toBeDefined()
    await waitFor(() => {
      const hoveredColor = hooks().getBodyFaceColorSample('F1', hoveredFaceId!)
      const restColor = hooks().getBodyFaceColorSample('F1', controlFaceId!)
      expect(hoveredColor).toBeDefined()
      expect(restColor).toBeDefined()
      expect(hoveredColor).toEqual(restColor)
      expect(hooks().getBodyInteractionSnapshot('F1')).toContainEqual(
        expect.objectContaining({
          kind: 'face-boundary',
          variant: 'hovered',
          color: INTERACTION_HOVER_ORANGE,
          depthTest: true,
          linewidth: 4,
          clippingPlaneCount: 0,
        }),
      )
    })

    fireEvent.click(screen.getByTestId('workbench-cancel-plane-pick'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-plane-hover-readout')).toBeNull())
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('none')
    await waitFor(() => {
      expect(hooks().getBodyInteractionSnapshot('F1')).toEqual([])
      expect(hooks().getBodyFaceColorSample('F1', hoveredFaceId!))
        .toEqual(hooks().getBodyFaceColorSample('F1', controlFaceId!))
    })
  }, 40_000)

  // SKETCH-ON-FACE-FIX (workplan 4e): the UNIFIED "New sketch" pick starts a sketch on a flat body
  // FACE, not only on a base plane. Before the fix, "New sketch" armed a base-plane-only pick that
  // refused every body-face hit as "A body blocks that plane" (Operator's LIVE FAIL). This is the
  // RED->GREEN mutation proof for that behavior.
  it('New sketch (unified pick): clicking a flat body face starts the sketch ON that face', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    // Aim straight down through the footprint centre -> the box's top face.
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    // The UNIFIED pick: "New sketch" arms it, and a click on the body face resolves to a sketch on
    // that face (NOT a base plane, NOT a "body blocks that plane" refusal).
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    // A face-plane datum + its sketch open, folded exactly like the explicit "On face" entry.
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('feature-row-sketch3d:SK2')).toBeTruthy()
    expect(screen.getByTestId('feature-row-datum:SK2').getAttribute('data-folded-under')).toBe('sketch3d:SK2')
    expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy()
    // FAILS-IF the unified pick refused the face: the base-plane refusal hint would still be up.
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    // Contextual-feedback: the completion line names the FACE the sketch started on (WO-2858: described).
    expect(workbenchConsoleMessages()).toContain('New sketch started on flat face facing up at Z 20.00 mm of Extrude F1.')

    fireEvent.click(screen.getByTestId('workbench-cancel-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-sketch3d:SK2')).toBeNull(), { timeout: 20_000 })
    expect(screen.queryByTestId('feature-row-datum:SK2')).toBeNull()
    expect(hooks().dag.has('datum:SK2')).toBe(false)
  }, 40_000)

  // SKETCH-ON-FACE-FIX (workplan 4e, ADR-0003): a NON-PLANAR face hit under the unified pick refuses
  // BY NAME in plain words and stays armed -- never a silent no-op, never a started sketch.
  it('New sketch (unified pick): clicking a curved (non-planar) face refuses by name and stays armed', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // A tube around the world Z axis: an XZ-plane rectangle (radius 10..50, height 20) revolved 360
    // sweeps a CURVED outer wall (a cylinder face) -- the non-planar target.
    await mintRectangleSketch({ plane: 'xz', width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-revolve'))
    commitField('revolve-angle', '360')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    // A horizontal ray from far +X hits the curved outer wall at (50, 0, 10).
    runtime.rayOverride = { origin: { x: 1000, y: 0, z: 10 }, direction: { x: -1, y: 0, z: 0 } }

    const before = workbenchConsoleMessages().length
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    // Named refusal in plain words (ADR-0003), and NO sketch opened.
    await waitFor(() => expect(workbenchConsoleMessages().slice(before).some((m) => /not flat/i.test(m))).toBe(true))
    expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull()
    // No sketch node or hidden provisional datum remains after the refusal.
    expect(screen.queryByTestId('feature-row-sketch3d:SK2')).toBeNull()
    expect(screen.queryByTestId('feature-row-datum:SK2')).toBeNull()
    expect(hooks().dag.has('datum:SK2')).toBe(false)
    expect(sketchSessionStore.getState().sketch).toBeNull()
    // Still armed on the unified pick, so the operator can pick a flat face or a base plane next.
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()
  }, 40_000)
})
