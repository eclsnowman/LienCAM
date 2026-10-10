// Single source of truth for the application version.
//
// The version lives in package.json (`"version"`); this module re-exports it so
// the rest of the app imports ONE constant instead of hardcoding a literal.
// Enabled by `resolveJsonModule` in tsconfig.app.json; under Vite/Vitest the JSON
// import resolves natively. Distinct from the project FILE-FORMAT schema version
// (CURRENT_PROJECT_SCHEMA_VERSION in src/store/migrations/projectMigrations.ts),
// which versions the saved .camproject document, not the app build.
import pkg from '../package.json'

export const APP_VERSION: string = pkg.version

// Build provenance, injected at build time by Vite's `define`
// (vite.config.ts) and declared in src/vite-env.d.ts. Each is guarded with a
// `typeof ... !== 'undefined'` check so non-vite contexts (vitest, SSR) — where
// the define replacement never runs — fall back to 'dev' instead of throwing a
// ReferenceError. GIT_COMMIT carries the readable revision plus the renderer
// input digest, so dirty builds remain traceable to their actual bytes.
export const GIT_COMMIT: string =
  typeof __APP_GIT_COMMIT__ !== 'undefined' ? __APP_GIT_COMMIT__ : 'dev'
// The full GIT_COMMIT value is machine provenance consumed by the freshness
// check. Human-facing version readouts keep the short, speakable revision.
export const GIT_COMMIT_LABEL: string = GIT_COMMIT.replace(/:sha256-[0-9a-f]{64}$/i, '')
export const GIT_BRANCH: string =
  typeof __APP_GIT_BRANCH__ !== 'undefined' ? __APP_GIT_BRANCH__ : 'dev'
export const BUILD_DATE: string =
  typeof __APP_BUILD_DATE__ !== 'undefined' ? __APP_BUILD_DATE__ : 'dev'
