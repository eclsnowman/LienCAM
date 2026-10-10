// @vitest-environment jsdom
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pkg from '../../../package.json'
import credits from '../../about/credits.json'
import { APP_VERSION, BUILD_DATE, GIT_COMMIT_LABEL } from '../../version'
import { assetUrl } from '../../lib/assetUrl'
import { AboutModal } from '../../components/modals/AboutModal'
import { HelpCenterModal } from '../../components/modals/HelpCenterModal'
import { useCamStore } from '../../store'
import { useHelpOpen } from '../../help/helpOpen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useCamStore.setState({ activeModal: null })
  useHelpOpen.setState({ overlay: false, requested: null })
})

function select(label: string) { fireEvent.click(screen.getByRole('tab', { name: label })) }

describe('WO-2361 About LienCAM', () => {
  it('renders package version, build provenance, copyright and the exact licence statement', () => {
    render(<AboutModal isOpen onClose={() => {}} />)
    const panel = screen.getByRole('tabpanel')
    expect(APP_VERSION).toBe(pkg.version)
    expect(panel.textContent).toContain(`Version ${pkg.version}`)
    expect(panel.textContent).toContain(GIT_COMMIT_LABEL)
    expect(panel.textContent).toContain(BUILD_DATE)
    expect(panel.textContent).toContain('Copyright (c) 2026 Eric Lien and LienCAM contributors')
    expect(panel.textContent).toContain("Apache-2.0 for LienCAM's own code; the adaptive-clearing engine is a separate LGPL-2.1-or-later module")
    expect(screen.getByRole('img', { name: 'LienCAM' }).getAttribute('src')).toContain('liencam-wordmark.svg')
  })

  it('renders every JSON credit once, with its category, thanks and existing link', () => {
    render(<AboutModal isOpen onClose={() => {}} />)
    select('Credits')
    const rows = screen.getAllByTestId('about-credit-row')
    expect(rows).toHaveLength(credits.entries.length)
    for (const entry of credits.entries) {
      const row = rows.find((element) => element.dataset.creditId === entry.id)!
      expect(row.textContent).toContain(entry.name)
      expect(row.textContent).toContain(entry.thanks)
      expect(row.closest('section')?.querySelector('h2')?.textContent)
        .toBe(credits.categories.find((category) => category.id === entry.category)?.title)
      if (entry.link) expect(within(row).getByRole('link').getAttribute('href')).toBe(entry.link)
      else expect(within(row).queryByRole('link')).toBeNull()
    }
  })

  it('negative control: deleting one entry from a temporary copy removes exactly one row; restore recovers it', () => {
    const onClose = () => {}
    const { rerender } = render(<AboutModal isOpen onClose={onClose} />)
    select('Credits')
    expect(screen.getAllByTestId('about-credit-row')).toHaveLength(credits.entries.length)
    const temporary = structuredClone(credits)
    const removed = temporary.entries.pop()!
    rerender(<AboutModal isOpen onClose={onClose} credits={temporary} />)
    expect(screen.getAllByTestId('about-credit-row')).toHaveLength(credits.entries.length - 1)
    expect(screen.queryByText(removed.name)).toBeNull()
    rerender(<AboutModal isOpen onClose={onClose} />)
    expect(screen.getAllByTestId('about-credit-row')).toHaveLength(credits.entries.length)
    expect(screen.getByText(removed.name)).toBeTruthy()
  })

  it('loads the actual bundled licence files through the base-aware helper into the same dialog', async () => {
    const files = ['LICENSE', 'THIRD_PARTY_LICENSES.md']
    const texts = files.map((file) => readFileSync(file, 'utf8'))
    const fetcher = vi.fn(async (url: string) => {
      const index = files.findIndex((file) => assetUrl(file) === url)
      if (index < 0) throw new Error(`Unexpected URL: ${url}`)
      return { ok: true, text: async () => texts[index] }
    })
    vi.stubGlobal('fetch', fetcher)
    render(<AboutModal isOpen onClose={() => {}} />)
    select('Licence texts')
    await waitFor(() => expect(screen.getByRole('tabpanel').querySelectorAll('pre')).toHaveLength(2))
    const shown = [...screen.getByRole('tabpanel').querySelectorAll('pre')]
    expect(shown.map((element) => element.textContent)).toEqual(texts)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(files.map(assetUrl))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('keeps successful texts when one file fails and retries the failed load', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => 'Apache text' })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, text: async () => 'Restored text' })
    vi.stubGlobal('fetch', fetcher)
    render(<AboutModal isOpen onClose={() => {}} />)
    select('Licence texts')
    await screen.findByRole('alert')
    expect(screen.getByText('Apache text')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503')
    fireEvent.click(screen.getByRole('button', { name: 'Retry licence texts' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await waitFor(() => expect(screen.getAllByText('Restored text')).toHaveLength(2))
  })

  it('supports keyboard tabs and resets to About on a fresh open', () => {
    const onClose = vi.fn()
    const { rerender } = render(<AboutModal isOpen onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'About' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Credits' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Credits' }))
    rerender(<AboutModal isOpen={false} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<AboutModal isOpen onClose={onClose} />)
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true')
  })

  it('opens from real Help, and Escape or Close returns to Help without clearing an underlying editor', async () => {
    function HelpHost() {
      const [open, setOpen] = useState(false)
      return <>
        <HelpCenterModal aboutOpen={open} onAbout={() => setOpen(true)} />
        <AboutModal isOpen={open} onClose={() => setOpen(false)} />
      </>
    }
    act(() => {
      useCamStore.setState({ activeModal: 'post-process' })
      useHelpOpen.setState({ overlay: true })
    })
    render(<HelpHost />)
    const opener = screen.getByRole('button', { name: 'About LienCAM' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByTestId('about-modal')).toBeTruthy()
    expect(screen.getByTestId('help-center-backdrop').hasAttribute('inert')).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('about-modal')).toBeNull())
    expect(useCamStore.getState().activeModal).toBe('post-process')
    expect(useHelpOpen.getState().overlay).toBe(true)
    expect(document.activeElement).toBe(opener)
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('about-modal')).toBeNull()
    expect(useHelpOpen.getState().overlay).toBe(true)
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Close About LienCAM' }))
    expect(screen.queryByTestId('about-modal')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useHelpOpen.getState().overlay).toBe(false)
    expect(useCamStore.getState().activeModal).toBe('post-process')
  })
})
