// @vitest-environment jsdom
//
// WO-1324: Operator's note -- "Model workspace fails to apply fillet to imported
// geometry in a project ... look for similar issues on direct editing of
// imported models or created models" -- with FailtoFillet.camproject.
//
// The APPLY half of that note is already covered: WO-1292 opens the very same
// project file, picks two edges on the reopened imported body and applies a
// r=10 fillet (SolidsWorkbenchPage.importedBodyOps.wo1292.test.tsx). What that
// sweep never asked is whether the applied fillet SURVIVES: every one of its
// nine operations ends the moment the new leaf gets a body handle, inside the
// same authoring session that made it. That is the same fresh-import vs
// reopened-project distinction WO-1299 had to close for Resize Hole, one step
// further downstream -- an imported body is replayed from its STEP source on
// every open, so a `feature`-role node hanging off it (fillet, and its
// edge ids) is only proven once it has been through a real save and reopen.
//
// This file drives that round trip on Operator's own project, and gives the two
// creator-role ops that can still CONSUME an imported body -- extrude with a
// boolean target -- their own answer, which WO-1292's classification table
// exempted from its census on the grounds that they create their own body.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService } from '../../geom'
import { cacheStep } from '../../lib/stepCache'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { mintRectangleSketch } from './mintRectangleSketch'

// Operator's project, byte-identical in content to the copy WO-1292 already
// carries (same id/updatedAt/DAG); the lane compared them rather than
// committing a second 535 KB copy of the same file.
const FIXTURE = resolve(process.cwd(), 'src/tests/evidence/WO-1292/FailtoFillet.camproject')
const MODEL_ITEM_ID = 'bbc394b0-772d-4211-a705-69fd44a02abc'
const STEP_CACHE_KEY = '471ed7f8-9b1c-4e9b-8d02-df2d25bef110'
const STEP_FIXTURE = resolve(process.cwd(), 'test_fixtures/brep/fix_freeform.step')

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function clickWorld(runtime: FakeSceneRuntime, origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): void {
  runtime.rayOverride = { origin, direction }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

let savedBlobs: Blob[] = []
let alertSpy: ReturnType<typeof vi.fn>
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

/** saveProjectToFile hands its Blob to URL.createObjectURL; capturing there is
 *  how this test reads the exact bytes a reopen would load (WO-1299's idiom). */
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

/** Open a project text through the store and mount the Model workspace on
 *  Operator's imported model item, waiting until the imported body is really live. */
async function openProject(text: string): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  await useCamStore.getState().loadProjectFromFile(text)
  render(
    <SolidsWorkbenchPage
      modelItemId={MODEL_ITEM_ID}
      createClient={createLocalGeomService}
      createSceneRuntime={() => runtime}
    />,
  )
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  return runtime
}

async function primeStepCache(): Promise<void> {
  const source = readFileSync(STEP_FIXTURE)
  const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
  await cacheStep(STEP_CACHE_KEY, sourceBytes)
}

/** Bring a STEP file in through the workbench's own import input, into a new
 *  project, and wait until its body is really live. */
async function importFreshStep(file: string, name: string): Promise<FakeSceneRuntime> {
  const runtime = createFakeSceneRuntime()
  useCamStore.getState().newProject()
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const source = readFileSync(file)
  const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
  const input = screen.getByTestId('workbench-import-step-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([sourceBytes], name)] } })
  await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 30_000 })
  await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })
  return runtime
}

/** Operator's own fillet: the two edges WO-1292's capture picked, r=10, applied
 *  through the dialog's real preview -> Apply path. Returns the new leaf id. */
