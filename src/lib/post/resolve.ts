// ============================================================
// Spindle + coolant resolution for the post (C-P0)
// ============================================================
// Mirrors the feedrate two-tier chain: operation override (when enabled)
// then tool default. Machine bounds clamp the result.

import type { MachineConfig, Operation, Tool } from '../../types'
import {
  machineOffersCoolant,
  machineOutputForChannel,
  machineVacuumCapability,
  reconciledMachineCoolant,
} from '../../types'
import type { PostOperation } from './types'
import { spindleRotationForTool } from '../tool/cutHand'

/** Pick the tool's feeds/speeds 'default' entry, falling back to the first
 *  available key when 'default' is absent. Returns undefined if the tool has
 *  no entries at all. */
function pickFeeds(tool: Tool): Tool['feedsAndSpeeds'][string] | undefined {
  const fs = tool.feedsAndSpeeds
  if (fs?.default) return fs.default
  const firstKey = fs ? Object.keys(fs)[0] : undefined
  return firstKey ? fs[firstKey] : undefined
}

/** The RPM the operation asked the post to use, before machine bounds. Kept as
 * one resolver so emission and the diagnostic explaining a clamp cannot choose
 * different feed/speed entries. */
export function requestedSpindleRpm(op: Operation, tool: Tool): number {
  const fo = op.feedrateOverride
  return fo?.enabled ? fo.rpm : (pickFeeds(tool)?.rpm ?? 0)
}

/** Resolve spindle rpm + direction. rpm = override.rpm when the op override
 *  is enabled, else the tool default rpm, clamped to each bound the machine
 *  actually states. An unstated bound does not invent a clamp.
 *  Tool hand is the physical authority for rotation: right-hand cutters run CW
 *  and left-hand cutters run CCW. The machine still owns RPM bounds, but its
 *  legacy default direction cannot reverse a selected cutter. */
export function resolveSpindle(
  op: Operation,
  tool: Tool,
  machine: MachineConfig,
): { rpm: number; dir: 'cw' | 'ccw' } {
  const rawRpm = requestedSpindleRpm(op, tool)
  // No stated minimum still means no negative speed: a spindle cannot turn at one.
  const aboveMinimum = Math.max(rawRpm, machine.minSpindleRpm ?? 0)
  const rpm = machine.maxSpindleRpm === undefined
    ? aboveMinimum
    : Math.min(aboveMinimum, machine.maxSpindleRpm)
  const dir = spindleRotationForTool(tool)
  return { rpm, dir }
}

/**
 * Resolve coolant from the tool default. Vacuum is resolved independently by
 * `resolveVacuum`: a combined machine must keep the coolant the tool requested
 * and run dust extraction beside it, never rank one accessory above the other.
 *
 * TWO GATES, BECAUSE THERE IS ONE FACT ASKED AT TWO GRAINS (WO-965).
 *
 * 1. THE MACHINE-WIDE ONE, read DERIVED. `machine.coolant` is no longer taken
 *    at face value: `reconciledMachineCoolant` prefers the per-channel answers
 *    where they prove something and falls back to the stored bit where they
 *    prove nothing. A record whose bit was left `false` while somebody answered
 *    Yes on a channel is a record that contradicts itself, and the post now
 *    reads the answer rather than the contradiction. Where no channel is
 *    answered - which is every record written before WO-965 - this is character
 *    for character the old `machine.coolant === false` test.
 *
 * 2. THE PER-CHANNEL ONE. A machine with mist and no flood used to be posted
 *    M8 anyway, because this function only ever had one bit to read. The
 *    definition page carried a note saying so and naming this file as the
 *    thing that had to learn it; it has. A channel stated `false` is now posted
 *    dry, which is the same answer the Control page gives by not drawing the
 *    button.
 *
 * ABSENT IS NOT FALSE HERE EITHER. `machineOffersCoolant` refuses only on a
 * stated `false`, so a tool asking for flood on a machine nobody has described
 * still posts flood. And 'air' is not gated: an air blast is neither M7 nor M8
 * and this record says nothing about it - inventing a refusal from silence is
 * the same defect as inventing a capability.
 */
export function resolveCoolant(
  tool: Tool,
  machine: MachineConfig,
): PostOperation['coolant'] {
  const asked = pickFeeds(tool)?.coolant ?? 'none'
  // Older or imported tool records may still carry the typed value, but a tool
  // cannot invent a machine output that its definition does not declare.
  if (asked === 'vacuum') return 'none'
  if (!reconciledMachineCoolant(machine)) return 'none'
  if ((asked === 'mist' || asked === 'flood') && !machineOffersCoolant(machine, asked)) {
    return 'none'
  }
  return asked
}

/**
 * Resolve the machine-wide dust-extraction start word FROM THE STORED RECORD.
 *
 * It reads the document raw, exactly as the Control page and the definition
 * editor do, because a machine document with two accessories on one M-code can
 * no longer be in the store to be read: `adoptMachineDocument` migrates that
 * collision out at every door a machine enters through (WO-1058). This function
 * used to reconcile on read, and so did `SpindlePanel`, and the definition
 * editor did not - one record, three surfaces, two sources, and the audits kept
 * finding whichever surface was left behind that round. The button and the
 * program say the same word now because they read the same document, not
 * because they were each given the same rule.
 *
 * The flat refusals below are NOT that rule and do not move: program-flow,
 * tool-change, spindle and the shared M9 off fail dry here and again at the
 * emitter boundary, because a `PostOperation.vacuum` set directly by a caller
 * never passes through here at all.
 */
export function resolveVacuum(machine: MachineConfig): PostOperation['vacuum'] {
  const raw = machineVacuumCapability(machine)?.onCode
  if (!raw || !/^M(?:0|[1-9]\d*)$/.test(raw)) return null
  if (raw === 'M0' || raw === 'M1' || raw === 'M2' || raw === 'M6'
    || raw === 'M9' || raw === 'M30') return null
  return raw
}

/**
 * WO-1650: THE WORD A COOLANT REQUEST IS POSTED AS, from the machine's one
 * output list. Flood is the listed flood output's on word, mist (and an air
 * blast, which has always gone out on the mist word) the listed mist output's;
 * a machine whose list names neither is posted the standard M8 / M7.
 */
export function resolveCoolantWord(
  machine: MachineConfig | null | undefined,
  coolant: PostOperation['coolant'],
): string | null {
  if (coolant === 'none') return null
  const role = coolant === 'flood' ? 'flood' : 'mist'
  const listed = machineOutputForChannel(machine, role)?.onCode
  if (typeof listed === 'string' && /^M\d+$/.test(listed)) return listed
  return role === 'flood' ? 'M8' : 'M7'
}
