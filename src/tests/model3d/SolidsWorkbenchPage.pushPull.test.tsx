// @vitest-environment jsdom
//
// WO UI-5 acceptance #1-#5: drives the REAL SolidsWorkbenchPage against the
// REAL in-process kernel (createLocalGeomService, same seam
// SolidsWorkbenchPage.wiring.test.tsx/downstreamRegen.test.tsx already use)
// through its actual UI affordances -- the "Push/Pull" toolbar toggle, a
// canvas click to pick a face, and the gizmo's onChange/onDraggingChange/
// onCommit seams driven via a PushPullGizmoTestDriver (jsdom lacks the
// pointer-capture APIs a real drag would touch; SolidsWorkbenchPage's
// createPushPullTestDriver prop is the injection seam this test uses, same
// contract createClient/createSceneRuntime already establish -- WO UI-57
// Design 1 replaced the old FAKE TransformControlsAdapter seam this file
// used to drive; pushPullHarness()'s own header comment below has the full
// migration story and its legacy {x,y,z}-position compatibility shim).
//
// #4's cone case has no in-scope UI affordance to BUILD a cone-bearing body
// (this WO owns no hole/countersink dialog) -- it drives the REAL page/pick
// UI exactly like the cylinder case, with classifyFace() wrapped to report
// 'cone' for the picked face (an injected fixture for the ONE seam
// handlePushPullPick's cone/cylinder/sphere/torus branch actually reads).
// The kernel's own cone classification/refusal is independently proven by
// editfeature.test.ts's #fo-refuse-cone fixture.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { BodyHandle, FaceEditRequest, OpResult } from '../../geom/geom-service'
import { INTERACTION_HOVER_ORANGE } from '../../viewport3d'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { rectangleProfile } from '../../components/model3d/workbench/profileGeometry'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

// WO-270 removed the viewport-theme and selection-glow settings, so there are
// no user prefs left for interaction mechanics to be independent OF -- the
// pins that used to sit here are gone. Resting-color assertions already
// capture the rendered baseline rather than importing a legacy color constant,
// so they hold against the one shipped palette unchanged.

/** Drains the microtask/macrotask queue a bounded number of ticks -- long
 *  enough for the in-process (createLocalGeomService) kernel's own promise
 *  chains (editFeature -> tessellate x2) to settle, short enough to stay
 *  well inside the "foreground, bounded" survival rule. */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function countOf<T>(values: T[], target: T): number {
  return values.filter((v) => v === target).length
}

/** WO UI-5-R1 (finding 1): wraps the REAL in-process kernel so the test can
 *  hold exactly one 'pushpull-preview' editFeature call open (gated on a
 *  manually-released promise) while driving cancel/commit through it --
 *  reproducing the actual in-flight race the audit found, not a proxy for
 *  it. Every other call (classifyFace, tessellate, the commit-check call,
 *  the replay call) passes straight through untouched. */
function createGatedPreviewClient(): {
  client: GeomClient
  release: () => void
  previewCallCount: () => number
  waitForPreviewSettled: () => Promise<void>
} {
  const real = createLocalGeomService()
  let armed = true
  let calls = 0
  let releaseGate: (() => void) | null = null
  let inFlight: Promise<OpResult> | null = null
  const client: GeomClient = {
    ...real,
    editFeature: (req: FaceEditRequest) => {
      if (armed && req.featureId === 'pushpull-preview') {
        armed = false
        calls++
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve
        })
        inFlight = gate.then(() => real.editFeature(req))
        return inFlight
      }
      return real.editFeature(req)
    },
  }
  return {
    client,
    release: () => releaseGate?.(),
    previewCallCount: () => calls,
    waitForPreviewSettled: async () => {
      if (inFlight !== null) await inFlight.catch(() => undefined)
    },
  }
}

/** WO UI-5-R1 (finding 2): wraps the REAL in-process kernel so the test can
 *  force the SECOND replay-loop editFeature call (featureId === the owning
 *  feature's own id -- applyFaceEditsAndFinalize's own convention) to refuse
 *  once capture is armed, while recording every disposed handle. */
function createReplayFailureClient(featureId: string): {
  client: GeomClient
  disposedHandles: BodyHandle[]
  startCapture: (failOnCallNumber: number) => void
  replayBodies: () => BodyHandle[]
} {
  const real = createLocalGeomService()
  const disposedHandles: BodyHandle[] = []
  let capture = false
  let failOnCallNumber = -1
  let replayBodies: BodyHandle[] = []
  const client: GeomClient = {
    ...real,
    dispose: async (h: BodyHandle) => {
      disposedHandles.push(h)
      return real.dispose(h)
    },
    editFeature: (req: FaceEditRequest) => {
      if (capture && req.featureId === featureId) {
        replayBodies.push(req.body)
        if (replayBodies.length === failOnCallNumber) {
          return Promise.resolve({
            ok: false,
            diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity: 'error', params: { reason: 'forced replay failure (test)' } }],
          } as OpResult)
        }
      }
      return real.editFeature(req)
    },
  }
  return {
    client,
    disposedHandles,
    startCapture: (failOnCallNumber_: number) => {
      capture = true
      failOnCallNumber = failOnCallNumber_
      replayBodies = []
    },
    replayBodies: () => replayBodies,
  }
}

/** UI-82-R4: delegates to the real local OCCT engine, but can be armed
 * immediately before an existing F2 Apply to count the isolated replay and,
 * for the refusal case, fail only downstream F3's fillet operation. */
function createTransactionalReplayClient(): {
  client: GeomClient
  arm: (refuseF3: boolean) => void
  disarm: () => void
  counts: () => { f2: number; f3: number; commitCheck: number; serialized: number }
  allCandidateHandlesDisposed: () => boolean
} {
  const real = createLocalGeomService()
  let armed = false
  let refuse = false
  let f2 = 0
  let f3 = 0
  let commitCheck = 0
  let serialized = 0
  const candidateHandles = new Set<BodyHandle>()
  const disposed = new Set<BodyHandle>()
  const client: GeomClient = {
    ...real,
    serializeBody: async (handle) => {
      if (armed) serialized++
      return real.serializeBody(handle)
    },
    restoreBody: async (bytes, delta) => {
      const handle = await real.restoreBody(bytes, delta)
      if (armed) candidateHandles.add(handle)
      return handle
    },
    editFeature: async (req) => {
      if (armed && req.featureId === 'pushpull-commit-check') commitCheck++
      if (armed && req.featureId === 'F2') f2++
      const result = await real.editFeature(req)
      if (armed && req.featureId === 'F2' && result.ok && result.body !== undefined) candidateHandles.add(result.body)
      return result
    },
    applyFillet: async (req) => {
      if (armed && req.featureId === 'F3') {
        f3++
        if (refuse) {
          return {
            ok: false,
            diagnostics: [{
              code: 'KERNEL_OP_FAILED',
              severity: 'error',
              params: { reason: 'forced F3 replay refusal (UI-82-R4)' },
            }],
          }
        }
      }
      const result = await real.applyFillet(req)
      if (armed && req.featureId === 'F3' && result.ok && result.body !== undefined) candidateHandles.add(result.body)
      return result
    },
    dispose: async (handle) => {
      if (candidateHandles.has(handle)) disposed.add(handle)
      return real.dispose(handle)
    },
  }
  return {
    client,
    arm: (refuseF3) => {
      armed = true
      refuse = refuseF3
      f2 = 0
      f3 = 0
      commitCheck = 0
      serialized = 0
      candidateHandles.clear()
      disposed.clear()
    },
    disarm: () => { armed = false },
    counts: () => ({ f2, f3, commitCheck, serialized }),
    allCandidateHandlesDisposed: () =>
      candidateHandles.size > 0 && [...candidateHandles].every((handle) => disposed.has(handle)),
  }
}

/** WO UI-5-R2 (blocker): the audited residual hole is in the PAINT phase,
 *  AFTER editFeature has already resolved -- runPushPullPreview ->
 *  paintPreviewBodyGuarded -> progressiveTessellate's two internal
 *  client.tessellate awaits, each followed by a cache.ingest + owner-mesh
 *  swap. This wrapper leaves editFeature untouched (so the preview EDIT
 *  resolves normally) but HOLDS the tessellate call for the resulting preview
 *  body until released -- reproducing the real "gesture ends while the paint
 *  is mid-flight" race the R1 editFeature-gate could not reach. It also spies
 *  every dispose() so a test can assert the stale path disposes the preview
 *  handle exactly once. The preview body is identified by capturing the
 *  handle the FIRST 'pushpull-preview' editFeature returns; commit/cancel's
 *  own base/committed tessellations (different handles) pass straight
 *  through, so only the stale preview's paint is gated. */
function createPaintGatedClient(): {
  client: GeomClient
  release: () => void
  gateEntered: () => Promise<void>
  previewBody: () => BodyHandle | null
  disposeCountOfPreview: () => number
} {
  const real = createLocalGeomService()
  let previewBody: BodyHandle | null = null
  let previewDisposeCount = 0
  let releaseGate: (() => void) | null = null
  let gatePromise: Promise<void> | null = null
  let markGateEntered: (() => void) | null = null
  const gateEnteredPromise = new Promise<void>((resolve) => {
    markGateEntered = resolve
  })
  const client: GeomClient = {
    ...real,
    editFeature: async (req: FaceEditRequest) => {
      const r = await real.editFeature(req)
      if (req.featureId === 'pushpull-preview' && previewBody === null && r.ok && r.body !== undefined) {
        previewBody = r.body
      }
      return r
    },
    tessellate: async (h: BodyHandle, q) => {
      if (previewBody !== null && h === previewBody) {
        if (gatePromise === null) {
          gatePromise = new Promise<void>((resolve) => {
            releaseGate = resolve
          })
          markGateEntered?.()
        }
        await gatePromise
      }
      return real.tessellate(h, q)
    },
    dispose: async (h: BodyHandle) => {
      if (previewBody !== null && h === previewBody) previewDisposeCount++
      return real.dispose(h)
    },
  }
  return {
    client,
    release: () => releaseGate?.(),
    gateEntered: () => gateEnteredPromise,
    previewBody: () => previewBody,
    disposeCountOfPreview: () => previewDisposeCount,
  }
}

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

/** CommandHistory exposes only canUndo()/canRedo() booleans, not a depth --
 *  by this point in the test, sketch+extrude have already pushed real
 *  commands, so "no command in history" (AC2's literal wording) means "the
 *  DEPTH did not change", not "canUndo() is false". Measures depth by
 *  fully unwinding then replaying (undo()/redo() are exact inverses --
 *  the SAME guarantee every dialog Apply's undo test already relies on),
 *  leaving history exactly as found. */
function historyDepth(h: SolidsWorkbenchHooks): number {
  let n = 0
  while (h.history.undo()) n++
  for (let i = 0; i < n; i++) h.history.redo()
  return n
}

/** Legacy-shaped test seam (WO UI-57 Design 1 migration): the retired
 *  FakeTransformControlsAdapter reported a RAW position ({x,y,z}) that
 *  PushPullGizmo itself used to project onto the face normal (delta =
 *  dot(pos - origin, normal)). The rewritten PushPullGizmo owns its own
 *  pointer/raycast lifecycle and its PushPullGizmoTestDriver seam takes the
 *  signed delta DIRECTLY (see PushPullGizmo.tsx's own header comment -- the
 *  on-axis constraint is now enforced by construction, not by projecting a
 *  raw position, so there is no more off-axis component for a driver to
 *  carry; PushPullGizmo.test.tsx's own real-raycasting drag test is what now
 *  proves off-axis pointer noise still yields an on-axis delta, at the unit
 *  level). This shim preserves the OLD simulateDragStart/simulateDrag({x,y,z})/
 *  simulateDragEnd call shape so the ~90 call sites below need NO changes --
 *  only this harness function's own internals do. Every fixture in this file
 *  picks a box's TOP face (normal always +Z), so delta = z - originZ
 *  reproduces the OLD combination's arithmetic exactly. originZ is captured
 *  FRESH on every simulateDragStart (reading the CURRENT committed top-face z
 *  via hooks().getBodyTopPoint) -- required because a SECOND drag on an
 *  already-edited body picks a face at a NEW z (see "disposes the superseded
 *  base body handle..." test: commit #2 drags from z=15, not the original 12,
 *  after commit #1 already raised the top face). */
interface LegacyPositionAdapter {
  simulateDragStart(): void
  simulateDrag(pos: { x: number; y: number; z: number }): void
  simulateDragEnd(): void
}

/** Harness: captures the fake scene runtime (for rayOverride/setOrbitEnabledCalls)
 *  and the MOST RECENT PushPullGizmoTestDriver the gizmo mounted (a fresh
 *  instance is created every time PushPullGizmo mounts -- one per pick,
 *  since the gizmo unmounts on cancel/commit), wrapped in the legacy
 *  {x,y,z}-position shape above. */
function pushPullHarness() {
  let runtime: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    runtime = rt
    return rt
  }
  let realDriver: PushPullGizmoTestDriver | null = null
  let driverFactoryCalls = 0
  let originZ = 0
  const createTestDriver: CreatePushPullGizmoTestDriver = () => {
    driverFactoryCalls++
    // PushPullGizmo.tsx overwrites this object's three methods with its own
    // bound implementations right after this factory returns -- the caller
    // (this harness) keeps the SAME object reference so `adapter()` below
    // always reads the CURRENT bound methods, not a stale placeholder.
    const obj = {} as PushPullGizmoTestDriver
    realDriver = obj
    return obj
  }
  /** WO UI-79 F-A: releasing the drag NO LONGER completes the tool. This legacy
   *  seam preserved the OLD "end the gesture = commit" meaning for the ~90
   *  mechanics call sites below, so it now RELEASES the drag and then drives the
   *  REAL commit surface -- the shared AnchoredValueEntry's Apply, the sole
   *  commit path (mirroring the SKC-44 fillet-drag standard). Fire-and-forget:
   *  each caller's own `await waitFor(...)` / gated await after simulateDragEnd
   *  gives the entry render + Apply click time. The entry needs a non-null
   *  projection to render, so default one in when a test has not set its own.
   *  A disabled Apply (zero/invalid draft) is left un-clicked -- the same
   *  "no commit" outcome the old near-zero onCommit guard produced. The
   *  release-vs-complete BEHAVIOUR itself (release stays armed; Apply commits)
   *  is proven separately -- the F-A acceptance tests + PushPullGizmo.test.tsx;
   *  here the legacy sites only need the commit to LAND. */
  const commitViaApply = async (): Promise<void> => {
    if (runtime && runtime.projectToCanvasResult === null) runtime.projectToCanvasResult = { x: 200, y: 200 }
    const apply = await screen.findByTestId('pushpull-delta-entry-apply', undefined, { timeout: 20_000 })
    if (!(apply as HTMLButtonElement).disabled) fireEvent.click(apply)
  }
  const legacyAdapter: LegacyPositionAdapter = {
    simulateDragStart: () => {
      originZ = hooks().getBodyTopPoint('F1')?.z ?? 0
      realDriver?.simulateDragStart()
    },
    simulateDrag: (pos) => realDriver?.simulateDrag(pos.z - originZ),
    simulateDragEnd: () => {
      realDriver?.simulateDragEnd()
      void commitViaApply().catch(() => undefined)
    },
  }
  return {
    createSceneRuntime: captureSceneRuntime,
    createPushPullTestDriver: createTestDriver,
    runtime: () => runtime as unknown as FakeSceneRuntime,
    adapter: (): LegacyPositionAdapter | null => (realDriver ? legacyAdapter : null),
    adapterFactoryCalls: () => driverFactoryCalls,
  }
}

