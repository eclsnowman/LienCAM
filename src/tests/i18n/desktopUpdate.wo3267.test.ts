import { describe, expect, it } from 'vitest'

const AREA = 'desktop-update.wo3267'

// WO-3267: the desktop update offer reads its text from the catalogue.
describe('WO-3267: desktop update offer text', () => {
  it('keeps the English wording word for word, with interpolated values', async () => {
    const { applyLanguage, textFor } = await import('../../i18n')
    await applyLanguage('en')
    const t = textFor(AREA)
    expect([
      t('offerAvailable', { version: '0.2.0', currentVersion: '0.1.0' }),
      t('offerAvailableSized', { version: '0.2.0', currentVersion: '0.1.0', size: '12.5 MB' }),
      t('notNow'), t('download'),
      t('downloadingPercent', { version: '0.2.0', percent: 42 }),
      t('downloading', { version: '0.2.0' }),
      t('downloaded', { version: '0.2.0' }),
      t('installExplanation'), t('showFileExplanation'),
      t('later'), t('installAndRestart'), t('showFile'), t('close'), t('downloadAgain'),
      t('downloadFailed', { version: '0.2.0', error: 'offline' }),
      t('downloadedMatched', { version: '0.2.0' }),
      t('installChecking', { version: '0.2.0' }),
      t('installFailed', { version: '0.2.0', error: 'disk full' }),
    ]).toEqual([
      'LienCAM 0.2.0 is available (you have 0.1.0).',
      'LienCAM 0.2.0 is available (you have 0.1.0), 12.5 MB.',
      'Not now', 'Download',
      'Downloading LienCAM 0.2.0: 42%',
      'Downloading LienCAM 0.2.0...',
      'LienCAM 0.2.0 is downloaded and checked.',
      'Installing closes LienCAM and the machine bridge, then starts the new version. Your settings, machine, tools and projects are kept.',
      'This copy cannot replace itself; LienCAM shows you the checked file to start instead.',
      'Later', 'Install and restart', 'Show the file', 'Close', 'Download again',
      'LienCAM could not download 0.2.0 (offline); nothing was installed.',
      'LienCAM 0.2.0 downloaded and matched its published SHA-256 checksum.',
      'Checking LienCAM 0.2.0 again before installing...',
      'LienCAM could not install 0.2.0 (disk full); this copy is unchanged.',
    ])
  })

  it.each(['de', 'es', 'fr'])('translates every key in %s and keeps placeholders', async language => {
    const { applyLanguage, textFor } = await import('../../i18n')
    const { ENGLISH_CATALOG, loadCatalog } = await import('../../i18n/catalogs')
    const { structuralIssues } = await import('../../../tools/i18n-freshness.mjs')
    const english = ENGLISH_CATALOG[AREA]
    expect(english, `English catalogue for ${AREA}`).toBeDefined()
    const translated = (await loadCatalog(language))[AREA]
    expect(translated, `${language} catalogue for ${AREA}`).toBeDefined()
    expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort())
    for (const [key, text] of Object.entries(english)) {
      expect(typeof translated[key], key).toBe('string')
      expect(translated[key], key).not.toBe(text)
      expect(structuralIssues(String(text), String(translated[key])), key).toEqual([])
    }
    try {
      await applyLanguage(language)
      const t = textFor(AREA)
      expect(t('downloadFailed', { version: '0.2.0', error: 'Error: <offline> & timeout' }))
        .toBe(String(translated.downloadFailed).replace('{{version}}', '0.2.0').replace('{{error}}', 'Error: <offline> & timeout'))
      expect(t('offerAvailableSized', { version: '0.2.0', currentVersion: '0.1.0', size: '12.5 MB' }))
        .toBe(String(translated.offerAvailableSized).replace('{{version}}', '0.2.0').replace('{{currentVersion}}', '0.1.0').replace('{{size}}', '12.5 MB'))
    } finally {
      await applyLanguage('en')
    }
  })
})
