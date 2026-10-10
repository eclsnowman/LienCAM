// @vitest-environment jsdom
//
// WO UI-81B gate 2: the mode-transition matrix. Operator's reject named a THIRD axis the UI-81
// StrictMode test never drove -- the workspace switch (setup/CAM view vs the Part/model host) --
// on top of the sketch-active axis UI-81 already covers. This derives the matrix from the mode
// enum itself (MODES below), not a hand-picked list of scenarios, and asserts the WO's own
// invariant literally: "tree-visible and not hidden implies scene-drawn; tree-deleted or hidden
// implies scene-removed, at EVERY mode boundary" -- for every ordered (from, to) pair, a delete
// performed while the page is in mode `from` must leave mode `to`'s live scene matching the tree.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { GENESIS_NODE_IDS } from '../../doc'
import type { FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import { stubCanvas2d } from './stubCanvas2d'
import { bootCoMount, switchToCam, switchToPart } from '../workspace/int13cHarness'

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function hooks() {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function clickCanvas(at: { x: number; y: number }): void {
  for (const type of ['pointerdown', 'pointerup']) {
    canvas().dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0,
    }))
  }
}

/** Mirrors SolidsWorkbenchPage.delete.test.tsx's own census helper (WO UI-81's authority is the
 *  live scene graph, not the page's bookkeeping) -- duplicated per this repo's existing per-file
 *  test-helper convention rather than factored into a shared module. */