/** Renders the page, builds the 40x20x12 box (top face at z=12), arms
 *  Push/Pull, picks the top face, and starts a drag -- the shared prelude
 *  every gated-client test needs before it drives a preview. Hoisted to module
 *  scope by WO UI-14A-R2 so its single-flight tests reuse it verbatim. */
async function renderBoxArmPick(createClient: () => GeomClient, h: ReturnType<typeof pushPullHarness>): Promise<void> {
  render(
    <SolidsWorkbenchPage
      createClient={createClient}
      createSceneRuntime={h.createSceneRuntime}
      createPushPullTestDriver={h.createPushPullTestDriver}
    />,
  )
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '12')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

  h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
  await waitFor(() => expect(hooks().getBodyGeometryHash('F1')).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

  fireEvent.click(screen.getByTestId('workbench-push-pull'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(0), { timeout: 20_000 })
  h.adapter()!.simulateDragStart()
}

describe('SolidsWorkbenchPage push/pull face-edit mode (WO UI-5, real occt-wasm kernel)', () => {
  it('mounts a normal-constrained gizmo on a planar pick (#1), previews without history (#2), cancels cleanly (#2), commits exactly one undoable edit matching a direct editFeature call (#3), and refuses an overcut without committing (#4 planar-refused)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // --- Build a box: sketch (proven ray-pick coordinates from
    // downstreamRegen.test.tsx: rect center (30,10) in world XY) extruded
    // 12mm (top face at z=12, mirroring GEO-10's own BOX.z=12 fixture). ---
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const originalHandle = hooks().getBodyHandle('F1')!
    const originalVol = (await hooks().client.measure(originalHandle, 'volume')).value
    expect(originalVol).toBeCloseTo(40 * 20 * 12, 1)
    const originalFeatureOrder = [...hooks().dag.featureOrder()]
    const baseDepth = historyDepth(hooks()) // sketch + extrude already pushed 2 commands

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    // ===================== AC1: mount + orbit toggle =========================
    let priorAdapterCalls = h.adapterFactoryCalls()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    // Wait for a FRESH adapter instance (not just "non-null") -- a stale
    // adapter reference from a PRIOR gesture would otherwise look mounted
    // even before this pick's own gizmo actually attaches.
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy()

    h.adapter()!.simulateDragStart()
    expect(h.runtime().setOrbitEnabledCalls.at(-1)).toBe(false) // orbit disabled during drag

    // ===================== AC1 (off-axis constraint, end to end) + AC2 =======
    // Off-axis pointer input (x/y moved far from the pick point) must still
    // produce an on-axis (normal-only) delta -- proven at the unit level in
    // PushPullGizmo.test.tsx; this re-confirms the wiring end to end. z=15 on
    // a face at z~12 is a +3 pull.
    h.adapter()!.simulateDrag({ x: 999, y: -999, z: 15 })
    await waitFor(() => expect(h.runtime().requestRenderCallCount).toBeGreaterThan(0))

    // AC2: preview never enters command history (depth unchanged), and the
    // COMMITTED handle of record is untouched mid-drag (the preview body is
    // a separate, uncommitted kernel handle -- see runPushPullPreview's doc
    // comment).
    expect(historyDepth(hooks())).toBe(baseDepth)
    expect(hooks().getBodyHandle('F1')).toBe(originalHandle)

    // AC2: Escape cancels -- the committed handle/history stay exactly as
    // they were (nothing to "restore" from, since nothing committed was ever
    // touched -- the strongest form of "restores the original mesh").
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull())
    expect(historyDepth(hooks())).toBe(baseDepth)
    expect(hooks().getBodyHandle('F1')).toBe(originalHandle)
    expect(hooks().dag.featureOrder()).toEqual(originalFeatureOrder)

    // ===================== AC3: commit ========================================
    priorAdapterCalls = h.adapterFactoryCalls()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })

    h.adapter()!.simulateDragStart()
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // on-axis, +3 pull
    h.adapter()!.simulateDragEnd()

    await waitFor(() => expect(historyDepth(hooks())).toBe(baseDepth + 1), { timeout: 20_000 })
    expect(h.runtime().setOrbitEnabledCalls.at(-1)).toBe(true) // orbit restored after drag
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull() // gizmo unmounted post-commit

    // Exactly ONE command: history depth grew by exactly 1, and featureOrder
    // grew by exactly the new first-class pushPull node F2 (WO UI-80: the
    // commit now mints its OWN DAG node consuming F1 instead of stashing a
    // payload.faceEdits sub-record on the owner).
    expect(hooks().dag.featureOrder()).toEqual([...originalFeatureOrder, 'F2'])
    // Body of record for the PUSHED result is the new node F2; the owner F1 is
    // now hidden and holds its original base geometry. The node exists
    // synchronously with the command, but its body is painted by the async
    // fullResync -- wait for that handle before measuring it.
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    const committedHandle = hooks().getBodyHandle('F2')!
    expect(committedHandle).not.toBe(originalHandle)
    const committedVol = (await hooks().client.measure(committedHandle, 'volume')).value
    expect(committedVol - originalVol).toBeCloseTo(40 * 20 * 3, 1) // area * delta

    // Geometry matches a DIRECT editFeature call with the SAME delta --
    // recover the delta this gesture committed from the committed pushPull
    // node's own payload (createFeatureCommand's target: kind 'feature',
    // opType 'pushPull', with the target face carried as a single-face ref),
    // and replay it against an INDEPENDENT box of the SAME dimensions (rather
    // than the page's own `originalHandle`, which the commit's own regen
    // already disposed via disposePriorReplayHandle -- the SAME "no leaked
    // stale handle" guarantee INT-4A-R1 established, working exactly as
    // intended). makeBox's deterministic id scheme (editfeature.test.ts's own
    // TOP = 'F1:BOX:zMax' constant) makes this a like-for-like comparison:
    // same 40x20x12 box, same top-face id convention, same edit kind/delta.
    const pushPullNode = hooks().dag.getNode('F2')
    expect(pushPullNode?.payload.opType).toBe('pushPull')
    expect(pushPullNode?.consumes).toContain('F1') // consumes the owner extrude
    expect(pushPullNode?.refs[0]?.kind).toBe('single-face') // target face rides node.refs
    const committedDelta = pushPullNode?.payload.delta as number
    expect(committedDelta).toBeCloseTo(3, 1)
    const verifyBox = (await hooks().client.makeBox('F1', { x: 40, y: 20, z: 12 })).body!
    const verifyBaseVol = (await hooks().client.measure(verifyBox, 'volume')).value
    expect(verifyBaseVol).toBeCloseTo(originalVol, 1)
    const direct = await hooks().client.editFeature({ featureId: 'verify', body: verifyBox, featureKey: 'F1:BOX:zMax', delta: committedDelta, kind: 'faceOffset' })
    expect(direct.ok).toBe(true)
    const directVol = (await hooks().client.measure(direct.body!, 'volume')).value
    expect(directVol - verifyBaseVol).toBeCloseTo(committedVol - originalVol, 1)
    await hooks().client.dispose(direct.body!)

    // Single undo restores exactly: geometry AND featureOrder.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(async () => {
      const handle = hooks().getBodyHandle('F1')
      if (handle === undefined) throw new Error('F1 not rebuilt yet')
      const v = (await hooks().client.measure(handle, 'volume')).value
      expect(v).toBeCloseTo(originalVol, 1)
    }, { timeout: 20_000 })
    expect(hooks().dag.featureOrder()).toEqual(originalFeatureOrder)
    expect(historyDepth(hooks())).toBe(baseDepth)

    // ===================== AC4: planar-refused (overcut) =====================
    // Same top face, delta -20 on a 12mm-tall block -- the exact
    // #fo-refuse-overcut fixture GEO-10's editfeature.test.ts proves refuses
    // at the engine level. Must show the reason and NOT commit.
    priorAdapterCalls = h.adapterFactoryCalls()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })

    h.adapter()!.simulateDragStart()
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: -8 }) // 12 - 20 = -8 -> delta -20
    await waitFor(() => {
      const hint = screen.getByTestId('solids-workbench-pushpull-hint').textContent ?? ''
      expect(hint).toMatch(/DEFEATURE_UNSUPPORTED|solid|out-of-class/i)
    }, { timeout: 20_000 })

    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 }) // gizmo unmounted -- "no gizmo mount" as the post-refusal resting state
    expect(historyDepth(hooks())).toBe(baseDepth) // refused: no command committed
    expect(hooks().dag.featureOrder()).toEqual(originalFeatureOrder)
    const finalVol = (await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')).value
    expect(finalVol).toBeCloseTo(originalVol, 1) // unchanged -- the refusal never touched the committed body
  }, 90_000)

  it('a preview whose editFeature resolves AFTER Escape-cancel does NOT repaint the restored mesh (finding 1, blocker)', async () => {
    const h = pushPullHarness()
    const gated = createGatedPreviewClient()
    render(
      <SolidsWorkbenchPage
        createClient={() => gated.client}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })
    const originalHandle = hooks().getBodyHandle('F1')!

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(0), { timeout: 20_000 })

    h.adapter()!.simulateDragStart()
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3 pull -- kicks off the gated preview call
    await waitFor(() => expect(gated.previewCallCount()).toBe(1), { timeout: 20_000 })

    // Cancel BEFORE the gated preview resolves -- the real race the audit
    // found. handlePushPullCancel repaints the base (untouched) handle and
    // returns while editFeature is still pending.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

    // NOW let the stale preview resolve, well after cancel already restored
    // the mesh, and drain its own paint chain if the fix were absent.
    gated.release()
    await gated.waitForPreviewSettled()
    await flush()

    // Fails-if: removing the generation-token check makes this fail --
    // the stale +3 preview would repaint the (already-restored) mesh's top
    // face back up to z=15.
    expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1)
    expect(hooks().getBodyHandle('F1')).toBe(originalHandle) // committed handle-of-record untouched by the stale preview
  }, 90_000)

  it('a preview whose editFeature resolves AFTER commit does NOT repaint over the committed mesh (finding 1, blocker)', async () => {
    const h = pushPullHarness()
    const gated = createGatedPreviewClient()
    render(
      <SolidsWorkbenchPage
        createClient={() => gated.client}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(0), { timeout: 20_000 })

    h.adapter()!.simulateDragStart()
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 13 }) // +1 -- the gated (never-repainted) preview
    await waitFor(() => expect(gated.previewCallCount()).toBe(1), { timeout: 20_000 })

    // Move further and release the pointer at a DIFFERENT final delta
    // BEFORE the +1 preview above ever resolves -- onCommit re-validates
    // with its own fresh (ungated) editFeature call, so the commit itself
    // completes normally.
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3 -- becomes the committed delta
    h.adapter()!.simulateDragEnd()

    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
    // WO UI-80: the committed (+3) result now lives on the new node F2, not on
    // the owner F1 (which is hidden with its original base geometry).
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    const committedHandle = hooks().getBodyHandle('F2')!

    // NOW release the stale +1 preview, well after commit already landed.
    gated.release()
    await gated.waitForPreviewSettled()
    await flush()

    // Fails-if: removing the generation-token check makes this fail -- the
    // stale +1 preview would repaint the committed (+3) mesh back down to
    // z=13, and would leave the committed handle-of-record disagreeing
    // with what's on screen.
    expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1)
    expect(hooks().getBodyHandle('F2')).toBe(committedHandle)
  }, 90_000)

  it('disposes the superseded prior handle on a pushPull-node replay, and does not double-dispose or leave a stale exportable handle on a mid-chain regen refusal (finding 2, major; WO UI-80 node model)', async () => {
    const h = pushPullHarness()
    // WO UI-80: push/pull is now a first-class node. Two commits create the
    // sibling chain F2 (consumes F1) and F3 (consumes F2); each node's regen
    // calls client.editFeature({ featureId: node.id, kind: 'faceOffset', ... }).
    // Target F3 -- the LAST link of the chain -- and force ITS regen to refuse.
    const rc = createReplayFailureClient('F3')
    render(
      <SolidsWorkbenchPage
        createClient={() => rc.client}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    // ---- Commit #1: +3 -> creates node F2 (consumes F1). ----
    let priorAdapterCalls = h.adapterFactoryCalls()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })
    h.adapter()!.simulateDragStart()
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
    h.adapter()!.simulateDragEnd()
    // Wait for F2 to exist AND be painted (its body of record) before the
    // second pick raycasts the now-visible top face at z=15.
    await waitFor(() => {
      expect(hooks().dag.getNode('F2')?.payload.opType).toBe('pushPull')
      expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1)
    }, { timeout: 20_000 })

    // ---- Commit #2: a second push on the now-higher top face -> creates node
    // F3 (consumes F2). Two sibling pushPull nodes now stack on the extrude. ----
    priorAdapterCalls = h.adapterFactoryCalls()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })
    h.adapter()!.simulateDragStart()
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 17 })
    h.adapter()!.simulateDragEnd()
    // Wait for F3 to exist AND be painted before capturing its live handle.
    await waitFor(() => {
      expect(hooks().dag.getNode('F3')?.payload.opType).toBe('pushPull')
      expect(hooks().getBodyHandle('F3')).not.toBeUndefined()
    }, { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')?.consumes).toContain('F1') // F2 consumes the extrude
    expect(hooks().dag.getNode('F3')?.consumes).toContain('F2') // F3 consumes F2

    // Capture F3's live handle before forcing its regen to fail -- this is the
    // handle disposePriorReplayHandle(F3) will retire at the top of F3's own
    // regen branch, and the one that must NOT survive as a stale exportable.
    const staleF3 = hooks().getBodyHandle('F3')!

    // ---- Force a regen (edit the extrude distance, same trigger
    // SolidsWorkbenchPage.handleLeak.test.tsx uses) that re-runs F1 -> F2 -> F3
    // in topo order, with the LAST link's (F3's) own editFeature made to refuse
    // -- the "mid-chain refusal" case the audit asked for, keyed on the node. ----
    rc.startCapture(1)
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    commitField('extrude-distance', '14')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    // F3's regen reaches its single editFeature call (input = F2's rebuilt
    // body) and is refused.
    await waitFor(() => expect(rc.replayBodies().length).toBe(1), { timeout: 20_000 })
    await waitFor(() => expect(rc.disposedHandles).toContain(staleF3), { timeout: 20_000 })

    // Fails-if: disposePriorReplayHandle double-fires for the same handle --
    // F3's prior handle is disposed exactly once at the top of its regen.
    expect(countOf(rc.disposedHandles, staleF3)).toBe(1)
    // The failed pushPull-node replay leaves NO stale exportable handle for F3
    // (INT-4A-R1 invariant, now keyed on the node id rather than the owner).
    expect(hooks().getBodyHandle('F3')).toBeUndefined()
  }, 90_000)

  // WO UI-16 (C6): the hint-bar typed-delta field -- proves a TYPED commit produces the exact same
  // faceOffset request/history shape the gizmo-driven commit test above already proves, and that
  // Enter routes through handlePushPullCommit -- THE SAME function the gizmo's own onCommit calls
  // (SolidsWorkbenchPage.tsx's dialog render block wires both to one call; there is no second commit
  // implementation to drift out of sync with it).
  it('typed delta entry: TWO-STAGE Enter -- the first ADJUSTS (previews, stays open), a second unedited Enter COMPLETES via handlePushPullCommit -- the SAME path the gizmo onCommit uses (WO UI-16 C6, WO UI-57 Design 3)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const originalHandle = hooks().getBodyHandle('F1')!
    const baseDepth = historyDepth(hooks())

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    // AnchoredValueEntry renders nothing while its anchor projects to null
    // (the fake runtime's own default) -- pre-arm it, same contract
    // SolidsWorkbenchPage.resizeHole.test.tsx's captureRuntime() documents.
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })

    // No drag at all -- single-shot pick mounts the gizmo AND shows the entry immediately
    // (PushPullMode 'mounted' does not require a live drag gesture).
    const deltaInput = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement
    fireEvent.change(deltaInput, { target: { value: '3' } })

    // ---- Stage 1: first Enter on a CHANGED draft ADJUSTS only. ----
    fireEvent.keyDown(deltaInput, { key: 'Enter' })
    await flush() // let the adjust's async preview settle (a waitFor(...===baseDepth) proves nothing -- it is already true at t=0)
    expect(historyDepth(hooks())).toBe(baseDepth) // NOT committed yet
    expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy() // entry still open
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy() // gizmo still mounted

    // ---- Stage 2: a SECOND Enter with NO edit in between COMPLETES. ----
    fireEvent.keyDown(deltaInput, { key: 'Enter' })
    await waitFor(() => expect(historyDepth(hooks())).toBe(baseDepth + 1), { timeout: 20_000 })
    // Gizmo unmounted post-commit -- the SAME resting state a gizmo-driven commit leaves (proving
    // this went through the real commit lifecycle, not a bespoke shortcut).
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull()

    // WO UI-80: the typed commit mints the SAME first-class pushPull node F2 a
    // gizmo-driven commit does -- body of record is F2, not the owner F1.
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    const committedHandle = hooks().getBodyHandle('F2')!
    expect(committedHandle).not.toBe(originalHandle)
    const pushPullNode = hooks().dag.getNode('F2')
    expect(pushPullNode?.payload.opType).toBe('pushPull')
    expect(pushPullNode?.refs[0]?.kind).toBe('single-face')
    expect(pushPullNode?.payload.delta as number).toBeCloseTo(3, 6)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(historyDepth(hooks())).toBe(baseDepth), { timeout: 20_000 })
  }, 60_000)

  it('typed delta entry: Enter, EDIT AGAIN, Enter -- ADJUSTS a second time (does not complete); a clean third Enter completes (WO UI-57 Design 3)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    const baseDepth = historyDepth(hooks())

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })
    const deltaInput = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement

    fireEvent.change(deltaInput, { target: { value: '3' } })
    fireEvent.keyDown(deltaInput, { key: 'Enter' }) // adjust #1 (to 3)
    await flush()
    expect(historyDepth(hooks())).toBe(baseDepth)
    expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy()

    fireEvent.change(deltaInput, { target: { value: '5' } }) // EDIT AGAIN before the next Enter
    fireEvent.keyDown(deltaInput, { key: 'Enter' }) // adjust #2 (to 5) -- must NOT complete
    await flush()
    expect(historyDepth(hooks())).toBe(baseDepth)
    expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy()
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy()

    fireEvent.keyDown(deltaInput, { key: 'Enter' }) // clean Enter -> completes at 5
    await waitFor(() => expect(historyDepth(hooks())).toBe(baseDepth + 1), { timeout: 20_000 })
    const pushPullNode = hooks().dag.getNode('F2')
    expect(pushPullNode?.payload.opType).toBe('pushPull')
    expect(pushPullNode?.payload.delta as number).toBeCloseTo(5, 6)
  }, 60_000)

  it('typed delta entry: FOCUS-LOSS TRAP -- blurring the input (e.g. clicking away) mid-typing ADJUSTS only, never completes the feature (WO UI-57 Design 3)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    const baseDepth = historyDepth(hooks())

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy(), { timeout: 20_000 })
    const deltaInput = screen.getByTestId('pushpull-delta-entry-input') as HTMLInputElement

    fireEvent.change(deltaInput, { target: { value: '4' } })
    fireEvent.blur(deltaInput) // simulates clicking the gizmo mid-typing
    await flush()
    expect(historyDepth(hooks())).toBe(baseDepth) // NEVER completes on blur
    expect(screen.getByTestId('pushpull-delta-entry')).toBeTruthy() // entry stays open
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy() // gizmo stays mounted
  }, 60_000)

  it('picking a CYLINDER wall refuses at pick time (structured reason) and mounts no gizmo (#4)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // A full-360 revolve of a rectangle [rIn=10, rOut=50] x height 20 about
    // world Z -- a hollow cylinder/tube, same Pappus fixture
    // SolidsWorkbenchPage.wiring.test.tsx already proves. Its outer wall
    // (radius 50) is a genuine kernel CYLINDER face.
    await mintRectangleSketch({ width: '40', height: '20', offset: '10', plane: 'xz' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-revolve'))
    commitField('revolve-angle', '360')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // Ray straight at the outer wall from world +X, mid-height.
    h.runtime().rayOverride = { origin: { x: 1000, y: 0, z: 10 }, direction: { x: -1, y: 0, z: 0 } }

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => {
      const hint = screen.getByTestId('solids-workbench-pushpull-hint').textContent ?? ''
      expect(hint).toMatch(/cylinder/i)
    }, { timeout: 20_000 })
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy() // still armed (hint block renders in both 'arm' and 'mounted')
    expect(h.adapter()).toBeNull() // the gizmo was never mounted -- no adapter was ever constructed
    expect(h.adapterFactoryCalls()).toBe(0)
  }, 30_000)

  it('picking a CONE face refuses at pick time (structured reason) and mounts no gizmo (#4)', async () => {
    // WO UI-5-R1 (finding 3): SolidsWorkbenchPage owns no hole/countersink
    // dialog, so there is no in-scope UI affordance that BUILDS a body with
    // a real cone face to click -- the suggested fix's "injected-fixture
    // workbench test" seam. handlePushPullPick's cone/cylinder/sphere/torus
    // branch is identical (it only ever branches on classifyFace()'s
    // returned SurfaceType string, see handlePushPullPick's own `if
    // (surfaceType !== 'plane')` check), so classifyFace is the ONE seam
    // wrapped here -- everything else (pick raycast, hint rendering, adapter
    // construction) is the REAL page driven exactly like the cylinder case
    // above. The kernel's OWN cone classification/refusal is independently
    // proven by editfeature.test.ts's #fo-refuse-cone fixture (a real
    // countersink face) -- this test proves the WORKBENCH UI plumbing for
    // that outcome, which #fo-refuse-cone cannot reach.
    const h = pushPullHarness()
    const real = createLocalGeomService()
    const client: GeomClient = { ...real, classifyFace: async () => 'cone' }
    render(
      <SolidsWorkbenchPage
        createClient={() => client}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => {
      const hint = screen.getByTestId('solids-workbench-pushpull-hint').textContent ?? ''
      expect(hint).toMatch(/cone/i)
    }, { timeout: 20_000 })
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy() // still armed (hint block renders in both 'arm' and 'mounted')
    expect(h.adapter()).toBeNull() // the gizmo was never mounted -- no adapter was ever constructed
    expect(h.adapterFactoryCalls()).toBe(0)
  }, 30_000)
})

