// @vitest-environment jsdom
//
// WO UI-70-R4 -- THE PAIR, PROVEN AS ONE GATE.
//
// ###########################################################################
// # DECISIONS 2026-07-17 ("UI-70 census re-scope"), item 4, VERBATIM:       #
// #                                                                         #
// #   "UI-70-R4 executes this ruling. Its audit judges the pair (lint +     #
// #    census) as one gate: an overlay is either sanctioned-and-censused    #
// #    or refused at authoring - no third state."                           #
// #                                                                         #
// # This file is where that claim is EARNED rather than asserted, on real   #
// # objects, in one test. It is deliberately separate from both halves: a   #
// # claim about the JOINT behaviour of two gates, living inside one of      #
// # them, is a claim that gets quietly scoped to whatever that half can     #
// # already see.                                                            #
// ###########################################################################
//
// THE THIRD STATE IS NOT HYPOTHETICAL -- IT IS WHAT FAILED R3.
// The R3 audit's BLOCKER was exactly a third-state object: a position:fixed HUD
// authored in a same-origin iframe. It was NOT refused at authoring (there was
// no lint), and it was NOT censused (enumerateFloating returned zero surfaces --
// "PROBE RESULT: MISSED, EXIT CODE: 1"). It existed, it painted over the
// viewport, and no gate had an opinion about it. Five rounds of this WO had that
// hole in some form.
//
// So this file does not argue the hole is closed. It REPRODUCES the R3 auditor's
// probe verbatim -- builds the iframe, authors the fixed HUD in the child
// document, and watches the census MISS it exactly as the audit recorded -- and
// then shows the lint refusing the route that authors it. The miss is committed
// as a fact of this file, not hidden: the census's blind spot is real and the
// ruling's answer is not to keep chasing it.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import path from 'node:path'
import {
  injectAppStylesheet,
  measureCanary,
  enumerateFloating,
  CANARY_EXPECTATIONS,
} from './support/overlayRuntimeCensus'
import { buildKeyMap, dispositionFor } from './support/overlayKeyMap'
import { FORM_IMPERATIVE_DISPOSITIONS } from './support/overlayDispositions'
import {
  SANCTIONED_AUTHORING as COMMITTED_SANCTIONED_AUTHORING,
  lintAuthoringSpace,
  productSourceFiles,
  refusedViolations,
} from './support/overlayAuthoringLint'

// WO-2622: one shared sanction list; retain the exact migrated-site controls.
const MIGRATED_KEYS = [
  'components/model3d/referenceImage/ReferenceImageCalibration.tsx:ReferenceImageCalibration > createPortal(<> {points.length < 2 && <WorkbenchConfirmBar testId="reference-image-cali...',
  'components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > createPortal(<div aria-label="Reference image corner handles"> {IMAGE_CORNERS.map((corn...',
  'components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > createPortal( <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={onCl...',
  'form/remesh.ts:r > home[i](q)',
  'form/symmetry.ts:symmetrize/pairs.images.forEach(...) > T[t](positions[winner])',
  'lib/sketch/printDrawing.ts:printSketchDocument > document.body.appendChild(frame)',
  "lib/sketch/printDrawing.ts:printSketchDocument > document.createElement('iframe')",
  'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentDocument',
  'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentWindow',
]
const EXTRA_SANCTIONED_AUTHORING = COMMITTED_SANCTIONED_AUTHORING.filter(s => MIGRATED_KEYS.includes(s.key))
const SANCTIONED_AUTHORING = COMMITTED_SANCTIONED_AUTHORING

// The census REFUSES to report without this recorder installed (it is what puts
// an authoring site on every host element), and vi.mock is what hoists it above
// the component imports. Instrumentation, not a mock: the real jsxDEV is called
// and its element returned untouched.
//
// WO-1052 FINDING: not converted to typedMock. wrapJsxDev's signature is
// `<T extends (...args: unknown[]) => unknown>(actual: T) => T` (support/
// overlayRuntimeCensus.ts), so its return here is typed `(...args: unknown[])
// => unknown`, which is not assignable to react/jsx-dev-runtime's real
// `jsxDEV: (...) => ReactElement` (tsc: "Type 'unknown' is not assignable to
// type 'ReactElement'"). Reconciling it needs either a narrowing cast on the
// return value (forbidden by this sweep) or a signature change to wrapJsxDev
// itself, which lives in support/overlayRuntimeCensus.ts - not one of this
// sweep's listed files.
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  const { wrapJsxDev } = await import('./support/overlayRuntimeCensus')
  return { ...actual, jsxDEV: wrapJsxDev(actual.jsxDEV as unknown as (...args: unknown[]) => unknown) }
})

