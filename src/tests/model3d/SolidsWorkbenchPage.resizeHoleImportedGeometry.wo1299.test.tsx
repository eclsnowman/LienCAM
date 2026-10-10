// @vitest-environment jsdom
//
// WO-1299: WO-1292's nine-operation imported-body sweep answered eight
// operations and one excuse -- Resize Hole's line read "cannot enter preview
// on this fixture because the imported body has no recognized through,
// blind, or counterbore holes", because the sweep's fixture
// (fix_freeform.step) has no holes to recognize. That is the sweep saying it
// never ran the case, not a pass.
//
// This gives Resize Hole a body that HAS holes
// (test_fixtures/brep/fix_single_hole_block.step, one blind hole d=6 depth
// 8), brought in through the application's own import path, and drives it to
// its own independent preview+apply verdict TWICE: once on the fresh-import
// body (before it is ever saved), and again on that body after the project
// is saved and reopened -- the exact distinction WO-1292's fix depended on
// for the other eight operations. One answer for both paths is exactly the
// gap this WO exists to close.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService } from '../../geom'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { stubCanvas2d } from './stubCanvas2d'

const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_single_hole_block.step')
const HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack']

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

/** Pre-arms projectToCanvasResult -- the anchored value entry renders
 *  nothing while its anchor is off-screen/behind-camera in this jsdom
 *  harness (SolidsWorkbenchPage.resizeHole.test.tsx's own idiom). */
function harness(): { createSceneRuntime: () => FakeSceneRuntime } {
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    return rt
  }
  return { createSceneRuntime }
}

let restoreCanvas2d: (() => void) | null = null
let savedBlobs: Blob[] = []
let alertSpy: ReturnType<typeof vi.fn>
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

beforeEach(() => {
  stepBytes.clear()
  resetDocumentHolder()
  restoreCanvas2d = stubCanvas2d()
  savedBlobs = []
  alertSpy = vi.fn()
  vi.stubGlobal('alert', alertSpy)
  // saveProjectToFile hands its Blob to URL.createObjectURL -- capturing
  // there is how this test reads the exact bytes a reopen would load.
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1299' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

async function importFixture(h: ReturnType<typeof harness>): Promise<void> {
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const source = readFileSync(STEP_FIXTURE)
  const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([sourceBytes], 'fix_single_hole_block.step')] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })
}

/** The one predicate that stops this test from ever going green on a fixture
 *  the recognizer silently found nothing on -- exactly the failure mode that
 *  produced the original gap. */
async function recognizedHoleCount(featureId: string): Promise<number> {
  const handle = hooks().getBodyHandle(featureId)
  if (handle === undefined) throw new Error(`${featureId} has no live body`)
  const verdicts = await hooks().client.recognizeFeatures(handle)
  return verdicts.filter((v) => HOLE_CLASSES.includes(v.featureClass)).length
}

async function openList(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-resizehole-list'))
  await waitFor(() => expect(screen.getByTestId('resize-hole-picker')).toBeTruthy(), { timeout: 20_000 })
}

async function armResizeHole(): Promise<void> {
  await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false), { timeout: 20_000 })
  fireEvent.click(screen.getByTestId('workbench-resize-hole'))
  await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
    { timeout: 20_000 },
  )
}

/** Arms Resize Hole, opens the supplement list, picks the one recognized
 *  hole, and applies `deltaMm` through the real anchored-value-entry apply
 *  path -- then confirms the resize actually committed (a live DAG node,
 *  scheduler status 'ok', `recognizeFeatures` reporting the new diameter).
 *  This is the FULL preview+apply verdict, not just recognition -- called
 *  once against the fresh-import body and once against the reopened one,
 *  so each path gets proof of its own rather than one being inferred from
 *  the other. Diffs against the resizeHole node set already present so it
 *  identifies the NEW node even when called a second time on a body that
 *  already carries a prior resize. */
