// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const AREA = 'guided-setup.wo3256'

// WO-3256: the Guided setup reads its words from the catalogue, in every language.
afterEach(async () => {
  cleanup()
  const { applyLanguage } = await import('../../i18n')
  await applyLanguage('en')
})

describe('WO-3256 Guided setup words', () => {
  it('keeps the English wording word for word, with interpolated values', async () => {
    const { applyLanguage, textFor } = await import('../../i18n')
    await applyLanguage('en')
    const t = textFor(AREA)
    expect([
      t('title'), t('machineSummary', { name: 'Shop router' }), t('toolsSummary', { count: 3 }),
      t('unitsSummary', { display: t('unitIn'), export: t('unitMm') }), t('unitsNote'), t('savedNote'),
      t('skip'), t('continue'),
    ]).toEqual([
      'Guided setup', 'Project machine: Shop router', 'Tools in your library: 3',
      'Display units: inches (in). G-code export units: millimetres (mm).',
      'Display units and G-code export units are separate settings.',
      'Saved changes stay when you leave setup.', 'Skip setup', 'Continue to project',
    ])
  })

  it.each(['de', 'es', 'fr'])('translates every key in %s and keeps placeholders', async language => {
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
  })

  it('the open guide switches language live, interpolating the real counts', async () => {
    const { useCamStore } = await import('../../store')
    const { applyLanguage } = await import('../../i18n')
    const { GuidedSetupModal, useGuidedSetup } = await import('../../components/modals/GuidedSetupModal')
    act(() => useCamStore.setState({ toolLibrary: [] }))
    act(() => useGuidedSetup.getState().show())
    render(<GuidedSetupModal onOpenChild={() => undefined} />)
    expect(screen.getByRole('dialog', { name: 'Guided setup' })).toBeTruthy()
    await act(async () => { await applyLanguage('de') })
    expect(screen.getByRole('dialog', { name: 'Geführte Einrichtung' })).toBeTruthy()
    expect(screen.getByText('Werkzeuge in Ihrer Bibliothek: 0')).toBeTruthy()
    act(() => useGuidedSetup.getState().hide())
  })
})