// ===========================================================================
// WO UI-5-R2: the invariant across the ENTIRE async PAINT pipeline.
//
// R1 gated the editFeature-resolution boundary; the re-audit proved the hole
// moved one await deeper -- into the tessellate/paint phase. These three tests
// hold the PAINT gate (not editFeature) via createPaintGatedClient, so the
// preview's edit resolves and its paint is caught mid-flight when the gesture
// ends. They assert the OWNER MESH's position-buffer CONTENT HASH (per the R2
// order: "not top-Z, not handle identity"), and that the stale path disposes
// the preview handle without surfacing an unhandled rejection.
//
// A note on why the FIX's disposal-ordering change is what makes these BITE:
// R1 published the preview handle to pushPullPreviewHandleRef BEFORE painting,
// so cancel/commit disposed the STILL-IN-FLIGHT preview handle -- the held
// tessellate would then REJECT on release (never repaint), so a buffer assert
// could not distinguish guarded from unguarded. R2 publishes the handle only
// AFTER the paint is confirmed current; cancel/commit no longer touch an
// in-flight handle, so on release the stale tessellate RESOLVES and -- absent
// the generation guard -- repaints stale geometry over the restored/committed
// mesh, which the buffer hash catches. Mutation-proof records in the report.
// ===========================================================================
describe('SolidsWorkbenchPage push/pull stale-preview PAINT-phase invariant (WO UI-5-R2)', () => {
  it('a preview whose PAINT is still in flight when Escape-cancel fires does NOT overwrite the restored mesh buffer, and disposes the preview handle without an unhandled rejection (finding: paint-phase race)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createPaintGatedClient()
      await renderBoxArmPick(() => gated.client, h)

      // Baseline: the owner mesh currently shows the committed base (z=12).
      const baseHash = hooks().getBodyGeometryHash('F1')!

      // Drag +3 -> preview editFeature resolves; its PAINT tessellate is now
      // held by the gate (editFeature is NOT gated).
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await gated.gateEntered()
      expect(gated.previewBody()).not.toBeNull()

      // Cancel while the preview paint is parked at the gate. Cancel repaints
      // the base (its own tessellation of a DIFFERENT handle -- ungated) and
      // returns; it does NOT dispose the in-flight preview handle (R2
      // ordering), so the held tessellate will resolve successfully on
      // release rather than reject.
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      expect(hooks().getBodyGeometryHash('F1')).toBe(baseHash) // deterministic re-tess of base -> identical content

      // Release the stale preview paint, well after cancel restored the mesh.
      gated.release()
      await waitFor(() => expect(gated.disposeCountOfPreview()).toBe(1), { timeout: 20_000 })
      await flush()

      // Fails-if: with the generation guard removed from paintPreviewBodyGuarded,
      // the +3 preview tessellate ingests + repaints over the restored base,
      // changing the mesh buffer hash away from baseHash.
      expect(hooks().getBodyGeometryHash('F1')).toBe(baseHash)
      // WO UI-14A (BK-87 fold-in, UI-5.audit.json major finding): binds the
      // guardedClient throw-if-stale (SolidsWorkbenchPage.tsx's
      // paintPreviewBodyGuarded) INDIVIDUALLY, not just in conjunction with
      // the onPaint predicate -- removing ONLY the wrapper throw lets a
      // stale cache.ingest corrupt the GeometryCache entry under 'F1' (a
      // real self-contained defect: PickEngine/mass-properties/measure all
      // read through the cache, not the mesh) even though the onPaint
      // predicate alone still blocks the MESH swap, so the buffer-hash
      // assert above alone would miss it. getBodyTopPoint reads the CACHE
      // (GeometryCache), never meshesRef -- this is what the buffer-hash
      // assert cannot see.
      expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1)
      expect(gated.disposeCountOfPreview()).toBe(1) // stale path disposed the preview handle exactly once
      await flush()
      expect(rejections).toEqual([]) // swallowed cleanly -- no unhandled rejection
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('a preview whose PAINT is still in flight when commit fires does NOT overwrite the committed mesh buffer, and disposes the preview handle without an unhandled rejection (finding: paint-phase race)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createPaintGatedClient()
      await renderBoxArmPick(() => gated.client, h)

      // Drag +1 -> preview editFeature resolves; its PAINT is held at the gate.
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 13 })
      await gated.gateEntered()
      expect(gated.previewBody()).not.toBeNull()

      // Move to +3 (coalesced pending -- no new editFeature while one is in
      // flight) and release the pointer: commit re-validates the FINAL delta
      // with its own fresh (ungated) editFeature + regen paint (a DIFFERENT
      // handle), so the commit lands at z=15 normally.
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      h.adapter()!.simulateDragEnd()
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      // WO UI-80: the committed (+3) body of record is the new node F2.
      await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
      const committedHash = hooks().getBodyGeometryHash('F2')!

      // Release the stale +1 preview paint, well after commit landed at +3.
      gated.release()
      await waitFor(() => expect(gated.disposeCountOfPreview()).toBe(1), { timeout: 20_000 })
      await flush()

      // Fails-if: without the generation guard, the +1 preview tessellate
      // ingests + repaints over the committed +3 mesh, changing the hash.
      expect(hooks().getBodyGeometryHash('F2')).toBe(committedHash)
      // WO UI-14A (BK-87 fold-in, UI-5.audit.json major finding): see the
      // matching comment in the cancel test above -- binds the guardedClient
      // throw-if-stale INDIVIDUALLY via a cache read (getBodyTopPoint),
      // which the mesh-only buffer-hash assert above cannot catch.
      expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1)
      expect(gated.disposeCountOfPreview()).toBe(1)
      await flush()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('the stale preview path disposes the preview handle exactly once (spy) and never re-throws into the void-called preview promise (finding: dispose + no unhandled rejection)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createPaintGatedClient()
      await renderBoxArmPick(() => gated.client, h)

      // Preview whose paint is held, then committed away underneath it.
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 14 })
      await gated.gateEntered()
      const previewHandle = gated.previewBody()
      expect(previewHandle).not.toBeNull()
      expect(gated.disposeCountOfPreview()).toBe(0) // NOT yet disposed -- commit must not dispose an in-flight handle

      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 16 })
      h.adapter()!.simulateDragEnd()
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })

      // Fails-if: removing runPushPullPreview's POST-PAINT generation re-check
      // publishes the stale body to the ref instead of disposing it -- the
      // handle then leaks and this dispose spy stays at 0.
      gated.release()
      await waitFor(() => expect(gated.disposeCountOfPreview()).toBe(1), { timeout: 20_000 })
      await flush()
      expect(gated.disposeCountOfPreview()).toBe(1) // disposed exactly once, never double
      expect(rejections).toEqual([]) // stale rejection swallowed, not re-thrown into void runPushPullPreview()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)
})

// ===========================================================================
// WO UI-14A-R2: the SINGLE-FLIGHT GESTURE LIFECYCLE (UI-14A-R1.audit.json
// blocker, reproduced verbatim below as a committed regression).
//
// The audit's ordering, in the auditor's own words: "pushPullGenerationRef is
// not mutated only from DOM-event macrotasks: after awaiting commit
// validation, handlePushPullCommit calls handlePushPullCancel, whose
// synchronous prefix increments the generation. A second drag can start while
// the first commit check is pending because onCommit is void-called and no
// commit single-flight lock disables onChange. ... The stale buffers then pass
// the wrapper, ingest into GeometryCache, and paint after the generation
// changed."
//
// Both holes are closed at the LIFECYCLE, not at the paint: (1) the commit's
// refusal path no longer re-enters handlePushPullCancel, so there is no
// post-await generation increment anywhere; (2) pushPullEndingRef refuses every
// onChange/onCommit/onCancel that arrives while a gesture end is in flight, so
// no second preview can ever capture the post-bump generation.
//
// Why these tests still BITE with (1) alone removed: the second preview's paint
// gate is released LAST, after the refusal's restore has already repainted the
// true base -- so an unlocked build ingests its stale z=14 buffers on top of a
// restored z=12 body regardless of promise-reaction ordering. The assertion
// reads getBodyTopPoint (the GeometryCache), which is precisely where the audit
// observed the stale Z, and which the mesh-only buffer-hash assert cannot see.
// ===========================================================================

