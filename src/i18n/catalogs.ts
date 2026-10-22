// WO-2319: where the interface text lives, and which languages exist.
//
// Layout: src/i18n/locales/<language>/<area>.ts, one file per screen area,
// default-exporting that area's words. Files are collected here by
// import.meta.glob, so an extraction order adds its own area file and never
// edits a shared index (WO-2320..WO-2327 run in parallel on that promise).
//
// A language exists exactly when its folder holds at least one catalog file:
// adding src/i18n/locales/de/<area>.ts adds "Deutsch" to Settings > Language
// with no list to edit. English is loaded up front (it is the default and the
// fallback for every missing key); every other language is a lazy chunk, so an
// English-only user downloads no other catalog.
//
// This module deliberately imports no i18next runtime: the UI preferences
// store reads isAvailableLanguage() from here without pulling the library in.

export const SOURCE_LANGUAGE = 'en'

/** One area's words: nested groups of plain strings. */
export interface CatalogTree {
  readonly [key: string]: string | CatalogTree
}

interface CatalogModule {
  default: CatalogTree
}

const ENGLISH_FILES = import.meta.glob<CatalogModule>('./locales/en/*.ts', { eager: true })
const OTHER_FILES = import.meta.glob<CatalogModule>(['./locales/*/*.ts', '!./locales/en/*.ts'])

const CATALOG_PATH = /^\.\/locales\/([^/]+)\/([^/]+)\.ts$/

function catalogPath(path: string): { language: string; area: string } | null {
  const match = CATALOG_PATH.exec(path)
  return match === null ? null : { language: match[1], area: match[2] }
}

/** The English catalog, area -> words. */
export const ENGLISH_CATALOG: Readonly<Record<string, CatalogTree>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ENGLISH_FILES).flatMap(([path, module]) => {
      const parsed = catalogPath(path)
      return parsed === null ? [] : [[parsed.area, module.default] as const]
    }),
  ),
)

/** Every language with a catalog, English first, the rest by code. */
export const AVAILABLE_LANGUAGES: readonly string[] = Object.freeze([
  SOURCE_LANGUAGE,
  ...[...new Set(Object.keys(OTHER_FILES).flatMap((path) => {
    const parsed = catalogPath(path)
    return parsed === null ? [] : [parsed.language]
  }))].sort(),
])

export function isAvailableLanguage(value: unknown): value is string {
  return typeof value === 'string' && AVAILABLE_LANGUAGES.includes(value)
}

/** Load one non-English language's catalog files (area -> words). */
export async function loadCatalog(language: string): Promise<Record<string, CatalogTree>> {
  if (language === SOURCE_LANGUAGE) return { ...ENGLISH_CATALOG }
  const entries = await Promise.all(
    Object.entries(OTHER_FILES).flatMap(([path, load]) => {
      const parsed = catalogPath(path)
      return parsed === null || parsed.language !== language
        ? []
        : [load().then((module) => [parsed.area, module.default] as const)]
    }),
  )
  return Object.fromEntries(entries)
}

/** WO-2329: languages whose words are machine translation, with the note the
 *  picker and Help show for them - written in that language, because the
 *  person choosing it reads it. Corrections go through Help > Report a problem;
 *  the terms they are checked against are docs/i18n/GLOSSARY.md. */
const MACHINE_TRANSLATION_NOTES: Readonly<Record<string, string>> = Object.freeze({
  de: 'Maschinell übersetzt - Korrekturen willkommen: Hilfe > Problem melden.',
  es: 'Traducción automática - Correcciones bienvenidas: Ayuda > Informar de un problema.',
  fr: 'Traduction automatique - Corrections bienvenues : Aide > Signaler un problème.',
})

/** The machine-translation note for a language, or null if people wrote it. */
export function machineTranslationNote(code: string): string | null {
  return isAvailableLanguage(code) ? MACHINE_TRANSLATION_NOTES[code] ?? null : null
}

/** A language's own name for itself ("English", "Deutsch"), for the picker. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (name === undefined || name === '') return code
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch {
    return code
  }
}