async function applySampleMachineFillet(runtime: FakeSceneRuntime): Promise<string> {
  const priorFillets = new Set(
    hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'fillet'),
  )
  fireEvent.click(screen.getByTestId('workbench-fillet'))
  clickWorld(runtime, { x: 0, y: -100, z: 5 }, { x: 0, y: 1, z: 0 })
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge/))
  clickWorld(runtime, { x: 40, y: -100, z: 5 }, { x: 0, y: 1, z: 0 })
  await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/2 edges/))
  commitField('fillet-radius', '10')
  await waitFor(
    () => expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).not.toBe('pending'),
    { timeout: 30_000 },
  )
  expect(screen.getByTestId('fillet-preview-status').getAttribute('data-status')).toBe('ready')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const filletId = await waitFor(() => {
    const id = hooks().dag.featureOrder().find(
      (candidate) => hooks().dag.getNode(candidate)?.payload.opType === 'fillet' && !priorFillets.has(candidate),
    )
    if (id === undefined) throw new Error('no new fillet node')
    return id
  }, { timeout: 30_000 })
  await waitFor(() => expect(hooks().getBodyHandle(filletId)).not.toBeUndefined(), { timeout: 30_000 })
  expect(hooks().scheduler.statusOf(filletId)).toBe('ok')
  return filletId
}

beforeEach(async () => {
  stepBytes.clear()
  resetDocumentHolder()
  savedBlobs = []
  alertSpy = vi.fn()
  vi.stubGlobal('alert', alertSpy)
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1324' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  await primeStepCache()
})

afterEach(() => {
  cleanup()
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

describe('WO-1324: a fillet on imported geometry survives the save it was made for', () => {
  it("applies Operator's fillet to his imported body and replays it after the project is saved and reopened", async () => {
    const runtime = await openProject(readFileSync(FIXTURE, 'utf8'))
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })

    const filletId = await applySampleMachineFillet(runtime)
    const edges = hooks().dag.getNode(filletId)?.payload.edges as string[]
    expect(Array.isArray(edges) && edges.length === 2).toBe(true)
    const hashBeforeSave = hooks().getBodyGeometryHash(filletId)
    expect(hashBeforeSave).toBeDefined()
    console.log('WO-1324 authored fillet:', JSON.stringify({ filletId, edges, radius: hooks().dag.getNode(filletId)?.payload.radius }))

    const saved = await saveAndCaptureFile()
    cleanup()
    resetDocumentHolder()

    // THE ROUND TRIP. The imported body is rebuilt from its STEP source on
    // this open; the fillet is replayed on top of it from persisted edge ids.
    await openProject(saved)
    expect(alertSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(hooks().dag.getNode(filletId)).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(
      () => expect(hooks().scheduler.statusOf(filletId)).not.toBe('pending'),
      { timeout: 30_000 },
    )
    console.log('WO-1324 reopened fillet:', JSON.stringify({
      status: hooks().scheduler.statusOf(filletId),
      diagnostics: hooks().scheduler.diagnosticsOf(filletId),
      hasHandle: hooks().getBodyHandle(filletId) !== undefined,
    }))
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf(filletId))).not.toMatch(/no live body|stale|not found/i)
    expect(hooks().scheduler.statusOf(filletId)).toBe('ok')
    expect(hooks().getBodyHandle(filletId)).not.toBeUndefined()

    // The replayed body is the filleted one, not the bare import: the leaf's
    // geometry must match what the authoring session produced.
    await waitFor(() => expect(hooks().getBodyGeometryHash(filletId)).toBe(hashBeforeSave), { timeout: 30_000 })
  }, 180_000)
})

