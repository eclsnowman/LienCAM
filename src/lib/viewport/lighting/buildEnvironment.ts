// GEO-23 L1: the shared image-based-lighting (IBL) environment, applied to BOTH
// the CAM viewport (CNCViewport.ts) and the Model workspace (sceneRuntime.ts).
// ONE module, two call sites, no third fork.
//
// Root cause it addresses (recon 2026-07-18): both viewports lit bodies with a
// handful of fixed directionals all above the part, so a -Z (bottom) face and a
// side-/bottom-bored hole interior received almost no direct light and read
// black / flat. RoomEnvironment is a synthetic lit room; baked into a PMREM cube
// via PMREMGenerator it becomes scene.environment, so EVERY MeshStandardMaterial
// samples real irradiance from every direction -- orbit to any face and it is
// lit "from the space", exactly Operator's ask. No material TYPE change is needed:
// MeshStandardMaterial reads scene.environment implicitly, and unlit overlay
// materials (LineBasicMaterial / MeshBasicMaterial) never sample it (G2).
//
// scene.background is untouched (fromScene renders the throwaway RoomEnvironment
// scene, not the live one), so each viewport keeps its dark --vp-canvas clear.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

export interface ViewportEnvironment {
  /** The PMREM cube texture assigned to scene.environment. */
  readonly texture: THREE.Texture
  /**
   * Detach from the scene and free the PMREM render target (GPU framebuffer +
   * depth renderbuffer) that owns `texture`. Call on viewport dispose.
   */
  dispose(): void
}

/**
 * Bake RoomEnvironment into a PMREM texture and install it as scene.environment.
 *
 * Called ONCE at viewport construction (never per-frame or per-orbit): the PMREM
 * texture is a static cube, and scene.environmentIntensity is what the headlight/
 * orbit vary against. The heavy transient render targets live on the
 * PMREMGenerator and the RoomEnvironment meshes, both disposed here immediately
 * after the bake -- only the small resulting cube texture is retained (preflight
 * PERF/leak note).
 *
 * @param renderer the live WebGLRenderer (PMREMGenerator renders into it once)
 * @param scene    the scene whose .environment / .environmentIntensity are set
 * @param intensity scene.environmentIntensity (envMapIntensity on every std mat)
 */
export function installViewportEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  intensity: number,
): ViewportEnvironment {
  const t0 = performance.now()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  // sigma 0.04: a light blur so the IBL is smooth diffuse irradiance rather than
  // sharp reflections of the room geometry on a roughness-0.55/0.8 body.
  // GEO-23-R2 C1: fromScene() returns a WebGLRenderTarget (framebuffer + depth
  // renderbuffer), not just a texture -- keep the target so dispose() below can
  // free that GPU-side allocation, not only the texture it owns.
  const envTarget = pmrem.fromScene(room, 0.04)
  const envTexture = envTarget.texture
  scene.environment = envTexture
  scene.environmentIntensity = intensity
  // Free the generator's render targets and the room's geometry/materials -- the
  // baked cube texture is all we keep.
  pmrem.dispose()
  room.dispose()
  const bakeMs = performance.now() - t0

  // GEO-23-R1 cure C4: record the ONE-TIME PMREM bake wall time and the retained
  // env-texture GPU memory estimate as DEV-only telemetry the perf probe reads
  // (perfProbe.mjs). This is not a production interface member and is stripped from
  // any production build (import.meta.env.DEV). The retained cost is JUST this cube
  // texture (the generator + room meshes were disposed above).
  if (import.meta.env.DEV) {
    const img = (envTexture.image ?? {}) as { width?: number; height?: number }
    const w = img.width ?? 0, h = img.height ?? 0
    // PMREM cube-uv output is RGBA HalfFloat (2 bytes/channel) -> w*h*4*2 bytes.
    const bytesPerTexel = envTexture.type === THREE.HalfFloatType ? 8 : envTexture.type === THREE.FloatType ? 16 : 4
    const bytes = w * h * bytesPerTexel
    const rec = { bakeMs: +bakeMs.toFixed(2), width: w, height: h, textureType: envTexture.type, bytes, intensity }
    const win = window as unknown as { __geo23EnvBakes?: unknown[] }
    ;(win.__geo23EnvBakes ??= []).push(rec)
  }

  return {
    texture: envTexture,
    dispose(): void {
      if (scene.environment === envTexture) scene.environment = null
      // GEO-23-R2 C1: dispose the render TARGET, not just its texture -- the
      // target owns the framebuffer/depth renderbuffer three allocated for it
      // (WebGLTextures' render-target disposal path is distinct from its plain
      // texture path). target.dispose() also disposes envTexture internally.
      envTarget.dispose()
    },
  }
}
