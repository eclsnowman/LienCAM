// WO-3256: words for the optional Guided setup (units, machine, tools) opened
// from the startup Open picker and from Settings.
const guidedSetup = {
  title: 'Guided setup',
  intro: 'Three things most people look at before their first job. Each one opens the editor you already have, and you come back here when you close it.',
  openerButton: 'Guided setup',
  openerTooltip: 'Walk through units, machine and tools. Nothing is created or changed until you save in one of those editors.',
  settingsHeading: 'First-time setup',
  settingsHint: 'Units, machine and tools in one short list. Optional; open it whenever you like.',
  unitsTitle: 'Units',
  unitsSummary: 'Display units: {{display}}. G-code export units: {{export}}.',
  unitsNote: 'Display units and G-code export units are separate settings.',
  unitMm: 'millimetres (mm)',
  unitIn: 'inches (in)',
  unitsOpen: 'Open Settings',
  machineTitle: 'Machine',
  machineSummary: 'Project machine: {{name}}',
  machineNone: 'Project machine: none chosen yet',
  machineOpen: 'Open Machine Library',
  toolsTitle: 'Tools (optional)',
  toolsSummary: 'Tools in your library: {{count}}',
  toolsOpen: 'Open Tool Library',
  savedNote: 'Saved changes stay when you leave setup.',
  skip: 'Skip setup',
  continue: 'Continue to project',
  close: 'Close guided setup',
}

export default guidedSetup

declare module 'i18next' {
  interface ResourceNamespaceMap {
    'guided-setup.wo3256': typeof guidedSetup
  }
}
