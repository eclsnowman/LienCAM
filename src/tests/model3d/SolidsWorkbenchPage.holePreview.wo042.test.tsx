// @vitest-environment jsdom
//
// WO-042 (UI-107 slice 4): Hole create/edit on the shared
// FeaturePreviewSession contract -- a real-kernel ghost of the drilled result
// previews while HoleDialog is open WITHOUT appending history; Apply commits
// ONCE with one undo step behind the commit-time guard (accepted intent +
// authored-state fingerprint); Cancel and the terminal error path restore the
// original presentation unchanged; edit restores and visibly highlights the
// saved FACE reference (pick-highlight selection painted onto an interaction
// overlay over the ghost) and the saved SEED POINT (a marker cross keyed by
// the exact seed coordinates). This is the delivered DRESS-UP template
// (single owner body, face ref, numeric params) per the WO-019 census -- the
// linear/circular pattern points are COMPUTED from the one picked seed.
//
// WO-054 closes the proof-target audit: every numeric bound/extreme is applied
// and asserted on the committed DAG payload, while Cancel and terminal-error
// restoration re-tessellate the committed handle before and after and compare
// serialized position + index + normal bytes (real kernel on both paths).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import type { HoleFeaturePayload } from '../../components/model3d/dialogs/HoleDialog'
import { createFakeGeomClient, type FakeGeomClient } from './fakeGeomClient'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { HoleRequest, TessBuffers, Vec3 } from '../../geom/geom-service'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'

const GHOST_ID = '__hole-preview__'

let restoreCanvas: (() => void) | null = null

beforeEach(() => { restoreCanvas = stubCanvas2d() })
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  restoreCanvas = null
})

function hooks(): SolidsWorkbenchHooks {
  if (window.__solidsWorkbenchHooks === undefined) throw new Error('workbench hooks unavailable')
  return window.__solidsWorkbenchHooks
}

async function boot(createClient: () => GeomClient): Promise<FakeSceneRuntime> {
  let runtime: FakeSceneRuntime | null = null
  const createRuntime: CreateSceneRuntime = () => {
    runtime = createFakeSceneRuntime()
    return runtime
  }
  render(<SolidsWorkbenchPage createClient={createClient} createSceneRuntime={createRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  return runtime as unknown as FakeSceneRuntime
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** The bounds the dialog ACTUALLY renders on a field (modal parity source of
 *  truth for WO-046): NumericInput forwards min/max straight onto the input,
 *  so a null attribute IS the proof the field is unbounded on that side. */
function fieldBounds(testId: string): { min: string | null; max: string | null } {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  return { min: input.getAttribute('min'), max: input.getAttribute('max') }
}

function committedHolePayload(): HoleFeaturePayload {
  const payload = hooks().dag.getNode('F2')?.payload
  if (payload?.opType !== 'hole') throw new Error('F2 must be a committed hole feature')
  return payload as unknown as HoleFeaturePayload
}

/** Cross one matrix cell all the way through the guarded Apply, assert only
 *  against the committed DAG payload, then reopen that committed feature so
 *  the next cell starts from committed state too. */
async function applyAssertCommittedAndReopen(
  assertion: (payload: HoleFeaturePayload) => void,
  reopen = true,
): Promise<void> {
  await waitForReady()
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
  assertion(committedHolePayload())
  if (!reopen) return
  const edit = hooks().editEntryFor('F2')
  if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
  edit.onEdit()
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  await waitForReady()
}

/** Serialize exactly the committed handle's positions, indices, and normals.
 *  Length prefixes make unequal buffer partitions unequal even if concatenated
 *  payload bytes happen to match. The returned Uint8Array is the byte-proof. */
function serializeProofBuffers(tessellation: TessBuffers): Uint8Array {
  const views = [tessellation.position, tessellation.index, tessellation.normal]
  const headerBytes = views.length * Uint32Array.BYTES_PER_ELEMENT
  const output = new Uint8Array(headerBytes + views.reduce((sum, view) => sum + view.byteLength, 0))
  const header = new DataView(output.buffer, output.byteOffset, headerBytes)
  let offset = headerBytes
  views.forEach((view, index) => {
    header.setUint32(index * Uint32Array.BYTES_PER_ELEMENT, view.byteLength, true)
    output.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset)
    offset += view.byteLength
  })
  return output
}

async function serializeCommittedBody(featureId: string): Promise<Uint8Array> {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`${featureId} must have a committed body handle`)
  return serializeProofBuffers(await hooks().client.tessellate(handle, { deflection: 0.1 }))
}

function previewStatus(): string | null {
  return screen.queryByTestId('hole-preview-status')?.getAttribute('data-status') ?? null
}

async function waitForReady(timeout = 20_000): Promise<void> {
  await waitFor(() => expect(previewStatus()).toBe('ready'), { timeout })
}

/** Every live scene object carrying the WO-042 seed-point highlight key (the
 *  saved-seed marker the edit contract requires). */
function liveSeedHighlightKeys(runtime: FakeSceneRuntime): string[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((object: THREE.Object3D) => !removed.has(object) && typeof object.userData.holeSeedKey === 'string')
    .map((object: THREE.Object3D) => object.userData.holeSeedKey as string)
}

/** Every live scene object carrying the WO-042 saved-face overlay key. */
function liveSavedFaceOverlays(runtime: FakeSceneRuntime): THREE.Object3D[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((object: THREE.Object3D) => !removed.has(object) && typeof object.userData.holeSavedFaceKey === 'string')
}

/** Fake-kernel box body F1 via the real extrude toolbar (default distance). */
async function addFakeBody(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

/** Arm the Hole tool and pick straight down onto the body under (0,0). */
async function armHoleAndPick(runtime: FakeSceneRuntime): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-hole'))
  runtime.rayOverride = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
}

function captureClient(reqs: HoleRequest[]): FakeGeomClient {
  return createFakeGeomClient({
    makeHoleImpl: (req, mintHandle) => {
      reqs.push(req)
      return { ok: true, body: mintHandle(), diagnostics: [] }
    },
  })
}

/** Committed single hole F2 on fake body F1, inserted through the real
 *  history command (draftShellEdit's forceInsert shape) so edit-mode tests
 *  start from an exact known payload. */
const EDIT_SEED: Vec3 = { x: 2, y: 1, z: 10 }
async function insertHoleF2(faceId: string): Promise<Record<string, unknown>> {
  const payload = {
    opType: 'hole',
    ownerId: 'F1',
    faceId,
    points: [{ ...EDIT_SEED }],
    style: { kind: 'simple', diameter: 6 },
    depth: { kind: 'blind', distance: 5 },
    seed: { ...EDIT_SEED },
    normal: { x: 0, y: 0, z: 1 },
    placement: { kind: 'single' },
    name: 'Hole F2',
  }
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id: 'F2',
    kind: 'feature',
    consumes: ['F1'],
    payload,
  }))
  await hooks().fullResync(['F2'])
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
  return payload
}

