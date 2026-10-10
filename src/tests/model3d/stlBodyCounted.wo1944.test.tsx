// @vitest-environment jsdom
// WO-1944: the Model screen's bottom status bar counts an open STL body, the
// same as the BODIES list does (the WO-1846 plate reads 1 body, not 0).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))

const { useCamStore } = await import('../../store')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
type ImportedGeometry = import('../../types').ImportedGeometry

beforeEach(() => {
  cache.clear()
  act(() => { useCamStore.getState().newProject() })
})
afterEach(() => { cleanup() })

describe('WO-1944: the status bar counts an open STL body', () => {
  it('the WO-1846 plate open in the Model screen reads 1 bodies in the status bar, matching the list', async () => {
    const plate = readFileSync(resolve(__dirname, '../evidence/WO-1846/acceptance-plate.stl'))
    cache.set('plate', plate.buffer.slice(plate.byteOffset, plate.byteOffset + plate.byteLength) as ArrayBuffer)
    const row: ImportedGeometry = {
      id: 'plate', name: 'acceptance plate', filename: 'acceptance plate.stl', type: 'mesh', format: 'stl',
      boundingBox: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 17 }, size: { x: 80, y: 80, z: 17 }, center: { x: 0, y: 0, z: 8.5 } },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, meshEdits: [],
    }
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [row] } })) })
    await act(async () => { await useCamStore.getState().wrapImportedGeometryAsModelItem('plate') })

    const runtime = createFakeSceneRuntime()
    render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('body-row-stl-body:plate')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('workbench-status-bodies').textContent).toBe('1 bodies')
  })
})
