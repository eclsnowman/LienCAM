// @vitest-environment jsdom
//
// WO UI-4 acceptance #3: section-view state round-trips through the UI-H1
// sectionable runtime (setClipPlanes). Drives the real hook against a fake
// SceneRuntime (jsdom has no WebGL) -- same fake-injection precedent
// Lab3DView/ChassisDemo established.

import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import * as THREE from 'three'
import { useSectionState } from '../../components/model3d/section'
import { createFakeSceneRuntime } from './fakeSceneRuntime'

afterEach(cleanup)

describe('useSectionState', () => {
  it('disabled by default: mounting never calls setClipPlanes with an active plane', () => {
    const runtime = createFakeSceneRuntime()
    const { result } = renderHook(() => useSectionState({ runtime }))
    expect(result.current.state.enabled).toBe(false)
  })

  it('enabling drives setClipPlanes with exactly one plane; disabling clears it (full render restored)', () => {
    const runtime = createFakeSceneRuntime()
    const { result, rerender } = renderHook(({ rt }) => useSectionState({ runtime: rt }), { initialProps: { rt: runtime } })

    act(() => {
      result.current.expandRangeFor(new THREE.BoxGeometry(40, 20, 10))
    })
    rerender({ rt: runtime })

    act(() => {
      result.current.setEnabled(true)
    })
    rerender({ rt: runtime })

    const lastCall = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1]
    expect(lastCall.length).toBe(1)

    act(() => {
      result.current.setEnabled(false)
    })
    rerender({ rt: runtime })

    const afterDisable = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1]
    expect(afterDisable).toEqual([]) // "toggle off restores full render"
  })

  it('flip negates the plane normal', () => {
    const runtime = createFakeSceneRuntime()
    const { result, rerender } = renderHook(({ rt }) => useSectionState({ runtime: rt }), { initialProps: { rt: runtime } })

    act(() => {
      result.current.expandRangeFor(new THREE.BoxGeometry(40, 20, 10))
    })
    rerender({ rt: runtime })
    act(() => {
      result.current.setEnabled(true)
    })
    rerender({ rt: runtime })

    const before = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1][0]
    act(() => {
      result.current.setFlip(true)
    })
    rerender({ rt: runtime })
    const after = runtime.clipPlaneCalls[runtime.clipPlaneCalls.length - 1][0]

    expect(after.normal.x).toBeCloseTo(-before.normal.x, 9)
    expect(after.normal.y).toBeCloseTo(-before.normal.y, 9)
    expect(after.normal.z).toBeCloseTo(-before.normal.z, 9)
  })

  it('switching axis resets position to auto (fully open) for the new axis', () => {
    const runtime = createFakeSceneRuntime()
    const { result, rerender } = renderHook(({ rt }) => useSectionState({ runtime: rt }), { initialProps: { rt: runtime } })

    act(() => {
      result.current.expandRangeFor(new THREE.BoxGeometry(40, 20, 10))
    })
    rerender({ rt: runtime })
    act(() => {
      result.current.setEnabled(true)
      result.current.setPos(5)
    })
    rerender({ rt: runtime })
    expect(result.current.state.pos).toBe(5)

    act(() => {
      result.current.setAxis('x')
    })
    rerender({ rt: runtime })
    expect(result.current.state.pos).toBeNull()
  })
})
