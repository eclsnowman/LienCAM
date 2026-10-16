// @vitest-environment jsdom
//
// WO INT-13B-R1 acceptance B3, B3b and B4 -- the three page-level claims the base
// worker IMPLEMENTED but left ungated. Each one here is can-fail against a named
// mutation of the suspend contract (coordination/evidence/INT-13B/mutation-B3*/,
// mutation-B4-suspend/); the mutation proofs are committed, not asserted here.
//
// WHY THIS FILE MOUNTS THE PAGE DIRECTLY (recon RECON-3, verified this session):
// B3/B3b/B4 cannot be driven through a full <App /> mount -- App renders
// SolidsWorkbenchPage lazily with no injection seam, so a real occt-wasm kernel and
// a real WebGL context would both be required. The page is mounted `embedded` with
// the fake kernel + fake runtime instead, and suspension is driven through the REAL
// store action (`setWorkspace`, store/index.ts:7895) that the real Part tab
// dispatches -- not by poking a prop. The page self-drives off that value
// (SolidsWorkbenchPage.tsx:3863-3869); see the base report's PC-3 for why the store
// (not the page) is the invoker and why store/index.ts stayed out of the manifest.
//
// TRAP, verified: with `embedded` set, `suspended` is TRUE on the very first render
// while the store sits at its 'cam' default -- the page would boot suspended and
// never reach a session. Every boot below therefore sets workspace='part' BEFORE
// render. That is a real property of the contract, not a test artifact.
//
// The WebGL probe is deliberately NOT stubbed here: without it WorkbenchViewCube
// renders nothing in jsdom, which keeps the real ViewCube's WebGLRenderer (which
// throws in jsdom) out of this file entirely. B0's rendering claim is the real-GPU
// capture's alone and is not touched here.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient, type FakeGeomClientOptions } from './fakeGeomClient'
import type { GeomClient } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

/** The cam store is persist()-wrapped (store/index.ts:3384) with zustand's default
 *  createJSONStorage(() => localStorage), which resolves localStorage ONCE when the
 *  store module initializes -- and this runtime's own localStorage.setItem throws.
 *  So the shim must be installed BEFORE the store module is imported, which is what
 *  vi.hoisted() is for: a beforeEach() shim is already too late and every
 *  store-writing action in this file throws "storage.setItem is not a function"
 *  (observed, not theorised). The sibling that drives this store the same way
 *  (SolidsWorkbenchPage.embeddedHostLayout.int13aR2.test.tsx:22-31) gets the same
 *  effect by installing at module scope and importing the store DYNAMICALLY; this
 *  file imports statically, so it hoists instead. */
vi.hoisted(() => {
  const m = new Map<string, string>()
  const memStorage: Storage = {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k)
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
})

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  // Both sketch stores are MODULE SINGLETONS (toolStore.ts:148, menuStore.ts:75),
  // so they leak across files without this.
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  useCamStore.getState().newProject()
  useCamStore.getState().setWorkspace('part')
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  // The store is module-level: leave the workspace axis at its default or the next
  // file inherits a Part workspace.
  useCamStore.setState({ workspace: 'cam' })
})

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function sessionOpen(): boolean {
  return screen.queryByTestId('workbench-package-sketch-toolbar') !== null
}

/** THE suspend trigger: the real store action the Part/Setup tabs dispatch. */
function suspendWorkspace(): void {
  act(() => {
    useCamStore.getState().setWorkspace('cam')
  })
}
function resumeWorkspace(): void {
  act(() => {
    useCamStore.getState().setWorkspace('part')
  })
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

/** Boot the page EMBEDDED (the co-mounted host shape the contract governs) with the
 *  workspace already on 'part', so the page boots live rather than suspended. */
async function boot(clientOpts: FakeGeomClientOptions = {}, wrapClient: (c: GeomClient) => GeomClient = (c) => c): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage embedded createClient={() => wrapClient(createFakeGeomClient(clientOpts))} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  // The fake's default camera sits at the origin, so a raycast onto a plane through
  // the origin is degenerate. Replaced BEFORE any session opens, because the host
  // captures runtime.camera when it is constructed (bootSketch, sketchEditSession).
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100)
  cam.up.set(0, 1, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect
  return runtime
}

async function openSketchOnXy(runtime: FakeSceneRuntime): Promise<void> {
  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(sessionOpen()).toBe(true))
}

