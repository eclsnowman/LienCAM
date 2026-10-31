// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HeightDiagram, HeightsExplainedNotice } from '../../components/modals/newOperationModalParts'
import { useHelpOpen } from '../../help/helpOpen'
import { useCamStore } from '../../store'
import { defaultHeights } from '../../components/modals/newOperationModalDefaults'
import { applyLanguage, i18n } from '../../i18n'

afterEach(async () => {
  await applyLanguage('en')
  cleanup()
  useHelpOpen.setState({ overlay: false, requested: null })
})

describe('WO-3103 Heights explanation', () => {
  it('starts closed, expands on summary click, and can collapse again', () => {
    render(<HeightsExplainedNotice />)
    const notice = screen.getByTestId('heights-explained') as HTMLDetailsElement
    expect(notice.open).toBe(false)
    fireEvent.click(screen.getByText('How these heights are used'))
    expect(notice.open).toBe(true)
    expect(notice.textContent).toContain('about 1 mm')
    expect(notice.textContent).toContain('even above Clearance')
    fireEvent.click(screen.getByText('How these heights are used'))
    expect(notice.open).toBe(false)
  })

  it('opens Heights explained over the operation editor while still collapsed', () => {
    useCamStore.setState({ activeModal: 'new-operation' })
    render(<HeightsExplainedNotice />)
    fireEvent.click(screen.getByTestId('help-link-height-references'))
    expect(useHelpOpen.getState().requested?.topicId).toBe('height-references')
    expect(useHelpOpen.getState().overlay).toBe(true)
    expect(useCamStore.getState().activeModal).toBe('new-operation')
    expect((screen.getByTestId('heights-explained') as HTMLDetailsElement).open).toBe(false)
  })

  it('labels numeric references separately from the illustrative local route', () => {
    const heights = { ...defaultHeights }
    const before = JSON.stringify(heights)
    render(<HeightDiagram heights={heights} />)
    expect(screen.getByText('Reference planes (WCS Z)')).toBeTruthy()
    expect(screen.getByText('Clearance')).toBeTruthy()
    expect(screen.getByText('Retract')).toBeTruthy()
    expect(screen.getByText('Feed height')).toBeTruthy()
    expect(screen.getByText('Top of cut')).toBeTruthy()
    expect(screen.getByText('Bottom of cut')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Illustrative local route - not to scale' })).toBeTruthy()
    for (const label of ['Entry start', 'Ordinary hop', 'Clamp crossing', 'Material left']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(JSON.stringify(heights)).toBe(before)
  })

  it.each(['de', 'es', 'fr'])('provides %s translations for every new UI string', async language => {
    await applyLanguage(language)
    const english = i18n.getResource('en', 'cam-operations-new-operation', 'newOperationModalParts')
    for (const key of ['Heights_explained', 'Entry_explained', 'Travel_explained', 'Clearance_explained',
      'Reference_planes', 'Illustrative_route', 'Entry_start', 'Ordinary_hop', 'Clamp_crossing', 'Material_left']) {
      const translated = i18n.getResource(language, 'cam-operations-new-operation', `newOperationModalParts.${key}`)
      expect(typeof translated).toBe('string')
      expect(translated).not.toBe(english[key])
    }
  })
})
