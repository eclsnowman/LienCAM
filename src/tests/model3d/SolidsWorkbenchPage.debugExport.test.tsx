// @vitest-environment jsdom
//
// WO UI-24 (Operator Q-17 verbatim: "I cannot save dimensions out from the workbench for you. can you
// devise a way to do this or add a small debug export link in the software now to show you
// issues?"). This is the ROUND-TRIP PROOF the WO's acceptance criterion 1 requires: build a
// nontrivial scene (2 sketches, 2 extrudes, a hole, an off-axis camera, a hidden plane) against the
// REAL occt-wasm kernel, export it through the exact function the Debug-export BUTTON calls
// (buildDebugSceneExport, via window.__solidsWorkbenchHooks -- the same hook seam every other
// probe/test in this suite already uses, see e.g. workbenchKernelVolume.test.tsx), mount a SECOND,
// FRESH page instance with that export as `initialDebugScene`, and assert feature-tree equivalence,
// SAME kernel-measured body volumes, camera pose within tolerance, and display/plane-visibility
// state equal. A second block proves the mutation side: corrupting one field of the REAL exported
// JSON makes the loader refuse BY NAME (WORKER-CHARTER item 6's mutation-proof discipline, applied
// against real exported data rather than a synthetic fixture).

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import {
  captureDebugCameraState,
  restoreDebugCameraState,
  type CreateSceneRuntime,
} from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { parseDebugSceneExport, DebugSceneFormatError, type DebugSceneExport } from '../../components/model3d/debugScene'
import { useUiPrefs } from '../../store/uiPrefs'
import type { CreatePushPullGizmoTestDriver, PushPullGizmoTestDriver } from '../../components/model3d/gizmos'
import { mintRectangleSketch } from './mintRectangleSketch'

afterEach(cleanup)

/** This vitest runtime exposes Node's EXPERIMENTAL webstorage on globalThis
 *  ("--localstorage-file was provided without a valid path"), whose setItem throws -- same shim
 *  SolidsWorkbenchPage.ui17.test.tsx's own header comment describes; workbenchHiddenGenesisIds is
 *  a GLOBAL persisted store (src/store/uiPrefs.ts's own header: "follows the user across
 *  projects/sessions"), so this test needs a real settable backend to toggle it at all. */
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  } as Storage
}

let restoreCanvas2d: (() => void) | null = null
let priorLocalStorage: PropertyDescriptor | undefined
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [], workbenchCameraProjection: 'perspective' })
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [], workbenchCameraProjection: 'perspective' })
  if (priorLocalStorage !== undefined) Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
  priorLocalStorage = undefined
})

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

/** Wait for the real Inspect-panel calculation to settle on the current body. `massBusy` is
 * deliberately export-visible live state, so a clean-scene assertion must not sample it during a
 * newly-created body's asynchronous volume/snapshot calculation. The selected body plus rendered
 * readout confirms this is the settled calculation for the expected body, rather than a stale one. */
async function waitForMassPropertiesQuiescence(bodyId: string): Promise<void> {
  await waitFor(() => {
    expect((screen.getByTestId('mass-body-select') as HTMLSelectElement).value).toBe(bodyId)
    expect(screen.queryByTestId('mass-busy')).toBeNull()
    expect(screen.getByTestId('mass-readout')).toBeTruthy()
  }, { timeout: 20_000 })
}

/** Sketch (rectangle, on XY) -> Extrude. Same proven fixture shape SolidsWorkbenchPage.hole.test.tsx's
 *  buildBox() uses, parameterized so a second call in the same document produces a distinct sketch.
 *  `sketchId` is explicitly selected in the profile dropdown (never relying on the dialog's own
 *  default-selection order) so the SECOND call in a document with an already-consumed SK1 is
 *  unambiguous. */
async function sketchAndExtrude(sketchId: string, width: string, height: string, offset: string, distance: string): Promise<void> {
  await mintRectangleSketch({ width, height, offset, id: sketchId })
  await waitFor(() => expect(screen.getByTestId(`feature-row-${sketchId}`)).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sketchId } })
  commitField('extrude-distance', distance)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
}

/** Builds the WO's own nontrivial-scene description: 2 sketches (each extruded into its own
 *  body), a hole on the first body, an off-axis camera, and one hidden base plane. Returns the
 *  captured fake runtime (camera pose lives there) and the real exported snapshot. */