const SRC_ROOT = path.join(process.cwd(), 'src')

/** The site->authoring-key mapping, derived once from the static walk exactly as
 *  the census derives it. The census uses the static tier for ONE thing -- what
 *  a site is CALLED -- and the direction of failure is what makes that safe: a
 *  surface it cannot name still fails BY NAME as unmapped. */
const keyMap = buildKeyMap()
const FIXTURES = path.join(SRC_ROOT, 'tests', 'ui', 'fixtures', 'authoringLint')

/** The whole-tree walk parses 482 product files with the TypeScript compiler and
 *  the FIRST caller pays ~6 s, against vitest's default 5 s per-test budget --
 *  so the state-1/state-2 test below timed out mid-walk and never reached its
 *  verdict. The walk is memoised on (srcRoot, file list); warming it here pays
 *  the cost once, outside any test's budget, and keeps the failure from moving
 *  to whichever test happens to run first. The timeout is on the WARM-UP, not on
 *  a verdict: every assertion in this file is unchanged. */
beforeAll(() => {
  lintAuthoringSpace(productSourceFiles(SRC_ROOT), SRC_ROOT)
}, 120_000)

let removeStylesheet: (() => void) | null = null
beforeEach(() => {
  removeStylesheet = injectAppStylesheet()
})
afterEach(() => {
  cleanup()
  removeStylesheet?.()
  removeStylesheet = null
  vi.clearAllMocks()
})

