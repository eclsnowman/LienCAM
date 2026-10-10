// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { useUiPrefs } from '../../store/uiPrefs'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import { mintRectangleSketch } from './mintRectangleSketch'
import {
  BASE_PLANE_FRAMES,
  NODE_ID_BY_BASE_PLANE,
} from '../../components/model3d/workbench/basePlanes'
import type { BasePlaneKind } from '../../sketch3d'

let restoreCanvas2d: (() => void) | null = null
let priorLocalStorage: PropertyDescriptor | undefined

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  } as Storage
}

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  sketchSessionStore.__reset()
})

afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  sketchSessionStore.__reset()
  if (priorLocalStorage !== undefined) Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
  priorLocalStorage = undefined
})

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks was not installed')
  return value
}

function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function liveGlyphIds(runtime: FakeSceneRuntime, variant: 'ambient' | 'emphasis'): string[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((object) => !removed.has(object))
    .filter((object) => variant === 'ambient'
      ? object.userData.genesisVariant === 'ambient'
      : object.userData.genesisVariant !== 'ambient')
    .map((object) => object.userData.genesisNodeId as unknown)
    .filter((id): id is string => typeof id === 'string')
}

async function boot() {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime: CreateSceneRuntime = () => {
    const next = createFakeSceneRuntime()
    runtime = next
    return next
  }
  const mounted = render(
    <SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={createSceneRuntime} />,
  )
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  return { runtime: runtime as unknown as FakeSceneRuntime, ...mounted }
}

function armVisualPick(): void {
  // WO SKETCH-PLANE-INWORKSPACE: "New sketch" arms the in-workspace plane pick DIRECTLY -- there is
  // no modal chooser step any more, so no `workbench-sketch-pick-plane` button to click first.
  fireEvent.click(screen.getByTestId('workbench-new-sketch'))
  expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
  expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()
}

function commitField(testId: string, value: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

/** Build a unique ray from the canonical plane frame itself. This makes the
 *  identity domain source-derived: adding a base-plane kind to the mapping
 *  adds a case here without a hand-maintained XY/XZ/YZ ray table. */
function rayForPlane(kind: BasePlaneKind) {
  const frame = BASE_PLANE_FRAMES[kind]
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
  const xDir = new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z).normalize()
  const yDir = normal.clone().cross(xDir).normalize()
  const target = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
    .addScaledVector(xDir, 20)
    .addScaledVector(yDir, 20)
  const origin = target.clone().addScaledVector(normal, 100)
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    direction: { x: -normal.x, y: -normal.y, z: -normal.z },
  }
}

const PLANE_CASES = (Object.entries(NODE_ID_BY_BASE_PLANE) as Array<[BasePlaneKind, string]>)
const PAGE_SOURCE = readFileSync('src/components/model3d/SolidsWorkbenchPage.tsx', 'utf8')

