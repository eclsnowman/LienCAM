// WO-3301 (UI M2 W2-8): the commands of Form, Relief and Drawing mode. Each rail tool the Form and Relief
// sessions build, and each Drawing editor tool, is one command (`model.<mode>.<tool>`, camelCase); a press runs the same
// handler the shipped rail button runs, through the session the Model page publishes (see
// components/model3d/form/modePort). `model.enterMode.*` are the ids other lanes call (WO-3306 contract).
import { READY, type Availability, type CommandSpec } from '../../commands/types'
import type { MessageKey } from '../../notices/types'
import type { RailSection, RailTool } from '../../components/model3d/workbench/WorkbenchToolRail'
import { formModePort } from '../../components/model3d/form/formModePort'
import { reliefModePort } from '../../components/model3d/relief/reliefModePort'
import { useReliefStore } from '../../components/model3d/relief/reliefStore'
import {
  drawingEditorPort, drawingsModelPort, type DrawingExportKind, type DrawingToolId,
} from '../../components/model3d/drawing/drawingModePort'
import { commandIdOf, DRAWING_GROUPS, DXF_LOGO_TOOL, FORM_GROUPS, RELIEF_GROUPS, modeKey, type ToolRow } from './toolTable'

const LOADING_MODEL: Availability = { ready: false, reason: 'app-shell-settings-menus:App.loadingModel' as MessageKey }
const WAITING_SHEET: Availability = { ready: false, reason: 'technical-drawings:editor.waiting' }
const NOTHING_TO_UNDO: Availability = { ready: false, reason: modeKey('nothingToUndo') }
const NOTHING_TO_REDO: Availability = { ready: false, reason: modeKey('nothingToRedo') }
/** The sentence the Relief panel itself gives while no picture or face is set up. */
const RELIEF_NEEDS_FACE: Availability = { ready: false, reason: 'sketch-and-model-workbench:useReliefSession.clickAFlatFaceOnThePartToLay' }

function findTool(sections: readonly RailSection[], testId: string | undefined): RailTool | undefined {
  for (const section of sections) {
    const tool = section.tools.find(t => t.testId === testId)
    if (tool !== undefined) return tool
  }
  return undefined
}

type Port<S> = { get(): S | null }
function railCommand(mode: 'form' | 'relief', group: string, row: ToolRow, port: Port<{ railSections: RailSection[] }>): CommandSpec {
  const missing = (): Availability => (row.id === 'undo' ? NOTHING_TO_UNDO : row.id === 'redo' ? NOTHING_TO_REDO : mode === 'relief' ? RELIEF_NEEDS_FACE : LOADING_MODEL)
  return {
    id: commandIdOf(mode, row.id),
    labelKey: row.labelKey,
    place: 'model',
    group: `${mode}-${group}`,
    kind: row.kind,
    availability: () => {
      const session = port.get()
      if (session === null) return LOADING_MODEL
      const tool = findTool(session.railSections, row.testId)
      return tool === undefined || tool.disabled === true ? missing() : READY
    },
    run: () => { findTool(port.get()?.railSections ?? [], row.testId)?.onClick() },
    isOn: () => findTool(port.get()?.railSections ?? [], row.testId)?.active === true,
  }
}

