// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import { boxCage } from '../../form/starters'

const st = () => useFormStore.getState()
const session = {
  active: true, open: () => {}, finish: vi.fn(), cancel: vi.fn(), undo: () => {}, redo: () => {},
  canUndo: false, canRedo: false, railSections: [],
}
const sentences = {
  translate: 'Move: click a point, edge or face to select it; Shift adds.',
  rotate: 'Rotate: click a point, edge or face to rotate it',
  scale: 'Scale: click a point, edge or face to scale it',
} as const

beforeEach(() => {
  window.localStorage.clear()
  st().openSession({ featureId: null, name: 'Form 1', cage: boxCage() })
})
afterEach(() => { cleanup(); st().closeSession() })

describe('WO-2502 every Form session starts in Move', () => {
  it.each(['rotate', 'scale'] as const)('resets %s for a new form', (mode) => {
    st().setTransformMode(mode)
    st().closeSession()
    st().openSession({ featureId: null, name: 'Next form' })
    expect(st().transformMode).toBe('translate')
    expect(st().selection).toEqual({ points: [], edges: [], faces: [] })
  })

  it.each(['rotate', 'scale'] as const)('resets %s when reopening an existing feature', (mode) => {
    const cage = boxCage({ size: { x: 55, y: 25, z: 15 } })
    st().setTransformMode(mode)
    st().openSession({ featureId: 'FRM7', name: 'Existing', cage, tolerance: 0.02, symmetry: 'x', symmetryAt: 4 })
    expect(st().transformMode).toBe('translate')
    expect(st().featureId).toBe('FRM7')
    expect(st().cage).toEqual(cage)
    expect(st().tolerance).toBe(0.02)
    expect(st().symmetry).toBe('x')
    expect(st().symmetryAt).toBe(4)
  })

  it.each(['cancel', 'finish'] as const)('reopens in Move after the real session %s route', (leave) => {
    const dag = new FeatureDag()
    const deps = { runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn() }
    const { result } = renderHook(() => useFormSession(deps))
    const tools = () => result.current.railSections.flatMap(s => s.tools)
    act(() => result.current.open())
    act(() => tools().find(t => t.testId === 'form-transform-scale')!.onClick())
    expect(st().transformMode).toBe('scale')
    act(() => result.current[leave]())
    expect(st().active).toBe(false)
    act(() => result.current.open())
    expect(st().transformMode).toBe('translate')
    expect(tools().filter(t => t.testId?.startsWith('form-transform-') && t.active).map(t => t.testId)).toEqual(['form-transform-translate'])
    if (leave === 'finish') {
      act(() => tools().find(t => t.testId === 'form-transform-rotate')!.onClick())
      act(() => result.current.cancel())
      act(() => result.current.open('FRM1'))
      expect(st().featureId).toBe('FRM1')
      expect(st().transformMode).toBe('translate')
    }
  })

  it.each(['rotate', 'scale'] as const)('keeps %s during selection, starter, undo and display changes', (mode) => {
    st().setTransformMode(mode)
    st().select({ kind: 'face', index: 0 }, false)
    st().subdivideSelection()
    st().undo()
    st().setDisplayMode('cage')
    st().newFromStarter('plane')
    expect(st().transformMode).toBe(mode)
  })
})

describe('WO-2502 empty selection names the active mode', () => {
  it.each(['translate', 'rotate', 'scale'] as const)('reactively shows the %s sentence', (mode) => {
    render(<FormPanel session={session} />)
    act(() => st().setTransformMode(mode))
    expect(screen.getByTestId('form-selection').textContent).toBe(sentences[mode])
    expect(screen.getByTestId('form-selection').closest('.docked-panel-footer')).not.toBeNull()
  })

  it('keeps selected counts and the Alt-drag hint, restoring the active sentence on deselect', () => {
    render(<FormPanel session={session} />)
    for (const mode of ['translate', 'rotate', 'scale'] as const) {
      act(() => { st().setTransformMode(mode); st().setSelection({ points: [], edges: [], faces: [0] }) })
      expect(screen.getByTestId('form-selection').textContent).toBe('Selected: 1 face')
      act(() => st().setSelection({ points: [], edges: [], faces: [] }))
      expect(screen.getByTestId('form-selection').textContent).toBe(sentences[mode])
    }
    expect(screen.getByTestId('form-palette').querySelector('.form-hint')?.textContent).toBe('Alt-drag a move arrow to extrude the selected faces.')
  })
})
