// WO-3305 (UI M2 W2-12): sketch geometry as a toolpath input, registered for the New UI shell.
// A Toolpath ribbon group opens the Sketches window; the sync follows sketches in use. Nothing
// here replaces a hosted panel or the operation card's geometry pick: the sketch part's loops are
// picked there like any 2D layer.
import type { WorkspaceRegistration } from '../registry/types'
import { SketchInputDialog } from './SketchInputDialog'
import { SketchInputSync } from './SketchInputSync'
import { openSketchInput } from './state'

export const registration: WorkspaceRegistration = {
  owner: 'sketch-input',
  ribbonGroups: [{
    id: 'sketch-input.group',
    workspace: 'toolpath',
    order: 900,
    captionKey: 'ui2-sketch-input.wo3305:group',
    actions: [{ id: 'sketch-input.open', labelKey: 'ui2-sketch-input.wo3305:open', run: openSketchInput }],
  }],
  windows: [
    { id: 'sketch-input.window', Component: SketchInputDialog },
    { id: 'sketch-input.sync', Component: SketchInputSync },
  ],
}
