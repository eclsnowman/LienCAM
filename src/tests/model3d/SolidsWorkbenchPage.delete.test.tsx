// @vitest-environment jsdom
//
// WO UI-12 (BK-73) acceptance #3, driven through the REAL SolidsWorkbenchPage
// (worker faked at the facade boundary, same idiom as
// SolidsWorkbenchPage.suppress.test.tsx): deleting a feature disposes its
// viewport body and drops it from the tree; undo restores the node AND
// replays its kernel op; a feature with a downstream consumer removes the
// whole transitive closure in ONE undo step.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import {
  LOAD_TOLERANT_TEST_TIMEOUT_MS,
  waitForLoadedModel3d as waitFor,
} from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, fakeCreateSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import { BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID, GENESIS_NODE_IDS } from '../../doc'
import { stubCanvas2d } from './stubCanvas2d'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'
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

function packageSketch(): CamSketch | undefined {
  return hooks().dag.getNode('sketch3d:SK1')?.payload.sketch as CamSketch | undefined
}

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function clickCanvas(at: { x: number; y: number }): void {
  for (const type of ['pointerdown', 'pointerup']) {
    canvas().dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      button: 0,
    }))
  }
}

function configureSketchCamera(runtime: FakeSceneRuntime): void {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.position.set(0, 0, 100)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  runtime.camera = camera

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect
}

/**
 * UI-81's authority is the live scene graph, not the page's bookkeeping.
 * Each ambient root is stamped by buildGenesisGlyph; walking parents catches
 * a present child hidden by an ancestor just as the renderer would.
 */
function ambientGenesisSceneCensus(runtime: FakeSceneRuntime): Map<string, { visible: boolean; renderOrder: number }> {
  const census = new Map<string, { visible: boolean; renderOrder: number }>()
  runtime.scene.traverse((object) => {
    if (object.userData.genesisVariant !== 'ambient') return
    const nodeId = object.userData.genesisNodeId
    if (typeof nodeId !== 'string') throw new Error('ambient genesis glyph is missing its node id')
    if (census.has(nodeId)) throw new Error(`ambient genesis glyph '${nodeId}' appears more than once in the scene`)
    let visible = true
    for (let cursor: typeof object | null = object; cursor !== null; cursor = cursor.parent) {
      if (!cursor.visible) visible = false
    }
    census.set(nodeId, { visible, renderOrder: object.renderOrder })
  })
  return census
}

function expectGenesisEyesMatchScene(runtime: FakeSceneRuntime): void {
  const census = ambientGenesisSceneCensus(runtime)
  for (const nodeId of GENESIS_NODE_IDS) {
    const treeVisible = screen.getByTestId(`genesis-visible-${nodeId}`).getAttribute('aria-pressed') === 'true'
    if (treeVisible) {
      expect(census.get(nodeId)?.visible, `${nodeId}: tree says visible but the ambient scene root is missing or hidden`).toBe(true)
    } else {
      expect(census.has(nodeId), `${nodeId}: tree says hidden but an ambient scene root remains`).toBe(false)
    }
  }
}

function expectVisibleGenesisAboveActiveSketchGrid(runtime: FakeSceneRuntime): void {
  const grid = runtime.getSketchGrid()
  expect(grid, 'an active package sketch must own a live grid').not.toBeNull()
  const census = ambientGenesisSceneCensus(runtime)
  for (const nodeId of GENESIS_NODE_IDS) {
    const treeVisible = screen.getByTestId(`genesis-visible-${nodeId}`).getAttribute('aria-pressed') === 'true'
    if (!treeVisible) continue
    expect(
      census.get(nodeId)?.renderOrder,
      `${nodeId}: a visible ambient datum must sort after its coplanar sketch grid`,
    ).toBeGreaterThan(grid!.renderOrder)
  }
}

/**
 * UI-81B: which finished-sketch outline node ids are ACTUALLY present in the live scene graph --
 * the tree/dag-side authority is `sketchLinesRef`/`hasSketchOutline`, but this WO's whole premise is
 * that the two can diverge (a ref-map entry with no scene object, or vice versa), so a repro test
 * must read the scene directly, mirroring ambientGenesisSceneCensus's own rationale.
 */
function sketchOutlineSceneCensus(runtime: FakeSceneRuntime): Set<string> {
  const ids = new Set<string>()
  runtime.scene.traverse((object) => {
    const nodeId = object.userData.workbenchSketchNodeId
    if (typeof nodeId !== 'string') return
    if (ids.has(nodeId)) throw new Error(`sketch outline '${nodeId}' appears more than once in the scene`)
    ids.add(nodeId)
  })
  return ids
}

