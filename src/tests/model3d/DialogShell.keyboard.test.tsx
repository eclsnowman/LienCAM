// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialogShell } from '../../components/model3d/dialogs/DialogShell'

afterEach(cleanup)

interface HarnessOptions {
  applyDisabled?: boolean
  children?: React.ReactNode
}

function renderHarness({ applyDisabled = false, children }: HarnessOptions = {}) {
  const onApply = vi.fn()
  const onCancel = vi.fn()

  render(
    <DialogShell
      title="Keyboard test"
      onApply={onApply}
      onCancel={onCancel}
      applyDisabled={applyDisabled}
    >
      {children ?? <input data-testid="safe-input" type="text" />}
    </DialogShell>,
  )

  return { onApply, onCancel }
}

describe('DialogShell keyboard commands', () => {
  it('applies once when Enter comes from an ordinary single-line input', () => {
    const { onApply } = renderHarness()

    fireEvent.keyDown(screen.getByTestId('safe-input'), { key: 'Enter' })

    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('does not apply on Enter while Apply is disabled', () => {
    const { onApply } = renderHarness({ applyDisabled: true })

    fireEvent.keyDown(screen.getByTestId('safe-input'), { key: 'Enter' })

    expect(onApply).not.toHaveBeenCalled()
  })

  it('leaves Enter to textarea and aria-multiline editors', () => {
    const { onApply } = renderHarness({
      children: (
        <>
          <textarea data-testid="textarea" />
          <div data-testid="multiline-editor" role="textbox" aria-multiline="true" tabIndex={0} />
        </>
      ),
    })

    fireEvent.keyDown(screen.getByTestId('textarea'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByTestId('multiline-editor'), { key: 'Enter' })

    expect(onApply).not.toHaveBeenCalled()
  })

  it('does not double-fire when a child prevents the Enter event', () => {
    const { onApply } = renderHarness({
      children: (
        <input
          data-testid="consuming-input"
          type="text"
          onKeyDown={(event) => event.preventDefault()}
        />
      ),
    })

    fireEvent.keyDown(screen.getByTestId('consuming-input'), { key: 'Enter' })

    expect(onApply).not.toHaveBeenCalled()
  })

  it('does not apply during IME composition', () => {
    const { onApply } = renderHarness()

    fireEvent.keyDown(screen.getByTestId('safe-input'), { key: 'Enter', isComposing: true })

    expect(onApply).not.toHaveBeenCalled()
  })

  it('leaves Enter on buttons and selects to their native semantics', () => {
    const { onApply } = renderHarness({
      children: (
        <select data-testid="native-select" defaultValue="one">
          <option value="one">One</option>
        </select>
      ),
    })

    fireEvent.keyDown(screen.getByTestId('native-select'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByTestId('dialog-shell-apply'), { key: 'Enter' })
    expect(onApply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('preserves Escape cancel and ignores Enter outside the dialog panel', () => {
    const { onApply, onCancel } = renderHarness()

    fireEvent.keyDown(screen.getByTestId('safe-input'), { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Enter' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })
})
