// GEO-23-R2 C1: PMREMGenerator.fromScene() returns a WebGLRenderTarget (framebuffer
// + depth renderbuffer), not just a texture. The R1 audit's major finding was that
// installViewportEnvironment kept only .texture and disposed THAT, discarding the
// target handle needed to free the framebuffer/renderbuffer (three's WebGLTextures
// render-target disposal path is distinct from its plain-texture path -- see
// buildEnvironment.ts's C1 comment). This test proves the fix at the JS-object
// level: PMREMGenerator.fromScene() needs a real GL context (WebGLRenderer.render
// internally), so it cannot run headless in vitest -- we mock ONLY PMREMGenerator
// (RoomEnvironment is pure Object3D/geometry construction, no GL, so it stays real)
// and capture the exact WebGLRenderTarget instance fromScene() would have returned.
//
// Can-fail proof: RenderTarget.dispose() (three/src/core/RenderTarget.js) ONLY
// dispatches its own 'dispose' event -- it does NOT call this.texture.dispose().
// So target.dispose() and target.texture.dispose() are observably distinct JS
// method calls. A reverted fix (`envTexture.dispose()` only, the audited defect)
// calls the texture spy and NEVER the target spy; this test's assertion on the
// target spy is exactly what flips RED under that mutation (proof recorded in
// coordination/evidence/GEO-23-R2/mutation-C1/).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { typedMock } from '../support/typedMock'

const { capturedTargets } = vi.hoisted(() => ({ capturedTargets: [] as unknown[] }))

vi.mock('three', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('three')
  class FakePMREMGenerator {
    constructor(_renderer: unknown) {}
    fromScene(_scene: unknown, _sigma: number) {
      const target = new actual.WebGLRenderTarget(16, 16)
      capturedTargets.push(target)
      return target
    }
    dispose(): void {
      // The generator's own transient render targets -- not under test here.
    }
    // Not exercised by this test (only fromScene + dispose are), but required
    // to satisfy the real PMREMGenerator's instance shape now that the mock is
    // checked against it.
    fromEquirectangular = vi.fn()
    fromCubemap = vi.fn()
    compileCubemapShader = vi.fn()
    compileEquirectangularShader = vi.fn()
  }
  return typedMock<typeof import('three')>({ ...actual, PMREMGenerator: FakePMREMGenerator })
})

import * as THREE from 'three'
import { installViewportEnvironment } from '../../lib/viewport/lighting/buildEnvironment'

describe('installViewportEnvironment (GEO-23-R2 C1)', () => {
  const win = globalThis as unknown as { window?: unknown }
  const hadWindow = 'window' in win

  beforeEach(() => {
    capturedTargets.length = 0
    // buildEnvironment's DEV telemetry block reads `window.__geo23EnvBakes` when
    // import.meta.env.DEV is true; this vitest run has no DOM global, so stand in
    // a minimal object (mirrors how a real browser tab supplies `window`).
    if (!hadWindow) win.window = {}
  })

  afterEach(() => {
    if (!hadWindow) delete win.window
  })

  it('dispose() frees the PMREM WebGLRenderTarget itself, not only its texture', () => {
    const fakeRenderer = {} as THREE.WebGLRenderer
    const scene = new THREE.Scene()

    const env = installViewportEnvironment(fakeRenderer, scene, 1)

    expect(capturedTargets).toHaveLength(1)
    const target = capturedTargets[0] as THREE.WebGLRenderTarget
    expect(scene.environment).toBe(target.texture)

    const targetDisposeSpy = vi.spyOn(target, 'dispose')
    const textureDisposeSpy = vi.spyOn(target.texture, 'dispose')

    env.dispose()

    expect(targetDisposeSpy).toHaveBeenCalledTimes(1)
    expect(scene.environment).toBeNull()
    // The texture path may or may not fire depending on implementation, but the
    // defect this test guards against is specifically the RENDER TARGET being
    // discarded -- textureDisposeSpy is recorded for evidence, not asserted on.
    void textureDisposeSpy
  })
})
