// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeomBridgeSession, RayLike } from '../../viewport3d'
import { AppearanceStore, useAppearanceSession } from '../../components/model3d/appearance'

const RAY = {} as RayLike

function sessionFor(hit: ReturnType<GeomBridgeSession['pick']>): GeomBridgeSession {
  return {
    pick: vi.fn(() => hit),
    selection: {
      setHover: vi.fn(),
      clearSelection: vi.fn(),
      select: vi.fn(),
    },
  } as unknown as GeomBridgeSession
}

afterEach(cleanup)

describe('useAppearanceSession whole-body color synchronization', () => {
  it('mirrors body apply and clear while keeping the AppearanceStore projection current', () => {
    const appearance = new AppearanceStore()
    const onBodyColorChanged = vi.fn()
    const session = sessionFor({
      kind: 'body',
      bodyId: 'body-1',
      id: 'body-1',
      distance: 1,
      point: { x: 0, y: 0, z: 0 },
    })
    const { result } = renderHook(() =>
      useAppearanceSession({
        session,
        appearance,
        liveBodyIds: () => ['body-1'],
        onBodyColorChanged,
      }),
    )

    act(() => result.current.handlePointerClick(RAY))
    act(() => result.current.applyColor([1, 0.5, 0]))

    expect(appearance.bodyColor('body-1')).toEqual([1, 0.5, 0])
    expect(onBodyColorChanged).toHaveBeenLastCalledWith('body-1', [1, 0.5, 0])

    act(() => result.current.clearColor())

    expect(appearance.bodyColor('body-1')).toBeUndefined()
    expect(onBodyColorChanged).toHaveBeenLastCalledWith('body-1', undefined)
    expect(onBodyColorChanged).toHaveBeenCalledTimes(2)
  })

  it('keeps per-face appearance Model-only', () => {
    const appearance = new AppearanceStore()
    const onBodyColorChanged = vi.fn()
    const session = sessionFor({
      kind: 'face',
      bodyId: 'body-1',
      id: 'face-1',
      distance: 1,
      point: { x: 0, y: 0, z: 0 },
    })
    const { result } = renderHook(() =>
      useAppearanceSession({
        session,
        appearance,
        liveBodyIds: () => ['body-1'],
        onBodyColorChanged,
      }),
    )

    act(() => result.current.handlePointerClick(RAY))
    act(() => result.current.applyColor([0.2, 0.4, 0.6]))
    expect(appearance.faceColor('face-1')).toEqual([0.2, 0.4, 0.6])

    act(() => result.current.clearColor())
    expect(appearance.faceColor('face-1')).toBeUndefined()
    expect(onBodyColorChanged).not.toHaveBeenCalled()
  })
})
