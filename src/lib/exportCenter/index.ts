// WO-2448: the ONE Export window's model. Every row routes to the writer that
// already exists for its kind - nothing here writes a file format itself.
// Rows exist only when there is something to export; a group with no rows is
// not returned at all (owner ruling 2026-10-02: no disabled rows, no clutter).
import { create } from 'zustand'
import { useCamStore, exportSetupsText, SETUPS_EXPORT_FILENAME } from '../../store'
import { exportUserProfileText, USER_PROFILE_FILENAME } from '../../store/uiPrefs'
import { exportMachineMacro, parkCarrierMachine } from '../../store/machineActionsStore'
import { useFormStore } from '../../form/formStore'
import { modelExportFilename, saveFile } from '../saveFile'
import { saveGeometryOriginal, saveOriginalFile } from '../import/originalFile'
import { fontOriginalFile } from '../sketch/fontImport'
import { exportSketchDxf } from '../sketch/exportDxf'
import { stripSketchAnchors, strippedSketchHasUserContent } from '../sketch/sketchAnchors'
import type { Sketch } from '../sketch/types'
import { buildSheetExportModel, sheetToDxf, sheetToSvg, sheetExportFilename } from '../cam/nesting/sheetExport'
import { exportOperationToolpath } from '../../components/panels/exportOperationToolpath'
import { exportStockStl } from '../simulation/stockStl'
import type { HeightmapSimulator } from '../simulation/HeightmapSimulator'
import type { VoxelSimulator } from '../simulation/VoxelSimulator'
import { toolLibraryToCsv } from '../tools/toolLibraryCsv'
import { serializeHolderForFusion } from '../fusionImporter'
import { normalizeToolCutHand } from '../tool/cutHand'
import { machineDefinitionText, machineLibraryText } from '../machine/machineDefinitionExport'
import { resolveDeclaredController } from '../machine/machineChoice'
import { machineMacros } from '../machine/macros/macroRuntime'
import { parseUserPostConfig, serializeUserPostConfig, userPostDefinitionFilename } from '../post'
import { readRegisteredLocalData } from '../../store/persistedKeys'
import { originalVendorPostFile, type UserPostConfig } from '../post/userPostConfig'
import { bodyFeatureIds } from '../../components/model3d/bodyLineage'
import { isReferenceImagePayload } from '../../referenceImage/referenceImage'
import type { PostConfig } from '../post'
import type { MachineMacro, Tool, ToolHolder } from '../../types'

export interface ExportFormat { id: string; label: string }

export interface ExportRow {
  id: string
  name: string
  /** One entry = no format choice is shown. */
  formats: ExportFormat[]
  /** Routes to the existing writer. Resolves to null when the save was cancelled. */
  save(format: string): Promise<string | null | void>
}

export interface ExportGroup { id: string; label: string; rows: ExportRow[] }

type LiveStock = HeightmapSimulator | VoxelSimulator

interface ExportCenterState {
  /** The row the window opens on (a right-click names its item). */
  pickedRowId: string | null
  /** The live cut stock the Simulation panel has built, if any. */
  simulationStock: LiveStock | null
  /** The Macro editor's unsaved draft, so it exports without a machine-record save. */
  macroDraft: MachineMacro | null
}

export const useExportCenter = create<ExportCenterState>()(() => ({ pickedRowId: null, simulationStock: null, macroDraft: null }))

export const EXPORT_MODAL_ID = 'export'
export const MODEL_ROW_ID = 'model'

/** Opens the Export window, optionally on one row. */
export function openExportWindow(pickedRowId: string | null = null): void {
  useExportCenter.setState({ pickedRowId })
  useCamStore.getState().openModal(EXPORT_MODAL_ID)
}

/** The Simulation panel's live stock, published once its baseline is real (null on teardown). */
export function publishSimulationStock(sim: LiveStock | null): void {
  useExportCenter.setState({ simulationStock: sim })
}

/** The Macro editor's open draft, unsaved (null when no draft is open). */
export function publishMacroDraft(macro: MachineMacro | null): void {
  useExportCenter.setState({ macroDraft: macro })
}

/** Saved macros with the open draft laid over them: it replaces its saved twin, or joins as a new one. */
function macroRowsWithDraft(saved: MachineMacro[], draft: MachineMacro | null): MachineMacro[] {
  if (!draft) return saved
  return saved.some((m) => m.id === draft.id) ? saved.map((m) => (m.id === draft.id ? draft : m)) : [...saved, draft]
}

