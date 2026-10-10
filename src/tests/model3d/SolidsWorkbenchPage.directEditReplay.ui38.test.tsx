// @vitest-environment jsdom
//
// UI-38: integrated edit-replay acceptance evidence for the defeature and
// resizeHole direct-edit body operations. Each block drives the real
// SolidsWorkbenchPage through the visible FeatureTree Edit affordance and
// proves the full contract the product audit said was missing integrated proof
// for: edit-after-creation replays the REAL operation payload (not merely
// changed dialog state), rewrites the SAME feature id at the SAME history
// position (no second node appended), produces a fresh real kernel
// result/handle or canonical geometric signal, and one undo + one redo
// restore the exact before/after payload AND replay geometry. A
// missing/invalid upstream refusal is proved for each op: the shared
// editEntryFor resolver refuses BY NAME without corrupting or appending
// history.
//
// The defeature block exercises the defeatureBatch kernel seam through the
// same createFakeGeomClient spy booleanHoleEdit.ui38 already accepts as UI-38
// evidence (request payload + fresh minted handle = the canonical replay
// signal for a fake-kernel op), and adds the undo/redo + missing-owner refusal
// the existing defeature.test.tsx BK-174 case does not cover. The resize-hole
// block drives the REAL in-process OCCT kernel and the same armed in-viewport
// pick surface resizeHole.test.tsx BK-174 already proves, and adds the redo +
// invalid-target refusal that case does not cover.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { createLocalGeomService } from '../../geom'
import type { BodyHandle, DefeatureRequest, FeatureVerdict } from '../../geom/geom-service'
import { createFakeGeomClient, type FakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import type { SolidsWorkbenchHooks } from '../../components/model3d'

// jsdom's localStorage is broken under Vitest's node launch flags: the store
// captures it during module evaluation, so install the repository-standard
// in-memory Storage shim BEFORE importing the workbench (same contract
// resizeHole.test.tsx uses for its real-kernel pick-surface tests).
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
const { useCamStore } = await import('../../store')

beforeEach(() => { memory.clear() })

// SolidsWorkbenchPage reads addConsoleEvent through a useCamStore selector at
// mount and threads it through addConsoleEventRef, so a refusal-capture
// override must be installed BEFORE render and restored AFTER the test. A
// refusal section installs the capture and assigns `restore` here; afterEach
// drains any pending install so an assertion failure mid-test can never leak a
// stubbed action into the next test.
let pendingCaptureRestore: (() => void) | null = null
afterEach(() => {
  pendingCaptureRestore?.()
  pendingCaptureRestore = null
})
afterEach(cleanup)

// ---------------- shared helpers ----------------

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

/** Captures workbench console events so a refusal section can assert the edit
 *  resolver named the refused node BY NAME. Restores the real action in
 *  `restore` so later sections/other blocks see production routing. */
function captureWorkbenchMessages(): { messages: string[]; restore: () => void } {
  const real = useCamStore.getState().addConsoleEvent
  const messages: string[] = []
  useCamStore.getState().addConsoleEvent = (event) => { messages.push(event.message) }
  return {
    messages,
    restore: () => { useCamStore.getState().addConsoleEvent = real },
  }
}

/** Inserts a feature node directly through the command layer WITHOUT a regen,
 *  so a broken/missing-upstream node exists in the DAG for editEntryFor to
 *  route to -- the same shape booleanHoleEdit.ui38's BAD-BOOLEAN/BAD-HOLE and
 *  revolveEdit.ui38's BAD-REVOLVE use to prove a refused edit does not append
 *  or corrupt history. */
function forceInsertNode(id: string, consumes: string[], payload: Record<string, unknown>): void {
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id,
    kind: 'feature',
    consumes,
    payload,
  }))
}

// ================= Defeature =================

const FILLET: FeatureVerdict = {
  featureKey: 'blend-radius-2',
  featureClass: 'filletPlanar',
  removable: true,
  effect: 'add',
  faceIds: ['F1:FACE:blend'],
  neighbourIds: ['F1:FACE:top', 'F1:FACE:side'],
  params: { radius: 2 },
}

