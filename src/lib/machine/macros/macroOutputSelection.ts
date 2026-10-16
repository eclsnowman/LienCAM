import type { MachineOutputDefinition } from '../../../types'

// Labels may be duplicate or empty. Persist the selected definition's wiring,
// including polarity, rather than its position in the editable output list.
export function macroOutputSelection(output: MachineOutputDefinition): string {
  return JSON.stringify([output.name, output.onCode, output.offCode,
    output.pin.port, output.pin.pin, output.pin.negate === true])
}

export function selectedMacroOutput(
  outputs: readonly MachineOutputDefinition[], selection: string | undefined,
): MachineOutputDefinition | undefined {
  if (!selection) return undefined
  const exact = outputs.find(output => macroOutputSelection(output) === selection)
  if (exact) return exact
  // Preserve the initial optional-name format only when it is unambiguous.
  // Reordering duplicate labels must never redirect an existing selection.
  const named = outputs.filter(output => output.name === selection)
  return named.length === 1 ? named[0] : undefined
}

export function macroOutputLabel(output: MachineOutputDefinition, outputs: readonly MachineOutputDefinition[]): string {
  return output.name && outputs.filter(other => other.name === output.name).length === 1
    ? output.name
    : `${output.name} [${output.onCode} ${output.pin.port}:${output.pin.pin}${output.pin.negate ? ' !' : ''}]`
}
