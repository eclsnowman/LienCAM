// ============================================================
// Number + word formatting for G-code emission (C-P1a)
// ============================================================
// Pure string helpers. No I/O, no throwing. Coordinates and feeds are
// formatted to a fixed number of decimals, then trailing zeros are trimmed
// (3.500 -> "3.5", 3.000 -> "3") so output stays compact and controller-
// friendly. The decimal separator is always a period; sign is preserved.

/** Format a number to `decimals` fixed places, then trim trailing zeros and a
 *  bare trailing decimal point. -0 collapses to "0". */
export function fmtNum(v: number, decimals: number): string {
  let s = v.toFixed(Math.max(0, decimals))
  if (s.includes('.')) {
    s = s.replace(/0+$/, '') // drop trailing zeros
    s = s.replace(/\.$/, '') // drop a now-bare decimal point
  }
  // Normalize negative zero so we never emit "-0". Exact -0 collapses, but so
  // does a tiny negative that ROUNDS to zero (e.g. -0.0004 -> "-0.000" -> "-0"):
  // both must read "0", or a controller may reject the malformed word.
  if (Number(s) === 0) s = '0'
  return s
}

/** Build an address word: letter + formatted value (e.g. word('X', 3.5, 3) ->
 *  "X3.5"). */
export function word(letter: string, v: number, decimals: number): string {
  return `${letter}${fmtNum(v, decimals)}`
}

// --- units (ADR-0022 export boundary) ---------------------------------------
// Canonical internal unit is millimeters. The post converts dimensioned values
// to the EXPORT unit at the single formatting seam each quantity flows through,
// using these helpers. 1 inch = 25.4 mm, EXACT. Spindle RPM (S) and dwell
// time (P) are unit-invariant and NEVER scaled.
export type PostUnits = 'mm' | 'inch'

/** Divisor that turns a canonical mm value into the export-unit value:
 *  mm -> 1 (identity), inch -> 25.4. Apply as `mmValue / unitScale(units)`. */
export function unitScale(units: PostUnits): number {
  return units === 'inch' ? 25.4 : 1
}

/** The program-frame units word: inch -> 'G20', mm -> 'G21'. */
export function unitsWord(units: PostUnits): string {
  return units === 'inch' ? 'G20' : 'G21'
}

/** Format a dimensioned (length) value, converting mm -> export unit first.
 *  This is the single conversion point for coordinates / I/J / R / Q. */
export function dimWord(letter: string, valueMm: number, decimals: number, units: PostUnits): string {
  return word(letter, valueMm / unitScale(units), decimals)
}

export const xWord = (v: number, decimals: number): string => word('X', v, decimals)
export const yWord = (v: number, decimals: number): string => word('Y', v, decimals)
export const zWord = (v: number, decimals: number): string => word('Z', v, decimals)
export const iWord = (v: number, decimals: number): string => word('I', v, decimals)
export const jWord = (v: number, decimals: number): string => word('J', v, decimals)
export const fWord = (v: number, decimals: number): string => word('F', v, decimals)
/** Spindle speed is always an integer RPM. */
export const sWord = (v: number): string => word('S', Math.round(v), 0)
