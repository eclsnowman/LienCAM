// @vitest-environment node
//
// WO UI-70 / UI-70-R1 / UI-70-R2 -- the in-viewport overlay design-cohesion
// census, STATIC tier.
//
// ###########################################################################
// # ADVISORY. THIS FILE'S VERDICT IS NOT THE CENSUS'S VERDICT.              #
// #                                                                         #
// # WO UI-70-R2 required shape item 2, verbatim: "The AST walk MAY remain   #
// # as an advisory secondary check (comment it as advisory); its verdict    #
// # never substitutes for 1." Item 1 is the RUNTIME census --               #
// # src/tests/ui/overlayRuntimeCensus.test.tsx -- which mounts the real     #
// # components and enumerates the real DOM. THAT is the verdict-bearing     #
// # gate. This file is kept for what a static walk is genuinely good at and #
// # a runtime mount is not: DISCOVERY. It sees every authoring site in the  #
// # source, including the ones no committed mount recipe renders, and it    #
// # supplies the runtime census's authoring-site names (the site->key       #
// # mapping of amendment A3). It never decides membership.                  #
// #                                                                         #
// # WHY it was demoted: it was bypassed TWICE. Round 0 keyed on CSS text;   #
// # the auditor reused a dispositioned class from a new site. Round 1 keyed #
// # on this AST walk; the auditor declared a local styled-wrapper component #
// # whose variable declaration holds no intrinsic JSX for walkBody to       #
// # classify, so it produced neither a Surface nor an unresolved hole, and  #
// # the census stayed 31/31 green while a real positioned HUD rendered over #
// # the viewport. Both bypasses have ONE root cause: a static scan must     #
// # MODEL how the code paints, and every model has a route it does not      #
// # model. The runtime census does not model -- it looks.                   #
// #                                                                         #
// # The R1 auditor's styled-wrapper bypass is committed against the runtime #
// # census as src/tests/ui/fixtures/overlayRuntimeBypass.fixture.tsx. This  #
// # file is STILL BYPASSABLE BY IT BY DESIGN, and asserts that it is, so    #
// # nobody mistakes this tier for a gate again.                             #
// ###########################################################################
//
// Born from Operator's T-UI58 MODIFY verdict ("this overlay does not look good.
// Make it consistent with our software design look and feel."). The failure
// class it closes is the one he found: UI-58's overlay shipped through a
// UI-lane merge painting `background: var(--surface-panel)` -- a token defined
// NOWHERE. CSS resolves an undefined custom property with no fallback to the
// property's initial value ("invalid at computed-value time"), so the panel
// silently painted `transparent` and the viewport showed straight through the
// card. Nothing failed: not tsc (CSS strings are opaque to it), not vitest
// (jsdom resolves no custom properties), not the UI-58 flow tests (the
// behaviour was correct throughout). The FLOW was audited; the SURFACE was not.
//
// ---------------------------------------------------------------------------
// R1: WHY THIS FILE WAS REWRITTEN
// ---------------------------------------------------------------------------
// Round 0 derived the domain from CSS TEXT (positioned selectors in app.css)
// and from FILE TEXT (files containing an inline position). The auditor broke
// it in one move, verbatim:
//
//   "A1's closed-domain law is not implemented ... neither derives the
//    floating-surface membership from the CAM/workbench React render trees. The
//    disposition keys are selectors/files, not rendered surface identities, so
//    a new HUD can reuse an existing positioned class and evade the gate
//    entirely."
//
// He proved it by rendering `<div className="sketch-prompt-bar">` next to
// <ViewportOverlay> with no disposition: 18/18 green, EXIT CODE 0. A selector
// key cannot see that, because the selector was already dispositioned.
//
// So the domain is now derived from the RENDER TREE, and a disposition is keyed
// by THE SITE THAT AUTHORS THE DOM:
//
//     components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.tp-legend
//
// Reuse a positioned class from a new site and you author DOM at a site with no
// disposition -- a brand-new key, failing by name. That bypass is committed as
// src/tests/ui/fixtures/overlayBypass.fixture.tsx and asserted below, alongside
// three more routes (inline style, computed className, spread props).
//
// FOUR derivations, all mechanical (re-run: `npx vitest run
// src/tests/ui/overlayCohesionCensus.test.ts`; the artifact and its commands
// live in coordination/evidence/UI-70/OVERLAY-CENSUS.md):
//
//   R. the React render tree from App.tsx        -> every floating surface, by
//      down through lazy/barrel hops                authoring site
//   D. imperative DOM append sites               -> the overlays no React walk
//      (CNCViewport.ts)                             can ever see
//   A. app.css coverage cross-check              -> proves R lost no positioned
//                                                    class on the way
//   C. every var(--token) reference in src/      -> the phantom-token class
//
// WHAT COUNTS AS IN-VIEWPORT is itself derived, not listed: a surface is in the
// domain when it is authored inside a VIEWPORT HOST's element subtree (a
// container with a <canvas> / .viewport-canvas child -- the thing the 3D scene
// paints into), or by any component reachable from one, or when it is
// position:FIXED anywhere at all (a fixed surface paints over the viewport from
// wherever it is authored -- which is how SetupModal's `.vertex-pick-banner`
// and NewOperationModal's `.loop-pick-banner` are real in-viewport overlays
// authored in modal files). An absolutely-positioned toggle knob inside a modal
// form is mechanically OUT, not hand-waved out.
//
// Scope fence (UI-70 Standing law): a member dispositioned RESTYLE-NEEDED is
// BOOKED here, not edited -- "one overlay done excellently beats five done
// loosely". Only .workbench-anchor-entry was touched by this WO.

import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  positionedClasses,
  walkRenderTree,
  imperativeSurfaces,
  stripComments,
  evalClassExpression,
  evalStylePosition,
} from './support/overlayRenderTree'
import {
  SURFACE_DISPOSITIONS as COMMITTED_SURFACE_DISPOSITIONS,
  IMPERATIVE_DISPOSITIONS,
  UNRENDERED_CLASSES as COMMITTED_UNRENDERED_CLASSES,
  GUARDED_PHANTOM_DISPOSITIONS,
} from './support/overlayDispositions'

