// Types for ui74-render-trap.mjs. The harness is plain .mjs (RENDER_TRAP_INIT is
// injected into the page and also run under node with no build step), but
// src/tests/viewport/renderTrap.ui74.test.ts imports the trap and its predicates
// so they are pinned by the same suite as everything else -- and `npm run build`
// typechecks the tests, so the module needs a shape. (Same reason the pins module
// carries a .d.mts: vitest strips types and a test can run green while
// `npm run build` refuses the import with TS7016. Charter 11.)

/** Installed at page bootstrap via page.addInitScript, and also runnable under
 *  node against a mock WebGLRenderer. Installs a `render` accessor that migrates
 *  onto WebGLRenderer.prototype at the first construction, capturing every
 *  renderer AT CONSTRUCTION and observing its FIRST render call. State lands on
 *  globalThis.__ui74Trap. Takes and returns nothing. */
export declare function RENDER_TRAP_INIT(): void

/** The signals the page measures after boot, which evalTrapDrift judges. */
export interface TrapDriftSignals {
  trapPresent?: boolean
  installed?: boolean
  constructedCount?: number
  protoRenderIsAccessor?: boolean
  seedRendererPresent?: boolean
  seedRendererCaptured?: boolean
  /** What `render` on the seed renderer's prototype is: our accessor, a drifted
   *  data-function (prototype method), none, or something else. */
  seedProtoRenderKind?: 'accessor' | 'data-function' | 'none' | 'other' | null
  threeVersion?: string
}

export interface TrapDriftVerdict {
  ok: boolean
  /** A named STOP code when the ruled mechanism did not install, else null. */
  stop: string | null
  why: string
}

/** THE VERSION-DRIFT TRIPWIRE, as a pure decision. STOPS by name when the setter
 *  never fired for a constructed renderer (render moved onto the prototype, or the
 *  trap did not arm in time) rather than silently enumerating nothing. */
export declare function evalTrapDrift(signals: TrapDriftSignals): TrapDriftVerdict

/** One LIVE (not collected) WebGL surface mapped to a wrapped renderer. */
export interface WrappedSurface {
  rid?: string
  page?: string
  /** The wrap's observed render-call count. */
  calls?: number | null
  /** The GL context's own draw-call delta since census install. */
  drawsSinceInstall?: number | null
  where?: string
}

export interface FirstCallVerdict {
  ok: boolean
  /** One entry per surface that drew but was not observed rendering (bypass). */
  offenders: string[]
}

/** R2 BLOCKER 1, as a pure decision: a live wrapped renderer whose GL context
 *  drew while the census watched must have been observed rendering (calls > 0). */
export declare function evalRendererFirstCall(surfaces: WrappedSurface[]): FirstCallVerdict