/** WO UI-14A-R2: THE CONSTRUCTED INTERLEAVE, driven through the supported
 *  `createClient` seam exactly as the auditor drove it. Holds the
 *  'pushpull-commit-check' editFeature call open, then resolves it as a
 *  REFUSAL, so a test can start a SECOND drag inside the commit-pending window.
 *  Separately holds the tessellation of any preview body created DURING that
 *  window, so its paint can be forced to land AFTER the refusal's restore.
 *
 *  Under the single-flight lock no such preview is ever created, so that second
 *  gate is never entered -- tests must never `await` it, only release it (a
 *  no-op then). Every other kernel call passes through to the REAL in-process
 *  service untouched. */
function createCommitInterleaveClient(): {
  client: GeomClient
  previewCalls: () => number
  interleavedPreviewCreated: () => boolean
  commitCheckEntered: () => Promise<void>
  releaseCommitCheck: () => void
  releaseInterleavedPreviewPaint: () => void
} {
  const real = createLocalGeomService()
  let previewCalls = 0
  let commitPending = false
  let interleavedPreviewBody: BodyHandle | null = null

  let markCommitEntered: (() => void) | null = null
  const commitEnteredPromise = new Promise<void>((resolve) => {
    markCommitEntered = resolve
  })
  let releaseCommit: (() => void) | null = null
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  let releasePaint: (() => void) | null = null
  const paintGate = new Promise<void>((resolve) => {
    releasePaint = resolve
  })

  const client: GeomClient = {
    ...real,
    editFeature: async (req: FaceEditRequest) => {
      if (req.featureId === 'pushpull-commit-check') {
        commitPending = true
        markCommitEntered?.()
        await commitGate
        // The audit's scenario: the commit resolves REFUSED, sending
        // handlePushPullCommit down the restore path from inside a promise
        // continuation -- the exact place the old code bumped the generation.
        return {
          ok: false,
          diagnostics: [{ code: 'DEFEATURE_UNSUPPORTED', severity: 'error', params: { reason: 'forced commit refusal (test)' } }],
        } as OpResult
      }
      if (req.featureId === 'pushpull-preview') {
        previewCalls++
        const r = await real.editFeature(req)
        if (commitPending && interleavedPreviewBody === null && r.ok && r.body !== undefined) interleavedPreviewBody = r.body
        return r
      }
      return real.editFeature(req)
    },
    tessellate: async (h: BodyHandle, q) => {
      if (interleavedPreviewBody !== null && h === interleavedPreviewBody) await paintGate
      return real.tessellate(h, q)
    },
  }
  return {
    client,
    previewCalls: () => previewCalls,
    interleavedPreviewCreated: () => interleavedPreviewBody !== null,
    commitCheckEntered: () => commitEnteredPromise,
    releaseCommitCheck: () => releaseCommit?.(),
    releaseInterleavedPreviewPaint: () => releasePaint?.(),
  }
}

describe('SolidsWorkbenchPage push/pull single-flight gesture lifecycle (WO UI-14A-R2)', () => {
  it('a second drag started while the first commit validation is still pending never ingests stale preview geometry over the refused commit restore (UI-14A-R1 audit blocker)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createCommitInterleaveClient()
      await renderBoxArmPick(() => gated.client, h)
      const baseHash = hooks().getBodyGeometryHash('F1')! // the true base, z=12

      // --- Gesture 1: drag +3 and let its preview paint normally (z=15). ---
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
      expect(gated.previewCalls()).toBe(1)

      // --- Release the pointer: COMMIT-PENDING. The generation is bumped in
      // onCommit's synchronous prefix; the validation call is now parked. The
      // gizmo is still mounted (setPushPullMode({kind:'none'}) runs only after
      // the awaits), so its onChange seam is still live -- which is exactly why
      // the lock, not the mode, has to be the thing that refuses. ---
      h.adapter()!.simulateDragEnd()
      await gated.commitCheckEntered()
      expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy()

      // --- THE INTERLEAVE: a second drag, inside the commit-pending window. ---
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 14 }) // +2
      await flush()

      // --- Resolve the commit as REFUSED. handlePushPullCommit restores the
      // true base (z=12) from inside a promise continuation. ---
      gated.releaseCommitCheck()
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

      // --- Release the interleaved preview's paint LAST. On a build without
      // the lock this ingests its stale +2 buffers into GeometryCache AFTER the
      // restore already landed -- the audit's "cancel required restored Z=12,
      // stale second-preview Z=14 observed". Under the lock that preview never
      // existed, so this is a no-op. ---
      gated.releaseInterleavedPreviewPaint()
      await flush()

      // Fails-if: runPushPullPreview's `if (pushPullEndingRef.current) return`
      // single-flight guard is removed -- getBodyTopPoint then reads 14.
      expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1)
      expect(hooks().getBodyGeometryHash('F1')).toBe(baseHash) // deterministic re-tess of the base
      expect(gated.interleavedPreviewCreated()).toBe(false) // no second gesture ever started
      expect(hooks().dag.getNode('F2')).toBeUndefined() // the refused commit minted no pushPull node
      await flush()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('during commit-pending the lock is observable: a new preview is refused and so is a new cancel, until the commit resolves (WO UI-14A-R2, Option B)', async () => {
    const h = pushPullHarness()
    const gated = createCommitInterleaveClient()
    await renderBoxArmPick(() => gated.client, h)

    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    expect(gated.previewCalls()).toBe(1)

    h.adapter()!.simulateDragEnd()
    await gated.commitCheckEntered()

    // onChange during commit-pending: REFUSED before any kernel call.
    // Fails-if: the `if (pushPullEndingRef.current) return` guard at the top of
    // runPushPullPreview is removed -- previewCalls becomes 2.
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 14 })
    await flush()
    expect(gated.previewCalls()).toBe(1)
    expect(gated.interleavedPreviewCreated()).toBe(false)

    // onCancel during commit-pending: REFUSED -- the pending commit owns this
    // gesture's end, so Escape must not bump the generation, must not restore,
    // and must not unmount the gizmo out from under it.
    // Fails-if: beginPushPullGestureEnd's `if (pushPullEndingRef.current) return
    // null` is removed -- the gizmo unmounts here and the mesh drops to z=12.
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy()
    expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1)

    // The commit resolves (refused) and performs the ONE restore it owns.
    gated.releaseCommitCheck()
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

    // Lock released: push/pull is usable again (never wedged).
    gated.releaseInterleavedPreviewPaint()
    await flush()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(1), { timeout: 20_000 })
  }, 90_000)
})

// ===========================================================================
// WO UI-14A-R3: THE REACT CLEANUP TAIL (UI-14A-R2.audit.json blocker).
//
// The auditor, verbatim: "The successful-commit transition releases
// pushPullEndingRef before React has committed the idle render and removed the
// old PushPullGizmo listeners. setPushPullMode({kind:'none'}) only schedules
// that render; the finally then sets the ref false while the old onChange
// closure still captures the mounted gesture. A callback already queued ahead
// of React's cleanup can therefore start a new preview with the post-bump
// generation and the old base handle. Because no later generation bump occurs,
// paintPreviewBodyGuarded accepts it; its cache ingest can land after the
// committed fullResync."
//
// The lifecycle does not end when the state says idle. It ends when the old
// gizmo's listeners are gone AND every callback they already queued is inert.
// R3 makes that end SYNCHRONOUS: handlePushPullPick mints a PushPullGesture
// token onto the mounted mode (so every gizmo closure captures it), and the
// gesture end retires the live token in the same uninterruptible `finally` step
// that releases the lock -- ahead of every queued callback, regardless of how
// React schedules the idle render. Each seam then asks "am I the LIVE gesture?"
// rather than only "did the generation move?" -- the question the generation
// counter structurally cannot answer for work that STARTED after the bump.
//
// The three tests below are the tail, driven through the SUPPORTED createClient
// + createPushPullTestDriver seams exactly as the auditor drove it:
//   1. a queued onChange  -> refused by runPushPullPreview's token check.
//   2. a queued onCommit + a queued Escape -> refused by handlePushPullCommit's
//      and handlePushPullCancel's token checks.
//   3. a THROWING commit validation -> the `any -> idle (exception)` transition
//      the R2 report claimed but the code never performed (audit finding 3),
//      now real: base restored, gizmo unmounted, token retired, lock released.
// Plus the mirror-image ARM tail (4): a pick whose classifyFace resolves after
// the user already dismissed the tool must not mount a gizmo.
// ===========================================================================

/** WO UI-14A-R3: the SUCCESS-PATH CLEANUP-TAIL harness. Three one-shot gates,
 *  in the order a successful commit hits them:
 *
 *   1. `pushpull-commit-check` -- held, then released to SUCCEED. Gives the
 *      test control of exactly when the commit's final synchronous step (the
 *      one that schedules the idle render, launches fullResync, and runs the
 *      `finally`) executes.
 *   2. `dispose(baseHandle)` -- fullResync's own disposePriorReplayHandle, the
 *      FIRST kernel call the post-commit regen makes. Parking there puts the
 *      test INSIDE the cleanup tail: handlePushPullCommit's `finally` has run
 *      (lock free, token retired) but React has not yet committed the idle
 *      render, so the old gizmo, its TransformControls listeners and its
 *      onChange/onCommit closures are all still live -- and the pre-gesture
 *      baseHandle those closures capture is still UN-disposed, exactly as it is
 *      when a real queued pointer callback lands there. Tests assert the gizmo
 *      is still mounted at this point, so the window can never close silently
 *      and let these tests pass vacuously.
 *   3. `tessellate(stalePreviewBody)` -- the PAINT of any preview created in
 *      that tail, held so it can be released LAST, after the committed
 *      fullResync has already ingested Z=15. This is the auditor's ordering.
 *
 *  It also records whether anything ever re-tessellated the pre-gesture
 *  baseHandle during the tail -- the observable act of a stale cancel's restore
 *  (`restorePushPullBase` -> `paintFeatureBody(ownerId, mode.baseHandle)`),
 *  whose ingest would overwrite the commit. Asserting the ATTEMPT is strictly
 *  stronger than asserting the resulting cache Z, which in this constructed
 *  order would depend on who wins the race with fullResync.
 *
 *  Under R3 every tail callback is refused, so gate 3 never arms and no stale
 *  preview exists -- tests must never `await` it, only release it (a no-op). */
function createCleanupTailClient(): {
  client: GeomClient
  gateBaseDisposeOf: (handle: BodyHandle) => void
  previewCalls: () => number
  commitCheckCalls: () => number
  commitCheckEntered: () => Promise<void>
  releaseCommitCheck: () => void
  baseDisposeEntered: () => Promise<void>
  releaseBaseDispose: () => void
  stalePreviewCreated: () => boolean
  releaseStalePreviewPaint: () => void
  staleBaseRepaintAttempted: () => boolean
} {
  const real = createLocalGeomService()
  let previewCalls = 0
  let commitCheckCalls = 0
  let tailPhase = false
  let baseHandle: BodyHandle | null = null
  let stalePreviewBody: BodyHandle | null = null
  let baseDisposeArmed = true
  let staleBaseRepaint = false

  let markCommitEntered: (() => void) | null = null
  const commitEnteredPromise = new Promise<void>((resolve) => {
    markCommitEntered = resolve
  })
  let releaseCommit: (() => void) | null = null
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  let markBaseDisposeEntered: (() => void) | null = null
  const baseDisposeEnteredPromise = new Promise<void>((resolve) => {
    markBaseDisposeEntered = resolve
  })
  let releaseBaseDisposeGate: (() => void) | null = null
  const baseDisposeGate = new Promise<void>((resolve) => {
    releaseBaseDisposeGate = resolve
  })
  let releasePaint: (() => void) | null = null
  const stalePaintGate = new Promise<void>((resolve) => {
    releasePaint = resolve
  })

  const client: GeomClient = {
    ...real,
    editFeature: async (req: FaceEditRequest) => {
      if (req.featureId === 'pushpull-commit-check') {
        commitCheckCalls++
        // Only the FIRST (real) commit validation is gated. A SECOND one is the
        // tail-onCommit defect itself -- let it run so the count exposes it.
        if (commitCheckCalls > 1) return real.editFeature(req)
        markCommitEntered?.()
        await commitGate
        const r = await real.editFeature(req)
        tailPhase = true
        return r
      }
      if (req.featureId === 'pushpull-preview') {
        previewCalls++
        const r = await real.editFeature(req)
        if (tailPhase && stalePreviewBody === null && r.ok && r.body !== undefined) stalePreviewBody = r.body
        return r
      }
      return real.editFeature(req)
    },
    dispose: async (h: BodyHandle) => {
      if (baseDisposeArmed && baseHandle !== null && h === baseHandle) {
        baseDisposeArmed = false
        markBaseDisposeEntered?.()
        await baseDisposeGate
      }
      return real.dispose(h)
    },
    tessellate: async (h: BodyHandle, q) => {
      if (stalePreviewBody !== null && h === stalePreviewBody) await stalePaintGate
      else if (tailPhase && baseHandle !== null && h === baseHandle) staleBaseRepaint = true
      return real.tessellate(h, q)
    },
  }
  return {
    client,
    gateBaseDisposeOf: (handle: BodyHandle) => {
      baseHandle = handle
    },
    previewCalls: () => previewCalls,
    commitCheckCalls: () => commitCheckCalls,
    commitCheckEntered: () => commitEnteredPromise,
    releaseCommitCheck: () => releaseCommit?.(),
    baseDisposeEntered: () => baseDisposeEnteredPromise,
    releaseBaseDispose: () => releaseBaseDisposeGate?.(),
    stalePreviewCreated: () => stalePreviewBody !== null,
    releaseStalePreviewPaint: () => releasePaint?.(),
    staleBaseRepaintAttempted: () => staleBaseRepaint,
  }
}

/** WO UI-14A-R3 (audit finding 3): a kernel whose commit VALIDATION throws --
 *  a rejection, not an `ok:false` refusal. The R2 code skipped every setter
 *  after the await and left the mode 'mounted' (the report claimed
 *  `any -> idle`); with the R3 token retired in the `finally`, that mounted
 *  gizmo's every seam would refuse and the tool would be visibly wedged. */
function createThrowingCommitCheckClient(): GeomClient {
  const real = createLocalGeomService()
  return {
    ...real,
    editFeature: async (req: FaceEditRequest) => {
      if (req.featureId === 'pushpull-commit-check') throw new Error('forced kernel failure (test)')
      return real.editFeature(req)
    },
  }
}

/** WO UI-14A-R3 (audit finding 3): the WORST exception -- the commit validation
 *  throws AND the base restore that the exception policy runs throws too (a
 *  dead kernel, a disposed handle). Nothing on the failure path can repaint or
 *  reason about geometry, so the ONLY thing standing between the user and a
 *  permanently inert gizmo is the policy's own explicit idle transition:
 *  restorePushPullBase never reaches its `setPushPullMode({kind:'none'})`, and
 *  the `finally` has already retired this gesture's token, so a mounted gizmo
 *  would refuse its own Escape. Binds mutation MT6, which the single-failure
 *  test above cannot (there, the restore's own idle transition masks it). */
function createDoublyFailingCommitClient(): { client: GeomClient; armRestoreFailure: (handle: BodyHandle) => void } {
  const real = createLocalGeomService()
  let failingHandle: BodyHandle | null = null
  let armed = false
  return {
    client: {
      ...real,
      editFeature: async (req: FaceEditRequest) => {
        if (req.featureId === 'pushpull-commit-check') {
          armed = true
          throw new Error('forced kernel failure (test)')
        }
        return real.editFeature(req)
      },
      tessellate: async (h: BodyHandle, q) => {
        if (armed && failingHandle !== null && h === failingHandle) throw new Error('forced restore tessellate failure (test)')
        return real.tessellate(h, q)
      },
    },
    armRestoreFailure: (handle: BodyHandle) => {
      failingHandle = handle
    },
  }
}