/** A real body, minted through the REAL UI (sketch rectangle -> extrude) against the
 *  fake kernel. Four of the six armed flows below cannot arm without one: their
 *  toolbar buttons are `disabled` on `availableBodies.length === 0`
 *  (SolidsWorkbenchPage.tsx:6228, :6261, :6275) or on `resizeHoleAnyLiveBody`
 *  (:6292, derived from currentLiveBodyIds at :6030). Arming through the real
 *  disabled-gated button is the point -- a test that poked state directly would
 *  prove nothing about the flow the operator can actually reach. */
async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

/** THE CLOSED DOMAIN (charter rule 2, the WO's own Standing law, and the R1 audit's
 *  MINOR: "B3 proves the base-plane-pick flow disarms, but it does not cover the
 *  other armed flows cleared by disarmActiveTool ... a regression omitting push-pull,
 *  face-pick, N-pick, dress-up, or resize-hole state would leave its own hint visible
 *  and this gate would still pass").
 *
 *  The domain is NOT hand-picked. It is the page's OWN enumeration of "a pick is
 *  armed" -- the five terms of `anyPickModeArmed`, read from source this session at
 *  SolidsWorkbenchPage.tsx:6214:
 *
 *    const anyPickModeArmed = sketchMode.kind !== 'none' || pushPullMode.kind !== 'none'
 *      || dressUpPickMode.kind !== 'none' || nPickArmed || resizeHolePickMode.kind !== 'none'
 *
 *  and that same line is what disarmActiveTool's own doc comment (:3889-3901) cites as
 *  the derivation for the six setters it calls. (That comment cites the enumeration as
 *  ":6117"; the line is really at :6214. R1-F1 reported the stale number and left the
 *  comment alone on scope grounds, so this table is derived from the LINE ITSELF, read
 *  directly, never from the citation -- charter rule 10's "a cited file:line must PROVE
 *  the claim it decorates".)
 *
 *  Term 1 expands to TWO rows because sketchMode is overloaded: it carries the two
 *  ARMED pick kinds ('pick-base-plane', 'pick-face') AND the OPEN SESSION ('package').
 *  Only the armed kinds belong to this domain -- clearing 'package' would exit the
 *  sketch, which is exactly the data loss D3.2 forbids and B4 gates. That expansion is
 *  the carve-out disarmActiveTool:3903 encodes, not a choice made here.
 *
 *  Five terms -> six rows, and every row asserts. No refusals: every flow in the
 *  enumeration is reachable through the real UI in this harness. */
interface ArmedFlow {
  /** The `anyPickModeArmed` term this row binds, verbatim from :6214. */
  term: string
  name: string
  /** The visible control surface mounted conditionally on THIS flow's armed state.
   *  Its absence is the same fact as the tool being disarmed (one assertion, both
   *  halves of B3: "an armed tool disarms on suspend AND its visible control clears"). */
  surfaceTestId: string
  surfaceSite: string
  needsBody: boolean
  clientOpts?: FakeGeomClientOptions
  arm: () => void
}

const ARMED_FLOWS: ArmedFlow[] = [
  {
    term: "sketchMode.kind !== 'none'",
    name: "sketchMode 'pick-base-plane' (visual base-plane pick, SKETCH-PLANE-INWORKSPACE)",
    surfaceTestId: 'solids-workbench-plane-pick-hint',
    surfaceSite: 'SolidsWorkbenchPage.tsx:6714',
    needsBody: false,
    arm: () => {
      // WO SKETCH-PLANE-INWORKSPACE: "New sketch" arms the in-workspace plane pick directly -- no
      // chooser modal step. Assert the pick hint appeared so the row cannot pass on a no-op.
      fireEvent.click(screen.getByTestId('workbench-new-sketch'))
      expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
      expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()
    },
  },
  {
    term: "pushPullMode.kind !== 'none'",
    name: 'pushPullMode (Push/Pull)',
    surfaceTestId: 'solids-workbench-pushpull-hint',
    surfaceSite: 'SolidsWorkbenchPage.tsx:6764',
    needsBody: true,
    arm: () => {
      fireEvent.click(screen.getByTestId('workbench-push-pull'))
    },
  },
  {
    term: "dressUpPickMode.kind !== 'none'",
    name: 'Fillet preview-session command strip',
    surfaceTestId: 'fillet-workspace-palette',
    surfaceSite: 'FilletDialog.tsx:226',
    needsBody: true,
    arm: () => {
      fireEvent.click(screen.getByTestId('workbench-fillet'))
    },
  },
  {
    term: 'nPickArmed',
    name: 'nPickArmed (the "N" look-normal-to pick, UI-23)',
    surfaceTestId: 'solids-workbench-npick-hint',
    surfaceSite: 'SolidsWorkbenchPage.tsx:6757',
    needsBody: false,
    arm: () => {
      // Its real affordance is a WINDOW keydown (:4549-4566), not a button.
      fireEvent.keyDown(window, { key: 'n' })
    },
  },
  {
    term: "resizeHolePickMode.kind !== 'none'",
    name: 'resizeHolePickMode (Resize hole, UI-58)',
    surfaceTestId: 'solids-workbench-resizehole-hint',
    surfaceSite: 'SolidsWorkbenchPage.tsx:6911',
    needsBody: true,
    // Arming kicks the page's recognition fetch. The fake REJECTS recognizeFeatures by
    // default ("not used in 3D Lab tests"), which would make this row's subject an
    // unhandled rejection rather than the disarm. An empty verdict list is the honest
    // fixture: the flow arms, recognizes nothing, and the hint renders its own
    // no-eligible-holes message -- armed is armed, which is all this term claims.
    clientOpts: { recognizeFeaturesResult: [] },
    arm: () => {
      fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    },
  },
]

