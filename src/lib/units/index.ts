// WO-3281 (UI M2 W1-D): the units and format service (standard 8). Stored values are mm, degrees,
// mm/min and rpm; only display and entry convert. It shows what today's screens show for the same
// value and unit (src/lib/ui/unitFormat.ts is the reference), reads only the operator's own decimal
// mark and never guesses. The app's settings reach it through ./format/appPrefs (connectAppUnitPrefs),
// which keeps this file free of the store so the kit and the gallery can import it alone.
import { UNIT_REASON } from '../../notices/catalogue'
import type { DecimalMark, FormatOptions, ParseOptions, ParseResult, Quantity, UnitPrefs, UnitsService } from './types'
import { DEFAULT_UNIT_PREFS } from './types'

export * from './types'

export const MM_PER_INCH = 25.4

const UNIT_WORDS: Readonly<Record<string, 'mm' | 'inch'>> = { mm: 'mm', in: 'inch', inch: 'inch', '"': 'inch' }

/** Shown for a value that is not a number yet (spec 7: loading shows a dash). */
export const NO_VALUE = '—'
const MAX_PLACES = 12

function digits(value: number, places: number, mark: string, trim: boolean): string {
  if (!Number.isFinite(value)) return NO_VALUE
  let text = value.toFixed(Math.min(MAX_PLACES, Math.max(0, Math.trunc(places))))
  if (trim && text.includes('.')) text = text.replace(/\.?0+$/, '')
  if (/^-0(\.0*)?$/.test(text)) text = text.slice(1)
  return mark === '.' ? text : text.replace('.', mark)
}

type Read = { value: number; unit?: 'mm' | 'inch' } | { problem: 'notANumber' | 'wrongMark' }

/** A parse never guesses: only the operator's own decimal mark is a decimal mark, and no
 *  thousands separators are accepted, so '1,000' with '.' prefs is not a number (never 1): it is
 *  told it uses the wrong mark. */
function readNumber(text: string, mark: DecimalMark): Read {
  const own = mark === ',' ? ',' : '\\.'
  const other = mark === ',' ? '\\.' : ','
  const unit = '\\s*(mm|inch|in|")?\\s*$'
  const m = new RegExp(`^\\s*([+-]?(?:\\d+(?:${own}\\d*)?|${own}\\d+))${unit}`, 'i').exec(text)
  if (m) {
    const value = Number(m[1].replace(',', '.'))
    return Number.isFinite(value) ? { value, unit: m[2] ? UNIT_WORDS[m[2].toLowerCase()] : undefined } : { problem: 'notANumber' }
  }
  return new RegExp(`^\\s*[+-]?(?:\\d+${other}\\d*|${other}\\d+)${unit}`, 'i').test(text) ? { problem: 'wrongMark' } : { problem: 'notANumber' }
}
const failure = (r: { problem: 'notANumber' | 'wrongMark' }): ParseResult => ({ ok: false, reason: UNIT_REASON[r.problem] })
const WRONG_UNIT: ParseResult = { ok: false, reason: UNIT_REASON.wrongUnit }

/** Inch entries convert exactly enough for the operator: 12 in is 304.8 mm, not 304.79999999999995. */
const fromInch = (inches: number) => Math.round(inches * MM_PER_INCH * 1e9) / 1e9

/** Strips one trailing unit word (and the space before it) when it is one of `words`. */
const stripSuffix = (text: string, words: RegExp) => text.replace(words, '')

