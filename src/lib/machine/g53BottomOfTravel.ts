// WO-3187 (owner, MC card 2026-10-27: "Say it at Load, change nothing"): a G53
// Z move whose machine target is the bottom end of this machine's Z travel.
// A generic `G53 G0 Z0` retracts to the top on a machine that homes Z
// to zero; on one that homes Z to the top of a positive travel (LienCNC: home
// 128.9, travel -0.1..129.1) machine Z 0 is the bottom. That is not refused -
// with enough stick-out it does not crash, and the operator may mean it - so
// Load says it once per line and the file runs as written.
//
// The bottom is the travel end OPPOSITE the Z home end. A machine whose Z home
// end is not known gets no line: the software never guesses which end is down.

import { tokenize } from '../gcode/parse'

/** How close to the bottom end a G53 Z target counts as going there, mm. */
export const G53_BOTTOM_TOLERANCE_MM = 0.5

/** How many lines Load names before it counts the rest in one line. */
export const G53_BOTTOM_NAMED_LINES = 3

/** The Z facts the check reads: the reachable machine range and the home end. */
export interface G53BottomZAxis {
  range: { min: number; max: number } | null
  homesToward: 'min' | 'max' | null
}

export interface G53BottomLine {
  /** 1-based line of the file. */
  line: number
  /** The line as written, trimmed. */
  code: string
  /** The machine Z it goes to, mm. */
  machineZ: number
}

/** The bottom end of Z travel, or null when the range or home end is unknown. */
export function zBottomOfTravel(axis: G53BottomZAxis): number | null {
  if (axis.range === null || axis.homesToward === null) return null
  const { min, max } = axis.range
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return axis.homesToward === 'max' ? min : max
}

/** Every line of `text` with a G53 Z word whose target is the bottom of Z travel. */
export function g53LinesAtBottomOfTravel(text: string, axis: G53BottomZAxis): G53BottomLine[] {
  const bottom = zBottomOfTravel(axis)
  if (bottom === null || !/G\s*0*53/i.test(text)) return []
  const found: G53BottomLine[] = []
  let inches = false
  for (const line of tokenize(text)) {
    let g53 = false
    for (const word of line.words) {
      if (word.letter !== 'G') continue
      if (word.value === 20) inches = true
      else if (word.value === 21) inches = false
      else if (word.value === 53) g53 = true
    }
    const z = line.words.find((word) => word.letter === 'Z')
    if (!g53 || z === undefined || !Number.isFinite(z.value)) continue
    const machineZ = inches ? z.value * 25.4 : z.value
    if (Math.abs(machineZ - bottom) <= G53_BOTTOM_TOLERANCE_MM) {
      found.push({ line: line.number, code: line.raw.trim(), machineZ })
    }
  }
  return found
}
