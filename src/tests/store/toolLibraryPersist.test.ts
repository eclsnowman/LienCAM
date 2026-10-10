// feat/persistent-tool-library: the TOOL library must survive new-project /
// open-file / reload, mirroring machineLibrary. The library is promoted from
// inside the `project` slice to a ROOT store slice (the single source of truth
// for live reads/writes). Project.toolLibrary remains only a serialization
// snapshot (written at save, additively merged at open).
//
// These tests drive the REAL store (jsdom) the same way projectOpen.test.ts and
// nestedResolution.test.ts do: import useCamStore, reset state, call actions.
//   (a) addTool -> newProject -> tool still present (survives project switch).
//   (b) addTool -> loadProjectFromFile (file embeds a DIFFERENT tool) ->
//       BOTH present (additive merge) and re-opening the SAME file does NOT
//       duplicate (dedupe by id).
//   (d) persistMigrate on an OLD-format (v1) blob lifts project.toolLibrary to
//       the ROOT.
//
// Against the UNMODIFIED store, (a) and (d) FAIL (red): newProject resets the
// project (and with it the in-project library), and there is no persistMigrate
// export / no root lifting.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { persistMigrate, gatherUsedTools } from '../../store'
import type { Project, Tool } from '../../types'

function makeTool(id: string, name = id): Tool {
  return {
    id, name, type: 'flat_endmill',
    diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 } },
  } as unknown as Tool
}

function makeProjectFile(id: string, tools: Tool[]): string {
  const project: Project = {
    id, name: 'Saved Project', version: '1.0.0',
    createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      axisLimits: {
        x: { maxCutting: 3000, maxRapid: 5000 },
        y: { maxCutting: 3000, maxRapid: 5000 },
        z: { maxCutting: 1000, maxRapid: 3000 },
      },
      notes: '',
    },
    toolLibrary: tools, geometry: [], setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
  } as Project
  return JSON.stringify(project)
}

const state = () => useCamStore.getState()

describe('persistent tool library: root slice is the single source of truth', () => {
  beforeEach(() => {
    // alert is called by loadProjectFromFile's invalid path; stub it.
    vi.stubGlobal('alert', vi.fn())
    // No viewport handle in node -> loadProjectFromFile skips the scene reload.
    vi.stubGlobal('window', {})
    // Start each test from an empty live library and a clean project.
    useCamStore.setState((s) => ({
      toolLibrary: [],
      project: { ...s.project, toolLibrary: [], geometry: [], setups: [] },
      projectHistory: [], sketchHistory: [], canUndo: false,
    }))
  })

  it('(a) addTool then newProject -> the tool is STILL in the library', () => {
    state().addTool(makeTool('tool-A'))
    expect(state().toolLibrary.map((t) => t.id)).toContain('tool-A')

    state().newProject()
    expect(state().toolLibrary.map((t) => t.id)).toContain('tool-A')
  })

  it('(b) open a file embedding a DIFFERENT tool merges additively, re-open dedupes by id', () => {
    state().addTool(makeTool('tool-A'))
    const file = makeProjectFile('proj-1', [makeTool('tool-B')])

    state().loadProjectFromFile(file)
    const ids1 = state().toolLibrary.map((t) => t.id).sort()
    expect(ids1).toContain('tool-A')
    expect(ids1).toContain('tool-B')

    // Re-opening the SAME file must NOT duplicate tool-B (dedupe by id).
    state().loadProjectFromFile(file)
    const ids2 = state().toolLibrary.map((t) => t.id)
    expect(ids2.filter((id) => id === 'tool-B').length).toBe(1)
    expect(ids2.filter((id) => id === 'tool-A').length).toBe(1)
  })

  it('(d) persistMigrate lifts an old-format project.toolLibrary to the ROOT slice', () => {
    const toolX = makeTool('tool-X')
    const oldBlob = {
      project: { ...JSON.parse(makeProjectFile('proj-old', [toolX])) },
      machineLibrary: [],
    }
    const migrated = persistMigrate(oldBlob, 1) as { toolLibrary?: Tool[]; project: Project }
    expect(Array.isArray(migrated.toolLibrary)).toBe(true)
    expect(migrated.toolLibrary!.map((t) => t.id)).toContain('tool-X')
    // The persisted project's library is emptied so it is not a stale duplicate.
    expect(migrated.project.toolLibrary).toEqual([])
  })
})

// Portable project files: a saved .camproject embeds ONLY the tools its
// operations use; opening a shared one imports any new tools into your library
// and tells you. (The "one library" model — no project-vs-library tool split.)
describe('portable project files: embed used tools + import notice', () => {
  let alertSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    vi.stubGlobal('window', {})
    useCamStore.setState((s) => ({
      toolLibrary: [],
      project: { ...s.project, toolLibrary: [], geometry: [], setups: [] },
      projectHistory: [], sketchHistory: [], canUndo: false,
    }))
  })

  it('gatherUsedTools embeds only the tools the project uses (library order)', () => {
    const lib = [makeTool('A'), makeTool('B'), makeTool('C')]
    const project = { setups: [{ operations: [{ toolId: 'C' }, { toolId: 'A' }] }] }
    expect(gatherUsedTools(project, lib).map((t) => t.id)).toEqual(['A', 'C'])
  })

  it('opening a shared project imports its tools and notifies once', async () => {
    // WO UI-11B alert() policy: this notice is now a console event + the
    // status-bar sketchNotice (non-blocking), not a blocking alert().
    // UI-85 (8202146b0) made loadProjectFromFile a transactional ASYNC action:
    // the tool-import notice is pushed after an await, so an unawaited call
    // observes sketchNotice still null. Await it.
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, sketchNotice: null })
    const file = makeProjectFile('proj-share', [makeTool('tool-B')])
    await state().loadProjectFromFile(file)
    expect(state().toolLibrary.map((t) => t.id)).toContain('tool-B')
    expect(alertSpy).not.toHaveBeenCalled()
    expect(state().sketchNotice).toContain('Imported 1 tool')
    const events = state().consoleEvents.filter((e) => e.source === 'tool')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ severity: 'success', message: expect.stringContaining('Imported 1 tool') })
  })

  it('opening a project whose tools you already have imports nothing and stays silent', async () => {
    state().addTool(makeTool('tool-B'))
    alertSpy.mockClear()
    // Same UI-85 async point as the case above. This one asserts ABSENCE, so an
    // unawaited call made it pass vacuously -- nothing had run yet. Await it,
    // and check the channel the notice would ACTUALLY use, not just alert():
    // a silent import that quietly pushed a footer notice would otherwise slip
    // through, which is exactly what this case exists to catch.
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, sketchNotice: null })
    await state().loadProjectFromFile(makeProjectFile('proj-share', [makeTool('tool-B')]))
    expect(alertSpy).not.toHaveBeenCalled()
    expect(state().sketchNotice).toBeNull()
    expect(state().consoleEvents.filter((e) => e.source === 'tool')).toHaveLength(0)
  })
})
