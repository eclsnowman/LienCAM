// WO-3301 (UI M2 W2-8): Form, Relief and Drawing as modes inside Model. A Modes group in the Model ribbon enters
// each; while a mode is active the ribbon shows only its groups and Exit (the registry draws Exit from the mode's
// exitLabelKey). There is no Form, Relief or Drawing tab. The Drawings section joins the Model Browser.
// Registered through the local stub of the WO-3306 contract; the one-line switch is the import below.
import type {
  BrowserSectionRegistration, ModeRegistration, RibbonGroupRegistration, WorkspaceRegistration,
} from '../registry'
import { formModePort } from '../../components/model3d/form/formModePort'
import { reliefModePort } from '../../components/model3d/relief/reliefModePort'
import { drawingsModelPort } from '../../components/model3d/drawing/drawingModePort'
import { MODE_COMMANDS } from './commands'
import { DrawingsSection } from './DrawingsSection'
import { ModeSync } from './ModeSync'
import { GROUPS_BY_MODE, commandIdOf, MODE_IDS, modeKey, type ModeId } from './toolTable'

const cap = (id: string) => `${id[0].toUpperCase()}${id.slice(1)}`

const modes: readonly ModeRegistration[] = [
  {
    id: 'form', workspace: 'model', labelKey: modeKey('modeForm'), exitLabelKey: modeKey('exitForm'),
    onExit: () => { const s = formModePort.get(); if (s?.active === true) s.cancel() },
  },
  {
    id: 'relief', workspace: 'model', labelKey: modeKey('modeRelief'), exitLabelKey: modeKey('exitRelief'),
    onExit: () => { const s = reliefModePort.get(); if (s?.active === true) s.cancel() },
  },
  {
    id: 'drawing', workspace: 'model', labelKey: modeKey('modeDrawing'), exitLabelKey: modeKey('exitDrawing'),
    onExit: () => { drawingsModelPort.get()?.close() },
  },
]

/** Finish first (Form's Finish Form, Relief's Apply), then the mode's tool groups in the shipped rail's order. */
function modeGroups(mode: ModeId): readonly RibbonGroupRegistration[] {
  const groups = GROUPS_BY_MODE[mode].filter(g => g.tools.some(t => t.offered !== false)).map((g, i): RibbonGroupRegistration => ({
    id: `${mode}-${g.id}`, workspace: 'model', order: 100 + i * 10, captionKey: g.captionKey, mode,
    actions: g.tools.filter(t => t.offered !== false).map(t => ({ id: t.id, labelKey: t.labelKey, commandId: commandIdOf(mode, t.id) })),
  }))
  if (mode === 'drawing') return groups
  const finish = mode === 'form'
    ? { id: 'finish', labelKey: 'sketch-and-model-workbench:FormPanel.finishForm' as const, commandId: 'model.form.finish' as const }
    : { id: 'apply', labelKey: 'sketch-and-model-workbench:ReliefPanel.applyRelief' as const, commandId: 'model.relief.apply' as const }
  return [...groups, { id: `${mode}-finish`, workspace: 'model', order: 0, captionKey: modeKey('groupFinish'), mode, actions: [finish] }]
}

const modesGroup: RibbonGroupRegistration = {
  id: 'modes', workspace: 'model', order: 900, captionKey: modeKey('groupModes'),
  actions: MODE_IDS.map(id => ({ id, labelKey: modeKey(`mode${cap(id)}`), commandId: `model.enterMode.${id}` as const })),
}

const drawingsSection: BrowserSectionRegistration = {
  id: 'drawings', workspace: 'model', order: 800, titleKey: 'technical-drawings:entry.section', Component: DrawingsSection,
}

export const registration: WorkspaceRegistration = {
  owner: 'model-modes',
  ribbonGroups: [modesGroup, ...MODE_IDS.flatMap(modeGroups)],
  modes,
  browserSections: [drawingsSection],
  windows: [{ id: 'model-modes-sync', Component: ModeSync }],
  commands: MODE_COMMANDS,
}
