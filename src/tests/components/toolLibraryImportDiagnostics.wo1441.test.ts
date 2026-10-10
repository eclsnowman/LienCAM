// @vitest-environment jsdom
//
// WO-1441 component-level acceptance:
//   #4 an internal-format import of 7 records (3 valid, 4 malformed in
//      different ways) imports exactly the 3 valid ones and the console
//      summary lists all 4 rejects with a reason each — not just a bare count
//      (BUG-518).
//   #6 editing a tool's "Length below holder" to exceed its overall length
//      does not commit through Save — the tool keeps its last valid
//      assembly, console explains why (BUG-536, store contract).
// The lib-level acceptance items (unit double-conversion, unknown-type
// preservation, negative-diameter rejection, holder-section validation) live
// in src/tests/lib/toolPhysicalValidation.wo1441.test.ts.

import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

beforeEach(() => {
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0, toolLibrary: [] })
  })
})

function jsonFile(name: string, content: unknown): File {
  return new File([JSON.stringify(content)], name, { type: 'application/json' })
}

async function fireImport(file: File) {
  render(createElement(ToolLibraryModal))
  act(() => { useCamStore.getState().openModal('tool-library') })
  const input = document.querySelector('input[type="file"][accept=".json,.tools"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
  // FileReader is genuinely async in jsdom (see ToolLibraryModalImportConsole
  // smoke test's note) — poll for the outcome the import path always renders.
  await screen.findByTestId('tool-import-feedback', {}, { timeout: 2000 })
}

const feeds = { default: { rpm: 12000, feedRate: 1000, plungeRate: 300, depthOfCut: 1, stepover: 2, coolant: 'none' as const } }

describe('internal-format batch import diagnostics (WO-1441 #4)', () => {
  // WO-1542 (rule 11) repin: a nameless record and a numeric-text diameter are
  // now RECOVERED (generated name / parsed number), so of these 7 records only
  // the two physically-impossible ones are flagged. The per-record reason text
  // (not a bare count) contract is unchanged.
  it('imports the 5 recoverable records of 7 and reports the 2 physical rejects with a reason each', async () => {
    const records = [
      { name: 'Valid A', type: 'flat_end_mill', diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: feeds },
      // #2: missing name entirely -> WO-1542 imports under a generated name
      { diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '' },
      // #3: diameter is numeric text -> WO-1542 parses it (was BUG-518)
      { name: 'Bad Diameter String', diameter: '6', shankDiameter: 6, overallLength: 50, fluteLength: 18, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '' },
      // #4: negative diameter (physical reject, BUG-511)
      { name: 'Negative Diameter', diameter: -3, shankDiameter: 6, overallLength: 50, fluteLength: 18, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '' },
      // #5: lengthBelowHolder exceeds overallLength (physical reject, BUG-536)
      { name: 'Overlong LBH', diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18, lengthBelowHolder: 3030, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '' },
      { name: 'Valid B', type: 'ball_end_mill', diameter: 8, shankDiameter: 8, overallLength: 60, fluteLength: 20, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: feeds },
      { name: 'Valid C', type: 'flat_end_mill', diameter: 10, shankDiameter: 10, overallLength: 70, fluteLength: 25, numberOfFlutes: 4, material: 'hss', coating: 'none', notes: '', feedsAndSpeeds: feeds },
    ]

    await fireImport(jsonFile('SevenRecords.json', records))

    const state = useCamStore.getState()
    const names = state.toolLibrary.map((t) => t.name).sort()
    expect(names).toEqual(['Bad Diameter String', 'Valid A', 'Valid B', 'Valid C', 'flat end mill 6.0mm'])

    const events = state.consoleEvents.filter((e) => e.source === 'tool')
    const summary = events.find((e) => e.message.includes('Imported 5 tools'))
    expect(summary).toBeTruthy()
    expect(summary!.severity).toBe('warning')
    const msg = summary!.message
    expect(msg).toMatch(/Imported 5 tools/)
    expect(msg).toMatch(/2 flagged/)
    // Every reject is named with a reason — not a bare count.
    expect(msg).toMatch(/Negative Diameter.*diameter must be a positive number/)
    expect(msg).toMatch(/Overlong LBH.*lengthBelowHolder.*exceeds/)
    // The generated name is announced in its own console line (WO-1542).
    expect(events.some((e) => /had no name/.test(e.message))).toBe(true)

    expect(screen.getByTestId('tool-import-feedback').textContent).toMatch(/2 flagged/)
  })
})

describe('manual edit rejection at Save (WO-1441 #6)', () => {
  it('editing Length below holder past overallLength does not commit; the tool keeps its last valid assembly', () => {
    const libId = useCamStore.getState().toolLibraries[0]?.id ?? 'lib-default'
    act(() => {
      useCamStore.getState().addTool({
        id: 'lbh-test-tool',
        name: 'LBH Test Tool',
        type: 'flat_end_mill',
        diameter: 6,
        shankDiameter: 6,
        overallLength: 50,
        fluteLength: 18,
        numberOfFlutes: 2,
        material: 'carbide',
        coating: 'none',
        notes: '',
        libraryId: libId,
        feedsAndSpeeds: feeds,
      })
    })

    render(createElement(ToolLibraryModal))
    act(() => { useCamStore.getState().openModal('tool-library') })
    fireEvent.click(screen.getByText('LBH Test Tool'))
    fireEvent.click(screen.getByText('Cutter'))

    const labels = Array.from(document.querySelectorAll('.mform-row .mform-label'))
      .filter((el) => el.textContent === 'Length below holder')
    expect(labels).toHaveLength(1)
    const lbhInput = labels[0].parentElement!.querySelector('input') as HTMLInputElement

    act(() => {
      fireEvent.focus(lbhInput)
      fireEvent.change(lbhInput, { target: { value: '3030' } })
      fireEvent.blur(lbhInput)
    })

    // Save is now offered (the draft is dirty) — click it; the store must
    // refuse the impossible geometry rather than committing it.
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    const stored = useCamStore.getState().toolLibrary.find((t) => t.id === 'lbh-test-tool')
    expect(stored!.lengthBelowHolder).toBeUndefined() // unchanged — never committed

    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'tool')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('warning')
    expect(events[0].message).toMatch(/lengthBelowHolder/)
    expect(events[0].message).toMatch(/exceeds/)

    // No new UI notice/banner — the rejection is console-only (rule: console,
    // not UI notices) — and the Save button stays visible since the draft is
    // still dirty (never silently marked saved).
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy()
  })
})
