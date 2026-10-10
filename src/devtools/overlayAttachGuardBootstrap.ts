// WO UI-78 -- the dev-only bootstrap for the DOM attach-guard (preflight AM6).
//
// THIS FILE IS THE AC6 STRIP TARGET. main.tsx reaches it through ONE gate --
// `if (import.meta.env.DEV)` -- mirroring mountLab3DPage.ts's `if
// (!import.meta.env.DEV) return` and the cam3d dev-page precedent. In a
// production `vite build`, `import.meta.env.DEV` is the literal `false`, so
// Rollup's dead-code elimination drops the gated dynamic import and the entire
// guard chain (this file -> overlayAttachGuard.ts -> overlayFloating.ts) never
// enters the production bundle. A dev build (`vite build --mode development`,
// or `vite dev`) carries it. That difference is AC6, and it is proven by
// inspecting the two bundles, not a runtime flag.
//
// It lives under src/devtools (product-scanned by the authoring lint) rather
// than with the guard under src/tests/ui/support, and deliberately uses NONE of
// the DOM-authoring primitives the lint refuses -- it reads an attribute and
// installs the guard, nothing more -- so it passes the product lint while the
// guard's instrumentation stays in the excluded instrumentation directory.
//
// SANCTION REGIMES IN A REAL DEV SESSION (AM5, stated honestly). The guard's
// verdict-bearing proof is the vitest gate (src/tests/ui/overlayAttachGuard.
// test.tsx), where REGIME 1 cross-checks a JSX node's data-ui70-site against the
// census disposition set. A real `vite dev` session has neither the census
// disposition table nor a wrapped jsxDEV unless a dev-only Vite plugin aliases
// `react/jsx-dev-runtime` to overlayRuntimeCensus.wrapJsxDev (the AM5 real-dev
// mechanism). Until that plugin is installed this bootstrap runs the guard in
// REPORT-ONLY mode: it never throws, it logs each refusal to the console as an
// early warning, and REGIME 1 is inert (no data-ui70-site is present to match),
// so the reliable signal in a real session is the non-JSX bypass class
// (imperative DOM, iframe child documents, shadow roots, document.write) plus
// any surface an owner explicitly marks with the REGIME-2 ownership marker.

const BOOTSTRAP_SENTINEL = 'UI78_OVERLAY_ATTACH_GUARD_BOOTSTRAP'

/** Install the attach-guard for a real dev session. Called ONLY from main.tsx's
 *  `import.meta.env.DEV` branch. Returns void; failures are swallowed (a dev
 *  diagnostic must never break the app boot). */
export async function installDevOverlayAttachGuard(): Promise<void> {
  // Extra runtime belt-and-braces on top of the compile-time gate: even if this
  // function were ever reached in a non-dev context, it no-ops.
  if (!import.meta.env.DEV) return
  try {
    const guard = await import('../tests/ui/support/overlayAttachGuard')
    guard.installOverlayAttachGuard(document, {
      // REGIME 1 is inert here (see the file header): no wrapped jsxDEV in a
      // plain dev session, so no node carries data-ui70-site to match. The
      // reliable signal is the ownership marker (regime 2) + the non-JSX bypass
      // class, which need no predicate.
      isSanctionedJsx: undefined,
      // REPORT-ONLY: log, never throw. `${BOOTSTRAP_SENTINEL}` tags the message
      // so it is greppable in a dev console and is the unique bundle sentinel
      // AC6's inspection keys on.
      onRefusal: (r) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[${BOOTSTRAP_SENTINEL}] unsanctioned floating surface attached: `
          + `<${r.tag}${r.classes.map((c) => `.${c}`).join('')}> position:${r.position} via ${r.channel} @ ${r.domPath}`,
        )
      },
    })
    // eslint-disable-next-line no-console
    console.info(`[${BOOTSTRAP_SENTINEL}] installed (dev-only overlay attach-guard, report-only).`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[${BOOTSTRAP_SENTINEL}] failed to install:`, err)
  }
}
