// @vitest-environment jsdom
//
// React-render SMOKE test for SettingsModal. The repo's vitest env is 'node' by
// default (see vite.config.ts); the directive above flips THIS file to jsdom so
// a real React tree can mount. Mirrors NestModal.smoke.test.tsx.
//
// WHY THIS EXISTS: tsc + the pure-logic vitest suite do NOT catch React
// render-time defects (hooks-order bugs, missing store selectors). This test
// mounts the modal open and asserts the new "Nesting" settings rows render so a
// later edit that breaks them fails loudly here rather than only in the browser.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Pure test
// scaffolding; no app change.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { useCamStore } = await import('../../store')
const { APP_VERSION } = await import('../../version')
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')

const realCloseModal = useCamStore.getState().closeModal

afterEach(() => {
  act(() => { useCamStore.setState({ closeModal: realCloseModal }) })
  cleanup()
})

// The Settings selects are now the themed custom listbox (UI-BRAND-B3-1), not
// native <select>s. Drive them the way a user does: click the trigger (its
// data-testid is unchanged) to open, then click the option
// (`${testId}-option-${value}`). Value/onChange semantics are identical.
function pick(testId: string, value: string) {
  act(() => { fireEvent.click(screen.getByTestId(testId)) })
  act(() => { fireEvent.click(screen.getByTestId(`${testId}-option-${value}`)) })
}

// The store is a process singleton; force activeModal closed before each test so
// the tests are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.getState().closeModal()
  })
})

