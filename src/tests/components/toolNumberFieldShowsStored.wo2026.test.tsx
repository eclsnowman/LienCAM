// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { postProject } from '../../lib/post/postProject'
import type { Project, Setup, Tool } from '../../types'
import {
  makeMachine, makeOp, makeStock, makeTool, makeWcs, move, stampGenerationCurrent,
} from '../post/helpers'

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

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')

const LIBRARY_ID = 'wo2026-library'

function projectTool(toolNumber?: number): Tool {
  return makeTool({
    id: 'wo2026-tool',
    name: toolNumber === undefined ? 'Unnumbered tool' : `Stored T${toolNumber}`,
    libraryId: LIBRARY_ID,
    toolNumber,
  })
}

function seedTool(tool: Tool): void {
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({
      toolLibrary: [tool],
      toolLibraries: [{ id: LIBRARY_ID, name: 'WO-2026 tools' }],
      holders: [],
    })
  })
}

function openPostTab(): HTMLInputElement {
  act(() => { useCamStore.getState().openModal('tool-library') })
  fireEvent.click(screen.getByRole('button', { name: 'Post' }))
  const row = screen.getByText('Tool number').closest('.mform-row')
  const input = row?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error('Tool number input not rendered')
  return input
}

function postSavedTool(tool: Tool): string {
  const op = makeOp({
    id: 'wo2026-op',
    name: 'WO-2026 contour',
    toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 500, role: 'cut' }),
    ],
  })
  const setup: Setup = {
    id: 'wo2026-setup',
    name: 'WO-2026 setup',
    wcs: makeWcs({ id: 'wo2026-wcs' }),
    stock: makeStock(),
    operations: [op],
    notes: '',
  }
  const current = useCamStore.getState().project
  const project: Project = {
    ...current,
    machine: makeMachine(),
    toolLibrary: [tool],
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: op.id,
  }
  stampGenerationCurrent(project, setup, op, tool)
  const posted = postProject(project, [setup], UCCNC_CONFIG, {
    mode: 'combined',
    pauseBetweenSetups: false,
    baseName: 'wo2026',
    ext: 'nc',
  })
  expect(posted.ok).toBe(true)
  return posted.combined!.gcode
}

beforeEach(() => {
  mem.clear()
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-2026 tool number field shows what is stored', () => {
  it('shows a blank field for a project tool with no stored number', () => {
    seedTool(projectTool())
    render(<ToolLibraryModal />)

    const input = openPostTab()

    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Auto-post')
    expect(useCamStore.getState().toolLibrary[0].toolNumber).toBeUndefined()
  })

  it('stores an entered 1 and the production post emits T1', () => {
    seedTool(projectTool())
    render(<ToolLibraryModal />)
    const input = openPostTab()

    act(() => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: '1' } })
      fireEvent.blur(input)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    const saved = useCamStore.getState().toolLibrary[0]
    expect(saved.toolNumber).toBe(1)
    expect(postSavedTool(saved)).toMatch(/^T1$/m)
  })

  it('shows an existing stored tool number unchanged', () => {
    seedTool(projectTool(27))
    render(<ToolLibraryModal />)

    expect(openPostTab().value).toBe('27')
  })
})