// WO-2458: six in-viewport surfaces and five positioned jog classes landed after the committed
// tables (support/overlayDispositions.ts, outside this order's grant) were last cut. Their
// rulings are declared here and merged, so every check below sees one combined table. Each was
// adjudicated by reading the authoring site and the app.css rule it uses.
const EXTRA_SURFACE_DISPOSITIONS: typeof COMMITTED_SURFACE_DISPOSITIONS = {
  'components/model3d/dialogs/MoveHoleEntry.tsx:MoveHoleEntry > div.wb-dialog': {
    verdict: 'COHESIVE',
    reason: 'WO-2804 Move Hole, restored by WO-2838: both STEP and STL routes render this same compact nonblocking entry over the Model viewport. Uses the defined --surface-2 raised-panel background like AnchoredValueEntry, --border-subtle and shared modal-btn controls; inline position only places it at the right of the viewport. Escape/Cancel dismiss and Apply uses the existing tool path. No raw colour or new motion.',
  },
  'components/gcode/GcodeLineMenu.tsx:GcodeLineMenu > div.gce-line-menu.sketch-context-menu': {
    verdict: 'COHESIVE',
    reason: 'WO-2651: Control and Post share the existing sketch-context-menu surface: --bg-panel, --border-light, --radius-md and --font-size-sm; gce-line-menu adds only minimum width. Pointer coordinates place the transient menu, with Escape/outside dismissal and focus return. It uses the same context-menu family as the sketch tools.',
  },
  'components/gcode/GcodeLineMenu.tsx:GcodeLineMenu > div.sketch-context-overlay': {
    verdict: 'COHESIVE',
    reason: 'WO-2651: the shared transparent sketch-context-overlay behind the line menu catches outside presses and context clicks. The existing fixed/inset scrim paints no independent chrome and follows the menu family already dispositioned for sketch context menus.',
  },
  'components/modals/ExportModal.tsx:ExportModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'WO-2448 (e56294822) added the Export window: shared fixed modal-backdrop with a modal-container child, data-ui78-sanctioned, role=dialog, aria-modal, useDialogFocus, Escape and outside-click dismissal. It follows the modal standard like its sibling dialogs.',
  },
  'components/machine/ProgramPreview.tsx:IntendedStockReadout > button.control-intended-stock-line': {
    verdict: 'COHESIVE',
    reason: 'WO-2063-era intended-stock summary line, the clickable row of the already-COHESIVE intended-stock card. Its inline style is conditional and carries only white-space (normal/nowrap) - no position, inset, colour or z-index - so the static walk marks it indeterminate; the real look is the .control-intended-stock-line rule (app.css:15098): transparent background, inherited colour and font, accent-blue hover token, no raw hex.',
  },
  'components/machine/ProgramPreview.tsx:IntendedStockReadout > span.control-intended-stock-badge': {
    verdict: 'COHESIVE',
    reason: 'The CURRENT / STALE / NONE badge inside the intended-stock line. Inline style is only the conditional white-space nowrap; the look is .control-intended-stock-badge (app.css:12263): --font-mono, --font-size-xs, --border-strong, --text-secondary, no raw hex, no position.',
  },
  'components/modals/AboutModal.tsx:AboutModal > div.about-backdrop.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The About dialog: the shared fixed .modal-backdrop scrim (app.css:4098) with a modal-container child, data-ui78-sanctioned, role=dialog aria-modal and a focus ref - the same shell as every sibling modal, governed by the modal standard rather than the overlay standard.',
  },
  // WO-2784 RE-PIN: WO-2725 (f9019502e5, merged 9a94ae6559) turned the demo picker into the shared
  // "Open a project" window and added the project-picker-backdrop class to the same backdrop; re-keyed.
  'components/modals/DemoExamplePickerModal.tsx:DemoExamplePickerModal > div.modal-backdrop.project-picker-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The "Open a project" window (WO-2725; formerly the startup demo-example picker): the shared fixed .modal-backdrop scrim with a modal-container child (role=dialog aria-modal, data-ui78-sanctioned, Escape closes). project-picker-backdrop has no rule of its own (ProjectPicker.css styles only the card and its contents); same shell as every sibling modal.',
  },
  // WO-2784 RE-PIN: WO-2759 (2d220dbd0b) added Help > Report a problem -- a genuinely new modal surface.
  'components/modals/ReportProblemModal.tsx:ReportProblemDialog > div.modal-backdrop.report-problem-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'WO-2759 Help > Report a problem: the shared fixed .modal-backdrop scrim with a modal-container child (role=dialog, aria-modal, aria-labelledby, data-ui78-sanctioned, useDialogFocus ref, outside-press closes). report-problem-backdrop adds only z-index 570 (ReportProblemModal.css) so it can sit over Help-as-overlay. Same shell as every sibling modal. (Its body CSS references the undefined --text-warning token; that is reported by the phantom-token check, not adjudicated here.)',
  },
  // WO-2784 RE-PIN: WO-2748 (33879cedf3) added the smart-dimension preview connector -- a new surface.
  'lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx:SketchDimensionOverlay > svg.sketch-dim-preview-connector': {
    verdict: 'COHESIVE',
    reason: 'WO-2748 placement-preview leader: an aria-hidden svg inline position:absolute inset:0 filling the already-COHESIVE .sketch-dim-layer, pointer-events none, no background, border or z-index. It paints one 1px line stroked var(--sketch-dimension) (a defined sketch token) (tokens.css) at 0.75 opacity, display:none until placed. No raw hex.',
  },
  // WO-2784 RE-PIN: WO-2616 (4d60c51a8a, landed 5211ea829b) added the sketch pattern editor -- two new surfaces.
  'lib/sketch/sketcher/overlays/SketchPatternEditor.tsx:SketchPatternEditor > div.sketch-context-overlay': {
    verdict: 'COHESIVE',
    reason: 'WO-2616 Edit pattern: the shared transparent .sketch-context-overlay scrim (app.css, fixed/inset) behind the editor form; a pointer-down closes the editor. It paints no chrome of its own and is the same overlay already dispositioned COHESIVE for SketchContextMenu and GcodeLineMenu.',
  },
  'lib/sketch/sketcher/overlays/SketchPatternEditor.tsx:SketchPatternEditor > form.sketch-context-menu': {
    verdict: 'COHESIVE',
    reason: 'WO-2616 Edit pattern form: reuses the shared .sketch-context-menu surface (--bg-panel, --border-light, --radius-md, --font-size-sm), which COHESION-STANDARD.md section 3 names a sanctioned context-menu model; its Apply/Cancel use the established .sketch-prompt-btn classes (ba1c17b3cb). Inline style only places and sizes it (left 50%, top 30%, maxHeight 60vh, padding 12) -- no colour, border, shadow or z-index literals.',
  },
  'components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > div': {
    verdict: 'STRUCTURAL',
    reason: 'WO-2304 reference-image placement: the createPortal(document.body) wrapper div that only groups the four corner-handle buttons under one aria-label. It has no style, class, background, border or position of its own and paints nothing; the handles are adjudicated separately.',
  },
  'components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > button': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'WO-2304 resize handle, four per image: inline position:fixed 12px square, display:none until placed over each image corner. Drifts from the standard: raw literals (background white, border 2px solid #167bc1, zIndex 35) instead of the --surface / --accent / --z tokens, and an inline position with no class. It is a small drag handle, functional and not covering the model beyond its 12px. BOOKED, not edited (WO-2458 is census-only, no product change).',
  },
}
// WO-2431: the folded Offsets strip positions .panel-action-btn, but only under .control-offsets-view-folded;
// the class-based scanner then also classifies this unrelated eye button as positioned.
EXTRA_SURFACE_DISPOSITIONS['components/machine/ProgramPreview.tsx:IntendedStockReadout > button.control-intended-stock-eye.panel-action-btn'] = {
  verdict: 'COHESIVE',
  reason: 'The eye toggle of the intended-stock card: an ordinary in-flow .panel-action-btn. It is NOT positioned in the app - WO-2431 positions .panel-action-btn only under .control-offsets-view-folded (app.css:10844, the Offsets folded strip), which this button is never inside; the scanner reads the rule by class alone.',
}
// WO-2882: WO-2865 (9eb36100fd) gave the Shell command strip three refusal lines
// (reference, apply, refused preview) that wrap onto their own row.
const SHELL_REFUSAL_LINE = 'WO-2865 Shell refusal line inside the already-dispositioned command strip: an in-flow span. Its inline REFUSAL_LINE_STYLE (ShellDialog.tsx:57) carries only flex layout - order 1, flexBasis 100%, maxWidth none, whiteSpace normal, overflow visible - so the line wraps onto its own row; no position, inset, colour, border or z-index, so the static walk marks it indeterminate. The look is .fillet-command-status + .fillet-command-status--error (app.css:8708/8714): --text-muted/--text-danger and --font-size-xs, the same tokens as the Fillet/Chamfer status lines. No raw hex.'
for (const key of [
  'components/model3d/dialogs/ShellDialog.tsx:ShellDialog > span.fillet-command-status.fillet-command-status--error',
  'components/model3d/dialogs/ShellDialog.tsx:ShellDialog > span.fillet-command-status.fillet-command-status--error#2',
  'components/model3d/dialogs/ShellDialog.tsx:ShellDialog > span.fillet-command-status.fillet-command-status--error#3',
]) EXTRA_SURFACE_DISPOSITIONS[key] = { verdict: 'COHESIVE', reason: SHELL_REFUSAL_LINE }
const SURFACE_DISPOSITIONS = { ...COMMITTED_SURFACE_DISPOSITIONS, ...EXTRA_SURFACE_DISPOSITIONS }
const JOG_PLATE_UNRENDERED = "WO-2063 Probing screen v2 mounts the shared JogPanel in the probing tab; this positioned class is part of the Jog panel's own wedge cluster (JogPanel.tsx), absolute within that cluster in the right column - out of the viewport domain by design, same as control-jog-wedge, so no censused surface claims it."
const UNRENDERED_CLASSES: Record<string, string> = {
  ...COMMITTED_UNRENDERED_CLASSES,
  'control-jog-plate': JOG_PLATE_UNRENDERED,
  'control-jog-seams': JOG_PLATE_UNRENDERED,
  'control-jog-frame': JOG_PLATE_UNRENDERED,
  'control-jog-label': JOG_PLATE_UNRENDERED,
  'control-jog-step-readout': JOG_PLATE_UNRENDERED,
  // WO-2431: the class is on the ResizableSplit root (a layout container, not a floating surface); app.css only positions its folded strip's expand chevron inside the Offsets workspace.
  'control-offsets-view-folded': 'WO-2431 Control > Offsets folded workspace: a class on the split root whose rule positions the fill pane expand chevron inside a 36px strip; layout inside the Control screen, not an in-viewport floating surface.',
}

const SRC = fileURLToPath(new URL('../..', import.meta.url))
const APP_CSS = path.join(SRC, 'styles', 'app.css')

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

const ALL_SRC_FILES = walkFiles(SRC)

/** Source files that PAINT the app. Tests are excluded on purpose: a census
 *  fixture legitimately contains the very defect strings these scans hunt for
 *  (this file quotes `var(--surface-panel)` verbatim as its own mutation
 *  proof), and a test file styles nothing. Caught by this census's first run
 *  flagging its own fixtures. */
const PAINTING_FILES = ALL_SRC_FILES.filter((f) => !f.includes(`${path.sep}tests${path.sep}`))





// ---------------------------------------------------------------------------
// Derivation C: phantom tokens (the UI-70 defect class)
// ---------------------------------------------------------------------------

function tokenRefs(): Map<string, { withFallback: boolean; sites: string[] }> {
  const refs = new Map<string, { withFallback: boolean; sites: string[] }>()
  for (const file of PAINTING_FILES) {
    if (!/\.(css|ts|tsx)$/.test(file)) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*(,)?/g)) {
      const name = m[1]
      const hasFallback = m[2] === ','
      const rel = path.relative(SRC, file).split(path.sep).join('/')
      const prior = refs.get(name)
      if (prior === undefined) refs.set(name, { withFallback: hasFallback, sites: [rel] })
      else {
        // A token is "guarded" only if EVERY reference supplies a fallback --
        // one bare reference is enough to paint an initial value.
        prior.withFallback &&= hasFallback
        if (!prior.sites.includes(rel)) prior.sites.push(rel)
      }
    }
  }
  return refs
}

