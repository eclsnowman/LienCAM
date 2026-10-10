// @vitest-environment jsdom
//
// BUG-EDIT-MODEL-IMPORT-2026-08-03: an imported STEP's Edit as model path must
// open the model item that wraps that exact import, not an empty genesis model.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id: string, bytes: ArrayBuffer) => { cache.set(id, bytes) },
  loadCachedStep: async (id: string) => cache.get(id) ?? null,
  removeCachedStep: async (id: string) => { cache.delete(id) },
}))

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

let importedBodies: Array<{ name: string }> = []
vi.mock('../../components/model3d/SolidsWorkbenchPage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/model3d/SolidsWorkbenchPage')>()
  const { createFakeGeomClient } = await import('./fakeGeomClient')
  const { fakeCreateSceneRuntime } = await import('./fakeSceneRuntime')
  return typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
    ...actual,
    SolidsWorkbenchPage: (props: any) => createElement(actual.SolidsWorkbenchPage, {
      ...props,
      createClient: () => createFakeGeomClient({ importedBodies }),
      createSceneRuntime: fakeCreateSceneRuntime,
    }),
  })
})

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
type ImportedGeometry = import('../../types').ImportedGeometry

function importedStep(): ImportedGeometry {
  return {
    id: 'imported-step', name: 'Imported bracket', filename: 'bracket.step', type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 8, z: 4 },
      size: { x: 10, y: 8, z: 4 }, center: { x: 5, y: 4, z: 2 },
    },
    position: { x: 12, y: -3, z: 0 }, rotation: { x: 0, y: 0, z: 30 }, loaded: true, solidCount: 1,
  }
}

beforeEach(() => {
  window.history.pushState(null, '', '/?partWorkspace=1')
  cache.clear()
  cache.set('imported-step', new Uint8Array([1, 2, 3]).buffer)
  importedBodies = [{ name: 'Imported bracket' }]
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({ workspace: 'cam', project: { ...s.project, geometry: [importedStep()] } }))
  })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('BUG-EDIT-MODEL-IMPORT: imported STEP Edit as model', () => {
  it('replays the imported body into the selected Model item without duplicating or replacing its geometry row', async () => {
    render(<App />)

    fireEvent.click(screen.getByTestId('edit-as-model-btn-imported-step'))

    await waitFor(() => expect(useCamStore.getState().workspace).toBe('part'))
    const itemId = useCamStore.getState().activeModelItemId
    expect(itemId).toBeTruthy()
    await waitFor(
      () => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
      { timeout: 10_000 },
    )
    await waitFor(() => expect(screen.getByTestId('feature-row-IMP1')).toBeTruthy(), { timeout: 10_000 })

    const rows = useCamStore.getState().project.geometry
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('imported-step')
    expect(rows[0].format).toBe('model')
    expect(rows[0].modelItemId).toBe(itemId)
    expect(rows[0].modelBody?.ref.bodyId).toBe('IMP1')
    expect(rows[0].position).toEqual({ x: 0, y: 0, z: 0 })
    expect(rows[0].rotation).toEqual({ x: 0, y: 0, z: 0 })
    expect(useCamStore.getState().project.modelItemPlacements?.find((p) => p.modelItemId === itemId)).toMatchObject({
      position: { x: 12, y: -3, z: 0 }, rotation: { x: 0, y: 0, z: 30 },
    })
  })

  it('does not send the sole imported STEP to a separate empty Project Model document', async () => {
    // Exact screenshot state: an existing, empty legacy Project Model beside
    // the sole imported STEP. The Project Model button must not mask the STEP
    // behind a genesis document.
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          modelItems: [{ id: 'legacy', name: 'Project Model', documentState: 'empty' }],
        },
      }))
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('model-placeholder-edit-btn-legacy'))

    await waitFor(() => expect(useCamStore.getState().workspace).toBe('part'))
    await waitFor(() => expect(useCamStore.getState().activeModelItemId).not.toBe('legacy'))
    await waitFor(() => expect(screen.getByTestId('feature-row-IMP1')).toBeTruthy(), { timeout: 10_000 })
  }, 20_000)
})