describe('WO-1324: a creator-role op that consumes the imported body', () => {
  // WO-1292's census classified extrude/revolve/sweep/loft as 'creator' ops
  // and exercised only the nine that take an existing body as their subject.
  // Extrude is the one creator op that ALSO consumes one -- Add/Remove/
  // Intersect name a boolean target -- and cutting a pocket into imported
  // geometry is exactly the "direct editing of imported models" Operator asked
  // about. It gets its own answer here rather than inheriting fillet's.
  it('cuts a pocket into the reopened imported body and folds it into the result', async () => {
    await openProject(readFileSync(FIXTURE, 'utf8'))
    await waitFor(() => expect(hooks().getBodyHandle('IMP1')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 20_000 })

    // A 10x10 rectangle on XY sitting over the imported body's footprint,
    // extruded up through it.
    const sketchId = await mintRectangleSketch({ width: 10, height: 10, offset: 10, plane: 'xy' })
    await waitFor(() => expect(screen.getByTestId(`feature-row-${sketchId}`)).toBeTruthy(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-boolmode-select'), { target: { value: 'remove' } })
    expect((screen.getByTestId('extrude-target-select') as HTMLSelectElement).value).toBe('IMP1')
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const cutId = await waitFor(() => {
      const id = hooks().dag.featureOrder().find((candidate) => hooks().dag.getNode(candidate)?.payload.opType === 'extrude')
      if (id === undefined) throw new Error('no extrude node')
      return id
    }, { timeout: 30_000 })
    await waitFor(() => expect(hooks().getBodyHandle(cutId)).not.toBeUndefined(), { timeout: 30_000 })
    console.log('WO-1324 extrude-remove on imported body:', JSON.stringify({
      cutId,
      status: hooks().scheduler.statusOf(cutId),
      diagnostics: hooks().scheduler.diagnosticsOf(cutId),
      consumes: hooks().dag.getNode(cutId)?.consumes.slice().sort(),
    }))
    expect(JSON.stringify(hooks().scheduler.diagnosticsOf(cutId))).not.toMatch(/no live body/i)
    expect(hooks().scheduler.statusOf(cutId)).toBe('ok')
    // The imported body is the consumed target, folded into the cut result --
    // the same consumed-body lineage a modelled target gets.
    expect(hooks().dag.getNode(cutId)?.consumes.slice().sort()).toEqual(['IMP1', sketchId].sort())
  }, 180_000)
})

/** Arm Shell on the body already on screen, pick one face by ray, ask for a
 *  2 mm wall and return the settled preview status + text. */
async function shellPreviewHere(
  runtime: FakeSceneRuntime,
  ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } },
): Promise<{ status: string | null; text: string }> {
  fireEvent.click(screen.getByTestId('workbench-shell'))
  clickWorld(runtime, ray.origin, ray.direction)
  await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/), { timeout: 20_000 })
  commitField('shell-thickness', '2')
  const status = screen.getByTestId('shell-preview-status')
  await waitFor(() => expect(status.getAttribute('data-status')).not.toBe('pending'), { timeout: 30_000 })
  return { status: status.getAttribute('data-status'), text: status.textContent ?? '' }
}

/** WO-2107 + 9b258d2cea name shell blends and construct blind-hole walls.
 * A green preview is insufficient: apply, measure material removal, save and
 * reopen through the workbench, then measure/hash the replayed hollow. */
