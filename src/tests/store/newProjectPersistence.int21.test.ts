import { beforeEach, describe, expect, it } from 'vitest'
import { persistMerge, persistPartialize, useCamStore } from '../../store'
import type {
  AppSettings,
  ImportedGeometry,
  MachineConfig,
  Tool,
  ToolHolder,
  ToolLibrary,
} from '../../types'
import type { ImportedFontRecord } from '../../lib/sketch/fontImport'

const machine = {
  id: 'int21-machine',
  name: 'LienCNC Router',
  type: 'gantry_router',
  controller: 'grbl',
  travel: { x: 1200, y: 800, z: 180 },
  rapidRate: 7000,
  maxSpindleRpm: 24000,
  minSpindleRpm: 8000,
  spindleDirection: 'cw',
  toolChanger: 'manual',
  coolant: false,
  notes: 'persistent machine',
} as MachineConfig

const library = { id: 'int21-library', name: 'Router Tools' } as ToolLibrary
const holder = {
  id: 'int21-holder',
  name: 'ER20',
  segments: [{ height: 30, lowerDiameter: 32, upperDiameter: 32 }],
} as ToolHolder
const tool = {
  id: 'int21-tool',
  libraryId: library.id,
  holderId: holder.id,
  name: '6mm End Mill',
  type: 'flat_endmill',
  diameter: 6,
  fluteLength: 18,
  shankDiameter: 6,
  overallLength: 55,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {
    default: {
      rpm: 18000,
      feedRate: 1200,
      plungeRate: 300,
      depthOfCut: 3,
      stepover: 2.4,
    },
  },
} as unknown as Tool
const font = {
  family: 'INT21 Font',
  fileName: 'int21-font.json',
  typeface: { glyphs: {} },
} as unknown as ImportedFontRecord

const oldGeometry = {
  id: 'int21-old-geometry',
  name: 'Old project geometry',
  filename: 'old-project.dxf',
  type: 'curves_2d',
  format: 'dxf',
  boundingBox: {
    min: { x: 10, y: 20, z: 0 },
    max: { x: 30, y: 40, z: 0 },
    size: { x: 20, y: 20, z: 0 },
    center: { x: 20, y: 30, z: 0 },
  },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  loaded: true,
  loops: [],
} as ImportedGeometry

describe('INT-21 New Project user-data boundary', () => {
  beforeEach(() => {
    useCamStore.setState((state) => ({
      project: { ...state.project, geometry: [], setups: [] },
      machineLibrary: [machine],
      toolLibrary: [tool],
      toolLibraries: [library],
      holders: [holder],
      importedFonts: [font],
      appSettings: {
        ...state.appSettings,
        defaultMachineId: machine.id,
        displayUnits: 'inch',
        projectionToleranceDefault: 0.1,
      },
      activeSketch: null,
      projectHistory: [],
      sketchHistory: [],
      projectFuture: [],
      sketchFuture: [],
      canUndo: false,
      canRedo: false,
      sketchEntrySnapshot: null,
    }))
  })

  it('clears project data while preserving every browser-persistent user asset', () => {
    const before = useCamStore.getState()
    const persistentRefs = {
      machineLibrary: before.machineLibrary,
      toolLibrary: before.toolLibrary,
      toolLibraries: before.toolLibraries,
      holders: before.holders,
      appSettings: before.appSettings,
      importedFonts: before.importedFonts,
    }

    before.newProject()

    const after = useCamStore.getState()
    expect(after.machineLibrary).toBe(persistentRefs.machineLibrary)
    expect(after.toolLibrary).toBe(persistentRefs.toolLibrary)
    expect(after.toolLibraries).toBe(persistentRefs.toolLibraries)
    expect(after.holders).toBe(persistentRefs.holders)
    expect(after.appSettings).toBe(persistentRefs.appSettings)
    expect(after.importedFonts).toBe(persistentRefs.importedFonts)
    expect(after.project.machine).toEqual(machine)
    expect(after.project.machine).not.toBe(machine)
    expect(after.project.geometry).toEqual([])
    expect(after.project.setups).toEqual([])

    const persisted = persistPartialize(after)
    expect(persisted.machineLibrary).toEqual([machine])
    expect(persisted.toolLibrary).toEqual([tool])
    expect(persisted.toolLibraries).toEqual([library])
    expect(persisted.holders).toEqual([holder])
    expect(persisted.appSettings).toEqual(persistentRefs.appSettings as AppSettings)
    expect(persisted.importedFonts).toEqual([font])
  })

  it('writes and rehydrates every browser-persistent user asset', () => {
    const live = useCamStore.getState()
    const written = JSON.parse(JSON.stringify(persistPartialize(live))) as unknown
    const coldState = {
      ...live,
      machineLibrary: [],
      toolLibrary: [],
      toolLibraries: [],
      holders: [],
      appSettings: { ...live.appSettings, defaultMachineId: null, displayUnits: 'mm' as const },
      importedFonts: [],
    }

    const rehydrated = persistMerge(written, coldState)

    expect(rehydrated.machineLibrary).toEqual([machine])
    // Rehydrate intentionally normalizes legacy tools (for example, backfilling
    // cutHand). The authored tool fields must all survive that migration.
    expect(rehydrated.toolLibrary).toMatchObject([tool])
    expect(rehydrated.toolLibraries).toEqual([library])
    expect(rehydrated.holders).toEqual([holder])
    expect(rehydrated.appSettings).toEqual(live.appSettings)
    expect(rehydrated.importedFonts).toEqual([font])
  })

  it('starts a fresh undo domain that cannot restore the previous project', () => {
    const state = useCamStore.getState()
    const oldProject = {
      ...state.project,
      id: 'int21-old-project',
      geometry: [oldGeometry],
    }
    const oldFutureProject = {
      ...oldProject,
      id: 'int21-old-future-project',
    }

    useCamStore.setState({
      project: oldProject,
      projectHistory: [structuredClone(oldProject)],
      sketchHistory: [null],
      projectFuture: [structuredClone(oldFutureProject)],
      sketchFuture: [null],
      canUndo: true,
      canRedo: true,
      sketchEntrySnapshot: {
        project: structuredClone(oldProject),
        projectHistory: [structuredClone(oldProject)],
        sketchHistory: [null],
        projectFuture: [structuredClone(oldFutureProject)],
        sketchFuture: [null],
        lastNonSketchMode: state.lastNonSketchMode,
      },
    })

    useCamStore.getState().newProject()

    const fresh = useCamStore.getState()
    const freshProjectId = fresh.project.id
    expect(freshProjectId).not.toBe(oldProject.id)
    expect(fresh.project.geometry).toEqual([])
    expect(fresh.projectHistory).toEqual([])
    expect(fresh.sketchHistory).toEqual([])
    expect(fresh.projectFuture).toEqual([])
    expect(fresh.sketchFuture).toEqual([])
    expect(fresh.canUndo).toBe(false)
    expect(fresh.canRedo).toBe(false)
    expect(fresh.sketchEntrySnapshot).toBeNull()

    fresh.undo()
    expect(useCamStore.getState().project.id).toBe(freshProjectId)
    expect(useCamStore.getState().project.geometry).toEqual([])

    useCamStore.getState().redo()
    expect(useCamStore.getState().project.id).toBe(freshProjectId)
    expect(useCamStore.getState().project.geometry).toEqual([])
  })
})
