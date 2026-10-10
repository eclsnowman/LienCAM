// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, Project, Setup } from '../../types'
import {
  makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent,
} from '../post/helpers'

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

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')
const originalComputeOperationToolpath = useCamStore.getState().computeOperationToolpath

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

function seedPostOperation(overrides: Partial<Operation> = {}): void {
  const tool = makeTool()
  const operation = makeOp({ toolId: tool.id, ...overrides })
  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: makeWcs(),
    stock: makeStock(),
    operations: [operation],
    notes: '',
  }
  act(() => {
    const current = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    const project = {
      ...current.project,
      name: 'ContextMenuProject',
      machine: makeMachine(),
      setups: [setup],
      activeSetupId: setup.id,
    }
    // CAM-15 (52ac9e3e7): stamp the op generation-current so posting evaluates
    // the REAL gate under test (gcode present, or OP_NO_TOOLPATH for the
    // moveless-ready case) instead of refusing everything as OP_OUTDATED.
    stampGenerationCurrent(
      { ...project, toolLibrary: [tool] } as unknown as Project,
      setup as unknown as Setup,
      operation,
      tool,
    )
    useCamStore.setState({
      project,
      toolLibrary: [tool],
      consoleEvents: [],
      consoleReadThroughId: 0,
      computeOperationToolpath: originalComputeOperationToolpath,
    } as never)
  })
}

beforeEach(() => {
  memory.clear()
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  act(() => useCamStore.getState().closeModal())
  seedPostOperation()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'clipboard')
  act(() => {
    useCamStore.setState({ computeOperationToolpath: originalComputeOperationToolpath })
  })
})

describe('PostProcessModal G-code context menu (UI-40)', () => {
  it('copies complete output, opens the full preview, and reports clipboard refusal without blocking text fallback', async () => {
    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))

    const preview = screen.getByTestId('post-gcode-preview')
    const gcode = preview.textContent ?? ''
    expect(gcode.length).toBeGreaterThan(0)

    fireEvent.contextMenu(preview, { clientX: 110, clientY: 90 })
    expect(screen.getByRole('menuitem', { name: 'Copy all G-code' })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Open full preview' })).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Recompute all' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy all G-code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(gcode))

    fireEvent.contextMenu(preview, { clientX: 120, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open full preview' }))
    expect(screen.getByText(/Full g-code/)).not.toBeNull()

    const flyout = screen.getByTestId('gcode-flyout-body')
    fireEvent.contextMenu(flyout, { clientX: 130, clientY: 110 })
    expect(screen.getByRole('menuitem', { name: 'Copy all G-code' })).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open full preview' })).toBeNull()

    writeText.mockRejectedValueOnce(new Error('permission denied'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy all G-code' }))

    const failure = await screen.findByRole('alert')
    expect(failure.textContent).toContain('permission denied')
    expect(failure.textContent).toContain('Ctrl+C')
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'post',
    })
  })

  it('offers recompute only through the existing no-toolpath diagnostic gate', () => {
    const recompute = vi.fn()
    seedPostOperation({ status: 'ready', toolpathMoves: [] })
    act(() => {
      useCamStore.setState({ computeOperationToolpath: recompute })
    })

    render(<PostProcessModal />)
    act(() => useCamStore.getState().openModal('post-process'))

    fireEvent.contextMenu(screen.getByTestId('post-gcode-preview'), {
      clientX: 140,
      clientY: 120,
    })
    expect(screen.getByRole('menuitem', { name: 'Recompute all' })).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy all G-code' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open full preview' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Recompute all' }))
    expect(recompute).toHaveBeenCalledWith('setup-1', 'op1', expect.any(String))
  })
})
