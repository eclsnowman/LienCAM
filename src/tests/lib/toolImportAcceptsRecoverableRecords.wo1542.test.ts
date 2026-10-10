// @vitest-environment jsdom
//
// WO-1542 (LIENCAM rule 11): importing a LienCAM tool library must not refuse
// a record the software can recover. A missing/empty name is generated (type +
// diameter, the Fusion importer's shape), and a geometry field written as
// numeric text is parsed. A genuinely unparseable value still skips the record
// with its reason, and WO-1441's physical rejects stay rejected.
//
// Acceptance: importing
//   [{"diameter": 6}, {"name": "T2", "diameter": "6.35"}, {"name": "T3", "diameter": "abc"}]
// through the Tool Library import adds two tools (one generated name, one at
// 6.35 mm) and reports one skipped record naming T3.

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
const { validateToolRecordShape } = await import('../../lib/tool/toolValidation')

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
  await screen.findByTestId('tool-import-feedback', {}, { timeout: 2000 })
}

describe('validateToolRecordShape recovers what the software can do (WO-1542)', () => {
  it('generates a name for a nameless record, in the Fusion importer shape', () => {
    const result = validateToolRecordShape({ diameter: 6 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.nameGenerated).toBe(true)
    expect(result.record.tool.name).toBe('flat end mill 6.0mm')
  })

  it('parses a diameter (and other geometry fields) written as numeric text', () => {
    const result = validateToolRecordShape({ name: 'T2', diameter: '6.35', fluteLength: '18' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.nameGenerated).toBe(false)
    expect(result.record.tool.name).toBe('T2')
    expect(result.record.tool.diameter).toBe(6.35)
    expect(result.record.tool.fluteLength).toBe(18)
  })

  it('still refuses a value it cannot recover: non-numeric text, null, non-object', () => {
    expect(validateToolRecordShape({ name: 'T3', diameter: 'abc' }).ok).toBe(false)
    expect(validateToolRecordShape({ name: 'T3', diameter: null }).ok).toBe(false)
    expect(validateToolRecordShape(null).ok).toBe(false)
  })

  // Audit finding: the recovery gate must keep main's requirement that a
  // diameter be PRESENT — a tool with none is a genuine cannot (rule 11), so it
  // stays skipped with main's reason rather than importing diameter: undefined.
  it('does not recover a record with no diameter at all: it stays skipped with a reason', () => {
    for (const raw of [{ name: 'NoDia', type: 'flat_end_mill' }, {}]) {
      const result = validateToolRecordShape(raw)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toMatch(/diameter must be a number \(got undefined\)/)
    }
  })
})

describe('Tool Library import of recoverable records (WO-1542 acceptance)', () => {
  it('adds two tools (one generated name, one at 6.35 mm) and reports T3 skipped', async () => {
    const records = [
      { diameter: 6 },
      { name: 'T2', diameter: '6.35' },
      { name: 'T3', diameter: 'abc' },
    ]

    await fireImport(jsonFile('Recoverable.json', records))

    const state = useCamStore.getState()
    expect(state.toolLibrary).toHaveLength(2)

    const generated = state.toolLibrary.find((t) => t.name === 'flat end mill 6.0mm')
    expect(generated).toBeTruthy()
    expect(generated!.diameter).toBe(6)

    const t2 = state.toolLibrary.find((t) => t.name === 'T2')
    expect(t2).toBeTruthy()
    expect(t2!.diameter).toBe(6.35)

    // The unparseable record is skipped, named, with its reason.
    const toolEvents = state.consoleEvents.filter((e) => e.source === 'tool')
    const summary = toolEvents.find((e) => e.message.includes('Imported 2 tools'))
    expect(summary).toBeTruthy()
    expect(summary!.message).toMatch(/T3.*diameter must be a number/)
    expect(state.toolLibrary.some((t) => t.name === 'T3')).toBe(false)

    // One console line says the name was generated.
    const generatedLine = toolEvents.find((e) => /name was generated|had no name/.test(e.message))
    expect(generatedLine).toBeTruthy()
    expect(generatedLine!.message).toMatch(/flat end mill 6\.0mm/)

    expect(screen.getByTestId('tool-import-feedback').textContent).toMatch(/Imported 2 tools/)
  })

  // Audit finding, modal level: a diameter-less record is a genuine cannot, so
  // neither of these imports — both are skipped with main's diameter reason.
  it('does not import a diameter-less record through the modal', async () => {
    await fireImport(jsonFile('NoDiameter.json', [{ name: 'NoDia', type: 'flat_end_mill' }, {}]))

    const state = useCamStore.getState()
    expect(state.toolLibrary).toHaveLength(0)

    const toolEvents = state.consoleEvents.filter((e) => e.source === 'tool')
    const summary = toolEvents.find((e) => e.message.includes('0 tools imported'))
    expect(summary).toBeTruthy()
    expect(summary!.message).toMatch(/NoDia.*diameter must be a number/)
    expect(summary!.message).toMatch(/record 2.*diameter must be a number/)
    expect(state.toolLibrary.some((t) => t.diameter === undefined)).toBe(false)
  })
})
