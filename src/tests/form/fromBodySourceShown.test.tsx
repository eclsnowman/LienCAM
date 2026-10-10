// @vitest-environment jsdom
//
// WO-2125 audit: Form - From body hides its source body for the session. Leaving
// form mode (Cancel) and replacing the cage with a starter must repaint that
// body, or the viewport keeps it invisible while the Bodies list says shown.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'

function mount() {
  const showBody = vi.fn()
  const dag = new FeatureDag()
  const deps = {
    runtime: null,
    canvasRef: { current: null },
    dag,
    history: new CommandHistory(dag),
    onApplied: vi.fn(),
    showBody,
  }
  const { result } = renderHook(() => useFormSession(deps))
  return { result, showBody }
}

afterEach(() => {
  act(() => useFormStore.getState().closeSession())
  cleanup()
})

describe('WO-2125 From body: the source body comes back', () => {
  it('Cancel repaints the From-body source body', () => {
    const { result, showBody } = mount()
    act(() => result.current.open())
    act(() => useFormStore.getState().setSourceBodyId('BLK'))
    showBody.mockClear()
    act(() => result.current.cancel())
    expect(showBody).toHaveBeenCalledWith('BLK', true)
    expect(useFormStore.getState().sourceBodyId).toBeNull()
  })

  it('a starter chosen after From body repaints the old source body', () => {
    const { result, showBody } = mount()
    act(() => result.current.open())
    act(() => useFormStore.getState().setSourceBodyId('BLK'))
    showBody.mockClear()
    const box = result.current.railSections.flatMap((s) => s.tools).find((t) => t.testId === 'form-starter-box')
    expect(box).toBeDefined()
    act(() => box!.onClick())
    expect(showBody).toHaveBeenCalledWith('BLK', true)
    expect(useFormStore.getState().sourceBodyId).toBeNull()
  })
})