describe('Hole shared preview session (WO-042)', () => {
  it('create: the ghost previews single/linear/circular pattern points computed from ONE typed seed without authoring, bounded fields clamp at BOTH sides, and Apply commits exactly once with one undo', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    const runtime = await boot(() => client)
    await addFakeBody()
    const historySizeBefore = hooks().history.size()

    await armHoleAndPick(runtime)
    // ONE typed seed drives every computed pattern point below.
    commitField('hole-seed-x', '2')
    commitField('hole-seed-y', '1')
    commitField('hole-seed-z', '30')

    // BELOW the diameter field's min (0.1): the commit clamps to EXACTLY the
    // bound and that exact magnitude reaches the kernel evaluation.
    commitField('hole-diameter', '0.05')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 0.1 })
    })
    // An in-range value passes through EXACTLY (no upper bound on diameter).
    commitField('hole-diameter', '8')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 8 })
    })
    // BELOW the blind-depth field's min (0.1): clamps to exactly the bound.
    commitField('hole-blind-distance', '0.05')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.depth).toEqual({ kind: 'blind', distance: 0.1 })
    })
    commitField('hole-blind-distance', '5')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.depth).toEqual({ kind: 'blind', distance: 5 })
    })
    // The other depth kind reaches the kernel exactly.
    fireEvent.change(screen.getByTestId('hole-depth-select'), { target: { value: 'throughAll' } })
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.depth).toEqual({ kind: 'throughAll' })
    })
    fireEvent.change(screen.getByTestId('hole-depth-select'), { target: { value: 'blind' } })
    await waitForReady()

    // Countersink angle is the one hole field bounded on BOTH sides [1, 179]:
    // both violations clamp to exactly the bound.
    fireEvent.change(screen.getByTestId('hole-style-select'), { target: { value: 'countersink' } })
    commitField('hole-cs-angle', '0.5')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'countersink', diameter: 8, csDiameter: 9, csAngleDeg: 1 })
    })
    commitField('hole-cs-angle', '200')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'countersink', diameter: 8, csDiameter: 9, csAngleDeg: 179 })
    })
    fireEvent.change(screen.getByTestId('hole-style-select'), { target: { value: 'simple' } })
    await waitForReady()

    // SINGLE placement: exactly the typed seed, once.
    expect(reqs.at(-1)?.points).toEqual([{ x: 2, y: 1, z: 30 }])
    const pickedFace = reqs.at(-1)!.face
    expect(pickedFace).toMatch(/./)
    expect(reqs.every((req) => req.face === pickedFace && req.featureId === 'F2')).toBe(true)

    // LINEAR placement: count clamps below ITS min (2), then the points walk
    // the derived in-plane u for a +Z face normal (0,-1,0) -- exactly
    // seed, seed - (0,10,0). Computed, never re-picked.
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'linear' } })
    commitField('hole-pattern-count', '1')
    commitField('hole-pattern-spacing', '10')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.points).toEqual([
        { x: 2, y: 1, z: 30 },
        { x: 2, y: -9, z: 30 },
      ])
    })

    // CIRCULAR placement: a 4-hole bolt circle about the same single seed --
    // point i sits at seed + u*(r cos theta_i) + v*(r sin theta_i) with
    // u=(0,-1,0), v=(1,0,0), theta_i = i*2pi/4 (start angle 0).
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'circular' } })
    commitField('hole-pattern-count', '4')
    commitField('hole-pattern-radius', '5')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.points).toHaveLength(4)
    })
    const circular = reqs.at(-1)!.points
    for (let i = 0; i < 4; i++) {
      const theta = (i * 2 * Math.PI) / 4
      expect(circular[i].x).toBeCloseTo(2 + 5 * Math.sin(theta), 10)
      expect(circular[i].y).toBeCloseTo(1 - 5 * Math.cos(theta), 10)
      expect(circular[i].z).toBeCloseTo(30, 10)
    }

    // Ghost painted, seed marker live at the EXACT typed seed, NOTHING
    // authored: no dag node, no history entry.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(liveSeedHighlightKeys(runtime)).toEqual(['2,1,30'])
    expect(hooks().dag.has('F2')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Apply the SINGLE configuration: exact committed content, not counts.
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'single' } })
    await waitForReady()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(hooks().dag.getNode('F2')?.payload).toEqual({
      opType: 'hole',
      ownerId: 'F1',
      faceId: pickedFace,
      points: [{ x: 2, y: 1, z: 30 }],
      style: { kind: 'simple', diameter: 8 },
      depth: { kind: 'blind', distance: 5 },
      seed: { x: 2, y: 1, z: 30 },
      normal: { x: 0, y: 0, z: 1 },
      placement: { kind: 'single' },
      name: 'Hole F2',
    })
    expect(hooks().dag.getNode('F2')?.consumes).toEqual(['F1'])
    // Session closed with the dialog: ghost and seed marker fully gone.
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())
    expect(liveSeedHighlightKeys(runtime)).toHaveLength(0)

    // ONE undo step removes the whole Apply.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))
    expect(hooks().history.size()).toBe(historySizeBefore)
  }, 60_000)

  it('edit: restores and visibly highlights the saved face reference AND seed point, hides the current result behind the ghost, Cancel restores unchanged, Apply is one undo step', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    const runtime = await boot(() => client)
    await addFakeBody()
    const savedFace = hooks().getBodyFaceIds('F1')![0]
    const savedPayload = await insertHoleF2(savedFace)

    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    // The SAVED face reference is restored and selected at edit entry.
    expect(hooks().getPickHighlightState(savedFace)).toBe('selected')
    await waitForReady()

    // ...and VISIBLY highlighted: a live interaction overlay keyed by the
    // exact saved face paints a selected face fill over the ghost.
    const overlays = liveSavedFaceOverlays(runtime)
    expect(overlays.map((o) => o.userData.holeSavedFaceKey)).toEqual([savedFace])
    let selectedFill = 0
    overlays[0].traverse((child) => {
      if (child.userData.interactionKind === 'face-fill' && child.userData.interactionVariant === 'selected') selectedFill += 1
    })
    expect(selectedFill).toBe(1)
    // The SAVED seed point is visibly highlighted at its exact coordinates.
    expect(liveSeedHighlightKeys(runtime)).toEqual([`${EDIT_SEED.x},${EDIT_SEED.y},${EDIT_SEED.z}`])
    // The feature's committed result hides behind the live ghost. Awaited, not
    // asserted straight after waitForReady(): the ghost swap can land a render
    // tick after the readiness this test already waited on, and asserting it
    // synchronously raced under fleet load and failed WO-1299's lane on
    // 2026-09-09 with "expected true to be false". Both facts are still
    // required, and required together.
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
      expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    })

    // A changed diameter re-evaluates the ghost ONLY: the committed payload
    // is untouched while previewing, and the request is exact.
    commitField('hole-diameter', '9')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })
    })
    expect(reqs.at(-1)?.points).toEqual([{ ...EDIT_SEED }])
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)

    // Cancel: presentation and document restored unchanged; face and seed
    // highlights torn down with the dialog, selection restored.
    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
      expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    })
    expect(liveSavedFaceOverlays(runtime)).toHaveLength(0)
    expect(liveSeedHighlightKeys(runtime)).toHaveLength(0)
    expect(hooks().getPickHighlightState(savedFace)).toBe('none')
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Apply an edit and undo it in ONE step -- exact payload both ways.
    const secondEdit = hooks().editEntryFor('F2')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F2 must route to its Hole edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    commitField('hole-diameter', '9')

    // WO-1811: keep the original generic-ready schedule, but make a future
    // recurrence stop at its FIRST divergent boundary instead of reporting
    // only the final committed 6-vs-9 mismatch. These are observations after
    // the original wait, not a stronger condition inside that wait.
    const diameterInput = screen.getByTestId('hole-diameter').querySelector('input') as HTMLInputElement
    expect(diameterInput.value).toBe('9')
    await waitForReady()
    const traceBeforeApply = {
      domValue: diameterInput.value,
      previewStatus: previewStatus(),
      latestRequest: reqs.at(-1),
      authoredPayload: hooks().dag.getNode('F2')?.payload,
      historySize: hooks().history.size(),
    }
    expect(traceBeforeApply.latestRequest?.style).toEqual({ kind: 'simple', diameter: 9 })
    expect(traceBeforeApply.previewStatus).toBe('ready')
    expect(traceBeforeApply.authoredPayload).toEqual(savedPayload)

    const apply = screen.getByTestId('dialog-shell-apply')
    let applyClicks = 0
    apply.addEventListener('click', () => { applyClicks += 1 })
    fireEvent.click(apply)
    expect(applyClicks).toBe(1)
    await waitFor(() => expect(
      hooks().dag.getNode('F2')?.payload.style,
      `WO-1811 boundary trace: ${JSON.stringify({ ...traceBeforeApply, applyClicks, authoredPayload: hooks().dag.getNode('F2')?.payload })}`,
    ).toEqual({ kind: 'simple', diameter: 9 }))
    expect(hooks().dag.getNode('F2')?.payload).toEqual({ ...savedPayload, style: { kind: 'simple', diameter: 9 } })
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload))
  }, 60_000)

  it('edit with delayed supersession: restores and visibly highlights the saved face reference AND seed point, hides the current result behind the ghost, Cancel restores unchanged, Apply is one undo step', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    const realMakeHole = client.makeHole.bind(client)
    let delayDiameter8 = false
    let releaseDiameter8 = (): void => undefined
    const diameter8Gate = new Promise<void>((resolve) => { releaseDiameter8 = resolve })
    client.makeHole = async (req) => {
      const result = await realMakeHole(req)
      if (delayDiameter8 && req.style.diameter === 8) {
        delayDiameter8 = false
        await diameter8Gate
      }
      return result
    }
    const runtime = await boot(() => client)
    await addFakeBody()
    const savedFace = hooks().getBodyFaceIds('F1')![0]
    const savedPayload = await insertHoleF2(savedFace)

    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    // The SAVED face reference is restored and selected at edit entry.
    expect(hooks().getPickHighlightState(savedFace)).toBe('selected')
    await waitForReady()

    // ...and VISIBLY highlighted: a live interaction overlay keyed by the
    // exact saved face paints a selected face fill over the ghost.
    const overlays = liveSavedFaceOverlays(runtime)
    expect(overlays.map((o) => o.userData.holeSavedFaceKey)).toEqual([savedFace])
    let selectedFill = 0
    overlays[0].traverse((child) => {
      if (child.userData.interactionKind === 'face-fill' && child.userData.interactionVariant === 'selected') selectedFill += 1
    })
    expect(selectedFill).toBe(1)
    // The SAVED seed point is visibly highlighted at its exact coordinates.
    expect(liveSeedHighlightKeys(runtime)).toEqual([`${EDIT_SEED.x},${EDIT_SEED.y},${EDIT_SEED.z}`])
    // The feature's committed result hides behind the live ghost. Awaited, not
    // asserted straight after waitForReady(): the ghost swap can land a render
    // tick after the readiness this test already waited on, and asserting it
    // synchronously raced under fleet load and failed WO-1299's lane on
    // 2026-09-09 with "expected true to be false". Both facts are still
    // required, and required together.
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
      expect(hooks().getBodyPresentationVisible('F2')).toBe(false)
    })

    // A changed diameter re-evaluates the ghost ONLY: the committed payload
    // is untouched while previewing, and the request is exact.
    commitField('hole-diameter', '9')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })
    })
    expect(reqs.at(-1)?.points).toEqual([{ ...EDIT_SEED }])
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)

    // Cancel: presentation and document restored unchanged; face and seed
    // highlights torn down with the dialog, selection restored.
    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
      expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    })
    expect(liveSavedFaceOverlays(runtime)).toHaveLength(0)
    expect(liveSeedHighlightKeys(runtime)).toHaveLength(0)
    expect(hooks().getPickHighlightState(savedFace)).toBe('none')
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Apply an edit and undo it in ONE step -- exact payload both ways.
    const secondEdit = hooks().editEntryFor('F2')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F2 must route to its Hole edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    // Establish which intent owns the rendered ready flag before editing. A
    // generic ready check alone cannot distinguish this saved diameter-6
    // preview from the diameter-9 preview Apply must publish.
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 6 })
    })

    // Hold an intermediate diameter-8 evaluation, then commit diameter 9.
    // The single-flight preview session must supersede the late 8 result and
    // accept 9. This controlled ordering also makes the field-commit boundary
    // observable: the input says 9 while the last kernel request is still 8.
    delayDiameter8 = true
    commitField('hole-diameter', '8')
    await waitFor(() => {
      expect(previewStatus()).toBe('pending')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 8 })
    })
    commitField('hole-diameter', '9')
    expect((screen.getByTestId('hole-diameter').querySelector('input') as HTMLInputElement).value).toBe('9')
    expect(previewStatus()).toBe('pending')
    expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 8 })
    releaseDiameter8()
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.style).toEqual({ kind: 'simple', diameter: 9 }))
    expect(hooks().dag.getNode('F2')?.payload).toEqual({ ...savedPayload, style: { kind: 'simple', diameter: 9 } })
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload))
  }, 60_000)

  it('edit diagnostic: an immediate Apply waits for the committed diameter-9 preview before authoring', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    const realMakeHole = client.makeHole.bind(client)
    let releaseDiameter9 = (): void => undefined
    const diameter9Gate = new Promise<void>((resolve) => { releaseDiameter9 = resolve })
    client.makeHole = async (req) => {
      const result = await realMakeHole(req)
      if (req.style.diameter === 9) await diameter9Gate
      return result
    }
    await boot(() => client)
    await addFakeBody()
    const savedFace = hooks().getBodyFaceIds('F1')![0]
    const savedPayload = await insertHoleF2(savedFace)

    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 6 })
    })

    const historySizeBefore = hooks().history.size()
    const apply = screen.getByTestId('dialog-shell-apply')
    let applyClicks = 0
    apply.addEventListener('click', () => { applyClicks += 1 })

    // This is the missing commit-vs-Apply boundary: commit the field and click
    // Apply immediately, without first waiting for a rendered ready flag. The
    // exact diameter-9 request is held so the guard must remain pending.
    commitField('hole-diameter', '9')
    fireEvent.click(apply)
    expect(applyClicks).toBe(1)
    expect((screen.getByTestId('hole-diameter').querySelector('input') as HTMLInputElement).value).toBe('9')
    await waitFor(() => {
      expect(previewStatus()).toBe('pending')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })
    })
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)
    expect(hooks().history.size()).toBe(historySizeBefore)

    releaseDiameter9()
    await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload).toEqual({ ...savedPayload, style: { kind: 'simple', diameter: 9 } })
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload))
  }, 60_000)

  it('edit diagnostic: a cancelled edit completion cannot replace a reopened edit intent', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    const realMakeHole = client.makeHole.bind(client)
    let releaseDiameter8 = (): void => undefined
    let cancelledCandidate: number | undefined
    const diameter8Gate = new Promise<void>((resolve) => { releaseDiameter8 = resolve })
    client.makeHole = async (req) => {
      const result = await realMakeHole(req)
      if (req.style.diameter === 8) {
        cancelledCandidate = result.body
        await diameter8Gate
      }
      return result
    }
    await boot(() => client)
    await addFakeBody()
    const savedFace = hooks().getBodyFaceIds('F1')![0]
    const savedPayload = await insertHoleF2(savedFace)

    const firstEdit = hooks().editEntryFor('F2')
    if (firstEdit === undefined || !('onEdit' in firstEdit)) throw new Error('F2 must route to its Hole edit dialog')
    firstEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitForReady()
    commitField('hole-diameter', '8')
    await waitFor(() => {
      expect(previewStatus()).toBe('pending')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 8 })
    })
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)

    const secondEdit = hooks().editEntryFor('F2')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F2 must route to its Hole edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 6 })
    })
    commitField('hole-diameter', '9')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })
    })

    // Release the cancelled session only after the reopened session owns a
    // ready diameter-9 candidate. Disposal proves the late work completed;
    // the current DOM/request/readiness must remain owned by the new session.
    releaseDiameter8()
    await waitFor(() => expect(client.disposedHandles).toContain(cancelledCandidate))
    expect((screen.getByTestId('hole-diameter').querySelector('input') as HTMLInputElement).value).toBe('9')
    expect(previewStatus()).toBe('ready')
    expect(reqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })

    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload).toEqual({ ...savedPayload, style: { kind: 'simple', diameter: 9 } })
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
  }, 60_000)

  it('edit diagnostic: pending work from an unmounted page cannot leak into a fresh page', async () => {
    const firstReqs: HoleRequest[] = []
    const firstClient = captureClient(firstReqs)
    const firstMakeHole = firstClient.makeHole.bind(firstClient)
    let releaseOldDiameter8 = (): void => undefined
    let unmountedCandidate: number | undefined
    const oldDiameter8Gate = new Promise<void>((resolve) => { releaseOldDiameter8 = resolve })
    firstClient.makeHole = async (req) => {
      const result = await firstMakeHole(req)
      if (req.style.diameter === 8) {
        unmountedCandidate = result.body
        await oldDiameter8Gate
      }
      return result
    }
    await boot(() => firstClient)
    await addFakeBody()
    const firstFace = hooks().getBodyFaceIds('F1')![0]
    await insertHoleF2(firstFace)
    const firstEdit = hooks().editEntryFor('F2')
    if (firstEdit === undefined || !('onEdit' in firstEdit)) throw new Error('F2 must route to its Hole edit dialog')
    firstEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitForReady()
    commitField('hole-diameter', '8')
    await waitFor(() => {
      expect(previewStatus()).toBe('pending')
      expect(firstReqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 8 })
    })

    cleanup()

    const freshReqs: HoleRequest[] = []
    const freshClient = captureClient(freshReqs)
    await boot(() => freshClient)
    expect(hooks().client).toBe(freshClient)
    await addFakeBody()
    const freshFace = hooks().getBodyFaceIds('F1')![0]
    const freshPayload = await insertHoleF2(freshFace)
    const freshEdit = hooks().editEntryFor('F2')
    if (freshEdit === undefined || !('onEdit' in freshEdit)) throw new Error('F2 must route to its Hole edit dialog')
    freshEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitForReady()
    commitField('hole-diameter', '9')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(freshReqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })
    })

    // Settle the abandoned page only after the fresh page is ready. The old
    // candidate must be disposed by its cancelled session, while the global
    // hooks and exact request/status remain those of the fresh page.
    releaseOldDiameter8()
    await waitFor(() => expect(firstClient.disposedHandles).toContain(unmountedCandidate))
    expect(hooks().client).toBe(freshClient)
    expect((screen.getByTestId('hole-diameter').querySelector('input') as HTMLInputElement).value).toBe('9')
    expect(previewStatus()).toBe('ready')
    expect(freshReqs.at(-1)?.style).toEqual({ kind: 'simple', diameter: 9 })

    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
    expect(hooks().dag.getNode('F2')?.payload).toEqual({ ...freshPayload, style: { kind: 'simple', diameter: 9 } })
    expect(hooks().history.size()).toBe(historySizeBefore + 1)
  }, 60_000)

  // WO-030's audit lesson, REQUIRED here from day one: the model mutates
  // AFTER the ready preview and Apply fires with UNCHANGED dialog values, so
  // no re-evaluation intervenes -- the commit itself must refuse against the
  // stale session baseline.
  it('apply guard: a model change after a ready preview refuses an immediate Apply with unchanged values', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    const runtime = await boot(() => client)
    await addFakeBody()
    await armHoleAndPick(runtime)
    await waitForReady()

    // Another actor mutates the document. Nothing touches the dialog, so no
    // preview re-request runs and the session still holds a ready candidate.
    hooks().dag.insertNode({
      id: 'param:external-drift',
      kind: 'parameter',
      consumes: [],
      refs: [],
      payload: { name: 'external', expression: '9', value: 9 },
    })
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(screen.getByTestId('hole-apply-error').textContent).toMatch(/model changed/i))
    // REFUSED: no committed node, no history entry, ghost torn down.
    expect(hooks().dag.has('F2')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
    expect(previewStatus()).toBe('idle')
  }, 60_000)

  // Drive the adapter through the session's TERMINAL error result -- distinct
  // from Cancel and from an evaluate refusal: the candidate evaluates fine,
  // then the ghost PRESENTATION throws. The session must land the honest
  // teardown: ghost gone, committed presentation restored, history untouched.
  it('error: a ghost paint failure takes the terminal error path and restores the committed presentation', async () => {
    const reqs: HoleRequest[] = []
    const client = captureClient(reqs)
    await boot(() => client)
    await addFakeBody()
    const savedFace = hooks().getBodyFaceIds('F1')![0]
    const savedPayload = await insertHoleF2(savedFace)

    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitForReady()
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    const historySizeBefore = hooks().history.size()

    // Detonate the NEXT tessellation only: evaluation succeeds, the paint
    // inside presentCandidate throws -> FeaturePreviewSession's terminal
    // 'error' result.
    const realTessellate = client.tessellate.bind(client)
    let armed = true
    client.tessellate = async (handle, quality) => {
      if (armed) {
        armed = false
        throw new Error('ghost paint exploded')
      }
      return realTessellate(handle, quality)
    }

    commitField('hole-diameter', '4')
    await waitFor(() => {
      expect(previewStatus()).toBe('refused')
      expect(screen.getByTestId('hole-preview-status').textContent).toMatch(/ghost paint exploded/i)
    })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    // Honest teardown: ghost gone, the committed F2 presentation restored,
    // document and history untouched.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)
    expect(hooks().history.size()).toBe(historySizeBefore)
  }, 60_000)

  it('real kernel: the ghost is REAL drilled geometry tracking the typed diameter without authoring, and Apply commits the same geometry once', async () => {
    const runtime = await boot(createLocalGeomService)
    // Same box fixture as SolidsWorkbenchPage.hole.test.tsx: sketch 40x20
    // offset 10, extrude 20 -> box x:[10,50] y:[0,20] z:[0,20], volume 16000.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-hole'))
    // top face z=20, point (20,5,20) -- well inside x:[10,50] y:[0,20].
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())

    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '5')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    }, { timeout: 20_000 })
    // EXACT geometry, not counts: the ghost's real tessellated top face sits
    // at the box height, the owner hides behind it, and NOTHING was authored.
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(20, 6)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
    expect(hooks().dag.has('F2')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)
    // The seed marker sits at the exact displayed seed.
    const seedKey = ['hole-seed-x', 'hole-seed-y', 'hole-seed-z']
      .map((id) => (screen.getByTestId(id).querySelector('input') as HTMLInputElement).value)
      .join(',')
    expect(liveSeedHighlightKeys(runtime)).toEqual([seedKey])
    const hashAt6 = hooks().getBodyGeometryHash(GHOST_ID)
    expect(hashAt6).not.toBeUndefined()

    // The ghost TRACKS the typed diameter with real kernel geometry: a wider
    // hole re-tessellates to DIFFERENT buffer content at the same height.
    commitField('hole-diameter', '10')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(hooks().getBodyGeometryHash(GHOST_ID)).not.toBe(hashAt6)
    }, { timeout: 20_000 })
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(20, 6)
    expect(hooks().dag.has('F2')).toBe(false)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    // The committed body is the SAME geometry the ghost previewed: box minus
    // one blind hole, diameter 10 (r=5), depth 5.
    const committed = hooks().getBodyHandle('F2')!
    const volume = (await hooks().client.measure(committed, 'volume')).value
    const expected = 16000 - Math.PI * 25 * 5
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-3)
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())
    expect(liveSeedHighlightKeys(runtime)).toHaveLength(0)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))
  }, 90_000)
})

