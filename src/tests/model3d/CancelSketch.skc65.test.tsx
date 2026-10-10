// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
import { stubCanvas2d } from './stubCanvas2d'
import type { SketchEntity } from '../../lib/sketch/types'
import type { Sketch as CamSketch } from '../../lib/sketch/sketcher'

class StubWorker {
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })

let useCamStore: typeof import('../../store').useCamStore
let restoreCanvas2d: (() => void) | null = null

beforeAll(async () => { ({ useCamStore } = await import('../../store')) })
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { cleanup(); restoreCanvas2d?.(); restoreCanvas2d = null })

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

function canvas(): HTMLElement { return screen.getByTestId('solids-workbench-canvas') }

function clickCanvas(point: { x: number; y: number }): void {
  for (const type of ['pointerdown', 'pointerup']) {
    canvas().dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0,
    }))
  }
}

async function bootModelSketch(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const createSceneRuntime: CreateSceneRuntime = () => {
    captured = createFakeSceneRuntime()
    return captured
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={createSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.position.set(0, 0, 100)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  runtime.camera = camera
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

  enterBasePlaneSketchViaPick(runtime, 'xy')
  await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())
  return runtime
}

describe('SKC-65 Cancel sketch', () => {
  it('restores the exact CAM entry snapshot and removes a new Model sketch without baking', async () => {
    useCamStore.setState((state) => ({
      viewer: { ...state.viewer, mode: 'setup' },
      project: { ...state.project, geometry: [] },
      projectHistory: [], sketchHistory: [], projectFuture: [], sketchFuture: [],
      activeSketch: null, sketchEntrySnapshot: null, sketchSelectedIds: [],
      lastNonSketchMode: 'setup',
    }))
    useCamStore.getState().startNewSketch()
    useCamStore.getState().addEntity(line('cam-entry-edit', 0, 0, 10, 0))
    useCamStore.getState().cancelActiveSketch()
    expect(useCamStore.getState().viewer.mode).toBe('setup')
    expect(useCamStore.getState().activeSketch).toBeNull()
    expect(useCamStore.getState().project.geometry).toEqual([])
    expect(useCamStore.getState().sketchEntrySnapshot).toBeNull()

    const runtime = await bootModelSketch()
    const nodeId = 'sketch3d:SK1'
    expect(hooks().dag.has(nodeId)).toBe(true)
    fireEvent.click(screen.getByTestId('workbench-package-tool-line'))
    clickCanvas({ x: 400, y: 300 })
    clickCanvas({ x: 500, y: 300 })
    await waitFor(() => {
      const sketch = hooks().dag.getNode(nodeId)?.payload.sketch as CamSketch
      expect(sketch.entities.length).toBeGreaterThan(0)
    })

    fireEvent.click(screen.getByTestId('workbench-cancel-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull())
    expect(hooks().dag.has(nodeId)).toBe(false)
    expect(runtime.setCameraPoseCalls.length).toBeGreaterThan(0)
  }, 60_000)
})