const fmt = (...ids: string[]): ExportFormat[] => ids.map((id) => ({ id, label: id.toUpperCase() }))
const safeStem = (name: string, fallback: string): string =>
  Array.from(name, (char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char))
    .join('').trim().replace(/[. ]+$/, '') || fallback

/** Same bytes the Tool Library's JSON export writes (tool + resolvable holder block). */
function toolJson(t: Tool, holders: readonly ToolHolder[]): Record<string, unknown> {
  const portableTool = { ...t, cutHand: normalizeToolCutHand(t.cutHand) }
  const h = t.holderId ? holders.find((x) => x.id === t.holderId) : undefined
  return h ? { ...portableTool, holder: serializeHolderForFusion(h) } : portableTool
}

/** Saved user posts, read the way the Post Process window reads them. */
function savedUserPosts(): UserPostConfig[] {
  try {
    const parsed: unknown = JSON.parse(readRegisteredLocalData('userPosts') ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((candidate) => {
      const result = parseUserPostConfig(JSON.stringify(candidate))
      return result.ok ? [result.config] : []
    })
  } catch {
    return []
  }
}

function postRow(config: PostConfig): ExportRow {
  const original = originalVendorPostFile(config)
  return {
    id: `post:${config.id}`,
    name: config.label,
    formats: original ? [{ id: 'json', label: 'JSON' }, { id: 'original', label: 'Original' }] : fmt('json'),
    save: (format) => {
      if (format === 'original' && original) return saveFile(original.filename, original.contents)
      return saveFile(userPostDefinitionFilename(config), serializeUserPostConfig(config), 'application/json')
    },
  }
}

/** True when `id` is a live body of the Model workspace's own document (the Export
 *  window's Model row writes that document). Demo/standalone trees get no entry. */
export function modelBodyExportable(dag: unknown, id: string): boolean {
  const hooks = typeof window === 'undefined' ? undefined : window.__solidsWorkbenchHooks
  return hooks !== undefined && (dag === undefined || hooks.dag === dag) && bodyFeatureIds(hooks.dag).includes(id)
}

/** The live Model workspace's visible bodies, exactly as its own export rail picks them. */
function modelRow(modelName: string): ExportRow | null {
  const hooks = typeof window === 'undefined' ? undefined : window.__solidsWorkbenchHooks
  if (!hooks) return null
  const ids = () => bodyFeatureIds(hooks.dag)
    .filter((id) => hooks.dag.getNode(id)?.hidden !== true && hooks.getBodyPresentationVisible(id) !== false)
  if (ids().length === 0) return null
  const kinds = {
    step: { write: hooks.exportStep, ext: 'step', mime: 'application/step' },
    stl: { write: hooks.exportStl, ext: 'stl', mime: 'model/stl' },
    '3mf': { write: hooks.export3mf, ext: '3mf', mime: 'model/3mf' },
  } as const
  return {
    id: MODEL_ROW_ID,
    name: modelName,
    formats: fmt('step', 'stl', '3mf'),
    save: async (format) => {
      const kind = kinds[format as keyof typeof kinds]
      const bytes = await kind.write(ids())
      const filename = kind.ext === '3mf' ? 'workbench-export.3mf' : modelExportFilename(useCamStore.getState().project.name, kind.ext)
      return saveFile(filename, new Blob([bytes], { type: kind.mime }), kind.mime)
    },
  }
}

/** A row captures one live body id, independently of tree/viewport selection. */
function modelBodyRows(): ExportRow[] {
  const hooks = typeof window === 'undefined' ? undefined : window.__solidsWorkbenchHooks
  if (!hooks?.getExportBodies) return []
  return hooks.getExportBodies().filter((body) => body.visible).map((body) => ({
    id: `model-body:${body.id}`,
    name: body.name,
    formats: body.mesh ? fmt('stl') : fmt('step', 'stl'),
    save: async (format) => {
      const step = format === 'step'
      const bytes = await (step ? hooks.exportStep([body.id]) : hooks.exportStl([body.id]))
      const name = hooks.getExportBodies?.().find((current) => current.id === body.id)?.name ?? body.name
      const filename = modelExportFilename(useCamStore.getState().project.name, step ? 'step' : 'stl', name)
      const mime = step ? 'application/step' : 'model/stl'
      return saveFile(filename, new Blob([bytes], { type: mime }), mime)
    },
  }))
}

/** Every exportable thing this session has, grouped. Empty groups are omitted. */
export function collectExportGroups(): ExportGroup[] {
  const cam = useCamStore.getState()
  const project = cam.project
  const groups: ExportGroup[] = []
  const add = (id: string, label: string, rows: (ExportRow | null | undefined | false)[]) => {
    const present = rows.filter((row): row is ExportRow => !!row)
    if (present.length > 0) groups.push({ id, label, rows: present })
  }

  add('project', 'Project', [
    {
      id: 'project', name: project.name, formats: [{ id: 'camproject', label: 'CAMPROJECT' }, { id: 'zip', label: 'ZIP' }],
      save: (format) => (format === 'zip' ? cam.exportProjectBundleToFile() : cam.saveProjectToFile()),
    },
    ...project.geometry
      .filter((geo) => geo.originalFile || geo.format === 'stl' || (geo.format === 'step' && !/\.(igs|iges)$/i.test(geo.filename)))
      .map((geo): ExportRow => ({
        id: `original:geo:${geo.id}`, name: geo.originalFile?.fileName ?? geo.filename, formats: fmt('original'),
        save: () => saveGeometryOriginal(geo),
      })),
    ...(project.referenceImages2d ?? []).filter(({ payload }) => !!payload.image.dataUrl)
      .map(({ id, payload }): ExportRow => ({
        id: `original:image:${id}`, name: payload.image.fileName, formats: fmt('original'),
        save: () => saveOriginalFile(payload.image),
      })),
    ...Object.entries(project.fonts ?? {}).map(([id, font]) => {
      const original = fontOriginalFile(font)
      return original && { id: `original:font:${id}`, name: original.fileName, formats: fmt('original'), save: () => saveOriginalFile(original) }
    }),
  ])

  const activeItem = (project.modelItems ?? []).find((item) => item.id === cam.activeModelItemId)
  // Model-workspace reference images live in its document, not in project.referenceImages2d.
  const modelHooks = typeof window === 'undefined' ? undefined : window.__solidsWorkbenchHooks
  const modelImageRows = (modelHooks?.dag.nodeIds() ?? []).flatMap((id): ExportRow[] => {
    const payload = modelHooks?.dag.getNode(id)?.payload
    if (!payload || !isReferenceImagePayload(payload) || !payload.image.dataUrl) return []
    return [{ id: `original:model-image:${id}`, name: payload.image.fileName, formats: fmt('original'), save: () => saveOriginalFile(payload.image) }]
  })
  add('model', 'Model', [modelRow(activeItem?.name ?? 'Model'), ...modelBodyRows(), ...modelImageRows])

  // A sketch's live draft is newer than its stored document; a sketch that has
  // never been finished has only the live draft, and still gets its row.
  const live = cam.activeSketch
  const liveOwner = live && (live.ownerGeometryId ?? project.geometry.find((geo) => geo.layers2d?.some((layer) => layer.id === live.layerId))?.id)
  const sketchRow = (geoId: string, layerId: string, stored: Sketch | null): ExportRow => {
    const geo = project.geometry.find((g) => g.id === geoId)
    const name = geo?.layers2d?.find((layer) => layer.id === layerId)?.name ?? 'Sketch'
    return {
      id: `sketch:${geoId}:${layerId}`, name, formats: fmt('dxf'),
      save: () => {
        const current = useCamStore.getState().activeSketch
        const isLive = current && current.layerId === layerId && (current.ownerGeometryId ?? geoId) === geoId
        // A draft finished after the window opened is read back from the project.
        const doc = isLive ? current : stored ?? useCamStore.getState().project.geometry
          .find((g) => g.id === geoId)?.sketches?.find((sk) => sk.layerId === layerId)
        if (!doc) return Promise.resolve(null)
        return saveFile(`${safeStem(name, 'Sketch')}.dxf`, exportSketchDxf(doc), 'application/dxf')
      },
    }
  }
  const storedRows = project.geometry.flatMap((geo) => (geo.sketches ?? []).map((sketch) => sketchRow(geo.id, sketch.layerId, sketch)))
  const liveRowMissing = live && liveOwner && strippedSketchHasUserContent(stripSketchAnchors(live))
    && !storedRows.some((row) => row.id === `sketch:${liveOwner}:${live.layerId}`)
  add('sketches', 'Sketches', [...storedRows, liveRowMissing ? sketchRow(liveOwner, live.layerId, null) : null])

  add('toolpaths', 'Toolpaths', project.setups.flatMap((setup) => setup.operations.map((op): ExportRow => ({
    id: `toolpath:${setup.id}:${op.id}`, name: op.name, formats: fmt('dxf', 'svg'),
    save: (format) => exportOperationToolpath(setup.id, op.id, format as 'dxf' | 'svg'),
  }))))

  add('nesting', 'Nesting', (project.nests ?? [])
    .filter((rec) => (rec.status ?? (rec.placements.length > 0 ? 'ready' : 'computing')) === 'ready')
    .map((rec): ExportRow => ({
      id: `nest:${rec.id}`, name: rec.name, formats: fmt('dxf', 'svg'),
      save: (format) => {
        const ext = format === 'svg' ? 'svg' : 'dxf'
        const model = buildSheetExportModel(rec, useCamStore.getState().project.geometry)
        return saveFile(sheetExportFilename(rec.name, ext), ext === 'dxf' ? sheetToDxf(model) : sheetToSvg(model),
          ext === 'dxf' ? 'application/dxf' : 'image/svg+xml')
      },
    })))

  const stock = useExportCenter.getState().simulationStock
  add('simulation', 'Simulation', [stock && { id: 'simulation', name: 'Stock', formats: fmt('stl'), save: () => exportStockStl(stock) }])

  const form = useFormStore.getState()
  add('form', 'Form', [form.active && { id: 'form', name: form.name || 'Form', formats: fmt('obj'), save: () => useFormStore.getState().exportCageObj() }])

  add('setups', 'Setups', [project.setups.length > 0 && {
    id: 'setups', name: SETUPS_EXPORT_FILENAME, formats: fmt('json'),
    save: () => saveFile(SETUPS_EXPORT_FILENAME, exportSetupsText(useCamStore.getState().project), 'application/json'),
  }])

  const declared = resolveDeclaredController(project.machine)
  const machinePost = declared.ok ? declared.dialect : null
  const parkMachine = parkCarrierMachine(cam)
  add('libraries', 'Libraries', [
    cam.toolLibrary.length > 0 && {
      id: 'tools', name: 'Tools', formats: fmt('csv', 'json'),
      save: (format) => {
        const { toolLibrary, holders } = useCamStore.getState()
        return format === 'csv'
          ? saveFile('tool_library.csv', toolLibraryToCsv(toolLibrary, holders), 'text/csv')
          : saveFile('tool_library.json', JSON.stringify(toolLibrary.map((t) => toolJson(t, holders)), null, 2), 'application/json')
      },
    },
    ...(cam.toolLibraries ?? []).map((lib): ExportRow | false => cam.toolLibrary.some((t) => t.libraryId === lib.id) && {
      id: `tools:${lib.id}`, name: `Tools - ${lib.name}`, formats: fmt('csv', 'json'),
      save: (format) => {
        const { toolLibrary, holders } = useCamStore.getState()
        const tools = toolLibrary.filter((t) => t.libraryId === lib.id)
        const stem = lib.name.replace(/\s+/g, '_')
        return format === 'csv'
          ? saveFile(`${stem}.csv`, toolLibraryToCsv(tools, holders), 'text/csv')
          : saveFile(`${stem}.json`, JSON.stringify(tools.map((t) => toolJson(t, holders)), null, 2), 'application/json')
      },
    }),
    {
      id: 'machine', name: project.machine.name, formats: fmt('json'),
      save: () => saveFile(`${project.machine.name.replace(/\s+/g, '_')}.machine.json`, machineDefinitionText(project.machine), 'application/json'),
    },
    cam.machineLibrary.length > 0 && {
      id: 'machine-library', name: 'Machines', formats: fmt('json'),
      save: () => saveFile('machine_library.json', machineLibraryText(useCamStore.getState().machineLibrary), 'application/json'),
    },
    machinePost && postRow(machinePost),
    ...savedUserPosts().filter((post) => post.id !== machinePost?.id).map(postRow),
    ...macroRowsWithDraft(machineMacros(parkMachine), useExportCenter.getState().macroDraft).map((macro): ExportRow => ({
      id: `macro:${macro.id}`, name: macro.name, formats: fmt('json', 'txt'),
      save: (format) => exportMachineMacro(macro, format === 'txt' ? 'txt' : 'json'),
    })),
  ])

  add('settings', 'Settings', [{
    id: 'settings', name: USER_PROFILE_FILENAME, formats: fmt('json'),
    save: () => saveFile(USER_PROFILE_FILENAME, exportUserProfileText(useCamStore.getState().appSettings), 'application/json'),
  }])

  return groups
}
