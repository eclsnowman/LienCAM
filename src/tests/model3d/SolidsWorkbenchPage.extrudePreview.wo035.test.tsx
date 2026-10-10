// @vitest-environment jsdom
//
// WO-035 (UI-107 slice 2): Extrude create/edit on the shared
// FeaturePreviewSession contract -- a real-kernel ghost of the extruded
// result previews while the dialog is open WITHOUT appending history; Apply
// commits ONCE with one undo step behind the commit-time guard (accepted
// intent + authored-state fingerprint); Cancel and the terminal error path
// restore the original presentation unchanged; edit restores and visibly
// highlights the saved profile. This is the PROFILE-CONSUMING adapter
// template (sketch profile + newBody/add/cut target) revolve/sweep/loft
// will reuse.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient, type FakeGeomClient } from './fakeGeomClient'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { ExtrudeRequest } from '../../geom/geom-service'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'

const GHOST_ID = '__extrude-preview__'

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
  return screen.queryByTestId('extrude-preview-status')?.getAttribute('data-status') ?? null
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

function fakeClientCapturing(reqs: ExtrudeRequest[]): FakeGeomClient {
  return createFakeGeomClient({
    makeExtrudeImpl: (req, mintHandle) => {
      reqs.push(req)
      return { ok: true, body: mintHandle(), diagnostics: [] }
    },
  })
}

async function buildFirstExtrude(distance = '10'): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', distance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

