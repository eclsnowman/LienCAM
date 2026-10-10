// UI unit-conversion shim (ADR-0022).
//
// Canonical internal unit is millimeters. This module is the SINGLE seam every
// UI display/input site routes through when showing or reading a dimensioned
// value, so conversion happens exactly once, at the edge. Stored values are
// never converted — only their presentation/parsing is.
//
// Identity at mm: when `units === 'mm'` every function is a pass-through
// (toDisplay/fromDisplay return their input unchanged; fmtDim just toFixed).
// Rounded negative zero is normalized only in the formatted string.
//
// Spindle speed (RPM) is unit-invariant and NEVER lives in this file.

// Reuse the shared Units type from src/types so there is ONE definition.
import type { Units } from '../../types'
export type { Units }

// 1 inch = 25.4 mm, EXACT. The only conversion constant.
export const MM_PER_INCH = 25.4

// Area conversion: 1 in^2 = 25.4^2 mm^2 = 645.16 mm^2, EXACT.
export const MM2_PER_IN2 = MM_PER_INCH * MM_PER_INCH

// Per-unit decimal places, one source of truth (ADR-0022 §4).
export const DIM_DECIMALS: Record<Units, number> = { mm: 3, inch: 4 }
export const FEED_DECIMALS: Record<Units, number> = { mm: 1, inch: 1 }
// Areas: mm^2 keeps the legacy 1-decimal format; in^2 is ~645x smaller per unit
// so it needs more fractional precision to stay legible.
export const AREA_DECIMALS: Record<Units, number> = { mm: 1, inch: 3 }

// 'mm' -> 'mm'; 'inch' -> 'in'.
export function unitLabel(units: Units): string {
  return units === 'inch' ? 'in' : 'mm'
}

// 'mm' -> 'mm/min'; 'inch' -> 'in/min' (IPM).
export function feedLabel(units: Units): string {
  return units === 'inch' ? 'in/min' : 'mm/min'
}

// 'mm' -> 'mm²'; 'inch' -> 'in²'. Uses the same superscript-2 glyph the app
// already renders for areas (DesignTree / loop list).
export function areaLabel(units: Units): string {
  return units === 'inch' ? 'in²' : 'mm²'
}

// --- dimensions (lengths: XYZ, heights, stock, tool, tolerances) ---

// mm value -> display number (UNROUNDED). inch = value / 25.4.
export function toDisplay(valueMm: number, units: Units): number {
  return units === 'inch' ? valueMm / MM_PER_INCH : valueMm
}

// display number -> stored mm value. inch = value * 25.4.
export function fromDisplay(value: number, units: Units): number {
  return units === 'inch' ? value * MM_PER_INCH : value
}

// mm value -> formatted display string, NO unit suffix. Decimals default to the
// per-unit DIM_DECIMALS entry.
export function fmtDim(valueMm: number, units: Units, decimals?: number): string {
  const dp = decimals ?? DIM_DECIMALS[units]
  const text = toDisplay(valueMm, units).toFixed(dp)
  return text.startsWith('-') && Number(text) === 0 ? text.slice(1) : text
}

// Control readouts have a different precision rule from CAM geometry.
// Keep this at the display edge; commands and stored values use canonical mm.
export function fmtMachineLength(valueMm: number, units: Units): string {
  return fmtDim(valueMm, units, units === 'inch' ? 3 : 2)
}

// Legacy path diagnostics describe canonical mm as prose. Apply Control units
// only to those generated sentences, never to G-code, operator text or feeds.
export function fmtMachineDiagnostic(textMm: string, units: Units): string {
  return textMm.replace(
    /(-?\d+(?:\.\d+)?) mm(?!\/)|\b([XYZ]) (-?\d+(?:\.\d+)?)(?![\d.]| mm\/min| deg)(?: mm(?!\/))?/g,
    (_match, length: string | undefined, axis: string | undefined, position: string | undefined) => {
      const value = Number(length ?? position)
      const text = `${fmtMachineLength(value, units)} ${unitLabel(units)}`
      return axis ? `${axis} ${text}` : text
    },
  )
}

// mm² value -> formatted area display string, NO unit suffix. Decimals default
// to the per-unit AREA_DECIMALS entry. mm is identity with today's behavior
// (toFixed(1)); inch divides by 645.16 (mm²/in²) before formatting.
export function fmtArea(valueMm2: number, units: Units, decimals?: number): string {
  const dp = decimals ?? AREA_DECIMALS[units]
  const value = units === 'inch' ? valueMm2 / MM2_PER_IN2 : valueMm2
  return value.toFixed(dp)
}

// Strip whitespace and an optional trailing unit label from a numeric string.
// Accepts e.g. "25.4", "25.4 mm", "1.0000in", or a raw number. Returns the
// numeric part as a number, or NaN if it is not parseable.
function parseNumeric(input: string | number): number {
  if (typeof input === 'number') return input
  const trimmed = input.trim()
  if (trimmed === '') return NaN
  // Drop a trailing unit label (mm | in | inch | mm/min | in/min) if present.
  const stripped = trimmed.replace(/\s*(mm\/min|in\/min|inch|mm|in)\s*$/i, '').trim()
  if (stripped === '') return NaN
  // Require the remainder to be a clean number (Number('') === 0, so guard the
  // empty case above; Number('1 2') === NaN, which we want).
  const n = Number(stripped)
  return Number.isNaN(n) ? NaN : n
}

// user text in display units -> stored mm value. NaN on unparseable garbage
// (NOT 0). Tolerant of a trailing unit label.
export function parseDimToMm(input: string | number, units: Units): number {
  const n = parseNumeric(input)
  if (Number.isNaN(n)) return NaN
  return fromDisplay(n, units)
}

// --- feeds (mm/min canonical) ---

// mm/min -> display number. inch = IPM (value / 25.4).
export function feedToDisplay(valueMmMin: number, units: Units): number {
  return units === 'inch' ? valueMmMin / MM_PER_INCH : valueMmMin
}

// mm/min -> formatted feed string, NO unit suffix. Decimals default per unit.
export function fmtFeed(valueMmMin: number, units: Units, decimals?: number): string {
  const dp = decimals ?? FEED_DECIMALS[units]
  return feedToDisplay(valueMmMin, units).toFixed(dp)
}

// user feed text in display units -> stored mm/min. NaN on garbage.
export function parseFeedToMmMin(input: string | number, units: Units): number {
  const n = parseNumeric(input)
  if (Number.isNaN(n)) return NaN
  return units === 'inch' ? n * MM_PER_INCH : n
}

// --- surface speed (cutting speed) ---
//
// Canonical internal unit is meters per minute (m/min). The inch-world
// equivalent is SFM (surface feet per minute): 1 m = 3.28084 ft, so
// 1 m/min = 3.28084 SFM. RPM is never touched here.
export const FT_PER_M = 3.28084

// 'mm' -> 'm/min'; 'inch' -> 'SFM' (surface feet per minute).
export function surfaceSpeedLabel(units: Units): string {
  return units === 'inch' ? 'SFM' : 'm/min'
}

// m/min value -> display number. inch = SFM (value * 3.28084).
export function surfaceSpeedToDisplay(valueMMin: number, units: Units): number {
  return units === 'inch' ? valueMMin * FT_PER_M : valueMMin
}

// display number (m/min or SFM) -> stored m/min. inch = value / 3.28084.
export function surfaceSpeedFromDisplay(value: number, units: Units): number {
  return units === 'inch' ? value / FT_PER_M : value
}
