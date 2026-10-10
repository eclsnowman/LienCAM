// @vitest-environment jsdom
//
// WO UI-11B-R1 Finding 2 rework: batch-B's alert() replacement tests never
// drove loadProjectFromFile's own tool-import failure site (store/index.ts's
// outer catch block — "same tool-import alert() policy as above (error
// case)"), only ToolLibraryModal's three sites. This test fires that REAL
// failure branch (malformed JSON text, so JSON.parse throws) and proves it:
// (a) never calls window.alert, (b) lands an error/tool console event, and
// (c) renders the inline status-bar feedback (App.tsx's sketchNotice span) —
// the same always-mounted surface pushTransientFooterNotice targets.
// Fails-if: restoring the original alert() call in that catch block fails
// this test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

let alertSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, sketchNotice: null })
  })
})

describe('loadProjectFromFile tool-import failure site (UI-11B-R1 Finding 2)', () => {
  it('a malformed project file (JSON.parse throws) never alerts, lands an error/tool console event, and renders the inline status-bar feedback', () => {
    render(<App />)

    act(() => {
      useCamStore.getState().loadProjectFromFile('not valid json {{{')
    })

    expect(alertSpy).not.toHaveBeenCalled()

    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'tool')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('error')
    expect(events[0].message).toMatch(/Failed to read the file/)

    // BottomConsole ALSO renders the same message (it's a persistent log),
    // so scope this assertion to the status-bar's transient notice span
    // specifically (App.tsx's sketchNotice surface) rather than screen-wide.
    const notice = document.querySelector('.status-sketch-notice')
    expect(notice?.textContent).toMatch(/Failed to read the file/)
  })
})