const CHAMFER: FeatureVerdict = {
  featureKey: 'chamfer-distance-1',
  featureClass: 'chamferPlanar',
  removable: true,
  effect: 'add',
  faceIds: ['F1:FACE:chamfer'],
  neighbourIds: ['F1:FACE:top', 'F1:FACE:end'],
  params: { distance: 1 },
}

async function buildDefeatureBody(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  expect(screen.getByTestId('extrude-profile-select')).toBeTruthy()
  commitField('extrude-distance', '10')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
}

/** The committed defeatureBatch replays for F2 only (preview calls carry
 *  featureId '__defeature-preview__' and are excluded). Each entry's
 *  featureKeys is the REAL operation payload the kernel seam replayed. */
function f2DefeatureCalls(client: FakeGeomClient): DefeatureRequest[] {
  return client.defeatureBatchCalls.filter((c) => c.featureId === 'F2')
}

/** Proves a FRESH kernel replay happened (the F2 call count grew) AND that the
 *  replayed payload matches the expected accept mask -- not merely a payload
 *  restore, but the real defeatureBatch seam running again with the correct
 *  featureKeys for the current history state. */
async function waitForDefeatureReplay(client: FakeGeomClient, expectedKeys: string[], priorCount: number): Promise<void> {
  await waitFor(() => {
    const calls = f2DefeatureCalls(client)
    expect(calls.length).toBeGreaterThan(priorCount)
    expect(calls.at(-1)?.featureKeys).toEqual(expectedKeys)
  }, { timeout: 20_000 })
}

/** Waits for a fresh, distinct body handle -- the regen replayed the feature
 *  and stored a new kernel result, not merely rewrote the payload. */
async function waitForFreshHandle(featureId: string, prior: BodyHandle): Promise<BodyHandle> {
  let current: BodyHandle | undefined
  await waitFor(() => {
    current = hooks().getBodyHandle(featureId)
    expect(current).not.toBeUndefined()
    expect(current).not.toBe(prior)
  }, { timeout: 20_000 })
  return current as BodyHandle
}

