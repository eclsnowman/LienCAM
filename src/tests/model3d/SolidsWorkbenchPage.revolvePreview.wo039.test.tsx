// @vitest-environment jsdom
//
// WO-039 (UI-107 slice 3): Revolve create/edit on the shared
// FeaturePreviewSession contract -- a real-kernel ghost of the revolved
// result previews while the dialog is open WITHOUT appending history; Apply
// commits ONCE with one undo step behind the commit-time guard (accepted
// intent + authored-state fingerprint); Cancel and the terminal error path
// restore the original presentation unchanged; edit restores and visibly
// highlights the saved profile AND the axis reference (fixed world-Z, carried
// in every preview intent and painted as a highlight line in the viewport).
// This is extrude's WO-035 profile-consuming template plus the axis reference
// the WO-019 census names.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient, type FakeGeomClient } from './fakeGeomClient'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { RevolveRequest } from '../../geom/geom-service'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'

const GHOST_ID = '__revolve-preview__'
const WORLD_Z_AXIS = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }
const LOAD_TOLERANT_TEST_TIMEOUT_MS = 20_000

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
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  return runtime as unknown as FakeSceneRuntime
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function previewStatus(): string | null {
  return screen.queryByTestId('revolve-preview-status')?.getAttribute('data-status') ?? null
}

async function waitForReady(): Promise<void> {
  await waitFor(() => expect(previewStatus()).toBe('ready'))
}

/** Every live scene object carrying a profile-pick outline key (the saved-
 *  profile highlight the edit contract requires). */
function liveProfileOutlineKeys(runtime: FakeSceneRuntime): string[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((object: THREE.Object3D) => !removed.has(object) && typeof object.userData.profilePickRegionKey === 'string')
    .map((object: THREE.Object3D) => object.userData.profilePickRegionKey as string)
}

/** Every live scene object carrying the WO-039 axis-reference highlight key
 *  (the saved-axis highlight the edit contract requires). */
function liveAxisHighlightKeys(runtime: FakeSceneRuntime): string[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((object: THREE.Object3D) => !removed.has(object) && typeof object.userData.revolveAxisKey === 'string')
    .map((object: THREE.Object3D) => object.userData.revolveAxisKey as string)
}

function fakeClientCapturing(reqs: RevolveRequest[]): FakeGeomClient {
  return createFakeGeomClient({
    makeRevolveImpl: (req, mintHandle) => {
      reqs.push(req)
      return { ok: true, body: mintHandle(), diagnostics: [] }
    },
  })
}

