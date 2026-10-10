// @vitest-environment jsdom
//
// WO-1442: re-importing an internal-format tool export that carries an
// embedded `holder` block (written by serializeToolForExport whenever the
// exported tool had a resolvable holderId) must rehydrate that holder the
// same way the fusion import branch already does, so the reimported tool's
// holderId resolves instead of pointing at nothing.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool, ToolHolder } from '../../types'
import { makeTool } from '../post/helpers'

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

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')
const { serializeHolderForFusion } = await import('../../lib/fusionImporter')

function testHolder(overrides: Partial<ToolHolder> = {}): ToolHolder {
  return {
    id: 'holder-guid-1',
    name: 'ER32 Collet Holder',
    vendor: 'Acme',
    segments: [
      { height: 10, lowerDiameter: 20, upperDiameter: 20 },
      { height: 40, lowerDiameter: 32, upperDiameter: 32 },
    ],
    ...overrides,
  }
}

function resetStore(overrides: Partial<ReturnType<typeof useCamStore.getState>> = {}) {
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState((s) => ({
      toolLibrary: [],
      toolLibraries: [{ id: 'lib-default', name: 'My Tools' }],
      holders: [],
      consoleEvents: [],
      consoleReadThroughId: 0,
      project: { ...s.project, toolLibrary: [] },
      ...overrides,
    }))
  })
}

beforeEach(() => {
  memory.clear()
  resetStore()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Mirrors the ToolCutHand.toolpost.test.tsx pattern for capturing the Blob a
// download-triggering handler builds, without letting jsdom try to navigate.
function stubDownload(): Array<{ parts: unknown[]; type: string }> {
  const captured: Array<{ parts: unknown[]; type: string }> = []
  class CapturedBlob {
    constructor(parts: unknown[], options?: { type?: string }) {
      captured.push({ parts, type: options?.type ?? '' })
    }
  }
  vi.stubGlobal('Blob', CapturedBlob)
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:tool'),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return captured
}

// Drives the real "Export" button (the internal-format export path,
// serializeToolForExport) on whatever tool the modal currently has selected.
function exportSelectedTool(): string {
  const captured = stubDownload()
  render(createElement(ToolLibraryModal))
  act(() => useCamStore.getState().openModal('tool-library'))
  fireEvent.click(screen.getByRole('button', { name: /^Export$/ }))
  cleanup()
  return String(captured[0].parts[0])
}

async function importFile(text: string, name = 'Reimport.json') {
  render(createElement(ToolLibraryModal))
  act(() => useCamStore.getState().openModal('tool-library'))
  const input = document.querySelector('input[type="file"][accept=".json,.tools"]') as HTMLInputElement
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
  await screen.findByTestId('tool-import-feedback', {}, { timeout: 2000 })
}

describe('internal-format import rehydrates an embedded holder (WO-1442)', () => {
  it('re-embeds the holder on export, then rehydrates it into a fresh library on import', async () => {
    const holder = testHolder()
    const tool = makeTool({ id: 'src-tool', name: 'Test Endmill', holderId: holder.id, libraryId: 'lib-default' })
    resetStore({ holders: [holder], toolLibrary: [tool] })

    const exportedText = exportSelectedTool()
    const exportedJson = JSON.parse(exportedText)
    expect(exportedJson.holder).toBeTruthy()
    expect(exportedJson.holder.guid).toBe(holder.id)

    // Reimport into a fresh library (no pre-existing holders/tools).
    resetStore()
    await importFile(exportedText, 'RoundtripExport.json')

    const state = useCamStore.getState()
    expect(state.holders).toHaveLength(1)
    expect(state.holders[0].id).toBe(holder.id)
    expect(state.holders[0].segments).toEqual(holder.segments)

    const importedTool = state.toolLibrary.find((t) => t.name === 'Test Endmill')
    expect(importedTool).toBeTruthy()
    expect(importedTool!.holderId).toBe(holder.id)
    // The raw `holder` block must never land on the registered Tool object.
    expect('holder' in (importedTool as unknown as Record<string, unknown>)).toBe(false)

    // The holder selector for the reimported tool shows the SAME holder, not "None".
    fireEvent.click(screen.getByText('Test Endmill'))
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    const select = screen.getByTestId('tool-holder-select') as HTMLSelectElement
    expect(select.value).toBe(holder.id)
    expect(select.selectedOptions[0].textContent).toBe(holder.name)

    // The Holders list is non-empty with matching segment dimensions.
    fireEvent.click(screen.getByTestId('tool-view-holders'))
    expect(screen.queryByText('No holders — add one.')).toBeNull()
    expect(screen.getByText(holder.name)).toBeTruthy()
  })

  it('leaves a plain internal-format import unchanged when no tool carries a holder block', async () => {
    const tools: Tool[] = [
      makeTool({ id: 'a', name: 'Plain Tool A', libraryId: 'lib-default' }),
      makeTool({ id: 'b', name: 'Plain Tool B', libraryId: 'lib-default', holderId: 'dangling-holder-id' }),
    ]
    await importFile(JSON.stringify(tools), 'PlainTools.json')

    const state = useCamStore.getState()
    expect(state.holders).toHaveLength(0)
    const a = state.toolLibrary.find((t) => t.name === 'Plain Tool A')
    const b = state.toolLibrary.find((t) => t.name === 'Plain Tool B')
    expect(a!.holderId).toBeUndefined()
    // No holder block present -> the declared (even dangling) holderId passes through unchanged.
    expect(b!.holderId).toBe('dangling-holder-id')
  })

  it('dedupes a batch import where two tools embed the same holder guid into one holder record', async () => {
    const holder = testHolder({ id: 'shared-holder-guid', name: 'Shared Holder' })
    const embedded = serializeHolderForFusion(holder)
    const raw = [
      { ...makeTool({ id: 'a', name: 'Batch Tool A', libraryId: 'lib-default' }), holder: embedded },
      { ...makeTool({ id: 'b', name: 'Batch Tool B', libraryId: 'lib-default' }), holder: embedded },
    ]
    await importFile(JSON.stringify(raw), 'BatchShared.json')

    const state = useCamStore.getState()
    expect(state.holders).toHaveLength(1)
    expect(state.holders[0].id).toBe('shared-holder-guid')
    const a = state.toolLibrary.find((t) => t.name === 'Batch Tool A')
    const b = state.toolLibrary.find((t) => t.name === 'Batch Tool B')
    expect(a!.holderId).toBe('shared-holder-guid')
    expect(b!.holderId).toBe('shared-holder-guid')
  })
})