describe('UI-38 Defeature edit reliability (real workbench + defeature kernel seam)', () => {
  it('edits the same node, replays the accept mask through undo/redo, and refuses a missing owner by name', async () => {
    // Install the capture BEFORE render (see pendingCaptureRestore's own
    // comment): the workbench reads addConsoleEvent at mount, so the override
    // must be in place when SolidsWorkbenchPage first runs its selector.
    const { messages, restore } = captureWorkbenchMessages()
    pendingCaptureRestore = restore
    const client = createFakeGeomClient({
      recognizeFeaturesResult: [FILLET, CHAMFER],
      defeatureBatchImpl: (req, mintHandle) => ({
        ok: true,
        body: mintHandle(),
        diagnostics: [],
        report: {
          requested: req.featureKeys?.length ?? 0,
          healed: req.featureKeys?.length ?? 0,
          failed: 0,
          refused: 0,
          totalVolumeDelta: 100,
          items: (req.featureKeys ?? []).map((featureKey) => ({
            featureKey,
            featureClass: featureKey === FILLET.featureKey ? 'filletPlanar' : 'chamferPlanar',
            healed: true,
            volumeDelta: 100,
            effect: 'add',
          })),
        },
      }),
    })
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    await buildDefeatureBody()

    // --- create: accept FILLET only ---
    fireEvent.click(screen.getByTestId('workbench-defeature'))
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId(`defeature-check-${FILLET.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    const createHandle = await waitForFreshHandle('F2', 0 as unknown as BodyHandle)
    expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature', ownerId: 'F1', featureKeys: [FILLET.featureKey], name: 'Delete 1 fillet',
    })
    expect(hooks().dag.getNode('F2')?.consumes).toEqual(['F1'])
    // The create committed exactly one real F2 replay with [FILLET].
    expect(f2DefeatureCalls(client).at(-1)?.featureKeys).toEqual([FILLET.featureKey])
    const orderAfterCreate = hooks().dag.featureOrder()

    // --- edit: reopen with the STORED accept mask truthfully represented ---
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)
    await waitFor(() => expect(screen.getByTestId('defeature-picker')).toBeTruthy())
    // (1) stored accepted/removal selection represented truthfully: FILLET
    // preselected (it was accepted at create), CHAMFER not (it was not).
    expect((screen.getByTestId(`defeature-check-${FILLET.featureKey}`) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`) as HTMLInputElement).checked).toBe(false)

    // (2) apply a changed selection -- rewrites the SAME node, no second row.
    const countBeforeEdit = f2DefeatureCalls(client).length
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId(`defeature-check-${CHAMFER.featureKey}`))
    await waitFor(() => expect(screen.getByTestId('defeature-preview-status').getAttribute('data-state')).toBe('ready'))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature', ownerId: 'F1', featureKeys: [FILLET.featureKey, CHAMFER.featureKey],
    }))
    // (3) fresh real replay: a NEW defeatureBatch call for F2 with the edited
    // mask + a fresh, distinct kernel handle -- not merely changed dialog state.
    await waitForDefeatureReplay(client, [FILLET.featureKey, CHAMFER.featureKey], countBeforeEdit)
    const editHandle = await waitForFreshHandle('F2', createHandle)
    // (2) same feature id, same history position -- no appended defeature node.
    expect(hooks().dag.featureOrder()).toEqual(orderAfterCreate)
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'defeature')).toEqual(['F2'])

    // (4) one undo restores the ORIGINAL payload/result and replays geometry.
    const countBeforeUndo = f2DefeatureCalls(client).length
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature', ownerId: 'F1', featureKeys: [FILLET.featureKey],
    }))
    await waitForDefeatureReplay(client, [FILLET.featureKey], countBeforeUndo)
    const undoneHandle = await waitForFreshHandle('F2', editHandle)
    expect(hooks().dag.featureOrder()).toEqual(orderAfterCreate)
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'defeature')).toEqual(['F2'])

    // one redo restores the EDITED payload/result and replays geometry.
    const countBeforeRedo = f2DefeatureCalls(client).length
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload).toMatchObject({
      opType: 'defeature', ownerId: 'F1', featureKeys: [FILLET.featureKey, CHAMFER.featureKey],
    }))
    await waitForDefeatureReplay(client, [FILLET.featureKey, CHAMFER.featureKey], countBeforeRedo)
    await waitForFreshHandle('F2', undoneHandle)
    expect(hooks().dag.featureOrder()).toEqual(orderAfterCreate)
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'defeature')).toEqual(['F2'])

    // (5) a missing upstream/source condition refuses BY NAME and does not
    // corrupt or append history. A defeature feature with no stored owner body
    // is the canonical "missing upstream" state; handleEditDefeature refuses
    // before any recognition or DAG mutation.
    forceInsertNode('BAD-DEFEATURE', [], {
      opType: 'defeature',
      featureKeys: [],
      name: 'Broken defeature',
    })
    const brokenBefore = hooks().dag.getNode('BAD-DEFEATURE')
    const orderBeforeRefusal = hooks().dag.featureOrder()
    const historySizeBeforeRefusal = hooks().history.size()
    const historyBeforeRefusal = hooks().history.serialize()

    const invalidEntry = hooks().editEntryFor('BAD-DEFEATURE')
    if (invalidEntry === undefined || !('onEdit' in invalidEntry)) {
      throw new Error('BAD-DEFEATURE must route to its edit dialog')
    }
    invalidEntry.onEdit()
    await waitFor(() => {
      expect(
        messages.some((m) => /Defeature edit refused/i.test(m) && m.includes('BAD-DEFEATURE') && /no stored owner body/i.test(m)),
      ).toBe(true)
    })
    expect(hooks().dag.getNode('BAD-DEFEATURE')).toEqual(brokenBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeRefusal)
    expect(hooks().history.size()).toBe(historySizeBeforeRefusal)
    expect(hooks().history.serialize()).toEqual(historyBeforeRefusal)
  }, 60_000)
})

