// @vitest-environment jsdom
// Only WebGL's Viewport boundary is mocked; App, the scheduler, store and
// BottomConsole are production code, so removing the App wiring fails here.
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { typedMock } from '../../support/typedMock'
import { APP_VERSION } from '../../../version'

vi.mock('../../../components/viewport/Viewport', () => typedMock<typeof import('../../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

// Same storage seam as AppBottomConsole.smoke; jsdom has no desktop persistence.
const mem = new Map<string, string>()
const storage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: key => mem.get(key) ?? null,
  key: index => [...mem.keys()][index] ?? null,
  removeItem: key => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, value) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
const { default: App } = await import('../../../App')
const { useCamStore } = await import('../../../store')
const { RELEASES_URL } = await import('../../../lib/update/releaseCheck')

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })

it('startup wiring: newer release reaches the real console once under StrictMode and shell remount', async () => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_DEMO_BUILD', 'false')
  vi.stubGlobal('liencamHost', undefined)
  const url = 'https://github.com/eclsnowman/LienCAM/releases/tag/v999.0.0-alpha.2'
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{
    tag_name: 'v999.0.0-alpha.2', html_url: url, draft: false, prerelease: true,
    published_at: '2026-10-09T12:00:00Z',
  }])))
  vi.stubGlobal('fetch', fetcher)
  act(() => { useCamStore.getState().newProject(); useCamStore.setState({ consoleEvents: [] }) })

  // A normal browser mount is silent and does not consume the desktop launch check.
  const browser = render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(fetcher.mock.calls.filter(([url]) => url === RELEASES_URL)).toHaveLength(0)
  browser.unmount()

  vi.stubGlobal('liencamHost', {})
  const desktop = render(<StrictMode><App /></StrictMode>)
  await act(async () => { await vi.advanceTimersByTimeAsync(2999) })
  expect(fetcher.mock.calls.filter(([url]) => url === RELEASES_URL)).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  const message = `LienCAM 999.0.0-alpha.2 is available (you have ${APP_VERSION}): ${url}`
  expect(screen.getByTestId('console-strip').textContent).toContain(message)
  expect(useCamStore.getState().consoleEvents.filter(e => e.message === message)).toHaveLength(1)
  desktop.unmount()
  render(<App />)
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(fetcher.mock.calls.filter(([url]) => url === RELEASES_URL)).toHaveLength(1)
  expect(useCamStore.getState().consoleEvents.filter(e => e.message === message)).toHaveLength(1)
})
