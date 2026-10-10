import type { MachineConfig } from '../../types'

// The text the Machine Library's "Export" and "Export All" buttons download.
// Plain JSON, described by docs/formats/machine-definition.schema.json
// (ADR-0057: your data always leaves with you). The modal and the schema test
// both call these, so the file the test validates is the file the buttons write.

/** One machine: `<name>.machine.json`. */
export function machineDefinitionText(machine: MachineConfig): string {
  return JSON.stringify(machine, null, 2)
}

/** The whole library: `machine_library.json`, an array of machines. */
export function machineLibraryText(library: MachineConfig[]): string {
  return JSON.stringify(library, null, 2)
}
