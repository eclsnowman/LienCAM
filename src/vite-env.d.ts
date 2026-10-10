/// <reference types="vite/client" />

// Build-time provenance constants injected by Vite's `define` (see
// vite.config.ts). They are textual replacements at build time, NOT real runtime
// bindings, so they are `undefined` in non-vite contexts (vitest/SSR). Consumers
// (src/version.ts) must guard with `typeof __X__ !== 'undefined'`.
declare const __APP_GIT_COMMIT__: string
declare const __APP_GIT_BRANCH__: string
declare const __APP_BUILD_DATE__: string
