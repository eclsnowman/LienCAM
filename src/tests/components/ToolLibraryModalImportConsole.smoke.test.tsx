// @vitest-environment jsdom
//
// WO UI-11B alert() policy (acceptance #2): the tool-import success/fail
// alert() calls in ToolLibraryModal.handleImport (:441/:488/:495 in the WO's
// premise line numbers) are now console events + a non-blocking inline
// readout. A spy asserts window.alert is NEVER called across all three
// outcomes (success, nothing-found, malformed file).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

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

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

let alertSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  act(() => {
    useCamStore.getState().closeModal()
    // Reset the tool library too (not just consoleEvents): the store is a
    // process singleton across this file's tests, and the "success" test's
    // imported tool would otherwise leak into later tests as toolLibrary[0]
    // and get auto-selected on open (ToolLibraryModal's useEffect).
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, toolLibrary: [] })
  })
})

function jsonFile(name: string, content: unknown | string): File {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return new File([text], name, { type: 'application/json' })
}

async function fireImport(file: File) {
  render(<ToolLibraryModal />)
  act(() => { useCamStore.getState().openModal('tool-library') })
  const input = document.querySelector('input[type="file"][accept=".json,.tools"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
  // jsdom's FileReader is genuinely async (three chained setImmediate ticks
  // internally -- see node_modules/jsdom/lib/jsdom/living/file-api/FileReader-impl.js),
  // entirely outside RTL's act()/promise tracking. A fixed sleep here (the
  // previous approach) is a race: under full-suite CPU load the FileReader's
  // onload can fire AFTER the sleep resolves and this test (or even this whole
  // file) is already marked done by vitest, so the callback runs in a context
  // vitest can't attribute to any active test -- which is exactly what surfaced
  // as SUITE-UNHANDLED-REJECTION (a stray "Tool library import failed" escaping
  // at teardown). Polling for the actual outcome (the feedback element every
  // import path renders -- success/warning/error) removes the race: the test
  // does not proceed until the FileReader callback has genuinely completed.
  await screen.findByTestId('tool-import-feedback', {}, { timeout: 2000 })
}

describe('ToolLibraryModal import alert() replacement (batch B lane)', () => {
  it('success: lands a success console event + visible inline feedback, no alert()', async () => {
    await fireImport(jsonFile('MyLib.json', [
      { name: 'T1', diameter: 6, type: 'flat_end_mill', feedsAndSpeeds: { default: { rpm: 1, feedRate: 1, plungeRate: 1, depthOfCut: 1, stepover: 1 } } },
    ]))

    expect(alertSpy).not.toHaveBeenCalled()
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'tool')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('success')
    expect(screen.getByTestId('tool-import-feedback').textContent).toMatch(/Imported 1 tool/)
  })

  it('nothing found: lands a warning console event + visible inline feedback, no alert()', async () => {
    await fireImport(jsonFile('Empty.json', []))

    expect(alertSpy).not.toHaveBeenCalled()
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'tool')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('warning')
    expect(screen.getByTestId('tool-import-feedback').textContent).toMatch(/No tools were found/)
  })

  it('malformed file: lands an error console event + visible inline feedback, no alert()', async () => {
    await fireImport(jsonFile('bad.json', 'not valid json {{{'))

    expect(alertSpy).not.toHaveBeenCalled()
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'tool')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('error')
    expect(screen.getByTestId('tool-import-feedback').textContent).toMatch(/Tool library import failed/)
  })
})
