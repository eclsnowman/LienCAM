// @vitest-environment node
//
// WO UI-70-R5 -- the AUTHORING LINT gate, rebuilt for FAIL-CLOSED semantics.
//
// ###########################################################################
// # THIS FILE'S VERDICT IS HALF OF THE CENSUS GATE'S VERDICT.               #
// #                                                                         #
// # DECISIONS 2026-07-17 ("UI-70 census re-scope"), item 4, verbatim: "Its  #
// # audit judges the pair (lint + census) as one gate: an overlay is either #
// # sanctioned-and-censused or refused at authoring - no third state."      #
// #                                                                         #
// # The other half is src/tests/ui/overlayRuntimeCensus.test.tsx. The two   #
// # are tied together by src/tests/ui/overlayGatePair.test.tsx, which is    #
// # where the no-third-state claim is actually proven on real components.   #
// ###########################################################################
//
// WHAT CHANGED IN R5, and why these tests are shaped differently from R4's.
// R4's lint was an exact-syntax BLACKLIST and its tests asserted the blacklist:
// "`document.createElement('iframe')` produces an IFRAME finding". Those tests
// passed while the thing they claimed to gate was wide open, because
// `const tag = 'iframe'; document.createElement(tag)` is the same route and was
// not on the list. The R4 audit proved it with a live probe.
//
// So these tests assert the REFUSAL CODE, not just the route. A code says WHICH
// STAGE refused -- RESOLVED-ROUTE means "the lint proved a fact", and every
// UNRESOLVED-* code means "the lint proved nothing and refused anyway". A test
// that only checked "some violation appeared" would stay green if the
// fail-closed branch were deleted and a neighbouring clause happened to fire on
// the same file. That is precisely how R4 shipped.
import { beforeAll, describe, it, expect } from 'vitest'
import path from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  SANCTIONED_AUTHORING,
  auditSanctions,
  keyCollisions,
  lintAuthoringSpace,
  productSourceFiles,
  refusedViolations,
  renderSanctionsArtifact,
  type AuthoringViolation,
  type RefusedRoute,
} from './support/overlayAuthoringLint'

/** vitest runs every file from the repo root; the census's own SRC_ROOT is
 *  derived the same way and for the same reason (import.meta.url is not a file
 *  URL under the jsdom environment). */
const SRC_ROOT = path.join(process.cwd(), 'src')
const FIXTURES = path.join(SRC_ROOT, 'tests', 'ui', 'fixtures', 'authoringLint')
const fixture = (name: string): string => path.join(FIXTURES, name)

const ALL_ROUTES: RefusedRoute[] = ['SHADOW-ROOT', 'IFRAME', 'WEB-COMPONENT', 'BODY-PORTAL', 'UNRESOLVED']

const EXOTIC_FIXTURES = [
  fixture('shadowRootHud.fixture.tsx'),
  fixture('iframeHud.fixture.tsx'),
  fixture('webComponentHud.fixture.tsx'),
  fixture('bodyPortalHud.fixture.tsx'),
]
const INDIRECTION_FIXTURE = fixture('dynamicIndirection.fixture.tsx')

/** The refusals on the R5 indirection fixture, keyed by the line they sit on --
 *  the fixture is organised as numbered cases and each assertion below names
 *  its case, so a failure says WHICH indirection stopped being refused. */
const indirection = (): AuthoringViolation[] => lintAuthoringSpace([INDIRECTION_FIXTURE], SRC_ROOT)

/** The whole-tree walk parses every product source file with the TypeScript
 *  compiler, and the FIRST caller pays that cost (~6 s for 482 files) while
 *  vitest's default per-test budget is 5 s. Pre-memoisation this blew the budget
 *  in four tests; memoised, it blows it in whichever ONE happens to run first --
 *  a failure that moves when the file is reordered and says nothing about the
 *  recognizer. Warming the memo here pays it once, outside any test's budget.
 *
 *  Read this before deleting it: the timeout is on the WARM-UP, not on a
 *  verdict. Every assertion below is byte-identical to the one the R5 round
 *  committed and still fails on regression -- the r5b mutation proof is the
 *  evidence that this line did not soften the gate. */
