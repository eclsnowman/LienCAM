// WO UI-78 -- THE EXECUTION-BASED REGRESSION HARNESS (preflight AM7).
//
// ###########################################################################
// # AM7, VERBATIM: "The R4/R5 fixtures ... are currently consumed ONLY as    #
// # file paths fed to the static text-based lintAuthoringSpace() walker;     #
// # none of their exported functions/components are ever invoked or          #
// # rendered ... A NEW harness file must import each fixture's exported       #
// # construct-building function/component directly, render or execute it     #
// # against a live jsdom document with the guard installed, and assert the   #
// # GUARD's own refusal signal fired at attach time -- new test              #
// # infrastructure, named as such in the WO's file manifest, not a reuse of  #
// # the existing lint-fixture wiring."                                        #
// ###########################################################################
//
// So this file IMPORTS the historical bypass fixtures and RENDERS/EXECUTES their
// exports. A bypass that only re-passes the OLD lint/census gate does not count
// (WO "Regression bed"); every entry here attaches its exact construct into a
// live document with the attach-guard installed, and the test asserts the
// GUARD's refusal fired AT ATTACH. The static lint walker is never invoked.
//
// The seven historical bypasses of the UI-70 saga (WO "Regression bed"):
//   1. CSS-scan escape (R1)   -> ReusedClassBypassViewport      (render)
//   2. styled wrapper (R1/R2) -> StyledWrapperBypassViewport    (render)
//   3. body portal (R2)       -> PortalBypassViewport           (render)
//   4. shadow DOM (R2/R3)     -> ShadowHudBypassViewport        (render)
//   5. same-origin iframe (R3)-> iframeHud.fixture: IframeHud   (execute)
//   6. dynamic iframe (R4)    -> AliasedIframeHud                (render)
//   7. document.write (R5B)   -> writeDocumentHud                (execute)
// Each carries the fixture provenance it came from, so the bed cannot silently
// drop a bypass and still look complete.

import { render } from '@testing-library/react'
import { createElement } from 'react'
import { drainGuard, getGuardRefusals, type GuardRefusal } from './overlayAttachGuard'

// R2/R3 census bypass fixtures (styled wrapper, reused class, body portal, shadow)
import {
  ReusedClassBypassViewport,
  StyledWrapperBypassViewport,
  PortalBypassViewport,
  ShadowHudBypassViewport,
} from '../fixtures/overlayRuntimeBypass.fixture'
// R3 same-origin iframe fixture (imperative)
import { IframeHud } from '../fixtures/authoringLint/iframeHud.fixture'
// R4 dynamically-named iframe fixture (JSX component with a useEffect)
import { AliasedIframeHud } from '../fixtures/authoringLint/dynamicIndirection.fixture'

export interface BypassSpec {
  id: string
  historical: string
  /** 'render' drives a JSX component through testing-library; 'execute' calls
   *  an imperative construct directly. Both attach into the live document. */
  kind: 'render' | 'execute'
  run: () => void
}

/** R5B's document.write shape. jsdom does NOT implement iframe `srcdoc` (the
 *  census file and the R5B founding finding both state this), so the "second
 *  Document" half of the srcdoc form is not executable here; the document.write
 *  half IS (jsdom parses document.write in its default mode -- verified). This
 *  writes a position:fixed HUD straight onto the live document, exactly the
 *  construct the R5B census miss was built on, and the guard's patched write
 *  hook + root observer catch the attached surface. */
function writeDocumentHud(): void {
  document.write('<div class="auditor-documentwrite-hud" style="position:fixed;top:0;left:0">document.write HUD</div>')
}

export const SEVEN_BYPASSES: readonly BypassSpec[] = [
  {
    id: 'css-scan-escape',
    historical: 'R1 -- a HUD reusing the dispositioned .sketch-prompt-bar class at a NEW, undispositioned site',
    kind: 'render',
    run: () => { render(createElement(ReusedClassBypassViewport)) },
  },
  {
    id: 'styled-wrapper',
    historical: 'R1/R2 -- a styled.div wrapper whose position arrives through a runtime-injected stylesheet rule',
    kind: 'render',
    run: () => { render(createElement(StyledWrapperBypassViewport)) },
  },
  {
    id: 'body-portal',
    historical: 'R2 -- createPortal(position:absolute HUD, document.body), outside every viewport container',
    kind: 'render',
    run: () => { render(createElement(PortalBypassViewport)) },
  },
  {
    id: 'shadow-dom',
    historical: 'R2/R3 -- a web component painting a position:fixed HUD from OPEN, CLOSED, and NESTED shadow roots',
    kind: 'render',
    run: () => { render(createElement(ShadowHudBypassViewport)) },
  },
  {
    id: 'same-origin-iframe',
    historical: 'R3 -- a same-origin iframe whose contentDocument holds a position:fixed div.auditor-iframe-hud',
    kind: 'execute',
    run: () => { IframeHud() },
  },
  {
    id: 'dynamic-iframe',
    historical: 'R4 -- a dynamically-named iframe (const tag=\'iframe\') with a fixed HUD in its child document',
    kind: 'render',
    run: () => { render(createElement(AliasedIframeHud)) },
  },
  {
    id: 'document-write',
    historical: 'R5B -- document.write of a position:fixed HUD (srcdoc form unavailable in jsdom; write form executed)',
    kind: 'execute',
    run: writeDocumentHud,
  },
]

/** Drive one bypass and return the guard refusals that fired. The caller
 *  installs the guard (with its disposition-backed predicate) and resets the
 *  refusal log first; this drives the construct, drains the observers
 *  synchronously (so the assertion is deterministic and does not race the
 *  MutationObserver microtask), and hands back what the GUARD refused. */
export function attachAndDrain(spec: BypassSpec): readonly GuardRefusal[] {
  spec.run()
  drainGuard()
  return getGuardRefusals()
}