/** UI-14A-R3 audit major (Architect-applied fix): an Escape-cancel whose BASE
 *  repaint throws must still dispose the gesture's stolen preview handle.
 *  Tracks the preview via the same featureId seam createPaintGatedClient uses,
 *  arms a tessellate throw for ONE handle (the committed base), and spies
 *  dispose. */
function createCancelRestoreFailingClient(): {
  client: GeomClient
  armRestoreFailure: (handle: BodyHandle) => void
  previewBody: () => BodyHandle | null
  disposeCallsOfPreview: () => number
} {
  const real = createLocalGeomService()
  let previewBody: BodyHandle | null = null
  let previewDisposeCount = 0
  let failingHandle: BodyHandle | null = null
  return {
    client: {
      ...real,
      editFeature: async (req: FaceEditRequest) => {
        const r = await real.editFeature(req)
        if (req.featureId === 'pushpull-preview' && previewBody === null && r.ok && r.body !== undefined) {
          previewBody = r.body
        }
        return r
      },
      tessellate: async (h: BodyHandle, q) => {
        if (failingHandle !== null && h === failingHandle) throw new Error('forced cancel-restore tessellate failure (test)')
        return real.tessellate(h, q)
      },
      dispose: async (h: BodyHandle) => {
        if (previewBody !== null && h === previewBody) previewDisposeCount++
        return real.dispose(h)
      },
    },
    armRestoreFailure: (handle: BodyHandle) => {
      failingHandle = handle
    },
    previewBody: () => previewBody,
    disposeCallsOfPreview: () => previewDisposeCount,
  }
}

/** WO UI-14A-R3: the ARM tail -- classifyFace held open so a cancel can land
 *  inside a pick's own await. */
function createGatedClassifyClient(): { client: GeomClient; entered: () => Promise<void>; release: () => void } {
  const real = createLocalGeomService()
  let markEntered: (() => void) | null = null
  const enteredPromise = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  let releaseGate: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  return {
    client: {
      ...real,
      classifyFace: async (handle: BodyHandle, faceId: string) => {
        markEntered?.()
        await gate
        return real.classifyFace(handle, faceId)
      },
    },
    entered: () => enteredPromise,
    release: () => releaseGate?.(),
  }
}

describe('SolidsWorkbenchPage push/pull cleanup-tail lifecycle (WO UI-14A-R3)', () => {
  it('an onChange queued ahead of React cleanup after a SUCCESSFUL commit never ingests stale preview geometry over the committed fullResync (UI-14A-R2 audit blocker)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createCleanupTailClient()
      await renderBoxArmPick(() => gated.client, h)
      const baseHandle = hooks().getBodyHandle('F1')!
      gated.gateBaseDisposeOf(baseHandle)

      // --- The gesture: drag +3, let its preview paint normally (z=15). ---
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
      expect(gated.previewCalls()).toBe(1)

      // --- Release the pointer: onCommit(+3). The validation is parked. ---
      h.adapter()!.simulateDragEnd()
      await gated.commitCheckEntered()

      // --- Let the commit finish. Its final synchronous step lands the
      // command, schedules the idle render, launches fullResync and runs the
      // `finally`. fullResync then parks on dispose(baseHandle). ---
      gated.releaseCommitCheck()
      await gated.baseDisposeEntered()

      // ============ WE ARE NOW IN THE CLEANUP TAIL ============
      // Lock free, token retired, idle render NOT yet committed. Fail-closed:
      // if React already unmounted the gizmo, the interleave below would be
      // vacuous (its listeners gone), so assert the window is genuinely open.
      expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy()
      const staleAdapter = h.adapter()!

      // The auditor's construction: old-adapter onChange callbacks queued in
      // promise microtasks, ahead of React's cleanup. delta +2 -> a body whose
      // top is z=14, against the still-undisposed pre-gesture baseHandle. The
      // second call exercises the throttle's pendingDelta path as well.
      await Promise.resolve().then(() => staleAdapter.simulateDrag({ x: 30, y: 10, z: 14 }))
      await Promise.resolve().then(() => staleAdapter.simulateDrag({ x: 30, y: 10, z: 14 }))
      await flush() // a stale preview (if one started) resolves; its PAINT parks at gate 3

      // --- Let fullResync run to completion: committed cache Z=15, page idle.
      // WO UI-80: the committed (+3) body of record is the new node F2. ---
      gated.releaseBaseDispose()
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
      const committedHash = hooks().getBodyGeometryHash('F2')!
      await flush()

      // --- Release the stale paint LAST. ---
      gated.releaseStalePreviewPaint()
      await flush()

      // Fails-if: runPushPullPreview's `mounted.gesture !== active` token check
      // is removed (mutation MT1), or the token is not retired in
      // handlePushPullCommit's finally (mutation MT4) -- the queued onChange
      // then starts a preview with the post-bump generation, nothing bumps
      // again, paintPreviewBodyGuarded accepts it, and its cache.ingest lands
      // after the committed fullResync. getBodyTopPoint reads the GeometryCache
      // -- precisely where the auditor observed Z=14 instead of Z=15.
      expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1)
      expect(hooks().getBodyGeometryHash('F2')).toBe(committedHash)
      expect(gated.stalePreviewCreated()).toBe(false) // no tail gesture ever started
      expect(gated.previewCalls()).toBe(1) // refused BEFORE any kernel call
      expect(hooks().dag.getNode('F2')?.payload.opType).toBe('pushPull') // the commit minted its node
      await flush()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('an onCommit and an Escape queued ahead of React cleanup after a SUCCESSFUL commit are both refused -- no second command, no restore over the committed body (UI-14A-R2 audit blocker, tail paths b and c)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createCleanupTailClient()
      await renderBoxArmPick(() => gated.client, h)
      const baseHandle = hooks().getBodyHandle('F1')!
      gated.gateBaseDisposeOf(baseHandle)
      const baseDepth = historyDepth(hooks())

      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })

      h.adapter()!.simulateDragEnd()
      await gated.commitCheckEntered()
      gated.releaseCommitCheck()
      await gated.baseDisposeEntered()

      // ============ THE CLEANUP TAIL ============
      expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeTruthy() // fail-closed
      const staleAdapter = h.adapter()!

      // (b) a 'dragging-changed'(false) queued ahead of cleanup -> the mounted
      // render's onCommit closure -> handlePushPullCommit for a dead gesture.
      // The proxy still sits at z=15, so this would re-validate and re-execute
      // the SAME +3 edit, minting a SECOND pushPull node and firing a second
      // fullResync. The lock cannot refuse it: in the tail the lock is free.
      await Promise.resolve().then(() => staleAdapter.simulateDragEnd())

      // (c) an Escape reaching the OLD render's keydown effect, whose cleanup
      // also has not run. Fired before any macrotask, so the listener is still
      // installed (fireEvent dispatches inside act() before flushing).
      fireEvent.keyDown(window, { key: 'Escape' })
      await flush()

      // Fails-if (MT2): handlePushPullCommit's token check removed -- a second
      // 'pushpull-commit-check' runs and a second createFeatureCommand lands,
      // minting a second pushPull node (F3) on top of the committed F2.
      expect(gated.commitCheckCalls()).toBe(1)
      // Fails-if (MT3): handlePushPullCancel's token check removed -- the stale
      // cancel calls restorePushPullBase(mode, ...) -> paintFeatureBody with
      // the PRE-GESTURE baseHandle, re-tessellating (and ingesting) the z=12
      // body over the commit. Asserting the ATTEMPT is stronger than asserting
      // the resulting Z, which here would depend on racing fullResync.
      expect(gated.staleBaseRepaintAttempted()).toBe(false)

      gated.releaseBaseDispose()
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      // WO UI-80: the committed (+3) body of record is the new node F2.
      await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
      gated.releaseStalePreviewPaint()
      await flush()

      expect(gated.commitCheckCalls()).toBe(1)
      expect(gated.staleBaseRepaintAttempted()).toBe(false)
      expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1)
      expect(hooks().dag.getNode('F2')?.payload.opType).toBe('pushPull') // exactly ONE pushPull node
      expect(historyDepth(hooks())).toBe(baseDepth + 1) // exactly ONE undoable edit
      await flush()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('a commit validation that THROWS restores the pre-gesture body, drops to idle, and leaves push/pull usable -- the any->idle exception transition (UI-14A-R2 audit finding 3)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const client = createThrowingCommitCheckClient()
      await renderBoxArmPick(() => client, h)
      const baseHandle = hooks().getBodyHandle('F1')!
      const baseHash = hooks().getBodyGeometryHash('F1')!
      const baseDepth = historyDepth(hooks())

      // Drag +3 so the PREVIEW geometry (z=15) is what is on screen when the
      // validation throws -- if the exception path merely dropped to idle
      // without restoring, that preview would be stranded there forever.
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })

      h.adapter()!.simulateDragEnd() // onCommit -> editFeature rejects

      // Fails-if: the catch is removed -- the mode stays 'mounted' (the gizmo
      // never unmounts) while the finally retires this gesture's token, so
      // every seam including Escape refuses: a visibly wedged gizmo.
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      // Base restored (deterministic re-tessellation -> identical buffers),
      // nothing committed, no unhandled rejection out of the void-called seam.
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })
      expect(hooks().getBodyGeometryHash('F1')).toBe(baseHash)
      expect(hooks().getBodyHandle('F1')).toBe(baseHandle)
      expect(historyDepth(hooks())).toBe(baseDepth)
      expect(hooks().dag.getNode('F2')).toBeUndefined() // the throwing commit minted no node
      await flush()
      expect(rejections).toEqual([])

      // The lock was released and the token retired: push/pull is not wedged.
      // Re-arming surfaces WHY the gesture died (the reason outlives the idle
      // transition rather than being silently dropped), and a fresh pick mints
      // a fresh live token and mounts a new gizmo.
      const priorAdapterCalls = h.adapterFactoryCalls()
      fireEvent.click(screen.getByTestId('workbench-push-pull'))
      await waitFor(() => {
        const hint = screen.getByTestId('solids-workbench-pushpull-hint').textContent ?? ''
        expect(hint).toMatch(/could not finish/i)
      }, { timeout: 20_000 })
      fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('a commit validation that throws AND a base restore that also throws still ends the gesture -- no wedged gizmo (UI-14A-R2 audit finding 3)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createDoublyFailingCommitClient()
      await renderBoxArmPick(() => gated.client, h)
      const baseHandle = hooks().getBodyHandle('F1')!
      const baseDepth = historyDepth(hooks())
      gated.armRestoreFailure(baseHandle)

      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })

      h.adapter()!.simulateDragEnd() // commit validation rejects; the restore rejects too

      // Fails-if (MT6): the catch's own `setPushPullMode({kind:'none'})` is
      // removed -- restorePushPullBase never reaches its own idle transition
      // (its paint threw), so the mode stays 'mounted'. The gizmo would remain
      // on screen with its token already retired by the finally: every seam,
      // Escape included, silently refuses. A wedged gizmo, strictly worse than
      // the wedged lock the R2 finally was introduced to prevent.
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      expect(hooks().getBodyHandle('F1')).toBe(baseHandle) // nothing committed
      expect(historyDepth(hooks())).toBe(baseDepth)
      expect(hooks().dag.getNode('F2')).toBeUndefined() // nothing committed -> no pushPull node
      await flush()
      expect(rejections).toEqual([]) // both failures swallowed, never a void-call rejection

      // Not wedged: the lock is free, the token is retired, and a fresh pick
      // mints a new live token and mounts a new gizmo. (The mesh still shows the
      // dead gesture's preview -- the restore genuinely failed -- and the reason
      // is on screen rather than silently dropped.)
      const priorAdapterCalls = h.adapterFactoryCalls()
      fireEvent.click(screen.getByTestId('workbench-push-pull'))
      await waitFor(() => {
        const hint = screen.getByTestId('solids-workbench-pushpull-hint').textContent ?? ''
        expect(hint).toMatch(/could not finish/i)
      }, { timeout: 20_000 })
      fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
      await waitFor(() => expect(h.adapterFactoryCalls()).toBeGreaterThan(priorAdapterCalls), { timeout: 20_000 })
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('an Escape-cancel whose base repaint throws still disposes the stolen preview handle -- no kernel body leak (UI-14A-R3 audit major)', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const h = pushPullHarness()
      const gated = createCancelRestoreFailingClient()
      await renderBoxArmPick(() => gated.client, h)
      const baseHandle = hooks().getBodyHandle('F1')!

      // Publish one +3 preview so the gesture OWNS a stolen preview handle.
      h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
      await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
      expect(gated.previewBody()).not.toBeNull()
      expect(gated.disposeCallsOfPreview()).toBe(0)

      // The restore's base repaint will throw; Escape is the live cancel.
      gated.armRestoreFailure(baseHandle)
      fireEvent.keyDown(window, { key: 'Escape' })

      // The gesture still ends (catch -> idle; finally -> lock/token handoff)...
      await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })
      // ...and the preview handle is disposed DESPITE the repaint throw.
      // Fails-if: restorePushPullBase's dispose is sequenced after the paint
      // without a finally -- the throw skips it, the only reference to the
      // native body is dropped, and this spy stays at 0 (the audit's exact
      // reproduction: 'dispose calls were []; expected the calls to include 2').
      await waitFor(() => expect(gated.disposeCallsOfPreview()).toBe(1), { timeout: 20_000 })
      await flush()
      expect(gated.disposeCallsOfPreview()).toBe(1) // exactly once, never double
      expect(rejections).toEqual([]) // the void-called seam swallows both failures
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  }, 90_000)

  it('a pick whose classifyFace resolves AFTER the tool was dismissed mounts no gizmo -- the ARM tail (WO UI-14A-R3)', async () => {
    const h = pushPullHarness()
    const gated = createGatedClassifyClient()
    render(
      <SolidsWorkbenchPage
        createClient={() => gated.client}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await gated.entered() // the pick is parked inside classifyFace

    // The user dismisses the tool while the pick is still in flight. Cancel from
    // 'arm' takes no restore path, but it DOES bump the generation through
    // beginPushPullGestureEnd -- which is the token this pick captured.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })

    gated.release()
    await flush()

    // Fails-if (MT5): handlePushPullPick's post-await generation re-check is
    // removed -- the superseded continuation mints a LIVE token and mounts a
    // gizmo over a tool the user already dismissed.
    expect(h.adapterFactoryCalls()).toBe(0)
    expect(h.adapter()).toBeNull()
    expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull()
  }, 60_000)
})

