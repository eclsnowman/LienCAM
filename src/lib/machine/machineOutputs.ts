/**
 * ONE LIST, ONE RESOLVER, AND IT KNOWS NO CONTROLLER (WO-1649).
 *
 * Operator ruling 2026-09-17: "They define the pins. They point them at the use cases
 * like a pump or a vacuum or whatever they want to run in the macro and it
 * works." AND: "My machine is just the test bed. This needs to be able to be
 * used by anyone, and their machine and settings are apt to be different. But
 * it still has to work."
 *
 * WHY THIS FILE EXISTS RATHER THAN THE FUNCTION STAYING WHERE WO-1637 PUT IT.
 * The resolver lived inside `uccncProfileImport.ts` and read UCCNC setting
 * names - `Spindlesetupsettings.M8relaypin`, `Floodmistrelaysenabled`,
 * `M9delay`. Every route that switches a pin therefore went through a UCCNC
 * importer, and a GRBL or hand-made machine could state a pump it could never
 * state flood beside. The profile is now READ ONCE, at import, into the
 * machine definition's one output list (`uccncProfileOutputs`); this file reads
 * THAT LIST and nothing else. A second controller's importer fills the same
 * list, and nothing here changes.
 *
 * WHAT THE LIST DECIDES, AND THEREFORE WHAT IS NOT DECIDED HERE:
 *   - which words switch something on this machine (`onCode` / `offCode`);
 *   - which pin each one switches, with its polarity, carried from the
 *     definition and never computed - the bridge's one board table translates
 *     it;
 *   - how long motion waits afterwards (`onDelayMs`, `offDelayMs`).
 *
 * THE ONE RULE THAT IS NOT PER-ENTRY is the shared off word. M9 stops coolant
 * and accessories on every dialect this product speaks, so it stops every
 * output in the list that is not switched BESIDE a controller word of its own
 * (`besideWord` - a relay on the spindle's M3/M4/M5, which M5 stops).
 */

import type {
  CoolantChannel,
  MachineConfig,
  MachineMCode,
  MachineOutputDefinition,
  PinRef,
} from '../../types'

/** The word that stops coolant and accessories. Standard on every dialect this
 *  product speaks, which is why it is the one word the list does not have to
 *  state on each entry. */
export const SHARED_OFF_CODE: MachineMCode = 'M9'

/** One pin to switch, carried as the definition names it. */
export interface MachineOutputSwitch {
  /** What the operator calls it, for the console line. */
  name: string
  pin: PinRef
  on: boolean
  /** Motion waits this long after the switch, as the definition says. */
  delayMs: number
}

export type MachineOutputResolution =
  | { kind: 'switch'; word: MachineMCode; switches: MachineOutputSwitch[] }
  /** The word is a use case this machine names, but no pin is assigned to it:
   *  `setting` is what the operator fills in. */
  | { kind: 'unassigned'; word: MachineMCode; name: string; setting: string }

/** WO-1649: everything the resolver reads. One container, by design. */
export type OutputMachine = Pick<MachineConfig, 'controllerDefinition'>

/** This machine's one list of outputs. Absent and empty are the same answer. */
export function machineOutputList(
  machine: OutputMachine | null | undefined,
): readonly MachineOutputDefinition[] {
  return machine?.controllerDefinition?.outputs ?? []
}

/** The listed output that IS this channel, or null. */
export function machineOutputWithRole(
  machine: OutputMachine | null | undefined,
  role: CoolantChannel,
): MachineOutputDefinition | null {
  return machineOutputList(machine).find((output) => output.role === role) ?? null
}

/** A pin the definition actually names. Port and pin both count from 1, so a
 *  zero in either is "nobody has filled this in". */
export const outputPinAssigned = (pin: PinRef): boolean => pin.port > 0 && pin.pin > 0

/** An output its word actually switches: a pin assigned AND not switched off.
 *  WO-1703: a `disabled` output answers exactly as an unassigned one did when
 *  the importer used to blank its pin - the resolver's behaviour for a relay
 *  UCCNC is told not to switch is unchanged; only the real pin is kept. */
