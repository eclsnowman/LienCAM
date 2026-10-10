// GRBL 1.1 protocol constants. The codes follow the GRBL 1.1 protocol; the
// error and alarm wording is LienCAM's own.
// Full contract: docs/machine/GRBL-PROTOCOL.md.

/**
 * Real-time command bytes. These act the instant the UART receives them,
 * bypass the 128-byte RX line buffer entirely, and must NEVER be counted
 * against the character-counting tally.
 */
export const REALTIME = {
  statusQuery: 0x3f, // '?'
  cycleStartResume: 0x7e, // '~'
  feedHold: 0x21, // '!'
  softReset: 0x18, // Ctrl-X
  safetyDoor: 0x84,
  jogCancel: 0x85,
  feedOvrReset: 0x90,
  feedOvrCoarsePlus: 0x91,
  feedOvrCoarseMinus: 0x92,
  feedOvrFinePlus: 0x93,
  feedOvrFineMinus: 0x94,
  rapidOvrFull: 0x95,
  rapidOvrHalf: 0x96,
  rapidOvrQuarter: 0x97,
  spindleOvrReset: 0x99,
  spindleOvrCoarsePlus: 0x9a,
  spindleOvrCoarseMinus: 0x9b,
  spindleOvrFinePlus: 0x9c,
  spindleOvrFineMinus: 0x9d,
  spindleStopToggle: 0x9e, // HOLD state only
  coolantFloodToggle: 0xa0,
  coolantMistToggle: 0xa1,
} as const

/** GRBL serial RX buffer is 128 bytes; stream with an 8-byte safety margin (cncjs convention). */
export const GRBL_RX_BUFFER_SIZE = 128
export const STREAM_BYTE_LIMIT = GRBL_RX_BUFFER_SIZE - 8

/** GRBL's own line buffer is 80 chars - a longer line answers error:11. */
export const GRBL_MAX_LINE_CHARS = 80


/** error:N meanings, worded by LienCAM (the codes follow the GRBL 1.1 protocol; 18/19 unused). */
export const GRBL_ERROR_MESSAGES: Record<number, string> = {
  1: 'A G-code word has no letter in front of its number. Check the line for a stray number.',
  2: 'A number in the line is badly formed, or a word is missing its number.',
  3: 'The controller does not know that $ command. Check the spelling or leave it out.',
  4: 'A value that must be positive was negative.',
  5: 'Homing is switched off in the controller settings ($22), so the controller did not home.',
  6: 'The step pulse time setting is too short. It must be longer than 3 microseconds.',
  7: 'The controller could not read its saved settings, so it reset them to factory defaults. Check your settings.',
  8: 'That $ command only works while the controller is idle. Wait for the machine to stop.',
  9: 'The controller refused the G-code because it is in an alarm or a jog. Clear the alarm first.',
  10: 'Soft limits need homing switched on as well. Turn homing on first.',
  11: 'The line is too long for the controller and was skipped. Split it into shorter lines.',
  12: 'A $ setting asks for a step rate faster than the controller can produce. Lower the value.',
  13: 'The safety door is open, so the controller went into its door state. Close the door.',
  14: 'The startup or build-info line is too long to be stored. Shorten it.',
  15: 'The jog would go past the machine travel, so it was not done.',
  16: 'The jog line is missing its "=" or has G-code in it that the controller does not accept in a jog.',
  17: 'Laser mode needs a PWM spindle output, and none is set up.',
  20: 'The line contains a G-code command the controller does not support or does not recognise.',
  21: 'The line has two commands from the same group, and only one is allowed per line.',
  22: 'No feed rate has been set yet. Add an F word before the cutting move.',
  23: 'A command in the line needs a whole number and was given a fraction.',
  24: 'The line has two commands that both want axis words (X, Y, Z). Put them on separate lines.',
  25: 'The same G-code word appears twice in one line.',
  26: 'A command in the line needs axis words (X, Y, Z) and the line has none.',
  27: 'The N line number is outside the allowed range of 1 to 9,999,999.',
  28: 'A command in the line is missing a P or L value that it requires.',
  29: 'Only the six work offsets G54 to G59 are supported. G59.1, G59.2 and G59.3 are not available.',
  30: 'G53 only works while the motion mode is G0 (rapid) or G1 (feed). Switch to one of them first.',
  31: 'The line has axis words that nothing uses, because the motion mode was cancelled with G80.',
  32: 'An arc (G2 or G3) has no axis words in the selected plane, so there is nothing to trace.',
  33: 'The controller rejected the move because its target is invalid (for example an impossible arc, or a probe move to where the probe already is).',
  34: 'The controller could not work out the arc from its radius. Check the radius and end point.',
  35: 'An arc given with centre offsets is missing an I, J or K word for the selected plane.',
  36: 'The line has leftover words that no command in it uses.',
  37: 'G43.1 can only set a tool length offset on the axis the controller is configured for.',
  38: 'The tool number is higher than the controller supports.',
}

/** ALARM:N meanings, worded by LienCAM (the codes follow the GRBL 1.1 protocol). */
export const GRBL_ALARM_MESSAGES: Record<number, string> = {
  1: 'A hard limit switch was hit. The machine position is probably lost, so home the machine again.',
  2: 'The move would go past the machine travel (soft limit). The position is still good, and you can unlock the alarm.',
  3: 'The controller was reset while the machine was moving. The position is probably lost, so home the machine again.',
  4: 'Probing failed: the probe was not in the state the probe move expects at its start (for example, already touching).',
  5: 'Probing failed: the probe never touched anything within the distance it was allowed to travel.',
  6: 'Homing failed: the controller was reset while homing was running.',
  7: 'Homing failed: the safety door was opened while homing was running.',
  8: 'Homing failed: the machine could not back off the limit switch.',
  9: 'Homing failed: no limit switch was found within the search distance.',
  10: 'Homing failed: the second limit switch of a dual-axis pair never triggered.',
}

/** Alarms after which machine position is untrustworthy - prefer $H over $X. */
export const GRBL_ALARMS_POSITION_LOST: ReadonlySet<number> = new Set([1, 3, 6, 7, 8, 9, 10])
