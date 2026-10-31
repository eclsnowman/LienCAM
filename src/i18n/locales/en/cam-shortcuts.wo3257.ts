// WO-3257: remappable CAM shortcuts - the Settings editor, the Help map and the tooltip hints.
// Key letters (G, Shift+G, N, ...) are filled in by the app and stay English in every language.

const words = {
  section: 'Keyboard shortcuts',
  hint: 'Click a key box, then press the letter to use (hold Shift to include it). Enter applies, Escape cancels. These work in CAM outside Sketch, and not while you type in a field or a window is open.',
  actionSelected: 'Generate selected operation',
  actionAll: 'Generate all toolpaths',
  actionNewOperation: 'New operation',
  unassigned: 'Unassigned',
  apply: 'Apply',
  clear: 'Clear',
  restore: 'Restore',
  restoreAll: 'Restore all defaults',
  keyBoxLabel: 'Key for {{action}}',
  conflict: '{{key}} is already used by "{{action}}". Clear or change that one first.',
  mapHeading: 'Your CAM shortcuts',
  mapScope: 'Work in CAM, outside Sketch. Jog, transport, sketch, undo and delete keys are not part of this list.',
  mapTitle: 'LienCAM CAM keyboard shortcuts',
  mapScopeText: 'Scope: CAM, outside Sketch',
  download: 'Download printable CAM shortcut map',
  downloadName: 'liencam-cam-shortcuts.txt',
  computeToolpath: 'Compute toolpath ({{key}})',
  computeToolpathNone: 'Compute toolpath',
  regenerateAll: 'Regenerate all toolpaths ({{key}})',
  regenerateAllNone: 'Regenerate all toolpaths',
  addOperation: 'Add operation ({{key}})',
  addOperationNone: 'Add operation',
  computeRegenerate: "Compute (regenerate) this operation's toolpath ({{key}})",
  computeRegenerateNone: "Compute (regenerate) this operation's toolpath",
}

export default words

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'cam-shortcuts.wo3257': typeof words
  }
}