export const outputSwitches = (
  output: MachineOutputDefinition,
  outputs: readonly MachineOutputDefinition[] = [output],
): boolean => !outputTurnedOff(output, outputs) && outputPinAssigned(output.pin)

/**
 * WO-1703 fix round 3: IS THIS OUTPUT SWITCHED OFF, ANSWERED AS THE CONTROLLER
 * ANSWERS IT. An entry with no `sharedSwitch` is its own switch. Entries that
 * share one (UCCNC's M7+M8 behind the single `Floodmistrelaysenabled`) are off
 * only when EVERY member is off - the controller gets one flag, the export
 * writes True unless all are off, and True switches both. So a record that is
 * somehow mixed resolves both relays as on, the way the machine would.
 */
export function outputTurnedOff(
  output: MachineOutputDefinition,
  outputs: readonly MachineOutputDefinition[],
): boolean {
  if (output.sharedSwitch === undefined) return output.disabled === true
  return outputs
    .filter((o) => o.sharedSwitch === output.sharedSwitch)
    .every((o) => o.disabled === true)
}

/** What the operator fills in, said in the definition's own words rather than
 *  any controller's setting names. */
const pinSetting = (name: string): string =>
  `the pin of the "${name}" output in the machine definition`

/** Why one word can name several outputs and how each one was named. `own` is
 *  the word the entry itself states; the shared off word names an entry
 *  without the entry mentioning it. */
interface OutputHit {
  output: MachineOutputDefinition
  on: boolean
  own: boolean
}

/**
 * The pins `M<code>` switches on this machine, or null when the word is not an
 * output word here at all - and null is the important answer: the caller then
 * treats it as any other word and it goes to the controller as written. A GRBL
 * board that handles its own M8 is a machine with no flood entry, not a machine
 * that gets refused.
 */
export function resolveMachineOutputWord(
  machine: OutputMachine | null | undefined,
  code: number,
): MachineOutputResolution | null {
  if (!Number.isInteger(code) || code < 0) return null
  const word: MachineMCode = `M${code}`
  const outputs = machineOutputList(machine)
  if (outputs.length === 0) return null

  const hits: OutputHit[] = []
  for (const output of outputs) {
    if (output.onCode === word) hits.push({ output, on: true, own: true })
    else if (output.offCode === word) hits.push({ output, on: false, own: true })
    else if (word === SHARED_OFF_CODE && output.besideWord !== true) {
      hits.push({ output, on: false, own: false })
    }
  }
  if (hits.length === 0) return null

  // A WORD THE ENTRY ITSELF STATES, WITH NO PIN BEHIND IT, is the operator's to
  // fill in and is named before anything is sent. Not so for a switch made
  // BESIDE a controller word: there the word still means what it meant without
  // us, so an unassigned pin is silence.
  const named = hits.find(({ output, own }) =>
    own && output.besideWord !== true && !outputSwitches(output, outputs))
  if (named !== undefined) {
    const { name } = named.output
    return { kind: 'unassigned', word, name, setting: pinSetting(name) }
  }

  const live = hits.filter(({ output }) => outputSwitches(output, outputs))
  if (live.length === 0) {
    // Only `besideWord` entries answered: the word is the controller's alone.
    if (hits.every((hit) => hit.own)) return null
    // The shared off word on a machine whose outputs are all unwired.
    return {
      kind: 'unassigned',
      word,
      name: 'coolant and accessories',
      setting: 'a pin for an output in the machine definition',
    }
  }

  const switches: MachineOutputSwitch[] = live.map(({ output, on }) => ({
    name: output.name,
    pin: output.pin,
    on,
    delayMs: on ? Math.max(0, output.onDelayMs ?? 0) : 0,
  }))

  // A WORD THAT SWITCHES A GROUP OFF WAITS ONCE, for the longest off-delay the
  // group states - said generally, that is what UCCNC's single `M9delay` is.
  const offWait = live.reduce(
    (most, { output, on }) => (on ? most : Math.max(most, output.offDelayMs ?? 0)),
    0,
  )
  if (offWait > 0) {
    for (let i = switches.length - 1; i >= 0; i--) {
      if (!switches[i].on) {
        switches[i].delayMs = offWait
        break
      }
    }
  }
  return { kind: 'switch', word, switches }
}