// WO UI-15 (B1 acceptance #1 + #3): hover feedback on the push-pull face pick, and the UI-4
// non-regression clause -- arming push-pull must not fire measure hover.
describe('SolidsWorkbenchPage push/pull hover feedback (WO UI-15 B1)', () => {
  it('hover: pointermove while armed paints the hovered face + shows a detail readout; leaving the mode clears both (WO UI-15 B1)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    // Arm push-pull -- no pick yet, so no readout and the raw canvas cursor is 'default'
    // (asserted via the readout's absence; jsdom does not expose computed CSS cursor reliably).
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull()

    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const readoutText = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
    expect(readoutText).toMatch(/^Face \S+ on /)
    const hoveredFaceId = readoutText.match(/^Face (\S+) on/)?.[1]
    expect(hoveredFaceId).not.toBeUndefined()
    // FAILS-IF: removing the hover-paint call (setHover inside handlePickHover) leaves this 'none'.
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('hovered')

    // Leaving the mode (Cancel) clears both the readout and the paint state -- B1.1's "leaving the
    // mode clears it".
    fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull())
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('none')
  }, 30_000)

  it('UI-4 non-regression: arming push-pull does not fire measure hover (WO UI-15 acceptance #3)', async () => {
    const h = pushPullHarness()
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={h.createSceneRuntime}
        createPushPullTestDriver={h.createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
    const restingFaceColors = new Map(
      (hooks().getBodyFaceIds('F1') ?? []).map((faceId) => [
        faceId,
        hooks().getBodyFaceColorSample('F1', faceId),
      ]),
    )

    // Activate Measure in BODY filter mode and hover the body -- measure.state.hoveredBodyId is now
    // live (its own established mechanism, unrelated to this WO). BK-114's own mutation target is the
    // BODY-TINT gate (applyBodyHighlight), which reads ONLY measure.state.hoveredBodyId -- that is set
    // ONLY by a 'body'-kind hit (useMeasureSession.handlePointerMove's own `hit.kind === 'body'`
    // guard), never by the default 'face' filter mode's face-level hit (which instead sets
    // bridge.selection's hover, a DIFFERENT highlight path this test does not exercise). Without this
    // filter switch the body-tint branch is never reached at all, and the mutation-proof below would be
    // a probe that cannot fail (charter bar 1) -- verified by actually running the mutation.
    //
    // MUST wait for hasBridgeBody('F1') before hovering -- the UI-4 bridge session syncs its OWN
    // tessellation cache asynchronously (SolidsWorkbenchHooks.hasBridgeBody's own doc comment); a pick
    // fired before that sync resolves against an EMPTY cache and silently misses (hit: null), which is
    // exactly why the ORIGINAL (pre-BK-114) version of this test never actually observed a measure hit
    // at all -- its only assertion was the panel's mere presence, not a resolved hover.
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    fireEvent.click(screen.getByTestId('workbench-measure-filter-body'))
    await waitFor(() => expect(hooks().hasBridgeBody('F1')).toBe(true), { timeout: 20_000 })
    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('measure-panel')).toBeTruthy())

    // WO UI-16 (BK-114, auditor's exact ask): spy on the bridge session's OWN `pick` method --
    // useMeasureSession.handlePointerMove's ONLY entry into a hit-test (resolvePick -> session.pick).
    // push-pull's own hover (handlePickHover) calls pickAcrossBodies DIRECTLY and never touches
    // session.pick, so this is a structural proof of exclusive routing, not an inference from state.
    // Installed AFTER the Measure hover above (which legitimately calls session.pick once) so the
    // assertion below covers ONLY the push-pull-armed pointermove.
    const pickSpy = vi.spyOn(hooks().bridgeSession!, 'pick')

    // Arm push-pull WITHOUT deactivating Measure first (activeUi4Tool stays 'measure', a stale
    // value the toolbar toggle never clears) -- then hover again. If arming push-pull's own
    // pointermove routed to measure.handlePointerMove (or if repaintUi4Overlays still painted the
    // stale measure body-hover tint over the live push-pull face hover), that would be exactly the
    // double-paint / stale-measure-hover regression this test exists to catch.
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))

    await waitFor(() => expect(screen.getByTestId('solids-workbench-hover-readout')).toBeTruthy())
    const readoutText = screen.getByTestId('solids-workbench-hover-readout').textContent ?? ''
    const hoveredFaceId = readoutText.match(/^Face (\S+) on/)?.[1]
    expect(hoveredFaceId).not.toBeUndefined()
    expect(hooks().getPickHighlightState(hoveredFaceId!)).toBe('hovered')

    // BK-114: Measure's own pointer-move dispatch never fired for the push-pull-armed hover.
    expect(pickSpy).not.toHaveBeenCalled()

    // Interaction now lives in a boundary overlay. Resting face colors stay
    // unchanged, which also proves the stale Measure body tint did not leak
    // into the push-pull-owned repaint.
    const hoveredColor = hooks().getBodyFaceColorSample('F1', hoveredFaceId!)
    expect(hoveredColor).toBeDefined()

    const otherFaceId = hooks().getBodyFaceIds('F1')?.find((id) => id !== hoveredFaceId)
    expect(otherFaceId).not.toBeUndefined()
    const otherColor = hooks().getBodyFaceColorSample('F1', otherFaceId!)
    expect(otherColor).toBeDefined()
    expect(hoveredColor).toEqual(otherColor)
    expect(hoveredColor).toEqual(restingFaceColors.get(hoveredFaceId!))
    expect(otherColor).toEqual(restingFaceColors.get(otherFaceId!))

    const hoverOverlay = hooks().getBodyInteractionSnapshot('F1')
      .find((entry) => entry.kind === 'face-boundary')
    expect(hoverOverlay).toMatchObject({
      kind: 'face-boundary',
      variant: 'hovered',
      color: INTERACTION_HOVER_ORANGE,
      depthTest: true,
      linewidth: 4,
      clippingPlaneCount: 0,
    })
    expect(hoverOverlay?.resolution?.every((value) => value >= 1)).toBe(true)

    fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-hover-readout')).toBeNull())
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    await waitFor(() => expect(hooks().getBodyInteractionSnapshot('F1')).toEqual([]))
  }, 30_000)
})

// ===========================================================================
// WO UI-80: first-class push/pull node acceptance -- edit-later geometry (CF2),
// downstream survival across an upstream edit (CF4), and delete-from-tree (CF7).
// Reuses the same real-occt harness (pushPullHarness/renderBoxArmPick) as the
// lifecycle suite above. Deterministic ids: F1 = extrude, F2 = first push/pull.
// ===========================================================================