async function buildNontrivialScene(): Promise<{ runtime: FakeSceneRuntime; snapshot: DebugSceneExport }> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const runtime = captured as unknown as FakeSceneRuntime

  // Sketch 1 + Extrude -> F1 (box x:[10,50] y:[0,20] z:[0,20], volume 16000mm^3).
  await sketchAndExtrude('SK1', '40', '20', '10', '20')
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

  // Hole on F1's top face -> F2 (a real second feature, hole.test.tsx's own proven pick point).
  fireEvent.click(screen.getByTestId('workbench-hole'))
  runtime.rayOverride = { origin: { x: 20, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitField('hole-diameter', '6')
  commitField('hole-blind-distance', '5')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })

  // Sketch 2 + Extrude -> F3, a second, distinct body (30x15 rect offset 60, distance 8).
  await sketchAndExtrude('SK2', '30', '15', '60', '8')
  await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })

  // Off-axis camera (not a straight-on axis view -- proves the export is not merely round-tripping
  // a default pose).
  runtime.setCameraPose({ position: { x: 123, y: -77, z: 61 }, target: { x: 5, y: 5, z: 5 } })

  // Translucent display mode (not the default), and hide the XY base plane -- both via the SAME
  // real UI a user would click.
  fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
  fireEvent.click(screen.getByTestId('workbench-shading-translucent'))
  fireEvent.click(screen.getByTestId('genesis-visible-datum:XY'))
  await waitFor(() => expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toContain('datum:XY'))

  await waitForMassPropertiesQuiescence('F3')
  const snapshot = hooks().buildDebugSceneExport()
  return { runtime, snapshot }
}