describe('WO INT-13B (spec 3.2 step 1 / B3): an armed tool disarms on suspend and its hint bar clears', () => {
  it.each(ARMED_FLOWS)('disarms $name and removes its hint bar when the workspace suspends', async (flow) => {
    await boot(flow.clientOpts)
    if (flow.needsBody) await buildBox()

    flow.arm()

    // Precondition (charter rule 1 -- the probe must be able to fire at all): the visible
    // control surface is UP. Without this the row would pass vacuously against a button click that
    // silently did nothing (e.g. a `disabled` toolbar button, which is exactly what
    // every needsBody flow renders on a virgin document).
    expect(screen.getByTestId(flow.surfaceTestId)).toBeTruthy()

    suspendWorkspace()

    // Spec 3.2 step 1, for THIS term of the enumeration. The visible surface is mounted
    // conditionally on the armed state (flow.surfaceSite), so its ABSENCE from the DOM is
    // the same fact as the tool being disarmed -- one assertion, two halves of the
    // criterion.
    expect(screen.queryByTestId(flow.surfaceTestId)).toBeNull()

    // ...and resume does not resurrect it. An armed tool is a promise about what the
    // NEXT click means; that promise cannot survive a workspace switch.
    resumeWorkspace()
    expect(screen.queryByTestId(flow.surfaceTestId)).toBeNull()
  }, 60_000)

  /** The SIXTH setter. disarmActiveTool calls six setters (:3902-3909) but the
   *  enumeration at :6214 has only five terms: setPushPullRefusal(null) is the odd one
   *  out. It is not an armed-state term -- it is the push-pull hint's REFUSAL TEXT,
   *  and it renders only while pushPullMode is armed (:6767-6773), so the six rows
   *  above cannot see it and a regression dropping that line would leave every one of
   *  them green.
   *
   *  It is still a real (if small) defect: the stale refusal from the pick BEFORE the
   *  workspace switch would resurface on the operator's NEXT arm, describing a face
   *  they have long since forgotten picking. So it is bound here rather than refused
   *  by name -- there is no reason to refuse something reachable. */
  it('clears the stale push-pull refusal text, so re-arming after a round trip starts clean', async () => {
    // WO-2813 accepts cylinder/cone picks. Use the still-unsupported sphere
    // classification to retain this test's refusal-reset contract.
    const runtime = await boot({}, (c) => ({ ...c, classifyFace: async () => 'sphere' as const }))
    await buildBox()

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    runtime.rayOverride = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(canvas())

    await waitFor(() => expect(screen.getByTestId('solids-workbench-pushpull-hint').textContent).toMatch(/cannot offset a sphere face yet/i))

    suspendWorkspace()
    expect(screen.queryByTestId('solids-workbench-pushpull-hint')).toBeNull()
    resumeWorkspace()

    // Re-arm. The hint must read its GENERIC prompt -- the refusal died with the
    // workspace switch that disarmed the pick it described.
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    const hint = screen.getByTestId('solids-workbench-pushpull-hint')
    expect(hint.textContent).toMatch(/Click a planar face to push\/pull/i)
    expect(hint.textContent).not.toMatch(/cannot offset a sphere face yet/i)
  }, 60_000)
})

