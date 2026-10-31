// WO-3281: the operator's settings -> the units service. Length unit follows Settings > Display
// units; the decimal mark follows the interface language (comma for de, es, fr). This is the only
// units file that reads the stores; the New UI root calls connectAppUnitPrefs() once.
import { useCamStore } from '../../../store'
import { useUiPrefs } from '../../../store/uiPrefs'
import type { Units } from '../../ui/unitFormat'
import { setUnitPrefsSource } from '..'
import { DEFAULT_UNIT_PREFS, type DecimalMark, type UnitPrefs } from '../types'

const COMMA_LANGUAGES: ReadonlySet<string> = new Set(['de', 'es', 'fr'])

export function decimalMarkFor(language: string): DecimalMark {
  return COMMA_LANGUAGES.has(language) ? ',' : '.'
}

const cache = new Map<string, UnitPrefs>()
export function unitPrefsFrom(displayUnits: Units, language: string): UnitPrefs {
  const decimalMark = decimalMarkFor(language)
  const id = `${displayUnits}${decimalMark}`
  let prefs = cache.get(id)
  if (!prefs) {
    prefs = Object.freeze({ ...DEFAULT_UNIT_PREFS, length: displayUnits, decimalMark }) as UnitPrefs
    cache.set(id, prefs)
  }
  return prefs
}

/** Make `units` follow the live settings. Safe to call twice. */
export function connectAppUnitPrefs(): void {
  setUnitPrefsSource(() => unitPrefsFrom(useCamStore.getState().appSettings.displayUnits, useUiPrefs.getState().language))
}