describe('WO UI-70-R4 / L2: the pair is ONE gate -- sanctioned-and-censused, or refused. No third state.', () => {
  it('THE CANARY: the stylesheet is live, so a "no floating surfaces" reading below would be a real reading', () => {
    // Without this, jsdom reports `static` for every class-styled element, the
    // census enumerates NOTHING, and the iframe MISS proven below would be
    // indistinguishable from a census that sees nothing at all -- which would
    // make this file's whole argument vacuous in the most flattering direction.
    // (amendment A5; WORKER-CHARTER item 1.)
    expect(measureCanary().map((r) => `${r.className}=${r.actual}`)).toEqual(
      CANARY_EXPECTATIONS.map((c) => `${c.className}=${c.expected}`),
    )
  })

  it('THE WHOLE CLAIM, in one test: a sanctioned overlay is CENSUSED, and an unsanctioned one is REFUSED', async () => {
    // -----------------------------------------------------------------------
    // STATE 1 of 2: SANCTIONED-AND-CENSUSED.
    // -----------------------------------------------------------------------
    // A real product component authoring a real out-of-flow surface through the
    // sanctioned route (ordinary React JSX in this document). Pure props, so
    // this is the component itself and not a harness impression of it.
    const { TreeContextMenu } = await import('../../components/panels/TreeContextMenu')
    render(
      <TreeContextMenu
        at={{ x: 10, y: 10 }}
        target={{ kind: 'setup', setupId: 'pair-setup' }}
        onAction={() => {}}
        onClose={() => {}}
      />,
    )

    // (a) The LINT sanctions it: its authoring route is not a refused one.
    const lintOnIt = lintAuthoringSpace([path.join(SRC_ROOT, 'components/panels/TreeContextMenu.tsx')], SRC_ROOT)
    expect(lintOnIt).toEqual([])

    // (b) The CENSUS sees it, names it, and it carries a disposition. All three
    //     matter, and they are three different failures: seeing an element it
    //     cannot name is a bypass; naming one nobody adjudicated is the gap this
    //     WO was cut for. This walks the census's REAL chain -- live element ->
    //     JSX site -> authoring key -> disposition -- rather than asserting on
    //     the display key, because the chain is the thing that has to hold.
    const surfaces = enumerateFloating(document)
    expect(surfaces.map((s) => s.unattributed)).toEqual([null, null])
    const SCRIM = 'components/panels/TreeContextMenu.tsx:TreeContextMenu > div.sketch-context-overlay'
    const MENU = 'components/panels/TreeContextMenu.tsx:TreeContextMenu > div.sketch-context-menu'
    const authoringKeys = surfaces.map((s) => keyMap.bySite.get(s.site)?.authoringKey)
    expect(authoringKeys).toContain(SCRIM)
    expect(authoringKeys).toContain(MENU)
    expect(dispositionFor(SCRIM)).toBeDefined()
    expect(dispositionFor(MENU)).toBeDefined()

    // -----------------------------------------------------------------------
    // STATE 2 of 2: REFUSED AT AUTHORING.
    // -----------------------------------------------------------------------
    // The R3 auditor's probe, rebuilt here move for move: a same-origin iframe
    // whose contentDocument holds a div.auditor-iframe-hud at position:fixed.
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const childDoc = frame.contentDocument!
    const hud = childDoc.createElement('div')
    hud.className = 'auditor-iframe-hud'
    hud.style.position = 'fixed'
    hud.textContent = 'a fixed HUD in a second Document'
    childDoc.body.appendChild(hud)

    // (c) IT REALLY IS AN OVERLAY. Asserted, because the audit asserted it: if
    //     the child window did not compute `fixed`, the miss below would be
    //     jsdom being unable to host the probe rather than the census being
    //     unable to see it, and the two are not the same finding at all.
    expect(frame.contentWindow!.getComputedStyle(hud).position).toBe('fixed')

    // (d) THE CENSUS MISSES IT -- exactly as coordination/reports/
    //     UI-70-R3.audit.json recorded. This is committed as a FACT of the
    //     current design, not as a defect awaiting a sixth patch round. A walk
    //     of THIS document does not enter a child browsing context, and the
    //     ruling's answer is to bound the authoring space instead of chasing
    //     the next Document-minting API.
    const afterIframe = enumerateFloating(document).map((s) => s.key)
    expect(afterIframe.some((k) => k.includes('auditor-iframe-hud'))).toBe(false)
    // ...and the census is not merely blind everywhere: it still sees the
    // sanctioned surfaces in the same reading. A "sees nothing" census would
    // pass line (d) too, which is why this line is here.
    expect(afterIframe.some((k) => k.startsWith(SCRIM))).toBe(true)

    // (e) THE LINT REFUSES THE ROUTE. This is the state-2 half, and it closes
    //     the R3 hole: the object the census cannot see cannot be authored.
    const refused = lintAuthoringSpace([path.join(FIXTURES, 'iframeHud.fixture.tsx')], SRC_ROOT)
    expect(refused.filter((v) => v.route === 'IFRAME').length).toBeGreaterThan(0)

    // -----------------------------------------------------------------------
    // NO THIRD STATE.
    // -----------------------------------------------------------------------
    // Visible overlays must be refused or sanctioned-and-censused. Each exact
    // local sanction below answers that same question; the isolated PRINT
    // document is a named non-overlay exemption, guarded as hidden/zero-size
    // by the production-route test below. New visible iframe HUD sites remain
    // refused, including the adversarial fixture checked above.
    const productRefusals = refusedViolations(productSourceFiles(SRC_ROOT), SRC_ROOT)
    expect(productRefusals).toEqual([])
  })

  it('WO-2470 local sanctions each name exactly one live route and explain its census disposition', () => {
    const found = lintAuthoringSpace(productSourceFiles(SRC_ROOT), SRC_ROOT)
    expect(EXTRA_SANCTIONED_AUTHORING).toHaveLength(MIGRATED_KEYS.length)
    expect(new Set(EXTRA_SANCTIONED_AUTHORING.map((s) => s.key)).size).toBe(EXTRA_SANCTIONED_AUTHORING.length)
    for (const s of EXTRA_SANCTIONED_AUTHORING) {
      expect(found.filter((v) => v.key === s.key && v.route === s.route), s.key).toHaveLength(1)
      expect(s.reason.length, s.key).toBeGreaterThan(40)
      expect(s.censusStatus.length, s.key).toBeGreaterThan(40)
    }
  })

  it('the production print route keeps its iframe hidden and zero-size until afterprint cleanup', async () => {
    const { printSketchDocument } = await import('../../lib/sketch/printDrawing')
    const frame = printSketchDocument('<html><body>Print control</body></html>')
    try {
      expect(frame.parentElement).toBe(document.body)
      expect(frame.getAttribute('aria-hidden')).toBe('true')
      const style = getComputedStyle(frame)
      expect(style.position).toBe('fixed')
      expect(style.visibility).toBe('hidden')
      expect(style.width).toBe('0px')
      expect(style.height).toBe('0px')
      const win = frame.contentWindow!
      vi.spyOn(win, 'focus').mockImplementation(() => {})
      const print = vi.spyOn(win, 'print').mockImplementation(() => {})
      const loaded = frame.onload as () => Promise<void>
      await loaded()
      expect(print).toHaveBeenCalledOnce()
      expect(frame.isConnected).toBe(true)
      win.dispatchEvent(new Event('afterprint'))
      expect(frame.isConnected).toBe(false)
    } finally {
      frame.onload = null
      frame.remove()
      vi.restoreAllMocks()
    }
  })

  it('censuses the production Form box drag and names its imperative disposition', async () => {
    const THREE = await import('three')
    const { FormInteraction } = await import('../../components/model3d/form/formInteraction')
    const { FormOverlay } = await import('../../form/formOverlay')
    const { useFormStore } = await import('../../form/formStore')
    const { cylinderCage } = await import('../../form/starters')
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300,
      right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) })
    document.body.appendChild(canvas)
    const camera = new THREE.PerspectiveCamera(50, 400 / 300, 0.1, 1000)
    camera.position.set(0, 0, -40)
    camera.lookAt(0, 0, 10)
    camera.updateMatrixWorld(true)
    useFormStore.getState().openSession({ featureId: null, name: 'Census', cage: cylinderCage() })
    useFormStore.getState().setSymmetry(null)
    const host = { canvas, camera: () => camera, addObject: () => {}, removeObject: () => {},
      requestRender: () => {}, setOrbitEnabled: () => {} }
    const overlay = new FormOverlay(host)
    const state = useFormStore.getState()
    overlay.update({ cage: state.cage, topologyVersion: state.topologyVersion, displayMode: 'both', dragging: false })
    // Stub only the WebGL gizmo; pointer handling, shape authoring and census are real.
    const interaction = new FormInteraction(host, overlay, () => ({
      object: undefined, enabled: true, addEventListener: () => {}, removeEventListener: () => {},
      attach: () => {}, detach: () => {}, setMode: () => {}, setSpace: () => {},
      getHelper: () => new THREE.Object3D(), dispose: () => {},
    }))
    const move = (type: string, x: number, y: number) => canvas.dispatchEvent(new MouseEvent(type,
      { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }))
    try {
      expect(overlay.pickAt(1, 1)).toBeNull()
      const before = new Set(enumerateFloating(document).map(s => s.key))
      move('pointerdown', 1, 1)
      move('pointermove', 40, 35)
      const box = document.querySelector('[data-testid="form-box-select"]')!
      expect(box).not.toBeNull()
      const surfaces = enumerateFloating(document)
      const found = surfaces.filter(s => !before.has(s.key))
      expect(found).toHaveLength(1)
      expect(getComputedStyle(box).position).toBe('fixed')
      expect(getComputedStyle(box).width).toBe('39px')
      expect(found[0].unattributed).toContain('no React fiber')
      expect(FORM_IMPERATIVE_DISPOSITIONS['components/model3d/form/formInteraction.ts:form-box-select']?.verdict).toBe('COHESIVE')
      const key = 'components/model3d/form/formInteraction.ts:dragBoxTo > document.body.appendChild(shape)'
      expect(SANCTIONED_AUTHORING.filter(s => s.key === key && s.authorsOutOfFlow)).toHaveLength(1)
      move('pointerup', 40, 35)
      expect(box.isConnected).toBe(false)
      expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    } finally {
      interaction.dispose()
      overlay.dispose()
      canvas.remove()
    }
  })

  it('the seam between the halves is CLOSED: every sanctioned exception answers the census question', () => {
    // The one place a third state could still hide is the sanctioned list --
    // a grant is, by construction, a route the lint waves through, so if one of
    // them authored a surface the census also did not answer for, that surface
    // would be in neither gate. Each sanction therefore carries an explicit
    // censusStatus, and the ones that DO author out-of-flow DOM are named here
    // rather than left for an auditor to find.
    //
    // R5B: this list was written at R4 against a sanctioned list that had only
    // the two BODY-PORTAL grants in it. R5's inversion added the UNRESOLVED
    // bucket -- sites refused because their RECEIVER is unprovable, not because
    // of anything they do -- and four of those really do author out of flow. The
    // list grew 2 -> 6 because the LIST grew, not because the seam opened: each
    // of the four is ordinary in-tree DOM in this document, so the census either
    // enumerates it (state 1) or names it unmapped. An unprovable RECEIVER is
    // not an invisible SURFACE, and that distinction is the whole seam. This
    // stays a frozen list rather than a property check for the reason it always
    // was: a NEW floating sanction must be read by a human before it is allowed
    // to appear here.
    for (const s of SANCTIONED_AUTHORING) {
      expect(s.censusStatus.length).toBeGreaterThan(40)
    }
    const floaters = SANCTIONED_AUTHORING.filter((s) => s.authorsOutOfFlow)
    expect(floaters.map((s) => s.key).sort()).toEqual([
      'components/model3d/form/formInteraction.ts:dragBoxTo > document.body.appendChild(shape)',
      // IN the census domain, and a real GRANT: Operator's ruling of 2026-08-20
      // (WO-404, COHESION-STANDARD section 15 item 1) - the pendant pairing
      // flyout "pops right, user interacts, it pops back" and may paint over the
      // program preview while open. Portalled to document.body so the Machine
      // panel cannot clip it; position:fixed, so A4's membership rule names it
      // (div.pendant-popover, COHESIVE in SURFACE_DISPOSITIONS). Read by a human:
      // this entry exists because the architect re-homed it without asking and
      // was overruled.
      'components/machine/PendantPanel.tsx:PendantPanel > createPortal( <div id=\"pendant-pairing-popover\" ref={popoverRef} className=\"pendant-pop...',
      // IN the guarded whole-document domain: a running macro's question owns
      // one body-mounted React root, whose only visible child is the shared
      // fixed modal backdrop. The host is not itself another visible surface.
      'components/machine/MacroAskDialog.tsx:mountMacroAskDialog > document.body.appendChild(host)',
      // UNRESOLVED-RECEIVER, not a grant: `root` is the function's own
      // parameter, so no reading of the file can prove it is not document.body.
      // Outside the census domain because no recipe mounts the cam3d dev page;
      // if one ever did, its position:fixed DOM is in-tree in this document and
      // the census names it as unmapped rather than missing it.
      'cam3d/dev/devPage.ts:mountCam3dDevPage > root.appendChild(page)',
      // IN the census domain: the sketcher's position:absolute rubber-band
      // marquee is ordinary in-tree DOM. Refused only because the receiver is a
      // field read through `this`; if a recipe mounts the sketcher the census
      // enumerates it and fails BY NAME until it is dispositioned.
      'lib/sketch/sketcher/sketchInteraction.ts:updateMarquee > this.host.container.appendChild(this.marqueeDiv)',
      // IN the census domain: a REAL in-viewport floating surface authored
      // through the STANDARD route -- imperative position:absolute DOM in the
      // viewport's own container. Precisely what the census is for, which is why
      // it is sanctioned here and censused there rather than refused outright.
      'lib/viewport/CNCViewport.ts:_buildProjectPlanePicker > this.container.appendChild(overlay)',
      // IN the census domain: same route, same container, same reason -- the
      // Z-scrub overlay. Enumerated by positioning, mapped to its authoring
      // site, and failing BY NAME if it ever carries no disposition.
      'lib/viewport/CNCViewport.ts:_enterZScrubMode > this.container.appendChild(overlay)',
      // WO-2303 e355945b3: shared, dispositioned overlays inside the viewport host.
      'components/model3d/referenceImage/ReferenceImageCalibration.tsx:ReferenceImageCalibration > createPortal(<> {points.length < 2 && <WorkbenchConfirmBar testId="reference-image-cali...',
      // WO-2331 3693668eb: fixed image handles, explicitly classified by the static census.
      'components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > createPortal(<div aria-label="Reference image corner handles"> {IMAGE_CORNERS.map((corn...',
      // WO-2318 e1a181ed2: the existing MODAL-GOVERNED sketch import/export shell.
      'components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > createPortal( <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={onCl...',
      // WO-2301 6ce7ed850: hidden zero-size print document, outside the visible overlay domain.
      'lib/sketch/printDrawing.ts:printSketchDocument > document.body.appendChild(frame)',
      "lib/sketch/printDrawing.ts:printSketchDocument > document.createElement('iframe')",
    ].sort())
  })
})
