// @vitest-environment jsdom
//
// WO-3111: Form - From body owns the source body's presentation only while
// the form cage is active. Cancel returns that exact body to the viewport;
// Finish deliberately leaves it hidden behind the new Form result.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { CommandHistory, FeatureDag } from '../../doc'
import { useFormSession } from '../../components/model3d/form/useFormSession'
import { useFormStore } from '../../form/formStore'
import type { BodyMesh } from '../../form/fromMesh'

const mesh: BodyMesh = {
  position: Float32Array.from([
    0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
    0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,
  ]),
  index: Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]),
  triFace: Uint32Array.from([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mount(selectedBodyMesh: () => Promise<{ featureId: string; mesh: BodyMesh } | null>) {
  const dag = new FeatureDag()
  const history = new CommandHistory(dag)
  const presentation = new Map([['MESH', true], ['OTHER', true]])
  const showBody = vi.fn((id: string, visible: boolean) => presentation.set(id, visible))
  const hideBody = vi.fn((id: string) => presentation.set(id, false))
  const onApplied = vi.fn()
  const deps = {
    runtime: null, canvasRef: { current: null }, dag, history, onApplied, showBody, hideBody, selectedBodyMesh,
  }
  const hook = renderHook(() => useFormSession(deps))
  const bodyTool = () => hook.result.current.railSections.flatMap((section) => section.tools).find((tool) => tool.testId === 'form-starter-body')!
  return { ...hook, bodyTool, dag, history, presentation, showBody, hideBody, onApplied }
}

async function startFromBody(session: ReturnType<typeof mount>) {
  await act(async () => { void session.bodyTool().onClick() })
  await waitFor(() => expect(useFormStore.getState().sourceBodyId).toBe('MESH'))
}

afterEach(() => {
  act(() => useFormStore.getState().closeSession())
  cleanup()
})

describe('WO-3111 Form cancellation restores the source mesh presentation', () => {
  it('returns a converted source mesh on Cancel, preserves its data, and leaves Finish behavior intact', async () => {
    const source = { featureId: 'MESH', mesh }
    const sourceBytes = Array.from(mesh.position)
    const session = mount(async () => source)

    act(() => session.result.current.open())
    await startFromBody(session)
    expect(session.presentation.get('MESH')).toBe(false)
    expect(session.presentation.get('OTHER')).toBe(true)
    expect(mesh.position).toEqual(Float32Array.from(sourceBytes))
    expect(source.mesh).toBe(mesh)

    act(() => session.result.current.cancel())
    expect(session.presentation.get('MESH')).toBe(true)
    expect(session.presentation.get('OTHER')).toBe(true)
    expect(session.showBody).toHaveBeenLastCalledWith('MESH', true)
    expect(useFormStore.getState().active).toBe(false)
    expect(useFormStore.getState().sourceBodyId).toBeNull()
    expect(mesh.position).toEqual(Float32Array.from(sourceBytes))

    // A new session repeats the restoration route, while Finish retains the
    // pre-existing result semantics: the source stays hidden behind the Form.
    act(() => session.result.current.open())
    await startFromBody(session)
    act(() => session.result.current.finish())
    expect(session.hideBody).toHaveBeenLastCalledWith('MESH')
    expect(session.presentation.get('MESH')).toBe(false)
    expect(session.onApplied).toHaveBeenCalledTimes(1)
    const finishedId = session.onApplied.mock.calls[0]![0] as string
    expect(session.dag.getNode(finishedId)?.kind).toBe('feature')
    expect(mesh.position).toEqual(Float32Array.from(sourceBytes))
  })

  it('Cancel invalidates a pending source conversion so a late selection cannot hide the mesh', async () => {
    const pending = deferred<{ featureId: string; mesh: BodyMesh } | null>()
    const session = mount(() => pending.promise)

    act(() => session.result.current.open())
    await act(async () => { void session.bodyTool().onClick() })
    expect(useFormStore.getState().active).toBe(true)
    act(() => session.result.current.cancel())
    expect(session.presentation.get('MESH')).toBe(true)
    expect(useFormStore.getState().active).toBe(false)

    await act(async () => { pending.resolve({ featureId: 'MESH', mesh }); await Promise.resolve() })
    expect(session.showBody).not.toHaveBeenCalled()
    expect(session.presentation.get('MESH')).toBe(true)
    expect(useFormStore.getState().sourceBodyId).toBeNull()
  })
})
