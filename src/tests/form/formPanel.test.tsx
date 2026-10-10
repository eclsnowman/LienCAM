// @vitest-environment jsdom
//
// Form palette: the chord Tolerance field (WO-2109) stays editable beside the
// Soft radius field stage 5 added (WO-2121 fix round 1).

import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { useFormStore } from '../../form/formStore'

const session = {
  active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
  canUndo: false, canRedo: false, railSections: [],
}

function commit(label: string, text: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

describe('Form palette', () => {
  beforeEach(() => {
    useFormStore.getState().openSession({ featureId: null, name: 'Form 1', tolerance: 0.01 })
  })

  it('shows Tolerance and Soft radius side by side, both editable', () => {
    render(<FormPanel session={session} />)
    expect(screen.getByTestId('form-tolerance')).toBeTruthy()
    expect(screen.getByTestId('form-soft-radius')).toBeTruthy()

    commit('Finished body chord tolerance', '0.05')
    expect(useFormStore.getState().tolerance).toBeCloseTo(0.05, 6)

    commit('Soft move radius', '12')
    expect(useFormStore.getState().softRadius).toBeCloseTo(12, 6)
    // editing one leaves the other alone
    expect(useFormStore.getState().tolerance).toBeCloseTo(0.05, 6)
  })
})
