// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { useFormStore } from '../../form/formStore'

const session = {
  active: true, open: () => {}, finish: vi.fn(), cancel: vi.fn(), undo: () => {}, redo: () => {},
  canUndo: false, canRedo: false, railSections: [],
}

describe('WO-2495 Form status stays above the footer actions', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    useFormStore.getState().openSession({ featureId: null, name: 'Form 1', tolerance: 0.01 })
  })
  afterEach(() => { cleanup(); useFormStore.getState().closeSession() })

  it('keeps the three live lines outside the scrolling settings and leaves static hints in the body', () => {
    render(<FormPanel session={session} />)
    act(() => useFormStore.getState().shrinkSelection())
    const status = screen.getByTestId('form-status')
    const footer = status.closest('.docked-panel-footer')
    expect(footer).not.toBeNull()
    expect(status.closest('.docked-panel-body')).toBeNull()
    expect(status.children).toHaveLength(3)
    expect(status.firstElementChild?.textContent).toMatch(/^Cage: /)
    expect(status.contains(screen.getByTestId('form-selection'))).toBe(true)
    expect(status.contains(screen.getByTestId('form-notice'))).toBe(true)
    expect(footer?.contains(screen.getByTestId('form-finish'))).toBe(true)
    expect(status.compareDocumentPosition(screen.getByTestId('form-cancel')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const body = screen.getByTestId('form-palette')
    expect(body.textContent).toContain('Smooth skin: level')
    expect(body.textContent).toContain('Alt-drag a move arrow')
    expect(body.querySelector('[data-testid="form-status"]')).toBeNull()
  })

  it('shows unchanged no-apply and success messages, selection updates, and the full notice hover hint', () => {
    render(<FormPanel session={session} />)
    act(() => useFormStore.getState().thickenForm())
    const noApply = useFormStore.getState().notice
    expect(noApply).toBe('Thicken closes an open form; this form has no opening')
    expect(screen.getByTestId('form-notice').textContent).toBe(noApply)
    expect(screen.getByTestId('form-notice').title).toBe(noApply)
    act(() => useFormStore.getState().selectAll())
    expect(screen.getByTestId('form-selection').textContent).toMatch(/^Selected: \d+ faces$/)
    expect(screen.getByTestId('form-notice').textContent).toBe(useFormStore.getState().notice)
    expect(screen.getByTestId('form-notice').title).toBe(useFormStore.getState().notice)
  })

  it('preserves footer Cancel and Finish handlers and live status after folding and unfolding', () => {
    render(<FormPanel session={session} />)
    fireEvent.click(screen.getByTestId('form-palette-shell-fold'))
    act(() => useFormStore.getState().shrinkSelection())
    fireEvent.click(screen.getByTestId('form-palette-shell-unfold'))
    expect(screen.getByTestId('form-notice').closest('.docked-panel-footer')).not.toBeNull()
    expect(screen.getByTestId('form-notice').textContent).toBe(useFormStore.getState().notice)
    fireEvent.click(screen.getByTestId('form-cancel'))
    fireEvent.click(screen.getByTestId('form-finish'))
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(session.finish).toHaveBeenCalledTimes(1)
  })
})
