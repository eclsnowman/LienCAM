// @vitest-environment jsdom
//
// WO-2232: the Form rail's Start-from group lights the button the current form
// was started from - not just the five primitives (Box..Plane); Pipe, Extrude,
// Revolve, Loft and From body light too, and exactly one button lights at a time.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import type { SketchEntity } from '../../lib/sketch/types'
import type { BodyMesh } from '../../form/fromMesh'
import type { PlaneFrame } from '../../form/pipe'

const line = (id: string, a: [number, number], b: [number, number]) =>
  ({ id, kind: 'line', construction: false, start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] } }) as unknown as SketchEntity

function square(z: number): { entities: readonly SketchEntity[]; frame: PlaneFrame } {
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10]] as Array<[number, number]>
  const entities = pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % 4]))
  return { entities, frame: { origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } } }
}

/** an 8-point box as a raw tessellation (six flat quad faces, two triangles each): From body's fromMesh.ts merges it back to the same eight points */
function boxMesh(): BodyMesh {
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  const position = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]
  // each quad in outward-normal winding (fromMesh.ts orients its cage from the triangles' own winding)
  const quads = [
    [0, 3, 2, 1], // bottom
    [4, 5, 6, 7], // top
    [0, 1, 5, 4], // front
    [3, 7, 6, 2], // back
    [0, 4, 7, 3], // left
    [1, 2, 6, 5], // right
  ]
  const index: number[] = []
  const triFace: number[] = []
  quads.forEach(([a, b, c, d], f) => { index.push(a, b, c, a, c, d); triFace.push(f, f) })
  return { position, index, triFace }
}

function mount(sketch: { entities: readonly SketchEntity[]; frame: PlaneFrame } | null = null, body: BodyMesh | null = boxMesh()) {
  const dag = new FeatureDag()
  const onApplied = vi.fn()
  const deps = {
    runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied, showBody: vi.fn(),
    selectedSketch: () => (sketch === null ? null : { name: 'Sketch 1', ...sketch }),
    selectedBodyMesh: async () => (body === null ? null : { featureId: 'SRC', mesh: body }),
  }
  const { result } = renderHook(() => useFormSession(deps))
  const tool = (id: string) => result.current.railSections.flatMap((s) => s.tools).find((t) => t.testId === id)!
  const lit = () => result.current.railSections.find((s) => s.id === 'form-create')!.tools.filter((t) => t.active === true).map((t) => t.testId)
  return { result, tool, lit, onApplied }
}

afterEach(() => {
  act(() => useFormStore.getState().closeSession())
  cleanup()
})

describe('WO-2232: the Start-from button you chose lights, and only that one', () => {
  it('a primitive lights, and choosing a next one unlights the last', () => {
    const { result, tool, lit } = mount()
    act(() => result.current.open())
    act(() => tool('form-starter-torus').onClick())
    expect(lit()).toEqual(['form-starter-torus'])
    act(() => tool('form-starter-cylinder').onClick())
    expect(lit()).toEqual(['form-starter-cylinder'])
  })

  it('Pipe lights and unlights the primitive lit before it', () => {
    const { result, tool, lit } = mount()
    act(() => result.current.open())
    act(() => tool('form-starter-torus').onClick())
    act(() => tool('form-starter-pipe').onClick())
    expect(lit()).toEqual(['form-starter-pipe'])
  })

  it('Extrude lights and unlights Pipe', () => {
    const { result, tool, lit } = mount(square(0))
    act(() => result.current.open())
    act(() => tool('form-starter-pipe').onClick())
    act(() => tool('form-starter-extrude').onClick())
    expect(lit()).toEqual(['form-starter-extrude'])
  })

  it('Revolve lights and unlights Extrude', () => {
    const { result, tool, lit } = mount(square(0))
    act(() => result.current.open())
    act(() => tool('form-starter-extrude').onClick())
    act(() => tool('form-starter-revolve').onClick())
    expect(lit()).toEqual(['form-starter-revolve'])
  })

  it('From body lights and unlights Revolve', async () => {
    const { result, tool, lit } = mount(square(0))
    act(() => result.current.open())
    act(() => tool('form-starter-revolve').onClick())
    await act(async () => {
      tool('form-starter-body').onClick()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(lit()).toEqual(['form-starter-body'])
  })

  it("Loft lights only once its cage actually builds (the second profile), not on the first click", () => {
    const profiles = [square(0), square(20)]
    let call = 0
    const dag = new FeatureDag()
    const deps = {
      runtime: null, canvasRef: { current: null }, dag, history: new CommandHistory(dag), onApplied: vi.fn(), showBody: vi.fn(),
      selectedSketch: () => ({ name: `Sketch ${call}`, ...profiles[call] }),
    }
    const { result } = renderHook(() => useFormSession(deps))
    const tool = (id: string) => result.current.railSections.flatMap((s) => s.tools).find((t) => t.testId === id)!
    const lit = () => result.current.railSections.find((s) => s.id === 'form-create')!.tools.filter((t) => t.active === true).map((t) => t.testId)
    act(() => result.current.open())
    act(() => tool('form-starter-torus').onClick())
    call = 0
    act(() => tool('form-starter-loft').onClick())
    expect(useFormStore.getState().notice).toMatch(/profile 1/)
    expect(lit()).toEqual(['form-starter-torus'])
    call = 1
    act(() => tool('form-starter-loft').onClick())
    expect(lit()).toEqual(['form-starter-loft'])
  })

  it('a start that does not happen (From body, nothing selected) leaves the lit button as it was', async () => {
    const { result, tool, lit } = mount(null, null)
    act(() => result.current.open())
    act(() => tool('form-starter-torus').onClick())
    await act(async () => {
      tool('form-starter-body').onClick()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(useFormStore.getState().notice).toMatch(/Select a body/)
    expect(lit()).toEqual(['form-starter-torus'])
  })

  it('opening an existing form lights none: the feature does not record what it was started from', () => {
    const { result, tool, lit, onApplied } = mount()
    act(() => result.current.open())
    act(() => tool('form-starter-torus').onClick())
    act(() => result.current.finish())
    const id = onApplied.mock.calls[0][0] as string
    act(() => result.current.open(id))
    expect(lit()).toEqual([])
  })

  it('a brand new form lights the starter it opens with (the default box)', () => {
    act(() => useFormStore.setState({ starterKind: 'box' }))
    const { result, lit } = mount()
    act(() => result.current.open())
    expect(lit()).toEqual(['form-starter-box'])
  })

  it('Torus -> Face: only Face lights while the replace tool runs, and after the first face commits, not both', () => {
    const { result, tool, lit } = mount()
    act(() => result.current.open())
    act(() => tool('form-starter-torus').onClick())
    expect(lit()).toEqual(['form-starter-torus'])
    act(() => tool('form-starter-face').onClick())
    expect(lit()).toEqual(['form-starter-face'])
    act(() => {
      useFormStore.getState().addFaceClick({ at: [0, 0, 0] })
      useFormStore.getState().addFaceClick({ at: [10, 0, 0] })
      useFormStore.getState().addFaceClick({ at: [10, 10, 0] })
      useFormStore.getState().addFaceClick({ at: [0, 10, 0] })
    })
    expect(useFormStore.getState().notice).toMatch(/Added a face/)
    expect(lit()).toEqual(['form-starter-face'])
  })
})