/** Draws a real package sketch (rectangle) on the XY plane and finishes it, the same product path
 *  UI-81's own test uses -- the only path that reliably populates BOTH sketchLinesRef and the scene
 *  (a plane-bound `payload.sketch` is drawn on every fullResync, unlike the parametric-rectangle
 *  dialog's node shape). Returns the new sketch's node id. */
async function drawAndFinishPackageSketch(runtime: FakeSceneRuntime, at: { x1: number; y1: number; x2: number; y2: number }): Promise<string> {
  const before = new Set(hooks().dag.nodeIds())
  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-package-tool-rect-corner'))
  clickCanvas({ x: at.x1, y: at.y1 })
  clickCanvas({ x: at.x2, y: at.y2 })
  await waitFor(() => {
    const nodeId = [...hooks().dag.nodeIds()].find((id) => !before.has(id) && id.startsWith('sketch3d:'))
    expect(nodeId).not.toBeUndefined()
  })
  const nodeId = [...hooks().dag.nodeIds()].find((id) => !before.has(id) && id.startsWith('sketch3d:')) as string
  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
  await waitFor(() => expect(hooks().dag.getNode(nodeId)?.payload.regions).not.toBeUndefined())
  return nodeId
}

describe('UI-81B: scene stops matching the tree after back-to-back deletes + mode handoffs', () => {
  it('shape (a): two deletes fired back-to-back (no await between) leave the live scene matching the tree -- no vanished genesis datums, no stale outline from the deleted sketch, no lingering body mesh', async () => {
    const client = createFakeGeomClient()
    let capturedRuntime: FakeSceneRuntime | null = null
    const createSceneRuntime = () => {
      const runtime = createFakeSceneRuntime()
      capturedRuntime = runtime
      return runtime
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    configureSketchCamera(runtime)
    await waitFor(() => expectGenesisEyesMatchScene(runtime))

    // SK1/F1: a body Operator will delete first ("delete body").
    const sk1 = await drawAndFinishPackageSketch(runtime, { x1: 260, y1: 200, x2: 340, y2: 260 })
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sk1 } })
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    // Consumption hides SK1 by default. Re-show it through the real eye
    // control so this delete race proves an explicit user override persists.
    await waitFor(() => expect(hooks().dag.getNode(sk1)?.hidden).toBe(true))
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(false))
    fireEvent.click(screen.getByTestId(`feature-row-hide-${sk1}`))
    await waitFor(() => expect(hooks().dag.getNode(sk1)?.hidden).toBe(false))
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(true))

    // SK2: an independent finished sketch (no consumer) -- the "worktree item" Operator deletes second.
    // Its outline is drawn now and must survive F1's delete untouched.
    const sk2 = await drawAndFinishPackageSketch(runtime, { x1: 420, y1: 320, x2: 520, y2: 400 })
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk2)).toBe(true))

    // Back-to-back deletes: BOTH confirm clicks fire before either's fire-and-forget fullResync has
    // a chance to settle (handleDelete's `void fullResync([])`, SolidsWorkbenchPage.tsx:6598, is
    // unawaited) -- exactly Operator's literal "delete body, and deleting worktree items" sequence, no
    // `await` or `waitFor` between them.
    fireEvent.keyDown(screen.getByTestId('feature-row-F1'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    fireEvent.keyDown(screen.getByTestId(`feature-row-${sk2}`), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))

    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    await waitFor(() => expect(hooks().dag.has(sk2)).toBe(false))

    // Tree-visible datums must still be scene-drawn (the UI-81 invariant) ...
    await waitFor(() => expectGenesisEyesMatchScene(runtime))
    // ... the deleted sketch's outline must be GONE, not stale ...
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk2)).toBe(false))
    // ... the surviving sketch remains explicitly shown (the delete/resync
    // must not silently restore the automatic-hide presentation) ...
    expect(hooks().dag.getNode(sk1)?.hidden).toBe(false)
    expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(true)
    // ... and the deleted body's mesh must be gone from the live scene, not merely from bookkeeping.
    expect(hooks().hasSceneMesh('F1')).toBe(false)
  }, LOAD_TOLERANT_TEST_TIMEOUT_MS)

  it('shape (b): opening a NEW sketch right after a back-to-back delete pair still populates the whole ambient scene (origin/planes/grid), not an empty viewport', async () => {
    const client = createFakeGeomClient()
    let capturedRuntime: FakeSceneRuntime | null = null
    const createSceneRuntime = () => {
      const runtime = createFakeSceneRuntime()
      capturedRuntime = runtime
      return runtime
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    configureSketchCamera(runtime)
    await waitFor(() => expectGenesisEyesMatchScene(runtime))

    const sk1 = await drawAndFinishPackageSketch(runtime, { x1: 260, y1: 200, x2: 340, y2: 260 })
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sk1 } })
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    // Leave this consumed sketch in its default automatic-hidden state; the
    // re-entry below must not redraw it merely because another sketch opens.
    await waitFor(() => expect(hooks().dag.getNode(sk1)?.hidden).toBe(true))
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(false))

    const sk2 = await drawAndFinishPackageSketch(runtime, { x1: 420, y1: 320, x2: 520, y2: 400 })

    // Same back-to-back double delete as shape (a).
    fireEvent.keyDown(screen.getByTestId('feature-row-F1'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    fireEvent.keyDown(screen.getByTestId(`feature-row-${sk2}`), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    await waitFor(() => expect(hooks().dag.has(sk2)).toBe(false))

    // Operator's screenshot: SK2 (his "SK2") is a brand-new sketch opened right after such deletes, with
    // the whole ambient scene -- origin, planes, grid -- failing to draw.
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())

    // The new session must own a live grid ...
    await waitFor(() => expect(runtime.getSketchGrid()).not.toBeNull())
    // ... and every tree-visible genesis datum must still be scene-drawn, above that grid.
    await waitFor(() => expectGenesisEyesMatchScene(runtime))
    expectVisibleGenesisAboveActiveSketchGrid(runtime)
    // The surviving consumed sketch keeps its automatic-hidden presentation
    // through the delete pair and new-sketch re-entry.
    expect(hooks().dag.getNode(sk1)?.hidden).toBe(true)
    expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(false)
  })

  it('CONSTRUCTED INTERLEAVE: a slow kernel dispose (real-world async, unlike the instant fake) lets a second delete\'s fullResync run to completion WHILE the first is still in flight -- the final scene must still match the tree', async () => {
    const client = createFakeGeomClient()
    // WORKER CHARTER item 4: an async/timing claim is settled by a CONSTRUCTED interleave, not
    // event-loop prose. handleDelete's `void fullResync([])` (SolidsWorkbenchPage.tsx:6598) is
    // fire-and-forget; the fake client's dispose() normally resolves same-microtask, which is FAR
    // faster than a real kernel dispose (a real WASM/worker round-trip). This deferred dispose
    // widens that window to its adversarial extreme: the SECOND delete's entire fullResync (stale
    // sweep, redraw, regen pass, post-processing, dagVersion bump) runs and SETTLES while the
    // FIRST delete's fullResync is still parked mid-disposal -- the worst legal ordering, not a
    // guess at one.
    let releaseDispose: (() => void) | null = null
    const realDispose = client.dispose.bind(client)
    client.dispose = (h) => new Promise<void>((resolve) => {
      releaseDispose = () => { void realDispose(h).then(resolve) }
    })

    let capturedRuntime: FakeSceneRuntime | null = null
    const createSceneRuntime = () => {
      const runtime = createFakeSceneRuntime()
      capturedRuntime = runtime
      return runtime
    }
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    configureSketchCamera(runtime)
    await waitFor(() => expectGenesisEyesMatchScene(runtime))

    const sk1 = await drawAndFinishPackageSketch(runtime, { x1: 260, y1: 200, x2: 340, y2: 260 })
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sk1 } })
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    await waitFor(() => expect(hooks().dag.getNode(sk1)?.hidden).toBe(true))
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(false))

    const sk2 = await drawAndFinishPackageSketch(runtime, { x1: 420, y1: 320, x2: 520, y2: 400 })
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: sk2 } })
    commitField('extrude-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
    await waitFor(() => expect(hooks().dag.getNode(sk2)?.hidden).toBe(true))
    await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(sk2)).toBe(false))

    // Delete #1 (F1's body): its stale-body sweep calls disposeFeatureBody('F1'), which awaits the
    // now-deferred client.dispose -- fullResync #1 is parked right there until releaseDispose() fires.
    fireEvent.keyDown(screen.getByTestId('feature-row-F1'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    expect(releaseDispose, 'fullResync #1 must be parked at the deferred dispose await').not.toBeNull()

    // Delete #2 (an UNRELATED sketch, F2/SK2) fires and is given the ENTIRE window to complete --
    // its own fullResync has no stale body to await-dispose (F1's handle is already gone from
    // bodyHandlesRef by the time it synchronously reaches that loop), so it runs uninterrupted.
    fireEvent.keyDown(screen.getByTestId('feature-row-F2'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).toBeUndefined())

    // NOW release the first delete's parked dispose and let fullResync #1 run to completion LAST.
    releaseDispose!()
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())

    // The final live scene must match the tree exactly, regardless of which fullResync settled last.
    await waitFor(() => expectGenesisEyesMatchScene(runtime))
    expect(hooks().hasSceneMesh('F1')).toBe(false)
    expect(hooks().hasSceneMesh('F2')).toBe(false)
    // Both source sketches survived their consumer deletes. Their automatic
    // hidden state must survive even this adversarial async resync ordering.
    expect(hooks().dag.getNode(sk1)?.hidden).toBe(true)
    expect(hooks().dag.getNode(sk2)?.hidden).toBe(true)
    expect(sketchOutlineSceneCensus(runtime).has(sk1)).toBe(false)
    expect(sketchOutlineSceneCensus(runtime).has(sk2)).toBe(false)
  })
})

