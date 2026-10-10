// @vitest-environment jsdom
//
// WO SKETCH-PLANE-INWORKSPACE (Operator Q-68 item 4): the no-modal plane pick, its embedded XY/YZ/XZ
// glyph labels, and its three-surface contextual feedback (viewport highlight, console lines,
// properties-visible plane name). This suite is the behavioral proof for the feature the older
// SolidsWorkbenchPage.visualPlanePick.test.tsx (ray/highlight mechanics) does not cover: the
// console feedback (contextual-feedback rule) and the labeled glyphs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as rtlWaitFor } from './loadTolerantWaitFor'
import * as THREE from 'three'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { useUiPrefs } from '../../store/uiPrefs'
import { useCamStore } from '../../store'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import { NODE_ID_BY_BASE_PLANE } from '../../components/model3d/workbench/basePlanes'
import { rayForPlane } from './enterBasePlaneSketch'
import { ORIGIN_NODE_ID } from '../../doc'

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

function consoleMessages(): string[] {
  return useCamStore.getState().consoleEvents.filter((e) => e.source === 'workbench').map((e) => e.message)
}

/** Live (added-not-removed) scene objects the page drew for a genesis node + variant. */
function liveGlyphGroups(runtime: FakeSceneRuntime, nodeId: string, variant: 'ambient' | 'emphasis'): THREE.Object3D[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((o) => !removed.has(o))
    .filter((o) => o.userData.genesisNodeId === nodeId)
    .filter((o) => variant === 'ambient' ? o.userData.genesisVariant === 'ambient' : o.userData.genesisVariant !== 'ambient')
}

// WO PLANE-LABEL-INPLANE: the XY/YZ/XZ label is now a COPLANAR quad (THREE.Mesh) lying in the plane,
// not a camera-facing Sprite. genesisGlyphs tags it with `userData.planeLabel`, so the render-gate
// keys off that tag (there are no Sprites in the scene any more).
function hasPlaneLabelChild(object: THREE.Object3D): boolean {
  let found = false
  object.traverse((o) => { if (typeof o.userData.planeLabel === 'string') found = true })
  return found
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
  await rtlWaitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  return { runtime: runtime as unknown as FakeSceneRuntime, ...mounted }
}

describe('SKETCH-PLANE-INWORKSPACE: no-modal entry + contextual feedback', () => {
  it('New sketch arms the plane pick with NO modal and posts a plain-words arm console line', async () => {
    await boot()
    const before = consoleMessages().length

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))

    // No modal step: the removed chooser dialog never appears; the in-workspace hint bar does.
    expect(screen.queryByTestId('workbench-sketch-plane-dialog')).toBeNull()
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()

    // SKETCH-ON-FACE-FIX: the unified pick accepts a base plane OR a flat body face, so the arm line
    // names both targets.
    const armed = consoleMessages().slice(before)
    expect(armed.some((m) => m.includes('Pick a plane or a flat face for the new sketch') && m.includes('XY'))).toBe(true)
  })

  it('hovering a plane names it in the console as armed-for-selection, ONCE per hover-target change', async () => {
    const { runtime } = await boot()
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))

    runtime.rayOverride = rayForPlane('xz')
    fireEvent.pointerMove(canvas())
    await rtlWaitFor(() => expect(consoleMessages().some((m) => m.includes('Armed for selection: XZ plane'))).toBe(true))

    // A second pointermove over the SAME plane must NOT add another XZ line (ref-dedup'd).
    const xzCount = () => consoleMessages().filter((m) => m.includes('Armed for selection: XZ plane')).length
    const afterFirst = xzCount()
    fireEvent.pointerMove(canvas())
    fireEvent.pointerMove(canvas())
    expect(xzCount()).toBe(afterFirst)

    // Moving to a DIFFERENT plane posts its own line.
    runtime.rayOverride = rayForPlane('yz')
    fireEvent.pointerMove(canvas())
    await rtlWaitFor(() => expect(consoleMessages().some((m) => m.includes('Armed for selection: YZ plane'))).toBe(true))
  })

  it('clicking a plane starts the sketch on it, posts a completion console line, and names the sketch by its plane (properties fact)', async () => {
    const { runtime } = await boot()
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = rayForPlane('xz')
    fireEvent.click(canvas())

    await rtlWaitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    expect(consoleMessages().some((m) => m.includes('New sketch started on the XZ plane'))).toBe(true)

    const sketchNodeId = hooks().dag.nodeIds().find((id) => id.startsWith('sketch3d:'))
    expect(sketchNodeId).toBeDefined()
    const sketchNode = hooks().dag.getNode(sketchNodeId!)
    expect(sketchNode?.consumes).toEqual([NODE_ID_BY_BASE_PLANE.xz])
    // The properties-visible fact: the sketch carries its plane in its display name.
    expect((sketchNode?.payload as { name?: string }).name).toBe('Sketch on XZ')
  })

  it('a hidden base plane is temporary and pickable while armed, then re-hides when its sketch opens', async () => {
    // Hide the XY base plane BEFORE arming.
    useUiPrefs.setState({ workbenchHiddenGenesisIds: [NODE_ID_BY_BASE_PLANE.xy] })
    const { runtime } = await boot()

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))

    await rtlWaitFor(() => expect(liveGlyphGroups(runtime, NODE_ID_BY_BASE_PLANE.xy, 'ambient').length).toBeGreaterThan(0))
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual([NODE_ID_BY_BASE_PLANE.xy])

    runtime.rayOverride = rayForPlane('xy')
    fireEvent.click(canvas())
    await rtlWaitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
    await rtlWaitFor(() => expect(liveGlyphGroups(runtime, NODE_ID_BY_BASE_PLANE.xy, 'ambient').length).toBe(0))
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual([NODE_ID_BY_BASE_PLANE.xy])
  })

  it('with all base planes saved hidden, New sketch temporarily reveals all three without changing prefs', async () => {
    useUiPrefs.setState({
      workbenchHiddenGenesisIds: [
        NODE_ID_BY_BASE_PLANE.xy,
        NODE_ID_BY_BASE_PLANE.xz,
        NODE_ID_BY_BASE_PLANE.yz,
      ],
    })
    const hidden = [
      NODE_ID_BY_BASE_PLANE.xy,
      NODE_ID_BY_BASE_PLANE.xz,
      NODE_ID_BY_BASE_PLANE.yz,
    ]
    const { runtime } = await boot()

    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    const hint = screen.getByTestId('solids-workbench-plane-pick-hint')
    expect(hint.textContent).toMatch(/Click a base plane/i)
    await rtlWaitFor(() => {
      for (const nodeId of hidden) {
        expect(liveGlyphGroups(runtime, nodeId, 'ambient').length).toBeGreaterThan(0)
      }
    })
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual(hidden)
  })

  it('each ambient base-plane glyph carries an embedded coplanar label; the Origin glyph does not', async () => {
    const { runtime } = await boot()

    for (const nodeId of Object.values(NODE_ID_BY_BASE_PLANE)) {
      const groups = liveGlyphGroups(runtime, nodeId, 'ambient')
      expect(groups.length).toBeGreaterThan(0)
      expect(groups.every(hasPlaneLabelChild)).toBe(true)
    }
    // The Origin triad is not a plane and carries no XY/YZ/XZ label.
    const originGroups = liveGlyphGroups(runtime, ORIGIN_NODE_ID, 'ambient')
    expect(originGroups.length).toBeGreaterThan(0)
    expect(originGroups.some(hasPlaneLabelChild)).toBe(false)
  })
})