// ================= Resize hole =================

/** Captures the fake scene runtime AND pre-arms projectToCanvasResult (the
 *  fake's own default is null -- "nothing projects" -- so without this the
 *  anchored value entry, which renders nothing while its anchor is
 *  off-screen, would never mount in jsdom). Same harness resizeHole.test.tsx
 *  uses for its pick-surface tests. */
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
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

/** Blind hole at (x,y): the ray that CREATES the hole (aimed at the flat top
 *  face) is the exact same ray that later RESIZE-PICKS it. Same convention
 *  resizeHole.test.tsx uses. */
async function drillBlindHole(rt: () => FakeSceneRuntime, x: number, y: number, diameter: string, blindDistance: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-hole'))
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitField('hole-diameter', diameter)
  commitField('hole-blind-distance', blindDistance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
}

async function expectRecognizedDiameter(featureId: string, expected: number): Promise<void> {
  await waitFor(async () => {
    const handle = hooks().getBodyHandle(featureId)
    expect(handle).not.toBeUndefined()
    const verdicts = await hooks().client.recognizeFeatures(handle!)
    const diameters = verdicts
      .filter((v) => ['throughHole', 'blindHole', 'counterboreStack'].includes(v.featureClass))
      .map((v) => v.params.diameter)
      .filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
    expect(diameters.some((d) => Math.abs(d - expected) <= 1e-5)).toBe(true)
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

async function waitForResizeHolePreviewReady(): Promise<void> {
  await waitFor(() => {
    const status = screen.getByTestId('resize-hole-anchor-entry-status')
    if (status.getAttribute('data-status') === 'refused') {
      throw new Error(status.textContent ?? 'Resize hole preview refused')
    }
    expect(status.getAttribute('data-status')).toBe('ready')
  }, { timeout: 20_000 })
}

describe('UI-38 Resize hole edit reliability (real workbench + in-process OCCT kernel)', () => {
  // WO-270 removed the theme/glow settings, so there is no user-default
  // palette left to pin against. What remains is the canvas2d stub, so a
  // badge/hover path that needs a 2D context never throws in jsdom (same setup
  // resizeHole.test.tsx uses).
  let restoreCanvas2d: (() => void) | null = null
  beforeEach(() => {
    restoreCanvas2d = stubCanvas2d()
  })
  afterEach(() => {
    restoreCanvas2d?.()
    restoreCanvas2d = null
  })

  it('FeatureTree Edit reopens the same in-viewport surface, rewrites the same node, and undo/redo replay the diameter', async () => {
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '5')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await expectRecognizedDiameter('F2', 6)

    // First resize d=6 -> D=8 creates F3 (the resizeHole feature).
    await armResizeHole()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '8' } })
    await waitForResizeHolePreviewReady()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })

    const resizeId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeId).toBe('F3')
    expect(hooks().dag.getNode(resizeId!)?.payload).toMatchObject({
      opType: 'resizeHole', ownerId: 'F2', currentDiameter: 6, newDiameter: 8, delta: 2,
    })
    await expectRecognizedDiameter(resizeId!, 8)
    const orderAfterCreate = hooks().dag.featureOrder()

    // Disarm first -- proves Edit reopens the surface on its own, not riding
    // an already-armed session.
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())

    // (1) Edit reopens the SAME in-viewport surface, auto-selects the stored
    // hole, and represents the stored target/diameter truthfully: "Current"
    // reads the ORIGINAL base (6, the hole's diameter before any resize) and
    // the entry is prefilled with the STORED target (8) -- see
    // handleEditResizeHole's own doc comment for why the base, not the live
    // rendered diameter, is the delta reference.
    fireEvent.contextMenu(screen.getByTestId(`feature-row-${resizeId}`))
    const editItem = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(editItem.disabled).toBe(false)
    fireEvent.click(editItem)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    expect((screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement).value).toBe('8')

    // (2) Changing the diameter rewrites the SAME feature id and history
    // position -- no new resizeHole node. (3) The real result changes in a
    // geometrically meaningful way: a real recognizeFeatures readback reports
    // the new diameter on the live kernel body.
    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '9' } })
    await waitForResizeHolePreviewReady()
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toEqual([resizeId])
    expect(hooks().dag.getNode(resizeId!)?.payload).toMatchObject({
      opType: 'resizeHole', ownerId: 'F2', currentDiameter: 6, newDiameter: 9, delta: 3,
    })
    expect(hooks().dag.featureOrder()).toEqual(orderAfterCreate)
    await expectRecognizedDiameter(resizeId!, 9)

    // (4) One undo restores the ORIGINAL (8 mm) diameter/result on the SAME
    // node and replays geometry through the real kernel.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode(resizeId!)?.payload.newDiameter).toBe(8), { timeout: 20_000 })
    expect(hooks().dag.getNode(resizeId!)?.payload).toMatchObject({ currentDiameter: 6, newDiameter: 8, delta: 2 })
    expect(hooks().dag.featureOrder()).toEqual(orderAfterCreate)
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toEqual([resizeId])
    await expectRecognizedDiameter(resizeId!, 8)

    // One redo restores the EDITED (9 mm) diameter/result on the SAME node.
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode(resizeId!)?.payload.newDiameter).toBe(9), { timeout: 20_000 })
    expect(hooks().dag.getNode(resizeId!)?.payload).toMatchObject({ currentDiameter: 6, newDiameter: 9, delta: 3 })
    expect(hooks().dag.featureOrder()).toEqual(orderAfterCreate)
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')).toEqual([resizeId])
    await expectRecognizedDiameter(resizeId!, 9)
  }, 240_000)

  it('a missing/invalid target refuses by name without corrupting or appending history', async () => {
    // Install the capture BEFORE render (same reason as the defeature block).
    const { messages, restore } = captureWorkbenchMessages()
    pendingCaptureRestore = restore
    const h = harness()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // A resizeHole feature whose stored base diameter is invalid and whose
    // owner/feature key are missing -- the canonical "missing/invalid upstream
    // or target" state. handleEditResizeHole validates the payload BEFORE any
    // state change or kernel call, so the refusal is deterministic.
    forceInsertNode('BAD-RESIZE', [], {
      opType: 'resizeHole',
      ownerId: 'GONE',
      featureKey: '',
      currentDiameter: 0,
      newDiameter: 8,
      delta: 2,
      name: 'Resize hole to 8 mm',
    })
    const brokenBefore = hooks().dag.getNode('BAD-RESIZE')
    const orderBeforeRefusal = hooks().dag.featureOrder()
    const historySizeBeforeRefusal = hooks().history.size()
    const historyBeforeRefusal = hooks().history.serialize()

    const invalidEntry = hooks().editEntryFor('BAD-RESIZE')
    if (invalidEntry === undefined || !('onEdit' in invalidEntry)) {
      throw new Error('BAD-RESIZE must route to its edit surface')
    }
    invalidEntry.onEdit()
    await waitFor(() => {
      expect(messages.some((m) => /Resize hole edit refused/i.test(m) && m.includes('BAD-RESIZE'))).toBe(true)
    })
    // Refused BY NAME, and history/DAG are byte-identical: no command was
    // executed, no node appended, no armed surface opened.
    expect(hooks().dag.getNode('BAD-RESIZE')).toEqual(brokenBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeRefusal)
    expect(hooks().history.size()).toBe(historySizeBeforeRefusal)
    expect(hooks().history.serialize()).toEqual(historyBeforeRefusal)
    expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull()
  }, 90_000)
})