/** Definitions from any stylesheet in src/ PLUS imperative JS publication
 *  (element.style.setProperty('--x', ...)), which a CSS-only sweep would
 *  mis-report as phantom (SimulationPanel.tsx publishes --sim-panel-h this
 *  way). Both forms are real definitions. */
function inlineStyleTokenDefs(file: string, text: string): Set<string> {
  const defs = new Set<string>()
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const collect = (node: ts.Node) => {
    if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      if (node.expression) collect(node.expression)
    } else if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue)
      collect(node.whenFalse)
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) collect(property.expression)
        else if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)
          && /^--[a-zA-Z0-9-]+$/.test(property.name.text)) defs.add(property.name.text)
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style' && node.initializer) {
      collect(node.initializer)
    } else ts.forEachChild(node, visit)
  }
  visit(source)
  return defs
}

function tokenDefs(): Set<string> {
  const defs = new Set<string>()
  for (const file of PAINTING_FILES) {
    if (!/\.(css|ts|tsx)$/.test(file)) continue
    const text = stripComments(readFileSync(file, 'utf8'))
    if (file.endsWith('.tsx')) for (const name of inlineStyleTokenDefs(file, text)) defs.add(name)
    if (file.endsWith('.css')) for (const m of text.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/gm)) defs.add(m[1])
    for (const m of text.matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9-]+)['"`]/g)) defs.add(m[1])
  }
  return defs
}


// ---------------------------------------------------------------------------

const css = readFileSync(APP_CSS, 'utf8')
const positioned = positionedClasses(css)
const walk = walkRenderTree({ srcRoot: SRC, roots: [{ file: 'App.tsx', name: 'default' }], positioned })
const domain = walk.surfaces.filter((s) => s.inViewport)
const imperative = imperativeSurfaces(
  PAINTING_FILES.filter((f) => f.endsWith('.ts')),
  SRC,
  positioned,
)