async function verifyShellHollowAndReopen(
  runtime: FakeSceneRuntime,
  ray: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } },
  ownerId: string,
  facePattern: RegExp,
): Promise<void> {
  const before = (await hooks().client.measure(hooks().getBodyHandle(ownerId)!, 'volume')).value
  const { status, text } = await shellPreviewHere(runtime, ray)
  expect(status, text).toBe('ready')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  const shellId = await waitFor(() => {
    const id = hooks().dag.featureOrder().find(candidate => hooks().dag.getNode(candidate)?.payload.opType === 'shell')
    if (!id) throw new Error('no applied shell')
    expect(hooks().getBodyHandle(id)).toBeDefined()
    expect(hooks().scheduler.statusOf(id)).toBe('ok')
    return id
  }, { timeout: 30_000 })
  const payload = hooks().dag.getNode(shellId)!.payload
  expect(payload.ownerId).toBe(ownerId)
  expect(payload.thickness).toBe(2)
  expect(payload.removeFaces).toHaveLength(1)
  expect((payload.removeFaces as string[])[0]).toMatch(facePattern)
  const after = (await hooks().client.measure(hooks().getBodyHandle(shellId)!, 'volume')).value
  expect(after).toBeGreaterThan(0)
  expect(after).toBeLessThan(before - 1)
  const area = (await hooks().client.measure(hooks().getBodyHandle(shellId)!, 'area')).value
  const hash = hooks().getBodyGeometryHash(shellId)
  expect(hash).toBeDefined()
  const saved = await saveAndCaptureFile()
  cleanup()
  resetDocumentHolder()
  await useCamStore.getState().loadProjectFromFile(saved)
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => createFakeSceneRuntime()} />)
  await waitFor(() => expect(hooks().getBodyHandle(shellId)).toBeDefined(), { timeout: 30_000 })
  expect(hooks().scheduler.statusOf(shellId)).toBe('ok')
  // Kernel tessellation ordering may change on replay; compare exact solid
  // measures and persisted face/thickness intent rather than vertex-order hashes.
  expect(hooks().dag.getNode(shellId)!.payload).toEqual(payload)
  const reopenedArea = (await hooks().client.measure(hooks().getBodyHandle(shellId)!, 'area')).value
  expect(reopenedArea).toBeCloseTo(area, 5)
  const reopened = (await hooks().client.measure(hooks().getBodyHandle(shellId)!, 'volume')).value
  expect(reopened).toBeCloseTo(after, 5)
  expect(alertSpy).not.toHaveBeenCalled()
  console.log('WO-2621 applied/reopened shell', { ownerId, shellId, before, after, reopened, area, reopenedArea, hash, reopenedHash: hooks().getBodyGeometryHash(shellId) })
}

describe("WO-1324: the one census entry Operator's fixture could not answer", () => {
  // WO-2107 resolved the historical Shell refusal. Both imported fixtures and
  // the modelled blind-hole body must now produce a hollow that survives a
  // production save/reopen, preserving the exact shell payload and measures.
  const IMPORTED_FIXTURES = [
    { file: 'fix_single_hole_block.step', ray: { origin: { x: -100, y: 5, z: 5 }, direction: { x: 1, y: 0, z: 0 } } },
    { file: 'fix_prismatic_boss.step', ray: { origin: { x: 30, y: 30, z: -100 }, direction: { x: 0, y: 0, z: 1 } } },
  ] as const

  it('shells imported AND modelled blind-hole bodies and preserves the hollow after reopen', async () => {
    for (const { file, ray } of IMPORTED_FIXTURES) {
      const runtime = await importFreshStep(resolve(process.cwd(), `test_fixtures/brep/${file}`), file)
      await verifyShellHollowAndReopen(runtime, ray, 'IMP1', /^IMP1:step:face#\d+$/)
      cleanup()
      resetDocumentHolder()
    }

    // A modelled block with a blind hole -- fix_single_hole_block's geometry,
    // built from scratch. The circular concave edge at the hole floor is the
    // feature the shell construction now handles; the imported fixtures above
    // carry the same concave edge.
    const runtime = createFakeSceneRuntime()
    useCamStore.getState().newProject()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    const baseSketch = await mintRectangleSketch({ width: 40, height: 20, offset: 10, plane: 'xy' })
    await waitFor(() => expect(screen.getByTestId(`feature-row-${baseSketch}`)).toBeTruthy(), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 30_000 })

    fireEvent.click(screen.getByTestId('workbench-hole'))
    clickWorld(runtime, { x: 30, y: 10, z: 100 }, { x: 0, y: 0, z: -1 })
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy(), { timeout: 20_000 })
    commitField('hole-diameter', '6')
    commitField('hole-blind-distance', '8')
    await waitFor(
      () => expect(screen.getByTestId('hole-preview-status').getAttribute('data-status')).not.toBe('pending'),
      { timeout: 30_000 },
    )
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 30_000 })
    expect(hooks().scheduler.statusOf('F2')).toBe('ok')

    await verifyShellHollowAndReopen(runtime,
      { origin: { x: -100, y: 10, z: 10 }, direction: { x: 1, y: 0, z: 0 } }, 'F2', /^F\d+:/)
  }, 300_000)
})
