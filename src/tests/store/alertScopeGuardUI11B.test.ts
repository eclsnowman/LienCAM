// UI-41 batch E: passive project/save/schema failures use the existing
// non-blocking status-strip + console event surface. Destructive confirmations
// remain decisions; informational errors must never freeze the browser.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Project } from '../../types'
import { typedMock } from '../support/typedMock'

// No real IndexedDB in this env; collectProjectBinaries reads via stlCache's
// loadCachedSTL. Mock it to "not found" (same shape/pattern projectBinaries.test.ts
// uses) so the save-path test below reaches MissingGeometryBinaryError instead of
// crashing on `indexedDB is not defined`.
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')

function makeProjectFile(over: Partial<Project> = {}): string {
  const project: Project = {
    id: 'p1', name: 'Saved Project', version: '1.0.0',
    createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      notes: '',
    },
    toolLibrary: [], geometry: [], setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
    ...over,
  } as Project
  return JSON.stringify(project)
}

describe('UI-41 batch E: project failures are non-blocking', () => {
  let alertSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    vi.stubGlobal('window', { alert: alertSpy })
    useCamStore.setState((s) => ({
      toolLibrary: [],
      project: { ...s.project, toolLibrary: [], geometry: [], setups: [] },
      projectHistory: [], sketchHistory: [], canUndo: false,
      consoleEvents: [], consoleReadThroughId: 0,
    }))
  })

  it('an invalid project file reports through the app without alerting', () => {
    useCamStore.getState().loadProjectFromFile(JSON.stringify({ not: 'a project' }))
    expect(alertSpy).not.toHaveBeenCalled()
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'project',
      message: expect.stringContaining('does not appear to be a valid LienCAM project file'),
    })
    expect(useCamStore.getState().sketchNotice).toContain('does not appear to be a valid LienCAM project file')
  })

  it('a newer-than-supported schema reports through the app without alerting', () => {
    const file = makeProjectFile({ schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION + 1 } as Partial<Project>)
    useCamStore.getState().loadProjectFromFile(file)
    expect(alertSpy).not.toHaveBeenCalled()
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'project',
      message: expect.stringContaining('NEWER version of LienCAM'),
    })
  })

  it('a save with a missing geometry binary still writes and skips the part, without alerting', async () => {
    // Seed a root-level geometry part whose binary cannot be found in cache.
    // WO-1884 (rule 11): Save no longer aborts; it writes the file without that
    // part and names the part on the console (console.warn in projectBinaries).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const click = vi.fn()
    vi.stubGlobal('document', { createElement: () => ({ click }) })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:wo1950', revokeObjectURL: () => {} })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [{
          id: 'g-missing', name: 'Missing STL', filename: 'missing.stl',
          type: 'mesh', format: 'stl',
          boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 } },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
        setups: [],
      },
    }))
    await useCamStore.getState().saveProjectToFile()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing STL'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-import missing.stl'))
    expect(useCamStore.getState().consoleEvents.some(e => e.message.includes('Could not save this project'))).toBe(false)
    warn.mockRestore()
    vi.unstubAllGlobals()
  })
})