describe('SolidsWorkbenchPage feature delete (WO UI-12, BK-73)', () => {
  it('deleting a leaf feature disposes its viewport body and drops its tree row; undo restores the node and replays the kernel op', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    fireEvent.keyDown(screen.getByTestId('feature-row-F1'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))

    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(true))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
  })

  it('deleting a feature with a downstream boolean consumer removes the whole transitive closure in ONE undo step', async () => {
    const client = createFakeGeomClient()
    render(<SolidsWorkbenchPage createClient={() => client} createSceneRuntime={fakeCreateSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    await mintRectangleSketch()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '5')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())

    fireEvent.click(screen.getByTestId('workbench-boolean'))
    fireEvent.change(screen.getByTestId('boolean-target-select'), { target: { value: 'F1' } })
    fireEvent.change(screen.getByTestId('boolean-tool-select'), { target: { value: 'F2' } })
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F3')).not.toBeUndefined())

    expect(hooks().dag.transitiveConsumersOf('F1')).toEqual(['F3'])

    fireEvent.keyDown(screen.getByTestId('feature-row-F1'), { key: 'Delete' })
    expect(screen.getByTestId('tree-delete-confirm-consumers').textContent).toContain('F3')

    const sizeBefore = hooks().history.size()
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))

    await waitFor(() => expect(hooks().dag.has('F1')).toBe(false))
    expect(hooks().dag.has('F3')).toBe(false)
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()
    expect(screen.queryByTestId('feature-row-F3')).toBeNull()
    // ONE undo step for both removed features.
    expect(hooks().history.size()).toBe(sizeBefore + 1)

    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(true))
    expect(hooks().dag.has('F3')).toBe(true)
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
    expect(screen.getByTestId('feature-row-F1')).toBeTruthy()
    expect(screen.getByTestId('feature-row-F3')).toBeTruthy()
  })

  it('UI-81: StrictMode keeps visible Origin and XY after body disposal and package-sketch re-entry', async () => {
    const client = createFakeGeomClient()
    let capturedRuntime: FakeSceneRuntime | null = null
    const createSceneRuntime = () => {
      const runtime = createFakeSceneRuntime()
      capturedRuntime = runtime
      return runtime
    }
    render(
      <StrictMode>
        <SolidsWorkbenchPage createClient={() => client} createSceneRuntime={createSceneRuntime} />
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const runtime = capturedRuntime as unknown as FakeSceneRuntime
    configureSketchCamera(runtime)
    await waitFor(() => expectGenesisEyesMatchScene(runtime))

    // Match Operator's screenshot: Origin + XY visible, XZ + YZ hidden.
    fireEvent.click(screen.getByTestId(`genesis-visible-${BASE_PLANE_XZ_NODE_ID}`))
    fireEvent.click(screen.getByTestId(`genesis-visible-${BASE_PLANE_YZ_NODE_ID}`))
    await waitFor(() => expectGenesisEyesMatchScene(runtime))

    // Build a real package sketch and feature through the same product controls.
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-package-tool-rect-corner'))
    clickCanvas({ x: 320, y: 250 })
    clickCanvas({ x: 480, y: 350 })
    await waitFor(() => expect(packageSketch()?.entities.length).toBeGreaterThanOrEqual(4))
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
    await waitFor(() => expect(hooks().dag.getNode('sketch3d:SK1')?.payload.regions).not.toBeUndefined())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: 'sketch3d:SK1' } })
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())

    // Dispose only the body. The applied feature and source sketch remain in
    // the tree while the BODIES section falls to zero, matching Operator's frame.
    fireEvent.click(screen.getByTestId('body-dispose-F1'))
    await waitFor(() => expect(hooks().dag.has('F1')).toBe(true))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeUndefined())
    await waitFor(() => expectGenesisEyesMatchScene(runtime))

    // Re-enter the package sketch with F1 still applied but zero live bodies.
    fireEvent.click(screen.getByTestId('feature-row-sketch3d:SK1'))
    fireEvent.click(screen.getByTestId('workbench-edit-feature'))
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    await waitFor(() => expectGenesisEyesMatchScene(runtime))
    expectVisibleGenesisAboveActiveSketchGrid(runtime)
  })
})
