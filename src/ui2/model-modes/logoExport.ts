// WO-3301: the DXF + logo button. The shipped editor draws it only when the sheet has a logo, so the ribbon does
// the same: ModeSync registers this group while the open sheet has one and withdraws it when it has none.
import type { WorkspaceRegistration } from '../registry'
import { commandIdOf, DXF_LOGO_TOOL, modeKey } from './toolTable'

export const logoExportRegistration: WorkspaceRegistration = {
  owner: 'model-modes-logo',
  // order 131: right after the Export group (130) and before History (140)
  ribbonGroups: [{
    id: 'drawing-export-logo', workspace: 'model', order: 131, captionKey: modeKey('groupExport'), mode: 'drawing',
    actions: [{ id: DXF_LOGO_TOOL.id, labelKey: DXF_LOGO_TOOL.labelKey, commandId: commandIdOf('drawing', DXF_LOGO_TOOL.id) }],
  }],
}
