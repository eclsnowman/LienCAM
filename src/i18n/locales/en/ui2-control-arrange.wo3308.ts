// WO-3308: words of Control Arrange mode and saved layouts.
const ui2ControlArrange = {
  arrange: 'Arrange',
  layout: 'Layout',
  layoutMenu: 'Layout menu',
  windowTitle: 'Arrange modules',
  done: 'Done',
  columnLeft: 'Left',
  columnCentre: 'Centre',
  columnRight: 'Right',
  column: 'Column',
  show: 'Show',
  moveUp: 'Move up',
  moveDown: 'Move down',
  locked: 'Locked',
  lockedNote: 'Locked parts stay where they are: they cannot be moved, hidden or turned off.',
  grip: 'Drag {{name}}',
  moduleOff: 'Off',
  layouts: 'Saved layouts',
  layoutName: 'Layout name',
  saveAs: 'Save as',
  save: 'Save',
  rename: 'Rename',
  delete: 'Delete',
  resetDefault: 'Back to Run layout',
  defaultName: 'Run',
  changed: 'changed',
  pick: 'Layout',
  stateChip: 'State chip',
  runSection: 'Run section',
  moduleMachine: 'Machine',
  modulePosition: 'Position',
  moduleOffsets: 'Work offsets',
  moduleTool: 'Tool',
  moduleProgram: 'Program',
  moduleConsole: 'Console',
  moduleJog: 'Jog',
  moduleOverrides: 'Overrides',
  moduleSpindle: 'Spindle and coolant',
  moduleMacros: 'Macros',
  moduleCycleLog: 'Cycle log',
  moduleSimulatedPart: 'Simulated part',
} as const

export default ui2ControlArrange

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-control-arrange.wo3308': typeof ui2ControlArrange
  }
}