beforeAll(() => {
  lintAuthoringSpace(productSourceFiles(SRC_ROOT), SRC_ROOT)
}, 120_000)

/** Every refusal whose snippet contains `needle`. Snippet-matched rather than
 *  line-matched: a line number drifts when a comment is added above it, and a
 *  test nobody can edit is a test that gets deleted. */
const bySnippet = (vs: AuthoringViolation[], needle: string): AuthoringViolation[] =>
  vs.filter((v) => v.snippet.includes(needle))

// ---------------------------------------------------------------------------
// 0. The lint is not vacuous
// ---------------------------------------------------------------------------
// A lint that scans nothing passes everything. This program has audit-FAILED
// three WOs in one night on probes that could not fail, so the reach of the walk
// is asserted before anything it concludes is believed (WORKER-CHARTER item 1).

describe('WO UI-70-R5 / 0. the lint reaches the tree it claims to bound', () => {
  it('the product-source derivation reaches the real app, and excludes tests', () => {
    const files = productSourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(100)
    // Named files, not a count: a count passes while pointed at the wrong root.
    const rels = files.map((f) => path.relative(SRC_ROOT, f).split(path.sep).join('/'))
    expect(rels).toContain('components/viewport/Viewport.tsx')
    expect(rels).toContain('components/model3d/SolidsWorkbenchPage.tsx')
    expect(rels).toContain('lib/import/svgImporter.ts')
    // The fixtures below legitimately contain the very syntax the clauses hunt
    // for. If they were ever swept into the product scan, the gate would fail
    // for a reason that has nothing to do with the app -- and, worse, someone
    // would weaken a clause to make it green.
    expect(rels.filter((r) => r.startsWith('tests/'))).toEqual([])
  })

  it('THE CANARY: the clauses are live -- pointed at the fixtures they refuse, they DO refuse', () => {
    // If this ever reads 0, every "no violations in src/" assertion below is
    // vacuous and means nothing.
    expect(lintAuthoringSpace([...EXOTIC_FIXTURES, INDIRECTION_FIXTURE], SRC_ROOT).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 1. LINT-MUST-REFUSE: the R4 BLOCKER and every indirection around it
// ---------------------------------------------------------------------------
// The audit's remedy, verbatim: "Commit this combined dynamic-iframe probe plus
// alias cases as LINT-MUST-REFUSE coverage." Each case asserts its REFUSAL CODE.

describe('WO UI-70-R5 / 1. LINT-MUST-REFUSE: the dynamic constructions that beat R4', () => {
  it('THE R4 BLOCKER, case 1: `const tag = \'iframe\'; document.createElement(tag)` refuses as IFRAME', () => {
    // The exact probe coordination/reports/UI-70-R4.audit.json used to prove
    // the shipped lint returned 0 findings while the child window computed the
    // HUD as position:fixed. It resolves now, so it is a FACT, not a spelling.
    const v = bySnippet(indirection(), 'document.createElement(tag)')
    expect(v.length).toBeGreaterThan(0)
    const iframe = v.filter((x) => x.route === 'IFRAME')
    expect(iframe.map((x) => x.code)).toContain('RESOLVED-ROUTE')
  })

  it('case 1 (cont): the combined probe\'s COMPUTED child-document key refuses as IFRAME (AM5b)', () => {
    // R4 checked for a dotted `.contentDocument` only. This is the bracket form.
    const v = bySnippet(indirection(), "frame['contentDocument'")
    expect(v.map((x) => `${x.route}/${x.code}`)).toContain('IFRAME/RESOLVED-ROUTE')
  })

  it('case 2+3: a CONCATENATED and a TEMPLATE tag refuse -- no literal "iframe" is spelled', () => {
    // `'if' + 'rame'` and `` `if${half}` ``. The folder resolves both to the
    // same fact. If this goes green-by-absence the resolver stopped folding.
    const all = indirection().filter((x) => x.route === 'IFRAME' && x.code === 'RESOLVED-ROUTE')
    expect(all.length).toBeGreaterThanOrEqual(4)
  })

  it('case 4: THE ONE THAT PROVES THE DESIGN -- an UNRESOLVABLE tag refuses as UNRESOLVED-TAG', () => {
    // `document.createElement(pick())`. No blacklist can say anything here, and
    // no widening of one ever could. The lint refuses BECAUSE it cannot resolve.
    const v = bySnippet(indirection(), 'document.createElement(pick())')
    expect(v.map((x) => `${x.route}/${x.code}`)).toEqual(['UNRESOLVED/UNRESOLVED-TAG'])
  })

  it('case 5: createElement ALIASED away from its call site refuses as UNRESOLVED-TAG', () => {
    const v = indirection().filter((x) => x.snippet === 'document.createElement' && x.code === 'UNRESOLVED-TAG')
    expect(v.length).toBe(1)
  })

  it('case 7: attachShadow reached through an ALIAS refuses -- naming it IS the violation', () => {
    const v = bySnippet(indirection(), 'host.attachShadow')
    expect(v.map((x) => `${x.route}/${x.code}`)).toEqual(['SHADOW-ROOT/RESOLVED-ROUTE'])
  })

  it('case 8: attachShadow through a COMPUTED CALLEE refuses as UNRESOLVED-CALLEE', () => {
    // The method name never appears in the source at all.
    const v = indirection().filter((x) => x.code === 'UNRESOLVED-CALLEE')
    expect(v.length).toBe(1)
    expect(v[0].route).toBe('UNRESOLVED')
  })

  it('case 9: AM2 -- an iframe parsed in through `innerHTML =` refuses (R4 walked calls only)', () => {
    const v = bySnippet(indirection(), 'document.body.innerHTML')
    expect(v.length).toBe(1)
    expect(v[0].code).toBe('RESOLVED-ROUTE')
  })

  it('case 10: AM2 -- markup that does NOT resolve refuses as UNRESOLVED-MARKUP', () => {
    const v = bySnippet(indirection(), 'host.innerHTML = build()')
    expect(v.map((x) => `${x.route}/${x.code}`)).toEqual(['UNRESOLVED/UNRESOLVED-MARKUP'])
  })

  it('case 11: a document root reached through an ALIAS refuses as BODY-PORTAL', () => {
    // `const root = document.body; root.appendChild(hud)`. R4 matched the
    // receiver by its text and this walked past.
    const v = bySnippet(indirection(), 'root.appendChild(hud)')
    expect(v.map((x) => `${x.route}/${x.code}`)).toEqual(['BODY-PORTAL/RESOLVED-ROUTE'])
  })

  it('case 12: a JSX tag identifier holding the STRING "iframe" refuses -- React renders the VALUE', () => {
    const v = bySnippet(indirection(), 'auditor-jsx-tag-hud')
    expect(v.some((x) => x.route === 'IFRAME' && x.code === 'RESOLVED-ROUTE')).toBe(true)
  })

  it('case 13: a JSX tag that is NEITHER string nor component refuses as UNRESOLVED-TAG', () => {
    const v = bySnippet(indirection(), 'auditor-jsx-computed-hud')
    expect(v.map((x) => `${x.route}/${x.code}`)).toEqual(['UNRESOLVED/UNRESOLVED-TAG'])
  })

  it('case 14: BOTH halves of a custom element refuse -- incl. the bare-global registry', () => {
    // The `customElements.define(...)` half was a REAL HOLE found by this
    // fixture: the clause resolved MEMBER names, so it saw `define` on a bare
    // global it never looked at, and case 14 refused on `extends HTMLElement`
    // alone. Asserted as two separate refusals so the route cannot be
    // assembled one half at a time.
    const v = indirection().filter((x) => x.route === 'WEB-COMPONENT')
    expect(v.some((x) => x.snippet.includes('extends HTMLElement'))).toBe(true)
    expect(v.some((x) => x.snippet === 'customElements')).toBe(true)
  })

  it('case 15: a hyphenated tag built dynamically refuses as WEB-COMPONENT', () => {
    const v = indirection().filter((x) => x.route === 'WEB-COMPONENT' && x.snippet.includes('createElement(tag)'))
    expect(v.map((x) => x.code)).toEqual(['RESOLVED-ROUTE'])
  })

  it('THE FAIL-CLOSED BUCKET IS REAL: the fixture produces every UNRESOLVED-* code', () => {
    // The four fail-closed codes are the entire answer to the R4 BLOCKER. If a
    // future edit makes one unreachable, its whole indirection class has gone
    // back to passing silently and this says so BY NAME.
    const codes = new Set(indirection().map((v) => v.code))
    expect([...codes].sort()).toEqual([
      'RESOLVED-ROUTE',
      'UNRESOLVED-CALLEE',
      'UNRESOLVED-MARKUP',
      'UNRESOLVED-RECEIVER',
      'UNRESOLVED-TAG',
    ])
  })
})

// ---------------------------------------------------------------------------
// 1b. The R2/R3 exotic fixtures still refuse
// ---------------------------------------------------------------------------
// Converted from census-must-catch to LINT-MUST-REFUSE per DECISIONS item 3 in
// R4, and re-run here against the REWRITTEN lint: a rewrite can silently weaken
// prior rounds' coverage (WORKER-CHARTER pre-flight), so the old fixtures are
// re-asserted rather than assumed.

describe('WO UI-70-R5 / 1b. the exotic routes that beat five census rounds still refuse', () => {
  it('SHADOW-ROOT: the R2 audit\'s open-root HUD, and the closed root that needed instrumentation', () => {
    const v = lintAuthoringSpace([fixture('shadowRootHud.fixture.tsx')], SRC_ROOT)
    const shadow = v.filter((x) => x.route === 'SHADOW-ROOT')
    expect(shadow.map((x) => x.key).sort()).toEqual([
      'tests/ui/fixtures/authoringLint/shadowRootHud.fixture.tsx:ClosedShadowRootHud > host.attachShadow',
      'tests/ui/fixtures/authoringLint/shadowRootHud.fixture.tsx:ShadowRootHud > host.attachShadow',
    ])
  })

  it('IFRAME: the R3 audit\'s same-origin child Document -- the route that fired the tripwire', () => {
    const v = lintAuthoringSpace([fixture('iframeHud.fixture.tsx')], SRC_ROOT)
    const iframe = v.filter((x) => x.route === 'IFRAME')
    expect(iframe.map((x) => x.snippet)).toEqual(
      expect.arrayContaining(["document.createElement('iframe')", 'frame.contentDocument', 'frame.contentWindow']),
    )
    expect(iframe.some((x) => x.snippet.startsWith('<iframe'))).toBe(true)
  })

  it('WEB-COMPONENT: refused at BOTH halves, so the route cannot be assembled one line at a time', () => {
    const v = lintAuthoringSpace([fixture('webComponentHud.fixture.tsx')], SRC_ROOT)
    const wc = v.filter((x) => x.route === 'WEB-COMPONENT')
    expect(wc.some((x) => x.snippet.includes('extends HTMLElement'))).toBe(true)
    expect(wc.some((x) => x.snippet === 'customElements')).toBe(true)
  })

  it('BODY-PORTAL: createPortal (which the census DOES see) and an unsanctioned imperative append', () => {
    const v = lintAuthoringSpace([fixture('bodyPortalHud.fixture.tsx')], SRC_ROOT)
    const bp = v.filter((x) => x.route === 'BODY-PORTAL')
    expect(bp.some((x) => x.snippet.startsWith('createPortal('))).toBe(true)
    expect(bp.some((x) => x.snippet === 'document.body.appendChild(hud)')).toBe(true)
    // The point of this case: NOTHING here is sanctioned. The real body-append
    // sites are sanctioned by a key that names their own function, so a fixture
    // cannot inherit a sanction by looking like one.
    const sanctioned = new Set(SANCTIONED_AUTHORING.map((s) => s.key))
    expect(bp.filter((x) => sanctioned.has(x.key))).toEqual([])
  })

  it('every refused route has a committed fixture -- no clause is asserted only by its absence in src/', () => {
    const found = lintAuthoringSpace([...EXOTIC_FIXTURES, INDIRECTION_FIXTURE], SRC_ROOT)
    const covered = new Set(found.map((v) => v.route))
    // Three of the four NAMED routes have ZERO sites in src/. Their clauses
    // could be deleted outright and the product-tree assertion would stay green
    // forever. These fixtures are the only thing standing between that and a
    // silent fail-open, which is why this is an assertion and not a comment.
    expect([...covered].sort()).toEqual([...ALL_ROUTES].sort())
  })
})

// ---------------------------------------------------------------------------
// 2. The lint PASSES the current tree
// ---------------------------------------------------------------------------
// "no false positives - if a legitimate current overlay trips it, THAT is a
// sanctioned-list gap: fix the list, never weaken the lint" (UI-70-R4, L1).

describe('WO UI-70-R5 / 2. the current tree passes -- every route it uses is sanctioned by name', () => {
  it('src/ carries ZERO unsanctioned authoring violations', () => {
    const violations = refusedViolations(productSourceFiles(SRC_ROOT), SRC_ROOT)
    // Fails BY NAME, never as a bare count: the message is what the next author
    // reads at 2am, and "expected 1 to be 0" tells them nothing.
    expect(
      violations.map((v) => `${v.route}/${v.code}  ${v.key}\n      ${v.file}:${v.line} -- ${v.reason}`),
    ).toEqual([])
  })

  it('refuses shadow/web-component routes and permits only the exact hidden print iframe routes', () => {
    const all = lintAuthoringSpace(productSourceFiles(SRC_ROOT), SRC_ROOT)
    expect(all.filter((v) => v.route === 'SHADOW-ROOT')).toEqual([])
    expect(all.filter((v) => v.route === 'WEB-COMPONENT')).toEqual([])
    // WO-2301 requires an isolated printable document. This is not a blanket
    // iframe exception: a new creation or access site still fails exactly.
    expect(all.filter((v) => v.route === 'IFRAME').map(v => v.key).sort()).toEqual([
      "lib/sketch/printDrawing.ts:printSketchDocument > document.createElement('iframe')",
      'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentDocument',
      'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentWindow',
    ].sort())
  })

  it('the sanctioned list is EXACTLY the tree\'s refusals -- asserted in BOTH directions', () => {
    const all = lintAuthoringSpace(productSourceFiles(SRC_ROOT), SRC_ROOT).map((v) => v.key).sort()
    const sanctioned = SANCTIONED_AUTHORING.map((s) => s.key).sort()
    // Per the A2 exemption discipline this WO's own history earned: an
    // unsanctioned site fails, AND a sanction with no site fails. A
    // one-directional allowlist is one nobody prunes, and an allowlist nobody
    // prunes permits things nobody has read.
    expect(all).toEqual(sanctioned)
  })

  it('names every exact route grant separately from resolution limits', () => {
    // WO-2622: prune retired downloads and add only the individually reviewed
    // Form, reference-image, modal and hidden-print routes. No pattern grants.
    const grants = SANCTIONED_AUTHORING.filter((s) => s.route !== 'UNRESOLVED')
    expect(grants.map((s) => s.key).sort()).toEqual([
      'components/model3d/referenceImage/ReferenceImageCalibration.tsx:ReferenceImageCalibration > createPortal(<> {points.length < 2 && <WorkbenchConfirmBar testId="reference-image-cali...',
      // WO-2784 RE-PIN: WO-2322 (686f74ad2f, landed a43dc7cf90) moved the corner-handles aria-label into the workbench text catalog; same portal site, key re-texted only.
      "components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > createPortal(<div aria-label={workbenchText('ReferenceImagePlacement.referenceImageCorn...",
      'components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > createPortal( <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={onCl...',
      'lib/sketch/printDrawing.ts:printSketchDocument > document.body.appendChild(frame)',
      "lib/sketch/printDrawing.ts:printSketchDocument > document.createElement('iframe')",
      'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentDocument',
      'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentWindow',
      'components/model3d/form/formInteraction.ts:dragBoxTo > document.body.appendChild(shape)',
      'components/machine/PendantPanel.tsx:PendantPanel > createPortal( <div id=\"pendant-pairing-popover\" ref={popoverRef} className=\"pendant-pop...',
      'components/machine/MacroAskDialog.tsx:mountMacroAskDialog > document.body.appendChild(host)',
    ].sort())
  })
})

// ---------------------------------------------------------------------------
// 2b. The sanctioned list is a COMMITTED, GENERATED artifact
// ---------------------------------------------------------------------------

describe('WO UI-70-R5 / 2b. the sanctions artifact matches its derivation', () => {
  const ARTIFACT = path.join(process.cwd(), 'src', 'tests', 'evidence', 'UI-70', 'OVERLAY-AUTHORING-SANCTIONS.md')

  it('OVERLAY-AUTHORING-SANCTIONS.md is byte-identical to renderSanctionsArtifact(SANCTIONED_AUTHORING)', () => {
    const rendered = renderSanctionsArtifact()
    if (process.env.UI70_WRITE_SANCTIONS === '1') writeFileSync(ARTIFACT, rendered, 'utf8')
    expect(
      existsSync(ARTIFACT),
      'OVERLAY-AUTHORING-SANCTIONS.md is NOT COMMITTED. Regenerate with UI70_WRITE_SANCTIONS=1 '
      + 'npx vitest run src/tests/ui/overlayAuthoringLint.test.ts',
    ).toBe(true)
    // Normalised for line endings ONLY: this repo has CRLF files and git may
    // rewrite the checkout, so a byte gate failing for that reason would be
    // noise rather than drift (WORKER-CHARTER item 11's CRLF trap).
    expect(
      readFileSync(ARTIFACT, 'utf8').replace(/\r\n/g, '\n'),
      'OVERLAY-AUTHORING-SANCTIONS.md has DRIFTED from the derivation it is generated from.',
    ).toBe(rendered.replace(/\r\n/g, '\n'))
  })
})

// ---------------------------------------------------------------------------
// 3. The sanctions are themselves gated
// ---------------------------------------------------------------------------
// The sanctioned list is the lint's only soft spot: it is the one place a human
// judgement sits inside a mechanical gate. So the judgements are re-derived from
// the source they point at.

describe('WO UI-70-R5 / 3. the sanctioned list cannot go stale, understate, or lie', () => {
  // The full-source scan costs ~2s; four tests each re-deriving it from
  // scratch crossed the 5s per-test budget under full-suite CPU load
  // (v0.29.0 gate, 2 timeouts). The scan is pure on (files, SRC_ROOT), so
  // derive it ONCE per run and let every assertion read the same result.
  //
  // 2026-08-04 UPDATE: deriving it once was necessary but not sufficient.
  // Memoizing LAZILY just moves the whole cost inside whichever test calls
  // audit() first, which still has to fit in that test's own 5s budget. The
  // sweep has since grown to 4.0-4.9s in isolation, so under full-suite load
  // the first test tips over and times out -- observed on the 2026-08-04 gate
  // as the only remaining red, with the same test passing 33/33 when run
  // alone. That reads as a broken assertion and it is not one: nothing is
  // wrong except where the clock is being charged.
  //
  // So charge it to a hook that owns a budget of its own. beforeAll gets an
  // explicit 60s allowance -- generous on purpose, because this is a
  // whole-tree AST sweep whose cost scales with src/, and a budget that only
  // just fits today becomes the same flake again after the next 50 files.
  // The per-test budgets stay untouched: an assertion that goes slow is still
  // a real signal, it just no longer inherits the sweep's cost.
  let auditResult: ReturnType<typeof auditSanctions> | null = null
  beforeAll(() => {
    auditResult = auditSanctions(productSourceFiles(SRC_ROOT), SRC_ROOT)
  }, 60_000)
  const audit = (): ReturnType<typeof auditSanctions> => {
    if (auditResult === null) {
      // Not reachable through the suite (beforeAll always runs first). Kept as
      // a fail-loud guard rather than a silent re-derive: a null here would
      // mean the hook was skipped, and quietly recomputing would hide that.
      throw new Error('sanction audit was read before beforeAll derived it')
    }
    return auditResult
  }

  it('no sanction names a site that no longer exists', () => {
    expect(audit().stale).toEqual([])
  })

  it('no ONE sanction covers TWO sites -- amendment A3\'s defect, wearing an allowlist', () => {
    expect(audit().ambiguous).toEqual([])
  })

  it('every authoring key in src/ is INJECTIVE -- one key, one site', () => {
    // toolController.ts has two BYTE-IDENTICAL `doc.append(...)` statements in
    // one function. No name derived from source text can separate them, so the
    // keys carry a source-order ordinal. Without it one sanction covered both.
    expect(keyCollisions(productSourceFiles(SRC_ROOT), SRC_ROOT)).toEqual([])
  })

  it('no sanction claiming authorsOutOfFlow:false sits in a scope that sets an out-of-flow position', () => {
    expect(audit().understated).toEqual([])
  })

  it('THE R4 MINOR\'S GATE: every sanction\'s CLAIMS are re-derived from the source, both directions', () => {
    // The R4 audit found two sanctions whose PROSE claimed display:none at
    // sites that set no such thing. Prose is not a claim, so the behaviours a
    // sanction's reasoning rests on now live in `claims` where this re-derives
    // them -- and an OVERSTATED claim fails exactly as an understated one does.
    //
    // This gate is not decorative: on its first run it refused SEVEN entries in
    // the list above that had been written from a reading rather than from the
    // bytes, including all three of the corrected download anchors and both
    // viewport overlays. Every one was fixed at the source of the claim.
    expect(audit().falseClaims).toEqual([])
  })

  it('the sanctions that DO author out of flow say so, and say why the census does not see them', () => {
    // Named, not counted. An auditor should be able to find them in one grep
    // rather than by reading a table.
    const outOfFlow = SANCTIONED_AUTHORING.filter((s) => s.authorsOutOfFlow).map((s) => s.key).sort()
    // Each added surface has its exact sanction and census recipe above.
    expect(outOfFlow).toEqual([
      'components/model3d/referenceImage/ReferenceImageCalibration.tsx:ReferenceImageCalibration > createPortal(<> {points.length < 2 && <WorkbenchConfirmBar testId="reference-image-cali...',
      // WO-2784 RE-PIN: WO-2322 (686f74ad2f, landed a43dc7cf90) moved the corner-handles aria-label into the workbench text catalog; same portal site, key re-texted only.
      "components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > createPortal(<div aria-label={workbenchText('ReferenceImagePlacement.referenceImageCorn...",
      'components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > createPortal( <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={onCl...',
      'lib/sketch/printDrawing.ts:printSketchDocument > document.body.appendChild(frame)',
      "lib/sketch/printDrawing.ts:printSketchDocument > document.createElement('iframe')",
      'components/model3d/form/formInteraction.ts:dragBoxTo > document.body.appendChild(shape)',
      'components/machine/PendantPanel.tsx:PendantPanel > createPortal( <div id=\"pendant-pairing-popover\" ref={popoverRef} className=\"pendant-pop...',
      'components/machine/MacroAskDialog.tsx:mountMacroAskDialog > document.body.appendChild(host)',
      'cam3d/dev/devPage.ts:mountCam3dDevPage > root.appendChild(page)',
      'lib/sketch/sketcher/sketchInteraction.ts:updateMarquee > this.host.container.appendChild(this.marqueeDiv)',
      'lib/viewport/CNCViewport.ts:_buildProjectPlanePicker > this.container.appendChild(overlay)',
      'lib/viewport/CNCViewport.ts:_enterZScrubMode > this.container.appendChild(overlay)',
    ].sort())
    for (const s of SANCTIONED_AUTHORING) {
      // Every entry documents itself -- the WO's "document each entry" is a gate
      // here, not a habit that decays on the next round.
      expect(s.reason.length).toBeGreaterThan(80)
      expect(s.censusStatus.length).toBeGreaterThan(40)
    }
  })
})
