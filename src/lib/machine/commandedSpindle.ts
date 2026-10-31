// WO-3191: THE ONE RECORD OF WHICH WAY THE SPINDLE WAS TOLD TO TURN.
//
// The gap (CT-5, alpha.3.2 plan): a posted program ran M3 S10000 on the
// simulator, the readout said 10000 rpm, and the spindle panel lit Off - CW
// never lit, in the run or in Feed Hold. The panel kept the direction in its
// own state, written only by its own buttons, so a spindle started by the
// program, or typed at the MDI line, left it saying 'off'.
//
// The direction is now recorded here, from every route that actually sends a
// spindle word to the controller: `commandSpindle` (the panel, the program's
// own spindle on the program door, a spindle word on a controller with no text
// reader), an MDI line on the text route, and the program stream's sent cursor
// on the text door. The panel reads it. Running/stopped still comes from the
// machine's report, and the direction NEVER comes from the inverter: this VFD
// reports the opposite direction while turning correctly
// (VFD-COMMISSIONING.md 4.9).

import { tokenizeLine } from '../gcode/parse'
import { stripGcodeComments } from '../gcode/text'
import { useMachineControl, type CommandedSpindleDirection } from '../../store/machineControlStore'

const DIRECTION_BY_M: Readonly<Record<number, CommandedSpindleDirection>> = { 3: 'cw', 4: 'ccw', 5: 'off' }

/** The LAST M3/M4/M5 on one g-code line (comments stripped), or null.
 *  Read as address words by the project's g-code tokenizer, so a block
 *  written without spaces counts: N20M5, M3S10000, G0X1M5 (astra audit).
 *  M30, M50 and M3.1 are other words, not a spindle direction. Comments go
 *  first, the way the text door strips them, so an unclosed "(" hides the
 *  rest of the line. */
export function spindleWordInLine(line: string): CommandedSpindleDirection | null {
  let found: CommandedSpindleDirection | null = null
  for (const word of tokenizeLine(stripGcodeComments(line), 0).words) {
    if (word.letter === 'M' && DIRECTION_BY_M[word.value]) found = DIRECTION_BY_M[word.value]
  }
  return found
}

/** The last spindle word across lines sent in order, or null. */
export function lastSpindleWord(lines: readonly string[]): CommandedSpindleDirection | null {
  let found: CommandedSpindleDirection | null = null
  for (const line of lines) found = spindleWordInLine(line) ?? found
  return found
}

/** Record a spindle command that WENT. Call only once the send succeeded - a
 *  refused command must not move the panel (WO-474). */
export function recordCommandedSpindle(direction: CommandedSpindleDirection): void {
  if (useMachineControl.getState().commandedSpindle === direction) return
  useMachineControl.setState({ commandedSpindle: direction })
}

/** Record the spindle word, if any, on lines that were sent. */
export function recordSpindleWordsSent(lines: readonly string[]): void {
  const word = lastSpindleWord(lines)
  if (word !== null) recordCommandedSpindle(word)
}
