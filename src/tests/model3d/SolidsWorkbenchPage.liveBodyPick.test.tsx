// @vitest-environment jsdom
//
// WO UI-14A (C1, UI-14.report.json defects[0]): regression coverage for the
// shared stale-ancestor-body pick bug -- EVERY dress-up/push-pull/
// sketch-on-face pick candidate list now goes through liveBodyFeatureIds(dag)
// (SolidsWorkbenchPage.tsx) instead of the raw bodyFeatureIds(dag) superset,
// which used to include a superseded-but-hidden ancestor whose kernel handle
// and cached tessellation are deliberately kept alive (fast undo). Before the
// fix, a pick on geometry UNCHANGED between the ancestor and its descendant
// (e.g. a face far from a fillet/hole) could silently resolve to the STALE
// ancestor body instead of the LIVE one -- this is "draft breaks fillets"
// (UI-14 C1) generalized to all seven pick-driven feature types.
//
// Shared fixture (real occt-wasm kernel, same box every prior UI-13A/UI-5/
// SKC-5 test file already uses): sketch 40x20 offset 10 + extrude 20 -> F1,
// box x:[10,50] y:[0,20] z:[0,20]. F2 supersedes F1 via a small BLIND HOLE
// on the top face at (15,5,20) -- deliberately chosen because a hole touches
// ONLY a small local region of the top face and leaves every edge and every
// other face bit-for-bit unchanged, so every subsequent pick below (aimed
// well away from (15,5)) is a clean "unmodified geometry, which body does it
// resolve to" probe. Each test then performs ONE MORE pick-driven feature
// (of a different kind, so all seven pick types get independent coverage)
// and asserts the resulting node's ownerId (or `consumes`, for the sketch-
// on-face datum, which has no ownerId field of its own) is 'F2' -- the live
// leaf -- never 'F1', the stale, hidden ancestor.

// WO SKC-15E: adjudicated H1 (test-side). The two sketch-on-face picks below now enter THE Sketcher
// package session (the SKC-15C/S3 severing rerouted sketch-on-face through beginPackageSketch).
// Historically those sessions were seeded with four fixed boundary lines, whose constraint BADGES
// made sketchLayer.badgeMaterial paint onto a <canvas> 2D context that
// jsdom does not provide (getContext('2d') === null) -- so the mount threw
// `Cannot read properties of null (reading 'beginPath')` from SketchLayer.rebuild, the pick never
// resolved, and feature-row-datum:SK2 never appeared (pick-hint stayed up -> waitFor timed out). This
// is the IDENTICAL environment gap the green sibling SolidsWorkbenchPage.sketchOnFace.test.tsx already
// handles with the same stub; this file predates the S3 severing (it entered the old INLINE session,
// which had no badges) so it never got it. Product code is unchanged: the badge path runs in every
// real browser and is exercised on a real 2D context by tools/smoke/skc15-sketcher-evidence.mjs.
// The shared stub remains because these tests exercise sketch sessions that can still render badges.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
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

/** Captures the fake scene runtime (rayOverride) so each test can aim picks
 *  at exact analytic coordinates, same seam every dress-up/push-pull/
 *  sketch-on-face test file already uses. */
function captureRuntime(): { createSceneRuntime: CreateSceneRuntime; runtime: () => FakeSceneRuntime } {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    runtime = rt
    return rt
  }
  return { createSceneRuntime, runtime: () => runtime as unknown as FakeSceneRuntime }
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

/** F2 = a small blind hole on the top face at (15,5,20) -- supersedes F1
 *  (consumes: ['F1']) while leaving every edge and every other face of the
 *  box, plus the vast majority of the top face itself, byte-identical. */
