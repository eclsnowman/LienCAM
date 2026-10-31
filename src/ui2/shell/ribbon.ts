// WO-3285 (UI M2 W1-H), WO-3306: the shell's own ribbon table: what the ribbon offers in each
// workspace. Every action is a store action or window the shipped UI already has, so a press does
// what the same press does today. WO-3306 made this table the registry's first registration
// (../registry/builtin.ts); a lane that takes a group over names it in `replaces`.
import { askBeforeReplacingProject, useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { openExportWindow } from '../../lib/exportCenter'
import { browseProject } from '../../lib/projectOpen/actions'
import { useProjectPicker } from '../../lib/projectOpen/picker'
import type { RibbonGroupRegistration } from '../registry/types'

const open = (id: string) => () => useCamStore.getState().openModal(id)

async function newProject(): Promise<void> {
  if (await askBeforeReplacingProject('new')) useCamStore.getState().newProject()
}

function openProject(): void {
  if (!useUiPrefs.getState().projectOpenDirectly) { useProjectPicker.getState().show(); return }
  void browseProject().catch((error: unknown) => {
    useCamStore.getState().addConsoleEvent({ source: 'project', severity: 'error', message: String(error) })
  })
}

const text = (key: string) => `ui2-shell.wo3285:${key}` as const

// Orders leave room between the groups for the lanes' own: Project 100, then each workspace's
// own group at 200, Output at 900.
const PROJECT: RibbonGroupRegistration = {
  id: 'project',
  workspace: ['setup', 'sketch', 'model', 'toolpath', 'simulate'],
  order: 100,
  captionKey: text('groupProject'),
  actions: [
    { id: 'new', labelKey: text('actNew'), run: () => void newProject() },
    { id: 'open', labelKey: text('actOpen'), run: openProject },
    { id: 'save', labelKey: text('actSave'), run: () => void useCamStore.getState().saveProjectToFile() },
    { id: 'export', labelKey: text('actExport'), run: () => openExportWindow() },
  ],
}

const OUTPUT: RibbonGroupRegistration = {
  id: 'output',
  workspace: ['toolpath', 'simulate'],
  order: 900,
  captionKey: text('groupOutput'),
  actions: [{ id: 'post', labelKey: text('actPost'), run: open('post-process') }],
}

export const SHELL_RIBBON_GROUPS: readonly RibbonGroupRegistration[] = [
  PROJECT,
  {
    id: 'setup', workspace: 'setup', order: 200, captionKey: text('groupSetup'),
    actions: [
      { id: 'new-setup', labelKey: text('actNewSetup'), run: open('new-setup') },
      { id: 'machine', labelKey: text('actMachine'), run: open('machine-config') },
      { id: 'nest', labelKey: text('actNest'), run: open('new-nest') },
    ],
  },
  {
    id: 'sketch', workspace: 'sketch', order: 200, captionKey: text('groupSketch'),
    actions: [{ id: 'edit-sketch', labelKey: text('actEditSketch'), run: () => useCamStore.getState().enterSketchWorkspace() }],
  },
  {
    id: 'model', workspace: 'model', order: 200, captionKey: text('groupModel'),
    actions: [{ id: 'new-model', labelKey: text('actNewModel'), run: open('new-model') }],
  },
  {
    id: 'toolpath', workspace: 'toolpath', order: 200, captionKey: text('groupToolpath'),
    actions: [{ id: 'new-operation', labelKey: text('actNewOperation'), run: open('new-operation') }],
  },
  OUTPUT,
]
