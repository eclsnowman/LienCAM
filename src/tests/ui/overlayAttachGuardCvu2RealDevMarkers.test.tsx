// @vitest-environment jsdom
//
// CVU-2 (CRASH-VERIFY-UAT 2026-07-26, coordination/reports/CRASH-VERIFY-UAT.
// report.md): the dev-only overlay attach-guard (src/devtools/
// overlayAttachGuardBootstrap.ts -> src/tests/ui/support/overlayAttachGuard.ts)
// flooded a real Feature Tour session with ~44 "unsanctioned floating surface"
// warnings for legitimate, already-shipped chrome -- themed tooltips, the view
// cube, the sim panel, the modal backdrop, tree/section headers, viewport
// overlays, the toolpath legend, etc.
//
// ROOT CAUSE (see overlayAttachGuardBootstrap.ts's own header comment): the
// guard has TWO sanction regimes. REGIME 1 cross-checks a JSX node's
// data-ui70-site against the UI-70 census disposition table, but that requires
// a dev-only Vite plugin (aliasing react/jsx-dev-runtime to the census's
// wrapJsxDev) that is not installed -- so the REAL browser bootstrap always
// passes `isSanctionedJsx: undefined`, and REGIME 1 is INERT there. REGIME 2
// (the `data-ui78-sanctioned` ownership marker) is the only regime that works
// in a real dev session, and until this fix it had never actually been applied
// to any shipped component -- every one of these already-census-dispositioned
// (COHESIVE/MODAL-GOVERNED/PANEL-INTERNAL) surfaces was still refused live.
//
// THE FIX (a source-level allowlist extension, not a log filter): the shipped
// components carrying these classes now set the REGIME 2 marker on their own
// rendered root. This test proves it the way CVU-2 requires: mount the guard
// in the EXACT config the real bootstrap uses (isSanctionedJsx: undefined --
// REGIME 1 inert, same as a live dev session) and show that (a) the fixed
// surfaces this fix touched are no longer refused, while (b) a genuinely
// unsanctioned floating surface is STILL refused -- the guard is not disabled,
// just correctly informed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import {
  installOverlayAttachGuard,
  uninstallOverlayAttachGuard,
  drainGuard,
  getGuardRefusals,
  resetGuardRefusals,
  guardIsInstalled,
} from './support/overlayAttachGuard'
import { injectAppStylesheet } from './support/overlayRuntimeCensus'
import { ThemedTooltip } from '../../components/ui/ThemedTooltip'
import { DisclosureSection } from '../../components/ui/DisclosureSection'

let removeStylesheet: (() => void) | null = null

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.replaceChildren()
  removeStylesheet = injectAppStylesheet()
  resetGuardRefusals()
  // THE REAL-DEV CONFIG (overlayAttachGuardBootstrap.ts installDevOverlayAttachGuard):
  // isSanctionedJsx is undefined -- REGIME 1 is inert, exactly like a live
  // `vite dev` session with no jsx-dev-runtime aliasing plugin installed.
  installOverlayAttachGuard(document, { isSanctionedJsx: undefined })
})

afterEach(() => {
  if (guardIsInstalled()) uninstallOverlayAttachGuard()
  cleanup()
  removeStylesheet?.()
  removeStylesheet = null
  document.body.replaceChildren()
  document.head.querySelectorAll('style').forEach((s) => s.remove())
})

// Flush the guard's queued MutationObserver microtask (scheduled via
// queueMicrotask, see overlayAttachGuard.ts's scheduleReclassify), then drain
// synchronously. Deliberately NOT wrapped around the mount/interaction step
// itself -- render()/fireEvent already self-flush via their own act() calls,
// and nesting them inside an outer async act() defers React's commit until
// the OUTER act resolves, which left the DOM empty when the mount and the
// flush were combined in one callback.
async function flushGuard() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  drainGuard()
  return getGuardRefusals()
}

