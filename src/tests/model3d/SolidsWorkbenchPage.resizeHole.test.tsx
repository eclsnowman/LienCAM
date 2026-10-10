// @vitest-environment jsdom
//
// WO UI-6Y (superseded primary flow, kept for the shared apply-path/undo
// coverage) + WO UI-58 (Operator verdict, T-UI5-PUSHPULL-RESIZE step 3):
// "Resize hole uses a fucking modal ... Start pulling this stuff into
// interactive workspace selectors." Drives the REAL workbench UI against the
// REAL in-process occt-wasm kernel: arm resize-hole -> synthetic pointer
// hover/pick on a hole face (fakeSceneRuntime's rayOverride, same seam every
// other pick-driven WO in this file already uses) -> anchored on-screen
// value entry -> Enter applies -> authoritative recognizeFeatures readback
// -> Undo -> readback. window.__solidsWorkbenchHooks is read-only evidence,
// never a mutation shortcut.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { FaceEditRequest, FeatureVerdict, OpResult } from '../../geom/geom-service'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'

// jsdom's localStorage is broken under Vitest's node launch flags. The store
// captures it during module evaluation, so install the repository-standard
// in-memory Storage shim before importing the workbench.
const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  memory.clear()
  // WO-270: the theme/glow pins that used to sit here are gone with the
  // settings they pinned. This suite's exact-value colour assertions now read
  // the ONE shipped palette (brand-blue bodies + the signature glow), which is
  // also what a real user sees -- the pins existed only because a user's
  // choice could differ from the test's.
  restoreCanvas2d = stubCanvas2d()
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
})

function commitNumericField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

/** Captures the fake scene runtime AND pre-arms projectToCanvasResult (the
 *  fake's own default is null -- "nothing projects" -- so without this the
 *  anchored value entry, which renders nothing while its anchor is
 *  off-screen/behind-camera, would never mount in this jsdom harness). */
function harness(): { createSceneRuntime: () => FakeSceneRuntime; runtime: () => FakeSceneRuntime } {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    runtime = rt
    return rt
  }
  return { createSceneRuntime, runtime: () => runtime as FakeSceneRuntime }
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitNumericField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

/** Blind hole at (x,y), same coordinate convention every pick-driven WO in
 *  this suite already uses -- the ray that CREATES the hole (aimed at the
 *  flat top face) is the exact same ray that later RESIZE-PICKS it (the
 *  hole's own void makes a dead-center vertical ray pass straight through to
 *  the blind floor -- a real hittable face, one of the verdict's own
 *  faceIds, never the cylindrical wall a purely axial ray could never touch). */
async function drillBlindHole(rt: () => FakeSceneRuntime, x: number, y: number, diameter: string, blindDistance: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-hole'))
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitNumericField('hole-diameter', diameter)
  commitNumericField('hole-blind-distance', blindDistance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
}

async function recognizedVerdicts(featureId: string) {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`${featureId} has no live body`)
  return hooks().client.recognizeFeatures(handle)
}

async function recognizedDiameters(featureId: string): Promise<number[]> {
  const verdicts = await recognizedVerdicts(featureId)
  return verdicts
    .filter((verdict) => ['throughHole', 'blindHole', 'counterboreStack'].includes(verdict.featureClass))
    .map((verdict) => verdict.params.diameter)
    .filter((diameter): diameter is number => typeof diameter === 'number' && Number.isFinite(diameter))
}

async function expectRecognizedDiameter(featureId: string, expected: number): Promise<void> {
  await waitFor(async () => {
    const diameters = await recognizedDiameters(featureId)
    expect(diameters.some((diameter) => Math.abs(diameter - expected) <= 1e-5)).toBe(true)
  }, { timeout: 20_000 })
}

async function armResizeHole(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
    { timeout: 20_000 },
  )
}