describe('WO UI-24: debug-export round-trip (real occt-wasm kernel)', () => {
  it('export -> load fresh: feature tree, kernel volumes, camera, display mode, plane visibility all match; skipped[] is honest-empty', async () => {
    const { runtime: runtimeA, snapshot } = await buildNontrivialScene()

    // The exported snapshot itself: a well-formed, self-describing JSON round-trip (JSON.stringify
    // then parseDebugSceneExport, exactly what the real download+drag-drop path does).
    const roundTripped = parseDebugSceneExport(JSON.parse(JSON.stringify(snapshot)))
    expect(roundTripped.skipped).toEqual([]) // AC #1: honest-empty on this clean test scene
    expect(roundTripped.featureOrder.length).toBeGreaterThanOrEqual(7) // 4 genesis + SK1 + F1 + F2(hole) + SK2 + F3

    const volF2Before = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    const volF3Before = await hooks().client.measure(hooks().getBodyHandle('F3')!, 'volume')

    cleanup() // unmount page A -- "load it fresh" means a SECOND, independent instance.

    let capturedB: FakeSceneRuntime | null = null
    const captureSceneRuntimeB: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedB = rt
      return rt
    }
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={captureSceneRuntimeB}
        initialDebugScene={roundTripped}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await waitFor(() => expect(screen.getByTestId('workbench-debug-scene-load-status').textContent).toMatch(/ok/i), { timeout: 30_000 })
    const runtimeB = capturedB as unknown as FakeSceneRuntime

    // Feature-tree equivalence: same node ids, in the same order.
    expect(hooks().dag.featureOrder()).toEqual(roundTripped.featureOrder)
    expect(hooks().dag.getRollbackMarker()).toEqual(roundTripped.rollbackMarker)

    // SAME body volumes, kernel-measured on the FRESH instance's own recomputed geometry.
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined(), { timeout: 20_000 })
    const volF2After = await hooks().client.measure(hooks().getBodyHandle('F2')!, 'volume')
    const volF3After = await hooks().client.measure(hooks().getBodyHandle('F3')!, 'volume')
    expect(Math.abs(volF2After.value - volF2Before.value) / volF2Before.value).toBeLessThan(1e-6)
    expect(Math.abs(volF3After.value - volF3Before.value) / volF3Before.value).toBeLessThan(1e-6)

    // Camera pose within tolerance (position/target -- up/fov/projection are invariant by
    // construction, see sceneRuntime.ts's own getDebugCameraState doc comment).
    const poseA = runtimeA.getCameraPose()
    const poseB = runtimeB.getDebugCameraState()
    expect(poseB.position.x).toBeCloseTo(poseA.position.x, 6)
    expect(poseB.position.y).toBeCloseTo(poseA.position.y, 6)
    expect(poseB.position.z).toBeCloseTo(poseA.position.z, 6)
    expect(poseB.target.x).toBeCloseTo(poseA.target.x, 6)
    expect(poseB.target.y).toBeCloseTo(poseA.target.y, 6)
    expect(poseB.target.z).toBeCloseTo(poseA.target.z, 6)

    // Display mode + plane visibility.
    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    expect((screen.getByTestId('workbench-shading-translucent') as HTMLInputElement).checked).toBe(true)
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toContain('datum:XY')
  }, 120_000)

  it('orthographic export -> parse -> fresh load preserves projection, pose, up, and every frustum field', async () => {
    const { runtime } = await buildNontrivialScene()
    const orthographicState = {
      position: { x: 123, y: -77, z: 61 },
      target: { x: 5, y: 5, z: 5 },
      up: { x: 0.2, y: 0.1, z: 1 },
      projection: 'orthographic' as const,
      left: -91,
      right: 109,
      top: 70,
      bottom: -50,
      zoom: 1.75,
      near: 0.25,
      far: 3200,
    }
    runtime.setDebugCameraState(orthographicState)
    const snapshot = hooks().buildDebugSceneExport()
    const roundTripped = parseDebugSceneExport(JSON.parse(JSON.stringify(snapshot)))
    expect(roundTripped.camera).toEqual(orthographicState)
    if (roundTripped.camera.projection !== 'orthographic') throw new Error('test setup: expected orthographic camera')

    // Drive the parsed payload through the production restore operation on a
    // real THREE camera and real OrbitControls. The page-level fake below still
    // proves React import wiring, while this closes the production restore seam.
    const realCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    realCamera.position.set(20, -20, 15)
    realCamera.up.set(0, 0, 1)
    let realControls = new OrbitControls(realCamera, document.createElement('canvas'))
    realControls.target.set(0, 0, 0)
    realControls.update()
    realControls = restoreDebugCameraState(
      realCamera,
      realControls,
      roundTripped.camera,
      (previous, target) => {
        previous.dispose()
        const rebound = new OrbitControls(realCamera, document.createElement('canvas'))
        rebound.target.copy(target)
        rebound.update()
        return rebound
      },
    )
    const productionRestored = captureDebugCameraState(realCamera, realControls.target)
    if (productionRestored.projection !== 'orthographic') throw new Error('production restore changed projection')
    expect(productionRestored.position.x).toBeCloseTo(orthographicState.position.x, 12)
    expect(productionRestored.position.y).toBeCloseTo(orthographicState.position.y, 12)
    expect(productionRestored.position.z).toBeCloseTo(orthographicState.position.z, 12)
    expect(productionRestored.target.x).toBeCloseTo(orthographicState.target.x, 12)
    expect(productionRestored.target.y).toBeCloseTo(orthographicState.target.y, 12)
    expect(productionRestored.target.z).toBeCloseTo(orthographicState.target.z, 12)
    expect(productionRestored.up.x).toBe(orthographicState.up.x)
    expect(productionRestored.up.y).toBe(orthographicState.up.y)
    expect(productionRestored.up.z).toBe(orthographicState.up.z)
    expect(productionRestored.left).toBe(orthographicState.left)
    expect(productionRestored.right).toBe(orthographicState.right)
    expect(productionRestored.top).toBe(orthographicState.top)
    expect(productionRestored.bottom).toBe(orthographicState.bottom)
    expect(productionRestored.zoom).toBe(orthographicState.zoom)
    expect(productionRestored.near).toBe(orthographicState.near)
    expect(productionRestored.far).toBe(orthographicState.far)
    realControls.dispose()

    const corrupted = JSON.parse(JSON.stringify(snapshot)) as { camera: { zoom: unknown } }
    corrupted.camera.zoom = null
    try {
      parseDebugSceneExport(corrupted)
      expect.unreachable('a null orthographic zoom must refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('camera.zoom')
    }

    cleanup()
    let capturedB: FakeSceneRuntime | null = null
    const captureSceneRuntimeB: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedB = rt
      return rt
    }
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={captureSceneRuntimeB}
        initialDebugScene={roundTripped}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('workbench-debug-scene-load-status').textContent).toMatch(/ok/i), { timeout: 30_000 })
    const restored = (capturedB as unknown as FakeSceneRuntime).getDebugCameraState()
    expect(restored).toEqual(orthographicState)
    expect((capturedB as unknown as FakeSceneRuntime).getCameraProjection()).toBe('orthographic')
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('orthographic')
  }, 120_000)

  it('mutation proof: corrupting the REAL exported snapshot refuses BY NAME (schemaVersion, camera.position)', async () => {
    const { snapshot } = await buildNontrivialScene()
    const goodJson = JSON.stringify(snapshot)

    // Mutation 1: schemaVersion bumped past what this build supports.
    const corruptedVersion = JSON.parse(goodJson) as Record<string, unknown>
    corruptedVersion.schemaVersion = 999
    try {
      parseDebugSceneExport(corruptedVersion)
      expect.unreachable('a newer schemaVersion must refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('schemaVersion')
    }

    // Mutation 2: a NaN-shaped camera field (JSON round-trip turns NaN into null -- the exact shape
    // a real serialization bug would produce; charter item 3's "NaN sails through both directions").
    const corruptedCamera = JSON.parse(goodJson) as { camera: { position: { x: unknown } } }
    corruptedCamera.camera.position.x = null
    try {
      parseDebugSceneExport(corruptedCamera)
      expect.unreachable('a null camera coordinate must refuse')
    } catch (err) {
      expect(err).toBeInstanceOf(DebugSceneFormatError)
      expect((err as DebugSceneFormatError).field).toBe('camera.position')
    }

    // Restore proof: the UNCORRUPTED original still parses clean (the corruption, not the format
    // itself, is what triggered the refusal).
    expect(() => parseDebugSceneExport(JSON.parse(goodJson))).not.toThrow()
  }, 60_000)
})