describe('Extrude shared preview session (WO-035)', () => {
  it('create newBody: the ghost previews without authoring, the bounded distance clamps at BOTH sides, and Apply commits exactly once with one undo', async () => {
    const reqs: ExtrudeRequest[] = []
    const client = fakeClientCapturing(reqs)
    await boot(() => client)
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    // BELOW the field's min (0.1): the commit clamps to EXACTLY the bound and
    // that exact magnitude -- never the sub-min raw value -- reaches the
    // kernel evaluation.
    commitField('extrude-distance', '0.05')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.end).toEqual({ kind: 'blind', distance: 0.1 })
    })
    expect(reqs.at(-1)?.op).toBe('newBody')
    // ABOVE the min: the exact typed magnitude reaches the kernel.
    commitField('extrude-distance', '25')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.end).toEqual({ kind: 'blind', distance: 25 })
    })

    // Ghost painted, NOTHING authored: no dag node, no history entry.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    // Exact committed content, not counts: the payload is byte-for-byte what
    // the dialog authored and consumes is exactly the sketch.
    expect(hooks().dag.getNode('F1')?.payload).toEqual({
      opType: 'extrude',
      sketchId: 'SK1',
      distance: 25,
      direction: 'up',
      endCondition: 'blind',
      boolMode: 'newBody',
      name: 'Extrude F1',
    })
    expect(hooks().dag.getNode('F1')?.consumes).toEqual(['SK1'])
    // Session closed with the dialog: the ghost presentation is fully gone.
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())

    // ONE undo step covers the whole Apply (feature + its auto-hidden sketch).
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    expect(hooks().dag.getNode('SK1')?.hidden).toBe(false)
  })

  it('create add/remove: the pre-feature state is the TARGET body -- the ghost supersedes it against a scratch-restored handle, Cancel restores it, Apply consumes it', async () => {
    const reqs: ExtrudeRequest[] = []
    const client = fakeClientCapturing(reqs)
    await boot(() => client)
    await buildFirstExtrude()
    const liveTargetHandle = hooks().getBodyHandle('F1')

    // Remove (kernel op 'cut'), Direction=Down: the preview evaluates the
    // REAL boolean result. Its request must target the session's scratch-
    // RESTORED copy of F1 -- never the live document handle.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-direction-select'), { target: { value: 'down' } })
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    commitField('extrude-distance', '8')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.op).toBe('cut')
    })
    expect(reqs.at(-1)?.end).toEqual({ kind: 'blind', distance: -8 })
    expect(reqs.at(-1)?.target).toBeDefined()
    expect(reqs.at(-1)?.target).not.toBe(liveTargetHandle)
    // The ghost supersedes the target: F1's presentation is DOWN while the
    // ghost previews the boolean result.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)
    expect(hooks().dag.has('F2')).toBe(false)

    // Cancel: original presentation restored unchanged, nothing authored.
    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
      expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
    })
    expect(hooks().dag.has('F2')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Add: Apply publishes the accepted intent once; the COMMITTED replay's
    // request runs against the live F1 handle and F2 consumes it.
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'add' } })
    commitField('extrude-distance', '6')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.op).toBe('add')
    })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    expect(hooks().dag.getNode('F2')?.consumes.slice().sort()).toEqual(['F1', 'SK1'])
    expect(hooks().dag.getNode('F2')?.payload.boolMode).toBe('add')
    expect(hooks().dag.getNode('F2')?.payload.targetFeatureId).toBe('F1')
    const committed = [...reqs].reverse().find((request) => request.featureId === 'F2')
    expect(committed?.target).toBe(liveTargetHandle)

    // ONE undo removes the add-extrude entirely.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))
  })

  it('edit: restores and visibly highlights the saved profile, hides the current result behind the ghost, Cancel restores unchanged, Apply is one undo step', async () => {
    const reqs: ExtrudeRequest[] = []
    const client = fakeClientCapturing(reqs)
    const runtime = await boot(() => client)
    await buildFirstExtrude('10')

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 must route to its Extrude edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    await waitForReady()

    // The SAVED profile is restored and visibly highlighted -- the exact
    // whole-sketch key for SK1, even though the consumed sketch is hidden.
    await waitFor(() => expect(liveProfileOutlineKeys(runtime)).toContain('SK1:whole-sketch'))
    // The feature's committed result hides behind the live ghost.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    expect(hooks().getBodyPresentationVisible('F1')).toBe(false)

    // A changed distance re-evaluates the ghost ONLY -- the committed payload
    // is untouched while previewing.
    commitField('extrude-distance', '4')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(reqs.at(-1)?.end).toEqual({ kind: 'blind', distance: 4 })
    })
    expect(hooks().dag.getNode('F1')?.payload.distance).toBe(10)

    // Cancel: presentation and document restored unchanged.
    const historySizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => {
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
      expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
    })
    expect(liveProfileOutlineKeys(runtime)).toHaveLength(0)
    expect(hooks().dag.getNode('F1')?.payload.distance).toBe(10)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // Apply an edit and undo it in ONE step.
    const secondEdit = hooks().editEntryFor('F1')
    if (secondEdit === undefined || !('onEdit' in secondEdit)) throw new Error('F1 must route to its Extrude edit dialog')
    secondEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    commitField('extrude-distance', '4')
    await waitForReady()
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.distance).toBe(4))
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F1')?.payload.distance).toBe(10))
  })

  // WO-030's audit lesson, REQUIRED here from day one: the model mutates
  // AFTER the ready preview and Apply fires with UNCHANGED dialog values, so
  // no re-evaluation intervenes -- the commit itself must refuse against the
  // stale session baseline.
  it('apply guard: a model change after a ready preview refuses an immediate Apply with unchanged values', async () => {
    const reqs: ExtrudeRequest[] = []
    const client = fakeClientCapturing(reqs)
    await boot(() => client)
    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '25')
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
    await waitFor(() => expect(screen.getByTestId('extrude-apply-error').textContent).toMatch(/model changed/i))
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
    const reqs: ExtrudeRequest[] = []
    const client = fakeClientCapturing(reqs)
    await boot(() => client)
    await buildFirstExtrude('10')

    const edit = hooks().editEntryFor('F1')
    if (edit === undefined || !('onEdit' in edit)) throw new Error('F1 must route to its Extrude edit dialog')
    edit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
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

    commitField('extrude-distance', '7')
    await waitFor(() => {
      expect(previewStatus()).toBe('refused')
      expect(screen.getByTestId('extrude-preview-status').textContent).toMatch(/ghost paint exploded/i)
    })
    expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(true)
    // Honest teardown: ghost gone, the committed F1 presentation restored,
    // document and history untouched.
    expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined()
    expect(hooks().getBodyPresentationVisible('F1')).toBe(true)
    expect(hooks().dag.getNode('F1')?.payload.distance).toBe(10)
    expect(hooks().history.size()).toBe(historySizeBefore)
  })

  it('real kernel: the ghost is REAL extrude geometry tracking the typed distance without authoring, and Apply commits the same geometry once', async () => {
    await boot(createLocalGeomService)
    await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    const historySizeBefore = hooks().history.size()

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBe(true)
    }, { timeout: 20_000 })
    // EXACT geometry, not counts: the ghost's real tessellated top face sits
    // at the typed distance.
    expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(12, 6)
    expect(hooks().dag.has('F1')).toBe(false)
    expect(hooks().history.size()).toBe(historySizeBefore)

    // The ghost TRACKS the typed value with real kernel geometry.
    commitField('extrude-distance', '30')
    await waitFor(() => {
      expect(previewStatus()).toBe('ready')
      expect(hooks().getBodyTopPoint(GHOST_ID)?.z).toBeCloseTo(30, 6)
    }, { timeout: 20_000 })
    expect(hooks().dag.has('F1')).toBe(false)

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(30, 6)
    await waitFor(() => expect(hooks().getBodyPresentationVisible(GHOST_ID)).toBeUndefined())

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
  }, 60_000)
})