describe('CVU-2: REGIME-2-marked shipped surfaces pass the real-dev guard config', () => {
  it('ThemedTooltip.themed-tooltip is NOT refused once shown', async () => {
    vi.useFakeTimers()
    render(
      <div>
        <button data-tooltip="Click to change color" data-testid="btn-a">A</button>
        <ThemedTooltip />
      </div>,
    )
    fireEvent.pointerOver(screen.getByTestId('btn-a'))
    // ThemedTooltip's ~500ms hover delay (SHOW_DELAY_MS) before it renders.
    act(() => { vi.advanceTimersByTime(500) })
    expect(document.querySelector('.themed-tooltip')).not.toBeNull() // sanity: it's actually mounted
    // flushGuard's own microtask-settle uses a REAL setTimeout(0) -- switch back
    // to real timers first so that wait actually elapses.
    vi.useRealTimers()
    const refusals = await flushGuard()
    expect(refusals.some((r) => r.classes.includes('themed-tooltip'))).toBe(false)
  })

  it('DisclosureSection.disclosure-header is NOT refused (mounted with props-disclosure, the sticky context the real warning came from)', async () => {
    render(
      <DisclosureSection title="Stock" testId="disc-test" className="props-disclosure">
        <div>body</div>
      </DisclosureSection>,
    )
    const refusals = await flushGuard()
    expect(refusals.some((r) => r.classes.includes('disclosure-header'))).toBe(false)
  })

  it('WorkbenchDisplayMode.display-mode-control is NOT refused (Model-tab mount chrome)', async () => {
    const { WorkbenchDisplayMode } = await import('../../components/model3d/workbench/WorkbenchDisplayMode')
    render(
      <WorkbenchDisplayMode
        mode="shaded-edges"
        onModeChange={() => {}}
      />,
    )
    const refusals = await flushGuard()
    expect(refusals.some((r) => r.classes.includes('display-mode-control'))).toBe(false)
  })

  it('workbench sticky tree-section-header with REGIME-2 marker is NOT refused', async () => {
    // SolidsWorkbenchPage stamps data-ui78-sanctioned on its sticky section
    // headers (same class as the CAM DesignTree ones that already passed).
    // Mount a structural twin under the real-dev config so a missing marker
    // on the workbench path re-creates the mode-switch over-warn.
    render(
      <div className="panel-body">
        <div
          className="tree-section-header tree-section-header-btn"
          data-ui78-sanctioned=""
          data-testid="wb-header-twin"
        >
          Model
        </div>
      </div>,
    )
    // sticky is stylesheet-driven in app.css; force OUT_OF_FLOW for this
    // isolated mount so classification matches the live refuse path.
    const el = screen.getByTestId('wb-header-twin') as HTMLElement
    el.style.position = 'sticky'
    const refusals = await flushGuard()
    expect(refusals.some((r) => r.classes.includes('tree-section-header'))).toBe(false)
  })

  it('floating mode-tabs fallback host with REGIME-2 marker is NOT refused', async () => {
    render(
      <div
        className="viewport-toolbar app-mode-tabs-floating"
        data-testid="floating-mode-tabs-fallback"
        data-ui78-sanctioned=""
        style={{ position: 'absolute', top: 0, left: 0 }}
      />,
    )
    const refusals = await flushGuard()
    expect(refusals.some((r) => r.classes.includes('app-mode-tabs-floating'))).toBe(false)
  })

  it('CONTROL: a genuinely unsanctioned fixed HUD is STILL refused under the same config', async () => {
    // Proves the guard is not disabled and REGIME 2 is not a blanket pass --
    // only nodes actually carrying the marker (or an ancestor that does) are
    // sanctioned. A rogue fixed HUD with no marker anywhere in its ancestry
    // must still be caught.
    const hud = document.createElement('div')
    hud.className = 'cvu2-control-unsanctioned-hud'
    hud.style.position = 'fixed'
    hud.style.top = '0'
    hud.style.left = '0'
    document.body.appendChild(hud)
    const refusals = await flushGuard()
    expect(refusals.some((r) => r.classes.includes('cvu2-control-unsanctioned-hud'))).toBe(true)
  })
})
