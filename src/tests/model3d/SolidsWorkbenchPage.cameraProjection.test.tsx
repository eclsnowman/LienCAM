// @vitest-environment jsdom
//
// UI-34 render smoke: exercise the complete page wiring rather than only the
// WorkbenchDisplayMode child callback. The real page reads uiPrefs, applies it
// through its projection effect, and the fake runtime records the last mode.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { FakeSceneRuntime } from './fakeSceneRuntime'

const values = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return values.size },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key) },
  setItem: (key, value) => { values.set(key, String(value)) },
}
const priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { useUiPrefs } = await import('../../store/uiPrefs')

beforeEach(() => {
  values.clear()
  useUiPrefs.setState({ workbenchCameraProjection: 'orthographic' })
})

afterEach(() => {
  cleanup()
  useUiPrefs.setState({ workbenchCameraProjection: 'orthographic' })
})

afterAll(() => {
  if (priorLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage')
  } else {
    Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
  }
})

describe('UI-34: SolidsWorkbenchPage camera projection wiring', () => {
  it('applies the orthographic default and follows both projection radio testids', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const runtime = createFakeSceneRuntime()
      capturedRuntime = runtime
      return runtime
    }

    render(
      <SolidsWorkbenchPage
        createClient={createFakeGeomClient}
        createSceneRuntime={captureSceneRuntime}
      />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
    )

    const runtime = () => capturedRuntime as unknown as FakeSceneRuntime
    await waitFor(() => expect(runtime().setCameraProjectionCalls.at(-1)).toBe('orthographic'))

    fireEvent.click(screen.getByTestId('workbench-display-mode-btn'))
    const perspective = screen.getByTestId('workbench-projection-perspective') as HTMLInputElement
    const orthographic = screen.getByTestId('workbench-projection-orthographic') as HTMLInputElement
    expect(orthographic.checked).toBe(true)
    expect(perspective.checked).toBe(false)

    fireEvent.click(perspective)
    await waitFor(() => expect(runtime().setCameraProjectionCalls.at(-1)).toBe('perspective'))
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('perspective')
    expect(perspective.checked).toBe(true)

    fireEvent.click(orthographic)
    await waitFor(() => expect(runtime().setCameraProjectionCalls.at(-1)).toBe('orthographic'))
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('orthographic')
    expect(orthographic.checked).toBe(true)
  })
})
