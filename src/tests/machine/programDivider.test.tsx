// @vitest-environment jsdom
//
// WO-117: the preview/list divider is user-owned. Prove pointer + keyboard
// control and the actual uiPrefs persistence round trip into the APPLIED grid,
// rather than merely checking that a number reached localStorage.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { UI_PREFS_STORAGE_KEY, useUiPrefs } = await import('../../store/uiPrefs')
const {
  PROGRAM_LIST_MIN_PX,
  PROGRAM_PREVIEW_DEFAULT_PERCENT,
  PROGRAM_PREVIEW_MIN_PX,
  setProgramPreviewPercent,
} = await import('../../components/machine/ProgramDivider')

async function mountControlTab() {
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
  return screen.getByTestId('control-page').querySelector<HTMLElement>('.control-col-main')!
}

beforeEach(() => {
  mem.clear()
  setProgramPreviewPercent(PROGRAM_PREVIEW_DEFAULT_PERCENT)
})

afterEach(cleanup)

describe('WO-117 preview/list divider', () => {
  it('keeps the old 3:2 default, exposes low pane minimums, and supports the keyboard', async () => {
    const columns = await mountControlTab()
    const divider = screen.getByRole('separator', {
      name: 'Resize program preview and G-code list',
    })

    expect(columns.style.getPropertyValue('--control-program-preview-fr')).toBe('60fr')
    expect(columns.style.getPropertyValue('--control-program-list-fr')).toBe('40fr')
    expect(PROGRAM_PREVIEW_MIN_PX).toBe(120)
    expect(PROGRAM_LIST_MIN_PX).toBe(160)
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(columns.style.getPropertyValue('--control-program-preview-fr')).toBe('62fr'),
    )
    fireEvent.keyDown(divider, { key: 'ArrowLeft', shiftKey: true })
    await waitFor(() =>
      expect(columns.style.getPropertyValue('--control-program-preview-fr')).toBe('52fr'),
    )
  })

  it('drags larger, persists in uiPrefs, and reapplies the saved split after reload', async () => {
    let columns = await mountControlTab()
    vi.spyOn(columns, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect)
    const divider = screen.getByTestId('control-program-divider')

    fireEvent.pointerDown(divider, { clientX: 600 })
    fireEvent.pointerMove(window, { clientX: 700 })
    fireEvent.pointerUp(window)

    await waitFor(() =>
      expect(columns.style.getPropertyValue('--control-program-preview-fr')).toBe('70.1fr'),
    )
    const saved = mem.get(UI_PREFS_STORAGE_KEY)
    expect(saved).toBeTruthy()
    expect(JSON.parse(saved!).state.machineProgramPreviewPercent).toBe(70.1)

    // Simulate a fresh page's default in memory, restore the browser's saved
    // payload, then exercise Zustand persist's real merge/rehydrate path.
    cleanup()
    setProgramPreviewPercent(PROGRAM_PREVIEW_DEFAULT_PERCENT)
    mem.set(UI_PREFS_STORAGE_KEY, saved!)
    await act(async () => { await useUiPrefs.persist.rehydrate() })

    columns = await mountControlTab()
    expect(columns.style.getPropertyValue('--control-program-preview-fr')).toBe('70.1fr')
    expect(columns.style.getPropertyValue('--control-program-list-fr')).toBe('29.9fr')
    expect(screen.getByTestId('control-program-divider').getAttribute('aria-valuenow')).toBe('70.1')
  })
})
