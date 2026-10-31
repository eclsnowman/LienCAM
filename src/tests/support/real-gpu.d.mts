// Types for real-gpu.mjs. The harnesses are plain .mjs (they run under node with
// no build step), but src/tests/viewport/realGpuClassifier.ui74.test.ts imports
// the classifier so the matcher table is pinned by the same suite as everything
// else -- and `npm run build` typechecks the tests, so the module needs a shape.

export interface RealGpuVerdict {
  /** True ONLY for a string naming a known hardware family and no software device. */
  ok: boolean
  /** Why, in words a log reader can act on. */
  why: string
  /** The matched family, or null for every refusal. */
  family: string | null
}

export interface HardwareFamily {
  family: string
  match: RegExp
}

export declare const SOFTWARE_GL: RegExp
export declare const HARDWARE_FAMILIES: HardwareFamily[]
export declare function realGpuVerdict(renderer: unknown): RealGpuVerdict
