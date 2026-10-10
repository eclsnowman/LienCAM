// @vitest-environment jsdom
//
// Form stage 15: the rail's Extrude and Revolve take the profile of the sketch
// selected in the Model tree (the page's selectedSketch dep), use the palette's
// Extrude height, and with no sketch build a default profile and say so.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import { validateCage } from '../../form/halfEdge'
import type { SketchEntity } from '../../lib/sketch/types'

const line = (id: string, a: [number, number], b: [number, number]) =>
  ({ id, kind: 'line', construction: false, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } }) as unknown as SketchEntity
const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as Array<[number, number]>
const entities = square.map((p, i) => line(`l${i}`, p, square[(i + 1) % 4]))
// a sketch on the plane Z = 7
const frame = { origin: { x: 0, y: 0, z: 7 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }

function mount(sketch: boolean) {
  const dag = new FeatureDag()
  const deps = {
    runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn(),
    selectedSketch: () => (sketch ? { name: 'Sketch 3', entities, frame } : null),
  }
  const { result } = renderHook(() => useFormSession(deps))
  act(() => result.current.open())
  const tool = (id: string) => result.current.railSections.flatMap((s) => s.tools).find((t) => t.testId === id)!
  return { tool }
}

afterEach(() => {
  act(() => useFormStore.getState().closeSession())
  cleanup()
})

describe('Form - Extrude / Revolve from the rail', () => {
  it('Extrude takes the selected sketch up by the palette height from its plane', () => {
    const { tool } = mount(true)
    act(() => useFormStore.getState().setProfileHeight(12))
    act(() => tool('form-starter-extrude').onClick())
    const st = useFormStore.getState()
    expect(validateCage(st.cage, true).problems).toEqual([])
    const z = st.cage.positions.map((p) => p[2])
    expect(Math.min(...z)).toBeCloseTo(7, 9)
    expect(Math.max(...z)).toBeCloseTo(19, 9)
    // WO-2500: a straight side is one span - four points round the square
    expect(st.notice).toBe('Extruded Sketch 3 12 mm: 4 points round, 4 corners creased')
    expect(st.cage.positions).toHaveLength(12)
    // one undo step back to the cage before
    act(() => useFormStore.getState().undo())
    expect(Math.max(...useFormStore.getState().cage.positions.map((p) => p[2]))).not.toBeCloseTo(19, 3)
  })

  it('Revolve turns it round the sketch Y axis (the square touches it) into a closed form', () => {
    const { tool } = mount(true)
    act(() => tool('form-starter-revolve').onClick())
    const st = useFormStore.getState()
    expect(validateCage(st.cage, true).problems).toEqual([])
    expect(st.notice).toBe('Revolved Sketch 3 round the sketch Y axis: 4 points along the profile, 16 round, 2 poles on the axis')
  })

  it('with no sketch selected both build a default profile and say how to use a sketch', () => {
    const { tool } = mount(false)
    act(() => tool('form-starter-extrude').onClick())
    expect(useFormStore.getState().notice).toMatch(/With a sketch selected in the Model tree, Extrude takes its profile/)
    expect(validateCage(useFormStore.getState().cage, true).problems).toEqual([])
    act(() => tool('form-starter-revolve').onClick())
    expect(useFormStore.getState().notice).toMatch(/With a sketch selected in the Model tree, Revolve turns its profile/)
    expect(validateCage(useFormStore.getState().cage, true).problems).toEqual([])
  })
})