function drawingCommand(group: string, row: ToolRow): CommandSpec {
  const editor = () => drawingEditorPort.get()
  const available = (): Availability => {
    const e = editor()
    if (e === null) return WAITING_SHEET
    switch (row.id) {
      case 'undo': return e.canUndo ? READY : NOTHING_TO_UNDO
      case 'redo': return e.canRedo ? READY : NOTHING_TO_REDO
      case 'export-pdf': case 'export-dxf': case 'export-dxf-logo': return e.hasSheet ? READY : WAITING_SHEET
      case 'size-letter': case 'size-a4': return e.hasSheet ? READY : WAITING_SHEET
      default: return READY
    }
  }
  const run = (): void => {
    const e = editor()
    if (e === null) return
    switch (row.id) {
      case 'undo': e.undo(); return
      case 'redo': e.redo(); return
      // the shipped size select does not fire for the size it already shows, so neither does this
      case 'size-letter': if (e.sheetChoice !== 'letter') e.changeSize('letter'); return
      case 'size-a4': if (e.sheetChoice !== 'a4') e.changeSize('a4'); return
      case 'export-pdf': case 'export-dxf': case 'export-dxf-logo': void e.exportSheet(row.id.slice('export-'.length) as DrawingExportKind); return
      default: e.chooseTool(row.id as DrawingToolId)
    }
  }
  const isOn = (): boolean => {
    const e = editor()
    if (e === null) return false
    if (row.id === 'size-letter') return e.sheetChoice === 'letter'
    if (row.id === 'size-a4') return e.sheetChoice === 'a4'
    return e.tool === row.id
  }
  return { id: commandIdOf('drawing', row.id), labelKey: row.labelKey, place: 'model', group: `drawing-${group}`, kind: row.kind, availability: available, run, isOn }
}

const wb = (key: string): MessageKey => `sketch-and-model-workbench:${key}` as MessageKey

/** Relief's Apply needs what its panel's Apply button needs: settings, a picture, a face, and nothing running. */
function reliefCanApply(): boolean {
  const s = useReliefStore.getState()
  return s.settings !== null && s.picture !== null && s.target !== null && !s.applying
}

function enterCommand(mode: 'form' | 'relief', port: Port<{ active: boolean; open(): void }>): CommandSpec {
  return {
    id: `model.enterMode.${mode}`,
    labelKey: modeKey(mode === 'form' ? 'modeForm' : 'modeRelief'),
    place: 'model',
    group: 'modes',
    kind: 'choice',
    availability: () => (port.get() === null ? LOADING_MODEL : READY),
    run: () => { const s = port.get(); if (s !== null && !s.active) s.open() },
    isOn: () => port.get()?.active === true,
  }
}

const enterDrawing: CommandSpec = {
  id: 'model.enterMode.drawing',
  labelKey: modeKey('modeDrawing'),
  place: 'model',
  group: 'modes',
  kind: 'choice',
  availability: () => {
    const m = drawingsModelPort.get()
    if (m === null) return LOADING_MODEL
    if (m.openId !== null || m.drawings.length > 0 || m.canCreate) return READY
    return { ready: false, reason: 'technical-drawings:entry.createNeedsBody' }
  },
  // open the item's first drawing; with none, make one from the selected (or only) body, as Create drawing does
  run: () => {
    const m = drawingsModelPort.get()
    if (m === null || m.openId !== null) return
    if (m.drawings.length > 0) m.open(m.drawings[0].id)
    else if (m.canCreate) m.create()
  },
  isOn: () => drawingEditorPort.get() !== null,
}

export const MODE_COMMANDS: readonly CommandSpec[] = [
  enterCommand('form', formModePort),
  enterCommand('relief', reliefModePort),
  enterDrawing,
  ...FORM_GROUPS.flatMap(g => g.tools.filter(t => t.offered !== false).map(t => railCommand('form', g.id, t, formModePort))),
  {
    id: 'model.form.finish', labelKey: wb('FormPanel.finishForm'), place: 'model', group: 'form-finish', kind: 'momentary',
    availability: () => (formModePort.get()?.active === true ? READY : LOADING_MODEL),
    run: () => { formModePort.get()?.finish() },
  },
  ...RELIEF_GROUPS.flatMap(g => g.tools.map(t => railCommand('relief', g.id, t, reliefModePort))),
  {
    id: 'model.relief.apply', labelKey: wb('ReliefPanel.applyRelief'), place: 'model', group: 'relief-finish', kind: 'momentary',
    availability: () => (reliefModePort.get() === null ? LOADING_MODEL : reliefCanApply() ? READY : RELIEF_NEEDS_FACE),
    run: () => { reliefModePort.get()?.apply() },
  },
  ...DRAWING_GROUPS.flatMap(g => g.tools.map(t => drawingCommand(g.id, t))),
  drawingCommand('export', DXF_LOGO_TOOL),
]
