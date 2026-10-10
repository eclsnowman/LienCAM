import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  observeSceneViewportResize,
  resizeSceneCameraProjection,
} from '../../components/model3d/sceneRuntime'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Model scene runtime layout resize', () => {
  it('updates perspective aspect when a docked panel changes canvas height', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)

    resizeSceneCameraProjection(camera, 1200, 600)

    expect(camera.aspect).toBe(2)
  })

  it('preserves orthographic vertical scale while reflowing horizontal aspect', () => {
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000)

    resizeSceneCameraProjection(camera, 1200, 600)

    expect(camera.top).toBe(10)
    expect(camera.bottom).toBe(-10)
    expect(camera.left).toBe(-20)
    expect(camera.right).toBe(20)
  })

  it('observes the canvas box and disconnects the observer on runtime disposal', () => {
    const callbacks: ResizeObserverCallback[] = []
    const observe = vi.fn()
    const disconnect = vi.fn()

    class FakeResizeObserver {
      constructor(next: ResizeObserverCallback) {
        callbacks.push(next)
      }

      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
    }

    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const canvas = {} as HTMLCanvasElement
    const onResize = vi.fn()

    const stop = observeSceneViewportResize(canvas, onResize)
    expect(observe).toHaveBeenCalledWith(canvas)

    callbacks[0]?.([], {} as ResizeObserver)
    expect(onResize).toHaveBeenCalledTimes(1)

    stop()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