describe('SettingsModal render smoke', () => {
  it('mounts closed without crashing', () => {
    // activeModal is null (beforeEach). The modal self-gates on
    // activeModal === 'settings' and returns null, so nothing renders.
    render(<SettingsModal />)
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('opens and renders the Nesting stock-default fields', () => {
    // Mount CLOSED first so the open is a true closed->open hook transition.
    render(<SettingsModal />)
    expect(screen.queryByText('Settings')).toBeNull()

    act(() => {
      useCamStore.getState().openModal('settings')
    })

    // Body rendered: the Nesting section header plus both new field labels are
    // present. getByText throws if absent, so a non-null return is sufficient.
    expect(screen.getByText('Nesting')).not.toBeNull()
    expect(screen.getByText(/Default stock thickness \(Z\)/)).not.toBeNull()
    expect(screen.getByText(/Default stock padding \(XY\)/)).not.toBeNull()

    // Flip back closed: it must unmount cleanly.
    act(() => {
      useCamStore.getState().closeModal()
    })
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('applies STL projection quality presets and reflects custom values', () => {
    act(() => {
      useCamStore.getState().setProjectionToleranceDefault(0.02)
      useCamStore.getState().openModal('settings')
    })
    render(<SettingsModal />)

    const preset = () => screen.getByTestId('settings-projection-tolerance-preset')
    expect(preset().textContent).toContain('Standard')

    pick('settings-projection-tolerance-preset', 'draft')
    expect(useCamStore.getState().appSettings.projectionToleranceDefault).toBe(0.1)
    expect(preset().textContent).toContain('Draft')

    act(() => { useCamStore.getState().setProjectionToleranceDefault(0.037) })
    expect(preset().textContent).toContain('Custom')

    act(() => {
      useCamStore.getState().setProjectionToleranceDefault(0.02)
      useCamStore.getState().closeModal()
    })
  })

  it('renders the Startup splash checkbox bound to appSettings.showSplash', () => {
    // Mount CLOSED first so the open is a true closed->open hook transition (the
    // path that catches hooks-order render crashes). The Startup section + its
    // splash checkbox must render whenever the modal is open.
    render(<SettingsModal />)
    act(() => {
      useCamStore.getState().openModal('settings')
    })

    expect(screen.getByText('Startup')).not.toBeNull()
    const label = screen.getByText('Show splash screen on startup')
    expect(label).not.toBeNull()

    // The checkbox is bound to appSettings.showSplash (default true) and toggles
    // it via setShowSplash — proves the selector + setter are wired.
    const checkbox = label.closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(true)
    act(() => { fireEvent.click(checkbox) })
    expect(useCamStore.getState().appSettings.showSplash).toBe(false)
    // Restore so we don't bleed into sibling tests / the persisted singleton.
    act(() => { useCamStore.getState().setShowSplash(true) })

    act(() => {
      useCamStore.getState().closeModal()
    })
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('renders the About version readout (app version + file-format schema version)', () => {
    // Mount CLOSED first so the open is a true closed->open hook transition (the
    // path that catches hooks-order render crashes).
    render(<SettingsModal />)
    act(() => {
      useCamStore.getState().openModal('settings')
    })

    // App version: the single source of truth string (src/version.ts ->
    // package.json) must appear verbatim in the readout.
    const appVer = screen.getByTestId('settings-app-version')
    expect(appVer.textContent).toContain(APP_VERSION)

    // Project FILE-FORMAT version: "v" + CURRENT_PROJECT_SCHEMA_VERSION. This is
    // the saved .camproject schema version, distinct from the app version above.
    const schemaVer = screen.getByTestId('settings-schema-version')
    expect(schemaVer.textContent).toContain('v' + CURRENT_PROJECT_SCHEMA_VERSION)

    // Build provenance row: assert the LABEL renders and the value row mounts.
    // We do NOT assert the commit-hash VALUE — it changes every commit and is
    // 'dev' under vitest (the Vite `define` replacement never runs in tests).
    // Proving the row renders without crashing is the deterministic guarantee.
    expect(screen.getByText('Build')).not.toBeNull()
    expect(screen.getByTestId('settings-build-info')).not.toBeNull()

    act(() => {
      useCamStore.getState().closeModal()
    })
    expect(screen.queryByText('Settings')).toBeNull()
  })

  // WO-270 (Operator ruling 2026-08-12: "We need brand identity, not a free for all"):
  // three render-gate tests stood here -- "renders the Viewport theme
  // selector...", "renders the UI theme selector...", and "renders the
  // Selection glow selector...". Each mounted the modal and asserted its own
  // control's options, default and immediate-apply behaviour. All three
  // controls are gone, so all three tests are gone with them; the "Display"
  // section header they shared went too. Their replacement is the ABSENCE
  // gate in src/tests/components/settingsThemeRemoval.wo270.test.tsx, which
  // asserts none of the three can be found in the mounted modal.

  it('closes exactly once on safe Enter without reverting live-applied settings', () => {
    const closeModal = vi.fn(() => useCamStore.setState({ activeModal: null }))
    act(() => {
      useCamStore.setState({ closeModal })
      useCamStore.getState().setProjectionToleranceDefault(0.02)
      useCamStore.getState().openModal('settings')
    })
    render(<SettingsModal />)

    pick('settings-projection-tolerance-preset', 'draft')
    const ordinaryInput = document.createElement('input')
    ordinaryInput.type = 'text'
    screen.getByTestId('settings-modal-panel').append(ordinaryInput)
    fireEvent.keyDown(ordinaryInput, { key: 'Enter', code: 'Enter' })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(useCamStore.getState().appSettings.projectionToleranceDefault).toBe(0.1)
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()
  })

  it('closes exactly once on safe Escape without reverting live-applied settings', () => {
    const closeModal = vi.fn(() => useCamStore.setState({ activeModal: null }))
    act(() => {
      useCamStore.setState({ closeModal })
      useCamStore.getState().setProjectionToleranceDefault(0.02)
      useCamStore.getState().openModal('settings')
    })
    render(<SettingsModal />)

    pick('settings-projection-tolerance-preset', 'fine')
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(useCamStore.getState().appSettings.projectionToleranceDefault).toBe(0.005)
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()
  })

  it('does not hijack excluded Enter, composing, prevented, or consumed keys', () => {
    const closeModal = vi.fn(() => useCamStore.setState({ activeModal: null }))
    act(() => {
      useCamStore.setState({ closeModal })
      useCamStore.getState().openModal('settings')
    })
    render(<SettingsModal />)

    const panel = screen.getByTestId('settings-modal-panel')
    const ordinaryInput = document.createElement('input')
    ordinaryInput.type = 'text'
    const textarea = document.createElement('textarea')
    const multiline = document.createElement('div')
    multiline.setAttribute('aria-multiline', 'true')
    const contenteditable = document.createElement('div')
    contenteditable.setAttribute('contenteditable', 'true')
    const roleLink = document.createElement('div')
    roleLink.setAttribute('role', 'link')
    const select = document.createElement('select')
    const option = document.createElement('option')
    select.append(option)
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    const roleOption = document.createElement('div')
    roleOption.setAttribute('role', 'option')
    const disabledInput = document.createElement('input')
    disabledInput.type = 'text'
    disabledInput.disabled = true
    panel.append(
      ordinaryInput,
      textarea,
      multiline,
      contenteditable,
      roleLink,
      select,
      listbox,
      roleOption,
      disabledInput,
    )
    const done = screen.getByRole('button', { name: 'Done' })

    const expectStillOpen = () => {
      expect(closeModal).not.toHaveBeenCalled()
      expect(useCamStore.getState().activeModal).toBe('settings')
    }
    for (const target of [
      textarea,
      multiline,
      contenteditable,
      roleLink,
      select,
      option,
      listbox,
      roleOption,
      done,
      disabledInput,
    ]) {
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      expectStillOpen()
    }

    for (const key of ['Enter', 'Escape']) {
      fireEvent.keyDown(ordinaryInput, { key, code: key, isComposing: true })
      expectStillOpen()

      fireEvent.keyDown(ordinaryInput, { key, code: key, keyCode: 229 })
      expectStillOpen()

      ordinaryInput.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
      fireEvent.keyDown(ordinaryInput, { key, code: key })
      expectStillOpen()

      ordinaryInput.addEventListener('keydown', (event) => event.stopPropagation(), { once: true })
      fireEvent.keyDown(ordinaryInput, { key, code: key })
      expectStillOpen()
    }

    fireEvent.keyDown(ordinaryInput, { key: 'Process', code: 'Process' })
    expectStillOpen()

    // Native activation remains the one and only close path for the Done button.
    fireEvent.click(done)
    expect(closeModal).toHaveBeenCalledTimes(1)
  })

  it('routes unconsumed Escape from a multiline child through Done', () => {
    const closeModal = vi.fn(() => useCamStore.setState({ activeModal: null }))
    act(() => {
      useCamStore.setState({ closeModal })
      useCamStore.getState().openModal('settings')
    })
    render(<SettingsModal />)

    const textarea = document.createElement('textarea')
    screen.getByTestId('settings-modal-panel').append(textarea)
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(useCamStore.getState().activeModal).toBeNull()
  })
})