async function buildFirstRevolve(angleDeg = '270'): Promise<void> {
  await mintRectangleSketch({ plane: 'xz' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-revolve'))
  commitField('revolve-angle', angleDeg)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

describe('Revolve shared preview session (WO-039)', () => {
  it('create: the ghost previews without authoring, the bounded angle clamps at BOTH sides, every request carries the world-Z axis, and Apply commits exactly once with one undo', async () => {
    const reqs: RevolveRequest[] = []
    const client = fakeClientCapturing(reqs)
    const runtime = await boot(() => client)
    await mintRectangleSketch({ plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    // BELOW the field's min (1): the commit clamps to EXACTLY the bound and
    // that exact magnitude -- never the sub-min raw value -- reaches the
    // kernel evaluation.
    commitField('revolve-angle', '0.5')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.angleDeg).toBe(1)
    })
    expect(reqs.at(-1)?.op).toBe('newBody')
    // The axis reference is exactly the world-Z axis through the origin.
    expect(reqs.at(-1)?.axis).toEqual(WORLD_Z_AXIS)
    // ABOVE the field's max (360): the commit clamps to EXACTLY the bound.
    commitField('revolve-angle', '400')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.angleDeg).toBe(360)
    })
    expect(reqs.at(-1)?.axis).toEqual(WORLD_Z_AXIS)

    // The axis-reference highlight is painted while the dialog previews.
    expect(liveAxisHighlightKeys(runtime)).toEqual(['world-z'])

    // Ghost painted, NOTHING authored: no dag node, no history entry.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    // Exact committed content, not counts: the payload is byte-for-byte what
    // the dialog authored and consumes is exactly the sketch.
    expect(hooks().dag.getNode('F1')?.payload).toEqual({
      opType: 'revolve',
      sketchId: 'SK1',
      angleDeg: 360,
      name: 'Revolve F1',
    })
    expect(hooks().dag.getNode('F1')?.consumes).toEqual(['SK1'])
    // Session closed with the dialog: ghost and axis highlight fully gone.
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())
    expect(liveAxisHighlightKeys(runtime)).toHaveLength(0)

    // ONE undo step covers the whole Apply (feature + its auto-hidden sketch).
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    expect(hooks().dag.getNode('SK1')?.hidden).toBe(false)
  })

  it('edit: restores and visibly highlights the saved profile AND axis reference, hides the current result behind the ghost, Cancel restores unchanged, Apply is one undo step', async () => {
    const reqs: RevolveRequest[] = []
    const client = fakeClientCapturing(reqs)
    const runtime = await boot(() => client)
    await buildFirstRevolve('270')

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 must route to its Revolve edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('revolve-angle')).toBeTruthy())
    await waitForReady()

    // The SAVED profile is restored and visibly highlighted -- the exact
    // whole-sketch key for SK1, even though the consumed sketch is hidden.
    await waitFor(() => expect(liveProfileOutlineKeys(runtime)).toContain('SK1:whole-sketch'))
    // The SAVED axis reference is visibly highlighted: exactly one world-Z
    // axis line lives in the scene.
    expect(liveAxisHighlightKeys(runtime)).toEqual(['world-z'])
    // The feature's committed result hides behind the live ghost.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)

    // A changed angle re-evaluates the ghost ONLY -- the committed payload
    // is untouched while previewing, and the request is the exact angle.
    commitField('revolve-angle', '90')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.angleDeg).toBe(90)
    })
    expect(reqs.at(-1)?.axis).toEqual(WORLD_Z_AXIS)
    expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(270)

    // Cancel: presentation and document restored unchanged; profile and axis
    // highlights torn down with the dialog.
    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
      expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
    })
    expect(liveProfileOutlineKeys(runtime)).toHaveLength(0)
    expect(liveAxisHighlightKeys(runtime)).toHaveLength(0)
    expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(270)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Apply an edit and undo it in ONE step.
    const secondEdit = hooks().editEntryFor('F1')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F1 must route to its Revolve edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('revolve-angle')).toBeTruthy())
    commitField('revolve-angle', '90')
    await waitForReady()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    // WO-123: Apply adopts the ready preview asynchronously. Under full-slice
    // CPU contention it can cross Testing Library's 1s default without being
    // stuck, so await the committed document state with integration headroom.
    await waitFor(
      () => expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(90),
      { timeout: LOAD_TOLERANT_TEST_TIMEOUT_MS },
    )
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(
      () => expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(270),
      { timeout: LOAD_TOLERANT_TEST_TIMEOUT_MS },
    )
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)

  // WO-030's audit lesson, REQUIRED here from day one: the model mutates
  // AFTER the ready preview and Apply fires with UNCHANGED dialog values, so
  // no re-evaluation intervenes -- the commit itself must refuse against the
  // stale session baseline.
  it('apply guard: a model change after a ready preview refuses an immediate Apply with unchanged values', async () => {
    const reqs: RevolveRequest[] = []
    const client = fakeClientCapturing(reqs)
    await boot(() => client)
    await mintRectangleSketch({ plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    commitField('revolve-angle', '180')
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
    await waitFor(() => expect(screen.getByTestId('revolve-apply-error').textContent).toMatch(/model changed/i))
    // REFUSED: no committed node, no history entry, ghost torn down.
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
    expect(previewStatus()).toBe('idle')
  })

  // Drive the adapter through the session's TERMINAL error result -- distinct
  // from Cancel and from an evaluate refusal: the candidate evaluates fine,
  // then the ghost PRESENTATION throws. The session must land the honest
  // teardown: ghost gone, committed presentation restored, history untouched.
  it('error: a ghost paint failure takes the terminal error path and restores the committed presentation', async () => {
    const reqs: RevolveRequest[] = []
    const client = fakeClientCapturing(reqs)
    await boot(() => client)
    await buildFirstRevolve('270')

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 must route to its Revolve edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('revolve-angle')).toBeTruthy())
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

    commitField('revolve-angle', '45')
    await waitFor(() => {
      expect(previewStatus()).toBe('refused')
      expect(screen.getByTestId('revolve-preview-status').textContent).toMatch(/ghost paint exploded/i)
    })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    // Honest teardown: ghost gone, the committed F1 presentation restored,
    // document and history untouched.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
    expect(hooks().dag.getNode('F1')?.payload.angleDeg).toBe(270)
    expect(hooks().history.size()).toBe(historySizeBefore)
  })

  it('real kernel: the ghost is REAL revolve geometry tracking the typed angle without authoring, and Apply commits the same geometry once', async () => {
    await boot(createLocalGeomService)
    // The XZ rectangle spans radius 10..50 and height 20 about the world Z
    // axis; a full revolve's volume is exact by Pappus.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10', plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    commitField('revolve-angle', '360')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    }, { timeout: 20_000 })
    // EXACT geometry, not counts: the ghost's real tessellated top face sits
    // at the profile's height, and NOTHING was authored.
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(20, 6)
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)
    const fullHash = hooks().getBodyGeometryHash(GHOST_ID)
    expect(fullHash).not.toBeUndefined()

    // The ghost TRACKS the typed angle with real kernel geometry: a half
    // revolve re-tessellates to DIFFERENT buffer content at the same height.
    commitField('revolve-angle', '180')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(hooks().getBodyGeometryHash(GHOST_ID)).not.toBe(fullHash)
    }, { timeout: 20_000 })
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(20, 6)
    expect(hooks().dag.has('F1')).toBe(false)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    // The committed body is the SAME geometry the ghost previewed: exactly
    // half the Pappus full-revolve volume.
    const committed = hooks().getBodyHandle('F1')!
    const volume = (await hooks().client.measure(committed, 'volume')).value
    const expectedHalfVolume = (Math.PI * (50 * 50 - 10 * 10) * 20) / 2
    expect(Math.abs(volume - expectedHalfVolume) / expectedHalfVolume).toBeLessThan(1e-6)
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
  }, 90_000)
})
