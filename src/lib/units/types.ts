// WO-3275 (UI M2 Wave 0): the units and format service contract (M2-PLAN standard 8).
// Screens never call toFixed or parseFloat: every number the operator reads or types goes through
// this service, which owns mm or inch, precision and the locale's decimal mark.
// Stored values are always millimetres, degrees, mm/min and rpm; only display and entry convert.
// Wave 1 (W1-D) replaces the stub in ./index.ts; only the Wave 0 owner changes this file.
import type { MessageKey } from '../../notices/types'

export type LengthUnit = 'mm' | 'inch'
export type DecimalMark = '.' | ','

/** What kind of quantity a number is; decides its unit and default precision. */
export const QUANTITIES = ['length', 'angle', 'feed', 'speed', 'count', 'percent', 'time', 'none'] as const
export type Quantity = (typeof QUANTITIES)[number]

export interface UnitPrefs {
  readonly length: LengthUnit
  readonly decimalMark: DecimalMark
  /** Decimal places for lengths in mm and in inch. */
  readonly precision: { readonly mm: number; readonly inch: number }
}

export const DEFAULT_UNIT_PREFS: UnitPrefs = Object.freeze({
  length: 'mm',
  decimalMark: '.',
  precision: Object.freeze({ mm: 3, inch: 4 }),
}) as UnitPrefs

export interface FormatOptions {
  /** Overrides the prefs for this one call. */
  readonly prefs?: UnitPrefs
  /** Decimal places for this call (else the prefs' precision for the unit). */
  readonly precision?: number
  /** Append the unit ('12.500 mm'). Default true. */
  readonly withUnit?: boolean
  /** Drop trailing zeros after the decimal mark ('12.5 mm'). Default false. */
  readonly trim?: boolean
}

export interface ParseOptions {
  readonly prefs?: UnitPrefs
}

/** A parse never guesses: it gives the value in stored units, or a catalogue reason for the field
 *  to show. Text may carry its own unit ('1 in', '25.4mm'), which wins over the prefs. */
export type ParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: MessageKey }

export interface UnitsService {
  /** mm -> text in the operator's length unit. */
  formatLength(mm: number, options?: FormatOptions): string
  /** text -> mm. */
  parseLength(text: string, options?: ParseOptions): ParseResult
  /** degrees -> text. */
  formatAngle(degrees: number, options?: FormatOptions): string
  parseAngle(text: string, options?: ParseOptions): ParseResult
  /** mm/min -> text in mm/min or in/min. */
  formatFeed(mmPerMin: number, options?: FormatOptions): string
  /** text -> mm/min. */
  parseFeed(text: string, options?: ParseOptions): ParseResult
  /** rpm -> text. */
  formatSpeed(rpm: number, options?: FormatOptions): string
  /** Any quantity, for generic fields (the parameter schema's renderer). */
  format(quantity: Quantity, value: number, options?: FormatOptions): string
  parse(quantity: Quantity, text: string, options?: ParseOptions): ParseResult
  /** The unit label a field shows beside its value ('mm', 'in/min', '°'). */
  unitLabel(quantity: Quantity, prefs?: UnitPrefs): string
}
