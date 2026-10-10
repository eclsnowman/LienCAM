// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import type { ImportedGeometry } from '../../types'
import type { SolidsWorkbenchHooks } from '../../components/model3d'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => [...memory.keys()][index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, value) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFeatureCommand } = await import('../../components/model3d/dialogs/createFeatureCommand')
const { useCamStore } = await import('../../store')

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function bodyRow(bodyId: string): ImportedGeometry | undefined {
  return useCamStore.getState().project.geometry.find(
    (geometry) => geometry.modelBody?.ref.bodyId === bodyId,
  )
}

async function buildBody(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  hooks().history.execute(createFeatureCommand(hooks().dag, {
    id: 'F1',
    kind: 'feature',
    consumes: ['SK1'],
    payload: {
      opType: 'extrude',
      sketchId: 'SK1',
      distance: 10,
      direction: 'up',
      boolMode: 'newBody',
      name: 'Body A',
    },
  }))
  await hooks().fullResync(['F1'])
  await waitFor(() => expect(bodyRow('F1')).toBeDefined())
  await waitFor(() => expect(screen.getByTestId('body-color-input-F1')).toBeTruthy())
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'part' })
})

afterEach(() => {
  cleanup()
  useCamStore.setState({ workspace: 'cam' })
})

describe('SolidsWorkbenchPage whole-body color authority', () => {
  it('round-trips Model body colors through the CAM row while face colors remain Model-only', async () => {
    const runtime = createFakeSceneRuntime()
    render(createElement(SolidsWorkbenchPage, {
      embedded: true,
      createClient: createFakeGeomClient,
      createSceneRuntime: () => runtime,
    }))
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 20_000 },
    )
    await buildBody()

    // Body-list changes update both the Model projection and the persisted CAM row.
    fireEvent.change(screen.getByTestId('body-color-input-F1'), { target: { value: '#00ff00' } })
    await waitFor(() => expect(hooks().appearanceStore.bodyColor('F1')).toEqual([0, 1, 0]))
    await waitFor(() => expect(bodyRow('F1')?.color).toBe('#00ff00'))
    const bodyFaceId = hooks().getBodyFaceIds('F1')?.[0]
    expect(bodyFaceId).toBeDefined()
    await waitFor(() => expect(hooks().getBodyFaceColorSample('F1', bodyFaceId!)).toEqual([0, 1, 0]))

    // The retained Model host does not subscribe to project.geometry while CAM
    // is active. Re-entering Model is the explicit hydration boundary.
    act(() => useCamStore.getState().setWorkspace('cam'))
    act(() => useCamStore.getState().updateGeometryColor(bodyRow('F1')!.id, '#336699'))
    act(() => useCamStore.getState().setWorkspace('part'))
    await waitFor(() => expect(hooks().appearanceStore.bodyColor('F1')).toEqual([0.2, 0.4, 0.6]))
    await waitFor(() =>
      expect((screen.getByTestId('body-color-input-F1') as HTMLInputElement).value).toBe('#336699'),
    )

    // Appearance body clear removes the durable row override as well as the
    // Model projection, restoring the inherited/default material in both hosts.
    fireEvent.click(screen.getByTestId('workbench-ui4-tool-appearance'))
    await waitFor(() => expect(hooks().hasBridgeBody('F1')).toBe(true), { timeout: 20_000 })
    fireEvent.click(screen.getByTestId('appearance-filter-body'))
    runtime.rayOverride = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('appearance-target-label').textContent).toBe('body: F1'))
    fireEvent.click(screen.getByTestId('appearance-clear'))
    await waitFor(() => expect(hooks().appearanceStore.bodyColor('F1')).toBeUndefined())
    await waitFor(() => expect(bodyRow('F1')?.color).toBeUndefined())

    // Re-establish a whole-body color, then paint one face. The face override
    // stays in AppearanceStore and must not overwrite the CAM row's body color.
    fireEvent.change(screen.getByTestId('body-color-input-F1'), { target: { value: '#112233' } })
    await waitFor(() => expect(bodyRow('F1')?.color).toBe('#112233'))
    fireEvent.click(screen.getByTestId('appearance-filter-face'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() =>
      expect(screen.getByTestId('appearance-target-label').textContent).not.toMatch(/^body:/),
    )
    const faceId = screen.getByTestId('appearance-target-label').textContent!
    fireEvent.change(screen.getByTestId('appearance-color-input'), { target: { value: '#ff0000' } })
    await waitFor(() => expect(hooks().appearanceStore.faceColor(faceId)).toEqual([1, 0, 0]))
    expect(bodyRow('F1')?.color).toBe('#112233')
  }, 60_000)
})