export function createUnitsService(getPrefs: () => UnitPrefs = () => DEFAULT_UNIT_PREFS): UnitsService {
  const prefsOf = (o?: FormatOptions | ParseOptions) => o?.prefs ?? getPrefs()
  const withUnit = (text: string, unit: string, o?: FormatOptions) => (o?.withUnit === false || !unit ? text : `${text} ${unit}`)

  /** A length-like entry (length, feed): its own unit word wins over the prefs. */
  const parseDistance = (text: string, o: ParseOptions | undefined): ParseResult => {
    const p = prefsOf(o)
    const n = readNumber(text, p.decimalMark)
    if ('problem' in n) return failure(n)
    const mm = (n.unit ?? p.length) === 'inch' ? fromInch(n.value) : n.value
    return { ok: true, value: mm + 0 } // + 0: a typed '-0' is 0, never negative zero
  }
  /** A quantity with no unit choice: a typed length unit is the wrong kind of unit for it. */
  const parsePlain = (text: string, o: ParseOptions | undefined): ParseResult => {
    const n = readNumber(text, prefsOf(o).decimalMark)
    if ('problem' in n) return failure(n)
    return n.unit ? WRONG_UNIT : { ok: true, value: n.value + 0 }
  }

  const service: UnitsService = {
    formatLength(mm, o) {
      const p = prefsOf(o)
      const inch = p.length === 'inch'
      const places = o?.precision ?? (inch ? p.precision.inch : p.precision.mm)
      return withUnit(digits(inch ? mm / MM_PER_INCH : mm, places, p.decimalMark, o?.trim ?? false), inch ? 'in' : 'mm', o)
    },
    parseLength: (text, o) => parseDistance(text, o),
    formatAngle(degrees, o) {
      const text = digits(degrees, o?.precision ?? 2, prefsOf(o).decimalMark, o?.trim ?? false)
      return o?.withUnit === false ? text : `${text}°`
    },
    parseAngle: (text, o) => parsePlain(stripSuffix(text, /\s*(°|deg)\s*$/i), o),
    formatFeed(mmPerMin, o) {
      const p = prefsOf(o)
      const inch = p.length === 'inch'
      return withUnit(digits(inch ? mmPerMin / MM_PER_INCH : mmPerMin, o?.precision ?? 1, p.decimalMark, o?.trim ?? false), inch ? 'in/min' : 'mm/min', o)
    },
    parseFeed: (text, o) => parseDistance(stripSuffix(text, /\s*\/\s*min\s*$/i), o),
    formatSpeed(rpm, o) {
      return withUnit(digits(rpm, o?.precision ?? 0, prefsOf(o).decimalMark, o?.trim ?? false), 'rpm', o)
    },
    format(quantity: Quantity, value, o) {
      switch (quantity) {
        case 'length': return service.formatLength(value, o)
        case 'angle': return service.formatAngle(value, o)
        case 'feed': return service.formatFeed(value, o)
        case 'speed': return service.formatSpeed(value, o)
        default:
          return withUnit(digits(value, o?.precision ?? (quantity === 'count' ? 0 : 2), prefsOf(o).decimalMark, o?.trim ?? false), service.unitLabel(quantity, prefsOf(o)), o)
      }
    },
    parse(quantity: Quantity, text, o) {
      switch (quantity) {
        case 'length': return service.parseLength(text, o)
        case 'angle': return service.parseAngle(text, o)
        case 'feed': return service.parseFeed(text, o)
        case 'speed': return parsePlain(stripSuffix(text, /\s*rpm\s*$/i), o)
        case 'percent': return parsePlain(stripSuffix(text, /\s*%\s*$/), o)
        case 'time': return parsePlain(stripSuffix(text, /\s*s\s*$/i), o)
        default: return parsePlain(text, o)
      }
    },
    unitLabel(quantity: Quantity, prefs?: UnitPrefs) {
      const inch = (prefs ?? getPrefs()).length === 'inch'
      switch (quantity) {
        case 'length': return inch ? 'in' : 'mm'
        case 'angle': return '°'
        case 'feed': return inch ? 'in/min' : 'mm/min'
        case 'speed': return 'rpm'
        case 'percent': return '%'
        case 'time': return 's'
        default: return ''
      }
    },
  }
  return service
}

let prefsSource: (() => UnitPrefs) | null = null
/** Where the app's one service reads the operator's preferences (see ./format/appPrefs);
 *  null goes back to the defaults. */
export function setUnitPrefsSource(source: (() => UnitPrefs) | null): void { prefsSource = source }

/** The app's one units service. Until a source is set it uses the defaults (mm, '.'). */
export const units: UnitsService = createUnitsService(() => prefsSource?.() ?? DEFAULT_UNIT_PREFS)