// WO-054 closure 1: EVERY matrix crossing reaches guarded Apply and is asserted
// on the committed F2 DAG payload. Preview requests are intentionally not proof
// targets here: the fake kernel uses them as scratch evaluations.
describe('Hole bounded-field committed matrix (WO-054)', () => {
  it('commits every clamp and unbounded-above extreme to the feature payload', async () => {
    const client = captureClient([])
    const runtime = await boot(() => client)
    await addFakeBody()
    const historySizeBefore = hooks().history.size()
    await armHoleAndPick(runtime)
    commitField('hole-seed-x', '2')
    commitField('hole-seed-y', '1')
    commitField('hole-seed-z', '30')

    // MODAL PARITY: the dialog's own rendered bounds decide which fields have
    // an upper side. Only the countersink angle is bounded above; the seed
    // and start angle are unbounded on BOTH sides.
    expect(fieldBounds('hole-diameter')).toEqual({ min: '0.1', max: null })
    expect(fieldBounds('hole-blind-distance')).toEqual({ min: '0.1', max: null })
    for (const axis of ['x', 'y', 'z']) {
      expect(fieldBounds(`hole-seed-${axis}`)).toEqual({ min: null, max: null })
    }

    // Hole diameter [0.1, unbounded): both attempts are committed separately.
    commitField('hole-diameter', '0.05')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'simple', diameter: 0.1 })
    })
    commitField('hole-diameter', '100000')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'simple', diameter: 100000 })
    })
    commitField('hole-diameter', '8')

    // Blind depth [0.1, unbounded).
    commitField('hole-blind-distance', '0.09')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.depth).toEqual({ kind: 'blind', distance: 0.1 })
    })
    commitField('hole-blind-distance', '99999')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.depth).toEqual({ kind: 'blind', distance: 99999 })
    })

    // Counterbore diameter and depth [0.1, unbounded) each.
    fireEvent.change(screen.getByTestId('hole-style-select'), { target: { value: 'counterbore' } })
    expect(fieldBounds('hole-cb-diameter')).toEqual({ min: '0.1', max: null })
    expect(fieldBounds('hole-cb-depth')).toEqual({ min: '0.1', max: null })
    commitField('hole-cb-diameter', '0.05')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'counterbore', diameter: 8, cbDiameter: 0.1, cbDepth: 2 })
    })
    commitField('hole-cb-diameter', '5000')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'counterbore', diameter: 8, cbDiameter: 5000, cbDepth: 2 })
    })
    commitField('hole-cb-depth', '0.02')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'counterbore', diameter: 8, cbDiameter: 5000, cbDepth: 0.1 })
    })
    commitField('hole-cb-depth', '4000')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'counterbore', diameter: 8, cbDiameter: 5000, cbDepth: 4000 })
    })

    // Countersink diameter [0.1, unbounded); angle [1, 179] is the ONE hole
    // field bounded on both sides -- both crossings clamp to the exact bound.
    fireEvent.change(screen.getByTestId('hole-style-select'), { target: { value: 'countersink' } })
    expect(fieldBounds('hole-cs-diameter')).toEqual({ min: '0.1', max: null })
    expect(fieldBounds('hole-cs-angle')).toEqual({ min: '1', max: '179' })
    commitField('hole-cs-diameter', '0.01')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'countersink', diameter: 8, csDiameter: 0.1, csAngleDeg: 90 })
    })
    commitField('hole-cs-diameter', '6000')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'countersink', diameter: 8, csDiameter: 6000, csAngleDeg: 90 })
    })
    commitField('hole-cs-angle', '0.5')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'countersink', diameter: 8, csDiameter: 6000, csAngleDeg: 1 })
    })
    commitField('hole-cs-angle', '200')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.style).toEqual({ kind: 'countersink', diameter: 8, csDiameter: 6000, csAngleDeg: 179 })
    })
    fireEvent.change(screen.getByTestId('hole-style-select'), { target: { value: 'simple' } })

    // Pattern count [2, unbounded int) and linear spacing [0.1, unbounded).
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'linear' } })
    expect(fieldBounds('hole-pattern-count')).toEqual({ min: '2', max: null })
    expect(fieldBounds('hole-pattern-spacing')).toEqual({ min: '0.1', max: null })
    commitField('hole-pattern-count', '1')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'linear', count: 2, spacing: 10 })
      expect(payload.points).toHaveLength(2)
    })
    commitField('hole-pattern-count', '250')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'linear', count: 250, spacing: 10 })
      expect(payload.points).toHaveLength(250)
    })
    commitField('hole-pattern-count', '2')
    commitField('hole-pattern-spacing', '0.05')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'linear', count: 2, spacing: 0.1 })
      expect(payload.points[1]).toEqual({ x: 2, y: 1 - 0.1, z: 30 })
    })
    commitField('hole-pattern-spacing', '9999')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'linear', count: 2, spacing: 9999 })
      expect(payload.points[1]).toEqual({ x: 2, y: 1 - 9999, z: 30 })
    })

    // Circular radius [0.1, unbounded); start angle unbounded BOTH sides.
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'circular' } })
    expect(fieldBounds('hole-pattern-radius')).toEqual({ min: '0.1', max: null })
    expect(fieldBounds('hole-pattern-start-angle')).toEqual({ min: null, max: null })
    commitField('hole-pattern-radius', '0.04')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'circular', count: 2, radius: 0.1, startAngleDeg: 0 })
      expect(payload.points[0].y).toBeCloseTo(1 - 0.1, 10)
    })
    commitField('hole-pattern-radius', '12345')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'circular', count: 2, radius: 12345, startAngleDeg: 0 })
      expect(payload.points[0].y).toBeCloseTo(1 - 12345, 8)
    })

    // Unbounded start angle and seed coordinates each commit an extreme value
    // unchanged; these are matrix cells too, not modal-only assertions.
    commitField('hole-pattern-start-angle', '987654')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.placement).toEqual({ kind: 'circular', count: 2, radius: 12345, startAngleDeg: 987654 })
    })
    fireEvent.change(screen.getByTestId('hole-placement-select'), { target: { value: 'single' } })
    commitField('hole-seed-x', '100001')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.seed).toEqual({ x: 100001, y: 1, z: 30 })
    })
    commitField('hole-seed-y', '100002')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.seed).toEqual({ x: 100001, y: 100002, z: 30 })
    })
    commitField('hole-seed-z', '100003')
    await applyAssertCommittedAndReopen((payload) => {
      expect(payload.seed).toEqual({ x: 100001, y: 100002, z: 100003 })
    }, false)

    // One create plus 21 edit commits: every matrix attempt crossed Apply.
    expect(hooks().history.size()).toBe(historySizeBefore + 22)
  }, 120_000)
})

