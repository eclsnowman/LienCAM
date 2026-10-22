// WO-2319: the typed text lookup and the catalog layout.
//
// The @ts-expect-error lines are the type-check half of this file: tsc fails
// if a wrong key or area ever stops being an error (the directive goes unused),
// so "a missing key is a type-check error" is guarded by the normal tsc run.
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import {
  AVAILABLE_LANGUAGES,
  SOURCE_LANGUAGE,
  i18n,
  isAvailableLanguage,
  languageName,
  machineTranslationNote,
  textFor,
  type Translation,
} from '../../i18n'
import { ENGLISH_CATALOG, type CatalogTree } from '../../i18n/catalogs'

describe('WO-2319: typed text lookup', () => {
  it('reads English words by key', () => {
    const t = textFor('language')
    expect(t('section')).toBe('Language')
    expect(t('label')).toBe('Interface language')
    expect(i18n.language).toBe('en')
  })

  it('makes a wrong key or area a type error', () => {
    const t = textFor('language')
    // @ts-expect-error - not a key in the English 'language' catalog
    expect(t('lable')).toBe('lable')
    // @ts-expect-error - a default value does not excuse a missing key
    expect(t('lable', { defaultValue: 'Label' })).toBe('Label')
    // @ts-expect-error - not a catalog area
    expect(() => textFor('no-such-area')).not.toThrow()
    const partial: Translation<'language'> = { label: 'Sprache der Oberflaeche' }
    // @ts-expect-error - a translation may only use English keys
    const extra: Translation<'language'> = { lable: 'x' }
    expect([partial.label, extra]).toHaveLength(2)
  })
})

describe('WO-2319: catalog layout', () => {
  it('offers every on-disk language with a catalog, English first and others sorted', () => {
    // Read the files independently of the production discovery/export.
    const root = new URL('../../i18n/locales/', import.meta.url)
    const discovered = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        && readdirSync(new URL(`${entry.name}/`, root)).some((file) => file.endsWith('.ts')))
      .map((entry) => entry.name)
    expect(AVAILABLE_LANGUAGES).toEqual(['en', ...discovered.filter((code) => code !== 'en').sort()])
    expect(SOURCE_LANGUAGE).toBe('en')
    for (const code of discovered) expect(isAvailableLanguage(code), code).toBe(true)
    expect(isAvailableLanguage('xx-unavailable')).toBe(false)
    expect(isAvailableLanguage(undefined)).toBe(false)
    expect(languageName('en')).toBe('English')
  })

  it('keeps English and unavailable languages free of translation notices', () => {
    expect(machineTranslationNote('en')).toBeNull()
    expect(machineTranslationNote('xx-unavailable')).toBeNull()
    for (const code of ['de', 'es', 'fr']) {
      if (isAvailableLanguage(code)) expect(machineTranslationNote(code), code).toBeTruthy()
      else expect(machineTranslationNote(code), `${code} has no catalog yet`).toBeNull()
    }
  })

  it('collects one area per English file, each a tree of plain strings', () => {
    expect(Object.keys(ENGLISH_CATALOG)).toContain('language')
    const strings = (tree: CatalogTree): boolean =>
      Object.values(tree).every((value) => typeof value === 'string' || strings(value))
    for (const [area, words] of Object.entries(ENGLISH_CATALOG)) {
      expect(strings(words), area).toBe(true)
      expect(i18n.hasResourceBundle('en', area), area).toBe(true)
    }
  })

  it('formats no numbers: a value passes through with its "." decimal', () => {
    i18n.addResourceBundle('en', 'wo2319-probe', { depth: 'Depth {{value}} mm' }, true, true)
    try {
      expect(i18n.t('depth', { ns: 'wo2319-probe', value: 1234.5 } as never)).toBe('Depth 1234.5 mm')
    } finally {
      i18n.removeResourceBundle('en', 'wo2319-probe')
    }
  })
})