function pickHole(rt: () => FakeSceneRuntime, x: number, y: number): void {
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

async function waitForResizePreview(status: 'ready' | 'refused' = 'ready'): Promise<void> {
  await waitFor(() => {
    const readout = screen.getByTestId('resize-hole-anchor-entry-status')
    if (status === 'ready' && readout.getAttribute('data-status') === 'refused') {
      throw new Error(readout.textContent ?? 'Resize hole preview refused')
    }
    expect(readout.getAttribute('data-status')).toBe(status)
  }, { timeout: 20_000 })
}

describe('SolidsWorkbenchPage resize-hole: armed in-viewport pick (WO UI-58, primary flow)', () => {
  it('shows live geometry before history mutation, adopts that exact candidate once, stays armed, and round-trips undo/redo', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const holeDiameterRequests: FaceEditRequest[] = []
    let acceptedPreviewBody: OpResult['body']
    let gateAdoption = false
    let releaseAdoption: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        const result = await real.editFeature(request)
        if (request.kind === 'holeDiameter') {
          holeDiameterRequests.push(request)
          if (result.ok) acceptedPreviewBody = result.body
        }
        return result
      },
      tessellate: (body, quality) => {
        if (gateAdoption && body === acceptedPreviewBody) {
          gateAdoption = false
          return new Promise((resolve, reject) => {
            releaseAdoption = () => { void real.tessellate(body, quality).then(resolve, reject) }
          })
        }
        return real.tessellate(body, quality)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    const resizeRail = screen.getByTestId('workbench-resize-hole') as HTMLButtonElement
    expect(resizeRail.disabled).toBe(true)
    expect(resizeRail.getAttribute('data-tooltip')).toMatch(/no live body/i)

    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false))

    // Modal-first surface is GONE: the toolbar click never opens a dialog any more.
    await armResizeHole()
    expect(screen.queryByTestId('dialog-shell')).toBeNull()
    expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).toMatch(/click a hole/i)

    // Hover: highlights the hole's OWN face(s) and shows a readout -- the FOURTH handlePickHover branch.
    h.runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const hoveredFaceId = screen.getByTestId('solids-workbench-hover-readout').textContent?.match(/^Face (\S+) on/)?.[1]
    expect(hoveredFaceId).not.toBeUndefined()
    // FAILS-IF the pickModeArmed enumeration (:2490 preflight site) drops the resize-hole term: the
    // repaint effect (re-run by the SAME pickHoverInfo change that produced the readout above) would
    // paint from the empty bridge.selection instead and this reads back 'none'.
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('hovered')
    // Face hover is now boundary-only. The underlying rendered face color
    // remains unchanged while the shared depth-aware boundary object is live.
    const hoveredColor = hooks().getBodyFaceColorSample('F2', hoveredFaceId!)
    expect(hoveredColor).toBeDefined()
    expect(hooks().getBodyInteractionSnapshot('F2')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'face-boundary', depthTest: true, linewidth: 4 }),
    ]))
    const otherFaceId = (hooks().getBodyFaceIds('F2') ?? []).find((id) => id !== hoveredFaceId)
    expect(otherFaceId).not.toBeUndefined()
    const otherColor = hooks().getBodyFaceColorSample('F2', otherFaceId!)
    expect(otherColor).toBeDefined()
    expect(hoveredColor).toEqual(otherColor)

    // Click: selects, opens the anchored entry.
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('selected')
    expect(hooks().getBodyInteractionSnapshot('F2')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'face-fill', depthTest: true }),
    ]))
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')

    // Non-blocking: Measure/Appearance stay disabled (anyPickModeArmed enumeration, :5756 preflight
    // site) but the entry itself does not block canvas interaction structurally (it is a sibling
    // overlay, not a backdrop-modal -- no 'dialog-shell-backdrop' exists for it).
    expect((screen.getByTestId('workbench-ui4-tool-measure') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workbench-ui4-tool-appearance') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('dialog-shell-backdrop')).toBeNull()

    // Grow d=6 -> D=8 (+2), Enter applies -- THE apply path (handleResizeHoleApply), never a fork.
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    const historyBeforePreview = hooks().history.size()
    fireEvent.change(input, { target: { value: '8' } })
    expect(screen.getByTestId('resize-hole-anchor-entry-delta').textContent).toContain('+2 mm')
    await waitForResizePreview()
    expect(holeDiameterRequests).toHaveLength(1)
    expect(hooks().history.size()).toBe(historyBeforePreview)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBe(true)
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    if (acceptedPreviewBody === undefined) throw new Error('Resize Hole preview did not return a body')
    const previewVerdicts = await client.recognizeFeatures(acceptedPreviewBody)
    expect(previewVerdicts.some((verdict) =>
      typeof verdict.params.diameter === 'number' && Math.abs(verdict.params.diameter - 8) <= 1e-5,
    )).toBe(true)
    const callsBeforeApply = holeDiameterRequests.length
    gateAdoption = true
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('applying'))
    expect((screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('solids-workbench-root').getAttribute('data-resize-hole-adoption-pending')).toBe('true')
    const historyDuringHeldAdoption = hooks().history.serialize()
    const orderDuringHeldAdoption = hooks().dag.featureOrder()
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(hooks().history.serialize()).toEqual(historyDuringHeldAdoption)
    expect(hooks().dag.featureOrder()).toEqual(orderDuringHeldAdoption)
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    expect(hooks().history.serialize()).toEqual(historyDuringHeldAdoption)
    expect(hooks().dag.featureOrder()).toEqual(orderDuringHeldAdoption)
    releaseAdoption?.()

    // Success drops back to 'arm' (deselected, entry closes) -- STAYS armed for another pick.
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy()
    const resizeId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeId).toBe('F3')
    expect(holeDiameterRequests).toHaveLength(callsBeforeApply)
    expect(hooks().getBodyHandle(resizeId!)).toBe(acceptedPreviewBody)
    expect(hooks().dag.getNode(resizeId!)?.payload).toMatchObject({
      opType: 'resizeHole',
      ownerId: 'F2',
      currentDiameter: 6,
      newDiameter: 8,
      delta: 2,
    })
    expect(hooks().dag.getNode('F2')?.payload.faceEdits ?? []).toEqual([])
    expect(screen.getByTestId(`feature-row-${resizeId}`).textContent).toContain('Resize hole to 8 mm')
    await expectRecognizedDiameter(resizeId!, 8)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(hooks().dag.getNode(resizeId!)).toBeUndefined(), { timeout: 20_000 })
    expect(screen.queryByTestId(`feature-row-${resizeId}`)).toBeNull()
    await expectRecognizedDiameter('F2', 6)

    fireEvent.keyDown(window, { key: 'y', ctrlKey: true })
    await waitFor(() => expect(hooks().dag.getNode(resizeId!)?.payload.newDiameter).toBe(8), { timeout: 20_000 })
    await expectRecognizedDiameter(resizeId!, 8)
    expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy()

    // Toolbar re-click fully disarms (matching push-pull's own toggle convention).
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
    expect((screen.getByTestId('workbench-ui4-tool-measure') as HTMLButtonElement).disabled).toBe(false)
  }, 120_000)

  it('queues Apply while the exact diameter preview is pending and commits only after it settles', async () => {
    const h = harness()
    const real = createLocalGeomService()
    let releasePreview: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: (request: FaceEditRequest): Promise<OpResult> => {
        if (request.kind !== 'holeDiameter') return real.editFeature(request)
        return new Promise((resolve, reject) => {
          releasePreview = () => { void real.editFeature(request).then(resolve, reject) }
        })
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    const historyBefore = hooks().history.size()
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('idle')
    expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/differ from the current diameter/i)
    fireEvent.change(input, { target: { value: '0' } })
    expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('refused')
    expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/greater than 0/i)
    expect(hooks().history.size()).toBe(historyBefore)
    fireEvent.change(input, { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('pending'))
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().history.size()).toBe(historyBefore)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)

    releasePreview?.()
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(hooks().history.size()).toBe(historyBefore + 1)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(true)
  }, 120_000)

  // WO-077: the Apply-queues test above pins the MOUSE route (the Apply
  // button). The KEYBOARD route -- Enter on the input -- goes through the
  // SAME handleApply() in AnchoredValueEntry (resize-hole is single-stage:
  // twoStageEnter is not set, so Enter calls onApply directly, never
  // onAdjust). handleResizeHoleEntryApply -> handleResizeHolePreviewApply
  // awaits the exact current pending preview, re-checks the intent still
  // matches, and commits only if it settled ready -- the same contract the
  // Apply button uses. This pins that contract so Enter-while-PENDING is
  // never again silently unpinned (WO-075 lost the old Enter-while-pending
  // assertion when it rewrote the Apply path; this replaces it for the
  // queueing world, not the old block-while-pending world).
  it('presses Enter while the exact diameter preview is pending and commits only after it settles (exactly ONE commit)', async () => {
    const h = harness()
    const real = createLocalGeomService()
    let releasePreview: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: (request: FaceEditRequest): Promise<OpResult> => {
        if (request.kind !== 'holeDiameter') return real.editFeature(request)
        return new Promise((resolve, reject) => {
          releasePreview = () => { void real.editFeature(request).then(resolve, reject) }
        })
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    const historyBefore = hooks().history.size()
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('pending'))
    // Enter-while-pending must QUEUE, not silently discard. The Apply button
    // is enabled while pending (canApply covers 'pending'); Enter goes through
    // the same handleApply() and the same onApply, so it must behave the same.
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter' })
    // The shared applying guard engages synchronously -- both routes now read
    // busy=true, so neither a second Enter nor a stray Apply click can start a
    // second adoption against the same pending settlement.
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(true)
    // Nothing committed yet -- the adoption is still waiting on the preview.
    expect(hooks().history.size()).toBe(historyBefore)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)

    releasePreview?.()
    // Exactly ONE commit after settlement -- the same settlement must not be
    // adopted twice, and the keyboard route must not fork from the mouse route.
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(hooks().history.size()).toBe(historyBefore + 1)
    const resizeNodes = hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeNodes).toHaveLength(1)
    expect(hooks().dag.getNode(resizeNodes[0])?.payload).toMatchObject({
      opType: 'resizeHole', ownerId: 'F2', currentDiameter: 6, newDiameter: 8, delta: 2,
    })
  }, 120_000)

  // WO-077: the two entrances to the same commit (Enter on the input, Apply
  // button click) both route through AnchoredValueEntry's single handleApply(),
  // which sets the local `applying` flag synchronously BEFORE awaiting onApply.
  // That flag makes applyReady false for any second invocation that lands after
  // React flushes (which it does between every pair of fireEvent calls), so a
  // second Enter or a second Apply click is a no-op. This pins the contract:
  // pressing Enter and clicking Apply in quick succession while pending must
  // not double-commit the same settlement. The guard is symmetric -- it does
  // not matter which route fires first; the first to flush `applying=true`
  // blocks the other.
  it('pressing Enter and clicking Apply in quick succession while pending commits exactly once (no double-commit)', async () => {
    const h = harness()
    const real = createLocalGeomService()
    let releasePreview: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: (request: FaceEditRequest): Promise<OpResult> => {
        if (request.kind !== 'holeDiameter') return real.editFeature(request)
        return new Promise((resolve, reject) => {
          releasePreview = () => { void real.editFeature(request).then(resolve, reject) }
        })
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    const historyBefore = hooks().history.size()
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('pending'))
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(false)

    // Fire BOTH entrances back-to-back while the preview is still pending.
    // The first flushes `applying=true` (handleApply sets it before awaiting
    // onApply); the second lands on a disabled Apply button / a handleApply
    // whose applyReady is already false, so it is a no-op.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(hooks().history.size()).toBe(historyBefore)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)

    releasePreview?.()
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    // Exactly ONE commit -- not two. The same settlement cannot be adopted twice.
    expect(hooks().history.size()).toBe(historyBefore + 1)
    const resizeNodes = hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeNodes).toHaveLength(1)
    expect(hooks().dag.getNode(resizeNodes[0])?.payload).toMatchObject({
      opType: 'resizeHole', ownerId: 'F2', currentDiameter: 6, newDiameter: 8, delta: 2,
    })
  }, 120_000)

  it('refuses a ready preview after an external DAG mutation and restores the source exactly', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const candidates: NonNullable<OpResult['body']>[] = []
    const disposed: NonNullable<OpResult['body']>[] = []
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        const result = await real.editFeature(request)
        if (request.kind === 'holeDiameter' && result.ok && result.body !== undefined) candidates.push(result.body)
        return result
      },
      dispose: async (body) => {
        disposed.push(body)
        await real.dispose(body)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview()
    const accepted = candidates.at(-1)!
    const historyBefore = hooks().history.serialize()
    const owner = hooks().dag.getNode('F2')
    if (owner === undefined) throw new Error('fixture owner F2 is missing')

    // This simulates a document mutation outside the preview session without
    // changing the field intent. Ready must not mean adoptable after the
    // captured graph/history fingerprint stops matching.
    hooks().dag.setPayload('F2', { ...owner.payload, name: 'Externally renamed drilled body' })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))

    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-apply-error').textContent).toMatch(/model changed after the preview was created/i))
    await waitFor(() => expect(disposed).toContain(accepted))
    expect(hooks().history.serialize()).toEqual(historyBefore)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy()
  }, 120_000)

  it('coalesces rapid A -> B input, disposes late A, and adopts only visible B', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const holeRequests: FaceEditRequest[] = []
    const resultBodies: NonNullable<OpResult['body']>[] = []
    const disposed: NonNullable<OpResult['body']>[] = []
    const tessellated: NonNullable<OpResult['body']>[] = []
    let releaseA: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: (request: FaceEditRequest): Promise<OpResult> => {
        if (request.kind !== 'holeDiameter') return real.editFeature(request)
        holeRequests.push(request)
        const evaluate = async (): Promise<OpResult> => {
          const result = await real.editFeature(request)
          if (result.ok && result.body !== undefined) resultBodies.push(result.body)
          return result
        }
        if (holeRequests.length === 1) {
          return new Promise((resolve, reject) => {
            releaseA = () => { void evaluate().then(resolve, reject) }
          })
        }
        return evaluate()
      },
      dispose: async (handle) => {
        disposed.push(handle)
        await real.dispose(handle)
      },
      tessellate: async (body, quality) => {
        tessellated.push(body)
        return real.tessellate(body, quality)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    await waitFor(() => expect(holeRequests).toHaveLength(1))
    fireEvent.change(input, { target: { value: '9' } })
    expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('pending')
    releaseA?.()

    await waitForResizePreview()
    expect(holeRequests.map((request) => request.delta)).toEqual([2, 3])
    expect(resultBodies).toHaveLength(2)
    await waitFor(() => expect(disposed).toContain(resultBodies[0]))
    expect(disposed).not.toContain(resultBodies[1])
    expect(tessellated).not.toContain(resultBodies[0])
    expect(tessellated).toContain(resultBodies[1])
    const visibleVerdicts = await client.recognizeFeatures(resultBodies[1])
    expect(visibleVerdicts.some((verdict) => verdict.params.diameter === 9)).toBe(true)

    const callsBeforeApply = holeRequests.length
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(holeRequests).toHaveLength(callsBeforeApply)
    expect(hooks().getBodyHandle('F3')).toBe(resultBodies[1])
    expect(hooks().dag.getNode('F3')?.payload.newDiameter).toBe(9)
  }, 120_000)

  it('restores the source and disposes candidates on re-pick and full cancel', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const candidateBodies: NonNullable<OpResult['body']>[] = []
    const disposed: NonNullable<OpResult['body']>[] = []
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        const result = await real.editFeature(request)
        if (request.kind === 'holeDiameter' && result.ok && result.body !== undefined) candidateBodies.push(result.body)
        return result
      },
      dispose: async (handle) => {
        disposed.push(handle)
        await real.dispose(handle)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await drillBlindHole(h.runtime, 40, 15, '4', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    const historyBefore = hooks().history.size()
    hooks().setPickHighlightState(['pre-resize-selected-b', 'pre-resize-selected-a'], 'pre-resize-hovered')
    const interactionBefore = hooks().getPushPullTransactionState()
    expect(interactionBefore.pickSelected).toEqual(['pre-resize-selected-a', 'pre-resize-selected-b'])
    expect(interactionBefore.pickHovered).toBe('pre-resize-hovered')
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '7' } })
    await waitForResizePreview()
    const candidateA = candidateBodies.at(-1)!
    expect(hooks().getBodyPresentationVisible('F3')).toBe(false)

    pickHole(h.runtime, 40, 15)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('4 mm'))
    await waitFor(() => expect(disposed).toContain(candidateA))
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()

    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '5' } })
    await waitForResizePreview()
    const candidateB = candidateBodies.at(-1)!
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
    await waitFor(() => expect(disposed).toContain(candidateB))
    expect(hooks().getBodyPresentationVisible('F3')).toBe(true)
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()
    expect(hooks().history.size()).toBe(historyBefore)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)
    const interactionAfter = hooks().getPushPullTransactionState()
    expect(interactionAfter.pickSelected).toEqual(interactionBefore.pickSelected)
    expect(interactionAfter.pickHovered).toBe(interactionBefore.pickHovered)
  }, 180_000)

  it('retires preview and restores exact interaction state before Defeature, Edit, or another command', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const candidates: NonNullable<OpResult['body']>[] = []
    const disposed: NonNullable<OpResult['body']>[] = []
    let holdRecognition = false
    let releaseRecognition: (() => void) | undefined
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        const result = await real.editFeature(request)
        if (request.kind === 'holeDiameter' && result.ok && result.body !== undefined) candidates.push(result.body)
        return result
      },
      recognizeFeatures: (body) => {
        if (!holdRecognition) return real.recognizeFeatures(body)
        return new Promise((resolve, reject) => {
          releaseRecognition = () => { void real.recognizeFeatures(body).then(resolve, reject) }
        })
      },
      dispose: async (body) => {
        disposed.push(body)
        await real.dispose(body)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    hooks().setPickHighlightState(['before-switch-selected'], 'before-switch-hovered')
    const beforeSwitch = hooks().getPushPullTransactionState()
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview()
    const candidate = candidates.at(-1)!
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBe(true)
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)

    holdRecognition = true
    fireEvent.click(screen.getByTestId('workbench-defeature'))

    // The competing dialog cannot begin recognition until Resize Hole has
    // synchronously relinquished its session, presentation, and interaction
    // ownership in this same click turn.
    expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull()
    expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull()
    expect(screen.queryByTestId('dialog-shell')).toBeNull()
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    const afterSwitch = hooks().getPushPullTransactionState()
    expect(afterSwitch.pickSelected).toEqual(beforeSwitch.pickSelected)
    expect(afterSwitch.pickHovered).toBe(beforeSwitch.pickHovered)
    await waitFor(() => expect(disposed).toContain(candidate))

    releaseRecognition?.()
    await waitFor(() => expect(screen.getByTestId('defeature-command-card')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('defeature-command-card')).toBeNull())

    // FeatureTree's shared edit resolver uses the same switch seam.
    holdRecognition = false
    hooks().setPickHighlightState(['before-edit-selected'], 'before-edit-hovered')
    const beforeEdit = hooks().getPushPullTransactionState()
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview()
    fireEvent.contextMenu(screen.getByTestId('feature-row-F1'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)
    expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull()
    expect(screen.getByTestId('extrude-distance')).toBeTruthy()
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    const afterEditSwitch = hooks().getPushPullTransactionState()
    expect(afterEditSwitch.pickSelected).toEqual(beforeEdit.pickSelected)
    expect(afterEditSwitch.pickHovered).toBe(beforeEdit.pickHovered)
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('extrude-distance')).toBeNull())

    // A different rail command also retires Resize Hole before opening.
    hooks().setPickHighlightState(['before-command-selected'], 'before-command-hovered')
    const beforeCommand = hooks().getPushPullTransactionState()
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull()
    expect(screen.getByTestId('extrude-distance')).toBeTruthy()
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    const afterCommandSwitch = hooks().getPushPullTransactionState()
    expect(afterCommandSwitch.pickSelected).toEqual(beforeCommand.pickSelected)
    expect(afterCommandSwitch.pickHovered).toBe(beforeCommand.pickHovered)
  }, 120_000)

  it('a shrink (D < d) applies a negative delta and Escape on the open entry deselects without disarming', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    // Escape on the open entry: deselects (entry closes) but the toolbar stays armed.
    fireEvent.keyDown(screen.getByTestId('resize-hole-anchor-entry-input'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull())
    expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy()
    expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false)

    // Re-pick and shrink d=6 -> D=4 (-2).
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '4' } })
    expect(screen.getByTestId('resize-hole-anchor-entry-delta').textContent).toContain('-2 mm')
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    await expectRecognizedDiameter('F3', 4)
  }, 120_000)

  it('an engine refusal keeps the entry open with the named reason, and commits no resize-hole feature', async () => {
    const h = harness()
    const real = createLocalGeomService()
    let refuseCommit = false
    const client: GeomClient = {
      ...real,
      editFeature: (request: FaceEditRequest): Promise<OpResult> => {
        if (refuseCommit && request.kind === 'holeDiameter') {
          return Promise.resolve({
            ok: false,
            diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity: 'error', params: { reason: 'named engine refusal from UI-58 test', featureKey: request.featureKey } }],
          })
        }
        return real.editFeature(request)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    const historyBeforeRefusal = hooks().history.size()
    refuseCommit = true
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview('refused')
    expect(screen.getByTestId('resize-hole-anchor-entry-status').textContent).toMatch(/named engine refusal from UI-58 test/i)
    expect((screen.getByTestId('resize-hole-anchor-entry-apply') as HTMLButtonElement).disabled).toBe(true)
    expect((hooks().dag.getNode('F2')?.payload.faceEdits as unknown[] | undefined) ?? []).toHaveLength(0)
    expect(hooks().dag.featureOrder().some((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toBe(false)
    expect(hooks().history.size()).toBe(historyBeforeRefusal)
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBeUndefined()
    // Refusal does not silently close the entry -- the user can still see/retype.
    expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy()
  }, 120_000)
})

describe('SolidsWorkbenchPage resize-hole: negative controls (WO UI-58, "the heart of the pick")', () => {
  it('zero eligible holes on the live body: arming shows the NAMED empty state, never a silent dead mode', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false))

    await armResizeHole()
    expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).toMatch(/no recognized through, blind, or counterbore holes/i)
    // No List affordance when there is nothing to list.
    expect(screen.queryByTestId('workbench-resizehole-list')).toBeNull()

    // A click on any face (there are no eligible holes) selects nothing.
    pickHole(h.runtime, 30, 10)
    expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull()
  }, 60_000)

  it('clicking a face that belongs to NO eligible hole selects nothing and opens no entry, even with an eligible hole elsewhere on the same body', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    await armResizeHole()
    // The box's own BOTTOM face (z=0), untouched by the top-face hole -- a real, live, pickable
    // face that is provably not part of any recognized hole.
    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: -100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    // No hole highlight, no hover readout -- unlike the other three armed modes, a miss on the
    // resize-hole pick surface never lights up the lone face it hit.
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull()
    expect(hooks().dag.getNode('F2')?.payload.faceEdits ?? []).toEqual([])
  }, 60_000)

  it('hovering ANY face of a counterbore stack highlights EVERY face in the stack -- proving multi-id hover, not a lone-face highlight', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-hole'))
    h.runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    fireEvent.change(screen.getByTestId('hole-style-select'), { target: { value: 'counterbore' } })
    commitNumericField('hole-diameter', '6')
    commitNumericField('hole-cb-diameter', '10')
    commitNumericField('hole-cb-depth', '3')
    commitNumericField('hole-blind-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const verdicts = await recognizedVerdicts('F2')
    const stack = verdicts.find((v) => v.featureClass === 'counterboreStack')
    expect(stack).toBeDefined()
    expect(stack!.faceIds.length).toBeGreaterThan(1) // non-vacuous: a real multi-face feature

    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false))
    await armResizeHole()
    h.runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())

    for (const faceId of stack!.faceIds) expect(hooks().getPickHighlightState(faceId)).toBe('hovered')
    const otherFace = (hooks().getBodyFaceIds('F2') ?? []).find((id) => !stack!.faceIds.includes(id))
    expect(otherFace).not.toBeUndefined()
    expect(hooks().getPickHighlightState(otherFace!)).toBe('none')
  }, 60_000)
})

