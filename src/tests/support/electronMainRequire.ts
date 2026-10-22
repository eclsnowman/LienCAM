// WO-3056: the one require the tests hand electron/main.cjs when they run it in a vm.
//
// main.cjs loads its own siblings by relative path (./agentChannel.cjs since WO-2995,
// ./mcp/server.cjs since WO-3010). A require made from a TEST file resolves those
// against src/tests/... and fails with "Cannot find module". This one resolves them
// against electron/, exactly as Electron does for the real file. Node built-ins and
// packages resolve the same either way.
//
// Rooted at the checkout the tests run from (vitest's cwd), the same root every one of
// these tests already reads electron/main.cjs from. Not import.meta.url: in a jsdom test
// module that is not always a file: URL.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

/** Absolute path of electron/main.cjs in this checkout. */
export const ELECTRON_MAIN_PATH = resolve('electron/main.cjs')

/** A require for main.cjs's own `require` calls, rooted at electron/main.cjs. */
export const electronMainRequire = createRequire(ELECTRON_MAIN_PATH)
