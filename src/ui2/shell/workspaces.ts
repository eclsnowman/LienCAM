// WO-3285 (UI M2 W1-H): the workspace tabs. Six flat tabs, one click apart, number keys 1 to 6
// (spec 5). Each tab drives the same store action as the shipped tab strip, so the same click
// gives the same result; the New UI adds no state of its own here.
import { WORKSPACES, type Workspace as WorkspaceId } from '../../commands'
import { useCamStore } from '../../store'
import { carryModelBodySelectionToCam } from '../../store/modelSelectionHandoff'
import type { Workspace } from '../../types'

/** The six tabs, in order: the command contract's list, so the ribbon and the registry agree. */
export const WORKSPACE_IDS = WORKSPACES
export type { WorkspaceId }

export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return (WORKSPACE_IDS as readonly unknown[]).includes(value)
}

/** Which tab is lit, from the store: Control and Model are workspaces, the rest are CAM modes. */
export function workspaceIdFor(workspace: Workspace, viewerMode: string): WorkspaceId {
  if (workspace === 'control') return 'control'
  if (workspace === 'part') return 'model'
  switch (viewerMode) {
    case 'sketch': return 'sketch'
    case 'toolpath': return 'toolpath'
    case 'simulation': return 'simulate'
    default: return 'setup'
  }
}

export function useActiveWorkspaceId(): WorkspaceId {
  const workspace = useCamStore(s => s.workspace)
  const mode = useCamStore(s => s.viewer.mode)
  return workspaceIdFor(workspace, mode)
}

/** Enter a workspace exactly as the shipped tab strip does. Model first offers New model; the
 *  workspace changes when that is confirmed, so dismissing it leaves everything as it was. */
export function enterWorkspace(id: WorkspaceId): void {
  const s = useCamStore.getState()
  if (id === 'model') { s.openModal('new-model'); return }
  if (id === 'control') { s.setWorkspace('control'); return }
  if (s.workspace !== 'cam') {
    const fromModel = s.workspace === 'part'
    s.setWorkspace('cam')
    if (fromModel) carryModelBodySelectionToCam()
  }
  if (id === 'sketch') { useCamStore.getState().enterSketchWorkspace(); return }
  s.setViewerMode(id === 'simulate' ? 'simulation' : id)
}
