// @vitest-environment jsdom
//
// WO-2095: the 3D view never runs out of WebGL contexts.
//
// Measured 2026-09-27: after about 8 New / Model cycles in the real app the
// browser printed "WARNING: Too many active WebGL contexts. Oldest context will
// be lost." The Model screen builds its view through createDefaultSceneRuntime
// on mount and calls runtime.dispose() on unmount (SolidsWorkbenchPage.tsx), but
// dispose() only called renderer.dispose(). That frees three's GPU resources and
// leaves the context alive until the browser garbage-collects the canvas, so
// every closed view kept counting toward the browser's cap.
//
// This drives the PRODUCTION factory, createDefaultSceneRuntime. jsdom has no GL,
// so only the two GL-bound classes are replaced (the same seam
// buildEnvironment.dispose.test.ts uses for PMREMGenerator). The fake models the
// browser the way it behaves:
//   - a canvas has ONE context for its whole life; the first renderer on it
//     makes that context, a later renderer on the same canvas gets the same one;
//   - renderer.dispose() does not give the context back;
//   - WEBGL_lose_context.loseContext() does, and a renderer built on a lost
//     context throws (real three: "Cannot read properties of null (reading
//     'precision')" -- seen when the dev double mount reused the canvas);
//   - past the cap the browser drops the oldest context and prints the warning.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { typedMock } from '../support/typedMock'

interface FakeGl {
  lost: boolean
  isContextLost(): boolean
  getExtension(name: string): { loseContext(): void } | null
}

const { browser } = vi.hoisted(() => ({
  browser: {
    cap: 16,
    live: [] as object[],
    warnings: [] as string[],
    byCanvas: new WeakMap<object, object>(),
  },
}))

vi.mock('three', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('three')

  function contextFor(canvas: HTMLCanvasElement): FakeGl {
    const existing = browser.byCanvas.get(canvas) as FakeGl | undefined
    if (existing) return existing
    const gl: FakeGl = {
      lost: false,
      isContextLost: () => gl.lost,
      getExtension: (name) => name === 'WEBGL_lose_context'
        ? {
            loseContext: () => {
              gl.lost = true
              const at = browser.live.indexOf(gl)
              if (at >= 0) browser.live.splice(at, 1)
            },
          }
        : null,
    }
    browser.byCanvas.set(canvas, gl)
    browser.live.push(gl)
    if (browser.live.length > browser.cap) {
      const oldest = browser.live.shift() as FakeGl
      oldest.lost = true
      browser.warnings.push('WARNING: Too many active WebGL contexts. Oldest context will be lost.')
    }
    return gl
  }

  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement
    localClippingEnabled = false
    shadowMap = { enabled: true }
    toneMapping: number = actual.NoToneMapping
    toneMappingExposure = 1
    private pixelRatio = 1
    private gl: FakeGl

    constructor(params: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement = params.canvas ?? document.createElement('canvas')
      this.gl = contextFor(this.domElement)
      if (this.gl.lost) throw new TypeError("Cannot read properties of null (reading 'precision')")
    }
    getContext(): FakeGl { return this.gl }
    setPixelRatio(value: number): void { this.pixelRatio = value }
    getPixelRatio(): number { return this.pixelRatio }
    setSize(): void {}
    render(): void {}
    forceContextLoss(): void { this.gl.getExtension('WEBGL_lose_context')?.loseContext() }
    dispose(): void {}
  }

  class FakePMREMGenerator {
    constructor(_renderer: unknown) {}
    fromScene() {
      return new actual.WebGLRenderTarget(16, 16)
    }
    dispose(): void {}
    fromEquirectangular = vi.fn()
    fromCubemap = vi.fn()
    compileCubemapShader = vi.fn()
    compileEquirectangularShader = vi.fn()
  }

  return typedMock<typeof import('three')>({
    ...actual,
    WebGLRenderer: FakeWebGLRenderer as unknown as typeof actual.WebGLRenderer,
    PMREMGenerator: FakePMREMGenerator,
  })
})

import { createDefaultSceneRuntime } from '../../components/model3d/sceneRuntime'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** One Model-screen mount, the way SolidsWorkbenchPage does it: a canvas in the
 *  page, the runtime built on it in an effect, and on unmount React removes the
 *  canvas BEFORE the effect cleanup calls runtime.dispose(). */
function mountModelView(canvas = document.createElement('canvas')) {
  if (!canvas.isConnected) document.body.appendChild(canvas)
  const runtime = createDefaultSceneRuntime(canvas)
  return {
    canvas,
    runtime,
    unmount: () => {
      canvas.remove()
      runtime.dispose()
    },
  }
}

describe('WO-2095: every closed 3D view gives its WebGL context back', () => {
  beforeEach(() => {
    browser.live.length = 0
    browser.warnings.length = 0
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('20 New / Model cycles leave no context open and never hit the browser cap', () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      const view = mountModelView()
      expect(browser.live).toHaveLength(1)
      view.unmount()
    }
    expect(browser.live).toHaveLength(0)
    expect(browser.warnings).toEqual([])
  })

  it('a live view keeps its context while the closed ones are released', () => {
    const live = mountModelView()
    for (let cycle = 0; cycle < 20; cycle++) mountModelView().unmount()
    expect(browser.live).toHaveLength(1)
    expect(browser.warnings).toEqual([])
    live.unmount()
    expect(browser.live).toHaveLength(0)
  })

  it('the dev double mount rebuilds on the same canvas and keeps drawing', () => {
    vi.useFakeTimers()
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    // StrictMode: mount, cleanup with the canvas still in the page, mount again.
    createDefaultSceneRuntime(canvas).dispose()
    const second = createDefaultSceneRuntime(canvas)
    vi.runAllTimers()
    expect(browser.live).toHaveLength(1)
    // The real unmount afterwards still gives the context back.
    canvas.remove()
    second.dispose()
    expect(browser.live).toHaveLength(0)
  })

  it('a canvas removed just after dispose is released once it has left the page', () => {
    vi.useFakeTimers()
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    createDefaultSceneRuntime(canvas).dispose()
    canvas.remove()
    expect(browser.live).toHaveLength(1)
    vi.runAllTimers()
    expect(browser.live).toHaveLength(0)
  })
})