// WO UI-24-R1 (audit finding 2): skipped[] must be an EXHAUSTIVE fail-loud manifest, not just
// sketchMode/dialog -- each `it` below drives ONE additional live-only-visual state through the
// real UI (or the same hooks seam WO UI-13B's own doc comment sanctions for appearance/visibility)
// and asserts buildDebugSceneExport() actually names it, populating skipped[] for real rather than
// leaving the parent WO's own flagged gap (an always-empty array a print-only probe cannot fail on).
describe('WO UI-24-R1: skipped[] enumerates every live-only-visual state', () => {
  async function renderWithOneBody(): Promise<void> {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => createFakeSceneRuntime()} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await sketchAndExtrude('SK1', '40', '20', '10', '20')
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  }

  it('a clean scene (one body, nothing armed) reports skipped: []', async () => {
    await renderWithOneBody()
    await waitForMassPropertiesQuiescence('F1')
    expect(hooks().buildDebugSceneExport().skipped).toEqual([])
  }, 30_000)

  it('names an armed push/pull pick mode', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /armed push\/pull pick mode/i.test(s))).toBe(true)
  }, 30_000)

  it('names an armed dress-up (fillet) pick mode', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('workbench-fillet'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /fillet.*dress-up pick mode/i.test(s))).toBe(true)
  }, 30_000)

  it('names appearance (face/body color) overrides', async () => {
    await renderWithOneBody()
    hooks().appearanceStore.setBodyColor('F1', [1, 0, 0])
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /appearance color override/i.test(s))).toBe(true)
  }, 30_000)

  it('names visibility-store overrides (hidden body)', async () => {
    await renderWithOneBody()
    hooks().visibilityStore.setBodyHidden('F1', true)
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /visibility overrides/i.test(s))).toBe(true)
  }, 30_000)

  // WO UI-56: the eye-icon toggle's hidden state is no longer session-only --
  // it is the node's own PERSISTED `hidden` flag (P5 deliverable 4), so a
  // clean scene's skipped[] contract stays honest by NOT naming it while the
  // dag serialization itself proves the flag round-trips.
  it('a body hidden via the tree eye-icon toggle is dag-captured, NOT named in skipped[]', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('body-visible-F1'))
    await waitFor(() => expect((screen.getByTestId('body-visible-F1') as HTMLInputElement).checked).toBe(false))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /eye-icon toggle/i.test(s))).toBe(false)
    const parsed = JSON.parse(snapshot.dag) as { nodes: Array<{ id: string; hidden: boolean }> }
    const node = parsed.nodes.find((n) => n.id === 'F1')
    expect(node?.hidden).toBe(true)
  }, 30_000)

  it('names an active section/clip-plane view', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('section-enabled'))
    await waitFor(() => expect((screen.getByTestId('section-enabled') as HTMLInputElement).checked).toBe(true))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /section\/clip-plane/i.test(s))).toBe(true)
  }, 30_000)
})