describe('WO INT-13B (spec 3.2 step 2 / B3b): a transient pre-commit interaction closes on suspend and does NOT reappear on resume', () => {
  it('closes the open in-workspace plane pick on suspend and leaves it closed across the round trip', async () => {
    await boot()

    // WO SKETCH-PLANE-INWORKSPACE: the transient pre-commit surface is now the in-workspace plane
    // pick (the SketchPlaneDialog chooser is removed). Its hint bar is that SURFACE -- arming it is
    // a promise about what the next viewport click means, which cannot survive a workspace switch.
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()

    suspendWorkspace()

    // Spec 3.2 step 2. A no-op implementation fails HERE (mutation-B3b): suspend disarms the pick.
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()

    resumeWorkspace()

    // The half a "stash and restore" implementation would fail: a pre-commit interaction is
    // DISCARDED by suspend, not parked. Re-arming it over a workspace the operator has since
    // re-entered is the incoherence step 2 rules out.
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
  }, 40_000)
})

describe('WO INT-13B (D3.2 + spec 6.2(1) / B4): an open sketch survives a round trip and observes NOTHING while suspended', () => {
  it('keeps the session open across cam->part and repaints ZERO times across the suspended interval', async () => {
    const runtime = await boot()
    await openSketchOnXy(runtime)

    // The repaint seam. refreshToolOverlay() is what the tool-overlay subscription
    // CALLS when it fires (sketcher/index.ts:225), so spying it counts real repaints
    // rather than a proxy for them. The page builds a real Sketcher, so the prototype
    // spy sees the live instance.
    const repaint = vi.spyOn(Sketcher.prototype, 'refreshToolOverlay')

    // CONTROL 1 (charter rule 1 -- the probe must be able to fire at all): while the
    // workspace is LIVE, a repaint-worthy change to the SHARED module-singleton tool
    // store does reach this session's overlay.
    act(() => {
      sketcherTools.setFilletRadius(3)
    })
    expect(repaint).toHaveBeenCalledTimes(1)

    suspendWorkspace()

    // D3.2: suspend QUIESCES, it does not destroy. The session is still open.
    expect(sessionOpen()).toBe(true)
    expect(runtime.isRenderSuspended()).toBe(true)

    // THE CONSTRUCTED INTERLEAVE (charter rule 4 / the WO's Standing law: this claim
    // is settled by a built ordering, never by event-loop prose). This is RECON-2's
    // real hazard, reproduced deliberately: sketcherToolStore is a MODULE SINGLETON
    // (toolStore.ts:148) shared by every mount, so this is exactly what the OTHER
    // workspace changing its armed tool looks like to THIS suspended session.
    const repaintsAtSuspend = repaint.mock.calls.length
    const framesAtSuspend = runtime.frameCount()
    const requestsAtSuspend = runtime.requestRenderCallCount

    act(() => {
      sketcherTools.setFilletRadius(4)
      sketcherTools.setFilletRadius(5)
      sketcherTools.setFilletRadius(6)
    })

    // 6.2(1): the suspended workspace observed NOTHING. Repaint count unchanged
    // across the suspended interval -- sampled BEFORE the resume on purpose, because
    // resumeRender() legitimately issues one catch-up render (fakeSceneRuntime.ts:355)
    // and folding that into this window would make the assertion lie in one direction.
    expect(repaint.mock.calls.length).toBe(repaintsAtSuspend)
    expect(runtime.frameCount()).toBe(framesAtSuspend)
    expect(runtime.requestRenderCallCount).toBe(requestsAtSuspend)

    resumeWorkspace()

    // D3.2 again, the criterion's first half: the sketch is STILL OPEN after the full
    // cam->part round trip -- it was never exited, only quieted.
    expect(sessionOpen()).toBe(true)
    expect(runtime.isRenderSuspended()).toBe(false)

    // CONTROL 2, and the reason CONTROL 1 is not enough. Without this, "zero repaints
    // while suspended" could be satisfied by a subscription that is permanently dead,
    // or by a change the store filtered as uninteresting -- both would ship a broken
    // resume and still pass. The SAME kind of change now repaints again, which proves
    // the silence above was the unsubscription and nothing else.
    const repaintsAfterResume = repaint.mock.calls.length
    act(() => {
      sketcherTools.setFilletRadius(9)
    })
    expect(repaint.mock.calls.length).toBe(repaintsAfterResume + 1)

    repaint.mockRestore()
  }, 60_000)
})
