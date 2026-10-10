// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

class StubWorker {
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}

vi.stubGlobal('Worker', StubWorker)
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { createBlankSketch } = await import('../../lib/sketch/blankSketch')
const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { useCamStore } = await import('../../store')
const realRedo = useCamStore.getState().redo

afterEach(() => {
  cleanup()
  act(() => {
    useCamStore.setState({ redo: realRedo, activeSketch: null, canRedo: false })
  })
})

describe('SKC-38 CAM sketch Redo control', () => {
  it('sits beside Undo and reflects real sketch redo availability, action, and tooltip', () => {
    const redo = vi.fn()
    act(() => {
      useCamStore.setState({
        workspace: 'cam',
        activeSketch: createBlankSketch('skc38-sketch'),
        canUndo: false,
        canRedo: false,
        redo,
      })
    })

    render(<TopToolbar />)
    // WO-1833 repin: these buttons now carry aria-label = the tooltip string
    // (the accessible name survives app.css hiding the label span at compact
    // widths), so the role-name queries below match the tooltip, not the old
    // span text. Behavior under test is unchanged.
    const undoButton = screen.getByRole('button', { name: 'Undo (Ctrl+Z)' })
    const redoButton = screen.getByRole('button', { name: 'Nothing to redo in this sketch' }) as HTMLButtonElement

    expect(redoButton.parentElement).toBe(undoButton.parentElement)
    expect(undoButton.nextElementSibling).toBe(redoButton)
    expect(redoButton.disabled).toBe(true)
    expect(redoButton.getAttribute('data-tooltip')).toBe('Nothing to redo in this sketch')

    act(() => {
      useCamStore.setState({ canRedo: true })
    })
    expect(redoButton.disabled).toBe(false)
    expect(redoButton.getAttribute('data-tooltip')).toBe('Redo sketch edit (Ctrl+Shift+Z)')

    fireEvent.click(redoButton)
    expect(redo).toHaveBeenCalledTimes(1)
  })
})