// WO UI-24-R2 (census-derived skipped[], root-cause ruling item b): the states audit R1 finding 3
// named explicitly -- genesis/tree emphasis, UI-4 tool armed, measure/appearance hover+selection --
// each driven through the REAL UI and asserted, not merely reasoned about.
describe('WO UI-24-R2: census-derived skipped[] additions', () => {
  async function renderWithOneBody(): Promise<void> {
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => createFakeSceneRuntime()} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await sketchAndExtrude('SK1', '40', '20', '10', '20')
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
  }

  it('names a genesis-row selection (drives the real emphasis glyph)', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('feature-row-origin'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /genesis emphasis glyph/i.test(s) && /tree selection/i.test(s))).toBe(true)
  }, 30_000)

  it('names a genesis-row hover (drives the real emphasis glyph)', async () => {
    await renderWithOneBody()
    fireEvent.mouseEnter(screen.getByTestId('feature-row-origin'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /genesis emphasis glyph/i.test(s) && /row hover/i.test(s))).toBe(true)
  }, 30_000)

  it('does NOT name an ordinary (non-genesis) feature selection -- cosmetic tree-row highlight only, no 3D-scene effect', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('feature-row-F1'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /genesis emphasis glyph/i.test(s))).toBe(false)
  }, 30_000)

  it('names a BODIES-row selection because it paints the whole-body tint and topology outline', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('body-row-F1'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /selected body-row presentation/i.test(s) && /F1/i.test(s))).toBe(true)
  }, 30_000)

  it('names an armed UI-4 tool (measure)', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /UI-4 'measure' tool armed/i.test(s))).toBe(true)
  }, 30_000)

  it('names an armed UI-4 tool (appearance)', async () => {
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-appearance'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /UI-4 'appearance' tool armed/i.test(s))).toBe(true)
  }, 30_000)

  it('names a non-default Inspect-panel (mass properties) state', async () => {
    await renderWithOneBody()
    fireEvent.change(screen.getByTestId('mass-body-select'), { target: { value: 'F1' } })
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /Inspect panel state/i.test(s))).toBe(true)
  }, 30_000)

  it('a clean scene with a UI-4 tool armed but no pick yet still reports empty measure/appearance session state', async () => {
    // Guards the OTHER direction of the same gate: arming a tool alone must not report a live
    // measure/appearance SESSION (only the "tool armed" entry) until an actual pick happens.
    await renderWithOneBody()
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-measure'))
    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /live measure-tool session/i.test(s))).toBe(false)
  }, 30_000)
})

// WO UI-24-R2 (R1-audit minor, this WO's criterion 3): SolidsWorkbenchPage.tsx:3498's mounted
// push/pull preview branch had no can-fail test -- deleting that skipped[] entry left every scoped
// test green. This drives a REAL face pick into a MOUNTED push/pull gesture, produces a genuine
// nonzero preview delta via the fake TransformControlsAdapter's 'change' event (same seam
// SolidsWorkbenchPage.pushPull.test.tsx's own renderBoxArmPick uses), and asserts the export
// actually names it while the gesture is still live.
describe('WO UI-24-R2: mounted push-pull preview skipped[] branch (can-fail)', () => {
  it('names the mounted push/pull preview once a real drag produces a nonzero delta', async () => {
    let runtime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      runtime = rt
      return rt
    }
    // WO UI-57 Design 1 migration: PushPullGizmoTestDriver takes the signed
    // delta directly (no more {x,y,z} to project) -- see
    // SolidsWorkbenchPage.pushPull.test.tsx's pushPullHarness() for the full
    // migration story. This fixture's box is always picked on its top face
    // (origin z=12), so `simulateDrag({z: 15, ...})` (a +3mm pull) becomes
    // `simulateDrag(3)` below.
    let driver: PushPullGizmoTestDriver | null = null
    const createTestDriver: CreatePushPullGizmoTestDriver = () => {
      const obj = {} as PushPullGizmoTestDriver
      driver = obj
      return obj
    }
    render(
      <SolidsWorkbenchPage
        createClient={createLocalGeomService}
        createSceneRuntime={captureSceneRuntime}
        createPushPullTestDriver={createTestDriver}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '12')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    const rt = runtime as unknown as FakeSceneRuntime
    rt.rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    await waitFor(() => expect(hooks().getBodyTopPoint('F1')?.z).toBeCloseTo(12, 1), { timeout: 20_000 })

    fireEvent.click(screen.getByTestId('workbench-push-pull'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(driver).not.toBeNull(), { timeout: 20_000 })
    driver!.simulateDragStart()
    driver!.simulateDrag(3) // +3mm along the top face normal -- a real, nonzero delta
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)) // settle the preview's async editFeature/tessellate

    const snapshot = hooks().buildDebugSceneExport()
    expect(snapshot.skipped.some((s) => /active push\/pull gesture/i.test(s))).toBe(true)

    fireEvent.click(screen.getByTestId('workbench-cancel-pushpull'))
  }, 30_000)
})