describe('WO UI-70: in-viewport overlay design-cohesion census (closed domain, derived from the RENDER TREE)', () => {
  describe('the derivation itself reaches the app it claims to census', () => {
    it('the viewport HOSTS are derived from the render tree, and the two shipped ones are found', () => {
      // The host rule is structural (a container with a canvas / .viewport-canvas
      // child). If a refactor renames the canvas mount, this fails LOUD rather
      // than quietly censusing an empty domain.
      const shipped = walk.hosts.map((h) => `${h.file}:${h.component}`)
      expect(shipped, 'CAM viewport host not derived -- the scanner anchor is stale')
        .toContain('components/viewport/Viewport.tsx:Viewport')
      expect(shipped, 'workbench viewport host not derived -- the scanner anchor is stale')
        .toContain('components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument')
    })

    it('the walk follows lazy() and barrel hops -- the WO-named seeds are all reached', () => {
      // SolidsWorkbenchPage is behind `lazy(() => import(...))` in App.tsx and
      // SketcherOverlays is behind lib/sketch/sketcher/index.ts. Round 0's walk
      // would have stopped at both. Each of these is a WO-named census seed.
      for (const seed of [
        'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPage',
        'components/model3d/workbench/AnchoredValueEntry.tsx:AnchoredValueEntry',
        'components/model3d/workbench/WorkbenchConfirmBar.tsx:WorkbenchConfirmBar',
        'lib/sketch/sketcher/overlays/SketcherOverlays.tsx:SketcherOverlays',
        'lib/sketch/sketcher/overlays/SketchPromptBar.tsx:SketchPromptBar',
        'components/viewport/ViewportOverlay.tsx:ViewportOverlay',
      ]) {
        expect(walk.visited, `walk never reached ${seed} -- the domain is missing it`).toContain(seed)
      }
      expect(walk.visited.length, 'suspiciously small walk -- verify the roots still resolve').toBeGreaterThan(100)
      expect(domain.length, 'the census found no in-viewport surfaces at all -- the derivation is broken')
        .toBeGreaterThan(30)
    })

    it('every component reference the walk could NOT follow is named, and none is in the viewport', () => {
      // A reference the scanner cannot resolve is a HOLE in the closure. It is
      // tolerable only where it cannot hide an overlay -- so the assertion is
      // that no unfollowed reference sits inside the viewport domain.
      const inViewport = walk.unresolved.filter((u) => u.inViewport)
      expect(
        inViewport.map((u) => `${u.site} -> <${u.name}> (line ${u.line})`),
        'a component reference INSIDE the viewport render tree could not be followed, so the census cannot '
        + 'see what it renders. Resolve it (a direct import) or the domain has a blind spot:',
      ).toEqual([])
      // The tolerated remainder, named. These are icon components chosen from a
      // lookup (`const Icon = tab.icon`), which a parse-only scan cannot follow;
      // all sit in docked panels/toolbars, outside the viewport domain.
      expect(new Set(walk.unresolved.map((u) => u.name))).toEqual(new Set(['ToolIcon', 'Icon']))
    })

    it('only allowlisted external modules are treated as non-authoring', () => {
      // Anything imported from a bare specifier is skipped by the walk. That is
      // safe ONLY for modules that render no LienCNC surface -- so the list is
      // pinned rather than open.
      expect(walk.externals, 'a new external module renders inside this app: prove it authors no floating '
        + 'surface, then add it here').toEqual(['lucide-react'])
    })
  })

  describe('R. the render tree: every in-viewport floating surface, by authoring site', () => {
    it('EVERY in-viewport surface has a disposition -- a new overlay fails BY NAME', () => {
      const undispositioned = domain
        .filter((s) => SURFACE_DISPOSITIONS[s.key] === undefined)
        .map((s) => `${s.key}\n      @ ${s.file}:${s.line} [${s.route}] ${s.detail} (${s.domainReason})`)
      expect(
        undispositioned,
        'undispositioned in-viewport floating surface(s). Each is a surface that renders OVER a viewport and '
        + 'that nobody has adjudicated against docs/ui-ux/COHESION-STANDARD.md. Add a SURFACE_DISPOSITIONS entry '
        + 'keyed by the authoring site below (COHESIVE with evidence, RESTYLE-NEEDED with the defect + a booking '
        + `note, STRUCTURAL if it paints nothing, MODAL-GOVERNED, or DEV-ROUTE):\n${undispositioned.map((s) => `  ${s}`).join('\n')}`,
      ).toEqual([])
    })

    it('no stale dispositions: every entry still matches a live surface', () => {
      const live = new Set(domain.map((s) => s.key))
      const stale = Object.keys(SURFACE_DISPOSITIONS).filter((k) => !live.has(k))
      expect(
        stale,
        'stale disposition(s) -- the surface no longer exists, moved authoring site, or is no longer positioned. '
        + `Delete or re-key each:\n${stale.map((k) => `  ${k}`).join('\n')}`,
      ).toEqual([])
    })

    it('every disposition carries a real reason (no bare verdict)', () => {
      for (const [key, d] of Object.entries(SURFACE_DISPOSITIONS)) {
        expect(d.reason.trim().length, `empty/short reason for ${key}`).toBeGreaterThan(40)
      }
    })

    it('every RESTYLE-NEEDED member is BOOKED rather than silently carried', () => {
      const owed = Object.entries(SURFACE_DISPOSITIONS).filter(([, d]) => d.verdict === 'RESTYLE-NEEDED')
      expect(owed.length, 'the census found no drift at all -- suspicious; verify the walk still reaches the app')
        .toBeGreaterThan(0)
      for (const [key, d] of owed) {
        expect(d.reason, `${key}: a RESTYLE-NEEDED member must say it is booked, not edited (UI-70 scope fence)`)
          .toMatch(/BOOKED, not edited/)
      }
    })

    it('the census reports its app-wide derivation and retains coverage', () => {
      // WO UI-70-R1 (audit NOTE): the round-0 report published per-file test
      // counts of 8 and 20 where re-execution found 12 and 16. Nobody lied --
      // the numbers were measured once and then carried while the tree moved.
      // The fix for a stale count is a gate, not more care: these are the
      // numbers coordination/evidence/UI-70/OVERLAY-CENSUS.md section 3 prints,
      // so the artifact cannot drift from the code without this failing.
      // If you legitimately changed the domain, update BOTH.
      const byVerdict: Record<string, number> = {}
      for (const d of Object.values(SURFACE_DISPOSITIONS)) byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1
      // 10 -> 11 (UI-70 cohesion census count sync, 2026-07-24, citing commit
      // 9b9b8257c GEO-UNIFY-S1b): ModelWorkspaceHeader.tsx's own model-switcher
      // click-outside backdrop (an unclassed inline position:fixed/inset:0 div,
      // same shape as TreeContextMenu.tsx's backdrop) was dispositioned
      // RESTYLE-NEEDED at landing (overlayDispositions.ts, "WO GEO-UNIFY-S1b"
      // comment) but this advisory file's own hardcoded counts were never
      // synced. dc1369b2b (OP-TOOL-FILTER, same night) added no new floating
      // overlay surface -- its own commit message records "overlay census
      // 65/67 with the 2 remaining failures traced ... to ... ModelWorkspaceHeader.tsx,
      // not mine" -- so it contributes no delta here.
      // 45 -> 46 COHESIVE (UI-BRAND-B3-1, Q-65): the ThemedListbox custom-select
      // dropdown (components/ui/ThemedListbox.tsx:399, position:fixed, authored
      // in place) is a new in-viewport floating surface, dispositioned COHESIVE
      // (fully token-styled, zero raw hex). Scoped to the Settings + Post
      // Processor modals only; every other native <select> stays native.
      // 46 -> 47 COHESIVE (B3-2, Q-65): the shared ThemedTooltip surface
      // (components/ui/ThemedTooltip.tsx, div.themed-tooltip, position:fixed,
      // authored in place) is a new in-viewport floating surface, dispositioned
      // COHESIVE (fully token-styled, zero raw hex) -- the themed replacement
      // for native title= bubbles across src/components.
      // 16 -> 17 MODAL-GOVERNED (PROMOTE-SKETCH-FAIL round 2): ConfirmModal.tsx's
      // div.modal-backdrop -- the app's ONE themed confirm dialog, the on-brand
      // replacement for native window.confirm(). Same shared .modal-backdrop
      // scrim + shell chrome as every sibling modal, dispositioned MODAL-GOVERNED.
      // 17 -> 18 MODAL-GOVERNED (IMPORT-MULTIBODY-CHOICE, Operator Q-76):
      // MultiBodyImportModal.tsx's div.modal-backdrop -- the themed chooser that
      // lets the user decide whether a multi-body STEP lands as one item or one
      // item per body. Same shared .modal-backdrop scrim + shell chrome as every
      // sibling modal, dispositioned MODAL-GOVERNED.
      // 47 -> 49 COHESIVE, 19 -> 20 MODAL-GOVERNED (MACHINE-CONTROL merge,
      // 2026-08-01): the Control tab's g-code preview canvas + its .panel-empty
      // hint (both token-driven, COHESIVE) and the Machine actions modal's
      // shared .modal-backdrop scrim (MODAL-GOVERNED), dispositioned above.
      // 49 -> 50 COHESIVE (Fillet single-palette rework, a776c3290): the
      // model Fillet role=toolbar command strip deliberately reuses the
      // sanctioned sketch confirm-strip pattern from WO UX-KEYFLOW-1.
      // 50 -> 51 COHESIVE (Chamfer qualified strip conversion): model Chamfer
      // reuses that exact accepted role=toolbar confirm-strip family.
      // 52 -> 51 COHESIVE (MC-TIER1, 2026-08-05): the Control tab's Canvas-2D
      // g-code backplot was REPLACED by a real CNCViewport, whose canvas THREE
      // appends at runtime. Its .panel-empty hint survives and is still
      // COHESIVE; the authored canvas surface no longer exists to adjudicate.
      // 51 -> 55 COHESIVE (2026-08-20): +2 WO-404, Operator's rulings - the program
      // preview's view rail ("where they were") and the pendant pairing flyout
      // ("pops right, user interacts, it pops back"); +2 were already live and
      // never re-pinned here (ProgramPreviewGridControl's grid selector and
      // WO-292's EnvelopeReadout card, both dispositioned COHESIVE above) - the
      // count had drifted since those landed, independent of today.
      expect(byVerdict, 'OVERLAY-CENSUS.md section 3 publishes this distribution -- update it alongside').toEqual({
        // 55 -> 56 (2026-08-20, WO-380): +1 the intended-stock readout on the
        // program preview (dispositioned COHESIVE above).
        // 56 -> 57 (2026-08-21, WO-414 batch 2, Operator's verdicts): -1 the Table
        // card (EnvelopeReadout, removed), +1 its surviving travel-mismatch
        // line (TravelMismatchLine), +1 the intended-stock facts popover that
        // opens above the lower-right line.
        // 57 -> 72 (WO-1088 census catch-up): WO-1062 added the second
        // simulation panel plus 14 token-styled feed-summary text sites.
        // 72 -> 73: WO-1570's SketchConfirmOverlay chamfer mode-select/Swap
        // buttons (one new .sketch-prompt-btn authoring-site key), COHESIVE.
        // 73 -> 74 (WO-1586): Seat in vise's re-hosted command strip, COHESIVE
        // (same sanctioned sketch-confirm-overlay family as Fillet/Chamfer/Shell).
        // WO-2784 RE-PIN 80 -> 83: WO-2748 preview connector svg, WO-2616 pattern-editor scrim + form.
        COHESIVE: 87, // WO-2882: +3 WO-2865 Shell refusal lines. // WO-2838: +1 WO-2804 MoveHoleEntry. // WO-2651 adds the line menu and its shared transparent dismissal scrim. // 77 -> 78 WO-2431: intended-stock eye button (class-based scan of the folded-strip rule). // WO-2305 independent reference-image editor (+1); 75 -> 77 WO-2458: intended-stock line + badge.
        'RESTYLE-NEEDED': 12, // 11 -> 12 WO-2458: ReferenceImagePlacement corner handle (booked).
        // 4 -> 11 (WO-1088 census catch-up): WO-1062 added seven in-flow
        // feed-summary layout wrappers that paint no floating surface.
        STRUCTURAL: 12, // 11 -> 12 WO-2458: ReferenceImagePlacement portal wrapper.
        // 22 -> 24: the help-image lightbox + its X close (5eae1d577).
        // 24 -> 25 (2026-08-21, WO-416): the mesh flatness viewer's
        // div.modal-backdrop, opened from the "Mesh N x N" chip that replaced
        // the full-width "MESH COMPENSATION ACTIVE" banner.
        // 25 -> 26 (WO-1706): MacroEditor's div.modal-backdrop, same shared
        // modal family as MachineActionsModal.
        // 26 -> 27 (Form): the Form palette shown while form mode is open
        // inside the Model screen (FormPanel.tsx), modal-container chrome.
        // 27 -> 29 (WO-2201, surfaces landed by WO-2171): the Relief palette
        // and its height map (ReliefPanel.tsx), the Form palette's shell.
        // 29 -> 28 (Form stage 50): the Form palette docks as a column beside
        // the rail, in the page's flow; it is no longer a floating surface.
        // 28 -> 26 (Form stage 51): the Relief palette and height map dock the
        // same way, one column beside the rail.
        // WO-2318: +1 shared scrim for both sketch file windows.
        // WO-2784 RE-PIN 30 -> 31: WO-2759 (2d220dbd0b) ReportProblemDialog's shared scrim.
        'MODAL-GOVERNED': 31, // 29 -> 30 WO-2448 (e56294822): ExportModal's shared scrim.
        'DEV-ROUTE': 13,
      })
      // 85 -> 86 (CAM-BINDING Stage 1 census reconciliation, 2026-07-22): the
      // editLoadError-branch modal-backdrop (NewOperationModal.tsx:2306, added
      // by 7be7f8f43 the day before) was ALWAYS in this static domain -- this
      // count was stale from the day it landed, independent of and predating
      // today's two feature commits that additionally shifted line numbers.
      // The runtime census (verdict-bearing) now dispositions and OBSERVES
      // both sites; this advisory count simply catches up to match it.
      // 86 -> 87 (FULL-SUITE-DRIFT, 2026-07-23, citing commit 523dc5256):
      // ModelEntryModal.tsx's div.modal-backdrop (added by INT-MODEL-UNIFY,
      // 505830f78) was already live in the render tree -- domain.length was
      // ALREADY 87 before 523dc5256, this advisory count was the one that had
      // gone stale. 523dc5256 dispositioned it MODAL-GOVERNED (identical to
      // its SketchEntryModal sibling) and fixed the verdict-bearing runtime
      // census, but did not touch this advisory static-walk file's own
      // hardcoded counts; this pass catches them up to match.
      // 87 -> 88 (UI-70 cohesion census count sync, 2026-07-24, citing commit
      // 9b9b8257c GEO-UNIFY-S1b): the same switcher backdrop above is a new
      // in-viewport surface -- ModelWorkspaceHeader.tsx did not exist before
      // tonight's batch, so this was never counted.
      // 88 -> 89 (UI-BRAND-B3-1, Q-65): the ThemedListbox custom-select dropdown
      // (components/ui/ThemedListbox.tsx:399, position:fixed) is a new in-viewport
      // floating surface, dispositioned COHESIVE above.
      // 89 -> 90 (B3-2, Q-65): the ThemedTooltip surface (div.themed-tooltip,
      // position:fixed) is a new in-viewport floating surface, dispositioned
      // COHESIVE above.
      // 90 -> 91 (MSH-4-BOOLEAN-EDIT, Q-70/Q-72): the boolean-mesh-vs-model-body
      // dialog's outer div (BooleanMeshDialog.tsx:211, position:fixed floating
      // side panel, no backdrop) is a new in-viewport surface, dispositioned
      // MODAL-GOVERNED above.
      // 91 -> 92 (PROMOTE-SKETCH-FAIL round 2): ConfirmModal.tsx's themed-confirm
      // div.modal-backdrop is a new in-viewport fixed surface, dispositioned
      // MODAL-GOVERNED above.
      // 92 -> 93 (IMPORT-MULTIBODY-CHOICE, Operator Q-76): MultiBodyImportModal.tsx's
      // themed div.modal-backdrop is a new in-viewport fixed surface, dispositioned
      // MODAL-GOVERNED above.
      // 93 -> 94 (IMPORT-STOCK-PROMPT): ImportStockChoiceModal.tsx's themed
      // div.modal-backdrop is the same fixed, MODAL-GOVERNED surface class.
      // 94 -> 95 (DEFEATURE direct workflow): DialogShell's floating-palette
      // modal-container is fixed so the viewport remains available for picks;
      // it is a distinct MODAL-GOVERNED surface from the transparent backdrop.
      // 95 -> 96 (UI-91 Draft direct workflow): DraftDialog's movable command
      // card is fixed while the viewport remains the primary face-pick surface.
      // 96 -> 99 (TRUNK MERGE 2026-08-03, machine-control side): the Control
      // tab brings three in-viewport surfaces - the Machine actions modal
      // backdrop (fixed scrim, MODAL-GOVERNED) and the ProgramPreview backplot
      // canvas + its empty-state hint (absolute in the preview stage, COHESIVE).
      // 99 -> 100 (Fillet single-palette rework, a776c3290): FilletDialog's
      // sketch-confirm-overlay command strip is a new in-viewport surface.
      // 100 -> 101 (Chamfer qualified strip conversion): ChamferDialog's
      // matching command strip is the second model dress-up surface in this family.
      // 101 -> 103 (help-image lightbox, 5eae1d577 - Operator directive): the
      // maximize lightbox scrim and its always-visible X close button are two
      // fixed authoring sites in HelpFigure.tsx, both MODAL-GOVERNED.
      // 103 -> 104 (Shell qualified strip conversion): ShellDialog joins the
      // accepted Fillet/Chamfer command-strip family.
      // 104 -> 103 (MC-TIER1, 2026-08-05): the Control tab's authored Canvas-2D
      // backplot was replaced by a runtime-mounted CNCViewport, removing one
      // authoring site. Its .control-preview-wrap host is still in the domain -
      // it now declares itself with data-viewport-host - so the .panel-empty
      // hint inside it stays censused.
      // 103 -> 107 (re-pinned 2026-08-20 with WO-404): +2 Operator's rulings (the
      // ProgramPreview view rail, the pendant pairing flyout), +2 already live
      // and dispositioned COHESIVE but never counted here (the grid selector,
      // WO-292's envelope readout) - drift from their own landings, not today's.
      // 107 -> 108 (re-pinned 2026-08-20 with WO-380): +1 the intended-stock
      // readout card on the program preview.
      // 108 -> 109 (2026-08-21, WO-414 batch 2): -1 the Table card, +1 its
      // travel-mismatch line, +1 the intended-stock facts popover.
      // 109 -> 110 (2026-08-21, WO-416): +1 MeshViewerModal's modal-backdrop -
      // the flatness viewer that opens from the "Mesh N x N" chip which
      // replaced the full-width "MESH COMPENSATION ACTIVE" banner.
      // 110 -> 132 (WO-1088 census catch-up): WO-1062 added one simulation
      // panel and 21 feed-summary sites; every site is dispositioned above.
      // 132 -> 133: WO-1570 added the chamfer mode-select and Swap buttons to
      // SketchConfirmOverlay; both collapse into one new .sketch-prompt-btn
      // authoring-site key (see overlayDispositions.ts).
      // 133 -> 134 (WO-1586): Seat in vise re-hosted from a mounted-nowhere
      // modal into the same sketch-confirm-overlay strip family, +1 new
      // authoring site (SeatInViseCommand.tsx).
      // 134 -> 135 (WO-1706): MacroEditor.tsx's div.modal-backdrop -- the
      // macro editor opened from the Macros panel's "Edit macros" control,
      // same shared modal family as MachineActionsModal.
      // 135 -> 136 (Form, docs/design/FORM-ENVIRONMENT.md): the Form palette
      // (FormPanel.tsx div.form-palette-shell.modal-container) shown while
      // form mode is open inside the Model screen.
      // 136 -> 138 (WO-2201, surfaces landed by WO-2171): ReliefPanel.tsx's
      // div.relief-palette-shell and div.relief-map-shell, both inline
      // position:fixed modal-container palettes shown in relief mode.
      // 138 -> 137 (Form stage 50): the Form palette docks as a column beside
      // the rail (FormPanel.tsx aside.panel-right), no longer a position:fixed
      // modal-container over the view, so it leaves the in-viewport domain.
      // 137 -> 135 (Form stage 51): the Relief palette and its height map dock
      // as one column beside the rail (the map a section in it), no longer two
      // position:fixed modal-containers over the view.
      // 135 -> 143 (WO-2458): six surfaces landed after the last count sync; each dispositioned above
      // (the census table's own header lists them).
      // 143 -> 144 (WO-2448, e56294822): ExportModal adds one shared modal-backdrop, MODAL-GOVERNED above.
      // 144 -> 145 (WO-2431): intended-stock eye button, COHESIVE above (class-based scan of the folded-strip rule).
      // WO-2784 RE-PIN 147 -> 151: +1 ReportProblemDialog backdrop (WO-2759, MODAL-GOVERNED), +1 the
      // smart-dimension preview connector svg (WO-2748, COHESIVE), +2 SketchPatternEditor scrim + form
      // (WO-2616, COHESIVE); the Help and project-picker backdrops were re-keyed, not added. Each above.
      // WO-2838: WO-2804 adds the MoveHoleEntry authoring site (STEP/STL share it).
      // WO-2882 RE-PIN 152 -> 155: WO-2865's three Shell refusal lines, COHESIVE above.
      expect(domain.length, 'overlay census derives 155 in-viewport surfaces').toBe(155)
      expect(Object.keys(SURFACE_DISPOSITIONS).length, 'one disposition per in-viewport surface, exactly').toBe(155)
      // MERGE-SEAM NOTE (main 52ec79e9): 117 -> 119. Both new surfaces are the
      // UI-73 "restore floating tabs" portal-target divs in App.tsx (line 93,
      // FloatingModeTabs's own fallback; line 208, CamApp's Part-workspace
      // target) -- `.viewport-toolbar.app-mode-tabs-floating`, position:absolute
      // via app.css, OUT of the in-viewport domain (inViewport:false; neither
      // is position:fixed nor reachable from a viewport host), so `domain.length`
      // (74) and every SURFACE_DISPOSITIONS-gated count below are unaffected.
      // See src/tests/ui/support/overlayAuthoringLint.ts's new BODY-PORTAL
      // sanction for the createPortal() call that feeds them.
      // 131 -> 133: same pre-existing catch-up as domain.length above (+1 the
      // editLoadError-branch modal-backdrop) plus App.tsx's model-item-editing
      // -banner (2b7b82846, also predates today), neither previously counted.
      // 133 -> 134 (UI70-COHESION-SYNC, 2026-07-23, citing UI-BRAND-B2-10 commit
      // 89b7eb5b2): DisclosureSection.tsx gained an additive `className` prop
      // ("a ported site's own scoped CSS", e.g. PropertiesPanel's sticky-header
      // restore) so its wrapper became `className={className ? \`disclosure-
      // section ${className}\` : 'disclosure-section'}` (DisclosureSection.tsx:
      // 115) -- a ternary keyed on an external identifier the AST walk cannot
      // resolve, so it lands as ONE new INDETERMINATE-route surface. It is NOT
      // in-viewport (a docked-panel/modal disclosure header, not authored inside
      // a viewport host or position:fixed), so domain.length/SURFACE_DISPOSITIONS
      // above are unaffected -- confirmed by diffing this walk against the
      // pre-batch tree (commit 949be4452): the ONLY new key added anywhere in
      // walk.surfaces is `components/ui/DisclosureSection.tsx:DisclosureSection
      // > div.disclosure-section`.
      // 134 -> 135: the same ModelEntryModal.tsx div.modal-backdrop site (see
      // above) is also a floating surface app-wide, not just in-viewport.
      // 135 -> 136 (UI-70 cohesion census count sync, 2026-07-24, citing commit
      // 9b9b8257c GEO-UNIFY-S1b): the same ModelWorkspaceHeader.tsx switcher
      // backdrop above is also a floating surface app-wide, not just
      // in-viewport.
      // 136 -> 137 (UI70-CENSUS-SYNC, 2026-07-24, citing commit dc9dd534a
      // NAV-BODY-ROW): TreeContextMenu.tsx (model3d/tree) gained a NEW "Show
      // in CAM" menu-item button (onShowInCam prop). Like its 8 sibling menu
      // items, it authors `style={itemStyle}` -- a local-variable style
      // reference the AST walk cannot statically resolve -- so it lands as
      // an INDETERMINATE surface (`TreeContextMenu.tsx:TreeContextMenu >
      // button#9`), confirmed by diffing this walk's surface keys against
      // commit 745853538 (the last synced count): the ONLY added key
      // anywhere in walk.surfaces is this one. It is NOT in-viewport (a
      // context-menu item, not authored inside a viewport host nor
      // position:fixed itself), so domain.length/SURFACE_DISPOSITIONS above
      // are unaffected -- no new disposition entry is owed, only this count.
      // 137 -> 139 (UI-BRAND-B3-1, Q-65): the ThemedListbox adds TWO app-wide
      // surface keys -- its wrapper `div.themed-listbox` (NOT positioned, NOT
      // in-viewport, so no disposition owed -- same status as DisclosureSection's
      // own `div.disclosure-section` wrapper above) and its `ul.themed-listbox-popup`
      // dropdown (position:fixed, in-viewport, dispositioned COHESIVE above).
      // Only the popup counts toward domain.length (+1); both count here (+2).
      // 140 -> 147 (MSH-4-BOOLEAN-EDIT catch-up): the boolean-mesh dialog adds
      // ONE app-wide fixed surface (matching the +1 in the in-viewport count
      // below); the remaining +6 is pre-existing advisory drift from concurrent
      // lanes that updated the in-viewport count but not this app-wide advisory
      // total -- caught up to the live derivation here (the app-wide count is
      // advisory; the in-viewport domain + its dispositions are the gated truth).
      // 139 -> 140 (B3-2, Q-65): the ThemedTooltip adds ONE app-wide surface key
      // -- div.themed-tooltip (position:fixed, in-viewport, dispositioned
      // COHESIVE above), so it counts toward BOTH domain.length (+1) and here (+1).
      // 147 -> 148 (PROMOTE-SKETCH-FAIL round 2): the ConfirmModal themed-confirm
      // div.modal-backdrop counts app-wide too (position:fixed, in-viewport).
      // 148 -> 149 (VIEW-ERRORBOUNDARY census catch-up): the walk previously
      // could not follow CLASS components (findDeclaration only knew function/
      // variable declarations), so ViewportErrorBoundary sat in walk.unresolved
      // and its absolutely-positioned fallback overlay was invisible to the
      // census. overlayRenderTree.ts now resolves class declarations; the
      // fallback (div, inline absolute, app-main level - ABOVE the viewport
      // host domain, so app-wide advisory only, no in-viewport disposition
      // owed) is the +1.
      // 149 -> 150 (IMPORT-MULTIBODY-CHOICE, Operator Q-76): the MultiBodyImportModal
      // themed div.modal-backdrop counts app-wide too (position:fixed, in-viewport).
      // 150 -> 151 (IMPORT-STOCK-PROMPT): ImportStockChoiceModal's backdrop.
      // 151 -> 153 (DEFEATURE direct workflow): DialogShell's fixed
      // floating-palette modal-container counts app-wide, and the conditional
      // drag-cursor style makes its modal-header an advisory INDETERMINATE
      // authoring entry (out of the in-viewport disposition domain).
      // 153 -> 154 (UI-91 Draft direct workflow): DraftDialog's command card.
      // 154 -> 173 (TRUNK MERGE 2026-08-03, machine-control side): the Control
      // tab's positioned chrome lands app-wide - three in-viewport surfaces
      // dispositioned above, the tab's out-of-domain positioned classes
      // (safety bar chrome, overlay cards, jog cluster, resizers, probe/park
      // rows), and the fit-trace guided card + job-properties readout.
      // 173 -> 174 (Fillet single-palette rework, a776c3290): the same new
      // command-strip authoring site counted in the in-viewport total above.
      // 174 -> 175 (Chamfer qualified strip conversion): the matching Chamfer
      // command-strip authoring site counts app-wide and in-viewport.
      // 175 -> 178 (help-image lightbox, 5eae1d577): the lightbox scrim + its
      // X close count in-viewport too; the figure's hover expand chip is
      // absolutely positioned inside the figure so it counts app-wide only.
      // MERGE-SEAM NOTE: concurrent Sweep/Loft command-surface work moved the
      // live app-wide derivation to 179 before this lane's Shell surface.
      // 179 -> 180: the same Shell command strip counts app-wide.
      // 180 -> 179 (MC-TIER1, 2026-08-05): the Control tab's authored Canvas-2D
      // backplot is gone; the CNCViewport that replaced it appends its canvas
      // imperatively, so there is one fewer authoring site app-wide.
      // 179 -> 176 (WO-047, 2026-08-07): the mode tabs moved natively into the
      // top header and UI-73's floating chrome is deleted - all three of its
      // authoring sites (App.tsx's part + control portal-host divs and
      // FloatingModeTabs's fallback div, `.viewport-toolbar
      // .app-mode-tabs-floating`) are gone. All were out of the in-viewport
      // domain (inViewport:false), so `domain.length` above is unaffected.
      // 176 -> 178 (WO-117, 2026-08-09): the resizable program split added two
      // app-wide authoring sites. ControlPage's main.control-col-main now has
      // an opaque React style object that publishes the split values, so the
      // conservative walk reports it as INDETERMINATE. ProgramDivider's
      // div.control-program-divider hosts its absolutely positioned ::after
      // rule, so the positioned-class derivation reports that live surface too.
      // Neither is in the viewport domain, so no SURFACE_DISPOSITIONS entry is
      // owed and the 103 in-viewport count above remains unchanged.
      // 178 -> 211 app-wide (re-pinned 2026-08-20 with WO-404): the app-wide
      // count had drifted across many landings since it was last pinned; the
      // in-viewport subset (107) is the adjudicated domain and is pinned above.
      // 211 -> 212 (WO-380): the intended-stock readout.
      // 212 -> 213 (WO-414 batch 2): -1 Table card, +1 travel-mismatch line, +1 stock popover.
      // 213 -> 214 (WO-416): the mesh viewer's div.modal-backdrop.
      // 214 -> 216: main's machine-definition expansion added two app-wide
      // surfaces; the adjudicated in-viewport domain remains pinned above.
      // 216 -> 239 (WO-1088 census catch-up): the same 22 WO-1062 sites plus
      // WO-1053's VfdReadout span are present in the app-wide derivation.
      // 239 -> 242 (WO-1137): WO-1042's durable work-offset state adds three
      // legitimate app-wide authoring surfaces: ControlPage's unknown-WCS
      // chip, OffsetCell's stored/live wrapper, and OffsetsPanel's WCS label
      // carrying the unknown-state provenance marker. None is in-viewport.
      //
      // WO-1250: this was an exact 242 pin. It went stale three times because
      // it measures every floating authoring site, including ordinary
      // out-of-viewport form structure. The UX invariant is the separately
      // pinned in-viewport domain and its one-to-one, reasoned dispositions;
      // that gate fails by name when a new viewport overlay appears. Keep the
      // app-wide number visible as a run receipt and retain a broad scanner
      // floor, but do not require unrelated product work to edit this census.
      const appWideSurfaceCount = walk.surfaces.length
      console.info(`[overlay census] derives ${appWideSurfaceCount} floating surfaces app-wide`)
      expect(
        appWideSurfaceCount,
        'overlay census lost its app-wide coverage: the render walk must retain a substantial non-viewport population',
      ).toBeGreaterThanOrEqual(200)
      expect(imperative.length, 'OVERLAY-CENSUS.md section 3 publishes 2 imperative overlays').toBe(2)
    })

    it('the ONE surface this WO edited is the one the WO named', () => {
      // The scope fence, asserted rather than promised: every other drifted
      // member is booked, and the subject is the only COHESIVE entry claiming
      // to have been restyled here.
      const restyled = Object.entries(SURFACE_DISPOSITIONS).filter(([, d]) => /RESTYLED BY THIS WO/.test(d.reason))
      expect(restyled.map(([k]) => k)).toEqual([
        'components/model3d/workbench/AnchoredValueEntry.tsx:AnchoredValueEntry > div.workbench-anchor-entry',
      ])
    })
  })

  describe('D. imperative DOM append sites (no React walk can see these)', () => {
    it('the scan is non-vacuous: it finds the two known imperative overlays', () => {
      expect(imperative.map((s) => s.key)).toEqual([
        'lib/viewport/CNCViewport.ts:project-plane-overlay',
        'lib/viewport/CNCViewport.ts:slice-plane-overlay',
      ])
    })

    it('EVERY imperative overlay has a disposition', () => {
      const undispositioned = imperative.filter((s) => IMPERATIVE_DISPOSITIONS[s.key] === undefined)
      expect(
        undispositioned.map((s) => `${s.key} (${s.file}:${s.line})`),
        'undispositioned imperative overlay(s): an element created in JS, given a positioned class and appended '
        + 'into the viewport container. Add an IMPERATIVE_DISPOSITIONS entry for each.',
      ).toEqual([])
      const stale = Object.keys(IMPERATIVE_DISPOSITIONS).filter((k) => !imperative.some((s) => s.key === k))
      expect(stale, 'stale imperative disposition(s)').toEqual([])
    })
  })

  describe('A. app.css coverage cross-check (the render walk lost nothing)', () => {
    it('EVERY positioned class in app.css is either rendered by a censused surface or named as unrendered', () => {
      // This is the render walk's own blind-spot check. If a positioned class is
      // claimed by no surface AND is not named below, the walk failed to reach
      // whatever renders it -- a false negative, which is the failure mode this
      // derivation has and a text scan does not.
      const claimed = new Set<string>()
      for (const s of walk.surfaces) for (const c of s.classes) claimed.add(c)
      for (const s of imperative) claimed.add(s.className)
      const unclaimed = [...positioned.keys()]
        .filter((c) => !claimed.has(c))
        .filter((c) => UNRENDERED_CLASSES[c] === undefined)
      expect(
        unclaimed.map((c) => `.${c} (app.css:${positioned.get(c)?.line})`),
        'positioned class(es) in app.css that NO surface the render walk found claims, and that are not named '
        + 'in UNRENDERED_CLASSES. Either the walk cannot reach what renders them (fix the walk -- this is a '
        + 'blind spot), or nothing renders them (name them, with why):',
      ).toEqual([])
    })

    it('no stale unrendered claims: a class named unrendered must really be positioned in app.css', () => {
      const stale = Object.keys(UNRENDERED_CLASSES).filter((c) => !positioned.has(c))
      expect(stale, `UNRENDERED_CLASSES names class(es) app.css no longer positions:\n${stale.join('\n')}`).toEqual([])
    })

    it('the app.css scan is non-vacuous: it finds the known positioned anchors', () => {
      expect(positioned.size).toBeGreaterThan(20)
      for (const anchor of ['workbench-confirm-bar', 'viewport-overlay', 'sketch-prompt-bar']) {
        expect([...positioned.keys()], `scanner anchor stale: .${anchor} not found`).toContain(anchor)
      }
      // The fixed/absolute split is load-bearing (it is what puts the pick
      // banners in the domain from a modal file), so pin both sides.
      expect(positioned.get('modal-backdrop')?.positions.has('fixed')).toBe(true)
      // MERGE-SEAM NOTE (main 52ec79e9): `.workbench-anchor-entry` LEFT the
      // app.css-class route entirely -- UI-57's shipped AnchoredValueEntry
      // positions itself INLINE (a dispositioned exception, see
      // overlayDispositions.ts and the "AnchoredValueEntry disposition" block
      // below). Keeping it in the app.css text-anchor list above would be
      // testing a rule that no longer exists; asserted absent here instead, so
      // this test still fails loud if the class is ever reintroduced without
      // updating the anchor list back. The surface's real identity is now
      // proven through the RENDER WALK (derivation R), not the CSS text scan --
      // pointed at what actually identifies it: its authoring site and its
      // `inline-position` route.
      expect(
        positioned.has('workbench-anchor-entry'),
        '.workbench-anchor-entry has an app.css rule again -- move this anchor back into the loop above',
      ).toBe(false)
      const anchorEntrySurface = walk.surfaces.find(
        (s) => s.key === 'components/model3d/workbench/AnchoredValueEntry.tsx:AnchoredValueEntry > div.workbench-anchor-entry',
      )
      expect(anchorEntrySurface, 'scanner anchor stale: AnchoredValueEntry > div.workbench-anchor-entry not found by the render walk').toBeDefined()
      expect(
        anchorEntrySurface?.route,
        'AnchoredValueEntry is dispositioned as an INLINE-POSITION exception; if this ever reads positioned-class, restore it to the app.css anchor loop above instead',
      ).toBe('inline-position')
    })
  })

  describe('C. phantom tokens (the UI-70 defect class)', () => {
    it('recognizes inline JSX custom-property definitions without accepting mere references', () => {
      const defs = inlineStyleTokenDefs('inline.tsx', `
        const unrelated = { '--not-painted': '2px' }
        const reference = 'var(--only-referenced)'
        const element = <div style={{ height: 'var(--only-referenced)', background: makeBackground({ '--not-a-style-key': '1px' }), ...{ '--inline-line': '20px' } } as CSSProperties} />
      `)
      expect([...defs]).toEqual(['--inline-line'])
      expect(tokenDefs().has('--gce-line')).toBe(true)
    })

    const refs = tokenRefs()
    const defs = tokenDefs()
    const phantoms = [...refs.entries()].filter(([name]) => !defs.has(name))

    it('the scan is non-vacuous: it resolves real tokens and real definitions', () => {
      expect(refs.size).toBeGreaterThan(100)
      expect(defs.has('--surface-1')).toBe(true)
      expect(defs.has('--text-danger')).toBe(true)
      // The imperative JS-side definition must count, or the scan cries phantom
      // on a token that is genuinely published at runtime.
      expect(defs.has('--sim-panel-h'), 'setProperty() definitions must be recognized').toBe(true)
    })

    it('NO unguarded phantom token: a var(--x) with no definition AND no fallback paints the initial value silently', () => {
      const unguarded = phantoms.filter(([, v]) => !v.withFallback)
      expect(
        unguarded.map(([name, v]) => `${name} <- ${v.sites.join(', ')}`),
        'unguarded phantom token(s): referenced without a fallback and defined nowhere in src/. CSS resolves these '
        + 'to the property\'s INITIAL value (transparent, for a background) with no error anywhere -- this is the exact '
        + 'defect Operator caught in UI-58\'s overlay. Define the token in src/theme/tokens.css, or point the reference at '
        + 'an existing semantic token.',
      ).toEqual([])
    })

    it('every fallback-guarded phantom is dispositioned', () => {
      const guarded = phantoms.filter(([, v]) => v.withFallback).map(([name]) => name)
      const undispositioned = guarded.filter((name) => GUARDED_PHANTOM_DISPOSITIONS[name] === undefined)
      expect(
        undispositioned,
        `fallback-guarded phantom token(s) with no disposition:\n${undispositioned.map((n) => `  ${n}`).join('\n')}`,
      ).toEqual([])
      const stale = Object.keys(GUARDED_PHANTOM_DISPOSITIONS).filter((n) => !guarded.includes(n))
      expect(stale, `stale guarded-phantom disposition(s):\n${stale.join('\n')}`).toEqual([])
    })

    it('the specific token that broke UI-58 is gone and stays gone', () => {
      expect(refs.has('--surface-panel'), '--surface-panel is referenced again -- it has never been defined').toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // MERGE-SEAM ADJUDICATION (main 52ec79e9): this describe block used to assert
  // that THIS WO's own R1 restyle of AnchoredValueEntry moved its paint into an
  // app.css class rule and dropped its inline position. That restyle was
  // SUPERSEDED during the main merge by UI-57's independently shipped
  // AnchoredValueEntry (v0.12.12) -- per the merge commit's own ruling, "the
  // branch variant predates it". UI-57's version passed its OWN
  // design-cohesion audit at the SKC-44 bar and positions itself INLINE.
  //
  // This is a DISPOSITIONED EXCEPTION (SURFACE_DISPOSITIONS, BK-168 rider), not
  // a weakened guard: the block below still refuses the ACTUAL UI-58 defect
  // (a phantom, undefined token painting nothing) unconditionally, for every
  // surface in the app, not just this one -- that guard is derivation C above
  // and is untouched. What changed is narrow to THIS ONE NAMED SITE, and it is
  // tied to a LIVE disposition entry rather than asserted as a bare pass: if the
  // disposition is ever deleted, downgraded, or stops naming the exception,
  // this fails. No other surface can borrow this permission -- every other
  // in-viewport surface is still required to have NO inline position (or to
  // earn its own named, reasoned disposition exactly like this one, via
  // derivation R's "EVERY in-viewport surface has a disposition" gate above).
  // ---------------------------------------------------------------------------
  describe('the AnchoredValueEntry disposition: a NAMED, AUDITED exception, not a generic weakening', () => {
    const ENTRY_FILE = path.join(SRC, 'components/model3d/workbench/AnchoredValueEntry.tsx')
    const ANCHOR_KEY = 'components/model3d/workbench/AnchoredValueEntry.tsx:AnchoredValueEntry > div.workbench-anchor-entry'

    it('the ACTUAL UI-58 defect -- a phantom, undefined token -- is still absent, regardless of route', () => {
      // This is the generic guard, unweakened: it fires on `var(--surface-panel)`
      // wherever it appears, in ANY component, inline or not -- derivation C
      // above already gates it app-wide. Re-asserted narrowly here too, so a
      // reader of this specific file's history sees the regression it replaced.
      const entry = stripComments(readFileSync(ENTRY_FILE, 'utf8'))
      expect(entry, 'the UI-58 phantom token is back').not.toMatch(/var\(\s*--surface-panel\b/)
      expect(entry).toContain('className="workbench-anchor-entry"')
    })

    it('the inline position is the ADJUDICATED UI-57 surface, and it is gated on a LIVE, named disposition', () => {
      const entry = stripComments(readFileSync(ENTRY_FILE, 'utf8'))
      // Documents present reality (main's shipped component), rather than
      // asserting the old branch's now-superseded contract.
      expect(
        /position:\s*['"](absolute|fixed)['"]/.test(entry),
        'AnchoredValueEntry no longer positions itself inline -- if this was restyled back into an app.css class, '
        + 'update this test AND move the scanner anchor in the previous describe block back to the positioned-class route',
      ).toBe(true)
      // The permission is not a bare pass: it exists ONLY because a live,
      // reasoned disposition still names this exact site as the exception.
      const disposition = SURFACE_DISPOSITIONS[ANCHOR_KEY]
      expect(disposition, `${ANCHOR_KEY} carries no disposition -- an inline position here is only ever permitted for a NAMED, audited exception`).toBeDefined()
      expect(disposition.verdict).toBe('COHESIVE')
      expect(disposition.reason, 'the disposition must name the exception mechanism, not just assert COHESIVE').toMatch(/DISPOSITIONED EXCEPTION/)
      expect(disposition.reason, 'the disposition must name its booked follow-up').toMatch(/BK-168/)
    })

    it('app.css carries no rule for workbench-anchor-entry -- the class is a test/DOM hook only, and that gap is the booked follow-up, not an oversight', () => {
      expect(
        css,
        '.workbench-anchor-entry has an app.css rule again -- the BK-168 refactor landed; restore the positioned-class '
        + 'assertions this block replaced and move the scanner anchor back',
      ).not.toMatch(/^\.workbench-anchor-entry\s*\{/m)
    })
  })

  // -------------------------------------------------------------------------
  // THE BYPASS FIXTURE (WORKER-CHARTER item 1: "a probe that cannot fail is not
  // a gate"). The auditor defeated round 0 by rendering an undispositioned HUD
  // that reused a dispositioned class. That exact move, plus three other
  // positioning routes, is committed as a fixture and run through the REAL
  // scanner here. Round 0's census returns 18/18 GREEN on all four.
  // -------------------------------------------------------------------------
  describe('mutation proof: the auditor\'s bypass, and three more routes, FAIL the census', () => {
    const bypass = walkRenderTree({
      srcRoot: SRC,
      roots: [{ file: 'tests/ui/fixtures/overlayBypass.fixture.tsx', name: 'BypassViewport' }],
      positioned,
    })
    const bypassDomain = bypass.surfaces.filter((s) => s.inViewport)

    it('the fixture is recognised as a viewport host -- the bypasses are IN the domain', () => {
      expect(bypass.hosts.map((h) => h.component)).toEqual(['BypassViewport'])
      expect(bypassDomain.length, 'the fixture rendered no in-viewport surface -- the fixture, not the app, is broken')
        .toBe(4)
    })

    it('RED: the auditor\'s own bypass -- a NEW site reusing the dispositioned .sketch-prompt-bar class', () => {
      const hud = bypassDomain.find((s) => s.classes.includes('sketch-prompt-bar'))
      expect(hud, 'the reused-class HUD was not detected at all').toBeDefined()
      // The class IS dispositioned -- at SketchPromptBar's site. That must not
      // help the impostor: the key is the authoring SITE.
      expect(
        Object.keys(SURFACE_DISPOSITIONS).some((k) => k.includes('SketchPromptBar') && k.includes('sketch-prompt-bar')),
        'precondition: .sketch-prompt-bar must already be dispositioned at its real site, or this proves nothing',
      ).toBe(true)
      expect(
        SURFACE_DISPOSITIONS[hud?.key ?? ''],
        `class reuse must NOT inherit a disposition: ${hud?.key} has to fail by name`,
      ).toBeUndefined()
    })

    it('RED: each of the four positioning routes lands as its own undispositioned key', () => {
      // Reused class, inline style, computed className, spread props. A scanner
      // that reads only app.css sees the first; one that reads only inline
      // styles sees the second; neither sees the last two.
      expect(new Set(bypassDomain.map((s) => s.route))).toEqual(new Set(['positioned-class', 'inline-position', 'indeterminate']))
      const undispositioned = bypassDomain.filter((s) => SURFACE_DISPOSITIONS[s.key] === undefined)
      expect(
        undispositioned.length,
        'every bypass must be undispositioned -- that IS the failure the real census would report',
      ).toBe(4)
    })

    it('RED: fed to the real assertion, the fixture produces the census failure by name', () => {
      // The exact expression the "EVERY in-viewport surface has a disposition"
      // test evaluates, run against the fixture: it must be non-empty. Round 0
      // returned [] here, which is the whole reason this WO exists.
      const undispositioned = bypassDomain
        .filter((s) => SURFACE_DISPOSITIONS[s.key] === undefined)
        .map((s) => s.key)
      expect(undispositioned).not.toEqual([])
      expect(undispositioned.every((k) => k.includes('overlayBypass.fixture.tsx:BypassViewport'))).toBe(true)
    })

    it('CONTROL: the fixture is unreachable from the app, so it cannot pollute the real census', () => {
      expect(walk.visited.some((v) => v.includes('overlayBypass.fixture'))).toBe(false)
      expect(domain.some((s) => s.file.includes('fixtures/'))).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Scanner-level mutation proofs: each primitive catches its own defect class
  // when fed a synthetic fixture carrying that exact defect.
  // -------------------------------------------------------------------------
  describe('mutation proof: each scanner primitive catches its own defect class', () => {
    it('RED: the app.css scan flags a new positioned class, and ignores prose in a comment', () => {
      const found = positionedClasses('.brand-new-hud {\n  position: absolute;\n  top: 8px;\n}\n')
      expect([...found.keys()]).toEqual(['brand-new-hud'])
      expect(found.get('brand-new-hud')?.positions.has('absolute')).toBe(true)
      // The round-0 false positive: a comment saying "with `position:fixed`".
      const prose = positionedClasses('/* .top-toolbar sits above with `position:fixed` and no chrome */\n.x { color: red; }\n')
      expect([...prose.keys()], 'a comment must never read as a positioned rule').toEqual([])
    })

    it('RED: the className evaluator resolves literals through conditionals -- and refuses identifiers', () => {
      const lit = evalClassExpression(literal(`'a b'`))
      expect(lit).toEqual({ classes: ['a', 'b'], complete: true })
      // A condition being opaque must not make the class set opaque.
      expect(evalClassExpression(literal(`hidden ? 'on' : 'off'`))).toEqual({ classes: ['on', 'off'], complete: true })
      expect(evalClassExpression(literal('`x ${cond ? "sketch-prompt-bar" : ""}`')).classes).toContain('sketch-prompt-bar')
      // ...but a class that only exists behind an identifier is NOT resolvable,
      // and must be reported rather than silently treated as no-classes.
      expect(evalClassExpression(literal('smuggled')).complete).toBe(false)
    })

    it('RED: the style evaluator finds position through a conditional, and refuses a spread', () => {
      expect(evalStylePosition(literal(`{ position: 'absolute', top: 8 }`)).values).toEqual(['absolute'])
      expect(evalStylePosition(literal(`embedded ? { position: 'relative' } : { position: 'fixed' }`)).values)
        .toEqual(['relative', 'fixed'])
      expect(evalStylePosition(literal('{ ...base, top: y }')).complete, 'a spread can hide a position').toBe(false)
    })

    it('RED: the phantom-token scanner flags an undefined, unfallbacked reference -- and not a defined one', () => {
      const defsFixture = new Set(['--surface-1'])
      const refsFixture = new Map([
        ['--surface-panel', { withFallback: false, sites: ['x.tsx'] }],
        ['--surface-1', { withFallback: false, sites: ['x.tsx'] }],
      ])
      const flagged = [...refsFixture.entries()].filter(([n, v]) => !defsFixture.has(n) && !v.withFallback).map(([n]) => n)
      expect(flagged, 'exactly the undefined token must be flagged').toEqual(['--surface-panel'])
    })

    it('RED: this is the ACTUAL UI-58 defect line -- the scanner flags it verbatim', () => {
      // The literal source line this WO deleted, replayed through the real
      // reference scanner. It must parse as a bare (no-fallback) reference to a
      // token that src/ does not define.
      const defectLine = "        background: 'var(--surface-panel)',"
      const m = [...defectLine.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*(,)?/g)]
      expect(m.length).toBe(1)
      expect(m[0][1]).toBe('--surface-panel')
      expect(m[0][2], 'the defect had no fallback -- which is why it painted transparent').toBeUndefined()
      expect(tokenDefs().has('--surface-panel'), 'still undefined in src/ -- so the reference would still be a phantom').toBe(false)
    })

    it('CONTROL: a fallback-guarded reference to the same undefined token is NOT flagged as unguarded', () => {
      const guarded = 'background: var(--surface-panel, #161b22);'
      const m = [...guarded.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*(,)?/g)]
      expect(m[0][2]).toBe(',')
    })
  })
})

/** Parses one expression so the evaluator mutation proofs above feed the REAL
 *  functions real AST nodes, not hand-built stand-ins. */
function literal(source: string): ts.Expression {
  const sf = ts.createSourceFile('probe.tsx', `const x = ${source}`, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX)
  const stmt = sf.statements[0] as ts.VariableStatement
  return stmt.declarationList.declarations[0].initializer as ts.Expression
}
