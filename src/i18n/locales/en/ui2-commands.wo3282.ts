// WO-3282: words for New UI command search (the search box at the right end of the tab row).
// Key names in shortcuts (Ctrl, Shift, G) are filled in by the app and stay English in every language.
const ui2Commands = {
  searchLabel: 'Search commands',
  placeholder: 'Type a command name or a shortcut',
  results: 'Commands',
  noMatch: 'No command matches "{{query}}".',
  notNow: 'Not available now',
  placeSetup: 'Setup',
  placeSketch: 'Sketch',
  placeModel: 'Model',
  placeToolpath: 'Toolpath',
  placeSimulate: 'Simulate',
  placeControl: 'Control',
  placeGlobal: 'Everywhere',
} as const

export default ui2Commands

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'ui2-commands.wo3282': typeof ui2Commands
  }
}
