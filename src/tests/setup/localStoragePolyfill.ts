// Origin: WO UI-80-R3. Promoted to a global vitest setupFile by WO INT-17A-R7
// (coordination/work-orders/INT-17A-R7.md) after INT-17A Stage 1 wired model
// bodies into the CAM store's zustand `persist(...)` middleware -- every
// model3d suite that mounts SolidsWorkbenchPage and syncs a body now performs
// the first-ever CAM persist write in this environment, tripping a vitest/jsdom
// runner quirk (the "--localstorage-file was provided without a valid path"
// warning) whose global `localStorage.setItem` is not a function.
//
// The persist store resolves and CACHES its storage from the global
// `localStorage` at import-time hydration, so a test that stubs localStorage
// inside a test body is already too late -- the fix must land before the
// store's own module graph is imported. This module is registered in
// vite.config.ts `test.setupFiles`, which vitest runs to completion BEFORE
// importing the test file's module graph: @vitest/runner's
// dist/chunk-hooks.js `collectTests()` awaits `runSetupFiles(...)` (which
// itself awaits importing every setup file) and only then awaits
// `runner.importFile(filepath, "collect")` (the step that loads the test
// file and everything it imports, including the store). So installing here
// beats the store's hydration for every suite, with no per-suite import.
//
// Scope: jsdom suites ONLY. `test.environment` defaults to 'node' (see
// vite.config.ts) and per-file `// @vitest-environment jsdom` opts a suite in.
// Node-environment suites have no `window` global at all, and some of those
// suites intentionally exercise a world with NO localStorage (e.g. a
// localStorage-absent code path in a store test) -- installing a phantom
// storage for them would silently mask that path. Guarding on
// `typeof window !== 'undefined'` limits the install to jsdom suites only.
// WO-960: the typed-mock rule (src/tests/support/mockContractGuard.ts). It is
// installed from here, and not per-suite, because it wraps `vi.mock` and
// `vi.doMock` and has to be in place before a test file's HOISTED mock calls
// run - the same setupFiles-runs-before-collect ordering argued above. Written
// as an import rather than a call so it is hoisted with the module graph: this
// file's own polyfill must beat the product's imports, and the guard must beat
// the test file's, and those are two different races.
import '../support/mockContractGuard'
import './trackedFileGuard'

function installMemoryLocalStorage(): void {
  if (typeof window === 'undefined') return

  const existing = (globalThis as { localStorage?: unknown }).localStorage as Storage | undefined
  if (existing && typeof existing.setItem === 'function') return

  const backing = new Map<string, string>()
  const mem: Storage = {
    get length() {
      return backing.size
    },
    clear: () => backing.clear(),
    getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key: string) => void backing.delete(key),
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true })
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true, writable: true })

  // Fail-loud self-check (ADR-0003 "no silent fallbacks"): if the install
  // above did not actually produce a callable setItem, throw a named error
  // now instead of limping into the same silent storage.setItem-is-not-a-
  // function class this module exists to prevent.
  const installed = (globalThis as { localStorage?: Storage }).localStorage
  if (!installed || typeof installed.setItem !== 'function') {
    throw new Error(
      'src/tests/setup/localStoragePolyfill.ts: installed localStorage.setItem is still not callable -- ' +
        'the jsdom broken-localStorage boundary guard failed to install (INT-17A-R7).'
    )
  }
}

installMemoryLocalStorage()