describe('SolidsWorkbenchPage resize-hole: stale-cache control (WO UI-58 preflight finding)', () => {
  it('applying a diameter change on hole A while STAYING armed invalidates the cache -- re-selecting hole A (and hole B on the same body) shows the POST-apply diameter, never the pre-apply cached verdict', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)
    await drillBlindHole(h.runtime, 40, 15, '4', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F3', 4)

    await armResizeHole()
    // Hole A (was on F2, now recognized on the live leaf F3): d=6 -> D=9.
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    // STILL armed the whole time -- never dropped back to 'none'.
    expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy()

    // Re-select hole A: must read back 9, never the stale pre-apply 6.
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('9 mm')
    fireEvent.keyDown(screen.getByTestId('resize-hole-anchor-entry-input'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull())

    // A SECOND hole on the SAME body: its own reading is unaffected/correct too -- the cache
    // invalidation refreshed the WHOLE body's verdict set, not just the just-applied featureKey.
    pickHole(h.runtime, 40, 15)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('4 mm')
  }, 120_000)
})

describe('SolidsWorkbenchPage resize-hole: constructed interleave for the post-apply refresh race (WO UI-58-R1 blocker)', () => {
  it('a re-pick that lands while the post-apply recognizeFeatures refresh is still IN FLIGHT is REFUSED (no stale diameter, no entry) -- then resolves to the post-apply value once the refresh completes', async () => {
    const h = harness()
    const real = createLocalGeomService()
    // WORKER-CHARTER item 4: the ordering is built, not argued. `hangGate`
    // hangs EVERY recognizeFeatures call made while it is armed on a
    // manually-released Promise, so a re-pick fired while one is pending is
    // a PROVEN in-flight read, not a hope about event-loop timing. A gate
    // (not a fixed call index) because handleResizeHoleEntryApply's own
    // dagVersion bump (inside fullResync) and its `kind: 'armed' -> 'arm'`
    // deselect land in two SEPARATE renders (the latter runs after fullResync's
    // await already resolved) -- the fetch effect (deps include both
    // dagVersion AND resizeHolePickMode.kind) fires once for each, so TWO
    // recognizeFeatures calls can be in flight for the same post-apply
    // refresh. Only the LATER (non-cancelled) effect instance's call ever
    // writes back to resizeHoleVerdictsRef -- see its own `cancelled` guard
    // -- so releasing every hung call together is correct regardless of how
    // many fired.
    let hangGate = false
    const pendingReleases: Array<() => void> = []
    const client: GeomClient = {
      ...real,
      recognizeFeatures: (handle): Promise<FeatureVerdict[]> => {
        if (hangGate) {
          return new Promise((resolve) => {
            pendingReleases.push(() => resolve(real.recognizeFeatures(handle)))
          })
        }
        return real.recognizeFeatures(handle)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // Arm: real and immediate (gate not yet armed) -- resizeHoleVerdictsRef warms with the pre-apply d=6 verdict.
    await armResizeHole()
    h.runtime().rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const hoveredFaceId = screen.getByTestId('solids-workbench-hover-readout').textContent?.match(/^Face (\S+) on/)?.[1]
    expect(hoveredFaceId).not.toBeUndefined()
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')

    // Apply d=6 -> D=9 with the gate armed: fullResync bumps dagVersion, re-arming the fetch effect,
    // which fires recognizeFeatures -- HUNG by the wrapper above until releasePending() below runs.
    hangGate = true
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    // STILL armed (kind='arm', deselected) -- the apply's own await chain (editFeature + fullResync)
    // resolved without ever waiting on the resize-hole verdict refresh, which is a SEPARATE effect.
    expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy()
    // The refresh is provably in flight -- the busy hint (driven by the SAME setResizeHoleRecognizing(true)
    // that runs before each hung call) confirms it synchronously.
    await waitFor(() => expect(pendingReleases.length).toBeGreaterThan(0), { timeout: 20_000 })
    expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).toMatch(/recognizing/i)

    // Re-pick the SAME hole BEFORE the refresh resolves. Pre-R1: this read the stale 6mm verdict
    // straight out of the still-populated resizeHoleVerdictsRef, matched it (SAME faceIds persist
    // across a resize -- proven by the earlier stale-cache-control test), and transitioned
    // resizeHolePickMode to 'armed' with the STALE diameter -- the auditor's exact reproduction.
    // Post-R1: the version gate refuses the read outright, so the mode NEVER leaves 'arm'.
    //
    // Two rAF-independent, synchronous discriminators (the message text alone is NOT one -- while
    // resizeHoleRecognizing is true, the hint shows "Recognizing holes..." regardless of kind, so a
    // stale 'armed' transition would be masked by that same overlay text):
    //  1. the List affordance's OWN render gate is `eligibleCount > 0 && kind === 'arm'`, independent
    //     of resizeHoleRecognizing -- it disappears the instant kind flips to 'armed', with no rAF
    //     dependency (a plain conditional in the JSX below, not AnchoredValueEntry's own mount path).
    //  2. pickHighlightSelectionRef only gains a 'selected' face via handleResizeHolePick's own
    //     selectMany() call, which runs ONLY past a successful match -- a refused read never calls it.
    pickHole(h.runtime, 20, 5)
    expect(screen.getByTestId('workbench-resizehole-list')).toBeTruthy()
    expect(hooks().getPickHighlightState(hoveredFaceId!)).not.toBe('selected')

    // Release every hung call -- the refresh(es) complete and land the real post-apply (9mm) verdict set.
    hangGate = false
    pendingReleases.splice(0).forEach((release) => release())
    await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i), { timeout: 20_000 })

    // The SAME re-pick now resolves -- and reads the POST-apply diameter, never the stale one.
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('9 mm')
  }, 120_000)
})