describe('SKC-29 visual base-plane pick integration', () => {
  it('the one cancellation path explicitly clears both hover identity and readout state', () => {
    const start = PAGE_SOURCE.indexOf('const cancelBasePlanePick = useCallback')
    const end = PAGE_SOURCE.indexOf('const armBasePlanePick = useCallback', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const cancellationPath = PAGE_SOURCE.slice(start, end)
    expect(cancellationPath).toContain('setHoveredBasePlaneNodeId(null)')
    expect(cancellationPath).toContain('setPlanePickStatus(null)')
  })

  // WO SKETCH-PLANE-INWORKSPACE (Operator Q-68 item 4): "New sketch" arms the in-workspace plane pick
  // with NO modal step at all -- neither the removed SketchPlaneDialog chooser nor the older
  // rectangle escape hatch (SKC-PARAM-RECT-REMOVAL, Q-24).
  //
  it('temporarily reveals hidden planes only while armed, then restores saved visibility on cancel and entry', async () => {
    const hidden = PLANE_CASES.map(([, nodeId]) => nodeId)
    useUiPrefs.setState({ workbenchHiddenGenesisIds: hidden })
    const { runtime } = await boot()
    expect(liveGlyphIds(runtime, 'ambient')).not.toEqual(expect.arrayContaining(hidden))

    armVisualPick()
    // No chooser modal and no rectangle escape hatch exist any more.
    expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
    expect(screen.queryByTestId('workbench-sketch-use-rectangle')).toBeNull()
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([])
    await waitFor(() => expect(liveGlyphIds(runtime, 'ambient')).toEqual(expect.arrayContaining(hidden)))
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual(hidden)

    fireEvent.click(screen.getByTestId('workbench-cancel-plane-pick'))
    // Cancel returns to idle with NO chooser reopened (the modal is gone) and the pick hint cleared.
    expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    await waitFor(() => expect(liveGlyphIds(runtime, 'ambient')).not.toEqual(expect.arrayContaining(hidden)))
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual(hidden)

    armVisualPick()
    await waitFor(() => expect(liveGlyphIds(runtime, 'ambient')).toEqual(expect.arrayContaining(hidden)))
    runtime.rayOverride = rayForPlane('xy')
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    await waitFor(() => expect(liveGlyphIds(runtime, 'ambient')).not.toEqual(expect.arrayContaining(hidden)))
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual(hidden)

    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
    expect(liveGlyphIds(runtime, 'ambient')).not.toEqual(expect.arrayContaining(hidden))
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual(hidden)
  })

  it('hover derives every plane identity from the canonical mapping and clears on pointer-move miss', async () => {
    const { runtime } = await boot()
    armVisualPick()

    for (const [kind, nodeId] of PLANE_CASES) {
      runtime.rayOverride = rayForPlane(kind)
      fireEvent.pointerMove(canvas())
      const readout = await screen.findByTestId('solids-workbench-plane-hover-readout')
      expect(readout.getAttribute('data-plane-node-id')).toBe(nodeId)
      await waitFor(() => expect(liveGlyphIds(runtime, 'emphasis')).toEqual([nodeId]))
    }

    runtime.rayOverride = { origin: { x: 5000, y: 5000, z: 5000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.pointerMove(canvas())
    await waitFor(() => {
      expect(screen.queryByTestId('solids-workbench-plane-hover-readout')).toBeNull()
      expect(liveGlyphIds(runtime, 'emphasis')).toEqual([])
    })
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()
  })

  it.each(PLANE_CASES)('hands %s through the canonical beginBasePlaneSketch session', async (kind, nodeId) => {
    const { runtime } = await boot()
    armVisualPick()
    runtime.rayOverride = rayForPlane(kind)
    fireEvent.click(canvas())

    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    const sketchNodeId = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))
    expect(sketchNodeId).toBeDefined()
    const sketchNode = hooks().dag.getNode(sketchNodeId!)
    expect(sketchNode?.consumes).toEqual([nodeId])
    expect((sketchNode?.payload as { planeNodeId?: string }).planeNodeId).toBe(nodeId)
    const basePlaneNodeIds = new Set(Object.values(NODE_ID_BY_BASE_PLANE))
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('datum:') && !basePlaneNodeIds.has(id))).toEqual([])
    expect(sketchSessionStore.getState().frame).toEqual(BASE_PLANE_FRAMES[kind])
    expect(runtime.orientNormalToPlaneCalls.at(-1)?.frame).toEqual(BASE_PLANE_FRAMES[kind])
    expect(runtime.sketchGridCalls.at(-1)?.frame).toEqual(BASE_PLANE_FRAMES[kind])
  })

  it('ambiguous and missed clicks create nothing and leave the picker armed', async () => {
    const { runtime } = await boot()
    armVisualPick()
    runtime.rayOverride = { origin: { x: 100, y: 100, z: 100 }, direction: { x: -1, y: -1, z: -1 } }
    fireEvent.click(canvas())
    expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent).toMatch(/Multiple planes/)
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([])

    runtime.rayOverride = { origin: { x: 5000, y: 5000, z: 5000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(canvas())
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([])
  })

  // SKETCH-ON-FACE-FIX (workplan 4e): a visible body FACE under the unified pick is now ROUTED to the
  // face-sketch path (a sketch target), NOT the old "A body blocks that plane" refusal. With the body
  // hidden, the same click falls through to the base plane behind it.
  //
  // NOTE ON CLIENT: this suite drives the FAKE geom client, whose face datum has no real planar frame,
  // so the routed face pick refuses BY NAME ("not flat") instead of opening. That still proves the
  // ROUTING change (face path taken, old blocker gone, named refusal, never a silent no-op); the
  // successful planar-face OPEN is proven against the REAL occt-wasm kernel in
  // SolidsWorkbenchPage.sketchOnFace.test.tsx ("New sketch (unified pick): clicking a flat body face
  // starts the sketch ON that face").
  it('unified pick: a visible body face is routed to the face path (never "body blocks"); the hidden body falls through to the base plane behind', async () => {
    const { runtime } = await boot()
    await mintRectangleSketch({ width: '40', height: '20', offset: '0' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '10')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeDefined())

    // (a) Visible body under the ray -> routed to the face path. FAILS-IF it takes the old
    // "A body blocks that plane" refusal (which would create no face routing at all).
    armVisualPick()
    runtime.rayOverride = { origin: { x: 5, y: 5, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(canvas())
    // The face path was taken: a plain-words face refusal (fake-client frame), never a started sketch,
    // never the old "body blocks that plane".
    await waitFor(() => expect(
      screen.getByTestId('solids-workbench-plane-hover-readout').textContent ?? '',
    ).toMatch(/not flat/i))
    expect(screen.getByTestId('solids-workbench-plane-hover-readout').textContent ?? '').not.toMatch(/body blocks/i)
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([])
    // Still armed on the unified pick, so the operator can pick a flat face or a base plane next.
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()

    // (b) Hide the body; the SAME ray now falls through to the XY base plane behind it.
    const rendersBeforeHide = runtime.requestRenderCallCount
    hooks().visibilityStore.setBodyHidden('F1', true)
    await waitFor(() => expect(runtime.requestRenderCallCount).toBeGreaterThan(rendersBeforeHide))
    fireEvent.click(canvas())
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    const sketchNodeId = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))
    expect((hooks().dag.getNode(sketchNodeId!)?.payload as { planeNodeId?: string }).planeNodeId).toBe(NODE_ID_BY_BASE_PLANE.xy)
  })

  it('Cancel exits the in-workspace pick (no chooser reopens), clears hover, and rejects a queued stale click', async () => {
    const { runtime } = await boot()
    armVisualPick()
    runtime.rayOverride = rayForPlane('xy')
    fireEvent.pointerMove(canvas())
    expect(await screen.findByTestId('solids-workbench-plane-hover-readout')).toBeTruthy()

    const queuedClick = new Promise<void>((resolve) => queueMicrotask(() => {
      fireEvent.click(canvas())
      resolve()
    }))
    fireEvent.click(screen.getByTestId('workbench-cancel-plane-pick'))
    // No modal chooser exists to reopen; Cancel simply returns to idle.
    expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-plane-hover-readout')).toBeNull()
    await queuedClick
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([])
  })

  it('Escape exits the in-workspace pick (no chooser reopens) and rejects a following stale click', async () => {
    const { runtime } = await boot()
    armVisualPick()
    runtime.rayOverride = rayForPlane('xz')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    fireEvent.click(canvas())
    expect(hooks().dag.nodeIds().filter((id) => id.startsWith('sketch3d:'))).toEqual([])
  })

  it('tool switch retires without reopening the chooser', async () => {
    await boot()
    await mintRectangleSketch({ width: '20', height: '20' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    armVisualPick()
    const extrude = screen.getByTestId('workbench-extrude') as HTMLButtonElement
    expect(extrude.disabled).toBe(false)
    fireEvent.click(extrude)
    expect(screen.getByTestId('dialog-shell-apply')).toBeTruthy()
    expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull()
    expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
  })

  it('unmount while armed removes the Escape listener and every transient scene root', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { runtime, unmount } = await boot()
    armVisualPick()
    runtime.rayOverride = rayForPlane('yz')
    fireEvent.pointerMove(canvas())
    await screen.findByTestId('solids-workbench-plane-hover-readout')
    const liveBefore = runtime.addedObjects.filter((object) => !runtime.removedObjects.includes(object))
    expect(liveBefore.length).toBeGreaterThan(0)

    unmount()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(runtime.addedObjects.filter((object) => !runtime.removedObjects.includes(object))).toEqual([])
    fireEvent.keyDown(window, { key: 'Escape' })
    removeSpy.mockRestore()
  })
})
