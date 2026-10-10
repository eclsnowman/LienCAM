// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project, Setup } from '../../types'
import {
  makeMachine,
  makeOp,
  makeStock,
  makeTool,
  makeWcs,
  stampGenerationCurrent,
} from '../post/helpers'

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

function seedPostOperation(): void {
  const tool = makeTool()
  const operation = makeOp({ toolId: tool.id })
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
      name: 'SelectAllProject',
      machine: makeMachine(),
      setups: [setup],
      activeSetupId: setup.id,
    }
    stampGenerationCurrent(
      { ...project, toolLibrary: [tool] } as unknown as Project,
      setup as unknown as Setup,
      operation,
      tool,
    )
    useCamStore.setState({ project, toolLibrary: [tool] } as never)
  })
}

function openModal(): ReturnType<typeof render> {
  const view = render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
  return view
}

function inputBeside(label: string): HTMLInputElement {
  const row = screen.getByText(label).parentElement
  const input = row?.querySelector('input[inputmode="decimal"]')
  expect(input).toBeInstanceOf(HTMLInputElement)
  return input as HTMLInputElement
}

beforeEach(() => {
  act(() => useCamStore.getState().closeModal())
  seedPostOperation()
})

afterEach(cleanup)

describe('PostProcessModal numeric select-all contract', () => {
  it('pins every Post properties numeric field to keyboard-focus and first-click select-all', () => {
    const { container } = openModal()

    fireEvent.click(screen.getByTestId('disclosure-output-format'))
    fireEvent.click(screen.getByTestId('disclosure-arcs'))

    const lineNumbersRow = screen.getByText('Line / sequence numbers').parentElement
    const lineNumbersToggle = lineNumbersRow?.querySelector('input[type="checkbox"]')
    expect(lineNumbersToggle).toBeInstanceOf(HTMLInputElement)
    fireEvent.click(lineNumbersToggle!)

    fireEvent.click(screen.getByTestId('post-program-end-mode'))
    fireEvent.click(screen.getByTestId('post-program-end-mode-option-machine_coords'))
    for (const placeholder of ['X', 'Y', 'Z']) {
      fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: '12' } })
    }

    const numericInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]'),
    )
    expect(numericInputs).toHaveLength(11)
    expect(numericInputs.every((input) => input.type === 'text' && !input.disabled)).toBe(true)

    for (const input of numericInputs) {
      input.setSelectionRange(input.value.length, input.value.length)

      // Direct focus covers keyboard/programmatic focus: replacement typing can
      // begin immediately, before any mouse event is involved.
      fireEvent.focus(input)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(input.value.length)

      // The mouseUp paired with the first click is consumed so the browser
      // cannot collapse the selected value back to a caret.
      expect(fireEvent.mouseUp(input)).toBe(false)
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe(input.value.length)
      fireEvent.blur(input)
    }
  })

  it('preserves second-click caret editing and applies the same contract to Go to line', () => {
    openModal()
    fireEvent.click(screen.getByTestId('disclosure-arcs'))

    const maxRadius = inputBeside('Max arc radius')
    fireEvent.focus(maxRadius)
    expect(fireEvent.mouseUp(maxRadius)).toBe(false)
    expect(maxRadius.selectionStart).toBe(0)
    expect(maxRadius.selectionEnd).toBe(maxRadius.value.length)

    maxRadius.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(maxRadius, { detail: 1 })).toBe(true)
    expect(fireEvent.doubleClick(maxRadius, { detail: 2 })).toBe(true)
    expect(maxRadius.selectionStart).toBe(1)
    expect(maxRadius.selectionEnd).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    const gotoLine = screen.getByLabelText('Go to line') as HTMLInputElement
    fireEvent.change(gotoLine, { target: { value: '12' } })
    gotoLine.setSelectionRange(1, 1)
    fireEvent.focus(gotoLine)
    expect(fireEvent.mouseUp(gotoLine)).toBe(false)
    expect(gotoLine.selectionStart).toBe(0)
    expect(gotoLine.selectionEnd).toBe(2)

    gotoLine.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(gotoLine, { detail: 1 })).toBe(true)
    expect(gotoLine.selectionStart).toBe(1)
    expect(gotoLine.selectionEnd).toBe(1)
  })
})