describe('SolidsWorkbenchPage resize-hole: named recognizer failure (WO UI-58-R1 major 2, ADR-0003)', () => {
  it('a thrown recognizeFeatures failure is surfaced BY NAME in the armed hint -- never collapsed into the same "no recognized holes" text an honest zero-hole body gets', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const FAILURE_REASON = 'named UI-58-R1 test recognizer failure'
    const client: GeomClient = {
      ...real,
      recognizeFeatures: (): Promise<FeatureVerdict[]> => Promise.reject(new Error(FAILURE_REASON)),
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    // Drilled through the REAL client (the hole dialog itself never calls recognizeFeatures), so
    // there genuinely IS an eligible hole for the failure to hide -- not an honest empty body.
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false))

    // armResizeHole()'s own "not recognizing" wait resolves on EITHER branch of the fetch effect's
    // try/catch (setResizeHoleRecognizing(false) runs unconditionally after the loop), so it is safe
    // to reuse here even though this arm's own recognizeFeatures call is the one that throws.
    await armResizeHole()

    const hintText = screen.getByTestId('solids-workbench-resizehole-hint').textContent ?? ''
    expect(hintText).toMatch(/recognition failed/i)
    expect(hintText).toContain(FAILURE_REASON)
    // NAMED failure, never the generic empty-state text an honest zero-hole body would show instead
    // (ADR-0003: a failed recognizer must be indistinguishable from neither "zero holes" nor silence).
    expect(hintText).not.toMatch(/no recognized through, blind, or counterbore holes/i)
    // No List affordance -- nothing eligible to list (the failed body contributed zero verdicts).
    expect(screen.queryByTestId('workbench-resizehole-list')).toBeNull()

    // A click on the (actually real) hole face selects nothing -- the failure degraded this body's
    // OWN verdicts to empty, the same "try again" contract a genuine miss already uses.
    pickHole(h.runtime, 20, 5)
    expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull()
  }, 60_000)
})

