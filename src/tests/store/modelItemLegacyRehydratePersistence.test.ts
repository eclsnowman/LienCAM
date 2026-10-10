// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Project } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
Object.defineProperty(window, 'localStorage', { value: memStorage, configurable: true })

const { PERSIST_STORE_VERSION, useCamStore } = await import('../../store')
const { CURRENT_PROJECT_SCHEMA_VERSION } =
  await import('../../store/migrations/projectMigrations')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { resetDocumentHolder, setDocumentStorage } =
  await import('../../doc/documentHolder')

const STORAGE_KEY = 'cnc-cam-project'

function modelRow(id: string, modelItemId: string): ImportedGeometry {
  return {
    id,
    name: id,
    filename: id,
    type: 'brep',
    format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 },
      center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
    },
  }
}

beforeEach(() => {
  mem.clear()
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.setState({
    workspace: 'cam',
    activeModelItemId: null,
    consoleEvents: [],
  })
})

describe('legacy browser Model Item persistence migration', () => {
  it('rehydrates a wrapper-v4/project-v14 authored A/B project and refuses blank entry when its checkpoint is missing', async () => {
    const current = useCamStore.getState()
    const legacyProject: Project = {
      ...structuredClone(current.project),
      id: 'legacy-v14-models',
      schemaVersion: 14,
      geometry: [modelRow('row-a', 'item-a'), modelRow('row-b', 'item-b')],
      modelItems: [
        { id: 'item-a', name: 'Legacy A' },
        { id: 'item-b', name: 'Legacy B' },
      ],
      modelItemPlacements: [],
    }
    mem.set(STORAGE_KEY, JSON.stringify({
      version: 4,
      state: {
        project: legacyProject,
        machineLibrary: current.machineLibrary,
        toolLibrary: current.toolLibrary,
        toolLibraries: current.toolLibraries,
        holders: current.holders,
        appSettings: current.appSettings,
        importedFonts: [],
      },
    }))

    await useCamStore.persist.rehydrate()

    expect(PERSIST_STORE_VERSION).toBe(6)
    expect(useCamStore.getState().project.schemaVersion)
      .toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(useCamStore.getState().project.modelItems).toEqual([
      expect.objectContaining({ id: 'item-a', documentState: 'authored' }),
      expect.objectContaining({ id: 'item-b', documentState: 'authored' }),
    ])

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await useCamStore.getState().openModelItem('item-a')
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(useCamStore.getState().activeModelItemId).toBeNull()
    expect(useCamStore.getState().project.geometry.map((g) => g.id))
      .toEqual(['row-a', 'row-b'])
    expect(useCamStore.getState().consoleEvents.at(-1)?.message)
      .toMatch(/checkpoint reference is missing/i)
    errorSpy.mockRestore()
  })
})