// WO-054 closure 2: proof bytes come from re-tessellating the committed handle
// itself before and after each restoration path. No cached presentation mesh is
// accepted as evidence. The serialized bytes contain positions + indices +
// normals, with the real kernel used for both restoration paths.
describe('Hole preview committed-handle restoration (WO-054)', () => {
  it('real kernel Cancel: re-tessellated committed positions, indices, and normals are byte-equal', async () => {
    const runtime = await boot(createLocalGeomService)
    // Same real box fixture as the WO-042 real-kernel test: 40x20 sketch
    // offset 10, extrude 20.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // Commit a REAL drilled hole F2 through the dialog.
    fireEvent.click(screen.getByTestId('workbench-hole'))
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '5')
    await waitForReady()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyPresentationVisible('F2')).toBe(true))

    // Capture proof bytes by tessellating the committed handle BEFORE preview.
    const handleBefore = hooks().getBodyHandle('F2')
    const geometryBefore = await serializeCommittedBody('F2')
    const payloadBefore = hooks().dag.getNode('F2')?.payload
    expect(handleBefore).not.toBeUndefined()
    expect(geometryBefore.byteLength).toBeGreaterThan(0)
    const historySizeBefore = hooks().history.size()

    // Open the edit preview and actually preview DIFFERENT geometry.
    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitForReady()
    commitField('hole-diameter', '10')
    await waitForReady()
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().getBodyPresentationVisible('F2')).toBe(false)

    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
      expect(hooks().getBodyPresentationVisible('F2')).toBe(true)
    })
    // Re-tessellate the committed handle AFTER Cancel and byte-compare the
    // complete proof serialization, independent of the presentation cache.
    const geometryAfter = await serializeCommittedBody('F2')
    expect(hooks().getBodyHandle('F2')).toEqual(handleBefore)
    expect(geometryAfter).toEqual(geometryBefore)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(payloadBefore)
    expect(hooks().history.size()).toBe(historySizeBefore)
  }, 120_000)

  it('real kernel terminal error: re-tessellated committed positions, indices, and normals are byte-equal', async () => {
    const runtime = await boot(createLocalGeomService)
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // Commit a REAL drilled hole F2 through the dialog, so the serialized
    // proof bytes below depend on the exact committed kernel handle.
    fireEvent.click(screen.getByTestId('workbench-hole'))
    runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '5')
    await waitForReady()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyPresentationVisible('F2')).toBe(true))
    const savedPayload = hooks().dag.getNode('F2')?.payload
    const client = hooks().client

    const handleBefore = hooks().getBodyHandle('F2')
    const geometryBefore = await serializeCommittedBody('F2')
    expect(handleBefore).not.toBeUndefined()
    expect(geometryBefore.byteLength).toBeGreaterThan(0)
    const historySizeBefore = hooks().history.size()

    const edit = hooks().editEntryFor('F2')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F2 must route to its Hole edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    await waitForReady()

    // Detonate the NEXT tessellation only: evaluation succeeds, the ghost
    // paint throws -> the session's TERMINAL error result.
    const realTessellate = client.tessellate.bind(client)
    let armed = true
    client.tessellate = async (handle, quality) => {
      if (armed) {
        armed = false
        throw new Error('ghost paint exploded')
      }
      return realTessellate(handle, quality)
    }
    commitField('hole-diameter', '4')
    await waitFor(() => expect(previewStatus()).toBe('refused'))
    await waitFor(() => expect(hooks().getBodyPresentationVisible('F2')).toBe(true))

    // Re-tessellate the committed handle after terminal teardown. The one-shot
    // paint failure is disarmed, so this reads the restored body itself.
    const geometryAfterError = await serializeCommittedBody('F2')
    expect(hooks().getBodyHandle('F2')).toEqual(handleBefore)
    expect(geometryAfterError).toEqual(geometryBefore)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(savedPayload)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // ...and the committed-handle bytes survive closing the dead dialog too.
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('hole-diameter')).toBeNull())
    expect(hooks().getBodyHandle('F2')).toEqual(handleBefore)
    expect(await serializeCommittedBody('F2')).toEqual(geometryBefore)
  }, 120_000)
})