describe('SolidsWorkbenchPage push/pull first-class node acceptance (WO UI-80)', () => {
  it('CF1/CF7: a commit adds a Push/Pull tree row; deleting it from the tree restores the prior body', async () => {
    const h = pushPullHarness()
    await renderBoxArmPick(createLocalGeomService, h)
    const originalVol = (await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')).value
    expect(originalVol).toBeCloseTo(40 * 20 * 12, 1)

    // The renderBoxArmPick prelude already armed+picked+started a drag; finish it.
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3 -> top at 15
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.opType).toBe('pushPull'), { timeout: 20_000 })

    // CF1: a real first-class tree row exists for the push/pull.
    await waitFor(() => expect(screen.getByTestId('feature-row-F2')).toBeTruthy(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')!.consumes).toContain('F1')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    const pushedVol = (await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')).value
    expect(pushedVol).toBeCloseTo(40 * 20 * 15, 1)

    // CF7: delete the node FROM THE TREE (Delete key on its row + confirm, the
    // same affordance SolidsWorkbenchPage.delete.test.tsx drives) -- the prior
    // body is restored (RemoveNodeCommand + regen), not merely undone.
    fireEvent.click(screen.getByTestId('feature-row-F2'))
    fireEvent.keyDown(screen.getByTestId('feature-row-F2'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    await waitFor(async () => {
      const handle = hooks().getBodyHandle('F1')
      if (handle === undefined) throw new Error('F1 not restored yet')
      const v = (await hooks().client.measure(handle, 'volume')).value
      expect(v).toBeCloseTo(originalVol, 1)
    }, { timeout: 20_000 })
  }, 90_000)

  it('UI-82 D1/CF2: tree Edit reuses the anchored drag UI, cancel is inert, Apply updates the same node, and one Undo restores it', async () => {
    const h = pushPullHarness()
    await renderBoxArmPick(createLocalGeomService, h)
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    const orderBeforeEdit = [...hooks().dag.featureOrder()]
    const depthBeforeEdit = historyDepth(hooks())
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }

    // The Design Tree's Edit command must mount the original in-viewport
    // arrow/card path. The retired push/pull modal is unreachable.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const cancelInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    expect(cancelInput.value).toBe('3')
    expect(screen.queryByTestId('pushpull-distance')).toBeNull()
    expect(screen.queryByTestId('dialog-shell')).toBeNull()

    // A live edit preview targets F2, but Escape restores the committed F2
    // mesh and leaves payload, order, and command history untouched.
    fireEvent.change(cancelInput, { target: { value: '4' } })
    fireEvent.keyDown(cancelInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(16, 1), { timeout: 20_000 })
    fireEvent.keyDown(cancelInput, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')?.payload.delta).toBe(3)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeEdit)
    expect(historyDepth(hooks())).toBe(depthBeforeEdit)

    // Reopen the same node. First Enter previews; the second applies one
    // EditFeaturePayloadCommand to F2 instead of inserting another feature.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const editInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    expect(editInput.value).toBe('3')
    fireEvent.change(editInput, { target: { value: '5' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(5), { timeout: 20_000 })

    await waitFor(async () => {
      const handle = hooks().getBodyHandle('F2')
      if (handle === undefined) throw new Error('F2 not regenerated yet')
      const v = (await hooks().client.measure(handle, 'volume')).value
      expect(v).toBeCloseTo(40 * 20 * 17, 1) // base 12 + 5
    }, { timeout: 20_000 })

    // Geometric parity (not a hash): the edited node's body equals a FRESH
    // push/pull of delta 5 on the same box, built via a direct editFeature.
    const editedVol = (await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')).value
    const verifyBox = (await hooks().client.makeBox('VB', { x: 40, y: 20, z: 12 })).body!
    const fresh = await hooks().client.editFeature({ featureId: 'verify', body: verifyBox, featureKey: 'VB:BOX:zMax', delta: 5, kind: 'faceOffset' })
    expect(fresh.ok).toBe(true)
    const freshVol = (await hooks().client.measure(fresh.body!, 'volume')).value
    expect(editedVol).toBeCloseTo(freshVol, 1)
    await hooks().client.dispose(fresh.body!)

    // WO UI-80-R1 MAJOR 5: volume ALONE is not body equivalence -- an equal-area
    // push on the WRONG face (e.g. the bottom face down, or an equal-area side
    // face) yields the SAME volume yet a DIFFERENT body. Pin the bounding box's
    // top point too: the correct top-face push of +5 puts the top at z=17 with
    // the box's XY footprint (center (30,10)) unchanged. A bottom/side push of
    // equal volume would leave maxZ at 12 (bottom push) or shift the XY center
    // (side push), so this second dimension refuses the volume-only false pass.
    const top = hooks().getBodyTopPoint('F2')
    expect(top).toBeDefined()
    expect(top!.x).toBeCloseTo(30, 1)
    expect(top!.y).toBeCloseTo(10, 1)
    expect(top!.z).toBeCloseTo(17, 1)

    expect(hooks().dag.featureOrder()).toEqual(orderBeforeEdit)
    expect(hooks().dag.featureOrder().filter((id) => hooks().dag.getNode(id)?.payload.opType === 'pushPull')).toEqual(['F2'])
    expect(historyDepth(hooks())).toBe(depthBeforeEdit + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(3), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    expect(historyDepth(hooks())).toBe(depthBeforeEdit)
  }, 90_000)

  it('UI-82-R5: non-leaf edit cancels, rolls back fallible staging, adopts atomically, and preserves the F2 to F3 chain through undo/redo', async () => {
    const h = pushPullHarness()
    const transactionClient = createTransactionalReplayClient()
    await renderBoxArmPick(() => transactionClient.client, h)
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // F2: +3 -> top at 15
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // Add the smallest stable body-producing descendant already exercised by
    // this real-kernel harness: a fillet F3 that consumes F2.
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    h.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/), { timeout: 20_000 })
    commitField('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F3')?.payload.opType).toBe('fillet')
    expect(hooks().dag.getNode('F3')?.consumes).toEqual(['F2'])

    const meshFor = (featureId: string): THREE.Mesh => {
      const mesh = h.runtime().addedObjects.find(
        (obj): obj is THREE.Mesh => obj instanceof THREE.Mesh && obj.userData.workbenchFeatureId === featureId,
      )
      if (mesh === undefined) throw new Error(`missing painted mesh for ${featureId}`)
      return mesh
    }

    const orderBeforeEdit = [...hooks().dag.featureOrder()]
    const depthBeforeEdit = historyDepth(hooks())
    const documentBeforeEdit = hooks().dag.serialize()
    const f2PayloadBefore = structuredClone(hooks().dag.getNode('F2')!.payload)
    const f3PayloadBefore = structuredClone(hooks().dag.getNode('F3')!.payload)
    const f2HandleBefore = hooks().getBodyHandle('F2')
    const f3HandleBefore = hooks().getBodyHandle('F3')
    const f2HashBefore = hooks().getBodyGeometryHash('F2')
    const f3HashBefore = hooks().getBodyGeometryHash('F3')
    expect(f2HashBefore).toBeDefined()
    expect(f3HashBefore).toBeDefined()
    expect(meshFor('F2').visible).toBe(false)
    expect(meshFor('F3').visible).toBe(true)
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }

    // The original card/gizmo reopen on F2 with no modal or duplicate rows.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const cancelInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    expect(cancelInput.value).toBe('3')
    expect(screen.queryByTestId('pushpull-distance')).toBeNull()
    expect(screen.queryByTestId('dialog-shell')).toBeNull()
    expect(screen.getAllByTestId('feature-row-F2')).toHaveLength(1)
    expect(screen.getAllByTestId('feature-row-F3')).toHaveLength(1)

    // A typed preview must repaint the VISIBLE terminal body F3. Repainting
    // hidden F2 alone leaves both of these assertions at the committed value.
    fireEvent.change(cancelInput, { target: { value: '4' } })
    fireEvent.keyDown(cancelInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).not.toBe(f3HashBefore), { timeout: 20_000 })
    expect(hooks().getBodyTopPoint('F3')?.z).toBeCloseTo(16, 1)
    expect(meshFor('F2').visible).toBe(false)
    expect(meshFor('F3').visible).toBe(true)

    // Preview is presentation-only: committed handles, payloads, ordering,
    // history, and the serialized document remain byte-for-byte unchanged.
    expect(hooks().getBodyHandle('F2')).toBe(f2HandleBefore)
    expect(hooks().getBodyHandle('F3')).toBe(f3HandleBefore)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(f2PayloadBefore)
    expect(hooks().dag.getNode('F3')?.payload).toEqual(f3PayloadBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeEdit)
    expect(historyDepth(hooks())).toBe(depthBeforeEdit)
    expect(hooks().dag.serialize()).toBe(documentBeforeEdit)

    // Escape restores the exact committed F2/F3 presentation and all
    // document/history state, including which member of the chain is visible.
    fireEvent.keyDown(cancelInput, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).toBe(f3HashBefore), { timeout: 20_000 })
    expect(hooks().getBodyGeometryHash('F2')).toBe(f2HashBefore)
    expect(meshFor('F2').visible).toBe(false)
    expect(meshFor('F3').visible).toBe(true)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(f2PayloadBefore)
    expect(hooks().dag.getNode('F3')?.payload).toEqual(f3PayloadBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeEdit)
    expect(historyDepth(hooks())).toBe(depthBeforeEdit)
    expect(hooks().dag.serialize()).toBe(documentBeforeEdit)

    // R5: every throw-capable display operation is staged before the live
    // adoption boundary. Force that staging to fail and require exact
    // document, history, handles, cache, BVH, mesh, and pristine identity.
    const f2PresentationBeforeFailure = hooks().getBodyPresentationIdentity('F2')
    const f3PresentationBeforeFailure = hooks().getBodyPresentationIdentity('F3')
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const failingInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    fireEvent.change(failingInput, { target: { value: '5' } })
    fireEvent.keyDown(failingInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F3')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    const boundingBoxSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'computeBoundingBox')
      .mockImplementationOnce(() => { throw new Error('forced staged presentation failure') })
    transactionClient.arm(false)
    fireEvent.keyDown(failingInput, { key: 'Enter' })
    const stagedRefusal = 'Push/Pull Apply refused: forced staged presentation failure. No changes were applied.'
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-pushpull-hint').textContent).toContain(stagedRefusal),
      { timeout: 20_000 },
    )
    boundingBoxSpy.mockRestore()
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).toBe(f3HashBefore), { timeout: 20_000 })
    expect(hooks().dag.serialize()).toBe(documentBeforeEdit)
    expect(hooks().history.size()).toBe(depthBeforeEdit)
    expect(hooks().getBodyHandle('F2')).toBe(f2HandleBefore)
    expect(hooks().getBodyHandle('F3')).toBe(f3HandleBefore)
    for (const [after, prior] of [
      [hooks().getBodyPresentationIdentity('F2'), f2PresentationBeforeFailure],
      [hooks().getBodyPresentationIdentity('F3'), f3PresentationBeforeFailure],
    ] as const) {
      expect(after.cache).toBe(prior.cache)
      expect(after.geometry).toBe(prior.geometry)
      expect(after.edgeGeometry).toBe(prior.edgeGeometry)
      expect(after.bvh).toBe(prior.bvh)
      expect(after.mesh).toBe(prior.mesh)
      expect(after.edgeLines).toBe(prior.edgeLines)
      expect(after.meshGeometry).toBe(prior.meshGeometry)
      expect(after.renderedEdgeGeometry).toBe(prior.renderedEdgeGeometry)
      expect(after.pristine).toBe(prior.pristine)
      expect(after.sceneObjects).toHaveLength(prior.sceneObjects.length)
      after.sceneObjects.forEach((object, index) => expect(object).toBe(prior.sceneObjects[index]))
    }
    expect(transactionClient.allCandidateHandlesDisposed()).toBe(true)
    transactionClient.disarm()

    // Reopen, preview +5 on visible F3, then Apply through the same card.
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const applyInput = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    expect(applyInput.value).toBe('3')
    fireEvent.change(applyInput, { target: { value: '5' } })
    fireEvent.keyDown(applyInput, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F3')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    let competingResync: ReturnType<SolidsWorkbenchHooks['fullResync']> | undefined
    let adoptionObservation: {
      delta: unknown
      f2Handle: BodyHandle | undefined
      f3Handle: BodyHandle | undefined
    } | undefined
    hooks().setPushPullAdoptionProbe(() => {
      hooks().setPushPullAdoptionProbe(null)
      adoptionObservation = {
        delta: hooks().dag.getNode('F2')?.payload.delta,
        f2Handle: hooks().getBodyHandle('F2'),
        f3Handle: hooks().getBodyHandle('F3'),
      }
      competingResync = hooks().fullResync(['F2'])
    })
    transactionClient.arm(false)
    fireEvent.keyDown(applyInput, { key: 'Enter' })

    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(5), { timeout: 20_000 })
    await waitFor(() => expect(competingResync).toBeDefined(), { timeout: 20_000 })
    await competingResync
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).not.toBe('dirty'), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F3')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    expect(hooks().dag.getNode('F3')?.payload).toEqual(f3PayloadBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeEdit)
    expect(screen.getAllByTestId('feature-row-F2')).toHaveLength(1)
    expect(screen.getAllByTestId('feature-row-F3')).toHaveLength(1)
    expect(historyDepth(hooks())).toBe(depthBeforeEdit + 1)
    expect(meshFor('F2').visible).toBe(false)
    expect(meshFor('F3').visible).toBe(true)
    expect(transactionClient.counts()).toEqual({ f2: 1, f3: 1, commitCheck: 0, serialized: 1 })
    expect(adoptionObservation).toEqual({
      delta: 3,
      f2Handle: f2HandleBefore,
      f3Handle: f3HandleBefore,
    })
    const successfulF2Hash = hooks().getBodyGeometryHash('F2')
    const successfulF3Hash = hooks().getBodyGeometryHash('F3')
    transactionClient.disarm()

    // One Undo restores the complete pre-edit chain, not only F2's payload.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(3), { timeout: 20_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).not.toBe('dirty'), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).toBe(f3HashBefore), { timeout: 20_000 })
    expect(hooks().getBodyGeometryHash('F2')).toBe(f2HashBefore)
    expect(hooks().dag.getNode('F2')?.payload).toEqual(f2PayloadBefore)
    expect(hooks().dag.getNode('F3')?.payload).toEqual(f3PayloadBefore)
    expect(hooks().dag.featureOrder()).toEqual(orderBeforeEdit)
    expect(historyDepth(hooks())).toBe(depthBeforeEdit)
    expect(meshFor('F2').visible).toBe(false)
    expect(meshFor('F3').visible).toBe(true)

    // One Redo replays the command through the ordinary awaited resync path
    // and restores the complete successful candidate result.
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(5), { timeout: 20_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).not.toBe('dirty'), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).toBe(successfulF3Hash), { timeout: 20_000 })
    expect(hooks().getBodyGeometryHash('F2')).toBe(successfulF2Hash)
    expect(historyDepth(hooks())).toBe(depthBeforeEdit + 1)
    expect(meshFor('F2').visible).toBe(false)
    expect(meshFor('F3').visible).toBe(true)
  }, 120_000)

  it('UI-82-R5: adopting a successful non-leaf edit heals F3 when no prior handle or MeshPair exists', async () => {
    const h = pushPullHarness()
    const transactionClient = createTransactionalReplayClient()
    await renderBoxArmPick(() => transactionClient.client, h)
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // Capture a kernel-valid edge ID through the normal picker, but cancel
    // before opening the preview. The selected IDs are topology-derived; a
    // made-up ID would make the eventual healing replay fail for the wrong
    // reason after the forced refusal is disarmed. Cancelling here also avoids
    // recording an F3 lineage delta that would outlive an undo in the map.
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    h.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/), { timeout: 20_000 })
    const [selectedEdgeId] = hooks().getPushPullTransactionState().pickSelected
    expect(selectedEdgeId).toBeDefined()
    fireEvent.click(screen.getByTestId('dialog-shell-cancel'))
    await waitFor(() => expect(screen.queryByTestId('fillet-workspace-palette')).toBeNull(), { timeout: 20_000 })

    // Reinsert that valid downstream node directly, then force its first live
    // replay to fail. UI-107 keeps refused Fillet previews isolated and
    // disables Apply, so this healing fixture must deliberately create the
    // failed live node it is intended to exercise. The document row survives,
    // but there is deliberately no F3 handle, cache entry, mesh pair, or tagged
    // scene object to update in place.
    transactionClient.arm(true)
    hooks().history.execute(createFeatureCommand(hooks().dag, {
      id: 'F3',
      kind: 'feature',
      consumes: ['F2'],
      payload: {
        opType: 'fillet',
        ownerId: 'F2',
        edges: [selectedEdgeId],
        radius: 2,
        name: 'Fillet F3',
      },
    }))
    await hooks().fullResync(['F3'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('failed'), { timeout: 20_000 })
    expect(hooks().dag.getNode('F3')?.payload.opType).toBe('fillet')
    expect(hooks().getBodyHandle('F3')).toBeUndefined()
    const failedPresentation = hooks().getBodyPresentationIdentity('F3')
    expect(failedPresentation.cache).toBeUndefined()
    expect(failedPresentation.mesh).toBeUndefined()
    expect(failedPresentation.edgeLines).toBeUndefined()
    expect(failedPresentation.sceneObjects).toHaveLength(0)
    expect(hooks().hasSceneMesh('F3')).toBe(false)
    transactionClient.disarm()

    h.runtime().projectToCanvasResult = { x: 200, y: 200 }
    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const input = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })

    transactionClient.arm(false)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(hooks().dag.getNode('F2')?.payload.delta).toBe(5), { timeout: 20_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('F3')).toBe('ok'), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const healed = hooks().getBodyPresentationIdentity('F3')
    expect(healed.cache).toBeDefined()
    expect(healed.mesh).toBeDefined()
    expect(healed.edgeLines).toBeDefined()
    expect(healed.meshGeometry).toBe(healed.geometry)
    expect(healed.renderedEdgeGeometry).toBe(healed.edgeGeometry)
    expect(healed.pristine).toBeDefined()
    expect(healed.sceneObjects).toHaveLength(2)
    expect(hooks().hasSceneMesh('F3')).toBe(true)
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
    expect(transactionClient.counts()).toEqual({ f2: 1, f3: 1, commitCheck: 0, serialized: 1 })
    transactionClient.disarm()
  }, 120_000)

  it('UI-82-R4: downstream F3 refusal rolls back the entire non-leaf Apply with exact diagnostics and candidate cleanup', async () => {
    const h = pushPullHarness()
    const transactionClient = createTransactionalReplayClient()
    await renderBoxArmPick(() => transactionClient.client, h)
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    h.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/), { timeout: 20_000 })
    commitField('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const meshFor = (featureId: string): THREE.Mesh => {
      const mesh = h.runtime().addedObjects.find(
        (object): object is THREE.Mesh => object instanceof THREE.Mesh && object.userData.workbenchFeatureId === featureId,
      )
      if (mesh === undefined) throw new Error(`missing painted mesh for ${featureId}`)
      return mesh
    }
    h.runtime().projectToCanvasResult = { x: 200, y: 200 }
    h.runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }

    fireEvent.contextMenu(screen.getByTestId('feature-row-F2'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    const input = await screen.findByTestId('pushpull-delta-entry-input', undefined, { timeout: 20_000 }) as HTMLInputElement

    const mapHistory = (): unknown[] =>
      (hooks().map as unknown as { deltaHistory(): unknown[] }).deltaHistory()
    const schedulerState = (): unknown => ({
      statuses: hooks().dag.nodeIds().map((id) => [id, hooks().scheduler.statusOf(id), hooks().scheduler.diagnosticsOf(id)]),
      dirty: hooks().scheduler.dirtyIds(),
      transitions: hooks().scheduler.transitions(),
    })
    const stableStepText = async (): Promise<string> => {
      const bytes = await hooks().exportStep(hooks().getPushPullTransactionState().effectiveExportIds)
      // OCCT stamps wall-clock time into FILE_NAME and increments a translator
      // product label on every export. Remove only those known metadata tokens,
      // then compare every remaining byte.
      return new TextDecoder().decode(bytes)
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, '<export-timestamp>')
        .replace(/Open CASCADE STEP translator 8\.0 \d+/g, '<export-product>')
    }
    const before = {
      document: hooks().dag.serialize(),
      order: [...hooks().dag.featureOrder()],
      rollback: hooks().dag.getRollbackMarker(),
      history: structuredClone(hooks().history.serialize()),
      historySize: hooks().history.size(),
      canUndo: hooks().history.canUndo(),
      canRedo: hooks().history.canRedo(),
      map: structuredClone(mapHistory()),
      scheduler: structuredClone(schedulerState()),
      f1Handle: hooks().getBodyHandle('F1'),
      f2Handle: hooks().getBodyHandle('F2'),
      f3Handle: hooks().getBodyHandle('F3'),
      f2Hash: hooks().getBodyGeometryHash('F2'),
      f3Hash: hooks().getBodyGeometryHash('F3'),
      f2Presentation: hooks().getBodyPresentationIdentity('F2'),
      f3Presentation: hooks().getBodyPresentationIdentity('F3'),
      f2Scene: hooks().hasSceneMesh('F2'),
      f3Scene: hooks().hasSceneMesh('F3'),
      f2Visible: meshFor('F2').visible,
      f3Visible: meshFor('F3').visible,
      bodyRows: screen.getAllByTestId(/^body-row-/).map((row) => row.getAttribute('data-testid')),
      pick: hooks().pickAt(0, 0),
      transaction: hooks().getPushPullTransactionState(),
      cam: JSON.stringify(useCamStore.getState().project),
      step: await stableStepText(),
    }

    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(hooks().getBodyTopPoint('F3')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })

    transactionClient.arm(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    const exactRefusal = "Push/Pull Apply refused by downstream feature 'F3' (Fillet F3): KERNEL_OP_FAILED: forced F3 replay refusal (UI-82-R4). No changes were applied."
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-pushpull-hint').textContent).toContain(exactRefusal),
      { timeout: 20_000 },
    )
    await waitFor(() => expect(hooks().getBodyGeometryHash('F3')).toBe(before.f3Hash), { timeout: 20_000 })

    const afterTransaction = hooks().getPushPullTransactionState()
    const afterPick = hooks().pickAt(0, 0)
    const afterStep = await stableStepText()
    expect(hooks().dag.serialize()).toBe(before.document)
    expect(hooks().dag.featureOrder()).toEqual(before.order)
    expect(hooks().dag.getRollbackMarker()).toEqual(before.rollback)
    expect(hooks().history.serialize()).toEqual(before.history)
    expect(hooks().history.size()).toBe(before.historySize)
    expect(hooks().history.canUndo()).toBe(before.canUndo)
    expect(hooks().history.canRedo()).toBe(before.canRedo)
    expect(mapHistory()).toEqual(before.map)
    expect(schedulerState()).toEqual(before.scheduler)
    expect(hooks().getBodyHandle('F1')).toBe(before.f1Handle)
    expect(hooks().getBodyHandle('F2')).toBe(before.f2Handle)
    expect(hooks().getBodyHandle('F3')).toBe(before.f3Handle)
    expect(hooks().getBodyGeometryHash('F2')).toBe(before.f2Hash)
    expect(hooks().getBodyGeometryHash('F3')).toBe(before.f3Hash)
    const afterF2Presentation = hooks().getBodyPresentationIdentity('F2')
    const afterF3Presentation = hooks().getBodyPresentationIdentity('F3')
    for (const [after, prior] of [
      [afterF2Presentation, before.f2Presentation],
      [afterF3Presentation, before.f3Presentation],
    ] as const) {
      expect(after.cache).toBe(prior.cache)
      expect(after.geometry).toBe(prior.geometry)
      expect(after.edgeGeometry).toBe(prior.edgeGeometry)
      expect(after.bvh).toBe(prior.bvh)
      expect(after.mesh).toBe(prior.mesh)
      expect(after.edgeLines).toBe(prior.edgeLines)
      expect(after.meshGeometry).toBe(prior.meshGeometry)
      expect(after.renderedEdgeGeometry).toBe(prior.renderedEdgeGeometry)
      expect(after.colorAttribute).toBe(prior.colorAttribute)
      expect(after.edgeColorAttribute).toBe(prior.edgeColorAttribute)
      expect(after.pristine).toBe(prior.pristine)
      expect(after.sceneObjects).toHaveLength(prior.sceneObjects.length)
      after.sceneObjects.forEach((object, index) => expect(object).toBe(prior.sceneObjects[index]))
    }
    expect(hooks().hasSceneMesh('F2')).toBe(before.f2Scene)
    expect(hooks().hasSceneMesh('F3')).toBe(before.f3Scene)
    expect(meshFor('F2').visible).toBe(before.f2Visible)
    expect(meshFor('F3').visible).toBe(before.f3Visible)
    expect(screen.getAllByTestId(/^body-row-/).map((row) => row.getAttribute('data-testid'))).toEqual(before.bodyRows)
    expect(afterPick?.bodyId).toBe(before.pick?.bodyId)
    expect(afterPick?.id).toBe(before.pick?.id)
    expect(afterTransaction.touchedPast).toEqual(before.transaction.touchedPast)
    expect(afterTransaction.touchedFuture).toEqual(before.transaction.touchedFuture)
    expect(afterTransaction.selectedId).toBe(before.transaction.selectedId)
    expect(afterTransaction.effectiveExportIds).toEqual(before.transaction.effectiveExportIds)
    expect(afterTransaction.pickHovered).toBe(before.transaction.pickHovered)
    expect(afterTransaction.pickSelected).toEqual(before.transaction.pickSelected)
    expect(afterTransaction.dagVersion).toBe(before.transaction.dagVersion)
    expect(afterTransaction.gesture).toMatchObject({
      mode: 'arm',
      active: false,
      ending: false,
      previewHandle: null,
      inFlight: false,
      pendingDelta: null,
    })
    expect(JSON.stringify(useCamStore.getState().project)).toBe(before.cam)
    expect(afterStep).toBe(before.step)
    expect(afterStep.length).toBeGreaterThan(0)
    expect(transactionClient.counts()).toEqual({ f2: 1, f3: 1, commitCheck: 0, serialized: 1 })
    expect(transactionClient.allCandidateHandlesDisposed()).toBe(true)
    expect(screen.queryByTestId('pushpull-delta-entry')).toBeNull()
    expect(screen.getByTestId('solids-workbench-pushpull-hint').textContent).toContain(exactRefusal)
    transactionClient.disarm()
  }, 120_000)

  it('UI-82 D2: pull previews and commit keep the opposite face fixed in world space without reframing the camera', async () => {
    const h = pushPullHarness()
    await renderBoxArmPick(createLocalGeomService, h)

    const boundsOf = (featureId: string): THREE.Box3 => {
      const mesh = h.runtime().addedObjects.find(
        (obj): obj is THREE.Mesh => obj instanceof THREE.Mesh && obj.userData.workbenchFeatureId === featureId,
      )
      if (mesh === undefined) throw new Error(`missing painted mesh for ${featureId}`)
      mesh.updateMatrixWorld(true)
      return new THREE.Box3().setFromObject(mesh)
    }

    const fixedZ = boundsOf('F1').min.z
    const frameCount = h.runtime().frameBoxCalls.length

    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3 preview
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(15, 1), { timeout: 20_000 })
    expect(boundsOf('F1').min.z).toBe(fixedZ)
    expect(h.runtime().frameBoxCalls).toHaveLength(frameCount)

    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 17 }) // +5 preview
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    expect(boundsOf('F1').min.z).toBe(fixedZ)
    expect(h.runtime().frameBoxCalls).toHaveLength(frameCount)

    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyTopPoint('F2')?.z).toBeCloseTo(17, 1), { timeout: 20_000 })
    expect(boundsOf('F2').min.z).toBe(fixedZ)
    expect(h.runtime().frameBoxCalls).toHaveLength(frameCount)
  }, 90_000)

  it('CF4/AM1: after an upstream extrude edit, the push/pull tracks its face via ElementMap lineage (survives) or fails loud by name', async () => {
    const h = pushPullHarness()
    await renderBoxArmPick(createLocalGeomService, h)
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3 -> top at 15
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

    // Edit the UPSTREAM extrude (12 -> 14): F1 rebuilds, then F2 (pushPull)
    // re-regens against the RELINEAGED top face -- AM1's map.resolve heals the
    // stored single-face ref across the change.
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy(), { timeout: 20_000 })
    commitField('extrude-distance', '14')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))

    await waitFor(() => expect(hooks().scheduler.statusOf('F2')).not.toBe('dirty'), { timeout: 20_000 })
    const status = hooks().scheduler.statusOf('F2')
    if (status === 'failed' || status === 'degraded') {
      // The loud-failure branch: the diagnostic must NAME the lost face (ADR-0003),
      // never a silent no-op.
      const diags = hooks().scheduler.diagnosticsOf('F2')
      const text = JSON.stringify(diags)
      expect(text).toMatch(/lost|push\/pull target face/i)
    } else {
      // Survived via lineage: F2 regenerated a valid body offset +3 from the new
      // base top (14), i.e. top at 17.
      const v = (await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')).value
      expect(v).toBeCloseTo(40 * 20 * 17, 1)
    }
  }, 90_000)

  // WO UI-80-R2 MAJOR 3 (cures the CF4 gap the R1 audit found): the test above
  // edits only an extrude DISTANCE, which reproduces the same deterministic cap
  // stable id (via === 'exact') -- a raw-faceId implementation would pass it. The
  // audit demanded a REAL upstream TOPOLOGY change that changes/splits the target
  // face id, an explicit assertion on `map.resolve(...).via` (proving the stored
  // ref heals through LINEAGE, not a live raw id), plus a downstream fillet whose
  // survival-or-named-failure is asserted.
  //
  // Mechanism (found empirically -- see the R1 scratch probe folded away in
  // UI-80-R2.report.json): an upstream boolean channel cut that passes THROUGH the
  // owner box SPLITS its single top cap `F1:XTR:SK1:capEnd` into two fragments
  // `CUT1:CUT:...capEnd#0/#1`. The old cap id is then NOT live (map.has === false)
  // and only reachable via the lineage edge -- exactly the transition edge fillets/
  // chamfers/distance edits do NOT produce (a planar retrim keeps the cap's
  // identity, so those all resolve via 'exact'). This is the ONLY in-executor path
  // that forces via === 'lineage' for the pushPull's stored face ref.
  //
  // The upstream cut is spliced with direct DAG surgery because the app exposes no
  // "insert a feature before an existing one" gesture (a later-built cut would be
  // DOWNSTREAM of F2 and never re-lineage its ref); the split, the resolution, the
  // faceOffset and every failure below still run through the REAL integrated
  // executor (executeFeature's opType==='pushPull' branch) via fullResync.
  it('CF4/AM1 lineage transition: an upstream topology change that SPLITS the pushed cap forces the stored ref to resolve via LINEAGE (not a raw live id); the integrated executor targets that survivor and fails LOUD by name, and the downstream fillet reports a NAMED failure -- never a silent wrong-bind', async () => {
    const h = pushPullHarness()
    await renderBoxArmPick(createLocalGeomService, h)
    // Commit the pushPull F2 (+3 -> top at 15) via the real gizmo seam.
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 })
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')!.payload.opType).toBe('pushPull')

    // The pushPull stores its target as a single-face FeatureRef (AM1), NOT a raw
    // faceId in payload -- capture that stored id (the ORIGINAL cap).
    const storedRef = hooks().dag.getNode('F2')!.refs.find((r) => r.kind === 'single-face')
    expect(storedRef).toBeDefined()
    const T0 = storedRef!.id
    expect(T0).toBe('F1:XTR:SK1:capEnd')

    // BASELINE: before any topology change the stored ref resolves via 'exact'
    // (the raw id is live). This is precisely the scenario a raw-id impl passes --
    // so the assertions AFTER the split are what actually lock CF4/AM1.
    const baseline = hooks().map.resolve(T0, 'single-face')
    expect(baseline.via).toBe('exact')
    expect(hooks().map.has(T0)).toBe(true)

    // Build a DOWNSTREAM fillet F3 consuming the pushPull body F2, through the real
    // dress-up pick UI (top edge midpoint (30,0,15) of the pushed body).
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    h.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/), { timeout: 20_000 })
    commitField('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F3')!.payload.opType).toBe('fillet')
    expect(hooks().dag.getNode('F3')!.consumes).toContain('F2')

    // Splice an UPSTREAM channel cut (CUT1) between F1 and F2 that passes through
    // the box and SPLITS the top cap; rewire F2 to consume CUT1 (F3 still consumes
    // F2). Direct DAG surgery -- see the block comment above for why the app has no
    // UI gesture for a mid-chain insert.
    const dag = hooks().dag as unknown as {
      getNode: (id: string) => { refs: { kind: string; id: string }[]; payload: Record<string, unknown>; consumes: string[] } | undefined
      removeNode: (id: string) => { refs: { kind: string; id: string }[]; payload: Record<string, unknown>; consumes: string[] }
      insertNode: (n: unknown) => void
    }
    const f2snap = dag.removeNode('F2')
    dag.insertNode({
      id: 'SK2',
      kind: 'sketch',
      payload: {
        // Off-centre (not offset 20, which would split the 40-wide cap into two
        // identical 200 mm2 halves -- a genuine symmetric tie the resolver now
        // reports as ambiguous, per WO-1415). offset 25 leaves unequal fragments
        // (300 mm2 / 100 mm2) so the larger survivor still resolves cleanly.
        name: 'Sketch SK2', plane: 'xy', width: 20, height: 20, offset: 25,
        regions: [rectangleProfile({ sketchId: 'SK2', plane: 'xy', width: 20, height: 20, offset: 25 })],
      },
    })
    dag.insertNode({
      id: 'CUT1', kind: 'feature', consumes: ['SK2', 'F1'], refs: [],
      payload: { opType: 'extrude', sketchId: 'SK2', distance: 20, direction: 'up', boolMode: 'remove', targetFeatureId: 'F1', name: 'Cut CUT1' },
    })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['CUT1'], refs: f2snap.refs, payload: { ...f2snap.payload, ownerId: 'CUT1' } })
    // Re-run the whole chain through the REAL executor.
    await hooks().fullResync(['F1'])
    await waitFor(() => expect(hooks().scheduler.statusOf('F2')).not.toBe('dirty'), { timeout: 20_000 })

    // --- THE LINEAGE TRANSITION (what MAJOR 3 demanded) ---------------------
    // The upstream cut succeeded and split the cap: the ORIGINAL cap id is no
    // longer live and is reachable only through its lineage edge to the fragments.
    expect(hooks().scheduler.statusOf('CUT1')).toBe('ok')
    expect(hooks().map.has(T0)).toBe(false)
    const successors = hooks().map.successorsOf(T0)
    expect(successors.length).toBeGreaterThanOrEqual(2) // a real SPLIT, not a retrim
    for (const s of successors) expect(s).toMatch(/^CUT1:CUT:.*capEnd#\d+$/)

    // The stored ref now resolves via LINEAGE (NOT 'exact' -- the raw id is dead)
    // to a live split survivor. A raw-faceId implementation would find T0 not-live
    // and be lost; this is the assertion the R1 CF4 test lacked.
    const healed = hooks().map.resolve(T0, 'single-face')
    expect(healed.via).toBe('lineage')
    expect(healed.status).toBe('exact')
    expect(healed.boundTo.length).toBe(1)
    const survivor = healed.boundTo[0]
    expect(survivor).toMatch(/^CUT1:CUT:.*capEnd#\d+$/)
    // The pushPull node did NOT rewrite its stored ref to a raw live id -- it still
    // carries the original cap ref and heals it at resolve time (AM1).
    expect(hooks().dag.getNode('F2')!.refs.find((r) => r.kind === 'single-face')!.id).toBe(T0)

    // --- THE INTEGRATED EXECUTOR TARGETED THE LINEAGE SURVIVOR --------------
    // The push/pull re-ran through executeFeature and attempted the faceOffset on
    // the LINEAGE-resolved survivor (the cut splits the body into two closed
    // solids, so faceOffset then fails LOUD). The diagnostic's featureKey is the
    // SURVIVOR id (`CUT1:CUT:...#0`), which a raw-id executor emitting the dead
    // stored id (`F1:XTR:SK1:capEnd`) could never produce -- this is the can-fail
    // lock that ties the loud failure to the lineage resolution.
    expect(hooks().scheduler.statusOf('F2')).toBe('failed')
    const f2diagText = JSON.stringify(hooks().scheduler.diagnosticsOf('F2'))
    expect(f2diagText).toContain(survivor)          // executor used the LINEAGE survivor id
    expect(f2diagText).toMatch(/CUT1:CUT:.*capEnd#\d+/)
    expect(hooks().getBodyHandle('F2')).toBeUndefined() // loud failure -> no wrong body materialized

    // --- THE DOWNSTREAM FILLET REPORTS A NAMED FAILURE ---------------------
    // CF4's "downstream fillet ... SURVIVES ... OR fails LOUD by name": with its
    // owner F2 failed, the fillet degrades with an UPSTREAM_FAILED diagnostic that
    // NAMES the failed upstream (F2) -- surfaced, never a silent wrong-bind.
    expect(hooks().scheduler.statusOf('F3')).toMatch(/failed|degraded/)
    const f3diagText = JSON.stringify(hooks().scheduler.diagnosticsOf('F3'))
    expect(f3diagText).toContain('F2')
  }, 120_000)

  it('CF7 cascade: deleting a pushPull with a downstream fillet removes the fillet too, and the confirm NAMES it', async () => {
    const h = pushPullHarness()
    await renderBoxArmPick(createLocalGeomService, h)
    const originalVol = (await hooks().client.measure(hooks().getBodyHandle('F1')!, 'volume')).value
    h.adapter()!.simulateDrag({ x: 30, y: 10, z: 15 }) // +3 -> top at 15
    h.adapter()!.simulateDragEnd()
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')!.payload.opType).toBe('pushPull')

    // Build a DOWNSTREAM fillet (F3) that consumes the pushPull body F2, through
    // the real dress-up pick UI (the same flow SolidsWorkbenchPage.dressUp.test
    // drives): arm fillet, pick a top edge of F2, apply.
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    h.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } } // top edge midpoint (30,0,15)
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/), { timeout: 20_000 })
    commitField('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F3')!.payload.opType).toBe('fillet')
    expect(hooks().dag.getNode('F3')!.consumes).toContain('F2')

    // Delete the pushPull F2 FROM THE TREE. WO UI-80-R1 MAJOR 4 (Architect
    // ruling): cascade removal of the transitive-consumer closure IS the
    // accepted CF7 behavior -- but the confirm must SURFACE THE TRUTH by naming
    // every downstream feature that goes with it. Assert the confirm lists F3
    // (DeleteConfirmDialog, TreeContextMenu.tsx) BEFORE confirming.
    fireEvent.click(screen.getByTestId('feature-row-F2'))
    fireEvent.keyDown(screen.getByTestId('feature-row-F2'), { key: 'Delete' })
    const consumers = await screen.findByTestId('tree-delete-confirm-consumers')
    const filletLabel = featureLabelOf('F3')
    expect(consumers.textContent).toContain(filletLabel)
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))

    // OBSERVED cascade: F2 AND its downstream fillet F3 are both removed. This
    // is a can-fail lock on the current app-wide middle-delete semantic -- any
    // future change to healed/retained downstream handling trips this test.
    await waitFor(() => expect(screen.queryByTestId('feature-row-F2')).toBeNull(), { timeout: 20_000 })
    expect(hooks().dag.getNode('F2')).toBeUndefined()
    expect(hooks().dag.getNode('F3')).toBeUndefined()
    expect(screen.queryByTestId('feature-row-F3')).toBeNull()

    // The pre-push owner body is restored (RemoveNodeCommand + regen).
    await waitFor(async () => {
      const handle = hooks().getBodyHandle('F1')
      if (handle === undefined) throw new Error('F1 not restored yet')
      const v = (await hooks().client.measure(handle, 'volume')).value
      expect(v).toBeCloseTo(originalVol, 1)
    }, { timeout: 20_000 })
  }, 120_000)
})

/** The tree row label the DeleteConfirm dialog renders for a node -- the same
 *  nodeLabel(id, payload) the tree uses (payload.name when present, else id). */
function featureLabelOf(id: string): string {
  const payload = hooks().dag.getNode(id)?.payload ?? {}
  const name = (payload as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : id
}