async function driveResizeHoleToVerdict(deltaMm: number): Promise<string> {
  const priorResizeIds = new Set(
    hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole'),
  )
  await armResizeHole()
  await openList()
  const option = screen.getByTestId('resize-hole-option-0') as HTMLButtonElement
  const currentDiameter = Number(option.getAttribute('data-current-diameter'))
  expect(Number.isFinite(currentDiameter)).toBe(true)
  fireEvent.click(option)
  await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

  const newDiameter = currentDiameter + deltaMm
  fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: String(newDiameter) } })
  fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
  await waitFor(() => {
    const closed = screen.queryByTestId('resize-hole-anchor-entry') === null
    const errored = screen.queryByTestId('resize-hole-anchor-entry-apply-error')
    if (!closed) throw new Error(errored?.textContent ?? 'resize-hole apply still pending')
  }, { timeout: 20_000 })

  const resizeId = hooks().dag.featureOrder().find(
    (id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole' && !priorResizeIds.has(id),
  )
  expect(resizeId).toBeDefined()
  await waitFor(() => expect(hooks().getBodyHandle(resizeId!)).not.toBeUndefined(), { timeout: 30_000 })
  expect(hooks().scheduler.statusOf(resizeId!)).toBe('ok')

  const verdictsAfterApply = await hooks().client.recognizeFeatures(hooks().getBodyHandle(resizeId!)!)
  const diametersAfterApply = verdictsAfterApply
    .filter((v) => HOLE_CLASSES.includes(v.featureClass))
    .map((v) => v.params.diameter as number)
  expect(diametersAfterApply.some((d) => Math.abs(d - newDiameter) <= 1e-4)).toBe(true)

  return resizeId!
}

describe('WO-1299: Resize Hole on imported geometry -- fresh import and after save+reopen', () => {
  it('drives Resize Hole to its own verdict on the fresh import AND again on the reopened project, and the second resize persists through another save+reopen', async () => {
    useCamStore.getState().newProject()
    await importFixture(harness())

    // FRESH IMPORT: recognition must actually find the hole this fixture
    // carries. Asserting >0 here is what stops "no holes recognized" from
    // being read as a pass, the way it silently was for the freeform fixture.
    expect(await recognizedHoleCount('IMP1')).toBeGreaterThan(0)

    // FRESH-IMPORT VERDICT. Resize Hole must be armed, previewed, and
    // applied against the body while it is still live from the import --
    // never saved yet -- so this is its own answer, not one inferred from
    // the reopened-project drive below.
    const resizeIdFresh = await driveResizeHoleToVerdict(-1)

    const fileTextV1 = await saveAndCaptureFile()
    cleanup()
    resetDocumentHolder()

    // REOPEN. Same body id, loaded fresh from the saved file rather than
    // still live from the authoring session -- the exact distinction
    // WO-1292's fix depended on for fillet/chamfer/draft/hole/etc.
    useCamStore.getState().loadProjectFromFile(fileTextV1)
    expect(alertSpy).not.toHaveBeenCalled()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={harness().createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle(resizeIdFresh)).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf(resizeIdFresh)).toBe('ok'), { timeout: 20_000 })

    // Recognition on the reopened body finds the (already-resized) hole
    // again -- confirms the fresh-import verdict's result actually persisted
    // before the reopened-project drive adds its own independent resize.
    expect(await recognizedHoleCount(resizeIdFresh)).toBeGreaterThan(0)

    // REOPENED-PROJECT VERDICT: an independent second drive to a verdict on
    // the REOPENED imported body through the supplement list -- no
    // hard-coded viewport ray for a hole position this test never places.
    // This is the WO-1292 distinction: fresh-import and reopened-project are
    // two separate answers, not one answer read twice.
    const resizeIdReopened = await driveResizeHoleToVerdict(-1)

    // The reopened-project resize survives ANOTHER save + reopen.
    const fileTextV2 = await saveAndCaptureFile()
    cleanup()
    resetDocumentHolder()
    useCamStore.getState().loadProjectFromFile(fileTextV2)
    expect(alertSpy).not.toHaveBeenCalled()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={harness().createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle(resizeIdReopened)).not.toBeUndefined(), { timeout: 30_000 })

    const verdictsFinal = await hooks().client.recognizeFeatures(hooks().getBodyHandle(resizeIdReopened)!)
    const diametersFinal = verdictsFinal
      .filter((v) => HOLE_CLASSES.includes(v.featureClass))
      .map((v) => v.params.diameter as number)
    // Two independent -1mm applies against the fixture's d=6 hole land at 4mm.
    expect(diametersFinal.some((d) => Math.abs(d - 4) <= 1e-4)).toBe(true)
  }, 180_000)
})