describe('SolidsWorkbenchPage resize-hole: supplement-list anchor derives from the FEATURE, not the body bbox (WO UI-58-R1 minor)', () => {
  it("a row click for an off-center hole anchors the entry ON the hole -- never the owning body's whole-bbox top-center", async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    // buildBox's box is x:[10,50] y:[0,20] z:[0,20] (bbox CENTER x=30, y=10 -- same fixture
    // SolidsWorkbenchPage.liveBodyPick.test.tsx documents). This hole at (20,5) is deliberately off
    // that center on BOTH axes, so a bbox-center anchor and a feature-centroid anchor provably
    // disagree -- a passing assertion here cannot be satisfied by the pre-R1 bbox fallback.
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    await armResizeHole()
    fireEvent.click(screen.getByTestId('workbench-resizehole-list'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-picker')).toBeTruthy(), { timeout: 20_000 })
    const rows = screen.getAllByRole('radio') as HTMLButtonElement[]
    expect(rows.length).toBeGreaterThan(0)
    fireEvent.click(rows[0])
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    // AnchoredValueEntry's own rAF loop calls projectToCanvas(anchorWorldPoint) every frame -- the
    // fake records every world point it was called with, in order (WO UI-58-R1 addition to
    // fakeSceneRuntime.ts, same additive call-log pattern as clipPlaneCalls/frameBoxCalls).
    await waitFor(() => expect(h.runtime().projectToCanvasCalls.length).toBeGreaterThan(0), { timeout: 20_000 })
    const anchor = h.runtime().projectToCanvasCalls.at(-1)!
    // ON the hole's own faces (a real, tessellation-derived centroid near (20,5)) --
    expect(anchor.x).toBeCloseTo(20, 0)
    expect(anchor.y).toBeCloseTo(5, 0)
    // -- provably NOT the body's whole-bbox top-center (30, 10, 20) the pre-R1 code anchored at.
    expect(Math.abs(anchor.x - 30)).toBeGreaterThan(5)
    expect(Math.abs(anchor.y - 10)).toBeGreaterThan(2)
  }, 120_000)
})

describe('SolidsWorkbenchPage resize-hole: supplement list (WO UI-58, demoted -- never the first thing the user sees)', () => {
  it('the List affordance is reachable only from the armed state, and a row click behaves as a click-select', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    // Never reachable before arming -- there is no standalone "open the list" affordance any more.
    expect(screen.queryByTestId('workbench-resizehole-list')).toBeNull()

    await armResizeHole()
    fireEvent.click(screen.getByTestId('workbench-resizehole-list'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-picker')).toBeTruthy(), { timeout: 20_000 })
    const rows = screen.getAllByRole('radio') as HTMLButtonElement[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => ['throughHole', 'blindHole', 'counterboreStack'].includes(row.dataset.featureClass ?? ''))).toBe(true)

    // Row click is a click-select: closes the list, opens the SAME anchored entry a viewport click would.
    fireEvent.click(rows[0])
    expect(screen.queryByTestId('resize-hole-picker')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')

    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '7' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    await expectRecognizedDiameter('F3', 7)
  }, 120_000)
})

describe('SolidsWorkbenchPage resize-hole: React render smoke test (hooks-order class, WORKER-CHARTER item 11)', () => {
  it('mount -> arm -> hover -> select -> apply -> deselect -> disarm never logs a React hook-order/render warning', async () => {
    const errors: unknown[][] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    try {
      const h = harness()
      render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
      await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
      await buildBox()
      await drillBlindHole(h.runtime, 20, 5, '6', '5')
      await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

      await armResizeHole()
      pickHole(h.runtime, 20, 5)
      await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
      fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
      await waitForResizePreview()
      fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
      await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
      fireEvent.click(screen.getByTestId('workbench-resize-hole'))
      await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
    } finally {
      errorSpy.mockRestore()
    }
    const hookOrderErrors = errors.filter((args) =>
      args.some((a) => typeof a === 'string' && /rendered (more|fewer) hooks|invalid hook call|hooks can only be called/i.test(a)),
    )
    expect(hookOrderErrors).toEqual([])
  }, 120_000)
})

// BK-174: FeatureTree Edit on a resizeHole feature was permanently disabled.
// It now reopens the SAME in-viewport surface it was created with -- armed
// pick mode auto-selects the stored hole, the anchored value entry opens
// prefilled with the stored target diameter -- and Apply rewrites the SAME
// node. resizeHole's historyRole is 'direct-edit' (bodyLineage.ts): applying
// it disposes the owner's OWN handle, so by the time an EXISTING resizeHole
// node is edited, its stored ownerId (F2, the drilled body) is no longer
// literally live -- this proves the lineage-keyed resolution still finds it.
describe('SolidsWorkbenchPage resize-hole: FeatureTree Edit reopens the same in-viewport surface (BK-174)', () => {
  it('tree-menu Edit... arms resize-hole, auto-selects the stored hole, prefills the stored target diameter, and Apply rewrites the SAME node', async () => {
    const h = harness()
    const real = createLocalGeomService()
    const holeRequests: FaceEditRequest[] = []
    const preFeatureDiameters: number[][] = []
    const candidateBodies: NonNullable<OpResult['body']>[] = []
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        if (request.kind === 'holeDiameter') {
          holeRequests.push(request)
          const verdicts = await real.recognizeFeatures(request.body)
          preFeatureDiameters.push(verdicts
            .map((verdict) => verdict.params.diameter)
            .filter((diameter): diameter is number => typeof diameter === 'number'))
        }
        const result = await real.editFeature(request)
        if (request.kind === 'holeDiameter' && result.ok && result.body !== undefined) candidateBodies.push(result.body)
        return result
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    // First resize: d=6 -> D=8 (F3), same apply path the primary-flow test above proves.
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    const resizeId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeId).toBe('F3')
    await expectRecognizedDiameter('F3', 8)
    // Fully disarm before Edit -- proves Edit reopens the surface on its own,
    // not merely riding an already-armed session.
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())

    // FeatureTree Edit on the resizeHole row -- no dialog, no disabled reason.
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${resizeId}`))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)

    // Reopens the SAME armed pick + anchored entry surface, auto-selected
    // (no click needed) on the stored hole. "Current diameter" reads the
    // ORIGINAL BASE (6, the hole's diameter BEFORE any resize) -- not the
    // live rendered diameter (8, the result of the FIRST resize) -- because
    // handleResizeHoleApply always applies `delta` to the OWNER's OWN fresh
    // regeneration (6mm), never to whatever this SAME feature last produced;
    // a SECOND delta must be computed against that SAME base every time (see
    // the 'armed' branch's own doc comment, SolidsWorkbenchPage.tsx). Draft
    // prefilled with the STORED target (8, what was last typed).
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    expect((screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement).value).toBe('8')
    await waitForResizePreview()
    expect(holeRequests.at(-1)?.featureId).toBe(resizeId)
    expect(preFeatureDiameters.at(-1)).toContain(6)
    expect(preFeatureDiameters.at(-1)).not.toContain(8)

    // Retype to 9 and Apply -- rewrites the SAME node (F3), no new feature
    // row. (9, not a larger value: the hole sits 5mm from the sketch's
    // nearest edge at this position -- see drillBlindHole/buildBox's own
    // fixture geometry -- so a diameter much past 9-10 would breach the
    // boundary, an unrelated geometric constraint of this fixture, not a
    // resize-hole defect.)
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitForResizePreview()
    expect(preFeatureDiameters.at(-1)).toContain(6)
    const callsBeforeEditApply = holeRequests.length
    const acceptedEditCandidate = candidateBodies.at(-1)
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toEqual([resizeId])
    expect(holeRequests).toHaveLength(callsBeforeEditApply)
    expect(hooks().getBodyHandle(resizeId!)).toBe(acceptedEditCandidate)
    expect(hooks().dag.getNode(resizeId!)?.payload).toMatchObject({
      opType: 'resizeHole', ownerId: 'F2', currentDiameter: 6, newDiameter: 9, delta: 3,
    })
    await expectRecognizedDiameter(resizeId!, 9)

    // Undo restores the PRIOR payload on the SAME node (byte-exact
    // EditFeaturePayloadCommand restore) -- the hole goes back to 8, not 6.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode(resizeId!)?.payload.newDiameter).toBe(8), { timeout: 20_000 })
    await expectRecognizedDiameter(resizeId!, 8)

    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode(resizeId!)?.payload.newDiameter).toBe(9), { timeout: 20_000 })
    await expectRecognizedDiameter(resizeId!, 9)
  }, 120_000)

  it.each([
    ['failed status', 'status' as const],
    ['thrown error', 'throw' as const],
  ])('rolls back a non-leaf edit when downstream replay returns a %s', async (_label, failureMode) => {
    const h = harness()
    const real = createLocalGeomService()
    let failDownstreamStatus = false
    const client: GeomClient = {
      ...real,
      editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
        if (failDownstreamStatus && request.kind === 'holeDiameter' && request.featureId === 'F4') {
          failDownstreamStatus = false
          return {
            ok: false,
            diagnostics: [{
              code: 'DEFEATURE_UNSUPPORTED',
              severity: 'error',
              params: { reason: 'injected downstream status failure', featureKey: request.featureKey },
            }],
          }
        }
        return real.editFeature(request)
      },
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // F3 is the feature we will edit; F4 is its real non-leaf consumer.
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
      { timeout: 20_000 },
    )
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('8 mm'), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitForResizePreview()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F3')?.payload).toMatchObject({ newDiameter: 8, delta: 2 })
    expect(hooks().dag.getNode('F4')?.payload).toMatchObject({ ownerId: 'F3', newDiameter: 9, delta: 1 })
    await expectRecognizedDiameter('F4', 9)

    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())
    fireEvent.contextMenu(screen.getByTestId('feature-row-F3'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '7' } })
    await waitForResizePreview()

    const historyBefore = hooks().history.serialize()
    const orderBefore = hooks().dag.featureOrder()
    const f3Before = structuredClone(hooks().dag.getNode('F3')?.payload)
    const f4Before = structuredClone(hooks().dag.getNode('F4')?.payload)
    if (failureMode === 'status') {
      failDownstreamStatus = true
    } else {
      hooks().setResizeHoleDownstreamReplayProbe(() => { throw new Error('injected downstream replay throw') })
    }
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))

    const expectedFailure = failureMode === 'status'
      ? /injected downstream status failure/i
      : /injected downstream replay throw/i
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-apply-error').textContent).toMatch(expectedFailure), { timeout: 20_000 })
    await waitForResizePreview()
    expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy()
    expect(hooks().history.serialize()).toEqual(historyBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBefore)
    expect(hooks().dag.getNode('F3')?.payload).toEqual(f3Before)
    expect(hooks().dag.getNode('F4')?.payload).toEqual(f4Before)
    await expectRecognizedDiameter('F4', 9)
    expect(hooks().getBodyPresentationVisible('__resize-hole-preview__')).toBe(true)
    expect(hooks().getBodyPresentationVisible('F4')).toBe(false)
  }, 240_000)
})