async function buildBoxThenHole(rt: () => FakeSceneRuntime): Promise<void> {
  await buildBox()
  fireEvent.click(screen.getByTestId('workbench-hole'))
  rt().rayOverride = { origin: { x: 15, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitField('hole-diameter', '4')
  // Shallow (1mm) blind depth -- deep enough to supersede F1, shallow enough
  // that a later Shell test's 2mm wall offset never intersects the hole's
  // own blind-bottom face (a REAL kernel self-intersection unrelated to the
  // C1 pick bug this file regression-tests -- verified via a deeper hole
  // reproducing SHELL_FAILED on ANY removed face, not just a picked one).
  commitField('hole-blind-distance', '1')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
  await waitFor(() => expect(screen.queryByTestId('body-row-F1')).toBeNull())
  expect(screen.getByTestId('body-row-F2')).toBeTruthy()
}

describe('SolidsWorkbenchPage: every pick type resolves to the live leaf body, never a superseded ancestor (WO UI-14A, C1)', () => {
  it('Fillet: a post-supersede edge pick lands on F2, never F1', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-fillet'))
    // top-front edge y=0, x:[10,50] -- midpoint (30,0,20), far from the hole at (15,5).
    cap.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
    commitField('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const node = hooks().dag.getNode('F3')
    expect((node?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull())
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
  }, 60_000)

  it('Chamfer: a post-supersede edge pick lands on F2, never F1', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-chamfer'))
    // top-right edge x=50, y:[0,20] -- midpoint (50,10,20), far from the hole at (15,5).
    cap.runtime().rayOverride = { origin: { x: 50, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('chamfer-workspace-palette')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('chamfer-edge-count').textContent).toMatch(/1 edge selected/))
    commitField('chamfer-distance', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const node = hooks().dag.getNode('F3')
    expect((node?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull())
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
  }, 60_000)

  it('Shell: a post-supersede face pick lands on F2, never F1', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-shell'))
    // bottom face z=0, center (30,10,0) -- untouched by the top-face hole; ray from below.
    cap.runtime().rayOverride = { origin: { x: 30, y: 10, z: -100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('shell-workspace-palette')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('shell-face-count').textContent).toMatch(/1 face to open/))
    commitField('shell-thickness', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const node = hooks().dag.getNode('F3')
    expect((node?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull())
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
  }, 60_000)

  it('Draft: a post-supersede face pick lands on F2, never F1', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-draft'))
    // UI-91 viewport-first Draft: first choose and confirm the neutral face.
    cap.runtime().rayOverride = { origin: { x: 30, y: 10, z: -100 }, direction: { x: 0, y: 0, z: 1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('draft-neutral-face-role').textContent).toMatch(/confirm this role/i))
    fireEvent.click(screen.getByTestId('draft-confirm-neutral'))

    // Then pick the front face y=0, center (30,0,10), untouched by the
    // top-face hole. Both picks must resolve to the live F2 body.
    cap.runtime().rayOverride = { origin: { x: 30, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('draft-face-role').textContent).toMatch(/1 draft face selected/i))
    commitField('draft-angle', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const node = hooks().dag.getNode('F3')
    expect((node?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull())
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
  }, 60_000)

  it('Hole: a post-supersede face pick lands on F2, never F1', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-hole'))
    // top face, a second point (40,15,20) well clear of the first hole at (15,5).
    cap.runtime().rayOverride = { origin: { x: 40, y: 15, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
    commitField('hole-diameter', '4')
    commitField('hole-blind-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

    const node = hooks().dag.getNode('F3')
    expect((node?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull())
    expect(screen.getByTestId('body-row-F3')).toBeTruthy()
  }, 60_000)

  // WO UI-80-R4 (D1): renamed from "...edits F2s payload, never F1s" -- UI-80
  // promoted push/pull to a first-class node, so the live-leaf carrier moved
  // from owner.faceEdits to the new node's consumes/ownerId (see the assertion
  // block for the full contract-migration rationale). Same property, new carrier.
  it('Push/Pull: a post-supersede face pick creates a pushPull node consuming the live leaf F2, never the stale ancestor F1', async () => {
    const cap = captureRuntime()
    // WO UI-57 Design 1 migration: PushPullGizmoTestDriver takes the signed
    // delta directly -- see SolidsWorkbenchPage.pushPull.test.tsx's
    // pushPullHarness() for the full migration story.
    let driver: PushPullGizmoTestDriver | null = null
    let driverFactoryCalls = 0
    const createPushPullTestDriver: CreatePushPullGizmoTestDriver = () => {
      driverFactoryCalls++
      const obj = {} as PushPullGizmoTestDriver
      driver = obj
      return obj
    }
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={cap.createSceneRuntime}
        createPushPullTestDriver={createPushPullTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    // front face y=0, center (30,0,10) -- untouched by the top-face hole; horizontal ray.
    cap.runtime().rayOverride = { origin: { x: 30, y: -100, z: 10 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    // 'workbench-cancel-pushpull' renders in BOTH the 'arm' and 'mounted'
    // states -- wait for a FRESH gizmo driver instance, not just the button.
    await waitFor(() => expect(driverFactoryCalls).toBeGreaterThan(0), { timeout: 20_000 })

    driver!.simulateDragStart()
    driver!.simulateDrag(3) // +3 pull outward along the front face's -Y normal
    // WO UI-79 F-A: releasing the drag no longer commits -- the tool stays armed
    // with the live value. Completion is the shared AnchoredValueEntry's Apply
    // (the sole commit path). Drive it to land the +3 push/pull node below.
    driver!.simulateDragEnd()
    cap.runtime().projectToCanvasResult = { x: 200, y: 200 } // the anchored entry needs a projection to render
    fireEvent.click(await screen.findByTestId('pushpull-delta-entry-apply', undefined, { timeout: 20_000 }))
    await waitFor(() => expect(screen.queryByTestId('workbench-cancel-pushpull')).toBeNull(), { timeout: 20_000 })

    // WO UI-80-R4 (D1): contract migration, NOT a weakening. Before UI-80 a
    // push/pull was recorded as a `faceOffset` faceEdit sub-record written onto
    // the PICKED body's OWN payload (EditFeaturePayloadCommand(ownerId,...)), so
    // the live-leaf property read as "F2.faceEdits === 1, F1.faceEdits === 0".
    // UI-80 promoted push/pull to a FIRST-CLASS node (handlePushPullCommit ->
    // createFeatureCommand): the edit is now its own `opType:'pushPull'` DAG node
    // (here F3) that CONSUMES the picked body and supersedes it -- the picked
    // body's payload.faceEdits is deliberately never written. The property this
    // file guards is UNCHANGED (the pick must resolve to the LIVE leaf F2, never
    // the stale ancestor F1); only its carrier moved from owner.faceEdits to the
    // new node's `consumes`/`ownerId`. So we assert that carrier directly, which
    // is STRICTLY can-fail against a stale-ancestor resolution: if the push/pull
    // resolved through F1 (the UI-14 C1 bug this suite exists to catch), F3 would
    // consume/own 'F1' and every assertion below would go red.
    const f3 = hooks().dag.getNode('F3')
    expect(f3).toBeTruthy()
    // the new node is a real, live push/pull body (the drag actually took) --
    expect((f3?.payload as { opType?: string } | undefined)?.opType).toBe('pushPull')
    expect(hooks().getBodyHandle('F3')).not.toBeUndefined()
    expect((f3?.payload as { delta?: number } | undefined)?.delta).toBe(3) // the +3 pull
    // ...and it resolved to the LIVE leaf F2, never the stale ancestor F1:
    expect(f3?.consumes).toEqual(['F2'])
    expect((f3?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    expect(f3?.consumes).not.toContain('F1')
    // the retired faceEdits carrier stays empty on BOTH bodies (no dual-format
    // resurrection of the pre-UI-80 owner-payload path -- AM2's own invariant):
    const f2 = hooks().dag.getNode('F2')
    const f1 = hooks().dag.getNode('F1')
    expect(((f2?.payload as { faceEdits?: unknown[] } | undefined)?.faceEdits ?? []).length).toBe(0)
    expect(((f1?.payload as { faceEdits?: unknown[] } | undefined)?.faceEdits ?? []).length).toBe(0)
  }, 60_000)

  it('face-based New Sketch: a post-supersede face pick consumes F2, never F1', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    // top face, a point (40,15,20) well clear of the hole at (15,5).
    cap.runtime().rayOverride = { origin: { x: 40, y: 15, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })

    const datum = hooks().dag.getNode('datum:SK2')
    expect(datum?.consumes).toEqual(['F2'])
  }, 60_000)

  // WO UI-58 (Design/P4): resize-hole is the EIGHTH pick-driven case, joining the seven above --
  // absent from this suite before this WO (P4's own preflight premise). Its own candidate list
  // (handlePickHover's fourth branch AND handleResizeHolePick) goes through the SAME
  // liveBodyFeatureIds(dag, ...) this whole file regression-tests for the other seven, so a pick at
  // the hole's exact location must resolve through F2 (the live leaf), never the stale F1 ancestor.
  // Unlike the other six dress-up-style cases, a bypass here does not silently resolve to F1's
  // GEOMETRY (F1 has no hole to match at all) -- it manifests as F1's stale, still-solid top face
  // OCCLUDING F2's real hole at the exact same (x,y), so the pick misses entirely and the entry never
  // opens. That is the can-fail signal this test asserts on.
  it('Resize hole: a post-supersede pick on the hole itself resolves to F2 (opens the anchored entry, creates a resizeHole node consuming F2), never silently misses behind F1s stale solid face', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    cap.runtime().projectToCanvasResult = { x: 200, y: 200 }
    await buildBoxThenHole(cap.runtime)

    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
      { timeout: 20_000 },
    )
    // The hole itself, at (15,5) -- F1 (still-solid ancestor) would occlude it if the candidate
    // list were the raw bodyFeatureIds superset instead of the live-filtered set.
    cap.runtime().rayOverride = { origin: { x: 15, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })

    fireEvent.change(screen.getByTestId('resize-hole-anchor-entry-input'), { target: { value: '6' } })
    fireEvent.click(screen.getByTestId('resize-hole-anchor-entry-apply'))
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })

    // WO UI-71 (commit 7751968d6, "Record resize-hole as a first-class replayable
    // DAG feature"): resize-hole was promoted from an invisible payload.faceEdits
    // sub-record on the owner to its own first-class DAG node (opType 'resizeHole',
    // consuming the owner), the SAME contract push/pull moved to under WO UI-80
    // above. That commit updated SolidsWorkbenchPage.resizeHole.test.tsx to match
    // but missed this file, which still asserted the retired faceEdits-on-owner
    // shape -- so it can no longer can-fail against a stale-ancestor resolution
    // (payload.faceEdits never gets written by either F1 or F2 post-migration,
    // so the old assertion was vacuously true regardless of which body the pick
    // actually resolved through). Assert directly on the new node's consumes/
    // ownerId instead, mirroring the push/pull case above.
    const resizeId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizeId).toBeTruthy()
    const resizeNode = hooks().dag.getNode(resizeId!)
    expect(resizeNode?.consumes).toEqual(['F2'])
    expect((resizeNode?.payload as { ownerId?: string } | undefined)?.ownerId).toBe('F2')
    expect(resizeNode?.consumes).not.toContain('F1')
    // the retired faceEdits carrier stays empty on BOTH bodies (no dual-format
    // resurrection of the pre-UI-71 owner-payload path):
    const f2 = hooks().dag.getNode('F2')
    const f1 = hooks().dag.getNode('F1')
    expect(((f2?.payload as { faceEdits?: unknown[] } | undefined)?.faceEdits ?? []).length).toBe(0)
    expect(((f1?.payload as { faceEdits?: unknown[] } | undefined)?.faceEdits ?? []).length).toBe(0)
  }, 60_000)
})

// WO UI-14A-R1 (blocker, UI-14A.audit.json findings[0], verbatim scenario):
// "first creates a successful downstream body, makes its replay fail, and
// proves the failed node is hidden/unpickable while the nearest upstream
// body is the sole live pick target." Distinct from every case above --
// those all cover a LIVE superseding body correctly hiding its ancestor.
// This covers the inverse: a feature that ONCE succeeded (had a real body,
// cached mesh, visible=false on its own owner) whose LATER replay FAILS.
// disposePriorReplayHandle deletes only the failed node's OWN handle before
// the kernel op runs -- it deliberately leaves any prior cache/mesh alone --
// so pre-fix, liveBodyFeatureIds' returned set still included that bodyless
// id (hasBody was consulted only while building the superseded set, never
// applied to the final filter), leaving it visible and pick-eligible.
//
// Fillet (F2) is not independently editable via workbench-edit-feature (only
// extrude/revolve/sketch3d are), so the replay failure is driven the same
// way a real user would trigger it: editing the UPSTREAM extrude (F1) that
// F2 depends on. Shrinking F1's extrude distance from 20 to 1 forces F2's
// regen to re-run applyFillet with the SAME 2mm radius against a now-1mm-
// tall wall -- an infeasible radius, the same FILLET_RADIUS_TOO_LARGE
// failure src/tests/geom/fillet.test.ts's #7a proves at the kernel layer.
// F1 itself regenerates successfully (it is just a shorter box), so it ends
// up as the nearest LIVE upstream body once F2 goes bodyless.
describe('SolidsWorkbenchPage: a bodyless failed replay is excluded from the live set (WO UI-14A-R1 blocker)', () => {
  it('fillet succeeds, then its owner shrinks so the fillet radius no longer fits: the failed fillet is hidden/unpickable, the upstream extrude is the sole live pick target', async () => {
    const cap = captureRuntime()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={cap.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()

    // --- F2 = a valid fillet on F1's top-front edge (radius 2, fits a 20mm
    // tall wall) -- succeeds, supersedes F1 the normal way. ------------------
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    cap.runtime().rayOverride = { origin: { x: 30, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('fillet-workspace-palette')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('fillet-edge-count').textContent).toMatch(/1 edge selected/))
    commitField('fillet-radius', '2')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(screen.queryByTestId('body-row-F1')).toBeNull())
    expect((screen.getByTestId('body-visible-F2') as HTMLInputElement).checked).toBe(true)

    // --- Edit F1 (the UPSTREAM extrude): shrink 20mm -> 1mm. F1's own regen
    // succeeds; F2's dependent regen re-runs applyFillet with the SAME 2mm
    // radius against the new 1mm wall and FAILS (radius no longer fits). ----
    // UI-94 makes an ordinary click on consumed history resolve to its sole
    // live owner F2. This test deliberately edits the historical F1 producer,
    // so invoke that exact node's edit entry rather than the synchronized
    // ordinary-selection surface.
    const upstreamEdit = hooks().editEntryFor('F1')
    if (upstreamEdit === undefined || !('onEdit' in upstreamEdit)) {
      throw new Error('historical extrude F1 must expose its direct edit entry')
    }
    upstreamEdit.onEdit()
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    commitField('extrude-distance', '1')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    // This wait is the one step in the file that forces a REAL occt-wasm
    // recompute-then-throw (applyFillet re-run against the shrunk wall, radius
    // now infeasible) rather than a successful op -- load-flaky twice in full
    // censuses (2026-08-21/08-21b: last observed status stayed 'ok', i.e. the
    // wall-clock-bound regen had not even flipped off its pre-edit value by
    // the deadline), never alone or in this file's own directory-scale runs.
    // WO-136 (docs/research/MODEL3D-FLAKINESS.md) named this exact class for
    // this exact file family -- a CPU-bound kernel step outrunning its own
    // wait budget under full-suite contention, not cross-file leakage (forks
    // pool + isolate: true rules that out architecturally) -- and recommended
    // recutting the budget for the specific slow case rather than the shared
    // constant. Widened here, matching that recommendation.
    await waitFor(() => expect(hooks().scheduler.statusOf('F2')).toBe('failed'), { timeout: 45_000 })

    // THE fix under test: a bodyless failed replay must not be visible...
    // WO INT-6A-R2 (INT-6A-R1 audit major): strengthened from "hidden (checked=false)" to
    // "the COMPLETE Bodies-panel row is gone" -- refreshBodiesList now excludes any node whose
    // scheduler status is 'failed' outright, not just via the visibility flag this row used to
    // read. UI-6X tightened the normal supersede path too: a superseded body
    // is history cache, not a second Bodies-panel row (Operator B4).
    expect(hooks().getBodyHandle('F2')).toBeUndefined()
    await waitFor(() => expect(screen.queryByTestId('body-row-F2')).toBeNull())
    expect(screen.queryByTestId('body-visible-F2')).toBeNull()
    // ...and F1 (the nearest live upstream body) must become visible again,
    // never staying hidden just because SOMETHING once superseded it.
    expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(true)

    // THE decisive pick-eligibility proof (the audit's own words: "hidden/
    // unpickable while the nearest upstream body is the sole live pick
    // target"): a face pick that used to resolve through the live fillet
    // body must now resolve to F1, never to F2's stale bodyless entry --
    // never null either (a bodyless id silently blocking the ray, or a
    // dead/empty live set, would both also manifest as a failed pick).
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    cap.runtime().rayOverride = { origin: { x: 30, y: -100, z: 0.5 }, direction: { x: 0, y: 1, z: 0 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    const datum = hooks().dag.getNode('datum:SK2')
    expect(datum?.consumes).toEqual(['F1'])
  }, 90_000)
})
