// @vitest-environment jsdom
//
// WO-3275 (UI M2 Wave 0): the New UI switch. Off by default; off renders the legacy shell with
// no wrapper (the same DOM as rendering it directly); on mounts the New UI root with its scoped
// tokens; a dev query flag overrides for one load without persisting; App's default export goes
// through the gate.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  applyNewUiQuery, isNewUiOn, NEW_UI_DEFAULT, NEW_UI_STORAGE_KEY, parseNewUiQuery, resetNewUiQueryForTests, setNewUi,
} from '../../ui2/newUiSwitch'
import { NewUiGate } from '../../ui2/NewUiGate'

const ROOT = join(__dirname, '..', '..', '..')

function Legacy() {
  return <main className="app-shell"><header>old</header><section data-testid="legacy">panels</section></main>
}

beforeEach(() => { localStorage.removeItem(NEW_UI_STORAGE_KEY); resetNewUiQueryForTests() })
afterEach(() => { cleanup(); localStorage.removeItem(NEW_UI_STORAGE_KEY); resetNewUiQueryForTests() })

describe('WO-3275 New UI switch', () => {
  it('is off by default', () => {
    expect(NEW_UI_DEFAULT).toBe(false)
    expect(isNewUiOn()).toBe(false)
  })

  it('off: renders exactly the legacy tree, no wrapper element', () => {
    const direct = render(<Legacy />).container.innerHTML
    cleanup()
    const gated = render(<NewUiGate legacy={<Legacy />} />).container.innerHTML
    expect(gated).toBe(direct)
    expect(screen.queryByTestId('ui2-root')).toBeNull()
  })

  it('on: mounts the New UI root with its tokens and the empty shell frame', async () => {
    setNewUi(true)
    expect(localStorage.getItem(NEW_UI_STORAGE_KEY)).toBe('1')
    render(<NewUiGate legacy={<Legacy />} />)
    const root = await screen.findByTestId('ui2-root', {}, { timeout: 30000 })
    expect(root.hasAttribute('data-ui2')).toBe(true)
    expect(root.getAttribute('data-ui2-theme')).toBe('dark')
    expect(root.querySelector('style')?.textContent).toContain('[data-ui2]{')
    expect(screen.getByTestId('ui2-shell')).toBeTruthy()
    expect(screen.queryByTestId('legacy')).toBeNull()
  })

  it('flips live when set from code', async () => {
    render(<NewUiGate legacy={<Legacy />} />)
    expect(screen.getByTestId('legacy')).toBeTruthy()
    act(() => setNewUi(true))
    expect(await screen.findByTestId('ui2-root', {}, { timeout: 30000 })).toBeTruthy()
    act(() => setNewUi(false))
    expect(screen.getByTestId('legacy')).toBeTruthy()
  })

  it('the dev query flag overrides for this load only', () => {
    expect(parseNewUiQuery('?newui=1')).toBe(true)
    expect(parseNewUiQuery('?a=b&newui=off')).toBe(false)
    expect(parseNewUiQuery('?newui=maybe')).toBeUndefined()
    expect(parseNewUiQuery('')).toBeUndefined()
    applyNewUiQuery('?newui=1')
    expect(isNewUiOn()).toBe(true)
    expect(localStorage.getItem(NEW_UI_STORAGE_KEY)).toBeNull()
  })

  it('App routes its default export through the gate with the legacy shell', () => {
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8')
    expect(app).toMatch(/export default function App\(\) \{\n {2}return <NewUiGate legacy=\{<LegacyApp \/>\} \/>\n\}/)
    expect(app.match(/export default/g)).toHaveLength(1)
    expect(app).toMatch(/\nfunction LegacyApp\(\) \{/)
  })
})
