// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

// Install storage before importing persisted stores, just as a browser does.
const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => [...memory.keys()][index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { ToolLibraryModal, TOOL_LIST_PANE_DEFAULT, TOOL_LIST_PANE_MIN } = await import('../../components/modals/ToolLibraryModal')
const { PanelResizer } = await import('../../components/panels/PanelResizer')
const { useCamStore } = await import('../../store')
const {
  useUiPrefs, UI_PREFS_STORAGE_KEY, UI_PREFS_VERSION, UI_SCALE_DEFAULT,
  isUiScalePreference, resolveUiScale, resolveEffectivePanelWidth,
  PANEL_LEFT_DEFAULT, PANEL_RIGHT_DEFAULT,
} = await import('../../store/uiPrefs')

beforeEach(() => {
  act(() => {
    useCamStore.getState().closeModal()
    useUiPrefs.setState({ uiScale: UI_SCALE_DEFAULT, panelSizes: {},
      panelLeftWidth: PANEL_LEFT_DEFAULT, panelRightWidth: PANEL_RIGHT_DEFAULT,
      panelLeftWidthCustomized: false, panelRightWidthCustomized: false })
  })
})
afterEach(cleanup)

describe('WO-2511: smaller interface scale through existing Settings', () => {
  it('offers the smaller choices alongside every existing choice', () => {
    render(<SettingsModal />)
    act(() => { useCamStore.getState().openModal('settings') })
    fireEvent.click(screen.getByTestId('settings-interface-scale'))
    for (const [value, label] of [['auto', 'Auto'], ['0.8', '80%'], ['0.9', '90%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%']]) {
      expect(screen.getByTestId(`settings-interface-scale-option-${value}`).textContent).toContain(label)
    }
  })

  for (const scale of [0.8, 0.9] as const) {
    it(`selects ${scale * 100}% in Settings and rehydrates the persisted choice`, async () => {
      render(<SettingsModal />)
      act(() => { useCamStore.getState().openModal('settings') })
      fireEvent.click(screen.getByTestId('settings-interface-scale'))
      fireEvent.click(screen.getByTestId(`settings-interface-scale-option-${scale}`))
      expect(useUiPrefs.getState().uiScale).toBe(scale)
      expect(screen.getByTestId('settings-interface-scale').textContent).toContain(`${scale * 100}%`)
      const saved = storage.getItem(UI_PREFS_STORAGE_KEY)!
      expect(JSON.parse(saved).state.uiScale).toBe(scale)
      act(() => { useUiPrefs.setState({ uiScale: 'auto' }) })
      storage.setItem(UI_PREFS_STORAGE_KEY, saved)
      await act(async () => { await useUiPrefs.persist.rehydrate() })
      expect(useUiPrefs.getState().uiScale).toBe(scale)
      expect(resolveUiScale(useUiPrefs.getState().uiScale, 1366, 1.5)).toBe(scale)
    })

    it(`keeps panel keyboard math in rendered pixels at ${scale * 100}%`, () => {
      act(() => { useUiPrefs.getState().setUiScale(scale) })
      render(<PanelResizer side="left" />)
      const handle = screen.getByRole('separator')
      const inputs = { panelLeftWidth: PANEL_LEFT_DEFAULT, panelRightWidth: PANEL_RIGHT_DEFAULT,
        panelLeftWidthCustomized: false, panelRightWidthCustomized: false,
        viewportCssWidth: window.innerWidth, uiScale: scale }
      const width = resolveEffectivePanelWidth('left', inputs)
      expect(Number(handle.getAttribute('aria-valuenow'))).toBe(width)
      fireEvent.keyDown(handle, { key: 'ArrowRight' })
      expect(Number(handle.getAttribute('aria-valuenow'))).toBe(width + 8)
      expect(useUiPrefs.getState().panelLeftWidth).toBe(width + 8)
    })

    it(`scales Tool Library default and minimum together at ${scale * 100}%`, () => {
      act(() => { useUiPrefs.getState().setUiScale(scale); useCamStore.getState().openModal('tool-library') })
      render(<ToolLibraryModal />)
      const pane = screen.getByTestId('tool-library-split').firstElementChild as HTMLElement
      expect(pane.style.width).toBe(`${Math.round(TOOL_LIST_PANE_DEFAULT * scale)}px`)
      expect(pane.style.minWidth).toBe(`${Math.round(TOOL_LIST_PANE_MIN * scale)}px`)
    })
  }

  it('preserves Auto and existing explicit scales', () => {
    expect(UI_SCALE_DEFAULT).toBe('auto')
    for (const width of [1366, 1600, 1920]) expect(resolveUiScale('auto', width, 1)).toBe(1)
    expect(resolveUiScale('auto', 3840, 1)).toBe(1.5)
    expect(resolveUiScale('auto', 2560, 1.5)).toBe(1)
    for (const scale of [1, 1.25, 1.5] as const) {
      expect(isUiScalePreference(scale)).toBe(true)
      expect(resolveUiScale(scale, 1366, 1)).toBe(scale)
    }
  })

  it('rejects arbitrary writes and falls back for invalid persisted scales', async () => {
    act(() => { useUiPrefs.getState().setUiScale(0.8) })
    for (const invalid of [0, -1, 0.7, 0.85, '0.8', null]) {
      expect(isUiScalePreference(invalid)).toBe(false)
      // Runtime validation also applies to untyped callers.
      act(() => { useUiPrefs.getState().setUiScale(invalid as never) })
      expect(useUiPrefs.getState().uiScale).toBe(0.8)
    }
    storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({ version: UI_PREFS_VERSION, state: { uiScale: 0.7 } }))
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    expect(useUiPrefs.getState().uiScale).toBe(UI_SCALE_DEFAULT)
  })
})
