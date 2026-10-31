// WO-3306: the shell's own table as the registry's first registration. The ribbon groups are
// ../shell/ribbon.ts (today's actions, unchanged); the Show rows are the six viewer flags the
// shipped overlay toggled.
import { useCamStore } from '../../store'
import { SHELL_RIBBON_GROUPS } from '../shell/ribbon'
import { SHELL_OWNER } from './registry'
import type { ShowRowRegistration, Workspace, WorkspaceRegistration } from './types'

type Flag = 'showStock' | 'showWorkpiece' | 'showToolpath' | 'showMachine' | 'showGrid' | 'showAxes'
const SHOW_ROWS = [
  ['showStock', 'showStock'], ['showWorkpiece', 'showModel'], ['showToolpath', 'showToolpath'],
  ['showMachine', 'showMachine'], ['showGrid', 'showGrid'], ['showAxes', 'showAxes'],
] as const satisfies readonly (readonly [Flag, string])[]

/** The tabs the shipped overlay drew on: the CAM modes (Model and Control have their own bodies). */
const CAM_TABS: readonly Workspace[] = ['setup', 'sketch', 'toolpath', 'simulate']

const showRows: readonly ShowRowRegistration[] = SHOW_ROWS.map(([flag, key], i) => ({
  id: flag,
  workspace: CAM_TABS,
  order: (i + 1) * 100,
  labelKey: `ui2-shell.wo3285:${key}` as const,
  isOn: state => state.viewer[flag],
  toggle: () => useCamStore.getState().toggleViewerFlag(flag),
}))

export const shellRegistration: WorkspaceRegistration = {
  owner: SHELL_OWNER,
  ribbonGroups: SHELL_RIBBON_GROUPS,
  showRows,
}
