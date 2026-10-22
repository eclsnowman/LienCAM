// WO-2319: the interface text lookup (i18next + react-i18next, MIT).
//
// Screens read their words by key from the area catalogs (see catalogs.ts):
//
//   const t = useText('language')
//   <span>{t('label')}</span>
//
// Keys are typed: a key the English catalog does not have is a tsc error, not
// a blank label at run time. Code outside React uses textFor(area).
//
// What is NOT translated, ever: G-code, posted files, controller messages,
// dialect names, file extensions and keyboard shortcut letters stay English,
// and numbers keep the "." decimal - no number or unit formatting goes through
// this layer.
//
// Importing this module initialises the instance synchronously with English,
// so any component that calls useText renders English on its first paint in
// the app, the standalone dev pages and tests alike.
import i18next, { type ResourceNamespaceMap } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { useUiPrefs } from '../store/uiPrefs'
import {
  ENGLISH_CATALOG,
  SOURCE_LANGUAGE,
  isAvailableLanguage,
  loadCatalog,
} from './catalogs'
import { withoutStale } from './freshness/runtime'

export {
  AVAILABLE_LANGUAGES,
  SOURCE_LANGUAGE,
  isAvailableLanguage,
  languageName,
  machineTranslationNote,
} from './catalogs'

/** A catalog area name (one file under locales/en/). */
export type CatalogArea = keyof ResourceNamespaceMap

type Words<T> = { readonly [K in keyof T]?: T[K] extends string ? string : Words<T[K]> }
/** The shape another language's area file must satisfy: the English keys,
 *  any string value, every key optional (a missing one falls back to English). */
export type Translation<A extends CatalogArea> = Words<ResourceNamespaceMap[A]>

declare module 'i18next' {
  interface CustomTypeOptions {
    // A defaultValue never excuses a key the English catalog lacks.
    strictKeyChecks: true
  }
}

export const i18n = i18next.createInstance()

void i18n.use(initReactI18next).init({
  lng: SOURCE_LANGUAGE,
  fallbackLng: SOURCE_LANGUAGE,
  // A copy: i18next adds to its store in place, and the catalog is frozen.
  resources: { [SOURCE_LANGUAGE]: { ...ENGLISH_CATALOG } },
  ns: Object.keys(ENGLISH_CATALOG),
  defaultNS: false,
  initAsync: false,
  // React escapes text itself; i18next escaping would double it.
  interpolation: { escapeValue: false },
  returnEmptyString: false,
})

/** The typed text lookup for one area, for React components. */
export function useText<const A extends CatalogArea>(area: A) {
  return useTranslation(area).t
}

/** The typed text lookup for one area, for code outside React. */
export function textFor<const A extends CatalogArea>(area: A) {
  return i18n.getFixedT(null, area)
}

const loaded = new Set([SOURCE_LANGUAGE])
let requested = SOURCE_LANGUAGE

/** Switch the interface to one available language, loading its catalog first.
 *  Anything else (absent, retired, tampered) shows English. */
export async function applyLanguage(language: string): Promise<void> {
  const target = isAvailableLanguage(language) ? language : SOURCE_LANGUAGE
  requested = target
  if (!loaded.has(target)) {
    // WO-2943: a translation whose English source changed since it was
    // written is left out, so that key shows English until it is updated.
    const catalog = withoutStale(target, await loadCatalog(target))
    for (const [area, words] of Object.entries(catalog)) {
      i18n.addResourceBundle(target, area, words, true, true)
    }
    loaded.add(target)
  }
  // A later choice made while this catalog was loading wins.
  if (requested !== target) return
  if (i18n.language !== target) await i18n.changeLanguage(target)
  if (typeof document !== 'undefined') document.documentElement.lang = target
}

void applyLanguage(useUiPrefs.getState().language)
useUiPrefs.subscribe((s) => s.language, (language) => { void applyLanguage(language) })
