// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { BottomConsole } = await import('../../components/panels/BottomConsole')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState({ activeModal: null, consoleEvents: [], consoleReadThroughId: 0 })
  })
})

describe('Help and troubleshooting', () => {
  it('opens from app chrome, searches current topics, and links the console to error details', async () => {
    render(
      <>
        <TopToolbar />
        <BottomConsole defaultExpanded />
        <HelpCenterModal />
      </>,
    )

    fireEvent.click(screen.getByTestId('toolbar-help'))
    await waitFor(() => expect(screen.getByTestId('help-center')).toBeTruthy())
    // HELP-1 S2: opening Help selects the TOP CONTEXT SUGGESTION and pins the
    // suggested group. In a fresh session (workspace:cam + mode:setup) the
    // most specific match is the first-toolpath walkthrough (mode beats
    // workspace in the ranking).
    expect(screen.getByTestId('help-suggested').textContent).toMatch(/Suggested for what you're doing/)
    expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Your first toolpath/)

    // Search narrows to a small filtered subset (exact counts would break
    // every time the index grows) and clicking a result shows its topic.
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'voxel' } })
    const hits = screen.getAllByTestId(/^help-topic-/).filter((el) => el.tagName === 'BUTTON')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.length).toBeLessThan(10)
    fireEvent.click(screen.getByTestId('help-topic-stock-simulation'))
    expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Stock simulation/)
    expect(screen.getByTestId('help-center').textContent).toMatch(/not an exhaustive manual/i)

    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByTestId('help-topic-keyboard-shortcuts'))
    // Topic bodies are code-split per category (HELP-1 S1) - loaded async.
    await waitFor(() => {
      expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Shift\+G/)
    })
    expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Ctrl\+Z/)

    fireEvent.click(screen.getByTestId('help-center-close'))
    expect(screen.queryByTestId('help-center')).toBeNull()

    fireEvent.click(screen.getByTestId('console-help'))
    await waitFor(() => {
      expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Where error details live/)
    })
    await waitFor(() => {
      expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Warning, and Error buttons/i)
    })
  })

  it('an unread console error elevates the error topics when Help opens normally', async () => {
    render(<HelpCenterModal />)
    act(() => {
      useCamStore.setState({
        consoleEvents: [
          { id: 7, severity: 'error', source: 'test', message: 'boom', at: 1 } as never,
        ],
        consoleReadThroughId: 0,
      })
      useCamStore.getState().openModal('help')
    })
    await waitFor(() => expect(screen.getByTestId('help-center')).toBeTruthy())
    const suggested = screen.getByTestId('help-suggested')
    const rows = suggested.querySelectorAll('[data-testid^="help-topic-"]')
    // error:recent outranks the workspace match - error topics pin first.
    expect(rows[0]?.getAttribute('data-testid')).toBe('help-topic-error-details')
    expect(screen.getByTestId('help-topic-content').textContent).toMatch(/Where error details live/)
  })

  it('zooms an enlarged image in bounded wheel steps without scrolling the page and resets on reopen', async () => {
    render(<HelpCenterModal />)
    act(() => useCamStore.getState().openModal('help'))
    const trigger = await screen.findByRole('button', {
      name: /Enlarge Five small screenshots showing import, setup, operation, toolpath view, and post process/i,
    })

    fireEvent.click(trigger)
    const lightbox = screen.getByTestId('help-image-lightbox')
    const image = screen.getByTestId('help-image-lightbox-image')
    expect(image.getAttribute('data-zoom')).toBe('1.00')
    fireEvent.wheel(lightbox, { deltaY: -1 })
    expect(image.getAttribute('data-zoom')).toBe('1.25')

    for (let i = 0; i < 20; i += 1) fireEvent.wheel(lightbox, { deltaY: -1 })
    expect(image.getAttribute('data-zoom')).toBe('3.00')
    for (let i = 0; i < 20; i += 1) fireEvent.wheel(lightbox, { deltaY: 1 })
    expect(image.getAttribute('data-zoom')).toBe('1.00')

    fireEvent.click(screen.getByTestId('help-image-lightbox-close'))
    fireEvent.click(trigger)
    expect(screen.getByTestId('help-image-lightbox-image').getAttribute('data-zoom')).toBe('1.00')
  })

  it('enters All topics collapsed, preserves deliberate disclosure choices, and resets them on reopen', async () => {
    render(<HelpCenterModal />)
    act(() => useCamStore.getState().openModal('help'))
    await waitFor(() => expect(screen.getByTestId('help-suggested')).toBeTruthy())

    fireEvent.click(screen.getByTestId('help-nav-tab-all'))
    const categories = screen.getAllByTestId(/^help-cat-/) as HTMLButtonElement[]
    expect(categories.length).toBeGreaterThan(0)
    expect(categories.every((category) => category.getAttribute('aria-expanded') === 'false')).toBe(true)

    fireEvent.click(categories[0])
    expect(categories[0].getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByTestId('help-nav-tab-suggested'))
    fireEvent.click(screen.getByTestId('help-nav-tab-all'))
    expect(screen.getAllByTestId(/^help-cat-/)[0].getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByTestId('help-center-close'))
    expect(screen.queryByTestId('help-center')).toBeNull()
    act(() => useCamStore.getState().openModal('help'))
    await waitFor(() => expect(screen.getByTestId('help-suggested')).toBeTruthy())
    fireEvent.click(screen.getByTestId('help-nav-tab-all'))
    expect(screen.getAllByTestId(/^help-cat-/).every((category) => category.getAttribute('aria-expanded') === 'false')).toBe(true)
  })

  it('maximizes help images and closes only the lightbox through every dismissal path', async () => {
    render(<HelpCenterModal />)
    act(() => useCamStore.getState().openModal('help'))

    const trigger = await screen.findByRole('button', {
      name: /Enlarge Five small screenshots showing import, setup, operation, toolpath view, and post process/i,
    })
    const alt = 'Five small screenshots showing import, setup, operation, toolpath view, and post process'

    // Pointer activation opens the maximized dialog; the obvious X closes it.
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: alt })).toBeTruthy()
    expect(screen.getByTestId('help-center').contains(screen.getByTestId('help-image-lightbox'))).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('help-image-lightbox-close'))
    fireEvent.click(screen.getByTestId('help-image-lightbox-close'))
    expect(screen.queryByTestId('help-image-lightbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    // Clicking the scrim, but not the image content, is a second close path.
    fireEvent.click(trigger)
    fireEvent.click(screen.getByTestId('help-image-lightbox'))
    expect(screen.queryByTestId('help-image-lightbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    // The figure is keyboard-activatable. Escape is captured by the top layer,
    // leaves Help open underneath, and returns focus to the opening figure.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByTestId('help-image-lightbox')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('help-image-lightbox')).toBeNull()
    expect(screen.getByTestId('help-center')).toBeTruthy()
    expect(useCamStore.getState().activeModal).toBe('help')
    expect(document.activeElement).toBe(trigger)

    fireEvent.keyDown(trigger, { key: ' ' })
    expect(screen.getByTestId('help-image-lightbox')).toBeTruthy()
  })
})
