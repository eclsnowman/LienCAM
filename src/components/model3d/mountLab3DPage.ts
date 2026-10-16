// 3D Lab (WO UI-2): mounts the standalone Lab3DView INSTEAD of the app, gated
// by the ?lab3d=1 query param (see src/main.tsx). Lazy-imported from
// main.tsx so the normal app bundle is untouched when the flag is absent.
//
// WO INT-4A: a second flag, `?lab3d=1&workbench=1`, mounts SolidsWorkbenchPage
// (sketch -> extrude/revolve -> boolean -> STEP export) instead of the plain
// Lab3DView -- checked here rather than in main.tsx (outside this WO's
// ownership manifest) so both routes hang off the SAME already-shipped,
// already-bundled `?lab3d=1` entry point main.tsx wires today. This is what
// makes the workbench "reachable in the real app, not a dev-server-only demo
// URL" per the WO's mission statement: no file outside src/components/model3d/**
// needs to change for it to be reachable.

import { textFor } from '../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Lab3DView } from './Lab3DView'
import { SolidsWorkbenchPage } from './SolidsWorkbenchPage'
import { parseDebugSceneExport, DebugSceneFormatError } from './debugScene'

declare global {
  interface Window {
    /** WO UI-24: the debug-export REPLAY entry point. A probe (or a dev pasting a file's contents
     *  into devtools) sets this to a parsed-or-raw-JSON debug scene BEFORE navigation (Playwright's
     *  `page.addInitScript`, same technique tools/probes/ui-21-shadow-repro.mjs already uses to hand
     *  the app test-only globals with zero src/** production-path changes) -- checked here, once, at
     *  boot, alongside the existing `?workbench=1` gate. Never read after mount. */
    __DEBUG_SCENE_IMPORT__?: unknown
  }
}

/** WO UI-24: resolves the boot-time debug-scene REPLAY source, if any -- `window.__DEBUG_SCENE_IMPORT__`
 *  (primary; the probe's own seam, see the global's own doc comment) or `?debugScene=<url>` (the
 *  WO's own suggested human-facing form, fetched relative to the current origin). Undefined if
 *  neither is present -- the ordinary boot path. Throws DebugSceneFormatError (named field) if
 *  either source is present but fails validation; the caller decides how to surface that.
 *
 *  WO UI-24-R1 (audit finding 4, minor/hygiene): both sources are gated behind
 *  `import.meta.env.DEV` -- `?debugScene=<url>` makes the browser fetch an ARBITRARY caller-
 *  supplied URL before the workbench even mounts, and `__DEBUG_SCENE_IMPORT__` is a global any
 *  page script can set, so leaving either reachable in a production build is a live surface a
 *  crafted link (or a compromised third-party script) can drive with zero user action. Every real
 *  probe (tools/probes/ui-24/*.mjs) and every test in this suite runs against `vite dev`/vitest,
 *  where `import.meta.env.DEV` is always true, so this gate does not touch them; a PRODUCTION
 *  build gets the export button only -- there is no import path in a shipped build at all. */
// Exported (not otherwise needed outside this module) so WO UI-24-R1's own DEV-gate test can assert
// directly on the resolved value/thrown error, instead of reverse-engineering it through mountLab3DPage's
// DOM-level error element -- see mountLab3DPage.debugSceneDevGate.test.ts.
export async function resolveInitialDebugScene(): Promise<ReturnType<typeof parseDebugSceneExport> | undefined> {
  if (!import.meta.env.DEV) return undefined
  if (window.__DEBUG_SCENE_IMPORT__ !== undefined) {
    const raw = window.__DEBUG_SCENE_IMPORT__
    return parseDebugSceneExport(typeof raw === 'string' ? JSON.parse(raw) : raw)
  }
  const url = new URLSearchParams(window.location.search).get('debugScene')
  if (url === null) return undefined
  const res = await fetch(url)
  if (!res.ok) throw new DebugSceneFormatError('root', workbenchText('mountLab3DPage.debugsceneFetchFailedHTTP', { url: String(url), status: String(res.status) }))
  return parseDebugSceneExport(await res.json())
}

/** Mount the 3D Lab (or, with `?workbench=1`, the M4 solids workbench) into
 *  `root`. Signals the app-shell splash immediately (mirrors
 *  src/cam3d/dev/devPage.ts's identical convention): the splash in index.html
 *  waits for window.LienSplash.ready() before it will dismiss, and Lab3DView
 *  never calls it itself until its own kernel init lands, so without this
 *  call the splash would sit on top of the Lab for its full ~8s timed fill.
 *  SolidsWorkbenchPage calls window.LienSplash.ready() itself once its own
 *  kernel init settles, matching that same contract. */
export async function mountLab3DPage(root: HTMLElement): Promise<void> {
  const workbenchMode = new URLSearchParams(window.location.search).get('workbench') === '1'
  if (workbenchMode) {
    // WO UI-24: a corrupted/newer-schema debug scene REFUSES BY NAME here -- rendered as a plain
    // error element, never a half-booted blank workbench that quietly hides the real cause.
    try {
      const initialDebugScene = await resolveInitialDebugScene()
      createRoot(root).render(createElement(SolidsWorkbenchPage, { initialDebugScene }))
    } catch (err) {
      window.LienSplash?.ready()
      const message = err instanceof Error ? err.message : String(err)
      const field = err instanceof DebugSceneFormatError ? err.field : 'unknown'
      const el = document.createElement('div')
      el.setAttribute('data-testid', 'debug-scene-load-error')
      el.setAttribute('data-field', field)
      el.style.cssText = 'padding:24px;font:13px monospace;color:#f0a0a0;white-space:pre-wrap;'
      el.textContent = workbenchText('mountLab3DPage.debugSceneRefused', { field: String(field), message: String(message) })
      root.appendChild(el)
    }
    return
  }
  window.LienSplash?.ready()
  createRoot(root).render(createElement(Lab3DView))
}
