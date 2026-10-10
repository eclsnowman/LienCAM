// @vitest-environment jsdom
//
// Form palette groups: the settings sit under the rail group names whose tools they set, each group folds,
// the folds are remembered, and a group with no row showing has no header.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { useFormStore } from '../../form/formStore'

const session = {
  active: true, open: () => {}, finish: () => {}, cancel: () => {}, undo: () => {}, redo: () => {},
  canUndo: false, canRedo: false, railSections: [],
} as unknown as Parameters<typeof FormPanel>[0]['session']
const inGroup = (group: string, testId: string) => screen.getByTestId(`form-group-${group}`).querySelector(`[data-testid="${testId}"]`) !== null
const header = (group: string) => screen.getByTestId(`form-group-toggle-${group}`)

describe('Form palette groups', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useFormStore.getState().openSession({ featureId: null, name: 'Form 1', tolerance: 0.01 })
  })
  afterEach(cleanup)

  it('each setting sits under the rail group of the tools it sets', () => {
    render(<FormPanel session={session} />)
    expect(inGroup('start', 'form-segments-x')).toBe(true)
    expect(inGroup('start', 'form-pipe-radius')).toBe(true)
    expect(inGroup('edit', 'form-soft-radius')).toBe(true)
    expect(inGroup('topology', 'form-bridge-segments')).toBe(false)
    expect(inGroup('openings', 'form-bridge-segments')).toBe(true)
    expect(inGroup('display', 'form-tolerance')).toBe(true)
    // the name stays on top, in no group
    expect(screen.getByTestId('form-name').closest('.form-group')).toBeNull()
  })

  it('a header folds its group and unfolds it; the other groups stay; folds are remembered', () => {
    render(<FormPanel session={session} />)
    fireEvent.click(header('start'))
    expect(screen.queryByTestId('form-segments-x')).toBeNull()
    expect(header('start').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('form-soft-radius')).toBeTruthy()
    cleanup()
    render(<FormPanel session={session} />)
    expect(screen.queryByTestId('form-segments-x')).toBeNull()
    fireEvent.click(header('start'))
    expect(screen.getByTestId('form-segments-x')).toBeTruthy()
  })

  it('Symmetry has no header until a mirror is on (its rows only show then)', () => {
    render(<FormPanel session={session} />)
    expect(screen.queryByTestId('form-group-symmetry')).toBeNull()
    cleanup()
    useFormStore.getState().setSymmetry('x')
    render(<FormPanel session={session} />)
    expect(inGroup('symmetry', 'form-mirror-at')).toBe(true)
  })
})
