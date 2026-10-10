// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostInput, PostOperation } from '../../lib/post'
import type { Tool } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from '../post/helpers'

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

const { spindleSignForTool } = await import('../../lib/tool/cutHand')
const { resolveFeedrates } = await import('../../lib/cam/feedrates')
const { resolveCoolant, resolveSpindle } = await import('../../lib/post/resolve')
const { postProgram, UCCNC_CONFIG } = await import('../../lib/post')
const {
  CURRENT_PROJECT_SCHEMA_VERSION,
  migrateProjectData,
} = await import('../../store/migrations/projectMigrations')
const { persistMigrate, useCamStore } = await import('../../store')
const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')

function legacyRightTool(): Tool {
  const tool = makeTool({ id: 'cut-hand-tool', toolNumber: 12 })
  delete tool.cutHand
  return tool
}

function postWith(tool: Tool): string {
  const machine = makeMachine({ spindleDirection: 'cw' })
  const op = makeOp({
    id: 'cut-hand-op',
    toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5 }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 800 }),
    ],
  })
  const postOp: PostOperation = {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
  const input: PostInput = {
    machine,
    setup: { wcs: makeWcs(), operations: [postOp] },
  }
  const result = postProgram(input, UCCNC_CONFIG)
  expect(result.ok).toBe(true)
  return result.gcode
}

beforeEach(() => {
  memory.clear()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState((state) => ({
      toolLibrary: [],
      toolLibraries: [{ id: 'lib-default', name: 'My Tools' }],
      holders: [],
      project: { ...state.project, toolLibrary: [] },
    }))
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('tool cutting hand', () => {
  it('keeps legacy/right-hand post bytes stable and reverses left-hand spindle direction', () => {
    const legacy = legacyRightTool()
    const right = { ...legacy, cutHand: 'right' as const }
    const left = { ...legacy, cutHand: 'left' as const }

    expect(spindleSignForTool(legacy)).toBe(1)
    expect(spindleSignForTool(right)).toBe(1)
    expect(spindleSignForTool(left)).toBe(-1)
    expect(postWith(right)).toBe(postWith(legacy))
    expect(postWith(right)).toMatch(/\bM3\b/)
    expect(postWith(left)).toMatch(/\bM4\b/)
    expect(postWith(left)).not.toMatch(/\bM3\b/)
  })

  it('normalizes legacy and malformed project, persisted-library, and store inputs to right', () => {
    const left = { ...legacyRightTool(), id: 'left', cutHand: 'left' as const }
    const missing = { ...legacyRightTool(), id: 'missing' }
    const malformed = {
      ...legacyRightTool(),
      id: 'malformed',
      cutHand: 'sideways',
    } as unknown as Tool
    const currentProject = {
      ...structuredClone(useCamStore.getState().project),
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      toolLibrary: [left, missing, malformed],
    }

    const project = migrateProjectData(currentProject)
    expect(project.toolLibrary.map((tool) => tool.cutHand)).toEqual(['left', 'right', 'right'])

    const persisted = persistMigrate({
      project: currentProject,
      toolLibrary: [left, missing, malformed],
    }, 1) as { toolLibrary: Tool[] }
    expect(persisted.toolLibrary.map((tool) => tool.cutHand)).toEqual(['left', 'right', 'right'])

    act(() => useCamStore.getState().addTool(malformed))
    expect(useCamStore.getState().toolLibrary[0].cutHand).toBe('right')
  })

  it('edits and exports cutting hand through the real tool library UI', () => {
    const tool = { ...legacyRightTool(), libraryId: 'lib-default' }
    act(() => useCamStore.setState({ toolLibrary: [tool] }))

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

    render(<ToolLibraryModal />)
    act(() => useCamStore.getState().openModal('tool-library'))
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))

    const hand = screen.getByTestId('tool-cut-hand') as HTMLSelectElement
    expect(hand.value).toBe('right')
    fireEvent.change(hand, { target: { value: 'left' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(useCamStore.getState().toolLibrary[0].cutHand).toBe('left')

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(captured[0].type).toBe('application/json')
    expect(JSON.parse(String(captured[0].parts[0])).cutHand).toBe('left')
  })
})
