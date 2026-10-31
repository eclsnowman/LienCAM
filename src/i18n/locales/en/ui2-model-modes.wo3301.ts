// WO-3301: words of Form, Relief and Drawing as modes inside Model (New UI). Tool names, tips and the
// Drawings section reuse the catalogues the shipped panels already use; only the mode frame is new.
const ui2ModelModes = {
  groupModes: 'Modes',
  modeForm: 'Form',
  modeRelief: 'Relief',
  modeDrawing: 'Drawing',
  exitForm: 'Exit Form',
  exitRelief: 'Exit Relief',
  exitDrawing: 'Exit Drawing',
  groupFinish: 'Finish',
  groupHistory: 'History',
  groupDimension: 'Dimension',
  groupAnnotate: 'Annotate',
  groupSheet: 'Sheet',
  groupExport: 'Export',
  nothingToUndo: 'Nothing to undo',
  nothingToRedo: 'Nothing to redo',
} as const

export default ui2ModelModes

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-model-modes.wo3301': typeof ui2ModelModes
  }
}