function ambientGenesisSceneCensus(runtime: FakeSceneRuntime): Map<string, { visible: boolean }> {
  const census = new Map<string, { visible: boolean }>()
  runtime.scene.traverse((object) => {
    if (object.userData.genesisVariant !== 'ambient') return
    const nodeId = object.userData.genesisNodeId
    if (typeof nodeId !== 'string') throw new Error('ambient genesis glyph is missing its node id')
    if (census.has(nodeId)) throw new Error(`ambient genesis glyph '${nodeId}' appears more than once in the scene`)
    let visible = true
    for (let cursor: typeof object | null = object; cursor !== null; cursor = cursor.parent) {
      if (!cursor.visible) visible = false
    }
    census.set(nodeId, { visible })
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

function sketchOutlineSceneCensus(runtime: FakeSceneRuntime): Set<string> {
  const ids = new Set<string>()
  runtime.scene.traverse((object) => {
    const nodeId = object.userData.workbenchSketchNodeId
    if (typeof nodeId !== 'string') return
    ids.add(nodeId)
  })
  return ids
}

async function drawAndFinishPackageSketch(runtime: FakeSceneRuntime): Promise<string> {
  const before = new Set(hooks().dag.nodeIds())
  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-package-tool-rect-corner'))
  clickCanvas({ x: 320, y: 250 })
  clickCanvas({ x: 480, y: 350 })
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

// WO UI-81B step 4: "for each ordered pair of (setup/CAM view, model idle, model sketch-active)".
// This enum drives the whole matrix below -- adding a fourth mode here grows the matrix to 16
// cases automatically, rather than requiring a new hand-written scenario per pair.
const MODES = ['cam', 'idle', 'sketch'] as const
type Mode = (typeof MODES)[number]

// A consuming feature starts with its source sketch automatically hidden, but
// the eye control is an intentional user override. Exercise both presentations
// over every ordered workspace transition rather than treating the old always-
// visible sketch outline as the only valid state.
const SKETCH_PRESENTATIONS = ['auto-hidden', 'explicitly-re-shown'] as const

// WO-123: each matrix cell boots and drives a complete workbench twice. Keep
// resource contention from turning Vitest's 5s default into a random failure;
// assertion polling windows remain unchanged and still fail promptly.
const LOAD_TOLERANT_TEST_TIMEOUT_MS = 20_000

/** Puts the ALREADY-BOOTED page into `mode`, driving every transition through the real product
 *  actions (setWorkspace / new-sketch / finish-sketch) -- never poking sketchMode/workspace
 *  directly, since the whole point of this matrix is to exercise the REAL handoff code paths. */
async function enterMode(runtime: FakeSceneRuntime, mode: Mode): Promise<void> {
  if (mode === 'cam') {
    switchToCam()
    return
  }
  switchToPart()
  const sketchOpen = screen.queryByTestId('workbench-package-sketch-toolbar') !== null
  if (mode === 'idle' && sketchOpen) {
    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
  } else if (mode === 'sketch' && !sketchOpen) {
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
  }
}

describe('UI-81B mode-transition matrix: a delete in mode A leaves mode B\'s scene matching the tree', () => {
  for (const sketchPresentation of SKETCH_PRESENTATIONS) {
    for (const from of MODES) {
      for (const to of MODES) {
        it(`${sketchPresentation}: delete while ${from} -> view from ${to}`, async () => {
        const runtime = await bootCoMount()
        await waitFor(() => expectGenesisEyesMatchScene(runtime))

        // A survivor sketch/body (untouched by the delete below) and the one that gets deleted.
        const survivorSketch = await drawAndFinishPackageSketch(runtime)
        fireEvent.click(screen.getByTestId('workbench-extrude'))
        fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: survivorSketch } })
        const distanceInput = screen.getByTestId('extrude-distance').querySelector('input') as HTMLInputElement
        fireEvent.change(distanceInput, { target: { value: '10' } })
        fireEvent.blur(distanceInput)
        fireEvent.click(screen.getByTestId('dialog-shell-apply'))
        await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined())
        await waitFor(() => expect(hooks().dag.getNode(survivorSketch)?.hidden).toBe(true))
        await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(survivorSketch)).toBe(false))

        const doomedSketch = await drawAndFinishPackageSketch(runtime)
        fireEvent.click(screen.getByTestId('workbench-extrude'))
        fireEvent.change(screen.getByTestId('extrude-profile-select'), { target: { value: doomedSketch } })
        const distanceInput2 = screen.getByTestId('extrude-distance').querySelector('input') as HTMLInputElement
        fireEvent.change(distanceInput2, { target: { value: '5' } })
        fireEvent.blur(distanceInput2)
        fireEvent.click(screen.getByTestId('dialog-shell-apply'))
        await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined())
        await waitFor(() => expect(hooks().dag.getNode(doomedSketch)?.hidden).toBe(true))
        await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(doomedSketch)).toBe(false))

        if (sketchPresentation === 'explicitly-re-shown') {
          fireEvent.click(screen.getByTestId(`feature-row-hide-${survivorSketch}`))
          await waitFor(() => expect(hooks().dag.getNode(survivorSketch)?.hidden).toBe(false))
          await waitFor(() => expect(sketchOutlineSceneCensus(runtime).has(survivorSketch)).toBe(true))
        }

        await enterMode(runtime, from)

        // The delete itself: the doomed SKETCH (not just its extrude) -- handleDelete's transitive-
        // consumers closure removes it AND F2 (the extrude it feeds) in ONE CompositeCommand, so
        // this exercises BOTH "tree-deleted implies scene-removed" surfaces at once: the stale
        // finished-sketch OUTLINE (Operator's "sketch lines visible from a previous sketch") and the
        // body MESH it fed. A plain tree delete regardless of which mode it is fired from -- the
        // FeatureTree panel is not gated on `suspended` (SolidsWorkbenchPage.tsx:4158's suspend
        // effect only quiesces the runtime/render path, it never unmounts the tree), so this is
        // reachable in every one of the 3 modes.
        fireEvent.keyDown(screen.getByTestId(`feature-row-${doomedSketch}`), { key: 'Delete' })
        fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
        await waitFor(() => expect(hooks().dag.has(doomedSketch)).toBe(false))
        await waitFor(() => expect(hooks().dag.has('F2')).toBe(false))

        await enterMode(runtime, to)

        // THE INVARIANT (WO UI-81B step 3): a sketch's explicit hidden state
        // controls scene membership across every mode boundary. Scene-graph
        // membership is asserted regardless of whether `to` suspends painting.
        await waitFor(() => expectGenesisEyesMatchScene(runtime))
        expect(hooks().hasSceneMesh('F2'), 'the deleted body must be gone from the live scene').toBe(false)
        expect(hooks().hasSceneMesh('F1'), 'the surviving body must still be in the live scene').toBe(true)
        const shouldDrawSurvivor = sketchPresentation === 'explicitly-re-shown'
        expect(hooks().dag.getNode(survivorSketch)?.hidden).toBe(!shouldDrawSurvivor)
        expect(
          sketchOutlineSceneCensus(runtime).has(survivorSketch),
          shouldDrawSurvivor
            ? 'an explicitly re-shown sketch must remain drawn through the mode handoff'
            : 'an automatically hidden sketch must remain absent through the mode handoff',
        ).toBe(shouldDrawSurvivor)
        expect(
          sketchOutlineSceneCensus(runtime).has(doomedSketch),
          'the deleted sketch outline must not remain stale in the scene',
        ).toBe(false)
        }, LOAD_TOLERANT_TEST_TIMEOUT_MS)
      }
    }
  }
})
